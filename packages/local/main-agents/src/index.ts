/**
 * KairoForge Agent Registry host plugin. Mounts `ctx.mainAgents` (durable
 * registry of persistent main agents), the Agent-scoped main-agent tools with
 * the Agent Administration capability gate, and the Agents page routes.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MainAgentRegistry } from './registry.ts'
import { installMainAgentRoutes } from './routes.ts'
import { installMainAgentTools } from './tools.ts'

export { MainAgentRegistry, isTopLevelSession } from './registry.ts'
export { ADMIN_TOOLS, COMMUNICATION_TOOLS, approvalReason } from './tools.ts'
export type * from './types.ts'
export { MainAgentError } from './types.ts'

/** Cordis plugin name. */
export const name = 'local-main-agents'

/** Agent Registry configuration. */
export interface Config {
  /** Modes whose top-level Sessions hold Agent Administration until the user changes it on the Agents page. */
  readonly administratorModes: string[]
  /** Mode for new main agents when none is given. */
  readonly defaultMode: string
  /** Permission preset for new main agents when none is given; never a full-access preset by default. */
  readonly defaultPermissionPreset: string
  /** Continuable-subagent provider used for main-agent sub-agent teammates. */
  readonly teamProvider: string
}

/** Loader schema; defaults grant administration to Creator mode (`cordis`) and Lead (`standard`). */
export const Config: z<Config> = z.object({
  administratorModes: z.array(z.string()).default(['cordis', 'standard']),
  defaultMode: z.string().default('standard'),
  defaultPermissionPreset: z.string().default('workspace-write'),
  teamProvider: z.string().default('spawn'),
})

/**
 * Mount the registry, then the tools and routes once their services exist.
 * @param ctx - Host context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(MainAgentRegistry, {
    administratorModes: config.administratorModes,
    defaultMode: config.defaultMode,
    defaultPermissionPreset: config.defaultPermissionPreset,
    teamProvider: config.teamProvider,
  })
  ctx.inject(['mainAgents', 'agents', 'tools', 'systemPrompt'], (scoped) => {
    installMainAgentTools(scoped, scoped.mainAgents)
  })
  ctx.inject(['mainAgents', 'webServer', 'connection', 'sessionController'], (scoped) => {
    installMainAgentRoutes(scoped, scoped.mainAgents)
  })
}
