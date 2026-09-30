"""Configuration loading for KairoForge training and inference.

Legacy configuration surface, retained so the original ``configs/*.yaml`` files
and any existing caller keep working. New code should prefer the typed
configuration in :mod:`kairoforge.training.engine` (``TrainingRunConfig``) and
:mod:`kairoforge.cloud.manager` (``TrainingRequest``), which validate far more
of the surface.

The ``from __future__ import annotations`` import below is load-bearing: the
signatures use PEP 604 ``X | Y`` syntax, which is only legal at runtime from
Python 3.10. Deferring annotation evaluation keeps this module importable on
3.9, which is what the local interpreter provides.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TrainingConfig:
    """Validated training settings used by the KairoForge SFT pipeline."""

    base_model: str
    output_dir: str
    dataset_path: str
    epochs: int
    learning_rate: float
    batch_size: int
    gradient_accumulation: int
    max_sequence_length: int
    warmup_ratio: float
    weight_decay: float
    lora_r: int
    lora_alpha: int
    lora_dropout: float
    precision: str
    checkpoint_interval: int
    evaluation_interval: int
    random_seed: int


def _parse_scalar(value: str) -> Any:
    """Parse the scalar types used by KairoForge's checked-in YAML files."""

    if value == "null":
        return None
    if value in {"true", "false"}:
        return value == "true"
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value.strip('"')


def load_yaml(path: str | Path) -> dict[str, Any]:
    """Load a YAML file and return an empty mapping for empty files."""

    root: dict[str, Any] = {}
    current: dict[str, Any] | None = None
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.rstrip()
            if not line or line.lstrip().startswith("#"):
                continue
            if not line.startswith(" "):
                if not line.endswith(":"):
                    raise ValueError(f"{path}:{line_number} expected a top-level mapping")
                current = {}
                root[line[:-1]] = current
                continue
            if current is None or ":" not in line:
                raise ValueError(f"{path}:{line_number} expected an indented key/value")
            key, value = line.strip().split(":", 1)
            current[key] = _parse_scalar(value.strip())
    return root


def load_training_config(path: str | Path) -> TrainingConfig:
    """Load the `training` object from a KairoForge training YAML file."""

    data = load_yaml(path)
    training = data.get("training")
    if not isinstance(training, dict):
        raise ValueError(f"{path} must contain a training mapping")
    config = TrainingConfig(**training)
    if config.epochs < 1:
        raise ValueError("epochs must be >= 1")
    if config.learning_rate <= 0:
        raise ValueError("learning_rate must be > 0")
    if config.batch_size < 1 or config.gradient_accumulation < 1:
        raise ValueError("batch sizes must be >= 1")
    if config.max_sequence_length < 128:
        raise ValueError("max_sequence_length must be >= 128")
    if not 0 <= config.warmup_ratio <= 1:
        raise ValueError("warmup_ratio must be between 0 and 1")
    if config.weight_decay < 0:
        raise ValueError("weight_decay must be >= 0")
    if config.lora_r < 1 or config.lora_alpha < 1:
        raise ValueError("LoRA settings must be positive")
    if not 0 <= config.lora_dropout <= 1:
        raise ValueError("lora_dropout must be between 0 and 1")
    return config
