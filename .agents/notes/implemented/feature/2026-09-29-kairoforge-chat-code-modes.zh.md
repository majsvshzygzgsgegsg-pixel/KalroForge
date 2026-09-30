# Agent Note：KairoForge 聊天与编程模式使用独立 preset

Status: implemented

[English](2026-09-29-kairoforge-chat-code-modes.md) | 中文

## 问题

Web 产品已有编程 Agent preset，却没有普通的仅回答模式。单纯的视觉开关只能隐藏工具界面，模型仍可能收到工具 schema，这会错误承诺助手不能执行操作。产品 persona 也仍把自己描述成通用编程 Agent，而不是 KairoForge 应用。

## 决策

将 `chat` 作为第一方 agent preset 交付，其中只包含完整的 KairoForge persona。它不挂载工具、命令、workspace、skill、memory、compaction 或 delegation 插件，并抑制运行时上下文。因此，preset 组合边界保证 provider 请求不携带工具 schema。

现有 `standard` preset 作为 KairoForge 编程模式。一个紧凑且本地化的「聊天/KairoForge」分段控件位于对话页眉右侧工具区的最前方。只有会话仍为空白时才原地选择不同 preset；一旦已有 turn，选择另一模式会暂存该 preset 并新建任务，从而保留既有规则：会话的工具与提示词组合不能在持久历史下变化。

所有随 Web 交付的 persona 都使用 KairoForge 名称，并明确拒绝旧的 DeepSeek Harness 产品身份。身份由 preset 与 Web system prompt 组合拥有，而不是由 provider adapter 拥有，因此 DeepSeek、OpenAI 兼容及其他已配置 provider 都会收到相同的应用身份。

此决策扩展[声明式 agent preset](../architecture/2026-09-18-declarative-agent-presets.zh.md)，并不取代它；原决策仍负责 preset 生命周期与不可变性。

## 考虑过的替代方案

**只在浏览器隐藏工具。** 否决，因为模型仍会保留可调用 schema 与 Host 执行路径。

**重新组合活跃会话。** 否决，因为较早的助手消息与工具结果是在另一份能力契约下生成的。

**按 provider 实现身份提示词。** 否决，因为 provider 路由与产品身份相互独立，而且会导致各 adapter 漂移。

## 验证

随发行版组合测试会创建 `chat` agent，并断言其精确的完整 KairoForge 提示词、空的组装工具数组、空的运行时工具名册、缺失的 goal 命令，以及缺失的 preset 级 filesystem 服务。组件测试覆盖两个选中状态与模式切换请求。完整 GUI 套件覆盖 slot 注册、本地化、释放和周边页眉行为。

## 后果

聊天模式在结构上只能回答，而不是仅做表面限制。编程模式保留现有 Agent 能力与设计。在活跃对话中切换会按设计新建任务；自定义或高级 preset 仍可通过现有设置与新会话界面使用。
