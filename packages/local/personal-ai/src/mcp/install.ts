/**
 * MCP Hub wiring: starts the saved servers and registers `mcp_servers`, the
 * tool KairoForge uses to give itself new abilities.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { serverName, type CreatedTool, type McpServerEntry } from '../core/mcp-servers.ts'
import { McpHub } from './hub.ts'

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

const ACTIONS = ['list', 'add', 'create', 'import_cursor', 'enable', 'disable', 'reconnect', 'remove'] as const
const PARAMETER_TYPES = ['string', 'number', 'boolean', 'array', 'object'] as const

const DESCRIPTION = [
  'Give yourself new abilities with MCP servers. Their tools appear as mcp__<server>__<tool> from your next step and stay after restarts.',
  'list: saved servers, their state, and tools. add: connect an existing server — a command (for example command "npx", args',
  '["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"]) or an http(s) url. import_cursor: connect the servers set up in Cursor.',
  'create: when nothing you have can do a job, write your own server — each tool\'s code is the body of async (args, lib) => { ... }',
  'returning a string or JSON; lib.run(command, args) runs a program, lib.osascript(script) runs AppleScript, and fetch and require work.',
  'enable / disable / reconnect / remove manage a saved server. Pass secrets only in env or headers ("KEY=value"); they are never shown back.',
].join(' ')

function pairs(values: readonly string[] | undefined, separator: RegExp): Record<string, string> | undefined {
  if (values === undefined || values.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const value of values) {
    const match = separator.exec(value)
    if (match === null) throw new Error(`"${value.split(separator)[0] ?? ''}" needs the form KEY=value`)
    out[value.slice(0, match.index).trim()] = value.slice(match.index + match[0].length)
  }
  return out
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

/**
 * Start the MCP Hub and register its tool on the host.
 * @param ctx - Host context with the tool registry.
 * @returns the hub.
 */
export function installMcpHub(ctx: Context): McpHub {
  const hub = new McpHub(ctx)
  ctx.effect(() => () => { void hub.dispose() }, 'personal-ai.mcp-hub')
  hub.start().catch((error: unknown) => { ctx.logger('personal-ai').warn('MCP servers did not start: %s', error) })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mcp_servers',
    description: DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, enum: [...ACTIONS] },
      name: { type: 'string', description: 'Server name (lowercase letters, digits, _ or -). Required except for list and import_cursor.' },
      command: { type: 'string', description: 'add: program that starts a stdio server.' },
      args: { type: 'array', items: { type: 'string' }, description: 'add: arguments for command.' },
      env: { type: 'array', items: { type: 'string' }, description: 'add: environment as "KEY=value" strings.' },
      url: { type: 'string', description: 'add: http(s) URL of a Streamable HTTP server.' },
      headers: { type: 'array', items: { type: 'string' }, description: 'add: HTTP headers as "Name: value" strings.' },
      description: { type: 'string', description: 'create: what the server is for.' },
      tools: {
        type: 'array',
        description: 'create: the tools to write.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            description: { type: 'string', required: true },
            code: { type: 'string', required: true, description: 'Body of async (args, lib) => { ... } that returns the result.' },
            parameters: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                  type: { type: 'string', required: true, enum: [...PARAMETER_TYPES] },
                  required: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
      },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      try {
        const name = serverName(args.name ?? '')
        const named = (): string => {
          if (name === '') throw new Error(`${args.action} needs a server name`)
          return name
        }
        switch (args.action) {
          case 'list': return toJson({ servers: await hub.list() })
          case 'import_cursor': return toJson({ imported: await hub.importCursor(), next: 'Their tools are available from your next step.' })
          case 'add': {
            const env = pairs(args.env, /=/)
            const headers = pairs(args.headers, /:\s*/)
            const http: McpServerEntry = {
              name: named(), transport: 'streamable-http', url: args.url ?? '', ...headers === undefined ? {} : { headers }, enabled: true, source: 'added',
            }
            const stdio: McpServerEntry = {
              name: named(), transport: 'stdio', command: args.command ?? '', ...args.args === undefined ? {} : { args: args.args },
              ...env === undefined ? {} : { env }, enabled: true, source: 'added',
            }
            const entry = args.url !== undefined && args.url !== '' ? http : stdio
            return toJson({ server: await hub.add(entry), next: 'If it connected, its tools are available from your next step.' })
          }
          case 'create': {
            const tools: CreatedTool[] = (args.tools ?? []).map(tool => ({
              name: tool.name, description: tool.description, code: tool.code, parameters: tool.parameters ?? [],
            }))
            const server = await hub.create({ name: named(), description: args.description ?? '', tools })
            return toJson({ server, next: 'If it connected, call its tools now and compare the first result with the raw source before you rely on it.' })
          }
          case 'enable': return toJson({ server: await hub.set(named(), true) })
          case 'disable': return toJson({ server: await hub.set(named(), false) })
          case 'reconnect': return toJson({ server: await hub.set(named()) })
          case 'remove': return toJson({ removed: await hub.remove(named()) })
        }
      } catch (error) {
        return toJson({ error: error instanceof Error ? error.message : String(error) })
      }
    },
  })), 'personal-ai.mcp-servers-tool')
  return hub
}
