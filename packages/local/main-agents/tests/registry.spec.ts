import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
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
import { ADMIN_TOOLS, COMMUNICATION_TOOLS, approvalReason } from '../src/index.ts'
import type { MainAgentView } from '../src/index.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

/** Session query whose search faces are outside these tests. */
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

interface Roots {
  readonly sessions: string
  readonly storage: string
}

function freshRoots(): Roots {
  const sessions = mkdtempSync(join(tmpdir(), 'main-agents-sessions-'))
  const storage = mkdtempSync(join(tmpdir(), 'main-agents-storage-'))
  roots.push(sessions, storage)
  return { sessions, storage }
}

/**
 * Session controller stand-in over the real agent loop: ordinary root Sessions
 * are created, resumed from JSONL persistence, and prompted exactly like the
 * Web controller does for these operations.
 */
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
    selected: [] as unknown[],
    async create(request: { sessionId: SessionId; cwd?: string; agentPreset?: string }) {
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
    selectModel(request: unknown) {
      this.selected.push(request)
      return Promise.resolve({ selected: request })
    },
    rename() {
      return Promise.resolve({ title: '', seq: 0 })
    },
    modelCatalog() {
      return Promise.resolve({ groups: [] })
    },
  }
}

/** Lead turns consume planned responses; every other Session answers with plain text. */
function adapter(planned: Array<ReturnType<typeof textResponse>>) {
  const respond = (options: GenerateOptions) => options.model === 'lead'
    ? planned.shift() ?? textResponse('lead done')
    : textResponse('main agent ok')
  return new MockAdapter(Array.from({ length: 200 }, () => respond))
}

async function setup(paths: Roots = freshRoots(), planned: Array<ReturnType<typeof textResponse>> = []) {
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
  const controller = sessionController(ctx)
  ctx.provide('sessionController', controller as never)
  ctx.llm.registerAdapter(['mock'], adapter(planned))
  await ctx.plugin(mainAgents, {
    administratorModes: ['cordis', 'standard'],
    defaultMode: 'standard',
    defaultPermissionPreset: 'workspace-write',
    teamProvider: 'spawn',
    orchestration: true,
    engineer: false,
    toolFreeModes: ['chat', 'minimal'],
  })
  await vi.waitFor(() => { expect(ctx.get('mainAgents')).toBeDefined() })
  await ctx.mainAgents.whenReady()
  return { ctx, controller, paths }
}

async function lead(ctx: Context, id = 'lead-session'): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'lead' })
  await vi.waitFor(async () => { expect(await toolNames(ctx, agent)).toContain('list_main_agents') })
  return agent
}

async function toolNames(ctx: Context, agent: Agent): Promise<string[]> {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return (await ctx.systemPrompt.assemble({ scope })).tools.map(tool => tool.name)
}

async function systemText(ctx: Context, agent: Agent): Promise<string> {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return JSON.stringify(await ctx.systemPrompt.assemble({ scope }))
}

async function run<T>(ctx: Context, agent: Agent, name: string, args: unknown): Promise<T> {
  const result = await ctx.tools.execute({ callId: ToolCallId(`main-agent-call-${++callNumber}`), name, arguments: args, signal: SIGNAL, agent })
  const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  if (result.isError ?? false) throw new Error(text)
  return JSON.parse(text) as T
}

function userTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'user/message'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

function liveAgent(ctx: Context, view: MainAgentView): Agent {
  const agent = view.sessionId === undefined ? undefined : ctx.agents.get(SessionId(view.sessionId))
  if (agent === undefined) throw new Error(`main agent ${view.id} has no live Session`)
  return agent
}

describe('@local/main-agents', () => {
  it('persists a main agent and its Session across a restart', async () => {
    const first = await setup()
    const leadAgent = await lead(first.ctx)
    const created = await run<MainAgentView>(first.ctx, leadAgent, 'create_main_agent', {
      name: 'Research Scout',
      config: { description: 'Finds sources', instructions: 'Cite every source.', mode: 'standard' },
    })
    expect(created).toMatchObject({
      id: 'research-scout',
      name: 'Research Scout',
      status: 'running',
      mode: 'standard',
      permissions: { preset: 'workspace-write', agentAdministration: false },
    })
    expect(created.sessionId).toMatch(/^session-/)
    const firstSession = liveAgent(first.ctx, created)
    expect(firstSession.session.header.origin).toBeUndefined()
    expect(await systemText(first.ctx, firstSession)).toContain('You are \\"Research Scout\\", a persistent KairoForge main agent')
    await run(first.ctx, leadAgent, 'send_agent_message', { agent_id: 'research-scout', message: 'Collect sources.' })
    await vi.waitFor(() => { expect(userTexts(firstSession).join('\n')).toContain('Collect sources.') })
    await firstSession.whenIdle()

    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await setup(first.paths)
    const listed = await second.ctx.mainAgents.list()
    expect(listed.map(agent => [agent.id, agent.sessionId, agent.status])).toEqual([['research-scout', created.sessionId, 'running']])
    expect(listed[0]?.runtime).toBe('unloaded')
    const started = await second.ctx.mainAgents.start('Research Scout', { kind: 'user' })
    expect(started.sessionId).toBe(created.sessionId)
    const resumed = liveAgent(second.ctx, started)
    expect(userTexts(resumed).join('\n')).toContain('Collect sources.')
    await vi.waitFor(async () => { expect(await systemText(second.ctx, resumed)).toContain('Cite every source.') })
  })

  it('rebinds a never-used Session that persistence did not keep', async () => {
    const first = await setup()
    const created = await first.ctx.mainAgents.create('Blank Slate', {}, { kind: 'user' })
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await setup(first.paths)
    const started = await second.ctx.mainAgents.start('blank-slate', { kind: 'user' })
    expect(started.status).toBe('running')
    expect(started.sessionId).toBeDefined()
    liveAgent(second.ctx, started)
    expect(started.sessionId === created.sessionId || started.previousSessionIds.includes(created.sessionId!)).toBe(true)
  })

  it('lets a main agent create its own sub-agent teammate', async () => {
    const { ctx } = await setup()
    const children: Agent[] = []
    ctx.on('agent/created', ({ agent }) => { if (agent.session.header.origin === 'subagent') children.push(agent) })
    const leadAgent = await lead(ctx)
    const created = await run<MainAgentView>(ctx, leadAgent, 'create_main_agent', { name: 'Builder Two' })
    const team = await run<{ created: string[]; members: Array<{ name: string; role: string }> }>(
      ctx, leadAgent, 'create_agent_team',
      { agent_id: 'builder-two', members: [{ name: 'tester', description: 'Runs tests', prompt: 'Run the unit tests.' }] },
    )
    expect(team.created).toEqual(['tester'])
    expect(team.members.map(member => [member.name, member.role])).toEqual([['lead', 'lead'], ['tester', 'teammate']])

    const mainSession = liveAgent(ctx, created)
    const teammate = ctx.agentTeams.listMembers(mainSession).find(member => member.name === 'tester')
    expect(teammate).toBeDefined()
    const child = children.find(agent => agent.session.header.id === teammate!.id)
    expect(child).toBeDefined()
    expect(child!.session.header.parentSession).toBe(created.sessionId)
    // The teammate belongs to the main agent's team, not Lead's.
    expect(ctx.agentTeams.listMembers(leadAgent).map(member => member.name)).toEqual(['lead'])
    // Sub-agents are never administrators and never become main agents.
    expect(mainAgents.isTopLevelSession(child!.session.header)).toBe(false)
    expect(ctx.mainAgents.canAdminister(child!)).toBe(false)
    expect(ctx.mainAgents.recordForSession(child!.session.header.id)).toBeUndefined()
  })

  it('carries messages between Lead and a main agent in both directions', async () => {
    const { ctx } = await setup()
    const leadAgent = await lead(ctx)
    const created = await run<MainAgentView>(ctx, leadAgent, 'create_main_agent', { name: 'Analyst' })
    const mainSession = liveAgent(ctx, created)

    const delivery = await run<{ status: string; sessionId: string }>(ctx, leadAgent, 'send_agent_message', {
      agent_id: 'analyst',
      message: 'Please summarize the release notes.',
    })
    expect(delivery).toMatchObject({ status: 'accepted', sessionId: created.sessionId })
    await vi.waitFor(() => {
      const received = userTexts(mainSession).join('\n')
      expect(received).toContain('[KairoForge agent message]')
      expect(received).toContain('From: Lead (Session lead-session)')
      expect(received).toContain('Please summarize the release notes.')
    })

    const task = await run<{ status: string }>(ctx, leadAgent, 'delegate_task', { agent_id: 'Analyst', task: 'Draft the changelog.' })
    expect(task.status).toBe('accepted')
    await vi.waitFor(() => { expect(userTexts(mainSession).join('\n')).toContain('[KairoForge delegated task]') })

    await mainSession.whenIdle()
    await run(ctx, mainSession, 'send_agent_message', { agent_id: 'lead-session', message: 'Changelog drafted.' })
    await vi.waitFor(() => {
      const received = userTexts(leadAgent).join('\n')
      expect(received).toContain('From: Analyst (Session')
      expect(received).toContain('Changelog drafted.')
    })
  })

  it('installs admin tools only for Agent Administration holders', async () => {
    const { ctx } = await setup()
    const leadAgent = await lead(ctx)
    expect(await toolNames(ctx, leadAgent)).toEqual(expect.arrayContaining([...COMMUNICATION_TOOLS, ...ADMIN_TOOLS]))

    const plain = await run<MainAgentView>(ctx, leadAgent, 'create_main_agent', { name: 'Plain' })
    const plainSession = liveAgent(ctx, plain)
    await vi.waitFor(async () => { expect(await toolNames(ctx, plainSession)).toContain('send_agent_message') })
    const plainTools = await toolNames(ctx, plainSession)
    expect(plainTools).toEqual(expect.arrayContaining([...COMMUNICATION_TOOLS]))
    expect(plainTools.some(name => (ADMIN_TOOLS as readonly string[]).includes(name))).toBe(false)

    await ctx.mainAgents.managePermissions('plain', { agentAdministration: true }, { kind: 'user' })
    await vi.waitFor(async () => { expect(await toolNames(ctx, plainSession)).toContain('create_main_agent') })

    await ctx.mainAgents.updateSettings({ administratorModes: ['cordis'] })
    ctx.emit('main-agents/changed', (await ctx.mainAgents.get('plain')))
    await vi.waitFor(async () => { expect(await toolNames(ctx, leadAgent)).not.toContain('create_main_agent') })
    expect(await toolNames(ctx, leadAgent)).toContain('send_agent_message')
  })

  it('applies tool restrictions while keeping communication and team tools', async () => {
    const { ctx } = await setup()
    ctx.tools.register(defineTool({
      name: 'global_probe',
      description: 'A global tool outside the allow list.',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: () => Promise.resolve({ ok: true }),
    }))
    const leadAgent = await lead(ctx)
    const created = await run<MainAgentView>(ctx, leadAgent, 'create_main_agent', {
      name: 'Narrow',
      config: { tools: { allow: ['list_main_agents'], deny: ['delegate_task'] } },
    })
    const session = liveAgent(ctx, created)
    await vi.waitFor(async () => {
      const names = await toolNames(ctx, session)
      expect(names).toContain('send_agent_message')
      expect(names).not.toContain('global_probe')
    })
    expect(await toolNames(ctx, leadAgent)).toContain('global_probe')
    await expect(run(ctx, session, 'delegate_task', { agent_id: 'lead-session', task: 'x' })).rejects.toThrow(/denied for main agent "Narrow"/)
    await expect(run(ctx, session, 'global_probe', {})).rejects.toThrow()
    const listed = await run<MainAgentView[]>(ctx, session, 'list_main_agents', {})
    expect(listed.map(agent => agent.id)).toEqual(['narrow'])
  })

  it('stops, refuses work while stopped, restarts, clones, and archives', async () => {
    const { ctx } = await setup()
    const leadAgent = await lead(ctx)
    await run(ctx, leadAgent, 'create_main_agent', { name: 'Worker', config: { instructions: 'Be brief.' } })
    const stopped = await run<MainAgentView>(ctx, leadAgent, 'stop_main_agent', { agent_id: 'worker' })
    expect(stopped.status).toBe('stopped')
    await expect(run(ctx, leadAgent, 'send_agent_message', { agent_id: 'worker', message: 'hi' })).rejects.toThrow(/stopped/)
    const restarted = await run<MainAgentView>(ctx, leadAgent, 'restart_main_agent', { agent_id: 'worker' })
    expect(restarted.status).toBe('running')

    const clone = await run<MainAgentView>(ctx, leadAgent, 'clone_main_agent', { agent_id: 'worker', new_name: 'Worker Copy' })
    expect(clone).toMatchObject({ id: 'worker-copy', instructions: 'Be brief.', status: 'running' })
    expect(clone.sessionId).not.toBe(restarted.sessionId)

    const archived = await ctx.mainAgents.archive('worker-copy', { kind: 'user' })
    expect(archived.status).toBe('archived')
    expect((await ctx.mainAgents.list()).map(agent => agent.id)).toEqual(['worker'])
    expect((await ctx.mainAgents.list(true)).map(agent => agent.id)).toEqual(['worker', 'worker-copy'])
    await expect(run(ctx, leadAgent, 'create_main_agent', { name: 'worker' })).rejects.toThrow(/already exists/)
    await expect(run(ctx, leadAgent, 'create_main_agent', { name: 'Lead' })).rejects.toThrow(/reserved/)
  })

  it('starts a new Session on a mode change and keeps the old one', async () => {
    const { ctx } = await setup()
    const leadAgent = await lead(ctx)
    const created = await run<MainAgentView>(ctx, leadAgent, 'create_main_agent', { name: 'Shifter' })
    const changed = await run<MainAgentView>(ctx, leadAgent, 'assign_mode', { agent_id: 'shifter', mode: 'cordis' })
    expect(changed.mode).toBe('cordis')
    expect(changed.sessionId).not.toBe(created.sessionId)
    expect(changed.previousSessionIds).toEqual([created.sessionId])
  })

  it('assigns a model without changing the default', async () => {
    const { ctx, controller } = await setup()
    const leadAgent = await lead(ctx)
    await run(ctx, leadAgent, 'create_main_agent', { name: 'Modeler' })
    const assigned = await run<MainAgentView>(ctx, leadAgent, 'assign_model', { agent_id: 'modeler', provider: 'mock', model: 'main-2' })
    expect(assigned.model).toEqual({ provider: 'mock', model: 'main-2' })
    expect(controller.selected).toEqual([{ sessionId: assigned.sessionId, provider: 'mock', model: 'main-2' }])
  })

  it('requires user approval before archiving through a model tool call', async () => {
    const planned = [
      toolCallResponse('archive-1', 'archive_main_agent', { agent_id: 'target' }),
      textResponse('tried'),
      toolCallResponse('archive-2', 'archive_main_agent', { agent_id: 'target' }),
      textResponse('archived'),
    ]
    const { ctx } = await setup(freshRoots(), planned)
    await ctx.plugin(ApprovalService)
    const answers: ApprovalOutcome[] = ['rejected', 'allowed-once']
    const asked: string[] = []
    ctx.on('approval/request', (request) => {
      asked.push(request.toolName)
      return Promise.resolve(answers.shift() ?? 'rejected')
    })
    const leadAgent = await lead(ctx)
    await ctx.mainAgents.create('Target', {}, { kind: 'user' })

    leadAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'archive target' }], source: { kind: 'user' } }))
    await leadAgent.whenIdle()
    expect(asked).toEqual(['archive_main_agent'])
    expect((await ctx.mainAgents.get('target')).status).toBe('running')

    leadAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'archive target again' }], source: { kind: 'user' } }))
    await leadAgent.whenIdle()
    expect(asked).toEqual(['archive_main_agent', 'archive_main_agent'])
    expect((await ctx.mainAgents.get('target')).status).toBe('archived')
  })

  it('classifies which admin calls need approval', () => {
    expect(approvalReason('archive_main_agent', {})).toBeDefined()
    expect(approvalReason('manage_agent_permissions', {})).toBeDefined()
    expect(approvalReason('assign_workspace', {})).toBeDefined()
    expect(approvalReason('create_main_agent', { name: 'x' })).toBeUndefined()
    expect(approvalReason('create_main_agent', { name: 'x', config: { permissions: { agentAdministration: true } } })).toBeDefined()
    expect(approvalReason('create_main_agent', { name: 'x', config: { permissions: { preset: 'danger-full-access' } } })).toBeDefined()
    expect(approvalReason('create_main_agent', { name: 'x', config: { permissions: { preset: 'read-only' } } })).toBeUndefined()
    expect(approvalReason('edit_main_agent', { agent_id: 'x', changes: { tools: { allow: [] } } })).toBeDefined()
    expect(approvalReason('start_main_agent', { agent_id: 'x' })).toBeUndefined()
  })
})
