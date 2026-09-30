"""KairoForge training package.

Two layers live here, and they are deliberately separate:

* :mod:`kairoforge.training.engine` - the real engine. ``TrainingRunConfig``,
  the validators, the LoRA/TrainingArguments builders, ``train``, and the
  Phase 8 ``smoke_test``. Every ML import inside it is deferred, so importing
  this package works on a machine with no torch installed.

* :mod:`kairoforge.training.legacy` - the original single-file entrypoint
  (``run_training``/``validate_training_inputs``) that ``scripts/train.py``
  already calls. It is re-exported here so that existing callers keep working
  unchanged. It imports :mod:`kairoforge.config`, which requires Python 3.10+
  for its ``X | Y`` annotations.

The legacy names are imported **lazily** via module ``__getattr__`` for one
concrete reason: importing this package must not drag in a module that fails
to parse on an older interpreter. A caller that only wants the engine
(``from kairoforge.training.engine import ...``) therefore succeeds on
Python 3.9, while ``from kairoforge.training import run_training`` still
resolves exactly as it did before the module became a package.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "engine",
    "TrainingRunConfig",
    "SmokeResult",
    "StepReport",
    "ConfigError",
    "MissingDependencyError",
    "TrainingEngineError",
    "validate_config",
    "build_lora_config",
    "build_training_arguments",
    "train",
    "smoke_test",
    "count_parameters",
    "adapter_weight_hash",
    "run_training",
    "validate_training_inputs",
]

#: Names that must resolve through :mod:`kairoforge.training.legacy`.
_LEGACY_NAMES = ("run_training", "validate_training_inputs")


def __getattr__(name: str) -> Any:
    """Resolve legacy and engine names without eagerly importing either.

    This is the standard PEP 562 module hook. Accessing an engine name
    triggers an import of :mod:`kairoforge.training.engine`, and accessing a
    legacy name triggers :mod:`kairoforge.training.legacy` - so the cost, and
    the Python-version requirement, are paid only by callers that ask.

    ``importlib.import_module`` is used rather than ``from . import engine``
    deliberately. The latter asks the *package* for an attribute named
    ``engine``, which - because that attribute is not yet bound - re-enters
    this same hook and recurses until the interpreter's stack limit
    (``RecursionError``). Importing by absolute module path binds the submodule
    in ``sys.modules`` directly and cannot recurse.
    """

    import importlib

    if name in _LEGACY_NAMES:
        module = importlib.import_module(f"{__name__}.legacy")
        return getattr(module, name)

    if name.startswith("_"):
        # Never resolve private or dunder names through a lazy import: the
        # interpreter probes these during startup and while formatting
        # exceptions, so a recursive failure here would mask the real error.
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    try:
        module = importlib.import_module(f"{__name__}.engine")
    except ImportError as exc:  # pragma: no cover - only on a broken install
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from exc

    try:
        return getattr(module, name)
    except AttributeError:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from None


def __dir__() -> list[str]:
    """Advertise the public surface for interactive use and tab-completion."""

    return sorted(__all__)
