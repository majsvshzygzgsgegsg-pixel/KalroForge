/**
 * Personal AI records. They live in their own storage domain, layered on the
 * Agent Registry and orchestration records, which keep their own schemas.
 */
import type { AgentTag, CapabilityCategory } from './core/capabilities.ts'
import type { Depth } from './core/classifier.ts'
import type { MemoryScope, RankableMemory } from './core/memory.ts'

/** One memory entry. Never holds secrets: writes are screened first. */
export interface MemoryEntry extends RankableMemory {
  readonly scope: MemoryScope
  readonly source: 'user' | 'assistant'
  /** `user` or the Session that saved it. */
  readonly createdBy: string
  readonly createdAt: string
}

/** Commands a project is built and checked with. */
export interface ProjectCommands {
  readonly dev?: string
  readonly build?: string
  readonly test?: string
  readonly lint?: string
}

/** One registered project. */
export interface ProjectRecord {
  readonly id: string
  readonly name: string
  /** Absolute directory, when the project lives on disk. */
  readonly path?: string
  readonly description: string
  readonly stack: readonly string[]
  readonly commands: ProjectCommands
  readonly agentIds: readonly string[]
  readonly decisions: ReadonlyArray<{ readonly at: string; readonly text: string }>
  readonly docs: readonly string[]
  readonly status: 'active' | 'archived'
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastOpenedAt?: string
}

/** Notification preference. */
export type NotificationLevel = 'all' | 'important' | 'off'

/** How the assistant presents itself. No copyrighted character is implied. */
export interface Personality {
  readonly name: string
  readonly instructions: string
  readonly speakingStyle: string
  readonly verbosity: 'brief' | 'balanced' | 'detailed'
  readonly voice: { readonly name?: string; readonly rate: number }
  readonly notifications: NotificationLevel
  /** Keep listening after each reply (voice). */
  readonly handsFree: boolean
}

/** Defaults until the user changes them. */
export const DEFAULT_PERSONALITY: Personality = {
  name: 'KairoForge',
  instructions: '',
  speakingStyle: 'warm, direct, and calm',
  verbosity: 'balanced',
  voice: { rate: 1 },
  notifications: 'important',
  handsFree: false,
}

/** What a task control targets. */
export interface TaskRef {
  readonly kind: 'background' | 'workflow' | 'session'
  readonly id: string
}

/** Task control actions. */
export const CONTROL_ACTIONS = ['pause', 'resume', 'cancel', 'update', 'constrain'] as const

/** One task control action. */
export type ControlAction = typeof CONTROL_ACTIONS[number]

/** One control request and what actually happened. */
export interface ControlRecord {
  readonly id: string
  readonly ref: TaskRef
  readonly action: ControlAction
  readonly text?: string
  /** `applied`: the task changed state. `delivered`: the running agent received it. `rejected`: nothing changed. */
  readonly outcome: 'applied' | 'delivered' | 'rejected'
  readonly detail: string
  /** Task state after the control, when known. */
  readonly state?: string
  readonly by: string
  readonly at: string
}

/** User-set capability tags for one main agent. */
export interface AgentProfile {
  readonly agentId: string
  readonly tags: readonly AgentTag[]
}

/** Coordinator decision for the latest request of one Session. */
export interface CoordinatorDecision {
  readonly sessionId: string
  readonly depth: Depth
  readonly reason: string
  readonly category: string
  readonly categoryReason: string
  readonly at: string
}

/** Stored global settings; absent fields use defaults. */
export interface StoredPersonalSettings {
  readonly personality?: Partial<Personality>
  readonly activeProjectId?: string
  /** Coordinator prompt and per-turn hints on Lead Sessions. */
  readonly coordinator?: boolean
  /** The Session that Command Center conversations (voice or typed) continue. */
  readonly conversationSessionId?: string
}

/**
 * One live progress update of a running Command Center turn, spoken while the
 * work is still going. Every update comes from something that really happened:
 * the model's own words before a tool step, a tool that was allowed to run, or
 * an approval prompt.
 */
export type ConverseUpdate =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'tool'; readonly category: CapabilityCategory | 'OTHER'; readonly changes: boolean }
  | { readonly kind: 'approval' }

/** One Command Center turn: sent into the conversation Session, answered by KairoForge. */
export interface ConverseTurn {
  readonly id: string
  readonly sessionId: string
  readonly status: 'running' | 'done' | 'failed'
  /** Progress updates in order, while the turn runs. */
  readonly updates?: readonly ConverseUpdate[]
  /** Final assistant text of the turn (empty when it answered only with tool work). */
  readonly reply?: string
  readonly error?: string
  readonly startedAt: string
  readonly finishedAt?: string
}

/** Typed failure codes for tools and routes. */
export type PersonalAiErrorCode = 'not-found' | 'invalid' | 'sensitive' | 'conflict'

/** Personal AI failure with a stable code. */
export class PersonalAiError extends Error {
  override readonly name = 'PersonalAiError'

  /**
   * @param code - stable failure code.
   * @param message - human-readable detail.
   */
  constructor(readonly code: PersonalAiErrorCode, message: string) {
    super(message)
  }
}
