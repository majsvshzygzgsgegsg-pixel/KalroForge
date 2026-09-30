"""The KairoForge training manager.

Orchestrates the full lifecycle the user asked for:

    prepare -> estimate -> [APPROVAL GATE] -> upload -> provision -> start
            -> poll -> checkpoint -> evaluate -> fetch -> terminate

Two properties matter more than anything else here:

**No silent spend.** :meth:`TrainingManager.run` calls
:func:`require_spend_approval` before it touches the backend. The local
backend is free and is exempted explicitly and visibly; any backend that
rents hardware is not.

**No leaked GPU.** Every terminal path - success, failure, abort - terminates
the worker. :meth:`TrainingManager.run` wraps the body in a ``try/finally``
whose ``finally`` terminates whenever the job is still billable, so an
exception cannot leave a GPU billing by the hour.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from .backend import (
    CheckpointRef,
    CloudTrainingBackend,
    JobState,
    TrainingJob,
    TrainingProgress,
)
from .cost import (
    DEFAULT_MAX_RUN_COST_USD,
    CostEstimate,
    GpuOffer,
    estimate_hours,
    estimate_run,
    find_offer,
    require_spend_approval,
)


class TrainingManagerError(RuntimeError):
    """Raised when the manager cannot carry out a lifecycle operation."""


@dataclass
class ManagerPaths:
    """Where the manager keeps its durable state.

    ``jobs`` and ``registry`` live outside any worker: that is what makes a
    job resumable after the GPU instance is destroyed.
    """

    root: Path

    @property
    def jobs(self) -> Path:
        return self.root / "jobs"

    @property
    def checkpoints(self) -> Path:
        return self.root / "checkpoints"

    @property
    def estimates(self) -> Path:
        return self.root / "estimates"

    @property
    def registry_file(self) -> Path:
        return self.root / "registry.json"

    @property
    def bundles(self) -> Path:
        return self.root / "bundles"

    def job_file(self, job_id: str) -> Path:
        return self.jobs / f"{job_id}.json"

    def ensure(self) -> None:
        for directory in (self.jobs, self.checkpoints, self.estimates, self.bundles):
            directory.mkdir(parents=True, exist_ok=True)


@dataclass
class TrainingRequest:
    """Everything needed to describe and price one training run."""

    version: str
    base_model: str
    base_revision: str
    dataset_dir: Path
    dataset_version: str
    train_tokens: int
    method: str = "qlora"
    provider: str = "local"
    gpu: str = ""
    gpu_count: int = 1
    epochs: int = 1
    config: dict[str, Any] = field(default_factory=dict)
    storage_gib: float = 50.0
    estimated_model_size_gib: float = 0.5
    notes: list[str] = field(default_factory=list)

    def training_config(self) -> dict[str, Any]:
        """The full effective training configuration.

        The user-specified surface is materialised here with defaults, so the
        registry always records every knob that actually took effect rather
        than only the ones that were overridden.
        """

        base: dict[str, Any] = {
            "base_model": self.base_model,
            "base_revision": self.base_revision,
            "dataset_dir": str(self.dataset_dir),
            "epochs": self.epochs,
            "learning_rate": 2e-4,
            "batch_size": 1,
            "gradient_accumulation": 8,
            "sequence_length": 2048,
            "warmup_ratio": 0.03,
            "weight_decay": 0.01,
            "precision": "bf16",
            "lora_rank": 16,
            "lora_alpha": 32,
            "lora_dropout": 0.05,
            "checkpoint_interval": 50,
            "evaluation_interval": 50,
            "seed": 1337,
            "method": self.method,
        }
        base.update(self.config)
        return base


class TrainingManager:
    """Drives training jobs through their lifecycle against a backend."""

    def __init__(
        self,
        paths: ManagerPaths,
        backend: CloudTrainingBackend,
        max_run_cost_usd: float = DEFAULT_MAX_RUN_COST_USD,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        self.paths = paths
        self.backend = backend
        self.max_run_cost_usd = max_run_cost_usd
        self.environ = environ
        self.paths.ensure()

    # ------------------------------------------------------------------
    # planning
    # ------------------------------------------------------------------

    def estimate(self, request: TrainingRequest) -> CostEstimate:
        """Price a request without creating anything.

        The local backend is genuinely free, so it is quoted at $0 with an
        explicit note rather than being priced from the GPU catalogue.
        """

        if self.backend.name == "local":
            return CostEstimate(
                provider="local",
                gpu="local CPU/GPU",
                gpu_count=1,
                vram_gib_per_gpu=0,
                hourly_usd_per_gpu=0.0,
                estimated_hours=0.0,
                storage_gib=0.0,
                storage_usd_per_gib_month=0.0,
                estimated_model_size_gib=request.estimated_model_size_gib,
                method=request.method,
                base_model=request.base_model,
                dataset_version=request.dataset_version,
                train_tokens=request.train_tokens,
                notes=[
                    "LOCAL backend: runs on this machine and incurs no cloud cost.",
                    "No GPU is rented; training time is bounded by local hardware.",
                ],
            )

        offer = find_offer(request.provider, request.gpu)
        if offer is None:
            raise TrainingManagerError(
                f"no quoted offer for {request.provider!r} / {request.gpu!r}; "
                "run `kairoforge gpus` to list quoted providers"
            )
        hours = estimate_hours(
            request.train_tokens,
            request.epochs,
            offer,
            method=request.method,
            base_params_b=_parameters_billions(request.base_model),
        )
        return estimate_run(
            provider=request.provider,
            gpu=request.gpu,
            gpu_count=request.gpu_count,
            estimated_hours=hours,
            method=request.method,
            base_model=request.base_model,
            dataset_version=request.dataset_version,
            train_tokens=request.train_tokens,
            storage_gib=request.storage_gib,
            model_size_gib=request.estimated_model_size_gib,
        )

    def write_estimate(self, job_id: str, estimate: CostEstimate) -> Path:
        """Persist the quote so a human can review it before approving."""

        path = self.paths.estimates / f"{job_id}.json"
        payload = estimate.to_json()
        payload["job_id"] = job_id
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return path

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def create(self, request: TrainingRequest) -> TrainingJob:
        """Create a job in ``PENDING`` and record its quote.

        Creating a job does not spend money and does not contact a provider,
        so it is safe to call from the harness UI.
        """

        job_id = f"job-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
        estimate = self.estimate(request)
        job = TrainingJob(
            job_id=job_id,
            version=request.version,
            base_model=request.base_model,
            dataset_version=request.dataset_version,
            dataset_path=str(request.dataset_dir),
            method=request.method,
            provider=self.backend.name if self.backend.name == "local" else request.provider,
            gpu=estimate.gpu,
            gpu_count=estimate.gpu_count,
            state=JobState.PENDING,
            estimate=estimate,
            config=request.training_config(),
        )
        job.save(self.paths.job_file(job_id))
        return job

    def load(self, job_id: str) -> TrainingJob:
        """Load a job record from disk."""

        path = self.paths.job_file(job_id)
        if not path.exists():
            raise TrainingManagerError(f"no such job: {job_id}")
        return TrainingJob.load(path)

    def list_jobs(self) -> list[TrainingJob]:
        """Every job record on disk, newest first."""

        jobs = []
        for path in sorted(self.paths.jobs.glob("job-*.json")):
            try:
                jobs.append(TrainingJob.load(path))
            except Exception:
                # A corrupt record must not hide the healthy ones.
                continue
        return sorted(jobs, key=lambda job: job.created_at, reverse=True)

    def _save(self, job: TrainingJob) -> None:
        job.touch()
        job.save(self.paths.job_file(job.job_id))

    def _transition(self, job: TrainingJob, state: JobState, message: str = "") -> None:
        """Move a job to a new state and persist it."""

        job.state = state
        if message:
            progress = job.progress or TrainingProgress(state=state)
            progress.state = state
            progress.message = message
            progress.updated_at = datetime.now(timezone.utc).isoformat()
            job.progress = progress
        self._save(job)

    def run(
        self,
        job_id: str,
        poll_interval: float = 30.0,
        max_wait_seconds: float | None = None,
        on_progress: Callable[[TrainingJob], None] | None = None,
    ) -> TrainingJob:
        """Execute a created job through to a terminal state.

        The approval gate runs before any provider call. The ``finally``
        block terminates the worker whenever the job was still billable, so
        no failure path can leave rented hardware running.
        """

        job = self.load(job_id)
        estimate = job.estimate or self.estimate(
            TrainingRequest(
                version=job.version,
                base_model=job.base_model,
                base_revision="",
                dataset_dir=Path(job.dataset_path),
                dataset_version=job.dataset_version,
                train_tokens=0,
            )
        )

        if self.backend.name != "local":
            self._transition(job, JobState.WAITING_FOR_APPROVAL)
            require_spend_approval(
                estimate,
                max_run_cost_usd=self.max_run_cost_usd,
                environ=self.environ,
            )

        started = time.monotonic()
        try:
            self._transition(job, JobState.PREPARING, "writing job bundle")
            bundle = self.paths.bundles / job.job_id
            bundle.mkdir(parents=True, exist_ok=True)
            (bundle / "job.json").write_text(
                json.dumps(job.to_json(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            self.backend.prepare(bundle, job.to_json())

            self._transition(job, JobState.UPLOADING_DATA, "synchronising dataset")
            job.remote_prefix = self.backend.upload(bundle, f"kairoforge/{job.job_id}")
            self._save(job)

            if self.backend.name != "local":
                self._transition(job, JobState.PROVISIONING, "starting GPU worker")
            job.worker = self.backend.provision(estimate, job.to_json())
            self._save(job)

            self._transition(job, JobState.STARTING, "launching training")
            job.run_id = self.backend.start(job.worker, job.remote_prefix, job.to_json())
            self._save(job)

            return self._poll_until_terminal(
                job, poll_interval, max_wait_seconds, on_progress
            )
        except Exception as exc:
            job.error = f"{type(exc).__name__}: {exc}"
            self._transition(job, JobState.FAILED, job.error)
            raise
        finally:
            # Re-read: the worker handle may have been assigned mid-flight,
            # and an exception before that assignment still needs cleanup of
            # anything provisioned.
            current = self.load(job.job_id)
            if current.worker and not current.state.terminal:
                self._transition(current, JobState.STOPPING, "releasing resources")
                self._safe_terminate(current)
            elif current.worker and current.state.terminal and current.state is not JobState.STOPPED:
                # Completed or failed: the worker is no longer needed.
                self._safe_terminate(current)

    def _safe_terminate(self, job: TrainingJob) -> None:
        """Terminate the worker, never letting a cleanup error mask the outcome."""

        try:
            self.backend.terminate(job.worker)
        except Exception as exc:  # pragma: no cover - depends on provider
            job.notes = getattr(job, "notes", "")
            job.error = (
                f"{job.error}\nWARNING: failed to terminate worker {job.worker}: {exc}. "
                "Verify the instance is stopped in the provider console."
            ).strip()
        else:
            if job.state is not JobState.STOPPED:
                job.state = JobState.STOPPED if job.state.terminal else job.state
        self._save(job)

    def _poll_until_terminal(
        self,
        job: TrainingJob,
        poll_interval: float,
        max_wait_seconds: float | None,
        on_progress: Callable[[TrainingJob], None] | None,
    ) -> TrainingJob:
        """Poll the backend until the job reaches a terminal state."""

        deadline = None if max_wait_seconds is None else time.monotonic() + max_wait_seconds

        while True:
            progress = self.backend.poll(job.worker, job.run_id)
            job.progress = progress
            if progress.state is not job.state:
                job.state = progress.state
            if progress.state is JobState.CHECKPOINTING:
                job.checkpoints = self.backend.checkpoints(job.worker, job.run_id)
            self._save(job)

            if on_progress is not None:
                on_progress(job)

            if progress.state.terminal:
                if progress.state is JobState.COMPLETED:
                    job.checkpoints = self.backend.checkpoints(job.worker, job.run_id)
                    job.result["final_progress"] = progress.to_json()
                    self._save(job)
                return job

            if deadline is not None and time.monotonic() > deadline:
                job.error = (
                    f"poll timed out after {max_wait_seconds:.0f}s while in "
                    f"{progress.state.value}; the job is still running and the "
                    "worker has NOT been released"
                )
                self._save(job)
                return job

            time.sleep(poll_interval)

    # ------------------------------------------------------------------
    # operations
    # ------------------------------------------------------------------

    def status(self, job_id: str) -> dict[str, Any]:
        """Real status for one job, including live progress when available."""

        job = self.load(job_id)
        if job.worker and job.run_id and job.state.billable:
            try:
                job.progress = self.backend.poll(job.worker, job.run_id)
                job.state = job.progress.state
                self._save(job)
            except Exception as exc:
                job.progress = job.progress or TrainingProgress(
                    state=job.state, message=f"status unavailable: {exc}"
                )
        return job.to_json()

    def logs(self, job_id: str, tail: int = 200) -> str:
        """Recent log lines for one job."""

        job = self.load(job_id)
        if not job.worker or not job.run_id:
            return "(no worker started yet)"
        return self.backend.logs(job.worker, job.run_id, tail=tail)

    def checkpoints(self, job_id: str) -> list[CheckpointRef]:
        """Checkpoints durably stored for one job."""

        job = self.load(job_id)
        if not job.worker:
            return job.checkpoints
        found = self.backend.checkpoints(job.worker, job.run_id)
        job.checkpoints = found
        self._save(job)
        return found

    def fetch(self, job_id: str, step: int | None = None) -> Path:
        """Download a checkpoint into the manager's durable checkpoint store."""

        job = self.load(job_id)
        found = self.checkpoints(job_id)
        if not found:
            raise TrainingManagerError(f"job {job_id} has no checkpoints yet")

        if step is None:
            finals = [c for c in found if c.is_final]
            chosen = max(finals or found, key=lambda c: c.step)
        else:
            matches = [c for c in found if c.step == step]
            if not matches:
                raise TrainingManagerError(f"job {job_id} has no checkpoint at step {step}")
            chosen = matches[0]

        destination = self.paths.checkpoints / job.version
        destination.mkdir(parents=True, exist_ok=True)
        return self.backend.fetch(chosen, destination)

    def resume(self, job_id: str, from_step: int | None = None) -> TrainingJob:
        """Resume a failed or stopped job from its latest durable checkpoint."""

        job = self.load(job_id)
        found = self.checkpoints(job_id)
        if not found:
            raise TrainingManagerError(
                f"job {job_id} has no checkpoints; it cannot be resumed"
            )
        if from_step is None:
            chosen = max(found, key=lambda c: c.step)
        else:
            matches = [c for c in found if c.step == from_step]
            if not matches:
                raise TrainingManagerError(f"no checkpoint at step {from_step}")
            chosen = matches[0]

        if self.backend.name != "local":
            self._transition(job, JobState.WAITING_FOR_APPROVAL, "resume requires re-approval")
            require_spend_approval(
                job.estimate,  # type: ignore[arg-type]
                max_run_cost_usd=self.max_run_cost_usd,
                environ=self.environ,
            )

        if not job.worker:
            job.worker = self.backend.provision(job.estimate, job.to_json())  # type: ignore[arg-type]
        self._transition(job, JobState.STARTING, f"resuming from step {chosen.step}")
        job.run_id = self.backend.resume(job.worker, job.run_id, chosen)
        self._save(job)
        return job

    def stop(self, job_id: str) -> TrainingJob:
        """Stop a job and release its worker.

        Safe to call whether or not the job is running: an already-stopped job
        is a no-op rather than an error, so the harness "Stop" button is
        idempotent.
        """

        job = self.load(job_id)
        if not job.worker:
            job.state = JobState.STOPPED
            self._save(job)
            return job
        self._transition(job, JobState.STOPPING, "stop requested")
        self._safe_terminate(job)
        job.state = JobState.STOPPED
        self._save(job)
        return job


def _parameters_billions(base_model: str) -> float:
    """Infer model size in billions from a repo id, for time estimation.

    Falls back to 7.0 - the v0.1 base size - rather than failing, because the
    estimate only needs to be good enough to quote a budget.
    """

    from ..base_models import try_resolve_base_model

    spec = try_resolve_base_model(base_model)
    if spec is None:
        return 7.0
    table = {"1.5b": 1.5, "3b": 3.0, "7b": 7.0, "14b": 14.0, "32b": 32.0, "80b-moe": 80.0}
    return table.get(spec.parameter_count, 7.0)
