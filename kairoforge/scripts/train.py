#!/usr/bin/env python3
"""Run or dry-run KairoForge training."""

from __future__ import annotations

import argparse

from kairoforge.config import load_training_config
from kairoforge.training import run_training


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="configs/training.yaml")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    run_training(load_training_config(args.config), dry_run=args.dry_run)


if __name__ == "__main__":
    main()
