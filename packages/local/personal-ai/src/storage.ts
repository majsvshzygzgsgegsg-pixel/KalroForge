/** Durable Personal AI storage: memory, projects, task controls, agent profiles, finished turns, and settings. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { AGENT_TAGS } from './core/capabilities.ts'
import { DEPTHS } from './core/classifier.ts'
import { MEMORY_SCOPES } from './core/memory.ts'
import type { TurnRecord } from './core/metrics.ts'
import {
  CONTROL_ACTIONS,
  type AgentProfile, type ControlRecord, type MemoryEntry, type ProjectRecord, type StoredPersonalSettings,
} from './types.ts'

const instant = z.string().min(1)

/** Drop undefined members so exact optional properties stay exact. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T
}

const memorySchema = z.object({
  id: z.string().min(1),
  scope: z.enum(MEMORY_SCOPES),
  scopeId: z.string().min(1).optional(),
  text: z.string().min(1).max(2000),
  tags: z.array(z.string()),
  status: z.enum(['active', 'disabled']),
  source: z.enum(['user', 'assistant']),
  createdBy: z.string().min(1),
  createdAt: instant,
  updatedAt: instant,
}).strict().transform(value => compact(value) as MemoryEntry)

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1).optional(),
  description: z.string(),
  stack: z.array(z.string()),
  commands: z.object({
    dev: z.string().optional(), build: z.string().optional(), test: z.string().optional(), lint: z.string().optional(),
  }).strict().transform(value => compact(value)),
  agentIds: z.array(z.string()),
  decisions: z.array(z.object({ at: instant, text: z.string() }).strict()),
  docs: z.array(z.string()),
  status: z.enum(['active', 'archived']),
  createdAt: instant,
  updatedAt: instant,
  lastOpenedAt: instant.optional(),
}).strict().transform(value => compact(value) as ProjectRecord)

const controlSchema = z.object({
  id: z.string().min(1),
  ref: z.object({ kind: z.enum(['background', 'workflow', 'session']), id: z.string().min(1) }).strict(),
  action: z.enum(CONTROL_ACTIONS),
  text: z.string().optional(),
  outcome: z.enum(['applied', 'delivered', 'rejected']),
  detail: z.string(),
  state: z.string().optional(),
  by: z.string().min(1),
  at: instant,
}).strict().transform(value => compact(value) as ControlRecord)

const profileSchema = z.object({
  agentId: z.string().min(1),
  tags: z.array(z.enum(AGENT_TAGS)),
}).strict().transform(value => value as AgentProfile)

const turnSchema = z.object({
  at: instant,
  sessionId: z.string().min(1),
  mode: z.string(),
  depth: z.enum(DEPTHS),
  category: z.string(),
  durationMs: z.number().nonnegative(),
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tokens: z.number().nonnegative().optional(),
  delegated: z.boolean(),
  approvals: z.number().int().nonnegative(),
  ok: z.boolean(),
}).strict().transform(value => compact(value) as TurnRecord)

const settingsSchema = z.object({
  personality: z.object({
    name: z.string().min(1).max(40).optional(),
    instructions: z.string().max(4000).optional(),
    speakingStyle: z.string().max(200).optional(),
    verbosity: z.enum(['brief', 'balanced', 'detailed']).optional(),
    voice: z.object({ name: z.string().optional(), rate: z.number().min(0.5).max(2) }).strict().optional(),
    notifications: z.enum(['all', 'important', 'off']).optional(),
    handsFree: z.boolean().optional(),
  }).strict().optional(),
  activeProjectId: z.string().min(1).optional(),
  coordinator: z.boolean().optional(),
  conversationSessionId: z.string().min(1).optional(),
}).strict().transform(value => compact(value) as StoredPersonalSettings)

const initialSettings: StoredPersonalSettings = {}

/** Personal AI domain: `~/.dsh/storages/personal_ai.json` under the default JSON backend. */
export const personalAiDomain = defineDomain({
  name: 'personal_ai',
  version: 1,
  tables: {
    memory: domainTable<string, MemoryEntry>(memorySchema),
    projects: domainTable<string, ProjectRecord>(projectSchema),
    controls: domainTable<string, ControlRecord>(controlSchema),
    profiles: domainTable<string, AgentProfile>(profileSchema),
    turns: domainTable<string, TurnRecord>(turnSchema),
  },
  global: { schema: settingsSchema, initial: initialSettings },
})
