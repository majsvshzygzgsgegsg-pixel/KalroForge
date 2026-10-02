/**
 * Agent-scoped installation of the main-agent tool sets.
 *
 * - Every top-level Session receives the communication tools
 *   (`list_main_agents`, `get_main_agent`, `send_agent_message`, `delegate_task`).
 * - Sessions holding the Agent Administration capability (Creator and Lead by
 *   mode, main agents by explicit grant) also receive the admin tools.
 * - A main agent's own Session receives its identity prompt section and its
 *   tool allow/deny restriction.
 * - Admin calls that widen access or remove an agent pass through the existing
 *   `tools/pre-execute` approval path, so the user approves them explicitly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { syncDeferred } from './deferred-sync.ts'
import type {} from './orchestration/service.ts'
import { ORCHESTRATION_KEEP } from './orchestration/tools.ts'
import { isTopLevelSession, type MainAgentRegistry } from './registry.ts'
import type { MainAgentActor, MainAgentModel, MainAgentPermissions, MainAgentRecord, MainAgentTools } from './types.ts'

/** Communication tools installed in every top-level Session. */
export const COMMUNICATION_TOOLS = ['list_main_agents', 'get_main_agent', 'send_agent_message', 'delegate_task'] as const

/** Administration tools installed only for Agent Administration holders. */
export const ADMIN_TOOLS = [
  'create_main_agent', 'clone_main_agent', 'edit_main_agent', 'archive_main_agent',
  'start_main_agent', 'stop_main_agent', 'restart_main_agent',
  'assign_model', 'assign_mode', 'assign_tools', 'assign_workspace',
  'create_agent_team', 'manage_agent_permissions',
] as const

/** Agent Team tools a main agent always keeps so it can run its own sub-agent team. */
const TEAM_TOOLS = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
]

/** PTC mode's presentation transport; restricting it would disable PTC mode rather than any capability. */
const PTC_TRANSPORT = 'run_code'

/** Permission presets that never widen host access beyond the workspace. */
const CONTAINED_PRESETS = new Set(['read-only', 'workspace-write'])

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/** Detach a registry value into plain JSON for the tool result. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

const MODEL_PARAM = {
  type: 'object',
  additionalProperties: false,
  description: 'Provider route and model id, for example { "provider": "deepseek", "model": "deepseek-v4-flash" }.',
  properties: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    reasoningEffort: { type: 'string' },
  },
} as const

const TOOLS_PARAM = {
  type: 'object',
  additionalProperties: false,
  description: 'Tool restriction intersected with the mode tool set. Empty allow keeps every mode tool.',
  properties: {
    allow: { type: 'array', items: { type: 'string' } },
    deny: { type: 'array', items: { type: 'string' } },
  },
} as const

const PERMISSIONS_PARAM = {
  type: 'object',
  additionalProperties: false,
  description: 'preset is a KairoForge permission preset (read-only, workspace-write, ...). agentAdministration grants the admin tool set.',
  properties: {
    preset: { type: 'string' },
    agentAdministration: { type: 'boolean' },
  },
} as const

const AGENT_ID = { type: 'string', required: true, description: 'Main agent id or name from list_main_agents.' } as const

/** Drop absent optional keys so the registry receives exact optional fields. */
function modelOf(input: { provider: string; model: string; reasoningEffort?: string }): MainAgentModel {
  return input.reasoningEffort === undefined
    ? { provider: input.provider, model: input.model }
    : { provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort }
}

function toolsOf(input: { allow?: string[]; deny?: string[] }): Partial<MainAgentTools> {
  return {
    ...input.allow === undefined ? {} : { allow: input.allow },
    ...input.deny === undefined ? {} : { deny: input.deny },
  }
}

function permissionsOf(input: { preset?: string; agentAdministration?: boolean }): Partial<MainAgentPermissions> {
  return {
    ...input.preset === undefined ? {} : { preset: input.preset },
    ...input.agentAdministration === undefined ? {} : { agentAdministration: input.agentAdministration },
  }
}

/** Identity prompt for one main agent's own Session. */
function identityPrompt(record: MainAgentRecord): string {
  const lines = [
    `You are "${record.name}", a persistent KairoForge main agent (id "${record.id}").`,
    'You are a top-level agent with your own chat, configuration, model, mode, and tools; you are not a sub-agent.',
  ]
  if (record.description !== '') lines.push(`Role: ${record.description}`)
  if (record.instructions !== '') lines.push('', 'Standing instructions:', record.instructions)
  lines.push(
    '',
    'You are the Lead of your own Agent Team: create sub-agents with spawn_teammate when work benefits from parallel help.',
    'Messages that begin with "[KairoForge agent message]" or "[KairoForge delegated task]" come from other agents. Reply or report results with send_agent_message using the agent_id given in that message.',
  )
  return lines.join('\n')
}

/** Which approval reason applies to one admin call, or undefined when it needs none. */
export function approvalReason(name: string, args: unknown): string | undefined {
  const fields = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
  switch (name) {
    case 'archive_main_agent':
      return 'Archive a main agent and cancel its work'
    case 'manage_agent_permissions':
      return 'Change a main agent\'s permissions'
    case 'assign_workspace':
      return 'Give a main agent access to a different workspace directory'
    case 'assign_tools':
      return 'Change which tools a main agent may use'
    case 'create_main_agent':
    case 'clone_main_agent':
    case 'edit_main_agent': {
      const config = typeof fields.config === 'object' && fields.config !== null
        ? fields.config as Record<string, unknown>
        : typeof fields.changes === 'object' && fields.changes !== null ? fields.changes as Record<string, unknown> : {}
      const permissions = typeof config.permissions === 'object' && config.permissions !== null
        ? config.permissions as Record<string, unknown>
        : {}
      if (permissions.agentAdministration === true) return 'Grant Agent Administration to a main agent'
      if (typeof permissions.preset === 'string' && !CONTAINED_PRESETS.has(permissions.preset)) {
        return `Give a main agent the "${permissions.preset}" permission preset`
      }
      if (config.workspace !== undefined) return 'Give a main agent access to a workspace directory'
      if (name === 'edit_main_agent' && config.tools !== undefined) return 'Change which tools a main agent may use'
      return undefined
    }
    default:
      return undefined
  }
}

/** Installed contributions for one live Agent. */
interface Installed {
  communication?: () => void
  admin?: () => void
  identity?: { key: string; dispose: () => void }
}

/**
 * Install and keep the per-Agent tool sets in sync with the registry.
 * @param ctx - Host context.
 * @param registry - the Agent Registry.
 */
export function installMainAgentTools(ctx: Context, registry: MainAgentRegistry): void {
  const installed = new Map<Agent, Installed>()

  const actorOf = (agent: Agent): MainAgentActor => {
    const record = registry.recordForSession(agent.session.id)
    const name = record?.name ?? (registry.modeOf(agent) === 'cordis' ? 'Creator' : 'Lead')
    return { kind: 'session', sessionId: agent.session.id, name }
  }

  const callerOf = (agent: Agent | undefined, tool: string): Agent => {
    /* v8 ignore next -- scoped tools are discovered only with their calling Agent. */
    if (agent === undefined) throw new Error(`${tool} requires a calling Agent`)
    return agent
  }

  const registerCommunication = (agent: Agent): () => void => {
    const scoped = agent.ctx
    const disposers = [
      scoped.tools.register(defineTool({
        name: 'list_main_agents',
        description: 'List persistent KairoForge main agents (top-level agents with their own chat, model, mode, and tools; not sub-agents). Lead is the built-in coordinator and is not listed.',
        parameters: {
          include_archived: { type: 'boolean', description: 'Include archived agents. Defaults to false.' },
        },
        output: JSON_OUTPUT,
        async execute(args) {
          return toJson(await registry.list(args.include_archived ?? false))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'get_main_agent',
        description: 'Read one main agent\'s configuration, status, Session, and recent activity.',
        parameters: { agent_id: AGENT_ID },
        output: JSON_OUTPUT,
        async execute(args) {
          return toJson(await registry.get(args.agent_id))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'send_agent_message',
        description: 'Send a message to a main agent (by id or name) or reply to a top-level Session such as Lead (by its Session id). The message enters the recipient\'s own chat. For your own sub-agent teammates use the Agent Team send_message tool instead.',
        parameters: {
          agent_id: { type: 'string', required: true, description: 'Main agent id/name, or a top-level Session id for replies.' },
          message: { type: 'string', required: true, description: 'Self-contained message.' },
        },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.sendMessage(args.agent_id, args.message, actorOf(callerOf(exec.agent, 'send_agent_message'))))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'delegate_task',
        description: 'Delegate a complete task to a running main agent. It works in its own chat and returns the result to you (same as delegate_to_main_agent).',
        parameters: {
          agent_id: AGENT_ID,
          task: { type: 'string', required: true, description: 'Complete, self-contained task description with the expected result.' },
        },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          const actor = actorOf(callerOf(exec.agent, 'delegate_task'))
          const orchestration = ctx.get('orchestration')
          if (orchestration !== undefined && actor.kind === 'session') {
            const record = await orchestration.delegations.delegate({ sessionId: actor.sessionId, name: actor.name }, args.agent_id, args.task, 'task')
            return toJson({ delegation_id: record.id, target: record.toAgentId, sessionId: record.toSessionId, depth: record.depth, status: 'accepted' })
          }
          return toJson(await registry.delegateTask(args.agent_id, args.task, actor))
        },
      })),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }

  const registerAdmin = (agent: Agent): () => void => {
    const scoped = agent.ctx
    const actor = (exec: { agent?: Agent }, tool: string): MainAgentActor => actorOf(callerOf(exec.agent, tool))
    const disposers = [
      scoped.tools.register(defineTool({
        name: 'create_main_agent',
        description: 'Create a persistent main agent with its own chat Session, mode, model, tools, optional workspace, and permissions. New agents default to the workspace-write permission preset without Agent Administration. Use this, not spawn_teammate, when the user asks for a new main agent.',
        parameters: {
          name: { type: 'string', required: true, description: 'Unique display name.' },
          config: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional configuration.',
            properties: {
              description: { type: 'string', description: 'One-line role.' },
              instructions: { type: 'string', description: 'Standing instructions added to the agent\'s system prompt.' },
              mode: { type: 'string', description: 'Agent preset id, for example standard or cordis (Creator mode).' },
              model: MODEL_PARAM,
              tools: TOOLS_PARAM,
              workspace: { type: 'string', description: 'Absolute working directory.' },
              permissions: PERMISSIONS_PARAM,
              start: { type: 'boolean', description: 'Start the Session now. Defaults to true.' },
            },
          },
        },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          const config = args.config ?? {}
          return toJson(await registry.create(args.name, {
            ...config.description === undefined ? {} : { description: config.description },
            ...config.instructions === undefined ? {} : { instructions: config.instructions },
            ...config.mode === undefined ? {} : { mode: config.mode },
            ...config.model === undefined ? {} : { model: modelOf(config.model) },
            ...config.tools === undefined ? {} : { tools: toolsOf(config.tools) },
            ...config.workspace === undefined ? {} : { workspace: config.workspace },
            ...config.permissions === undefined ? {} : { permissions: permissionsOf(config.permissions) },
            ...config.start === undefined ? {} : { start: config.start },
          }, actor(exec, 'create_main_agent')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'clone_main_agent',
        description: 'Copy a main agent\'s configuration into a new main agent with its own fresh chat Session.',
        parameters: { agent_id: AGENT_ID, new_name: { type: 'string', required: true } },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.clone(args.agent_id, args.new_name, actor(exec, 'clone_main_agent')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'edit_main_agent',
        description: 'Change a main agent\'s name, description, instructions, mode, model, tools, workspace, or permissions. A mode or workspace change starts a new Session and keeps the old one.',
        parameters: {
          agent_id: AGENT_ID,
          changes: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              instructions: { type: 'string' },
              mode: { type: 'string' },
              model: MODEL_PARAM,
              tools: TOOLS_PARAM,
              workspace: { type: 'string', description: 'Absolute directory; empty string resets to the default workspace.' },
              permissions: PERMISSIONS_PARAM,
            },
          },
        },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          const c = args.changes
          return toJson(await registry.edit(args.agent_id, {
            ...c.name === undefined ? {} : { name: c.name },
            ...c.description === undefined ? {} : { description: c.description },
            ...c.instructions === undefined ? {} : { instructions: c.instructions },
            ...c.mode === undefined ? {} : { mode: c.mode },
            ...c.model === undefined ? {} : { model: modelOf(c.model) },
            ...c.tools === undefined ? {} : { tools: toolsOf(c.tools) },
            ...c.workspace === undefined ? {} : { workspace: c.workspace.trim() === '' ? null : c.workspace },
            ...c.permissions === undefined ? {} : { permissions: permissionsOf(c.permissions) },
          }, actor(exec, 'edit_main_agent')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'archive_main_agent',
        description: 'Archive a main agent: cancel its work and hide it. Its chat history is kept and start_main_agent restores it. Requires user approval.',
        parameters: { agent_id: AGENT_ID },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.archive(args.agent_id, actor(exec, 'archive_main_agent')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'start_main_agent',
        description: 'Start (or restore an archived) main agent and load its chat Session.',
        parameters: { agent_id: AGENT_ID },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.start(args.agent_id, actor(exec, 'start_main_agent')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'stop_main_agent',
        description: 'Stop a main agent: cancel its current turn and queued work; it refuses messages and tasks until started.',
        parameters: { agent_id: AGENT_ID },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.stop(args.agent_id, actor(exec, 'stop_main_agent')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'restart_main_agent',
        description: 'Stop then start a main agent.',
        parameters: { agent_id: AGENT_ID },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.restart(args.agent_id, actor(exec, 'restart_main_agent')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'assign_model',
        description: 'Assign a provider and model to a main agent. This does not change Lead\'s default model.',
        parameters: {
          agent_id: AGENT_ID,
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoning_effort: { type: 'string' },
        },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.assignModel(args.agent_id, modelOf({
            provider: args.provider,
            model: args.model,
            ...args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort },
          }), actor(exec, 'assign_model')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'assign_mode',
        description: 'Assign a mode (agent preset id such as standard, cordis, builder) to a main agent. A changed mode starts a new Session.',
        parameters: { agent_id: AGENT_ID, mode: { type: 'string', required: true } },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.assignMode(args.agent_id, args.mode, actor(exec, 'assign_mode')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'assign_tools',
        description: 'Replace a main agent\'s tool allow/deny lists. Requires user approval.',
        parameters: { agent_id: AGENT_ID, tools: { ...TOOLS_PARAM, required: true } },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.assignTools(args.agent_id, toolsOf(args.tools), actor(exec, 'assign_tools')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'assign_workspace',
        description: 'Assign an absolute workspace directory to a main agent, or an empty string for the default. A changed workspace starts a new Session. Requires user approval.',
        parameters: { agent_id: AGENT_ID, workspace: { type: 'string', required: true } },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          const workspace = args.workspace.trim() === '' ? null : args.workspace
          return toJson(await registry.assignWorkspace(args.agent_id, workspace, actor(exec, 'assign_workspace')))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'create_agent_team',
        description: 'Create sub-agent teammates under a main agent (the main agent is the Lead of its own Agent Team) and return the team roster. Omit members to only read the roster.',
        parameters: {
          agent_id: AGENT_ID,
          members: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
                description: { type: 'string', required: true },
                prompt: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
              },
            },
          },
        },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.createTeam(args.agent_id, args.members ?? [], actor(exec, 'create_agent_team'), exec.signal))
        },
      })),
      scoped.tools.register(defineTool({
        name: 'manage_agent_permissions',
        description: 'Change a main agent\'s permission preset (read-only, workspace-write, ...) or Agent Administration grant. Requires user approval.',
        parameters: { agent_id: AGENT_ID, permissions: { ...PERMISSIONS_PARAM, required: true } },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          return toJson(await registry.managePermissions(
            args.agent_id,
            permissionsOf(args.permissions),
            actor(exec, 'manage_agent_permissions'),
          ))
        },
      })),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }

  const registerIdentity = (agent: Agent, record: MainAgentRecord): () => void => {
    const scoped = agent.ctx
    const disposers: Array<() => unknown> = [scoped.systemPrompt.section({
      name: 'main-agents:identity',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY') + 5,
      text: identityPrompt(record),
    })]
    const { allow, deny } = record.tools
    if (allow.length > 0 || deny.length > 0) {
      const keep = new Set<string>([
        ...COMMUNICATION_TOOLS, ...TEAM_TOOLS, ...ORCHESTRATION_KEEP, PTC_TRANSPORT,
        ...record.permissions.agentAdministration ? ADMIN_TOOLS : [],
      ])
      const allowed = new Set([...allow, ...keep])
      const denied = new Set(deny)
      // The guard enforces both lists for every tool, including mode-scoped
      // ones that `restrict` cannot mask.
      disposers.push(scoped.tools.guard((exec) => {
        if (denied.has(exec.name)) return `Tool "${exec.name}" is denied for main agent "${record.name}".`
        if (allow.length > 0 && !allowed.has(exec.name)) {
          return `Tool "${exec.name}" is not in main agent "${record.name}"'s allowed tools.`
        }
        return undefined
      }))
      // `restrict` additionally hides global tools from the model; it accepts only global names.
      const globalNames = ctx.tools.schemas().map(schema => schema.name).filter(name => name !== PTC_TRANSPORT)
      const hideAllow = allow.length > 0 ? globalNames.filter(name => allowed.has(name)) : undefined
      const hideDeny = globalNames.filter(name => denied.has(name))
      if (hideAllow !== undefined || hideDeny.length > 0) {
        disposers.push(scoped.tools.restrict({
          ...hideAllow === undefined ? {} : { allow: hideAllow },
          ...hideDeny.length === 0 ? {} : { deny: hideDeny },
        }))
      }
    }
    return () => { for (const dispose of disposers.toReversed()) dispose() }
  }

  const sync = (agent: Agent): void => {
    if (ctx.agents.get(agent.id) !== agent) return
    const state = installed.get(agent) ?? {}
    const communicates = isTopLevelSession(agent.session.header) && registry.allowsTools(agent)
    if (communicates && state.communication === undefined) state.communication = registerCommunication(agent)
    if (!communicates && state.communication !== undefined) {
      state.communication()
      delete state.communication
    }
    const admin = registry.canAdminister(agent)
    if (admin && state.admin === undefined) state.admin = registerAdmin(agent)
    if (!admin && state.admin !== undefined) {
      state.admin()
      delete state.admin
    }
    const record = registry.recordForSession(agent.session.id)
    const own = record !== undefined && record.sessionId === agent.session.id ? record : undefined
    const key = own === undefined
      ? undefined
      : JSON.stringify([own.name, own.description, own.instructions, own.tools, own.permissions.agentAdministration])
    if (state.identity !== undefined && state.identity.key !== key) {
      state.identity.dispose()
      delete state.identity
    }
    if (own !== undefined && key !== undefined && state.identity === undefined) {
      state.identity = { key, dispose: registerIdentity(agent, own) }
    }
    installed.set(agent, state)
  }

  const release = (agent: Agent): void => {
    const state = installed.get(agent)
    if (state === undefined) return
    installed.delete(agent)
    state.identity?.dispose()
    state.admin?.()
    state.communication?.()
  }

  let active = true
  const syncAll = (): void => { if (active) syncDeferred(ctx.agents.list(), sync) }

  void registry.whenReady().then(syncAll)
  ctx.on('agent/created', ({ agent }) => { void registry.whenReady().then(() => { if (active) syncDeferred([agent], sync) }) })
  ctx.on('agent/disposed', ({ agent }) => { release(agent) })
  ctx.on('main-agents/changed', () => { syncAll() })
  // A blank Session can switch preset; the composition then announces a tool change. Batched so our own
  // registrations never re-enter a sync.
  let pending = false
  const scheduleSyncAll = (): void => {
    if (pending || !active) return
    pending = true
    queueMicrotask(() => {
      pending = false
      syncAll()
    })
  }
  ctx.on('agent-preset/selected', scheduleSyncAll)
  ctx.on('tools/change', scheduleSyncAll)
  ctx.effect(() => () => {
    active = false
    for (const agent of [...installed.keys()]) release(agent)
  }, 'main-agents: scoped tools')

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const reason = approvalReason(exec.name, exec.arguments)
    if (reason === undefined || exec.agent === undefined || installed.get(exec.agent)?.admin === undefined) return next()
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    return {
      kind: 'ask',
      reason: `${reason} (${exec.name})`,
      displayReason: { en: `${reason}.`, zh: `${reason}。` },
    }
  })
}
