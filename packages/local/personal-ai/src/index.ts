/**
 * KairoForge Personal AI host plugin. Upgrades Lead in place into the
 * coordinator: mounts `ctx.personalAi` (memory, projects, personality, task
 * control, live assistant state, metrics), the coordinator prompt and tools on
 * Lead Sessions, and the `/personal-ai/*` routes for the Command Center.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installDevHooks, installEditorBridge } from './dev/install.ts'
import { DevKit } from './dev/service.ts'
import { HoloDeck, DEFAULT_HOLO_CONFIG } from './holo.ts'
import { installPersonalAiHooks } from './hooks.ts'
import { installLifeHooks } from './life/install.ts'
import { LifeOs } from './life/service.ts'
import { installPersonalAiRoutes } from './routes.ts'
import { PersonalAi } from './service.ts'
import { installPersonalAiTools } from './tools.ts'

export { PersonalAi } from './service.ts'
export { HoloDeck, holoDomain, DEFAULT_HOLO_CONFIG } from './holo.ts'
export type { HoloConfig, HoloOpenResult, HoloView } from './holo.ts'
export { LifeOs, lifeDomain, DEFAULT_LIFE_SETTINGS } from './life/service.ts'
export type { LifeSettings, LifeStatus, AirGapStatus, ModelRef } from './life/service.ts'
export { DevKit, EDITORS } from './dev/service.ts'
export type { DevStatus, DevCounters, EditorKind, EditorTurn } from './dev/service.ts'
export { checkSyntax } from './dev/syntax.ts'
export * from './core/editor.ts'
export * from './core/reliability.ts'
export * from './core/repomap.ts'
export * from './core/autonomy.ts'
export * from './core/graph.ts'
export * from './core/senses.ts'
export * from './core/vectors.ts'
export { HOLO_TOOLS } from './holo-tools.ts'
export * from './core/holo-scene.ts'
export type { AssistantStateView, PersonalNotice, ProjectInput } from './service.ts'
export type * from './types.ts'
export { PersonalAiError } from './types.ts'
export * from './core/assistant-state.ts'
export * from './core/capabilities.ts'
export * from './core/classifier.ts'
export * from './core/memory.ts'
export * from './core/metrics.ts'
export * from './core/risk.ts'
export * from './core/sensitive.ts'

/** Cordis plugin name. */
export const name = 'local-personal-ai'

/** Personal AI configuration. */
export interface Config {
  /** Modes whose top-level Sessions act as the coordinator (Lead is `standard`). */
  readonly coordinatorModes: string[]
  /** Modes whose top-level Sessions are measured (state and turn metrics) without the coordinator prompt or tools. */
  readonly observedModes: string[]
  /** Answer-only modes (Chat): they do not use the editor at all. */
  readonly answerOnlyModes: string[]
  /** Open each file an agent edits in Cursor (every mode except the answer-only ones). */
  readonly followEdits: boolean
  /** When a request that does something arrives and Cursor is not connected, open its project in Cursor (rate-limited). */
  readonly bringUpEditor: boolean
  /** Escalate SENSITIVE tool calls in coordinator Sessions to a confirmation when the preset would allow them silently. */
  readonly confirmSensitive: boolean
  /**
   * Approve every confirmation automatically (preset prompts and the SENSITIVE
   * gate alike), so nothing waits on a prompt. Disk-, home-, or
   * protection-wiping commands are still refused.
   */
  readonly autoApprove: boolean
  /** Holo Hands: the Holo Gestures checkout, its port, and whether KairoForge starts it. */
  readonly holo: { readonly dir: string; readonly port: number; readonly autoStart: boolean }
}

/** Loader schema. */
export const Config: z<Config> = z.object({
  coordinatorModes: z.array(z.string()).default(['standard']),
  observedModes: z.array(z.string()).default(['fast']),
  answerOnlyModes: z.array(z.string()).default(['chat']),
  followEdits: z.boolean().default(true),
  bringUpEditor: z.boolean().default(true),
  confirmSensitive: z.boolean().default(true),
  autoApprove: z.boolean().default(false),
  holo: z.object({
    dir: z.string().default(DEFAULT_HOLO_CONFIG.dir),
    port: z.natural().default(DEFAULT_HOLO_CONFIG.port),
    autoStart: z.boolean().default(DEFAULT_HOLO_CONFIG.autoStart),
  }).default(DEFAULT_HOLO_CONFIG),
})

/**
 * Mount the service, then hooks, tools, and routes once their services exist.
 * @param ctx - Host context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(PersonalAi)
  ctx.plugin(HoloDeck, config.holo)
  ctx.plugin(LifeOs)
  ctx.inject(['lifeOs'], (scoped) => { installLifeHooks(scoped, scoped.lifeOs) })
  ctx.plugin(DevKit)
  ctx.inject(['devKit'], (scoped) => {
    installDevHooks(scoped, scoped.devKit, (agent) => {
      const mode = scoped.get('mainAgents')?.modeOf(agent)
      return config.followEdits && (mode === undefined || !config.answerOnlyModes.includes(mode))
    })
  })
  ctx.inject(['devKit', 'webServer'], (scoped) => { installEditorBridge(scoped, scoped.devKit) })
  ctx.inject(['personalAi', 'holoDeck', 'orchestration', 'mainAgents', 'agents', 'tools', 'systemPrompt'], (scoped) => {
    installPersonalAiHooks(scoped, scoped.personalAi, config)
    installPersonalAiTools(scoped, scoped.personalAi, config)
  })
  ctx.inject(['personalAi', 'holoDeck', 'orchestration', 'mainAgents', 'webServer', 'connection'], (scoped) => {
    installPersonalAiRoutes(scoped, scoped.personalAi)
  })
}
