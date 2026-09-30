"""Evaluation runner: score a model against a task suite, and compare runs.

The runner is deliberately transport-agnostic. It never imports a model, a
tokenizer, or an HTTP client: it takes a ``model_call`` callable with the
signature ``(prompt: str) -> str`` and calls it once per task. That is what
makes the same harness usable against the untouched base model, a fine-tuned
KairoForge checkpoint served by the inference API, and a deterministic stub in
tests, with the scoring path byte-identical in all three cases.

Nothing in this module invents results. Every number in an :class:`EvalReport`
is derived from a checker outcome that is itself recorded per task, so a
report can always be audited back to the response that produced it.

Determinism and honesty notes
-----------------------------

* Task execution is single-threaded and in suite order. A model call that
  fails raises :class:`ModelCallError` by default; pass ``on_error="record"``
  to store the failure as a zero-scored result instead. Both are honest - the
  question is whether the caller wants a partial report or a loud failure.
* Every report carries the ``model_name``, task count and timestamp that
  produced it, so two reports can only be compared when the caller knows they
  came from the same suite.
* :func:`compare_reports` refuses to silently compare reports with different
  task sets: a "delta" over different questions would be meaningless.
"""

from __future__ import annotations

import json
import statistics
import traceback
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Mapping, Sequence

from kairoforge.evaluation import checkers as _checkers
from kairoforge.evaluation.checkers import CheckerError, CheckResult
from kairoforge.evaluation.tasks import BUILTIN_TASKS, EvalTask

__all__ = [
    "ModelCallError",
    "TaskResult",
    "EvalReport",
    "FamilyDelta",
    "ComparisonReport",
    "run_evaluation",
    "compare_reports",
    "render_markdown",
    "render_leaderboard",
]

#: A model under test: prompt in, response text out.
ModelCall = Callable[[str], str]

#: Default weight below which a family delta is treated as noise rather than a
#: real regression. Reported, but not flagged.
DEFAULT_REGRESSION_TOLERANCE = 0.0


class ModelCallError(RuntimeError):
    """Raised when the model under test fails to answer a prompt.

    Carries the task id and the original exception so a failed evaluation run
    reports *which* prompt broke the model rather than a bare traceback.
    """

    def __init__(self, task_id: str, cause: BaseException) -> None:
        super().__init__(
            f"model_call failed on task {task_id!r}: {type(cause).__name__}: {cause}"
        )
        self.task_id = task_id
        self.cause = cause


@dataclass(frozen=True)
class TaskResult:
    """One task's outcome, with enough context to audit the score."""

    task_id: str
    task_family: str
    language: str
    checker: str
    weight: float
    passed: bool
    score: float
    detail: str
    response: str
    latency_seconds: float
    error: str | None = None

    @property
    def weighted_score(self) -> float:
        """Score multiplied by the task weight, the numerator of the aggregate."""

        return self.score * self.weight

    def as_dict(self, include_response: bool = True) -> dict[str, Any]:
        """Serialise for a JSON report. Response text is the bulky part."""

        data: dict[str, Any] = {
            "task_id": self.task_id,
            "task_family": self.task_family,
            "language": self.language,
            "checker": self.checker,
            "weight": self.weight,
            "passed": self.passed,
            "score": self.score,
            "detail": self.detail,
            "latency_seconds": self.latency_seconds,
        }
        if self.error is not None:
            data["error"] = self.error
        if include_response:
            data["response"] = self.response
        return data


@dataclass(frozen=True)
class EvalReport:
    """The complete result of scoring one model against one task suite."""

    model_name: str
    results: tuple[TaskResult, ...]
    timestamp: str
    duration_seconds: float
    metadata: Mapping[str, Any] = field(default_factory=dict)

    # -- basic aggregates ---------------------------------------------------

    @property
    def total_tasks(self) -> int:
        """Number of tasks that were attempted."""

        return len(self.results)

    @property
    def passed_tasks(self) -> int:
        """Number of tasks whose checker fully passed."""

        return sum(1 for result in self.results if result.passed)

    @property
    def failed_tasks(self) -> int:
        """Number of tasks that did not fully pass."""

        return self.total_tasks - self.passed_tasks

    @property
    def errored_tasks(self) -> int:
        """Number of tasks the model never answered (transport/exception)."""

        return sum(1 for result in self.results if result.error is not None)

    @property
    def total_weight(self) -> float:
        """Sum of the weights of every attempted task."""

        return sum(result.weight for result in self.results)

    @property
    def aggregate_score(self) -> float:
        """Weighted mean score in ``[0, 1]``. Zero for an empty report."""

        total = self.total_weight
        if total <= 0:
            return 0.0
        return sum(result.weighted_score for result in self.results) / total

    @property
    def pass_rate(self) -> float:
        """Unweighted fraction of tasks fully passed, for cross-run intuition."""

        if not self.results:
            return 0.0
        return self.passed_tasks / self.total_tasks

    # -- breakdowns ---------------------------------------------------------

    def _breakdown(self, attribute: str) -> dict[str, dict[str, float]]:
        buckets: dict[str, list[TaskResult]] = defaultdict(list)
        for result in self.results:
            buckets[getattr(result, attribute)].append(result)
        return {
            key: _summarise(group)
            for key, group in sorted(buckets.items())
        }

    @property
    def by_family(self) -> dict[str, dict[str, float]]:
        """Aggregate score, pass counts and task counts per task family."""

        return self._breakdown("task_family")

    @property
    def by_language(self) -> dict[str, dict[str, float]]:
        """Aggregate score, pass counts and task counts per language."""

        return self._breakdown("language")

    @property
    def by_checker(self) -> dict[str, dict[str, float]]:
        """Breakdown by checker, which exposes checker-specific quirks."""

        return self._breakdown("checker")

    @property
    def failures(self) -> tuple[TaskResult, ...]:
        """Every non-passing result, worst score first."""

        return tuple(
            sorted(
                (result for result in self.results if not result.passed),
                key=lambda result: (result.score, result.task_id),
            )
        )

    @property
    def regressions_vs(self) -> tuple[str, ...]:
        """Task ids that errored, i.e. the model produced no answer at all."""

        return tuple(result.task_id for result in self.results if result.error is not None)

    # -- serialisation ------------------------------------------------------

    def as_dict(self, include_responses: bool = True) -> dict[str, Any]:
        """Serialise to a JSON-ready dict, preserving per-task audit detail."""

        return {
            "model_name": self.model_name,
            "timestamp": self.timestamp,
            "duration_seconds": self.duration_seconds,
            "metadata": dict(self.metadata),
            "aggregate_score": self.aggregate_score,
            "pass_rate": self.pass_rate,
            "total_tasks": self.total_tasks,
            "passed_tasks": self.passed_tasks,
            "failed_tasks": self.failed_tasks,
            "errored_tasks": self.errored_tasks,
            "by_family": self.by_family,
            "by_language": self.by_language,
            "by_checker": self.by_checker,
            "results": [result.as_dict(include_response=include_responses) for result in self.results],
        }

    def to_json(self, include_responses: bool = True, indent: int = 2) -> str:
        """Render the report as JSON text."""

        return json.dumps(self.as_dict(include_responses=include_responses), indent=indent, sort_keys=False)


def _summarise(group: Sequence[TaskResult]) -> dict[str, float]:
    """Reduce one bucket of results to the numbers a report quotes."""

    weights = sum(result.weight for result in group)
    aggregate = (
        sum(result.weighted_score for result in group) / weights if weights > 0 else 0.0
    )
    scores = [result.score for result in group]
    return {
        "tasks": len(group),
        "passed": sum(1 for result in group if result.passed),
        "failed": sum(1 for result in group if not result.passed),
        "errors": sum(1 for result in group if result.error is not None),
        "aggregate_score": aggregate,
        "mean_score": statistics.fmean(scores) if scores else 0.0,
    }


def _utc_now() -> str:
    """ISO-8601 UTC timestamp; the report's only clock dependency."""

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run_evaluation(
    model_call: ModelCall,
    tasks: Sequence[EvalTask] = BUILTIN_TASKS,
    model_name: str = "unnamed-model",
    on_error: str = "raise",
    metadata: Mapping[str, Any] | None = None,
    progress: Callable[[TaskResult], None] | None = None,
) -> EvalReport:
    """Score ``model_call`` against ``tasks`` and return an :class:`EvalReport`.

    ``model_call`` takes the task prompt and returns the model's response text
    verbatim. It is called exactly once per task, in suite order, and the
    returned string is what the task's checker sees - the runner performs no
    prompt templating, so a caller testing a chat model wraps its own
    templating inside ``model_call``.

    ``on_error``:

    ``"raise"`` (default)
        A model failure aborts the run with :class:`ModelCallError`. This is
        the honest default for a benchmark: a report over a run where half the
        prompts failed is not a measurement of the model. Failed runs produce
        no report at all rather than a misleadingly low score.
    ``"record"``
        The failure is recorded as a zero-scored :class:`TaskResult` with
        ``error`` set, and the run continues. Use this when probing an
        unreliable endpoint and a partial picture is genuinely useful.

    ``progress``, when given, receives each :class:`TaskResult` as it is
    produced, for live logging. It is called synchronously.

    The checker itself may raise :class:`~kairoforge.evaluation.checkers.CheckerError`
    for a malformed task; that propagates, because a broken task must be fixed
    rather than scored.
    """

    if on_error not in {"raise", "record"}:
        raise ValueError(f"on_error must be 'raise' or 'record'; got {on_error!r}")
    if not callable(model_call):
        raise TypeError("model_call must be callable as (prompt: str) -> str")

    task_tuple = tuple(tasks)
    started = _utc_now()
    import time  # noqa: PLC0415 - local import keeps module import cost trivial

    wall_start = time.perf_counter()
    results: list[TaskResult] = []

    for task in task_tuple:
        call_start = time.perf_counter()
        error: str | None = None
        response = ""
        try:
            response = model_call(task.prompt)
        except Exception as exc:  # noqa: BLE001 - deliberately broad: any failure is a data point
            if on_error == "raise":
                raise ModelCallError(task.id, exc) from exc
            error = f"{type(exc).__name__}: {exc}"
            response = ""
        latency = time.perf_counter() - call_start

        if not isinstance(response, str) and error is None:
            type_error = TypeError(
                f"model_call returned {type(response).__name__}, expected str"
            )
            if on_error == "raise":
                raise ModelCallError(task.id, type_error) from type_error
            error = str(type_error)
            response = "" if response is None else repr(response)

        if error is not None:
            result = TaskResult(
                task_id=task.id,
                task_family=task.task_family,
                language=task.language,
                checker=task.checker,
                weight=task.weight,
                passed=False,
                score=0.0,
                detail=f"model produced no answer: {error}",
                response=response,
                latency_seconds=latency,
                error=error,
            )
        else:
            check: CheckResult = _checkers.check_response(response, task)
            result = TaskResult(
                task_id=task.id,
                task_family=task.task_family,
                language=task.language,
                checker=task.checker,
                weight=task.weight,
                passed=check.passed,
                score=check.score,
                detail=check.detail,
                response=response,
                latency_seconds=latency,
                error=None,
            )

        results.append(result)
        if progress is not None:
            progress(result)

    duration = time.perf_counter() - wall_start
    run_metadata = dict(metadata or {})
    run_metadata.setdefault("task_count", len(task_tuple))
    run_metadata.setdefault("task_ids_hash", _task_ids_digest(task_tuple))

    return EvalReport(
        model_name=model_name,
        results=tuple(results),
        timestamp=started,
        duration_seconds=duration,
        metadata=run_metadata,
    )


def _task_ids_digest(tasks: Iterable[EvalTask]) -> str:
    """Stable digest of the task ids in a suite.

    Two reports can only be meaningfully compared when this matches; it is
    stored in report metadata so :func:`compare_reports` can verify that the
    comparison is apples-to-apples instead of assuming it.
    """

    import hashlib  # noqa: PLC0415 - tiny helper, local import keeps top level lean

    digest = hashlib.sha256()
    for task in tasks:
        digest.update(task.id.encode("utf-8"))
        digest.update(b"\x00")
    return digest.hexdigest()[:16]


@dataclass(frozen=True)
class FamilyDelta:
    """Per-family movement between two reports."""

    task_family: str
    base_score: float
    tuned_score: float

    @property
    def delta(self) -> float:
        """Signed change in aggregate score; positive means tuned is better."""

        return self.tuned_score - self.base_score

    def is_regression(self, tolerance: float = DEFAULT_REGRESSION_TOLERANCE) -> bool:
        """Whether tuned scored meaningfully *worse* than base in this family."""

        return self.delta < -tolerance

    def as_dict(self) -> dict[str, Any]:
        """Serialise for a JSON comparison report."""

        return {
            "task_family": self.task_family,
            "base_score": self.base_score,
            "tuned_score": self.tuned_score,
            "delta": self.delta,
        }


@dataclass(frozen=True)
class ComparisonReport:
    """The difference between a base run and a tuned run."""

    base_model: str
    tuned_model: str
    base_timestamp: str
    tuned_timestamp: str
    overall_delta: float
    families: tuple[FamilyDelta, ...]
    task_deltas: Mapping[str, float]
    regressions: tuple[str, ...]
    improvements: tuple[str, ...]
    tolerance: float = DEFAULT_REGRESSION_TOLERANCE
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @property
    def improved(self) -> bool:
        """Whether the tuned model scored better overall."""

        return self.overall_delta > self.tolerance

    @property
    def regressed(self) -> bool:
        """Whether any family regressed beyond tolerance."""

        return bool(self.regressions)

    def worst_regressions(self, limit: int = 5) -> tuple[FamilyDelta, ...]:
        """The ``limit`` most negative family deltas, for a report summary."""

        ordered = sorted(self.families, key=lambda family: family.delta)
        return tuple(family for family in ordered if family.is_regression(self.tolerance))[:limit]

    def as_dict(self) -> dict[str, Any]:
        """Serialise for a JSON comparison report."""

        return {
            "base_model": self.base_model,
            "tuned_model": self.tuned_model,
            "base_timestamp": self.base_timestamp,
            "tuned_timestamp": self.tuned_timestamp,
            "overall_delta": self.overall_delta,
            "improved": self.improved,
            "regressions": list(self.regressions),
            "improvements": list(self.improvements),
            "tolerance": self.tolerance,
            "families": [family.as_dict() for family in self.families],
            "task_deltas": dict(self.task_deltas),
            "metadata": dict(self.metadata),
        }

    def to_json(self, indent: int = 2) -> str:
        """Render the comparison as JSON text."""

        return json.dumps(self.as_dict(), indent=indent)


def compare_reports(
    base: EvalReport,
    tuned: EvalReport,
    tolerance: float = DEFAULT_REGRESSION_TOLERANCE,
    require_same_tasks: bool = True,
) -> ComparisonReport:
    """Compare a base report against a tuned report.

    ``tolerance`` is the slack below zero before a family is called a
    regression. The default of ``0.0`` means "any drop counts", which is the
    right default for a controlled A/B run of the same suite but will flag
    noise on a small family. Raise it (e.g. ``0.02``) when families hold only
    a handful of tasks and the run is not seeded.

    ``require_same_tasks`` (default True) refuses to compare reports whose
    task-id digests differ, because a delta computed over different questions
    measures the questions, not the models. Pass ``False`` only when the
    overlap is known and the caller accepts the weaker claim; tasks present in
    one report and not the other are then simply absent from ``task_deltas``,
    and family scores remain the aggregate over each report's own tasks.
    """

    if base.model_name == tuned.model_name and base.timestamp == tuned.timestamp:
        raise ValueError(
            "compare_reports was given the same report twice "
            f"({base.model_name!r} at {base.timestamp}); there is nothing to compare"
        )
    if tolerance < 0:
        raise ValueError(f"tolerance must be non-negative; got {tolerance!r}")

    if require_same_tasks:
        base_digest = base.metadata.get("task_ids_hash")
        tuned_digest = tuned.metadata.get("task_ids_hash")
        if base_digest is not None and tuned_digest is not None and base_digest != tuned_digest:
            raise ValueError(
                "refusing to compare reports over different task suites "
                f"({base_digest} vs {tuned_digest}); re-run both models on the same suite "
                "or pass require_same_tasks=False if the overlap is intended"
            )

    base_families = base.by_family
    tuned_families = tuned.by_family
    family_names = sorted(set(base_families) | set(tuned_families))

    families: list[FamilyDelta] = []
    for name in family_names:
        base_entry = base_families.get(name)
        tuned_entry = tuned_families.get(name)
        families.append(
            FamilyDelta(
                task_family=name,
                base_score=base_entry["aggregate_score"] if base_entry else 0.0,
                tuned_score=tuned_entry["aggregate_score"] if tuned_entry else 0.0,
            )
        )

    base_by_task = {result.task_id: result for result in base.results}
    tuned_by_task = {result.task_id: result for result in tuned.results}
    task_deltas = {
        task_id: tuned_by_task[task_id].score - base_by_task[task_id].score
        for task_id in sorted(set(base_by_task) & set(tuned_by_task))
    }

    regressions = tuple(
        family.task_family for family in families if family.is_regression(tolerance)
    )
    improvements = tuple(
        family.task_family for family in families if family.delta > tolerance
    )

    return ComparisonReport(
        base_model=base.model_name,
        tuned_model=tuned.model_name,
        base_timestamp=base.timestamp,
        tuned_timestamp=tuned.timestamp,
        overall_delta=tuned.aggregate_score - base.aggregate_score,
        families=tuple(families),
        task_deltas=task_deltas,
        regressions=regressions,
        improvements=improvements,
        tolerance=tolerance,
        metadata={
            "base_aggregate_score": base.aggregate_score,
            "tuned_aggregate_score": tuned.aggregate_score,
            "base_pass_rate": base.pass_rate,
            "tuned_pass_rate": tuned.pass_rate,
        },
    )


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render_markdown(report: EvalReport, include_failures: int = 10) -> str:
    """Render a report as Markdown for a run log or a PR comment.

    Everything here is a direct projection of the report's own numbers. The
    renderer adds no interpretation and no rounding that would hide a zero.
    """

    lines = [
        f"# Evaluation report: {report.model_name}",
        "",
        f"- Timestamp (UTC): {report.timestamp}",
        f"- Tasks: {report.total_tasks} ({report.passed_tasks} passed, {report.failed_tasks} failed)",
        f"- Aggregate score (weighted): {report.aggregate_score:.4f}",
        f"- Pass rate (unweighted): {report.pass_rate:.4f}",
        f"- Wall clock: {report.duration_seconds:.2f}s",
    ]
    if report.errored_tasks:
        lines.append(f"- Tasks with no answer: {report.errored_tasks}")
    lines += ["", "## By task family", "", "| Family | Tasks | Passed | Score |", "| --- | --- | --- | --- |"]
    for family, entry in report.by_family.items():
        lines.append(
            f"| {family} | {int(entry['tasks'])} | {int(entry['passed'])} | {entry['aggregate_score']:.4f} |"
        )
    lines += ["", "## By language", "", "| Language | Tasks | Passed | Score |", "| --- | --- | --- | --- |"]
    for language, entry in report.by_language.items():
        lines.append(
            f"| {language} | {int(entry['tasks'])} | {int(entry['passed'])} | {entry['aggregate_score']:.4f} |"
        )
    if include_failures and report.failures:
        lines += ["", f"## First {min(include_failures, len(report.failures))} failing tasks", ""]
        for result in report.failures[:include_failures]:
            lines.append(f"- `{result.task_id}` (score {result.score:.2f}): {result.detail}")
    return "\n".join(lines) + "\n"


def render_leaderboard(reports: Sequence[EvalReport]) -> str:
    """Render several reports as one Markdown comparison table."""

    lines = [
        "| Model | Tasks | Passed | Pass rate | Aggregate score |",
        "| --- | --- | --- | --- | --- |",
    ]
    for report in reports:
        lines.append(
            f"| {report.model_name} | {report.total_tasks} | {report.passed_tasks} "
            f"| {report.pass_rate:.4f} | {report.aggregate_score:.4f} |"
        )
    return "\n".join(lines) + "\n"


def describe_exception(exc: BaseException) -> str:
    """Render an exception with its traceback for a run log."""

    return "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
