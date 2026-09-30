# KairoForge status report

KAIROFORGE VERSION: `kairoforge-v0.1-scaffold`

BASE MODEL: `Qwen/Qwen2.5-Coder-1.5B-Instruct`

PARAMETER COUNT: `1.5B`

TRAINING METHOD: Planned QLoRA/LoRA supervised fine-tuning

TRAINABLE PARAMETERS: NOT COMPLETED

TRAINING DATASET SIZE: demo dataset only

TOKENS TRAINED: NOT COMPLETED

CLOUD PROVIDER: NOT SELECTED

GPU: NOT SELECTED

GPU COUNT: NOT APPROVED

TRAINING TIME: NOT COMPLETED

TRAINING COST: `$0` from this scaffold work

FINAL CHECKPOINT: NOT COMPLETED

CHECKPOINT HASH: NOT COMPLETED

EVALUATION RESULTS: NOT COMPLETED

DEPLOYMENT STATUS: local API scaffold only

MODEL API ENDPOINT: local scaffold exposes `/health`, `/v1/models`, and `/v1/chat/completions`

MODEL IDENTIFIER: `kairoforge`

RUNNING CLOUD COST: `$0`

HOW TO STOP THE SERVICE: stop the local `uvicorn` process, or terminate the approved cloud service after deployment exists.

HOW TO TRAIN KAIROFORGE V0.2: create a new dataset manifest, update `configs/training.yaml` output/version fields, run a dry run, get GPU spend approval, run cloud smoke, then run the full approved training job.
