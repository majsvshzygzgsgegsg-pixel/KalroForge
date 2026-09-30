"""The KairoForge conversation vault.

Every conversation the user has through the harness lands here permanently:
what the user said, what the model said, and which model said it. The vault is
the long-term memory that makes later conversations aware of earlier ones.

Design decisions that matter:

**Append-only, never rewritten.** A conversation log that can be edited is not
evidence. Entries are only added; corrections are new entries.

**Everything is attributed.** Each entry records the model that produced it,
so "which model told me this" is always answerable. Distillation data, live
conversation, and imported history stay distinguishable.

**Style is measured, not guessed.** The vault derives an actual profile of how
the user writes - sentence length, vocabulary, question rate, preferred
phrasing - from real messages. That profile is what later conversations are
primed with. It is a measurement of the user's writing, not a claim about
their personality.

**Nothing is uploaded.** The vault is a local file. The only thing that leaves
this machine is the small derived profile when a conversation starts.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

SCHEMA_VERSION = 1

#: Conversation text is stored in full. This is the vault's whole point, so
#: there is deliberately no truncation of stored content - only of what is
#: injected back into a live prompt, which is bounded separately.
_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'harness',
    model       TEXT NOT NULL DEFAULT '',
    started_at  TEXT NOT NULL,
    cwd         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session);

CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn         INTEGER NOT NULL,
    role         TEXT NOT NULL,
    text         TEXT NOT NULL,
    model        TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    UNIQUE(conversation, turn, role)
);
CREATE INDEX IF NOT EXISTS idx_msg_role ON messages(role);
CREATE INDEX IF NOT EXISTS idx_msg_hash ON messages(content_hash);

CREATE TABLE IF NOT EXISTS facts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    subject    TEXT NOT NULL,
    detail     TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    source     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(kind, subject, detail)
);
CREATE INDEX IF NOT EXISTS idx_fact_subject ON facts(subject);
"""

#: Opening phrases a user repeats become part of their recognised style.
_STOPWORDS = frozenset("""
a an the and or but if then than that this these those it its is are was were be been being
to of in on at for with from by as into about over after before under again further once
i me my we our you your he she they them their what which who whom when where why how
do does did doing have has had having will would can could should shall may might must
not no nor so very just also too only own same such more most other some any each few
""".split())


@dataclass
class VaultMessage:
    """One stored conversation turn."""

    conversation: int
    turn: int
    role: str
    text: str
    model: str
    created_at: str

    def to_json(self) -> dict[str, Any]:
        return {
            "conversation": self.conversation,
            "turn": self.turn,
            "role": self.role,
            "text": self.text,
            "model": self.model,
            "created_at": self.created_at,
        }


@dataclass
class StyleProfile:
    """A measured description of how the user writes.

    Every field is derived from real messages in the vault. The profile exists
    so later conversations can be primed with the user's actual patterns
    instead of a generic instruction to "match the user's tone".
    """

    messages_analysed: int
    avg_words_per_message: float
    avg_sentence_length: float
    question_rate: float
    code_block_rate: float
    top_terms: list[str] = field(default_factory=list)
    common_openers: list[str] = field(default_factory=list)
    formality: str = "neutral"
    directness: str = "neutral"

    def to_json(self) -> dict[str, Any]:
        return {
            "messages_analysed": self.messages_analysed,
            "avg_words_per_message": round(self.avg_words_per_message, 2),
            "avg_sentence_length": round(self.avg_sentence_length, 2),
            "question_rate": round(self.question_rate, 3),
            "code_block_rate": round(self.code_block_rate, 3),
            "top_terms": self.top_terms,
            "common_openers": self.common_openers,
            "formality": self.formality,
            "directness": self.directness,
        }

    def as_prompt(self) -> str:
        """Render the profile as instructions for a live conversation.

        Deliberately short. This is prepended to every request, so it costs
        tokens on each call; it carries only what changes the model's output.
        """

        if self.messages_analysed < 5:
            return ""

        lines = [
            "The user's writing style, measured from their own messages:",
            f"- messages average {self.avg_words_per_message:.0f} words and "
            f"{self.avg_sentence_length:.0f} words per sentence",
        ]
        if self.question_rate > 0.25:
            lines.append("- they often phrase requests as direct questions; answer the question first")
        if self.question_rate < 0.08:
            lines.append("- they mostly give instructions rather than ask questions; act, do not interview them")
        if self.code_block_rate > 0.2:
            lines.append("- they frequently include code; read it carefully before answering")
        if self.top_terms:
            lines.append(f"- recurring topics: {', '.join(self.top_terms[:12])}")
        if self.common_openers:
            lines.append(f"- they often open with: {'; '.join(self.common_openers[:3])}")
        lines.append(
            "- match this register: mirror their level of formality and their "
            "directness rather than defaulting to a generic assistant voice"
        )
        return "\n".join(lines)


class Vault:
    """SQLite-backed permanent conversation store."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(self.path), timeout=30.0)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript(_SCHEMA)
        self._db.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        self._db.commit()

    def close(self) -> None:
        """Close the underlying connection."""

        self._db.close()

    # ------------------------------------------------------------------
    # writing
    # ------------------------------------------------------------------

    def record_conversation(
        self,
        session: str,
        messages: Iterable[dict[str, Any]],
        model: str = "",
        cwd: str = "",
        source: str = "harness",
        started_at: str | None = None,
    ) -> int:
        """Store one conversation and return its id.

        Re-recording the same session is safe: messages are keyed by turn and
        role, so a replayed sync inserts nothing new rather than duplicating
        the whole conversation.
        """

        started_at = started_at or datetime.now(timezone.utc).isoformat()
        cursor = self._db.execute(
            "SELECT id FROM conversations WHERE session = ? ORDER BY id DESC LIMIT 1",
            (session,),
        )
        row = cursor.fetchone()
        if row is None:
            cursor = self._db.execute(
                "INSERT INTO conversations(session, source, model, started_at, cwd) "
                "VALUES (?, ?, ?, ?, ?)",
                (session, source, model, started_at, cwd),
            )
            conversation_id = int(cursor.lastrowid)
        else:
            conversation_id = int(row["id"])

        turn = 0
        for message in messages:
            role = str(message.get("role", "")).strip()
            text = str(message.get("text", "")).strip()
            if role not in {"user", "assistant"} or not text:
                continue
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
            self._db.execute(
                "INSERT OR IGNORE INTO messages"
                "(conversation, turn, role, text, model, created_at, content_hash) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    conversation_id,
                    turn,
                    role,
                    text,
                    str(message.get("model", "") or model),
                    str(message.get("created_at", "") or started_at),
                    digest,
                ),
            )
            turn += 1

        self._db.commit()
        return conversation_id

    def record_exchange(
        self,
        user_text: str,
        assistant_text: str,
        model: str = "",
        session: str | None = None,
    ) -> int:
        """Convenience: store a single user/assistant exchange."""

        session = session or datetime.now(timezone.utc).strftime("live-%Y%m%d%H%M%S")
        return self.record_conversation(
            session=session,
            messages=[
                {"role": "user", "text": user_text},
                {"role": "assistant", "text": assistant_text, "model": model},
            ],
            model=model,
            source="live",
        )

    def remember_fact(
        self,
        kind: str,
        subject: str,
        detail: str,
        confidence: float = 0.5,
        source: str = "",
    ) -> None:
        """Store a durable fact, incrementing its count when already known."""

        self._db.execute(
            "INSERT INTO facts(kind, subject, detail, confidence, source, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(kind, subject, detail) DO UPDATE SET "
            "seen_count = seen_count + 1, "
            "confidence = MAX(confidence, excluded.confidence)",
            (
                kind,
                subject,
                detail,
                float(confidence),
                source,
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        self._db.commit()

    # ------------------------------------------------------------------
    # reading
    # ------------------------------------------------------------------

    def stats(self) -> dict[str, Any]:
        """Counts describing the vault's contents."""

        def one(sql: str) -> int:
            row = self._db.execute(sql).fetchone()
            return int(row[0]) if row else 0

        return {
            "conversations": one("SELECT COUNT(*) FROM conversations"),
            "messages": one("SELECT COUNT(*) FROM messages"),
            "user_messages": one("SELECT COUNT(*) FROM messages WHERE role='user'"),
            "assistant_messages": one("SELECT COUNT(*) FROM messages WHERE role='assistant'"),
            "facts": one("SELECT COUNT(*) FROM facts"),
            "models_seen": one("SELECT COUNT(DISTINCT model) FROM messages WHERE model <> ''"),
            "total_characters": one("SELECT COALESCE(SUM(LENGTH(text)), 0) FROM messages"),
            "path": str(self.path),
        }

    def models_seen(self) -> list[tuple[str, int]]:
        """Which models have contributed, most prolific first."""

        rows = self._db.execute(
            "SELECT model, COUNT(*) AS n FROM messages "
            "WHERE model <> '' GROUP BY model ORDER BY n DESC"
        ).fetchall()
        return [(str(r["model"]), int(r["n"])) for r in rows]

    def recent(self, limit: int = 20) -> list[VaultMessage]:
        """The most recent stored messages."""

        rows = self._db.execute(
            "SELECT * FROM messages ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [self._to_message(row) for row in rows]

    def search(self, query: str, limit: int = 20) -> list[VaultMessage]:
        """Full-text-ish search across stored messages.

        Uses SQLite's LIKE rather than FTS5 so the vault works on any SQLite
        build; the message volume here does not justify an index yet.
        """

        like = f"%{query}%"
        rows = self._db.execute(
            "SELECT * FROM messages WHERE text LIKE ? ORDER BY id DESC LIMIT ?",
            (like, limit),
        ).fetchall()
        return [self._to_message(row) for row in rows]

    def user_messages(self, limit: int | None = None) -> list[str]:
        """Every user message, oldest first - the raw material for style."""

        sql = "SELECT text FROM messages WHERE role='user' ORDER BY id"
        if limit:
            sql += f" LIMIT {int(limit)}"
        return [str(r["text"]) for r in self._db.execute(sql).fetchall()]

    def untrained_messages(self, mark_after: int = 0) -> list[VaultMessage]:
        """Messages beyond a high-water mark, for incremental training."""

        rows = self._db.execute(
            "SELECT * FROM messages WHERE id > ? ORDER BY id", (mark_after,)
        ).fetchall()
        return [self._to_message(row) for row in rows]

    def _to_message(self, row: sqlite3.Row) -> VaultMessage:
        return VaultMessage(
            conversation=int(row["conversation"]),
            turn=int(row["turn"]),
            role=str(row["role"]),
            text=str(row["text"]),
            model=str(row["model"]),
            created_at=str(row["created_at"]),
        )

    # ------------------------------------------------------------------
    # style
    # ------------------------------------------------------------------

    def style_profile(self, sample: int = 2000) -> StyleProfile:
        """Measure how the user writes, from their own real messages.

        The profile feeds every later conversation, so it must reflect what
        the user actually typed - not a template. With too few messages the
        numbers are noise, which is why :meth:`StyleProfile.as_prompt`
        declines to emit anything below a small threshold.
        """

        texts = self.user_messages(limit=sample)
        # Harness-injected context is not the user's own writing, so it is
        # excluded: it would otherwise dominate the averages.
        texts = [
            t for t in texts
            if not t.startswith("<system-reminder>")
            and not t.startswith("Current runtime context")
        ]

        if not texts:
            return StyleProfile(0, 0.0, 0.0, 0.0, 0.0)

        word_counts = []
        sentence_lengths = []
        questions = 0
        code_blocks = 0
        terms: dict[str, int] = {}
        openers: dict[str, int] = {}

        for text in texts:
            words = re.findall(r"[A-Za-z][A-Za-z'-]*", text)
            word_counts.append(len(words))
            if "?" in text:
                questions += 1
            if "```" in text:
                code_blocks += 1

            sentences = [s for s in re.split(r"[.!?\n]+", text) if s.strip()]
            if sentences:
                sentence_lengths.append(
                    statistics.mean(len(re.findall(r"[A-Za-z][A-Za-z'-]*", s)) for s in sentences)
                )

            for word in words:
                low = word.lower()
                if low not in _STOPWORDS and len(low) > 2:
                    terms[low] = terms.get(low, 0) + 1

            first = text.strip().split("\n", 1)[0].strip()
            if 3 < len(first) < 90:
                key = first.lower()[:60]
                openers[key] = openers.get(key, 0) + 1

        top_terms = [w for w, _ in sorted(terms.items(), key=lambda kv: -kv[1])[:25]]
        common_openers = [
            w for w, n in sorted(openers.items(), key=lambda kv: -kv[1])[:5] if n > 1
        ]

        avg_words = statistics.mean(word_counts) if word_counts else 0.0
        avg_sentence = statistics.mean(sentence_lengths) if sentence_lengths else 0.0
        question_rate = questions / len(texts)
        code_rate = code_blocks / len(texts)

        # Coarse descriptors only: these are computed from length and
        # punctuation, and are descriptive of writing, not of the person.
        formality = "terse" if avg_words < 25 else ("detailed" if avg_words > 120 else "neutral")
        directness = "direct" if question_rate < 0.15 else "inquisitive"

        return StyleProfile(
            messages_analysed=len(texts),
            avg_words_per_message=avg_words,
            avg_sentence_length=avg_sentence,
            question_rate=question_rate,
            code_block_rate=code_rate,
            top_terms=top_terms,
            common_openers=common_openers,
            formality=formality,
            directness=directness,
        )

    def context_for_prompt(self, budget_chars: int = 4000) -> str:
        """Build the memory block injected at the start of a conversation.

        Combines the measured style with the most relevant stored facts, and
        is bounded so it cannot crowd out the actual request.
        """

        parts: list[str] = []

        profile = self.style_profile()
        rendered = profile.as_prompt()
        if rendered:
            parts.append(rendered)

        facts = self._db.execute(
            "SELECT kind, subject, detail, confidence FROM facts "
            "ORDER BY confidence DESC, seen_count DESC LIMIT 40"
        ).fetchall()
        if facts:
            lines = ["", "Known context about this user:"]
            for row in facts:
                lines.append(f"- [{row['kind']}] {row['subject']}: {row['detail']}")
            parts.append("\n".join(lines))

        block = "\n".join(parts).strip()
        if len(block) > budget_chars:
            block = block[:budget_chars].rsplit("\n", 1)[0] + "\n..."
        return block


def export_training_pairs(
    vault: Vault, out_path: Path, min_chars: int = 40
) -> int:
    """Export stored conversations as instruction/response training pairs.

    This is the bridge from memory to model: what the user actually asked and
    what the model actually answered become fine-tuning data.

    Filtering matters more here than in the teacher-distillation path, because
    the vault holds *everything* - including harness scaffolding that the user
    never typed and model output that leaked internal reasoning. Training on
    that raw teaches a model to emit system-reminders and fake thinking
    traces, so each pair must pass all of these:

    * the prompt is the user's own words, not injected harness context;
    * the answer contains no leaked chain-of-thought markers;
    * neither side is boilerplate;
    * the pair is long enough to carry information.

    Rejected pairs are counted and reported so the yield is visible rather
    than silently assumed.
    """

    # Harness-injected context. The user never typed any of this.
    _PROMPT_NOISE_PREFIXES = (
        "<system-reminder>",
        "Current runtime context",
        "<skills>",
        "You are an AI agent powered by",
    )
    # Markers some models emit when their reasoning leaks into the response.
    _COT_MARKERS = (
        "internal_thinking",
        "<thinking>",
        "</thinking>",
        "«thinking»",
        "<|channel|>analysis",
    )

    rows = vault._db.execute(
        "SELECT m.conversation, m.turn, m.role, m.text, m.model "
        "FROM messages m ORDER BY m.conversation, m.turn"
    ).fetchall()

    by_conversation: dict[int, list[sqlite3.Row]] = {}
    for row in rows:
        by_conversation.setdefault(int(row["conversation"]), []).append(row)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    rejected: dict[str, int] = {}

    def reject(reason: str) -> None:
        rejected[reason] = rejected.get(reason, 0) + 1

    with out_path.open("w", encoding="utf-8") as handle:
        for conversation_id, messages in by_conversation.items():
            pending_user: str | None = None
            for row in messages:
                if row["role"] == "user":
                    pending_user = str(row["text"])
                    continue
                if row["role"] != "assistant" or not pending_user:
                    continue

                prompt = pending_user
                answer = str(row["text"])
                pending_user = None

                if any(prompt.lstrip().startswith(p) for p in _PROMPT_NOISE_PREFIXES):
                    reject("harness-context")
                    continue
                if any(marker in answer for marker in _COT_MARKERS):
                    reject("leaked-reasoning")
                    continue
                if any(marker in prompt for marker in _COT_MARKERS):
                    reject("leaked-reasoning")
                    continue
                if len(prompt) < min_chars or len(answer) < min_chars:
                    reject("too-short")
                    continue

                record = {
                    "id": f"vault-{conversation_id}-{row['turn']}",
                    "instruction": prompt,
                    "response": answer,
                    "task_family": "instruction-following",
                    "language": "text",
                    "source": f"vault:{row['model'] or 'unknown'}",
                    "license": "Apache-2.0",
                }
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                written += 1

    if rejected:
        summary = ", ".join(f"{k}={v}" for k, v in sorted(rejected.items()))
        # Written beside the data so the yield is auditable after the fact.
        (out_path.with_suffix(".rejected.json")).write_text(
            json.dumps(rejected, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        print(f"  rejected: {summary}")

    return written
