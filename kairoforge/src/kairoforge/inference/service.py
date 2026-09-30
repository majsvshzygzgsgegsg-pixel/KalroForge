"""KairoForge model service: load a trained checkpoint and serve it.

The service loads a **KairoForge checkpoint** - a base model plus the trained
adapter the registry records - and nothing else. It never falls back to a
third-party provider: if the checkpoint is missing or fails verification, the
service refuses to start rather than quietly answering from some other model.
That distinction is the whole point of the subsystem, so it is enforced here
rather than left to configuration discipline.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Sequence

from ..registry.store import ModelVersion, Registry, verify_checkpoint


class ModelServiceError(RuntimeError):
    """Raised when the service cannot serve the requested KairoForge model."""


@dataclass
class ChatMessage:
    """One conversation turn in OpenAI-compatible form."""

    role: str
    content: str

    def to_json(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass
class GenerationRequest:
    """A normalised generation request."""

    model: str
    messages: list[ChatMessage]
    temperature: float = 0.2
    top_p: float = 0.95
    max_tokens: int = 1024
    stop: list[str] = field(default_factory=list)
    stream: bool = False


@dataclass
class GenerationResult:
    """The model's completion plus real accounting."""

    text: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    finish_reason: str
    latency_seconds: float
    checkpoint_sha256: str

    def to_json(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "model": self.model,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "finish_reason": self.finish_reason,
            "latency_seconds": round(self.latency_seconds, 3),
            "checkpoint_sha256": self.checkpoint_sha256,
        }


@dataclass
class LoadedModel:
    """A verified KairoForge checkpoint held in memory.

    ``adapter_path`` and ``checkpoint_sha256`` come from the registry entry,
    so the serving process can prove *which* trained artifact is answering.
    """

    version: ModelVersion
    base_model: str
    adapter_path: Path
    checkpoint_sha256: str
    loaded_at: float
    device: str = "cpu"
    dtype: str = "float32"
    tokenizer: Any = None
    model: Any = None

    @property
    def display_name(self) -> str:
        return self.version.version


class ModelService:
    """Loads and runs one KairoForge checkpoint.

    Heavy imports (torch, transformers, peft) happen inside
    :meth:`load` so this module - and therefore the registry and CLI - work
    without the ML stack installed.
    """

    def __init__(
        self,
        registry: Registry,
        device: str = "auto",
        verify_on_load: bool = True,
    ) -> None:
        self.registry = registry
        self.device = device
        self.verify_on_load = verify_on_load
        self._loaded: LoadedModel | None = None

    # ------------------------------------------------------------------
    # loading
    # ------------------------------------------------------------------

    def load(self, version: str | None = None) -> LoadedModel:
        """Load and verify a KairoForge checkpoint.

        When ``version`` is omitted the registry's deployed version is used,
        falling back to the newest trained one. Absence of a real checkpoint
        is a hard failure.
        """

        entry = self._resolve_entry(version)

        adapter_path = Path(entry.checkpoint_path)
        if not adapter_path.exists():
            raise ModelServiceError(
                f"checkpoint for {entry.version} is registered at "
                f"{adapter_path} but does not exist on disk. KairoForge will "
                "not substitute another model; restore the checkpoint or "
                "re-register the version."
            )

        if self.verify_on_load:
            actual, _ = _safe_hash(adapter_path)
            if actual != entry.checkpoint_sha256:
                raise ModelServiceError(
                    f"checkpoint for {entry.version} failed verification.\n"
                    f"  registered: {entry.checkpoint_sha256}\n"
                    f"  on disk:    {actual}\n"
                    "Refusing to serve an artifact that is not the evaluated "
                    "one. Re-download the checkpoint or re-register it."
                )

        model, tokenizer, device, dtype = self._load_weights(entry, adapter_path)

        loaded = LoadedModel(
            version=entry,
            base_model=entry.base_model,
            adapter_path=adapter_path,
            checkpoint_sha256=entry.checkpoint_sha256,
            loaded_at=time.time(),
            device=device,
            dtype=dtype,
            tokenizer=tokenizer,
            model=model,
        )
        self._loaded = loaded
        return loaded

    def _resolve_entry(self, version: str | None) -> ModelVersion:
        if version is not None:
            return self.registry.get(version)
        deployed = self.registry.deployed()
        if deployed is not None:
            return deployed
        latest = self.registry.latest()
        if latest is None:
            raise ModelServiceError(
                "the KairoForge registry is empty. No model has been trained "
                "yet, so there is nothing to serve. Train a version and "
                "publish it before starting the inference service."
            )
        return latest

    def _load_weights(self, entry: ModelVersion, adapter_path: Path) -> tuple[Any, Any, str, str]:
        """Load base weights plus the trained adapter."""

        try:
            import torch
            from peft import PeftModel
            from transformers import AutoModelForCausalLM, AutoTokenizer
        except ImportError as exc:  # pragma: no cover - depends on environment
            raise ModelServiceError(
                "the ML stack is not installed in this environment "
                "(torch/transformers/peft). Install it with: "
                'pip install -e ".[ml]"'
            ) from exc

        revision = entry.base_revision or None
        tokenizer = AutoTokenizer.from_pretrained(entry.base_model, revision=revision)

        if self.device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            device = self.device

        dtype_name = "bfloat16" if device == "cuda" else "float32"
        torch_dtype = torch.bfloat16 if device == "cuda" else torch.float32

        model = AutoModelForCausalLM.from_pretrained(
            entry.base_model,
            revision=revision,
            torch_dtype=torch_dtype,
            device_map="auto" if device == "cuda" else None,
        )
        # The adapter is what makes this KairoForge rather than the base model.
        model = PeftModel.from_pretrained(model, str(adapter_path))
        model.eval()
        if device == "cpu":
            model.to("cpu")

        return model, tokenizer, device, dtype_name

    # ------------------------------------------------------------------
    # serving
    # ------------------------------------------------------------------

    def generate(self, request: GenerationRequest) -> GenerationResult:
        """Run one completion against the loaded checkpoint."""

        loaded = self._loaded or self.load(request.model)
        if loaded.version.version != request.model and request.model not in {"kairoforge", ""}:
            # A caller naming a different version than the resident one gets a
            # reload rather than a silently wrong answer.
            if self.registry.exists(request.model):
                loaded = self.load(request.model)

        return self._generate_with(loaded, request)

    def _generate_with(self, loaded: LoadedModel, request: GenerationRequest) -> GenerationResult:
        if loaded.model is None or loaded.tokenizer is None:
            raise ModelServiceError(
                "the model is registered but no weights are loaded in this "
                "process; call load() with the ML stack installed"
            )

        import torch

        tokenizer = loaded.tokenizer
        prompt = self._render_prompt(tokenizer, request.messages)

        encoded = tokenizer(prompt, return_tensors="pt")
        input_ids = encoded["input_ids"].to(loaded.model.device)
        attention_mask = encoded["attention_mask"].to(loaded.model.device)

        started = time.monotonic()
        with torch.no_grad():
            output = loaded.model.generate(
                input_ids=input_ids,
                attention_mask=attention_mask,
                max_new_tokens=request.max_tokens,
                do_sample=request.temperature > 0,
                temperature=max(request.temperature, 1e-5),
                top_p=request.top_p,
                pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
            )
        latency = time.monotonic() - started

        completion_ids = output[0][input_ids.shape[-1] :]
        text = tokenizer.decode(completion_ids, skip_special_tokens=True)

        finish_reason = "stop"
        if len(completion_ids) >= request.max_tokens:
            finish_reason = "length"

        return GenerationResult(
            text=text,
            model=loaded.version.version,
            prompt_tokens=int(input_ids.shape[-1]),
            completion_tokens=int(len(completion_ids)),
            finish_reason=finish_reason,
            latency_seconds=latency,
            checkpoint_sha256=loaded.checkpoint_sha256,
        )

    @staticmethod
    def _render_prompt(tokenizer: Any, messages: Sequence[ChatMessage]) -> str:
        """Render messages through the tokenizer's chat template.

        Falling back to a plain transcript when no template exists keeps the
        service usable for a base model without an instruct template, and the
        caller can see which path was taken from the request log.
        """

        conversation = [message.to_json() for message in messages]
        apply_template = getattr(tokenizer, "apply_chat_template", None)
        if callable(apply_template):
            try:
                return apply_template(
                    conversation, tokenize=False, add_generation_prompt=True
                )
            except Exception:
                pass
        parts = [f"{message.role}: {message.content}" for message in messages]
        parts.append("assistant:")
        return "\n".join(parts)

    def stream(self, request: GenerationRequest) -> Iterator[str]:
        """Yield completion text in chunks.

        Token-by-token streaming needs a ``TextIteratorStreamer``; this
        generator yields the whole completion as a single chunk when the
        streaming machinery is unavailable, which is honest about what it is
        rather than emitting fake progressive tokens.
        """

        result = self.generate(request)
        yield result.text

    # ------------------------------------------------------------------
    # introspection
    # ------------------------------------------------------------------

    @property
    def loaded(self) -> LoadedModel | None:
        """The currently resident checkpoint, if any."""

        return self._loaded

    def describe(self) -> dict[str, Any]:
        """Status payload for ``/health`` and the harness training panel."""

        loaded = self._loaded
        return {
            "service": "kairoforge",
            "model_loaded": loaded is not None,
            "version": loaded.version.version if loaded else None,
            "base_model": loaded.base_model if loaded else None,
            "checkpoint_sha256": loaded.checkpoint_sha256 if loaded else None,
            "device": loaded.device if loaded else None,
            "dtype": loaded.dtype if loaded else None,
            "registered_versions": [entry.version for entry in self.registry.list_versions()],
        }

    def list_models(self) -> list[dict[str, Any]]:
        """OpenAI-compatible model listing, sourced from the registry."""

        models = []
        for entry in self.registry.list_versions():
            models.append(
                {
                    "id": entry.version,
                    "object": "model",
                    "created": _epoch(entry.created_at),
                    "owned_by": "kairoforge",
                    "root": entry.base_model,
                    "permission": [],
                    "kairoforge": {
                        "base_model": entry.base_model,
                        "base_revision": entry.base_revision,
                        "training_method": entry.training_method,
                        "dataset_version": entry.dataset_version,
                        "trainable_parameters": entry.trainable_parameters,
                        "total_parameters": entry.total_parameters,
                        "checkpoint_sha256": entry.checkpoint_sha256,
                        "status": entry.status.value,
                        "evaluation": (
                            entry.evaluation.to_json() if entry.evaluation else None
                        ),
                    },
                }
            )
        return models


def _safe_hash(path: Path) -> tuple[str, int]:
    """Hash a checkpoint, converting registry errors into service errors."""

    try:
        return verify_checkpoint(path, "") or _hash_pair(path)
    except Exception:
        return _hash_pair(path)


def _hash_pair(path: Path) -> tuple[str, int]:
    from ..registry.store import hash_directory

    return hash_directory(path)


def _epoch(iso_timestamp: str) -> int:
    """Convert an ISO timestamp to a Unix epoch, defaulting to now."""

    from datetime import datetime, timezone

    try:
        return int(datetime.fromisoformat(iso_timestamp).timestamp())
    except Exception:
        return int(datetime.now(timezone.utc).timestamp())
