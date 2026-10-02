/**
 * Browser routes for the Agents management page. Every route first asks the
 * composition's `connection` service for a rejection (login-token cookie,
 * Host/Origin fence), then validates its JSON body at the wire. Requests come
 * from the signed-in user, so they act as the `user` actor.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import type { MainAgentRegistry } from './registry.ts'
import { MainAgentError, type MainAgentActor, type MainAgentModel } from './types.ts'

/** Route prefix shared with the client. */
export const MAIN_AGENTS_PATH = '/main-agents'

const MAX_BODY_BYTES = 256 * 1024
const USER: MainAgentActor = { kind: 'user' }

interface Connection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

const modelBody = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}).strict()
const toolsBody = z.object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }).strict()
const permissionsBody = z.object({ preset: z.string().min(1).optional(), agentAdministration: z.boolean().optional() }).strict()
const configBody = z.object({
  description: z.string().optional(),
  instructions: z.string().optional(),
  mode: z.string().min(1).optional(),
  model: modelBody.optional(),
  tools: toolsBody.optional(),
  workspace: z.string().min(1).optional(),
  permissions: permissionsBody.optional(),
  start: z.boolean().optional(),
}).strict()
const changesBody = configBody.omit({ start: true, workspace: true }).extend({
  name: z.string().min(1).optional(),
  workspace: z.string().nullable().optional(),
}).strict()

const createBody = z.object({ name: z.string().min(1), config: configBody.optional() }).strict()
const settingsBody = z.object({ administratorModes: z.array(z.string().min(1)) }).strict()
const teamBody = z.object({
  members: z.array(z.object({ name: z.string().min(1), description: z.string(), prompt: z.string().min(1) }).strict()).optional(),
}).strict()

/** Remove keys whose value is undefined so exact optional fields stay exact. */
function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const result: { [K in keyof T]?: Exclude<T[K], undefined> } = {}
  for (const key of Object.keys(value) as Array<keyof T>) {
    const entry = value[key]
    if (entry !== undefined) result[key] = entry as Exclude<T[typeof key], undefined>
  }
  return result
}

function modelOf(input: z.infer<typeof modelBody>): MainAgentModel {
  return input.reasoningEffort === undefined
    ? { provider: input.provider, model: input.model }
    : { provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort }
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
    // http server streams without setEncoding always yield Buffer chunks.
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new MainAgentError('invalid', 'request body is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    // Swallows the parse error: a non-JSON body is reported as invalid input.
    throw new MainAgentError('invalid', 'request body must be JSON')
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new MainAgentError('invalid', z.prettifyError(result.error))
  return result.data
}

const STATUS: Record<MainAgentError['code'], number> = {
  'not-found': 404,
  'invalid': 400,
  'conflict': 409,
  'archived': 409,
  'stopped': 409,
  'forbidden': 403,
  'unavailable': 503,
}

/**
 * Register the Agents page routes on the composition web server.
 * @param ctx - Host context carrying `webServer`, `connection`, and `mainAgents`.
 * @param registry - the Agent Registry.
 */
export function installMainAgentRoutes(ctx: Context, registry: MainAgentRegistry): void {
  const connection = Reflect.get(ctx, 'connection') as Connection

  const options = async (): Promise<unknown> => {
    const presets = ctx.get('agentPresets')
    const permissions = ctx.get('permissionPresets')
    const modes = presets === undefined ? [] : (await presets.list()).map(row => ({
      id: row.id,
      name: row.name ?? row.id,
      ...row.description === undefined ? {} : { description: row.description },
    }))
    const catalog = await ctx.sessionController.modelCatalog().catch((error: unknown) => {
      ctx.logger.warn(`main-agents: model catalog unavailable: ${String(error)}`)
      return undefined
    })
    return {
      modes,
      permissionPresets: permissions?.catalog().options ?? [],
      models: catalog === undefined ? [] : catalog.groups.map(group => ({
        provider: group.id,
        name: group.name,
        models: group.models.map(model => ({ id: model.id, name: model.name })),
      })),
      defaultModel: catalog?.default,
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Node always sets url on server requests; String keeps that fact local.
    const url = new URL(String(req.url), 'http://localhost')
    const parts = url.pathname.slice(MAIN_AGENTS_PATH.length).split('/').filter(part => part !== '').map(decodeURIComponent)
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'state') {
      sendJson(res, 200, {
        agents: await registry.list(url.searchParams.get('archived') === '1'),
        settings: registry.settings(),
        options: await options(),
      })
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, POST')
      res.end()
      return
    }
    const body = await readBody(req)
    if (parts.length === 1 && parts[0] === 'create') {
      const { name, config } = parse(createBody, body)
      const c = config ?? {}
      sendJson(res, 200, await registry.create(name, {
        ...defined({ description: c.description, instructions: c.instructions, mode: c.mode, workspace: c.workspace, start: c.start }),
        ...c.model === undefined ? {} : { model: modelOf(c.model) },
        ...c.tools === undefined ? {} : { tools: defined(c.tools) },
        ...c.permissions === undefined ? {} : { permissions: defined(c.permissions) },
      }, USER))
      return
    }
    if (parts.length === 1 && parts[0] === 'settings') {
      sendJson(res, 200, await registry.updateSettings(parse(settingsBody, body)))
      return
    }
    const [scope, id, action] = parts
    if (scope !== 'agent' || id === undefined || action === undefined || parts.length !== 3) {
      sendJson(res, 404, { code: 'not-found', message: `unknown route ${url.pathname}` })
      return
    }
    switch (action) {
      case 'edit': {
        const c = parse(z.object({ changes: changesBody }).strict(), body).changes
        sendJson(res, 200, await registry.edit(id, {
          ...defined({ name: c.name, description: c.description, instructions: c.instructions, mode: c.mode }),
          ...c.workspace === undefined ? {} : { workspace: c.workspace === null || c.workspace.trim() === '' ? null : c.workspace },
          ...c.model === undefined ? {} : { model: modelOf(c.model) },
          ...c.tools === undefined ? {} : { tools: defined(c.tools) },
          ...c.permissions === undefined ? {} : { permissions: defined(c.permissions) },
        }, USER))
        return
      }
      case 'clone':
        sendJson(res, 200, await registry.clone(id, parse(z.object({ newName: z.string().min(1) }).strict(), body).newName, USER))
        return
      case 'archive':
        sendJson(res, 200, await registry.archive(id, USER))
        return
      case 'start':
        sendJson(res, 200, await registry.start(id, USER))
        return
      case 'stop':
        sendJson(res, 200, await registry.stop(id, USER))
        return
      case 'restart':
        sendJson(res, 200, await registry.restart(id, USER))
        return
      case 'model':
        sendJson(res, 200, await registry.assignModel(id, modelOf(parse(modelBody, body)), USER))
        return
      case 'mode':
        sendJson(res, 200, await registry.assignMode(id, parse(z.object({ mode: z.string().min(1) }).strict(), body).mode, USER))
        return
      case 'tools':
        sendJson(res, 200, await registry.assignTools(id, defined(parse(toolsBody, body)), USER))
        return
      case 'workspace': {
        const { workspace } = parse(z.object({ workspace: z.string().nullable() }).strict(), body)
        sendJson(res, 200, await registry.assignWorkspace(id, workspace === null || workspace.trim() === '' ? null : workspace, USER))
        return
      }
      case 'permissions':
        sendJson(res, 200, await registry.managePermissions(id, defined(parse(permissionsBody, body)), USER))
        return
      case 'team': {
        const { members } = parse(teamBody, body)
        sendJson(res, 200, await registry.createTeam(id, members ?? [], USER, AbortSignal.timeout(120_000)))
        return
      }
      case 'message':
        sendJson(res, 200, await registry.sendMessage(id, parse(z.object({ message: z.string().min(1) }).strict(), body).message, USER))
        return
      case 'delegate':
        sendJson(res, 200, await registry.delegateTask(id, parse(z.object({ task: z.string().min(1) }).strict(), body).task, USER))
        return
      default:
        sendJson(res, 404, { code: 'not-found', message: `unknown action ${action}` })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: MAIN_AGENTS_PATH,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      try {
        await handle(req, res)
      } catch (error) {
        if (error instanceof MainAgentError) {
          sendJson(res, STATUS[error.code], { code: error.code, message: error.message })
          return
        }
        ctx.logger.error(`main-agents: ${req.method ?? 'GET'} ${String(req.url)} failed: ${String(error)}`)
        sendJson(res, 500, { code: 'internal', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `main-agents: ${MAIN_AGENTS_PATH}/*`)
}
