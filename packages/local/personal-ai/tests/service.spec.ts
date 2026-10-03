import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

vi.hoisted(() => {
  // Life OS keeps its Vault and tools under KAIROFORGE_HOME; tests must never touch the real one.
  process.env.KAIROFORGE_HOME = `${process.env.TMPDIR ?? '/tmp'}/kf-service-spec-${String(process.pid)}`
})
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as mainAgents from '@local/main-agents'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as personalAi from '../src/index.ts'
import { handlePersonalAiRoute } from '../src/routes.ts'
import { EDITOR_BUILD_GUIDANCE, EDITOR_OFFLINE_NOTE, MAC_CONTROL_GUIDANCE } from '../src/tools.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function lastUserText(options: GenerateOptions): string {
  const texts: string[] = []
  for (const message of [...options.messages].toReversed()) {
    if (message.role === 'assistant') break
    if (message.role !== 'user') continue
    texts.unshift(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
  }
  return texts.join('\n')
}

type Decision = StreamChunk[] | 'hang'

/** Mock model: `turnScript` makes the next turn call one tool; `hang` waits until the turn is cancelled. */
class ScriptedAdapter extends MockAdapter {
  turnScript: { id: string; name: string; args: object; issued: boolean; text?: string } | undefined

  constructor(private readonly decide: (options: GenerateOptions) => Decision) {
    super([])
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const script = this.turnScript
    let decision: Decision
    if (script !== undefined && !script.issued) {
      script.issued = true
      decision = toolCallResponse(script.id, script.name, script.args, script.text)
    } else if (script !== undefined) {
      this.turnScript = undefined
      decision = textResponse('turn done')
    } else {
      decision = this.decide(options)
    }
    if (decision === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'working' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of decision) yield chunk
  }
}

function decide(options: GenerateOptions): Decision {
  const text = lastUserText(options)
  if (text.includes('hang forever') || text.includes('keep thinking')) return 'hang'
  return textResponse('ok')
}

function sessionController(ctx: Context) {
  const resolveAgent = async (sessionId: SessionId) => {
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return { agent: live }
    try {
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'main' } })
      return { agent: handle.agent }
    } catch (error) {
      return { error: Object.assign(new Error(String(error)), { code: 'session/not-found' }) }
    }
  }
  return {
    async create(request: { sessionId?: SessionId; cwd?: string }) {
      const sessionId = request.sessionId ?? SessionId(`session-${String(++callNumber)}`)
      await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'main' }, request.cwd === undefined ? {} : { cwd: request.cwd })
      return { sessionId }
    },
    resolveAgent,
    async prompt(request: { sessionId: SessionId; content: readonly ContentBlock[] }) {
      const resolved = await resolveAgent(request.sessionId)
      if ('error' in resolved) throw resolved.error
      resolved.agent.followup(createUserMessage({ content: [...request.content], source: { kind: 'user' } }))
      return { accepted: true }
    },
    selectModel: (request: unknown) => Promise.resolve({ selected: request }),
    rename: () => Promise.resolve({ title: '', seq: 0 }),
    modelCatalog: () => Promise.resolve({ groups: [] }),
  }
}

interface Setup {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly paths: { sessions: string; storage: string }
}

interface HoloOptions { readonly dir: string; readonly port: number; readonly autoStart: boolean }

async function setup(
  paths = { sessions: tempDir('pai-sessions-'), storage: tempDir('pai-storage-') },
  holo: HoloOptions = { dir: tempDir('pai-holo-'), port: 1, autoStart: false },
  // Tests never open the real Cursor: bring-up is off unless a test stubs it.
  bringUpEditor = false,
): Promise<Setup> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: paths.sessions })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: paths.storage })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('sessionController', sessionController(ctx) as never)
  const adapter = new ScriptedAdapter(decide)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(mainAgents, {
    administratorModes: ['cordis', 'standard'],
    defaultMode: 'standard',
    defaultPermissionPreset: 'workspace-write',
    teamProvider: 'spawn',
    orchestration: true,
    engineer: false,
    toolFreeModes: ['chat', 'minimal'],
  })
  await vi.waitFor(() => { expect(ctx.get('orchestration')).toBeDefined() })
  await ctx.mainAgents.whenReady()
  await ctx.orchestration.whenReady()
  // The harness has no preset registry; Sessions whose id starts with `fast-` / `chat-` report Fast Mode / Chat.
  const modeOf = ctx.mainAgents.modeOf.bind(ctx.mainAgents)
  vi.spyOn(ctx.mainAgents, 'modeOf').mockImplementation((agent) => {
    const id = String(agent.session.id)
    return id.startsWith('fast-') ? 'fast' : id.startsWith('chat-') ? 'chat' : modeOf(agent)
  })
  await ctx.plugin(personalAi, {
    coordinatorModes: ['standard'], observedModes: ['fast'], answerOnlyModes: ['chat'], followEdits: true, bringUpEditor, confirmSensitive: true, holo,
  })
  await vi.waitFor(() => { expect(ctx.get('personalAi')).toBeDefined() })
  await ctx.personalAi.whenReady()
  await vi.waitFor(() => { expect(ctx.get('holoDeck')).toBeDefined() })
  await ctx.holoDeck.whenReady()
  return { ctx, adapter, paths }
}

async function toolNames(ctx: Context, agent: Agent): Promise<string[]> {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return (await ctx.systemPrompt.assemble({ scope })).tools.map(tool => tool.name)
}

async function assembled(ctx: Context, agent: Agent): Promise<{ sections: string; contexts: string }> {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  const assembly = await ctx.systemPrompt.assemble({ scope })
  const contexts = (Reflect.get(assembly, 'contexts') ?? []) as Array<{ text: string }>
  return { sections: assembly.sections.map(section => section.text).join('\n'), contexts: contexts.map(context => context.text).join('\n') }
}

async function lead(ctx: Context, id = 'lead-session'): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'lead' })
  await vi.waitFor(async () => { expect(await toolNames(ctx, agent)).toContain('pause_task') })
  return agent
}

async function exec(ctx: Context, agent: Agent, name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ callId: ToolCallId(`pai-call-${String(++callNumber)}`), name, arguments: args, signal: SIGNAL, agent })
}

async function run<T>(ctx: Context, agent: Agent, name: string, args: unknown): Promise<T> {
  const result = await exec(ctx, agent, name, args)
  const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  if (result.isError) throw new Error(text)
  return JSON.parse(text) as T
}

/** Have the model call one tool inside a real turn (approvals need one) and return the tool result. */
async function viaTurn(setupResult: Setup, agent: Agent, name: string, args: object): Promise<{ isError: boolean; text: string }> {
  const id = `pai-turn-${String(++callNumber)}`
  setupResult.adapter.turnScript = { id, name, args, issued: false }
  agent.followup(createUserMessage({ content: [{ type: 'text', text: `please run ${name}` }], source: { kind: 'user' } }))
  const find = () => agent.session.snapshotEvents().find(event => event.type === 'tool/result' && String(event.data.message.toolCallId) === id)
  await vi.waitFor(() => { expect(find()).toBeDefined() }, { timeout: 10_000 })
  await agent.whenIdle()
  const event = find()
  if (event?.type !== 'tool/result') throw new Error(`${name} did not run`)
  const message = event.data.message
  return { isError: message.isError === true, text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') }
}

function liveAgent(ctx: Context, sessionId: string | undefined): Agent {
  const agent = sessionId === undefined ? undefined : ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error('no live Session')
  return agent
}

describe('personal ai', () => {
  it('upgrades Lead into the coordinator, gives main agents agent memory, and leaves Fast Mode lean', async () => {
    const { ctx } = await setup()
    const leadAgent = await lead(ctx)
    const leadTools = await toolNames(ctx, leadAgent)
    expect(leadTools).toEqual(expect.arrayContaining([
      'remember', 'recall', 'forget', 'update_memory', 'create_project', 'open_project', 'update_project', 'archive_project',
      'assign_agent_to_project', 'project_status', 'pause_task', 'resume_task', 'cancel_task', 'update_task', 'add_task_constraint',
      'recommend_agent', 'propose_agent', 'list_capabilities',
    ]))
    // Existing KairoForge tools are still there.
    expect(leadTools).toEqual(expect.arrayContaining(['create_workflow', 'start_background_task']))
    const prompt = await assembled(ctx, leadAgent)
    expect(prompt.sections).toContain('You are KairoForge, the user\'s personal AI')

    const view = await ctx.mainAgents.create('Helper', {}, { kind: 'user' })
    const helper = liveAgent(ctx, view.sessionId)
    await vi.waitFor(async () => { expect(await toolNames(ctx, helper)).toContain('recall') })
    const helperTools = await toolNames(ctx, helper)
    expect(helperTools).not.toContain('pause_task')
    expect(helperTools).not.toContain('create_project')

    const fast = await ctx.agentLoop.create(SessionId('fast-1'), { provider: 'mock', model: 'lead' })
    await vi.waitFor(() => { expect(ctx.personalAi.coordinatorLive('fast-1')).toBeDefined() })
    expect(await toolNames(ctx, fast)).not.toContain('pause_task')
    expect((await assembled(ctx, fast)).sections).not.toContain('personal AI')

    // Turning the coordinator off removes the upgrade without touching existing tools.
    await ctx.personalAi.setCoordinator(false)
    await vi.waitFor(async () => { expect(await toolNames(ctx, leadAgent)).not.toContain('pause_task') })
    expect(await toolNames(ctx, leadAgent)).toContain('create_workflow')
  }, 30_000)

  it('puts Cursor guidance and editor tools in every mode except Chat', async () => {
    const { ctx } = await setup()
    await vi.waitFor(() => { expect(ctx.get('devKit')).toBeDefined() })
    const leadAgent = await lead(ctx)
    await vi.waitFor(async () => { expect((await assembled(ctx, leadAgent)).contexts).toContain(EDITOR_BUILD_GUIDANCE) })
    expect((await assembled(ctx, leadAgent)).contexts).toContain(EDITOR_OFFLINE_NOTE)
    expect(await toolNames(ctx, leadAgent)).toEqual(expect.arrayContaining(['editor_context', 'repo_map', 'open_in_editor']))
    if (process.platform === 'darwin') {
      expect((await assembled(ctx, leadAgent)).contexts).toContain(MAC_CONTROL_GUIDANCE)
      expect(await toolNames(ctx, leadAgent)).toContain('applescript')
    }

    const fast = await ctx.agentLoop.create(SessionId('fast-editor'), { provider: 'mock', model: 'lead' })
    await vi.waitFor(async () => { expect(await toolNames(ctx, fast)).toContain('open_in_editor') })
    expect((await assembled(ctx, fast)).contexts).toContain(EDITOR_BUILD_GUIDANCE)

    const chat = await ctx.agentLoop.create(SessionId('chat-editor'), { provider: 'mock', model: 'lead' })
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId('chat-editor'))).toBe(chat) })
    expect(await toolNames(ctx, chat)).not.toContain('open_in_editor')
    expect((await assembled(ctx, chat)).contexts).not.toContain('Cursor is the user\'s editor')
    expect((await assembled(ctx, chat)).contexts).not.toContain(MAC_CONTROL_GUIDANCE)

    // A live editor report replaces the offline note with the editor's own context.
    ctx.devKit.noteEditor({ editor: 'Cursor', workspaceFolders: [tempDir('pai-workspace-')], openFiles: [], diagnostics: [], at: new Date().toISOString() })
    const live = await ctx.agentLoop.create(SessionId('lead-live'), { provider: 'mock', model: 'lead' })
    await vi.waitFor(async () => { expect((await assembled(ctx, live)).contexts).toContain(EDITOR_BUILD_GUIDANCE) })
    expect((await assembled(ctx, live)).contexts).not.toContain(EDITOR_OFFLINE_NOTE)
  }, 30_000)

  it('brings Cursor up for requests that do something, never for greetings or Chat', async () => {
    const { ctx } = await setup(undefined, undefined, true)
    await vi.waitFor(() => { expect(ctx.get('devKit')).toBeDefined() })
    const bringUp = vi.spyOn(ctx.devKit, 'bringUpEditor').mockResolvedValue(undefined)
    const say = async (agent: Agent, text: string): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await vi.waitFor(() => { expect(ctx.orchestration.peekTelemetry(agent.session.id)?.lastUserText).toBe(text) }, { timeout: 10_000 })
      await agent.whenIdle()
      await assembled(ctx, agent)
    }

    const leadAgent = await lead(ctx)
    await say(leadAgent, 'Hi')
    expect(bringUp).not.toHaveBeenCalled()
    await say(leadAgent, 'change the header color to blue')
    expect(bringUp).toHaveBeenCalled()

    bringUp.mockClear()
    const chat = await ctx.agentLoop.create(SessionId('chat-bring-up'), { provider: 'mock', model: 'lead' })
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId('chat-bring-up'))).toBe(chat) })
    await say(chat, 'change the header color to blue')
    expect(bringUp).not.toHaveBeenCalled()
  }, 30_000)

  it('opens a project in Cursor at most once per window and never while Cursor is connected', async () => {
    const { ctx } = await setup()
    await vi.waitFor(() => { expect(ctx.get('devKit')).toBeDefined() })
    // A harmless stand-in for the Cursor CLI.
    vi.spyOn(ctx.devKit, 'editorCli').mockReturnValue('/usr/bin/true')
    const project = tempDir('pai-bring-up-')
    expect(await ctx.devKit.bringUpEditor(project)).toBe(project)
    expect(await ctx.devKit.bringUpEditor(project)).toBeUndefined()
    expect(ctx.devKit.counters.editorLaunches).toBe(1)
    expect(await ctx.devKit.bringUpEditor(homedir())).toBeUndefined()

    ctx.devKit.noteEditor({ editor: 'Cursor', workspaceFolders: [], openFiles: [], diagnostics: [], at: new Date().toISOString() })
    expect(await ctx.devKit.bringUpEditor(tempDir('pai-bring-up-'))).toBeUndefined()
    expect(ctx.devKit.counters.editorLaunches).toBe(1)
  }, 30_000)

  it('asks before a main agent\'s sensitive call, whatever its permission preset', async () => {
    const s = await setup()
    const { ctx } = s
    await ctx.plugin(ApprovalService)
    const asked: string[] = []
    ctx.on('approval/request', (request) => {
      asked.push(request.toolName)
      return Promise.resolve<ApprovalOutcome>('rejected')
    })
    const view = await ctx.mainAgents.create('Helper', {}, { kind: 'user' })
    const helper = liveAgent(ctx, view.sessionId)
    await vi.waitFor(async () => { expect(await toolNames(ctx, helper)).toContain('remember') })

    const read = await viaTurn(s, helper, 'recall', { query: 'package manager' })
    expect(read.isError).toBe(false)
    expect(asked).toEqual([])
    const sensitive = await viaTurn(s, helper, 'remember', { text: 'Prefers pnpm over npm', scope: 'user' })
    expect(sensitive.isError).toBe(true)
    expect(asked).toEqual(['remember'])
    expect(ctx.personalAi.memories()).toHaveLength(0)
  }, 30_000)

  it('stores memories, refuses secrets, and asks before saving a memory about the user', async () => {
    const s = await setup()
    const { ctx } = s
    await ctx.plugin(ApprovalService)
    const answers: ApprovalOutcome[] = ['allowed-once', 'rejected']
    const asked: string[] = []
    ctx.on('approval/request', (request) => {
      asked.push(request.toolName)
      return Promise.resolve(answers.shift() ?? 'rejected')
    })
    const leadAgent = await lead(ctx)

    const secret = await viaTurn(s, leadAgent, 'remember', { text: 'my password is hunter2', scope: 'session' })
    expect(secret.isError).toBe(true)
    expect(secret.text).toMatch(/password or credential/)
    expect(ctx.personalAi.memories({ includeDisabled: true })).toHaveLength(0)

    const saved = await viaTurn(s, leadAgent, 'remember', { text: 'Prefers pnpm over npm', scope: 'user' })
    expect(saved.isError).toBe(false)
    expect(asked).toEqual(['remember'])
    const denied = await viaTurn(s, leadAgent, 'remember', { text: 'Likes tabs', scope: 'user' })
    expect(denied.isError).toBe(true)
    expect(asked).toEqual(['remember', 'remember'])
    expect(ctx.personalAi.memories().map(entry => entry.text)).toEqual(['Prefers pnpm over npm'])

    const recalled = await run<Array<{ text: string }>>(ctx, leadAgent, 'recall', { query: 'which package manager pnpm' })
    expect(recalled.map(entry => entry.text)).toEqual(['Prefers pnpm over npm'])
    // Relevant memories reach the model as runtime context, never as a secret.
    leadAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'install deps' }], source: { kind: 'user' } }))
    await leadAgent.whenIdle()
    expect((await assembled(ctx, leadAgent)).contexts).toContain('Prefers pnpm over npm')
  }, 30_000)

  it('registers projects without guessing and reports live project status', async () => {
    const { ctx } = await setup()
    const repo = tempDir('pai-repo-')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'x')
    const leadAgent = await lead(ctx)
    const created = await run<{ id: string; active: boolean }>(ctx, leadAgent, 'create_project', { name: 'Galaxy', path: repo, stack: ['TypeScript'] })
    expect(created.active).toBe(true)
    expect(ctx.personalAi.activeProject()?.commands).toEqual({})
    await run(ctx, leadAgent, 'update_project', { project: 'Galaxy', commands: { test: 'pnpm vitest' }, decision: 'Use vitest' })
    const status = await run<{ git: { branch?: string; changed: number } }>(ctx, leadAgent, 'project_status', {})
    expect(status.git.branch).toBe('main')
    expect(status.git.changed).toBeGreaterThan(0)
    leadAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the tests' }], source: { kind: 'user' } }))
    await leadAgent.whenIdle()
    const context = (await assembled(ctx, leadAgent)).contexts
    expect(context).toContain('Active project: Galaxy')
    expect(context).toContain('test: pnpm vitest')
    await expect(run(ctx, leadAgent, 'create_project', { name: 'galaxy' })).rejects.toThrow(/already exists/)
  }, 30_000)

  it('pauses, updates, resumes, and cancels background work and says when a control cannot apply', async () => {
    const { ctx } = await setup()
    const leadAgent = await lead(ctx)
    await ctx.mainAgents.create('Worker Bee', {}, { kind: 'user' })
    const task = await ctx.orchestration.background.create({ agentId: 'worker-bee', title: 'Long', prompt: 'hang forever' }, { sessionId: 'user', name: 'the user' })
    await vi.waitFor(() => { expect(ctx.orchestration.background.get(task.id).status).toBe('running') }, { timeout: 10_000 })

    const update = await run<{ outcome: string }>(ctx, leadAgent, 'update_task', { kind: 'background', id: task.id, text: 'Also count tests' })
    expect(update.outcome).toBe('delivered')
    const paused = await run<{ outcome: string; state: string }>(ctx, leadAgent, 'pause_task', { kind: 'background', id: task.id })
    expect(paused).toMatchObject({ outcome: 'applied', state: 'paused' })
    const constrained = await run<{ outcome: string }>(ctx, leadAgent, 'add_task_constraint', { kind: 'background', id: task.id, text: 'Do not edit files' })
    expect(constrained.outcome).toBe('applied')
    expect(ctx.orchestration.background.get(task.id).prompt).toContain('Constraint: Do not edit files')
    const again = await run<{ outcome: string }>(ctx, leadAgent, 'pause_task', { kind: 'background', id: task.id })
    expect(again.outcome).toBe('rejected')
    const cancelled = await run<{ outcome: string; state: string }>(ctx, leadAgent, 'cancel_task', { kind: 'background', id: task.id })
    expect(cancelled).toMatchObject({ outcome: 'applied', state: 'cancelled' })

    const idle = await run<{ outcome: string }>(ctx, leadAgent, 'cancel_task', { kind: 'session', id: 'worker-bee' })
    expect(idle.outcome).toBe('rejected')
    const pausedTurn = await run<{ outcome: string }>(ctx, leadAgent, 'pause_task', { kind: 'session', id: 'worker-bee' })
    expect(pausedTurn.outcome).toBe('rejected')
    expect(ctx.personalAi.controls().map(row => `${row.action}:${row.outcome}`)).toEqual([
      'pause:rejected', 'cancel:rejected', 'cancel:applied', 'pause:rejected', 'constrain:applied', 'pause:applied', 'update:delivered',
    ])
  }, 30_000)

  it('interrupts a running chat turn and tracks live assistant state and turn metrics', async () => {
    const { ctx } = await setup()
    const leadAgent = await lead(ctx)
    expect(ctx.personalAi.assistantState().state).toBe('IDLE')
    leadAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'keep thinking about it' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(ctx.personalAi.assistantState('lead-session').state).toBe('THINKING') })
    expect(ctx.personalAi.assistantState().orb).toBe('processing')
    ctx.personalAi.setVoice('speaking')
    expect(ctx.personalAi.assistantState().state).toBe('SPEAKING')
    ctx.personalAi.setVoice('off')
    const control = await ctx.personalAi.control({ kind: 'session', id: 'lead-session' }, 'cancel', undefined, 'user')
    expect(control.outcome).toBe('applied')
    await leadAgent.whenIdle()
    await vi.waitFor(() => { expect(ctx.personalAi.metrics().summary.overall.turns).toBe(1) })
    expect(ctx.personalAi.assistantState().state).toBe('IDLE')

    leadAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } }))
    await leadAgent.whenIdle()
    await vi.waitFor(() => { expect(ctx.personalAi.metrics().summary.overall.turns).toBe(2) })
    const latest = ctx.personalAi.metrics().recent[0]
    expect(latest).toMatchObject({ depth: 'direct', toolCalls: 0, delegated: false, mode: 'standard' })
    expect(ctx.personalAi.decisionOf('lead-session')?.depth).toBe('direct')
  }, 30_000)

  it('answers a Command Center turn without a chat on screen and keeps one conversation Session', async () => {
    const { ctx } = await setup()
    const first = await ctx.personalAi.converse('Hi')
    expect(first.status).toBe('running')
    await vi.waitFor(() => { expect(ctx.personalAi.converseTurn(first.id).status).toBe('done') })
    expect(ctx.personalAi.converseTurn(first.id).reply).toBe('ok')
    expect(ctx.personalAi.conversationSessionId()).toBe(first.sessionId)
    expect(ctx.personalAi.decisionOf(first.sessionId)?.depth).toBe('direct')

    const routed = await handlePersonalAiRoute(ctx.personalAi, ctx, 'POST', ['converse'], new URLSearchParams(), { text: 'And after that?' })
    const second = routed.payload as { id: string; sessionId: string }
    expect(second.sessionId).toBe(first.sessionId)
    await vi.waitFor(async () => {
      const polled = await handlePersonalAiRoute(ctx.personalAi, ctx, 'GET', ['converse', second.id], new URLSearchParams(), undefined)
      expect(polled.payload).toMatchObject({ status: 'done', reply: 'ok' })
    })
    await expect(ctx.personalAi.converse('   ')).rejects.toMatchObject({ code: 'invalid' })
    await expect(handlePersonalAiRoute(ctx.personalAi, ctx, 'GET', ['converse', 'missing'], new URLSearchParams(), undefined))
      .rejects.toMatchObject({ code: 'not-found' })

    const fresh = (await handlePersonalAiRoute(ctx.personalAi, ctx, 'POST', ['converse', 'new'], new URLSearchParams(), {})).payload as { sessionId: string }
    expect(fresh.sessionId).not.toBe(first.sessionId)
    expect(ctx.personalAi.conversationSessionId()).toBe(fresh.sessionId)
    const third = await ctx.personalAi.converse('Hello again')
    expect(third.sessionId).toBe(fresh.sessionId)
    await vi.waitFor(() => { expect(ctx.personalAi.converseTurn(third.id).status).toBe('done') })
  }, 30_000)

  it('gives the spoken conversation a small toolset that grows on request and leaves Lead whole', async () => {
    const { ctx } = await setup()
    const leadAgent = await lead(ctx)
    const turn = await ctx.personalAi.converse('Hi')
    await vi.waitFor(() => { expect(ctx.personalAi.converseTurn(turn.id).status).toBe('done') })
    const voice = liveAgent(ctx, turn.sessionId)
    const stepTools = async (agent: Agent): Promise<string[]> => {
      const scope = scopeOf(agent.ctx)
      if (scope === undefined) throw new Error('expected Agent scope')
      return (await ctx.systemPrompt.assemble({ scope, agent })).tools.map(tool => tool.name)
    }

    // Small talk is answered directly: nothing but the switch that opens more.
    expect(await stepTools(voice)).toEqual(['use_tools'])
    // list_capabilities and the tools view still see everything the Session has.
    expect(await toolNames(ctx, voice)).toContain('create_workflow')
    expect(await stepTools(leadAgent)).toContain('create_workflow')

    const opened = await run<{ opened: string[] }>(ctx, voice, 'use_tools', { categories: ['WORKFLOWS'] })
    expect(opened.opened).toEqual(['WORKFLOWS'])
    const working = await stepTools(voice)
    expect(working).toEqual(expect.arrayContaining(['use_tools', 'remember', 'pause_task', 'create_workflow']))
    expect(working).not.toContain('schedule_create')
  }, 30_000)

  it('narrates a Command Center turn while it works and keeps narration out of the answer', async () => {
    const { ctx, adapter } = await setup()
    adapter.turnScript = { id: 'call-narrated', name: 'recall', args: { query: 'meeting' }, issued: false, text: 'On it — checking my notes now.' }
    const narrated = await ctx.personalAi.converse('When is my meeting?')
    await vi.waitFor(() => { expect(ctx.personalAi.converseTurn(narrated.id).status).toBe('done') })
    const first = ctx.personalAi.converseTurn(narrated.id)
    // The model's own words cover the step, so the tool adds no second line.
    expect(first.updates).toEqual([{ kind: 'say', text: 'On it — checking my notes now.' }])
    expect(first.reply).toBe('turn done')

    adapter.turnScript = { id: 'call-silent', name: 'recall', args: { query: 'meeting' }, issued: false }
    const silent = await ctx.personalAi.converse('And the one after?')
    await vi.waitFor(() => { expect(ctx.personalAi.converseTurn(silent.id).status).toBe('done') })
    expect(ctx.personalAi.converseTurn(silent.id).updates).toEqual([{ kind: 'tool', category: 'PROJECT', changes: false }])

    const quick = await ctx.personalAi.converse('Hi')
    await vi.waitFor(() => { expect(ctx.personalAi.converseTurn(quick.id).status).toBe('done') })
    expect(ctx.personalAi.converseTurn(quick.id).updates).toBeUndefined()
  }, 30_000)

  it('serves the Command Center overview and rejects secrets at the route', async () => {
    const { ctx } = await setup()
    await lead(ctx)
    const created = await handlePersonalAiRoute(ctx.personalAi, ctx, 'POST', ['memory'], new URLSearchParams(), { scope: 'user', text: 'Call me Frank' })
    expect(created.status).toBe(200)
    await expect(handlePersonalAiRoute(ctx.personalAi, ctx, 'POST', ['memory'], new URLSearchParams(), { scope: 'user', text: 'api key: sk-abcdefghijklmnopqrstuvwxyz123456' }))
      .rejects.toMatchObject({ code: 'sensitive' })
    const overview = await handlePersonalAiRoute(ctx.personalAi, ctx, 'GET', ['overview'], new URLSearchParams(), undefined)
    expect(overview.payload).toMatchObject({ state: { state: 'IDLE' }, coordinator: true, counts: { memories: 1 } })
    const personality = await handlePersonalAiRoute(ctx.personalAi, ctx, 'POST', ['personality'], new URLSearchParams(), { name: 'Nova', voice: { rate: 1.2 } })
    expect(personality.payload).toMatchObject({ name: 'Nova', voice: { rate: 1.2 } })
    const classified = await handlePersonalAiRoute(ctx.personalAi, ctx, 'GET', ['classify'], new URLSearchParams({ text: 'Hi' }), undefined)
    expect(classified.payload).toMatchObject({ depth: 'direct' })
  }, 30_000)

  it('builds a Holo Hands scene with tools, follows the deck through routes, and never fakes an open', async () => {
    const { ctx } = await setup()
    const route = (method: 'GET' | 'POST', path: string[], body?: unknown) =>
      handlePersonalAiRoute(ctx.personalAi, ctx, method, path, new URLSearchParams(), body)
    const leadAgent = await lead(ctx)
    expect(await toolNames(ctx, leadAgent)).toEqual(expect.arrayContaining([...personalAi.HOLO_TOOLS]))
    expect((await assembled(ctx, leadAgent)).sections).toContain('open holo hands')

    // No checkout and no server: open says so instead of pretending.
    const missing = await run<{ open: boolean; server: string; detail?: string }>(ctx, leadAgent, 'open_holo', {})
    expect(missing).toMatchObject({ open: false, server: 'missing' })
    expect(missing.detail).toMatch(/server\.py/)
    expect((await route('GET', ['state'])).payload).toMatchObject({ holo: { open: false } })
    // Voice phase changes answer with the same state shape, so the open deck is never dropped mid-talk.
    expect((await route('POST', ['voice'], { phase: 'listening' })).payload).toMatchObject({ state: 'LISTENING', holo: { open: false } })
    await route('POST', ['voice'], { phase: 'off' })

    const counter = await run<{ id: string }>(ctx, leadAgent, 'holo_add', {
      kind: 'widget', title: 'Counter', html: '<button onclick="holo.emit(++n)">+1</button><script>let n = 0</script>',
    })
    const total = await run<{ id: string }>(ctx, leadAgent, 'holo_add', { kind: 'text', title: 'Total', text: '0', color: 'gold' })
    const sensor = await run<{ id: string }>(ctx, leadAgent, 'holo_add', { kind: 'sensor', title: 'Smile', signal: 'smile' })
    const link = await run<{ id: string }>(ctx, leadAgent, 'holo_connect', { from: counter.id, to: total.id, label: 'count' })
    await run(ctx, leadAgent, 'holo_connect', { from: sensor.id, to: counter.id })
    expect((await run<{ id: string }>(ctx, leadAgent, 'holo_connect', { from: counter.id, to: total.id })).id).toBe(link.id)
    await expect(run(ctx, leadAgent, 'holo_connect', { from: total.id, to: total.id })).rejects.toThrow(/itself/)
    await expect(run(ctx, leadAgent, 'holo_add', { kind: 'note', title: 'Login', text: 'my password is hunter2' })).rejects.toThrow(/secrets/)
    await expect(run(ctx, leadAgent, 'holo_add', { kind: 'web', title: 'Bad', url: 'javascript:alert(1)' })).rejects.toThrow(/https/)

    const snapshot = (await route('GET', ['holo'])).payload as { revision: number; scene: { items: Array<{ id: string; x: number; posRev: number }>; connectors: unknown[] } }
    expect(snapshot.scene.items.map(entry => entry.id)).toEqual([counter.id, total.id, sensor.id])
    expect(snapshot.scene.connectors).toHaveLength(2)

    // Hand moves are saved without a new revision; a tool move bumps posRev so the deck re-seats the item.
    await route('POST', ['holo', 'layout'], { items: [{ id: total.id, x: 0.9, y: 0.2, scale: 1.5 }] })
    const moved = ctx.holoDeck.scene()
    expect(moved.revision).toBe(snapshot.revision)
    expect(moved.items.find(entry => entry.id === total.id)).toMatchObject({ x: 0.9, y: 0.2, scale: 1.5, posRev: 1 })
    const placed = await run<{ posRev: number; x: number }>(ctx, leadAgent, 'holo_update', { id: total.id, x: 0.1 })
    expect(placed).toMatchObject({ posRev: 2, x: 0.1 })

    // Perception is derived numbers, strictly shaped, in memory only.
    await expect(route('POST', ['holo', 'perception'], { hands: [], events: [], image: 'data:image/png;base64,AAAA' })).rejects.toMatchObject({ code: 'invalid' })
    await route('POST', ['holo', 'perception'], {
      face: { present: true, looking: 'screen', smile: 0.7 },
      hands: [{ side: 'right', gesture: 'pinch', x: 0.5, y: 0.5, holding: counter.id }],
      events: ['smile'],
    })
    expect(ctx.holoDeck.perception()?.hands[0]?.holding).toBe(counter.id)
    expect(ctx.holoDeck.seeing()).toMatch(/closed/)

    // An action hands its prompt back for the client to send as a normal request, rate-limited.
    const ask = await run<{ id: string }>(ctx, leadAgent, 'holo_add', { kind: 'action', title: 'Summarize', prompt: 'Summarize this: {value}' })
    expect((await route('POST', ['holo', 'activate'], { id: ask.id, value: 'the plan' })).payload).toEqual({ prompt: 'Summarize this: the plan' })
    await expect(route('POST', ['holo', 'activate'], { id: ask.id })).rejects.toMatchObject({ code: 'invalid' })
    expect((await route('POST', ['holo', 'activate'], { id: total.id })).payload).toEqual({ prompt: null })

    // Removing an item takes its connectors with it.
    expect(await run<{ removed: string[] }>(ctx, leadAgent, 'holo_remove', { ids: [counter.id] })).toMatchObject({ removed: [counter.id] })
    expect(ctx.holoDeck.scene().connectors).toEqual([])
    const status = await run<{ open: boolean; scene: { items: unknown[] }; camera: string }>(ctx, leadAgent, 'holo_status', {})
    expect(status.open).toBe(false)
    expect(status.scene.items).toHaveLength(3)
    expect(status.camera).toMatch(/closed/)
  }, 30_000)

  it('starts the Holo server from the checkout and opens the deck', async () => {
    const holoDir = tempDir('pai-holo-app-')
    const port = 47_000 + Math.floor(Math.random() * 2000)
    writeFileSync(join(holoDir, 'holo.html'), '<!doctype html><title>holo</title>')
    writeFileSync(join(holoDir, 'server.py'), [
      'import json, os',
      'from http.server import BaseHTTPRequestHandler, HTTPServer',
      'class H(BaseHTTPRequestHandler):',
      '    def log_message(self, *a): pass',
      '    def do_GET(self):',
      '        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps([]).encode())',
      'HTTPServer(("127.0.0.1", int(os.environ["HOLO_PORT"])), H).serve_forever()',
    ].join('\n'))
    const { ctx } = await setup(undefined, { dir: holoDir, port, autoStart: true })
    try {
      const opened = await ctx.holoDeck.open()
      expect(opened).toMatchObject({ open: true, server: 'started', url: `http://127.0.0.1:${String(port)}` })
      expect((await ctx.holoDeck.open()).server).toBe('running')
      expect(ctx.holoDeck.contextLine()).toContain('Holo Hands is open full screen')
      expect(ctx.holoDeck.close().open).toBe(false)
      expect(ctx.holoDeck.contextLine()).toBe('')
    } finally {
      const pids = execFileSync('lsof', ['-ti', `tcp:${String(port)}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean)
      for (const pid of pids) process.kill(Number(pid))
    }
  }, 30_000)

  it('keeps memories, projects, personality, and controls across a restart', async () => {
    const first = await setup()
    await first.ctx.personalAi.remember({ scope: 'user', text: 'Prefers dark mode' }, 'user')
    await first.ctx.personalAi.createProject({ name: 'Persisted' })
    await first.ctx.personalAi.updatePersonality({ name: 'Nova' })
    const talked = await first.ctx.personalAi.converse('Hi')
    await vi.waitFor(() => { expect(first.ctx.personalAi.converseTurn(talked.id).status).toBe('done') })
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await setup(first.paths)
    expect(second.ctx.personalAi.memories().map(entry => entry.text)).toEqual(['Prefers dark mode'])
    expect(second.ctx.personalAi.projects().map(project => project.name)).toEqual(['Persisted'])
    expect(second.ctx.personalAi.personality().name).toBe('Nova')
    expect(second.ctx.personalAi.conversationSessionId()).toBe(talked.sessionId)
  }, 30_000)
})
