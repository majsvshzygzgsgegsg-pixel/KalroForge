"""The KairoForge model registry.

Tracks every trained version with the metadata needed to reproduce, audit, and
deploy it. Two rules are enforced in code rather than by convention:

1. **A version is never overwritten.** Publishing a version that already
   exists raises unless the caller explicitly asks to supersede it, and even
   then the previous entry is retained as a superseded revision rather than
   being replaced.
2. **A checkpoint hash is mandatory.** An entry without a verifiable artifact
   hash is not a model; it is a claim. The registry refuses to record one.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Iterator

#: On-disk schema version. Bumped when the entry shape changes so an old
#: registry file can be detected and migrated rather than silently misread.
REGISTRY_SCHEMA_VERSION = 2


class DeploymentStatus(str, Enum):
    """Where a version currently stands in the delivery pipeline."""

    TRAINING = "training"
    TRAINED = "trained"
    EVALUATED = "evaluated"
    DEPLOYED = "deployed"
    RETIRED = "retired"
    FAILED = "failed"


@dataclass
class EvaluationRecord:
    """Stored measurements for one evaluated version.

    Only real measurements are recorded. ``overall_score`` is the aggregate
    the evaluator computed, not an estimate.
    """

    evaluated_at: str
    task_count: int
    passed: int
    overall_score: float
    baseline_score: float | None = None
    by_family: dict[str, float] = field(default_factory=dict)
    by_language: dict[str, float] = field(default_factory=dict)
    report_path: str = ""

    @property
    def delta_vs_baseline(self) -> float | None:
        """Improvement over the base model on the same suite, when measured."""

        if self.baseline_score is None:
            return None
        return self.overall_score - self.baseline_score

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        data["delta_vs_baseline"] = self.delta_vs_baseline
        return data


@dataclass
class ModelVersion:
    """One registered KairoForge version."""

    version: str
    base_model: str
    base_revision: str
    training_method: str
    dataset_version: str
    dataset_hash: str
    train_tokens: int
    checkpoint_path: str
    checkpoint_sha256: str
    checkpoint_bytes: int
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    status: DeploymentStatus = DeploymentStatus.TRAINED
    trainable_parameters: int = 0
    total_parameters: int = 0
    training_config: dict[str, Any] = field(default_factory=dict)
    training_metrics: dict[str, Any] = field(default_factory=dict)
    cloud_provider: str = ""
    gpu: str = ""
    gpu_count: int = 0
    training_hours: float = 0.0
    training_cost_usd: float = 0.0
    evaluation: EvaluationRecord | None = None
    deployment_endpoint: str = ""
    notes: str = ""
    superseded_by: str = ""

    @property
    def trainable_fraction(self) -> float:
        """Fraction of parameters that were actually trained."""

        if self.total_parameters <= 0:
            return 0.0
        return self.trainable_parameters / self.total_parameters

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = self.status.value
        data["trainable_fraction"] = round(self.trainable_fraction, 6)
        data["evaluation"] = self.evaluation.to_json() if self.evaluation else None
        return data


class RegistryError(RuntimeError):
    """Raised when a registry invariant would be violated."""


class VersionExistsError(RegistryError):
    """Raised when publishing a version that is already registered."""

    def __init__(self, version: str, path: Path) -> None:
        super().__init__(
            f"version {version!r} is already registered at {path}. "
            "KairoForge never overwrites a released version. Publish a new "
            "version (e.g. v0.2), or pass supersede=True to replace it while "
            "retaining the previous entry as a superseded revision."
        )


class Registry:
    """JSON-backed registry of KairoForge versions.

    The file is written atomically and keeps a full revision history, so a bad
    publish can always be rolled back by reading the previous entry.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._versions: dict[str, ModelVersion] = {}
        self._history: list[dict[str, Any]] = []
        self._load()

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------

    def _load(self) -> None:
        if not self.path.exists():
            return
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        schema = raw.get("schema_version", 1)
        if schema > REGISTRY_SCHEMA_VERSION:
            raise RegistryError(
                f"registry at {self.path} uses schema {schema}, but this build "
                f"understands up to {REGISTRY_SCHEMA_VERSION}. Upgrade KairoForge."
            )
        self._history = list(raw.get("history", []))
        for version, payload in raw.get("versions", {}).items():
            self._versions[version] = _version_from_json(payload)

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": REGISTRY_SCHEMA_VERSION,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "versions": {
                version: entry.to_json()
                for version, entry in sorted(self._versions.items())
            },
            "history": self._history,
        }
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        temporary.replace(self.path)

    # ------------------------------------------------------------------
    # queries
    # ------------------------------------------------------------------

    def list_versions(self) -> list[ModelVersion]:
        """All registered versions, newest first by creation time."""

        return sorted(
            self._versions.values(), key=lambda entry: entry.created_at, reverse=True
        )

    def get(self, version: str) -> ModelVersion:
        """Look up one version, raising when it is absent."""

        if version not in self._versions:
            known = ", ".join(sorted(self._versions)) or "(none)"
            raise RegistryError(f"unknown version {version!r}. Registered: {known}")
        return self._versions[version]

    def exists(self, version: str) -> bool:
        """Whether a version is registered."""

        return version in self._versions

    def latest(self) -> ModelVersion | None:
        """The most recently created version, or ``None`` when empty."""

        versions = self.list_versions()
        return versions[0] if versions else None

    def deployed(self) -> ModelVersion | None:
        """The currently deployed version, if any."""

        for entry in self.list_versions():
            if entry.status is DeploymentStatus.DEPLOYED:
                return entry
        return None

    def __iter__(self) -> Iterator[ModelVersion]:
        return iter(self.list_versions())

    # ------------------------------------------------------------------
    # mutations
    # ------------------------------------------------------------------

    def publish(
        self, version: ModelVersion, supersede: bool = False
    ) -> ModelVersion:
        """Register a new version.

        Refuses to overwrite an existing version unless ``supersede`` is set,
        and records the superseded entry in the history either way.
        """

        if not version.checkpoint_sha256:
            raise RegistryError(
                f"version {version.version!r} has no checkpoint hash. "
                "A version without a verifiable artifact is not registrable."
            )
        if version.checkpoint_bytes <= 0:
            raise RegistryError(
                f"version {version.version!r} has a zero-byte checkpoint; "
                "refusing to register an empty artifact."
            )

        existing = self._versions.get(version.version)
        if existing is not None and not supersede:
            raise VersionExistsError(version.version, self.path)
        if existing is not None:
            superseded = existing.to_json()
            superseded["superseded_at"] = datetime.now(timezone.utc).isoformat()
            superseded["superseded_by_kind"] = "republish"
            self._history.append(superseded)

        self._versions[version.version] = version
        self._save()
        return version

    def update(self, version: str, **changes: Any) -> ModelVersion:
        """Apply a partial update, preserving the previous state in history."""

        entry = self.get(version)
        self._history.append(
            {
                **entry.to_json(),
                "revision_kind": "update",
                "revision_at": datetime.now(timezone.utc).isoformat(),
                "changed_fields": sorted(changes),
            }
        )
        for key, value in changes.items():
            if not hasattr(entry, key):
                raise RegistryError(f"version {version!r} has no field {key!r}")
            setattr(entry, key, value)
        self._save()
        return entry

    def supersede(self, old_version: str, new_version: str) -> None:
        """Mark ``old_version`` as replaced by ``new_version``."""

        self.get(old_version)
        self.get(new_version)
        self.update(old_version, superseded_by=new_version)
        if self._versions[old_version].status is DeploymentStatus.DEPLOYED:
            self.update(old_version, status=DeploymentStatus.RETIRED)

    def set_evaluation(self, version: str, evaluation: EvaluationRecord) -> ModelVersion:
        """Record measured evaluation results and advance the status."""

        entry = self.get(version)
        changes: dict[str, Any] = {"evaluation": evaluation}
        if entry.status is DeploymentStatus.TRAINED:
            changes["status"] = DeploymentStatus.EVALUATED
        return self.update(version, **changes)

    def mark_deployed(self, version: str, endpoint: str) -> ModelVersion:
        """Record that a version is serving at ``endpoint``.

        Any previously deployed version is retired first, so there is exactly
        one deployed version at a time and the registry never claims two live
        endpoints.
        """

        current = self.deployed()
        if current is not None and current.version != version:
            self.update(current.version, status=DeploymentStatus.RETIRED)
        return self.update(
            version, status=DeploymentStatus.DEPLOYED, deployment_endpoint=endpoint
        )

    def history_for(self, version: str) -> list[dict[str, Any]]:
        """Every historical revision recorded for one version."""

        return [
            entry
            for entry in self._history
            if entry.get("version") == version
        ]


def _version_from_json(payload: dict[str, Any]) -> ModelVersion:
    """Rebuild a :class:`ModelVersion` from its stored JSON."""

    data = dict(payload)
    data.pop("trainable_fraction", None)
    evaluation = data.get("evaluation")
    data["evaluation"] = _evaluation_from_json(evaluation) if evaluation else None
    data["status"] = DeploymentStatus(data.get("status", "trained"))
    known = {field_name for field_name in ModelVersion.__dataclass_fields__}
    data = {key: value for key, value in data.items() if key in known}
    return ModelVersion(**data)


def _evaluation_from_json(payload: dict[str, Any]) -> EvaluationRecord:
    data = dict(payload)
    data.pop("delta_vs_baseline", None)
    known = {field_name for field_name in EvaluationRecord.__dataclass_fields__}
    data = {key: value for key, value in data.items() if key in known}
    return EvaluationRecord(**data)


def hash_directory(path: Path) -> tuple[str, int]:
    """Compute a deterministic hash and total size of a checkpoint directory.

    Files are hashed in sorted relative-path order with the path folded into
    the digest, so renaming a file changes the hash and a re-download produces
    the same value.
    """

    path = Path(path)
    if not path.exists():
        raise RegistryError(f"checkpoint path does not exist: {path}")

    digest = hashlib.sha256()
    total = 0

    if path.is_file():
        payload = path.read_bytes()
        digest.update(path.name.encode("utf-8"))
        digest.update(payload)
        return digest.hexdigest(), len(payload)

    for file_path in sorted(p for p in path.rglob("*") if p.is_file()):
        relative = file_path.relative_to(path).as_posix()
        digest.update(relative.encode("utf-8"))
        with file_path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
                total += len(block)
    return digest.hexdigest(), total


def verify_checkpoint(path: Path, expected_sha256: str) -> bool:
    """Re-hash a checkpoint and confirm it matches the registry entry.

    This is the check that proves a deployed artifact is the one that was
    evaluated, rather than a similarly named file.
    """

    actual, _ = hash_directory(path)
    return actual == expected_sha256
