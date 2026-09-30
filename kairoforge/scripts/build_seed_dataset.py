#!/usr/bin/env python3
"""Build the KairoForge authored seed dataset.

Writes ``data/raw/kairoforge-seed-v0.1.jsonl`` from the hand-authored records
in ``scripts/seed_chunks.py``.

The records are written by hand, so this script does no generative templating:
it validates each record against the *real* pipeline predicates
(``kairoforge.data.quality`` and ``kairoforge.data.schema``) and only then
emits it. Validation here is a guard rail, not a substitute for the pipeline
run - ``kairoforge dataset prepare`` is still the authority on what survives.

Usage::

    PYTHONPATH=src python3 scripts/build_seed_dataset.py
    PYTHONPATH=src python3 scripts/build_seed_dataset.py --check
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from seed_chunks import CHUNKS  # noqa: E402

from kairoforge.data.pipeline import read_shard  # noqa: E402
from kairoforge.data.quality import (  # noqa: E402
    Deduplicator,
    _has_pathological_repetition,
    _token_diversity,
    check_quality,
)
from kairoforge.data.schema import (  # noqa: E402
    SUPPORTED_LANGUAGES,
    TASK_FAMILIES,
    TrainingRecord,
    license_class_for,
)

SOURCE = "kairoforge-authored-seed"
LICENSE = "Apache-2.0"
OUTPUT = REPO_ROOT / "data" / "raw" / "kairoforge-seed-v0.1.jsonl"

#: Characters that break a JSONL line or look like formatting artefacts.
_FORBIDDEN_IN_TEXT = "\u2028\u2029\u00a0"

REQUIRED_FAMILIES = set(TASK_FAMILIES)
REQUIRED_LANGUAGES = {
    "python",
    "typescript",
    "javascript",
    "rust",
    "go",
    "java",
    "c",
    "cpp",
    "sql",
    "shell",
    "yaml",
    "json",
    "markdown",
    "text",
}


def _normalise(text: str) -> str:
    """Collapse trailing whitespace and reject characters unsafe in JSONL."""

    cleaned = text.replace("\r\n", "\n").strip("\n")
    for char in _FORBIDDEN_IN_TEXT:
        if char in cleaned:
            raise ValueError(f"forbidden character U+{ord(char):04X} in record text")
    return cleaned


def _build_records() -> list[dict]:
    """Flatten chunks into canonical raw records, validating as we go."""

    seen_ids: set[str] = set()
    records: list[dict] = []
    for chunk in CHUNKS:
        for slug, family, language, instruction, response in chunk:
            record_id = f"kf-seed-{slug}"
            if record_id in seen_ids:
                raise ValueError(f"duplicate record id: {record_id}")
            seen_ids.add(record_id)

            if family not in TASK_FAMILIES:
                raise ValueError(f"{record_id}: unknown task family {family!r}")
            if language not in SUPPORTED_LANGUAGES:
                raise ValueError(f"{record_id}: unknown language {language!r}")

            records.append(
                {
                    "id": record_id,
                    "instruction": _normalise(instruction),
                    "response": _normalise(response),
                    "task_family": family,
                    "language": language,
                    "source": SOURCE,
                    "license": LICENSE,
                }
            )
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--check", action="store_true", help="report only, do not write")
    args = parser.parse_args()

    try:
        records = _build_records()
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    problems: list[str] = []
    dedup = Deduplicator(threshold=0.95)
    for raw in records:
        record = TrainingRecord(
            id=raw["id"],
            instruction=raw["instruction"],
            response=raw["response"],
            task_family=raw["task_family"],
            language=raw["language"],
            source=raw["source"],
            license=raw["license"],
            license_class=license_class_for(raw["license"]),
        )
        reason = check_quality(record)
        if reason is not None:
            problems.append(f"{record.id}: quality filter would reject ({reason})")
        if _has_pathological_repetition(record.response):
            problems.append(f"{record.id}: pathological repetition")
        diversity = _token_diversity(record.response)
        if diversity < 0.15:
            problems.append(f"{record.id}: token diversity {diversity:.3f} below 0.15")
        duplicate = dedup.is_duplicate(record)
        if duplicate is not None:
            problems.append(f"{record.id}: {duplicate}")
        for field in ("instruction", "response"):
            for char in raw[field]:
                if unicodedata.category(char) in {"Cc"} and char != "\n":
                    problems.append(f"{record.id}: control character in {field}")
                    break

    families = Counter(raw["task_family"] for raw in records)
    languages = Counter(raw["language"] for raw in records)

    missing_families = sorted(REQUIRED_FAMILIES - set(families))
    missing_languages = sorted(REQUIRED_LANGUAGES - set(languages))
    if missing_families:
        problems.append(f"missing task families: {missing_families}")
    if missing_languages:
        problems.append(f"missing languages: {missing_languages}")

    response_lengths = [len(raw["response"]) for raw in records]
    print(f"records:      {len(records)}")
    print(f"id prefix:    {records[0]['id'].rsplit('-', 1)[0] if records else 'n/a'}")
    print(
        "response len: min={} mean={} max={}".format(
            min(response_lengths),
            round(sum(response_lengths) / len(response_lengths)),
            max(response_lengths),
        )
    )
    print("task families:")
    for family in TASK_FAMILIES:
        print(f"  {family:24s} {families.get(family, 0)}")
    print("languages:")
    for language in sorted(languages):
        print(f"  {language:12s} {languages[language]}")

    if problems:
        print("\nBLOCKING PROBLEMS:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    if args.check:
        print("\ncheck only: no file written")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as handle:
        for raw in records:
            handle.write(json.dumps(raw, ensure_ascii=False) + "\n")

    # Re-read through the pipeline's own loader: this is the check that matters.
    loaded, provenance, stage = read_shard(args.output, source=SOURCE, license=LICENSE)
    print(f"\nwrote {args.output}")
    print(
        f"pipeline read_shard: admitted={stage.admitted} rejected={stage.rejected} "
        f"sha256={provenance.sha256[:16]}... license_class={provenance.license_class.value}"
    )
    if stage.admitted != len(records) or stage.rejected:
        print("error: shard did not round-trip through read_shard", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
