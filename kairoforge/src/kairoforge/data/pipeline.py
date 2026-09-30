"""The KairoForge data pipeline: raw records in, versioned dataset out.

Stages, in order:

1. **Ingest** - read JSONL shards and map each to a canonical record.
2. **Validate** - schema, task family, language, and provenance checks.
3. **Secret scan** - drop any record carrying a credential.
4. **Quality filter** - drop truncated, placeholder, refusal, degenerate text.
5. **Deduplicate** - exact then near-duplicate removal.
6. **Contamination check** - drop records resembling held-out evaluation data.
7. **Split** - stratified train/validation/test partition.
8. **Manifest** - write dataset version, counts, hashes, and provenance.

Every stage records how many records it dropped and why, and that accounting
lands in the manifest. That is what makes "we trained on N tokens" auditable
rather than asserted.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

from .quality import (
    REASON_CONTAMINATION,
    REASON_DUPLICATE,
    REASON_SECRET,
    Deduplicator,
    RejectionReason,
    check_quality,
)
from .schema import (
    SUPPORTED_LANGUAGES,
    TASK_FAMILIES,
    LicenseClass,
    Split,
    TrainingRecord,
    coverage,
    dataset_hash,
    license_class_for,
)
from .secrets import scan_text


class PipelineError(RuntimeError):
    """Raised when the pipeline cannot proceed, e.g. an unlicensed shard."""


@dataclass
class StageReport:
    """How many records one stage admitted and rejected, and why."""

    name: str
    admitted: int = 0
    rejected: int = 0
    reasons: dict[str, int] = field(default_factory=dict)

    def reject(self, reason: RejectionReason) -> None:
        """Record one rejection under ``reason``."""

        self.rejected += 1
        key = reason.value
        self.reasons[key] = self.reasons.get(key, 0) + 1

    def to_json(self) -> dict[str, Any]:
        """Serialise for the manifest."""

        return {
            "stage": self.name,
            "admitted": self.admitted,
            "rejected": self.rejected,
            "reasons": dict(sorted(self.reasons.items())),
        }


@dataclass
class ShardProvenance:
    """Where one input shard came from and under what terms."""

    path: str
    source: str
    license: str
    license_class: LicenseClass
    sha256: str
    record_count: int

    def to_json(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "source": self.source,
            "license": self.license,
            "license_class": self.license_class.value,
            "sha256": self.sha256,
            "record_count": self.record_count,
        }


@dataclass
class DatasetManifest:
    """The versioned description of a processed dataset."""

    dataset_version: str
    dataset_hash: str
    created_at: str
    pipeline_version: str
    total_records: int
    total_characters: int
    estimated_tokens: int
    splits: dict[str, int]
    coverage: dict[str, dict[str, int]]
    stages: list[StageReport]
    shards: list[ShardProvenance]
    held_out_used: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        """Serialise the manifest, dropping empty rejection maps for readability."""

        return {
            "dataset_version": self.dataset_version,
            "dataset_hash": self.dataset_hash,
            "created_at": self.created_at,
            "pipeline_version": self.pipeline_version,
            "total_records": self.total_records,
            "total_characters": self.total_characters,
            "estimated_tokens": self.estimated_tokens,
            "splits": self.splits,
            "coverage": self.coverage,
            "stages": [stage.to_json() for stage in self.stages],
            "shards": [shard.to_json() for shard in self.shards],
            "held_out_used": self.held_out_used,
        }


#: Bumped whenever the pipeline's behaviour changes, so a manifest records
#: which generation of the code produced it.
PIPELINE_VERSION = "0.2.0"

#: Rough chars-per-token ratio used for cost estimation only. The trainer
#: reports the true token count from the tokenizer; this figure exists so a
#: cost estimate can be produced before any model is downloaded.
CHARS_PER_TOKEN_ESTIMATE = 3.6


def _sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read_shard(
    path: Path,
    source: str | None = None,
    license: str | None = None,
) -> tuple[list[TrainingRecord], ShardProvenance, StageReport]:
    """Read one JSONL shard into canonical records.

    The shard's own records may carry ``source``/``license``; explicit
    arguments override them, which is how a shard downloaded under a known
    repository licence is stamped consistently.
    """

    if not path.exists():
        raise PipelineError(f"shard not found: {path}")

    stage = StageReport(name=f"ingest:{path.name}")
    records: list[TrainingRecord] = []
    declared_license = license
    declared_source = source

    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                raw = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise PipelineError(f"{path}:{line_number} invalid JSON: {exc}") from exc
            if not isinstance(raw, Mapping):
                raise PipelineError(f"{path}:{line_number} must be a JSON object")

            record = _to_record(raw, path, line_number, declared_source, declared_license)
            if record is None:
                stage.reject(RejectionReason("invalid-record"))
                continue
            records.append(record)
            stage.admitted += 1

    if declared_license is None and records:
        declared_license = records[0].license
    if declared_source is None and records:
        declared_source = records[0].source

    license_class = license_class_for(declared_license or "")
    if records and not license_class.trainable:
        raise PipelineError(
            f"{path}: licence {declared_license!r} classified as "
            f"{license_class.value}, which does not permit fine-tuning. "
            "Refusing to ingest this shard."
        )

    provenance = ShardProvenance(
        path=str(path),
        source=declared_source or "unknown",
        license=declared_license or "unknown",
        license_class=license_class,
        sha256=_sha256_file(path),
        record_count=len(records),
    )
    return records, provenance, stage


def _to_record(
    raw: Mapping[str, Any],
    path: Path,
    line_number: int,
    source: str | None,
    license: str | None,
) -> TrainingRecord | None:
    """Map one raw JSON object to a record, or ``None`` when unusable."""

    instruction = raw.get("instruction") or raw.get("prompt")
    response = raw.get("response") or raw.get("completion") or raw.get("output")

    # A record may already be in conversation form.
    messages = raw.get("messages")
    if (not instruction or not response) and isinstance(messages, list):
        derived = _from_messages(messages)
        if derived is not None:
            instruction, response = derived

    if not isinstance(instruction, str) or not isinstance(response, str):
        return None
    if not instruction.strip() or not response.strip():
        return None

    license_name = str(raw.get("license") or license or "unknown")
    license_cls = license_class_for(license_name)
    if not license_cls.trainable:
        return None

    task_family = str(raw.get("task_family") or raw.get("task") or "code-generation")
    if task_family not in TASK_FAMILIES:
        task_family = "code-generation"

    language = str(raw.get("language") or "text").lower()
    if language not in SUPPORTED_LANGUAGES:
        language = "text"

    record_id = str(raw.get("id") or f"{path.stem}:{line_number}")

    try:
        return TrainingRecord(
            id=record_id,
            instruction=instruction,
            response=response,
            task_family=task_family,
            language=language,
            source=str(raw.get("source") or source or "unknown"),
            license=license_name,
            license_class=license_cls,
            messages=list(messages) if isinstance(messages, list) else [],
            metadata=dict(raw.get("metadata") or {}),
        )
    except ValueError:
        return None


def _from_messages(messages: Sequence[Any]) -> tuple[str, str] | None:
    """Derive instruction/response from a chat-message list."""

    user_parts: list[str] = []
    assistant_parts: list[str] = []
    for message in messages:
        if not isinstance(message, Mapping):
            continue
        role = message.get("role")
        content = message.get("content")
        if not isinstance(content, str):
            continue
        if role == "user":
            user_parts.append(content)
        elif role == "assistant":
            assistant_parts.append(content)
    if not user_parts or not assistant_parts:
        return None
    return "\n".join(user_parts), "\n".join(assistant_parts)


class ContaminationChecker:
    """Detects training records that resemble held-out evaluation items.

    Evaluation is only meaningful if the model has not seen the answers. This
    uses the same shingling as deduplication, so it catches paraphrase-level
    leakage rather than only exact copies.
    """

    def __init__(self, held_out: Iterable[TrainingRecord]) -> None:
        from .quality import _minhash_signature, _shingles

        self._minhash_signature = _minhash_signature
        self._shingles = _shingles
        self._signatures = [
            (record.id, _minhash_signature(_shingles(f"{record.instruction}\n{record.response}")))
            for record in held_out
        ]

    def is_contaminated(self, record: TrainingRecord, threshold: float = 0.7) -> bool:
        """True when ``record`` closely resembles any held-out item."""

        from .quality import _signature_similarity

        if not self._signatures:
            return False
        signature = self._minhash_signature(
            self._shingles(f"{record.instruction}\n{record.response}")
        )
        return any(
            _signature_similarity(signature, held) >= threshold
            for _, held in self._signatures
        )


def process(
    shards: Sequence[Path],
    output_dir: Path,
    dataset_version: str,
    held_out: Sequence[TrainingRecord] = (),
    validation_fraction: float = 0.05,
    test_fraction: float = 0.05,
    seed: int = 1337,
    similarity_threshold: float = 0.85,
    source_override: str | None = None,
    license_override: str | None = None,
    max_records: int | None = None,
) -> DatasetManifest:
    """Run the full pipeline and write the processed dataset plus manifest.

    Splitting is stratified: validation and test are sampled proportionally
    from every task family so a rare family is represented in evaluation
    instead of vanishing into the training split.
    """

    output_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)

    ingest_stage = StageReport(name="ingest")
    all_records: list[TrainingRecord] = []
    provenance: list[ShardProvenance] = []

    for shard in shards:
        records, shard_provenance, stage = read_shard(
            shard, source=source_override, license=license_override
        )
        all_records.extend(records)
        provenance.append(shard_provenance)
        ingest_stage.admitted += stage.admitted
        ingest_stage.rejected += stage.rejected
        for key, count in stage.reasons.items():
            ingest_stage.reasons[key] = ingest_stage.reasons.get(key, 0) + count

    if max_records is not None and len(all_records) > max_records:
        rng.shuffle(all_records)
        all_records = all_records[:max_records]

    secret_stage = StageReport(name="secret-scan")
    quality_stage = StageReport(name="quality-filter")

    survivors: list[TrainingRecord] = []
    for record in all_records:
        if _record_has_secret(record):
            secret_stage.reject(REASON_SECRET)
            continue
        secret_stage.admitted += 1

        reason = check_quality(record)
        if reason is not None:
            quality_stage.reject(reason)
            continue
        quality_stage.admitted += 1
        survivors.append(record)

    dedup_stage = StageReport(name="deduplicate")
    dedup = Deduplicator(threshold=similarity_threshold)
    unique: list[TrainingRecord] = []
    for record in survivors:
        reason = dedup.is_duplicate(record)
        if reason is not None:
            dedup_stage.reject(reason)
            continue
        dedup_stage.admitted += 1
        unique.append(record)

    contamination_stage = StageReport(name="contamination-check")
    checker = ContaminationChecker(held_out)
    clean: list[TrainingRecord] = []
    for record in unique:
        if checker.is_contaminated(record):
            contamination_stage.reject(REASON_CONTAMINATION)
            continue
        contamination_stage.admitted += 1
        clean.append(record)

    splits = stratified_split(
        clean, validation_fraction=validation_fraction, test_fraction=test_fraction, rng=rng
    )

    split_stage = StageReport(name="split")
    split_stage.admitted = len(clean)

    for split_name, records in splits.items():
        _write_jsonl(output_dir / f"{split_name}.jsonl", records)

    total_characters = sum(len(r.instruction) + len(r.response) for r in clean)
    manifest = DatasetManifest(
        dataset_version=dataset_version,
        dataset_hash=dataset_hash(clean),
        created_at=datetime.now(timezone.utc).isoformat(),
        pipeline_version=PIPELINE_VERSION,
        total_records=len(clean),
        total_characters=total_characters,
        estimated_tokens=int(total_characters / CHARS_PER_TOKEN_ESTIMATE),
        splits={name: len(records) for name, records in splits.items()},
        coverage=coverage(clean),
        stages=[
            ingest_stage,
            secret_stage,
            quality_stage,
            dedup_stage,
            contamination_stage,
            split_stage,
        ],
        shards=provenance,
        held_out_used=[record.id for record in held_out],
    )

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest.to_json(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest


def _record_has_secret(record: TrainingRecord) -> bool:
    """True when any part of the record carries a credential."""

    return bool(
        scan_text(record.instruction)
        or scan_text(record.response)
        or any(
            scan_text(message.get("content", "")) for message in record.as_conversation()
        )
    )


def stratified_split(
    records: Sequence[TrainingRecord],
    validation_fraction: float,
    test_fraction: float,
    rng: random.Random,
) -> dict[str, list[TrainingRecord]]:
    """Partition records per task family, then reassemble the splits.

    Every family with at least three records contributes at least one
    validation and one test record, so evaluation covers the whole task
    surface rather than the most common family.
    """

    if validation_fraction < 0 or test_fraction < 0:
        raise ValueError("split fractions must be non-negative")
    if validation_fraction + test_fraction >= 1:
        raise ValueError("validation + test fractions must leave a training split")

    by_family: dict[str, list[TrainingRecord]] = {}
    for record in records:
        by_family.setdefault(record.task_family, []).append(record)

    splits: dict[str, list[TrainingRecord]] = {
        Split.TRAIN.value: [],
        Split.VALIDATION.value: [],
        Split.TEST.value: [],
    }

    for family_records in by_family.values():
        shuffled = list(family_records)
        rng.shuffle(shuffled)
        count = len(shuffled)

        if count < 3:
            # Too small to stratify: keep it whole in training so the data is
            # not wasted, and let other families supply evaluation coverage.
            splits[Split.TRAIN.value].extend(shuffled)
            continue

        n_test = max(1, int(round(count * test_fraction)))
        n_validation = max(1, int(round(count * validation_fraction)))
        # Guarantee a non-empty training portion for every family.
        while n_test + n_validation >= count:
            if n_test >= n_validation and n_test > 1:
                n_test -= 1
            elif n_validation > 1:
                n_validation -= 1
            else:
                break

        splits[Split.TEST.value].extend(shuffled[:n_test])
        splits[Split.VALIDATION.value].extend(
            shuffled[n_test : n_test + n_validation]
        )
        splits[Split.TRAIN.value].extend(shuffled[n_test + n_validation :])

    for records_in_split in splits.values():
        records_in_split.sort(key=lambda record: record.id)

    return splits


def _write_jsonl(path: Path, records: Sequence[TrainingRecord]) -> None:
    """Write records as JSONL, one canonical object per line."""

    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record.to_json(), ensure_ascii=False) + "\n")


def load_jsonl(path: Path) -> Iterator[TrainingRecord]:
    """Iterate the canonical records in a processed JSONL file."""

    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            yield TrainingRecord.from_json(json.loads(stripped))
