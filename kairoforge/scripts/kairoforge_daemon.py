#!/usr/bin/env python3
"""KairoForge continuous training loop.

Turns the manual "generate data, then train" steps into one supervised service
that runs unattended:

    1. WATCH    - poll the teacher gateway's /v1/models for changes
    2. GENERATE - pull fresh training data from the teacher(s)
    3. PROCESS  - run the data pipeline (secret scan, quality, dedup, split)
    4. TRAIN    - fine-tune a KairoForge checkpoint on the new data
    5. REGISTER - publish the version and retire the previous one
    6. REPEAT   - forever, or for a bounded number of rounds

WHAT THIS IS
    A data flywheel. Each round the student sees more teacher output and its
    weights move further from the base model. It is genuine training: the
    checkpoints are real adapters produced by gradient descent, and nothing at
    inference time contacts the teacher.

WHAT THIS IS NOT
    It is not a way to make KairoForge *be* the teacher. A small student
    imitates a large one; it does not become it. The registry records the
    teacher models each dataset came from, so the lineage stays auditable.

TRAINING BACKEND
    By default training runs locally. That is fine for small models but will
    thrash on a memory-constrained machine, so the loop checks available memory
    before each round and refuses to start one it cannot finish - a stalled
    round is worse than a skipped one, because it looks like progress.

Usage::

    # Run continuously, training whenever the gateway's model set changes
    export FREELLMAPI_API_KEY=...
    python scripts/kairoforge_daemon.py --once          # one round now
    python scripts/kairoforge_daemon.py                 # watch forever
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STATE_FILE = ROOT / ".kairoforge/daemon-state.json"
LOG_FILE = ROOT / ".kairoforge/daemon.log"


def log(message: str) -> None:
    """Append a timestamped line to the daemon log and echo it."""

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{stamp}] {message}"
    print(line, flush=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def load_state() -> dict:
    """Read the daemon's persisted state, tolerating a corrupt file."""

    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            log("state file unreadable; starting fresh")
    return {"rounds": 0, "seen_models": [], "last_round_at": None, "history": []}


def save_state(state: dict) -> None:
    """Persist daemon state atomically."""

    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(STATE_FILE)


def fetch_models(base_url: str, api_key: str, timeout: float = 30.0) -> list[str]:
    """Return the gateway's currently offered model ids.

    A teacher gateway that reports 500+ models is the signal this loop watches:
    a model appearing that was not there last round means there is new material
    to learn from.
    """

    request = urllib.request.Request(f"{base_url.rstrip('/')}/models")
    request.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return sorted(m["id"] for m in payload.get("data", []) if isinstance(m, dict) and m.get("id"))


def available_memory_gib() -> float:
    """Best-effort free physical memory, in GiB.

    Used only as a guard: the loop skips a round it cannot finish rather than
    starting one that will be paged out to swap and stall.
    """

    try:
        import subprocess as sp

        out = sp.run(["vm_stat"], capture_output=True, text=True, timeout=10).stdout
        page_size = 16384
        free_pages = 0
        for line in out.splitlines():
            if line.startswith("Pages free:"):
                free_pages = int(line.split(":")[1].strip().rstrip("."))
            if "page size of" in line:
                page_size = int(line.split("page size of")[1].split()[0])
        return free_pages * page_size / (1024 ** 3)
    except Exception:
        return float("inf")


def run_step(description: str, argv: list[str], timeout: float | None = None) -> bool:
    """Run one subprocess step, streaming its output into the daemon log.

    ``PYTHONPATH`` is set explicitly on the child. The steps are launched with
    ``-m kairoforge.cli.main``, which resolves the package through the import
    system rather than through the script's own ``sys.path`` insertion, so
    inheriting the daemon's environment is not enough.
    """

    log(f"  -> {description}")

    child_env = dict(os.environ)
    existing = child_env.get("PYTHONPATH", "")
    src = str(ROOT / "src")
    child_env["PYTHONPATH"] = f"{src}{os.pathsep}{existing}" if existing else src

    try:
        result = subprocess.run(
            argv, cwd=str(ROOT), capture_output=True, text=True,
            timeout=timeout, env=child_env,
        )
    except subprocess.TimeoutExpired:
        log(f"  !! {description} timed out")
        return False

    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-4:]
        for line in tail:
            log(f"     {line}")
        log(f"  !! {description} failed (exit {result.returncode})")
        return False

    tail = (result.stdout or "").strip().splitlines()[-3:]
    for line in tail:
        log(f"     {line}")
    return True


def next_version(registry_path: Path) -> str:
    """Pick the next KairoForge version number from the registry."""

    from sys import path as sys_path

    sys_path.insert(0, str(ROOT / "src"))
    from kairoforge.registry.store import Registry

    registry = Registry(registry_path)
    versions = [v.version for v in registry.list_versions()]
    minor = 0
    for name in versions:
        if name.startswith("kairoforge-v1."):
            try:
                minor = max(minor, int(name.split(".")[-1]))
            except ValueError:
                continue
    return f"kairoforge-v1.{minor + 1}"


def one_round(args, state: dict) -> bool:
    """Run a single generate -> process -> train -> register cycle."""

    round_no = state["rounds"] + 1
    log(f"=== ROUND {round_no} ===")

    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        log(f"  !! {args.api_key_env} is not set; cannot reach the teacher")
        return False

    # --- 1. what is the gateway offering now? ---------------------------
    try:
        models = fetch_models(args.base_url, api_key, args.timeout)
    except Exception as exc:
        log(f"  !! gateway unreachable: {type(exc).__name__}: {exc}")
        return False

    seen = set(state.get("seen_models", []))
    new_models = [m for m in models if m not in seen]
    log(f"  gateway offers {len(models)} models ({len(new_models)} new since last round)")

    # --- 2. memory guard ------------------------------------------------
    free_gib = available_memory_gib()
    log(f"  free physical memory: {free_gib:.1f} GiB")
    if free_gib < args.min_memory_gib:
        log(
            f"  !! skipping this round: {free_gib:.1f} GiB free is below the "
            f"{args.min_memory_gib:.1f} GiB a training round needs. A round "
            "started here would page out to swap and stall."
        )
        return False

    # --- 3. generate fresh teacher data ---------------------------------
    raw_path = ROOT / f"data/raw/distill-round{round_no}.jsonl"
    if not run_step(
        f"generate {args.records} teacher records",
        [
            sys.executable, "scripts/generate_distill_data.py",
            "--base-url", args.base_url,
            "--api-key-env", args.api_key_env,
            "--model", args.teacher_model,
            "--count", str(args.records),
            "--workers", str(args.workers),
            "--out", str(raw_path),
        ],
        timeout=args.generate_timeout,
    ):
        return False

    if not raw_path.exists() or raw_path.stat().st_size == 0:
        log("  !! generator produced no data")
        return False

    # --- 4. process it ---------------------------------------------------
    dataset_dir = ROOT / f"data/processed/kairoforge-distill-r{round_no}"
    if not run_step(
        "run the data pipeline",
        [
            sys.executable, "-m", "kairoforge.cli.main",
            "--home", str(ROOT / ".kairoforge"),
            "dataset", "prepare",
            "--shard", str(raw_path),
            "--output", str(dataset_dir),
            "--version", f"kairoforge-distill-r{round_no}",
            "--source", f"distilled-round{round_no}",
            "--license", "Apache-2.0",
        ],
        timeout=900,
    ):
        return False

    manifest_path = dataset_dir / "manifest.json"
    if not manifest_path.exists():
        log("  !! pipeline produced no manifest")
        return False
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    log(f"  dataset: {manifest['total_records']} records, {manifest['estimated_tokens']:,} tokens")
    if manifest["total_records"] < args.min_records:
        log(f"  !! only {manifest['total_records']} records; below --min-records {args.min_records}")
        return False

    # --- 5. train --------------------------------------------------------
    version = next_version(ROOT / ".kairoforge/registry.json")
    log(f"  training {version} on {args.base_key}")
    if not run_step(
        f"train {version}",
        [
            sys.executable, "scripts/train_v12_lowmem.py",
            "--base", args.base_model,
            "--base-key", args.base_key,
            "--dataset", str(dataset_dir),
            "--version", version,
            "--max-steps", str(args.max_steps),
            "--sequence-length", str(args.sequence_length),
            "--gradient-accumulation", str(args.gradient_accumulation),
        ],
        timeout=args.train_timeout,
    ):
        return False

    # --- 6. record -------------------------------------------------------
    state["rounds"] = round_no
    state["seen_models"] = sorted(set(state.get("seen_models", [])) | set(models))
    state["last_round_at"] = datetime.now(timezone.utc).isoformat()
    state["history"].append({
        "round": round_no,
        "version": version,
        "dataset": manifest.get("dataset_version"),
        "records": manifest["total_records"],
        "tokens": manifest["estimated_tokens"],
        "new_models_seen": new_models[:20],
        "at": state["last_round_at"],
    })
    save_state(state)
    log(f"  DONE: {version} registered from {manifest['total_records']} records")
    return True


def main(argv: list[str] | None = None) -> int:
    """Run the continuous training loop."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("FREELLMAPI_BASE_URL", "http://127.0.0.1:31415/v1"))
    parser.add_argument("--api-key-env", default="FREELLMAPI_API_KEY")
    parser.add_argument("--teacher-model", default="auto")
    parser.add_argument("--base-model", default="Qwen/Qwen2.5-Coder-0.5B-Instruct")
    parser.add_argument("--base-key", default="qwen2.5-coder-0.5b-instruct")
    parser.add_argument("--records", type=int, default=200, help="teacher records per round")
    parser.add_argument("--min-records", type=int, default=50, help="skip training below this")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--max-steps", type=int, default=150)
    parser.add_argument("--sequence-length", type=int, default=256)
    parser.add_argument("--gradient-accumulation", type=int, default=16)
    parser.add_argument("--min-memory-gib", type=float, default=2.0)
    parser.add_argument("--interval", type=float, default=300.0, help="seconds between checks")
    parser.add_argument("--once", action="store_true", help="run one round and exit")
    parser.add_argument("--force", action="store_true", help="train even if the model set is unchanged")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--generate-timeout", type=float, default=1800.0)
    parser.add_argument("--train-timeout", type=float, default=14400.0)
    args = parser.parse_args(argv)

    state = load_state()
    log("KairoForge continuous training loop starting")
    log(f"  teacher : {args.base_url}")
    log(f"  student : {args.base_model}")
    log(f"  rounds completed so far: {state['rounds']}")

    if args.once:
        ok = one_round(args, state)
        return 0 if ok else 1

    while True:
        try:
            # Only train when something changed, unless explicitly forced.
            api_key = os.environ.get(args.api_key_env, "").strip()
            changed = True
            if api_key and not args.force:
                try:
                    models = set(fetch_models(args.base_url, api_key, args.timeout))
                    changed = bool(models - set(state.get("seen_models", [])))
                except Exception as exc:
                    log(f"gateway check failed ({type(exc).__name__}); retrying next interval")
                    changed = False

            if changed:
                one_round(args, state)
            else:
                log("no change in the teacher's model set; waiting")

        except KeyboardInterrupt:
            log("interrupted; stopping")
            return 0
        except Exception as exc:
            log(f"round error: {type(exc).__name__}: {exc}")

        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
