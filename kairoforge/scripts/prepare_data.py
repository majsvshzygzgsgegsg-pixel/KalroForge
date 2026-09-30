#!/usr/bin/env python3
"""Prepare licensed JSONL examples for KairoForge supervised fine-tuning."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from kairoforge.dataset import dedupe_examples, normalize_record, read_jsonl, sha256_file, write_sft_jsonl


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    manifest_path = Path(args.manifest)
    raw = read_jsonl(input_path)
    normalized = [example for record in raw if (example := normalize_record(record)) is not None]
    examples = dedupe_examples(normalized)
    count = write_sft_jsonl(examples, output_path)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "input": str(input_path),
        "output": str(output_path),
        "records_in": len(raw),
        "records_out": count,
        "output_sha256": sha256_file(output_path),
        "sources": sorted({example.source for example in examples}),
        "licenses": sorted({example.license for example in examples}),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {count} examples")


if __name__ == "__main__":
    main()
