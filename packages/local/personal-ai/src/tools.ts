/**
 * Coordinator installation. Lead Sessions (the coordinator modes) receive the
 * coordinator prompt built from the personality, a per-turn runtime context
 * (depth hint, active project, relevant memories, running work), and the
 * Personal AI tools. Main-agent Sessions receive agent-scoped memory only.
 * Every tool call still passes the normal `tools/pre-execute` permission path.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isTopLevelSession } from '@local/main-agents'
import { AGENT_TAGS, groupTools, proposeAgent, type AgentTag } from './core/capabilities.ts'
import { DEPTH_GUIDANCE } from './core/classifier.ts'
import { MEMORY_SCOPES, relevantMemories, type MemoryScope } from './core/memory.ts'
import type { Config } from './index.ts'
import type { PersonalAi } from './service.ts'
import type { ControlAction, Personality, TaskRef } from './types.ts'

/** Memory tools. */
export const MEMORY_TOOLS = ['remember', 'recall', 'update_memory', 'forget'] as const
/** Project tools. */
export const PROJECT_TOOLS = ['create_project', 'open_project', 'update_project', 'archive_project', 'assign_agent_to_project', 'project_status', 'list_projects'] as const
/** Task-control tools. */
export const CONTROL_TOOLS = ['pause_task', 'resume_task', 'cancel_task', 'update_task', 'add_task_constraint'] as const
/** Agent-selection tools. */
export const AGENT_TOOLS = ['recommend_agent', 'propose_agent', 'list_capabilities'] as const

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

const VERBOSITY: Readonly<Record<Personality['verbosity'], string>> = {
  brief: 'Keep replies short: a sentence or two unless the user asks for more.',
  balanced: 'Be concise but complete; lead with the answer.',
  detailed: 'Give thorough answers with the reasoning the user needs (not your private chain of thought).',
}

/**
 * Coordinator prompt section for one personality.
 * @param personality - effective personality.
 * @returns prompt text.
 */
export function coordinatorPrompt(personality: Personality): string {
  const lines = [
    `You are ${personality.name}, the user's personal AI inside KairoForge. You are the coordinator: answer simple things yourself, use tools when a task needs them, and hand larger work to main agents, workflows, or background tasks.`,
    `Speaking style: ${personality.speakingStyle}. ${VERBOSITY[personality.verbosity]}`,
  ]
  if (personality.instructions.trim() !== '') lines.push('', 'The user\'s standing instructions:', personality.instructions.trim())
  lines.push(
    '',
    'Choosing depth: each request comes with a "Coordinator hint" in the runtime context. Follow it unless the work clearly needs more:',
    ...Object.entries(DEPTH_GUIDANCE).map(([depth, text]) => `- ${depth}: ${text}`),
    'A greeting or a simple question never starts agents, workflows, or background tasks.',
    '',
    'Honesty: never say something is done unless a tool result shows it; report failures plainly with what you observed. Share conclusions and evidence, not private reasoning.',
    'Memory: use recall before asking for something the user may have told you. Use remember only for durable facts and preferences worth keeping; saving a memory about the user asks them first. Never store passwords, API keys, tokens, or other secrets — say so and point to KairoForge\'s credential settings.',
    'Projects: the active project\'s known facts are in the runtime context. Never guess build commands or configuration; verify by reading files, then record what you verified with update_project.',
    'Running work: when the user asks to pause, stop, change, or constrain running work, use pause_task, resume_task, cancel_task, update_task, or add_task_constraint, and report the returned outcome exactly (applied, delivered, or rejected). Never resume possibly destructive work without checking its state first.',
    'Agents: recommend_agent ranks main agents for a task; if the user names a different agent, theirs wins. propose_agent drafts a new agent — show the proposal and create it with create_main_agent only after the user agrees.',
    'Computer control and sensitive actions go through KairoForge\'s normal approval prompts. If something is denied, do not look for a way around it.',
  )
  return lines.join('\n')
}

/**
 * Install the coordinator on Lead Sessions and agent memory on main agents.
 * @param ctx - Host context.
 * @param service - Personal AI service.
 * @param config - plugin configuration.
 */
export function installPersonalAiTools(ctx: Context, service: PersonalAi, config: Config): void {
  type Role = 'coordinator' | 'observed' | 'agent'
  const installed = new Map<Agent, { readonly key: string; readonly dispose: () => void }>()

  const caller = (agent: Agent | undefined, tool: string): Agent => {
    /* v8 ignore next -- scoped tools are discovered only with their calling Agent. */
    if (agent === undefined) throw new Error(`${tool} requires a calling Agent`)
    return agent
  }

  type ScopeIds = { project?: string; agent?: string; session: string }
  const pickScopeId = (scope: MemoryScope | undefined, ids: ScopeIds): string | undefined =>
    scope === 'project' ? ids.project : scope === 'agent' ? ids.agent : scope === 'session' ? ids.session : undefined

  const memoryTools = (defaultScope: MemoryScope, scopeIdOf: (agent: Agent) => ScopeIds): unknown[] => [
    defineTool({
      name: 'remember',
      description: 'Save a durable memory. scope "user" (the user\'s preferences and facts; asks the user first), "project" (the active project), "agent" (your own working knowledge), or "session" (this chat only). Secrets are refused.',
      parameters: {
        text: { type: 'string', required: true, description: 'One self-contained fact or preference.' },
        scope: { type: 'string', enum: [...MEMORY_SCOPES], description: `Defaults to "${defaultScope}".` },
        tags: { type: 'array', items: { type: 'string' } },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const self = caller(exec.agent, 'remember')
        const scope = args.scope ?? defaultScope
        const scopeId = pickScopeId(scope, scopeIdOf(self))
        if (scope === 'project' && scopeId === undefined) return toJson({ error: 'No active project. Open a project first or use scope "user".' })
        if (scope === 'agent' && scopeId === undefined) return toJson({ error: 'Agent memory is for main agents; use scope "user" or "project".' })
        const entry = await service.remember({
          scope,
          ...scopeId === undefined ? {} : { scopeId },
          text: args.text,
          ...args.tags === undefined ? {} : { tags: args.tags },
        }, self.session.id)
        return toJson({ saved: entry.id, scope: entry.scope, text: entry.text })
      },
    }),
    defineTool({
      name: 'recall',
      description: 'Search saved memories (user preferences, project facts, agent notes). Returns the best matches.',
      parameters: {
        query: { type: 'string', description: 'What to look for. Omit for the newest memories.' },
        scope: { type: 'string', enum: [...MEMORY_SCOPES] },
      },
      output: JSON_OUTPUT,
      execute(args, exec) {
        const self = caller(exec.agent, 'recall')
        const ids = scopeIdOf(self)
        const scope = args.scope
        const scopeId = pickScopeId(scope, ids)
        const rows = service.memories({
          ...args.query === undefined ? {} : { text: args.query },
          ...scope === undefined ? {} : { scope },
          ...scopeId === undefined ? {} : { scopeId },
          limit: 12,
        }).filter(entry => entry.scope === 'user' || entry.scopeId === ids.project || entry.scopeId === ids.agent || entry.scopeId === ids.session)
        return Promise.resolve(toJson(rows.map(entry => ({
          id: entry.id, scope: entry.scope, text: entry.text, tags: entry.tags, updatedAt: entry.updatedAt,
        }))))
      },
    }),
    defineTool({
      name: 'update_memory',
      description: 'Correct a memory\'s text, or disable/re-enable it.',
      parameters: {
        memory_id: { type: 'string', required: true },
        text: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled'] },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const entry = await service.updateMemory(args.memory_id, {
          ...args.text === undefined ? {} : { text: args.text },
          ...args.status === undefined ? {} : { status: args.status },
        })
        return toJson({ id: entry.id, text: entry.text, status: entry.status })
      },
    }),
    defineTool({
      name: 'forget',
      description: 'Delete a memory permanently. Asks the user first.',
      parameters: { memory_id: { type: 'string', required: true } },
      output: JSON_OUTPUT,
      async execute(args) {
        const entry = await service.forget(args.memory_id)
        return toJson({ deleted: entry.id, text: entry.text })
      },
    }),
  ]

  const taskRef = { type: 'string', required: true, enum: ['background', 'workflow', 'session'], description: '"background" task, "workflow", or a running chat "session" (a main agent id or name works).' } as const
  const controlTool = (name: string, action: ControlAction, description: string, needsText: boolean): unknown => defineTool({
    name,
    description,
    parameters: {
      kind: taskRef,
      id: { type: 'string', required: true, description: 'Task, workflow, Session, or main agent id.' },
      ...needsText ? { text: { type: 'string', required: true, description: action === 'constrain' ? 'The constraint, e.g. "do not touch the database schema".' : 'The new or changed instruction.' } } : {},
    },
    output: JSON_OUTPUT,
    async execute(args: { kind: string; id: string; text?: string }, exec: { agent?: Agent }) {
      const self = caller(exec.agent, name)
      const ref: TaskRef = { kind: args.kind as TaskRef['kind'], id: args.id }
      return toJson(await service.control(ref, action, args.text, self.session.id))
    },
  } as never)

  const coordinatorTools = (agent: Agent): unknown[] => [
    ...memoryTools('user', self => ({ ...projectId(), session: self.session.id })),
    defineTool({
      name: 'list_projects',
      description: 'List registered projects (most recently used first) and which one is active.',
      parameters: { include_archived: { type: 'boolean' } },
      output: JSON_OUTPUT,
      execute(args) {
        const active = service.activeProject()?.id
        return Promise.resolve(toJson(service.projects(args.include_archived ?? false).map(project => ({
          id: project.id,
          name: project.name,
          path: project.path,
          status: project.status,
          active: project.id === active,
          agents: project.agentIds.length,
        }))))
      },
    }),
    defineTool({
      name: 'create_project',
      description: 'Register a project. Give only facts you verified (path, stack, commands); leave unknown fields out rather than guessing.',
      parameters: {
        name: { type: 'string', required: true },
        path: { type: 'string', description: 'Absolute directory.' },
        description: { type: 'string' },
        stack: { type: 'array', items: { type: 'string' } },
        commands: {
          type: 'object', additionalProperties: false,
          properties: { dev: { type: 'string' }, build: { type: 'string' }, test: { type: 'string' }, lint: { type: 'string' } },
        },
        open: { type: 'boolean', description: 'Make it the active project. Defaults to true.' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const project = await service.createProject({
          name: args.name,
          ...args.path === undefined ? {} : { path: args.path },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.stack === undefined ? {} : { stack: args.stack },
          ...args.commands === undefined ? {} : { commands: compact(args.commands) },
        })
        if (args.open !== false) await service.openProject(project.id)
        return toJson({ id: project.id, name: project.name, active: args.open !== false })
      },
    }),
    defineTool({
      name: 'open_project',
      description: 'Make a project the active one; its facts and memories join your context.',
      parameters: { project: { type: 'string', required: true, description: 'Project id or name.' } },
      output: JSON_OUTPUT,
      async execute(args) {
        const project = await service.openProject(args.project)
        return toJson({ active: project.id, name: project.name, path: project.path, stack: project.stack, commands: project.commands })
      },
    }),
    defineTool({
      name: 'update_project',
      description: 'Change verified project facts or record a decision in the project\'s decision log.',
      parameters: {
        project: { type: 'string', required: true },
        description: { type: 'string' },
        path: { type: 'string' },
        stack: { type: 'array', items: { type: 'string' } },
        commands: {
          type: 'object', additionalProperties: false,
          properties: { dev: { type: 'string' }, build: { type: 'string' }, test: { type: 'string' }, lint: { type: 'string' } },
        },
        docs: { type: 'array', items: { type: 'string' } },
        decision: { type: 'string', description: 'A decision to append to the log.' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const project = await service.updateProject(args.project, {
          ...args.description === undefined ? {} : { description: args.description },
          ...args.path === undefined ? {} : { path: args.path },
          ...args.stack === undefined ? {} : { stack: args.stack },
          ...args.commands === undefined ? {} : { commands: compact(args.commands) },
          ...args.docs === undefined ? {} : { docs: args.docs },
          ...args.decision === undefined ? {} : { decision: args.decision },
        })
        return toJson({ id: project.id, name: project.name, decisions: project.decisions.length })
      },
    }),
    defineTool({
      name: 'archive_project',
      description: 'Archive a project (kept, hidden, no longer active). Asks the user first.',
      parameters: { project: { type: 'string', required: true } },
      output: JSON_OUTPUT,
      async execute(args) {
        const project = await service.archiveProject(args.project)
        return toJson({ archived: project.id, name: project.name })
      },
    }),
    defineTool({
      name: 'assign_agent_to_project',
      description: 'Assign (or unassign) a main agent to a project.',
      parameters: {
        project: { type: 'string', required: true },
        agent_id: { type: 'string', required: true, description: 'Main agent id or name.' },
        unassign: { type: 'boolean' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const project = await service.assignAgent(args.project, args.agent_id, args.unassign !== true)
        return toJson({ project: project.id, agentIds: project.agentIds })
      },
    }),
    defineTool({
      name: 'project_status',
      description: 'Live status of a project (default: the active one): Git branch and changes, assigned agents, running background work, recent decisions.',
      parameters: { project: { type: 'string' } },
      output: JSON_OUTPUT,
      async execute(args) {
        return toJson(await service.projectStatus(args.project))
      },
    }),
    controlTool('pause_task', 'pause', 'Pause running or queued work. Background tasks pause (the running turn is interrupted); workflows and chat turns cannot pause and the result says so.', false),
    controlTool('resume_task', 'resume', 'Resume paused work. Check what the task was doing before resuming anything destructive.', false),
    controlTool('cancel_task', 'cancel', 'Cancel running work: a background task, a workflow, or a running chat turn.', false),
    controlTool('update_task', 'update', 'Change the instructions of running or queued work. Running agents receive it at their next step; queued or paused tasks get it added to their prompt.', true),
    controlTool('add_task_constraint', 'constrain', 'Add a constraint to running or queued work, e.g. "do not modify the API".', true),
    defineTool({
      name: 'recommend_agent',
      description: 'Rank main agents for a task by capability, availability, project assignment, model, permissions, and prior context, with reasons.',
      parameters: { task: { type: 'string', required: true }, project: { type: 'string' } },
      output: JSON_OUTPUT,
      async execute(args) {
        const project = args.project === undefined ? undefined : service.project(args.project).id
        return toJson((await service.recommend(args.task, project)).slice(0, 5))
      },
    }),
    defineTool({
      name: 'propose_agent',
      description: 'Draft a configuration for a new main agent. Nothing is created: show the proposal to the user, then create it with create_main_agent if they agree.',
      parameters: { need: { type: 'string', required: true, description: 'What the agent is for.' }, name: { type: 'string' } },
      output: JSON_OUTPUT,
      execute(args) {
        return Promise.resolve(toJson({ proposal: proposeAgent(args.need, args.name), next: 'Show this to the user. Create it with create_main_agent only after they approve.' }))
      },
    }),
    defineTool({
      name: 'list_capabilities',
      description: 'Your tools grouped by capability (FILES, TERMINAL, BROWSER, GIT, GITHUB, COMPUTER, SEARCH, PROJECT, AGENTS, WORKFLOWS, BACKGROUND_TASKS). Use it to see what you can do before planning.',
      parameters: {},
      output: JSON_OUTPUT,
      async execute() {
        return toJson(groupTools(await toolNamesOf(agent)))
      },
    }),
  ]

  const projectId = (): { project?: string } => {
    const id = service.activeProject()?.id
    return id === undefined ? {} : { project: id }
  }

  const toolNamesOf = async (agent: Agent): Promise<string[]> => {
    const scope = scopeOf(agent.ctx)
    if (scope === undefined) return []
    return (await ctx.systemPrompt.assemble({ scope })).tools.map(tool => tool.name)
  }

  const contextText = (agent: Agent): string => {
    const sessionId = agent.session.id
    const telemetry = ctx.orchestration.peekTelemetry(sessionId)
    const request = telemetry?.lastUserText ?? ''
    const decision = request === '' ? undefined : service.decide(sessionId, request, telemetry?.lastUserHasImage ?? false)
    const project = service.activeProject()
    const scope = { ...project === undefined ? {} : { projectId: project.id }, sessionId }
    const memories = relevantMemories(service.memories({ limit: 2000 }), request, scope)
    const running = ctx.orchestration.background.list().filter(task => task.status === 'running' || task.status === 'queued' || task.status === 'paused').slice(0, 6)
    const lines: string[] = []
    if (decision !== undefined) {
      lines.push(`Coordinator hint: depth=${decision.depth} (${decision.reason}). ${DEPTH_GUIDANCE[decision.depth]}`)
      lines.push(`Request category: ${decision.category} (${decision.categoryReason}).`)
    }
    if (project !== undefined) {
      const commands = Object.entries(project.commands).map(([key, value]) => `${key}: ${value}`).join('; ')
      lines.push(`Active project: ${project.name} (${project.id})${project.path === undefined ? '' : ` at ${project.path}`}.`
        + `${project.stack.length === 0 ? '' : ` Stack: ${project.stack.join(', ')}.`}${commands === '' ? ' Commands: not recorded yet — verify before running anything.' : ` Verified commands: ${commands}.`}`)
    }
    if (memories.length > 0) {
      lines.push('Relevant memories (from the user\'s saved memory; treat as facts the user gave you):')
      for (const memory of memories) lines.push(`- (${memory.scope}) ${memory.text}`)
    }
    if (running.length > 0) {
      lines.push('Running background work:')
      for (const task of running) lines.push(`- ${task.id} "${task.title}" — ${task.status}${task.progress.percent === undefined ? '' : `, ${String(task.progress.percent)}%`}`)
    }
    return lines.join('\n')
  }

  const agentContextText = (agent: Agent, agentId: string): string => {
    const request = ctx.orchestration.peekTelemetry(agent.session.id)?.lastUserText ?? ''
    const memories = relevantMemories(service.memories({ limit: 2000 }), request, { agentId }).filter(memory => memory.scope === 'agent')
    if (memories.length === 0) return ''
    return ['Your saved agent memories:', ...memories.map(memory => `- ${memory.text}`)].join('\n')
  }

  const register = (agent: Agent, role: Role, agentId?: string): () => void => {
    const scoped = agent.ctx
    const disposers: Array<() => unknown> = []
    if (role === 'observed') {
      service.liveOf(agent.session.id, ctx.mainAgents.modeOf(agent))
      disposers.push(() => { service.drop(agent.session.id) })
    } else if (role === 'coordinator') {
      for (const tool of coordinatorTools(agent)) disposers.push(scoped.tools.register(tool as Parameters<typeof scoped.tools.register>[0]))
      disposers.push(scoped.systemPrompt.section({
        name: 'personal-ai:coordinator',
        order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY') + 8,
        text: () => coordinatorPrompt(service.personality()),
        interpolate: false,
      }))
      disposers.push(scoped.systemPrompt.context({ name: 'personal-ai:coordinator-context', order: 130, text: () => contextText(agent) }))
      service.liveOf(agent.session.id, ctx.mainAgents.modeOf(agent))
      disposers.push(() => { service.drop(agent.session.id) })
    } else if (agentId !== undefined) {
      const tools = memoryTools('agent', () => ({ ...projectId(), agent: agentId, session: agent.session.id }))
      for (const tool of tools) disposers.push(scoped.tools.register(tool as Parameters<typeof scoped.tools.register>[0]))
      disposers.push(scoped.systemPrompt.context({ name: 'personal-ai:agent-memory', order: 131, text: () => agentContextText(agent, agentId) }))
    }
    return () => { for (const dispose of disposers.toReversed()) dispose() }
  }

  const roleOf = (agent: Agent): { role: Role; agentId?: string } | undefined => {
    if (!isTopLevelSession(agent.session.header)) return undefined
    const mode = ctx.mainAgents.modeOf(agent)
    const record = ctx.mainAgents.recordForSession(agent.session.id)
    if (record !== undefined) return ctx.mainAgents.allowsTools(agent) ? { role: 'agent', agentId: record.id } : undefined
    if (config.observedModes.includes(mode)) return { role: 'observed' }
    if (!service.coordinatorEnabled() || !ctx.mainAgents.allowsTools(agent)) return undefined
    return config.coordinatorModes.includes(mode) ? { role: 'coordinator' } : undefined
  }

  const release = (agent: Agent): void => {
    installed.get(agent)?.dispose()
    installed.delete(agent)
  }

  const sync = (agent: Agent): void => {
    if (ctx.agents.get(agent.id) !== agent) return
    const wanted = roleOf(agent)
    const key = wanted === undefined ? '' : `${wanted.role}:${wanted.agentId ?? ''}:${ctx.mainAgents.modeOf(agent)}`
    const current = installed.get(agent)
    if (current?.key === key) return
    if (current !== undefined) release(agent)
    if (wanted !== undefined) installed.set(agent, { key, dispose: register(agent, wanted.role, wanted.agentId) })
  }

  let active = true
  let pending = false
  const scheduleSyncAll = (): void => {
    if (pending || !active) return
    pending = true
    queueMicrotask(() => {
      pending = false
      if (active) for (const agent of ctx.agents.list()) sync(agent)
    })
  }

  void Promise.all([service.whenReady(), ctx.mainAgents.whenReady()]).then(scheduleSyncAll)
  ctx.on('agent/created', ({ agent }) => {
    void Promise.all([service.whenReady(), ctx.mainAgents.whenReady()]).then(() => { if (active) sync(agent) })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    release(agent)
    service.drop(agent.session.id)
  })
  ctx.on('agent-preset/selected', scheduleSyncAll)
  ctx.on('tools/change', scheduleSyncAll)
  ctx.on('personal-ai/personality', scheduleSyncAll)
  ctx.effect(() => () => {
    active = false
    for (const agent of [...installed.keys()]) release(agent)
  }, 'personal-ai: coordinator')
}

/** Tags accepted by the agent-tag route. */
export function parseTags(values: readonly string[]): AgentTag[] {
  return values.filter((value): value is AgentTag => (AGENT_TAGS as readonly string[]).includes(value))
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined && member !== '')) as T
}
