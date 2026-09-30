"""Run KairoForge training on *this* machine instead of rented GPUs.

The cloud backends exist because a 7B QLoRA run needs an accelerator that a
laptop does not have. But a backend that only knows how to rent hardware is
untestable: every bug in the job bundle, the progress plumbing, the checkpoint
inventory, and the resume path would be discovered for the first time on a
billed GPU. :class:`LocalTrainingBackend` closes that gap by implementing the
identical lifecycle against the local filesystem and a local subprocess.

The critical property is that **the local path is not a mock**. It writes the
same job bundle, runs the same :mod:`kairoforge.training.engine` runner, reads
progress from a status file that the trainer actually writes, hashes real
checkpoint bytes, and resumes from a real checkpoint directory. If the
lifecycle is broken, the local backend breaks too - which is the entire point.

Cost: **$0.00**. Local compute is not billed, and the backend says so
explicitly in :meth:`LocalTrainingBackend.provision`'s ``cost_note`` rather
than leaving an empty field that could be misread as "unknown".
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import textwrap
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from ..training.engine import (
    ConfigError,
    TrainingEngineError,
    TrainingRunConfig,
    validate_config,
)
from .backend import (
    BackendError,
    CheckpointRef,
    CloudTrainingBackend,
    JobState,
    TrainingProgress,
)
from .cost import CostEstimate

#: The exact string reported as the local backend's cost. Quoted verbatim in
#: the job record and the UI so no reader has to infer it.
LOCAL_COST_NOTE = (
    "LOCAL BACKEND: running on this machine. GPU rental cost is $0.00 - no "
    "cloud resource is created and nothing is billed. Time and electricity "
    "are the only costs, and they are not metered here."
)

#: Name of the status file the runner rewrites after every logged step. The
#: manager polls this; it is the only source of progress.
STATUS_FILE_NAME = "status.json"

#: Name of the log file the runner appends to.
LOG_FILE_NAME = "train.log"

#: Default poll interval the manager is told to use, in seconds.
DEFAULT_POLL_SECONDS = 2.0


def _utc_now() -> str:
    """Current time as an ISO-8601 UTC string."""

    return datetime.now(timezone.utc).isoformat()


def _sha256_file(path: Path) -> str:
    """SHA-256 of a file, streamed so a large checkpoint does not blow memory."""

    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _sha256_tree(root: Path) -> tuple[str, int]:
    """Digest of every file under ``root``, plus the total byte count.

    A checkpoint is a *directory*, not one file. Hashing the sorted set of
    relative paths together with each file's own digest makes the resulting
    hash change if any component is added, removed, or edited - which is what
    makes it usable as checkpoint identity for the registry.
    """

    root = Path(root)
    entries: list[tuple[str, str]] = []
    total_bytes = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        entries.append((str(path.relative_to(root)), _sha256_file(path)))
        total_bytes += path.stat().st_size

    combined = hashlib.sha256()
    for relative, digest in entries:
        combined.update(relative.encode("utf-8"))
        combined.update(b"\0")
        combined.update(digest.encode("ascii"))
        combined.update(b"\n")
    return combined.hexdigest(), total_bytes


def _safe_slug(value: str) -> str:
    """Reduce an arbitrary id to a filesystem-safe single path segment."""

    cleaned = "".join(
        character if character.isalnum() or character in "-_." else "-"
        for character in str(value)
    ).strip("-.")
    return cleaned or uuid.uuid4().hex[:12]


@dataclass
class LocalRun:
    """Durable record of one local run, stored next to its artifacts."""

    run_id: str
    job_id: str
    worker: str
    remote_prefix: str
    output_dir: str
    pid: int = 0
    started_at: str = field(default_factory=_utc_now)
    finished_at: str = ""
    exit_code: int | None = None
    resumed_from: str = ""
    config: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "job_id": self.job_id,
            "worker": self.worker,
            "remote_prefix": self.remote_prefix,
            "output_dir": self.output_dir,
            "pid": self.pid,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "exit_code": self.exit_code,
            "resumed_from": self.resumed_from,
            "config": self.config,
        }

    @classmethod
    def load(cls, path: Path) -> "LocalRun":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(**data)


@dataclass
class WorkerProvision:
    """What :meth:`LocalTrainingBackend.provision` hands back to the manager.

    The backend's interface types ``provision`` as returning ``str``, so the
    worker handle is that string and this record is persisted alongside it for
    everything the string cannot carry - notably the zero-cost note.
    """

    worker: str
    cost_usd: float
    cost_note: str
    billable: bool
    host: str
    created_at: str = field(default_factory=_utc_now)

    def to_json(self) -> dict[str, Any]:
        return {
            "worker": self.worker,
            "cost_usd": self.cost_usd,
            "cost_note": self.cost_note,
            "billable": self.billable,
            "host": self.host,
            "created_at": self.created_at,
        }


#: The generated runner. Kept as a template string so the backend can write it
#: into the job bundle, which makes every run self-describing and replayable
#: by hand. It performs NO cloud calls and touches ONLY paths under the job
#: directory it is given.
_RUNNER_TEMPLATE = '''"""Generated local training runner. Do not edit; regenerate instead."""

from __future__ import annotations

import json
import subprocess
import sys
import traceback
from pathlib import Path

RUN_DIR = Path(__file__).resolve().parent
PLAN = json.loads((RUN_DIR / "plan.json").read_text(encoding="utf-8"))
STATUS = RUN_DIR / "status.json"
LOG = RUN_DIR / "train.log"


def write_status(payload):
    """Atomically replace the status file the manager polls."""

    temporary = STATUS.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
    temporary.replace(STATUS)


def log(line):
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(str(line).rstrip() + "\\n")


def main():
    import time

    started = time.time()
    write_status({
        "state": "STARTING", "step": 0, "total_steps": plan_total(),
        "epoch": 0.0, "loss": None, "message": "runner started",
    })
    log("[runner] importing kairoforge training engine")

    try:
        from kairoforge.training.engine import (
            TrainingRunConfig, StepReport, train, validate_config,
        )
    except Exception as exc:
        write_status({
            "state": "FAILED", "step": 0, "total_steps": 0, "epoch": 0.0,
            "loss": None,
            "message": "import failed: %s" % (exc,),
            "traceback": traceback.format_exc(),
            "duration_seconds": round(time.time() - started, 3),
        })
        log("IMPORT FAILED: %s" % (exc,))
        return 2

    config = TrainingRunConfig.from_json(PLAN["config"])
    try:
        validate_config(config)
    except Exception as exc:
        write_status({
            "state": "FAILED", "step": 0, "total_steps": 0, "epoch": 0.0,
            "loss": None, "message": "invalid config: %s" % (exc,),
            "duration_seconds": round(time.time() - started, 3),
        })
        log("INVALID CONFIG: %s" % (exc,))
        return 2

    # The checkpoint dir is the trainer's output_dir, so a resume points the
    # trainer at the same directory it would have written to anyway.
    output_dir = Path(PLAN["checkpoint_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    def on_step(report):
        write_status({
            "state": "TRAINING" if report.message != "checkpoint saved" else "CHECKPOINTING",
            "step": report.step,
            "total_steps": report.total_steps,
            "epoch": report.epoch,
            "loss": None if report.loss != report.loss else report.loss,
            "learning_rate": report.learning_rate,
            "tokens_seen": report.tokens_seen,
            "message": report.message or ("step %d" % report.step),
            "duration_seconds": round(time.time() - started, 3),
        })
        log("[step %s] loss=%s epoch=%s" % (report.step, report.loss, report.epoch))

    try:
        metrics = train(
            config,
            resume_from_checkpoint=PLAN.get("resume_from") or None,
            on_step=on_step,
        )
    except Exception as exc:
        write_status({
            "state": "FAILED", "step": 0, "total_steps": plan_total(),
            "epoch": 0.0, "loss": None,
            "message": "training failed: %s" % (exc,),
            "traceback": traceback.format_exc(),
            "duration_seconds": round(time.time() - started, 3),
        })
        log("TRAINING FAILED: %s" % (exc,))
        log(traceback.format_exc())
        return 1

    # Persist the real metrics where the manager can read them, and mirror the
    # final state into the status file so a single poll sees completion.
    metrics_path = output_dir / "metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\\n", encoding="utf-8")

    write_status({
        "state": "COMPLETED",
        "step": metrics.get("steps", 0),
        "total_steps": plan_total() or metrics.get("steps", 0),
        "epoch": metrics.get("epochs_completed", 0.0),
        "loss": metrics.get("train_loss"),
        "eval_loss": metrics.get("eval_loss"),
        "tokens_seen": metrics.get("tokens", 0),
        "gpu_name": metrics.get("gpu_name", ""),
        "message": "training completed",
        "metrics": metrics,
        "metrics_path": str(metrics_path),
        "duration_seconds": round(time.time() - started, 3),
    })
    log("COMPLETED: %s" % json.dumps(metrics, sort_keys=True))
    return 0


def plan_total():
    return int(PLAN.get("total_steps") or 0)


if __name__ == "__main__":
    sys.exit(main())
'''


class LocalTrainingBackend(CloudTrainingBackend):
    """A :class:`CloudTrainingBackend` that never leaves this machine.

    Every method is a real filesystem or subprocess operation. Progress is
    read from the status file the runner writes; the backend has no fallback
    that synthesises a percentage, so a run that dies without writing status
    is reported as ``FAILED`` rather than as "still starting".
    """

    name = "local"

    def __init__(self, root: Path | str) -> None:
        """Create the backend, rooted at ``root``.

        ``root`` holds everything: job bundles, the "remote" prefix, run
        state, logs, and checkpoints. Keeping it in one directory is what
        makes ``terminate`` and cleanup trivially verifiable.
        """

        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._processes: dict[str, subprocess.Popen] = {}

    # -- path helpers ------------------------------------------------------

    def _worker_dir(self, worker: str) -> Path:
        return self.root / "workers" / _safe_slug(worker)

    def _run_dir(self, worker: str, run_id: str) -> Path:
        return self._worker_dir(worker) / "runs" / _safe_slug(run_id)

    def _status_path(self, worker: str, run_id: str) -> Path:
        return self._run_dir(worker, run_id) / STATUS_FILE_NAME

    def _log_path(self, worker: str, run_id: str) -> Path:
        return self._run_dir(worker, run_id) / LOG_FILE_NAME

    def _run_record_path(self, worker: str, run_id: str) -> Path:
        return self._run_dir(worker, run_id) / "run.json"

    def _checkpoint_dir(self, worker: str, run_id: str) -> Path:
        return self._run_dir(worker, run_id) / "checkpoints"

    # -- lifecycle ---------------------------------------------------------

    #: Keys the manager's ``TrainingRequest.training_config()`` does not emit.
    #: The manager builds a plan from a ``TrainingJob`` payload, whose
    #: ``config`` mapping is deliberately partial, so the backend materialises
    #: the remaining fields with the same values the engine documents as
    #: defaults. Anything the plan *does* specify always wins.
    _CONFIG_DEFAULTS: Mapping[str, Any] = {
        "output_dir": "",
        "lora_target_modules": (),
        "max_steps": 0,
        "save_total_limit": 3,
        "gradient_checkpointing": True,
        "logging_steps": 1,
        "report_to": (),
    }

    def _resolve_config(self, plan: Mapping[str, Any], job_dir: Path) -> TrainingRunConfig:
        """Build a validated :class:`TrainingRunConfig` from a manager plan.

        Accepts both shapes the manager produces:

        * ``{"config": {...}}`` - the bundle written by :meth:`prepare` itself;
        * a full ``TrainingJob`` payload, which the manager passes directly and
          which carries the training knobs under its own ``config`` key.

        The job payload has no ``output_dir``, because in the cloud backends
        the *worker* decides where checkpoints land. Locally the run directory
        is that answer, so a missing ``output_dir`` is filled with a path
        inside ``job_dir`` rather than being rejected.
        """

        raw: Mapping[str, Any]
        if isinstance(plan.get("config"), Mapping):
            raw = plan["config"]
        elif isinstance(plan.get("training_config"), Mapping):
            raw = plan["training_config"]
        else:
            raise BackendError(
                "plan carries neither a 'config' nor a 'training_config' "
                "mapping; the local backend cannot build a TrainingRunConfig"
            )

        payload: dict[str, Any] = dict(self._CONFIG_DEFAULTS)
        for key, value in raw.items():
            if value is not None:
                payload[key] = value

        # `method`/`precision` may live on the enclosing job payload rather
        # than inside the nested config mapping.
        payload.setdefault("method", plan.get("method", "qlora"))
        payload.setdefault("base_model", plan.get("base_model", ""))
        payload.setdefault("base_revision", plan.get("base_revision", ""))
        payload.setdefault("dataset_dir", plan.get("dataset_path", ""))

        if not payload.get("dataset_dir"):
            raise BackendError(
                "plan does not identify a dataset directory (none of "
                "'dataset_dir' in config, 'dataset_path', or 'dataset_dir' "
                "on the plan)"
            )

        for key in ("lora_target_modules", "report_to"):
            value = payload.get(key)
            if isinstance(value, str):
                payload[key] = tuple(
                    part.strip() for part in value.split(",") if part.strip()
                )
            elif value is None:
                payload[key] = ()
            else:
                payload[key] = tuple(value)

        if not payload.get("output_dir"):
            payload["output_dir"] = str(Path(job_dir) / "adapter")

        config = TrainingRunConfig.from_json(payload)
        validate_config(config)
        return config

    def prepare(self, job_dir: Path, plan: Mapping[str, Any]) -> None:
        """Write the job bundle: the config, the plan, and the runner script.

        The bundle is self-describing on purpose. A run can be reproduced by
        reading only what is written here, which is what makes a local
        failure diagnosable without re-running it.
        """

        job_dir = Path(job_dir)
        job_dir.mkdir(parents=True, exist_ok=True)

        try:
            config = self._resolve_config(plan, job_dir)
        except (ConfigError, TypeError, ValueError) as exc:
            raise BackendError(f"invalid training config in plan: {exc}") from exc

        (job_dir / "config.json").write_text(
            json.dumps(config.to_json(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        resolved = dict(plan)
        resolved["config"] = config.to_json()
        resolved.setdefault("job_id", job_dir.name)
        resolved.setdefault("method", config.method)
        resolved.setdefault("base_model", config.base_model)
        resolved["prepared_at"] = _utc_now()
        resolved["backend"] = self.name
        resolved["cost_note"] = LOCAL_COST_NOTE

        (job_dir / "plan.json").write_text(
            json.dumps(resolved, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        (job_dir / "runner.py").write_text(_RUNNER_TEMPLATE, encoding="utf-8")

        data_dir = Path(config.dataset_dir)
        if not (data_dir / "train.jsonl").exists():
            raise BackendError(
                f"dataset_dir {data_dir} has no train.jsonl; the job bundle "
                "would be runnable but would fail immediately on data loading"
            )

    def upload(self, job_dir: Path, remote_prefix: str) -> str:
        """Copy the job bundle into a local "remote" prefix directory.

        There is no network here, but the copy is real: it exercises the same
        "the worker reads a copy, not the original" property the cloud
        backends rely on, so a bundle that only works in place fails here.
        """

        job_dir = Path(job_dir)
        if not job_dir.exists():
            raise BackendError(f"job bundle does not exist: {job_dir}")

        destination = Path(remote_prefix)
        if not destination.is_absolute():
            destination = self.root / "remote" / _safe_slug(remote_prefix)
        destination.mkdir(parents=True, exist_ok=True)

        for path in sorted(job_dir.iterdir()):
            if path.is_file():
                shutil.copy2(path, destination / path.name)
            elif path.is_dir():
                shutil.copytree(path, destination / path.name, dirs_exist_ok=True)

        (destination / "UPLOADED").write_text(
            json.dumps({"uri": str(destination), "at": _utc_now()}, indent=2) + "\n",
            encoding="utf-8",
        )
        return str(destination)

    def provision(self, estimate: CostEstimate, plan: Mapping[str, Any]) -> str:
        """Return a worker handle for this machine. Cost is genuinely $0.

        No cloud resource is created. ``estimate`` is deliberately *not* used
        to bill anything; it is recorded so the job report can show what the
        same run would have cost on a rented GPU, which is a useful number and
        is clearly labelled as a comparison rather than a charge.
        """

        job_id = str(plan.get("job_id") or uuid.uuid4().hex[:8])
        worker = f"local-{_safe_slug(job_id)}"
        worker_dir = self._worker_dir(worker)
        worker_dir.mkdir(parents=True, exist_ok=True)

        handle = WorkerProvision(
            worker=worker,
            cost_usd=0.0,
            cost_note=LOCAL_COST_NOTE,
            billable=False,
            host=os.uname().nodename if hasattr(os, "uname") else "local",
        )

        record = handle.to_json()
        record["estimate_for_comparison"] = estimate.to_json() if estimate else None
        record["estimate_is_billed"] = False
        (worker_dir / "worker.json").write_text(
            json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        return worker

    def start(self, worker: str, remote_prefix: str, plan: Mapping[str, Any]) -> str:
        """Launch training in a background subprocess; return the run id.

        The process is started with ``Popen`` and never waited on, so the
        manager can poll. ``PYTHONPATH`` is extended with the uploaded bundle
        and the current ``src`` layout so the runner imports the same
        ``kairoforge`` the manager is using.
        """

        source = Path(remote_prefix)
        if not (source / "plan.json").exists():
            raise BackendError(
                f"remote prefix {remote_prefix} has no plan.json; run upload "
                "before start"
            )

        run_id = f"run-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}"
        run_dir = self._run_dir(worker, run_id)
        run_dir.mkdir(parents=True, exist_ok=True)

        for name in ("plan.json", "config.json", "runner.py"):
            if (source / name).exists():
                shutil.copy2(source / name, run_dir / name)

        # The plan's checkpoint_dir/output_dir must point inside this run so
        # two runs of the same job cannot overwrite each other's adapters.
        run_plan_path = run_dir / "plan.json"
        run_plan = json.loads(run_plan_path.read_text(encoding="utf-8"))
        checkpoint_dir = self._checkpoint_dir(worker, run_id)
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        run_plan["checkpoint_dir"] = str(checkpoint_dir)
        config = dict(run_plan.get("config") or {})
        config["output_dir"] = str(checkpoint_dir)
        run_plan["config"] = config
        run_plan["run_id"] = run_id
        run_plan["worker"] = worker
        run_plan["started_at"] = _utc_now()
        run_plan_path.write_text(
            json.dumps(run_plan, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

        # A status file is written immediately. "PENDING" here means "process
        # launched, no step reported yet" - not a synthesised percentage.
        self._write_status(
            worker,
            run_id,
            TrainingProgress(
                state=JobState.STARTING,
                message="subprocess launched; awaiting first trainer step",
                gpu_name="",
            ),
        )

        environment = dict(os.environ)
        python_path = [str(source), str(run_dir)]
        existing = environment.get("PYTHONPATH", "")
        if existing:
            python_path.append(existing)
        # Fall back to the checkout's src layout so an editable install is not
        # required for a local run to import kairoforge.
        checkout_src = Path(__file__).resolve().parents[2]
        if (checkout_src / "kairoforge").is_dir():
            python_path.append(str(checkout_src))
        environment["PYTHONPATH"] = os.pathsep.join(python_path)
        environment.setdefault("PYTHONUNBUFFERED", "1")
        # Keep local runs single-threaded: oversubscribing BLAS threads on a
        # laptop makes a small run slower, and the log unreadable.
        environment.setdefault("TOKENIZERS_PARALLELISM", "false")

        log_path = self._log_path(worker, run_id)
        log_handle = log_path.open("a", encoding="utf-8")
        log_handle.write(
            f"[backend] launching runner for {worker}/{run_id} at {_utc_now()}\n"
        )
        log_handle.flush()

        process = subprocess.Popen(
            [sys.executable, str(run_dir / "runner.py")],
            cwd=str(run_dir),
            env=environment,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        log_handle.close()

        self._processes[run_id] = process

        record = LocalRun(
            run_id=run_id,
            job_id=str(run_plan.get("job_id") or ""),
            worker=worker,
            remote_prefix=str(source),
            output_dir=str(checkpoint_dir),
            pid=process.pid,
            config=config,
        )
        self._run_record_path(worker, run_id).write_text(
            json.dumps(record.to_json(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return run_id

    def poll(self, worker: str, run_id: str) -> TrainingProgress:
        """Read the runner's REAL status file. Never invents progress.

        Precedence is deliberate:

        1. a status file written by the trainer wins outright;
        2. otherwise the run record's exit code decides FAILED vs STARTING;
        3. otherwise the run is ``FAILED`` - we do not know it is alive, and
           claiming progress we cannot observe is exactly the failure mode
           this backend exists to prevent.
        """

        status_path = self._status_path(worker, run_id)
        if status_path.exists():
            try:
                payload = json.loads(status_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                return TrainingProgress(
                    state=JobState.FAILED,
                    message=f"status file is unreadable: {exc}",
                )
            progress = self._progress_from_payload(payload)
            # A trainer that crashed mid-run leaves a stale TRAINING status.
            # Cross-check against the process so a dead worker is never
            # reported as still training.
            if not progress.state.terminal and not self._process_alive(worker, run_id):
                exit_code = self._exit_code(worker, run_id)
                if exit_code is not None and exit_code != 0:
                    return TrainingProgress(
                        state=JobState.FAILED,
                        step=progress.step,
                        total_steps=progress.total_steps,
                        epoch=progress.epoch,
                        loss=progress.loss,
                        tokens_seen=progress.tokens_seen,
                        message=(
                            f"runner exited with code {exit_code} while status "
                            f"said {progress.state.value}; see logs"
                        ),
                    )
            return progress

        exit_code = self._exit_code(worker, run_id)
        if exit_code is not None:
            return TrainingProgress(
                state=JobState.FAILED if exit_code != 0 else JobState.COMPLETED,
                message=(
                    f"runner exited with code {exit_code} and wrote no status "
                    "file; see logs"
                ),
            )
        return TrainingProgress(
            state=JobState.FAILED,
            message=(
                "no status file and no recorded exit code for this run; the "
                "runner never started or its record was removed"
            ),
        )

    def logs(self, worker: str, run_id: str, tail: int = 200) -> str:
        """Return the last ``tail`` lines of the runner log."""

        log_path = self._log_path(worker, run_id)
        if not log_path.exists():
            return ""
        with log_path.open("r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
        if tail <= 0:
            return "".join(lines)
        return "".join(lines[-tail:])

    def checkpoints(self, worker: str, run_id: str) -> list[CheckpointRef]:
        """List adapter checkpoints on disk, with real SHA-256 digests.

        A checkpoint is a directory (``adapter_config.json`` +
        ``adapter_model.safetensors``). Each is hashed over its whole tree so
        the digest identifies the artifact, not just one file. Directories
        still being written by a live trainer are skipped rather than hashed
        in a half-written state.
        """

        checkpoint_root = self._checkpoint_dir(worker, run_id)
        if not checkpoint_root.exists():
            return []

        alive = self._process_alive(worker, run_id)
        final_step = self._final_step(worker, run_id)

        references: list[CheckpointRef] = []
        for path in sorted(checkpoint_root.iterdir()):
            if not path.is_dir() or path.name.startswith("."):
                continue
            if path.name == "smoke-checkpoint":
                continue
            # Trainer checkpoints are named `checkpoint-<step>`; anything else
            # is reported with step 0 rather than a guessed number.
            step = 0
            if path.name.startswith("checkpoint-"):
                suffix = path.name.split("-", 1)[1]
                if suffix.isdigit():
                    step = int(suffix)

            artifacts = [
                child
                for child in path.iterdir()
                if child.is_file() and child.name != "optimizer.pt"
            ]
            if not artifacts:
                continue
            if alive and "adapter_model.safetensors" not in {
                child.name for child in artifacts
            }:
                # Still being written: report nothing rather than a partial hash.
                continue

            digest, size = _sha256_tree(path)
            references.append(
                CheckpointRef(
                    step=step,
                    uri=str(path),
                    sha256=digest,
                    size_bytes=size,
                    is_final=bool(final_step is not None and step == final_step),
                )
            )

        references.sort(key=lambda reference: (reference.step, reference.uri))
        return references

    def fetch(self, checkpoint: CheckpointRef, destination: Path) -> Path:
        """Copy a checkpoint into ``destination``."""

        source = Path(checkpoint.uri)
        if not source.exists():
            raise BackendError(f"checkpoint does not exist: {source}")

        destination = Path(destination)
        if destination.exists() and destination.is_dir() and any(destination.iterdir()):
            # Copy *into* an existing directory rather than replacing it, so
            # fetching two checkpoints into one folder does not lose the first.
            target = destination / source.name
            target.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, target, dirs_exist_ok=True)
            return target

        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, destination, dirs_exist_ok=True)
        return destination

    def resume(self, worker: str, run_id: str, checkpoint: CheckpointRef) -> str:
        """Start a NEW run continuing from ``checkpoint``.

        A fresh run id is issued rather than reusing the old one: the previous
        run's status and log are evidence and must stay intact. The new run's
        plan carries ``resume_from``, which the runner passes to
        ``train(resume_from_checkpoint=...)`` so the trainer restores optimizer
        and scheduler state.
        """

        checkpoint_path = Path(checkpoint.uri)
        if not checkpoint_path.exists():
            raise BackendError(
                f"cannot resume: checkpoint does not exist: {checkpoint_path}"
            )

        record_path = self._run_record_path(worker, run_id)
        if not record_path.exists():
            raise BackendError(f"cannot resume: unknown run {run_id!r} on {worker!r}")
        previous = LocalRun.load(record_path)

        source = Path(previous.remote_prefix)
        if not source.exists():
            raise BackendError(
                f"cannot resume: uploaded bundle for {run_id} is gone ({source})"
            )

        # Ensure the previous run is not still holding the old checkpoint.
        self._terminate_run(worker, run_id)

        new_run_id = self.start(worker, str(source), {"job_id": previous.job_id})

        run_plan_path = self._run_dir(worker, new_run_id) / "plan.json"
        run_plan = json.loads(run_plan_path.read_text(encoding="utf-8"))
        run_plan["resume_from"] = str(checkpoint_path)
        run_plan["resumed_from_checkpoint"] = checkpoint.to_json()
        run_plan["resumed_from_run"] = run_id
        run_plan_path.write_text(
            json.dumps(run_plan, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

        # The resumed run must not be treated as complete because the OLD
        # status file said so; rewrite it as freshly starting.
        self._write_status(
            worker,
            new_run_id,
            TrainingProgress(
                state=JobState.STARTING,
                message=f"resuming from checkpoint {checkpoint_path.name}",
            ),
        )

        new_record_path = self._run_record_path(worker, new_run_id)
        new_record = LocalRun.load(new_record_path)
        new_record.resumed_from = str(checkpoint_path)
        new_record_path.write_text(
            json.dumps(new_record.to_json(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return new_run_id

    def terminate(self, worker: str) -> None:
        """Stop every process this backend started for ``worker``.

        Idempotent by construction: it walks the worker's recorded runs,
        signals the process group of each, and ignores every "already gone"
        outcome. Calling it twice, or on a worker that never started, is safe.
        """

        worker_dir = self._worker_dir(worker)
        runs_dir = worker_dir / "runs"
        if runs_dir.is_dir():
            for run_dir in sorted(runs_dir.iterdir()):
                if run_dir.is_dir():
                    self._terminate_run(worker, run_dir.name)

        for run_id in [key for key in self._processes if key.startswith("run-")]:
            process = self._processes.get(run_id)
            if process is not None and process.poll() is None:
                try:
                    process.kill()
                except OSError:
                    pass

    # -- internals ---------------------------------------------------------

    def _terminate_run(self, worker: str, run_id: str) -> None:
        """Stop one run's process group, tolerating every already-dead case."""

        process = self._processes.pop(run_id, None)
        if process is not None and process.poll() is None:
            self._signal_process_group(process.pid)

        pid = self._recorded_pid(worker, run_id)
        if pid:
            self._signal_process_group(pid)

        record_path = self._run_record_path(worker, run_id)
        if record_path.exists():
            try:
                record = LocalRun.load(record_path)
            except (json.JSONDecodeError, OSError, TypeError):
                return
            status = self._status_path(worker, run_id)
            state = self._raw_status(worker, run_id).get("state")
            if state not in {JobState.COMPLETED.value, JobState.FAILED.value}:
                if not record.finished_at:
                    record.finished_at = _utc_now()
                    record.exit_code = record.exit_code if record.exit_code is not None else -signal.SIGTERM
                    record_path.write_text(
                        json.dumps(record.to_json(), indent=2, sort_keys=True) + "\n",
                        encoding="utf-8",
                    )
                    self._write_status(
                        worker,
                        run_id,
                        TrainingProgress(
                            state=JobState.STOPPED,
                            message="terminated by the local backend",
                        ),
                    )

    @staticmethod
    def _signal_process_group(pid: int) -> None:
        """Terminate a process group, ignoring the case where it is gone."""

        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                pass

    def _recorded_pid(self, worker: str, run_id: str) -> int:
        path = self._run_record_path(worker, run_id)
        if not path.exists():
            return 0
        try:
            return int(LocalRun.load(path).pid or 0)
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            return 0

    def _process_alive(self, worker: str, run_id: str) -> bool:
        """Whether this run's process is still running.

        Prefers the live handle. After a manager restart the handle is gone,
        so the recorded pid is probed with signal 0 - and a recycled pid would
        be a false positive, which is why a terminal status file always wins
        over this check in :meth:`poll`.
        """

        process = self._processes.get(run_id)
        if process is not None:
            return process.poll() is None

        pid = self._recorded_pid(worker, run_id)
        if not pid:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return False
        return True

    def _exit_code(self, worker: str, run_id: str) -> int | None:
        """The run's exit code, from the live handle or the record."""

        process = self._processes.get(run_id)
        if process is not None:
            return process.poll()
        path = self._run_record_path(worker, run_id)
        if not path.exists():
            return None
        try:
            record = LocalRun.load(path)
        except (json.JSONDecodeError, OSError, TypeError):
            return None
        return record.exit_code

    def _final_step(self, worker: str, run_id: str) -> int | None:
        """Step number of the completed run, from its metrics file if present."""

        metrics_path = self._checkpoint_dir(worker, run_id) / "metrics.json"
        if not metrics_path.exists():
            return None
        try:
            return int(json.loads(metrics_path.read_text(encoding="utf-8")).get("steps", 0))
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            return None

    def _raw_status(self, worker: str, run_id: str) -> dict[str, Any]:
        path = self._status_path(worker, run_id)
        if not path.exists():
            return {}
        try:
            return dict(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError, TypeError):
            return {}

    def _write_status(self, worker: str, run_id: str, progress: TrainingProgress) -> None:
        """Atomically write a progress record the manager will poll."""

        path = self._status_path(worker, run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = progress.to_json()
        payload["pid"] = self._recorded_pid(worker, run_id)
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        temporary.replace(path)

    @staticmethod
    def _progress_from_payload(payload: Mapping[str, Any]) -> TrainingProgress:
        """Convert a status payload into a :class:`TrainingProgress`.

        Unknown state strings become ``FAILED``: a state this backend does not
        understand is not evidence of progress.
        """

        raw_state = str(payload.get("state", "")).upper()
        try:
            state = JobState(raw_state)
        except ValueError:
            state = JobState.FAILED

        loss = payload.get("loss")
        eval_loss = payload.get("eval_loss")
        learning_rate = payload.get("learning_rate")

        return TrainingProgress(
            state=state,
            step=int(payload.get("step") or 0),
            total_steps=int(payload.get("total_steps") or 0),
            epoch=float(payload.get("epoch") or 0.0),
            loss=float(loss) if isinstance(loss, (int, float)) else None,
            eval_loss=float(eval_loss) if isinstance(eval_loss, (int, float)) else None,
            learning_rate=(
                float(learning_rate) if isinstance(learning_rate, (int, float)) else None
            ),
            tokens_seen=int(payload.get("tokens_seen") or 0),
            gpu_name=str(payload.get("gpu_name") or ""),
            gpu_hours=0.0,
            message=str(payload.get("message") or ""),
            updated_at=str(payload.get("updated_at") or _utc_now()),
        )

    def metrics(self, worker: str, run_id: str) -> dict[str, Any]:
        """Return the metrics the runner persisted, or ``{}`` if none yet.

        Not part of the backend interface, but the manager needs it to read
        the real result dict, and keeping it here avoids the manager guessing
        at file layout.
        """

        metrics_path = self._checkpoint_dir(worker, run_id) / "metrics.json"
        if not metrics_path.exists():
            return {}
        try:
            return dict(json.loads(metrics_path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError, TypeError):
            return {}

    def cost_note(self) -> str:
        """The explicit zero-cost statement for this backend."""

        return LOCAL_COST_NOTE

    def render_plan(self, config: TrainingRunConfig) -> str:
        """Human-readable description of what a local run will do.

        Uses :mod:`kairoforge.training.engine`'s plan renderer, which is
        import-light, so this prints on a machine with no torch.
        """

        from ..training.engine import trainable_parameter_report

        return textwrap.dedent(
            f"""\
            LOCAL TRAINING PLAN
            ===================
            {trainable_parameter_report(config)}
            dataset:           {config.dataset_dir}
            output:            {config.output_dir}
            precision:         {config.precision}
            epochs:            {config.epochs}
            max steps:         {config.max_steps or '(derived from dataset)'}

            {LOCAL_COST_NOTE}
            """
        )
