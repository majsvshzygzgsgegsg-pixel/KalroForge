"""KairoForge evaluation harness.

This package answers one question honestly: *does the trained model actually
perform the coding tasks KairoForge claims to support?* It does that by
scoring model responses against a held-out suite of tasks with
machine-checkable references, and by comparing a tuned run against the
untouched base model family by family.

The harness is a measurement instrument, not a generator of results. It never
synthesises a score, never falls back to a "looks reasonable" heuristic when a
checker errors, and refuses to compare runs over different task sets. A run
with no checkpoint available produces no report - see
:func:`kairoforge.evaluation.__init__` consumers such as
``scripts/evaluate.py``, which still emits an explicit dry-run marker rather
than a fabricated score.

Typical use::

    from kairoforge.evaluation import BUILTIN_TASKS, run_evaluation, compare_reports

    base = run_evaluation(call_base_model, BUILTIN_TASKS, model_name="qwen2.5-coder-7b")
    tuned = run_evaluation(call_kairoforge, BUILTIN_TASKS, model_name="kairoforge-v0.1")
    comparison = compare_reports(base, tuned)
    print(comparison.overall_delta, comparison.regressions)

Both ``call_base_model`` and ``call_kairoforge`` are plain
``(prompt: str) -> str`` callables supplied by the caller, so this package
imports no ML stack and no HTTP client. That keeps it runnable - and testable -
on a machine where torch is not installed.

Isolation caveat for the ``python-exec`` checker: model-authored code runs in a
subprocess with a wall-clock timeout, POSIX resource limits and an isolated
``sys.path``, but that is accident containment, not a security sandbox. See
:mod:`kairoforge.evaluation.checkers` for the exact guarantees.
"""

from __future__ import annotations

from kairoforge.evaluation.checkers import (
    CHECKS,
    DEFAULT_EXEC_TIMEOUT_SECONDS,
    CheckerError,
    CheckResult,
    UnknownCheckerError,
    check_contains,
    check_exact,
    check_python_exec,
    check_regex,
    check_response,
    check_rubric,
    extract_python_code,
)
from kairoforge.evaluation.runner import (
    ComparisonReport,
    EvalReport,
    FamilyDelta,
    ModelCall,
    ModelCallError,
    TaskResult,
    compare_reports,
    describe_exception,
    render_leaderboard,
    render_markdown,
    run_evaluation,
)
from kairoforge.evaluation.tasks import (
    BUILTIN_TASKS,
    CHECKERS,
    REQUIRED_FAMILIES,
    REQUIRED_LANGUAGES,
    EvalTask,
    select_tasks,
    suite_coverage,
    tasks_by_family,
    tasks_by_language,
    validate_suite,
)

__all__ = [
    # tasks
    "EvalTask",
    "BUILTIN_TASKS",
    "CHECKERS",
    "REQUIRED_FAMILIES",
    "REQUIRED_LANGUAGES",
    "select_tasks",
    "suite_coverage",
    "tasks_by_family",
    "tasks_by_language",
    "validate_suite",
    # checkers
    "CheckResult",
    "CheckerError",
    "UnknownCheckerError",
    "CHECKS",
    "DEFAULT_EXEC_TIMEOUT_SECONDS",
    "check_exact",
    "check_contains",
    "check_regex",
    "check_python_exec",
    "check_rubric",
    "check_response",
    "extract_python_code",
    # runner
    "ModelCall",
    "ModelCallError",
    "TaskResult",
    "EvalReport",
    "FamilyDelta",
    "ComparisonReport",
    "run_evaluation",
    "compare_reports",
    "render_markdown",
    "render_leaderboard",
    "describe_exception",
    # legacy helper kept so scripts/evaluate.py's import keeps resolving
    "write_dry_run_report",
]

__version__ = "0.1.0"


def write_dry_run_report(path):
    """Re-export of the legacy dry-run helper.

    Defined as a thin wrapper rather than a module-level import so that the
    real evaluation surface above stays importable even if the legacy module
    is removed in a future cleanup.
    """

    from .legacy import write_dry_run_report as _impl

    return _impl(path)
