/** Structured results reach the model, and the visible agent cursor is kept on before actions. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Provider from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/desktop.mjs', import.meta.url))
let ctx: Context
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cua-hands-'))
  ctx = new Context()
  await ctx.plugin(ComputerUse)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

async function execute(name: string, args: Record<string, unknown> = {}) {
  const result = await ctx.tools.execute({ name: `mcp__cua-driver-mcp__${name}`, callId: ToolCallId('hands'), arguments: args, signal: new AbortController().signal })
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

async function calls(): Promise<string[]> {
  return (await readFile(join(root, 'calls.ndjson'), 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { name: string }).name)
}

it('shows structured window ids to the model and turns the agent cursor on once before acting', async () => {
  await ctx.plugin(Provider, { command: process.execPath, args: [fixture, root], agentCursor: true, reconnect: { enabled: false } })
  const listed = await execute('list_windows', { pid: 9 })
  expect(listed).toContain('Found 1 window(s).')
  expect(listed).toContain('structured: {"windows":[{"window_id":2368,"title":"Untitled"}]}')
  await execute('click', { element_token: 's1:3' })
  await execute('click', { element_token: 's1:4' })
  expect(await calls()).toEqual(['list_windows', 'set_agent_cursor_enabled', 'click', 'click'])
})

it('leaves the cursor alone when agentCursor is off', async () => {
  await ctx.plugin(Provider, { command: process.execPath, args: [fixture, root], reconnect: { enabled: false } })
  await execute('click', { element_token: 's1:3' })
  expect(await calls()).toEqual(['click'])
})
