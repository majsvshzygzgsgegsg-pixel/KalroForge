import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as mainAgents from '../src/index.ts'
import type { MainAgentView } from '../src/index.ts'
import { agentDashboard, orchestrationState } from '../src/orchestration/views.ts'

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

function gitRepo(): string {
  const root = tempDir('orchestration-repo-')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  writeFileSync(join(root, 'app.txt'), 'v1\n')
  writeFileSync(join(root, 'user.txt'), 'user v1\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  return root
}

/** Text of the newest user message in a request. */
/** Text of every user message after the last assistant message (prompts can arrive alongside runtime-context notices). */
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

/** Mock model that answers each request from its content; `hang` waits until the turn is cancelled. */
class ScriptedAdapter extends MockAdapter {
  /** One tool call the next turn makes before replying, so the call runs inside a real turn (approvals need one). */
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

/** Default behaviour: workflow workers, integration, background tasks, delegation, and plain replies. */
function defaultDecide(planned: Decision[]) {
  return (options: GenerateOptions): Decision => {
    if (options.model === 'lead') return planned.shift() ?? textResponse('lead done')
    const text = lastUserText(options)
    const task = /## Task ([a-z0-9_-]+):/i.exec(text)?.[1]
    if (task !== undefined) {
      if (task === 'slow') return 'hang'
      if (task === 'flaky' && !text.includes('A previous attempt failed')) return textResponse('TASK FAILED: flaky first attempt')
      if (task === 'broken') return textResponse('TASK FAILED: cannot do it')
      if (task === 'merge') return textResponse(`done merge; deps ${text.includes('done api') && text.includes('done ui') ? 'received' : 'missing'}`)
      return textResponse(`done ${task}`)
    }
    if (text.includes('[KairoForge workflow')) return textResponse('INTEGRATED final result')
    if (text.includes('[KairoForge background task') && text.includes('hang forever')) return 'hang'
    if (text.includes('[KairoForge background task')) return textResponse('BG DONE')
    return textResponse('main agent ok')
  }
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
    async create(request: { sessionId: SessionId; cwd?: string }) {
      await ctx.agentLoop.create(request.sessionId, { provider: 'mock', model: 'main' }, request.cwd === undefined ? {} : { cwd: request.cwd })
      return { sessionId: request.sessionId }
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

async function setup(options: {
  paths?: { sessions: string; storage: string }
  planned?: Decision[]
  engineer?: boolean
  decide?: (options: GenerateOptions) => Decision
} = {}): Promise<Setup> {
  const paths = options.paths ?? { sessions: tempDir('orch-sessions-'), storage: tempDir('orch-storage-') }
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
  const adapter = new ScriptedAdapter(options.decide ?? defaultDecide(options.planned ?? []))
  ctx.llm.registerAdapter(['mock'], adapter)
  adapters.set(ctx, adapter)
  await ctx.plugin(mainAgents, {
    administratorModes: ['cordis', 'standard'],
    defaultMode: 'standard',
    defaultPermissionPreset: 'workspace-write',
    teamProvider: 'spawn',
    orchestration: true,
    engineer: options.engineer ?? false,
  })
  await vi.waitFor(() => { expect(ctx.get('orchestration')).toBeDefined() })
  await ctx.mainAgents.whenReady()
  await ctx.orchestration.whenReady()
  return { ctx, adapter, paths }
}

async function lead(ctx: Context, id = 'lead-session'): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'lead' })
  await vi.waitFor(async () => { expect(await toolNames(ctx, agent)).toContain('create_workflow') })
  return agent
}

async function toolNames(ctx: Context, agent: Agent): Promise<string[]> {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return (await ctx.systemPrompt.assemble({ scope })).tools.map(tool => tool.name)
}

async function exec(ctx: Context, agent: Agent, name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ callId: ToolCallId(`orch-call-${String(++callNumber)}`), name, arguments: args, signal: SIGNAL, agent })
}

async function run<T>(ctx: Context, agent: Agent, name: string, args: unknown): Promise<T> {
  const result = await exec(ctx, agent, name, args)
  const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  if (result.isError) throw new Error(text)
  return JSON.parse(text) as T
}

/** Have the agent's model call one tool inside a real turn and return the tool result. */
async function viaTurn(ctx: Context, agent: Agent, name: string, args: object): Promise<{ isError: boolean; text: string }> {
  const id = `orch-turn-${String(++callNumber)}`
  adapterOf(ctx).turnScript = { id, name, args, issued: false }
  agent.followup(createUserMessage({ content: [{ type: 'text', text: `please run ${name}` }], source: { kind: 'user' } }))
  const find = () => agent.session.snapshotEvents().find(event => event.type === 'tool/result' && String(event.data.message.toolCallId) === id)
  await vi.waitFor(() => { expect(find()).toBeDefined() }, { timeout: 10_000 })
  await agent.whenIdle()
  const event = find()
  if (event?.type !== 'tool/result') throw new Error(`${name} did not run`)
  const message = event.data.message
  return {
    isError: message.isError === true,
    text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
  }
}

function userTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'user/message'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

const adapters = new WeakMap<Context, ScriptedAdapter>()
function adapterOf(ctx: Context): ScriptedAdapter {
  const adapter = adapters.get(ctx)
  if (adapter === undefined) throw new Error('no adapter')
  return adapter
}

function live(ctx: Context, view: MainAgentView): Agent {
  const agent = view.sessionId === undefined ? undefined : ctx.agents.get(SessionId(view.sessionId))
  if (agent === undefined) throw new Error(`main agent ${view.id} has no live Session`)
  return agent
}

/** A fake shell tool: `exit:N` in the command sets the exit code. */
function fakeShell(ctx: Context): string[] {
  const commands: string[] = []
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'test shell',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args) => {
      commands.push(args.command)
      const code = Number(/exit:(\d+)/.exec(args.command)?.[1] ?? '0')
      return Promise.resolve({ kind: 'foreground', exitCode: code, output: code === 0 ? 'ok' : 'Error: assertion failed in suite' })
    },
  }))
  return commands
}

/** A fake edit tool that writes content into the caller's cwd. */
function fakeEdit(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'test edit',
    parameters: { path: { type: 'string', required: true }, new_string: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, run) => {
      const cwd = run.agent?.session.header.cwd ?? process.cwd()
      writeFileSync(join(cwd, args.path), args.new_string)
      return Promise.resolve({ ok: true })
    },
  }))
}

describe('orchestration', () => {
  it('runs a workflow with parallel tasks, dependencies, retries, result passing, a checkpoint, and integration', async () => {
    const { ctx } = await setup()
    const repo = gitRepo()
    const leadAgent = await lead(ctx)
    const agent = await ctx.mainAgents.create('Planner Prime', { workspace: repo }, { kind: 'user' })
    const owner = live(ctx, agent)
    await vi.waitFor(async () => { expect(await toolNames(ctx, owner)).toContain('create_workflow') })

    const created = await run<{ id: string; checkpointId?: string }>(ctx, owner, 'create_workflow', {
      title: 'Feature X',
      goal: 'Ship feature X',
      max_parallel: 2,
      tasks: [
        { id: 'api', title: 'API', role: 'backend engineer', instructions: 'Build the API.' },
        { id: 'ui', title: 'UI', role: 'frontend engineer', instructions: 'Build the UI.' },
        { id: 'flaky', title: 'Docs', role: 'technical writer', instructions: 'Write docs.', retries: 1 },
        { id: 'merge', title: 'Integrate', role: 'integrator', instructions: 'Merge API and UI.', depends_on: ['api', 'ui'] },
      ],
    })
    expect(created.checkpointId).toMatch(/^cp-/)
    await vi.waitFor(() => {
      expect(ctx.orchestration.workflows.get(created.id).status).toBe('completed')
    }, { timeout: 20_000, interval: 100 })

    const workflow = ctx.orchestration.workflows.get(created.id)
    const byId = Object.fromEntries(workflow.tasks.map(task => [task.id, task]))
    expect(byId.api?.result).toBe('done api')
    expect(byId.flaky).toMatchObject({ status: 'completed', attempts: 2, result: 'done flaky' })
    expect(byId.flaky?.workers).toHaveLength(2)
    expect(byId.merge?.result).toBe('done merge; deps received')
    expect(workflow.finalResult).toBeTruthy()
    expect(userTexts(owner).join('\n')).toContain('[KairoForge workflow complete] Feature X')
    // Workers are teammates of the main agent's own Agent Team, and the plan is mirrored to its task board.
    const members = ctx.agentTeams.listMembers(owner).map(member => member.name)
    expect(members.filter(name => name.startsWith('backend-engineer-api-'))).toHaveLength(1)
    const board = ctx.agentTeams.listTasks(owner)
    expect(board.filter(task => task.subject.startsWith(`[${created.id}]`))).toHaveLength(4)
    // The checkpoint ref exists in the workspace repository.
    const ref = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/kairoforge/checkpoints/'], { cwd: repo, encoding: 'utf8' })
    expect(ref).toContain(created.checkpointId)
    expect(leadAgent.session.id).toBe('lead-session')
  }, 30_000)

  it('skips dependants of a failed task, retries on request, and cancels running workers', async () => {
    const { ctx } = await setup()
    await lead(ctx)
    const agent = await ctx.mainAgents.create('Runner', {}, { kind: 'user' })
    const owner = live(ctx, agent)
    await vi.waitFor(async () => { expect(await toolNames(ctx, owner)).toContain('create_workflow') })
    const failing = await run<{ id: string }>(ctx, owner, 'create_workflow', {
      title: 'Failing', goal: 'g', checkpoint: false,
      tasks: [
        { id: 'broken', title: 'Broken', role: 'worker', instructions: 'x', retries: 0 },
        { id: 'after', title: 'After', role: 'worker', instructions: 'y', depends_on: ['broken'] },
      ],
    })
    await vi.waitFor(() => {
      expect(['integrating', 'failed']).toContain(ctx.orchestration.workflows.get(failing.id).status)
    }, { timeout: 15_000, interval: 100 })
    const settled = ctx.orchestration.workflows.get(failing.id)
    expect(settled.tasks.map(task => task.status)).toEqual(['failed', 'skipped'])
    expect(userTexts(owner).join('\n')).toContain('finished with failures')

    const slow = await run<{ id: string }>(ctx, owner, 'create_workflow', {
      title: 'Slow', goal: 'g', checkpoint: false,
      tasks: [{ id: 'slow', title: 'Slow', role: 'worker', instructions: 'wait' }],
    })
    await vi.waitFor(() => { expect(ctx.orchestration.workflows.get(slow.id).tasks[0]?.status).toBe('running') }, { timeout: 10_000 })
    const cancelled = await run<{ status: string; tasks: Array<{ status: string }> }>(ctx, owner, 'cancel_workflow', { workflow_id: slow.id })
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.tasks[0]?.status).toBe('cancelled')
  }, 30_000)

  it('creates, compares, and restores checkpoints without touching unrelated user work, with approval', async () => {
    const { ctx } = await setup({ planned: [] })
    await ctx.plugin(ApprovalService)
    const answers: ApprovalOutcome[] = ['allowed-once']
    const asked: string[] = []
    ctx.on('approval/request', (request) => {
      asked.push(request.toolName)
      return Promise.resolve(answers.shift() ?? 'rejected')
    })
    fakeEdit(ctx)
    const repo = gitRepo()
    await lead(ctx)
    const agent = await ctx.mainAgents.create('Editor', { workspace: repo }, { kind: 'user' })
    const session = live(ctx, agent)
    await vi.waitFor(async () => { expect(await toolNames(ctx, session)).toContain('create_checkpoint') })

    // Uncommitted user work before the agent starts.
    writeFileSync(join(repo, 'user.txt'), 'user v2 uncommitted\n')
    const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })

    // The first mutating call takes an automatic checkpoint, and the write is tracked as agent-touched.
    await run(ctx, session, 'edit', { path: 'app.txt', new_string: 'broken by agent\n' })
    const auto = ctx.orchestration.checkpoints.list().find(row => row.reason === 'auto')
    expect(auto).toBeDefined()
    expect(auto?.dirty).toEqual(['user.txt'])
    await run(ctx, session, 'edit', { path: 'new-file.txt', new_string: 'agent made this\n' })
    expect(ctx.orchestration.checkpoints.get(auto!.id).touched.toSorted()).toEqual(['app.txt', 'new-file.txt'])
    expect(ctx.orchestration.checkpoints.list().filter(row => row.reason === 'auto')).toHaveLength(1)
    // The user keeps editing their own file meanwhile.
    writeFileSync(join(repo, 'user.txt'), 'user v3 still editing\n')

    const comparison = await run<{ changes: Array<{ path: string; status: string; touchedByAgent: boolean }> }>(ctx, session, 'compare_checkpoint', { checkpoint_id: auto!.id })
    expect(comparison.changes.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'app.txt', status: 'M', touchedByAgent: true },
      { path: 'new-file.txt', status: 'A', touchedByAgent: true },
      { path: 'user.txt', status: 'M', touchedByAgent: false },
    ])

    const restoreTurn = await viaTurn(ctx, session, 'restore_checkpoint', { checkpoint_id: auto!.id })
    expect(restoreTurn.isError).toBe(false)
    const restored = JSON.parse(restoreTurn.text) as {
      restored: string[]
      deleted: string[]
      skipped: string[]
      safetyCheckpointId?: string
    }
    expect(asked).toEqual(['restore_checkpoint'])
    expect(restored.restored).toEqual(['app.txt'])
    expect(restored.deleted).toEqual(['new-file.txt'])
    expect(restored.skipped).toEqual(['user.txt'])
    expect(restored.safetyCheckpointId).toMatch(/^cp-/)
    expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(repo, 'new-file.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'user.txt'), 'utf8')).toBe('user v3 still editing\n')
    expect(statusBefore).toContain('user.txt')

    // A rejected approval leaves files alone.
    writeFileSync(join(repo, 'app.txt'), 'changed again\n')
    const denied = await viaTurn(ctx, session, 'restore_checkpoint', { checkpoint_id: auto!.id, scope: 'all' })
    expect(denied.isError).toBe(true)
    expect(asked).toEqual(['restore_checkpoint', 'restore_checkpoint'])
    expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toBe('changed again\n')

    // Proposals and deletion.
    await run(ctx, session, 'propose_rollback', { checkpoint_id: auto!.id, reason: 'tests broke' })
    expect(ctx.orchestration.checkpoints.get(auto!.id).proposal?.reason).toBe('tests broke')
    expect(ctx.orchestration.notifications().some(notice => notice.text.includes('proposes rolling back'))).toBe(true)
  }, 30_000)

  it('detects loops, injects a recovery protocol instead of stopping, and tracks metrics and outcome', async () => {
    const { ctx } = await setup()
    fakeShell(ctx)
    await lead(ctx)
    const agent = await ctx.mainAgents.create('Looper', {}, { kind: 'user' })
    const session = live(ctx, agent)
    const results: ToolExecutionResult[] = []
    for (let i = 0; i < 3; i++) results.push(await exec(ctx, session, 'bash', { command: 'pnpm test exit:1' }))
    const injected = (results[2]?.additionalContexts ?? []).flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    expect(injected).toContain('[KairoForge loop recovery]')
    expect(injected).toContain('failing-command')
    expect(injected).toContain('Pause the current strategy')
    expect(results[0]?.additionalContexts ?? []).toHaveLength(0)
    // The call itself still ran: the agent is not terminated or blocked.
    expect(results[2]?.isError).toBe(false)
    const [event] = ctx.orchestration.loops()
    expect(event).toMatchObject({ kind: 'failing-command', outcome: 'recovering', agentName: 'Looper' })
    // A different approach for the recovery window counts as recovered.
    for (let i = 0; i < 12; i++) await exec(ctx, session, 'bash', { command: `pnpm vitest run file${String(i)}.spec.ts` })
    await vi.waitFor(() => { expect(ctx.orchestration.loops()[0]?.outcome).toBe('recovered') })
    expect(ctx.orchestration.loopMetrics()).toMatchObject({ detections: 1, recovered: 1, byKind: { 'failing-command': 1 } })
    expect(ctx.orchestration.notifications().some(notice => notice.kind === 'loop')).toBe(true)
  })

  it('keeps the reply tools in Fast Mode while leaving out workflows and outgoing delegation', async () => {
    const { ctx } = await setup()
    await lead(ctx)
    // This harness has no preset registry to compose a mode, so Fast is reported directly.
    const modeOf = ctx.mainAgents.modeOf.bind(ctx.mainAgents)
    vi.spyOn(ctx.mainAgents, 'modeOf').mockImplementation(agent => ctx.mainAgents.recordForSession(agent.session.id)?.name === 'Quick'
      ? 'fast'
      : modeOf(agent))
    const agent = await ctx.mainAgents.create('Quick', { mode: 'fast' }, { kind: 'user' })
    const session = live(ctx, agent)
    await vi.waitFor(async () => { expect(await toolNames(ctx, session)).toContain('return_task_result') })
    const names = await toolNames(ctx, session)
    expect(names).toEqual(expect.arrayContaining(['return_task_result', 'report_task_progress', 'create_checkpoint']))
    expect(names).not.toContain('create_workflow')
    expect(names).not.toContain('delegate_to_main_agent')
    expect(names).not.toContain('request_agent_review')
  })

  it('escalates, without stopping the agent, when a loop recurs after recovery guidance', async () => {
    const { ctx } = await setup()
    fakeShell(ctx)
    await lead(ctx)
    const agent = await ctx.mainAgents.create('Stubborn', {}, { kind: 'user' })
    const session = live(ctx, agent)
    const texts = (result: ToolExecutionResult | undefined) => (result?.additionalContexts ?? [])
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    const results: ToolExecutionResult[] = []
    for (let i = 0; i < 5; i++) results.push(await exec(ctx, session, 'bash', { command: 'pnpm test exit:1' }))
    expect(texts(results[2])).toContain('[KairoForge loop recovery]')
    expect(texts(results[3])).toContain('[KairoForge loop recovery — escalation]')
    expect(texts(results[3])).toContain('stop and report to the user')
    expect(texts(results[4])).toBe('')
    expect(results.every(result => !result.isError)).toBe(true)
    await vi.waitFor(() => { expect(ctx.orchestration.loops()[0]?.outcome).toBe('recurred') })
    expect(ctx.orchestration.notifications().some(notice => notice.text.includes('escalated'))).toBe(true)
  })

  it('guards protected branches and destructive Git commands for managed agents only', async () => {
    const { ctx } = await setup()
    await ctx.plugin(ApprovalService)
    const asked: string[] = []
    ctx.on('approval/request', (request) => {
      asked.push(request.toolName)
      return Promise.resolve('rejected' as ApprovalOutcome)
    })
    const commands = fakeShell(ctx)
    const repo = gitRepo()
    const leadAgent = await lead(ctx)
    const agent = await ctx.mainAgents.create('Pusher', { workspace: repo }, { kind: 'user' })
    const session = live(ctx, agent)
    const force = await exec(ctx, session, 'bash', { command: 'git push --force origin main' })
    expect(force.isError).toBe(true)
    expect(JSON.stringify(force.content)).toContain('protected branch')
    const push = await viaTurn(ctx, session, 'bash', { command: 'git push' })
    expect(push.isError).toBe(true)
    expect(asked).toEqual(['bash'])
    expect(commands).toEqual([])
    const branch = await exec(ctx, session, 'bash', { command: 'git push -u origin kairoforge/feature' })
    expect(branch.isError).toBe(false)
    expect(commands).toEqual(['git push -u origin kairoforge/feature'])
    // Lead keeps its existing behaviour.
    const leadPush = await exec(ctx, leadAgent, 'bash', { command: 'git push --force origin main' })
    expect(leadPush.isError).toBe(false)
  })

  it('delegates between main agents with depth, ownership, cycle rejection, and result return', async () => {
    const { ctx } = await setup()
    const leadAgent = await lead(ctx)
    await ctx.orchestration.updateSettings({ delegation: { maxDepth: 2 } })
    const alpha = await ctx.mainAgents.create('Alpha', {}, { kind: 'user' })
    const beta = await ctx.mainAgents.create('Beta', {}, { kind: 'user' })
    await ctx.mainAgents.create('Gamma', {}, { kind: 'user' })
    const alphaSession = live(ctx, alpha)
    const betaSession = live(ctx, beta)

    const first = await run<{ delegation_id: string; depth: number }>(ctx, leadAgent, 'delegate_to_main_agent', { agent_id: 'alpha', task: 'Build the parser.' })
    expect(first.depth).toBe(1)
    await vi.waitFor(() => { expect(userTexts(alphaSession).join('\n')).toContain(`Delegation: ${first.delegation_id} (depth 1 of 2)`) })

    const nested = await run<{ delegation_id: string; depth: number }>(ctx, alphaSession, 'request_agent_review', { agent_id: 'beta', subject: 'parser', details: 'Review the parser diff.' })
    expect(nested.depth).toBe(2)
    await vi.waitFor(() => { expect(userTexts(betaSession).join('\n')).toContain('[KairoForge review request]') })
    await expect(run(ctx, betaSession, 'delegate_to_main_agent', { agent_id: 'alpha', task: 'loop back' })).rejects.toThrow(/depth|cycle/)
    await expect(run(ctx, betaSession, 'delegate_to_main_agent', { agent_id: 'gamma', task: 'go deeper' })).rejects.toThrow(/depth 3 exceeds the limit of 2/)
    await ctx.orchestration.updateSettings({ delegation: { maxDepth: 3 } })
    await expect(run(ctx, betaSession, 'delegate_to_main_agent', { agent_id: 'alpha', task: 'loop back' })).rejects.toThrow(/cycle/)

    // Ownership: only the delegatee returns the result.
    await expect(run(ctx, leadAgent, 'return_task_result', { delegation_id: first.delegation_id, result: 'x' })).rejects.toThrow(/owned by "Alpha"/)
    await run(ctx, betaSession, 'return_task_result', { delegation_id: nested.delegation_id, result: 'Looks good.' })
    await vi.waitFor(() => { expect(userTexts(alphaSession).join('\n')).toContain(`[KairoForge task result] Review ${nested.delegation_id} completed by Beta`) })
    await run(ctx, alphaSession, 'return_task_result', { delegation_id: first.delegation_id, result: 'Parser built and reviewed.' })
    await vi.waitFor(() => { expect(userTexts(leadAgent).join('\n')).toContain('Parser built and reviewed.') })
    const records = ctx.orchestration.delegations.list()
    expect(records.find(record => record.id === nested.delegation_id)).toMatchObject({ rootId: first.delegation_id, parentId: first.delegation_id, status: 'completed' })

    // The legacy delegate_task tool is tracked too.
    const legacy = await run<{ delegation_id: string }>(ctx, leadAgent, 'delegate_task', { agent_id: 'gamma', task: 'Count lines.' })
    expect(legacy.delegation_id).toMatch(/^dl-/)
  }, 30_000)

  it('runs background tasks host-side with pause, resume, cancel, notification, and restart resume', async () => {
    const first = await setup()
    const leadAgent = await lead(first.ctx)
    await first.ctx.mainAgents.create('Worker Bee', {}, { kind: 'user' })
    const task = await run<{ id: string }>(first.ctx, leadAgent, 'start_background_task', { agent_id: 'worker-bee', title: 'Count', prompt: 'Count the files.' })
    await vi.waitFor(() => { expect(first.ctx.orchestration.background.get(task.id).status).toBe('completed') }, { timeout: 10_000 })
    expect(first.ctx.orchestration.background.get(task.id).result).toBe('BG DONE')
    // The creating Session is notified with the result.
    await vi.waitFor(() => { expect(userTexts(leadAgent).join('\n')).toContain(`[KairoForge background task completed] Count (${task.id})`) })

    const long = await first.ctx.orchestration.background.create({ agentId: 'worker-bee', title: 'Long', prompt: 'hang forever' }, { sessionId: 'user', name: 'the user' })
    await vi.waitFor(() => { expect(first.ctx.orchestration.background.get(long.id).status).toBe('running') })
    expect((await first.ctx.orchestration.background.pause(long.id)).status).toBe('paused')
    expect((await first.ctx.orchestration.background.resume(long.id)).status).toBe('queued')
    await vi.waitFor(() => { expect(first.ctx.orchestration.background.get(long.id).status).toBe('running') })
    expect((await first.ctx.orchestration.background.cancel(long.id)).status).toBe('cancelled')

    // A task that was running when the host stopped resumes after restart.
    const interrupted = await first.ctx.orchestration.background.create({ agentId: 'worker-bee', title: 'Survivor', prompt: 'hang forever' }, { sessionId: 'user', name: 'the user' })
    await vi.waitFor(() => { expect(first.ctx.orchestration.background.get(interrupted.id).status).toBe('running') })
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await setup({
      paths: first.paths,
      decide: options => lastUserText(options).includes('resumed') ? textResponse('RESUMED DONE') : textResponse('ok'),
    })
    await vi.waitFor(() => { expect(second.ctx.orchestration.background.get(interrupted.id).status).toBe('completed') }, { timeout: 10_000 })
    expect(second.ctx.orchestration.background.get(interrupted.id)).toMatchObject({ result: 'RESUMED DONE', resumedAfterRestart: 1 })
    expect(second.ctx.orchestration.background.get(task.id).status).toBe('completed')
    expect(second.ctx.orchestration.background.get(long.id).status).toBe('cancelled')
  }, 30_000)

  it('routes models by category when configured, explains the choice, and can be disabled', async () => {
    const { ctx, adapter } = await setup()
    await lead(ctx)
    const agent = await ctx.mainAgents.create('Router', {}, { kind: 'user' })
    const session = live(ctx, agent)
    await ctx.orchestration.updateSettings({ routing: { categories: { FAST: { provider: 'mock', model: 'fast-model' } } } })
    await ctx.mainAgents.sendMessage('router', 'hi', { kind: 'user' })
    await vi.waitFor(() => { expect(adapter.requests.some(request => request.model === 'fast-model')).toBe(true) }, { timeout: 5000 })
    await session.whenIdle()
    expect(ctx.orchestration.routeOf(session.session.id)).toMatchObject({ category: 'FAST', provider: 'mock', model: 'fast-model', routed: true })

    await ctx.orchestration.updateSettings({ routing: { enabled: false } })
    const before = adapter.requests.length
    await ctx.mainAgents.sendMessage('router', 'hello again', { kind: 'user' })
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThan(before) })
    await session.whenIdle()
    // The Session's own model comes back even though the last logged request header carried the routed one.
    expect(adapter.requests.slice(before).map(request => request.model)).toEqual(['main'])
    expect(ctx.orchestration.routeOf(session.session.id)).toMatchObject({ routed: false, reason: 'routing disabled; using the session model' })

    // A per-agent override pins a category.
    await ctx.orchestration.updateSettings({ routing: { enabled: true, categories: { REVIEW: { provider: 'mock', model: 'review-model' } } } })
    await ctx.orchestration.setMeta('router', { routing: 'REVIEW' })
    const mark = adapter.requests.length
    await ctx.mainAgents.sendMessage('router', 'hi', { kind: 'user' })
    await vi.waitFor(() => { expect(adapter.requests.slice(mark).some(request => request.model === 'review-model')).toBe(true) })
  }, 20_000)

  it('seeds the KairoForge Engineer once, stopped, with contained permissions', async () => {
    const first = await setup({ engineer: true })
    await vi.waitFor(async () => { expect((await first.ctx.mainAgents.list()).map(agent => agent.name)).toContain('KairoForge Engineer') })
    const engineer = (await first.ctx.mainAgents.list()).find(agent => agent.name === 'KairoForge Engineer')
    expect(engineer).toMatchObject({ status: 'stopped', mode: 'standard', permissions: { preset: 'workspace-write', agentAdministration: false } })
    expect(engineer?.instructions).toContain('PREPARE CHANGE')
    expect(first.ctx.orchestration.meta(engineer!.id).template).toBe('engineer')
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const second = await setup({ paths: first.paths, engineer: true })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect((await second.ctx.mainAgents.list()).filter(agent => agent.name.startsWith('KairoForge Engineer'))).toHaveLength(1)
  })

  it('reports an agent dashboard and the orchestration tree with live state', async () => {
    const { ctx } = await setup()
    fakeShell(ctx)
    const leadAgent = await lead(ctx)
    const agent = await ctx.mainAgents.create('Observer', {}, { kind: 'user' })
    const session = live(ctx, agent)
    await exec(ctx, session, 'bash', { command: 'ls -la token=abcdef123456' })
    await ctx.mainAgents.createTeam('observer', [{ name: 'helper', description: 'helps', prompt: 'say hi' }], { kind: 'user' }, SIGNAL)
    await ctx.mainAgents.sendMessage('observer', 'status?', { kind: 'user' })
    await session.whenIdle()
    const dashboard = await agentDashboard(ctx.orchestration, 'observer')
    expect(dashboard.recentTools[0]).toMatchObject({ name: 'bash', ok: true })
    expect(dashboard.recentTools[0]?.summary).not.toContain('abcdef123456')
    expect(dashboard.subAgents.map(member => member.name)).toEqual(['helper'])
    expect(dashboard.live.provider).toBe('mock')
    expect(dashboard.live.tools).toContain('create_workflow')
    expect(dashboard.activity.length).toBeGreaterThan(0)
    const state = await orchestrationState(ctx.orchestration)
    const root = state.tree[0]
    const observer = root?.children.find(node => node.agentId === 'observer')
    expect(observer?.children.map(node => node.name)).toEqual(['helper'])
    expect(root?.children.some(node => node.sessionId === leadAgent.session.id)).toBe(true)
  }, 20_000)
})
