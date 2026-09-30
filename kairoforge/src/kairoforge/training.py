"""KairoForge supervised fine-tuning entrypoint."""

from __future__ import annotations

from pathlib import Path

from kairoforge.config import TrainingConfig


def validate_training_inputs(config: TrainingConfig) -> None:
    """Validate local training prerequisites that do not need GPU access."""

    dataset_path = Path(config.dataset_path)
    if not dataset_path.exists():
        raise FileNotFoundError(f"Dataset does not exist: {dataset_path}")
    if config.precision not in {"bf16", "fp16", "fp32"}:
        raise ValueError("precision must be one of: bf16, fp16, fp32")


def run_training(config: TrainingConfig, dry_run: bool = False) -> None:
    """Run or validate a LoRA/QLoRA supervised fine-tuning job."""

    validate_training_inputs(config)
    if dry_run:
        print(f"Dry run OK for base model {config.base_model}")
        print(f"Dataset: {config.dataset_path}")
        print(f"Output: {config.output_dir}")
        return

    try:
        from datasets import load_dataset
        from peft import LoraConfig
        from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
        from trl import SFTTrainer
    except ImportError as exc:
        raise RuntimeError('Install ML dependencies first: pip install -e ".[ml]"') from exc

    dataset = load_dataset("json", data_files=config.dataset_path, split="train")
    tokenizer = AutoTokenizer.from_pretrained(config.base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(config.base_model, device_map="auto", trust_remote_code=True)
    lora = LoraConfig(
        r=config.lora_r,
        lora_alpha=config.lora_alpha,
        lora_dropout=config.lora_dropout,
        task_type="CAUSAL_LM",
    )
    args = TrainingArguments(
        output_dir=config.output_dir,
        num_train_epochs=config.epochs,
        per_device_train_batch_size=config.batch_size,
        gradient_accumulation_steps=config.gradient_accumulation,
        learning_rate=config.learning_rate,
        warmup_ratio=config.warmup_ratio,
        weight_decay=config.weight_decay,
        logging_steps=1,
        save_steps=config.checkpoint_interval,
        eval_steps=config.evaluation_interval,
        seed=config.random_seed,
        bf16=config.precision == "bf16",
        fp16=config.precision == "fp16",
    )
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        peft_config=lora,
        args=args,
        max_seq_length=config.max_sequence_length,
        dataset_text_field="messages",
    )
    trainer.train()
    trainer.save_model(config.output_dir)
