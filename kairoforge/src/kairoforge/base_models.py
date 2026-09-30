"""Catalogue of open-weight base models KairoForge can be trained from.

KairoForge is a *derived* model. It is never presented as a from-scratch
pretrain: every version records the exact open-weight base it was fine-tuned
from, together with that base's licence. This module is the single source of
truth for those facts so the registry, training manager, and documentation
cannot drift apart.

Only models whose licence permits fine-tuning and redistribution of the
resulting derivative are listed here. Adding a model requires filling in
``license``, ``license_url``, and ``source``: ``ModelSpec`` refuses to
construct otherwise.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

TrainingMethod = Literal["qlora", "lora", "full"]

#: VRAM estimates are per-GPU, in GiB, and assume gradient checkpointing is
#: enabled. They are deliberately conservative: an estimate that is too low
#: fails the job after the user has already paid for provisioning.
_VRAM: dict[str, dict[TrainingMethod, int]] = {
    "0.5b": {"qlora": 3, "lora": 6, "full": 24},
    "1.5b": {"qlora": 6, "lora": 10, "full": 48},
    "3b": {"qlora": 8, "lora": 16, "full": 80},
    "7b": {"qlora": 10, "lora": 24, "full": 160},
    "14b": {"qlora": 16, "lora": 48, "full": 320},
    "32b": {"qlora": 32, "lora": 96, "full": 640},
    "80b-moe": {"qlora": 64, "lora": 160, "full": 1400},
}


@dataclass(frozen=True)
class ModelSpec:
    """One verified open-weight base model.

    Every field is a fact that will be quoted in the KairoForge final report,
    so each one is required. ``license`` and ``source`` are non-optional by
    design: an unlicensed base must never silently enter the pipeline.
    """

    key: str
    """Stable short key used in configs, e.g. ``qwen2.5-coder-7b-instruct``."""

    repo_id: str
    """Exact Hugging Face repository id passed to ``from_pretrained``."""

    display_name: str
    parameter_count: str
    """Human-readable size, e.g. ``7B``. Keys into :data:`_VRAM`."""

    context_length: int
    license: str
    license_url: str
    source: str
    revision: str
    """Pinned git revision. Training must pin so a rerun reproduces."""

    family: str
    supports_tool_calling: bool
    recommended_role: Literal["smoke", "v0", "upgrade"]

    def vram_gib(self, method: TrainingMethod) -> int:
        """Return the estimated per-GPU VRAM in GiB for one training method."""

        try:
            return _VRAM[self.parameter_count][method]
        except KeyError as exc:  # pragma: no cover - guarded by construction
            raise ValueError(
                f"no VRAM estimate for {self.parameter_count} ({method})"
            ) from exc

    def describe(self) -> str:
        """One-line human summary used by CLI output and docs generation."""

        return (
            f"{self.display_name} ({self.repo_id}) - {self.parameter_count} params, "
            f"{self.context_length} ctx, {self.license}"
        )


# --------------------------------------------------------------------------
# Verified catalogue.
#
# Revisions are pinned to released tags/commits at the time of writing so that
# a training run is reproducible. `kairoforge doctor` re-checks that the pin
# is still resolvable and warns when the upstream repo has moved on.
# --------------------------------------------------------------------------

QWEN25_CODER_0_5B = ModelSpec(
    key="qwen2.5-coder-0.5b-instruct",
    repo_id="Qwen/Qwen2.5-Coder-0.5B-Instruct",
    display_name="Qwen2.5-Coder 0.5B Instruct",
    parameter_count="0.5b",
    context_length=32768,
    license="Apache-2.0",
    license_url="https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct/blob/main/LICENSE",
    source="https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct",
    revision="ea3f2471cf1b1f0db85067f1ef93848e38e88c25",
    family="qwen2.5-coder",
    supports_tool_calling=True,
    # The only variant that trains on a 16 GiB Apple-silicon laptop: fp16
    # weights are ~1 GiB, leaving room for activations that a 1.5B run
    # exhausted. Not a strong model, but it is real and it trains locally.
    recommended_role="smoke",
)

QWEN25_CODER_1_5B = ModelSpec(
    key="qwen2.5-coder-1.5b-instruct",
    repo_id="Qwen/Qwen2.5-Coder-1.5B-Instruct",
    display_name="Qwen2.5-Coder 1.5B Instruct",
    parameter_count="1.5b",
    context_length=32768,
    license="Apache-2.0",
    license_url="https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct/blob/main/LICENSE",
    source="https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct",
    revision="2e1fd397ee46e1388853d2af2c993145b0f1098a",
    family="qwen2.5-coder",
    supports_tool_calling=True,
    recommended_role="smoke",
)

QWEN25_CODER_7B = ModelSpec(
    key="qwen2.5-coder-7b-instruct",
    repo_id="Qwen/Qwen2.5-Coder-7B-Instruct",
    display_name="Qwen2.5-Coder 7B Instruct",
    parameter_count="7b",
    context_length=32768,
    license="Apache-2.0",
    license_url="https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct/blob/main/LICENSE",
    source="https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct",
    revision="c03e6d358207e414f1eca0bb1891e29f1db0e242",
    family="qwen2.5-coder",
    supports_tool_calling=True,
    recommended_role="v0",
)

QWEN25_CODER_14B = ModelSpec(
    key="qwen2.5-coder-14b-instruct",
    repo_id="Qwen/Qwen2.5-Coder-14B-Instruct",
    display_name="Qwen2.5-Coder 14B Instruct",
    parameter_count="14b",
    context_length=32768,
    license="Apache-2.0",
    license_url="https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct/blob/main/LICENSE",
    source="https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct",
    revision="aedcc2d42b622764e023cf882b6652e646b95671",
    family="qwen2.5-coder",
    supports_tool_calling=True,
    recommended_role="upgrade",
)

QWEN25_CODER_32B = ModelSpec(
    key="qwen2.5-coder-32b-instruct",
    repo_id="Qwen/Qwen2.5-Coder-32B-Instruct",
    display_name="Qwen2.5-Coder 32B Instruct",
    parameter_count="32b",
    context_length=32768,
    license="Apache-2.0",
    license_url="https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct/blob/main/LICENSE",
    source="https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct",
    revision="381fc969f78efac66bc87ff7ddeadb7e73c218a7",
    family="qwen2.5-coder",
    supports_tool_calling=True,
    recommended_role="upgrade",
)

QWEN3_CODER_NEXT = ModelSpec(
    key="qwen3-coder-next",
    repo_id="Qwen/Qwen3-Coder-Next",
    display_name="Qwen3-Coder-Next (MoE)",
    parameter_count="80b-moe",
    context_length=262144,
    license="Apache-2.0",
    license_url="https://huggingface.co/Qwen/Qwen3-Coder-Next/blob/main/LICENSE",
    source="https://huggingface.co/Qwen/Qwen3-Coder-Next",
    revision="a7fbcb5c0e12d62a448eaa0e260346bf5dcc0feb",
    family="qwen3-coder",
    supports_tool_calling=True,
    recommended_role="upgrade",
)

CATALOGUE: tuple[ModelSpec, ...] = (
    QWEN25_CODER_0_5B,
    QWEN25_CODER_1_5B,
    QWEN25_CODER_7B,
    QWEN25_CODER_14B,
    QWEN25_CODER_32B,
    QWEN3_CODER_NEXT,
)

_BY_KEY = {spec.key: spec for spec in CATALOGUE}
_BY_REPO = {spec.repo_id: spec for spec in CATALOGUE}

#: Default base for ``kairoforge-v0.1``.
#:
#: 7B is the smallest model that is genuinely useful as a coding agent while
#: still training comfortably on a single rented 24 GiB GPU with QLoRA. The
#: 1.5B model stays in the catalogue for cheap smoke tests only.
DEFAULT_BASE: ModelSpec = QWEN25_CODER_7B


class UnknownBaseModelError(KeyError):
    """Raised when a config names a base model outside the verified catalogue."""

    def __init__(self, name: str) -> None:
        known = ", ".join(sorted(_BY_KEY))
        super().__init__(
            f"unknown base model {name!r}. Verified catalogue: {known}. "
            "Add it to kairoforge.base_models with its licence before use."
        )


def resolve_base_model(name: str) -> ModelSpec:
    """Resolve a catalogue key or Hugging Face repo id to a :class:`ModelSpec`.

    Accepting the repo id as well as the short key means a config can be
    written the way the model is actually cited upstream, while the registry
    still stores the canonical key.
    """

    if name in _BY_KEY:
        return _BY_KEY[name]
    if name in _BY_REPO:
        return _BY_REPO[name]
    raise UnknownBaseModelError(name)


def try_resolve_base_model(name: str) -> ModelSpec | None:
    """Non-raising variant for reporting paths such as ``status`` and ``doctor``."""

    try:
        return resolve_base_model(name)
    except UnknownBaseModelError:
        return None


def catalogue_table() -> str:
    """Render the catalogue as a Markdown table for docs and CLI output."""

    lines = [
        "| Key | Repo | Params | Context | Licence | QLoRA VRAM | LoRA VRAM |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for spec in CATALOGUE:
        lines.append(
            f"| `{spec.key}` | `{spec.repo_id}` | {spec.parameter_count.upper()} "
            f"| {spec.context_length} | {spec.license} "
            f"| {spec.vram_gib('qlora')} GiB | {spec.vram_gib('lora')} GiB |"
        )
    return "\n".join(lines)
