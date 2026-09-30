"""OpenAI-compatible KairoForge inference server."""

from __future__ import annotations

import os
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

MODEL_ID = "kairoforge"


class ChatMessage(BaseModel):
    """One OpenAI-compatible chat message."""

    role: str
    content: str


class ChatRequest(BaseModel):
    """Minimal OpenAI-compatible chat completion request."""

    model: str = MODEL_ID
    messages: list[ChatMessage]
    max_tokens: int = 512
    temperature: float = 0.2


def create_app() -> FastAPI:
    """Create the KairoForge API app."""

    app = FastAPI(title="KairoForge API", version="0.1.0")

    def require_auth(authorization: str | None) -> None:
        key = os.environ.get("KAIROFORGE_API_KEY")
        if not key:
            return
        if authorization != f"Bearer {key}":
            raise HTTPException(status_code=401, detail="Invalid API key")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "model": MODEL_ID, "checkpoint": os.environ.get("KAIROFORGE_CHECKPOINT", "not-loaded")}

    @app.get("/v1/models")
    def models() -> dict[str, Any]:
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "kairoforge"}]}

    @app.post("/v1/chat/completions")
    def chat(request: ChatRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_auth(authorization)
        if request.model != MODEL_ID:
            raise HTTPException(status_code=404, detail=f"Unknown model: {request.model}")
        if not request.messages:
            raise HTTPException(status_code=400, detail="messages must not be empty")
        checkpoint = os.environ.get("KAIROFORGE_CHECKPOINT")
        if not checkpoint:
            raise HTTPException(
                status_code=503,
                detail="KairoForge checkpoint is not loaded. Train or attach a checkpoint before serving real completions.",
            )
        raise HTTPException(status_code=501, detail="Model loading/generation adapter is not wired yet.")

    return app


app = create_app()


def main() -> None:
    """Run the API with uvicorn."""

    import uvicorn

    uvicorn.run("kairoforge.server:app", host="127.0.0.1", port=8090, reload=False)


if __name__ == "__main__":
    main()
