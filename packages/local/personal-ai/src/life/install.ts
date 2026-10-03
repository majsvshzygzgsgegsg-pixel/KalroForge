/**
 * Life OS wiring: Air-Gap enforcement on the model and tool paths, the
 * coordinator's brain / graph / self-written-tool tools, and the
 * `/personal-ai/life/*` routes. Air-Gap hooks run outermost so no other hook
 * can route a call back to the cloud; they only ever block or redirect to the
 * user's chosen local model, never grant anything.
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { airGapBlock, USER_TOOL_LANGUAGES, USER_TOOL_PREFIX } from '../core/autonomy.ts'
import { PersonalAiError } from '../types.ts'
import { PHONE_PAGE } from './phone.ts'
import { lifeSettingsPatch, type LifeOs } from './service.ts'

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

async function guarded(operation: () => Promise<unknown>): Promise<JsonValue> {
  try {
    return toJson(await operation())
  } catch (error) {
    return toJson({ error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Air-Gap hooks.
 * @param ctx - Host context.
 * @param life - Life OS service.
 */
export function installLifeHooks(ctx: Context, life: LifeOs): void {
  ctx.on('agent/request', async (_payload, next) => {
    const proposed = await next()
    const decision = life.airGapModel({ provider: proposed.provider, model: proposed.model })
    if ('error' in decision) throw new Error(decision.error)
    if (decision.provider === proposed.provider && decision.model === proposed.model) return proposed
    const { reasoningEffort: _dropped, ...rest } = proposed
    return { ...rest, provider: decision.provider, model: decision.model }
  }, { prepend: true })

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    if (life.settings().airGap) {
      const networked = exec.name.startsWith(USER_TOOL_PREFIX)
        && life.userTools.known().some(tool => `${USER_TOOL_PREFIX}${tool.name}` === exec.name && tool.reachesNetwork)
      const reason = airGapBlock(exec.name, exec.arguments) ?? (networked ? 'this self-written tool uses the network' : undefined)
      if (reason !== undefined) return { kind: 'deny', reason: `Air-Gap mode: ${reason}. The user can turn Air-Gap off in the Command Center.` }
    }
    return next()
  }, { prepend: true })
}

/**
 * Coordinator tools for the brain, the knowledge graph, and self-written tools.
 * @param life - Life OS service.
 * @param agent - the coordinator Agent (its working directory runs self-written tools).
 * @returns tool definitions.
 */
export function lifeTools(life: LifeOs, agent: Agent): unknown[] {
  const cwd = (): string => agent.session.header.cwd ?? homedir()
  const own = life.userTools.known().map(manifest => defineTool({
    name: `${USER_TOOL_PREFIX}${manifest.name}`,
    description: `Self-written tool: ${manifest.description} (${manifest.language} script in ~/.kairoforge/tools/${manifest.name})`,
    parameters: Object.fromEntries(manifest.parameters.map(parameter => [parameter.name, {
      type: 'string', description: parameter.description, ...parameter.required ? { required: true } : {},
    }])),
    output: JSON_OUTPUT,
    execute(args: Record<string, unknown>) {
      return guarded(() => life.userTools.run(manifest.name, args, cwd()))
    },
  } as never))
  return [
    defineTool({
      name: 'search_brain',
      description: 'Search the user\'s local brain: every indexed note, document, PDF, and code file on this Mac (folders the user chose). Use it before answering questions about the user\'s own files, projects, notes, or past work. Returns file paths and matching passages.',
      parameters: {
        query: { type: 'string', required: true, description: 'Question or keywords.' },
        limit: { type: 'number', description: 'Maximum results (default 6).' },
      },
      output: JSON_OUTPUT,
      execute(args) {
        return guarded(async () => {
          const status = life.brain.status()
          if (status.documents === 0) return { results: [], note: 'The brain has no indexed files yet. The user can add folders in Command Center → Life OS, or ask you to index_folder.' }
          const hits = await life.brain.search(args.query, Math.min(20, Math.max(1, args.limit ?? 6)))
          return { results: hits.map(hit => ({ path: hit.doc, score: Number(hit.score.toFixed(3)), passage: hit.snippet })) }
        })
      },
    }),
    defineTool({
      name: 'index_folder',
      description: 'Add a folder to the user\'s local brain so its notes, documents, PDFs, and code become searchable with search_brain (credentials and secret-looking files are skipped; the index is encrypted). Use when the user asks you to learn or index a folder.',
      parameters: { path: { type: 'string', required: true, description: 'Absolute folder path (~ allowed).' } },
      output: JSON_OUTPUT,
      execute(args) {
        return guarded(async () => {
          const settings = await life.update({ roots: [...new Set([...life.settings().roots, args.path])] })
          return { indexing: settings.roots, note: 'Indexing runs in the background; search_brain sees files as they are indexed.' }
        })
      },
    }),
    defineTool({
      name: 'link_entities',
      description: 'Record a lasting relationship in the user\'s knowledge graph, e.g. "Michael" is "boss", "KairoForge" is "main project", "login bug" affects "auth module". Use when the user tells you how people, projects, bugs, or things relate. Never store secrets.',
      parameters: {
        from: { type: 'string', required: true },
        relation: { type: 'string', required: true, description: 'Short relation: "is", "works on", "affects", "owns", "reports to"…' },
        to: { type: 'string', required: true },
        from_kind: { type: 'string', description: 'person, project, bug, module, place, org…' },
        to_kind: { type: 'string' },
        note: { type: 'string', description: 'Optional detail, e.g. a date.' },
      },
      output: JSON_OUTPUT,
      execute(args) {
        return guarded(async () => ({
          linked: await life.brain.link(args.from, args.relation, args.to, {
            ...args.from_kind === undefined ? {} : { fromKind: args.from_kind },
            ...args.to_kind === undefined ? {} : { toKind: args.to_kind },
            ...args.note === undefined ? {} : { note: args.note },
          }),
        }))
      },
    }),
    defineTool({
      name: 'unlink_entities',
      description: 'Remove a relationship from the knowledge graph (all relations between the two when relation is omitted).',
      parameters: { from: { type: 'string', required: true }, to: { type: 'string', required: true }, relation: { type: 'string' } },
      output: JSON_OUTPUT,
      execute(args) {
        return guarded(async () => ({ removed: await life.brain.unlink(args.from, args.to, args.relation) }))
      },
    }),
    defineTool({
      name: 'graph_query',
      description: 'Everything the knowledge graph knows about a person, project, bug, or thing (two hops of relationships).',
      parameters: { name: { type: 'string', required: true } },
      output: JSON_OUTPUT,
      execute(args) {
        return guarded(async () => ({ facts: await life.brain.about(args.name) }))
      },
    }),
    defineTool({
      name: 'create_tool',
      description: 'Write yourself a reusable tool when you notice you keep needing the same job done (e.g. resizing images). Saves a script to ~/.kairoforge/tools/<name>/ and adds it to your toolbelt as user_tool__<name> from your next step. The script receives its arguments as JSON on stdin and in the KF_ARGS environment variable and should print its result. The user approves the code first. Never embed secrets.',
      parameters: {
        name: { type: 'string', required: true, description: 'lowercase_with_underscores, 2-40 chars.' },
        description: { type: 'string', required: true },
        language: { type: 'string', required: true, enum: [...USER_TOOL_LANGUAGES] },
        script: { type: 'string', required: true, description: 'Complete source.' },
        parameters: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              description: { type: 'string', required: true },
              required: { type: 'boolean', required: true },
            },
          },
        },
      },
      output: JSON_OUTPUT,
      execute(args) {
        return guarded(async () => {
          const parameters = (args.parameters ?? []).filter(parameter => parameter.name !== '')
          const manifest = await life.userTools.create({
            name: args.name, description: args.description, language: args.language, script: args.script, parameters,
          })
          life.toolsChanged()
          return { created: `${USER_TOOL_PREFIX}${manifest.name}`, reachesNetwork: manifest.reachesNetwork, next: 'Available from your next step.' }
        })
      },
    }),
    defineTool({
      name: 'list_user_tools',
      description: 'List the tools you wrote for yourself.',
      parameters: {},
      output: JSON_OUTPUT,
      execute() {
        return guarded(async () => ({ tools: (await life.userTools.list()).map(tool => ({ name: `${USER_TOOL_PREFIX}${tool.name}`, description: tool.description, language: tool.language })) }))
      },
    }),
    ...own,
  ]
}

const linkBody = z.object({
  from: z.string().min(1).max(80), relation: z.string().min(1).max(40), to: z.string().min(1).max(80), note: z.string().max(300).optional(),
}).strict()
const unlinkBody = z.object({
  from: z.string().min(1).max(80), to: z.string().min(1).max(80), relation: z.string().max(40).optional(),
}).strict()
const noteBody = z.object({ text: z.string().min(1).max(4000) }).strict()
const notificationBody = z.object({
  app: z.string().min(1).max(80),
  title: z.string().max(300).optional(),
  subtitle: z.string().max(300).optional(),
  body: z.string().max(2000).optional(),
}).strict()
const routineBody = z.object({ id: z.string().min(1).max(300), approved: z.boolean() }).strict()

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new PersonalAiError('invalid', z.prettifyError(result.error))
  return result.data
}

function strip<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T
}

/** A Life OS route outcome; `html` replaces the JSON payload. */
export interface LifeRouteOutcome {
  readonly status: number
  readonly payload: unknown
  readonly html?: string
}

/**
 * One `/personal-ai/life/*` request.
 * @param life - Life OS service.
 * @param method - GET or POST.
 * @param parts - path segments after `life`.
 * @param query - URL query.
 * @param body - JSON body for POST.
 * @returns outcome.
 */
export async function handleLifeRoute(
  life: LifeOs, method: string, parts: readonly string[], query: URLSearchParams, body: unknown,
): Promise<LifeRouteOutcome> {
  await life.whenReady()
  const [action, id, sub] = parts
  const ok = (payload: unknown): LifeRouteOutcome => ({ status: 200, payload })
  if (method === 'GET') {
    if (action === undefined) return ok(await life.status())
    if (action === 'phone') return { status: 200, payload: null, html: PHONE_PAGE }
    if (action === 'search') {
      const q = query.get('q') ?? ''
      return ok({ results: q.trim() === '' ? [] : await life.brain.search(q, 10) })
    }
    if (action === 'graph') return ok({ facts: query.get('name') === null ? life.brain.facts() : await life.brain.about(query.get('name') ?? '') })
    return { status: 404, payload: { code: 'not-found', message: `unknown route life/${parts.join('/')}` } }
  }
  switch (action) {
    case 'settings': return ok(await life.update(strip(parse(lifeSettingsPatch, body))))
    case 'link': {
      const input = parse(linkBody, body)
      const note = input.note === undefined ? {} : { note: input.note }
      return ok({ linked: await life.brain.link(input.from, input.relation, input.to, note) })
    }
    case 'unlink': {
      const input = parse(unlinkBody, body)
      return ok({ removed: await life.brain.unlink(input.from, input.to, input.relation) })
    }
    case 'reindex':
      void life.brain.reindex()
      return ok({ reindexing: true })
    case 'voice-note': return ok(await life.voiceNote(parse(noteBody, body).text))
    case 'notification': {
      const input = parse(notificationBody, body)
      return ok(await life.senses.ingest({
        at: Date.now() / 1000,
        app: input.app,
        ...input.title === undefined ? {} : { title: input.title },
        ...input.subtitle === undefined ? {} : { subtitle: input.subtitle },
        ...input.body === undefined ? {} : { body: input.body },
      }))
    }
    case 'routine': {
      const input = parse(routineBody, body)
      const approved = new Set(life.settings().approvedRoutines)
      if (input.approved) approved.add(input.id)
      else approved.delete(input.id)
      return ok(await life.update({ approvedRoutines: [...approved] }))
    }
    case 'tool':
      if (id !== undefined && sub === 'delete') {
        const removed = await life.userTools.remove(id)
        if (removed) life.toolsChanged()
        return ok({ removed })
      }
      break
    default:
  }
  return { status: 404, payload: { code: 'not-found', message: `unknown route life/${parts.join('/')}` } }
}
