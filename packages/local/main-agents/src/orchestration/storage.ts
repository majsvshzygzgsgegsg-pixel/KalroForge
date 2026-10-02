/**
 * Durable orchestration storage (`~/.dsh/storages/main_agent_orchestration.json`
 * under the default JSON backend). Separate from the `main_agents` domain so
 * the registry schema and its stored data never need a migration.
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  MODEL_CATEGORIES,
  type AgentMeta, type BackgroundTaskRecord, type CheckpointRecord, type DelegationRecord, type LoopEvent,
  type OrchestrationSettings, type RouteDecision, type WorkflowRecord,
} from './types.ts'

/** Drop `undefined` members so parsed values satisfy exact optional properties. */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) out[key] = compact(member)
  }
  return out
}

/** Bind one zod schema to its record type after compaction. */
function record<T>(schema: z.ZodType): z.ZodType<T> {
  return schema.transform(value => compact(value) as T)
}

const instant = z.string().min(1)
const actor = z.object({ sessionId: z.string().min(1), name: z.string() })
const category = z.enum(MODEL_CATEGORIES)
const routedModel = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() })

const workflowTask = z.object({
  id: z.string().min(1),
  title: z.string(),
  role: z.string(),
  instructions: z.string(),
  dependsOn: z.array(z.string()),
  retries: z.number().int().min(0),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped']),
  attempts: z.number().int().min(0),
  workers: z.array(z.string()),
  workerSessionId: z.string().optional(),
  teamTaskId: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  startedAt: instant.optional(),
  finishedAt: instant.optional(),
})

const workflowSchema = record<WorkflowRecord>(z.object({
  id: z.string().min(1),
  title: z.string(),
  goal: z.string(),
  ownerSessionId: z.string().min(1),
  ownerName: z.string(),
  ownerAgentId: z.string().optional(),
  status: z.enum(['running', 'integrating', 'completed', 'failed', 'cancelled']),
  maxParallel: z.number().int().min(1),
  tasks: z.array(workflowTask),
  checkpointId: z.string().optional(),
  finalResult: z.string().optional(),
  error: z.string().optional(),
  createdAt: instant,
  updatedAt: instant,
}))

const testRun = z.object({ command: z.string(), ok: z.boolean(), exitCode: z.number().int().nullable(), at: instant })

const checkpointSchema = record<CheckpointRecord>(z.object({
  id: z.string().min(1),
  ref: z.string().min(1),
  commit: z.string().min(1),
  tree: z.string().min(1),
  head: z.string().optional(),
  branch: z.string().optional(),
  repo: z.string().min(1),
  dirty: z.array(z.string()),
  touched: z.array(z.string()),
  testsBefore: testRun.optional(),
  testsAfter: testRun.optional(),
  agent: actor,
  task: z.string().optional(),
  workflowId: z.string().optional(),
  reason: z.enum(['auto', 'manual', 'workflow', 'pre-restore']),
  createdAt: instant,
  restoredAt: instant.optional(),
  proposal: z.object({ reason: z.string(), at: instant, by: z.string() }).optional(),
}))

const loopSchema = record<LoopEvent>(z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  agentName: z.string(),
  kind: z.enum(['repeated-read', 'similar-edit', 'failing-command', 'alternating', 'same-error', 'no-progress']),
  summary: z.string(),
  attempts: z.array(z.string()),
  at: instant,
  outcome: z.enum(['recovering', 'recovered', 'recurred']),
  delegatedDiagnosis: z.boolean().optional(),
}))

const backgroundSchema = record<BackgroundTaskRecord>(z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  sessionId: z.string().optional(),
  title: z.string(),
  prompt: z.string(),
  status: z.enum(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  progress: z.object({
    steps: z.number().int().min(0),
    toolCalls: z.number().int().min(0),
    lastTool: z.string().optional(),
    percent: z.number().min(0).max(100).optional(),
    note: z.string().optional(),
  }),
  notifySessionId: z.string().optional(),
  createdBy: z.string(),
  result: z.string().optional(),
  error: z.string().optional(),
  createdAt: instant,
  startedAt: instant.optional(),
  finishedAt: instant.optional(),
  resumedAfterRestart: z.number().int().optional(),
}))

const delegationSchema = record<DelegationRecord>(z.object({
  id: z.string().min(1),
  kind: z.enum(['task', 'review']),
  from: actor,
  toAgentId: z.string().min(1),
  toName: z.string(),
  toSessionId: z.string().min(1),
  depth: z.number().int().min(1),
  rootId: z.string().min(1),
  parentId: z.string().optional(),
  chain: z.array(z.string()),
  task: z.string(),
  status: z.enum(['open', 'completed', 'failed', 'cancelled']),
  result: z.string().optional(),
  createdAt: instant,
  completedAt: instant.optional(),
}))

const routeSchema = record<RouteDecision>(z.object({
  sessionId: z.string().min(1),
  category,
  provider: z.string(),
  model: z.string(),
  routed: z.boolean(),
  reason: z.string(),
  at: instant,
  base: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
  }).optional(),
}))

const metaSchema = record<AgentMeta>(z.object({
  agentId: z.string().min(1),
  template: z.string().optional(),
  routing: z.union([z.enum(['auto', 'off']), category]).optional(),
}))

/** Stored settings; absent groups use {@link DEFAULT_SETTINGS}. */
export type StoredSettings = { readonly [K in keyof OrchestrationSettings]?: Partial<OrchestrationSettings[K]> }

const settingsSchema = record<StoredSettings>(z.object({
  routing: z.object({
    enabled: z.boolean().optional(),
    scope: z.enum(['managed', 'all']).optional(),
    categories: z.partialRecord(category, routedModel).optional(),
  }).optional(),
  loops: z.object({ enabled: z.boolean().optional(), noProgressSteps: z.number().int().min(5).optional() }).optional(),
  checkpoints: z.object({ auto: z.boolean().optional(), protectedBranches: z.array(z.string().min(1)).optional() }).optional(),
  delegation: z.object({ maxDepth: z.number().int().min(1).max(8).optional() }).optional(),
  background: z.object({ resumeOnRestart: z.boolean().optional() }).optional(),
}))

const initialSettings: StoredSettings = {}

/** Orchestration domain. */
export const orchestrationDomain = defineDomain({
  name: 'main_agent_orchestration',
  version: 1,
  tables: {
    workflows: domainTable<string, WorkflowRecord>(workflowSchema),
    checkpoints: domainTable<string, CheckpointRecord>(checkpointSchema),
    loops: domainTable<string, LoopEvent>(loopSchema),
    background: domainTable<string, BackgroundTaskRecord>(backgroundSchema),
    delegations: domainTable<string, DelegationRecord>(delegationSchema),
    routes: domainTable<string, RouteDecision>(routeSchema),
    meta: domainTable<string, AgentMeta>(metaSchema),
  },
  global: { schema: settingsSchema, initial: initialSettings },
})
