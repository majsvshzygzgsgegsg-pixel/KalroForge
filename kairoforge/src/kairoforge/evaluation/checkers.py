"""Response checkers used by the KairoForge evaluation harness.

Five checkers decide whether a model response satisfies an
:class:`~kairoforge.evaluation.tasks.EvalTask`:

``exact``
    Normalised string equality (whitespace collapsed, optional case folding).
``contains``
    One or more required substrings are present.
``regex``
    A regular expression matches the response.
``python-exec``
    Python is extracted from the response and executed in a **subprocess**.
``rubric``
    A list of required fragments; the score is the fraction present.

Each checker returns a :class:`CheckResult`. Scoring is deliberately graded
rather than binary where the checker can measure partial credit (``rubric``
returns the fraction of fragments found, ``contains`` returns the fraction of
required fragments found in ``any_of`` mode), so a report can distinguish
"nearly right" from "no answer".

Honest isolation limits
-----------------------

``python-exec`` is the only checker that runs model-authored code, and its
guarantees are **process-level only**:

* The code runs in a *separate* ``sys.executable`` subprocess with
  ``shell=False`` (never a shell string), through ``subprocess.run``.
* A hard wall-clock timeout (``timeout_seconds``, default 10s) is enforced by
  the parent. On expiry the child is killed and the check fails.
* POSIX resource limits are applied in a ``preexec_fn`` before ``exec``:
  ``RLIMIT_CPU`` (CPU seconds), ``RLIMIT_AS`` (address space), ``RLIMIT_FSIZE``
  (file size), ``RLIMIT_NPROC`` (process count) and ``RLIMIT_CORE`` (no core
  dumps). ``RLIMIT_NOFILE`` is left alone because the interpreter needs its
  inherited descriptors.
* The child runs with ``cwd`` set to a fresh empty temporary directory, with
  ``sys.path`` reduced to that directory (the harness itself is not
  importable), and with the network-related environment variables
  (``http_proxy``, ``https_proxy``, ``no_proxy``, along with the uppercase
  spellings) pointed at an unroutable address. ``HOME``, ``TMPDIR`` and
  ``XDG_CACHE_HOME`` are also redirected into that temporary directory.

**What this does not do.** This is not a security sandbox. It does not use
namespaces, seccomp, containers, or a separate user. Model-authored code can
still read any world-readable file on the host, write outside the temporary
directory if permissions allow, open sockets directly (the proxy variables only
influence libraries that honour them, such as ``requests``), call ``os.fork``
within the process-count limit, and consume the child's CPU and memory budget.
It defends against *accidents* - infinite loops, runaway allocation, filling
the disk, accidental writes into the repository - not against an adversary who
is specifically trying to escape. Do not evaluate untrusted third-party models
with it. For that, run the whole harness inside a container or VM, which is the
only isolation boundary this checker does not attempt to replace.

The timeout is the property the test suite pins: an infinite loop must be
killed rather than hanging the harness.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Sequence

__all__ = [
    "CheckResult",
    "CheckerError",
    "UnknownCheckerError",
    "check_exact",
    "check_contains",
    "check_regex",
    "check_python_exec",
    "check_rubric",
    "check_response",
    "CHECKS",
    "extract_python_code",
]

#: Default wall-clock budget for ``python-exec``. Kept short: an evaluation
#: item that needs longer than this is not measuring the model's coding skill.
DEFAULT_EXEC_TIMEOUT_SECONDS = 10.0

#: Default address-space cap for ``python-exec`` children, in bytes (768 MiB).
DEFAULT_EXEC_MEMORY_BYTES = 768 * 1024 * 1024

#: Default CPU-seconds cap for ``python-exec`` children.
DEFAULT_EXEC_CPU_SECONDS = 8

#: Default cap on processes/threads the child may create.
DEFAULT_EXEC_MAX_PROCS = 32

#: Applied when ``checker_args["truncate_exec_output"]`` is true (default).
_MAX_OBSERVED_OUTPUT_CHARS = 2000

_FENCED_BLOCK = re.compile(r"```[ \t]*(?P<lang>[A-Za-z0-9_+-]*)[ \t]*\n(?P<body>.*?)(?:```|\Z)", re.DOTALL)
_FENCED_ANY = re.compile(r"```.*?```", re.DOTALL)
_DIRECTIVE_LINE = re.compile(r"^[ \t]*(?:#|\/\/)[ \t]*eval:[ \t]*(?P<mode>[a-z-]+)[ \t]*$", re.IGNORECASE)
_PROMPT_ECHO_PREFIXES = ("assistant:", "answer:", "response:", "output:", "result:", "a:")
_CONVERSATIONAL_PREFIXES = (
    "sure,", "sure!", "certainly,", "certainly!", "of course",
    "here is", "here's", "here you go", "i'm sorry", "im sorry", "sorry,",
    "no problem", "absolutely",
)

#: Languages a fence tag must name (or omit) for the block to count as Python.
_PYTHON_FENCE_TAGS = frozenset({"", "python", "py", "python3"})


class CheckerError(ValueError):
    """Raised when a task's ``checker_args`` are malformed.

    This is a *task authoring* error, not a model failure: the harness refuses
    to silently score a mis-specified task as wrong.
    """


class UnknownCheckerError(KeyError):
    """Raised when a task names a checker that is not implemented."""

    def __init__(self, name: str) -> None:
        known = ", ".join(sorted(CHECKS))
        super().__init__(f"unknown checker {name!r}. Implemented checkers: {known}.")


@dataclass(frozen=True)
class CheckResult:
    """The outcome of applying one checker to one response."""

    passed: bool
    """True only when the checker's pass condition is fully satisfied."""

    score: float
    """Graded credit in ``[0.0, 1.0]``. ``1.0`` iff ``passed`` is True."""

    detail: str
    """Human-readable explanation, suitable for a report or CI log."""

    evidence: Mapping[str, Any] = field(default_factory=dict)
    """Structured extras (extracted code, observed stdout, unmatched items)."""

    def __post_init__(self) -> None:
        if not 0.0 <= self.score <= 1.0:
            raise ValueError(f"score must be within [0, 1]; got {self.score!r}")
        if self.passed and self.score != 1.0:
            # A "pass" that is not full credit would make aggregate scores and
            # pass counts disagree; keep them tied together by construction.
            object.__setattr__(self, "score", 1.0)

    def as_dict(self) -> dict[str, Any]:
        """Serialise to a JSON-ready dict for the report."""

        return {
            "passed": self.passed,
            "score": self.score,
            "detail": self.detail,
            "evidence": dict(self.evidence),
        }


# ---------------------------------------------------------------------------
# Response normalisation helpers
# ---------------------------------------------------------------------------


def _strip_code_fence(text: str) -> str:
    """Return the body of the first fenced block, or ``text`` unchanged.

    Only used when ``checker_args["strip_code_fence"]`` is true. A response
    that is entirely one fenced block is the common case for instruction
    following tasks; a response with prose around the block keeps the prose,
    and the caller is expected to use a checker that tolerates it.
    """

    stripped = text.strip()
    if not stripped.startswith("```"):
        return text
    match = _FENCED_BLOCK.search(stripped)
    if match is None:
        return text
    # Only unwrap when the fence is the whole response.
    if _FENCED_ANY.search(stripped).group(0).strip() != stripped:
        return text
    return match.group("body")


def _strip_conversational_preamble(text: str) -> str:
    """Drop a leading chatty line or two from a response.

    Models frequently answer a terse instruction with "Sure, here you go:"
    followed by the real answer. When ``checker_args["strip_preamble"]`` is
    set, that lead-in is removed before normalisation so an instruction
    following task measures the answer rather than the pleasantries. It is
    off by default: "do not begin with Sure" is itself a valid thing to test.
    """

    lines = [line for line in text.strip().splitlines()]
    while lines:
        head = lines[0].strip()
        lowered = head.lower()
        if not head:
            lines.pop(0)
            continue
        if lowered.startswith(_CONVERSATIONAL_PREFIXES) or lowered.endswith(":"):
            lines.pop(0)
            continue
        prefixed = lowered.split(" ", 1)[0]
        if prefixed in _PROMPT_ECHO_PREFIXES:
            remainder = head.split(" ", 1)[1] if " " in head else ""
            lines[0] = remainder
            if not remainder.strip():
                lines.pop(0)
            continue
        break
    return "\n".join(lines)


def _normalise(text: str, strip_outer_code_fence: bool, strip_preamble: bool) -> str:
    """Canonical form used by ``exact`` and ``contains``."""

    if strip_outer_code_fence:
        text = _strip_code_fence(text)
    if strip_preamble:
        text = _strip_conversational_preamble(text)
    return re.sub(r"\s+", " ", text).strip()


def _fold(text: str, case_sensitive: bool) -> str:
    """Apply the case-insensitivity policy shared by ``exact``/``contains``."""

    return text if case_sensitive else text.lower()


def _preview(text: str, limit: int = 160) -> str:
    """One-line, length-bounded rendering of arbitrary text for diagnostics."""

    flat = re.sub(r"\s+", " ", text).strip()
    if len(flat) <= limit:
        return flat
    return flat[: limit - 3] + "..."


def _require_str(checker_args: Mapping[str, Any], key: str, task_id: str = "") -> str:
    """Fetch a required string argument, raising a useful error when absent."""

    value = checker_args.get(key)
    if not isinstance(value, str) or not value:
        where = f" for task {task_id!r}" if task_id else ""
        raise CheckerError(f"checker_args[{key!r}] must be a non-empty string{where}")
    return value


def _positive_number(checker_args: Mapping[str, Any], key: str, default: float) -> float:
    """Fetch a positive numeric argument, falling back to ``default``."""

    value = checker_args.get(key, default)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        raise CheckerError(f"checker_args[{key!r}] must be a positive number; got {value!r}")
    return float(value)


# ---------------------------------------------------------------------------
# exact
# ---------------------------------------------------------------------------


def check_exact(
    response: str,
    reference: str,
    checker_args: Mapping[str, Any] | None = None,
    task_id: str = "",
) -> CheckResult:
    """Normalised string equality.

    ``checker_args``:

    ``case_sensitive`` (bool, default False)
        When false (the default) the comparison is case-insensitive.
    ``strip_code_fence`` (bool, default False)
        Unwrap a response that is entirely one fenced block.
    ``strip_preamble`` (bool, default False)
        Drop a leading conversational line before comparing.
    ``collapse_whitespace`` (bool, default True)
        Collapse all whitespace runs to a single space. Disable for answers
        where newlines are semantically load-bearing.
    """

    args = dict(checker_args or {})
    case_sensitive = bool(args.get("case_sensitive", False))
    collapse = bool(args.get("collapse_whitespace", True))

    reference_norm = reference.strip() if collapse else reference.strip("\n")
    if collapse:
        reference_norm = re.sub(r"\s+", " ", reference_norm)

    candidate = response
    if args.get("strip_code_fence"):
        candidate = _strip_code_fence(candidate)
    if args.get("strip_preamble"):
        candidate = _strip_conversational_preamble(candidate)
    candidate = candidate.strip() if collapse else candidate.strip("\n")
    if collapse:
        candidate = re.sub(r"\s+", " ", candidate)

    if not case_sensitive:
        reference_norm = reference_norm.lower()
        candidate = candidate.lower()

    if candidate == reference_norm:
        return CheckResult(
            passed=True,
            score=1.0,
            detail="response matches the reference exactly after normalisation",
            evidence={"normalised_response": _preview(candidate)},
        )
    return CheckResult(
        passed=False,
        score=0.0,
        detail=(
            "response does not match the reference; "
            f"expected {_preview(reference_norm)!r}, got {_preview(candidate)!r}"
        ),
        evidence={
            "expected": _preview(reference_norm),
            "actual": _preview(candidate),
        },
    )


# ---------------------------------------------------------------------------
# contains
# ---------------------------------------------------------------------------


def check_contains(
    response: str,
    reference: str,
    checker_args: Mapping[str, Any] | None = None,
    task_id: str = "",
) -> CheckResult:
    """Required substrings must be present in the response.

    ``checker_args``:

    ``any_of`` (list[str], optional)
        Explicit list of acceptable fragments. One hit is a full pass.
    ``all_of`` (list[str], optional)
        Every fragment must be present; the score is the fraction found.
    ``case_sensitive`` (bool, default False)
    ``strip_code_fence`` / ``strip_preamble`` as in :func:`check_exact`.

    When neither ``any_of`` nor ``all_of`` is given, ``reference`` is treated
    as an ``any_of`` list of one entry. Passing both keys is a task authoring
    error: ``any_of`` and ``all_of`` are different questions.
    """

    args = dict(checker_args or {})
    any_of = args.get("any_of")
    all_of = args.get("all_of")
    if any_of is not None and all_of is not None:
        raise CheckerError("checker_args must not set both 'any_of' and 'all_of'")
    if any_of is not None:
        if not isinstance(any_of, Sequence) or isinstance(any_of, str) or not any_of:
            raise CheckerError("checker_args['any_of'] must be a non-empty sequence of strings")
        fragments = [str(item) for item in any_of]
        mode = "any_of"
    elif all_of is not None:
        if not isinstance(all_of, Sequence) or isinstance(all_of, str) or not all_of:
            raise CheckerError("checker_args['all_of'] must be a non-empty sequence of strings")
        fragments = [str(item) for item in all_of]
        mode = "all_of"
    else:
        fragments = [reference]
        mode = "any_of"

    case_sensitive = bool(args.get("case_sensitive", False))
    haystack = response
    if args.get("strip_code_fence"):
        haystack = _strip_code_fence(haystack)
    if args.get("strip_preamble"):
        haystack = _strip_conversational_preamble(haystack)
    haystack = _fold(haystack, case_sensitive)

    found = [frag for frag in fragments if _fold(frag, case_sensitive) in haystack]
    missing = [frag for frag in fragments if frag not in found]
    score = len(found) / len(fragments)

    if mode == "any_of":
        passed = bool(found)
        detail = (
            f"matched {len(found)}/{len(fragments)} acceptable fragment(s)"
            + ("" if passed else f"; none of {missing!r} appear in the response")
        )
    else:
        passed = not missing
        detail = f"matched {len(found)}/{len(fragments)} required fragment(s)"
        if missing:
            detail += f"; missing {missing!r}"

    return CheckResult(
        passed=passed,
        score=1.0 if passed else (score if mode == "all_of" else 0.0),
        detail=detail,
        evidence={"found": found, "missing": missing, "mode": mode},
    )


# ---------------------------------------------------------------------------
# regex
# ---------------------------------------------------------------------------


def check_regex(
    response: str,
    reference: str,
    checker_args: Mapping[str, Any] | None = None,
    task_id: str = "",
) -> CheckResult:
    """A regular expression must match the (optionally normalised) response.

    ``checker_args``:

    ``pattern`` (str, required)
        The pattern. ``reference`` is used when omitted, which keeps the task
        file readable for one-pattern tasks.
    ``flags`` (list[str], optional)
        Any of ``ignorecase``, ``multiline``, ``dotall``, ``verbose``.
    ``count`` (int, optional)
        Require at least this many matches (default 1).
    ``strip_code_fence`` / ``strip_preamble`` as elsewhere.
    """

    args = dict(checker_args or {})
    pattern = args.get("pattern") or reference
    if not isinstance(pattern, str) or not pattern:
        raise CheckerError(f"checker_args['pattern'] must be a non-empty string for task {task_id!r}")

    flags = 0
    flag_names = args.get("flags", [])
    if isinstance(flag_names, str):
        flag_names = [flag_names]
    supported = {
        "ignorecase": re.IGNORECASE,
        "multiline": re.MULTILINE,
        "dotall": re.DOTALL,
        "verbose": re.VERBOSE,
    }
    for name in flag_names:
        key = str(name).lower()
        if key not in supported:
            raise CheckerError(
                f"checker_args['flags'] contains unknown flag {name!r}; "
                f"supported: {', '.join(sorted(supported))}"
            )
        flags |= supported[key]
    if args.get("strip_code_fence") and not (flags & re.MULTILINE):
        flags |= re.MULTILINE

    try:
        compiled = re.compile(pattern, flags)
    except re.error as exc:
        raise CheckerError(f"checker_args['pattern'] is not a valid regex ({exc}): {pattern!r}") from exc

    haystack = response
    if args.get("strip_code_fence"):
        haystack = _strip_code_fence(haystack).strip()
    if args.get("strip_preamble"):
        haystack = _strip_conversational_preamble(haystack)
    if args.get("strip_whitespace"):
        haystack = haystack.strip()

    matches = compiled.findall(haystack)
    required = int(args.get("count", 1))
    if required < 1:
        raise CheckerError(f"checker_args['count'] must be >= 1; got {required!r}")

    passed = len(matches) >= required
    detail = f"pattern matched {len(matches)} time(s); required at least {required}"
    if not passed:
        detail += f"; response was {_preview(haystack)!r}"
    return CheckResult(
        passed=passed,
        score=1.0 if passed else 0.0,
        detail=detail,
        evidence={"match_count": len(matches), "pattern": pattern},
    )


# ---------------------------------------------------------------------------
# rubric
# ---------------------------------------------------------------------------


def check_rubric(
    response: str,
    reference: str,
    checker_args: Mapping[str, Any] | None = None,
    task_id: str = "",
) -> CheckResult:
    """Fraction of required rubric fragments present in the response.

    ``checker_args``:

    ``required`` (list[str], required)
        Substrings that must all appear for a full pass. Matching is on a
        whitespace-collapsed, case-insensitive form, so a model that reflows
        its prose is not penalised.
    ``required_patterns`` (list[str], optional)
        Regexes that must all match. Lets a rubric express ordering or shape
        constraints that substrings cannot.
    ``forbidden`` (list[str], optional)
        Substrings that must be absent (e.g. the anti-pattern the task asks
        the model to remove). Any hit is a hard failure.
    ``forbidden_patterns`` (list[str], optional)
        Regex equivalents of ``forbidden``.
    ``case_sensitive`` (bool, default False)
    ``pass_threshold`` (float, default 1.0)
        Fraction of required items needed to pass. The *score* is always the
        fraction covered; ``pass_threshold`` only moves the pass line.

    ``reference`` is used as the ``required`` list when ``required`` is absent,
    for the degenerate one-fragment case.
    """

    args = dict(checker_args or {})
    required = args.get("required")
    if required is None:
        required = [reference]
    if not isinstance(required, Sequence) or isinstance(required, str) or not required:
        raise CheckerError(f"checker_args['required'] must be a non-empty sequence of strings (task {task_id!r})")
    required = [str(item) for item in required]

    required_patterns = [str(p) for p in (args.get("required_patterns") or [])]
    forbidden = [str(item) for item in (args.get("forbidden") or [])]
    forbidden_patterns = [str(p) for p in (args.get("forbidden_patterns") or [])]

    threshold = float(args.get("pass_threshold", 1.0))
    if not 0.0 < threshold <= 1.0:
        raise CheckerError(f"checker_args['pass_threshold'] must be within (0, 1]; got {threshold!r}")

    case_sensitive = bool(args.get("case_sensitive", False))
    haystack = response
    if args.get("strip_code_fence"):
        haystack = _strip_code_fence(haystack)
    if args.get("strip_preamble"):
        haystack = _strip_conversational_preamble(haystack)
    flattened = _fold(re.sub(r"\s+", " ", haystack), case_sensitive)

    present = [frag for frag in required if _fold(re.sub(r"\s+", " ", frag), case_sensitive) in flattened]
    missing = [frag for frag in required if frag not in present]

    pattern_hits: list[str] = []
    pattern_misses: list[str] = []
    for pattern in required_patterns:
        try:
            matched = re.search(pattern, haystack, re.DOTALL) is not None
        except re.error as exc:
            raise CheckerError(f"rubric pattern is not a valid regex ({exc}): {pattern!r}") from exc
        (pattern_hits if matched else pattern_misses).append(pattern)

    violated = [frag for frag in forbidden if _fold(frag, case_sensitive) in flattened]
    for pattern in forbidden_patterns:
        try:
            if re.search(pattern, haystack, re.DOTALL) is not None:
                violated.append(pattern)
        except re.error as exc:
            raise CheckerError(f"forbidden pattern is not a valid regex ({exc}): {pattern!r}") from exc

    total_items = len(required) + len(required_patterns)
    satisfied = len(present) + len(pattern_hits)
    score = satisfied / total_items if total_items else 0.0

    passed = not violated and score >= threshold
    parts = [f"rubric satisfied {satisfied}/{total_items} item(s)"]
    if missing:
        parts.append(f"missing {missing!r}")
    if pattern_misses:
        parts.append(f"unmatched patterns {pattern_misses!r}")
    if violated:
        parts.append(f"forbidden content present {violated!r}")

    return CheckResult(
        passed=passed,
        # ``score`` is the fraction of the rubric actually covered, always. A
        # task that passes at a sub-1.0 ``pass_threshold`` still earns partial
        # credit here, which is then lifted to 1.0 by CheckResult so that the
        # pass count and the aggregate cannot disagree: a "passed" task always
        # contributes a full point. A forbidden-content hit collapses to 0.0,
        # because the task asked for that content to be *removed*.
        score=0.0 if violated else score,
        detail="; ".join(parts),
        evidence={
            "present": present,
            "missing": missing,
            "unmatched_patterns": pattern_misses,
            "violations": violated,
        },
    )


# ---------------------------------------------------------------------------
# python-exec
# ---------------------------------------------------------------------------


def _iter_candidate_fences(response: str) -> Iterable[tuple[str, str]]:
    """Yield ``(language_tag, body)`` for each fenced block, in order."""

    for match in _FENCED_BLOCK.finditer(response):
        yield match.group("lang").strip().lower(), match.group("body")


def extract_python_code(response: str, task_id: str = "") -> str:
    """Extract executable Python from a model response.

    Resolution order, most explicit first:

    1. A directive comment - ``# eval:only`` means "this block is the whole
       answer, ignore everything else"; ``# eval:append`` adds a block to the
       accumulated program. Both are matched inside fenced blocks.
    2. Every fenced block tagged ``python``/``py`` (or untagged), concatenated
       in the order they appear.
    3. The longest fenced block of any language, taken as a last resort so a
       model that fences with ```rust by mistake still gets scored on the code
       rather than on its tag.
    4. A def/class-bearing heuristic over the raw response.

    Raises :class:`CheckerError` when nothing usable is found.
    """

    fences = list(_iter_candidate_fences(response))

    only_blocks: list[str] = []
    append_blocks: list[str] = []
    for lang, body in fences:
        modes = {m.group("mode").lower() for m in _DIRECTIVE_LINE.finditer(body)}
        if "only" in modes:
            only_blocks.append(body)
        elif "append" in modes:
            append_blocks.append(body)
    if only_blocks:
        return only_blocks[0]
    if append_blocks:
        return "\n\n".join(append_blocks)

    python_blocks = [body for lang, body in fences if lang in _PYTHON_FENCE_TAGS]
    if python_blocks:
        return "\n\n".join(python_blocks)

    if fences:
        return max(fences, key=lambda pair: len(pair[1]))[1]

    if re.search(r"^[ \t]*(?:def|class|import|from|@)\b", response, re.MULTILINE):
        return response

    raise CheckerError(
        f"no executable Python found in response{f' for task {task_id!r}' if task_id else ''}; "
        f"response began {_preview(response, 120)!r}"
    )


def _build_preexec(
    cpu_seconds: int,
    memory_bytes: int,
    max_procs: int,
) -> Callable[[], None] | None:
    """Return the POSIX ``preexec_fn`` that installs the child's rlimits.

    Returns ``None`` on platforms without :mod:`resource` (notably Windows),
    where only the wall-clock timeout applies. The returned callable runs in
    the forked child between ``fork`` and ``exec``; it touches nothing but
    ``resource.setrlimit`` so it is async-signal-safe enough for that window.
    """

    try:
        import resource  # noqa: PLC0415 - POSIX-only, imported defensively
    except ImportError:  # pragma: no cover - Windows
        return None

    def preexec() -> None:
        limits = [
            (resource.RLIMIT_CPU, cpu_seconds),
            (resource.RLIMIT_AS, memory_bytes),
            (resource.RLIMIT_FSIZE, 8 * 1024 * 1024),
            (resource.RLIMIT_NPROC, max_procs),
            (resource.RLIMIT_CORE, 0),
        ]
        for what, soft in limits:
            try:
                hard = resource.getrlimit(what)[1]
                if hard != resource.RLIM_INFINITY:
                    soft = min(soft, hard)
                resource.setrlimit(what, (soft, hard))
            except (ValueError, OSError):
                # A limit the platform refuses to lower is not fatal: the
                # wall-clock timeout remains the backstop.
                continue

    return preexec


def _child_environment(workdir: str, allow_network_env: bool) -> dict[str, str]:
    """Build a minimal environment for the sandboxed child process."""

    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": workdir,
        "TMPDIR": workdir,
        "TEMP": workdir,
        "TMP": workdir,
        "XDG_CACHE_HOME": workdir,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "0",
        "PYTHONNOUSERSITE": "1",
        "PYTHONUNBUFFERED": "1",
        "LC_ALL": "C",
        "LANG": "C",
    }
    if not allow_network_env:
        # Point the conventional proxy variables at an address that cannot be
        # routed, so libraries that honour them fail fast instead of hanging.
        for name in ("http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy"):
            env[name] = "http://127.0.0.1:9"
            env[name.upper()] = "http://127.0.0.1:9"
    return env


def _run_python(
    source: str,
    timeout_seconds: float,
    memory_bytes: int,
    cpu_seconds: int,
    max_procs: int,
    isolated_prefix: str,
    allow_network_env: bool = False,
) -> tuple[int | None, str, str, str | None]:
    """Execute ``source`` in a locked-down child process.

    Returns ``(returncode, stdout, stderr, failure)`` where ``failure`` is a
    short reason (``"timeout"``, ``"no-interpreter"``) or ``None`` on a normal
    completion. ``returncode`` is ``None`` only when the child never ran or was
    killed for exceeding the timeout.
    """

    stdout = ""
    stderr = ""
    with tempfile.TemporaryDirectory(prefix="kairoforge-eval-") as workdir:
        script_path = os.path.join(workdir, "candidate.py")
        with open(script_path, "w", encoding="utf-8") as handle:
            handle.write(isolated_prefix)
            handle.write(source)

        preexec = _build_preexec(cpu_seconds, memory_bytes, max_procs)
        try:
            completed = subprocess.run(
                [sys.executable, "-I", "-S", script_path],
                cwd=workdir,
                env=_child_environment(workdir, allow_network_env),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout_seconds,
                check=False,
                shell=False,
                preexec_fn=preexec,
                close_fds=True,
            )
        except subprocess.TimeoutExpired as exc:
            return (
                None,
                (exc.stdout or b"").decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
                (exc.stderr or b"").decode("utf-8", "replace") if isinstance(exc.stderr, bytes) else (exc.stderr or ""),
                "timeout",
            )
        except OSError as exc:
            return None, "", f"{type(exc).__name__}: {exc}", "no-interpreter"

        stdout = completed.stdout.decode("utf-8", "replace")
        stderr = completed.stderr.decode("utf-8", "replace")
        return completed.returncode, stdout, stderr, None


def check_python_exec(
    response: str,
    reference: str,
    checker_args: Mapping[str, Any] | None = None,
    task_id: str = "",
) -> CheckResult:
    """Execute extracted Python in a subprocess and check its observable result.

    Exactly one expectation mode must be configured in ``checker_args``:

    ``expect_stdout`` (str)
        Expected stdout. A ``|``-separated string compares printed lines
        positionally (use ``\\n`` for a literal pipe). Comparison ignores
        trailing whitespace per line unless ``exact_stdout`` is true. By
        default extra trailing lines are tolerated; ``exact_stdout`` requires
        the printed line count to match exactly.
    ``test_code`` (str)
        Harness-supplied code appended after the extracted code, usually
        containing ``print(...)`` or ``assert`` statements. Without one of the
        stdout keys below it must print something to be checkable.
    ``expect_ok`` (bool)
        Require the child to exit with status 0.

    Additional ``checker_args``:

    ``timeout_seconds`` (float, default 10)
    ``memory_bytes`` (int, default 768 MiB)
    ``cpu_seconds`` (int, default 8)
    ``max_procs`` (int, default 32)
    ``allow_network_env`` (bool, default False)
    ``isolated_prefix`` (str, default "")
        Extra code prepended to the child program (e.g. a stub module). Note
        that ``pytest`` is not installed in the child's environment and cannot
        be: the child runs with ``-I -S`` and an isolated ``sys.path``.

    On a non-zero exit the check fails and the child's stderr is truncated
    into ``detail``, so a report shows the real traceback instead of a bare
    "wrong answer". A timeout is reported as such and never as an ordinary
    wrong answer.

    See the module docstring for the isolation this does and does not provide.
    """

    args = dict(checker_args or {})
    timeout_seconds = _positive_number(args, "timeout_seconds", DEFAULT_EXEC_TIMEOUT_SECONDS)
    memory_bytes = int(_positive_number(args, "memory_bytes", DEFAULT_EXEC_MEMORY_BYTES))
    cpu_seconds = int(_positive_number(args, "cpu_seconds", DEFAULT_EXEC_CPU_SECONDS))
    max_procs = int(_positive_number(args, "max_procs", DEFAULT_EXEC_MAX_PROCS))
    allow_network_env = bool(args.get("allow_network_env", False))
    isolated_prefix = str(args.get("isolated_prefix", ""))
    truncate = bool(args.get("truncate_exec_output", True))

    has_stdout_expectation = "expect_stdout" in args
    has_test_code = "test_code" in args
    expect_ok = bool(args.get("expect_ok", False))
    if not (has_stdout_expectation or has_test_code or expect_ok):
        raise CheckerError(
            f"python-exec for task {task_id!r} needs one of "
            "'expect_stdout', 'test_code' or 'expect_ok'"
        )

    try:
        extracted = extract_python_code(response, task_id)
    except CheckerError as exc:
        return CheckResult(
            passed=False,
            score=0.0,
            detail=str(exc),
            evidence={"extraction_failed": True},
        )
    program = extracted if not has_test_code else extracted + "\n" + str(args["test_code"])

    returncode, stdout, stderr, failure = _run_python(
        program,
        timeout_seconds=timeout_seconds,
        memory_bytes=memory_bytes,
        cpu_seconds=cpu_seconds,
        max_procs=max_procs,
        isolated_prefix=isolated_prefix,
        allow_network_env=allow_network_env,
    )

    clipped_stdout = stdout[:_MAX_OBSERVED_OUTPUT_CHARS] if truncate else stdout
    clipped_stderr = stderr[:_MAX_OBSERVED_OUTPUT_CHARS] if truncate else stderr
    evidence: dict[str, Any] = {
        "extracted_code": extracted[:_MAX_OBSERVED_OUTPUT_CHARS],
        "stdout": clipped_stdout,
        "stderr": clipped_stderr,
        "returncode": returncode,
        "timeout_seconds": timeout_seconds,
    }

    if failure == "timeout":
        return CheckResult(
            passed=False,
            score=0.0,
            detail=(
                f"code did not finish within {timeout_seconds:g}s and the process was killed "
                "(likely an infinite loop or blocking input)"
            ),
            evidence=evidence,
        )
    if failure == "no-interpreter":
        return CheckResult(
            passed=False,
            score=0.0,
            detail=f"could not start a Python subprocess: {clipped_stderr}",
            evidence=evidence,
        )

    if returncode != 0:
        return CheckResult(
            passed=False,
            score=0.0,
            detail=f"code exited with status {returncode}; stderr: {_preview(clipped_stderr, 400)}",
            evidence=evidence,
        )

    if has_stdout_expectation:
        expected_raw = _require_str(args, "expect_stdout", task_id)
        expected_lines = expected_raw.replace("\\n", "\n").split("|")
        actual_lines = stdout.splitlines()
        exact = bool(args.get("exact_stdout", False))
        if exact:
            ok = [line.strip() for line in actual_lines] == [line.strip() for line in expected_lines]
        else:
            ok = len(actual_lines) >= len(expected_lines) and all(
                actual_lines[i].strip() == expected_lines[i].strip()
                for i in range(len(expected_lines))
            )
        if ok:
            return CheckResult(
                passed=True,
                score=1.0,
                detail=f"stdout matched all {len(expected_lines)} expected line(s)",
                evidence=evidence,
            )
        return CheckResult(
            passed=False,
            score=0.0,
            detail=(
                "stdout did not match; expected lines "
                f"{[line.strip() for line in expected_lines]!r}, got "
                f"{[line.strip() for line in actual_lines]!r}"
            ),
            evidence=evidence,
        )

    if has_test_code:
        if stdout.strip():
            return CheckResult(
                passed=True,
                score=1.0,
                detail="test code ran to completion and printed a result",
                evidence=evidence,
            )
        return CheckResult(
            passed=False,
            score=0.0,
            detail=(
                "test code exited 0 but printed nothing, so the result cannot be verified; "
                "add a print() or an assert to checker_args['test_code']"
            ),
            evidence=evidence,
        )

    return CheckResult(
        passed=True,
        score=1.0,
        detail="code exited with status 0",
        evidence=evidence,
    )


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

#: Registry used by :func:`check_response` and by the task validator.
CHECKS: dict[str, Callable[[str, str, Mapping[str, Any] | None, str], CheckResult]] = {
    "exact": check_exact,
    "contains": check_contains,
    "regex": check_regex,
    "python-exec": check_python_exec,
    "rubric": check_rubric,
}


def check_response(
    response: str,
    task: Any,
    checker: str | None = None,
) -> CheckResult:
    """Run ``task``'s checker against ``response``.

    ``task`` is any object exposing ``reference``, ``checker``,
    ``checker_args`` and ``id`` - in practice an
    :class:`~kairoforge.evaluation.tasks.EvalTask`. ``checker`` overrides the
    task's own checker, which is what a caller uses to re-score stored
    responses with a stricter checker without re-querying the model.

    A task whose ``checker_args`` are malformed raises :class:`CheckerError`;
    a task naming an unknown checker raises :class:`UnknownCheckerError`.
    Neither is swallowed, because both mean the *harness* is misconfigured and
    silently scoring them as model failures would fabricate a worse result
    than the model earned.
    """

    name = checker or getattr(task, "checker")
    implementation = CHECKS.get(name)
    if implementation is None:
        raise UnknownCheckerError(name)
    return implementation(
        response,
        getattr(task, "reference", ""),
        getattr(task, "checker_args", None),
        getattr(task, "id", ""),
    )
