"""Evaluation helpers for comparing base and KairoForge checkpoints."""

from pathlib import Path


def write_dry_run_report(path: Path) -> None:
    """Write an explicit dry-run evaluation report."""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "# KairoForge evaluation dry run\n\n"
        "No model checkpoint was evaluated. This file proves only that the evaluation command executed.\n"
        "Run the real evaluator after a checkpoint exists.\n",
        encoding="utf-8",
    )
