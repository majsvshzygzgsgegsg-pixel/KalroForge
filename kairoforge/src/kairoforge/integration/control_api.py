"""Training-control API for the harness.

This is the interface the harness's training panel (Phase 17) calls. It is a
thin, framework-agnostic facade over :class:`TrainingManager`, the registry,
and the evaluator, exposed as plain ``(status, payload)`` methods so it can be
mounted behind the harness's HTTP layer or driven from a test without one.

The capabilities mirror exactly what the harness must be able to do:

    Create Training Job  -> :meth:`create_job`
    Dataset              -> :meth:`list_datasets`
    Base Model           -> :meth:`list_base_models`
    Training Method      -> :meth:`list_methods`
    Cloud Provider       -> :meth:`list_providers`
    GPU                  -> :meth:`list_gpus`
    Estimated Cost       -> :meth:`estimate_cost`
    Start                -> :meth:`start_job`
    Stop                 -> :meth:`stop_job`
    Status               -> :meth:`job_status`
    Logs                 -> :meth:`job_logs`
    Checkpoints          -> :meth:`job_checkpoints`
    Evaluate             -> :meth:`evaluate_version`
    Deploy               -> :meth:`deploy_version`

Spend safety is preserved through this surface: :meth:`start_job` forwards to
the manager's gate, so a paid job cannot be started from the UI without the
same approval token the CLI requires.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..base_models import CATALOGUE, ModelSpec
from ..cloud.backend import JobState
from ..cloud.cost import (
    GPU_CATALOGUE,
    BudgetExceededError,
    SpendNotApprovedError,
)
from ..cloud.manager import ManagerPaths, TrainingManager, TrainingRequest
from ..registry.store import Registry, RegistryError


@dataclass
class TrainingControlApi:
    """Facade over the training subsystem for the harness UI."""

    home: Path
    registry_path: Path

    def __post_init__(self) -> None:
        self.home = Path(self.home)
        self.registry_path = Path(self.registry_path)

    # ------------------------------------------------------------------
    # catalogue
    # ------------------------------------------------------------------

    def list_base_models(self) -> tuple[int, dict[str, Any]]:
        """Every verified open-weight base model, with licence and VRAM."""

        return 200, {
            "base_models": [
                {
                    "key": spec.key,
                    "repo_id": spec.repo_id,
                    "display_name": spec.display_name,
                    "parameter_count": spec.parameter_count,
                    "context_length": spec.context_length,
                    "license": spec.license,
                    "license_url": spec.license_url,
                    "source": spec.source,
                    "revision": spec.revision,
                    "supports_tool_calling": spec.supports_tool_calling,
                    "recommended_role": spec.recommended_role,
                    "vram_gib": {
                        "qlora": spec.vram_gib("qlora"),
                        "lora": spec.vram_gib("lora"),
                        "full": spec.vram_gib("full"),
                    },
                }
                for spec in CATALOGUE
            ],
            "note": (
                "KairoForge is fine-tuned from one of these open-weight base "
                "models. It is not trained from scratch."
            ),
        }

    def list_methods(self) -> tuple[int, dict[str, Any]]:
        """Training methods the engine supports, with cost tradeoffs."""

        return 200, {
            "methods": [
                {
                    "id": "qlora",
                    "name": "QLoRA (4-bit)",
                    "description": "Cheapest. 4-bit base weights with fp16 adapters.",
                    "recommended": True,
                },
                {
                    "id": "lora",
                    "name": "LoRA (bf16)",
                    "description": "Faster per step, but base weights stay in bf16 and need more VRAM.",
                    "recommended": False,
                },
                {
                    "id": "full",
                    "name": "Full fine-tuning",
                    "description": "Updates every weight. Needs a large multi-GPU budget; not recommended for v0.1.",
                    "recommended": False,
                },
            ]
        }

    def list_providers(self) -> tuple[int, dict[str, Any]]:
        """Cloud providers with quoted GPU offers."""

        by_provider: dict[str, list[dict[str, Any]]] = {}
        for offer in GPU_CATALOGUE:
            by_provider.setdefault(offer.provider, []).append(
                {
                    "gpu": offer.gpu,
                    "vram_gib": offer.vram_gib,
                    "hourly_usd": offer.hourly_usd,
                    "region": offer.region,
                    "notes": offer.notes,
                }
            )
        providers = [
            {
                "id": "local",
                "name": "Local (this machine)",
                "billable": False,
                "gpus": [],
                "note": "Costs nothing. Training time is bounded by local hardware.",
            }
        ]
        for name, gpus in sorted(by_provider.items()):
            providers.append(
                {
                    "id": name,
                    "name": name.title(),
                    "billable": True,
                    "gpus": gpus,
                }
            )
        return 200, {"providers": providers}

    def list_gpus(self) -> tuple[int, dict[str, Any]]:
        """Flat list of quoted GPU offers."""

        return 200, {
            "gpus": [
                {
                    "provider": offer.provider,
                    "gpu": offer.gpu,
                    "vram_gib": offer.vram_gib,
                    "hourly_usd": offer.hourly_usd,
                }
                for offer in GPU_CATALOGUE
            ]
        }

    def list_datasets(self) -> tuple[int, dict[str, Any]]:
        """Processed datasets discoverable under the KairoForge home."""

        datasets = []
        for manifest_path in sorted(self.home.glob("**/manifest.json")):
            try:
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            datasets.append(
                {
                    "dataset_version": data.get("dataset_version"),
                    "directory": str(manifest_path.parent),
                    "records": data.get("total_records", 0),
                    "estimated_tokens": data.get("estimated_tokens", 0),
                    "splits": data.get("splits", {}),
                    "sources": [
                        {
                            "source": shard.get("source"),
                            "license": shard.get("license"),
                        }
                        for shard in data.get("shards", [])
                    ],
                }
            )
        return 200, {"datasets": datasets}

    # ------------------------------------------------------------------
    # jobs
    # ------------------------------------------------------------------

    def estimate_cost(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """Quote a job before creating it."""

        try:
            base = _resolve_base(body.get("base_model"))
            manager = TrainingManager(
                ManagerPaths(self.home / "state"), _backend_for(body.get("provider", "local"), self.home)
            )
            request = TrainingRequest(
                version=body.get("version", "kairoforge-v0.1"),
                base_model=base.repo_id,
                base_revision=base.revision,
                dataset_dir=Path(body.get("dataset_dir", ".")),
                dataset_version=body.get("dataset_version", ""),
                train_tokens=int(body.get("train_tokens", 0)),
                method=body.get("method", "qlora"),
                provider=body.get("provider", "local"),
                gpu=body.get("gpu", "RTX 4090"),
                gpu_count=int(body.get("gpu_count", 1)),
                epochs=int(body.get("epochs", 1)),
                config=dict(body.get("config") or {}),
            )
            estimate = manager.estimate(request)
        except (ValueError, RegistryError) as exc:
            return 400, {"error": {"message": str(exc), "type": "invalid_request"}}

        return 200, estimate.to_json()

    def create_job(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """Create a training job and persist its quote."""

        try:
            base = _resolve_base(body.get("base_model"))
            dataset_dir = Path(body["dataset_dir"])
            if not (dataset_dir / "train.jsonl").exists():
                return 400, {
                    "error": {
                        "message": f"{dataset_dir}/train.jsonl not found; prepare the dataset first",
                        "type": "invalid_request",
                    }
                }
            manager = TrainingManager(
                ManagerPaths(self.home / "state"), _backend_for(body.get("provider", "local"), self.home)
            )
            request = TrainingRequest(
                version=body["version"],
                base_model=base.repo_id,
                base_revision=base.revision,
                dataset_dir=dataset_dir,
                dataset_version=body.get("dataset_version", dataset_dir.name),
                train_tokens=int(body.get("train_tokens", 0)) or _estimate_tokens(dataset_dir),
                method=body.get("method", "qlora"),
                provider=body.get("provider", "local"),
                gpu=body.get("gpu", "RTX 4090"),
                gpu_count=int(body.get("gpu_count", 1)),
                epochs=int(body.get("epochs", 1)),
                config=dict(body.get("config") or {}),
            )
            job = manager.create(request)
            manager.write_estimate(job.job_id, job.estimate)
        except KeyError as exc:
            return 400, {"error": {"message": f"missing field {exc}", "type": "invalid_request"}}
        except (ValueError, RegistryError) as exc:
            return 400, {"error": {"message": str(exc), "type": "invalid_request"}}

        return 201, job.to_json()

    def start_job(self, job_id: str) -> tuple[int, dict[str, Any]]:
        """Start a job, preserving the spend gate."""

        try:
            job = self._manager_for_job(job_id).run(job_id, poll_interval=5.0)
        except SpendNotApprovedError as exc:
            return 402, {
                "error": {
                    "message": str(exc),
                    "type": "spend_not_approved",
                    "code": "KAIROFORGE_SPEND_APPROVAL_REQUIRED",
                }
            }
        except BudgetExceededError as exc:
            return 403, {
                "error": {
                    "message": str(exc),
                    "type": "budget_exceeded",
                    "code": "KAIROFORGE_BUDGET_EXCEEDED",
                }
            }
        except Exception as exc:
            return 500, {
                "error": {"message": f"{type(exc).__name__}: {exc}", "type": "start_failed"}
            }
        return 200, job.to_json()

    def stop_job(self, job_id: str) -> tuple[int, dict[str, Any]]:
        """Stop a job and release its worker."""

        try:
            job = self._manager_for_job(job_id).stop(job_id)
        except Exception as exc:
            return 404, {"error": {"message": str(exc), "type": "not_found"}}
        return 200, job.to_json()

    def job_status(self, job_id: str | None = None) -> tuple[int, dict[str, Any]]:
        """Real status for one job, or a list of all jobs."""

        try:
            manager = self._manager_for_job(job_id) if job_id else self._any_manager()
            if job_id:
                return 200, manager.status(job_id)
            return 200, {"jobs": [job.to_json() for job in manager.list_jobs()]}
        except Exception as exc:
            return 404, {"error": {"message": str(exc), "type": "not_found"}}

    def job_logs(self, job_id: str, tail: int = 200) -> tuple[int, dict[str, Any]]:
        """Recent log lines for one job."""

        try:
            text = self._manager_for_job(job_id).logs(job_id, tail=tail)
        except Exception as exc:
            return 404, {"error": {"message": str(exc), "type": "not_found"}}
        return 200, {"job_id": job_id, "logs": text}

    def job_checkpoints(self, job_id: str) -> tuple[int, dict[str, Any]]:
        """Checkpoints durably stored for one job."""

        try:
            found = self._manager_for_job(job_id).checkpoints(job_id)
        except Exception as exc:
            return 404, {"error": {"message": str(exc), "type": "not_found"}}
        return 200, {"job_id": job_id, "checkpoints": [c.to_json() for c in found]}

    # ------------------------------------------------------------------
    # versions
    # ------------------------------------------------------------------

    def list_versions(self) -> tuple[int, dict[str, Any]]:
        """Every registered KairoForge version."""

        registry = Registry(self.registry_path)
        return 200, {"versions": [entry.to_json() for entry in registry.list_versions()]}

    def version_detail(self, version: str) -> tuple[int, dict[str, Any]]:
        """Full metadata for one version, including evaluation results."""

        registry = Registry(self.registry_path)
        try:
            return 200, registry.get(version).to_json()
        except RegistryError as exc:
            return 404, {"error": {"message": str(exc), "type": "not_found"}}

    def evaluate_version(self, version: str, report: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """Record measured evaluation results for a version.

        The API deliberately accepts a *completed* report rather than running
        evaluation itself: measurement happens where the model is reachable,
        and this endpoint stores the outcome. It refuses an empty report so a
        version cannot be marked ``evaluated`` without measurements.
        """

        from ..registry.store import EvaluationRecord

        registry = Registry(self.registry_path)
        try:
            registry.get(version)
        except RegistryError as exc:
            return 404, {"error": {"message": str(exc), "type": "not_found"}}

        if not report or report.get("task_count", 0) <= 0:
            return 400, {
                "error": {
                    "message": "an evaluation report with task_count > 0 is required; "
                    "KairoForge does not mark a version evaluated without measurements",
                    "type": "invalid_request",
                }
            }

        evaluation = EvaluationRecord(
            evaluated_at=report.get("evaluated_at", ""),
            task_count=int(report["task_count"]),
            passed=int(report.get("passed", 0)),
            overall_score=float(report.get("overall_score", 0.0)),
            baseline_score=report.get("baseline_score"),
            by_family=dict(report.get("by_family") or {}),
            by_language=dict(report.get("by_language") or {}),
            report_path=report.get("report_path", ""),
        )
        entry = registry.set_evaluation(version, evaluation)
        return 200, entry.to_json()

    def deploy_version(self, version: str, endpoint: str) -> tuple[int, dict[str, Any]]:
        """Mark a version deployed at an endpoint.

        Requires the version to have been evaluated first: deploying an
        unmeasured model is how a regression reaches users unnoticed.
        """

        registry = Registry(self.registry_path)
        try:
            entry = registry.get(version)
        except RegistryError as exc:
            return 404, {"error": {"message": str(exc), "type": "not_found"}}

        if entry.evaluation is None:
            return 409, {
                "error": {
                    "message": (
                        f"{version} has no evaluation results recorded. Evaluate it "
                        "before deploying so a regression cannot ship unmeasured."
                    ),
                    "type": "not_evaluated",
                }
            }
        if not endpoint:
            return 400, {"error": {"message": "endpoint is required", "type": "invalid_request"}}

        updated = registry.mark_deployed(version, endpoint)
        return 200, updated.to_json()

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _any_manager(self) -> TrainingManager:
        """A manager over the default backend, for listing jobs across backends.

        Job records are backend-agnostic; the local backend is used purely as a
        reader. Starting or stopping a job always resolves the correct backend
        from the job record instead.
        """

        return TrainingManager(ManagerPaths(self.home / "state"), _backend_for("local", self.home))

    def _manager_for_job(self, job_id: str) -> TrainingManager:
        """Resolve the manager whose backend matches the job's recorded provider."""

        reader = self._any_manager()
        job = reader.load(job_id)
        return TrainingManager(
            ManagerPaths(self.home / "state"), _backend_for(job.provider, self.home)
        )


def _resolve_base(name: Any) -> ModelSpec:
    """Resolve a base model from a request body, defaulting to the v0.1 base."""

    from ..base_models import DEFAULT_BASE, resolve_base_model

    if not name:
        return DEFAULT_BASE
    return resolve_base_model(str(name))


def _backend_for(provider: Any, root: "Path"):
    """Resolve a provider name to a backend instance.

    ``root`` is the directory the local backend owns: its job bundles,
    "remote" prefix, run state, and logs all live there, which is what makes
    cleanup verifiable. Cloud backends ignore it.
    """

    from ..cloud.local_backend import LocalTrainingBackend

    name = str(provider or "local")
    if name == "local":
        return LocalTrainingBackend(Path(root) / "backend")
    try:
        from ..cloud.runpod_backend import RunpodBackend

        return RunpodBackend()
    except ImportError as exc:
        raise ValueError(
            f"the {name} backend is not available in this build ({exc}); "
            "use provider 'local'"
        ) from exc


def _estimate_tokens(dataset_dir: Path) -> int:
    """Estimate training tokens from a processed dataset."""

    manifest = dataset_dir / "manifest.json"
    if manifest.exists():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            if data.get("estimated_tokens"):
                return int(data["estimated_tokens"])
        except Exception:
            pass
    train = dataset_dir / "train.jsonl"
    if not train.exists():
        return 0
    total = sum(len(line) for line in train.read_text(encoding="utf-8").splitlines() if line.strip())
    return max(1, int(total / 3.6))
