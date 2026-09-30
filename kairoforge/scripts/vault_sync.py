#!/usr/bin/env python3
"""Sync harness conversations into the KairoForge vault, then use the vault.

Two directions, one command:

    sync    read every dsh session log into the vault (idempotent)
    prompt  print the memory block a new conversation should start with
    export  write vault conversations out as training pairs
    stats   report what the vault holds

This is the piece that makes the vault automatic: run ``sync`` on a schedule
or at harness start, and every conversation the user has is captured without
their having to do anything.

Usage::

    python scripts/vault_sync.py sync
    python scripts/vault_sync.py prompt
    python scripts/vault_sync.py export --out data/raw/vault-v1.jsonl
    python scripts/vault_sync.py stats
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

READER = HERE / "vault_reader.cjs"
DEFAULT_VAULT = ROOT / ".kairoforge/vault.sqlite"
DEFAULT_SESSIONS = Path.home() / ".dsh/sessions"


def read_sessions(sessions_dir: Path) -> list[dict]:
    """Decode every session log into flat message records.

    Delegates to the Node reader because session logs are concatenated
    Zstandard frames; node's zlib is available here and a Python zstd binding
    is not.
    """

    if not READER.exists():
        raise FileNotFoundError(f"vault reader missing at {READER}")

    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as handle:
        temp_path = Path(handle.name)

    result = subprocess.run(
        ["node", str(READER), "--sessions", str(sessions_dir), "--out", str(temp_path)],
        capture_output=True, text=True, timeout=600,
    )
    if result.returncode != 0:
        raise RuntimeError(f"vault reader failed: {result.stderr.strip()[:300]}")

    records = []
    for line in temp_path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            records.append(json.loads(line))
    temp_path.unlink(missing_ok=True)
    return records


def cmd_sync(args: argparse.Namespace) -> int:
    """Import harness sessions into the vault."""

    from kairoforge.vault.store import Vault

    sessions_dir = Path(args.sessions).expanduser()
    if not sessions_dir.exists():
        print(f"error: no session directory at {sessions_dir}", file=sys.stderr)
        return 2

    records = read_sessions(sessions_dir)
    by_session: dict[str, list[dict]] = {}
    for record in records:
        by_session.setdefault(record["session"], []).append(
            {"role": record["role"], "text": record["text"]}
        )

    vault = Vault(Path(args.vault))
    before = vault.stats()
    for session, messages in by_session.items():
        vault.record_conversation(session=session, messages=messages, source="harness-history")
    after = vault.stats()

    print("vault sync complete")
    print(f"  sessions read : {len(by_session)}")
    print(f"  messages seen : {len(records):,}")
    print(f"  new messages  : {after['messages'] - before['messages']:,}")
    print(f"  vault now     : {after['conversations']} conversations, "
          f"{after['messages']:,} messages, {after['total_characters']:,} characters")
    print(f"  path          : {after['path']}")
    return 0


def cmd_prompt(args: argparse.Namespace) -> int:
    """Print the memory block for a new conversation."""

    from kairoforge.vault.store import Vault

    vault = Vault(Path(args.vault))
    stats = vault.stats()
    if stats["messages"] == 0:
        print("(vault is empty; run `vault_sync.py sync` first)", file=sys.stderr)
        return 1

    block = vault.context_for_prompt(budget_chars=args.budget)
    if not block:
        print("(not enough history yet to derive a style profile)", file=sys.stderr)
        return 1
    print(block)
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    """Export vault conversations as training pairs."""

    from kairoforge.vault.store import Vault, export_training_pairs

    vault = Vault(Path(args.vault))
    written = export_training_pairs(vault, Path(args.out))
    print(f"exported {written:,} instruction/response pairs to {args.out}")
    if written == 0:
        print("(no complete user/assistant exchanges in the vault yet)", file=sys.stderr)
        return 1
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    """Report vault contents and the measured style profile."""

    from kairoforge.vault.store import Vault

    vault = Vault(Path(args.vault))
    stats = vault.stats()
    print("=== VAULT ===")
    for key, value in stats.items():
        print(f"  {key:22s}: {value:,}" if isinstance(value, int) else f"  {key:22s}: {value}")

    print()
    profile = vault.style_profile()
    print("=== MEASURED USER STYLE ===")
    for key, value in profile.to_json().items():
        print(f"  {key:22s}: {value}")

    print()
    print("=== MODELS THAT CONTRIBUTED ===")
    models = vault.models_seen()
    if not models:
        print("  (none recorded yet)")
    for name, count in models[:15]:
        print(f"  {count:6,}  {name}")
    return 0


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", default=str(DEFAULT_VAULT))
    sub = parser.add_subparsers(dest="command", required=True)

    sync = sub.add_parser("sync", help="import harness sessions into the vault")
    sync.add_argument("--sessions", default=str(DEFAULT_SESSIONS))
    sync.set_defaults(func=cmd_sync)

    prompt = sub.add_parser("prompt", help="print the memory block for a new conversation")
    prompt.add_argument("--budget", type=int, default=4000, help="max characters")
    prompt.set_defaults(func=cmd_prompt)

    export = sub.add_parser("export", help="write vault conversations as training pairs")
    export.add_argument("--out", default=str(ROOT / "data/raw/vault-v1.jsonl"))
    export.set_defaults(func=cmd_export)

    stats = sub.add_parser("stats", help="report vault contents and style")
    stats.set_defaults(func=cmd_stats)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
