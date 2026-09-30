"""OpenAI-compatible HTTP API for a trained KairoForge checkpoint.

Exposes the three endpoints the harness router needs:

    GET  /v1/models            - list KairoForge versions from the registry
    POST /v1/chat/completions  - chat completion against the loaded checkpoint
    POST /v1/completions       - legacy text completion

Plus ``/health`` for the training panel and ``/v1/kairoforge/provenance``,
which reports the exact checkpoint hash answering requests. That last endpoint
exists so a caller can prove the response came from the trained KairoForge
artifact rather than from any other model.

Security: the service refuses to start without an API key unless it is bound
to loopback, and credentials are read from the environment, never from a
literal in this file.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional

from ..inference.service import (
    ChatMessage,
    GenerationRequest,
    ModelService,
    ModelServiceError,
)
from ..registry.store import Registry


#: Environment variable holding the bearer token clients must present.
API_KEY_ENV_VAR = "KAIROFORGE_API_KEY"

#: Environment variable naming the registry file to serve from.
REGISTRY_ENV_VAR = "KAIROFORGE_REGISTRY"

#: Default model id advertised to OpenAI-compatible clients.
DEFAULT_MODEL_ID = "kairoforge"


class AuthError(RuntimeError):
    """Raised when a request presents no valid credential."""


@dataclass
class ServerConfig:
    """Runtime configuration for the inference server."""

    host: str = "127.0.0.1"
    port: int = 8090
    registry_path: Path = Path("registry.json")
    device: str = "auto"
    api_key: str = ""
    default_version: str = ""

    @property
    def is_loopback(self) -> bool:
        """Whether the bind address is reachable only from this machine."""

        return self.host in {"127.0.0.1", "localhost", "::1"}

    def validate(self) -> None:
        """Refuse configurations that would expose an unauthenticated endpoint.

        A public bind without a key is the failure mode that turns a private
        research model into someone else's free inference API, so it is a
        startup error rather than a warning.
        """

        if not self.is_loopback and not self.api_key:
            raise AuthError(
                f"refusing to bind {self.host}:{self.port} without authentication. "
                f"Set {API_KEY_ENV_VAR} to a strong secret, or bind 127.0.0.1 for "
                "local-only access."
            )
        if self.api_key and len(self.api_key) < 16:
            raise AuthError(
                f"{API_KEY_ENV_VAR} is too short ({len(self.api_key)} chars). "
                "Use at least 16 characters of real randomness."
            )

    @classmethod
    def from_environment(cls, **overrides: Any) -> "ServerConfig":
        """Build configuration from the environment, then apply overrides."""

        config = cls(
            host=os.environ.get("KAIROFORGE_HOST", "127.0.0.1"),
            port=int(os.environ.get("KAIROFORGE_PORT", "8090")),
            registry_path=Path(
                os.environ.get(REGISTRY_ENV_VAR, "registry.json")
            ),
            device=os.environ.get("KAIROFORGE_DEVICE", "auto"),
            api_key=os.environ.get(API_KEY_ENV_VAR, ""),
            default_version=os.environ.get("KAIROFORGE_VERSION", ""),
        )
        for key, value in overrides.items():
            setattr(config, key, value)
        return config


def check_auth(authorization: str | None, config: ServerConfig) -> None:
    """Verify the bearer token when the server requires one."""

    if not config.api_key:
        # Only reachable because validate() guarantees a loopback bind.
        return
    if not authorization:
        raise AuthError("missing Authorization header")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise AuthError("expected an 'Authorization: Bearer <token>' header")
    # Constant-time comparison so the token cannot be recovered by timing.
    import hmac

    if not hmac.compare_digest(token, config.api_key):
        raise AuthError("invalid API key")


def chat_completion_payload(
    result: Any,
    model_id: str,
    created: int | None = None,
) -> dict[str, Any]:
    """Render a :class:`GenerationResult` as an OpenAI chat completion."""

    return {
        "id": f"chatcmpl-kairoforge-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": created if created is not None else int(time.time()),
        "model": model_id,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": result.text},
                "finish_reason": result.finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "total_tokens": result.prompt_tokens + result.completion_tokens,
        },
        "kairoforge": {
            "version": result.model,
            "checkpoint_sha256": result.checkpoint_sha256,
            "latency_seconds": round(result.latency_seconds, 3),
        },
    }


def completion_payload(result: Any, model_id: str) -> dict[str, Any]:
    """Render a :class:`GenerationResult` as an OpenAI legacy completion."""

    return {
        "id": f"cmpl-kairoforge-{int(time.time() * 1000)}",
        "object": "text_completion",
        "created": int(time.time()),
        "model": model_id,
        "choices": [
            {
                "index": 0,
                "text": result.text,
                "finish_reason": result.finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "total_tokens": result.prompt_tokens + result.completion_tokens,
        },
        "kairoforge": {
            "version": result.model,
            "checkpoint_sha256": result.checkpoint_sha256,
        },
    }


class KairoForgeApp:
    """Framework-agnostic request handling.

    The handlers are plain methods returning ``(status, payload)`` so the
    logic is testable without a web server, and so the same code serves under
    FastAPI, uvicorn, or a container health check.
    """

    def __init__(self, service: ModelService, config: ServerConfig) -> None:
        self.service = service
        self.config = config

    def health(self) -> tuple[int, dict[str, Any]]:
        """Liveness plus which checkpoint is resident."""

        payload = self.service.describe()
        payload["authenticated"] = bool(self.config.api_key)
        payload["loopback_only"] = self.config.is_loopback
        return 200, payload

    def models(self, authorization: str | None) -> tuple[int, dict[str, Any]]:
        """``GET /v1/models``."""

        try:
            check_auth(authorization, self.config)
        except AuthError as exc:
            return 401, {"error": {"message": str(exc), "type": "invalid_request_error"}}

        listed = self.service.list_models()
        if not listed:
            # Advertise the canonical id even before training so a client can
            # configure the provider; requests will then fail with a clear
            # "nothing trained" error rather than a confusing 404.
            listed = [
                {
                    "id": DEFAULT_MODEL_ID,
                    "object": "model",
                    "created": int(time.time()),
                    "owned_by": "kairoforge",
                    "kairoforge": {"status": "not-trained"},
                }
            ]
        return 200, {"object": "list", "data": listed}

    def chat_completions(
        self, body: dict[str, Any], authorization: str | None
    ) -> tuple[int, dict[str, Any]]:
        """``POST /v1/chat/completions``."""

        try:
            check_auth(authorization, self.config)
        except AuthError as exc:
            return 401, {"error": {"message": str(exc), "type": "invalid_request_error"}}

        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return 400, {
                "error": {
                    "message": "messages must be a non-empty array",
                    "type": "invalid_request_error",
                }
            }

        model_id = _resolve_model_id(body.get("model"), self.service, self.config)

        try:
            request = GenerationRequest(
                model=model_id,
                messages=[
                    ChatMessage(
                        role=str(message.get("role", "user")),
                        content=str(message.get("content", "")),
                    )
                    for message in messages
                    if isinstance(message, dict)
                ],
                temperature=float(body.get("temperature", 0.2)),
                top_p=float(body.get("top_p", 0.95)),
                max_tokens=int(body.get("max_tokens", 1024)),
                stop=list(body.get("stop") or []),
                stream=bool(body.get("stream", False)),
            )
            result = self.service.generate(request)
        except ModelServiceError as exc:
            return 503, {
                "error": {
                    "message": str(exc),
                    "type": "model_unavailable",
                    "code": "kairoforge_not_serving",
                }
            }
        except Exception as exc:  # pragma: no cover - provider dependent
            return 500, {"error": {"message": str(exc), "type": "internal_error"}}

        return 200, chat_completion_payload(result, model_id)

    def completions(
        self, body: dict[str, Any], authorization: str | None
    ) -> tuple[int, dict[str, Any]]:
        """``POST /v1/completions`` - the legacy text endpoint."""

        try:
            check_auth(authorization, self.config)
        except AuthError as exc:
            return 401, {"error": {"message": str(exc), "type": "invalid_request_error"}}

        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt:
            return 400, {
                "error": {
                    "message": "prompt must be a non-empty string",
                    "type": "invalid_request_error",
                }
            }

        model_id = _resolve_model_id(body.get("model"), self.service, self.config)

        try:
            result = self.service.generate(
                GenerationRequest(
                    model=model_id,
                    messages=[ChatMessage(role="user", content=prompt)],
                    temperature=float(body.get("temperature", 0.2)),
                    top_p=float(body.get("top_p", 0.95)),
                    max_tokens=int(body.get("max_tokens", 1024)),
                    stop=list(body.get("stop") or []),
                )
            )
        except ModelServiceError as exc:
            return 503, {
                "error": {
                    "message": str(exc),
                    "type": "model_unavailable",
                    "code": "kairoforge_not_serving",
                }
            }
        except Exception as exc:  # pragma: no cover
            return 500, {"error": {"message": str(exc), "type": "internal_error"}}

        return 200, completion_payload(result, model_id)

    def provenance(self, authorization: str | None) -> tuple[int, dict[str, Any]]:
        """``GET /v1/kairoforge/provenance``.

        Reports exactly which trained artifact is answering, so a caller can
        verify that responses come from the KairoForge checkpoint and not from
        a substituted model.
        """

        try:
            check_auth(authorization, self.config)
        except AuthError as exc:
            return 401, {"error": {"message": str(exc), "type": "invalid_request_error"}}

        loaded = self.service.loaded
        if loaded is None:
            return 503, {
                "error": {
                    "message": "no KairoForge checkpoint is loaded",
                    "type": "model_unavailable",
                }
            }

        entry = loaded.version
        return 200, {
            "version": entry.version,
            "base_model": entry.base_model,
            "base_revision": entry.base_revision,
            "training_method": entry.training_method,
            "dataset_version": entry.dataset_version,
            "dataset_hash": entry.dataset_hash,
            "train_tokens": entry.train_tokens,
            "trainable_parameters": entry.trainable_parameters,
            "total_parameters": entry.total_parameters,
            "trainable_fraction": round(entry.trainable_fraction, 6),
            "checkpoint_path": entry.checkpoint_path,
            "checkpoint_sha256": entry.checkpoint_sha256,
            "created_at": entry.created_at,
            "evaluation": entry.evaluation.to_json() if entry.evaluation else None,
        }


def _resolve_model_id(
    requested: Any, service: ModelService, config: ServerConfig
) -> str:
    """Map a client-supplied model name onto a registry version.

    ``kairoforge`` and ``kairoforge-latest`` are accepted as aliases for the
    configured or deployed version, so a harness config can name the provider
    stably while versions advance underneath.
    """

    if isinstance(requested, str) and requested not in {"", DEFAULT_MODEL_ID, "kairoforge-latest"}:
        return requested
    if config.default_version:
        return config.default_version
    deployed = service.registry.deployed()
    if deployed is not None:
        return deployed.version
    latest = service.registry.latest()
    if latest is not None:
        return latest.version
    return DEFAULT_MODEL_ID


def build_app(config: ServerConfig) -> Any:
    """Build a FastAPI application bound to a KairoForge registry.

    FastAPI is imported here rather than at module scope so the rest of the
    package works without the server extras installed.
    """

    try:
        from fastapi import Body, FastAPI, Header
        from fastapi.responses import JSONResponse
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise RuntimeError(
            'the server extra is not installed; run: pip install -e ".[server]"'
        ) from exc

    config.validate()
    registry = Registry(config.registry_path)
    service = ModelService(registry, device=config.device)
    app_impl = KairoForgeApp(service, config)

    app = FastAPI(title="KairoForge", version="0.1.0")

    @app.on_event("startup")
    def _startup() -> None:  # pragma: no cover - lifecycle hook
        # Loading is best-effort: the service stays up and reports
        # model_unavailable rather than crash-looping before training exists.
        try:
            service.load(config.default_version or None)
        except ModelServiceError as exc:
            print(f"kairoforge: starting without a loaded checkpoint ({exc})")

    @app.get("/health")
    def health() -> JSONResponse:
        status, payload = app_impl.health()
        return JSONResponse(payload, status_code=status)

    @app.get("/v1/models")
    def models(authorization: Optional[str] = Header(default=None)) -> JSONResponse:
        status, payload = app_impl.models(authorization)
        return JSONResponse(payload, status_code=status)

    @app.get("/v1/kairoforge/provenance")
    def provenance(authorization: Optional[str] = Header(default=None)) -> JSONResponse:
        status, payload = app_impl.provenance(authorization)
        return JSONResponse(payload, status_code=status)

    @app.post("/v1/chat/completions")
    async def chat_completions(
        body: dict = Body(...), authorization: Optional[str] = Header(default=None)
    ) -> JSONResponse:
        # The request body is declared as a plain ``dict`` via ``Body`` rather
        # than read from a ``Request`` annotation. Under
        # ``from __future__ import annotations`` on Python 3.9, FastAPI cannot
        # resolve a deferred ``Request`` annotation, so it silently treats the
        # parameter as a required *query* field and every POST returns 422.
        # ``Body`` carries the marker in the default value, which survives
        # deferred annotations.
        status, payload = app_impl.chat_completions(body, authorization)
        return JSONResponse(payload, status_code=status)

    @app.post("/v1/completions")
    async def completions(
        body: dict = Body(...), authorization: Optional[str] = Header(default=None)
    ) -> JSONResponse:
        status, payload = app_impl.completions(body, authorization)
        return JSONResponse(payload, status_code=status)

    return app


def main(argv: list[str] | None = None) -> int:
    """Entry point for ``python -m kairoforge.inference.server``."""

    import argparse

    parser = argparse.ArgumentParser(description="Serve a trained KairoForge model")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--registry", default=None)
    parser.add_argument("--version", default=None, help="KairoForge version to serve")
    parser.add_argument("--device", default=None)
    args = parser.parse_args(argv)

    overrides: dict[str, Any] = {}
    if args.host:
        overrides["host"] = args.host
    if args.port:
        overrides["port"] = args.port
    if args.registry:
        overrides["registry_path"] = Path(args.registry)
    if args.version:
        overrides["default_version"] = args.version
    if args.device:
        overrides["device"] = args.device

    config = ServerConfig.from_environment(**overrides)
    try:
        config.validate()
    except AuthError as exc:
        print(f"kairoforge: {exc}")
        return 2

    try:
        import uvicorn
    except ImportError:
        print('kairoforge: uvicorn is not installed; run: pip install -e ".[server]"')
        return 2

    app = build_app(config)
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry point
    # Without this guard the documented command
    # ``python -m kairoforge.inference.server`` would import the module and
    # exit 0 without ever starting uvicorn - a silent no-op that looks like
    # success. ``main`` is also re-exported for the CLI's ``serve`` command.
    import sys

    sys.exit(main())
