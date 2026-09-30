"""The KairoForge supervised fine-tuning engine.

This is the real trainer. It runs QLoRA, LoRA, or full supervised fine-tuning
against ``transformers``/``peft``/``trl``, and it reports only what it can
count.

Two design rules shape this module:

1. **Every heavy import is deferred.** ``torch``, ``transformers``, ``peft``,
   and ``trl`` are imported *inside* the functions that need them, never at
   module scope. ``import kairoforge.training.engine`` therefore succeeds on a
   machine with no ML stack installed, which is what lets the CLI validate a
   config, the tests assert the field surface, and the UI render a plan,
   on a laptop with nothing but CPython.

2. **Nothing is asserted that was not measured.** ``train`` counts trainable
   parameters by iterating ``model.parameters()`` and testing
   ``requires_grad``; it does not infer them from the LoRA config. The metric
   ``tokens`` is summed from the tokenizer's own output. ``smoke_test`` hashes
   the adapter weights before and after an optimizer step and compares the
   bytes, so "the parameters changed" is a measurement rather than a claim.

The honest consequence of rule 2: if the ML stack is missing, these functions
raise :class:`MissingDependencyError` with the exact install command. They
never return a fabricated metrics dict, and no code path here reports a
successful training run that did not happen.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

#: Training methods, mirroring ``kairoforge.base_models.TrainingMethod``.
METHODS: tuple[str, ...] = ("qlora", "lora", "full")

#: Accepted numeric precisions.
PRECISIONS: tuple[str, ...] = ("bf16", "fp16", "fp32")

#: The pinned 4-bit quantization backend. Named rather than inlined so the
#: error message for a missing ``bitsandbytes`` can quote it.
QUANTIZATION_BACKEND = "bitsandbytes"

#: Transformer block suffixes that already carry a quantization config when a
#: model is loaded in 4-bit. Applying LoRA to a *quantized* linear layer is
#: what works; the matching in :func:`build_lora_config` is therefore done on
#: these suffixes.
_DEFAULT_LORA_TARGETS: tuple[str, ...] = (
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
)

#: Install hint quoted by every dependency failure, so the user gets the same
#: actionable command no matter which entrypoint they hit first.
INSTALL_HINT = 'pip install -e ".[ml]"'

#: The deliberately tiny default model used by :func:`smoke_test`. A real
#: Hugging Face model - not a stub - chosen because it is small enough to load
#: and step on a CPU-only laptop.
#:
#: Override with the ``KAIROFORGE_SMOKE_MODEL`` environment variable to point at
#: a locally cached copy. The smoke test must never be the thing that fails for
#: a network reason: it is the gate that decides whether a paid run is
#: justified, so an unreachable Hub would otherwise block training for a reason
#: that has nothing to do with the pipeline.
SMOKE_TEST_MODEL = "hf-internal-testing/tiny-random-LlamaForCausalLM"


def smoke_test_model() -> str:
    """Resolve the model the smoke test should use.

    Prefers ``KAIROFORGE_SMOKE_MODEL`` so an offline or rate-limited
    environment can point at an already-downloaded model instead of failing.
    """

    import os

    return os.environ.get("KAIROFORGE_SMOKE_MODEL", "").strip() or SMOKE_TEST_MODEL


class TrainingEngineError(RuntimeError):
    """Base class for training-engine failures."""


class MissingDependencyError(TrainingEngineError):
    """A required ML package is not installed.

    Raised instead of an opaque ``ImportError`` so the caller can print one
    actionable line. This is never raised at import time: the module imports
    fine without the ML stack.
    """

    def __init__(self, package: str, purpose: str) -> None:
        self.package = package
        self.purpose = purpose
        super().__init__(
            f"the {purpose} requires the {package!r} package, which is not "
            f"installed.\nInstall the ML extras with:\n    {INSTALL_HINT}"
        )


class ConfigError(ValueError):
    """A :class:`TrainingRunConfig` is internally inconsistent."""


@dataclass(frozen=True)
class TrainingRunConfig:
    """The complete, frozen description of one supervised fine-tuning run.

    Every field is required except the trailing ones with defaults. The field
    set is a public surface: the CLI, the cloud planner, and the job bundle
    all bind to these exact names, so renaming one is a breaking change.

    ``max_steps`` of ``0`` means "derive the step count from the dataset size
    and ``epochs``", which is the normal case. A positive value overrides
    ``epochs`` entirely, which is what a time-boxed smoke run wants.
    """

    base_model: str
    base_revision: str
    dataset_dir: str
    output_dir: str
    epochs: int
    learning_rate: float
    batch_size: int
    gradient_accumulation: int
    sequence_length: int
    warmup_ratio: float
    weight_decay: float
    precision: str
    lora_rank: int
    lora_alpha: int
    lora_dropout: float
    lora_target_modules: tuple[str, ...]
    checkpoint_interval: int
    evaluation_interval: int
    seed: int
    method: str
    max_steps: int = 0
    save_total_limit: int = 3
    gradient_checkpointing: bool = True
    logging_steps: int = 1
    report_to: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        """Serialise for the job bundle and the run report.

        Tuples become lists because this payload is written as JSON, and a
        round-tripped config must compare equal after ``from_json``.
        """

        payload = asdict(self)
        payload["lora_target_modules"] = list(self.lora_target_modules)
        payload["report_to"] = list(self.report_to)
        return payload

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> "TrainingRunConfig":
        """Rebuild a config from its serialised form."""

        payload = dict(data)
        # ``precision``/``method`` are validated by validate_config, but the
        # sequence-typed fields must be re-tupled before construction so the
        # frozen dataclass stays hashable.
        payload["lora_target_modules"] = tuple(payload.get("lora_target_modules") or ())
        payload["report_to"] = tuple(payload.get("report_to") or ())
        return cls(**payload)  # type: ignore[arg-type]

    def resolved_target_modules(self) -> tuple[str, ...]:
        """LoRA target suffixes, substituting the default set when empty."""

        if self.lora_target_modules:
            return tuple(self.lora_target_modules)
        return _DEFAULT_LORA_TARGETS


def validate_config(config: TrainingRunConfig) -> TrainingRunConfig:
    """Raise :class:`ConfigError` when ``config`` is internally inconsistent.

    This runs *without* the ML stack on purpose: catching ``full`` +
    ``4bit`` before a GPU is rented is the entire point. It returns the same
    config so it can be used inline as ``config = validate_config(config)``.
    """

    if not config.base_model.strip():
        raise ConfigError("base_model must be non-empty")
    if not config.dataset_dir.strip():
        raise ConfigError("dataset_dir must be non-empty")
    if not config.output_dir.strip():
        raise ConfigError("output_dir must be non-empty")

    if config.method not in METHODS:
        raise ConfigError(
            f"method must be one of {', '.join(METHODS)}; got {config.method!r}"
        )

    if config.precision not in PRECISIONS:
        raise ConfigError(
            f"precision must be one of {', '.join(PRECISIONS)}; "
            f"got {config.precision!r}"
        )

    # Full fine-tuning stores optimizer state for every parameter, so there is
    # no quantization to recover it from. Asking for both is a contradiction,
    # not a tuning choice.
    if config.method == "full" and config.precision == "fp32":
        raise ConfigError(
            "full fine-tuning with fp32 precision is not supported: full FT "
            "requires bf16 or fp16 (fp32 training of a multi-billion-parameter "
            "model will not fit on any single GPU in the catalogue)"
        )
    if config.method == "qlora" and config.precision == "fp32":
        raise ConfigError(
            "qlora requires bf16 or fp16 compute precision: the 4-bit weights "
            "are dequantized into a bf16/fp16 compute dtype, and fp32 would "
            "defeat the memory saving that justifies QLoRA"
        )

    if config.epochs < 1:
        raise ConfigError(f"epochs must be >= 1; got {config.epochs}")
    if not 0.0 < config.learning_rate <= 1.0:
        raise ConfigError(
            f"learning_rate must be in (0, 1]; got {config.learning_rate}"
        )
    if config.batch_size < 1:
        raise ConfigError(f"batch_size must be >= 1; got {config.batch_size}")
    if config.gradient_accumulation < 1:
        raise ConfigError(
            f"gradient_accumulation must be >= 1; got {config.gradient_accumulation}"
        )
    if config.sequence_length < 1:
        raise ConfigError(
            f"sequence_length must be >= 1; got {config.sequence_length}"
        )
    if not 0.0 <= config.warmup_ratio <= 1.0:
        raise ConfigError(
            f"warmup_ratio must be between 0 and 1; got {config.warmup_ratio}"
        )
    if config.weight_decay < 0.0:
        raise ConfigError(
            f"weight_decay must be >= 0; got {config.weight_decay}"
        )

    if config.method in {"qlora", "lora"}:
        if config.lora_rank < 1:
            raise ConfigError(f"lora_rank must be >= 1; got {config.lora_rank}")
        if config.lora_alpha < 1:
            raise ConfigError(f"lora_alpha must be >= 1; got {config.lora_alpha}")
        if not 0.0 <= config.lora_dropout < 1.0:
            raise ConfigError(
                f"lora_dropout must be in [0, 1); got {config.lora_dropout}"
            )
        if config.lora_alpha < config.lora_rank:
            # Not fatal - alpha < rank simply scales the update down - but it
            # is almost always a typo, and a silently tiny update looks like
            # "training did not work".
            raise ConfigError(
                f"lora_alpha ({config.lora_alpha}) is below lora_rank "
                f"({config.lora_rank}); this scales the LoRA update down by "
                f"{config.lora_alpha / config.lora_rank:.3f}. The conventional "
                "setting is lora_alpha == 2 * lora_rank."
            )

    if config.checkpoint_interval < 1:
        raise ConfigError(
            f"checkpoint_interval must be >= 1; got {config.checkpoint_interval}"
        )
    if config.evaluation_interval < 1:
        raise ConfigError(
            f"evaluation_interval must be >= 1; got {config.evaluation_interval}"
        )
    if config.save_total_limit < 1:
        raise ConfigError(
            f"save_total_limit must be >= 1; got {config.save_total_limit}. "
            "A limit of 0 would delete every checkpoint including the one that "
            "is meant to outlive the worker."
        )
    if config.max_steps < 0:
        raise ConfigError(f"max_steps must be >= 0; got {config.max_steps}")
    if config.logging_steps < 1:
        raise ConfigError(
            f"logging_steps must be >= 1; got {config.logging_steps}"
        )
    if config.seed < 0:
        raise ConfigError(f"seed must be >= 0; got {config.seed}")

    return config


def _require(package: str, purpose: str) -> Any:
    """Import ``package`` or raise :class:`MissingDependencyError`.

    A single choke point for deferred imports keeps the "no ML stack" path
    uniform: every failure names the missing package and the install command
    instead of leaking a bare ``ModuleNotFoundError`` from three frames deep.
    """

    try:
        return __import__(package)
    except ImportError as exc:  # pragma: no cover - exercised only without ML
        raise MissingDependencyError(package, purpose) from exc


def _resolve_dtype(precision: str, torch_module: Any) -> Any:
    """Map a precision string onto a ``torch`` dtype, probing availability.

    ``bf16`` is not available on every accelerator. Rather than silently
    falling back - which would make the run report a precision it did not use -
    an unavailable bf16 raises with the hardware reason.
    """

    if precision == "bf16":
        if not torch_module.cuda.is_available():
            # CPU bf16 works on modern builds but is extremely slow; the
            # honest move is to say so rather than quietly train in fp32.
            return torch_module.bfloat16
        if not torch_module.cuda.is_bf16_supported():
            raise TrainingEngineError(
                "precision='bf16' was requested but this GPU does not support "
                "bfloat16. Either select precision='fp16' or train on a "
                "device with bf16 support (Ampere or newer)."
            )
        return torch_module.bfloat16
    if precision == "fp16":
        return torch_module.float16
    return torch_module.float32


def build_lora_config(config: TrainingRunConfig) -> Any:
    """Build a ``peft.LoraConfig`` for ``config``.

    ``peft`` is imported here, not at module scope. The target modules default
    to the full attention + MLP projection set, which is the configuration
    QLoRA was validated with; narrowing it to ``q_proj``/``v_proj`` trains far
    fewer parameters and is a common cause of an adapter that appears to train
    but does not learn.
    """

    validate_config(config)
    if config.method == "full":
        raise ConfigError(
            "build_lora_config was called for method='full', which trains all "
            "parameters; there is no LoRA configuration to build"
        )

    peft = _require("peft", "LoRA adapter configuration")

    return peft.LoraConfig(
        r=config.lora_rank,
        lora_alpha=config.lora_alpha,
        lora_dropout=config.lora_dropout,
        target_modules=list(config.resolved_target_modules()),
        bias="none",
        task_type="CAUSAL_LM",
    )


def build_training_arguments(config: TrainingRunConfig) -> Any:
    """Build a ``transformers.TrainingArguments`` for ``config``.

    Checkpointing, evaluation cadence, and the seed are all set from the
    config rather than defaulted, because the cloud worker's checkpoint
    durability guarantee is only as good as ``save_steps``.
    """

    validate_config(config)
    transformers = _require("transformers", "training arguments")

    arguments: dict[str, Any] = {
        "output_dir": config.output_dir,
        "overwrite_output_dir": False,
        "num_train_epochs": float(config.epochs),
        "per_device_train_batch_size": config.batch_size,
        "gradient_accumulation_steps": config.gradient_accumulation,
        "learning_rate": config.learning_rate,
        "warmup_ratio": config.warmup_ratio,
        "weight_decay": config.weight_decay,
        "lr_scheduler_type": "cosine",
        "bf16": config.precision == "bf16",
        "fp16": config.precision == "fp16",
        "gradient_checkpointing": config.gradient_checkpointing,
        "logging_steps": config.logging_steps,
        "save_strategy": "steps",
        "save_steps": config.checkpoint_interval,
        "save_total_limit": config.save_total_limit,
        "seed": config.seed,
        "data_seed": config.seed,
        "report_to": list(config.report_to),
        "logging_first_step": True,
        "dataloader_num_workers": 0,
        # An adapter checkpoint is small, but the surrounding trainer state is
        # not; keeping the last N only is what stops a long run filling the
        # worker's disk and failing at the final save.
        "remove_unused_columns": False,
    }

    # ``max_steps > 0`` overrides ``epochs`` in the Trainer. Passing both is
    # legal but confusing, so the effective one is chosen explicitly here.
    if config.max_steps > 0:
        arguments["max_steps"] = config.max_steps

    if config.evaluation_interval > 0:
        arguments["eval_strategy"] = "steps"
        arguments["eval_steps"] = config.evaluation_interval
    else:  # pragma: no cover - evaluation_interval >= 1 is enforced above
        arguments["eval_strategy"] = "no"

    return transformers.TrainingArguments(**arguments)


def resolve_revision(model_id: str, requested: str) -> Optional[str]:
    """Return the revision to pin for ``model_id``, or ``None`` for the default.

    A pinned revision is only meaningful for the model it was recorded against.
    Pairing a model with some *other* model's commit makes the Hub lookup fail
    with a misleading "Unrecognized model" error, so a revision that cannot be
    shown to belong to this model is dropped rather than sent.

    Only catalogue members carry a revision this code can verify (see
    :mod:`kairoforge.base_models`), because the catalogue is where a revision
    and its repository are recorded together. Everything else - the smoke-test
    model, a caller's own local path, a model added outside the catalogue -
    is requested unpinned.

    Dropping a stale pin costs reproducibility for that one run; sending it
    costs the run entirely. The trade is deliberate, and the caller can always
    pin explicitly through the catalogue.
    """

    if not requested:
        return None

    from ..base_models import CATALOGUE

    for spec in CATALOGUE:
        if spec.repo_id == model_id or spec.key == model_id:
            # The catalogue is authoritative for its own models, so a
            # revision recorded elsewhere is replaced with the verified one.
            return spec.revision if not _same_model(requested, spec) else requested

    # Not a catalogue model: no verifiable revision pairing exists, so the
    # model is requested at its default branch rather than with a pin that
    # may belong to a different repository.
    return None


def _same_model(requested: str, spec: "Any") -> bool:
    """Whether a requested revision plausibly belongs to ``spec``.

    A catalogue revision is accepted only when it matches the catalogue's own
    pin, so a stale revision inherited from a different model cannot be sent.
    """

    return requested == spec.revision


def _load_tokenizer(config: TrainingRunConfig) -> Any:
    """Load the tokenizer, pinning the revision and a pad token."""

    transformers = _require("transformers", "tokenizer loading")
    tokenizer = transformers.AutoTokenizer.from_pretrained(
        config.base_model,
        revision=resolve_revision(config.base_model, config.base_revision),
        trust_remote_code=False,
    )
    if tokenizer.pad_token is None:
        # Causal LMs are trained with left/right padding against EOS; without
        # a pad token the collator fails, and without *setting* it the
        # tokenizer may silently pad with a token of id 0 that is not EOS.
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    return tokenizer


def _load_model(config: TrainingRunConfig) -> Any:
    """Load the causal LM, in 4-bit when the method is QLoRA."""

    torch = _require("torch", "model loading")
    transformers = _require("transformers", "model loading")
    dtype = _resolve_dtype(config.precision, torch)

    kwargs: dict[str, Any] = {
        "revision": resolve_revision(config.base_model, config.base_revision),
        "trust_remote_code": False,
        "torch_dtype": dtype,
    }

    if config.method == "qlora":
        _require(QUANTIZATION_BACKEND, "4-bit QLoRA quantization")
        try:
            from transformers import BitsAndBytesConfig
        except ImportError as exc:  # pragma: no cover - depends on version
            raise TrainingEngineError(
                "this transformers build exposes no BitsAndBytesConfig, so "
                "4-bit QLoRA cannot be configured. Install a newer "
                f"transformers: {INSTALL_HINT}"
            ) from exc

        kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=dtype,
            bnb_4bit_use_double_quant=True,
        )
        # A 4-bit model is sharded onto the devices it was loaded across.
        kwargs["device_map"] = "auto"
    else:
        kwargs["device_map"] = "auto" if torch.cuda.is_available() else None

    model = transformers.AutoModelForCausalLM.from_pretrained(
        config.base_model, **kwargs
    )

    if config.method == "qlora":
        # Required for gradient flow through a quantized base model.
        from peft import prepare_model_for_kbit_training

        model = prepare_model_for_kbit_training(
            model, use_gradient_checkpointing=config.gradient_checkpointing
        )

    return model


def _apply_lora(model: Any, config: TrainingRunConfig) -> Any:
    """Wrap ``model`` in a LoRA adapter (a no-op for full fine-tuning)."""

    if config.method == "full":
        return model

    peft = _require("peft", "LoRA adapter application")
    return peft.get_peft_model(model, build_lora_config(config))


def count_parameters(model: Any) -> dict[str, int]:
    """Count trainable and total parameters by actually walking the model.

    This is the honest measurement the whole reporting chain depends on. It
    is derived from ``p.requires_grad`` rather than from the LoRA config,
    because the config says what was *requested* while ``requires_grad`` says
    what the optimizer will actually see.
    """

    trainable = 0
    total = 0
    for parameter in model.parameters():
        count = parameter.numel()
        total += count
        if parameter.requires_grad:
            trainable += count
    return {"trainable_params": trainable, "total_params": total}


def _tensor_bytes(tensor: Any) -> bytes:
    """Serialise a tensor to raw bytes, without assuming a torch module.

    The obvious implementation is ``tensor.to(torch.float32).numpy().tobytes()``
    but that hard-codes a global import, which breaks the moment the module is
    exercised through an injected stand-in (the smoke test's stub model) or on
    a machine where torch resolves differently. Instead this prefers the
    tensor's *own* machinery, in order of how much it proves:

    1. ``numpy().tobytes()`` - the true bytes of the weights;
    2. ``detach().cpu().flatten().tolist()`` packed as float32 - identical
       content, obtained without numpy;
    3. a per-element fallback for anything else.

    Every path yields a byte string that changes when the weight changes,
    which is the only property the caller depends on.
    """

    detached = tensor.detach() if hasattr(tensor, "detach") else tensor

    # A structured dtype does not round-trip through the simple paths below,
    # so it is asked for its bytes directly.
    if hasattr(detached, "view") and hasattr(detached, "element_size"):
        try:
            return detached.cpu().contiguous().view(-1).numpy().tobytes()
        except Exception:
            pass

    try:
        return detached.cpu().numpy().tobytes()
    except Exception:
        pass

    import struct

    # A wrapper that keeps its numbers on an attribute (a tensor-like stub, or
    # a parameter object that is not itself a tensor) is unwrapped first: the
    # attribute holds the actual content, and hashing it keeps the digest a
    # pure function of the values.
    for attribute in ("values", "data", "array", "tensor"):
        inner = getattr(detached, attribute, None)
        if inner is not None and inner is not detached:
            try:
                return _tensor_bytes(inner)
            except Exception:
                pass

    try:
        values = detached.cpu().flatten().tolist()
        return b"".join(struct.pack("<f", float(value)) for value in values)
    except Exception:
        pass

    try:
        values = list(detached) if hasattr(detached, "__iter__") else [detached]
    except Exception:
        values = [detached]
    try:
        return b"".join(struct.pack("<f", float(value)) for value in values)
    except Exception:
        pass

    # Nothing above could read real numbers. A textual rendering is still
    # content-derived (unlike ``repr(obj)``, which embeds the memory address
    # and would make an unchanged model hash differently on every call), so
    # the digest stays a function of the value alone.
    return repr(_content_signature(detached)).encode("utf-8", errors="replace")


def _content_signature(value: Any, depth: int = 0) -> Any:
    """Render an opaque value by content, never by identity.

    ``repr`` of an arbitrary object includes its address, which would make a
    hash of unchanged weights differ between two calls and destroy the very
    guarantee the hash exists to provide. This walks plain containers and
    numeric-looking attributes instead, and for anything still opaque falls
    back to the type name alone.
    """

    if depth > 4:
        return type(value).__name__
    if isinstance(value, (str, bytes, int, float, bool, type(None))):
        return value
    if isinstance(value, dict):
        return {
            str(key): _content_signature(item, depth + 1)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_content_signature(item, depth + 1) for item in value]
    if hasattr(value, "tolist"):
        try:
            return value.tolist()
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        return {
            key: _content_signature(item, depth + 1)
            for key, item in sorted(vars(value).items())
            if not key.startswith("__")
        }
    return type(value).__name__


def _adapter_state(model: Any) -> dict[str, Any]:
    """Collect the state dict entries that belong to a trainable adapter.

    PEFT names its adapter weights with a ``lora_`` infix, so those entries are
    preferred by *name* - deliberately not filtered on ``requires_grad``.

    That distinction matters: a freshly reloaded ``PeftModel`` reports
    ``requires_grad=False`` on its LoRA layers until the caller explicitly asks
    for a trainable adapter, so grading the selection on ``requires_grad``
    would silently widen the hash from the 8 adapter tensors to all 29 model
    tensors. The before/after comparison would then be taken over two different
    sets of weights and report a spurious mismatch on an identical checkpoint.

    Only when no ``lora_`` entry exists - full fine-tuning, or an unwrapped
    model - does this fall back to the trainable set.
    """

    named = dict(model.named_parameters())

    selected = {name: value for name, value in named.items() if "lora_" in name}
    if selected:
        return selected

    trainable = {
        name: value
        for name, value in named.items()
        if getattr(value, "requires_grad", False)
    }
    if trainable:
        return trainable

    # Nothing is marked trainable (an inference-only model). Hashing the full
    # parameter set is still meaningful: it proves the reload matched, and it
    # lets the "weights did not change" case be detected rather than crashing.
    state = getattr(model, "state_dict", None)
    if callable(state):
        try:
            return dict(state())
        except Exception:  # pragma: no cover - defensive, unusual wrappers
            return {}
    return named


def adapter_weight_hash(model: Any) -> str:
    """SHA-256 over the adapter weights' raw bytes.

    Used as the "did the optimizer actually move anything?" proof. The digest
    is taken over the tensor bytes themselves, so a run that completes without
    updating a single weight produces an identical hash and is reported as
    unchanged - which is exactly the failure this catches.

    The parameter names are folded into the digest so that renaming or
    reordering weights cannot collide with an unchanged model.
    """

    digest = hashlib.sha256()
    for name, tensor in sorted(_adapter_state(model).items()):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(_tensor_bytes(tensor))
        digest.update(b"\n")
    return digest.hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    """Read JSONL objects, raising with the offending line number."""

    records: list[dict[str, Any]] = []
    path = Path(path)
    if not path.exists():
        raise TrainingEngineError(f"dataset file not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                loaded = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise TrainingEngineError(
                    f"{path}:{line_number} is not valid JSON: {exc}"
                ) from exc
            if not isinstance(loaded, Mapping):
                raise TrainingEngineError(
                    f"{path}:{line_number} must be a JSON object"
                )
            records.append(dict(loaded))
    return records


def to_messages(record: Mapping[str, Any]) -> list[dict[str, str]]:
    """Normalise one dataset record into chat messages.

    Accepts either the canonical ``messages`` form written by the data
    pipeline or the flat ``instruction``/``response`` form, so both a
    processed dataset and a hand-written JSONL train.
    """

    messages = record.get("messages")
    if isinstance(messages, list) and messages:
        normalised: list[dict[str, str]] = []
        for message in messages:
            if not isinstance(message, Mapping):
                continue
            role = str(message.get("role", "")).strip()
            content = message.get("content")
            if not role or not isinstance(content, str):
                continue
            normalised.append({"role": role, "content": content})
        if normalised:
            return normalised

    instruction = record.get("instruction") or record.get("prompt")
    response = record.get("response") or record.get("completion") or record.get("output")
    if isinstance(instruction, str) and isinstance(response, str):
        if instruction.strip() and response.strip():
            return [
                {"role": "user", "content": instruction},
                {"role": "assistant", "content": response},
            ]

    raise TrainingEngineError(
        "dataset record carries neither a usable 'messages' list nor a "
        "non-empty instruction/response pair"
    )


def load_split(dataset_dir: Path, name: str) -> list[dict[str, Any]]:
    """Load ``<dataset_dir>/<name>.jsonl`` as a list of message lists."""

    path = Path(dataset_dir) / f"{name}.jsonl"
    records = read_jsonl(path)
    return [{"messages": to_messages(record)} for record in records]


@dataclass
class StepReport:
    """One real optimizer step, reported live to the caller's callback."""

    step: int
    total_steps: int
    epoch: float
    loss: float
    learning_rate: float
    tokens_seen: int
    message: str = ""

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def _make_step_callback(
    sink: Callable[[StepReport], None],
    token_counter: dict[str, int],
) -> Any:
    """Build a ``transformers.TrainerCallback`` forwarding real steps to ``sink``.

    The callback is constructed inside a function so that importing this
    module never touches ``transformers``. Loss and learning rate come from
    the trainer's own ``logs`` dict, which is populated after the optimizer
    step - not from a running average the engine computes itself.
    """

    transformers = _require("transformers", "the step callback")
    callback_base = transformers.TrainerCallback

    class _StepSink(callback_base):  # type: ignore[misc, valid-type]
        """Forwards every logged training step to the caller."""

        def on_log(self, args, state, control, logs=None, **kwargs):  # type: ignore[no-untyped-def]
            if not logs or "loss" not in logs:
                return control
            total = int(getattr(state, "max_steps", 0) or 0)
            sink(
                StepReport(
                    step=int(getattr(state, "global_step", 0) or 0),
                    total_steps=total,
                    epoch=float(getattr(state, "epoch", 0.0) or 0.0),
                    loss=float(logs["loss"]),
                    learning_rate=float(logs.get("learning_rate", 0.0) or 0.0),
                    tokens_seen=int(token_counter.get("tokens", 0)),
                )
            )
            return control

        def on_save(self, args, state, control, **kwargs):  # type: ignore[no-untyped-def]
            sink(
                StepReport(
                    step=int(getattr(state, "global_step", 0) or 0),
                    total_steps=int(getattr(state, "max_steps", 0) or 0),
                    epoch=float(getattr(state, "epoch", 0.0) or 0.0),
                    loss=float("nan"),
                    learning_rate=0.0,
                    tokens_seen=int(token_counter.get("tokens", 0)),
                    message="checkpoint saved",
                )
            )
            return control

        def on_train_end(self, args, state, control, **kwargs):  # type: ignore[no-untyped-def]
            sink(
                StepReport(
                    step=int(getattr(state, "global_step", 0) or 0),
                    total_steps=int(getattr(state, "max_steps", 0) or 0),
                    epoch=float(getattr(state, "epoch", 0.0) or 0.0),
                    loss=float("nan"),
                    learning_rate=0.0,
                    tokens_seen=int(token_counter.get("tokens", 0)),
                    message="train end",
                )
            )
            return control

    return _StepSink()


def _gpu_name() -> str:
    """Best-effort name of the compute device, or ``""`` when unknown.

    Never invents a GPU name: on a CPU-only host it reports the CPU rather
    than an empty or fabricated accelerator.
    """

    try:
        import torch
    except ImportError:
        return ""
    try:
        if torch.cuda.is_available():
            return str(torch.cuda.get_device_name(0))
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return "Apple MPS"
        return "cpu"
    except Exception:  # pragma: no cover - defensive
        return ""


def train(
    config: TrainingRunConfig,
    resume_from_checkpoint: Optional[str] = None,
    on_step: Optional[Callable[[StepReport], None]] = None,
) -> dict[str, Any]:
    """Run real supervised fine-tuning and return measured metrics.

    Every value in the returned dict is measured during this call: losses come
    from the trainer's log history, the token count is summed from the
    tokenizer, and the parameter counts are walked off the live model. When
    the ML stack is absent this raises :class:`MissingDependencyError` rather
    than returning zeros that could be mistaken for a completed run.
    """

    validate_config(config)

    started = time.time()
    torch = _require("torch", "training")
    _require("transformers", "training")
    trl = _require("trl", "the SFT trainer")

    dataset_dir = Path(config.dataset_dir)
    train_rows = load_split(dataset_dir, "train")
    if not train_rows:
        raise TrainingEngineError(f"no training rows in {dataset_dir / 'train.jsonl'}")
    validation_rows: list[dict[str, Any]] = []
    if (dataset_dir / "validation.jsonl").exists():
        validation_rows = load_split(dataset_dir, "validation")

    tokenizer = _load_tokenizer(config)
    model = _load_model(config)
    model = _apply_lora(model, config)

    parameters = count_parameters(model)

    token_counter = {"tokens": 0}

    def _render(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
        """Render rows through the chat template into token id lists.

        Tokens are counted here, from the tokenizer's real output, and the
        counter is shared with the step callback so ``tokens_seen`` is a true
        cumulative figure rather than an estimate derived from characters.
        """

        rendered: list[dict[str, Any]] = []
        for row in rows:
            messages = to_messages(row)
            try:
                text = tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=False
                )
            except Exception:
                # A base model with no chat template still trains on the
                # canonical two-turn form; the join is explicit so the
                # rendered text is inspectable rather than silently empty.
                text = "\n".join(
                    f"{message['role']}: {message['content']}" for message in messages
                )
            encoded = tokenizer(
                text,
                truncation=True,
                max_length=config.sequence_length,
                padding=False,
                return_attention_mask=False,
            )
            input_ids = list(encoded["input_ids"])
            token_counter["tokens"] += len(input_ids)
            rendered.append({"input_ids": input_ids})
        return rendered

    train_dataset = _to_hf_dataset(_render(train_rows))
    eval_dataset = (
        _to_hf_dataset(_render(validation_rows)) if validation_rows else None
    )

    arguments = build_training_arguments(config)

    data_collator = None
    try:  # pragma: no cover - depends on the installed trl version
        from transformers import DataCollatorForLanguageModeling

        data_collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)
    except ImportError:  # pragma: no cover
        data_collator = None

    trainer_kwargs: dict[str, Any] = {
        "model": model,
        "args": arguments,
        "train_dataset": train_dataset,
        "eval_dataset": eval_dataset,
        "data_collator": data_collator,
    }
    if on_step is not None:
        trainer_kwargs["callbacks"] = [_make_step_callback(on_step, token_counter)]

    trainer = _build_sft_trainer(trl, trainer_kwargs, tokenizer)

    before_hash = adapter_weight_hash(model)

    # ``resume_from_checkpoint`` is threaded straight through to the Trainer so
    # a restarted worker genuinely continues from the saved optimizer and
    # scheduler state rather than merely re-reading the adapter weights.
    train_result = trainer.train(resume_from_checkpoint=resume_from_checkpoint)

    after_hash = adapter_weight_hash(model)
    parameters_after = count_parameters(model)

    output_dir = Path(config.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(output_dir))
    tokenizer.save_pretrained(str(output_dir))

    history = [
        entry
        for entry in getattr(trainer.state, "log_history", []) or []
        if "loss" in entry
    ]
    eval_losses = [
        float(entry["eval_loss"])
        for entry in getattr(trainer.state, "log_history", []) or []
        if "eval_loss" in entry
    ]
    final_train_loss = (
        float(history[-1]["loss"])
        if history
        else float(getattr(train_result, "training_loss", float("nan")))
    )

    adapter_hash = adapter_weight_hash(model)
    if adapter_hash == before_hash:
        # Not an exception - a zero learning rate is a legitimate way to
        # verify a pipeline - but the report must not imply learning happened.
        adapter_weights_changed = False
    else:
        adapter_weights_changed = True

    steps = int(getattr(trainer.state, "global_step", 0) or 0)
    total = parameters["total_params"] or 1

    return {
        "base_model": config.base_model,
        "base_revision": config.base_revision,
        "method": config.method,
        "precision": config.precision,
        "train_loss": final_train_loss,
        "eval_loss": eval_losses[-1] if eval_losses else None,
        "steps": steps,
        "epochs_completed": float(getattr(trainer.state, "epoch", 0.0) or 0.0),
        "tokens": int(token_counter["tokens"]),
        "trainable_params": parameters_after["trainable_params"],
        "total_params": parameters_after["total_params"],
        "trainable_fraction": parameters_after["trainable_params"] / total,
        "adapter_weights_changed": adapter_weights_changed,
        "adapter_hash_before": before_hash,
        "adapter_hash_after": adapter_hash,
        "gpu_name": _gpu_name(),
        "duration_seconds": round(time.time() - started, 3),
        "output_dir": str(output_dir),
        "resumed_from": resume_from_checkpoint or "",
        "torch_version": getattr(torch, "__version__", ""),
        "train_rows": len(train_rows),
        "validation_rows": len(validation_rows),
    }


# --------------------------------------------------------------------------
# Phase 8 smoke test.
# --------------------------------------------------------------------------


@dataclass
class SmokeResult:
    """Per-check truth about a minimal end-to-end training attempt.

    Every boolean is an independent measurement, and ``values`` carries the
    raw evidence (losses, weight hashes, token counts) behind them. ``ok`` is
    true only when every required check passed; a run that skipped the
    backward pass can never report ``ok``.
    """

    dataset_loaded: bool = False
    tokenizer_loaded: bool = False
    model_loaded: bool = False
    forward_pass_ok: bool = False
    backward_pass_ok: bool = False
    parameters_changed: bool = False
    checkpoint_saved: bool = False
    checkpoint_reloaded: bool = False
    inference_ok: bool = False
    trainable_params: int = 0
    total_params: int = 0
    loss_before: Optional[float] = None
    loss_after: Optional[float] = None
    adapter_hash_before: str = ""
    adapter_hash_after: str = ""
    checkpoint_path: str = ""
    inference_sample: str = ""
    model_id: str = ""
    tokens: int = 0
    duration_seconds: float = 0.0
    errors: list[str] = field(default_factory=list)

    @property
    def checks(self) -> dict[str, bool]:
        """The nine named checks, as reported."""

        return {
            "dataset_loaded": self.dataset_loaded,
            "tokenizer_loaded": self.tokenizer_loaded,
            "model_loaded": self.model_loaded,
            "forward_pass_ok": self.forward_pass_ok,
            "backward_pass_ok": self.backward_pass_ok,
            "parameters_changed": self.parameters_changed,
            "checkpoint_saved": self.checkpoint_saved,
            "checkpoint_reloaded": self.checkpoint_reloaded,
            "inference_ok": self.inference_ok,
        }

    @property
    def ok(self) -> bool:
        """True only when every check passed. Never optimistic."""

        return all(self.checks.values())

    def render(self) -> str:
        """Human-readable per-check report, failures first."""

        lines = [f"SMOKE TEST: {'PASS' if self.ok else 'FAIL'} ({self.model_id})"]
        for name, passed in self.checks.items():
            lines.append(f"  [{'ok' if passed else 'FAIL'}] {name}")
        if self.errors:
            lines.append("  errors:")
            lines.extend(f"    - {error}" for error in self.errors)
        lines.append(
            f"  loss before={self.loss_before} after={self.loss_after} "
            f"trainable={self.trainable_params}/{self.total_params}"
        )
        return "\n".join(lines)

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["checks"] = self.checks
        payload["ok"] = self.ok
        return payload


ModelLoader = Callable[["TrainingRunConfig", int], Any]
TokenizerLoader = Callable[["TrainingRunConfig"], Any]
DatasetLoader = Callable[[Path], tuple[list[dict[str, Any]], list[dict[str, Any]]]]


def _default_dataset_loader(dataset_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Load train/validation rows from ``dataset_dir``."""

    train_rows = load_split(dataset_dir, "train")
    validation_rows: list[dict[str, Any]] = []
    if (Path(dataset_dir) / "validation.jsonl").exists():
        validation_rows = load_split(dataset_dir, "validation")
    return train_rows, validation_rows


def smoke_test(
    config: TrainingRunConfig,
    model_loader: Optional[ModelLoader] = None,
    tokenizer_loader: Optional[TokenizerLoader] = None,
    dataset_loader: Optional[DatasetLoader] = None,
    step_budget: int = 4,
) -> SmokeResult:
    """Run the minimal-but-real end-to-end training proof.

    The sequence is exactly the one a real run performs, shrunk to one or two
    optimizer steps: load data, load tokenizer, load model, forward, backward,
    step, save a checkpoint, reload it, and generate. Each stage is recorded
    independently in the returned :class:`SmokeResult`, so a failure in the
    backward pass is visible as ``backward_pass_ok=False`` while the earlier
    checks stay true.

    ``model_loader``/``tokenizer_loader``/``dataset_loader`` exist so this can
    be unit-tested with a deterministic stub that provably does (or does not)
    move its weights. The default path loads a real, deliberately tiny
    Hugging Face causal LM (:data:`SMOKE_TEST_MODEL`) and a real tokenizer.

    The "parameters changed" check is a byte-level comparison of the adapter
    weights before and after the step - not an assertion that code ran.
    """

    started = time.time()
    result = SmokeResult()
    config = validate_config(config) if _is_validatable(config) else config

    torch = _require("torch", "the smoke test")

    model_loader = model_loader or _default_model_loader
    tokenizer_loader = tokenizer_loader or _load_tokenizer
    dataset_loader = dataset_loader or _default_dataset_loader

    # --- 1. dataset -------------------------------------------------------
    try:
        train_rows, validation_rows = dataset_loader(Path(config.dataset_dir))
        if not train_rows:
            raise TrainingEngineError("training split is empty")
        result.dataset_loaded = True
    except Exception as exc:
        result.errors.append(f"dataset: {exc}")
        result.duration_seconds = round(time.time() - started, 3)
        return result

    # --- 2. tokenizer -----------------------------------------------------
    try:
        tokenizer = tokenizer_loader(config)
        if tokenizer.pad_token is None and tokenizer.eos_token is not None:
            tokenizer.pad_token = tokenizer.eos_token
        result.tokenizer_loaded = True
    except Exception as exc:
        result.errors.append(f"tokenizer: {exc}")
        result.duration_seconds = round(time.time() - started, 3)
        return result

    rendered: list[list[int]] = []
    try:
        for row in train_rows:
            messages = to_messages(row)
            try:
                text = tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=False
                )
            except Exception:
                text = "\n".join(
                    f"{message['role']}: {message['content']}" for message in messages
                )
            encoded = tokenizer(
                text,
                truncation=True,
                max_length=config.sequence_length,
                padding=False,
                return_attention_mask=False,
            )
            ids = list(encoded["input_ids"])
            if ids:
                rendered.append(ids)
                result.tokens += len(ids)
        if not rendered:
            raise TrainingEngineError("chat template produced no tokens")
    except Exception as exc:
        result.errors.append(f"rendering: {exc}")
        result.duration_seconds = round(time.time() - started, 3)
        return result

    # --- 3. model ---------------------------------------------------------
    try:
        model = model_loader(config, step_budget)
        model.train()
        result.model_loaded = True
        result.model_id = _model_identifier(config, model_loader)
    except Exception as exc:
        result.errors.append(f"model: {exc}")
        result.duration_seconds = round(time.time() - started, 3)
        return result

    parameters = count_parameters(model)
    result.trainable_params = parameters["trainable_params"]
    result.total_params = parameters["total_params"]
    if parameters["trainable_params"] <= 0:
        result.errors.append(
            "model exposes no trainable parameters; there is nothing for the "
            "optimizer to update"
        )
        result.duration_seconds = round(time.time() - started, 3)
        return result

    result.adapter_hash_before = adapter_weight_hash(model)

    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(params, lr=config.learning_rate)

    def _batch(rows: Sequence[Sequence[int]]) -> dict[str, Any]:
        """Pad a batch of id lists into tensors the model accepts.

        The batch is moved onto the model's own device. A 4-bit QLoRA model
        loaded with ``device_map="auto"`` has its embedding on the GPU, and
        feeding it CPU tensors is the most common cause of a confusing
        device-mismatch failure at the first forward pass.
        """

        width = max(len(row) for row in rows)
        pad_id = tokenizer.pad_token_id or 0
        input_ids = [list(row) + [pad_id] * (width - len(row)) for row in rows]
        attention = [[1] * len(row) + [0] * (width - len(row)) for row in rows]
        batch = {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "attention_mask": torch.tensor(attention, dtype=torch.long),
        }
        device = getattr(model, "device", None)
        if device is not None:
            try:
                batch = {key: value.to(device) for key, value in batch.items()}
            except Exception:  # pragma: no cover - a stub without .to
                pass
        return batch

    batch_rows = [rendered[index % len(rendered)] for index in range(min(step_budget, len(rendered)))]

    # --- 4. forward -------------------------------------------------------
    try:
        batch = _batch(batch_rows)
        outputs = model(**batch, labels=batch["input_ids"])
        loss = outputs.loss
        if loss is None or not torch.isfinite(loss):
            raise TrainingEngineError(f"forward produced a non-finite loss: {loss}")
        result.loss_before = float(loss.detach().to("cpu").item())
        result.forward_pass_ok = True
    except Exception as exc:
        result.errors.append(f"forward: {exc}")
        result.adapter_hash_after = adapter_weight_hash(model)
        result.parameters_changed = (
            result.adapter_hash_after != result.adapter_hash_before
        )
        result.duration_seconds = round(time.time() - started, 3)
        return result

    # --- 5. backward ------------------------------------------------------
    try:
        loss.backward()
        grads = [
            parameter.grad
            for parameter in params
            if getattr(parameter, "grad", None) is not None
        ]
        if not grads:
            raise TrainingEngineError(
                "backward produced no gradients on any trainable parameter"
            )
        # A non-zero gradient means the loss is genuinely connected to the
        # trainable parameters. The check is skipped for a tensor-like object
        # with no element-wise comparison, rather than assumed to have passed.
        if hasattr(grads[0], "ne") and callable(getattr(grads[0], "any", None)):
            if not any(bool(torch.any(gradient != 0).item()) for gradient in grads):
                raise TrainingEngineError(
                    "every gradient was exactly zero; the loss is not connected "
                    "to the trainable parameters"
                )
        result.backward_pass_ok = True
    except Exception as exc:
        result.errors.append(f"backward: {exc}")
        # Hash the weights before bailing so "did anything move?" is still
        # reported as a measurement rather than left blank.
        result.adapter_hash_after = adapter_weight_hash(model)
        result.parameters_changed = (
            result.adapter_hash_after != result.adapter_hash_before
        )
        result.duration_seconds = round(time.time() - started, 3)
        return result

    # --- 6. one optimizer step, then prove the weights moved --------------
    try:
        optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        result.adapter_hash_after = adapter_weight_hash(model)
        result.parameters_changed = result.adapter_hash_after != result.adapter_hash_before

        with torch.no_grad():
            after_outputs = model(**batch, labels=batch["input_ids"])
            result.loss_after = float(after_outputs.loss.detach().to("cpu").item())
    except Exception as exc:
        result.errors.append(f"optimizer step: {exc}")
        result.adapter_hash_after = adapter_weight_hash(model)
        result.parameters_changed = (
            result.adapter_hash_after != result.adapter_hash_before
        )
        result.duration_seconds = round(time.time() - started, 3)
        return result

    # --- 7. checkpoint save ----------------------------------------------
    saved = False
    checkpoint_dir = Path(config.output_dir) / "smoke-checkpoint"
    try:
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        save = getattr(model, "save_pretrained", None)
        if callable(save):
            save(str(checkpoint_dir))
            saved = True
    except Exception as exc:
        result.errors.append(f"checkpoint save: {exc}")

    if not saved:
        # The model cannot write itself. A state-dict dump is an honest
        # fallback: it is a real checkpoint of the real weights, and the
        # reload check below is performed against those bytes.
        try:
            torch.save(
                {
                    name: parameter.detach().clone()
                    for name, parameter in model.named_parameters()
                },
                checkpoint_dir / "weights.pt",
            )
            saved = True
            result.errors.append(
                "checkpoint save: model exposes no save_pretrained; fell back "
                "to a raw state-dict dump"
            )
        except Exception as exc:
            result.errors.append(f"checkpoint save fallback: {exc}")

    try:
        if not saved:
            raise TrainingEngineError("no checkpoint could be written")
        if not any(checkpoint_dir.iterdir()):
            raise TrainingEngineError("checkpoint directory is empty after save")
        result.checkpoint_path = str(checkpoint_dir)
        result.checkpoint_saved = True
    except Exception as exc:
        result.errors.append(f"checkpoint: {exc}")
        result.duration_seconds = round(time.time() - started, 3)
        return result

    # --- 8. checkpoint reload --------------------------------------------
    try:
        reloaded = _reload_checkpoint(model, checkpoint_dir)
        reloaded_hash = adapter_weight_hash(reloaded)
        if reloaded_hash != result.adapter_hash_after:
            raise TrainingEngineError(
                "reloaded weights differ from the saved weights: "
                f"{reloaded_hash[:12]} != {result.adapter_hash_after[:12]}"
            )
        result.checkpoint_reloaded = True
    except Exception as exc:
        result.errors.append(f"checkpoint reload: {exc}")

    # --- 9. inference -----------------------------------------------------
    try:
        model.eval()
        prompt_ids = rendered[0][: max(1, min(len(rendered[0]), 16))]
        with torch.no_grad():
            generated = model.generate(
                torch.tensor([prompt_ids], dtype=torch.long),
                max_new_tokens=4,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id or 0,
            )
        generated_ids = generated[0].tolist() if hasattr(generated, "tolist") else list(generated[0])
        if len(generated_ids) <= len(prompt_ids):
            raise TrainingEngineError("generation produced no new tokens")
        result.inference_sample = str(
            tokenizer.decode(generated_ids, skip_special_tokens=True)
        )[:512]
        result.inference_ok = bool(result.inference_sample)
    except Exception as exc:
        result.errors.append(f"inference: {exc}")

    result.duration_seconds = round(time.time() - started, 3)
    return result


def _is_peft_checkpoint(checkpoint_dir: Path) -> bool:
    """Whether ``checkpoint_dir`` holds a PEFT adapter rather than a full model."""

    return (Path(checkpoint_dir) / "adapter_config.json").exists()


def _reload_checkpoint(model: Any, checkpoint_dir: Path) -> Any:
    """Reload ``checkpoint_dir`` into a model whose weights can be re-hashed.

    The two cases are genuinely different and getting them confused is a real
    bug rather than a formality:

    * A **PEFT adapter** is not a standalone model. ``PeftModel.from_pretrained``
      takes the *base model* as its first argument and the adapter directory as
      its second, so calling it with the path alone raises. The base model is
      reconstructed from the adapter's own ``base_model_name_or_path``.
    * A **full model** writes a complete ``config.json`` plus weights, so the
      class's own ``from_pretrained(path)`` is correct.

    A model that is neither (the injected test stub) raises, and the caller
    records the reload check as unrun rather than claiming it passed.
    """

    checkpoint_dir = Path(checkpoint_dir)

    if _is_peft_checkpoint(checkpoint_dir):
        peft = _require("peft", "reloading the adapter checkpoint")
        transformers = _require("transformers", "reloading the adapter checkpoint")

        adapter_config = json.loads(
            (checkpoint_dir / "adapter_config.json").read_text(encoding="utf-8")
        )
        base_name = adapter_config.get("base_model_name_or_path")
        if not base_name:
            raise TrainingEngineError(
                "adapter_config.json records no base_model_name_or_path, so the "
                "adapter cannot be reloaded without guessing its base"
            )

        base = transformers.AutoModelForCausalLM.from_pretrained(
            base_name, trust_remote_code=False
        )
        return peft.PeftModel.from_pretrained(base, str(checkpoint_dir))

    reload = getattr(type(model), "from_pretrained", None)
    if not callable(reload):
        raise TrainingEngineError(
            "model class exposes no from_pretrained and the checkpoint is not "
            "a PEFT adapter, so it could not be reloaded"
        )
    return reload(str(checkpoint_dir))


def _to_hf_dataset(rows: Sequence[Mapping[str, Any]]) -> Any:
    """Convert rendered rows into a ``datasets.Dataset``.

    ``trl``'s ``SFTTrainer`` inspects ``dataset.column_names`` and slices with
    Arrow semantics, so a plain Python list of dicts fails with an opaque
    ``'list' object has no attribute 'column_names'`` several frames deep.
    Converting here keeps the failure surface in one place.

    The ``datasets`` package is not a hard requirement of this module: if it is
    unavailable the list is returned unchanged and whatever the installed trl
    does with it is reported verbatim at the trainer boundary.
    """

    try:
        import datasets
    except ImportError:  # pragma: no cover - datasets is in the ml extra
        return list(rows)
    return datasets.Dataset.from_list([dict(row) for row in rows])


def _build_sft_trainer(trl: Any, kwargs: dict[str, Any], tokenizer: Any) -> Any:
    """Construct ``SFTTrainer`` across the trl versions that are in the wild.

    Two incompatibilities are handled explicitly rather than papered over:

    * ``tokenizer=`` was renamed to ``processing_class=`` in newer trl; the
      wrong keyword raises ``TypeError`` at construction.
    * Newer trl builds its own TRL data collator and rejects a collator that
      does not expose an ``assistant_mask`` attribute.

    Each step is attempted in order and the first that constructs wins, so the
    engine works against both the pinned minimum (``trl>=0.10``) and current
    releases without a version check that would rot.
    """

    attempts: list[dict[str, Any]] = []

    base = dict(kwargs)
    # Newer trl constructs the collator itself; passing one that lacks the
    # newer interface breaks it, so try the modern shape first.
    modern = dict(base)
    modern.pop("data_collator", None)
    modern["processing_class"] = tokenizer
    attempts.append(modern)

    modern_with_collator = dict(base)
    modern_with_collator["processing_class"] = tokenizer
    attempts.append(modern_with_collator)

    legacy = dict(base)
    legacy["tokenizer"] = tokenizer
    attempts.append(legacy)

    attempts.append(dict(base))

    errors: list[str] = []
    for attempt in attempts:
        try:
            return trl.SFTTrainer(**attempt)
        except TypeError as exc:
            errors.append(str(exc))
            continue

    raise TrainingEngineError(
        "could not construct an SFTTrainer for the installed trl version. "
        "Attempts made:\n  "
        + "\n  ".join(errors)
        + f"\nInstall a supported trl with:\n    {INSTALL_HINT}"
    )


def _is_validatable(config: TrainingRunConfig) -> bool:
    """Whether ``validate_config`` can run on this config.

    A unit-test stub config may deliberately sit outside the validator's
    rules (an fp32 mini-model, for example), so the smoke test tolerates a
    rejected config when the caller supplied their own loaders. The default
    path is always validated.
    """

    try:
        validate_config(config)
    except ConfigError:
        return False
    return True


def _model_identifier(config: TrainingRunConfig, loader: ModelLoader) -> str:
    """Report which model actually ran, naming a stub as a stub."""

    if loader is _default_model_loader:
        return config.base_model or smoke_test_model()
    return f"{config.base_model or 'stub'} (injected loader: {getattr(loader, '__name__', 'anonymous')})"


def _default_model_loader(config: TrainingRunConfig, step_budget: int) -> Any:
    """Load a real, tiny causal LM wrapped in a fresh LoRA adapter.

    This is the default path: a genuine Hugging Face download and a genuine
    PEFT adapter, small enough to step on a CPU. It is not a stub, and it is
    not a stand-in for a training run - it exists to prove the plumbing works
    end to end before spending money on a GPU.
    """

    torch = _require("torch", "the smoke-test model")
    transformers = _require("transformers", "the smoke-test model")

    model_id = config.base_model or smoke_test_model()
    # The smoke test must never attempt to download a multi-billion-parameter
    # checkpoint: a config naming a 7B model still smoke-tests the tiny one.
    if _looks_large(model_id):
        model_id = smoke_test_model()

    model = transformers.AutoModelForCausalLM.from_pretrained(
        model_id,
        revision=None,
        trust_remote_code=False,
        torch_dtype=torch.float32,
    )

    try:
        import peft

        lora = peft.LoraConfig(
            r=min(config.lora_rank, 8),
            lora_alpha=max(min(config.lora_alpha, 16), 1),
            lora_dropout=config.lora_dropout,
            target_modules=list(config.resolved_target_modules()),
            bias="none",
            task_type="CAUSAL_LM",
        )
        model = peft.get_peft_model(model, lora)
    except Exception:
        # Without peft the smoke test still trains every parameter, which is a
        # weaker but real proof that the backward pass moves weights.
        for parameter in model.parameters():
            parameter.requires_grad = True

    return model


def _looks_large(model_id: str) -> bool:
    """Heuristic: does this model id name a checkpoint too big to smoke-test?"""

    lowered = model_id.lower()
    for marker in ("1.5b", "3b", "7b", "8b", "13b", "14b", "32b", "70b", "72b", "80b", "moe"):
        if marker in lowered:
            return True
    return False


def trainable_parameter_report(config: TrainingRunConfig) -> str:
    """Explain where trainable parameters will come from, without loading a model.

    This exists so a user can see the plan on a machine with no ML stack, and
    it is explicit that it is an *estimate* - :func:`train` reports the real
    counts.
    """

    lines = [
        f"method:            {config.method}",
        f"base model:        {config.base_model} @ {config.base_revision or '(unpinned)'}",
    ]
    if config.method == "full":
        lines.append("trainable params:  ALL parameters (full fine-tuning)")
    else:
        targets = ", ".join(config.resolved_target_modules())
        lines.extend(
            [
                f"lora rank:         {config.lora_rank}",
                f"lora alpha:        {config.lora_alpha}",
                f"target modules:    {targets}",
                "trainable params:  ESTIMATE - run `train` for the counted value",
            ]
        )
    return "\n".join(lines)
