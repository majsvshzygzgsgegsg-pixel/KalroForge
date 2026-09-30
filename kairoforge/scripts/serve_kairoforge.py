#!/usr/bin/env python3
"""Serve a trained KairoForge checkpoint for the harness.

This is the process the harness's model route connects to. It resolves the
registry, exports the credential the route names, and starts the
OpenAI-compatible server.

Two operating modes:

* ``--check`` - validate everything and exit without serving. Use it to confirm
  a checkpoint is present and loadable before wiring the route up.
* default - run the server in the foreground (the harness supervises it).

Credentials are never written to a config file: the API key is generated or
read from ``KAIROFORGE_API_KEY``, and the harness's ``apiKeyEnv`` refers to the
variable by name, not by value.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

DEFAULT_HOME = ROOT / ".kairoforge"
DEFAULT_KEY_FILE = DEFAULT_HOME / "api-key.txt"


def load_or_create_key(path: Path) -> tuple[str, bool]:
    """Return the service API key, generating and persisting one if absent.

    Persisting matters: the harness stores only the *variable name*, so a key
    that changed on every restart would silently break the route.
    """

    env_key = os.environ.get("KAIROFORGE_API_KEY", "").strip()
    if env_key:
        return env_key, False

    if path.exists():
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing, False

    key = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(key + "\n", encoding="utf-8")
    path.chmod(0o600)
    return key, True


def resolve_registry(home: Path, explicit: str | None) -> Path:
    """Find the registry, preferring an explicit path then the standard home."""

    if explicit:
        return Path(explicit)
    for candidate in (home / "registry.json", ROOT / "registry.json"):
        if candidate.exists():
            return candidate
    return home / "registry.json"


def preflight(registry_path: Path, version: str | None) -> tuple[bool, str]:
    """Confirm a real checkpoint exists and is servable, without serving it.

    Returns ``(ok, message)``. Every failure names the concrete problem, so a
    broken setup is diagnosed here rather than as an opaque route error.
    """

    from kairoforge.registry.store import Registry, verify_checkpoint
    from kairoforge.registry.store import RegistryError

    if not registry_path.exists():
        return False, (
            f"no registry at {registry_path}. Train and register a version "
            "before serving:\n"
            "  python scripts/train_kairoforge.py\n"
            "  python -m kairoforge.cli.main --home .kairoforge registry list"
        )

    registry = Registry(registry_path)
    versions = registry.list_versions()
    if not versions:
        return False, f"registry at {registry_path} exists but has no versions"

    try:
        entry = registry.get(version) if version else (registry.deployed() or registry.latest())
    except RegistryError as exc:
        return False, str(exc)
    if entry is None:
        return False, "registry has no servable version"

    checkpoint = Path(entry.checkpoint_path)
    if not checkpoint.exists():
        return False, (
            f"{entry.version} is registered at {checkpoint} but that path does "
            "not exist. KairoForge will not substitute another model."
        )

    if not entry.checkpoint_sha256:
        return False, f"{entry.version} has no recorded checkpoint hash"
    if not verify_checkpoint(checkpoint, entry.checkpoint_sha256):
        return False, (
            f"{entry.version} checkpoint failed verification against the "
            f"registered hash {entry.checkpoint_sha256[:16]}..."
        )

    return True, (
        f"{entry.version} ready: base={entry.base_model} "
        f"trainable={entry.trainable_parameters:,}/{entry.total_parameters:,} "
        f"sha256={entry.checkpoint_sha256[:16]}..."
    )


def main(argv: list[str] | None = None) -> int:
    """Entry point for ``scripts/serve_kairoforge.py``."""

    parser = argparse.ArgumentParser(description="Serve KairoForge for the harness")
    parser.add_argument("--home", default=str(DEFAULT_HOME))
    parser.add_argument("--registry", default=None)
    parser.add_argument("--version", default=None, help="version to serve (default: deployed/latest)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--check", action="store_true", help="validate then exit without serving")
    parser.add_argument("--print-config", action="store_true", help="print the harness route YAML and exit")
    args = parser.parse_args(argv)

    home = Path(args.home)
    registry_path = resolve_registry(home, args.registry)

    key, generated = load_or_create_key(DEFAULT_KEY_FILE)

    if args.print_config:
        print(json.dumps({
            "provider": "kairoforge",
            "baseURL": f"http://{args.host}:{args.port}/v1",
            "apiKeyEnv": "KAIROFORGE_API_KEY",
            "keyFile": str(DEFAULT_KEY_FILE),
            "registry": str(registry_path),
        }, indent=2))
        return 0

    ok, message = preflight(registry_path, args.version)
    print(f"kairoforge: {message}", file=sys.stderr if not ok else sys.stdout)

    if args.check:
        if ok:
            print(f"kairoforge: API key at {DEFAULT_KEY_FILE} ({'generated now' if generated else 'existing'})")
            print(f"kairoforge: registry {registry_path}")
        return 0 if ok else 1

    if not ok:
        return 1

    # The server reads these directly, so the harness route's apiKeyEnv resolves.
    os.environ["KAIROFORGE_API_KEY"] = key
    os.environ["KAIROFORGE_REGISTRY"] = str(registry_path)
    os.environ["KAIROFORGE_DEVICE"] = args.device

    from kairoforge.inference.server import main as serve_main

    serve_argv = [
        "--host", args.host,
        "--port", str(args.port),
        "--registry", str(registry_path),
        "--device", args.device,
    ]
    if args.version:
        serve_argv += ["--version", args.version]
    return serve_main(serve_argv)


if __name__ == "__main__":
    sys.exit(main())
