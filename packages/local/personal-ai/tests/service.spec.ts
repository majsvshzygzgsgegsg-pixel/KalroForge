import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
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
  turnScript: { id: string; name: string; args: object; issued: boolean } | undefined

  constructor(private readonly decide: (options: GenerateOptions) => Decision) {
    super([])
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const script = this.turnScript
    let decision: Decision
    if (script !== undefined && !script.issued) {
      script.issued = true
      decision = toolCallResponse(script.id, script.name, script.args)
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

async function setup(paths = { sessions: tempDir('pai-sessions-'), storage: tempDir('pai-storage-') }): Promise<Setup> {
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
  // The harness has no preset registry; Sessions whose id starts with `fast-` report Fast Mode.
  const modeOf = ctx.mainAgents.modeOf.bind(ctx.mainAgents)
  vi.spyOn(ctx.mainAgents, 'modeOf').mockImplementation(agent => String(agent.session.id).startsWith('fast-') ? 'fast' : modeOf(agent))
  await ctx.plugin(personalAi, { coordinatorModes: ['standard'], observedModes: ['fast'], confirmSensitive: true })
  await vi.waitFor(() => { expect(ctx.get('personalAi')).toBeDefined() })
  await ctx.personalAi.whenReady()
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

  it('keeps memories, projects, personality, and controls across a restart', async () => {
    const first = await setup()
    await first.ctx.personalAi.remember({ scope: 'user', text: 'Prefers dark mode' }, 'user')
    await first.ctx.personalAi.createProject({ name: 'Persisted' })
    await first.ctx.personalAi.updatePersonality({ name: 'Nova' })
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await setup(first.paths)
    expect(second.ctx.personalAi.memories().map(entry => entry.text)).toEqual(['Prefers dark mode'])
    expect(second.ctx.personalAi.projects().map(project => project.name)).toEqual(['Persisted'])
    expect(second.ctx.personalAi.personality().name).toBe('Nova')
  }, 30_000)
})
