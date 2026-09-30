"""Credential detection and redaction for training data.

Training on leaked credentials is the single worst failure mode this pipeline
can have: it bakes a live secret into weights that are then served from a
public cloud endpoint. This module is therefore deliberately conservative -
it prefers dropping an example over keeping a partially redacted one.

Detection is layered:

1. **Structural patterns** for known credential formats (cloud keys, provider
   API keys, private key blocks, tokens). These have very high precision.
2. **Entropy heuristics** for high-entropy strings sitting next to a
   credential-shaped key name, catching formats nobody has catalogued.
3. **Connection-string detection** for URLs carrying inline user:password.

Everything here is pure and dependency-free so it can run inside the cloud
data-prep container without the ML stack.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from enum import Enum


class SecretKind(str, Enum):
    """Categories of detected secret, used for reporting without echoing the value."""

    AWS_ACCESS_KEY = "aws-access-key"
    AWS_SECRET_KEY = "aws-secret-key"
    GITHUB_TOKEN = "github-token"
    GITHUB_PAT = "github-pat"
    OPENAI_KEY = "openai-key"
    ANTHROPIC_KEY = "anthropic-key"
    HUGGINGFACE_TOKEN = "huggingface-token"
    SLACK_TOKEN = "slack-token"
    GOOGLE_API_KEY = "google-api-key"
    STRIPE_KEY = "stripe-key"
    PRIVATE_KEY_BLOCK = "private-key-block"
    JWT = "jwt"
    BASIC_AUTH_URL = "basic-auth-url"
    HIGH_ENTROPY_ASSIGNMENT = "high-entropy-assignment"
    BEARER_TOKEN = "bearer-token"


#: Structural patterns, ordered most-specific first. Each is anchored on a
#: distinctive prefix so false positives stay near zero.
_STRUCTURAL: tuple[tuple[SecretKind, re.Pattern[str]], ...] = (
    (
        SecretKind.PRIVATE_KEY_BLOCK,
        re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"),
    ),
    (SecretKind.AWS_ACCESS_KEY, re.compile(r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b")),
    (
        SecretKind.AWS_SECRET_KEY,
        re.compile(r"(?i)aws_?(?:secret_?access_?key|secret)\s*[=:]\s*[\"']?([A-Za-z0-9/+=]{40})[\"']?"),
    ),
    (SecretKind.GITHUB_PAT, re.compile(r"\bgithub_pat_[A-Za-z0-9_]{60,}\b")),
    (SecretKind.GITHUB_TOKEN, re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    (SecretKind.OPENAI_KEY, re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b")),
    (SecretKind.ANTHROPIC_KEY, re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    (SecretKind.HUGGINGFACE_TOKEN, re.compile(r"\bhf_[A-Za-z0-9]{30,}\b")),
    (SecretKind.SLACK_TOKEN, re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    (SecretKind.GOOGLE_API_KEY, re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    (SecretKind.STRIPE_KEY, re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b")),
    (
        SecretKind.JWT,
        re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    ),
    (
        SecretKind.BASIC_AUTH_URL,
        re.compile(r"://[^/\s:@]{1,64}:[^/\s:@]{6,128}@[A-Za-z0-9.-]+"),
    ),
    (
        SecretKind.BEARER_TOKEN,
        re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*"),
    ),
)

#: Key names that make a nearby high-entropy literal worth suspecting.
_SUSPICIOUS_KEY = re.compile(
    r"(?i)\b(?:api[_-]?key|secret|token|passwd|password|passphrase|credential|"
    r"private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)\b"
)

#: A long run of base64/hex-ish characters, the shape of a raw secret.
_ENTROPY_CANDIDATE = re.compile(r"[A-Za-z0-9+/=_-]{20,}")

#: Sequences that look entropic but are overwhelmingly benign in source code.
_BENIGN_PREFIXES = (
    "sha256-", "sha512-", "sha1-", "md5-",
    "data:image/", "http", "https",
    "0000000000", "aaaaaaaa", "ffffffff",
)


def shannon_entropy(value: str) -> float:
    """Return the Shannon entropy of ``value`` in bits per character.

    Random base64 secrets sit around 4.5-6.0; ordinary identifiers, words and
    repeated padding sit far lower.
    """

    if not value:
        return 0.0
    counts: dict[str, int] = {}
    for char in value:
        counts[char] = counts.get(char, 0) + 1
    length = len(value)
    return -sum(
        (count / length) * math.log2(count / length) for count in counts.values()
    )


@dataclass(frozen=True)
class SecretFinding:
    """One detected credential. The matched text is never stored."""

    kind: SecretKind
    start: int
    end: int
    length: int

    def describe(self) -> str:
        """Report the finding without echoing any part of the secret."""

        return f"{self.kind.value} (chars {self.start}-{self.end}, len={self.length})"


def scan_text(text: str) -> list[SecretFinding]:
    """Return every credential-shaped span in ``text``.

    The result is ordered by position and de-duplicated, so a value matched by
    both a structural pattern and the entropy heuristic is reported once.
    """

    if not text:
        return []

    found: dict[tuple[int, int], SecretFinding] = {}

    for kind, pattern in _STRUCTURAL:
        for match in pattern.finditer(text):
            # A pattern with a capture group points at the secret itself;
            # otherwise the whole match is the secret.
            if match.groups():
                start, end = match.span(1)
            else:
                start, end = match.span()
            found[(start, end)] = SecretFinding(kind, start, end, end - start)

    if _SUSPICIOUS_KEY.search(text):
        for match in _ENTROPY_CANDIDATE.finditer(text):
            value = match.group(0)
            if value.lower().startswith(_BENIGN_PREFIXES):
                continue
            if _covered(found, match.start(), match.end()):
                continue
            # Require real randomness: length alone is not evidence.
            if shannon_entropy(value) >= 4.0:
                found[(match.start(), match.end())] = SecretFinding(
                    SecretKind.HIGH_ENTROPY_ASSIGNMENT,
                    match.start(),
                    match.end(),
                    len(value),
                )

    return [found[key] for key in sorted(found)]


def _covered(found: dict[tuple[int, int], SecretFinding], start: int, end: int) -> bool:
    """True when a structural finding already covers this span."""

    return any(s <= start and end <= e for s, e in found)


def redact_text(text: str, findings: list[SecretFinding] | None = None) -> str:
    """Replace every detected secret with a stable placeholder.

    Used for *reporting* only. The pipeline itself drops whole examples rather
    than training on redacted text, because a partially masked secret still
    teaches the model the surrounding structure.
    """

    findings = findings if findings is not None else scan_text(text)
    if not findings:
        return text
    out: list[str] = []
    cursor = 0
    for finding in findings:
        out.append(text[cursor : finding.start])
        out.append(f"<REDACTED:{finding.kind.value.upper()}>")
        cursor = finding.end
    out.append(text[cursor:])
    return "".join(out)


def contains_secret(text: str) -> bool:
    """Fast predicate for record-level filtering."""

    return bool(scan_text(text))
