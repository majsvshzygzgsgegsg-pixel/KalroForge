"""Dataset parsing, filtering, and provenance manifest helpers."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
]


@dataclass(frozen=True)
class TrainingExample:
    """One supervised instruction/response pair with provenance fields."""

    id: str
    instruction: str
    response: str
    source: str
    license: str
    language: str


def has_secret(text: str) -> bool:
    """Return true when text contains a known high-risk credential pattern."""

    return any(pattern.search(text) for pattern in SECRET_PATTERNS)


def read_jsonl(path: Path) -> list[dict[str, object]]:
    """Read JSONL records from a UTF-8 file."""

    records: list[dict[str, object]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            loaded = json.loads(stripped)
            if not isinstance(loaded, dict):
                raise ValueError(f"{path}:{line_number} must contain an object")
            records.append(loaded)
    return records


def normalize_record(record: dict[str, object]) -> TrainingExample | None:
    """Validate and normalize one raw record, dropping unsafe examples."""

    required = ["id", "instruction", "response", "source", "license", "language"]
    if not all(isinstance(record.get(key), str) and record.get(key) for key in required):
        return None
    instruction = str(record["instruction"]).strip()
    response = str(record["response"]).strip()
    if len(instruction) < 4 or len(response) < 4:
        return None
    joined = f"{instruction}\n{response}"
    if has_secret(joined):
        return None
    return TrainingExample(
        id=str(record["id"]),
        instruction=instruction,
        response=response,
        source=str(record["source"]),
        license=str(record["license"]),
        language=str(record["language"]).lower(),
    )


def dedupe_examples(examples: Iterable[TrainingExample]) -> list[TrainingExample]:
    """Deduplicate examples by instruction and response text."""

    seen: set[str] = set()
    unique: list[TrainingExample] = []
    for example in examples:
        digest = hashlib.sha256(f"{example.instruction}\n{example.response}".encode("utf-8")).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        unique.append(example)
    return unique


def write_sft_jsonl(examples: Iterable[TrainingExample], path: Path) -> int:
    """Write records in a simple supervised fine-tuning JSONL format."""

    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as handle:
        for example in examples:
            payload = {
                "id": example.id,
                "messages": [
                    {"role": "system", "content": "You are KairoForge, a precise coding model."},
                    {"role": "user", "content": example.instruction},
                    {"role": "assistant", "content": example.response},
                ],
                "metadata": {
                    "source": example.source,
                    "license": example.license,
                    "language": example.language,
                },
            }
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
            count += 1
    return count


def sha256_file(path: Path) -> str:
    """Return the SHA-256 digest for a file."""

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
