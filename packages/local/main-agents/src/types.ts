/**
 * Agent Registry records. A main agent is a persistent, top-level agent with
 * its own root chat Session; it is never a sub-agent. Sub-agents (Agent Team
 * teammates) are children of a main agent's Session and live in that
 * Session's log, not in this registry.
 */

/** Lifecycle state owned by the registry. */
export type MainAgentStatus = 'running' | 'stopped' | 'archived'

/** Provider route and model id used for a main agent's Session. */
export interface MainAgentModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Tool allow/deny lists intersected with the agent's mode (preset) tool set. Empty `allow` keeps every mode tool. */
export interface MainAgentTools {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
}

/**
 * Permissions recorded for one main agent. `preset` is a KairoForge permission
 * preset name (`read-only`, `workspace-write`, ...); `agentAdministration`
 * grants the Agent Administration capability (the admin tool set).
 */
export interface MainAgentPermissions {
  readonly preset: string
  readonly agentAdministration: boolean
}

/** One bounded activity line shown in the Agents UI. */
export interface MainAgentActivity {
  readonly at: string
  readonly kind: 'created' | 'edited' | 'started' | 'stopped' | 'archived' | 'message' | 'task' | 'team' | 'session'
  readonly text: string
}

/** Durable registry record; the registry is the source of truth for every main agent. */
export interface MainAgentRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Standing instructions added to the agent's system prompt. */
  readonly instructions: string
  readonly status: MainAgentStatus
  /** Agent preset (mode) id, for example `cordis` (Creator mode) or `standard`. */
  readonly mode: string
  readonly model?: MainAgentModel
  readonly tools: MainAgentTools
  /** Absolute working directory; absent uses the deployment's default workspace. */
  readonly workspace?: string
  readonly permissions: MainAgentPermissions
  /** Current root chat Session. */
  readonly sessionId?: string
  /** Earlier Sessions retained after a mode or workspace change. */
  readonly previousSessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  /** `user` for the Agents UI, otherwise the administering Session id. */
  readonly createdBy: string
  readonly activity: readonly MainAgentActivity[]
}

/** Registry-wide settings. */
export interface MainAgentRegistrySettings {
  /** Agent presets whose top-level Sessions (Creator, Lead) hold the Agent Administration capability. */
  readonly administratorModes: readonly string[]
}

/** Configuration accepted when creating a main agent. */
export interface MainAgentConfig {
  readonly description?: string
  readonly instructions?: string
  readonly mode?: string
  readonly model?: MainAgentModel
  readonly tools?: Partial<MainAgentTools>
  readonly workspace?: string
  readonly permissions?: Partial<MainAgentPermissions>
  /** Start the agent's Session immediately; defaults to true. */
  readonly start?: boolean
}

/** Editable fields of a main agent. */
export interface MainAgentChanges {
  readonly name?: string
  readonly description?: string
  readonly instructions?: string
  readonly mode?: string
  readonly model?: MainAgentModel
  readonly tools?: Partial<MainAgentTools>
  /** `null` clears the workspace back to the default. */
  readonly workspace?: string | null
  readonly permissions?: Partial<MainAgentPermissions>
}

/** Live view of one main agent: the record plus runtime facts. */
export interface MainAgentView extends MainAgentRecord {
  /** `busy` while a turn executes, `idle` when loaded and idle, `unloaded` when the Session is not in memory. */
  readonly runtime: 'busy' | 'idle' | 'unloaded'
}

/** Who performs a registry operation. */
export type MainAgentActor =
  | { readonly kind: 'user' }
  | { readonly kind: 'session'; readonly sessionId: string; readonly name: string }

/** Delivery result of one agent-to-agent message. */
export interface MainAgentDelivery {
  readonly target: string
  readonly sessionId: string
  readonly status: 'accepted'
}

/** One requested teammate for a main agent's sub-agent team. */
export interface MainAgentTeammateRequest {
  readonly name: string
  readonly description: string
  readonly prompt: string
}

/** One sub-agent team member as reported by the main agent's Agent Team. */
export interface MainAgentTeamMember {
  readonly name: string
  readonly role: string
  readonly status: string
}

/** Typed registry failure codes surfaced to tools and HTTP callers. */
export type MainAgentErrorCode =
  | 'not-found'
  | 'invalid'
  | 'conflict'
  | 'archived'
  | 'stopped'
  | 'forbidden'
  | 'unavailable'

/** Registry failure with a stable code. */
export class MainAgentError extends Error {
  override readonly name = 'MainAgentError'

  /**
   * @param code - stable failure code.
   * @param message - human-readable detail.
   */
  constructor(readonly code: MainAgentErrorCode, message: string) {
    super(message)
  }
}
