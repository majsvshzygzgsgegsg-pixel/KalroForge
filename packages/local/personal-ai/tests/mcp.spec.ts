/** MCP Hub: saved servers, Cursor import, and servers KairoForge writes for itself. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Script } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  clientConfig, createdServerProblems, createdServerSource, maskedEntry, parseMcpJson, serverName, type CreatedServer,
} from '../src/core/mcp-servers.ts'
import { classifyRisk } from '../src/core/risk.ts'
import { McpHub } from '../src/mcp/hub.ts'

const CALC: CreatedServer = {
  name: 'calc',
  description: 'adds numbers',
  tools: [
    {
      name: 'add', description: 'Add a and b.', code: 'return String(args.a + args.b)',
      parameters: [{ name: 'a', description: 'first', type: 'number', required: true }, { name: 'b', description: 'second', type: 'number', required: true }],
    },
    { name: 'secret', description: 'Read SECRET.', code: 'return process.env.SECRET ?? "unset"', parameters: [] },
    { name: 'boom', description: 'Fails.', code: 'throw new Error("nope")', parameters: [] },
    { name: 'host', description: 'Uses require.', code: 'return require("node:os").platform()', parameters: [] },
    { name: 'arrow', description: 'Whole function.', code: 'async (args, lib) => { return "hi " + (args.who ?? "you") }', parameters: [] },
  ],
}

describe('MCP server entries', () => {
  it('normalizes names and reads Cursor-style mcp.json', () => {
    expect(serverName(' My Server! ')).toBe('my_server')
    const entries = parseMcpJson({
      mcpServers: {
        'native-app-control': { command: 'node', args: ['/x/index.js'], env: { TOKEN: 'abc' } },
        web: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer z' } },
        off: { command: 'x', disabled: true },
        broken: { args: [] },
      },
    }, 'cursor')
    expect(entries.map(entry => [entry.name, entry.transport, entry.enabled])).toEqual([
      ['native-app-control', 'stdio', true], ['web', 'streamable-http', true], ['off', 'stdio', false],
    ])
    expect(JSON.stringify(entries.map(maskedEntry))).not.toMatch(/abc|Bearer/)
    expect(clientConfig(entries[0]!)).toMatchObject({ transport: 'stdio', serverName: 'native-app-control', command: 'node', failOnStartupError: true })
  })

  it('rejects bad names, duplicates, and tool bodies that do not compile', () => {
    const compile = (code: string): void => { new Script(`(async function (args, lib) {\n${code}\n})`) }
    expect(createdServerProblems(CALC, compile)).toEqual([])
    const bad: CreatedServer = { name: 'Bad Name', description: '', tools: [CALC.tools[0]!, CALC.tools[0]!, { ...CALC.tools[1]!, code: 'return (' }] }
    expect(createdServerProblems(bad, compile).join('\n')).toMatch(/server name[\s\S]*listed twice[\s\S]*does not compile/)
  })

  it('treats adding or writing a server as sensitive and listing as read-only', () => {
    expect(classifyRisk('mcp_servers', { action: 'list' }).risk).toBe('LOW_RISK')
    expect(classifyRisk('mcp_servers', { action: 'create' }).risk).toBe('SENSITIVE')
    expect(classifyRisk('mcp_servers', { action: 'add' }).risk).toBe('SENSITIVE')
    expect(classifyRisk('mcp_servers', { action: 'disable' }).risk).toBe('MODIFYING')
  })
})

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kf-mcp-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('written MCP server', () => {
  it('speaks MCP over stdio', async () => {
    const file = join(home, 'server.mjs')
    await writeFile(file, createdServerSource(CALC))
    const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'inherit'] })
    const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const ask = async (id: number, method: string, params: unknown): Promise<Record<string, unknown>> => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return JSON.parse(String((await replies.next()).value)) as Record<string, unknown>
    }
    try {
      expect(await ask(1, 'initialize', { protocolVersion: '2025-06-18' })).toMatchObject({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } })
      const listed = await ask(2, 'tools/list', {}) as { result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> } }
      expect(listed.result.tools.map(tool => tool.name)).toEqual(['add', 'secret', 'boom', 'host', 'arrow'])
      expect(listed.result.tools[0]?.inputSchema.required).toEqual(['a', 'b'])
      expect(await ask(3, 'tools/call', { name: 'add', arguments: { a: 2, b: 3 } })).toMatchObject({ result: { content: [{ type: 'text', text: '5' }] } })
      expect(await ask(4, 'tools/call', { name: 'boom', arguments: {} })).toMatchObject({ result: { isError: true, content: [{ text: 'nope' }] } })
      expect(await ask(6, 'tools/call', { name: 'host', arguments: {} })).toMatchObject({ result: { content: [{ text: process.platform }] } })
      expect(await ask(5, 'tools/call', { name: 'arrow', arguments: { who: 'frank' } })).toMatchObject({ result: { content: [{ text: 'hi frank' }] } })
    } finally {
      child.kill()
    }
  })
})

describe('MCP Hub', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await ctx.tools.execute({ name, callId: ToolCallId('mcp-test'), arguments: args, signal: new AbortController().signal })
    return { isError: result.isError, text: result.content.map(block => block.type === 'text' ? block.text : '').join('') }
  }

  it('writes a server, connects it, runs its tools, and removes it', async () => {
    const hub = new McpHub(ctx, home, join(home, 'cursor-mcp.json'))
    const server = await hub.create(CALC)
    expect(server).toMatchObject({ name: 'calc', state: 'connected', tools: ['mcp__calc__add', 'mcp__calc__secret', 'mcp__calc__boom', 'mcp__calc__host', 'mcp__calc__arrow'] })
    expect(await call('mcp__calc__add', { a: 40, b: 2 })).toEqual({ isError: false, text: '42' })
    expect((await call('mcp__calc__boom')).isError).toBe(true)

    const disabled = await hub.set('calc', false)
    expect(disabled.state).toBe('off')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('mcp__calc__add')

    const again = new McpHub(ctx, home, join(home, 'cursor-mcp.json'))
    expect((await again.list()).map(item => [item.name, item.state])).toEqual([['calc', 'off']])
    expect(await again.remove('calc')).toBe(true)
    expect(existsSync(join(home, 'mcp', 'calc'))).toBe(false)
    await hub.dispose()
  })

  it('imports Cursor servers by name and reads their secrets from Cursor at connect time', async () => {
    const script = join(home, 'calc.mjs')
    await writeFile(script, createdServerSource(CALC))
    const cursorFile = join(home, 'cursor-mcp.json')
    await writeFile(cursorFile, JSON.stringify({ mcpServers: { 'My Calc': { command: process.execPath, args: [script], env: { SECRET: 's3cr3t' } } } }))
    const hub = new McpHub(ctx, home, cursorFile)
    const [imported] = await hub.importCursor()
    expect(imported).toMatchObject({ name: 'my_calc', source: 'cursor', state: 'connected' })
    expect(await call('mcp__my_calc__secret')).toEqual({ isError: false, text: 's3cr3t' })
    expect(await readFile(join(home, 'mcp.json'), 'utf8')).not.toContain('s3cr3t')
    expect(JSON.stringify(await hub.list())).not.toContain('s3cr3t')
    expect(await hub.importCursor()).toEqual([])
    await hub.dispose()
  })

  it('reports a server that cannot start instead of claiming it connected', async () => {
    const hub = new McpHub(ctx, home, join(home, 'none.json'))
    const server = await hub.add({ name: 'ghost', transport: 'stdio', command: join(home, 'missing-binary'), enabled: true, source: 'added' })
    expect(server.state).toBe('failed')
    expect(server.error).toBeTruthy()
    await expect(hub.add({ name: 'Bad', transport: 'stdio', command: 'x', enabled: true, source: 'added' })).rejects.toThrow(/server name/)
    await hub.dispose()
  })

  it('shuts down quietly after the host already stopped its servers', async () => {
    const hub = new McpHub(ctx, home, join(home, 'cursor-mcp.json'))
    expect((await hub.create(CALC)).state).toBe('connected')
    await ctx.fiber.dispose()
    await expect(hub.dispose()).resolves.toBeUndefined()
    await hub.remove('calc')
  })
})
