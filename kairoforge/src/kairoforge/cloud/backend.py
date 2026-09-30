"""Cloud training backend abstraction.

KairoForge must not be welded to one GPU vendor. Everything provider-specific
sits behind :class:`CloudTrainingBackend`; the training manager speaks only
this interface, so adding a provider is a new subclass rather than a change to
the pipeline.

The lifecycle mirrors what the user asked to be able to do:

    prepare -> upload -> provision -> start -> poll -> checkpoint -> stop -> fetch

Every implementation must satisfy two invariants the manager relies on:

* ``terminate`` is idempotent and is safe to call at any point, including
  after a failure, so a crash cannot leave an expensive GPU running;
* checkpoints are written to persistent storage that outlives the worker, so
  losing the worker never loses the model.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

from .cost import CostEstimate


class JobState(str, Enum):
    """Lifecycle states a training job moves through.

    Reporting uses these exact values; no state is ever synthesised to look
    like progress. ``TRAINING`` is entered only once the worker reports its
    first real step.
    """

    PENDING = "PENDING"
    PREPARING = "PREPARING"
    WAITING_FOR_APPROVAL = "WAITING_FOR_APPROVAL"
    PROVISIONING = "PROVISIONING"
    UPLOADING_DATA = "UPLOADING_DATA"
    STARTING = "STARTING"
    TRAINING = "TRAINING"
    CHECKPOINTING = "CHECKPOINTING"
    EVALUATING = "EVALUATING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    STOPPING = "STOPPING"
    STOPPED = "STOPPED"

    @property
    def terminal(self) -> bool:
        """Whether this state ends the job's life."""

        return self in {
            JobState.COMPLETED,
            JobState.FAILED,
            JobState.STOPPED,
        }

    @property
    def billable(self) -> bool:
        """Whether GPU resources are expected to be running and costing money."""

        return self in {
            JobState.PROVISIONING,
            JobState.UPLOADING_DATA,
            JobState.STARTING,
            JobState.TRAINING,
            JobState.CHECKPOINTING,
            JobState.EVALUATING,
        }


@dataclass
class TrainingProgress:
    """Real, worker-reported progress. Never a synthesised percentage."""

    state: JobState
    step: int = 0
    total_steps: int = 0
    epoch: float = 0.0
    loss: float | None = None
    eval_loss: float | None = None
    learning_rate: float | None = None
    tokens_seen: int = 0
    gpu_name: str = ""
    gpu_hours: float = 0.0
    message: str = ""
    updated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    @property
    def percent(self) -> float | None:
        """Fraction complete, or ``None`` when the total is genuinely unknown.

        Returning ``None`` rather than 0 is deliberate: the UI must show an
        indeterminate state instead of a fake 0%.
        """

        if self.total_steps <= 0:
            return None
        return min(100.0, 100.0 * self.step / self.total_steps)

    def to_json(self) -> dict[str, Any]:
        return {
            "state": self.state.value,
            "step": self.step,
            "total_steps": self.total_steps,
            "percent": self.percent,
            "epoch": round(self.epoch, 4),
            "loss": self.loss,
            "eval_loss": self.eval_loss,
            "learning_rate": self.learning_rate,
            "tokens_seen": self.tokens_seen,
            "gpu_name": self.gpu_name,
            "gpu_hours": round(self.gpu_hours, 3),
            "message": self.message,
            "updated_at": self.updated_at,
        }


@dataclass
class CheckpointRef:
    """A checkpoint durably stored outside the training worker."""

    step: int
    uri: str
    sha256: str
    size_bytes: int
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    is_final: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "uri": self.uri,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
            "created_at": self.created_at,
            "is_final": self.is_final,
        }


class BackendError(RuntimeError):
    """A cloud backend could not complete an operation."""


class CloudTrainingBackend(ABC):
    """One provider's implementation of the cloud training lifecycle."""

    #: Stable identifier used in configs and the registry.
    name: str = "abstract"

    @abstractmethod
    def prepare(self, job_dir: Path, plan: Mapping[str, Any]) -> None:
        """Write the job bundle (config, data, container spec) into ``job_dir``."""

    @abstractmethod
    def upload(self, job_dir: Path, remote_prefix: str) -> str:
        """Synchronise the job bundle to provider storage; return its URI."""

    @abstractmethod
    def provision(self, estimate: CostEstimate, plan: Mapping[str, Any]) -> str:
        """Start the GPU worker and return a worker handle.

        Implementations must attach an idle timeout and a maximum lifetime so
        a leaked worker cannot bill indefinitely.
        """

    @abstractmethod
    def start(self, worker: str, remote_prefix: str, plan: Mapping[str, Any]) -> str:
        """Launch training inside the worker; return a run id."""

    @abstractmethod
    def poll(self, worker: str, run_id: str) -> TrainingProgress:
        """Return the worker's current *real* state."""

    @abstractmethod
    def logs(self, worker: str, run_id: str, tail: int = 200) -> str:
        """Return recent log lines."""

    @abstractmethod
    def checkpoints(self, worker: str, run_id: str) -> list[CheckpointRef]:
        """List checkpoints durably written so far."""

    @abstractmethod
    def fetch(self, checkpoint: CheckpointRef, destination: Path) -> Path:
        """Download one checkpoint to ``destination``."""

    @abstractmethod
    def resume(self, worker: str, run_id: str, checkpoint: CheckpointRef) -> str:
        """Restart training from ``checkpoint``; return a new run id."""

    @abstractmethod
    def terminate(self, worker: str) -> None:
        """Release the GPU worker. Must be idempotent and always safe to call."""


@dataclass
class TrainingJob:
    """Durable description of one training run, persisted as JSON.

    This record is the single source of truth the registry, the API, and the
    harness training panel all read.
    """

    job_id: str
    version: str
    base_model: str
    dataset_version: str
    dataset_path: str
    method: str
    provider: str
    gpu: str
    gpu_count: int
    state: JobState = JobState.PENDING
    estimate: CostEstimate | None = None
    worker: str = ""
    run_id: str = ""
    remote_prefix: str = ""
    progress: TrainingProgress | None = None
    checkpoints: list[CheckpointRef] = field(default_factory=list)
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    error: str = ""
    config: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] = field(default_factory=dict)

    def touch(self) -> None:
        """Refresh the modification timestamp."""

        self.updated_at = datetime.now(timezone.utc).isoformat()

    def to_json(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "version": self.version,
            "base_model": self.base_model,
            "dataset_version": self.dataset_version,
            "dataset_path": self.dataset_path,
            "method": self.method,
            "provider": self.provider,
            "gpu": self.gpu,
            "gpu_count": self.gpu_count,
            "state": self.state.value,
            "estimate": self.estimate.to_json() if self.estimate else None,
            "worker": self.worker,
            "run_id": self.run_id,
            "remote_prefix": self.remote_prefix,
            "progress": self.progress.to_json() if self.progress else None,
            "checkpoints": [checkpoint.to_json() for checkpoint in self.checkpoints],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "error": self.error,
            "config": self.config,
            "result": self.result,
        }

    def save(self, path: Path) -> Path:
        """Persist the job record atomically."""

        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(self.to_json(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        temporary.replace(path)
        return path

    @classmethod
    def load(cls, path: Path) -> "TrainingJob":
        """Read a job record back from disk."""

        data = json.loads(Path(path).read_text(encoding="utf-8"))
        from .cost import CostEstimate as _CostEstimate

        estimate = None
        if data.get("estimate"):
            raw = data["estimate"]
            estimate = _CostEstimate(
                provider=raw["provider"],
                gpu=raw["gpu"],
                gpu_count=raw["gpu_count"],
                vram_gib_per_gpu=raw["vram_gib_per_gpu"],
                hourly_usd_per_gpu=raw["hourly_usd_per_gpu"],
                estimated_hours=raw["estimated_hours"],
                storage_gib=raw["storage_gib"],
                estimated_model_size_gib=raw.get("estimated_model_size_gib", 0.5),
                method=raw.get("method", "qlora"),
                base_model=raw.get("base_model", ""),
                dataset_version=raw.get("dataset_version", ""),
                train_tokens=raw.get("train_tokens", 0),
                quoted_at=raw.get("quoted_at", ""),
            )
        progress = None
        if data.get("progress"):
            raw_progress = dict(data["progress"])
            raw_progress.pop("percent", None)
            raw_progress["state"] = JobState(raw_progress["state"])
            progress = TrainingProgress(**raw_progress)

        return cls(
            job_id=data["job_id"],
            version=data["version"],
            base_model=data["base_model"],
            dataset_version=data["dataset_version"],
            dataset_path=data["dataset_path"],
            method=data["method"],
            provider=data["provider"],
            gpu=data["gpu"],
            gpu_count=data["gpu_count"],
            state=JobState(data["state"]),
            estimate=estimate,
            worker=data.get("worker", ""),
            run_id=data.get("run_id", ""),
            remote_prefix=data.get("remote_prefix", ""),
            progress=progress,
            checkpoints=[
                CheckpointRef(**checkpoint) for checkpoint in data.get("checkpoints", [])
            ],
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
            error=data.get("error", ""),
            config=dict(data.get("config", {})),
            result=dict(data.get("result", {})),
        )
