/**
 * Orchestration records layered on the Agent Registry: workflows, Git
 * checkpoints, loop events, background tasks, delegations, and model-routing
 * decisions. They live in their own storage domain so the main-agent registry
 * schema never changes.
 */

/** Model-routing categories. */
export const MODEL_CATEGORIES = ['FAST', 'STANDARD', 'DEEP_REASONING', 'CODING', 'REVIEW', 'VISION'] as const

/** One model-routing category. */
export type ModelCategory = typeof MODEL_CATEGORIES[number]

/** Provider route and model id configured for one category. */
export interface RoutedModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Who owns or performed an orchestration operation. */
export interface OrchestrationActor {
  /** Session id, or `user` for the Agents panel. */
  readonly sessionId: string
  readonly name: string
}

// ---------------------------------------------------------------------------
// Workflows

/** One task as requested by the planning agent. */
export interface WorkflowTaskSpec {
  /** Workflow-local id referenced by `dependsOn`. */
  readonly id: string
  readonly title: string
  /** Specialist the worker plays, chosen by the planning agent (free text). */
  readonly role: string
  readonly instructions: string
  readonly dependsOn: readonly string[]
  /** Extra attempts after the first failure. */
  readonly retries: number
}

/** Workflow task lifecycle. */
export type WorkflowTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'

/** One task with its runtime state. */
export interface WorkflowTaskRecord extends WorkflowTaskSpec {
  readonly status: WorkflowTaskStatus
  readonly attempts: number
  /** Teammate names used for each attempt, oldest first. */
  readonly workers: readonly string[]
  /** Session id of the current or last worker. */
  readonly workerSessionId?: string
  /** Mirrored Agent Team task id, when the Team task board accepted it. */
  readonly teamTaskId?: string
  readonly result?: string
  readonly error?: string
  readonly startedAt?: string
  readonly finishedAt?: string
}

/** Workflow lifecycle. */
export type WorkflowStatus = 'running' | 'integrating' | 'completed' | 'failed' | 'cancelled'

/** One workflow owned by a main agent (or Lead) Session. */
export interface WorkflowRecord {
  readonly id: string
  readonly title: string
  readonly goal: string
  /** Owning Session (the agent that integrates the result). */
  readonly ownerSessionId: string
  readonly ownerName: string
  /** Registry id when the owner is a main agent. */
  readonly ownerAgentId?: string
  readonly status: WorkflowStatus
  readonly maxParallel: number
  readonly tasks: readonly WorkflowTaskRecord[]
  readonly checkpointId?: string
  readonly finalResult?: string
  readonly error?: string
  readonly createdAt: string
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Checkpoints

/** One test/build run observed around a checkpoint. */
export interface TestRun {
  readonly command: string
  readonly ok: boolean
  readonly exitCode: number | null
  readonly at: string
}

/** Why a checkpoint was taken. */
export type CheckpointReason = 'auto' | 'manual' | 'workflow' | 'pre-restore'

/** One Git checkpoint: a commit object under `refs/kairoforge/checkpoints/<id>` capturing the working tree. */
export interface CheckpointRecord {
  readonly id: string
  readonly ref: string
  /** Snapshot commit (parent = HEAD at capture time). */
  readonly commit: string
  /** Snapshot tree (index-independent working-tree state). */
  readonly tree: string
  /** HEAD commit at capture time; absent on an unborn branch. */
  readonly head?: string
  readonly branch?: string
  /** Repository top-level directory. */
  readonly repo: string
  /** Paths that differed from HEAD when the checkpoint was taken (uncommitted work). */
  readonly dirty: readonly string[]
  /** Paths written by agents after the checkpoint, used to scope rollbacks. */
  readonly touched: readonly string[]
  readonly testsBefore?: TestRun
  readonly testsAfter?: TestRun
  readonly agent: OrchestrationActor
  readonly task?: string
  readonly workflowId?: string
  readonly reason: CheckpointReason
  readonly createdAt: string
  readonly restoredAt?: string
  /** A rollback an agent proposed; restoring still requires the user. */
  readonly proposal?: { readonly reason: string; readonly at: string; readonly by: string }
}

/** One path difference between a checkpoint and the current working tree. */
export interface CheckpointChange {
  readonly path: string
  /** A added since the checkpoint, D deleted since, M modified since. */
  readonly status: 'A' | 'D' | 'M'
}

// ---------------------------------------------------------------------------
// Loop detection

/** Detected loop pattern. */
export type LoopKind = 'repeated-read' | 'similar-edit' | 'failing-command' | 'alternating' | 'same-error' | 'no-progress'

/** One loop detection and its recovery outcome. */
export interface LoopEvent {
  readonly id: string
  readonly sessionId: string
  readonly agentName: string
  readonly kind: LoopKind
  /** Short human summary. */
  readonly summary: string
  /** Recent attempts that formed the pattern. */
  readonly attempts: readonly string[]
  readonly at: string
  /** `recovered` when the pattern did not recur in the following calls. */
  readonly outcome: 'recovering' | 'recovered' | 'recurred'
  readonly delegatedDiagnosis?: boolean
}

// ---------------------------------------------------------------------------
// Background tasks

/** Background task lifecycle. */
export type BackgroundTaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

/** One background task executed by a main agent host-side, independent of any browser tab. */
export interface BackgroundTaskRecord {
  readonly id: string
  readonly agentId: string
  readonly sessionId?: string
  readonly title: string
  readonly prompt: string
  readonly status: BackgroundTaskStatus
  readonly progress: {
    readonly steps: number
    readonly toolCalls: number
    readonly lastTool?: string
    readonly percent?: number
    readonly note?: string
  }
  /** Session to notify on completion or failure (the creator), when not the user. */
  readonly notifySessionId?: string
  readonly createdBy: string
  readonly result?: string
  readonly error?: string
  readonly createdAt: string
  readonly startedAt?: string
  readonly finishedAt?: string
  /** Set when a host restart interrupted the task and it was resumed. */
  readonly resumedAfterRestart?: number
}

// ---------------------------------------------------------------------------
// Delegation

/** Delegation kind. */
export type DelegationKind = 'task' | 'review'

/** One agent-to-agent delegation with ownership and depth. */
export interface DelegationRecord {
  readonly id: string
  readonly kind: DelegationKind
  readonly from: OrchestrationActor
  readonly toAgentId: string
  readonly toName: string
  readonly toSessionId: string
  /** 1 for a delegation from Lead/user; parent depth + 1 for a nested one. */
  readonly depth: number
  /** Root delegation id; equals `id` at depth 1. */
  readonly rootId: string
  readonly parentId?: string
  /** Session ids along the chain, root first, used for cycle rejection. */
  readonly chain: readonly string[]
  readonly task: string
  readonly status: 'open' | 'completed' | 'failed' | 'cancelled'
  readonly result?: string
  readonly createdAt: string
  readonly completedAt?: string
}

// ---------------------------------------------------------------------------
// Model routing

/** One routing decision for one request. */
export interface RouteDecision {
  readonly sessionId: string
  readonly category: ModelCategory
  readonly provider: string
  readonly model: string
  /** True when routing replaced the Session's model. */
  readonly routed: boolean
  readonly reason: string
  readonly at: string
  /** The Session's own model; later requests are seeded from the last logged (routed) header, so routing restores this. */
  readonly base?: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly maxTokens?: number
  }
}

/** Per-main-agent orchestration metadata kept outside the registry schema. */
export interface AgentMeta {
  readonly agentId: string
  /** Template the agent was created from, for example `engineer`. */
  readonly template?: string
  /** `auto` (default), `off`, or a fixed category. */
  readonly routing?: 'auto' | 'off' | ModelCategory
}

/** Orchestration-wide settings. */
export interface OrchestrationSettings {
  readonly routing: {
    readonly enabled: boolean
    /** `managed` routes main agents, their workers, and Fast Mode sessions; `all` routes every Session. */
    readonly scope: 'managed' | 'all'
    readonly categories: Partial<Record<ModelCategory, RoutedModel>>
  }
  readonly loops: { readonly enabled: boolean; readonly noProgressSteps: number }
  readonly checkpoints: { readonly auto: boolean; readonly protectedBranches: readonly string[] }
  readonly delegation: { readonly maxDepth: number }
  readonly background: { readonly resumeOnRestart: boolean }
}

/** Defaults used until the user changes a setting. */
export const DEFAULT_SETTINGS: OrchestrationSettings = {
  routing: { enabled: true, scope: 'managed', categories: {} },
  loops: { enabled: true, noProgressSteps: 40 },
  checkpoints: { auto: true, protectedBranches: ['main', 'master'] },
  delegation: { maxDepth: 3 },
  background: { resumeOnRestart: true },
}

/** Aggregated loop-detection metrics. */
export interface LoopMetrics {
  readonly detections: number
  readonly recovered: number
  readonly recurred: number
  readonly byKind: Partial<Record<LoopKind, number>>
}
