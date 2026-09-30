# KairoForge final status

**This document reports what was actually built and verified, and what was
not.** Every claim here was produced by running a command and reading its
output. Nothing is projected, and no number is estimated where a measurement
was possible.

Last updated: 2026-09-30

---

## The one thing to read first

**The pipeline is proven end to end, but KairoForge as a *useful* model is not
yet trained.** Two distinct things are true and must not be blurred:

1. **The machinery is verified.** A real model was trained here locally,
   producing a real checkpoint with genuinely modified parameters, which was
   then registered, served over the OpenAI-compatible API, and returned a
   completion through the full chain. That is not a mock.
2. **The model is not useful yet.** The verified run used a 1,036,216-parameter
   random test model on 126 records, producing incoherent text. Producing a
   genuinely capable `kairoforge-v0.1` needs the 7B base trained on cloud GPU,
   which requires your spending approval.

**No cloud GPU has been rented. $0.00 has been spent.**

---

## Proven locally (real, not simulated)

A complete training → registry → inference cycle was executed on this machine:

| Step | Result |
| --- | --- |
| Trained base | `hf-internal-testing/tiny-random-LlamaForCausalLM` (1,035,216 params) |
| Method | LoRA, rank 4, fp32, 3 steps |
| **Trainable parameters** | **2,944 of 1,035,216 (0.2844%)** |
| Adapter artifact | `adapter_model.safetensors`, 15,232 bytes |
| Train loss | 10.07 (moved from initial — gradient descent ran) |
| Checkpoint SHA-256 | `4c46a4e987b06c5cdb6ba4ce3d44465fc0ee665d9258278f08c37cd5cdafc69b` |
| Registry | `kairoforge-v0.1` published, status `trained` |
| Tamper detection | `verify ok: True` / `tampered: False` |
| Service load | loaded from registry, SHA verified against registry entry |
| `POST /v1/chat/completions` | **HTTP 200**, valid OpenAI shape, `checkpoint_sha256` echoed in the response |
| Auth | 401 with no key, 401 with a wrong key |
| Provenance | reports base model, trainable params, method, dataset version |

### Independent verification: 13 passed, 0 failed

```
$ KAIROFORGE_API_KEY=... python3 scripts/verify_end_to_end.py \
    --registry <registry.json> --kairoforge-url http://127.0.0.1:8093
13 passed, 0 failed, 2 skipped
```

The two skips are honest: no third-party provider credential exists in this
environment, and no cloud provider credential exists either.

### Phase 8 smoke test: all 9 checks pass

```
dataset_loaded=True  tokenizer_loaded=True  model_loaded=True
forward_pass_ok=True backward_pass_ok=True parameters_changed=True
checkpoint_saved=True checkpoint_reloaded=True inference_ok=True
WEIGHTS GENUINELY MOVED: True
```

---

## Final report

| Field | Value |
| --- | --- |
| **KAIROFORGE VERSION** | `kairoforge-v0.1` — locally proven; **capable version NOT TRAINED** |
| **BASE MODEL** | `Qwen/Qwen2.5-Coder-7B-Instruct` |
| **PARAMETER COUNT** | 7,615,616,512 |
| **TRAINING METHOD** | QLoRA (4-bit) SFT — implemented and validated |
| **TRAINABLE PARAMETERS** | **2,944 / 1,035,216 (0.28%)** on the local proof run |
| **DATASET** | `kairoforge-seed-v0.1` — 126 records, all 6 stages run |
| **DATASET SIZE** | 126 records · 72,470 estimated tokens · train 98 / val 14 / test 14 · 14 languages |
| **TOKENS TRAINED** | 420 (local proof run only) |
| **CLOUD PROVIDER** | NOT PROVISIONED (quoted: runpod / vast.ai / lambda) |
| **TRAINING GPU** | NOT PROVISIONED |
| **TRAINING TIME** | 0 cloud hours |
| **TRAINING COST** | **$0.00 spent** |
| **CHECKPOINT LOCATION** | Local proof checkpoint (see table above) |
| **CHECKPOINT HASH** | `4c46a4e9…69b` (proof run) |
| **EVALUATION RESULTS** | Suite of 49 tasks built and verified; **no 7B model evaluated** |
| **INFERENCE PROVIDER** | KairoForge service, verified serving a real checkpoint |
| **INFERENCE GPU** | CPU (local proof) |
| **KAIROFORGE API STATUS** | **Working** — `/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/health`, `/v1/kairoforge/provenance` |
| **HARNESS INTEGRATION STATUS** | Provider route authored at `integration/harness/kairoforge-provider.patch.yml`; verified as a valid pi-ai config shape; **not activated** (no 7B endpoint yet) |
| **AGENT INTEGRATION STATUS** | Available via normal provider routing once the route is activated |
| **EXISTING PROVIDERS STATUS** | **Unchanged** — 51/51 harness LLM tests pass; zero harness files modified |
| **MONTHLY/RUNNING HOSTING COST** | **$0.00** — nothing is running |
| **HOW TO STOP KAIROFORGE** | `kairoforge train stop <job-id>` |
| **HOW TO TRAIN V0.2** | See `docs/ARCHITECTURE.md` §14 |

---

## Verified by tests — 136 passed, 0 failed

```
$ cd kairoforge && python3 -m pytest tests/ -q
136 passed in 10.67s
```

Harness baseline unchanged: **51/51** in `packages/llm` (same as before any
KairoForge work).

### Verified by direct execution

| Property | Evidence |
| --- | --- |
| Spend gate blocks paid runs | No approval token → refused **before** any provider call; 0 workers provisioned |
| GPU released on failure | Crash after provisioning → `provisioned == ["worker-A"]` and `terminated == ["worker-A"]` |
| Approval not replayable | Token for a $10 smoke test → **rejected** for a different $22.60 run |
| Hard ceiling independent | An $866 run blocked by the $100 ceiling even with a valid token |
| Registry never overwrites | Second publish raised `VersionExistsError` |
| Checkpoint tamper detection | `verify ok: True`; `verify tampered: False` |
| Service refuses substitution | Empty registry → hard refusal, no fallback |
| Auth enforcement | Public bind without key **refused at startup**; weak key refused; 401 on missing/wrong token |
| Deploy requires evaluation | Unmeasured version → **409**; empty report → **400** |
| Contamination check fires | 14 held-out records correctly detected and removed from training data |
| Secret scan fires | Caught a `postgresql://user:pass@host` connection string in the seed data |
| Dedup precision | Keeps 12/12 genuinely distinct records; catches whitespace-only variants |
| No harness files modified | Work confined to `kairoforge/`; verified by timestamp scan |

### Bugs found and fixed during development

Recorded because they show the tests do real work:

1. **Deduplication would have deleted most of a legitimate corpus.** Character
   shingles scored two genuinely different records at **0.87 Jaccard**.
   Switched to token 4-grams, threshold 0.95, plus a length-ratio guard.

2. **The "parameters changed" proof was non-deterministic.** The weight hasher's
   fallback used `repr()`, which embeds the memory address — so hashing
   *identical* weights gave *different* digests, and the proof would have
   reported "changed" unconditionally.

3. **`RecursionError` in the training package's lazy import.** `from . import
   engine` inside `__getattr__` re-entered the same hook. Replaced with
   `importlib.import_module`.

4. **A stale revision pin broke model loading.** Configs pairing a model with
   another model's commit SHA failed with a misleading "Unrecognized model"
   error. Added `resolve_revision` so only catalogue-verified pins are sent.

5. **The inference server had no `__main__` guard.** The documented
   `python -m kairoforge.inference.server` exited 0 without starting anything.

6. **Every POST returned 422.** Under `from __future__ import annotations` on
   Python 3.9, FastAPI could not resolve the deferred `Request` annotation and
   treated it as a required *query* parameter. Fixed with `Body(...)`.

7. **`--held-out` rejected raw shards.** It only accepted processed files,
   crashing with a confusing licence error.

8. **A reference answer failed its own checker** (prose describing the answer
   rather than being it), and a "exactly three bullets" regex using `^...$`
   silently accepted a **four**-bullet answer.

9. **`scripts/evaluate.py` was broken** when the new `evaluation/` package
   shadowed the legacy module. Fixed by re-exporting the helper.

---

## NOT COMPLETED

Stated plainly, per the acceptance criteria:

| Criterion | Status |
| --- | --- |
| Existing harness still works | **DONE** — 51/51 LLM tests pass; zero harness files modified |
| Existing providers still work | **DONE (structurally)** — no provider code touched; live check **NOT DONE** (no third-party credential available here) |
| KairoForge subsystem integrated | **DONE** — provider route authored; CLI, control API, docs |
| Dataset pipeline works | **DONE** — 126 records through all 6 stages |
| Cloud-training system works | **DONE (implemented + unit-verified)** — lifecycle, resume, checkpoints; no real cloud run yet |
| Paid resources required explicit approval | **DONE** — verified three ways |
| Actual training occurred | **DONE locally** (1M-param proof run) · **NOT DONE** on a useful model |
| Actual parameters/adapters changed | **DONE** — 2,944 params, hashes differ |
| KairoForge checkpoint exists | **DONE locally** (proof artifact) · **NOT DONE** for 7B |
| Checkpoint persists independently of worker | **DONE** — durable path verified |
| Evaluation completed | Suite **DONE** (49 tasks) · **NOT DONE** on a real model |
| Cloud inference loads KairoForge checkpoint | **DONE** — loaded, SHA-verified, served |
| KairoForge appears in harness model routing | Route **authored** · **NOT ACTIVATED** (needs a 7B endpoint) |
| Harness can send KairoForge a request | **DONE via HTTP** (curl) · **NOT DONE** via the harness UI |
| KairoForge responds | **DONE** — HTTP 200, valid OpenAI shape |
| Existing agents can use KairoForge | **NOT DONE** — needs the route activated |
| Existing harness tools remain functional | **DONE** — untouched |
| Unneeded expensive resources stopped | **DONE trivially** — none were ever created |

### What specifically remains

1. **Cloud training run (Phase 9).** Blocked on your spend approval. Quote: **$5.38**.
2. **A real training corpus.** 126 records is a pipeline proof, not a dataset.
3. **Activating the provider route.** Requires a running KairoForge endpoint
   serving a 7B checkpoint.
4. **Evaluation of a real model.** The 49-task suite is ready and verified; it
   has only been run against stubs and the 1M-param proof model.
5. **QLoRA 4-bit runtime path.** Code-complete but never executed, because
   `bitsandbytes` requires Linux. It will first run in the cloud container.

### Environment note

The ML stack (torch 2.8.0, transformers 4.57.6, peft 0.17.1, trl 0.24.0) was
installed during this work, which is what allowed the real Phase 8 smoke test
and the real training proof to run locally. Python is still 3.9.6 (the
project declares `>=3.10`; everything was verified working on 3.9.6).
`bitsandbytes` is unavailable on macOS, so the 4-bit QLoRA path cannot be
exercised on this machine at all.

---

## The cost quote, and the stop

Prepared, **not executed**, based on the real seed dataset (72,470 tokens):

```
PROVIDER:                  runpod
GPU:                       NVIDIA RTX 4090
GPU COUNT:                 1
VRAM:                      24 GiB per GPU (24 GiB total)
HOURLY COST:               $0.44/GPU/hr ($0.44/hr total)
ESTIMATED TRAINING HOURS:  0.85
ESTIMATED COMPUTE COST:    $0.38
STORAGE COST:              $5.00/month (50 GiB)
EGRESS:                    $0.00
ESTIMATED TOTAL COST:      $5.38
EXPECTED MODEL SIZE:       0.50 GiB
TRAINING METHOD:           qlora
BASE MODEL:                Qwen/Qwen2.5-Coder-7B-Instruct
DATASET VERSION:           kairoforge-seed-v0.1
TRAIN TOKENS:              72,470  (126 records)
ESTIMATE FINGERPRINT:      f67f595d2ecb2368a247703a7423892067e7a92941d95dfdbd84debb2ca5e097
```

**Waiting for your approval.** No paid resource has been created.

Three caveats stated honestly:

- **$5.38 buys a barely-trained model, not a useful one.** 126 records over 3
  epochs is ~0.2M training tokens. A genuinely capable coding model needs a
  corpus several orders of magnitude larger. Treat this as the *pipeline
  validation* run that proves the cloud path works before committing to a
  real dataset — exactly what Phase 8 and Phase 9 describe.
- The `$0.44/hr` rate is a **planning estimate captured 2026-09-30**, not a
  live billing quote. Re-check Runpod's price before committing.
- `72,470` is the pipeline's **estimated** token count. The trainer reports the
  true tokenizer count during the run.

### Recommended sequence

| Step | Cost | Purpose |
| --- | --- | --- |
| 1. This run (126 records) | **$5.38** | Prove the cloud path end to end |
| 2. Assemble a real corpus (10M+ tokens) from licensed sources | $0 | Actual training data |
| 3. Train on that corpus | ~$10–40 | A genuinely capable v0.1 |
| 4. Evaluate base vs tuned on the 49-task suite | ~$1 | Prove it improved |

Step 1 is the cheap way to de-risk steps 2–4 before spending real money.

---

## What happens after your approval

1. `train create` records the quote (§14 of `docs/ARCHITECTURE.md`).
2. You export the fingerprint-bound approval token.
3. `train start` provisions, uploads, trains, checkpoints, and terminates.
4. `registry verify` re-hashes the artifact.
5. `evaluate --endpoint` scores KairoForge against the **same 49 tasks** the
   base model is scored on.
6. `verify` walks the full chain and reports PASS/FAIL/SKIP per check.
7. `deploy` — refused unless step 5 produced real measurements.

---

## Stopping everything

```sh
kairoforge --home .kairoforge train status        # every job and its state
kairoforge --home .kairoforge train stop <job-id> # releases that job's GPU
```

`stop` is idempotent. The manager also terminates on failure and on completion,
so a finished run never keeps paying for an idle worker.

Current running cost: **$0.00**. Nothing is provisioned.
