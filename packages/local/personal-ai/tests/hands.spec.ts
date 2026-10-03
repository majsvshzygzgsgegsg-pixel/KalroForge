/** Cursor as the hands: reading its stream, routing computer tools to it, risk, and running a (fake) Cursor agent CLI. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { actionOf, CURSOR_COMPUTER, readCursorStream } from '../src/core/cursor-hands.ts'
import { catastrophicReason, classifyRisk } from '../src/core/risk.ts'
import { cursorRouted, isScreenRequest } from '../src/core/voice-tools.ts'
import { CursorHands } from '../src/hands.ts'
import { fakeCursorAgent } from './fixtures/cursor-agent.ts'

describe('Cursor stream', () => {
  it('reads the reply, success, and actions, and skips schema lookups and junk', () => {
    const summary = readCursorStream([
      'not json',
      JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { getMcpToolsToolCall: { args: { server: 'native-app-control' } } } }),
      JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { mcpToolCall: { args: { providerIdentifier: 'cua-driver', toolName: 'click' } } } }),
      JSON.stringify({ type: 'tool_call', subtype: 'completed', tool_call: { mcpToolCall: { args: { providerIdentifier: 'cua-driver', toolName: 'click' } } } }),
      JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'osascript -e  \'beep\'' } } } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5142, result: 'The frontmost app is Cursor.' }),
    ])
    expect(summary).toEqual({ ok: true, reply: 'The frontmost app is Cursor.', actions: ['cua-driver/click', 'shell: osascript -e \'beep\''], durationMs: 5142 })
  })

  it('reports a run without a result as unfinished, keeping what Cursor last said', () => {
    expect(readCursorStream([JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } })]))
      .toEqual({ ok: false, reply: 'Working on it', actions: [] })
    expect(readCursorStream([JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'boom' })]).ok).toBe(false)
    expect(readCursorStream([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will check.' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Volume is 30.' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'I will check.Volume is 30.' }),
    ]).reply).toBe('Volume is 30.')
    expect(actionOf({ editToolCall: { args: {} } })).toBe('edit')
    expect(actionOf(null)).toBeUndefined()
  })
})

describe('computer control through Cursor', () => {
  const tools = ['read', 'bash', 'mac_action', 'applescript', 'applescript_dictionary', 'cua_driver_native__click', 'mcp__cua-driver-mcp__click', CURSOR_COMPUTER]
    .map(name => ({ name }))
  const names = (cursor: boolean): string[] => cursorRouted(tools, cursor).map(tool => tool.name)

  it('replaces every other computer tool with cursor_computer while Cursor is the hands', () => {
    expect(names(true)).toEqual(['read', 'bash', CURSOR_COMPUTER])
  })

  it('keeps KairoForge\'s own computer tools and hides cursor_computer otherwise', () => {
    expect(names(false)).toEqual(['read', 'bash', 'mac_action', 'applescript', 'applescript_dictionary', 'cua_driver_native__click', 'mcp__cua-driver-mcp__click'])
    expect(cursorRouted([{ name: 'mac_action' }], true).map(tool => tool.name)).toEqual(['mac_action'])
  })

  it('classifies Cursor requests like other computer control, with the hard floor intact', () => {
    expect(classifyRisk(CURSOR_COMPUTER, { task: 'open Notes and type hi' }).risk).toBe('MODIFYING')
    expect(classifyRisk(CURSOR_COMPUTER, { task: 'log in, my password is hunter2' }).risk).toBe('SENSITIVE')
    expect(catastrophicReason(CURSOR_COMPUTER, { task: 'run rm -rf ~ in Terminal' })).toMatch(/Refused/)
    expect(catastrophicReason(CURSOR_COMPUTER, { task: 'erase disk Macintosh HD in Disk Utility' })).toMatch(/Refused/)
    expect(catastrophicReason(CURSOR_COMPUTER, { task: 'open Finder' })).toBeUndefined()
  })

  it('recognises screen requests', () => {
    expect(isScreenRequest('click the blue button')).toBe(true)
    expect(isScreenRequest('what is 2+2')).toBe(false)
  })
})

describe('CursorHands', () => {
  let root: string
  let binary: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pai-cursor-'))
    binary = join(root, 'cursor-agent')
    await writeFile(binary, fakeCursorAgent(root))
    await chmod(binary, 0o755)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runs a request from its own workspace with narrow permissions and returns Cursor\'s reply', async () => {
    const hands = new CursorHands(binary, join(root, 'hands'), 'fast-model')
    expect(hands.ready()).toBe(false)
    expect(await hands.refresh()).toBe(true)
    expect(hands.ready()).toBe(true)
    const summary = await hands.run('open Notes and type hi')
    expect(summary).toEqual({ ok: true, reply: 'Opened Notes and typed hi.', actions: ['native-app-control/execute_applescript'], durationMs: 1200 })
    const [run] = (await readFile(join(root, 'runs.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; instructions: boolean })
    expect(run?.instructions).toBe(true)
    expect(run?.args).toEqual([
      '-p', '--output-format', 'stream-json', '--approve-mcps', '--trust', '--workspace', join(root, 'hands'), '--model', 'fast-model', 'open Notes and type hi',
    ])
    expect(run?.args).not.toContain('--force')
    const permissions = JSON.parse(await readFile(join(root, 'hands', '.cursor', 'cli.json'), 'utf8')) as { permissions: { allow: string[] } }
    expect(permissions.permissions.allow).toEqual(['Shell(osascript)', 'Shell(open)', 'Mcp(native-app-control:*)', 'Mcp(cua-driver:*)'])
  })

  it('falls back to Cursor\'s default model once when its model is refused', async () => {
    const hands = new CursorHands(binary, join(root, 'hands'), 'retired-model')
    expect((await hands.run('open Notes')).reply).toBe('Opened Notes and typed hi.')
    expect(await hands.run('open Notes')).toMatchObject({ ok: true })
    const runs = (await readFile(join(root, 'runs.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[] })
    expect(runs.map(run => run.args.includes('--model'))).toEqual([false, false])
  })

  it('tells Cursor the execution protocol', async () => {
    await new CursorHands(binary, join(root, 'hands'), '').prepare()
    const rules = await readFile(join(root, 'hands', 'AGENTS.md'), 'utf8')
    expect(rules).toContain('Native apps = AppleScript only')
    expect(rules).toContain('https://www.youtube.com/results?search_query=')
    expect(rules).toContain('Parallel execution')
    expect(rules).toContain('Never run the same failing command more than once more')
  })

  it('reports a failed run instead of claiming success', async () => {
    const summary = await new CursorHands(binary, join(root, 'hands')).run('open Notes, this will fail')
    expect(summary.ok).toBe(false)
    expect(summary.reply).toContain('Notes is not installed.')
  })

  it('is not ready when the CLI is missing', async () => {
    const hands = new CursorHands(join(root, 'missing'), join(root, 'hands'))
    expect(hands.ready()).toBe(false)
    expect(await hands.refresh()).toBe(false)
    expect((await hands.run('anything')).ok).toBe(false)
  })
})
