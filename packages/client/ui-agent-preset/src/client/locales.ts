/** Locale bundles for the agent-preset hero chip, header label, and management section. */

import { guideEn, guideZh, type PresetGuideKey } from './guide-locales.ts'

/** Locale keys these surfaces render. */
export type AgentPresetSettingsKey =
  | PresetGuideKey
  | 'builtInGroup'
  | 'customGroup'
  | 'seatHint'
  | 'headerHint'
  | 'nav'
  | 'sectionIntro'
  | 'setDefault'
  | 'view'
  | 'presetChatName'
  | 'presetChatDescription'
  | 'presetStandardName'
  | 'presetStandardDescription'
  | 'presetSubagentsName'
  | 'presetSubagentsDescription'
  | 'presetSelfEditName'
  | 'presetSelfEditDescription'
  | 'presetPtcName'
  | 'presetPtcDescription'
  | 'presetMinimalName'
  | 'presetMinimalDescription'
  | 'presetCordisName'
  | 'presetCordisDescription'
  | 'presetBuilderName'
  | 'presetBuilderDescription'
  | 'inUse'
  | 'noDescription'
  | 'brokenBadge'
  | 'switchRefused'
  | 'modeSwitchLabel'
  | 'modeChatHint'
  | 'modeCodeHint'
  | 'modeSubagentsHint'
  | 'close'
  | 'creatorDraft'

/** English copy. */
export const en: Record<AgentPresetSettingsKey, string> = {
  ...guideEn,
  builtInGroup: 'Built-in', customGroup: 'Custom',
  sectionIntro: 'Choose how KairoForge works. Chat mode only answers, while KairoForge mode can use coding and agent tools.',

  seatHint: 'Choose the agent preset for your new task',
  headerHint: 'The agent preset chosen when this task started',
  nav: 'Agent presets',

  setDefault: 'Set as new task default',
  view: 'View configuration',

  presetChatName: 'Chat',
  presetChatDescription: 'Answer-only conversation. Chat mode has no tools and cannot edit files, run commands, or take actions.',
  presetStandardName: 'KairoForge',
  presetStandardDescription:
    'Coding and agent mode. KairoForge can inspect projects, edit files, run commands, search, and use other available tools.',
  presetSubagentsName: 'Sub‑Agents',
  presetSubagentsDescription:
    'Creator mode with agent-team routing. Ask KairoForge to make or use a named sub-agent for research, design, coding, testing, publishing, or repo maintenance.',
  presetSelfEditName: 'Self-Edit + GitHub',
  presetSelfEditDescription:
    'Repository-builder mode. KairoForge can edit its own app files, run checks, add files, commit, and push directly to GitHub when you ask.',
  presetPtcName: 'PTC mode',
  presetPtcDescription:
    'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
  presetMinimalName: 'Minimal mode',
  presetMinimalDescription:
    'The agent works using only a terminal tool. Useful for testing and comparing its basic performance.',
  presetCordisName: 'Creator mode',
  presetCordisDescription:
    'Advanced builder mode. KairoForge can create projects, clone GitHub repos, build plugins, UI, tools, prompts, workflows, model settings, and custom modes, then verify and automatically publish repo updates unless you say not to.',
  presetBuilderName: 'Builder mode',
  presetBuilderDescription:
    'Live website and app builder. KairoForge builds, deploys, verifies a public URL you can open on phone or laptop, and can rename the app URL when you ask.',

  inUse: 'New task default',

  noDescription: 'No description.',
  brokenBadge: 'Failed to load',

  switchRefused: 'Could not switch to {name}: {reason}',
  modeSwitchLabel: 'Choose Chat, KairoForge, or Sub‑Agents mode',
  modeChatHint: 'Chat mode only answers and has no tools',
  modeCodeHint: 'KairoForge mode can code and take actions',
  modeSubagentsHint: 'Sub‑Agents mode helps you create and direct named helper agents',

  close: 'Close',

  creatorDraft: 'Let the agent help me create a preset',

}

/** Simplified Chinese copy. */
export const zh: Record<AgentPresetSettingsKey, string> = {
  ...guideZh,
  builtInGroup: '内置', customGroup: '自定义',
  sectionIntro: '选择 KairoForge 的工作方式。「聊天」模式只负责回答，「KairoForge」模式可以使用编程与 Agent 工具。',

  seatHint: '选择新任务使用的 Agent 预设',
  headerHint: '本任务的 Agent 预设，在任务开始时确定',
  nav: 'Agent 预设',

  setDefault: '设为新任务默认',
  view: '查看配置',

  presetChatName: '聊天',
  presetChatDescription: '仅回答问题，不提供工具，也不能编辑文件、运行命令或执行操作。',
  presetStandardName: 'KairoForge',
  presetStandardDescription: '编程与 Agent 模式。KairoForge 可以检查项目、编辑文件、运行命令、检索并使用其他可用工具。',
  presetSubagentsName: '子 Agent',
  presetSubagentsDescription: '带有 Agent 团队路由的创造模式。你可以让 KairoForge 创建或使用命名的子 Agent 来研究、设计、编码、测试、发布或维护仓库。',
  presetSelfEditName: '自我编辑 + GitHub',
  presetSelfEditDescription: '仓库构建模式。KairoForge 可以编辑自己的应用文件、运行检查、添加文件、提交，并在你要求时直接推送到 GitHub。',
  presetPtcName: 'PTC 模式',
  presetPtcDescription: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
  presetMinimalName: '极简模式',
  presetMinimalDescription: 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
  presetCordisName: '创造模式',
  presetCordisDescription: '高级构建模式。KairoForge 可以创建项目、克隆 GitHub 仓库，构建插件、界面、工具、提示词、工作流、模型设置和自定义模式，并在你要求时验证、提交并推送。',
  presetBuilderName: '构建模式',
  presetBuilderDescription: '在线网站与应用构建模式。KairoForge 会构建、部署并验证可在手机或电脑打开的公开网址，也能按你的要求更改应用网址名称。',

  inUse: '新任务默认',

  noDescription: '暂无描述。',
  brokenBadge: '加载失败',

  switchRefused: '无法切换到「{name}」：{reason}',
  modeSwitchLabel: '选择聊天、KairoForge 或子 Agent 模式',
  modeChatHint: '聊天模式只回答，不使用工具',
  modeCodeHint: 'KairoForge 模式可以编程并执行操作',
  modeSubagentsHint: '子 Agent 模式可以创建并指挥命名的辅助 Agent',

  close: '关闭',

  creatorDraft: '让 Agent 帮我创建预设模式',

}

// The resolution itself is the shared fold in `dsh-agent-preset-registry/display`,
// re-exported here so every surface in this plugin reads one path; the
// Settings plugin list inlines the same fold over this plugin's dictionaries.
export { isBuiltInPreset, presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
export type { PresetDisplaySource, PresetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
