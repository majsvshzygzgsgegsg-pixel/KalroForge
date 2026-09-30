"""The ``kairoforge`` command-line interface.

Exposes the full training-control surface the harness and a human operator
both need:

    dataset prepare / inspect
    train create / start / status / logs / stop / resume
    estimate / approve / gpus
    registry list / show / verify
    evaluate
    serve
    verify            (end-to-end acceptance checks)
    doctor            (environment diagnosis)

Design rule: every command that could cost money prints the quote and refuses
to proceed without a matching approval token. Every command that reports state
reports *measured* state.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

#: Default root for KairoForge durable state.
DEFAULT_HOME = Path(os.environ.get("KAIROFORGE_HOME", ".kairoforge"))


def _paths(root: Path):
    from ..cloud.manager import ManagerPaths

    return ManagerPaths(root)


def _backend(name: str, root: Path | None = None):
    """Resolve a backend name to an implementation.

    ``root`` is the directory the backend owns: the local backend keeps its
    job bundles, "remote" prefix, run state, and logs there, which is what
    makes its cleanup verifiable. Cloud backends ignore it.

    The cloud backends are loaded lazily so the CLI works - and reports a
    clear message - without provider SDKs installed.
    """

    root = root if root is not None else DEFAULT_HOME / "backend"

    if name == "local":
        from ..cloud.local_backend import LocalTrainingBackend

        return LocalTrainingBackend(root)

    if name in {"runpod", "vast", "vast.ai", "lambda"}:
        try:
            from ..cloud.runpod_backend import RunpodBackend
        except ImportError as exc:
            raise SystemExit(
                f"the {name} backend requires provider support that is not "
                f"installed ({exc}). Use --provider local for a free local run."
            )
        return RunpodBackend()

    raise SystemExit(f"unknown backend {name!r}; expected one of: local, runpod, vast, lambda")


# ----------------------------------------------------------------------
# dataset
# ----------------------------------------------------------------------


def _load_held_out(path: Path, source: str, license: str) -> "list":
    """Load held-out evaluation records from either file form.

    Two shapes are legitimate and a user should not have to know which one
    they have:

    * a **processed** file, where each row already carries ``license_class``
      and can be rebuilt directly;
    * a **raw** shard, the same format ``--shard`` accepts, where the licence
      is a plain string that must be classified.

    Only accepting the first made ``--held-out <raw shard>`` fail with a
    confusing "licence was not classified" error, so both are handled here.
    Raw rows are mapped through the same ingest path the shards use, which
    also means a held-out row with an untrainable licence is rejected rather
    than silently accepted.
    """

    import json

    from ..data.schema import LicenseClass, TrainingRecord, license_class_for

    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if stripped:
                rows.append(json.loads(stripped))

    records = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        # Already canonical: every required field is present and typed.
        if "license_class" in row and "task_family" in row:
            records.append(TrainingRecord.from_json(row))
            continue

        license_name = str(row.get("license") or license or "")
        license_cls = license_class_for(license_name)
        if not license_cls.trainable:
            # A held-out item under an untrainable licence cannot be used for
            # comparison either, so it is skipped rather than admitted.
            continue

        instruction = row.get("instruction") or row.get("prompt")
        response = row.get("response") or row.get("completion") or row.get("output")
        if not isinstance(instruction, str) or not isinstance(response, str):
            continue
        if not instruction.strip() or not response.strip():
            continue

        records.append(
            TrainingRecord(
                id=str(row.get("id") or f"heldout:{index}"),
                instruction=instruction,
                response=response,
                task_family=str(row.get("task_family") or "code-generation"),
                language=str(row.get("language") or "text").lower(),
                source=str(row.get("source") or source or "held-out"),
                license=license_name,
                license_class=license_cls,
            )
        )
    return records


def cmd_dataset_prepare(args: argparse.Namespace) -> int:
    """Run the data pipeline over one or more raw shards."""

    from ..data.pipeline import process, PipelineError

    shards = [Path(p) for p in args.shard]
    missing = [str(p) for p in shards if not p.exists()]
    if missing:
        print(f"error: missing shard(s): {', '.join(missing)}", file=sys.stderr)
        return 2

    held_out: list = []
    if args.held_out:
        held_out_path = Path(args.held_out)
        if not held_out_path.exists():
            print(f"error: held-out file not found: {held_out_path}", file=sys.stderr)
            return 2
        try:
            held_out = _load_held_out(held_out_path, args.source, args.license)
        except Exception as exc:
            print(
                f"error: could not read held-out records from {held_out_path}: {exc}",
                file=sys.stderr,
            )
            return 2
        print(f"held-out records loaded: {len(held_out)}")

    try:
        manifest = process(
            shards=shards,
            output_dir=Path(args.output),
            dataset_version=args.version,
            held_out=held_out,
            validation_fraction=args.validation_fraction,
            test_fraction=args.test_fraction,
            seed=args.seed,
            similarity_threshold=args.similarity_threshold,
            source_override=args.source,
            license_override=args.license,
            max_records=args.max_records,
        )
    except PipelineError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"dataset version : {manifest.dataset_version}")
    print(f"dataset hash    : {manifest.dataset_hash}")
    print(f"records kept    : {manifest.total_records:,}")
    print(f"estimated tokens: {manifest.estimated_tokens:,}")
    print(f"splits          : {manifest.splits}")
    print()
    print("stage accounting (what was dropped, and why):")
    for stage in manifest.stages:
        reasons = ", ".join(f"{k}={v}" for k, v in stage.reasons.items()) or "none"
        print(
            f"  {stage.name:22s} admitted={stage.admitted:<7,} "
            f"rejected={stage.rejected:<7,} ({reasons})"
        )
    print()
    print(f"manifest written to {Path(args.output) / 'manifest.json'}")
    return 0


def cmd_dataset_inspect(args: argparse.Namespace) -> int:
    """Print the manifest for a processed dataset."""

    manifest_path = Path(args.dataset) / "manifest.json"
    if not manifest_path.exists():
        print(f"error: no manifest at {manifest_path}", file=sys.stderr)
        return 2
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    print(json.dumps(data, indent=2, sort_keys=True))
    return 0


# ----------------------------------------------------------------------
# cost and approval
# ----------------------------------------------------------------------


def cmd_gpus(args: argparse.Namespace) -> None:
    """List quoted GPU offers."""

    from ..cloud.cost import GPU_CATALOGUE, PRICE_STALENESS_WARNING

    print(f"{'PROVIDER':<10} {'GPU':<28} {'VRAM':>6} {'$/HR':>7}  NOTES")
    print("-" * 92)
    for offer in GPU_CATALOGUE:
        print(
            f"{offer.provider:<10} {offer.gpu:<28} {offer.vram_gib:>4} GiB "
            f"{offer.hourly_usd:>7.2f}  {offer.notes}"
        )
    print()
    print("!! " + PRICE_STALENESS_WARNING)


def cmd_estimate(args: argparse.Namespace) -> int:
    """Quote a training run without creating anything."""

    from ..base_models import DEFAULT_BASE, resolve_base_model
    from ..cloud.cost import estimate_hours, estimate_run, find_offer

    base = resolve_base_model(args.base_model) if args.base_model else DEFAULT_BASE

    if args.provider == "local":
        print("PROVIDER:  local")
        print("GPU:       this machine")
        print("COST:      $0.00 - local runs rent no cloud GPU")
        return 0

    offer = find_offer(args.provider, args.gpu)
    if offer is None:
        print(
            f"error: no quoted price for {args.provider!r}/{args.gpu!r}. "
            "Run `kairoforge gpus`.",
            file=sys.stderr,
        )
        return 2

    hours = estimate_hours(
        train_tokens=args.train_tokens,
        epochs=args.epochs,
        gpu=offer,
        method=args.method,
        base_params_b=_billions(base.parameter_count),
    )
    estimate = estimate_run(
        provider=args.provider,
        gpu=args.gpu,
        gpu_count=args.gpu_count,
        estimated_hours=hours,
        method=args.method,
        base_model=base.repo_id,
        dataset_version=args.dataset_version,
        train_tokens=args.train_tokens,
        storage_gib=args.storage_gib,
        model_size_gib=_model_size_gib(base.parameter_count),
    )

    print(estimate.render())

    paths = _paths(Path(args.home))
    paths.ensure()
    out = paths.estimates / "estimate.json"
    payload = estimate.to_json()
    payload["approval_token_command"] = (
        "KAIROFORGE_SPEND_APPROVAL="
        + estimate.approval_token(os.environ.get("KAIROFORGE_APPROVAL_SECRET", ""))
    )
    out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print()
    print(f"estimate written to {out}")
    print("Review it, then export KAIROFORGE_SPEND_APPROVAL before starting the run.")
    return 0


def cmd_approve(args: argparse.Namespace) -> int:
    """Print the approval token for a written estimate."""

    from ..cloud.cost import load_estimate

    estimate = load_estimate(Path(args.estimate))
    print("Approving this estimate:")
    print()
    print(estimate.render())
    print()
    token = estimate.approval_token(os.environ.get("KAIROFORGE_APPROVAL_SECRET", ""))
    print("To authorise exactly this run, export:")
    print()
    print(f"    export KAIROFORGE_SPEND_APPROVAL={token}")
    print()
    print(
        "This token is bound to the estimate fingerprint above. Changing the "
        "GPU, count, hours, or method invalidates it."
    )
    return 0


# ----------------------------------------------------------------------
# training
# ----------------------------------------------------------------------


def cmd_train_create(args: argparse.Namespace) -> int:
    """Create a training job and record its quote."""

    from ..base_models import resolve_base_model
    from ..cloud.manager import TrainingManager, TrainingRequest

    base = resolve_base_model(args.base_model)
    dataset_dir = Path(args.dataset)
    if not (dataset_dir / "train.jsonl").exists():
        print(
            f"error: {dataset_dir}/train.jsonl not found. Run "
            "`kairoforge dataset prepare` first.",
            file=sys.stderr,
        )
        return 2

    train_tokens = args.train_tokens or _estimate_tokens(dataset_dir)

    manager = TrainingManager(_paths(Path(args.home)), _backend(args.provider, Path(args.home) / "backend"))
    request = TrainingRequest(
        version=args.version,
        base_model=base.repo_id,
        base_revision=base.revision,
        dataset_dir=dataset_dir,
        dataset_version=args.dataset_version or dataset_dir.name,
        train_tokens=train_tokens,
        method=args.method,
        provider=args.provider,
        gpu=args.gpu,
        gpu_count=args.gpu_count,
        epochs=args.epochs,
        config=_training_overrides(args),
    )
    job = manager.create(request)
    manager.write_estimate(job.job_id, job.estimate)

    print(f"created job      : {job.job_id}")
    print(f"target version   : {job.version}")
    print(f"base model       : {job.base_model}")
    print(f"dataset version  : {job.dataset_version}")
    print(f"train tokens     : {train_tokens:,}")
    print(f"state            : {job.state.value}")
    print()
    if job.estimate:
        print(job.estimate.render())
    print()
    print(f"Start it with: kairoforge train start {job.job_id} --provider {args.provider}")
    return 0


def cmd_train_start(args: argparse.Namespace) -> int:
    """Run a created job, enforcing the spend gate for paid backends."""

    from ..cloud.cost import BudgetExceededError, SpendNotApprovedError
    from ..cloud.manager import TrainingManager

    manager = TrainingManager(
        _paths(Path(args.home)),
        _backend(args.provider, Path(args.home) / "backend"),
        max_run_cost_usd=args.max_cost,
    )

    def on_progress(job) -> None:
        progress = job.progress
        if progress is None:
            return
        percent = "" if progress.percent is None else f" {progress.percent:5.1f}%"
        loss = "" if progress.loss is None else f" loss={progress.loss:.4f}"
        print(
            f"  [{progress.state.value}]{percent} step "
            f"{progress.step}/{progress.total_steps or '?'}{loss}"
            + (f" {progress.message}" if progress.message else "")
        )

    try:
        job = manager.run(
            args.job_id,
            poll_interval=args.poll_interval,
            max_wait_seconds=args.max_wait,
            on_progress=on_progress if not args.quiet else None,
        )
    except SpendNotApprovedError as exc:
        print(str(exc), file=sys.stderr)
        return 3
    except BudgetExceededError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 4
    except Exception as exc:
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print()
    print(f"final state: {job.state.value}")
    if job.error:
        print(f"error      : {job.error}")
    if job.checkpoints:
        print("checkpoints:")
        for checkpoint in job.checkpoints:
            print(f"  step {checkpoint.step:<6} {checkpoint.size_bytes:,} bytes  {checkpoint.uri}")
    return 0 if job.state.value == "COMPLETED" else 1


def cmd_train_status(args: argparse.Namespace) -> int:
    """Print real status for one job or every job."""

    from ..cloud.manager import TrainingManager

    manager = TrainingManager(_paths(Path(args.home)), _backend(args.provider, Path(args.home) / "backend"))

    if args.job_id:
        payload = manager.status(args.job_id)
        _print_job_status(payload)
        return 0

    jobs = manager.list_jobs()
    if not jobs:
        print("no training jobs recorded")
        return 0
    for job in jobs:
        progress = job.progress
        percent = ""
        if progress is not None and progress.percent is not None:
            percent = f" {progress.percent:5.1f}%"
        print(
            f"{job.job_id}  {job.version:<22} {job.state.value:<20}"
            f"{percent:<7} {job.base_model}"
        )
    return 0


def _print_job_status(payload: dict[str, Any]) -> None:
    """Render one job's status payload."""

    print(f"job id        : {payload['job_id']}")
    print(f"version       : {payload['version']}")
    print(f"base model    : {payload['base_model']}")
    print(f"dataset       : {payload['dataset_version']}")
    print(f"method        : {payload['method']}")
    print(f"provider/gpu  : {payload['provider']} / {payload['gpu']} x{payload['gpu_count']}")
    print(f"state         : {payload['state']}")
    progress = payload.get("progress")
    if progress:
        print(
            f"progress      : step {progress['step']}/{progress['total_steps'] or '?'} "
            f"epoch {progress['epoch']} loss {progress['loss']}"
        )
    if payload.get("error"):
        print(f"error         : {payload['error']}")
    if payload.get("checkpoints"):
        print("checkpoints   :")
        for checkpoint in payload["checkpoints"]:
            print(f"  step {checkpoint['step']}  {checkpoint['sha256'][:16]}...")
    estimate = payload.get("estimate")
    if estimate:
        print(f"estimated cost: ${estimate['total_usd']}")


def cmd_train_logs(args: argparse.Namespace) -> int:
    """Print recent log lines for a job."""

    from ..cloud.manager import TrainingManager

    manager = TrainingManager(_paths(Path(args.home)), _backend(args.provider, Path(args.home) / "backend"))
    print(manager.logs(args.job_id, tail=args.tail))
    return 0


def cmd_train_stop(args: argparse.Namespace) -> int:
    """Stop a job and release its GPU."""

    from ..cloud.manager import TrainingManager

    manager = TrainingManager(_paths(Path(args.home)), _backend(args.provider, Path(args.home) / "backend"))
    job = manager.stop(args.job_id)
    print(f"job {job.job_id} is now {job.state.value}")
    print("Worker resources have been released.")
    return 0


def cmd_train_resume(args: argparse.Namespace) -> int:
    """Resume a job from its latest durable checkpoint."""

    from ..cloud.manager import TrainingManager

    manager = TrainingManager(
        _paths(Path(args.home)), _backend(args.provider, Path(args.home) / "backend"), max_run_cost_usd=args.max_cost
    )
    job = manager.resume(args.job_id, from_step=args.from_step)
    print(f"job {job.job_id} resumed from step {args.from_step or 'latest'}")
    return 0


def _training_overrides(args: argparse.Namespace) -> dict[str, Any]:
    """Collect only the training knobs the user actually set."""

    mapping = {
        "learning_rate": args.learning_rate,
        "batch_size": args.batch_size,
        "gradient_accumulation": args.gradient_accumulation,
        "sequence_length": args.sequence_length,
        "warmup_ratio": args.warmup_ratio,
        "weight_decay": args.weight_decay,
        "precision": args.precision,
        "lora_rank": args.lora_rank,
        "lora_alpha": args.lora_alpha,
        "lora_dropout": args.lora_dropout,
        "checkpoint_interval": args.checkpoint_interval,
        "evaluation_interval": args.evaluation_interval,
        "seed": args.seed,
    }
    return {key: value for key, value in mapping.items() if value is not None}


def _estimate_tokens(dataset_dir: Path) -> int:
    """Estimate training tokens from the dataset, preferring the manifest."""

    manifest = dataset_dir / "manifest.json"
    if manifest.exists():
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if data.get("estimated_tokens"):
            return int(data["estimated_tokens"])
    total = 0
    train = dataset_dir / "train.jsonl"
    if train.exists():
        for line in train.read_text(encoding="utf-8").splitlines():
            if line.strip():
                total += len(line)
    # Mirror the pipeline's chars-per-token ratio.
    return max(1, int(total / 3.6))


def _billions(parameter_count: str) -> float:
    table = {"1.5b": 1.5, "3b": 3.0, "7b": 7.0, "14b": 14.0, "32b": 32.0, "80b-moe": 80.0}
    return table.get(parameter_count, 7.0)


def _model_size_gib(parameter_count: str) -> float:
    """Rough on-disk adapter size for the quote."""

    table = {"1.5b": 0.2, "3b": 0.3, "7b": 0.5, "14b": 0.9, "32b": 2.0, "80b-moe": 4.0}
    return table.get(parameter_count, 0.5)


# ----------------------------------------------------------------------
# registry
# ----------------------------------------------------------------------


def cmd_registry_list(args: argparse.Namespace) -> int:
    """List registered versions."""

    from ..registry.store import Registry

    registry = Registry(Path(args.registry))
    versions = registry.list_versions()
    if not versions:
        print("no KairoForge versions registered (nothing has been trained yet)")
        return 0
    print(
        f"{'VERSION':<24} {'STATUS':<11} {'BASE MODEL':<34} {'TRAINABLE':>12} {'CREATED':<20}"
    )
    print("-" * 108)
    for entry in versions:
        print(
            f"{entry.version:<24} {entry.status.value:<11} {entry.base_model:<34} "
            f"{entry.trainable_parameters:>12,} {entry.created_at[:19]:<20}"
        )
    return 0


def cmd_registry_show(args: argparse.Namespace) -> int:
    """Print full metadata for one version."""

    from ..registry.store import Registry

    registry = Registry(Path(args.registry))
    print(json.dumps(registry.get(args.version).to_json(), indent=2, sort_keys=True))
    return 0


def cmd_registry_verify(args: argparse.Namespace) -> int:
    """Re-hash a version's checkpoint and compare it to the registry."""

    from ..registry.store import Registry, verify_checkpoint

    registry = Registry(Path(args.registry))
    entry = registry.get(args.version)
    path = Path(entry.checkpoint_path)
    if not path.exists():
        print(f"FAIL: checkpoint missing at {path}", file=sys.stderr)
        return 1
    if verify_checkpoint(path, entry.checkpoint_sha256):
        print(f"OK: {entry.version} checkpoint matches {entry.checkpoint_sha256[:16]}...")
        return 0
    print(
        f"FAIL: {entry.version} checkpoint does NOT match the registered hash. "
        "The artifact has been modified or replaced.",
        file=sys.stderr,
    )
    return 1


# ----------------------------------------------------------------------
# misc
# ----------------------------------------------------------------------


def cmd_doctor(args: argparse.Namespace) -> int:
    """Diagnose whether this machine can train and serve KairoForge."""

    print("KairoForge environment diagnosis")
    print("=" * 60)

    print(f"python          : {sys.version.split()[0]} ({sys.executable})")
    if sys.version_info < (3, 10):
        print("  WARNING: KairoForge requires Python >= 3.10")

    modules = [
        ("torch", "training and inference"),
        ("transformers", "model loading"),
        ("peft", "LoRA/QLoRA adapters"),
        ("trl", "supervised fine-tuning trainer"),
        ("datasets", "dataset loading"),
        ("accelerate", "device placement"),
        ("bitsandbytes", "4-bit quantisation (QLoRA, Linux only)"),
        ("fastapi", "inference API"),
        ("uvicorn", "inference server"),
    ]
    print()
    print("ML / server dependencies:")
    for module, purpose in modules:
        try:
            imported = __import__(module)
            version = getattr(imported, "__version__", "installed")
            print(f"  [ok]      {module:<14} {version:<12} {purpose}")
        except ImportError:
            print(f"  [missing] {module:<14} {'-':<12} {purpose}")

    print()
    print("Hardware:")
    try:
        import torch

        if torch.cuda.is_available():
            for index in range(torch.cuda.device_count()):
                props = torch.cuda.get_device_properties(index)
                print(
                    f"  CUDA GPU {index}     : {props.name} "
                    f"({props.total_memory / 1024**3:.0f} GiB)"
                )
        else:
            print("  CUDA GPU       : none available")
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            print("  Apple MPS      : available")
    except ImportError:
        print("  (torch not installed; cannot query accelerators)")

    print()
    print("KairoForge state:")
    home = Path(args.home)
    print(f"  home           : {home.resolve()}")
    registry_path = Path(args.registry)
    print(f"  registry       : {registry_path} ({'present' if registry_path.exists() else 'absent'})")

    print()
    print("Cost safety:")
    print(f"  approval env   : KAIROFORGE_SPEND_APPROVAL="
          f"{'set' if os.environ.get('KAIROFORGE_SPEND_APPROVAL') else 'NOT SET'}")
    print(f"  approval secret: "
          f"{'set' if os.environ.get('KAIROFORGE_APPROVAL_SECRET') else 'using empty default'}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    """Start the KairoForge inference API."""

    from ..inference.server import main as serve_main

    argv = ["--registry", args.registry, "--host", args.host, "--port", str(args.port)]
    if args.version:
        argv += ["--version", args.version]
    if args.device:
        argv += ["--device", args.device]
    return serve_main(argv)


def cmd_verify(args: argparse.Namespace) -> int:
    """Run the end-to-end acceptance verification."""

    import subprocess

    script = Path(__file__).resolve().parent.parent.parent / "scripts" / "verify_end_to_end.py"
    if not script.exists():
        print(f"error: verification script missing at {script}", file=sys.stderr)
        return 2
    argv = [sys.executable, str(script), "--registry", args.registry, "--model", args.model]
    if args.kairoforge_url:
        argv += ["--kairoforge-url", args.kairoforge_url]
    return subprocess.call(argv)


def cmd_evaluate(args: argparse.Namespace) -> int:
    """Evaluate a version against the built-in suite."""

    from ..registry.store import Registry

    registry = Registry(Path(args.registry))
    entry = registry.get(args.version) if args.version else registry.latest()
    if entry is None:
        print("error: no KairoForge version is registered", file=sys.stderr)
        return 2
    print(f"evaluating {entry.version} (base: {entry.base_model})")
    print()
    print(
        "To evaluate a served model, pass --endpoint pointing at a running "
        "KairoForge (or base-model) OpenAI-compatible service."
    )
    if not args.endpoint:
        print()
        print("No --endpoint given; nothing was evaluated.")
        return 2

    from ..evaluation.runner import evaluate_endpoint  # type: ignore[attr-defined]

    report = evaluate_endpoint(args.endpoint, entry.version, api_key=os.environ.get("KAIROFORGE_API_KEY", ""))
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


# ----------------------------------------------------------------------
# argument parsing
# ----------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Construct the full CLI."""

    parser = argparse.ArgumentParser(
        prog="kairoforge",
        description="Train, evaluate, register, and serve the KairoForge coding model.",
    )
    parser.add_argument("--home", default=str(DEFAULT_HOME), help="KairoForge state directory")
    parser.add_argument("--registry", default=str(DEFAULT_HOME / "registry.json"))
    subparsers = parser.add_subparsers(dest="command", required=True)

    # dataset ---------------------------------------------------------
    dataset = subparsers.add_parser("dataset", help="prepare and inspect training data")
    dataset_sub = dataset.add_subparsers(dest="dataset_command", required=True)

    prepare = dataset_sub.add_parser("prepare", help="run the data pipeline")
    prepare.add_argument("--shard", action="append", required=True, help="raw JSONL shard")
    prepare.add_argument("--output", required=True, help="processed dataset directory")
    prepare.add_argument("--version", required=True, help="dataset version label")
    prepare.add_argument("--held-out", default="", help="JSONL of evaluation items to exclude")
    prepare.add_argument("--validation-fraction", type=float, default=0.05)
    prepare.add_argument("--test-fraction", type=float, default=0.05)
    prepare.add_argument("--seed", type=int, default=1337)
    prepare.add_argument("--similarity-threshold", type=float, default=0.95)
    prepare.add_argument("--source", default="", help="override provenance source")
    prepare.add_argument("--license", default="", help="override provenance licence")
    prepare.add_argument("--max-records", type=int, default=None)
    prepare.set_defaults(func=cmd_dataset_prepare)

    inspect = dataset_sub.add_parser("inspect", help="print a dataset manifest")
    inspect.add_argument("--dataset", required=True)
    inspect.set_defaults(func=cmd_dataset_inspect)

    # cost ------------------------------------------------------------
    gpus = subparsers.add_parser("gpus", help="list quoted GPU offers")
    gpus.set_defaults(func=lambda args: (cmd_gpus(args), 0)[1])

    estimate = subparsers.add_parser("estimate", help="quote a training run without spending")
    estimate.add_argument("--base-model", default="")
    estimate.add_argument("--dataset-version", default="")
    estimate.add_argument("--train-tokens", type=int, required=True)
    estimate.add_argument("--epochs", type=int, default=1)
    estimate.add_argument("--method", default="qlora", choices=["qlora", "lora", "full"])
    estimate.add_argument("--provider", default="runpod")
    estimate.add_argument("--gpu", default="RTX 4090")
    estimate.add_argument("--gpu-count", type=int, default=1)
    estimate.add_argument("--storage-gib", type=float, default=50.0)
    estimate.set_defaults(func=cmd_estimate)

    approve = subparsers.add_parser("approve", help="print the approval token for an estimate")
    approve.add_argument("--estimate", required=True)
    approve.set_defaults(func=cmd_approve)

    # training --------------------------------------------------------
    train = subparsers.add_parser("train", help="create, run, and manage training jobs")
    train_sub = train.add_subparsers(dest="train_command", required=True)

    def add_common(target: argparse.ArgumentParser, with_provider: bool = True) -> None:
        if with_provider:
            target.add_argument("--provider", default="local")

    create = train_sub.add_parser("create", help="create a job and record its quote")
    add_common(create)
    create.add_argument("--version", required=True, help="e.g. kairoforge-v0.1")
    create.add_argument("--base-model", default="")
    create.add_argument("--dataset", required=True)
    create.add_argument("--dataset-version", default="")
    create.add_argument("--train-tokens", type=int, default=0)
    create.add_argument("--method", default="qlora", choices=["qlora", "lora", "full"])
    create.add_argument("--gpu", default="RTX 4090")
    create.add_argument("--gpu-count", type=int, default=1)
    create.add_argument("--epochs", type=int, default=1)
    create.add_argument("--learning-rate", type=float, default=None)
    create.add_argument("--batch-size", type=int, default=None)
    create.add_argument("--gradient-accumulation", type=int, default=None)
    create.add_argument("--sequence-length", type=int, default=None)
    create.add_argument("--warmup-ratio", type=float, default=None)
    create.add_argument("--weight-decay", type=float, default=None)
    create.add_argument("--precision", default=None, choices=["bf16", "fp16", "fp32"])
    create.add_argument("--lora-rank", type=int, default=None)
    create.add_argument("--lora-alpha", type=int, default=None)
    create.add_argument("--lora-dropout", type=float, default=None)
    create.add_argument("--checkpoint-interval", type=int, default=None)
    create.add_argument("--evaluation-interval", type=int, default=None)
    create.add_argument("--seed", type=int, default=None)
    create.set_defaults(func=cmd_train_create)

    start = train_sub.add_parser("start", help="run a created job")
    start.add_argument("job_id")
    add_common(start)
    start.add_argument("--poll-interval", type=float, default=30.0)
    start.add_argument("--max-wait", type=float, default=None)
    start.add_argument("--max-cost", type=float, default=100.0)
    start.add_argument("--quiet", action="store_true")
    start.set_defaults(func=cmd_train_start)

    status = train_sub.add_parser("status", help="show real job status")
    status.add_argument("job_id", nargs="?")
    add_common(status)
    status.set_defaults(func=cmd_train_status)

    logs = train_sub.add_parser("logs", help="show job logs")
    logs.add_argument("job_id")
    add_common(logs)
    logs.add_argument("--tail", type=int, default=200)
    logs.set_defaults(func=cmd_train_logs)

    stop = train_sub.add_parser("stop", help="stop a job and release its GPU")
    stop.add_argument("job_id")
    add_common(stop)
    stop.set_defaults(func=cmd_train_stop)

    resume = train_sub.add_parser("resume", help="resume from the latest checkpoint")
    resume.add_argument("job_id")
    add_common(resume)
    resume.add_argument("--from-step", type=int, default=None)
    resume.add_argument("--max-cost", type=float, default=100.0)
    resume.set_defaults(func=cmd_train_resume)

    # registry --------------------------------------------------------
    registry = subparsers.add_parser("registry", help="inspect registered versions")
    registry_sub = registry.add_subparsers(dest="registry_command", required=True)

    reg_list = registry_sub.add_parser("list")
    reg_list.set_defaults(func=cmd_registry_list)

    reg_show = registry_sub.add_parser("show")
    reg_show.add_argument("version")
    reg_show.set_defaults(func=cmd_registry_show)

    reg_verify = registry_sub.add_parser("verify", help="re-hash a checkpoint")
    reg_verify.add_argument("version")
    reg_verify.set_defaults(func=cmd_registry_verify)

    # misc ------------------------------------------------------------
    evaluate = subparsers.add_parser("evaluate", help="evaluate a version")
    evaluate.add_argument("--version", default="")
    evaluate.add_argument("--endpoint", default="")
    evaluate.set_defaults(func=cmd_evaluate)

    serve = subparsers.add_parser("serve", help="start the inference API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8090)
    serve.add_argument("--version", default="")
    serve.add_argument("--device", default="")
    serve.set_defaults(func=cmd_serve)

    verify = subparsers.add_parser("verify", help="run end-to-end acceptance checks")
    verify.add_argument("--kairoforge-url", default="")
    verify.add_argument("--model", default="kairoforge-v0.1")
    verify.set_defaults(func=cmd_verify)

    doctor = subparsers.add_parser("doctor", help="diagnose the environment")
    doctor.set_defaults(func=cmd_doctor)

    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""

    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
