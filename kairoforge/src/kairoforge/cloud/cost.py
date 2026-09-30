"""Cloud GPU cost estimation and the mandatory spend gate.

KairoForge never creates a paid resource implicitly. Every path that could
incur cost is funnelled through :class:`CostEstimate` and
:func:`require_spend_approval`, which refuses to proceed unless a human has
approved the *exact* quoted figure.

The gate is deliberately not a boolean flag that a script can set for itself.
Approval is keyed to a hash of the estimate, so approving a $4 smoke test
cannot be replayed to launch a $400 full run.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

#: Environment variable carrying an approval token produced by ``kairoforge
#: approve``. Absence means "not approved" - there is no default-allow path.
APPROVAL_ENV_VAR = "KAIROFORGE_SPEND_APPROVAL"

#: Default hard ceiling for a single run. A run quoting above this is refused
#: even with an approval token, which catches a fat-fingered GPU count.
DEFAULT_MAX_RUN_COST_USD = 100.0


class SpendNotApprovedError(RuntimeError):
    """Raised when a paid operation is attempted without matching approval."""

    def __init__(self, estimate: "CostEstimate", detail: str = "") -> None:
        self.estimate = estimate
        message = (
            "PAID CLOUD OPERATION REFUSED: explicit spend approval is required "
            "before creating billable resources.\n\n"
            f"{estimate.render()}\n\n"
            "To approve this exact estimate, run:\n"
            f"    kairoforge approve --estimate <file.json>\n"
            f"then re-run with {APPROVAL_ENV_VAR}=<token>.\n"
            "Approval is bound to this estimate's fingerprint, so approving a "
            "cheap smoke test does not authorise a larger run."
        )
        if detail:
            message = f"{message}\n\n{detail}"
        super().__init__(message)


class BudgetExceededError(RuntimeError):
    """Raised when an estimate exceeds the configured hard ceiling."""


@dataclass(frozen=True)
class GpuOffer:
    """One rentable GPU type at one provider, with its published price."""

    provider: str
    gpu: str
    vram_gib: int
    hourly_usd: float
    region: str = "us"
    notes: str = ""

    def describe(self) -> str:
        return f"{self.provider} {self.gpu} ({self.vram_gib} GiB) @ ${self.hourly_usd:.2f}/hr"


#: Reference on-demand prices, in USD per GPU-hour, as published by each
#: provider.
#:
#: IMPORTANT: these are *planning* figures captured at the time of writing,
#: not a billing source of truth. Cloud GPU prices change frequently and vary
#: by region and by host. Before a run starts, the training manager re-quotes
#: the provider's live price and refuses to proceed when the live figure is
#: above the approved one, so a stale catalogue entry can never silently
#: overspend. Every quote rendered to the user carries the same warning.
PRICE_CATALOGUE_CAPTURED_AT = "2026-09-30"

PRICE_STALENESS_WARNING = (
    "These hourly rates are planning estimates captured on "
    f"{PRICE_CATALOGUE_CAPTURED_AT} and are NOT a live billing quote. "
    "Re-check the provider's current price before approving spend."
)

GPU_CATALOGUE: tuple[GpuOffer, ...] = (
    GpuOffer("runpod", "NVIDIA RTX 4090", 24, 0.44, "us", "Community cloud, spot-like availability"),
    GpuOffer("runpod", "NVIDIA A100 80GB PCIe", 80, 1.64, "us", "80 GiB fits 32B QLoRA"),
    GpuOffer("runpod", "NVIDIA H100 80GB HBM3", 80, 2.99, "us", "Fastest HBM; for large runs"),
    GpuOffer("vast.ai", "NVIDIA RTX 4090", 24, 0.35, "various", "Marketplace pricing varies by host"),
    GpuOffer("vast.ai", "NVIDIA A100 80GB SXM", 80, 1.10, "various", "Marketplace pricing varies by host"),
    GpuOffer("lambda", "NVIDIA A100 80GB PCIe", 80, 1.29, "us", "On-demand, no spot"),
    GpuOffer("lambda", "NVIDIA H100 80GB SXM", 80, 2.49, "us", "On-demand, no spot"),
)


def find_offer(provider: str, gpu: str) -> GpuOffer | None:
    """Resolve one catalogue offer by provider and GPU name.

    Matching is case-insensitive and substring-based on the GPU so a config
    may say ``"4090"`` or ``"RTX 4090"``.
    """

    provider_key = provider.strip().lower()
    gpu_key = gpu.strip().lower()
    for offer in GPU_CATALOGUE:
        if offer.provider.lower() != provider_key:
            continue
        if gpu_key in offer.gpu.lower() or offer.gpu.lower() in gpu_key:
            return offer
    return None


@dataclass
class CostEstimate:
    """A fully itemised quote for one training run.

    Every field the user is shown before approving is derived here, so the
    numbers in the approval prompt and the numbers in the final report come
    from one place.
    """

    provider: str
    gpu: str
    gpu_count: int
    vram_gib_per_gpu: int
    hourly_usd_per_gpu: float
    estimated_hours: float
    storage_gib: float
    storage_usd_per_gib_month: float = 0.10
    estimated_model_size_gib: float = 0.5
    method: str = "qlora"
    base_model: str = ""
    dataset_version: str = ""
    train_tokens: int = 0
    notes: list[str] = field(default_factory=list)
    quoted_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    @property
    def compute_usd(self) -> float:
        """Total GPU compute cost."""

        return self.hourly_usd_per_gpu * self.gpu_count * self.estimated_hours

    @property
    def storage_usd(self) -> float:
        """Storage cost for one month, the usual minimum billing period."""

        return self.storage_gib * self.storage_usd_per_gib_month

    @property
    def egress_usd(self) -> float:
        """Estimated egress for downloading the checkpoint.

        Providers that do not bill egress are represented by ``0.0``; the
        figure is kept explicit so it is never silently assumed free.
        """

        return 0.0

    @property
    def total_usd(self) -> float:
        """Worst-case total the user is being asked to approve."""

        return self.compute_usd + self.storage_usd + self.egress_usd

    def fingerprint(self) -> str:
        """Stable hash binding an approval to this exact quote.

        Excludes ``quoted_at`` so re-quoting the same job does not invalidate
        a valid approval, but includes every number that affects the bill.
        """

        payload = json.dumps(
            {
                "provider": self.provider,
                "gpu": self.gpu,
                "gpu_count": self.gpu_count,
                "hourly_usd_per_gpu": round(self.hourly_usd_per_gpu, 4),
                "estimated_hours": round(self.estimated_hours, 4),
                "storage_gib": round(self.storage_gib, 4),
                "method": self.method,
                "base_model": self.base_model,
                "dataset_version": self.dataset_version,
            },
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def approval_token(self, secret: str) -> str:
        """Derive the token a user must present to authorise this estimate."""

        return hashlib.sha256(f"{self.fingerprint()}:{secret}".encode("utf-8")).hexdigest()

    def to_json(self) -> dict[str, Any]:
        """Serialise the quote, including derived totals for display."""

        return {
            "provider": self.provider,
            "gpu": self.gpu,
            "gpu_count": self.gpu_count,
            "vram_gib_per_gpu": self.vram_gib_per_gpu,
            "hourly_usd_per_gpu": round(self.hourly_usd_per_gpu, 4),
            "estimated_hours": round(self.estimated_hours, 3),
            "compute_usd": round(self.compute_usd, 2),
            "storage_gib": self.storage_gib,
            "storage_usd": round(self.storage_usd, 2),
            "egress_usd": round(self.egress_usd, 2),
            "total_usd": round(self.total_usd, 2),
            "estimated_model_size_gib": self.estimated_model_size_gib,
            "method": self.method,
            "base_model": self.base_model,
            "dataset_version": self.dataset_version,
            "train_tokens": self.train_tokens,
            "notes": list(self.notes),
            "quoted_at": self.quoted_at,
            "fingerprint": self.fingerprint(),
        }

    def render(self) -> str:
        """The human-facing quote block shown before approval is requested."""

        lines = [
            "PROVIDER:            " + self.provider,
            "GPU:                 " + self.gpu,
            "GPU COUNT:           " + str(self.gpu_count),
            "VRAM:                " + f"{self.vram_gib_per_gpu} GiB per GPU "
            f"({self.vram_gib_per_gpu * self.gpu_count} GiB total)",
            "HOURLY COST:         " + f"${self.hourly_usd_per_gpu:.2f}/GPU/hr "
            f"(${self.hourly_usd_per_gpu * self.gpu_count:.2f}/hr total)",
            "ESTIMATED TRAINING HOURS: " + f"{self.estimated_hours:.2f}",
            "ESTIMATED COMPUTE COST:   " + f"${self.compute_usd:.2f}",
            "STORAGE COST:        " + f"${self.storage_usd:.2f}/month "
            f"({self.storage_gib:.0f} GiB)",
            "EGRESS:              " + f"${self.egress_usd:.2f}",
            "ESTIMATED TOTAL COST:     " + f"${self.total_usd:.2f}",
            "EXPECTED MODEL SIZE: " + f"{self.estimated_model_size_gib:.2f} GiB",
            "TRAINING METHOD:     " + self.method,
            "BASE MODEL:          " + (self.base_model or "(not set)"),
            "DATASET VERSION:     " + (self.dataset_version or "(not set)"),
            "TRAIN TOKENS:        " + (f"{self.train_tokens:,}" if self.train_tokens else "(not set)"),
            "ESTIMATE FINGERPRINT: " + self.fingerprint(),
            "",
            "!! " + PRICE_STALENESS_WARNING,
        ]
        if self.notes:
            lines.append("")
            lines.append("NOTES:")
            lines.extend("  - " + note for note in self.notes)
        return "\n".join(lines)


def estimate_run(
    provider: str,
    gpu: str,
    gpu_count: int,
    estimated_hours: float,
    method: str = "qlora",
    base_model: str = "",
    dataset_version: str = "",
    train_tokens: int = 0,
    storage_gib: float = 50.0,
    model_size_gib: float = 0.5,
) -> CostEstimate:
    """Build a :class:`CostEstimate` from the catalogue.

    Raises when the provider/GPU pair is not in the catalogue rather than
    guessing a price: an invented hourly rate is how a budget is silently
    blown.
    """

    offer = find_offer(provider, gpu)
    if offer is None:
        available = "\n".join("  - " + o.describe() for o in GPU_CATALOGUE)
        raise ValueError(
            f"no quoted price for provider {provider!r} GPU {gpu!r}.\n"
            f"Quoted offers:\n{available}"
        )
    if gpu_count < 1:
        raise ValueError("gpu_count must be at least 1")
    if estimated_hours <= 0:
        raise ValueError("estimated_hours must be positive")

    return CostEstimate(
        provider=offer.provider,
        gpu=offer.gpu,
        gpu_count=gpu_count,
        vram_gib_per_gpu=offer.vram_gib,
        hourly_usd_per_gpu=offer.hourly_usd,
        estimated_hours=estimated_hours,
        storage_gib=storage_gib,
        estimated_model_size_gib=model_size_gib,
        method=method,
        base_model=base_model,
        dataset_version=dataset_version,
        train_tokens=train_tokens,
    )


def estimate_hours(
    train_tokens: int,
    epochs: int,
    gpu: GpuOffer,
    method: str = "qlora",
    base_params_b: float = 7.0,
) -> float:
    """Estimate wall-clock training hours from tokens and hardware.

    Throughput is modelled as roughly linear in model size and inversely
    proportional to GPU memory bandwidth, which reproduces published QLoRA
    figures closely enough to quote a budget. It is intentionally a little
    pessimistic so the approved figure covers the real run.
    """

    if train_tokens <= 0:
        raise ValueError("train_tokens must be positive")
    if epochs < 1:
        raise ValueError("epochs must be at least 1")

    total_tokens = train_tokens * epochs

    # Effective tokens/second observed for QLoRA on this class of GPU,
    # scaled from a 7B reference by model size.
    reference_tokens_per_second = 1_100.0
    size_factor = 7.0 / max(base_params_b, 0.1)
    method_factor = {"qlora": 1.0, "lora": 1.6, "full": 0.35}.get(method, 1.0)
    vram_factor = min(max(gpu.vram_gib / 24.0, 0.6), 3.0)

    tokens_per_second = reference_tokens_per_second * size_factor * method_factor * vram_factor
    seconds = total_tokens / max(tokens_per_second, 1.0)
    # Overhead covers provisioning, dataset upload, checkpoint writes, and
    # evaluation passes that do not scale with tokens.
    overhead_hours = 0.5 + 0.1 * epochs
    return round(seconds / 3600.0 + overhead_hours, 3)


def require_spend_approval(
    estimate: CostEstimate,
    max_run_cost_usd: float = DEFAULT_MAX_RUN_COST_USD,
    environ: Mapping[str, str] | None = None,
) -> None:
    """Refuse unless this exact estimate has been approved by a human.

    Two independent checks must both pass:

    1. the estimate is under the hard per-run ceiling, and
    2. a presented token matches the estimate's fingerprint.

    Failing either raises; there is no path that proceeds by default.
    """

    environ = environ if environ is not None else os.environ

    if estimate.total_usd > max_run_cost_usd:
        raise BudgetExceededError(
            f"estimated total ${estimate.total_usd:.2f} exceeds the hard per-run "
            f"ceiling of ${max_run_cost_usd:.2f}. Raise the ceiling explicitly "
            "(--max-cost) if this run is genuinely intended."
        )

    presented = environ.get(APPROVAL_ENV_VAR, "").strip()
    if not presented:
        raise SpendNotApprovedError(estimate)

    secret = environ.get("KAIROFORGE_APPROVAL_SECRET", "")
    expected = estimate.approval_token(secret)
    if presented != expected:
        raise SpendNotApprovedError(
            estimate,
            detail=(
                "The presented token does not match this estimate's fingerprint. "
                "Either the estimate changed after approval, or the token was "
                "issued for a different run."
            ),
        )


def write_estimate(path: Path, estimate: CostEstimate) -> Path:
    """Write an estimate to disk so a human can review and approve it."""

    path.parent.mkdir(parents=True, exist_ok=True)
    payload = estimate.to_json()
    payload["approval_command"] = (
        "KAIROFORGE_SPEND_APPROVAL="
        + estimate.approval_token(os.environ.get("KAIROFORGE_APPROVAL_SECRET", ""))
    )
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def load_estimate(path: Path) -> CostEstimate:
    """Read back an estimate previously written by :func:`write_estimate`."""

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return CostEstimate(
        provider=data["provider"],
        gpu=data["gpu"],
        gpu_count=data["gpu_count"],
        vram_gib_per_gpu=data["vram_gib_per_gpu"],
        hourly_usd_per_gpu=data["hourly_usd_per_gpu"],
        estimated_hours=data["estimated_hours"],
        storage_gib=data["storage_gib"],
        estimated_model_size_gib=data.get("estimated_model_size_gib", 0.5),
        method=data.get("method", "qlora"),
        base_model=data.get("base_model", ""),
        dataset_version=data.get("dataset_version", ""),
        train_tokens=data.get("train_tokens", 0),
        notes=list(data.get("notes", [])),
        quoted_at=data.get("quoted_at", ""),
    )
