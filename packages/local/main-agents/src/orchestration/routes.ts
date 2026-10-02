/**
 * Orchestration routes under `/main-agents/orchestration/*`, served by the
 * Agents page handler (same login-token and Host/Origin fence). Requests act
 * as the signed-in user.
 */
import { z } from 'zod'
import { MODEL_CATEGORIES, type ModelCategory, type OrchestrationActor, type RoutedModel } from './types.ts'
import type { Orchestrator } from './service.ts'
import type { StoredSettings } from './storage.ts'
import { agentDashboard, orchestrationState } from './views.ts'

const USER: OrchestrationActor = { sessionId: 'user', name: 'the user' }

const category = z.enum(MODEL_CATEGORIES)
const routedModel = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}).strict()
const settingsBody = z.object({
  routing: z.object({
    enabled: z.boolean().optional(),
    scope: z.enum(['managed', 'all']).optional(),
    categories: z.partialRecord(category, routedModel.nullable()).optional(),
  }).strict().optional(),
  loops: z.object({ enabled: z.boolean().optional(), noProgressSteps: z.number().int().min(5).max(500).optional() }).strict().optional(),
  checkpoints: z.object({ auto: z.boolean().optional(), protectedBranches: z.array(z.string().min(1)).optional() }).strict().optional(),
  delegation: z.object({ maxDepth: z.number().int().min(1).max(8).optional() }).strict().optional(),
  background: z.object({ resumeOnRestart: z.boolean().optional() }).strict().optional(),
}).strict()

/** Route outcome. */
export interface RouteOutcome {
  readonly status: number
  readonly payload: unknown
}

/** Raised for malformed orchestration requests. */
export class OrchestrationRequestError extends Error {
  override readonly name = 'OrchestrationRequestError'
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new OrchestrationRequestError(z.prettifyError(result.error))
  return result.data
}

/** Drop undefined members (exact optional properties). */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T
}

/**
 * Handle one orchestration request.
 * @param service - orchestration service.
 * @param method - HTTP method.
 * @param parts - path segments after `orchestration`.
 * @param body - parsed JSON body for POST.
 * @returns status and JSON payload.
 */
export async function handleOrchestrationRoute(
  service: Orchestrator,
  method: string,
  parts: readonly string[],
  body: unknown,
): Promise<RouteOutcome> {
  await service.whenReady()
  const [scope, id, action, sub] = parts
  if (method === 'GET') {
    if (scope === 'state') return { status: 200, payload: await orchestrationState(service) }
    if (scope === 'agent' && id !== undefined) return { status: 200, payload: await agentDashboard(service, id) }
    if (scope === 'workflow' && id !== undefined) return { status: 200, payload: service.workflows.get(id) }
    if (scope === 'checkpoint' && id !== undefined && action === 'compare') return { status: 200, payload: await service.checkpoints.compare(id, true) }
    return { status: 404, payload: { code: 'not-found', message: `unknown route ${parts.join('/')}` } }
  }
  switch (scope) {
    case 'settings': {
      const changes = parse(settingsBody, body)
      let categories: Partial<Record<ModelCategory, RoutedModel>> | undefined
      if (changes.routing?.categories !== undefined) {
        const merged = new Map(Object.entries(service.settings().routing.categories) as Array<[ModelCategory, RoutedModel]>)
        const entries = Object.entries(changes.routing.categories) as Array<[ModelCategory, z.infer<typeof routedModel> | null | undefined]>
        for (const [key, value] of entries) {
          if (value === null) merged.delete(key)
          else if (value !== undefined) merged.set(key, compact(value) as RoutedModel)
        }
        categories = Object.fromEntries(merged)
      }
      const routing = changes.routing === undefined
        ? undefined
        : compact({ enabled: changes.routing.enabled, scope: changes.routing.scope, categories })
      return {
        status: 200,
        payload: await service.updateSettings(compact({
          routing,
          loops: changes.loops === undefined ? undefined : compact(changes.loops),
          checkpoints: changes.checkpoints === undefined ? undefined : compact(changes.checkpoints),
          delegation: changes.delegation === undefined ? undefined : compact(changes.delegation),
          background: changes.background === undefined ? undefined : compact(changes.background),
        }) as StoredSettings),
      }
    }
    case 'agent': {
      if (id === undefined || action !== 'routing') break
      const { routing } = parse(z.object({ routing: z.union([z.enum(['auto', 'off']), category]) }).strict(), body)
      const agent = await service.registry.get(id)
      return { status: 200, payload: await service.setMeta(agent.id, { routing }) }
    }
    case 'workflow': {
      if (id === undefined) break
      if (action === 'cancel') return { status: 200, payload: await service.workflows.cancel(id, USER) }
      if (action === 'task' && sub !== undefined && parts[4] === 'retry') return { status: 200, payload: await service.workflows.retryTask(id, sub) }
      break
    }
    case 'checkpoint': {
      if (id === 'create') {
        const input = parse(z.object({
          agentId: z.string().min(1).optional(),
          cwd: z.string().min(1).optional(),
          task: z.string().optional(),
        }).strict(), body)
        const agent = input.agentId === undefined ? undefined : await service.registry.get(input.agentId)
        const liveCwd = agent?.sessionId === undefined
          ? undefined
          : service.host.agents.list().find(live => live.session.id === agent.sessionId)?.session.header.cwd
        const cwd = input.cwd ?? liveCwd ?? agent?.workspace ?? process.cwd()
        const record = await service.checkpoints.create(cwd, {
          agent: agent?.sessionId === undefined ? USER : { sessionId: agent.sessionId, name: agent.name },
          reason: 'manual',
          ...input.task === undefined ? {} : { task: input.task },
        })
        if (record === undefined) return { status: 400, payload: { code: 'invalid', message: `${cwd} is not inside a Git repository` } }
        return { status: 200, payload: record }
      }
      if (id === undefined) break
      if (action === 'restore') {
        const input = parse(z.object({ scope: z.enum(['touched', 'all']).optional(), paths: z.array(z.string().min(1)).optional() }).strict(), body)
        return {
          status: 200,
          payload: await service.checkpoints.restore(id, {
            ...input.scope === undefined ? {} : { scope: input.scope },
            ...input.paths === undefined ? {} : { paths: input.paths },
          }, USER),
        }
      }
      if (action === 'delete') {
        await service.checkpoints.delete(id)
        return { status: 200, payload: { deleted: id } }
      }
      break
    }
    case 'background': {
      if (id === 'create') {
        const input = parse(z.object({ agentId: z.string().min(1), title: z.string(), prompt: z.string().min(1) }).strict(), body)
        return { status: 200, payload: await service.background.create(input, USER) }
      }
      if (id === undefined) break
      if (action === 'pause') return { status: 200, payload: await service.background.pause(id) }
      if (action === 'resume') return { status: 200, payload: await service.background.resume(id) }
      if (action === 'cancel') return { status: 200, payload: await service.background.cancel(id) }
      break
    }
    case 'delegate': {
      const input = parse(z.object({ agentId: z.string().min(1), task: z.string().min(1), kind: z.enum(['task', 'review']).optional() }).strict(), body)
      return { status: 200, payload: await service.delegations.delegate(USER, input.agentId, input.task, input.kind ?? 'task') }
    }
    default:
      break
  }
  return { status: 404, payload: { code: 'not-found', message: `unknown route ${parts.join('/')}` } }
}

/**
 * HTTP status for an orchestration error.
 * @param error - thrown value.
 * @returns status, or undefined when the error is not an orchestration error.
 */
export function orchestrationErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined
  if (error.name === 'OrchestrationRequestError') return 400
  if (['WorkflowError', 'CheckpointError', 'BackgroundError', 'DelegationError'].includes(error.name)) {
    return /^no (workflow|checkpoint|background task|delegation) /.test(error.message) ? 404 : 409
  }
  return undefined
}
