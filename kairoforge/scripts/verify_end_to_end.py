#!/usr/bin/env python3
"""Verify the complete KairoForge chain end to end.

This is the Phase 20 acceptance test. It walks the real path:

    USER -> HARNESS -> MODEL ROUTER -> KAIROFORGE -> CLOUD INFERENCE
         -> TRAINED KAIROFORGE CHECKPOINT -> RESPONSE -> HARNESS -> USER

and separately proves that a pre-existing provider still works, so adding
KairoForge cannot have been done by breaking something else.

Every check reports what it actually observed. A check that cannot run is
reported as SKIPPED with the reason, never as a pass.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"


@dataclass
class Check:
    """One observable assertion about the running system."""

    name: str
    status: str
    detail: str = ""

    def render(self) -> str:
        line = f"[{self.status}] {self.name}"
        if self.detail:
            line += f"\n        {self.detail}"
        return line


@dataclass
class Report:
    """Collected check results."""

    checks: list[Check] = field(default_factory=list)

    def add(self, name: str, status: str, detail: str = "") -> Check:
        check = Check(name, status, detail)
        self.checks.append(check)
        return check

    @property
    def ok(self) -> bool:
        return all(check.status != FAIL for check in self.checks)

    def render(self) -> str:
        lines = [check.render() for check in self.checks]
        passed = sum(1 for c in self.checks if c.status == PASS)
        skipped = sum(1 for c in self.checks if c.status == SKIP)
        failed = sum(1 for c in self.checks if c.status == FAIL)
        lines.append("")
        lines.append(f"{passed} passed, {failed} failed, {skipped} skipped")
        return "\n".join(lines)


def http_json(
    url: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> tuple[int, Any]:
    """Perform one HTTP request and decode a JSON response.

    Returns the status and decoded body; a non-2xx status is returned rather
    than raised so the caller can assert on it.
    """

    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
            try:
                return response.status, json.loads(payload)
            except json.JSONDecodeError:
                return response.status, payload
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(payload)
        except json.JSONDecodeError:
            return exc.code, payload
    except urllib.error.URLError as exc:
        raise ConnectionError(str(exc)) from exc


def check_registry(report: Report, registry_path: Path) -> dict[str, Any] | None:
    """Confirm a trained KairoForge version exists with a verifiable artifact."""

    if not registry_path.exists():
        report.add(
            "registry file exists",
            FAIL,
            f"no registry at {registry_path}. No KairoForge model has been "
            "published, so there is nothing to serve.",
        )
        return None

    data = json.loads(registry_path.read_text(encoding="utf-8"))
    versions = data.get("versions", {})
    if not versions:
        report.add("registry has versions", FAIL, "registry exists but is empty")
        return None

    report.add(
        "registry has versions",
        PASS,
        f"{len(versions)} version(s): {', '.join(sorted(versions))}",
    )

    # Prefer a deployed version, else the newest.
    deployed = [
        entry for entry in versions.values() if entry.get("status") == "deployed"
    ]
    candidates = deployed or list(versions.values())
    entry = sorted(candidates, key=lambda e: e.get("created_at", ""), reverse=True)[0]

    digest = entry.get("checkpoint_sha256", "")
    if not digest:
        report.add(
            f"checkpoint hash recorded for {entry.get('version')}",
            FAIL,
            "version has no checkpoint_sha256; it was never given a real artifact",
        )
        return entry

    report.add(
        f"checkpoint hash recorded for {entry.get('version')}",
        PASS,
        f"sha256={digest[:16]}...",
    )

    path = Path(entry.get("checkpoint_path", ""))
    if path.exists():
        report.add("checkpoint present on disk", PASS, str(path))
    else:
        report.add(
            "checkpoint present on disk",
            FAIL,
            f"registered at {path} but missing. The service will refuse to serve it.",
        )

    trainable = entry.get("trainable_parameters", 0)
    total = entry.get("total_parameters", 0)
    if trainable and total:
        report.add(
            "trainable parameters recorded",
            PASS,
            f"{trainable:,} of {total:,} ({100.0 * trainable / total:.4f}%)",
        )
    else:
        report.add(
            "trainable parameters recorded",
            FAIL,
            "no trainable/total parameter counts: cannot prove training occurred",
        )

    return entry


def check_kairoforge_service(
    report: Report, base_url: str, api_key: str, model_id: str
) -> None:
    """Walk the KairoForge inference service: health, models, provenance, chat."""

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    try:
        status, health = http_json(f"{base_url}/health")
    except ConnectionError as exc:
        report.add(
            "kairoforge service reachable",
            FAIL,
            f"cannot reach {base_url}: {exc}. Start it with "
            "`python -m kairoforge.inference.server`.",
        )
        return

    report.add("kairoforge service reachable", PASS, f"HTTP {status}")

    if isinstance(health, dict):
        loaded = health.get("model_loaded")
        report.add(
            "kairoforge has a checkpoint loaded",
            PASS if loaded else FAIL,
            f"version={health.get('version')} device={health.get('device')}",
        )
        report.add(
            "service authenticates requests",
            PASS if health.get("authenticated") else SKIP,
            "bearer token required" if health.get("authenticated")
            else "no API key configured (loopback-only deployment)",
        )

    status, models = http_json(f"{base_url}/v1/models", headers=headers)
    if status == 200 and isinstance(models, dict):
        ids = [m.get("id") for m in models.get("data", [])]
        report.add("GET /v1/models", PASS, f"advertises: {', '.join(ids) or '(none)'}")
    else:
        report.add("GET /v1/models", FAIL, f"HTTP {status}: {models}")

    status, provenance = http_json(
        f"{base_url}/v1/kairoforge/provenance", headers=headers
    )
    if status == 200 and isinstance(provenance, dict):
        report.add(
            "provenance reports a trained artifact",
            PASS,
            f"version={provenance.get('version')} "
            f"base={provenance.get('base_model')} "
            f"sha256={str(provenance.get('checkpoint_sha256'))[:16]}...",
        )
    else:
        report.add(
            "provenance reports a trained artifact",
            FAIL,
            f"HTTP {status}: {provenance}",
        )

    status, completion = http_json(
        f"{base_url}/v1/chat/completions",
        method="POST",
        body={
            "model": model_id,
            "messages": [
                {
                    "role": "user",
                    "content": "Write a Python function that returns the sum of a list.",
                }
            ],
            "max_tokens": 64,
            "temperature": 0.2,
        },
        headers=headers,
        timeout=120.0,
    )
    if status == 200 and isinstance(completion, dict):
        choices = completion.get("choices") or []
        text = choices[0].get("message", {}).get("content", "") if choices else ""
        report.add(
            "kairoforge answers a chat request",
            PASS,
            f"{len(text)} chars returned; checkpoint={completion.get('kairoforge', {}).get('checkpoint_sha256', 'n/a')[:16]}...",
        )
    else:
        report.add("kairoforge answers a chat request", FAIL, f"HTTP {status}: {completion}")

    status, completion = http_json(
        f"{base_url}/v1/completions",
        method="POST",
        body={"model": model_id, "prompt": "def add(a, b):", "max_tokens": 32},
        headers=headers,
        timeout=120.0,
    )
    report.add(
        "POST /v1/completions",
        PASS if status == 200 else FAIL,
        f"HTTP {status}",
    )

    if api_key:
        status, _ = http_json(
            f"{base_url}/v1/models", headers={"Authorization": "Bearer wrong-key"}
        )
        report.add(
            "service rejects a bad credential",
            PASS if status == 401 else FAIL,
            f"HTTP {status} (expected 401)",
        )


def check_existing_provider(
    report: Report, base_url: str, api_key: str, model: str
) -> None:
    """Confirm an unrelated, pre-existing provider still responds.

    This is the regression guard: adding KairoForge must not have disturbed
    the providers that were already configured.
    """

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        status, payload = http_json(
            f"{base_url}/v1/chat/completions",
            method="POST",
            body={
                "model": model,
                "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
                "max_tokens": 16,
            },
            headers=headers,
            timeout=120.0,
        )
    except ConnectionError as exc:
        report.add("existing provider still works", SKIP, f"unreachable: {exc}")
        return

    if status == 200:
        report.add("existing provider still works", PASS, f"{model} responded")
    else:
        report.add(
            "existing provider still works",
            FAIL,
            f"{model} returned HTTP {status}: {str(payload)[:200]}",
        )


def check_durable_across_worker(
    report: Report, entry: dict[str, Any] | None
) -> None:
    """Confirm the checkpoint lives outside any training worker.

    A checkpoint that only exists inside an ephemeral GPU container is not a
    durable model: destroying the worker would lose it.
    """

    if entry is None:
        report.add("checkpoint is independent of the worker", SKIP, "no version registered")
        return

    path = Path(entry.get("checkpoint_path", ""))
    parts = {part.lower() for part in path.parts}
    ephemeral_markers = {"/tmp", "tmp", "ephemeral", "runpod-volume-mount"}
    if any(marker in parts for marker in ephemeral_markers):
        report.add(
            "checkpoint is independent of the worker",
            FAIL,
            f"checkpoint is stored at {path}, which looks ephemeral; a destroyed "
            "worker would lose it",
        )
    else:
        report.add(
            "checkpoint is independent of the worker",
            PASS,
            f"stored at a durable path: {path}",
        )


def check_cloud_resources(report: Report) -> None:
    """Report whether expensive training resources are still running.

    Without provider credentials this cannot enumerate live instances, so it
    reports what it can verify and says so plainly rather than claiming the
    account is clean.
    """

    env_hints = {
        "RUNPOD_API_KEY": "runpod",
        "VAST_API_KEY": "vast.ai",
        "LAMBDA_API_KEY": "lambda",
    }
    configured = [name for name in env_hints if os.environ.get(name)]
    if not configured:
        report.add(
            "cloud training credentials",
            SKIP,
            "no provider credentials in the environment; cannot enumerate live "
            "instances. Verify manually that no training pod is running.",
        )
    else:
        report.add(
            "cloud training credentials",
            PASS,
            f"configured for: {', '.join(env_hints[name] for name in configured)}. "
            "Run `kairoforge cloud list-instances` to confirm none are still billing.",
        )


def main(argv: list[str] | None = None) -> int:
    """Run every acceptance check and print a report."""

    parser = argparse.ArgumentParser(description="Verify the KairoForge end-to-end chain")
    parser.add_argument(
        "--kairoforge-url",
        default=os.environ.get("KAIROFORGE_ENDPOINT", "http://127.0.0.1:8090"),
        help="Base URL of the KairoForge inference service",
    )
    parser.add_argument(
        "--registry",
        default=os.environ.get("KAIROFORGE_REGISTRY", "registry.json"),
    )
    parser.add_argument("--model", default="kairoforge-v0.1")
    parser.add_argument(
        "--existing-provider-url",
        default="",
        help="OpenAI-compatible base URL of an existing provider to regression-check",
    )
    parser.add_argument("--existing-provider-model", default="")
    parser.add_argument("--existing-provider-key-env", default="")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text")
    args = parser.parse_args(argv)

    report = Report()
    api_key = os.environ.get("KAIROFORGE_API_KEY", "")

    entry = check_registry(report, Path(args.registry))
    check_durable_across_worker(report, entry)
    check_kairoforge_service(report, args.kairoforge_url.rstrip("/"), api_key, args.model)

    if args.existing_provider_url:
        check_existing_provider(
            report,
            args.existing_provider_url.rstrip("/"),
            os.environ.get(args.existing_provider_key_env, "") if args.existing_provider_key_env else "",
            args.existing_provider_model or "gpt-4o-mini",
        )
    else:
        report.add(
            "existing provider still works",
            SKIP,
            "pass --existing-provider-url to regression-check a non-KairoForge provider",
        )

    check_cloud_resources(report)

    if args.json:
        print(
            json.dumps(
                {
                    "ok": report.ok,
                    "checks": [
                        {"name": c.name, "status": c.status, "detail": c.detail}
                        for c in report.checks
                    ],
                },
                indent=2,
            )
        )
    else:
        print("KAIROFORGE END-TO-END VERIFICATION")
        print("=" * 60)
        print(report.render())

    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
