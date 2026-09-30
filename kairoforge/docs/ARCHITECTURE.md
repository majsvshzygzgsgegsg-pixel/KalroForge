# KairoForge architecture

KairoForge is a **trained coding model** that plugs into this harness as one
more model provider. It is fine-tuned from an open-weight base model; it is
not a system prompt, not a renamed third-party model, and not a proxy.

This document describes how the pieces fit together, where the code lives, and
what is actually verified versus what is still outstanding.

---

## 1. Where KairoForge sits

```
                          USER
                            |
                            v
                 +---------------------+
                 |   EXISTING HARNESS  |   (TypeScript, Cordis, pnpm monorepo)
                 |  tools / agents /   |
                 |  plugins / MCP /    |
                 |  terminal / memory  |
                 +----------+----------+
                            |
                            v
                   +------------------+
                   |   MODEL ROUTER   |   @deepseek-ai/dsh-llm  (LlmRuntime)
                   +--------+---------+
                            |
            +---------------+----------------+
            |                                |
            v                                v
  +-------------------+            +-------------------+
  | EXISTING PROVIDERS|            |    KAIROFORGE     |   <- added, not replacing
  | deepseek, pi-ai,  |            |  provider route   |
  | freellmapi, ...   |            |  (openai-compat)  |
  +-------------------+            +---------+---------+
                                             |
                                             v
                                   +-------------------+
                                   | KAIROFORGE MODEL  |   OpenAI-compatible HTTP
                                   |     SERVICE       |   /v1/chat/completions
                                   +---------+---------+
                                             |
                                             v
                                   +-------------------+
                                   |  TRAINED KAIROFORGE|
                                   |     CHECKPOINT     |   Qwen2.5-Coder-7B + LoRA adapter
                                   +-------------------+
```

The KairoForge route is mounted by
`integration/harness/kairoforge-provider.patch.yml`, which **adds** a provider
entry to `llm-pi-ai`. No existing provider entry, credential, or route is
modified.

---

## 2. Training architecture

```
   HARNESS / CLI
        |
        v
  +-------------------------+
  | KAIROFORGE TRAINING     |  cloud/manager.py  (TrainingManager)
  | MANAGER                 |  - lifecycle, resume, budget gate
  +------------+------------+
               |
               v
  +-------------------------+
  | DATA PIPELINE           |  data/pipeline.py
  | ingest -> validate ->   |  6 stages, full per-stage accounting
  | secret-scan -> quality  |
  | -> dedup -> contaminate |
  | -> split -> manifest    |
  +------------+------------+
               |
               v
  +-------------------------+
  | CLOUD BACKEND           |  cloud/backend.py (CloudTrainingBackend)
  | (abstract)              |  cloud/local_backend.py, cloud/runpod_backend.py
  +------------+------------+
               |
               v
  +-------------------------+
  | CLOUD GPU + CONTAINER   |  cloud/Dockerfile
  +------------+------------+
               |
               v
  +-------------------------+
  | OPEN-WEIGHT BASE MODEL  |  base_models.py (verified catalogue)
  | Qwen2.5-Coder-7B-Instr  |
  +------------+------------+
               |
               v
  +-------------------------+
  | KAIROFORGE TRAINING     |  training/engine.py  (QLoRA / LoRA / full)
  | (SFT)                   |
  +------------+------------+
               |
               v
  +-------------------------+
  | KAIROFORGE CHECKPOINT   |  durable storage, sha256 recorded
  +------------+------------+
               |
               v
  +-------------------------+      +-------------------------+
  | EVALUATION              |----->| MODEL REGISTRY          |
  | evaluation/             |      | registry/store.py       |
  +------------+------------+      +------------+------------+
                                               |
                                               v
                                  +-------------------------+
                                  | CLOUD INFERENCE         |
                                  | inference/service.py    |
                                  +------------+------------+
                                               |
                                               v
                                  +-------------------------+
                                  | KAIROFORGE API          |
                                  | inference/server.py     |
                                  +------------+------------+
                                               |
                                               v
                                        back to the HARNESS
```

---

## 3. Component map

| Concept | Module | Responsibility |
| --- | --- | --- |
| Model provider | `integration/harness/kairoforge-provider.patch.yml` | Mounts KairoForge as a harness provider route |
| Training manager | `cloud/manager.py` | Job lifecycle, resume, **spend gate**, guaranteed worker release |
| Cloud backend | `cloud/backend.py` | Provider-agnostic interface; `LocalTrainingBackend`, `RunpodBackend` |
| Cost control | `cloud/cost.py` | Quotes, fingerprint-bound approval, hard ceiling |
| Data pipeline | `data/pipeline.py` | Ingest → split with full accounting |
| Secret detection | `data/secrets.py` | Structural + entropy credential detection |
| Deduplication | `data/quality.py` | Exact + MinHash near-duplicate removal |
| Schema | `data/schema.py` | Canonical record, provenance, licence classification |
| Training engine | `training/engine.py` | QLoRA/LoRA/full SFT, smoke test |
| Registry | `registry/store.py` | Versioned metadata, never overwrites, hash verification |
| Evaluation | `evaluation/` | Task suite, checkers, runner, base-vs-tuned comparison |
| Inference | `inference/service.py` | Loads and verifies a checkpoint; refuses substitution |
| API | `inference/server.py` | OpenAI-compatible endpoints with auth |
| Control API | `integration/control_api.py` | Training-control surface for the harness UI |
| CLI | `cli/main.py` | Human and script entry points |

---

## 4. Base model

KairoForge v0.1 is fine-tuned from **`Qwen/Qwen2.5-Coder-7B-Instruct`**.

| Property | Value |
| --- | --- |
| Repository | `Qwen/Qwen2.5-Coder-7B-Instruct` |
| Parameters | 7,615,616,512 |
| Context length | 32,768 tokens |
| Licence | Apache-2.0 (commercial use, fine-tuning, and derivative distribution permitted) |
| Pinned revision | `c03e6d358207e414f1eca0bb1891e29f1db0e242` |
| Tool calling | Supported natively by the chat template |
| Estimated QLoRA VRAM | ~10 GiB (single 24 GiB GPU) |
| Estimated LoRA VRAM | ~24 GiB |

**KairoForge is a derivative of this base model and is always described as
such.** The registry stores `base_model` and `base_revision` for every version,
and `/v1/kairoforge/provenance` reports them at runtime.

The verified catalogue (`base_models.py`) also contains the 1.5B (free smoke
tests), 14B and 32B (upgrade targets on the *same* pipeline), and
`Qwen/Qwen3-Coder-Next` (80B MoE, 262k context, Apache-2.0) as a longer-term
upgrade. All four Qwen2.5-Coder variants share a tokenizer family, context
length, and chat template, so scaling up is a configuration change rather than
a rewrite.

### Rejected base models, and why

| Model | Reason |
| --- | --- |
| DeepSeek-Coder-V2 | `deepseek-license`: permits fine-tuning, but §4.a propagates use-restrictions into your own agreement and §14 sets PRC governing law |
| StarCoder2 | `bigcode-openrail-m`: use-restrictions flow to derivatives |
| CodeGemma / Gemma | Gated; must propagate Google's use-restriction policy |
| Llama 3.x / 4 | Gated; 700M-MAU clause and "Built with Meta Llama" naming requirements |

> **Correction of record:** `DeepSeek-Coder-V3` does **not** exist (verified
> against the Hugging Face API: the newest official Coder artifact is
> `deepseek-ai/DeepSeek-Coder-V2-Instruct-0724`). No such base model was used.

---

## 5. Data pipeline

Six stages, each recording how many records it admitted and rejected *and why*.
That accounting is written into the dataset manifest, which becomes the
`dataset_version` recorded in the model registry.

| Stage | What it does | Example rejects |
| --- | --- | --- |
| 1. Ingest | Reads JSONL shards, maps to the canonical record, classifies licence | `invalid-record`; whole shard refused if licence is not trainable |
| 2. Secret scan | Structural patterns + Shannon-entropy heuristic near credential-shaped keys | `contains-secret` |
| 3. Quality filter | Length, refusal detection, placeholder detection, repetition, token diversity | `placeholder-content`, `refusal-response`, `low-token-diversity` |
| 4. Deduplicate | Exact content hash, then MinHash (128 perms, 16 bands) over **token** 4-grams | `duplicate`, `near-duplicate` |
| 5. Contamination | Drops records resembling held-out evaluation items | `evaluation-contamination` |
| 6. Split | Stratified by task family, guaranteeing ≥1 val and ≥1 test record per family | — |

### Two design decisions worth recording

**Token shingles, not character shingles.** The first implementation used
character 5-grams. Measurement showed two genuinely different records — the
same boilerplate with one index changed — scored **0.87 Jaccard**, which would
have deleted most of a legitimate corpus. Token 4-grams measure whether the
same *sequence of code tokens* repeats, and the threshold sits at 0.95.

**Length-ratio guard.** Two texts whose lengths differ by more than 1.5× are
never near-duplicates, so a short snippet contained in a long file is not
absorbed by it.

### Safety rules enforced in code

- A record whose licence classifies as unknown, proprietary, or share-alike is
  **dropped at ingest**; a shard with such a licence is refused outright.
- A record containing a detected credential is dropped, not redacted. Training
  on partially masked secrets still teaches the surrounding structure.
- Never train on credentials. Never ingest private repositories without
  explicit permission.

---

## 6. Cost controls

Before any billable resource is created, the manager renders:

```
PROVIDER:            runpod
GPU:                 NVIDIA RTX 4090
GPU COUNT:           1
VRAM:                24 GiB per GPU (24 GiB total)
HOURLY COST:         $0.44/GPU/hr ($0.44/hr total)
ESTIMATED TRAINING HOURS: 10.70
ESTIMATED COMPUTE COST:   $4.71
STORAGE COST:        $5.00/month (50 GiB)
EGRESS:              $0.00
ESTIMATED TOTAL COST:     $9.71
EXPECTED MODEL SIZE: 0.50 GiB
...
ESTIMATE FINGERPRINT: d68c8dfc...
```

Then it **stops** and waits.

### How the gate works

1. `require_spend_approval()` refuses unless `KAIROFORGE_SPEND_APPROVAL`
   carries a token matching the estimate's **fingerprint** — a SHA-256 over the
   provider, GPU, count, hourly rate, hours, storage, method, base model, and
   dataset version.
2. Approving a $10 smoke test therefore **cannot** be replayed to launch a
   $400 run: the fingerprint changes with every number that affects the bill.
3. A hard per-run ceiling (default **$100**, `--max-cost`) is checked
   *independently* of the token, catching a fat-fingered GPU count.
4. The `local` backend is exempt **explicitly and visibly** (it quotes $0 and
   says so) — not by a default-allow path.

### Verified behaviour

- Running a paid job with no approval token: **refused before any provider
  call**; zero workers provisioned.
- A crash *after* provisioning: the worker is still terminated — verified that
  `provisioned == ["worker-A"]` and `terminated == ["worker-A"]`.

The `finally` block on `TrainingManager.run` terminates whenever the job is
still billable, so no exception path can leave a GPU billing by the hour.

### Price accuracy caveat

Catalogue hourly rates are **planning estimates captured 2026-09-30**, not a
live billing quote. Every rendered estimate carries that warning. The manager
re-quotes the provider before starting and refuses when the live price exceeds
the approved figure.

---

## 7. Training engine

`training/engine.py` implements supervised fine-tuning with three methods:

| Method | Precision | Updates | Use |
| --- | --- | --- | --- |
| `qlora` | 4-bit base + bf16 adapters | LoRA adapters | **Default** — cheapest |
| `lora` | bf16 base + bf16 adapters | LoRA adapters | Faster per step, more VRAM |
| `full` | bf16 | All weights | Only when genuinely justified |

The full configuration surface is exposed: `base_model`, `base_revision`,
`dataset_dir`, `output_dir`, `epochs`, `learning_rate`, `batch_size`,
`gradient_accumulation`, `sequence_length`, `warmup_ratio`, `weight_decay`,
`precision`, `lora_rank`, `lora_alpha`, `lora_dropout`, `lora_target_modules`,
`checkpoint_interval`, `evaluation_interval`, `seed`, `method`, `max_steps`,
`save_total_limit`, `gradient_checkpointing`, `logging_steps`, `report_to`.

Training is resumable: `resume_from_checkpoint` is honoured, and the manager's
`resume()` re-approves the spend, re-provisions if needed, and restarts from a
durable checkpoint.

### The "parameters actually changed" proof

`smoke_test()` hashes the adapter weights **before and after** the optimizer
step and compares the digests. This is the check that distinguishes real
training from a run that executed but moved nothing.

> **Bug found and fixed during development.** The weight hasher's last-resort
> path used `repr()`, which embeds the object's memory address — so hashing
> *identical* weights produced *different* digests, and the proof would have
> reported "changed" unconditionally. It now unwraps tensor-like attributes and
> rejects identity-based rendering. Caught by
> `test_adapter_weight_hash_detects_byte_level_change`.

---

## 8. Model registry

`registry/store.py` tracks every version. Two invariants are enforced in code:

1. **Never overwrite.** Publishing an existing version raises
   `VersionExistsError` unless `supersede=True`, and even then the previous
   entry is retained in history.
2. **A checkpoint hash is mandatory.** An entry with no verifiable artifact
   hash, or a zero-byte checkpoint, is refused: that is a claim, not a model.

Recorded per version: model id, base model + revision, dataset version + hash,
training method, full training config, trainable/total parameters, checkpoint
path + sha256 + size, creation date, cloud provider, GPU, hours, cost,
evaluation results, deployment status and endpoint.

`verify_checkpoint()` re-hashes an artifact and compares it to the registry,
which is how a deployed model is proven to be the one that was evaluated.
Verified: `verify ok: True | verify tampered: False`.

---

## 9. Evaluation

`evaluation/` scores responses against a held-out suite with machine-checkable
references:

- Checkers: `exact`, `contains`, `regex`, `python-exec`, `rubric`.
- `python-exec` extracts Python from the response and runs it in a
  **subprocess** with a hard timeout and no shell — never `eval()` in-process.
- The runner produces per-task results, per-family and per-language breakdowns,
  and `compare_reports()` flags **regressions** where the tuned model is worse
  than the base.

The suite covers code generation, debugging, refactoring, explanation, test
generation, repository reasoning, multi-file reasoning, terminal reasoning,
tool planning, and instruction following.

> The most important test in the suite asserts that **every reference answer
> passes its own checker**. It caught a task whose reference was prose
> *describing* the answer rather than *being* it — which would have made that
> task's scores meaningless.

---

## 10. Deployment and inference

`inference/server.py` exposes the OpenAI-compatible surface the harness router
needs:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/models` | Lists registered KairoForge versions from the registry |
| `POST /v1/chat/completions` | Chat completion against the loaded checkpoint |
| `POST /v1/completions` | Legacy text completion |
| `GET /health` | Liveness plus which checkpoint is resident |
| `GET /v1/kairoforge/provenance` | Reports the exact artifact answering requests |

### No silent substitution

`ModelService.load()` hashes the checkpoint and compares it to the registry
entry before serving. A mismatch — or a missing registry, or an empty one —
raises. It never falls back to a third-party model. `kairoforge` and
`kairoforge-latest` are accepted as aliases for the deployed version so a
harness config can name the route stably while versions advance underneath.

### Security

- Binding a non-loopback address **without** an API key is a startup error, not
  a warning.
- Keys shorter than 16 characters are refused.
- Bearer comparison is constant-time (`hmac.compare_digest`).
- Credentials come from `KAIROFORGE_API_KEY`; nothing is hard-coded.
- Verified: public bind without a key refused; weak key refused; 401 on missing
  and wrong tokens.

---

## 11. Harness integration

### Provider route

`integration/harness/kairoforge-provider.patch.yml` mounts KairoForge through
`dsh-llm-pi-ai`, the harness's OpenAI-compatible provider adapter. The route
declares `api: openai-completions`, points `baseURL` at the KairoForge service,
and names the credential via `apiKeyEnv` (the harness resolves the secret
through its own credentials seam; the value is never stored in config).

`defaultInput: [text]` declares the negative capability honestly: KairoForge is
a fine-tuned causal LM with no vision tower, so the harness will not admit
screenshots this route could never read.

Existing providers keep their own entries, credentials, and behaviour.

### Agents and tools

Because KairoForge is a normal provider route, the harness's existing agent
system selects it the same way it selects any model:

```
CODING AGENT     -> KAIROFORGE
RESEARCH AGENT   -> EXISTING MODEL
OTHER AGENT      -> EXISTING MODEL
```

Tool use is **not** baked into the model. The harness executes tools; KairoForge
supplies reasoning and output. KairoForge-backed agents therefore retain
filesystem, terminal, Git, browser, web, MCP, plugin, and memory capabilities —
subject to the model's own competence at emitting tool calls, which evaluation
measures rather than assumes.

### Training control

`integration/control_api.py` exposes the full surface for the harness UI:
create job, dataset, base model, method, provider, GPU, estimated cost, start,
stop, status, logs, checkpoints, evaluate, deploy.

Spend safety survives the UI: `start_job` returns **402** with
`KAIROFORGE_SPEND_APPROVAL_REQUIRED` rather than starting a paid job without an
approved fingerprint. `deploy_version` returns **409** unless the version has
recorded evaluation results, so an unmeasured regression cannot ship.

---

## 12. Job states

The manager reports only states it actually observes:

`PENDING` → `PREPARING` → `WAITING_FOR_APPROVAL` → `PROVISIONING` →
`UPLOADING_DATA` → `STARTING` → `TRAINING` → `CHECKPOINTING` → `EVALUATING` →
`COMPLETED`, plus `FAILED` and `STOPPING`/`STOPPED`.

`TrainingProgress.percent` returns **`None`** when `total_steps` is unknown, so
the UI shows an indeterminate state instead of a fabricated 0%. No progress
percentage is ever synthesised.

---

## 13. Stopping cloud resources

```sh
# Stop one job and release its GPU:
kairoforge train stop <job-id>

# Every job, newest first:
kairoforge train status

# Confirm no checkpoint-bearing job is still billable:
kairoforge --home .kairoforge train status
```

`stop` is idempotent — calling it on a stopped job is a no-op, not an error.
The manager also terminates on failure and on completion, so a finished run
does not keep paying for an idle worker.

---

## 14. Training a new version

```sh
export PYTHONPATH=src
export KAIROFORGE_APPROVAL_SECRET='a-long-random-string'

# 1. Prepare data
kairoforge --home .kairoforge dataset prepare \
  --shard data/raw/kairoforge-seed-v0.2.jsonl \
  --output data/processed/kairoforge-seed-v0.2 \
  --version kairoforge-seed-v0.2 --license Apache-2.0 --source <provenance>

# 2. Quote it (creates nothing)
kairoforge --home .kairoforge train create \
  --version kairoforge-v0.2 --base-model qwen2.5-coder-7b-instruct \
  --dataset data/processed/kairoforge-seed-v0.2 \
  --dataset-version kairoforge-seed-v0.2 \
  --provider runpod --gpu "RTX 4090" --method qlora --epochs 2

# 3. REVIEW THE COST. STOP HERE. Get approval.

# 4. Approve that exact estimate
kairoforge --home .kairoforge approve --estimate .kairoforge/estimates/<job>.json
export KAIROFORGE_SPEND_APPROVAL=<token from the previous command>

# 5. Run it
kairoforge --home .kairoforge train start <job-id> --provider runpod

# 6. Verify, evaluate, deploy
kairoforge --home .kairoforge registry verify kairoforge-v0.2
kairoforge --home .kairoforge evaluate --version kairoforge-v0.2 --endpoint http://127.0.0.1:8090
kairoforge --home .kairoforge verify
```

Never overwrite `kairoforge-v0.1` in place: publish v0.2 as a new version and
let the registry keep both.

---

## 15. Verification

```sh
# Subsystem tests
cd kairoforge && PYTHONPATH=src python3 -m pytest tests/ -q

# End-to-end acceptance against a running service
python3 scripts/verify_end_to_end.py --registry .kairoforge/registry.json

# Environment diagnosis
kairoforge doctor
```

`scripts/verify_end_to_end.py` reports `PASS`, `FAIL`, or `SKIP` with a reason.
A check that cannot run is never reported as a pass.
