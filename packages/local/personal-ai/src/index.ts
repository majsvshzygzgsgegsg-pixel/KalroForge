/**
 * KairoForge Personal AI host plugin. Upgrades Lead in place into the
 * coordinator: mounts `ctx.personalAi` (memory, projects, personality, task
 * control, live assistant state, metrics), the coordinator prompt and tools on
 * Lead Sessions, and the `/personal-ai/*` routes for the Command Center.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installPersonalAiHooks } from './hooks.ts'
import { installPersonalAiRoutes } from './routes.ts'
import { PersonalAi } from './service.ts'
import { installPersonalAiTools } from './tools.ts'

export { PersonalAi } from './service.ts'
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
  /** Escalate SENSITIVE tool calls in coordinator Sessions to a confirmation when the preset would allow them silently. */
  readonly confirmSensitive: boolean
}

/** Loader schema. */
export const Config: z<Config> = z.object({
  coordinatorModes: z.array(z.string()).default(['standard']),
  observedModes: z.array(z.string()).default(['fast']),
  confirmSensitive: z.boolean().default(true),
})

/**
 * Mount the service, then hooks, tools, and routes once their services exist.
 * @param ctx - Host context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(PersonalAi)
  ctx.inject(['personalAi', 'orchestration', 'mainAgents', 'agents', 'tools', 'systemPrompt'], (scoped) => {
    installPersonalAiHooks(scoped, scoped.personalAi, config)
    installPersonalAiTools(scoped, scoped.personalAi, config)
  })
  ctx.inject(['personalAi', 'orchestration', 'mainAgents', 'webServer', 'connection'], (scoped) => {
    installPersonalAiRoutes(scoped, scoped.personalAi)
  })
}
