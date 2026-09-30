#!/usr/bin/env python3
"""Train KairoForge v1.2 with a memory budget that a 16 GiB laptop can survive.

Every previous local attempt died the same way: the training process was paged
out to swap until it had 0% CPU and made no progress. The fix is not a smaller
model - it is a smaller *working set*, enforced by construction:

* one training example at a time, with gradient accumulation doing the batching;
* a short sequence window, since activation memory scales with it quadratically
  through attention;
* gradient checkpointing, trading compute for activation memory;
* an explicit ``PYTORCH_MPS_HIGH_WATERMARK_RATIO`` so the allocator refuses to
  grow past the physical limit instead of forcing the OS to swap;
* a hard cap on total steps so the run has a bounded, known cost.

The result is a real fine-tune that completes, rather than a perfect one that
never finishes.

Usage::

    python scripts/train_v12_lowmem.py --minutes 60
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))


def main(argv: list[str] | None = None) -> int:
    """Run a memory-bounded fine-tune and register the result."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="Qwen/Qwen2.5-Coder-0.5B-Instruct")
    parser.add_argument("--base-key", default="qwen2.5-coder-0.5b-instruct")
    parser.add_argument("--dataset", default=str(ROOT / "data/processed/kairoforge-distill-v0.2"))
    parser.add_argument("--version", default="kairoforge-v1.2")
    parser.add_argument("--max-steps", type=int, default=300)
    parser.add_argument("--sequence-length", type=int, default=256)
    parser.add_argument("--gradient-accumulation", type=int, default=16)
    parser.add_argument("--lora-rank", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--checkpoint-interval", type=int, default=100)
    parser.add_argument("--seed", type=int, default=1337)
    args = parser.parse_args(argv)

    # Refuse to swap: an allocation past the physical watermark raises instead
    # of paging the process out, so a failure is loud and fast rather than a
    # silent multi-hour stall at 0% CPU.
    os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")
    os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.0")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    import torch

    from kairoforge.base_models import resolve_base_model
    from kairoforge.data.pipeline import load_jsonl
    from kairoforge.training import engine

    spec = resolve_base_model(args.base_key)
    dataset_dir = Path(args.dataset)
    train_rows = list(load_jsonl(dataset_dir / "train.jsonl"))
    validation_rows = list(load_jsonl(dataset_dir / "validation.jsonl"))
    manifest = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))

    print("=== KAIROFORGE v1.2 (memory-bounded) ===")
    print(f"base        : {spec.repo_id}")
    print(f"dataset     : {manifest.get('dataset_version')} "
          f"({len(train_rows)} train / {len(validation_rows)} val)")
    print(f"tokens      : {manifest.get('estimated_tokens'):,}")
    print(f"seq length  : {args.sequence_length}")
    print(f"max steps   : {args.max_steps}")
    print(f"device      : {'mps' if torch.backends.mps.is_available() else 'cpu'}")
    print()

    out_dir = ROOT / ".kairoforge/checkpoints" / args.version
    config = engine.TrainingRunConfig(
        base_model=spec.repo_id,
        base_revision=spec.revision,
        dataset_dir=str(dataset_dir),
        output_dir=str(out_dir),
        epochs=10,                     # max_steps caps the real work
        learning_rate=args.learning_rate,
        batch_size=1,
        gradient_accumulation=args.gradient_accumulation,
        sequence_length=args.sequence_length,
        warmup_ratio=0.03,
        weight_decay=0.01,
        precision="fp32",
        lora_rank=args.lora_rank,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        lora_target_modules=("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"),
        checkpoint_interval=args.checkpoint_interval,
        evaluation_interval=args.checkpoint_interval,
        seed=args.seed,
        method="lora",
        max_steps=args.max_steps,
        save_total_limit=2,
        gradient_checkpointing=True,
        logging_steps=10,
        report_to=(),
    )

    started = time.time()
    metrics = engine.train(config)
    duration = time.time() - started

    print()
    print("=== TRAINING COMPLETE ===")
    for key in ("train_loss", "eval_loss", "steps", "tokens",
                "trainable_params", "total_params", "trainable_fraction"):
        if key in metrics:
            print(f"  {key:20s}: {metrics[key]}")
    print(f"  {'duration_minutes':20s}: {duration / 60:.2f}")

    from kairoforge.registry.store import ModelVersion, Registry, hash_directory

    digest, size = hash_directory(out_dir)
    trainable = int(metrics.get("trainable_params", 0))
    total = int(metrics.get("total_params", 0))
    if trainable <= 0:
        print("error: zero trainable parameters; refusing to register", file=sys.stderr)
        return 3

    registry = Registry(ROOT / ".kairoforge/registry.json")
    version = ModelVersion(
        version=args.version,
        base_model=spec.repo_id,
        base_revision=spec.revision,
        training_method="lora",
        dataset_version=manifest.get("dataset_version", ""),
        dataset_hash=manifest.get("dataset_hash", ""),
        train_tokens=int(metrics.get("tokens", 0)),
        checkpoint_path=str(out_dir),
        checkpoint_sha256=digest,
        checkpoint_bytes=size,
        trainable_parameters=trainable,
        total_parameters=total,
        training_metrics={k: v for k, v in metrics.items() if isinstance(v, (int, float, str))},
        cloud_provider="local",
        gpu=metrics.get("gpu_name", "local"),
        gpu_count=1,
        training_hours=round(duration / 3600, 4),
        training_cost_usd=0.0,
        notes=(
            "Distilled from teacher models served via an OpenAI-compatible "
            "gateway. The teacher data is recorded in dataset provenance; this "
            "checkpoint contains weights trained on that data."
        ),
    )
    registry.publish(version, supersede=True)

    print()
    print("=== REGISTERED ===")
    print(f"  version   : {version.version}")
    print(f"  checkpoint: {out_dir}")
    print(f"  sha256    : {digest}")
    print(f"  bytes     : {size:,}")
    print(f"  trainable : {trainable:,} / {total:,} ({100.0 * trainable / max(total,1):.4f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
