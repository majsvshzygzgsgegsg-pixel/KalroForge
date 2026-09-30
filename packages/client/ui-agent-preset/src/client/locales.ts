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
  | 'presetPtcName'
  | 'presetPtcDescription'
  | 'presetMinimalName'
  | 'presetMinimalDescription'
  | 'presetCordisName'
  | 'presetCordisDescription'
  | 'inUse'
  | 'noDescription'
  | 'brokenBadge'
  | 'switchRefused'
  | 'modeSwitchLabel'
  | 'modeChatHint'
  | 'modeCodeHint'
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
  presetPtcName: 'PTC mode',
  presetPtcDescription:
    'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
  presetMinimalName: 'Minimal mode',
  presetMinimalDescription:
    'The agent works using only a terminal tool. Useful for testing and comparing its basic performance.',
  presetCordisName: 'Creator mode',
  presetCordisDescription:
    'Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',

  inUse: 'New task default',

  noDescription: 'No description.',
  brokenBadge: 'Failed to load',

  switchRefused: 'Could not switch to {name}: {reason}',
  modeSwitchLabel: 'Choose Chat or KairoForge coding mode',
  modeChatHint: 'Chat mode only answers and has no tools',
  modeCodeHint: 'KairoForge mode can code and take actions',

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
  presetPtcName: 'PTC 模式',
  presetPtcDescription: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
  presetMinimalName: '极简模式',
  presetMinimalDescription: 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
  presetCordisName: '创造模式',
  presetCordisDescription: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',

  inUse: '新任务默认',

  noDescription: '暂无描述。',
  brokenBadge: '加载失败',

  switchRefused: '无法切换到「{name}」：{reason}',
  modeSwitchLabel: '选择聊天或 KairoForge 编程模式',
  modeChatHint: '聊天模式只回答，不使用工具',
  modeCodeHint: 'KairoForge 模式可以编程并执行操作',

  close: '关闭',

  creatorDraft: '让 Agent 帮我创建预设模式',

}

// The resolution itself is the shared fold in `dsh-agent-preset-registry/display`,
// re-exported here so every surface in this plugin reads one path; the
// Settings plugin list inlines the same fold over this plugin's dictionaries.
export { isBuiltInPreset, presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
export type { PresetDisplaySource, PresetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
