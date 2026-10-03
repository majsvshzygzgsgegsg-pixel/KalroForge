/**
 * Browser wire for the orchestration views: the JSON shapes
 * `/main-agents/orchestration/*` returns and the requests it accepts. Like
 * `api.ts`, the client keeps its own copy of the Host shapes.
 */
import { request, type AgentView } from './api.ts'

/** Routing categories, in display order. */
export const MODEL_CATEGORIES = ['FAST', 'STANDARD', 'DEEP_REASONING', 'CODING', 'REVIEW', 'VISION'] as const

/** One routing category. */
export type ModelCategory = typeof MODEL_CATEGORIES[number]

/** Who owns or performed an operation. */
export interface Actor {
  readonly sessionId: string
  readonly name: string
}

/** One workflow task. */
export interface WorkflowTask {
  readonly id: string
  readonly title: string
  readonly role: string
  readonly instructions: string
  readonly dependsOn: readonly string[]
  readonly retries: number
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  readonly attempts: number
  readonly workers: readonly string[]
  readonly workerSessionId?: string
  readonly result?: string
  readonly error?: string
  readonly startedAt?: string
  readonly finishedAt?: string
}

/** One workflow. */
export interface Workflow {
  readonly id: string
  readonly title: string
  readonly goal: string
  readonly ownerSessionId: string
  readonly ownerName: string
  readonly ownerAgentId?: string
  readonly status: 'running' | 'integrating' | 'completed' | 'failed' | 'cancelled'
  readonly maxParallel: number
  readonly tasks: readonly WorkflowTask[]
  readonly checkpointId?: string
  readonly finalResult?: string
  readonly error?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** One test or build run observed around a checkpoint. */
export interface TestRun {
  readonly command: string
  readonly ok: boolean
  readonly exitCode: number | null
  readonly at: string
}

/** One Git checkpoint. */
export interface Checkpoint {
  readonly id: string
  readonly commit: string
  readonly head?: string
  readonly branch?: string
  readonly repo: string
  readonly dirty: readonly string[]
  readonly touched: readonly string[]
  readonly testsBefore?: TestRun
  readonly testsAfter?: TestRun
  readonly agent: Actor
  readonly task?: string
  readonly workflowId?: string
  readonly reason: 'auto' | 'manual' | 'workflow' | 'pre-restore'
  readonly createdAt: string
  readonly restoredAt?: string
  readonly proposal?: { readonly reason: string; readonly at: string; readonly by: string }
}

/** One path difference between a checkpoint and the working tree. */
export interface CheckpointChange {
  readonly path: string
  readonly status: 'A' | 'D' | 'M'
  /** Written by an agent after the checkpoint; anything else is treated as the user's work. */
  readonly touchedByAgent: boolean
}

/** Result of comparing a checkpoint with the working tree. */
export interface CheckpointComparison {
  readonly checkpoint: Checkpoint
  readonly changes: readonly CheckpointChange[]
  readonly diff: string
}

/** Result of restoring a checkpoint. */
export interface RestoreOutcome {
  readonly checkpointId: string
  readonly safetyCheckpointId?: string
  readonly restored: readonly string[]
  readonly deleted: readonly string[]
  readonly skipped: readonly string[]
}

/** One loop detection. */
export interface LoopEvent {
  readonly id: string
  readonly sessionId: string
  readonly agentName: string
  readonly kind: string
  readonly summary: string
  readonly attempts: readonly string[]
  readonly at: string
  readonly outcome: 'recovering' | 'recovered' | 'recurred'
  readonly delegatedDiagnosis?: boolean
}

/** Loop detection counters. */
export interface LoopMetrics {
  readonly detections: number
  readonly recovered: number
  readonly recurred: number
  readonly byKind: Readonly<Record<string, number>>
}

/** One background task. */
export interface BackgroundTask {
  readonly id: string
  readonly agentId: string
  readonly sessionId?: string
  readonly title: string
  readonly prompt: string
  readonly status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  readonly progress: {
    readonly steps: number
    readonly toolCalls: number
    readonly lastTool?: string
    readonly percent?: number
    readonly note?: string
  }
  readonly createdBy: string
  readonly result?: string
  readonly error?: string
  readonly createdAt: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly resumedAfterRestart?: number
}

/** One delegation between agents. */
export interface Delegation {
  readonly id: string
  readonly kind: 'task' | 'review'
  readonly from: Actor
  readonly toAgentId: string
  readonly toName: string
  readonly toSessionId: string
  readonly depth: number
  readonly rootId: string
  readonly parentId?: string
  readonly task: string
  readonly status: 'open' | 'completed' | 'failed' | 'cancelled'
  readonly result?: string
  readonly createdAt: string
  readonly completedAt?: string
}

/** One routing decision. */
export interface RouteDecision {
  readonly sessionId: string
  readonly category: ModelCategory
  readonly provider: string
  readonly model: string
  readonly routed: boolean
  readonly reason: string
  readonly at: string
}

/** One routed model choice. */
export interface RoutedModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Orchestration settings. */
export interface OrchestrationSettings {
  readonly routing: {
    readonly enabled: boolean
    readonly scope: 'managed' | 'all'
    readonly categories: Partial<Record<ModelCategory, RoutedModel>>
  }
  readonly loops: { readonly enabled: boolean; readonly noProgressSteps: number }
  readonly checkpoints: {
    readonly auto: boolean
    readonly protectedBranches: readonly string[]
    /** Modes whose ordinary pushes may land on protected branches without an approval. */
    readonly directPushModes: readonly string[]
  }
  readonly delegation: { readonly maxDepth: number }
  readonly background: { readonly resumeOnRestart: boolean }
}

/** One UI notification. */
export interface Notification {
  readonly id: string
  readonly at: string
  readonly level: 'info' | 'success' | 'warning' | 'error'
  readonly kind: string
  readonly text: string
  readonly agentId?: string
}

/** One orchestration tree node. */
export interface OrchestrationNode {
  readonly id: string
  readonly kind: 'lead' | 'main-agent' | 'sub-agent'
  readonly name: string
  readonly status: string
  readonly sessionId?: string
  readonly agentId?: string
  readonly detail?: string
  readonly children: readonly OrchestrationNode[]
}

/** Full state from `GET /main-agents/orchestration/state`. */
export interface OrchestrationState {
  readonly tree: readonly OrchestrationNode[]
  readonly workflows: readonly Workflow[]
  readonly delegations: readonly Delegation[]
  readonly background: readonly BackgroundTask[]
  readonly checkpoints: readonly Checkpoint[]
  readonly loops: readonly LoopEvent[]
  readonly loopMetrics: LoopMetrics
  readonly routes: readonly RouteDecision[]
  readonly notifications: readonly Notification[]
  readonly settings: OrchestrationSettings
  readonly templates: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/** One unit of work attributed to an agent. */
export interface WorkItem {
  readonly id: string
  readonly kind: 'workflow-task' | 'background' | 'delegation'
  readonly title: string
  readonly status: string
  readonly at: string
}

/** One agent's routing preference. */
export type AgentRouting = 'auto' | 'off' | ModelCategory

/** Activity dashboard from `GET /main-agents/orchestration/agent/:id`. */
export interface AgentDashboard {
  readonly agent: AgentView
  readonly template?: string
  readonly routing: AgentRouting
  readonly live: {
    readonly status: 'busy' | 'idle' | 'unloaded'
    readonly currentTask?: string
    readonly provider?: string
    readonly model?: string
    readonly contextTokens?: number
    readonly contextWindow?: number
    readonly runtimeMs: number
    readonly steps: number
    readonly toolCalls: number
    readonly cwd?: string
    readonly tools: readonly string[]
  }
  readonly route?: RouteDecision
  readonly subAgents: ReadonlyArray<{
    readonly name: string
    readonly sessionId: string
    readonly status: string
    readonly description?: string
  }>
  readonly work: {
    readonly queued: readonly WorkItem[]
    readonly running: readonly WorkItem[]
    readonly completed: readonly WorkItem[]
    readonly failed: readonly WorkItem[]
  }
  readonly recentTools: ReadonlyArray<{
    readonly at: string
    readonly name: string
    readonly summary: string
    readonly ok: boolean
    readonly error?: string
  }>
  readonly workflows: readonly Workflow[]
  readonly checkpoints: readonly Checkpoint[]
  readonly delegations: readonly Delegation[]
  readonly background: readonly BackgroundTask[]
  readonly loops: readonly LoopEvent[]
  readonly errors: ReadonlyArray<{ readonly at: string; readonly text: string }>
  readonly activity: ReadonlyArray<{ readonly at: string; readonly kind: string; readonly text: string }>
}

/** Partial settings update; a `null` category clears its override. */
export interface SettingsChanges {
  readonly routing?: {
    readonly enabled?: boolean
    readonly scope?: 'managed' | 'all'
    readonly categories?: Partial<Record<ModelCategory, RoutedModel | null>>
  }
  readonly loops?: { readonly enabled?: boolean }
  readonly checkpoints?: { readonly auto?: boolean }
  readonly background?: { readonly resumeOnRestart?: boolean }
}

const BASE = 'orchestration/'
const at = (scope: string, id: string, action: string) => `${BASE}${scope}/${encodeURIComponent(id)}/${action}`

/**
 * Read the orchestration tree and recent records.
 * @returns the state.
 */
export function loadOrchestration(): Promise<OrchestrationState> {
  return request<OrchestrationState>(`${BASE}state`)
}

/**
 * Read one agent's activity dashboard.
 * @param id - main agent id.
 * @returns the dashboard.
 */
export function loadDashboard(id: string): Promise<AgentDashboard> {
  return request<AgentDashboard>(`${BASE}agent/${encodeURIComponent(id)}`)
}

/**
 * Change one agent's routing preference.
 * @param id - main agent id.
 * @param routing - `auto`, `off`, or a pinned category.
 * @returns the saved metadata.
 */
export function setAgentRouting(id: string, routing: AgentRouting): Promise<unknown> {
  return request(at('agent', id, 'routing'), { routing })
}

/**
 * Update orchestration settings.
 * @param changes - fields to change.
 * @returns the saved settings.
 */
export function saveSettings(changes: SettingsChanges): Promise<OrchestrationSettings> {
  return request<OrchestrationSettings>(`${BASE}settings`, changes)
}

/**
 * Cancel a workflow.
 * @param id - workflow id.
 * @returns the workflow.
 */
export function cancelWorkflow(id: string): Promise<Workflow> {
  return request<Workflow>(at('workflow', id, 'cancel'), {})
}

/**
 * Retry one failed workflow task.
 * @param id - workflow id.
 * @param taskId - task id.
 * @returns the workflow.
 */
export function retryTask(id: string, taskId: string): Promise<Workflow> {
  return request<Workflow>(`${at('workflow', id, 'task')}/${encodeURIComponent(taskId)}/retry`, {})
}

/**
 * Take a manual checkpoint of an agent's workspace.
 * @param agentId - main agent id.
 * @param task - optional label.
 * @returns the checkpoint.
 */
export function createCheckpoint(agentId: string, task: string): Promise<Checkpoint> {
  return request<Checkpoint>(`${BASE}checkpoint/create`, { agentId, ...task === '' ? {} : { task } })
}

/**
 * Compare a checkpoint with the working tree.
 * @param id - checkpoint id.
 * @returns the comparison.
 */
export function compareCheckpoint(id: string): Promise<CheckpointComparison> {
  return request<CheckpointComparison>(at('checkpoint', id, 'compare'))
}

/**
 * Restore a checkpoint; the Host takes a safety checkpoint first.
 * @param id - checkpoint id.
 * @param scope - `touched` restores only agent-written paths; `all` every change.
 * @returns what was restored.
 */
export function restoreCheckpoint(id: string, scope: 'touched' | 'all'): Promise<RestoreOutcome> {
  return request<RestoreOutcome>(at('checkpoint', id, 'restore'), { scope })
}

/**
 * Delete a checkpoint ref.
 * @param id - checkpoint id.
 * @returns the deleted id.
 */
export function deleteCheckpoint(id: string): Promise<unknown> {
  return request(at('checkpoint', id, 'delete'), {})
}

/**
 * Queue a background task for a main agent.
 * @param agentId - main agent id.
 * @param title - short title.
 * @param prompt - the task.
 * @returns the task.
 */
export function createBackgroundTask(agentId: string, title: string, prompt: string): Promise<BackgroundTask> {
  return request<BackgroundTask>(`${BASE}background/create`, { agentId, title, prompt })
}

/**
 * Pause, resume, or cancel a background task.
 * @param id - task id.
 * @param action - the action.
 * @returns the task.
 */
export function backgroundAction(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<BackgroundTask> {
  return request<BackgroundTask>(at('background', id, action), {})
}
