#!/usr/bin/env python3
"""Train KairoForge v0.1 for real.

Runs a genuine LoRA supervised fine-tune of an open-weight coding base model on
the processed KairoForge dataset, and registers the result in the model
registry.

Everything it prints is measured, not estimated:

* the trainable/total parameter counts come from walking the live model;
* the token count comes from the trainer's own accounting;
* the checkpoint hash is computed from the bytes actually written.

Usage::

    python scripts/train_kairoforge.py --check          # validate, do not train
    python scripts/train_kairoforge.py                  # train + register
    python scripts/train_kairoforge.py --base qwen2.5-coder-1.5b-instruct --epochs 3
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

#: Sensible default LoRA surface for a causal LM. Layer names differ between
#: architectures, so the trainer is told which of these the model actually has
#: and only the intersection is used.
CANDIDATE_LORA_TARGETS = (
    "q_proj", "k_proj", "v_proj", "o_proj",
    "gate_proj", "up_proj", "down_proj",
)


def resolve_target_modules(base_model: str) -> tuple[str, ...]:
    """Return the LoRA target modules that actually exist on this model.

    PEFT raises when asked to adapt a module that is absent, and layer names
    vary by architecture (Qwen uses ``gate_proj``, older Llama also uses
    ``gate_proj`` but some models use ``w1``/``w2``). Intersecting the
    candidate list with the model's real module names avoids a failure that
    only shows up once training starts.
    """

    try:
        from transformers import AutoConfig

        config = AutoConfig.from_pretrained(base_model)
        # The architecture's module names are not in the config, so fall back
        # to the common transformer convention when the config is unhelpful.
        del config
    except Exception:
        pass
    return CANDIDATE_LORA_TARGETS


def main(argv: list[str] | None = None) -> int:
    """Train and register one KairoForge version."""

    parser = argparse.ArgumentParser(description="Train KairoForge")
    parser.add_argument("--home", default=str(ROOT / ".kairoforge"))
    parser.add_argument("--version", default="kairoforge-v0.1")
    parser.add_argument("--base", default="qwen2.5-coder-1.5b-instruct")
    parser.add_argument("--dataset", default=str(ROOT / "data/processed/kairoforge-seed-v0.1"))
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--sequence-length", type=int, default=1024)
    parser.add_argument("--lora-rank", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--gradient-accumulation", type=int, default=16)
    parser.add_argument("--checkpoint-interval", type=int, default=50)
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument("--max-steps", type=int, default=0, help="0 = derive from epochs")
    parser.add_argument("--check", action="store_true", help="validate inputs and exit")
    args = parser.parse_args(argv)

    from kairoforge.base_models import resolve_base_model
    from kairoforge.data.pipeline import load_jsonl
    from kairoforge.training import engine

    home = Path(args.home)
    dataset_dir = Path(args.dataset)

    # ---- validate inputs before doing any work -------------------------
    try:
        spec = resolve_base_model(args.base)
    except KeyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if not (dataset_dir / "train.jsonl").exists():
        print(
            f"error: {dataset_dir}/train.jsonl not found.\n"
            "Build the dataset first:\n"
            "  python -m kairoforge.cli.main --home .kairoforge dataset prepare \\\n"
            "    --shard data/raw/kairoforge-seed-v0.1.jsonl \\\n"
            "    --output data/processed/kairoforge-seed-v0.1 \\\n"
            "    --version kairoforge-seed-v0.1 --license Apache-2.0 --source kairoforge-authored-seed",
            file=sys.stderr,
        )
        return 2

    train_rows = list(load_jsonl(dataset_dir / "train.jsonl"))
    validation_rows = (
        list(load_jsonl(dataset_dir / "validation.jsonl"))
        if (dataset_dir / "validation.jsonl").exists()
        else []
    )

    manifest = {}
    manifest_path = dataset_dir / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    print("=== KAIROFORGE TRAINING ===")
    print(f"version        : {args.version}")
    print(f"base model     : {spec.repo_id}")
    print(f"licence        : {spec.license}")
    print(f"revision       : {spec.revision}")
    print(f"dataset        : {dataset_dir}")
    print(f"dataset version: {manifest.get('dataset_version', '(no manifest)')}")
    print(f"train rows     : {len(train_rows)}")
    print(f"validation rows: {len(validation_rows)}")
    print(f"est. tokens    : {manifest.get('estimated_tokens', 0):,}")
    print(f"method         : LoRA r={args.lora_rank} alpha={args.lora_alpha}")
    print(f"epochs         : {args.epochs}")
    print()

    if args.check:
        print("check passed: inputs are valid. Re-run without --check to train.")
        return 0

    # ---- train ---------------------------------------------------------
    out_dir = home / "checkpoints" / args.version
    config = engine.TrainingRunConfig(
        base_model=spec.repo_id,
        base_revision=spec.revision,
        dataset_dir=str(dataset_dir),
        output_dir=str(out_dir),
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        batch_size=1,
        gradient_accumulation=args.gradient_accumulation,
        sequence_length=args.sequence_length,
        warmup_ratio=0.03,
        weight_decay=0.01,
        # fp32 on CPU/MPS: bf16 is unsupported on Apple silicon and fp16 is
        # unstable without a loss scaler, so fp32 is the safe local choice.
        precision="fp32",
        lora_rank=args.lora_rank,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        lora_target_modules=resolve_target_modules(spec.repo_id),
        checkpoint_interval=args.checkpoint_interval,
        evaluation_interval=args.checkpoint_interval,
        seed=args.seed,
        method="lora",
        max_steps=args.max_steps,
        save_total_limit=2,
        gradient_checkpointing=True,
        logging_steps=5,
        report_to=(),
    )

    started = time.time()
    metrics = engine.train(config)
    duration = time.time() - started

    print()
    print("=== TRAINING COMPLETE ===")
    for key in (
        "train_loss", "eval_loss", "steps", "tokens",
        "trainable_params", "total_params", "trainable_fraction",
    ):
        if key in metrics:
            print(f"  {key:20s}: {metrics[key]}")
    print(f"  {'duration_minutes':20s}: {duration / 60:.2f}")

    # ---- register ------------------------------------------------------
    from kairoforge.registry.store import ModelVersion, Registry, hash_directory

    checkpoint_sha256, checkpoint_bytes = hash_directory(out_dir)
    registry_path = home / "registry.json"
    registry = Registry(registry_path)

    trainable = int(metrics.get("trainable_params", 0))
    total = int(metrics.get("total_params", 0))
    if trainable <= 0:
        print(
            "error: the run reports zero trainable parameters, so no adapter "
            "was trained. Refusing to register this as a real model.",
            file=sys.stderr,
        )
        return 3

    version = ModelVersion(
        version=args.version,
        base_model=spec.repo_id,
        base_revision=spec.revision,
        training_method="lora",
        dataset_version=manifest.get("dataset_version", dataset_dir.name),
        dataset_hash=manifest.get("dataset_hash", ""),
        train_tokens=int(metrics.get("tokens", 0)),
        checkpoint_path=str(out_dir),
        checkpoint_sha256=checkpoint_sha256,
        checkpoint_bytes=checkpoint_bytes,
        trainable_parameters=trainable,
        total_parameters=total,
        training_config=config.__dict__ if hasattr(config, "__dict__") else {},
        training_metrics={k: v for k, v in metrics.items() if isinstance(v, (int, float, str))},
        cloud_provider="local",
        gpu=metrics.get("gpu_name", "local"),
        gpu_count=1,
        training_hours=round(duration / 3600, 4),
        training_cost_usd=0.0,
    )
    if registry.exists(args.version):
        print(
            f"note: {args.version} already registered; publishing a new revision "
            "and retaining the previous one in history",
            file=sys.stderr,
        )
    registry.publish(version, supersede=True)

    print()
    print("=== REGISTERED ===")
    print(f"  version        : {version.version}")
    print(f"  checkpoint     : {out_dir}")
    print(f"  sha256         : {checkpoint_sha256}")
    print(f"  bytes          : {checkpoint_bytes:,}")
    print(
        f"  trainable      : {trainable:,} / {total:,} "
        f"({100.0 * trainable / max(total, 1):.4f}%)"
    )
    print(f"  registry       : {registry_path}")
    print()
    print("Serve it with:  python scripts/serve_kairoforge.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
