/**
 * MCP servers KairoForge connects to on its own: entries saved in
 * `~/.kairoforge/mcp.json`, Cursor's `mcp.json` import, masked views for the
 * model, and the source of dependency-free stdio servers KairoForge writes
 * for itself. Pure: no filesystem or process access.
 */

/** Server names become the `mcp__<name>__` tool prefix. */
export const MCP_SERVER_NAME = /^[a-z0-9_-]{1,32}$/

/** One saved MCP server. */
export interface McpServerEntry {
  readonly name: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly enabled: boolean
  /** `cursor`: settings are read from Cursor's mcp.json at connect time, so its secrets are never copied. */
  readonly source: 'added' | 'cursor' | 'created'
  readonly description?: string
}

/** Stdio connection input for `@deepseek-ai/dsh-mcp-client`. */
export interface McpStdioConfig {
  transport: 'stdio'
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  toolCallTimeoutMs: number
  failOnStartupError: boolean
}

/** Streamable HTTP connection input for `@deepseek-ai/dsh-mcp-client`. */
export interface McpHttpConfig {
  transport: 'streamable-http'
  serverName: string
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs: number
  failOnStartupError: boolean
}

/** Connection input for `@deepseek-ai/dsh-mcp-client`. */
export type McpClientConfig = McpStdioConfig | McpHttpConfig

const TOOL_CALL_TIMEOUT_MS = 120_000

/**
 * A valid server name from free text.
 * @param raw - spoken or written name.
 * @returns lowercase name of at most 32 characters, or '' when nothing usable is left.
 */
export function serverName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined
}

function dict(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/**
 * One server's connection settings from a Cursor / Claude style `mcpServers` record.
 * @param name - saved server name.
 * @param raw - the record's value.
 * @param source - where the entry comes from.
 * @returns the entry, or undefined when it has neither a command nor a URL.
 */
export function entryFromSpec(name: string, raw: unknown, source: McpServerEntry['source']): McpServerEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const spec = raw as Record<string, unknown>
  const enabled = spec.disabled !== true
  if (typeof spec.url === 'string' && spec.url !== '') {
    const headers = dict(spec.headers)
    return { name, transport: 'streamable-http', url: spec.url, ...headers === undefined ? {} : { headers }, enabled, source }
  }
  if (typeof spec.command !== 'string' || spec.command === '') return undefined
  const args = strings(spec.args)
  const env = dict(spec.env)
  return {
    name, transport: 'stdio', command: spec.command,
    ...args === undefined ? {} : { args },
    ...env === undefined ? {} : { env },
    ...typeof spec.cwd === 'string' && spec.cwd !== '' ? { cwd: spec.cwd } : {},
    enabled, source,
  }
}

/**
 * Servers in a Cursor `mcp.json`.
 * @param json - parsed file.
 * @param source - where the entries come from.
 * @returns valid entries; names are normalized and invalid records skipped.
 */
export function parseMcpJson(json: unknown, source: McpServerEntry['source']): McpServerEntry[] {
  const servers = typeof json === 'object' && json !== null ? (json as { mcpServers?: unknown }).mcpServers : undefined
  if (typeof servers !== 'object' || servers === null) return []
  const out: McpServerEntry[] = []
  for (const [raw, spec] of Object.entries(servers)) {
    const name = serverName(raw)
    const entry = name === '' ? undefined : entryFromSpec(name, spec, source)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

/**
 * What the model may see: env and header values are replaced.
 * @param entry - saved entry.
 * @returns entry with secret-bearing values masked.
 */
export function maskedEntry(entry: McpServerEntry): Record<string, unknown> {
  const mask = (values: Readonly<Record<string, string>> | undefined) =>
    values === undefined ? undefined : Object.fromEntries(Object.keys(values).map(key => [key, '(set)']))
  const env = mask(entry.env)
  const headers = mask(entry.headers)
  return { ...entry, ...env === undefined ? {} : { env }, ...headers === undefined ? {} : { headers } }
}

/**
 * Connection settings for the MCP client plugin.
 * @param entry - saved entry with its settings resolved.
 * @returns plugin config; the first connection failing rejects the plugin so the error can be reported.
 */
export function clientConfig(entry: McpServerEntry): McpClientConfig {
  if (entry.transport === 'streamable-http') {
    return {
      transport: 'streamable-http', serverName: entry.name, url: entry.url ?? '', headers: { ...entry.headers },
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS, failOnStartupError: true,
    }
  }
  return {
    transport: 'stdio', serverName: entry.name, command: entry.command ?? '', args: [...entry.args ?? []], env: { ...entry.env },
    cwd: entry.cwd ?? '', toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS, failOnStartupError: true,
  }
}

// ---------------------------------------------------------------------------
// Servers KairoForge writes for itself

/** One input of a created tool. */
export interface CreatedToolParameter {
  readonly name: string
  readonly description: string
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  readonly required: boolean
}

/** One tool of a created server. */
export interface CreatedTool {
  readonly name: string
  readonly description: string
  readonly parameters: readonly CreatedToolParameter[]
  /** Body of `async (args, lib) => { ... }`; returns a string or JSON value. */
  readonly code: string
}

/** A server KairoForge writes. */
export interface CreatedServer {
  readonly name: string
  readonly description: string
  readonly tools: readonly CreatedTool[]
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,40}$/
const FUNCTION_EXPRESSION = /^\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/

/**
 * A tool's code as the body of `async function (args, lib)`. A whole function
 * (`async (args, lib) => { ... }`) is accepted too and called with the same arguments.
 * @param code - body or function expression.
 * @returns function body.
 */
export function toolBody(code: string): string {
  return FUNCTION_EXPRESSION.test(code) ? `return await (${code.trim()})(args, lib)` : code
}

/**
 * Problems that would stop a created server from working.
 * @param spec - requested server.
 * @param compile - throws on a syntax error in one tool body.
 * @returns readable problems; empty when the server can be written.
 */
export function createdServerProblems(spec: CreatedServer, compile: (code: string) => void): string[] {
  const problems: string[] = []
  if (!MCP_SERVER_NAME.test(spec.name)) problems.push(`server name "${spec.name}" must be 1-32 lowercase letters, digits, _ or -`)
  if (spec.tools.length === 0) problems.push('a server needs at least one tool')
  const seen = new Set<string>()
  for (const tool of spec.tools) {
    if (!TOOL_NAME.test(tool.name)) problems.push(`tool name "${tool.name}" must be 1-40 letters, digits, _ or -`)
    if (seen.has(tool.name)) problems.push(`tool "${tool.name}" is listed twice`)
    seen.add(tool.name)
    try {
      compile(toolBody(tool.code))
    } catch (error) {
      problems.push(`tool "${tool.name}" does not compile: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return problems
}

function inputSchema(parameters: readonly CreatedToolParameter[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(parameters.map(parameter => [
      parameter.name, { type: parameter.type, description: parameter.description },
    ])),
    required: parameters.filter(parameter => parameter.required).map(parameter => parameter.name),
  }
}

/**
 * Source of a dependency-free stdio MCP server (newline-delimited JSON-RPC).
 * Tool bodies are embedded as JSON strings and compiled at start, so no body can break the file around it.
 * `lib` gives each body `run(command, args)`, `osascript(script)`, and `fetch`; `require` loads Node modules.
 * @param spec - validated server.
 * @returns ES module source.
 */
export function createdServerSource(spec: CreatedServer): string {
  const tools = spec.tools.map(tool => ({
    name: tool.name, description: tool.description, inputSchema: inputSchema(tool.parameters), code: toolBody(tool.code),
  }))
  return `#!/usr/bin/env node
// ${spec.name}: ${spec.description.replace(/\n/g, ' ')}
// Written by KairoForge. Plain MCP over stdio; no dependencies.
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

globalThis.require = createRequire(import.meta.url)

const TOOLS = ${JSON.stringify(tools, null, 2)}
const AsyncFunction = (async () => {}).constructor
const run = (command, args = [], options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 110_000, ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).trim()))
    else resolve(String(stdout).trim())
  })
})
const lib = { run, osascript: script => run('/usr/bin/osascript', ['-e', script]), fetch }
const bodies = new Map(TOOLS.map(tool => [tool.name, new AsyncFunction('args', 'lib', tool.code)]))
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const text = value => typeof value === 'string' ? value : JSON.stringify(value ?? null)

async function handle(request) {
  const { id, method, params } = request
  if (id === undefined) return
  if (method === 'initialize') {
    return send({ id, result: {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: ${JSON.stringify(spec.name)}, version: '1.0.0' },
    } })
  }
  if (method === 'ping') return send({ id, result: {} })
  if (method === 'tools/list') return send({ id, result: { tools: TOOLS.map(({ code: _code, ...tool }) => tool) } })
  if (method === 'tools/call') {
    const body = bodies.get(params?.name)
    if (!body) return send({ id, error: { code: -32602, message: 'unknown tool ' + params?.name } })
    try {
      return send({ id, result: { content: [{ type: 'text', text: text(await body(params?.arguments ?? {}, lib)) }] } })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return send({ id, result: { isError: true, content: [{ type: 'text', text: reason }] } })
    }
  }
  send({ id, error: { code: -32601, message: 'method not found: ' + method } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let request
  try { request = JSON.parse(line) } catch { return }
  handle(request).catch(error => send({ id: request.id, error: { code: -32603, message: String(error) } }))
})
`
}
