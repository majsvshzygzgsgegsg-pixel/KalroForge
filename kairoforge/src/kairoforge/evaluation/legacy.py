"""Legacy evaluation helper, retained for backwards compatibility.

The original single-module ``kairoforge/evaluation.py`` provided only
``write_dry_run_report``. That module is now shadowed by this package, so
``scripts/evaluate.py`` - which imports the helper from ``kairoforge.evaluation``
- would otherwise fail at import. The helper is re-exported here so the
existing import path keeps resolving.

It is deliberately kept as narrow as it was: a dry-run report states plainly
that nothing was evaluated, which is the honest output when no checkpoint
exists yet.
"""

from __future__ import annotations

from pathlib import Path

__all__ = ["write_dry_run_report"]


def write_dry_run_report(path: Path) -> None:
    """Write an explicit dry-run evaluation report.

    This file proves only that the evaluation command executed. It must never
    be mistaken for a measurement, so it says so in the body.
    """

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "# KairoForge evaluation dry run\n\n"
        "No model checkpoint was evaluated. This file proves only that the "
        "evaluation command executed.\n"
        "Run the real evaluator after a checkpoint exists.\n",
        encoding="utf-8",
    )
