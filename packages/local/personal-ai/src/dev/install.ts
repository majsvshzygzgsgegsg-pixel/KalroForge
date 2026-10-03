/**
 * DevKit wiring.
 * - Agent-loop hooks for every agent (coordinator, main agents, sub-agents):
 *   a hard loop stop, "did you mean" hints for missing paths, a syntax check
 *   after edits, and a clearer message for malformed tool arguments. They only
 *   refuse or add information; they never grant anything.
 * - Tools: editor_context, repo_map, open_in_editor.
 * - The editor bridge route (`/kairoforge-editor/*`) for the VS Code / Cursor
 *   extension, and the Command Center routes (`/personal-ai/dev/*`).
 */
import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type PostToolDecision, type PreToolDecision, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { editorContextText, type EditorSnapshot } from '../core/editor.ts'
import { malformedArgsHint, missingPathOf } from '../core/reliability.ts'
import { PersonalAiError } from '../types.ts'
import { EDITORS, type DevKit, type EditorKind } from './service.ts'
import { checkSyntax, syntaxWarning } from './syntax.ts'

/** Editor bridge route prefix (used by the extension). */
export const EDITOR_BRIDGE_PATH = '/kairoforge-editor'

const EDIT_TOOLS = new Set(['edit', 'write', 'str_replace_editor', 'apply_patch'])
const MAX_BRIDGE_BODY = 160 * 1024
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
} as const

const diagnostic = z.object({
  file: z.string().min(1).max(4096),
  line: z.number().int().min(0),
  severity: z.enum(['error', 'warning', 'info', 'hint']),
  message: z.string().max(4000),
  source: z.string().max(200).optional(),
})
const snapshotSchema = z.object({
  editor: z.string().min(1).max(100),
  workspaceFolders: z.array(z.string().min(1).max(4096)).max(20),
  activeFile: z.string().min(1).max(4096).optional(),
  language: z.string().max(100).optional(),
  cursor: z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }).optional(),
  selection: z.object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1), text: z.string().max(40_000) }).optional(),
  excerpt: z.object({ startLine: z.number().int().min(1), text: z.string().max(40_000) }).optional(),
  dirty: z.boolean().optional(),
  openFiles: z.array(z.string().min(1).max(4096)).max(100),
  diagnostics: z.array(diagnostic).max(300),
  at: z.string().min(1).max(64),
})
const askSchema = z.object({ prompt: z.string().min(1).max(8000), workspace: z.string().min(1).max(4096).optional() }).strict()

function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

function pathArg(args: unknown, ...names: string[]): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  for (const name of names) {
    const value: unknown = Reflect.get(args, name)
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function editedPath(exec: ToolExecution, result: ToolExecutionResult): string | undefined {
  if (result.isError) return undefined
  if (exec.name === 'str_replace_editor' && pathArg(exec.arguments, 'command') === 'view') return undefined
  const value = result.value as unknown
  const fromValue: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'path') : undefined
  const path = typeof fromValue === 'string' ? fromValue : pathArg(exec.arguments, 'file_path', 'path')
  if (path === undefined) return undefined
  const cwd = exec.agent?.session.header.cwd
  return isAbsolute(path) ? path : cwd === undefined ? undefined : resolve(cwd, path)
}

async function enrich(dev: DevKit, exec: ToolExecution, result: ToolExecutionResult): Promise<string[]> {
  const notes: string[] = []
  const cwd = exec.agent?.session.header.cwd
  if (result.isError) {
    const missing = missingPathOf(result.error.message)
    if (missing !== undefined) {
      const found = await dev.suggest(missing, cwd).catch(() => undefined)
      if (found !== undefined) {
        dev.counters.pathHints++
        notes.push(`That path does not exist. Did you mean (relative to ${found.root}): ${found.paths.join(', ')}? Use a real path from this list or search with glob before retrying.`)
      }
    }
    if (result.error.info?.code === 'INVALID_ARGS') {
      const hint = malformedArgsHint(exec.arguments)
      if (hint !== undefined) {
        dev.counters.jsonHints++
        notes.push(hint)
      }
    }
    return notes
  }
  if (!EDIT_TOOLS.has(exec.name)) return notes
  const path = editedPath(exec, result)
  if (path === undefined) return notes
  const checked = await checkSyntax(path).catch(() => undefined)
  if (checked === undefined) return notes
  dev.counters.syntaxChecks++
  if (!checked.ok) {
    dev.counters.syntaxFailures++
    notes.push(syntaxWarning(path, checked))
  }
  return notes
}

/**
 * Agent-loop hooks.
 * @param ctx - Host context.
 * @param dev - DevKit service.
 */
export function installDevHooks(ctx: Context, dev: DevKit): void {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const key = exec.agent?.session.id
    const reason = key === undefined ? undefined : dev.loops.check(key, exec.name, exec.arguments)
    if (reason !== undefined) {
      dev.counters.loopStops++
      return { kind: 'deny', reason }
    }
    return next()
  }, { prepend: true })

  ctx.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
    const decision = await next()
    const key = exec.agent?.session.id
    if (key !== undefined) dev.loops.record(key, exec.name, exec.arguments, result.isError ? result.error.message : undefined)
    if (decision.kind !== 'accept' || decision.value !== undefined || exec.signal.aborted) return decision
    const notes = await enrich(dev, exec, result).catch(() => [])
    if (notes.length === 0) return decision
    return { ...decision, content: [...decision.content ?? result.content, ...notes.map(text)] }
  })

  ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    dev.noteProvider(config.provider)
    return config
  })
}

function openInEditor(dev: DevKit, path: string, line: number | undefined): Promise<string> {
  const editor = dev.editor()?.editor ?? ''
  const order: EditorKind[] = /visual studio code|vs ?code/i.test(editor) ? ['vscode', 'cursor'] : ['cursor', 'vscode']
  const cli = order.map(kind => dev.editorCli(kind)).find(found => found !== undefined)
  if (cli === undefined) return Promise.resolve('No editor CLI found (install Cursor or VS Code in /Applications).')
  const target = line === undefined ? path : `${path}:${String(line)}`
  return new Promise((done) => {
    execFile(cli, ['-g', target], { timeout: 20_000 }, (error) => {
      done(error === null ? `Opened ${target} in the editor.` : `Could not open ${target}: ${error.message}`)
    })
  })
}

/**
 * DevKit tools for the coordinator and main agents.
 * @param dev - DevKit service.
 * @param agent - the agent the tools are registered for.
 * @returns tool definitions.
 */
export function devTools(dev: DevKit, agent: Agent): unknown[] {
  const cwd = (): string | undefined => agent.session.header.cwd
  return [
    defineTool({
      name: 'editor_context',
      description: 'What the user has open in VS Code / Cursor right now: active file, cursor, selection, nearby code, open tabs, and the editor\'s errors and warnings.',
      parameters: {},
      output: TEXT_OUTPUT,
      execute: () => {
        const snapshot = dev.editor()
        return Promise.resolve(snapshot === undefined
          ? 'No editor is connected. The user can install the KairoForge extension from Command Center > Dev, then reopen the editor.'
          : editorContextText(snapshot, Date.now()))
      },
    }),
    defineTool({
      name: 'repo_map',
      description: 'Find the files and top-level symbols in the current workspace most related to a query. Use it before guessing file paths.',
      parameters: { query: { type: 'string', required: true, description: 'Words, identifiers, or a feature description.' } },
      output: TEXT_OUTPUT,
      execute: args => dev.repoMap(args.query, cwd()),
    }),
    defineTool({
      name: 'open_in_editor',
      description: 'Open a file (optionally at a line) in the user\'s editor so they can see what you changed or found.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute path, or relative to the workspace.' },
        line: { type: 'number', description: '1-based line to jump to.' },
      },
      output: TEXT_OUTPUT,
      execute: (args) => {
        const root = dev.workspaceRoot(cwd())
        const path = isAbsolute(args.path) || root === undefined ? args.path : resolve(root, args.path)
        return openInEditor(dev, path, args.line === undefined ? undefined : Math.max(1, Math.round(args.line)))
      },
    }),
  ]
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BRIDGE_BODY) throw new PersonalAiError('invalid', 'request body is too large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new PersonalAiError('invalid', 'body is not JSON')
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new PersonalAiError('invalid', z.prettifyError(result.error))
  return result.data
}

const STATUS: Record<PersonalAiError['code'], number> = { 'not-found': 404, 'invalid': 400, 'sensitive': 422, 'conflict': 409 }

async function bridgeRoute(dev: DevKit, req: IncomingMessage): Promise<DevRouteOutcome> {
  const url = new URL(String(req.url), 'http://localhost')
  const [action, id] = url.pathname.slice(EDITOR_BRIDGE_PATH.length).split('/').filter(part => part !== '').map(decodeURIComponent)
  if (req.method === 'GET' && action === 'ping') return { status: 200, payload: { ok: true } }
  if (req.method === 'GET' && action === 'turn' && id !== undefined) return { status: 200, payload: dev.turn(id) }
  if (req.method === 'POST' && action === 'context') {
    dev.noteEditor(parse(snapshotSchema, await readJson(req)) as EditorSnapshot)
    return { status: 200, payload: { ok: true } }
  }
  if (req.method === 'POST' && action === 'ask') {
    const body = parse(askSchema, await readJson(req))
    return { status: 200, payload: await dev.ask(body.prompt, body.workspace) }
  }
  return { status: 404, payload: { code: 'not-found', message: 'unknown editor route' } }
}

/**
 * The editor bridge: only the local extension holding the bridge token gets
 * in. Browsers cannot reach it (any Origin header is refused, the Host must
 * be loopback), and LAN clients cannot either.
 * @param ctx - Host context with `webServer`.
 * @param dev - DevKit service.
 */
export function installEditorBridge(ctx: Context, dev: DevKit): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: EDITOR_BRIDGE_PATH,
    handler: async (req, res) => {
      if (req.headers.origin !== undefined || !LOOPBACK_HOST.test(req.headers.host ?? '') || !dev.authorized(req.headers.authorization)) {
        res.statusCode = 401
        res.end()
        return
      }
      try {
        const outcome = await bridgeRoute(dev, req)
        send(res, outcome.status, outcome.payload)
      } catch (error) {
        if (error instanceof PersonalAiError) {
          send(res, STATUS[error.code], { code: error.code, message: error.message })
          return
        }
        ctx.logger.error(`personal-ai: editor bridge ${req.method ?? 'GET'} failed: ${String(error)}`)
        send(res, 500, { code: 'internal', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `personal-ai: ${EDITOR_BRIDGE_PATH}/*`)
}

/** Outcome of a `/personal-ai/dev/*` route. */
export interface DevRouteOutcome {
  readonly status: number
  readonly payload: unknown
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

/**
 * Command Center routes under `/personal-ai/dev`.
 * @param dev - DevKit service.
 * @param method - HTTP method.
 * @param parts - path after `dev`.
 * @returns route outcome.
 */
export async function handleDevRoute(dev: DevKit, method: string, parts: readonly string[]): Promise<DevRouteOutcome> {
  const [action, id] = parts
  if (method === 'GET' && action === undefined) return { status: 200, payload: toJson(await dev.status()) }
  if (method === 'POST' && action === 'warm') return { status: 200, payload: await dev.warm() }
  if (method === 'POST' && action === 'install') {
    const editor = EDITORS.find(kind => kind === id)
    if (editor === undefined) throw new PersonalAiError('invalid', `editor must be one of ${EDITORS.join(', ')}`)
    return { status: 200, payload: await dev.installExtension(editor) }
  }
  return { status: 404, payload: { code: 'not-found', message: `unknown route dev/${parts.join('/')}` } }
}
