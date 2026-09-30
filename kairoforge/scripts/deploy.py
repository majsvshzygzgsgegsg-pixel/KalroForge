#!/usr/bin/env python3
"""Cost-gated cloud deployment placeholder for KairoForge."""

from __future__ import annotations

import argparse
from pathlib import Path

from kairoforge.config import load_yaml


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cloud-config", default="configs/cloud.yaml")
    parser.add_argument("--approve-spend", action="store_true")
    args = parser.parse_args()
    cloud = load_yaml(Path(args.cloud_config))["cloud"]
    missing = [key for key in ["provider", "gpu_type", "hourly_price_usd", "max_budget_usd"] if cloud.get(key) in {None, "unset"}]
    if missing:
        raise SystemExit(f"Cloud config is incomplete. Missing: {', '.join(missing)}")
    if not args.approve_spend:
        raise SystemExit("Refusing to create paid resources without --approve-spend after user approval.")
    raise SystemExit("Provider-specific deployment is not implemented yet.")


if __name__ == "__main__":
    main()
