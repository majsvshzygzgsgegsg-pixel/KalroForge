"""Canonical training-record schema and provenance model.

Every record that reaches the trainer carries full provenance: where it came
from, under what licence, and which pipeline stage last touched it. The
manifest emitted alongside a processed dataset is what the model registry
stores as ``dataset_version``, so a checkpoint can always be traced back to
the exact bytes that produced it.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping

#: Languages KairoForge specialises in. Kept as a closed set so the pipeline
#: can report coverage per language and the evaluator can stratify by it.
SUPPORTED_LANGUAGES: tuple[str, ...] = (
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
)

#: Task families KairoForge is trained to perform. Used for stratified
#: train/val/test splitting and for evaluation coverage reporting.
TASK_FAMILIES: tuple[str, ...] = (
    "code-generation",
    "debugging",
    "refactoring",
    "code-explanation",
    "test-generation",
    "repository-understanding",
    "multi-file-editing",
    "terminal-reasoning",
    "git-workflow",
    "api-design",
    "frontend",
    "backend",
    "agentic-coding",
    "tool-planning",
    "instruction-following",
)


class Split(str, Enum):
    """Which partition a record was assigned to."""

    TRAIN = "train"
    VALIDATION = "validation"
    TEST = "test"


class LicenseClass(str, Enum):
    """Coarse licence classification driving ingestion policy.

    Only ``PERMISSIVE`` and ``COPYLEFT_OK`` datasets may enter training. The
    split exists because weak-copyleft and permissive licences both permit
    fine-tuning; share-alike and unknown terms do not, and are refused.
    """

    PERMISSIVE = "permissive"
    COPYLEFT_OK = "copyleft-ok"
    SHARE_ALIKE = "share-alike"
    PROPRIETARY = "proprietary"
    UNKNOWN = "unknown"

    @property
    def trainable(self) -> bool:
        """Whether records under this licence class may be trained on."""

        return self in {LicenseClass.PERMISSIVE, LicenseClass.COPYLEFT_OK}


@dataclass
class TrainingRecord:
    """One supervised instruction/response example in canonical form.

    ``messages`` is the conversation actually rendered into the tokenizer
    chat template. ``instruction``/``response`` are retained alongside it for
    validation and reporting so a malformed conversation is still diagnosable.
    """

    id: str
    instruction: str
    response: str
    task_family: str
    language: str
    source: str
    license: str
    license_class: LicenseClass
    messages: list[dict[str, str]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.id:
            raise ValueError("record id must be non-empty")
        if not self.instruction.strip() or not self.response.strip():
            raise ValueError(f"record {self.id}: instruction and response must be non-empty")
        if self.task_family not in TASK_FAMILIES:
            raise ValueError(
                f"record {self.id}: unknown task_family {self.task_family!r}; "
                f"expected one of {', '.join(TASK_FAMILIES)}"
            )
        if self.language not in SUPPORTED_LANGUAGES:
            raise ValueError(
                f"record {self.id}: unknown language {self.language!r}; "
                f"expected one of {', '.join(SUPPORTED_LANGUAGES)}"
            )
        if not isinstance(self.license_class, LicenseClass):
            self.license_class = LicenseClass(self.license_class)
        if self.license_class is LicenseClass.UNKNOWN:
            raise ValueError(
                f"record {self.id}: licence {self.license!r} was not classified; "
                "refusing to train on records of unknown licence"
            )

    def as_conversation(self) -> list[dict[str, str]]:
        """Return the chat-message list used for training.

        If ``messages`` was populated by ingestion it is authoritative;
        otherwise the canonical two-turn form is derived.
        """

        if self.messages:
            return self.messages
        return [
            {"role": "user", "content": self.instruction},
            {"role": "assistant", "content": self.response},
        ]

    def content_hash(self) -> str:
        """Stable content hash used for deduplication.

        Deliberately excludes ``id``, ``source`` and ``license`` so the same
        text arriving from two sources deduplicates to one record.
        """

        payload = json.dumps(
            {
                "instruction": self.instruction,
                "response": self.response,
                "messages": self.as_conversation(),
            },
            sort_keys=True,
            ensure_ascii=False,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def to_json(self) -> dict[str, Any]:
        """Serialise to a JSONL-ready dict with the enum flattened to a string."""

        data = asdict(self)
        data["license_class"] = self.license_class.value
        return data

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> "TrainingRecord":
        """Rebuild a record from its JSONL form."""

        payload = dict(data)
        payload["license_class"] = LicenseClass(payload.get("license_class", "unknown"))
        payload.setdefault("messages", [])
        payload.setdefault("metadata", {})
        return cls(**payload)  # type: ignore[arg-type]


def license_class_for(license_name: str) -> LicenseClass:
    """Classify a licence string into a :class:`LicenseClass`.

    Matching is substring-based on a normalised form so that SPDX ids,
    human-readable names, and licence file headers all resolve consistently.
    Anything unrecognised is ``UNKNOWN``, which the pipeline refuses to train on.
    """

    normalised = license_name.strip().lower().replace("_", "-")
    if not normalised:
        return LicenseClass.UNKNOWN

    if any(token in normalised for token in ("apache-2.0", "apache 2.0", "apache license", "mit", "bsd-3", "bsd-2", "isc", "unlicense", "cc0", "public-domain", "odc-by")):
        return LicenseClass.PERMISSIVE
    if any(token in normalised for token in ("mpl-2.0", "mozilla public", "lgpl", "eclipse public", "epl-")):
        return LicenseClass.COPYLEFT_OK
    if any(token in normalised for token in ("gpl-3", "gpl-2", "agpl", "cc-by-sa", "share-alike", "sharealike")):
        return LicenseClass.SHARE_ALIKE
    if any(token in normalised for token in ("proprietary", "all rights reserved", "confidential", "no-license")):
        return LicenseClass.PROPRIETARY
    return LicenseClass.UNKNOWN


def dataset_hash(records: Iterable[TrainingRecord]) -> str:
    """Order-independent hash of a record collection.

    Sorting the per-record hashes makes the digest stable under shuffling, so
    the same dataset processed twice yields the same ``dataset_version``.
    """

    digests = sorted(record.content_hash() for record in records)
    combined = hashlib.sha256()
    for digest in digests:
        combined.update(digest.encode("ascii"))
    return combined.hexdigest()


def coverage(records: Iterable[TrainingRecord]) -> dict[str, dict[str, int]]:
    """Count records per task family and per language for manifest reporting."""

    by_family: dict[str, int] = {}
    by_language: dict[str, int] = {}
    for record in records:
        by_family[record.task_family] = by_family.get(record.task_family, 0) + 1
        by_language[record.language] = by_language.get(record.language, 0) + 1
    return {"task_family": by_family, "language": by_language}
