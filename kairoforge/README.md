# KairoForge

KairoForge is the model-training project for creating a real KairoForge coding model from open-weight base models, licensed training data, reproducible fine-tuning, evaluation, and an OpenAI-compatible inference API.

This repository folder is intentionally not a fake model wrapper. Until training is actually run and verified, KairoForge is marked as `NOT TRAINED`.

## Current status

- Real trained checkpoint: **NOT COMPLETED**
- Cloud GPU training: **NOT COMPLETED**
- Paid cloud resources: **NOT CREATED**
- Local scaffold, configs, data pipeline, training entrypoint, evaluation entrypoint, inference API: **CREATED**

## Quick start

```sh
cd kairoforge
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[ml,server,dev]"
python scripts/prepare_data.py --input data/raw/examples.jsonl --output data/processed/examples.sft.jsonl --manifest data/manifests/examples.manifest.json
python scripts/train.py --config configs/training.yaml --dry-run
python scripts/evaluate.py --config configs/training.yaml --dry-run
python -m kairoforge.server --host 127.0.0.1 --port 8090
```

The dry-run commands validate configuration and data without downloading a large model or starting a training job.

## Intended first training method

The first KairoForge version should use QLoRA or LoRA supervised fine-tuning. Full fine-tuning is not practical until there is a larger budget, bigger verified dataset, and dedicated GPU storage.

## Cost safety

Do not run `scripts/deploy.py --approve-spend` or any provider command until the GPU type, provider, hourly price, estimated runtime, and total budget are approved.

See [docs/cloud-training-plan.md](docs/cloud-training-plan.md).
