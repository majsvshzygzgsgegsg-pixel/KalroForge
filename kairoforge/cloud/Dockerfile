FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime

WORKDIR /app
COPY pyproject.toml README.md /app/
COPY src /app/src
COPY scripts /app/scripts
COPY configs /app/configs
RUN pip install --no-cache-dir -e ".[ml,server]"

ENV PYTHONUNBUFFERED=1
CMD ["python", "scripts/train.py", "--config", "configs/training.yaml"]
