# KairoForge cloud training plan

## Base model choice

Initial base model: `Qwen/Qwen2.5-Coder-1.5B-Instruct`.

Reasoning:

- Apache-2.0 license permits fine-tuning and redistribution of derived adapters when obligations are met.
- Small enough for a first QLoRA smoke test.
- Built for coding tasks.
- Supported by standard Hugging Face, Transformers, PEFT, and TRL tooling.

## First paid run proposal template

Before any cloud GPU is created, fill this in and ask for approval:

| Item | Value |
| --- | --- |
| Provider | NOT SELECTED |
| GPU | NOT SELECTED |
| GPU count | 1 |
| Hourly price | NOT QUOTED |
| Estimated duration | NOT ESTIMATED |
| Max budget | NOT SET |
| Auto-shutdown | Required |
| Persistent storage | Required |

## Required stages

1. Local dry run with no model download.
2. Local or cheap cloud smoke test with tiny dataset.
3. Verify checkpoint save and reload.
4. Evaluate base model and KairoForge on the same tasks.
5. Only then run a larger paid training job.

## Current blockers

- This Mac has too little free disk space for reliable local model downloads.
- Docker is not installed.
- No cloud provider and GPU budget have been approved.
- No large licensed training dataset has been assembled yet.
