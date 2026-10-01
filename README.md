# KairoForge

English | [中文](README.zh.md)

KairoForge is a local-first AI chat and coding workspace. It gives you two modes in one web app:

- a clean normal chat mode for everyday answers;
- a coding/agent mode for repository work, files, terminals, tools, and automation.
- a Sub‑Agents creator mode for making and directing named helper agents.

The project includes KairoForge branding, a custom web profile, model-label updates, and a new `kairoforge/` machine-learning scaffold for future open-weight training experiments.

## What is included

- KairoForge web branding, icons, app manifest, and chat styling.
- Top-right mode switching between normal chat and coding workflow.
- Sub‑Agents mode for research, design, coding, testing, publishing, and repo-maintenance helper agents.
- KairoForge model display names in the model picker.
- A phone-ready PWA-style web entry.
- A setup page with every supported launch command.
- A no-cost `kairoforge/` training scaffold with data preparation, LoRA/QLoRA dry runs, evaluation placeholders, cost-gated cloud deployment scripts, and an OpenAI-compatible API server skeleton.

## Current model status

KairoForge’s model-training scaffold exists, but no real cloud GPU training has been run yet.

- Trained KairoForge checkpoint: **not completed**
- Cloud GPU resources: **not created**
- Running cloud cost: **$0**

See [`kairoforge/docs/final-status.md`](kairoforge/docs/final-status.md).

## Run from source

For the complete setup guide, see [`SETUP.md`](SETUP.md).

```sh
git clone https://github.com/majsvshzygzgsgegsg-pixel/KalroForge.git
cd KalroForge
pnpm install
pnpm run kairoforge
```

The app opens at `http://127.0.0.1:3080` by default.

### Ways to open KairoForge

If you are inside the KairoForge folder, all of these commands start the same KairoForge web app and open it in your browser:

```sh
pnpm run kairoforge
pnpm run web
pnpm run open
pnpm run open:kairoforge
pnpm run launch
pnpm run launch:kairoforge
pnpm run start:kairoforge
pnpm run run:kairoforge
pnpm run kf
pnpm run app
pnpm run serve
pnpm run go
./scripts/open-kairoforge.sh
./scripts/kairoforge
./scripts/start-kairoforge
```

These commands are KairoForge launchers. You do not need to type the old upstream `dsh web` command.

### Open KairoForge from anywhere

Install the global shortcuts once:

```sh
cd /Users/franksmith/Documents/KalroForge
pnpm run install:command
```

After that, you can run these from any folder, including `~`:

```sh
kairoforge
kf
kairoforge-open
```

To use another port:

```sh
KAIROFORGE_PORT=3090 pnpm run open
```

## KairoForge ML scaffold

```sh
cd kairoforge
python3.11 scripts/prepare_data.py --input data/raw/examples.jsonl --output data/processed/examples.sft.jsonl --manifest data/manifests/examples.manifest.json
PYTHONPATH=src python3.11 scripts/train.py --config configs/training.yaml --dry-run
PYTHONPATH=src python3.11 scripts/evaluate.py --config configs/training.yaml --dry-run
```

The deploy script refuses paid cloud work until provider, GPU, hourly price, and max budget are filled in and approved.

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
