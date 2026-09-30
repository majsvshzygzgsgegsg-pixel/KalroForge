from kairoforge.config import load_training_config


def test_load_training_config() -> None:
    config = load_training_config("configs/training.yaml")
    assert config.base_model == "Qwen/Qwen2.5-Coder-1.5B-Instruct"
    assert config.lora_r == 16
