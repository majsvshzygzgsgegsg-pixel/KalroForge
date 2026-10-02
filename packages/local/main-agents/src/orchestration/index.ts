/**
 * Orchestration installer: mounts the `ctx.orchestration` service, its hooks
 * and tools, resumes persisted work after a restart, and seeds the permanent
 * KairoForge Engineer main agent once.
 */
import type { Context } from '@deepseek-ai/cordis'
import { installOrchestrationHooks } from './hooks.ts'
import { Orchestrator } from './service.ts'
import { ENGINEER_TEMPLATE } from './templates.ts'
import { installOrchestrationTools } from './tools.ts'

export { Orchestrator } from './service.ts'
export type * from './types.ts'

/** Installer options. */
export interface OrchestrationOptions {
  /** Create the KairoForge Engineer main agent (stopped) when it does not exist yet. */
  readonly engineer: boolean
}

async function seedEngineer(service: Orchestrator): Promise<void> {
  const domain = await service.whenReady()
  await service.registry.whenReady()
  const seeded = [...domain.table('meta').entries()].some(([, meta]) => meta.template === ENGINEER_TEMPLATE.id)
  if (seeded) return
  try {
    const agent = await service.registry.create(ENGINEER_TEMPLATE.name, ENGINEER_TEMPLATE.config, { kind: 'user' })
    await service.setMeta(agent.id, { template: ENGINEER_TEMPLATE.id })
  } catch (error) {
    service.host.logger.warn(`main-agents: KairoForge Engineer was not created: ${String(error)}`)
  }
}

/**
 * Install orchestration.
 * @param ctx - Host context.
 * @param options - installer options.
 */
export function installOrchestration(ctx: Context, options: OrchestrationOptions): void {
  ctx.plugin(Orchestrator)
  ctx.inject(['orchestration', 'mainAgents', 'agents', 'tools', 'systemPrompt'], (scoped) => {
    const service = scoped.orchestration
    installOrchestrationHooks(scoped, service)
    installOrchestrationTools(scoped, service)
    void (async () => {
      await service.whenReady()
      await service.registry.whenReady()
      await service.workflows.resumeAfterRestart()
      await service.background.resumeAfterRestart()
      if (options.engineer) await seedEngineer(service)
    })().catch((error: unknown) => {
      scoped.logger.warn(`main-agents: orchestration startup failed: ${String(error)}`)
    })
  })
}
