/** Durable Agent Registry storage: one record per main agent plus registry settings. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { MainAgentModel, MainAgentRecord, MainAgentRegistrySettings } from './types.ts'

const instant = z.string().min(1)

const modelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}).strict().transform(({ reasoningEffort, ...rest }): MainAgentModel =>
  reasoningEffort === undefined ? rest : { ...rest, reasoningEffort })

const activitySchema = z.object({
  at: instant,
  kind: z.enum(['created', 'edited', 'started', 'stopped', 'archived', 'message', 'task', 'team', 'session']),
  text: z.string(),
}).strict()

/** Stored main agent; unknown fields reject the domain so a newer writer is never silently truncated. */
export const mainAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  instructions: z.string(),
  status: z.enum(['running', 'stopped', 'archived']),
  mode: z.string().min(1),
  model: modelSchema.optional(),
  tools: z.object({ allow: z.array(z.string()), deny: z.array(z.string()) }).strict(),
  workspace: z.string().min(1).optional(),
  permissions: z.object({ preset: z.string().min(1), agentAdministration: z.boolean() }).strict(),
  sessionId: z.string().min(1).optional(),
  previousSessionIds: z.array(z.string()),
  createdAt: instant,
  updatedAt: instant,
  createdBy: z.string().min(1),
  activity: z.array(activitySchema),
}).strict().transform(({ model, workspace, sessionId, ...rest }): MainAgentRecord => ({
  ...rest,
  ...model === undefined ? {} : { model },
  ...workspace === undefined ? {} : { workspace },
  ...sessionId === undefined ? {} : { sessionId },
}))

/** Stored registry settings; fields are absent until the user changes them. */
export type StoredRegistrySettings = Partial<MainAgentRegistrySettings>

/** Absent `administratorModes` means the deployment's configured default applies. */
const settingsSchema = z.object({
  administratorModes: z.array(z.string().min(1)).optional(),
}).strict().transform(({ administratorModes }): StoredRegistrySettings =>
  administratorModes === undefined ? {} : { administratorModes })

const initialSettings: StoredRegistrySettings = {}

/** Agent Registry domain: `~/.dsh/storages/main_agents.json` under the default JSON backend. */
export const mainAgentDomain = defineDomain({
  name: 'main_agents',
  version: 1,
  tables: { agents: domainTable<string, MainAgentRecord>(mainAgentSchema) },
  global: { schema: settingsSchema, initial: initialSettings },
})
