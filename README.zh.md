# KairoForge

[English](README.md) | 中文

KairoForge 是一个本地优先的 AI 聊天与代码工作区。它在同一个 Web 应用里提供两种模式：

- 简洁的普通聊天模式，用于日常问答；
- 代码 / Agent 模式，用于仓库、文件、终端、工具和自动化工作流。

此项目已经加入 KairoForge 品牌、专用 Web profile、模型显示名更新，以及新的 `kairoforge/` 机器学习脚手架，用于未来的开源权重训练实验。

## 已包含内容

- KairoForge Web 品牌、图标、应用 manifest 和聊天界面样式。
- 普通聊天与代码工作流的右上角模式切换。
- 模型选择器中的 KairoForge 模型显示名。
- 持久化主 Agent 与 Agent 编排：专家子 Agent 工作流、可安全回滚的 Git 检查点、循环恢复、后台任务、主 Agent 之间的委派、模型路由、Fast 模式以及 KairoForge Engineer。详见 [`docs/kairoforge-creator-mode.md`](docs/kairoforge-creator-mode.md#agent-orchestration)。
- 适合手机使用的 PWA 风格 Web 入口。
- `kairoforge/` 训练脚手架：数据准备、LoRA/QLoRA dry run、评测占位、带成本保护的云部署脚本，以及 OpenAI 兼容 API 服务骨架。

## 当前模型状态

KairoForge 的模型训练脚手架已经存在，但还没有执行真实云 GPU 训练。

- KairoForge 训练后 checkpoint：**未完成**
- 云 GPU 资源：**未创建**
- 当前云成本：**$0**

详见 [`kairoforge/docs/final-status.md`](kairoforge/docs/final-status.md)。

## 从源码运行

```sh
git clone https://github.com/majsvshzygzgsgegsg-pixel/kairoforge.git
cd kairoforge
pnpm install
pnpm run kairoforge
```

应用默认会在 `http://127.0.0.1:3080` 启动。

## KairoForge ML 脚手架

```sh
cd kairoforge
python3.11 scripts/prepare_data.py --input data/raw/examples.jsonl --output data/processed/examples.sft.jsonl --manifest data/manifests/examples.manifest.json
PYTHONPATH=src python3.11 scripts/train.py --config configs/training.yaml --dry-run
PYTHONPATH=src python3.11 scripts/evaluate.py --config configs/training.yaml --dry-run
```

部署脚本会拒绝任何付费云操作，直到填写并批准云提供商、GPU、小时价格和最大预算。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
