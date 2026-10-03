/**
 * Command Center routes under `/personal-ai/*`. Every request first passes the
 * composition's `connection` fence (login-token cookie, Host/Origin check),
 * then validates its JSON body. Requests come from the signed-in user.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { z } from 'zod'
import { AGENT_TAGS, CAPABILITY_CATEGORIES, groupTools } from './core/capabilities.ts'
import { classifyDepth } from './core/classifier.ts'
import { HOLO_SIGNALS, HoloSceneError, type HoloPerception } from './core/holo-scene.ts'
import { MEMORY_SCOPES, type MemoryScope } from './core/memory.ts'
import type { HoloDeck } from './holo.ts'
import { handleDevRoute } from './dev/install.ts'
import type { DevKit } from './dev/service.ts'
import { handleLifeRoute } from './life/install.ts'
import type { LifeOs } from './life/service.ts'
import type { PersonalAi } from './service.ts'
import { CONTROL_ACTIONS, PersonalAiError, type TaskRef } from './types.ts'

/** Route prefix shared with the client. */
export const PERSONAL_AI_PATH = '/personal-ai'

const MAX_BODY_BYTES = 64 * 1024
const USER = 'user'

interface Connection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

const commands = z.object({ dev: z.string(), build: z.string(), test: z.string(), lint: z.string() }).partial().strict()
const memoryCreate = z.object({
  scope: z.enum(MEMORY_SCOPES),
  scopeId: z.string().min(1).optional(),
  text: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(40)).max(12).optional(),
}).strict()
const memoryUpdate = z.object({
  text: z.string().min(1).max(2000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(12).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict()
const projectCreate = z.object({
  name: z.string().min(1).max(80),
  path: z.string().min(1).optional(),
  description: z.string().max(2000).optional(),
  stack: z.array(z.string().min(1)).max(30).optional(),
  commands: commands.optional(),
  docs: z.array(z.string().min(1)).max(30).optional(),
  open: z.boolean().optional(),
}).strict()
const projectUpdate = z.object({
  name: z.string().min(1).max(80).optional(),
  path: z.string().min(1).nullable().optional(),
  description: z.string().max(2000).optional(),
  stack: z.array(z.string().min(1)).max(30).optional(),
  commands: commands.optional(),
  docs: z.array(z.string().min(1)).max(30).optional(),
  decision: z.string().min(1).max(2000).optional(),
}).strict()
const assignBody = z.object({ agentId: z.string().min(1), unassign: z.boolean().optional() }).strict()
const personalityBody = z.object({
  name: z.string().min(1).max(40).optional(),
  instructions: z.string().max(4000).optional(),
  speakingStyle: z.string().min(1).max(200).optional(),
  verbosity: z.enum(['brief', 'balanced', 'detailed']).optional(),
  voice: z.object({ name: z.string().max(200).optional(), rate: z.number().min(0.5).max(2).optional() }).strict().optional(),
  notifications: z.enum(['all', 'important', 'off']).optional(),
  handsFree: z.boolean().optional(),
}).strict()
const coordinatorBody = z.object({ enabled: z.boolean() }).strict()
const controlBody = z.object({
  kind: z.enum(['background', 'workflow', 'session']),
  id: z.string().min(1),
  action: z.enum(CONTROL_ACTIONS),
  text: z.string().min(1).max(4000).optional(),
}).strict()
const voiceBody = z.object({ phase: z.enum(['off', 'arming', 'listening', 'speaking']) }).strict()
const tagsBody = z.object({ tags: z.array(z.enum(AGENT_TAGS)).max(AGENT_TAGS.length) }).strict()
const recommendBody = z.object({ task: z.string().min(1).max(4000), project: z.string().min(1).optional() }).strict()
const converseBody = z.object({ text: z.string().min(1).max(4000) }).strict()
const unit = z.number().min(0).max(1)
const degrees = z.number().min(-180).max(180)
const perceptionBody = z.object({
  face: z.object({
    present: z.boolean(),
    yaw: degrees.optional(),
    pitch: degrees.optional(),
    roll: degrees.optional(),
    looking: z.enum(['screen', 'left', 'right', 'up', 'down']).optional(),
    smile: unit.optional(),
    mouthOpen: unit.optional(),
    blink: unit.optional(),
    browRaise: unit.optional(),
    frown: unit.optional(),
    distance: z.enum(['near', 'mid', 'far']).optional(),
  }).strict().nullable().optional(),
  hands: z.array(z.object({
    side: z.enum(['left', 'right', 'unknown']),
    gesture: z.enum(['open', 'fist', 'pinch', 'point', 'peace', 'relaxed']),
    x: unit,
    y: unit,
    hover: z.string().min(1).max(120).optional(),
    holding: z.string().min(1).max(120).optional(),
  }).strict()).max(2),
  pose: z.object({
    present: z.boolean(),
    armsUp: z.enum(['none', 'left', 'right', 'both']).optional(),
    lean: z.enum(['left', 'right', 'center']).optional(),
  }).strict().nullable().optional(),
  events: z.array(z.enum(HOLO_SIGNALS)).max(20),
  fps: z.number().min(0).max(240).optional(),
}).strict()
const layoutBody = z.object({
  items: z.array(z.object({ id: z.string().min(1).max(20), x: z.number(), y: z.number(), scale: z.number().optional() }).strict()).max(80),
}).strict()
const activateBody = z.object({ id: z.string().min(1).max(20), value: z.string().max(300).optional() }).strict()

const STATUS: Record<PersonalAiError['code'], number> = { 'not-found': 404, 'invalid': 400, 'sensitive': 422, 'conflict': 409 }

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new PersonalAiError('invalid', z.prettifyError(result.error))
  return result.data
}

type Compact<T> = { [K in keyof T]: Exclude<T[K], undefined> }

/** Drop undefined members so exact optional properties stay exact. */
function compact<T extends object>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as Compact<T>
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new PersonalAiError('invalid', 'request body is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    // A non-JSON body is reported as invalid input.
    throw new PersonalAiError('invalid', 'request body must be JSON')
  }
}

/**
 * Command Center overview: state, active project, running work, recent
 * activity, metrics, and settings in one request.
 * @param service - Personal AI service.
 * @param ctx - Host context.
 * @returns overview payload.
 */
export async function overview(service: PersonalAi, ctx: Context): Promise<Record<string, unknown>> {
  const background = service.backgroundTasks()
  const agents = await service.candidates()
  const workflows = ctx.orchestration.workflows.list()
  const memories = service.memories({ includeDisabled: true, limit: 5000 })
  return {
    state: service.assistantState(),
    personality: service.personality(),
    coordinator: service.coordinatorEnabled(),
    activeProject: service.activeProject() ?? null,
    counts: {
      agents: agents.length,
      agentsBusy: agents.filter(agent => agent.runtime === 'busy').length,
      projects: service.projects().length,
      memories: memories.length,
      background: background.filter(task => task.status === 'running' || task.status === 'queued' || task.status === 'paused').length,
      workflows: workflows.filter(workflow => workflow.status === 'running' || workflow.status === 'integrating').length,
    },
    background: background.slice(0, 30),
    workflows: workflows.slice(0, 20).map(workflow => ({
      id: workflow.id,
      title: workflow.title,
      status: workflow.status,
      ownerName: workflow.ownerName,
      tasks: workflow.tasks.map(task => ({ id: task.id, title: task.title, status: task.status })),
      createdAt: workflow.createdAt,
    })),
    controls: service.controls(20),
    notifications: service.notifications().slice(-30),
    metrics: service.metrics().summary,
  }
}

/**
 * The tools one live Session actually has, grouped by capability.
 * @param ctx - Host context.
 * @param sessionId - Session; without one, every category is empty.
 * @returns grouped tool names.
 */
async function toolGroups(ctx: Context, sessionId: string | undefined): Promise<Record<string, unknown>> {
  const agent = sessionId === undefined ? undefined : ctx.get('agents')?.get(SessionId(sessionId))
  const scope = agent === undefined ? undefined : scopeOf(agent.ctx)
  const prompt = ctx.get('systemPrompt')
  const names = scope === undefined || prompt === undefined ? [] : (await prompt.assemble({ scope })).tools.map(tool => tool.name)
  return { ...sessionId === undefined ? {} : { sessionId }, ...groupTools(names) }
}

/** Assistant state plus whether Holo Hands is open; every state reply carries both so the deck never flickers shut. */
function stateView(service: PersonalAi, ctx: Context, sessionId?: string): Record<string, unknown> {
  const holo = ctx.get('holoDeck')
  return { ...service.assistantState(sessionId), ...holo === undefined ? {} : { holo: holo.view() } }
}

function devOf(ctx: Context): DevKit {
  const dev = ctx.get('devKit')
  if (dev === undefined) throw new PersonalAiError('not-found', 'DevKit is not available')
  return dev
}

function lifeOf(ctx: Context): LifeOs {
  const life = ctx.get('lifeOs')
  if (life === undefined) throw new PersonalAiError('not-found', 'Life OS is not available')
  return life
}

function deckOf(ctx: Context): HoloDeck {
  const deck = ctx.get('holoDeck')
  if (deck === undefined) throw new PersonalAiError('not-found', 'Holo Hands is not available')
  return deck
}

/**
 * One Holo Hands request from the browser.
 * @param deck - Holo deck.
 * @param action - path segment after `holo`.
 * @param body - parsed JSON body.
 * @returns the payload.
 */
async function holoAction(deck: HoloDeck, action: string | undefined, body: unknown): Promise<unknown> {
  try {
    switch (action) {
      case 'open': return await deck.open()
      case 'close': return deck.close()
      case 'perception':
        deck.perceive(parse(perceptionBody, body) as unknown as HoloPerception)
        return { ok: true }
      case 'layout':
        await deck.layout(parse(layoutBody, body).items.map(entry => compact(entry)))
        return { ok: true }
      case 'activate': {
        const input = parse(activateBody, body)
        return { prompt: deck.activation(input.id, input.value) ?? null }
      }
      default:
        throw new PersonalAiError('not-found', `unknown route holo/${action ?? ''}`)
    }
  } catch (error) {
    if (error instanceof HoloSceneError) throw new PersonalAiError('invalid', error.message)
    throw error
  }
}

/**
 * Handle one Personal AI request.
 * @param service - Personal AI service.
 * @param ctx - Host context.
 * @param method - HTTP method.
 * @param parts - path segments after `/personal-ai`.
 * @param query - URL query.
 * @param body - parsed JSON body for POST.
 * @returns status and payload.
 */
export async function handlePersonalAiRoute(
  service: PersonalAi,
  ctx: Context,
  method: string,
  parts: readonly string[],
  query: URLSearchParams,
  body: unknown,
): Promise<{ status: number; payload: unknown; html?: string }> {
  await service.whenReady()
  const [scope, id, action] = parts
  const ok = (payload: unknown): { status: number; payload: unknown } => ({ status: 200, payload })
  if (method === 'GET') {
    switch (scope) {
      case 'state':
        return ok(stateView(service, ctx, query.get('session') ?? undefined))
      case 'holo': {
        const holo = deckOf(ctx)
        return ok({ ...holo.view(), scene: holo.scene(), camera: holo.seeing() })
      }
      case 'overview': return ok(await overview(service, ctx))
      case 'memory': {
        const scopeParam = query.get('scope')
        const memoryScope = scopeParam !== null && (MEMORY_SCOPES as readonly string[]).includes(scopeParam)
          ? scopeParam as MemoryScope
          : undefined
        return ok(service.memories(compact({
          text: query.get('q') ?? undefined,
          scope: memoryScope,
          includeDisabled: query.get('disabled') === '1',
          limit: 500,
        })))
      }
      case 'projects': return ok({ projects: service.projects(query.get('archived') === '1'), activeProjectId: service.activeProject()?.id ?? null })
      case 'project':
        if (id !== undefined && action === 'status') return ok(await service.projectStatus(id))
        if (id !== undefined) return ok(service.project(id))
        break
      case 'personality': return ok({ personality: service.personality(), coordinator: service.coordinatorEnabled() })
      case 'controls': return ok(service.controls())
      case 'notifications': return ok(service.notifications(query.get('since') ?? undefined))
      case 'metrics': return ok(service.metrics(query.get('session') ?? undefined))
      case 'background': return ok(service.backgroundTasks())
      case 'agents': return ok({ agents: await service.candidates(), tags: AGENT_TAGS })
      case 'capabilities': return ok({ categories: CAPABILITY_CATEGORIES, tags: AGENT_TAGS })
      case 'tools': return ok(await toolGroups(ctx, query.get('session') ?? service.assistantState().sessionId))
      case 'classify': {
        const text = query.get('text') ?? ''
        return ok({ ...classifyDepth(text), decision: service.decide('preview', text) })
      }
      case 'converse':
        if (id !== undefined) return ok(service.converseTurn(id))
        return ok({ sessionId: service.conversationSessionId() ?? null })
      case 'life': return handleLifeRoute(lifeOf(ctx), method, parts.slice(1), query, body)
      case 'dev': return handleDevRoute(devOf(ctx), method, parts.slice(1))
      default:
    }
    return { status: 404, payload: { code: 'not-found', message: `unknown route ${parts.join('/')}` } }
  }
  switch (scope) {
    case 'memory': {
      if (id === undefined) {
        const input = parse(memoryCreate, body)
        return ok(await service.remember(compact(input), USER))
      }
      if (action === 'delete') return ok(await service.forget(id))
      return ok(await service.updateMemory(id, compact(parse(memoryUpdate, body))))
    }
    case 'project': {
      if (id === undefined) {
        const { open, commands: given, ...input } = parse(projectCreate, body)
        const project = await service.createProject(compact({ ...input, commands: given === undefined ? undefined : compact(given) }))
        return ok(open === false ? project : await service.openProject(project.id))
      }
      if (action === 'open') return ok(await service.openProject(id))
      if (action === 'archive') return ok(await service.archiveProject(id))
      if (action === 'assign') {
        const input = parse(assignBody, body)
        return ok(await service.assignAgent(id, input.agentId, input.unassign !== true))
      }
      const { commands: given, ...changes } = parse(projectUpdate, body)
      return ok(await service.updateProject(id, compact({ ...changes, commands: given === undefined ? undefined : compact(given) })))
    }
    case 'personality': {
      const { voice, ...changes } = parse(personalityBody, body)
      const current = service.personality().voice
      const merged = voice === undefined ? undefined : { ...current, ...compact(voice) }
      return ok(await service.updatePersonality(compact({ ...changes, voice: merged })))
    }
    case 'coordinator': {
      await service.setCoordinator(parse(coordinatorBody, body).enabled)
      return ok({ coordinator: service.coordinatorEnabled() })
    }
    case 'control': {
      const input = parse(controlBody, body)
      const ref: TaskRef = { kind: input.kind, id: input.id }
      return ok(await service.control(ref, input.action, input.text, USER))
    }
    case 'voice': {
      service.setVoice(parse(voiceBody, body).phase)
      return ok(stateView(service, ctx))
    }
    case 'agent':
      if (id !== undefined && action === 'tags') return ok({ tags: await service.setAgentTags(id, parse(tagsBody, body).tags) })
      break
    case 'recommend': {
      const input = parse(recommendBody, body)
      return ok(await service.recommend(input.task, input.project === undefined ? undefined : service.project(input.project).id))
    }
    case 'converse':
      if (id === 'new') return ok(await service.newConversation())
      return ok(await service.converse(parse(converseBody, body).text))
    case 'holo': return ok(await holoAction(deckOf(ctx), id, body))
    case 'life': return handleLifeRoute(lifeOf(ctx), method, parts.slice(1), query, body)
    case 'dev': return handleDevRoute(devOf(ctx), method, parts.slice(1))
    default:
  }
  return { status: 404, payload: { code: 'not-found', message: `unknown route ${parts.join('/')}` } }
}

/**
 * Register the Personal AI routes on the composition web server.
 * @param ctx - Host context carrying `webServer` and `connection`.
 * @param service - Personal AI service.
 */
export function installPersonalAiRoutes(ctx: Context, service: PersonalAi): void {
  const connection = Reflect.get(ctx, 'connection') as Connection
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PERSONAL_AI_PATH,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      try {
        // Node always sets url on server requests; String keeps that fact local.
        const url = new URL(String(req.url), 'http://localhost')
        const parts = url.pathname.slice(PERSONAL_AI_PATH.length).split('/').filter(part => part !== '').map(decodeURIComponent)
        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'POST') {
          sendJson(res, 405, { code: 'invalid', message: 'method not allowed' })
          return
        }
        const body = method === 'POST' ? await readBody(req) : undefined
        const outcome = await handlePersonalAiRoute(service, ctx, method, parts, url.searchParams, body)
        if (outcome.html !== undefined) {
          res.statusCode = outcome.status
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(outcome.html)
          return
        }
        sendJson(res, outcome.status, outcome.payload)
      } catch (error) {
        if (error instanceof PersonalAiError) {
          sendJson(res, STATUS[error.code], { code: error.code, message: error.message })
          return
        }
        const status = typeof error === 'object' && error !== null && 'name' in error && /NotFound|Background|Workflow/i.test(String(error.name)) ? 409 : 500
        if (status === 500) ctx.logger.error(`personal-ai: ${req.method ?? 'GET'} ${String(req.url)} failed: ${String(error)}`)
        sendJson(res, status, { code: status === 409 ? 'conflict' : 'internal', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `personal-ai: ${PERSONAL_AI_PATH}/*`)
}
