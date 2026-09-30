"""The KairoForge evaluation task suite.

This module defines the *held-out* tasks a candidate model is scored on. A
task is a prompt, a reference answer, and a machine-checkable predicate for
deciding whether a model response is correct. Nothing here is a placeholder:
every task is answerable from the prompt alone (no secrets, no network, no
repository state that is not included inline) and every task is verified by
one of the checkers in :mod:`kairoforge.evaluation.checkers`.

Design rules
------------

* ``reference`` is the *ground truth*, not a sample of "good style". For
  ``contains`` and ``rubric`` checkers it holds the required fragments; for
  ``python-exec`` it holds runnable code; for ``exact`` it holds the exact
  answer; for ``regex`` it holds a description of the required match.
* ``checker_args`` is passed through to the checker unchanged, so the task
  file never needs to know *how* a checker works, only what it needs.
* Weights default to ``1.0``. A weight below 1 is a deliberate statement that
  the task is a smoke test rather than a discriminating item.

The suite is stratified by ``task_family`` (the closed set in
:data:`kairoforge.data.schema.TASK_FAMILIES`) and by ``language`` (the closed
set in :data:`kairoforge.data.schema.SUPPORTED_LANGUAGES`) so that
:func:`kairoforge.evaluation.runner.run_evaluation` can report a per-family
and per-language breakdown.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from kairoforge.data.schema import SUPPORTED_LANGUAGES, TASK_FAMILIES

#: Checkers implemented in :mod:`kairoforge.evaluation.checkers`.
CHECKERS: tuple[str, ...] = (
    "exact",
    "contains",
    "python-exec",
    "regex",
    "rubric",
)

#: Task families the built-in suite is expected to cover. This is every family
#: that can be evaluated by a single-turn prompt/response checker, which is the
#: subset of :data:`TASK_FAMILIES` that does not require a live repository,
#: git history, or a real tool runtime.
REQUIRED_FAMILIES: tuple[str, ...] = (
    "code-generation",
    "debugging",
    "refactoring",
    "code-explanation",
    "test-generation",
    "repository-understanding",
    "terminal-reasoning",
    "tool-planning",
    "instruction-following",
)

#: Languages the built-in suite is expected to cover. Not every supported
#: language has a meaningful single-turn task family here (``markdown`` and
#: ``text`` are training-format languages, not evaluation targets).
REQUIRED_LANGUAGES: tuple[str, ...] = (
    "python",
    "typescript",
    "javascript",
    "rust",
    "go",
    "sql",
    "shell",
)


@dataclass(frozen=True)
class EvalTask:
    """One held-out evaluation item.

    Frozen so that a task cannot be mutated mid-run: the report records the
    exact task objects that produced it, and an in-place edit would make a
    stored report unreproducible.
    """

    id: str
    """Stable identifier, unique across the suite. Used as the report key."""

    task_family: str
    """One of :data:`kairoforge.data.schema.TASK_FAMILIES`."""

    language: str
    """One of :data:`kairoforge.data.schema.SUPPORTED_LANGUAGES`."""

    prompt: str
    """The instruction handed to the model, verbatim."""

    reference: str
    """Ground-truth answer, reference code, or the text a checker matches on."""

    checker: str
    """Which checker in :mod:`kairoforge.evaluation.checkers` scores this task."""

    checker_args: dict[str, Any] = field(default_factory=dict)
    """Checker-specific configuration, passed through verbatim."""

    weight: float = 1.0
    """Relative weight in the aggregate score. Must be positive."""

    def __post_init__(self) -> None:
        if not self.id:
            raise ValueError("eval task id must be non-empty")
        if self.task_family not in TASK_FAMILIES:
            raise ValueError(
                f"eval task {self.id}: unknown task_family {self.task_family!r}; "
                f"expected one of {', '.join(TASK_FAMILIES)}"
            )
        if self.language not in SUPPORTED_LANGUAGES:
            raise ValueError(
                f"eval task {self.id}: unknown language {self.language!r}; "
                f"expected one of {', '.join(SUPPORTED_LANGUAGES)}"
            )
        if self.checker not in CHECKERS:
            raise ValueError(
                f"eval task {self.id}: unknown checker {self.checker!r}; "
                f"expected one of {', '.join(CHECKERS)}"
            )
        if not self.prompt.strip():
            raise ValueError(f"eval task {self.id}: prompt must be non-empty")
        if not self.reference.strip():
            raise ValueError(f"eval task {self.id}: reference must be non-empty")
        if self.weight <= 0:
            raise ValueError(f"eval task {self.id}: weight must be positive")

    def as_dict(self) -> dict[str, Any]:
        """Serialise to a JSON-ready dict for storing alongside a report."""

        return {
            "id": self.id,
            "task_family": self.task_family,
            "language": self.language,
            "prompt": self.prompt,
            "reference": self.reference,
            "checker": self.checker,
            "checker_args": dict(self.checker_args),
            "weight": self.weight,
        }


# ---------------------------------------------------------------------------
# code-generation
# ---------------------------------------------------------------------------

_TASK_PY_FIZZBUZZ = EvalTask(
    id="codegen-python-fizzbuzz-mapping",
    task_family="code-generation",
    language="python",
    prompt=(
        "Write a Python function `fizzbuzz_label(n: int) -> str` that returns "
        "'FizzBuzz' when n is divisible by both 3 and 5, 'Fizz' when divisible "
        "by 3 only, 'Buzz' when divisible by 5 only, and otherwise the decimal "
        "string of n. Order the divisibility checks so 15 yields 'FizzBuzz'. "
        "Reply with the function in a single Python code block."
    ),
    reference=(
        "def fizzbuzz_label(n: int) -> str:\n"
        "    if n % 15 == 0:\n"
        "        return \"FizzBuzz\"\n"
        "    if n % 3 == 0:\n"
        "        return \"Fizz\"\n"
        "    if n % 5 == 0:\n"
        "        return \"Buzz\"\n"
        "    return str(n)\n"
    ),
    checker="python-exec",
    checker_args={
        "expect_stdout": "FizzBuzz|Fizz|Buzz|1|7",
        "test_code": (
            "print(fizzbuzz_label(15))\n"
            "print(fizzbuzz_label(9))\n"
            "print(fizzbuzz_label(25))\n"
            "print(fizzbuzz_label(1))\n"
            "print(fizzbuzz_label(7))"
        ),
    },
)

_TASK_PY_RUN_LENGTH = EvalTask(
    id="codegen-python-run-length-encode",
    task_family="code-generation",
    language="python",
    prompt=(
        "Write a Python function `rle_encode(text: str) -> str` implementing "
        "run-length encoding: each maximal run of the same character is "
        "replaced by the character followed by the run length in decimal, "
        "e.g. 'aaabbc' -> 'a3b2c1'. The empty string maps to the empty string. "
        "Include the full function in your answer."
    ),
    reference=(
        "def rle_encode(text: str) -> str:\n"
        "    out = []\n"
        "    for ch in text:\n"
        "        if out and out[-1][0] == ch:\n"
        "            out[-1][1] += 1\n"
        "        else:\n"
        "            out.append([ch, 1])\n"
        "    return \"\".join(f\"{ch}{count}\" for ch, count in out)\n"
    ),    checker="python-exec",
    checker_args={
        "expect_stdout": "a3b2c1||z2",
        "test_code": (
            "print(rle_encode('aaabbc'))\n"
            "print(rle_encode(''))\n"
            "print(rle_encode('zz'))"
        ),
    },
)

_TASK_PY_MERGE_INTERVALS = EvalTask(
    id="codegen-python-merge-intervals",
    task_family="code-generation",
    language="python",
    prompt=(
        "Write a Python function `merge_intervals(intervals)` that takes a "
        "sequence of [start, end] pairs and returns the list of merged "
        "overlapping intervals sorted by start, where touching intervals such "
        "as [1, 2] and [2, 3] merge into [1, 3]. Use half-open reasoning only "
        "insofar as touching endpoints merge. Provide the function only."
    ),
    reference=(
        "def merge_intervals(intervals):\n"
        "    merged = []\n"
        "    for start, end in sorted(intervals, key=lambda pair: pair[0]):\n"
        "        if merged and start <= merged[-1][1]:\n"
        "            merged[-1][1] = max(merged[-1][1], end)\n"
        "        else:\n"
        "            merged.append([start, end])\n"
        "    return merged\n"
    ),
    checker="python-exec",
    checker_args={
        "expect_stdout": "[[1, 6], [8, 10], [15, 18]]|[[1, 4]]|[]",
        "test_code": (
            "print(merge_intervals([[1, 3], [2, 6], [8, 10], [15, 18]]))\n"
            "print(merge_intervals([[1, 4], [4, 4]]))\n"
            "print(merge_intervals([]))"
        ),
    },
)

_TASK_TS_GROUP_BY = EvalTask(
    id="codegen-typescript-group-by",
    task_family="code-generation",
    language="typescript",
    prompt=(
        "Write a TypeScript function `groupBy<T, K extends string>(items: T[], "
        "key: (item: T) => K): Record<K, T[]>` that groups items into an "
        "object keyed by the selector result, preserving input order inside "
        "each bucket. Do not use any external library."
    ),
    reference=(
        "function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {\n"
        "  const out = {} as Record<K, T[]>;\n"
        "  for (const item of items) {\n"
        "    const k = key(item);\n"
        "    (out[k] ||= []).push(item);\n"
        "  }\n"
        "  return out;\n"
        "}\n"
    ),
    checker="rubric",
    checker_args={
        "required": [
            "groupBy",
            "items: T[]",
            "key: (item: T) => K",
            "Record<K, T[]>",
            "for (",
        ]
    },
)

_TASK_TS_DEBOUNCE = EvalTask(
    id="codegen-typescript-debounce",
    task_family="code-generation",
    language="typescript",
    prompt=(
        "Write a TypeScript `debounce<F extends (...args: any[]) => void>(fn: F, "
        "waitMs: number): (...args: Parameters<F>) => void` that postpones each "
        "call until `waitMs` milliseconds have elapsed since the most recent "
        "call, cancelling the pending timer with clearTimeout. Keep the timer "
        "handle in a closure variable."
    ),
    reference=(
        "function debounce<F extends (...args: any[]) => void>(fn: F, waitMs: number) {\n"
        "  let timer: ReturnType<typeof setTimeout> | undefined;\n"
        "  return (...args: Parameters<F>) => {\n"
        "    if (timer !== undefined) clearTimeout(timer);\n"
        "    timer = setTimeout(() => fn(...args), waitMs);\n"
        "  };\n"
        "}\n"
    ),
    checker="rubric",
    checker_args={
        "required": [
            "debounce",
            "clearTimeout",
            "setTimeout",
            "Parameters<F>",
            "waitMs",
        ]
    },
)

_TASK_RUST_UNIQUE_SORTED = EvalTask(
    id="codegen-rust-dedup-sorted",
    task_family="code-generation",
    language="rust",
    prompt=(
        "Write a Rust function `fn dedup_sorted(values: Vec<i32>) -> Vec<i32>` "
        "that sorts the input in ascending order and removes consecutive "
        "duplicates in place, returning the vector. Include the idiomatic "
        "call that does the in-place deduplication."
    ),
    reference=(
        "fn dedup_sorted(mut values: Vec<i32>) -> Vec<i32> {\n"
        "    values.sort();\n"
        "    values.dedup();\n"
        "    values\n"
        "}\n"
    ),
    checker="rubric",
    checker_args={
        "required": ["fn dedup_sorted", "Vec<i32>", ".sort()", ".dedup()"],
    },
)

_TASK_GO_WORD_COUNT = EvalTask(
    id="codegen-go-word-frequency",
    task_family="code-generation",
    language="go",
    prompt=(
        "Write a Go function `func WordFrequency(text string) map[string]int` "
        "that splits the text on whitespace using strings.Fields, lowercases "
        "each token with strings.ToLower, and counts occurrences into a map. "
        "Include the package and imports you use."
    ),
    reference=(
        "package words\n\n"
        "import \"strings\"\n\n"
        "func WordFrequency(text string) map[string]int {\n"
        "    counts := make(map[string]int)\n"
        "    for _, token := range strings.Fields(text) {\n"
        "        counts[strings.ToLower(token)]++\n"
        "    }\n"
        "    return counts\n"
        "}\n"
    ),
    checker="rubric",
    checker_args={
        "required": [
            "func WordFrequency",
            "map[string]int",
            "strings.Fields",
            "strings.ToLower",
            "make(map[string]int)",
        ]
    },
)

_TASK_GO_CONTEXT_TIMEOUT = EvalTask(
    id="codegen-go-http-timeout",
    task_family="code-generation",
    language="go",
    prompt=(
        "Write a Go function `func Fetch(ctx context.Context, url string) "
        "(*http.Response, error)` that issues a GET request which is cancelled "
        "when ctx is cancelled, and closes the response body on error paths. "
        "Use http.NewRequestWithContext and http.DefaultClient.Do."
    ),
    reference=(
        "func Fetch(ctx context.Context, url string) (*http.Response, error) {\n"
        "    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)\n"
        "    if err != nil {\n"
        "        return nil, err\n"
        "    }\n"
        "    return http.DefaultClient.Do(req)\n"
        "}\n"
    ),
    checker="rubric",
    checker_args={
        "required": [
            "http.NewRequestWithContext",
            "http.DefaultClient.Do",
            "context.Context",
            "http.MethodGet",
        ]
    },
)

_TASK_SQL_TOP_CUSTOMERS = EvalTask(
    id="codegen-sql-top-customers",
    task_family="code-generation",
    language="sql",
    prompt=(
        "Given `customers(id, name)` and `orders(id, customer_id, total_cents, "
        "created_at)`, write a single SQL query returning the name of each "
        "customer together with the sum of their order totals as `lifetime_cents`, "
        "including customers with no orders (showing 0). Order by lifetime_cents "
        "descending, then name ascending."
    ),
    reference=(
        "SELECT c.name, COALESCE(SUM(o.total_cents), 0) AS lifetime_cents\n"
        "FROM customers c\n"
        "LEFT JOIN orders o ON o.customer_id = c.id\n"
        "GROUP BY c.name\n"
        "ORDER BY lifetime_cents DESC, c.name ASC;\n"
    ),
    checker="rubric",
    checker_args={
        "required": [
            "LEFT JOIN",
            "COALESCE(SUM(",
            "GROUP BY",
            "ORDER BY lifetime_cents DESC",
        ]
    },
)

_TASK_SHELL_PORT_LISTENER = EvalTask(
    id="codegen-shell-find-port-listener",
    task_family="code-generation",
    language="shell",
    prompt=(
        "Write a POSIX shell one-liner that prints the PID of the process "
        "listening on TCP port 8080. It must check whether `lsof` exists before "
        "using it and fall back to `ss -ltnp` otherwise, and it must exit "
        "non-zero with a message on stderr when neither tool is available."
    ),
    reference=(
        "if command -v lsof >/dev/null 2>&1; then\n"
        "  lsof -nP -iTCP:8080 -sTCP:LISTEN\n"
        "elif command -v ss >/dev/null 2>&1; then\n"
        "  ss -ltnp 'sport = :8080'\n"
        "else\n"
        "  echo 'need lsof or ss' >&2\n"
        "  exit 1\n"
        "fi\n"
    ),
    checker="rubric",
    checker_args={
        "required": [
            "command -v lsof",
            "command -v ss",
            ">&2",
            "exit 1",
        ]
    },
)

_TASK_JS_FLATTEN = EvalTask(
    id="codegen-javascript-flatten-once",
    task_family="code-generation",
    language="javascript",
    prompt=(
        "Write a JavaScript function `flattenOnce(arrays)` that takes an array "
        "of arrays and returns a new array with exactly one level of nesting "
        "removed, preserving order. Do not use `Array.prototype.flat`; use a "
        "loop and spread or push."
    ),
    reference=(
        "function flattenOnce(arrays) {\n"
        "  const out = [];\n"
        "  for (const inner of arrays) {\n"
        "    out.push(...inner);\n"
        "  }\n"
        "  return out;\n"
        "}\n"
    ),
    checker="rubric",
    checker_args={
        "required": ["flattenOnce", "for (", "push(", "return out"],
        "forbidden": ["flat("],
    },
)

# ---------------------------------------------------------------------------
# debugging
# ---------------------------------------------------------------------------

_TASK_DEBUG_PY_MUTABLE_DEFAULT = EvalTask(
    id="debug-python-mutable-default-argument",
    task_family="debugging",
    language="python",
    prompt=(
        "This function is wrong:\n\n"
        "```python\n"
        "def add_item(item, bucket=[]):\n"
        "    bucket.append(item)\n"
        "    return bucket\n"
        "```\n\n"
        "Calling `add_item(1)` returns `[1]` but a later `add_item(2)` returns "
        "`[1, 2]` instead of `[2]`. Return a corrected version of the function "
        "that keeps the same call signature behaviour (`add_item(x)` starts a "
        "fresh list) while still allowing an explicit bucket to be passed."
    ),
    reference=(
        "def add_item(item, bucket=None):\n"
        "    if bucket is None:\n"
        "        bucket = []\n"
        "    bucket.append(item)\n"
        "    return bucket\n"
    ),
    checker="python-exec",
    checker_args={
        "expect_stdout": "[2]|[1, 2]",
        "test_code": (
            "print(add_item(2))\n"
            "print(add_item(2, [1]))"
        ),
    },
)

_TASK_DEBUG_PY_OFF_BY_ONE = EvalTask(
    id="debug-python-off-by-one-slice",
    task_family="debugging",
    language="python",
    prompt=(
        "This function should return the last `k` elements of `items` but "
        "raises or returns the wrong values:\n\n"
        "```python\n"
        "def tail(items, k):\n"
        "    return items[len(items) - k - 1:]\n"
        "```\n\n"
        "For `tail([1, 2, 3, 4], 2)` it must return `[3, 4]`, and for `k = 0` "
        "it must return `[]`. Return the corrected function."
    ),
    reference=(
        "def tail(items, k):\n"
        "    if k <= 0:\n"
        "        return []\n"
        "    return items[-k:]\n"
    ),
    checker="python-exec",
    checker_args={
        "expect_stdout": "[3, 4]|[]|[]",
        "test_code": (
            "print(tail([1, 2, 3, 4], 2))\n"
            "print(tail([1, 2, 3, 4], 0))\n"
            "print(tail([], 3))"
        ),
    },
)

_TASK_DEBUG_TS_ASYNC_AWAIT = EvalTask(
    id="debug-typescript-missing-await",
    task_family="debugging",
    language="typescript",
    prompt=(
        "This async function always returns a Promise object instead of the "
        "parsed value, so callers see `undefined` fields:\n\n"
        "```typescript\n"
        "async function loadConfig(path: string) {\n"
        "  const text = fs.readFileSync(path, 'utf8');\n"
        "  return JSON.parse(text);\n"
        "}\n"
        "async function getPort(path: string): Promise<number> {\n"
        "  const config = loadConfig(path);\n"
        "  return config.port;\n"
        "}\n"
        "```\n\n"
        "Explain the defect and return the corrected `getPort`."
    ),
    reference=(
        "async function getPort(path: string): Promise<number> {\n"
        "  const config = await loadConfig(path);\n"
        "  return config.port;\n"
        "}\n"
    ),
    checker="rubric",
    checker_args={
        "required": [
            "await loadConfig(path)",
            "async function getPort",
            "Promise<number>",
        ]
    },
)

_TASK_DEBUG_RUST_BORROW = EvalTask(
    id="debug-rust-move-then-borrow",
    task_family="debugging",
    language="rust",
    prompt=(
        "This Rust code fails to compile with `borrow of moved value: name`:\n\n"
        "```rust\n"
        "fn greet(name: String) {\n"
        "    let message = format!(\"hello {}\", name);\n"
        "    consume(name);\n"
        "    println!(\"{}\", message);\n"
        "}\n"
        "```\n\n"
        "State the compiler error you expect and return a corrected `greet` "
        "that no longer moves `name` before the final use. Prefer borrowing "
        "over cloning."
    ),
    reference=(
        "fn greet(name: String) {\n"
        "    let message = format!(\"hello {}\", name);\n"
        "    consume(&name);\n"
        "    println!(\"{}\", message);\n"
        "}\n\n"
        "// The error is `borrow of moved value: name` (E0382): passing `name` "
        "by value moved the String into consume, so the later use is invalid. "
        "Passing a reference borrows it instead, leaving the original owner "
        "valid for the remaining scope."
    ),
    checker="rubric",
    checker_args={
        "required": ["&name", "moved value", "borrow"],
    },
)

_TASK_DEBUG_GO_NIL_MAP = EvalTask(
    id="debug-go-write-to-nil-map",
    task_family="debugging",
    language="go",
    prompt=(
        "This Go function panics with `assignment to entry in nil map`:\n\n"
        "```go\n"
        "func CountWords(words []string) map[string]int {\n"
        "    var counts map[string]int\n"
        "    for _, w := range words {\n"
        "        counts[w]++\n"
        "    }\n"
        "    return counts\n"
        "}\n"
        "```\n\n"
        "State the panic you expect and return a corrected function."
    ),
    reference=(
        "func CountWords(words []string) map[string]int {\n"
        "    counts := make(map[string]int)\n"
        "    for _, w := range words {\n"
        "        counts[w]++\n"
        "    }\n"
        "    return counts\n"
        "}\n\n"
        "// The panic is `assignment to entry in nil map`: a map declared with "
        "`var counts map[string]int` is a nil map, and writing to a nil map "
        "panics at run time. `make(map[string]int)` allocates it first."
    ),
    checker="rubric",
    checker_args={
        "required": ["nil map", "make(map[string]int)"],
    },
)

_TASK_DEBUG_SQL_HAVING = EvalTask(
    id="debug-sql-aggregate-in-where",
    task_family="debugging",
    language="sql",
    prompt=(
        "This query is rejected because aggregate functions cannot appear in "
        "WHERE:\n\n"
        "```sql\n"
        "SELECT customer_id, COUNT(*) AS order_count\n"
        "FROM orders\n"
        "WHERE COUNT(*) > 3\n"
        "GROUP BY customer_id;\n"
        "```\n\n"
        "Explain why it is invalid and return the corrected query."
    ),
    reference=(
        "SELECT customer_id, COUNT(*) AS order_count\n"
        "FROM orders\n"
        "GROUP BY customer_id\n"
        "HAVING COUNT(*) > 3;\n\n"
        "-- The original is invalid because WHERE is evaluated before grouping: "
        "aggregate functions such as COUNT(*) do not exist yet at that point. "
        "The filter belongs in HAVING, which runs after GROUP BY."
    ),
    checker="rubric",
    checker_args={
        "required": ["HAVING COUNT(*) > 3", "GROUP BY customer_id", "WHERE"],
    },
)

_TASK_DEBUG_SHELL_UNQUOTED = EvalTask(
    id="debug-shell-unquoted-variable",
    task_family="debugging",
    language="shell",
    prompt=(
        "This script breaks whenever a filename contains a space or a leading "
        "dash:\n\n"
        "```sh\n"
        "for f in $(ls *.log); do\n"
        "  gzip $f\n"
        "done\n"
        "```\n\n"
        "Explain both failure modes and return a corrected loop that is safe "
        "for arbitrary filenames."
    ),
    reference=(
        "for f in ./*.log; do\n"
        "  [ -e \"$f\" ] || continue\n"
        "  gzip -- \"$f\"\n"
        "done\n"
    ),
    checker="rubric",
    checker_args={
        "required": ['for f in ./*.log', '"$f"', "--"],
        "forbidden": ["$(ls"],
    },
)

# ---------------------------------------------------------------------------
# refactoring
# ---------------------------------------------------------------------------

_TASK_REFACTOR_PY_DATACLASS = EvalTask(
    id="refactor-python-dict-to-dataclass",
    task_family="refactoring",
    language="python",
    prompt=(
        "Refactor this into a frozen dataclass named `Point` with fields x and "
        "y and a method `manhattan(self) -> int` returning |x| + |y|:\n\n"
        "```python\n"
        "def make_point(x, y):\n"
        "    return {'x': x, 'y': y}\n\n"
        "def manhattan(p):\n"
        "    return abs(p['x']) + abs(p['y'])\n"
        "```\n\n"
        "Keep the API usable as `Point(3, -4).manhattan() == 7`."
    ),
    reference=(
        "from dataclasses import dataclass\n\n"
        "@dataclass(frozen=True)\n"
        "class Point:\n"
        "    x: int\n"
        "    y: int\n\n"
        "    def manhattan(self) -> int:\n"
        "        return abs(self.x) + abs(self.y)\n"
    ),
    checker="python-exec",
    checker_args={
        "expect_stdout": "7|7|True",
        "test_code": (
            "p = Point(3, -4)\n"
            "print(p.manhattan())\n"
            "print(Point(-3, -4).manhattan())\n"
            "print(p == Point(3, -4))"
        ),
    },
)

_TASK_REFACTOR_PY_EARLY_RETURN = EvalTask(
    id="refactor-python-flatten-nested-conditionals",
    task_family="refactoring",
    language="python",
    prompt=(
        "Refactor this function to use guard clauses (early returns) with no "
        "behaviour change and no nesting deeper than one level:\n\n"
        "```python\n"
        "def shipping_cost(weight_kg, express, international):\n"
        "    if weight_kg > 0:\n"
        "        if not international:\n"
        "            if express:\n"
        "                return 12.0 + 2.5 * weight_kg\n"
        "            else:\n"
        "                return 5.0 + 1.5 * weight_kg\n"
        "        else:\n"
        "            return 40.0 + 6.0 * weight_kg\n"
        "    return 0.0\n"
        "```"
    ),
    reference=(
        "def shipping_cost(weight_kg, express, international):\n"
        "    if weight_kg <= 0:\n"
        "        return 0.0\n"
        "    if international:\n"
        "        return 40.0 + 6.0 * weight_kg\n"
        "    if express:\n"
        "        return 12.0 + 2.5 * weight_kg\n"
        "    return 5.0 + 1.5 * weight_kg\n"
    ),
    checker="python-exec",
    checker_args={
        "expect_stdout": "0.0|8.0|17.0|64.0",
        "test_code": (
            "print(shipping_cost(0, True, False))\n"
            "print(shipping_cost(2, False, False))\n"
            "print(shipping_cost(2, True, False))\n"
            "print(shipping_cost(4, True, True))"
        ),
    },
)

_TASK_REFACTOR_TS_SWITCH_TO_MAP = EvalTask(
    id="refactor-typescript-switch-to-map",
    task_family="refactoring",
    language="typescript",
    prompt=(
        "Refactor this switch statement into a lookup table plus a single "
        "handler, preserving behaviour including the fallback for unknown "
        "commands:\n\n"
        "```typescript\n"
        "function run(cmd: string) {\n"
        "  switch (cmd) {\n"
        "    case 'start': return launch();\n"
        "    case 'halt': return stop();\n"
        "    case 'status': return report();\n"
        "    default: throw new Error('unknown command: ' + cmd);\n"
        "  }\n"
        "}\n"
        "```"
    ),
    reference=(
        "const HANDLERS: Record<string, () => unknown> = {\n"
        "  start: launch,\n"
        "  halt: stop,\n"
        "  status: report,\n"
        "};\n\n"
        "function run(cmd: string) {\n"
        "  const handler = HANDLERS[cmd];\n"
        "  if (!handler) throw new Error('unknown command: ' + cmd);\n"
        "  return handler();\n"
        "}\n"
    ),
    checker="rubric",
    checker_args={
        "required": [
            "Record<string",
            "HANDLERS[cmd]",
            "throw new Error('unknown command: ' + cmd)",
        ],
        "forbidden": ["switch ("],
    },
)

_TASK_REFACTOR_SQL_CTE = EvalTask(
    id="refactor-sql-subquery-to-cte",
    task_family="refactoring",
    language="sql",
    prompt=(
        "Rewrite this query using a common table expression instead of a "
        "repeated correlated subquery, with identical results and a CTE named "
        "`paid_totals`:\n\n"
        "```sql\n"
        "SELECT c.id,\n"
        "       (SELECT SUM(o.total_cents) FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid') AS paid\n"
        "FROM customers c\n"
        "WHERE (SELECT SUM(o.total_cents) FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid') > 10000;\n"
        "```"
    ),
    reference=(
        "WITH paid_totals AS (\n"
        "  SELECT customer_id, SUM(total_cents) AS paid\n"
        "  FROM orders\n"
        "  WHERE status = 'paid'\n"
        "  GROUP BY customer_id\n"
        ")\n"
        "SELECT c.id, pt.paid\n"
        "FROM customers c\n"
        "JOIN paid_totals pt ON pt.customer_id = c.id\n"
        "WHERE pt.paid > 10000;\n"
    ),
    checker="rubric",
    checker_args={
        "required": ["WITH paid_totals AS", "GROUP BY customer_id", "JOIN paid_totals"],
        "forbidden": ["(SELECT SUM("],
    },
)

_TASK_REFACTOR_GO_INTERFACE = EvalTask(
    id="refactor-go-concrete-to-interface",
    task_family="refactoring",
    language="go",
    prompt=(
        "The function below depends on a concrete type, which makes it "
        "untestable. Introduce a small interface `Store` with the method it "
        "actually needs and change the function to accept that interface:\n\n"
        "```go\n"
        "func LoadName(db *Postgres, id int) (string, error) {\n"
        "    row, err := db.Get(id)\n"
        "    if err != nil {\n"
        "        return \"\", err\n"
        "    }\n"
        "    return row.Name, nil\n"
        "}\n"
        "```"
    ),
    reference=(
        "type Store interface {\n"
        "    Get(id int) (Row, error)\n"
        "}\n\n"
        "func LoadName(store Store, id int) (string, error) {\n"
        "    row, err := store.Get(id)\n"
        "    if err != nil {\n"
        "        return \"\", err\n"
        "    }\n"
        "    return row.Name, nil\n"
        "}\n"
    ),
    checker="rubric",
    checker_args={
        "required": ["type Store interface", "Get(id int) (Row, error)", "store Store"],
        "forbidden": ["db *Postgres"],
    },
)

# ---------------------------------------------------------------------------
# code-explanation
# ---------------------------------------------------------------------------

_TASK_EXPLAIN_PY_CLOSURE_LATE_BINDING = EvalTask(
    id="explain-python-closure-late-binding",
    task_family="code-explanation",
    language="python",
    prompt=(
        "Explain why this prints `[2, 2, 2]` rather than `[0, 1, 2]`:\n\n"
        "```python\n"
        "funcs = [lambda: i for i in range(3)]\n"
        "print([f() for f in funcs])\n"
        "```\n\n"
        "Name the mechanism and give the one-line fix that binds the value at "
        "creation time."
    ),
    reference=(
        "The lambda closes over the *variable* `i`, not its current value: "
        "this is late binding. All three lambdas share the single loop "
        "variable in the enclosing comprehension scope, and by the time the "
        "functions are called the loop has finished with i == 2, so every "
        "closure returns 2. Bind the value at creation time with a default "
        "argument: `funcs = [lambda i=i: i for i in range(3)]`."
    ),
    checker="rubric",
    checker_args={
        "required": [
            "late binding",
            "closure",
            "lambda i=i: i",
        ]
    },
)

_TASK_EXPLAIN_PY_GIL = EvalTask(
    id="explain-python-gil-and-threads",
    task_family="code-explanation",
    language="python",
    prompt=(
        "A Python service runs CPU-bound work in `threading.Thread` and sees no "
        "speedup on an 8-core machine. Explain the cause and state which "
        "standard-library module should be used instead for CPU-bound work, "
        "and for which kind of workload threads remain the right choice."
    ),
    reference=(
        "CPython's global interpreter lock (GIL) allows only one thread to "
        "execute Python bytecode at a time, so CPU-bound threads serialise "
        "instead of running in parallel. Use multiprocessing (or "
        "concurrent.futures.ProcessPoolExecutor) for CPU-bound work. Threads "
        "remain appropriate for I/O-bound work that releases the GIL while "
        "waiting, such as network or disk calls."
    ),
    checker="rubric",
    checker_args={
        "required": ["global interpreter lock", "multiprocessing", "I/O"],
    },
)

_TASK_EXPLAIN_TS_STRUCTURAL_TYPING = EvalTask(
    id="explain-typescript-structural-typing",
    task_family="code-explanation",
    language="typescript",
    prompt=(
        "Explain why this TypeScript assignment compiles even though `Point` "
        "and `Vec` are unrelated declarations, and what a developer must add "
        "to make the two types mutually incompatible:\n\n"
        "```typescript\n"
        "interface Point { x: number; y: number }\n"
        "interface Vec { x: number; y: number }\n"
        "const p: Point = { x: 0, y: 0 };\n"
        "const v: Vec = p;\n"
        "```"
    ),
    reference=(
        "TypeScript uses structural typing: compatibility depends on the shape "
        "of the members, not on the declared name of the interface, so any "
        "object with numeric x and y satisfies both. To make them "
        "incompatible, add a brand/discriminant property that the other type "
        "lacks, for example a private or readonly `__brand: 'Point'` field "
        "(or a unique symbol brand)."
    ),
    checker="rubric",
    checker_args={
        "required": ["structural", "brand"],
    },
)

_TASK_EXPLAIN_RUST_OWNERSHIP = EvalTask(
    id="explain-rust-move-semantics",
    task_family="code-explanation",
    language="rust",
    prompt=(
        "Explain why `let b = a; println!(\"{}\", a);` fails to compile for "
        "`a: String` but the same code compiles for `a: i32`. Name the trait "
        "that distinguishes the two cases and describe the rule that decides "
        "which one applies to a type."
    ),
    reference=(
        "String is not Copy, so `let b = a` is a move: ownership transfers to "
        "b and a becomes unusable, which the borrow checker reports as "
        "use-of-moved-value. i32 implements the Copy trait, so assignment "
        "copies the bits and the original binding stays valid. A type can "
        "implement Copy only if all of its fields are Copy and it does not "
        "manage a heap allocation or other owned resource (no Drop)."
    ),
    checker="rubric",
    checker_args={
        "required": ["Copy", "move", "ownership"],
    },
)

_TASK_EXPLAIN_SQL_INDEX = EvalTask(
    id="explain-sql-index-left-prefix",
    task_family="code-explanation",
    language="sql",
    prompt=(
        "Given `CREATE INDEX idx_orders ON orders (customer_id, created_at)`, "
        "explain which of these two predicates can use the index efficiently "
        "and why:\n\n"
        "1. `WHERE created_at > '2024-01-01'`\n"
        "2. `WHERE customer_id = 7 AND created_at > '2024-01-01'`"
    ),
    reference=(
        "Only the second. A composite B-tree index is ordered by its leading "
        "column first, so it can be used efficiently only when the leftmost "
        "prefix (customer_id) is constrained. A query filtering on created_at "
        "alone cannot seek into the index and falls back to a full scan, "
        "unless a separate index on created_at exists."
    ),
    checker="rubric",
    checker_args={
        "required": ["leftmost", "customer_id", "full scan"],
    },
)

_TASK_EXPLAIN_SHELL_SET_E = EvalTask(
    id="explain-shell-set-euo-pipefail",
    task_family="code-explanation",
    language="shell",
    prompt=(
        "Explain precisely what `set -euo pipefail` changes in a bash script, "
        "including what each of the three options does and one classic "
        "pitfall of `-e` inside a conditional or pipeline."
    ),
    reference=(
        "-e makes the shell exit when a command fails (non-zero status) unless "
        "it is part of a condition; -u makes referencing an unset variable an "
        "error instead of expanding to empty; -o pipefail makes a pipeline "
        "return the status of the rightmost failing command rather than only "
        "the last command. A pitfall: a failing command on the left of `&&` or "
        "inside `if cmd; then` is not fatal under -e, and commands in a "
        "pipeline run in subshells so their side effects are lost."
    ),
    checker="rubric",
    checker_args={
        "required": ["-e", "-u", "pipefail", "unset"],
    },
)

# ---------------------------------------------------------------------------
# test-generation
# ---------------------------------------------------------------------------

_TASK_TEST_PY_IS_PALINDROME = EvalTask(
    id="testgen-python-palindrome-pytest",
    task_family="test-generation",
    language="python",
    prompt=(
        "Write pytest tests for this function. Include at least one test that "
        "covers a mixed-case phrase with punctuation, one that covers the "
        "empty string, and one that covers a clearly non-palindromic input:\n\n"
        "```python\n"
        "def is_palindrome(text: str) -> bool:\n"
        "    cleaned = ''.join(ch.lower() for ch in text if ch.isalnum())\n"
        "    return cleaned == cleaned[::-1]\n"
        "```"
    ),
    reference=(
        "def test_mixed_case_with_punctuation():\n"
        "    assert is_palindrome('A man, a plan, a canal: Panama') is True\n\n"
        "def test_empty_string():\n"
        "    assert is_palindrome('') is True\n\n"
        "def test_non_palindrome():\n"
        "    assert is_palindrome('kairoforge') is False\n"
    ),
    checker="rubric",
    checker_args={
        "required": ["def test_", "assert", "is_palindrome(", "Panama"],
    },
)

_TASK_TEST_PY_EDGE_CASES = EvalTask(
    id="testgen-python-boundary-values",
    task_family="test-generation",
    language="python",
    prompt=(
        "Write pytest tests for `def clamp(value, low, high)` that returns "
        "`low` when value < low, `high` when value > high, and the value "
        "otherwise. Cover below-range, above-range, both exact boundaries, and "
        "the degenerate case where low == high."
    ),
    reference=(
        "import pytest\n\n"
        "@pytest.mark.parametrize('value,expected', [(-1, 0), (0, 0), (5, 5), (10, 10), (11, 10)])\n"
        "def test_clamp_boundaries(value, expected):\n"
        "    assert clamp(value, 0, 10) == expected\n\n"
        "def test_clamp_degenerate_range():\n"
        "    assert clamp(7, 3, 3) == 3\n"
    ),
    checker="rubric",
    checker_args={
        "required": ["parametrize", "assert clamp(", "def test_", "=="],
    },
)

_TASK_TEST_PY_REGRESSION_BUG = EvalTask(
    id="testgen-python-regression-test-for-bug",
    task_family="test-generation",
    language="python",
    prompt=(
        "A bug shipped because `parse_duration('1h30m')` returned 60 seconds "
        "instead of 5400: the parser ignored trailing components after the "
        "first match. Write a pytest regression test that fails on the old "
        "behaviour and passes on the fixed one, asserting the exact integer "
        "value for both '1h30m' and '90s'."
    ),
    reference=(
        "def test_parse_duration_compound_units_regression():\n"
        "    assert parse_duration('1h30m') == 5400\n\n"
        "def test_parse_duration_seconds_only():\n"
        "    assert parse_duration('90s') == 90\n"
    ),
    checker="rubric",
    checker_args={
        "required": ["== 5400", "== 90", "def test_", "parse_duration("],
    },
)

_TASK_TEST_TS_VITEST = EvalTask(
    id="testgen-typescript-vitest-suite",
    task_family="test-generation",
    language="typescript",
    prompt=(
        "Write a Vitest suite for a `slugify(input: string): string` function "
        "that lowercases, replaces runs of non-alphanumeric characters with a "
        "single hyphen, and trims leading/trailing hyphens. Include a happy "
        "path, a punctuation-heavy input, and an input that is entirely "
        "punctuation (expected: empty string)."
    ),
    reference=(
        "import { describe, it, expect } from 'vitest';\n\n"
        "describe('slugify', () => {\n"
        "  it('lowercases and hyphenates words', () => {\n"
        "    expect(slugify('Hello World')).toBe('hello-world');\n"
        "  });\n"
        "  it('collapses punctuation', () => {\n"
        "    expect(slugify('A  B!! C')).toBe('a-b-c');\n"
        "  });\n"
        "  it('returns empty for punctuation only', () => {\n"
        "    expect(slugify('!!!')).toBe('');\n"
        "  });\n"
        "});\n"
    ),
    checker="rubric",
    checker_args={
        "required": ["describe(", "it(", "expect(", "toBe(", "vitest"],
    },
)

_TASK_TEST_SQL_FIXTURE = EvalTask(
    id="testgen-sql-assertion-fixture",
    task_family="test-generation",
    language="sql",
    prompt=(
        "Write a SQL test that inserts fixture rows into `orders(id, "
        "customer_id, total_cents, status)` and asserts that the query "
        "`SELECT customer_id, SUM(total_cents) FROM orders WHERE status = 'paid' "
        "GROUP BY customer_id` returns exactly 2500 for customer 1 and that "
        "customer 2 (whose only order is 'refunded') appears zero times."
    ),
    reference=(
        "INSERT INTO orders (id, customer_id, total_cents, status) VALUES\n"
        "  (1, 1, 1000, 'paid'),\n"
        "  (2, 1, 1500, 'paid'),\n"
        "  (3, 2, 900, 'refunded');\n\n"
        "SELECT customer_id, SUM(total_cents) FROM orders\n"
        "WHERE status = 'paid' GROUP BY customer_id;  -- expect exactly one row: (1, 2500)\n"
    ),
    checker="rubric",
    checker_args={
        "required": ["INSERT INTO orders", "2500", "refunded", "GROUP BY customer_id"],
    },
)

# ---------------------------------------------------------------------------
# repository-understanding
# ---------------------------------------------------------------------------

_REPO_SNAPSHOT = (
    "src/kairoforge/app.py\n"
    "    from kairoforge.data.schema import TrainingRecord\n"
    "    from kairoforge.registry.store import save_checkpoint\n"
    "    def run(records):\n"
    "        return save_checkpoint(records)\n"
    "src/kairoforge/registry/store.py\n"
    "    from kairoforge.data.schema import TrainingRecord\n"
    "    def save_checkpoint(records):\n"
    "        return len(records)\n"
    "src/kairoforge/data/schema.py\n"
    "    class TrainingRecord:\n"
    "        ...\n"
    "src/kairoforge/data/pipeline.py\n"
    "    def build(rows):\n"
    "        return rows\n"
)

_TASK_REPO_IMPORT_GRAPH = EvalTask(
    id="repo-understanding-import-graph",
    task_family="repository-understanding",
    language="python",
    prompt=(
        "Here is a four-file snapshot of a Python package with the module "
        "paths and the imports each module performs:\n\n"
        f"{_REPO_SNAPSHOT}\n"
        "Which module is the only leaf dependency that no other module in this "
        "snapshot imports transitively? Answer with the module path, and state "
        "whether moving `schema.py` into a new package would break `app.py` "
        "directly or only indirectly."
    ),
    reference=(
        "schema.py is the leaf: app.py and registry/store.py both import it "
        "from kairoforge.data.schema, and it imports nothing from the snapshot. "
        "Moving it breaks app.py directly as well as registry/store.py, because "
        "app.py imports TrainingRecord from that exact module path itself."
    ),
    checker="rubric",
    checker_args={
        "required": ["schema.py", "directly", "store.py"],
    },
)

_TASK_REPO_CHANGE_IMPACT = EvalTask(
    id="repo-understanding-change-impact",
    task_family="repository-understanding",
    language="python",
    prompt=(
        "Using the same snapshot:\n\n"
        f"{_REPO_SNAPSHOT}\n"
        "You must change the signature of `save_checkpoint` to require a "
        "second argument `version: str`. List every file in the snapshot that "
        "must be edited, and state whether `pipeline.py` needs an edit."
    ),
    reference=(
        "Only registry/store.py (the definition) and app.py (the call site) "
        "must be edited. pipeline.py does not import or call save_checkpoint, "
        "so it needs no edit."
    ),
    checker="rubric",
    checker_args={
        "required": ["app.py", "store.py", "pipeline.py"],
    },
)

_TASK_REPO_MODULE_LAYERING = EvalTask(
    id="repo-understanding-layering-violation",
    task_family="repository-understanding",
    language="python",
    prompt=(
        "Using the same snapshot:\n\n"
        f"{_REPO_SNAPSHOT}\n"
        "Suppose the project rule is that `data/` must not import from "
        "`registry/`. Someone proposes adding `from kairoforge.registry.store "
        "import save_checkpoint` to data/pipeline.py. Explain what rule this "
        "violates, why it would create an import cycle risk, and suggest where "
        "the call belongs instead."
    ),
    reference=(
        "It violates the layering rule that data/ must not depend on registry/. "
        "registry/store.py already imports from kairoforge.data.schema, so a "
        "data -> registry import would close a cycle "
        "(data.pipeline -> registry.store -> data.schema). The call belongs in "
        "the orchestration layer such as app.py, which already imports both."
    ),
    checker="rubric",
    checker_args={
        "required": ["cycle", "layer", "app.py"],
    },
)

# ---------------------------------------------------------------------------
# terminal-reasoning
# ---------------------------------------------------------------------------

_TASK_TERM_GRANT_PERMISSIONS = EvalTask(
    id="terminal-reasoning-fix-permission-denied",
    task_family="terminal-reasoning",
    language="shell",
    prompt=(
        "Running `./deploy.sh` prints `bash: ./deploy.sh: Permission denied` "
        "and `ls -l deploy.sh` shows `-rw-r--r-- 1 dev dev 0 deploy.sh`. Give "
        "the minimal command that fixes the immediate error, and name the "
        "command that also records the change in git."
    ),
    reference=(
        "chmod +x deploy.sh fixes it (the file lacks the execute bit for every "
        "user class). Run git update-index --chmod=+x deploy.sh, or chmod +x "
        "followed by git add, so the mode change is committed to the index."
    ),
    checker="rubric",
    checker_args={
        "required": ["chmod +x", "update-index"],
    },
)

_TASK_TERM_EXACT_PID = EvalTask(
    id="terminal-reasoning-kill-listener-on-port",
    task_family="terminal-reasoning",
    language="shell",
    prompt=(
        "A previous dev server is still bound to port 3000 and a new run fails "
        "with `EADDRINUSE`. Give the exact command sequence (one command per "
        "line, no explanation) that prints the listening PID and then "
        "terminates only that process, without using `killall` or `pkill -f`."
    ),
    reference=(
        "lsof -nP -iTCP:3000 -sTCP:LISTEN\n"
        "lsof -t -nP -iTCP:3000 -sTCP:LISTEN | xargs -r kill\n"
    ),
    checker="rubric",
    checker_args={
        "required": ["lsof", "-iTCP:3000", "kill"],
        "forbidden": ["killall", "pkill -f"],
    },
)

_TASK_TERM_EXIT_CODE = EvalTask(
    id="terminal-reasoning-decode-exit-status",
    task_family="terminal-reasoning",
    language="shell",
    prompt=(
        "A CI step exited with status 137 and the step before it was a "
        "container build. State the numeric meaning of 137, name the two most "
        "likely causes in a container, and give the command that shows how "
        "much memory the container was limited to."
    ),
    reference=(
        "137 = 128 + 9, i.e. the process was killed by SIGKILL. In a container "
        "that is most often the kernel OOM killer terminating the process for "
        "exceeding its cgroup memory limit, or an explicit `docker kill` / "
        "timeout. Inspect the limit with `docker inspect --format "
        "'{{.HostConfig.Memory}}' <container>` (or cat "
        "/sys/fs/cgroup/memory.max inside the container)."
    ),
    checker="rubric",
    checker_args={
        "required": ["128", "9", "SIGKILL", "OOM"],
    },
)

_TASK_TERM_GIT_RECOVER = EvalTask(
    id="terminal-reasoning-recover-from-detached-head",
    task_family="terminal-reasoning",
    language="shell",
    prompt=(
        "You ran `git checkout HEAD~3` to inspect an old commit and then made "
        "two commits while in detached HEAD. You are now about to check out "
        "main again. Give the exact command that preserves those two commits "
        "on a new branch before switching, and explain what `git reflog` would "
        "be used for if you had already switched away."
    ),
    reference=(
        "git switch -c recover-work (equivalently git checkout -b "
        "recover-work) creates a branch at the current detached commit, so the "
        "two commits stay reachable. If you already switched away, the commits "
        "are unreferenced but still in the reflog: git reflog shows the "
        "detached HEAD entries and you can git switch -c recover-work <sha> to "
        "reattach."
    ),
    checker="rubric",
    checker_args={
        "required": ["switch -c", "reflog"],
    },
)

_TASK_TERM_STDERR_REDIRECT = EvalTask(
    id="terminal-reasoning-merge-stderr-exact",
    task_family="terminal-reasoning",
    language="shell",
    prompt=(
        "Write a single shell command that runs `make build`, writes both "
        "stdout and stderr to build.log, and still exits with make's failure "
        "status so that `set -e` in the calling script aborts. Redirection "
        "order matters: explain where to place `2>&1` relative to the file "
        "redirection."
    ),
    reference=(
        "make build > build.log 2>&1 ; the shell's exit status of the pipeline "
        "is make's own status, so set -e still aborts. `2>&1` must come after "
        "`> build.log`: redirections are applied left to right, so pointing "
        "stderr at the old stdout first would send errors to the terminal."
    ),
    checker="regex",
    checker_args={
        "pattern": r">\s*build\.log\s+2>&1",
    },
)

# ---------------------------------------------------------------------------
# tool-planning
# ---------------------------------------------------------------------------

_TASK_TOOL_PLAN_RENAME_SYMBOL = EvalTask(
    id="tool-planning-rename-symbol-repo-wide",
    task_family="tool-planning",
    language="text",
    prompt=(
        "You are an agent with tools: `search(pattern, path)`, "
        "`read(path, start, end)`, `edit(path, old, new)`, `run(cmd)`. "
        "Plan, as a numbered list of tool calls, the safest way to rename the "
        "Python symbol `save_checkpoint` to `persist_checkpoint` across a "
        "repository. The plan must not blind-edit: it must verify the new name "
        "is unused first and must run the test suite last."
    ),
    reference=(
        "1. search('save_checkpoint', '.') to enumerate every definition and "
        "call site. 2. search('persist_checkpoint', '.') to prove the new name "
        "is unused. 3. read each matched file around the hit before editing. "
        "4. edit each file, definition first. 5. search('save_checkpoint', "
        "'.') again to confirm zero remaining hits. 6. run('pytest -q') last."
    ),
    checker="rubric",
    checker_args={
        "required": [
            "search",
            "persist_checkpoint",
            "read",
            "edit",
            "pytest",
        ]
    },
)

_TASK_TOOL_PLAN_FAILING_TEST_TRIAGE = EvalTask(
    id="tool-planning-triage-failing-test",
    task_family="tool-planning",
    language="text",
    prompt=(
        "A single pytest test `test_parse_duration_compound_units` fails in a "
        "repository you have never seen. With tools `search`, `read`, `edit`, "
        "`run`, write the ordered plan you would follow to decide whether the "
        "bug is in the test or in the production code. Include the specific "
        "evidence you would gather before making any edit."
    ),
    reference=(
        "1. run('pytest -q tests/test_duration.py::test_parse_duration_compound_units') "
        "to capture the exact assertion and actual value. 2. search for "
        "parse_duration to find the implementation. 3. read the implementation "
        "and the test. 4. Reproduce the failing input in a one-off run to see "
        "the actual value. 5. Compare against the documented/expected contract "
        "to decide which side is wrong. 6. edit only the side that contradicts "
        "the contract. 7. run the full suite to prove no regression."
    ),
    checker="rubric",
    checker_args={
        "required": ["run(", "search", "read", "edit"],
    },
)

_TASK_TOOL_PLAN_BATCHED_VS_SEQUENTIAL = EvalTask(
    id="tool-planning-parallel-read-then-write",
    task_family="tool-planning",
    language="text",
    prompt=(
        "You must add type annotations to twelve independent Python modules. "
        "Your tools are `read`, `edit`, `run`. Describe which tool calls may "
        "be issued in parallel and which must be sequential, and state why "
        "issuing all twelve `edit` calls in one batch is unsafe if two of the "
        "modules import each other."
    ),
    reference=(
        "The twelve `read` calls are independent and can be batched in "
        "parallel. The `edit` calls are sequential per file, and unsafe to "
        "batch blind when modules import each other: an edit that renames or "
        "changes a signature in module A changes what B must import, so a "
        "batch computed from the pre-edit state can produce a mutually "
        "inconsistent pair. Read, verify with run(), edit, then re-read."
    ),
    checker="rubric",
    checker_args={
        "required": ["parallel", "sequential", "import"],
    },
)

# ---------------------------------------------------------------------------
# instruction-following
# ---------------------------------------------------------------------------

_TASK_INSTR_EXACT_JSON = EvalTask(
    id="instruction-following-json-only-output",
    task_family="instruction-following",
    language="json",
    prompt=(
        "Respond with ONLY a JSON object, no prose and no code fence, with "
        "exactly the keys \"name\", \"version\", \"stable\" and values "
        "\"kairoforge\", \"0.1.0\", false in that order. The values must use "
        "the given types: the version is a string, stable is a boolean.\n\n"
        "Reply on the first line only if you can; otherwise still keep the "
        "object as the entire response."
    ),
    reference='{"name": "kairoforge", "version": "0.1.0", "stable": false}',
    checker="exact",
    checker_args={"strip_code_fence": True},
)

_TASK_INSTR_SENTENCE_LIMIT = EvalTask(
    id="instruction-following-exactly-three-bullets",
    task_family="instruction-following",
    language="text",
    prompt=(
        "List exactly three reasons a code review should be small. Output "
        "exactly three lines, each beginning with '- ', no preamble, no "
        "closing sentence, and no nesting."
    ),
    reference=(
        "- small reviews get read closely\n"
        "- reviewers hold the whole change in mind\n"
        "- defects are found before merge"
    ),
    checker="regex",
    checker_args={
        # \A...\Z, not ^...$: ^...$ would match only the first three lines of a
        # four-bullet answer and silently accept it.
        "strip_code_fence": True,
        "pattern": r"\A- [^\n]+\n- [^\n]+\n- [^\n]+\Z",
    },
)

_TASK_INSTR_NO_APOLOGY_PREFIX = EvalTask(
    id="instruction-following-no-conversational-preamble",
    task_family="instruction-following",
    language="text",
    prompt=(
        "Answer with the single shell command that prints the current working "
        "directory. Do not begin with 'Sure', 'Certainly', or an apology, and "
        "do not add explanation or a code fence."
    ),
    reference="pwd",
    checker="exact",
    checker_args={"strip_code_fence": True, "strip_preamble": True},
    # Low weight on purpose: this item measures response hygiene (no "Sure,
    # here you go" preamble), not coding ability, and should not dominate the
    # aggregate.
    weight=0.25,
)

_TASK_INSTR_TOOL_JSON_CALL = EvalTask(
    id="instruction-following-single-tool-call-json",
    task_family="instruction-following",
    language="json",
    prompt=(
        "Emit exactly one JSON object describing a tool call, with keys "
        "\"tool\" and \"arguments\", where tool is \"search\" and arguments is "
        "an object with a single key \"pattern\" whose value is "
        "\"save_checkpoint\". Output nothing else."
    ),
    reference='{"tool": "search", "arguments": {"pattern": "save_checkpoint"}}',
    checker="rubric",
    checker_args={
        # Whitespace-tolerant on purpose: this task checks instruction
        # following (single object, right keys, right values), not spacing.
        "required": ['"tool"', "search", '"arguments"', '"pattern"', "save_checkpoint"],
        "required_patterns": [r"\{.*\}\s*$"],
        "forbidden_patterns": ["```"],
    },
)


#: The built-in evaluation suite.
#:
#: Frozen and ordered so that a report rendered twice from the same suite is
#: byte-identical, which makes report diffs reviewable.
BUILTIN_TASKS: tuple[EvalTask, ...] = (
    # code-generation (9)
    _TASK_PY_FIZZBUZZ,
    _TASK_PY_RUN_LENGTH,
    _TASK_PY_MERGE_INTERVALS,
    _TASK_TS_GROUP_BY,
    _TASK_TS_DEBOUNCE,
    _TASK_RUST_UNIQUE_SORTED,
    _TASK_GO_WORD_COUNT,
    _TASK_GO_CONTEXT_TIMEOUT,
    _TASK_SQL_TOP_CUSTOMERS,
    _TASK_SHELL_PORT_LISTENER,
    _TASK_JS_FLATTEN,
    # debugging (7)
    _TASK_DEBUG_PY_MUTABLE_DEFAULT,
    _TASK_DEBUG_PY_OFF_BY_ONE,
    _TASK_DEBUG_TS_ASYNC_AWAIT,
    _TASK_DEBUG_RUST_BORROW,
    _TASK_DEBUG_GO_NIL_MAP,
    _TASK_DEBUG_SQL_HAVING,
    _TASK_DEBUG_SHELL_UNQUOTED,
    # refactoring (5)
    _TASK_REFACTOR_PY_DATACLASS,
    _TASK_REFACTOR_PY_EARLY_RETURN,
    _TASK_REFACTOR_TS_SWITCH_TO_MAP,
    _TASK_REFACTOR_SQL_CTE,
    _TASK_REFACTOR_GO_INTERFACE,
    # code-explanation (6)
    _TASK_EXPLAIN_PY_CLOSURE_LATE_BINDING,
    _TASK_EXPLAIN_PY_GIL,
    _TASK_EXPLAIN_TS_STRUCTURAL_TYPING,
    _TASK_EXPLAIN_RUST_OWNERSHIP,
    _TASK_EXPLAIN_SQL_INDEX,
    _TASK_EXPLAIN_SHELL_SET_E,
    # test-generation (5)
    _TASK_TEST_PY_IS_PALINDROME,
    _TASK_TEST_PY_EDGE_CASES,
    _TASK_TEST_PY_REGRESSION_BUG,
    _TASK_TEST_TS_VITEST,
    _TASK_TEST_SQL_FIXTURE,
    # repository-understanding (3)
    _TASK_REPO_IMPORT_GRAPH,
    _TASK_REPO_CHANGE_IMPACT,
    _TASK_REPO_MODULE_LAYERING,
    # terminal-reasoning (5)
    _TASK_TERM_GRANT_PERMISSIONS,
    _TASK_TERM_EXACT_PID,
    _TASK_TERM_EXIT_CODE,
    _TASK_TERM_GIT_RECOVER,
    _TASK_TERM_STDERR_REDIRECT,
    # tool-planning (3)
    _TASK_TOOL_PLAN_RENAME_SYMBOL,
    _TASK_TOOL_PLAN_FAILING_TEST_TRIAGE,
    _TASK_TOOL_PLAN_BATCHED_VS_SEQUENTIAL,
    # instruction-following (4)
    _TASK_INSTR_EXACT_JSON,
    _TASK_INSTR_SENTENCE_LIMIT,
    _TASK_INSTR_NO_APOLOGY_PREFIX,
    _TASK_INSTR_TOOL_JSON_CALL,
)


def tasks_by_family(family: str) -> tuple[EvalTask, ...]:
    """Return every built-in task in ``family``, preserving suite order."""

    return tuple(task for task in BUILTIN_TASKS if task.task_family == family)


def tasks_by_language(language: str) -> tuple[EvalTask, ...]:
    """Return every built-in task written in ``language``, preserving order."""

    return tuple(task for task in BUILTIN_TASKS if task.language == language)


def select_tasks(
    families: "tuple[str, ...] | None" = None,
    languages: "tuple[str, ...] | None" = None,
    ids: "tuple[str, ...] | None" = None,
) -> tuple[EvalTask, ...]:
    """Filter :data:`BUILTIN_TASKS` by family, language, and/or explicit ids.

    Filters compose as AND. With no arguments the whole suite is returned, so
    a caller can always write ``select_tasks()`` rather than special-casing the
    unfiltered case.
    """

    selected = BUILTIN_TASKS
    if families is not None:
        allowed = set(families)
        selected = tuple(task for task in selected if task.task_family in allowed)
    if languages is not None:
        allowed_languages = set(languages)
        selected = tuple(task for task in selected if task.language in allowed_languages)
    if ids is not None:
        allowed_ids = set(ids)
        selected = tuple(task for task in selected if task.id in allowed_ids)
    return selected


def suite_coverage(tasks: "tuple[EvalTask, ...]" = BUILTIN_TASKS) -> dict[str, list[str]]:
    """Report which families and languages a task collection covers.

    Used by the test suite to assert coverage of :data:`REQUIRED_FAMILIES` and
    :data:`REQUIRED_LANGUAGES`, and by report rendering to show gaps.
    """

    families = sorted({task.task_family for task in tasks})
    languages = sorted({task.language for task in tasks})
    return {
        "task_family": families,
        "language": languages,
        "missing_families": sorted(set(REQUIRED_FAMILIES) - set(families)),
        "missing_languages": sorted(set(REQUIRED_LANGUAGES) - set(languages)),
    }


def validate_suite(tasks: "tuple[EvalTask, ...]" = BUILTIN_TASKS) -> None:
    """Raise :class:`ValueError` if the suite is internally inconsistent.

    Checks that identifiers are unique and that the declared coverage is
    actually met. Called by the test suite; cheap enough to call at run time
    before a long evaluation so a broken suite fails in seconds, not hours.
    """

    seen: set[str] = set()
    duplicates: list[str] = []
    for task in tasks:
        if task.id in seen:
            duplicates.append(task.id)
        seen.add(task.id)
    if duplicates:
        raise ValueError(f"duplicate eval task ids: {', '.join(sorted(set(duplicates)))}")

    gaps = suite_coverage(tasks)
    problems: list[str] = []
    if gaps["missing_families"]:
        problems.append(f"uncovered task families: {', '.join(gaps['missing_families'])}")
    if gaps["missing_languages"]:
        problems.append(f"uncovered languages: {', '.join(gaps['missing_languages'])}")
    if problems:
        raise ValueError("evaluation suite does not meet declared coverage: " + "; ".join(problems))
