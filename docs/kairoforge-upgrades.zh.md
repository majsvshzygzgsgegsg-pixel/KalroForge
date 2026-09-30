# KairoForge 升级蓝图

[English](kairoforge-upgrades.md) | 中文

KairoForge 是 KairoForge 之上的产品层，而不是替代运行时。此分支保留上游 MIT 署名、
插件契约、权限门控、有界工具、持久会话格式与本地优先默认值，也不会复制或模拟任何模型的
隐藏推理。

## 能力地图

| 领域 | 仓库已有基础 | KairoForge 方向 |
|---|---|---|
| 可视化工作流 | Workflow 工具、持久运行事件、运行 UI | 节点画布、模板、校验、从节点重放 |
| 团队控制室 | 实验性持久 Agent Teams 服务与成员/任务 UI | 时间线、成本状态、worktree 隔离、操作控制 |
| 记忆控制 | 会话持久化、压缩、投影缓存 | 搜索、固定/编辑/删除、来源与保留策略 |
| 语音 | 可选本地 SenseVoice bundle 与麦克风 UI | 按键说话、连续模式、打断、provider 选择 |
| 模型路由 | Provider 注册表、模型设置、模型选择 | 规则路由、回退、预算、延迟与质量遥测 |
| 评测实验室 | Replay fixture、轨迹 UI、快照 | 数据集运行、并排评分、回归看板 |
| 插件市场 | 插件注册表与安装/启停/移除 UI | 信任元数据、兼容性检查、精选集合 |
| Git 工作区 | 变更、文件、终端、评审界面 | 分支/worktree 管理、提交/PR 流程、冲突助手 |
| 安全 | 权限预设、审批、沙箱策略 | 统一审计日志、密钥状态、网络/文件能力视图 |
| 离线应用 | 相对资源构建、manifest、桌面打包 | 完整 PWA 缓存策略、离线诊断、签名安装包 |
| 设计工作室 | 主题 token、外观设置、slot 系统 | 实时 token 编辑、可复用主题、布局预设 |
| 移动端 | 响应式外壳基础、安装元数据、聊天模式 PWA 启动 | 触控导航与紧凑控制室 |

## 交付规则

1. 优先暴露仓库已有稳定能力，避免重复实现。
2. 实验功能在失败与迁移契约稳定前保持明确标识和按需启用。
3. 破坏性、网络、shell 与写入操作继续受现有权限系统控制。
4. 每个面向用户的阶段在发布前都必须包含聚焦 UI 测试与组装应用快照。
5. 模型 provider 保持可配置；KairoForge 不捆绑或模仿专有模型内部结构。

## 品牌 profile

运行 `pnpm run kairoforge` 或 `make kairoforge`。`kairoforge` 构建 profile 提供标题、侧栏
字标、会话标记、favicon 与可安装应用 manifest。`official` profile 仍可用于生成与上游兼容的
KairoForge 产物。

主概念素材为 [`brand/kairoforge-mark-concept.png`](brand/kairoforge-mark-concept.png)。实际 UI
使用轻量 SVG 版本，以便无损缩放并跟随应用主题 token。
