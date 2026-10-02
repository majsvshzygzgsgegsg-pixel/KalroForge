/** Deferred per-Agent tool syncs that tolerate Agents torn down before the sync runs. */
import type { Agent } from '@deepseek-ai/dsh-agent'

const inactive = (error: unknown) => error instanceof Error && Reflect.get(error, 'code') === 'INACTIVE_EFFECT'

/**
 * Run a sync for each Agent after an await or microtask. An Agent disposed in
 * between has an inactive scope, and registering on it throws
 * `INACTIVE_EFFECT`; that Agent is skipped, and any other error propagates.
 * @param agents - Agents to sync.
 * @param sync - per-Agent sync.
 */
export function syncDeferred(agents: Iterable<Agent>, sync: (agent: Agent) => void): void {
  for (const agent of agents) {
    try {
      sync(agent)
    } catch (error) {
      if (!inactive(error)) throw error
    }
  }
}
