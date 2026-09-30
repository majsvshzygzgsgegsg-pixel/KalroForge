from pathlib import Path

from kairoforge.dataset import dedupe_examples, normalize_record, read_jsonl, write_sft_jsonl


def test_prepare_safe_examples(tmp_path: Path) -> None:
    record = {
        "id": "one",
        "instruction": "Write a function",
        "response": "def f():\n    return 1",
        "source": "test",
        "license": "MIT",
        "language": "python",
    }
    example = normalize_record(record)
    assert example is not None
    output = tmp_path / "out.jsonl"
    assert write_sft_jsonl(dedupe_examples([example, example]), output) == 1
    rows = read_jsonl(output)
    assert rows[0]["messages"][0]["content"] == "You are KairoForge, a precise coding model."


def test_rejects_secrets() -> None:
    record = {
        "id": "secret",
        "instruction": "Use this key",
        "response": "sk-abcdefghijklmnopqrstuvwxyz",
        "source": "test",
        "license": "MIT",
        "language": "text",
    }
    assert normalize_record(record) is None
