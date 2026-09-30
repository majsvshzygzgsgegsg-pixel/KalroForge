#!/usr/bin/env python3
"""Evaluate KairoForge checkpoints."""

from __future__ import annotations

import argparse
from pathlib import Path

from kairoforge.evaluation import write_dry_run_report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="configs/training.yaml")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--output", default="evaluations/kairoforge-v0.1-dry-run.md")
    args = parser.parse_args()
    if args.dry_run:
        write_dry_run_report(Path(args.output))
        print(f"Wrote {args.output}")
        return
    raise SystemExit("Real evaluation requires a trained checkpoint. Run with --dry-run until training completes.")


if __name__ == "__main__":
    main()
