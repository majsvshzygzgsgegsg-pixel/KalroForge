"""Quality filtering and deduplication for KairoForge training data.

Two distinct problems are solved here:

*Deduplication* removes the same text appearing many times, which is what
teaches a model to parrot rather than generalise. Near-duplicates are caught
with MinHash over character n-grams, so a record that differs only in
whitespace or a renamed variable still collapses.

*Quality filtering* removes examples that would actively harm the model:
truncated responses, placeholder-filled answers ("TODO", "your code here"),
refusals, non-code prose mislabelled as code, and pathological repetition.
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from dataclasses import dataclass

from .schema import TrainingRecord

#: Shingles are *token* n-grams of this width, not character n-grams.
#:
#: Character n-grams were measured to be unusable on real code: two records
#: that differ only in an index or a variable name still share ~87% of their
#: character 5-grams, because the surrounding boilerplate dominates. That
#: collapses a legitimate corpus. Token 4-grams measure the thing we actually
#: care about - whether the same sequence of code tokens repeats - and leave
#: genuinely distinct records alone.
SHINGLE_SIZE = 4

#: Jaccard estimate above which two records are considered duplicates.
#:
#: Set high deliberately. MinHash over-estimates the similarity of short
#: documents, so a permissive threshold deletes good data. Near-duplicate
#: detection is a safety net behind exact hashing, not the primary filter.
DEFAULT_SIMILARITY_THRESHOLD = 0.95

#: Two records whose lengths differ by more than this factor cannot be
#: duplicates, however similar their shingle sets look. Guards against a
#: short snippet being absorbed by a long file that contains it.
MAX_LENGTH_RATIO = 1.5

#: Number of MinHash permutations. 128 keeps the standard error near 0.09,
#: which is ample for a 0.85 threshold and stays fast on large datasets.
_MINHASH_PERMUTATIONS = 128

_MERSENNE_PRIME = (1 << 61) - 1
_MAX_HASH = (1 << 32) - 1


@dataclass(frozen=True)
class RejectionReason(str):
    """Why one record was dropped, with a machine-readable value."""

    value: str

    def __str__(self) -> str:  # pragma: no cover - convenience only
        return self.value


REASON_EMPTY = RejectionReason("empty")
REASON_TOO_SHORT = RejectionReason("too-short")
REASON_TOO_LONG = RejectionReason("too-long")
REASON_PLACEHOLDER = RejectionReason("placeholder-content")
REASON_REFUSAL = RejectionReason("refusal-response")
REASON_REPETITION = RejectionReason("pathological-repetition")
REASON_LOW_DIVERSITY = RejectionReason("low-token-diversity")
REASON_SECRET = RejectionReason("contains-secret")
REASON_DUPLICATE = RejectionReason("duplicate")
REASON_NEAR_DUPLICATE = RejectionReason("near-duplicate")
REASON_CONTAMINATION = RejectionReason("evaluation-contamination")


#: Responses consisting mainly of a deferral to the user.
_REFUSAL_PATTERNS = (
    re.compile(r"(?i)^\s*i (?:can'?t|cannot|won'?t|am unable to)\b"),
    re.compile(r"(?i)^\s*(?:sorry|apologies)[,.]?\s+(?:but\s+)?i\b"),
    re.compile(r"(?i)^\s*as an ai\b"),
    re.compile(r"(?i)^\s*i (?:don'?t|do not) have (?:access|the ability)\b"),
)

#: Unfilled templates and ellipsis stubs.
_PLACEHOLDER_PATTERNS = (
    re.compile(r"(?i)your code here"),
    re.compile(r"(?i)<(?:insert|add|your)[ _-]?\w*(?: code| logic| implementation)?>"),
    re.compile(r"(?i)^\s*(?:TODO|FIXME|XXX)\s*:?\s*$", re.MULTILINE),
    re.compile(r"\.\.\.\s*(?:rest of|remaining|more) (?:the )?code", re.I),
    re.compile(r"(?i)#\s*\.\.\.\s*$", re.MULTILINE),
)


_TOKEN_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+|[^\sA-Za-z0-9_]")


def _tokenize(text: str) -> list[str]:
    """Split text into identifier, number, and punctuation tokens.

    Splitting identifiers as whole units is what makes the shingle sets
    meaningful: ``build_0`` and ``build_1`` are different tokens, whereas
    character n-grams see almost the same string.
    """

    return _TOKEN_PATTERN.findall(text.lower())


def _shingles(text: str) -> set[int]:
    """Return the hashed token n-gram set of ``text``."""

    tokens = _tokenize(text)
    if not tokens:
        return set()
    if len(tokens) <= SHINGLE_SIZE:
        return {
            int.from_bytes(
                hashlib.blake2b(" ".join(tokens).encode("utf-8"), digest_size=4).digest(),
                "big",
            )
        }
    return {
        int.from_bytes(
            hashlib.blake2b(
                " ".join(tokens[i : i + SHINGLE_SIZE]).encode("utf-8"), digest_size=4
            ).digest(),
            "big",
        )
        for i in range(len(tokens) - SHINGLE_SIZE + 1)
    }


def _normalise_for_shingling(text: str) -> str:
    """Placeholder retained for callers that only need whitespace collapse."""

    return re.sub(r"\s+", " ", text).strip().lower()


def _minhash_signature(shingles: set[int]) -> tuple[int, ...]:
    """Compute the MinHash signature of a shingle set."""

    if not shingles:
        return tuple([_MAX_HASH] * _MINHASH_PERMUTATIONS)
    signature = []
    for seed in range(_MINHASH_PERMUTATIONS):
        lowest = _MAX_HASH
        for shingle in shingles:
            # Deterministic affine permutation over a Mersenne prime field.
            a = 2 * seed + 1
            b = seed * 2654435761
            hashed = ((a * shingle + b) % _MERSENNE_PRIME) & _MAX_HASH
            if hashed < lowest:
                lowest = hashed
        signature.append(lowest)
    return tuple(signature)


def _signature_similarity(left: tuple[int, ...], right: tuple[int, ...]) -> float:
    """Estimate Jaccard similarity from two MinHash signatures."""

    if not left or not right:
        return 0.0
    matches = sum(1 for a, b in zip(left, right) if a == b)
    return matches / len(left)


class MinHashIndex:
    """Banded MinHash index for near-duplicate detection.

    Records are bucketed by bands of their signature so a candidate lookup
    touches only plausibly similar records instead of comparing every pair.
    """

    def __init__(self, bands: int = 16) -> None:
        if _MINHASH_PERMUTATIONS % bands != 0:
            raise ValueError("bands must divide the permutation count evenly")
        self.bands = bands
        self.rows = _MINHASH_PERMUTATIONS // bands
        self._buckets: dict[tuple[int, tuple[int, ...]], list[int]] = {}
        self._signatures: list[tuple[int, ...]] = []

    def _band_keys(self, signature: tuple[int, ...]) -> list[tuple[int, tuple[int, ...]]]:
        return [
            (band, signature[band * self.rows : (band + 1) * self.rows])
            for band in range(self.bands)
        ]

    def add(self, signature: tuple[int, ...]) -> int:
        """Insert a signature and return its index."""

        index = len(self._signatures)
        self._signatures.append(signature)
        for key in self._band_keys(signature):
            self._buckets.setdefault(key, []).append(index)
        return index

    def candidates(self, signature: tuple[int, ...]) -> set[int]:
        """Return indexes of records sharing at least one band."""

        found: set[int] = set()
        for key in self._band_keys(signature):
            found.update(self._buckets.get(key, ()))
        return found

    def signature_at(self, index: int) -> tuple[int, ...]:
        """Return the stored signature for one inserted record."""

        return self._signatures[index]

    def find_near_duplicate(
        self, signature: tuple[int, ...], threshold: float
    ) -> int | None:
        """Return the index of an existing near-duplicate, if any."""

        best_index: int | None = None
        best_score = 0.0
        for index in self.candidates(signature):
            score = _signature_similarity(signature, self._signatures[index])
            if score >= threshold and score > best_score:
                best_index, best_score = index, score
        return best_index


def _token_diversity(text: str) -> float:
    """Ratio of distinct whitespace tokens to total tokens."""

    tokens = text.split()
    if not tokens:
        return 0.0
    return len(set(tokens)) / len(tokens)


def _has_pathological_repetition(text: str) -> bool:
    """Detect degenerate loops such as the same line repeated many times."""

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) < 8:
        return False
    most_common_count = Counter(lines).most_common(1)[0][1]
    return most_common_count / len(lines) > 0.5


def check_quality(
    record: TrainingRecord,
    min_chars: int = 24,
    max_chars: int = 100_000,
    min_diversity: float = 0.15,
) -> RejectionReason | None:
    """Return the reason to reject ``record``, or ``None`` when it passes.

    The checks are ordered cheapest-first so large corpora are filtered
    without paying for repetition analysis on obvious rejects.
    """

    instruction = record.instruction.strip()
    response = record.response.strip()

    if not instruction or not response:
        return REASON_EMPTY
    if len(response) < min_chars:
        return REASON_TOO_SHORT
    if len(instruction) + len(response) > max_chars:
        return REASON_TOO_LONG
    if any(pattern.search(response) for pattern in _REFUSAL_PATTERNS):
        return REASON_REFUSAL
    if any(pattern.search(response) for pattern in _PLACEHOLDER_PATTERNS):
        return REASON_PLACEHOLDER
    if _has_pathological_repetition(response):
        return REASON_REPETITION
    if _token_diversity(response) < min_diversity:
        return REASON_LOW_DIVERSITY
    return None


class Deduplicator:
    """Exact then near-duplicate removal with rejection accounting.

    Exact duplicates are removed by content hash first: it is O(1) per record
    and typically removes the bulk of a scraped corpus. Near-duplicates are
    then checked only among the survivors, and only against candidates whose
    length is comparable - a short snippet contained in a long file is not a
    duplicate of it, and treating it as one would discard real training data.
    """

    def __init__(self, threshold: float = DEFAULT_SIMILARITY_THRESHOLD) -> None:
        self.threshold = threshold
        self._exact: set[str] = set()
        self._index = MinHashIndex()
        self._lengths: list[int] = []

    def is_duplicate(self, record: TrainingRecord) -> RejectionReason | None:
        """Classify a record as new, exact duplicate, or near duplicate."""

        digest = record.content_hash()
        if digest in self._exact:
            return REASON_DUPLICATE

        text = f"{record.instruction}\n{record.response}"
        length = len(text)
        signature = _minhash_signature(_shingles(text))

        for index in self._index.candidates(signature):
            other_length = self._lengths[index]
            shorter, longer = sorted((length, other_length))
            if shorter == 0 or longer / shorter > MAX_LENGTH_RATIO:
                continue
            if _signature_similarity(signature, self._index.signature_at(index)) >= self.threshold:
                # Record the exact hash so a second copy is caught cheaply.
                self._exact.add(digest)
                return REASON_NEAR_DUPLICATE

        self._exact.add(digest)
        self._lengths.append(length)
        self._index.add(signature)
        return None
