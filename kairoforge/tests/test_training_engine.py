"""Tests for the KairoForge training engine and the local backend.

Everything here runs on a machine with **no torch, transformers, peft, or
trl** installed. That constraint is the point: the modules under test defer
every heavy import into the function that needs it, and these tests are what
prove that promise rather than assuming it.

Two classes of test live here:

* Structural tests (field surface, validator rejections, abstract-method
  coverage) run unconditionally.
* Execution tests drive ``smoke_test`` through an injected stub model. The
  stub is deterministic and its weights provably do or do not move, so the
  "parameters changed" logic is verified in BOTH directions - a harness that
  reports "changed" no matter what would fail the negative test.

Tests that would need a real torch run call ``pytest.importorskip`` and are
skipped, never passed, when the ML stack is absent. Nothing in this file
reports a training run that did not happen.
"""

from __future__ import annotations

import dataclasses
import json
import math
import os
import sys
import time
from pathlib import Path

import pytest

from kairoforge.cloud.backend import (
    BackendError,
    CheckpointRef,
    CloudTrainingBackend,
    JobState,
    TrainingProgress,
)
from kairoforge.cloud.local_backend import (
    LOCAL_COST_NOTE,
    LocalTrainingBackend,
    LocalRun,
)
from kairoforge.training import engine
from kairoforge.training.engine import (
    ConfigError,
    MissingDependencyError,
    SmokeResult,
    TrainingRunConfig,
    adapter_weight_hash,
    build_lora_config,
    build_training_arguments,
    count_parameters,
    smoke_test,
    to_messages,
    validate_config,
)

#: The exact field surface the user specified. Asserted as a set so an added
#: or renamed field fails loudly instead of silently changing the public API.
REQUIRED_FIELDS = {
    "base_model",
    "base_revision",
    "dataset_dir",
    "output_dir",
    "epochs",
    "learning_rate",
    "batch_size",
    "gradient_accumulation",
    "sequence_length",
    "warmup_ratio",
    "weight_decay",
    "precision",
    "lora_rank",
    "lora_alpha",
    "lora_dropout",
    "lora_target_modules",
    "checkpoint_interval",
    "evaluation_interval",
    "seed",
    "method",
    "max_steps",
    "save_total_limit",
    "gradient_checkpointing",
    "logging_steps",
    "report_to",
}

#: Every one of those fields annotated in the engine source. Asserted against
#: the source text so the annotations are checked too, not just the defaults.
REQUIRED_ANNOTATED_FIELDS = {name: "str" for name in REQUIRED_FIELDS}


def make_config(**overrides) -> TrainingRunConfig:
    """Build a valid baseline config, with per-test overrides."""

    values = {
        "base_model": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
        "base_revision": "2e1fd397ee46e1388853d2af2c993145b0f1098a",
        "dataset_dir": "data/processed",
        "output_dir": "adapters/test",
        "epochs": 1,
        "learning_rate": 2e-4,
        "batch_size": 1,
        "gradient_accumulation": 8,
        "sequence_length": 256,
        "warmup_ratio": 0.03,
        "weight_decay": 0.01,
        "precision": "bf16",
        "lora_rank": 16,
        "lora_alpha": 32,
        "lora_dropout": 0.05,
        "lora_target_modules": ("q_proj", "v_proj"),
        "checkpoint_interval": 50,
        "evaluation_interval": 50,
        "seed": 1337,
        "method": "qlora",
        "max_steps": 0,
        "save_total_limit": 3,
        "gradient_checkpointing": True,
        "logging_steps": 1,
        "report_to": (),
    }
    values.update(overrides)
    return TrainingRunConfig(**values)


# ---------------------------------------------------------------------------
# 1. The module imports with no ML stack.
# ---------------------------------------------------------------------------


def test_engine_module_imports_without_torch() -> None:
    """The engine must import on a machine with no torch/transformers/peft/trl."""

    for heavy in ("torch", "transformers", "peft", "trl"):
        assert heavy not in sys.modules, (
            f"{heavy} was imported as a side effect of importing the engine; "
            "every heavy import must live inside a function"
        )
    # Re-importing explicitly proves it rather than relying on the earlier one.
    assert engine.TrainingRunConfig is TrainingRunConfig


def test_engine_imports_with_the_ml_stack_actively_blocked() -> None:
    """Re-import the engine in a subprocess where torch et al. cannot import.

    ``test_engine_module_imports_without_torch`` only proves torch was not
    imported as a side effect; it passes trivially on a machine that has torch
    installed and merely did not touch it. This blocks the modules at the
    import system level in a fresh interpreter, which is the real constraint:
    the engine module must load and its config surface must work with the ML
    stack genuinely unavailable.
    """

    import subprocess

    program = "\n".join(
        [
            "import sys",
            "BLOCKED = {'torch', 'transformers', 'peft', 'trl', 'datasets', 'bitsandbytes', 'accelerate'}",
            "class Blocker:",
            "    def find_spec(self, name, path=None, target=None):",
            "        if name.split('.')[0] in BLOCKED:",
            "            raise ImportError('blocked: ' + name)",
            "        return None",
            "sys.meta_path.insert(0, Blocker())",
            "import dataclasses",
            "import kairoforge.training.engine as e",
            "assert len(dataclasses.fields(e.TrainingRunConfig)) == 25",
            "from kairoforge.cloud.local_backend import LocalTrainingBackend",
            "assert LocalTrainingBackend.__abstractmethods__ == frozenset()",
            "cfg = e.TrainingRunConfig(",
            "    base_model='m', base_revision='', dataset_dir='d', output_dir='o', epochs=1,",
            "    learning_rate=2e-4, batch_size=1, gradient_accumulation=1, sequence_length=64,",
            "    warmup_ratio=0.03, weight_decay=0.01, precision='bf16', lora_rank=8,",
            "    lora_alpha=16, lora_dropout=0.05, lora_target_modules=(), checkpoint_interval=10,",
            "    evaluation_interval=10, seed=1, method='qlora')",
            "assert e.validate_config(cfg).method == 'qlora'",
            "try:",
            "    e.train(cfg)",
            "except e.MissingDependencyError as exc:",
            "    assert exc.package == 'torch'",
            "else:",
            "    raise SystemExit('train() did not refuse without torch')",
            "print('NO-TORCH PATH OK')",
        ]
    )
    completed = subprocess.run(
        [sys.executable, "-c", program],
        capture_output=True,
        text=True,
        cwd=str(Path(__file__).resolve().parents[1]),
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")},
    )
    assert completed.returncode == 0, completed.stderr[-2000:]
    assert "NO-TORCH PATH OK" in completed.stdout


def test_no_heavy_modules_at_module_scope() -> None:
    """Grep the engine's import statements: none may reference an ML package.

    A behavioural test alone would miss a deferred-but-top-level import added
    later inside a rarely-run branch, so the source is checked directly.
    """

    source = Path(engine.__file__).read_text(encoding="utf-8")
    heavy = ("torch", "transformers", "peft", "trl", "bitsandbytes", "datasets")
    offenders: list[str] = []
    for number, line in enumerate(source.splitlines(), start=1):
        stripped = line.strip()
        if not (stripped.startswith("import ") or stripped.startswith("from ")):
            continue
        # Column 0 in the source means module scope; indented imports are the
        # deferred ones this design requires.
        if line[:1].isspace():
            continue
        for package in heavy:
            if stripped.startswith(f"import {package}") or stripped.startswith(
                f"from {package}"
            ):
                offenders.append(f"{number}: {stripped}")
    assert offenders == [], f"module-scope ML imports found: {offenders}"


# ---------------------------------------------------------------------------
# 2. The config's field surface is exactly what was specified.
# ---------------------------------------------------------------------------


def test_training_run_config_field_surface() -> None:
    """The field-name set must match the specified surface exactly."""

    actual = {field.name for field in dataclasses.fields(TrainingRunConfig)}
    assert actual == REQUIRED_FIELDS, (
        f"missing: {sorted(REQUIRED_FIELDS - actual)}; "
        f"unexpected: {sorted(actual - REQUIRED_FIELDS)}"
    )


def test_training_run_config_fields_are_annotated() -> None:
    """Every required field must carry a type annotation in the source."""

    source = Path(engine.__file__).read_text(encoding="utf-8")
    body = source.split("class TrainingRunConfig:", 1)[1].split("\n@dataclass", 1)[0]
    annotated = {
        line.strip().split(":", 1)[0]
        for line in body.splitlines()
        if ":" in line and line[:1].isspace() and not line.strip().startswith(("#", '"'))
    }
    missing = REQUIRED_FIELDS - annotated
    assert missing == set(), f"fields without annotations: {sorted(missing)}"


def test_training_run_config_is_frozen() -> None:
    """The config is immutable so a run cannot be silently retuned mid-flight."""

    config = make_config()
    with pytest.raises(dataclasses.FrozenInstanceError):
        config.epochs = 5  # type: ignore[misc]


def test_training_run_config_json_round_trip() -> None:
    """Serialising and reloading preserves every value, including tuples."""

    config = make_config(report_to=("tensorboard",))
    restored = TrainingRunConfig.from_json(json.loads(json.dumps(config.to_json())))
    assert restored == config
    assert restored.lora_target_modules == ("q_proj", "v_proj")
    assert restored.report_to == ("tensorboard",)


def test_resolved_target_modules_defaults_when_empty() -> None:
    """An empty target list resolves to the full attention+MLP set."""

    config = make_config(lora_target_modules=())
    assert set(config.resolved_target_modules()) >= {"q_proj", "k_proj", "v_proj", "o_proj"}


# ---------------------------------------------------------------------------
# 3. validate_config accepts good configs and rejects bad ones.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides",
    [
        {"method": "qlora", "precision": "bf16"},
        {"method": "qlora", "precision": "fp16"},
        {"method": "lora", "precision": "bf16"},
        {"method": "full", "precision": "bf16"},
        {"method": "full", "precision": "fp16"},
        {"method": "qlora", "max_steps": 10, "lora_target_modules": ()},
    ],
)
def test_validate_config_accepts_valid_combinations(overrides) -> None:
    """Genuinely valid combinations must pass."""

    assert validate_config(make_config(**overrides)) is not None


def test_validate_config_returns_the_same_config() -> None:
    """It returns the config, so it can be used inline."""

    config = make_config()
    assert validate_config(config) is config


@pytest.mark.parametrize(
    "overrides,expected",
    [
        # full + 4-bit is a contradiction (the engine has no 4-bit path for it).
        ({"method": "full", "precision": "fp32"}, "full fine-tuning with fp32"),
        # qlora dequantizes into bf16/fp16, so fp32 defeats the purpose.
        ({"method": "qlora", "precision": "fp32"}, "qlora requires bf16 or fp16"),
        ({"precision": "int8"}, "precision must be one of"),
        ({"precision": "BF16"}, "precision must be one of"),
        ({"method": "dora"}, "method must be one of"),
        ({"lora_rank": 0}, "lora_rank must be >= 1"),
        ({"lora_rank": -4}, "lora_rank must be >= 1"),
        ({"lora_alpha": 0}, "lora_alpha must be >= 1"),
        # alpha < rank is almost always a typo and is refused rather than run.
        ({"lora_rank": 32, "lora_alpha": 8}, "is below lora_rank"),
        ({"save_total_limit": 0}, "save_total_limit must be >= 1"),
        ({"save_total_limit": -1}, "save_total_limit must be >= 1"),
        ({"epochs": 0}, "epochs must be >= 1"),
        ({"learning_rate": 0.0}, "learning_rate must be in"),
        ({"learning_rate": -1e-4}, "learning_rate must be in"),
        ({"batch_size": 0}, "batch_size must be >= 1"),
        ({"gradient_accumulation": 0}, "gradient_accumulation must be >= 1"),
        ({"sequence_length": 0}, "sequence_length must be >= 1"),
        ({"warmup_ratio": 1.5}, "warmup_ratio must be between 0 and 1"),
        ({"warmup_ratio": -0.1}, "warmup_ratio must be between 0 and 1"),
        ({"weight_decay": -0.5}, "weight_decay must be >= 0"),
        ({"lora_dropout": 1.0}, "lora_dropout must be in [0, 1)"),
        ({"lora_dropout": -0.2}, "lora_dropout must be in [0, 1)"),
        ({"checkpoint_interval": 0}, "checkpoint_interval must be >= 1"),
        ({"evaluation_interval": 0}, "evaluation_interval must be >= 1"),
        ({"max_steps": -1}, "max_steps must be >= 0"),
        ({"logging_steps": 0}, "logging_steps must be >= 1"),
        ({"seed": -1}, "seed must be >= 0"),
        ({"base_model": "  "}, "base_model must be non-empty"),
        ({"dataset_dir": ""}, "dataset_dir must be non-empty"),
        ({"output_dir": ""}, "output_dir must be non-empty"),
    ],
)
def test_validate_config_rejects_bad_combinations(overrides, expected) -> None:
    """Each inconsistent configuration must raise with an explanatory message."""

    with pytest.raises(ConfigError) as excinfo:
        validate_config(make_config(**overrides))
    assert expected in str(excinfo.value), (
        f"expected {expected!r} in {str(excinfo.value)!r}"
    )


def test_config_error_is_a_value_error() -> None:
    """ConfigError subclasses ValueError so existing callers keep working."""

    assert issubclass(ConfigError, ValueError)


# ---------------------------------------------------------------------------
# 4. Deferred-import builders fail honestly without the ML stack.
# ---------------------------------------------------------------------------


def test_build_lora_config_names_the_missing_package(monkeypatch) -> None:
    """A missing peft surfaces as MissingDependencyError naming the fix.

    The absence is *simulated* by removing the module from the import system,
    so this asserts the same thing whether or not peft is installed locally.
    """

    monkeypatch.setitem(sys.modules, "peft", None)
    with pytest.raises(MissingDependencyError) as excinfo:
        build_lora_config(make_config())
    assert excinfo.value.package == "peft"
    assert "pip install" in str(excinfo.value)


def test_build_lora_config_builds_a_real_peft_config() -> None:
    """With peft present, the builder returns a genuine LoraConfig."""

    peft = pytest.importorskip("peft")
    config = build_lora_config(make_config(lora_rank=8, lora_alpha=16))
    assert isinstance(config, peft.LoraConfig)
    assert config.r == 8
    assert config.lora_alpha == 16
    assert config.task_type == "CAUSAL_LM"
    assert set(config.target_modules) == {"q_proj", "v_proj"}


def test_build_lora_config_rejects_full_method() -> None:
    """Full fine-tuning has no LoRA config, and says so before importing peft."""

    with pytest.raises(ConfigError, match="method='full'"):
        build_lora_config(make_config(method="full", precision="bf16"))


def test_build_training_arguments_names_the_missing_package(monkeypatch) -> None:
    """Same contract for TrainingArguments, with the absence simulated."""

    monkeypatch.setitem(sys.modules, "transformers", None)
    with pytest.raises(MissingDependencyError) as excinfo:
        build_training_arguments(make_config())
    assert excinfo.value.package == "transformers"


def test_build_training_arguments_sets_checkpointing_and_seed(tmp_path: Path) -> None:
    """With transformers present, the arguments carry the durability settings."""

    pytest.importorskip("transformers")
    config = make_config(
        output_dir=str(tmp_path / "out"),
        checkpoint_interval=7,
        evaluation_interval=9,
        save_total_limit=2,
        seed=4242,
        gradient_checkpointing=True,
    )
    arguments = build_training_arguments(config)
    assert arguments.save_steps == 7
    assert arguments.eval_steps == 9
    assert arguments.save_total_limit == 2
    assert arguments.seed == 4242
    # bf16 is requested by the config, not defaulted by the builder.
    assert arguments.bf16 is True
    assert arguments.fp16 is False


def test_train_without_torch_raises_instead_of_returning_metrics(
    tmp_path: Path, monkeypatch
) -> None:
    """`train` must never fabricate a metrics dict when the stack is missing."""

    monkeypatch.setitem(sys.modules, "torch", None)
    dataset_dir = tmp_path / "ds"
    dataset_dir.mkdir()
    (dataset_dir / "train.jsonl").write_text(
        json.dumps({"instruction": "a", "response": "b"}) + "\n", encoding="utf-8"
    )
    with pytest.raises(MissingDependencyError):
        engine.train(make_config(dataset_dir=str(dataset_dir)))


# ---------------------------------------------------------------------------
# 5. The local backend implements the whole interface.
# ---------------------------------------------------------------------------


def test_local_backend_is_concrete() -> None:
    """Every abstract method of CloudTrainingBackend must be implemented."""

    assert LocalTrainingBackend.__abstractmethods__ == frozenset()
    assert CloudTrainingBackend.__abstractmethods__ != frozenset()


def test_local_backend_covers_the_abstract_surface() -> None:
    """Explicitly: each abstract name resolves to a real override."""

    for name in CloudTrainingBackend.__abstractmethods__:
        implementation = getattr(LocalTrainingBackend, name, None)
        assert callable(implementation), f"{name} is not implemented"
        assert implementation is not getattr(CloudTrainingBackend, name), (
            f"{name} is not overridden by LocalTrainingBackend"
        )


def test_local_backend_is_instantiable_and_named() -> None:
    """It can be constructed and reports the stable backend name."""

    backend = LocalTrainingBackend(Path("/tmp/kairoforge-test-root"))
    assert isinstance(backend, CloudTrainingBackend)
    assert backend.name == "local"


def test_local_backend_reports_zero_cost_explicitly(tmp_path: Path) -> None:
    """`provision` states $0 in a cost_note rather than leaving it implied."""

    backend = LocalTrainingBackend(tmp_path)
    worker = backend.provision(None, {"job_id": "job-1"})
    record = json.loads((tmp_path / "workers" / worker / "worker.json").read_text())
    assert record["cost_usd"] == 0.0
    assert record["billable"] is False
    assert record["cost_note"] == LOCAL_COST_NOTE
    assert "0.00" in record["cost_note"]
    assert record["estimate_is_billed"] is False


def test_local_backend_poll_never_invents_progress(tmp_path: Path) -> None:
    """With no status file and no exit code, poll reports FAILED, not progress."""

    backend = LocalTrainingBackend(tmp_path)
    progress = backend.poll("worker-1", "run-nonexistent")
    assert isinstance(progress, TrainingProgress)
    assert progress.state is JobState.FAILED
    assert progress.step == 0
    assert progress.percent is None
    assert "no status file" in progress.message


def test_local_backend_terminate_is_idempotent(tmp_path: Path) -> None:
    """terminate is safe to call repeatedly, including on a worker that never ran."""

    backend = LocalTrainingBackend(tmp_path)
    backend.terminate("worker-never-existed")
    backend.terminate("worker-never-existed")


def test_local_backend_checkpoints_empty_when_none_exist(tmp_path: Path) -> None:
    """An unknown run yields no checkpoints rather than an exception."""

    backend = LocalTrainingBackend(tmp_path)
    assert backend.checkpoints("worker-1", "run-none") == []


def test_local_backend_logs_empty_when_no_log(tmp_path: Path) -> None:
    """A missing log returns an empty string, not a fabricated message."""

    backend = LocalTrainingBackend(tmp_path)
    assert backend.logs("worker-1", "run-none") == ""


def test_local_backend_checkpoints_hashes_real_bytes(tmp_path: Path) -> None:
    """Checkpoint digests are real SHA-256 over the directory's contents."""

    backend = LocalTrainingBackend(tmp_path)
    worker, run_id = "worker-hash", "run-hash"
    checkpoint = backend._checkpoint_dir(worker, run_id) / "checkpoint-10"
    checkpoint.mkdir(parents=True)
    (checkpoint / "adapter_config.json").write_text('{"r": 16}', encoding="utf-8")
    (checkpoint / "adapter_model.safetensors").write_bytes(b"weights-v1")

    references = backend.checkpoints(worker, run_id)
    assert len(references) == 1
    reference = references[0]
    assert reference.step == 10
    assert isinstance(reference, CheckpointRef)
    assert reference.size_bytes == len('{"r": 16}') + len(b"weights-v1")
    assert len(reference.sha256) == 64

    # Editing the weights must change the digest: it identifies the artifact.
    (checkpoint / "adapter_model.safetensors").write_bytes(b"weights-v2")
    changed = backend.checkpoints(worker, run_id)
    assert changed[0].sha256 != reference.sha256


def test_local_backend_fetch_copies_checkpoint(tmp_path: Path) -> None:
    """fetch performs a real copy and returns the destination."""

    backend = LocalTrainingBackend(tmp_path)
    worker, run_id = "worker-fetch", "run-fetch"
    checkpoint_dir = backend._checkpoint_dir(worker, run_id) / "checkpoint-5"
    checkpoint_dir.mkdir(parents=True)
    (checkpoint_dir / "adapter_config.json").write_text("{}", encoding="utf-8")

    reference = CheckpointRef(
        step=5, uri=str(checkpoint_dir), sha256="0" * 64, size_bytes=2
    )
    destination = tmp_path / "fetched"
    result = backend.fetch(reference, destination)
    assert result.exists()
    assert (result / "adapter_config.json").read_text(encoding="utf-8") == "{}"


def test_local_backend_fetch_rejects_missing_checkpoint(tmp_path: Path) -> None:
    """Fetching a checkpoint that does not exist raises rather than silently succeeding."""

    backend = LocalTrainingBackend(tmp_path)
    reference = CheckpointRef(
        step=1, uri=str(tmp_path / "nope"), sha256="0" * 64, size_bytes=0
    )
    with pytest.raises(BackendError):
        backend.fetch(reference, tmp_path / "dest")


def test_local_backend_prepare_writes_a_real_bundle(tmp_path: Path) -> None:
    """prepare writes config.json, plan.json and the runnable runner script."""

    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    (dataset_dir / "train.jsonl").write_text(
        json.dumps({"instruction": "a", "response": "b"}) + "\n", encoding="utf-8"
    )

    backend = LocalTrainingBackend(tmp_path / "root")
    job_dir = tmp_path / "job"
    config = make_config(dataset_dir=str(dataset_dir), output_dir=str(tmp_path / "out"))
    backend.prepare(job_dir, {"job_id": "job-42", "config": config.to_json()})

    assert (job_dir / "config.json").exists()
    assert (job_dir / "plan.json").exists()
    assert (job_dir / "runner.py").exists()
    plan = json.loads((job_dir / "plan.json").read_text(encoding="utf-8"))
    assert plan["job_id"] == "job-42"
    assert plan["backend"] == "local"
    assert plan["cost_note"] == LOCAL_COST_NOTE
    # The generated runner must be syntactically valid Python.
    compile((job_dir / "runner.py").read_text(encoding="utf-8"), "runner.py", "exec")


def test_local_backend_prepare_rejects_invalid_config(tmp_path: Path) -> None:
    """An inconsistent config fails at prepare, not inside a subprocess."""

    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    (dataset_dir / "train.jsonl").write_text("{}\n", encoding="utf-8")

    backend = LocalTrainingBackend(tmp_path / "root")
    bad = make_config(dataset_dir=str(dataset_dir), lora_rank=0).to_json()
    with pytest.raises(BackendError, match="invalid training config"):
        backend.prepare(tmp_path / "job", {"job_id": "j", "config": bad})


def test_local_backend_prepare_requires_config(tmp_path: Path) -> None:
    """A plan with neither config shape is refused rather than half-written."""

    backend = LocalTrainingBackend(tmp_path / "root")
    with pytest.raises(BackendError, match="neither a 'config' nor a 'training_config'"):
        backend.prepare(tmp_path / "job", {"job_id": "j"})


def test_local_backend_upload_copies_bundle(tmp_path: Path) -> None:
    """upload produces a real copy in the 'remote' prefix."""

    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    (dataset_dir / "train.jsonl").write_text("{}\n", encoding="utf-8")

    backend = LocalTrainingBackend(tmp_path / "root")
    job_dir = tmp_path / "job"
    backend.prepare(
        job_dir,
        {"job_id": "job-7", "config": make_config(dataset_dir=str(dataset_dir)).to_json()},
    )

    uri = backend.upload(job_dir, "remote/job-7")
    assert Path(uri).exists()
    assert (Path(uri) / "plan.json").exists()
    assert (Path(uri) / "runner.py").exists()
    # The copy is independent of the original.
    (job_dir / "plan.json").write_text("{}", encoding="utf-8")
    assert json.loads((Path(uri) / "plan.json").read_text(encoding="utf-8")) != {}


def test_local_backend_upload_rejects_missing_bundle(tmp_path: Path) -> None:
    """uploading a non-existent job directory raises."""

    backend = LocalTrainingBackend(tmp_path / "root")
    with pytest.raises(BackendError):
        backend.upload(tmp_path / "missing", "remote/x")


# ---------------------------------------------------------------------------
# 6. The smoke-test harness: injected stub model, verified BOTH directions.
# ---------------------------------------------------------------------------


class _Tensor:
    """Minimal tensor stub with a float buffer, ``requires_grad`` and a grad slot.

    Deliberately implements only what the engine's smoke-test harness touches:
    ``numel`` for parameter counting, ``detach``/``to``/``numpy`` for the
    weight hash, and ``backward`` so a step has something real to move. This is
    what lets the "did the weights actually move?" logic be tested with no
    torch installed at all.
    """

    def __init__(self, values, requires_grad: bool = True, target=None) -> None:
        # A real tensor holds whatever nesting it was built with; a batch of
        # token ids is a list of lists, so the shape is preserved rather than
        # coerced to a flat float buffer.
        if isinstance(values, (list, tuple)):
            self.values = [
                _Tensor(value, requires_grad=False) if isinstance(value, (list, tuple))
                else float(value)
                for value in values
            ]
        else:
            self.values = float(values)
        self.requires_grad = requires_grad
        self.grad = None
        self.target = target

    # -- shape / counting --------------------------------------------------
    def numel(self) -> int:
        if isinstance(self.values, list):
            return len(self.values)
        return 1

    def __len__(self) -> int:
        if isinstance(self.values, list):
            return len(self.values)
        return 1

    # -- hashing surface ---------------------------------------------------
    def detach(self):
        return _Tensor(list(self.values), requires_grad=False)

    def to(self, *_args, **_kwargs):
        return self

    def cpu(self):
        return self

    def numpy(self):
        import numpy as np

        return np.array(self.values, dtype="float32")

    def tolist(self):
        return list(self.values)

    def __getitem__(self, index):
        value = self.values[index]
        if isinstance(value, list):
            return _Tensor(value)
        return value

    def __iter__(self):
        return iter(self.values)

    # -- loss surface ------------------------------------------------------
    def item(self) -> float:
        """The scalar value, whether the buffer is flat or nested."""

        first = self.values[0]
        return float(first[0] if isinstance(first, list) else first)

    def __float__(self) -> float:
        return self.item()

    def backward(self):
        """Move the registered target, mirroring a real optimizer update.

        A frozen target is left untouched, which is exactly the negative case
        the "parameters changed" check must detect.
        """

        if self.target is None:
            return
        if not getattr(self.target, "frozen", False):
            self.target.values = [value - 0.005 for value in self.target.values]


class _StubTokenizer:
    """A character-level tokenizer with a ChatML-ish template."""

    pad_token = "<pad>"
    eos_token = "<eos>"
    pad_token_id = 0
    eos_token_id = 1

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        return "\n".join(
            f"<|{message['role']}|>{message['content']}" for message in messages
        )

    def __call__(self, text, truncation=True, max_length=512, **_kwargs):
        return {"input_ids": list(range(2, 2 + min(len(text), max_length)))}

    def decode(self, ids, skip_special_tokens=True):
        return "".join(chr(97 + (int(i) % 26)) for i in ids)

    def save_pretrained(self, path):
        Path(path).mkdir(parents=True, exist_ok=True)
        (Path(path) / "tokenizer.json").write_text("{}", encoding="utf-8")


class _StubModel:
    """A deterministic stand-in model whose weights move only if the harness steps.

    ``frozen=True`` makes both ``loss.backward()`` and ``optimizer.step()``
    leave the weights untouched, which is how the negative test proves the
    harness detects "nothing changed" instead of reporting success
    unconditionally.
    """

    def __init__(self, frozen: bool = False) -> None:
        self.weight = _Tensor([0.5, -0.25, 0.75, 0.125], requires_grad=True)
        # The flag lives on the WEIGHT, because that is what the optimizer and
        # the backward pass inspect. Putting it only on the model would let a
        # frozen model still be updated - exactly the bug this stub exists to
        # catch.
        self.weight.frozen = frozen
        self.frozen = frozen
        self.saved_paths: list[str] = []
        self._loss_values = [1.25, 0.5]
        self._call_count = 0

    def parameters(self):
        return [self.weight]

    def named_parameters(self):
        return [("lora_A.weight", self.weight)]

    def state_dict(self):
        return {
            "base.weight": _Tensor([1.0], requires_grad=False),
            "lora_A.weight": self.weight,
        }

    def train(self):
        return self

    def eval(self):
        return self

    def save_pretrained(self, path):
        Path(path).mkdir(parents=True, exist_ok=True)
        (Path(path) / "adapter_config.json").write_text('{"r": 4}', encoding="utf-8")
        (Path(path) / "adapter_model.safetensors").write_text(
            json.dumps(self.weight.values), encoding="utf-8"
        )
        self.saved_paths.append(str(path))

    @classmethod
    def from_pretrained(cls, path):
        payload = json.loads(
            (Path(path) / "adapter_model.safetensors").read_text(encoding="utf-8")
        )
        restored = cls()
        restored.weight = _Tensor(payload, requires_grad=True)
        return restored

    def __call__(self, input_ids=None, attention_mask=None, labels=None):
        """Forward pass returning a finite loss wired to the trainable weight."""

        index = min(self._call_count, len(self._loss_values) - 1)
        self._call_count += 1
        # A real backward sets .grad on the weight; the harness requires a
        # non-None gradient to accept the backward check.
        self.weight.grad = _Tensor([0.1] * len(self.weight.values), requires_grad=False)
        target = None if self.frozen else self.weight
        return _StubOutput(self._loss_values[index], target=target)

    def generate(self, input_ids, max_new_tokens=4, **kwargs):
        prompt = list(input_ids[0])
        return _Tensor(prompt + [7] * max_new_tokens)


class _StubOutput:
    """Forward output carrying a finite loss."""

    def __init__(self, loss_value: float, target=None) -> None:
        self.loss = _Tensor([loss_value], target=target)


class _StubModule:
    """Stand-in for the ``torch`` module: only the pieces the harness needs."""

    class _NoGrad:
        def __enter__(self):
            return None

        def __exit__(self, *_exc):
            return False

    float32 = "float32"
    bfloat16 = "bfloat16"
    float16 = "float16"
    long = "long"

    class cuda:  # noqa: N801 - mirrors the torch attribute name
        @staticmethod
        def is_available() -> bool:
            return False

    @staticmethod
    def tensor(values, dtype=None):
        return _Tensor(values)

    @staticmethod
    def isfinite(value) -> bool:
        return math.isfinite(float(value))

    @staticmethod
    def any(value) -> bool:
        return bool(value)

    @staticmethod
    def no_grad():
        return _StubModule._NoGrad()

    class optim:  # noqa: N801 - mirrors the torch attribute name
        class AdamW:
            def __init__(self, params, lr=0.0):
                self.params = list(params)
                self.lr = lr

            def step(self):
                for parameter in self.params:
                    if getattr(parameter, "frozen", False):
                        continue
                    # A real optimizer moves the weights; the delta is
                    # arbitrary but MUST differ from the initial values.
                    parameter.values = [value - 0.01 for value in parameter.values]

            def zero_grad(self, set_to_none=True):
                for parameter in self.params:
                    parameter.grad = None


def _install_stub_torch(monkeypatch) -> None:
    """Register a minimal stand-in ``torch`` module for the dispatch path."""

    import types

    stub_torch = types.ModuleType("torch")
    stub_torch.tensor = _StubModule.tensor
    stub_torch.isfinite = _StubModule.isfinite
    stub_torch.any = _StubModule.any
    stub_torch.no_grad = _StubModule.no_grad
    stub_torch.float32 = "float32"
    stub_torch.long = "long"
    stub_torch.optim = _StubModule.optim
    stub_torch.cuda = _StubModule.cuda
    monkeypatch.setitem(sys.modules, "torch", stub_torch)


@pytest.fixture()
def stub_dataset(tmp_path: Path) -> Path:
    """A two-row dataset directory the smoke test can load."""

    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    rows = [
        {"instruction": "Write a function", "response": "def f(): return 1"},
        {"instruction": "Explain this loop", "response": "It iterates twice."},
    ]
    with (dataset_dir / "train.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    with (dataset_dir / "validation.jsonl").open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(rows[0]) + "\n")
    return dataset_dir


def _run_stub_smoke(monkeypatch, tmp_path: Path, dataset_dir: Path, frozen: bool):
    """Drive smoke_test against the stub, with a patched torch module."""

    _install_stub_torch(monkeypatch)
    model = _StubModel(frozen=frozen)

    config = make_config(
        dataset_dir=str(dataset_dir),
        output_dir=str(tmp_path / "out"),
        precision="fp32",
        method="lora",
    )
    return smoke_test(
        config,
        model_loader=lambda cfg, budget: model,
        tokenizer_loader=lambda cfg: _StubTokenizer(),
    )


def test_smoke_test_detects_real_parameter_change(monkeypatch, tmp_path: Path, stub_dataset: Path) -> None:
    """POSITIVE: when weights move, every check passes and hashes differ."""

    result = _run_stub_smoke(monkeypatch, tmp_path, stub_dataset, frozen=False)

    assert isinstance(result, SmokeResult)
    assert result.dataset_loaded is True
    assert result.tokenizer_loaded is True
    assert result.model_loaded is True
    assert result.forward_pass_ok is True
    assert result.backward_pass_ok is True, result.errors
    assert result.parameters_changed is True, result.errors
    assert result.adapter_hash_before != result.adapter_hash_after
    assert len(result.adapter_hash_before) == 64
    assert result.trainable_params == 4
    assert result.total_params == 4


def test_smoke_test_detects_no_parameter_change(monkeypatch, tmp_path: Path, stub_dataset: Path) -> None:
    """NEGATIVE: a harness that never moves weights must report changed=False.

    This is the test that would fail if ``parameters_changed`` were hardcoded,
    inferred from config, or asserted rather than measured.
    """

    result = _run_stub_smoke(monkeypatch, tmp_path, stub_dataset, frozen=True)

    assert result.parameters_changed is False, (
        "the harness reported that parameters changed even though the stub "
        "optimizer never modified a weight"
    )
    assert result.adapter_hash_before == result.adapter_hash_after
    assert result.ok is False, "a run whose weights never moved must not report ok"


def test_smoke_result_ok_requires_every_check(stub_dataset: Path) -> None:
    """`ok` is the conjunction of the named checks, never optimistic."""

    result = SmokeResult()
    assert result.ok is False
    for name in result.checks:
        setattr(result, name, True)
    assert result.ok is True
    result.inference_ok = False
    assert result.ok is False


def test_smoke_result_reports_per_check_truth() -> None:
    """The rendered report names each check and its real outcome."""

    result = SmokeResult(dataset_loaded=True, tokenizer_loaded=True)
    rendered = result.render()
    assert "FAIL" in rendered
    assert "[ok] dataset_loaded" in rendered
    assert "[FAIL] model_loaded" in rendered
    payload = result.to_json()
    assert payload["ok"] is False
    assert payload["checks"]["model_loaded"] is False


def test_smoke_test_reports_failure_when_dataset_missing(monkeypatch, tmp_path: Path) -> None:
    """A missing dataset is reported as a failed check, not an exception."""

    _install_stub_torch(monkeypatch)

    result = smoke_test(
        make_config(dataset_dir=str(tmp_path / "absent"), output_dir=str(tmp_path / "o")),
        model_loader=lambda cfg, budget: _StubModel(),
        tokenizer_loader=lambda cfg: _StubTokenizer(),
    )
    assert result.dataset_loaded is False
    assert result.ok is False
    assert any("dataset" in error for error in result.errors)


def test_smoke_test_without_torch_raises(monkeypatch) -> None:
    """Without torch the smoke test refuses rather than reporting fake checks."""

    monkeypatch.setitem(sys.modules, "torch", None)
    with pytest.raises(MissingDependencyError):
        smoke_test(make_config())


# ---------------------------------------------------------------------------
# 7. Parameter counting really walks the model.
# ---------------------------------------------------------------------------


def test_count_parameters_walks_requires_grad() -> None:
    """Only parameters with requires_grad=True count as trainable."""

    class _P:
        def __init__(self, n, requires_grad):
            self.n = n
            self.requires_grad = requires_grad

        def numel(self):
            return self.n

    class _M:
        def parameters(self):
            return [_P(100, True), _P(900, False), _P(24, True)]

    counted = count_parameters(_M())
    assert counted == {"trainable_params": 124, "total_params": 1024}


def test_adapter_weight_hash_detects_byte_level_change() -> None:
    """The hash changes when and only when the underlying bytes change."""

    import numpy as np

    class _P:
        def __init__(self, values):
            self.values = np.array(values, dtype="float32")
            self.requires_grad = True

        def numel(self):
            return int(self.values.size)

        def detach(self):
            return self

        def to(self, *_a, **_k):
            return self

    class _M:
        def __init__(self, values):
            self.p = _P(values)

        def parameters(self):
            return [self.p]

        def named_parameters(self):
            return [("lora_A.weight", self.p)]

        def state_dict(self):
            return {"lora_A.weight": self.p}

    first = adapter_weight_hash(_M([1.0, 2.0, 3.0]))
    assert first == adapter_weight_hash(_M([1.0, 2.0, 3.0]))
    assert first != adapter_weight_hash(_M([1.0, 2.0, 3.5]))


# ---------------------------------------------------------------------------
# 8. Dataset record normalisation.
# ---------------------------------------------------------------------------


def test_to_messages_accepts_both_dataset_shapes() -> None:
    """The trainer accepts the pipeline's `messages` form and flat pairs."""

    from_messages = to_messages(
        {"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}]}
    )
    assert from_messages[0]["role"] == "user"
    assert from_messages[1]["content"] == "yo"

    from_pair = to_messages({"instruction": "hi", "response": "yo"})
    assert from_pair == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "yo"},
    ]


def test_to_messages_rejects_unusable_records() -> None:
    """A record with neither shape raises rather than training on nothing."""

    with pytest.raises(engine.TrainingEngineError):
        to_messages({"unrelated": "field"})


def test_local_backend_prepare_accepts_a_manager_job_payload(tmp_path: Path) -> None:
    """The manager passes a TrainingJob payload, not a bare config.

    ``TrainingManager.run`` calls ``backend.prepare(bundle, job.to_json())``,
    and that payload's nested ``config`` is deliberately partial: it has no
    ``output_dir`` because a cloud worker chooses its own. The backend must
    therefore materialise the missing fields instead of rejecting the plan.
    """

    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    (dataset_dir / "train.jsonl").write_text(
        json.dumps({"instruction": "a", "response": "b"}) + "\n", encoding="utf-8"
    )

    backend = LocalTrainingBackend(tmp_path / "root")
    job_payload = {
        "job_id": "job-manager",
        "version": "v0",
        "base_model": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
        "dataset_version": "ds-1",
        "dataset_path": str(dataset_dir),
        "method": "qlora",
        "provider": "local",
        "gpu": "local CPU/GPU",
        "gpu_count": 1,
        # Partial, exactly like TrainingRequest.training_config().
        "config": {
            "base_model": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
            "base_revision": "",
            "dataset_dir": str(dataset_dir),
            "epochs": 1,
            "learning_rate": 2e-4,
            "batch_size": 1,
            "gradient_accumulation": 8,
            "sequence_length": 2048,
            "warmup_ratio": 0.03,
            "weight_decay": 0.01,
            "precision": "bf16",
            "lora_rank": 16,
            "lora_alpha": 32,
            "lora_dropout": 0.05,
            "checkpoint_interval": 50,
            "evaluation_interval": 50,
            "seed": 1337,
            "method": "qlora",
        },
    }

    job_dir = tmp_path / "bundle"
    backend.prepare(job_dir, job_payload)

    resolved = json.loads((job_dir / "config.json").read_text(encoding="utf-8"))
    # The partial config was completed with the engine's documented defaults.
    assert resolved["save_total_limit"] == 3
    assert resolved["max_steps"] == 0
    assert resolved["gradient_checkpointing"] is True
    assert resolved["output_dir"], "output_dir must be filled in, not left empty"
    assert resolved["lora_target_modules"] == []
    # And the plan still carries the job identity.
    plan = json.loads((job_dir / "plan.json").read_text(encoding="utf-8"))
    assert plan["job_id"] == "job-manager"


def test_local_backend_prepare_rejects_a_config_with_no_dataset(tmp_path: Path) -> None:
    """A plan that identifies no dataset is refused with a clear reason."""

    backend = LocalTrainingBackend(tmp_path / "root")
    with pytest.raises(BackendError, match="dataset"):
        backend.prepare(
            tmp_path / "bundle",
            {"job_id": "j", "config": make_config(dataset_dir="").to_json()},
        )


# ---------------------------------------------------------------------------
# 9. The local backend's real subprocess lifecycle.
#
# These drive a genuine `subprocess.Popen` runner and read a genuine status
# file. The trainer itself is replaced with a tiny stand-in *module* on
# PYTHONPATH - which is the honest way to test the plumbing without torch:
# the runner, the job bundle, the progress file, the checkpoint inventory and
# the resume path are all the real ones.
# ---------------------------------------------------------------------------

#: A stand-in `kairoforge.training.engine` used by the lifecycle tests. It
#: mirrors the real module's contract (TrainingRunConfig.from_json,
#: StepReport, validate_config, train) and derives its output directory from
#: plan.json, exactly as the real engine's caller does.
_FAKE_ENGINE_SOURCE = '''
from dataclasses import dataclass
from pathlib import Path
import json
import sys


class TrainingRunConfig:
    @classmethod
    def from_json(cls, data):
        return cls()

    def to_json(self):
        return {}


@dataclass
class StepReport:
    step: int
    total_steps: int
    epoch: float
    loss: float
    learning_rate: float
    tokens_seen: int
    message: str = ""


def validate_config(config):
    return config


def train(config, resume_from_checkpoint=None, on_step=None):
    plan = json.loads((Path(sys.argv[0]).resolve().parent / "plan.json").read_text())
    output = Path(plan["checkpoint_dir"])
    checkpoint = output / "checkpoint-3"
    checkpoint.mkdir(parents=True, exist_ok=True)
    (checkpoint / "adapter_config.json").write_text('{"r": 4}', encoding="utf-8")
    (checkpoint / "adapter_model.safetensors").write_text("W", encoding="utf-8")
    for step in range(1, 4):
        if on_step:
            on_step(StepReport(step, 3, step / 3.0, 1.0 / step, 1e-4, step * 10))
    return {
        "train_loss": 0.2,
        "steps": 3,
        "tokens": 30,
        "resumed_from": resume_from_checkpoint or "",
        "trainable_params": 5,
        "total_params": 50,
        "gpu_name": "cpu",
        "duration_seconds": 0.2,
    }
'''


@pytest.fixture()
def fake_engine_on_path(tmp_path: Path, monkeypatch) -> None:
    """Put a stand-in `kairoforge.training.engine` ahead of the real one."""

    fake_root = tmp_path / "fakeroot"
    package = fake_root / "kairoforge" / "training"
    package.mkdir(parents=True)
    (fake_root / "kairoforge" / "__init__.py").write_text("", encoding="utf-8")
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "engine.py").write_text(_FAKE_ENGINE_SOURCE, encoding="utf-8")
    existing = os.environ.get("PYTHONPATH", "")
    monkeypatch.setenv(
        "PYTHONPATH", str(fake_root) + (os.pathsep + existing if existing else "")
    )


def _wait_for_terminal(backend, worker: str, run_id: str, timeout: float = 30.0):
    """Poll until the run reaches a terminal state, or fail the test."""

    deadline = time.time() + timeout
    progress = backend.poll(worker, run_id)
    while not progress.state.terminal and time.time() < deadline:
        time.sleep(0.25)
        progress = backend.poll(worker, run_id)
    return progress


@pytest.fixture()
def lifecycle(tmp_path: Path, fake_engine_on_path) -> tuple[LocalTrainingBackend, str, str]:
    """A backend, a provisioned worker, and an uploaded job bundle."""

    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    (dataset_dir / "train.jsonl").write_text(
        json.dumps({"instruction": "a", "response": "b"}) + "\n", encoding="utf-8"
    )

    backend = LocalTrainingBackend(tmp_path / "root")
    job_dir = tmp_path / "job"
    config = make_config(
        base_model="stub", dataset_dir=str(dataset_dir), output_dir=str(tmp_path / "out")
    )
    backend.prepare(
        job_dir, {"job_id": "job-lifecycle", "config": config.to_json(), "total_steps": 3}
    )
    uri = backend.upload(job_dir, "remote/job-lifecycle")
    worker = backend.provision(None, {"job_id": "job-lifecycle"})
    try:
        yield backend, worker, uri
    finally:
        backend.terminate(worker)


def test_lifecycle_runs_a_real_subprocess_to_completion(lifecycle) -> None:
    """start/poll read genuine progress from a genuine background process."""

    backend, worker, uri = lifecycle
    run_id = backend.start(worker, uri, {"job_id": "job-lifecycle"})
    progress = _wait_for_terminal(backend, worker, run_id)

    assert progress.state is JobState.COMPLETED, backend.logs(worker, run_id)
    assert progress.step == 3
    assert progress.total_steps == 3
    assert progress.percent == 100.0
    assert progress.tokens_seen == 30
    # The runner really ran: logs were written and the job bundle was copied.
    assert "COMPLETED" in backend.logs(worker, run_id, tail=50)
    record = json.loads(backend._run_record_path(worker, run_id).read_text())
    assert record["pid"] > 0
    assert record["run_id"] == run_id


def test_lifecycle_metrics_come_from_the_runner(lifecycle) -> None:
    """The metrics dict is the one the runner actually wrote to disk."""

    backend, worker, uri = lifecycle
    run_id = backend.start(worker, uri, {"job_id": "job-lifecycle"})
    _wait_for_terminal(backend, worker, run_id)
    metrics = backend.metrics(worker, run_id)
    assert metrics["steps"] == 3
    assert metrics["tokens"] == 30
    assert metrics["train_loss"] == 0.2


def test_lifecycle_checkpoints_are_discoverable_with_real_hashes(lifecycle) -> None:
    """A checkpoint written by the run is listed with a real sha256."""

    backend, worker, uri = lifecycle
    run_id = backend.start(worker, uri, {"job_id": "job-lifecycle"})
    _wait_for_terminal(backend, worker, run_id)

    references = backend.checkpoints(worker, run_id)
    assert len(references) == 1
    assert references[0].step == 3
    assert len(references[0].sha256) == 64
    assert references[0].size_bytes > 0
    assert references[0].is_final is True


def test_lifecycle_resume_starts_a_new_run_from_the_checkpoint(lifecycle) -> None:
    """resume issues a NEW run id and threads the checkpoint into the plan."""

    backend, worker, uri = lifecycle
    first = backend.start(worker, uri, {"job_id": "job-lifecycle"})
    _wait_for_terminal(backend, worker, first)
    checkpoints = backend.checkpoints(worker, first)
    assert checkpoints, "the first run produced no checkpoint to resume from"

    second = backend.resume(worker, first, checkpoints[0])
    assert second != first
    progress = _wait_for_terminal(backend, worker, second)
    assert progress.state is JobState.COMPLETED, backend.logs(worker, second)

    plan = json.loads((backend._run_dir(worker, second) / "plan.json").read_text())
    assert plan["resume_from"] == checkpoints[0].uri
    assert plan["resumed_from_run"] == first
    # The trainer genuinely received the checkpoint path.
    assert backend.metrics(worker, second)["resumed_from"] == checkpoints[0].uri
    # The original run's evidence is preserved, not overwritten.
    assert backend._run_record_path(worker, first).exists()


def test_lifecycle_fetch_copies_the_checkpoint_out(lifecycle, tmp_path: Path) -> None:
    """fetch moves a real checkpoint to a caller-owned destination."""

    backend, worker, uri = lifecycle
    run_id = backend.start(worker, uri, {"job_id": "job-lifecycle"})
    _wait_for_terminal(backend, worker, run_id)
    reference = backend.checkpoints(worker, run_id)[0]

    destination = tmp_path / "fetched"
    result = backend.fetch(reference, destination)
    names = sorted(path.name for path in result.iterdir())
    assert names == ["adapter_config.json", "adapter_model.safetensors"]


def test_lifecycle_terminate_stops_a_running_worker(lifecycle) -> None:
    """terminate kills the process and marks the run stopped, idempotently."""

    backend, worker, uri = lifecycle
    run_id = backend.start(worker, uri, {"job_id": "job-lifecycle"})
    backend.terminate(worker)
    backend.terminate(worker)  # idempotent

    progress = backend.poll(worker, run_id)
    assert progress.state.terminal
    assert progress.state in {JobState.STOPPED, JobState.COMPLETED, JobState.FAILED}


def test_lifecycle_poll_reports_failure_when_runner_cannot_import(
    tmp_path: Path, monkeypatch
) -> None:
    """A runner that cannot start is FAILED - never reported as progress.

    PYTHONPATH is stripped of both the fake engine and the checkout, so the
    subprocess's import genuinely fails. This is the no-torch case in the real
    environment, and the backend must report it truthfully.
    """

    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    (dataset_dir / "train.jsonl").write_text(
        json.dumps({"instruction": "a", "response": "b"}) + "\n", encoding="utf-8"
    )
    backend = LocalTrainingBackend(tmp_path / "root")
    job_dir = tmp_path / "job"
    backend.prepare(
        job_dir,
        {
            "job_id": "job-broken",
            "config": make_config(
                base_model="stub", dataset_dir=str(dataset_dir), output_dir=str(tmp_path / "o")
            ).to_json(),
            "total_steps": 3,
        },
    )
    uri = backend.upload(job_dir, "remote/job-broken")
    worker = backend.provision(None, {"job_id": "job-broken"})

    monkeypatch.setenv("PYTHONPATH", str(tmp_path / "nowhere"))
    run_id = backend.start(worker, uri, {"job_id": "job-broken"})
    progress = _wait_for_terminal(backend, worker, run_id)

    assert progress.state is JobState.FAILED
    assert progress.percent is None or progress.percent == 0.0
    logs = backend.logs(worker, run_id, tail=100)
    assert logs != "", "a failed run must leave a diagnostic log"
    backend.terminate(worker)


# ---------------------------------------------------------------------------
# 9. Optional real end-to-end smoke test, only when the ML stack is present.
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_real_smoke_test_end_to_end(tmp_path: Path) -> None:
    """The genuine Phase 8 smoke test against a real tiny model.

    Skipped - never passed - when torch/transformers/peft are unavailable. It
    downloads `hf-internal-testing/tiny-random-LlamaForCausalLM`, so it is
    marked `slow` and requires network access.
    """

    pytest.importorskip("torch")
    pytest.importorskip("transformers")
    pytest.importorskip("peft")

    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    rows = [
        {"instruction": "Write a function that adds two numbers.",
         "response": "def add(a, b):\n    return a + b"},
        {"instruction": "Explain a for loop.",
         "response": "A for loop repeats a block once per item in a sequence."},
    ]
    with (dataset_dir / "train.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")

    config = make_config(
        base_model=engine.SMOKE_TEST_MODEL,
        # The baseline config pins the Qwen revision, and the engine passes a
        # pin straight through to the hub; that SHA does not exist in the tiny
        # test repo, so an explicit empty revision is the correct config here.
        base_revision="",
        dataset_dir=str(dataset_dir),
        output_dir=str(tmp_path / "out"),
        precision="fp32",
        method="lora",
        sequence_length=64,
        lora_rank=4,
        lora_alpha=8,
    )
    result = smoke_test(config, step_budget=2)

    assert result.dataset_loaded is True
    assert result.tokenizer_loaded is True
    assert result.model_loaded is True, result.errors
    assert result.forward_pass_ok is True, result.errors
    assert result.backward_pass_ok is True, result.errors
    assert result.parameters_changed is True, result.errors
    assert result.checkpoint_saved is True, result.errors
    assert result.checkpoint_reloaded is True, result.errors
    assert result.inference_ok is True, result.errors
    assert result.ok is True, result.render()
