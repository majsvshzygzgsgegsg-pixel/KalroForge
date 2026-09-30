#!/usr/bin/env python3
"""Generate KairoForge training data by distilling a teacher model.

This is the honest bridge between "an API key" and "a trained model". The
teacher (reachable through any OpenAI-compatible endpoint) produces responses;
those responses become supervised fine-tuning targets; a smaller open-weight
model is then fine-tuned on them.

The result is a genuinely different artifact from the teacher:

* the teacher is a 120B-class model that cannot run on consumer hardware;
* KairoForge is a small open-weight model whose weights were changed by
  gradient descent on this data;
* nothing at inference time calls the teacher.

WHAT THIS DOES NOT DO
    It does not make KairoForge identical to the teacher. A distilled student
    is a compressed imitation: it captures style, structure, and common
    patterns well, and is weaker on hard reasoning. That is an honest and
    useful outcome, not a limitation to hide.

PROVENANCE
    Every record records the teacher model id that produced it, so the
    resulting dataset is auditable and the registry can state exactly which
    teacher the student learned from.

Usage::

    python scripts/generate_distill_data.py --count 5000 --out data/raw/distill-v0.2.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

#: Prompt seeds spanning the task families KairoForge must cover. Each entry
#: pairs a task family and language with templates that are deliberately varied
#: so the teacher produces structurally different answers rather than N
#: paraphrases of one prompt (which the deduplicator would collapse).
SEEDS: list[tuple[str, str, str]] = [
    ("code-generation", "python", "Write a Python function that {task}. Include type hints and a docstring."),
    ("code-generation", "typescript", "Write a TypeScript function that {task}. Use strict types."),
    ("code-generation", "rust", "Write a Rust function that {task}. Handle errors with Result."),
    ("code-generation", "go", "Write a Go function that {task}. Return an error rather than panicking."),
    ("debugging", "python", "This Python code has a bug that {task}. Explain the bug and give the fix:\n\n```python\ndef process(items):\n    result = []\n    for i in range(len(items)):\n        result.append(items[i] * 2)\n    return result[0]\n```"),
    ("debugging", "javascript", "Find and fix the bug in this JavaScript that {task}:\n\n```javascript\nasync function load(urls) {\n  const out = [];\n  urls.forEach(async (u) => { out.push(await fetch(u)); });\n  return out;\n}\n```"),
    ("refactoring", "python", "Refactor this Python to {task}, keeping behaviour identical:\n\n```python\ndef f(d):\n    r = []\n    for k in d:\n        if d[k] > 0:\n            r.append(k)\n    return r\n```"),
    ("refactoring", "typescript", "Refactor this TypeScript to {task}:\n\n```typescript\nfunction calc(a: any, b: any, op: string) {\n  if (op === 'add') return a + b;\n  if (op === 'sub') return a - b;\n  if (op === 'mul') return a * b;\n  return 0;\n}\n```"),
    ("code-explanation", "python", "Explain what this Python does and why {task}:\n\n```python\nfrom functools import lru_cache\n\n@lru_cache(maxsize=None)\ndef fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\n```"),
    ("code-explanation", "sql", "Explain this SQL query and what it returns when {task}:\n\n```sql\nSELECT u.id, COUNT(o.id) AS n\nFROM users u\nLEFT JOIN orders o ON o.user_id = u.id\nGROUP BY u.id\nHAVING COUNT(o.id) > 3;\n```"),
    ("test-generation", "python", "Write pytest tests for a function that {task}. Cover edge cases."),
    ("test-generation", "typescript", "Write unit tests (jest or vitest) for a function that {task}."),
    ("repository-understanding", "text", "Describe how you would explore an unfamiliar repository to understand {task}. Be concrete about commands."),
    ("multi-file-editing", "text", "You must change {task} across several files. Describe the plan and the order of edits."),
    ("terminal-reasoning", "shell", "Give the shell commands to {task}, and explain each flag."),
    ("git-workflow", "shell", "Show the git commands to {task}, and explain when each is appropriate."),
    ("api-design", "python", "Design a REST API for {task}. Specify routes, methods, status codes, and payloads."),
    ("frontend", "typescript", "Build a React component that {task}. Include accessibility considerations."),
    ("backend", "python", "Implement a FastAPI endpoint that {task}. Include validation and error handling."),
    ("agentic-coding", "text", "You are a coding agent that must {task}. Give a step-by-step plan with tool calls."),
    ("tool-planning", "text", "List the tools you would call, in order, to {task}, and what you expect each to return."),
    ("instruction-following", "text", "Explain {task} in exactly 3 sentences, no preamble."),
]

#: Task fragments substituted into the templates. Combined with the templates
#: this yields many distinct prompts.
TASKS: list[str] = [
    "parses a CSV file and returns typed rows",
    "retries a network request with exponential backoff",
    "validates an email address without regex",
    "computes a rolling average over a stream",
    "flattens a nested dictionary",
    "merges two sorted lists in linear time",
    "detects a cycle in a linked list",
    "finds the longest common prefix of a list of strings",
    "safely divides two numbers and handles zero",
    "caches expensive results with a TTL",
    "paginates a database query efficiently",
    "converts a nested callback API to promises",
    "deduplicates a list while preserving order",
    "splits a large file into chunks",
    "implements a simple rate limiter",
    "serialises a dataclass to JSON",
    "reads environment variables with defaults",
    "implements binary search over a sorted array",
    "groups records by a key and aggregates them",
    "streams a large JSON response without loading it fully",
    "handles timezone-aware timestamps correctly",
    "implements a bounded LRU cache",
    "parses command-line arguments with subcommands",
    "writes a file atomically to avoid partial reads",
    "implements a retry decorator",
    "sanitises user input before a database query",
    "computes the difference between two dates in business days",
    "implements a simple state machine",
    "batches API calls to respect a rate limit",
    "implements deepest-first traversal of a tree",
    "converts between two data schemas",
    "validates a JSON payload against a schema",
    "implements an in-memory job queue",
    "sorts a list of objects by multiple keys",
    "handles partial failures in a batch operation",
    "implements a circuit breaker",
    "normalises unicode text safely",
    "computes a checksum and verifies it",
    "implements a simple template renderer",
    "finds duplicate files by content hash",
    "background image processing for uploaded photos",
    "search across a large document set",
    "real-time notifications for order updates",
    "role-based access control for an admin panel",
    "an audit log of every write operation",
    "a webhook that retries on failure",
    "a migration from a monolith to services",
    "structured logging with request ids",
    "a health check that verifies dependencies",
    "graceful shutdown that drains connections",
    "connection pooling for a database",
    "idempotent payment processing",
    "soft deletes with a restore window",
    "full-text search over user content",
    "versioned API endpoints",
    "a feature flag system",
    "a scheduled job that is safe to run twice",
]


def build_prompts(count: int, seed: int) -> list[dict[str, str]]:
    """Build ``count`` distinct prompts by combining templates and tasks."""

    rng = random.Random(seed)
    prompts: list[dict[str, str]] = []
    seen: set[str] = set()

    # Full cross product first, so coverage is even across families.
    for family, language, template in SEEDS:
        for task in TASKS:
            # Direct replacement, not str.format: the templates embed
            # code samples whose braces str.format would try to parse.
            prompt = template.replace("{task}", task)
            if prompt in seen:
                continue
            seen.add(prompt)
            prompts.append(
                {"task_family": family, "language": language, "instruction": prompt}
            )

    rng.shuffle(prompts)
    if count < len(prompts):
        prompts = prompts[:count]
    return prompts


SYSTEM_PROMPT = (
    "You are KairoForge, an expert software engineering assistant. "
    "Answer with correct, runnable code and concise reasoning. "
    "Prefer clarity over cleverness. When you show code, use fenced blocks "
    "with a language tag. Do not add disclaimers or filler."
)


def call_teacher(
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    max_tokens: int,
    timeout: float,
) -> tuple[str, str]:
    """Ask the teacher for one completion, returning ``(text, model_id)``."""

    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.4,
    }).encode("utf-8")

    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions", data=body, method="POST"
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {api_key}")

    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))

    choices = payload.get("choices") or []
    text = choices[0].get("message", {}).get("content", "") if choices else ""
    return text, payload.get("model", model)


def call_teacher_with_retry(
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    max_tokens: int,
    timeout: float,
    attempts: int = 5,
) -> tuple[str, str]:
    """Ask the teacher, retrying transient failures with exponential backoff.

    A free gateway throttles aggressively under concurrency: a first attempt to
    generate 600 records with 6 workers lost 507 of them, all to rate limits
    that a retry would have absorbed. Backoff with jitter converts those into
    successes instead of holes in the dataset.
    """

    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return call_teacher(base_url, api_key, model, prompt, max_tokens, timeout)
        except urllib.error.HTTPError as exc:
            last_error = exc
            # 4xx other than 429 will not improve on retry.
            if exc.code not in (408, 425, 429, 500, 502, 503, 504) and exc.code < 500:
                raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc

        # Exponential backoff with jitter, so parallel workers do not retry in
        # lockstep and re-trip the same limit.
        delay = min(2.0 * (2 ** attempt) + random.uniform(0, 1.5), 45.0)
        time.sleep(delay)

    raise last_error if last_error is not None else RuntimeError("teacher call failed")


def main(argv: list[str] | None = None) -> int:
    """Generate a distillation dataset."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("KAIROFORGE_TEACHER_URL", "http://127.0.0.1:31415/v1"))
    parser.add_argument("--api-key-env", default="FREELLMAPI_API_KEY")
    parser.add_argument("--model", default="auto", help="teacher model id")
    parser.add_argument("--count", type=int, default=500)
    parser.add_argument("--out", default=str(ROOT / "data/raw/distill-v0.2.jsonl"))
    parser.add_argument("--max-tokens", type=int, default=1400)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--workers", type=int, default=4, help="parallel requests")
    parser.add_argument("--min-chars", type=int, default=200)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--append", action="store_true", help="append to an existing file")
    args = parser.parse_args(argv)

    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        print(f"error: set {args.api_key_env} to the teacher API key", file=sys.stderr)
        return 2

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Resume support: skip prompts already answered in the output file.
    existing: set[str] = set()
    if args.append and out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    existing.add(json.loads(line)["instruction"])
                except Exception:
                    continue

    prompts = [p for p in build_prompts(args.count * 2, args.seed) if p["instruction"] not in existing]
    prompts = prompts[: args.count]

    print(f"teacher  : {args.model} at {args.base_url}")
    print(f"prompts  : {len(prompts)} to generate ({len(existing)} already done)")
    print(f"output   : {out_path}")
    print()

    mode = "a" if args.append else "w"
    written = 0
    failed = 0
    teacher_ids: dict[str, int] = {}
    started = time.time()

    with out_path.open(mode, encoding="utf-8") as handle, ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(
                call_teacher_with_retry, args.base_url, api_key, args.model,
                item["instruction"], args.max_tokens, args.timeout,
            ): item
            for item in prompts
        }

        for future in as_completed(futures):
            item = futures[future]
            try:
                text, served_by = future.result()
            except Exception as exc:
                failed += 1
                if failed <= 5:
                    print(f"  [fail] {type(exc).__name__}: {str(exc)[:80]}", file=sys.stderr)
                continue

            if len(text.strip()) < args.min_chars:
                failed += 1
                continue

            teacher_ids[served_by] = teacher_ids.get(served_by, 0) + 1
            record = {
                "id": f"distill-{written:06d}",
                "instruction": item["instruction"],
                "response": text.strip(),
                "task_family": item["task_family"],
                "language": item["language"],
                "source": f"distilled:{served_by}",
                "license": "Apache-2.0",
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            written += 1

            if written % 25 == 0:
                rate = written / max(time.time() - started, 1e-9) * 60
                print(f"  {written}/{len(prompts)} written ({rate:.1f}/min)")

    print()
    print(f"wrote {written} records to {out_path}")
    print(f"failed: {failed}")
    if teacher_ids:
        print("served by teacher model(s):")
        for name, n in sorted(teacher_ids.items(), key=lambda kv: -kv[1]):
            print(f"  {n:5d}  {name}")
    print(f"elapsed: {(time.time() - started) / 60:.1f} min")

    if written == 0:
        print("error: no records were generated", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
