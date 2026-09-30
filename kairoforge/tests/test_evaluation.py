"""Tests for the KairoForge evaluation harness.

These tests do three distinct jobs, and it is worth keeping them separate:

1. **Suite integrity** - the task suite covers the families and languages it
   claims to, has unique ids, and every reference answer actually satisfies
   its own checker. A task whose reference fails its own check is a broken
   measuring instrument, so that is asserted, not hoped for.
2. **Checker behaviour** - each checker is exercised on a positive *and* a
   negative response, and ``python-exec`` is proven to kill an infinite loop
   rather than hang the suite.
3. **Runner/comparison mechanics** - aggregation arithmetic, breakdowns, and
   that a deliberate regression is detected.

Every test here runs against a stub ``model_call``. No test asserts anything
about a real model's quality, and none could: the harness measures whatever it
is pointed at.
"""

from __future__ import annotations

import time

import pytest

from kairoforge.data.schema import SUPPORTED_LANGUAGES, TASK_FAMILIES
from kairoforge.evaluation import (
    BUILTIN_TASKS,
    CHECKERS,
    REQUIRED_FAMILIES,
    REQUIRED_LANGUAGES,
    CheckResult,
    CheckerError,
    EvalReport,
    EvalTask,
    UnknownCheckerError,
    check_contains,
    check_exact,
    check_python_exec,
    check_regex,
    check_response,
    check_rubric,
    compare_reports,
    extract_python_code,
    render_leaderboard,
    render_markdown,
    run_evaluation,
    select_tasks,
    suite_coverage,
    tasks_by_family,
    tasks_by_language,
    validate_suite,
)

# ---------------------------------------------------------------------------
# 1. Suite integrity
# ---------------------------------------------------------------------------


def test_suite_meets_declared_families_and_languages() -> None:
    """All required families and languages are present, with no gaps reported."""

    coverage = suite_coverage()
    assert coverage["missing_families"] == [], coverage["missing_families"]
    assert coverage["missing_languages"] == [], coverage["missing_languages"]
    for family in REQUIRED_FAMILIES:
        assert tasks_by_family(family), f"no task in family {family!r}"
    for language in REQUIRED_LANGUAGES:
        assert tasks_by_language(language), f"no task in language {language!r}"


def test_suite_size_and_unique_ids() -> None:
    """The suite is large enough to discriminate, and ids are unique."""

    assert len(BUILTIN_TASKS) >= 30
    validate_suite()  # raises on duplicates or coverage gaps
    ids = [task.id for task in BUILTIN_TASKS]
    assert len(ids) == len(set(ids))


def test_suite_declares_only_canonical_families_and_languages() -> None:
    """Every task uses a family and language from the canonical schema."""

    for task in BUILTIN_TASKS:
        assert task.task_family in TASK_FAMILIES, task.id
        assert task.language in SUPPORTED_LANGUAGES, task.id
        assert task.checker in CHECKERS, task.id


def test_every_task_has_a_real_prompt_and_reference() -> None:
    """No task is a placeholder: prompts carry substance, references are answers.

    A reference may legitimately be short (the exact answer to "print the
    working directory" is `pwd`), so length is not asserted directly. What is
    asserted is that the reference is a non-trivial answer: it either passes
    the task's own checker, or is one of the handful of deliberately terse
    exact-match answers, each of which is listed here.
    """

    terse_exact_answers = {"instruction-following-no-conversational-preamble"}
    for task in BUILTIN_TASKS:
        assert len(task.prompt) >= 80, f"{task.id} prompt is too thin to be a real task"
        assert task.reference.strip(), f"{task.id} has an empty reference"
        assert task.weight > 0
        if task.id not in terse_exact_answers:
            assert len(task.reference) >= 20, f"{task.id} reference is too thin to check against"
        else:
            assert task.checker == "exact", f"{task.id} must be a terse exact-match task"


def test_every_reference_answer_satisfies_its_own_checker() -> None:
    """The ground truth must pass the check the model is held to.

    This is the single most important test in the file: a checker that rejects
    its own reference cannot measure anything, and if this ever fails the
    reported scores for that task are meaningless.
    """

    failures = []
    for task in BUILTIN_TASKS:
        result = check_response(task.reference, task)
        if not result.passed:
            failures.append(f"{task.id}: {result.detail}")
    assert failures == [], "reference answers failed their own checker:\n" + "\n".join(failures)


def test_python_exec_references_are_actually_executed() -> None:
    """The subprocess path is exercised by the suite, not just the string path."""

    executable = [task for task in BUILTIN_TASKS if task.checker == "python-exec"]
    assert len(executable) >= 4
    for task in executable:
        result = check_response(task.reference, task)
        assert result.passed, task.id
        assert result.evidence.get("returncode") == 0, task.id


def test_select_tasks_filters_compose() -> None:
    """Family, language and id filters compose as AND."""

    python_debugging = select_tasks(families=("debugging",), languages=("python",))
    assert python_debugging
    assert all(task.task_family == "debugging" and task.language == "python" for task in python_debugging)

    explicit = select_tasks(ids=(BUILTIN_TASKS[0].id,))
    assert explicit == (BUILTIN_TASKS[0],)

    assert select_tasks(families=("no-such-family",)) == ()


def test_eval_task_rejects_invalid_definitions() -> None:
    """A malformed task fails at construction rather than silently scoring."""

    base = dict(
        id="t",
        task_family="debugging",
        language="python",
        prompt="p",
        reference="r",
        checker="exact",
    )
    with pytest.raises(ValueError, match="unknown task_family"):
        EvalTask(**{**base, "task_family": "not-a-family"})
    with pytest.raises(ValueError, match="unknown language"):
        EvalTask(**{**base, "language": "cobol"})
    with pytest.raises(ValueError, match="unknown checker"):
        EvalTask(**{**base, "checker": "vibes"})
    with pytest.raises(ValueError, match="weight must be positive"):
        EvalTask(**{**base, "weight": 0.0})
    with pytest.raises(ValueError, match="id must be non-empty"):
        EvalTask(**{**base, "id": ""})


# ---------------------------------------------------------------------------
# 2. Checkers: positive and negative cases
# ---------------------------------------------------------------------------


def test_exact_checker_positive_and_negative() -> None:
    """``exact`` normalises whitespace, honours case folding, and rejects other text."""

    assert check_exact("  Hello   World \n", "hello world").passed
    assert check_exact("HELLO WORLD", "hello world", {"case_sensitive": True}).passed is False
    assert check_exact("hello world", "hello world", {"case_sensitive": True}).passed

    miss = check_exact("hello there", "hello world")
    assert miss.passed is False
    assert miss.score == 0.0
    assert "does not match" in miss.detail

    fenced = check_exact("```json\n{\"a\": 1}\n```", '{"a": 1}', {"strip_code_fence": True})
    assert fenced.passed, fenced.detail


def test_exact_checker_multiline_vs_collapsed() -> None:
    """Collapsing whitespace is the default; it can be turned off."""

    assert check_exact("a\n\nb", "a b").passed
    assert check_exact("a\n\nb", "a b", {"collapse_whitespace": False}).passed is False


def test_contains_checker_any_of_and_all_of() -> None:
    """``any_of`` needs one hit, ``all_of`` needs every hit and scores fractionally."""

    hit = check_contains("use git switch -c feature", "x", {"any_of": ["git switch -c", "git checkout -b"]})
    assert hit.passed and hit.score == 1.0

    miss = check_contains("use git branch", "x", {"any_of": ["git switch -c", "git checkout -b"]})
    assert miss.passed is False
    assert miss.score == 0.0
    assert miss.evidence["missing"]

    partial = check_contains("alpha beta", "x", {"all_of": ["alpha", "beta", "gamma"]})
    assert partial.passed is False
    assert partial.score == pytest.approx(2 / 3)
    assert partial.evidence["missing"] == ["gamma"]

    complete = check_contains("alpha beta gamma", "x", {"all_of": ["alpha", "beta", "gamma"]})
    assert complete.passed and complete.score == 1.0


def test_contains_checker_defaults_to_reference_and_case_folding() -> None:
    """With no ``any_of``/``all_of``, the reference itself is the fragment."""

    assert check_contains("I would use PWD here", "pwd").passed
    assert check_contains("I would use ls here", "pwd").passed is False


def test_contains_checker_rejects_conflicting_arguments() -> None:
    """``any_of`` and ``all_of`` are different questions and cannot both be set."""

    with pytest.raises(CheckerError, match="both"):
        check_contains("text", "x", {"any_of": ["a"], "all_of": ["a"]})


def test_regex_checker_positive_and_negative() -> None:
    """``regex`` matches the pattern and respects ``count``."""

    # Anchored with \A...\Z so an extra trailing line cannot satisfy it. A
    # pattern using ^...$ would match only its first three lines and silently
    # accept a four-bullet answer, which is exactly the failure mode this task
    # exists to catch.
    pattern = r"\A- [^\n]+\n- [^\n]+\n- [^\n]+\Z"
    good = "- one\n- two\n- three"
    assert check_regex(good, "", {"pattern": pattern, "strip_code_fence": True}).passed
    assert check_regex("- one\n- two", "", {"pattern": pattern, "strip_code_fence": True}).passed is False
    assert (
        check_regex("- one\n- two\n- three\n- four", "", {"pattern": pattern, "strip_code_fence": True}).passed
        is False
    )
    assert check_regex("ok", "", {"pattern": "ok", "count": 2}).passed is False

    with pytest.raises(CheckerError, match="not a valid regex"):
        check_regex("x", "", {"pattern": "([unclosed"})


def test_regex_checker_falls_back_to_reference_as_pattern() -> None:
    """``reference`` doubles as the pattern when ``checker_args`` omits it."""

    assert check_regex("run `git status` now", r"git\s+status").passed
    assert check_regex("run `git commit` now", r"git\s+status").passed is False


def test_rubric_checker_graded_scoring() -> None:
    """``rubric`` returns the fraction of required items found."""

    args = {"required": ["alpha", "beta", "gamma", "delta"]}
    full = check_rubric("alpha beta gamma delta", "", args)
    assert full.passed and full.score == 1.0

    half = check_rubric("alpha beta only", "", args)
    assert half.passed is False
    assert half.score == pytest.approx(0.5)
    assert half.evidence["missing"] == ["gamma", "delta"]

    nothing = check_rubric("unrelated text", "", args)
    assert nothing.score == 0.0

    # Whitespace reflow in the response must not break a fragment match.
    reflowed = check_rubric("alpha\n\n  beta gamma delta", "", args)
    assert reflowed.passed


def test_rubric_checker_penalises_forbidden_content() -> None:
    """A forbidden fragment is a hard failure even at full coverage."""

    args = {"required": ["for f in ./*.log"], "forbidden": ["$(ls"]}
    assert check_rubric("for f in ./*.log; do gzip -- \"$f\"; done", "", args).passed
    dirty = check_rubric("for f in $(ls *.log); do gzip $f; done", "", args)
    assert dirty.passed is False
    assert dirty.evidence["violations"] == ["$(ls"]


def test_rubric_checker_threshold_and_patterns() -> None:
    """``pass_threshold`` moves the pass line; a pass still contributes a full point."""

    args = {"required": ["alpha", "beta"], "pass_threshold": 0.5}
    partial = check_rubric("only alpha here", "", args)
    assert partial.passed is True
    assert partial.score == 1.0  # pass and score are kept consistent
    assert "1/2" in partial.detail  # the raw coverage is still reported honestly

    below = check_rubric("nothing relevant at all", "", args)
    assert below.passed is False

    pattern_args = {"required": ['"tool"'], "required_patterns": [r"\{.*\}\s*$"]}
    assert check_rubric('{"tool": "search"}', "", pattern_args).passed
    assert check_rubric('{"tool": "search"} trailing prose', "", pattern_args).passed is False


def test_rubric_checker_rejects_malformed_arguments() -> None:
    """A mis-specified rubric is a harness bug and raises rather than scoring 0."""

    with pytest.raises(CheckerError, match="required"):
        check_rubric("x", "", {"required": []})
    with pytest.raises(CheckerError, match="pass_threshold"):
        check_rubric("x", "", {"required": ["a"], "pass_threshold": 0})
    with pytest.raises(CheckerError, match="not a valid regex"):
        check_rubric("x", "", {"required": ["a"], "required_patterns": ["([bad"]})


def test_unknown_checker_is_refused() -> None:
    """Dispatching an unimplemented checker raises instead of guessing."""

    task = EvalTask(
        id="unknown-checker",
        task_family="debugging",
        language="python",
        prompt="do something",
        reference="something",
        checker="exact",
    )
    with pytest.raises(UnknownCheckerError):
        check_response("something", task, checker="vibes")


def test_check_result_keeps_pass_and_score_consistent() -> None:
    """A passing result always carries full score, so counts and scores agree."""

    result = CheckResult(passed=True, score=0.4, detail="inconsistent on purpose")
    assert result.score == 1.0
    with pytest.raises(ValueError):
        CheckResult(passed=False, score=1.5, detail="out of range")


# ---------------------------------------------------------------------------
# python-exec: extraction, success, failure, and the timeout
# ---------------------------------------------------------------------------


def test_extract_python_code_prefers_tagged_fences() -> None:
    """Extraction finds Python in fenced blocks and ignores surrounding prose."""

    response = (
        "Here is the function:\n\n"
        "```python\ndef f():\n    return 1\n```\n\n"
        "Let me know if you want tests."
    )
    assert extract_python_code(response).strip() == "def f():\n    return 1"

    untagged = "```\ndef g():\n    return 2\n```"
    assert "def g" in extract_python_code(untagged)

    directive = (
        "```python\n```\n\n"
        "```python\n# eval:only\ndef h():\n    return 3\n```"
    )
    assert extract_python_code(directive).strip().startswith("# eval:only")


def test_extract_python_code_refuses_a_response_without_code() -> None:
    """No code found is an explicit failure, not an empty program."""

    with pytest.raises(CheckerError, match="no executable Python"):
        extract_python_code("I would rather describe the approach in prose.")


def test_python_exec_runs_and_checks_stdout() -> None:
    """A correct program passes; a wrong one is reported with the real output."""

    args = {
        "test_code": "print(double(21))",
        "expect_stdout": "42",
        "timeout_seconds": 10,
    }
    good = "```python\ndef double(n):\n    return n * 2\n```"
    ok = check_python_exec(good, "", args)
    assert ok.passed and ok.score == 1.0
    assert ok.evidence["stdout"].strip() == "42"

    bad = "```python\ndef double(n):\n    return n + 2\n```"
    wrong = check_python_exec(bad, "", args)
    assert wrong.passed is False
    assert wrong.score == 0.0
    assert "did not match" in wrong.detail

    broken = "```python\ndef double(n):\n    return n *\n```"
    traceback_result = check_python_exec(broken, "", args)
    assert traceback_result.passed is False
    assert "exited with status" in traceback_result.detail
    assert "SyntaxError" in traceback_result.evidence["stderr"]


def test_python_exec_reports_uncaught_exceptions() -> None:
    """An exception in model code is a failed check carrying the traceback."""

    args = {"test_code": "print(boom())", "expect_stdout": "1"}
    response = "```python\ndef boom():\n    raise ValueError('nope')\n```"
    result = check_python_exec(response, "", args)
    assert result.passed is False
    assert result.evidence["returncode"] != 0
    assert "ValueError" in result.evidence["stderr"]


def test_python_exec_requires_an_expectation() -> None:
    """Executing code with nothing to compare against is a task-authoring error."""

    with pytest.raises(CheckerError, match="expect_stdout"):
        check_python_exec("```python\nx = 1\n```", "", {})


def test_python_exec_rejects_an_infinite_loop_via_timeout() -> None:
    """A non-terminating program is killed by the wall-clock timeout.

    The budget is deliberately tiny (0.6s) so the test proves the timeout path
    rather than slowing the suite down. The assertion is on the *elapsed*
    time as well as the result, because a harness that hangs is worse than one
    that fails: it never produces a report at all.
    """

    response = "```python\nwhile True:\n    pass\n```"
    started = time.perf_counter()
    result = check_python_exec(
        response,
        "",
        {"test_code": "print('never reached')", "expect_stdout": "never reached", "timeout_seconds": 0.6},
    )
    elapsed = time.perf_counter() - started

    assert result.passed is False
    assert result.score == 0.0
    assert "did not finish within" in result.detail
    assert result.evidence["returncode"] is None
    assert elapsed < 15, f"timeout took {elapsed:.1f}s; the subprocess was not killed"


def test_python_exec_isolates_the_child_environment() -> None:
    """The child gets a private sys.path and HOME, and cannot import the harness.

    This asserts the isolation claims made in the module docstring at the level
    they are actually guaranteed - process and path isolation - and makes no
    claim about filesystem confinement, which this checker does not provide.
    """

    args = {
        "test_code": (
            "import os, sys\n"
            "print('KAIROFORGE_IMPORTABLE=' + str(any(p.endswith('kairoforge') for p in sys.path)))\n"
            "print('HOME_IS_CWD=' + str(os.path.realpath(os.environ.get('HOME', '')) == os.path.realpath(os.getcwd())))\n"
            "print('CWD_EXISTS=' + str(os.path.isdir(os.getcwd())))\n"
            "print('PATH_MINIMAL=' + str(os.environ.get('PATH') == '/usr/bin:/bin'))\n"
            "print('CHILD_PID_DIFFERS=' + str(os.getpid() != PARENT_PID))"
        ),
        "isolated_prefix": "import os\nPARENT_PID = os.getppid()\n",
        # Built from the same list the program prints, so the test asserts
        # *where* the child ran rather than how the '|'-separated expectation
        # string happens to be spelled.
        "expect_stdout": "|".join(
            [
                "KAIROFORGE_IMPORTABLE=False",
                "HOME_IS_CWD=True",
                "CWD_EXISTS=True",
                "PATH_MINIMAL=True",
                "CHILD_PID_DIFFERS=True",
            ]
        ),
    }
    result = check_python_exec("```python\nx = 1\n```", "", args, task_id="isolation-probe")
    assert result.passed, f"{result.detail}\nstdout: {result.evidence['stdout']!r}\nstderr: {result.evidence['stderr']}"


def test_python_exec_survives_a_runaway_loop() -> None:
    """A CPU bomb is killed by the CPU resource limit, not left spinning.

    ``RLIMIT_CPU`` fires before the wall-clock timeout here, which is the point:
    the process is stopped by the kernel rather than waiting for the parent's
    timer. Either way the harness records a hard failure with a reason.
    """

    response = (
        "```python\n"
        "total = 0\n"
        "while True:\n"
        "    total += 1\n"
        "print(total)\n"
        "```"
    )
    started = time.perf_counter()
    result = check_python_exec(
        response,
        "",
        {
            "test_code": "print('never reached')",
            "expect_stdout": "never reached",
            "timeout_seconds": 6,
            "cpu_seconds": 1,
        },
    )
    elapsed = time.perf_counter() - started

    assert result.passed is False
    assert result.score == 0.0
    assert elapsed < 15, f"CPU bomb took {elapsed:.1f}s to contain"
    assert result.evidence["returncode"] != 0 or "did not finish" in result.detail


# ---------------------------------------------------------------------------
# 3. Runner
# ---------------------------------------------------------------------------


def _stub_task(task_id: str, family: str, language: str, checker: str, **checker_args):
    """Build a small synthetic task for runner arithmetic tests."""

    return EvalTask(
        id=task_id,
        task_family=family,
        language=language,
        prompt=f"prompt for {task_id}",
        reference=checker_args.pop("reference", "ref"),
        checker=checker,
        checker_args=checker_args,
    )


def test_runner_aggregates_scores_and_counts() -> None:
    """Aggregate score, pass counts and per-family breakdown match hand arithmetic."""

    tasks = (
        _stub_task("a", "debugging", "python", "contains", any_of=["alpha"]),
        _stub_task("b", "debugging", "python", "contains", any_of=["beta"]),
        _stub_task("c", "refactoring", "rust", "contains", any_of=["gamma"]),
        _stub_task("d", "refactoring", "rust", "contains", any_of=["delta"]),
    )
    answers = {
        "a": "alpha is the answer",
        "b": "no match here",
        "c": "gamma yes",
        "d": "delta yes",
    }
    report = run_evaluation(lambda prompt: answers[prompt.split()[-1]], tasks, model_name="stub")

    assert isinstance(report, EvalReport)
    assert report.model_name == "stub"
    assert report.total_tasks == 4
    assert report.passed_tasks == 3
    assert report.failed_tasks == 1
    assert report.errored_tasks == 0
    assert report.aggregate_score == pytest.approx(0.75)
    assert report.pass_rate == pytest.approx(0.75)

    assert report.by_family["debugging"]["tasks"] == 2
    assert report.by_family["debugging"]["passed"] == 1
    assert report.by_family["debugging"]["aggregate_score"] == pytest.approx(0.5)
    assert report.by_family["refactoring"]["aggregate_score"] == pytest.approx(1.0)

    assert report.by_language["python"]["aggregate_score"] == pytest.approx(0.5)
    assert report.by_language["rust"]["aggregate_score"] == pytest.approx(1.0)

    assert [result.task_id for result in report.failures] == ["b"]
    assert report.timestamp.endswith("+00:00") or report.timestamp.endswith("Z")
    assert report.duration_seconds >= 0


def test_runner_honours_task_weights() -> None:
    """A heavily weighted task moves the aggregate more than a light one."""

    tasks = (
        _stub_task("heavy", "debugging", "python", "contains", any_of=["yes"]),
        _stub_task("light", "debugging", "python", "contains", any_of=["yes"]),
    )
    tasks = (
        EvalTask(**{**tasks[0].as_dict(), "weight": 3.0}),
        tasks[1],
    )
    report = run_evaluation(
        lambda prompt: "yes" if prompt.endswith("heavy") else "no",
        tasks,
        model_name="stub",
    )
    assert report.aggregate_score == pytest.approx(0.75)
    assert report.pass_rate == pytest.approx(0.5)  # unweighted counts stay honest


def test_runner_records_and_raises_on_model_failure() -> None:
    """A raising model aborts by default and can be recorded on request."""

    tasks = (_stub_task("a", "debugging", "python", "contains", any_of=["alpha"]),)

    def exploding(prompt: str) -> str:
        raise RuntimeError("endpoint down")

    with pytest.raises(Exception) as excinfo:
        run_evaluation(exploding, tasks, model_name="flaky")
    assert "endpoint down" in str(excinfo.value)

    recorded = run_evaluation(exploding, tasks, model_name="flaky", on_error="record")
    assert recorded.total_tasks == 1
    assert recorded.errored_tasks == 1
    assert recorded.aggregate_score == 0.0
    assert recorded.results[0].error is not None
    assert "endpoint down" in recorded.results[0].detail

    with pytest.raises(ValueError, match="on_error"):
        run_evaluation(exploding, tasks, on_error="ignore")


def test_runner_rejects_a_non_callable_model() -> None:
    """The runner refuses to accept anything that is not prompt -> str."""

    with pytest.raises(TypeError):
        run_evaluation("not callable", (), model_name="x")  # type: ignore[arg-type]


def test_runner_on_empty_task_list_is_zero_not_undefined() -> None:
    """An empty suite yields 0.0 rather than a ZeroDivisionError or a fake perfect score."""

    report = run_evaluation(lambda prompt: "anything", (), model_name="empty")
    assert report.total_tasks == 0
    assert report.aggregate_score == 0.0
    assert report.pass_rate == 0.0


def test_report_serialises_and_renders() -> None:
    """Reports serialise to JSON and render to Markdown without inventing numbers."""

    tasks = (
        _stub_task("a", "debugging", "python", "contains", any_of=["alpha"]),
        _stub_task("b", "refactoring", "rust", "contains", any_of=["beta"]),
    )
    report = run_evaluation(
        lambda prompt: "alpha" if prompt.endswith("a") else "nope",
        tasks,
        model_name="stub",
    )
    payload = report.as_dict()
    assert payload["aggregate_score"] == pytest.approx(0.5)
    assert payload["results"][0]["task_id"] == "a"
    assert "aggregate_score" in report.to_json()

    markdown = render_markdown(report)
    assert "stub" in markdown
    assert "0.5000" in markdown
    assert "debugging" in markdown

    board = render_leaderboard([report])
    assert "| Model |" in board


# ---------------------------------------------------------------------------
# 4. Comparison
# ---------------------------------------------------------------------------


def _two_family_tasks():
    """Two families so a regression can be isolated to one of them."""

    return (
        _stub_task("dbg-1", "debugging", "python", "contains", any_of=["fix"]),
        _stub_task("dbg-2", "debugging", "python", "contains", any_of=["fix"]),
        _stub_task("ref-1", "refactoring", "python", "contains", any_of=["clean"]),
        _stub_task("ref-2", "refactoring", "python", "contains", any_of=["clean"]),
    )


def _answer_with(quality: dict) -> object:
    """Build a model_call that answers per task id, keyed off the prompt suffix."""

    def call(prompt: str) -> str:
        task_id = prompt.split()[-1]
        return quality.get(task_id, "")

    return call


def test_comparison_detects_an_overall_improvement() -> None:
    """A tuned model that fixes more tasks shows a positive overall delta."""

    tasks = _two_family_tasks()
    base = run_evaluation(_answer_with({"dbg-1": "fix", "ref-1": "clean"}), tasks, model_name="base")
    tuned = run_evaluation(
        _answer_with({"dbg-1": "fix", "dbg-2": "fix", "ref-1": "clean", "ref-2": "clean"}),
        tasks,
        model_name="tuned",
    )

    comparison = compare_reports(base, tuned)
    assert comparison.base_model == "base"
    assert comparison.tuned_model == "tuned"
    assert comparison.overall_delta == pytest.approx(0.5)
    assert comparison.improved
    assert comparison.regressions == ()
    assert set(comparison.improvements) == {"debugging", "refactoring"}
    assert comparison.task_deltas["dbg-2"] == pytest.approx(1.0)


def test_comparison_flags_a_regression_in_one_family() -> None:
    """A family that gets worse is reported as a regression, not averaged away."""

    tasks = _two_family_tasks()
    base = run_evaluation(
        _answer_with({"dbg-1": "fix", "dbg-2": "fix", "ref-1": "clean"}),
        tasks,
        model_name="base",
    )
    tuned = run_evaluation(
        _answer_with({"ref-1": "clean", "ref-2": "clean"}),
        tasks,
        model_name="tuned",
    )

    comparison = compare_reports(base, tuned)
    assert "debugging" in comparison.regressions
    assert comparison.regressed
    assert "refactoring" in comparison.improvements

    debugging = next(family for family in comparison.families if family.task_family == "debugging")
    assert debugging.base_score == pytest.approx(1.0)
    assert debugging.tuned_score == pytest.approx(0.0)
    assert debugging.delta == pytest.approx(-1.0)
    assert debugging.is_regression()

    worst = comparison.worst_regressions()
    assert worst and worst[0].task_family == "debugging"


def test_comparison_tolerance_suppresses_small_dips() -> None:
    """Tolerance is the caller's knob for treating noise as noise."""

    tasks = (
        _stub_task("a", "debugging", "python", "rubric", required=["x", "y", "z", "w"]),
    )
    base = run_evaluation(lambda prompt: "x y z w", tasks, model_name="base")
    tuned = run_evaluation(lambda prompt: "x y z", tasks, model_name="tuned")

    strict = compare_reports(base, tuned)
    assert strict.regressions == ("debugging",)
    assert strict.overall_delta == pytest.approx(-0.25)

    lenient = compare_reports(base, tuned, tolerance=0.3)
    assert lenient.regressions == ()
    assert lenient.overall_delta == pytest.approx(-0.25)  # the delta is never hidden


def test_comparison_refuses_mismatched_suites() -> None:
    """A delta across different questions would measure the questions."""

    short = (_stub_task("a", "debugging", "python", "contains", any_of=["x"]),)
    long = short + (_stub_task("b", "debugging", "python", "contains", any_of=["x"]),)

    base = run_evaluation(lambda prompt: "x", short, model_name="base")
    tuned = run_evaluation(lambda prompt: "x", long, model_name="tuned")

    with pytest.raises(ValueError, match="different task suites"):
        compare_reports(base, tuned)

    permissive = compare_reports(base, tuned, require_same_tasks=False)
    assert set(permissive.task_deltas) == {"a"}


def test_comparison_refuses_a_self_comparison() -> None:
    """Comparing a report with itself is almost always a caller bug."""

    report = run_evaluation(lambda prompt: "x", _two_family_tasks(), model_name="same")
    with pytest.raises(ValueError, match="same report twice"):
        compare_reports(report, report)


def test_comparison_rejects_negative_tolerance() -> None:
    """A negative tolerance would call noise an improvement."""

    tasks = _two_family_tasks()
    base = run_evaluation(lambda prompt: "fix", tasks, model_name="base")
    tuned = run_evaluation(lambda prompt: "fix clean", tasks, model_name="tuned")
    with pytest.raises(ValueError, match="tolerance"):
        compare_reports(base, tuned, tolerance=-0.1)


def test_comparison_report_serialises() -> None:
    """The comparison report round-trips through JSON-ready structures."""

    tasks = _two_family_tasks()
    base = run_evaluation(_answer_with({"dbg-1": "fix"}), tasks, model_name="base")
    tuned = run_evaluation(_answer_with({"ref-1": "clean"}), tasks, model_name="tuned")
    comparison = compare_reports(base, tuned)

    payload = comparison.as_dict()
    assert payload["base_model"] == "base"
    assert "overall_delta" in payload
    assert isinstance(payload["families"], list)
    assert "regressions" in comparison.to_json()


# ---------------------------------------------------------------------------
# 5. Full-suite smoke test against a deliberately weak stub
# ---------------------------------------------------------------------------


def test_runner_is_deterministic_given_the_same_responses() -> None:
    """Two runs over identical responses produce identical scores and counts.

    Only timestamps and per-task latency may differ. A harness whose scores move
    between identical runs cannot support an A/B comparison, so this is pinned
    rather than assumed. The stub also proves the runner does not mutate the
    task suite it was handed.
    """

    before = [task.as_dict() for task in BUILTIN_TASKS]
    answers = {task.prompt: task.reference for task in BUILTIN_TASKS}
    first = run_evaluation(lambda prompt: answers[prompt], BUILTIN_TASKS, model_name="echo")
    second = run_evaluation(lambda prompt: answers[prompt], BUILTIN_TASKS, model_name="echo")

    assert first.aggregate_score == second.aggregate_score
    assert first.passed_tasks == second.passed_tasks == len(BUILTIN_TASKS)
    assert [(r.task_id, r.score, r.passed) for r in first.results] == [
        (r.task_id, r.score, r.passed) for r in second.results
    ]
    assert [task.as_dict() for task in BUILTIN_TASKS] == before


def test_echoing_the_reference_scores_perfectly() -> None:
    """A model that reproduces the ground truth scores 1.0 across the whole suite.

    This is the ceiling check for the harness itself: it confirms the suite is
    satisfiable end to end (including the subprocess-backed tasks) without the
    checker configuration contradicting itself anywhere.
    """

    answers = {task.prompt: task.reference for task in BUILTIN_TASKS}
    report = run_evaluation(lambda prompt: answers[prompt], BUILTIN_TASKS, model_name="oracle")
    assert report.failed_tasks == 0, [
        (result.task_id, result.detail) for result in report.failures
    ]
    assert report.aggregate_score == pytest.approx(1.0)


def test_full_suite_runs_against_a_stub_model() -> None:
    """The real 30+ task suite executes end to end and scores a stub at zero.

    This is a wiring test, not a model claim: a stub that answers with a fixed
    non-answer string must score 0.0, because every task's reference demands
    real content. If this ever returns a non-zero score, a checker has started
    passing responses it should not.
    """

    report = run_evaluation(
        lambda prompt: "I am not sure how to answer that.",
        BUILTIN_TASKS,
        model_name="unhelpful-stub",
    )
    assert report.total_tasks == len(BUILTIN_TASKS)
    assert report.passed_tasks == 0
    assert report.aggregate_score == 0.0
    assert report.by_family.keys() == {task.task_family for task in BUILTIN_TASKS}
