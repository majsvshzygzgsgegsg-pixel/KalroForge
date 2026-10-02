/**
 * Agent Registry service (`ctx.mainAgents`): the source of truth for
 * persistent main agents. Each main agent owns one top-level chat Session
 * created through the Session controller, so it appears in the normal chat
 * UI, survives restarts, and is the Lead of its own Agent Team.
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { mainAgentDomain } from './storage.ts'
import {
  MainAgentError,
  type MainAgentActivity, type MainAgentActor, type MainAgentChanges, type MainAgentConfig,
  type MainAgentDelivery, type MainAgentModel, type MainAgentPermissions, type MainAgentRecord,
  type MainAgentRegistrySettings, type MainAgentTeamMember, type MainAgentTeammateRequest,
  type MainAgentTools, type MainAgentView,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent main-agent registry. */
    mainAgents: MainAgentRegistry
  }

  interface Events {
    /**
     * One main-agent record was created or changed.
     * @mode emit
     * @param record - the committed record.
     */
    'main-agents/changed'(record: MainAgentRecord): void
  }
}

/** Registry tunables supplied by the composition. */
export interface RegistryOptions {
  /** Agent presets whose top-level Sessions hold Agent Administration until the user changes the setting. */
  readonly administratorModes: readonly string[]
  /** Mode assigned to new main agents when the request names none. */
  readonly defaultMode: string
  /** Permission preset assigned to new main agents when the request names none. */
  readonly defaultPermissionPreset: string
  /** Continuable-subagent provider used for sub-agent teammates. */
  readonly teamProvider: string
}

/** Activity lines retained per record. */
const ACTIVITY_LIMIT = 20
/** Upper bound for names, kept short so Session titles and tool output stay readable. */
const NAME_LIMIT = 60
/** Reserved ids: `lead` names the built-in coordinator in every Session. */
const RESERVED_IDS = new Set(['lead'])

type MainAgentDomain = Domain<typeof mainAgentDomain>

/** Return a URL- and tool-safe id stem for one display name. */
function slugOf(name: string): string {
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 40)
  return slug === '' ? 'agent' : slug
}

/** Remove empty and duplicate tool names. */
function normalizeToolList(names: readonly string[] | undefined): string[] {
  return [...new Set((names ?? []).map(name => name.trim()).filter(name => name !== ''))]
}

/** True when a Session is a top-level chat rather than a delegated child. */
export function isTopLevelSession(header: SessionHeader): boolean {
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

/** Persistent main-agent registry; every method waits for the durable domain. */
export class MainAgentRegistry extends Service {
  static inject = ['agents', 'storageDomain', 'sessionController']

  private readonly ready: Promise<MainAgentDomain>
  private domain: MainAgentDomain | undefined
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - Host context with Agents, durable storage, and the Session controller.
   * @param options - composition tunables.
   */
  constructor(ctx: Context, private readonly options: RegistryOptions) {
    super(ctx, 'mainAgents')
    this.ready = ctx.storageDomain.open(mainAgentDomain).then((domain) => {
      this.domain = domain
      return domain
    })
    ctx.effect(() => async () => {
      const domain = await this.ready
      await this.chain.catch(() => {})
      await domain.close()
    }, 'main-agents: registry domain')
  }

  /** Resolve after the durable registry is open. */
  async whenReady(): Promise<void> {
    await this.ready
  }

  // ---------------------------------------------------------------------------
  // Reads

  /**
   * List main agents.
   * @param includeArchived - include archived agents.
   * @returns registry records with runtime facts, oldest first.
   */
  async list(includeArchived = false): Promise<MainAgentView[]> {
    const domain = await this.ready
    return [...domain.table('agents').entries()]
      .map(([, record]) => record)
      .filter(record => includeArchived || record.status !== 'archived')
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(record => this.view(record))
  }

  /**
   * Read one main agent by id or case-insensitive name.
   * @param idOrName - registry id or display name.
   * @returns the record with runtime facts.
   */
  async get(idOrName: string): Promise<MainAgentView> {
    await this.ready
    return this.view(this.require(idOrName))
  }

  /**
   * Find the main agent bound to a Session (current or retained).
   * @param sessionId - Session id.
   * @returns the record, or undefined when the Session is not a main agent's.
   */
  recordForSession(sessionId: string): MainAgentRecord | undefined {
    const domain = this.domain
    if (domain === undefined) return undefined
    for (const [, record] of domain.table('agents').entries()) {
      if (record.sessionId === sessionId || record.previousSessionIds.includes(sessionId)) return record
    }
    return undefined
  }

  /**
   * Current registry settings, with configured defaults filled in.
   * @returns the effective settings.
   */
  settings(): MainAgentRegistrySettings {
    const stored = this.domain?.global.get() ?? {}
    return { administratorModes: stored.administratorModes ?? this.options.administratorModes }
  }

  /**
   * Replace registry settings.
   * @param next - complete settings.
   * @returns the stored settings.
   */
  async updateSettings(next: MainAgentRegistrySettings): Promise<MainAgentRegistrySettings> {
    const domain = await this.ready
    const administratorModes = normalizeToolList(next.administratorModes)
    await this.serialize(() => domain.global.set({ administratorModes }))
    return this.settings()
  }

  /**
   * Resolve the mode (agent preset) of a live Agent.
   * @param agent - live Agent.
   * @returns preset id, falling back to the configured default mode.
   */
  modeOf(agent: Agent): string {
    return agent.session.header.agentPreset
      ?? this.ctx.get('agentPresets')?.composedPreset(agent.ctx)
      ?? this.options.defaultMode
  }

  /**
   * Whether a live Agent holds the Agent Administration capability. Sub-agents
   * never do; a main agent does only when its permissions grant it; any other
   * top-level Session (Lead, Creator) does when its mode is an administrator mode.
   * @param agent - live Agent.
   * @returns true when the admin tool set may be installed for this Agent.
   */
  canAdminister(agent: Agent): boolean {
    if (!isTopLevelSession(agent.session.header)) return false
    const record = this.recordForSession(agent.session.id)
    if (record !== undefined) return record.status !== 'archived' && record.permissions.agentAdministration
    return this.settings().administratorModes.includes(this.modeOf(agent))
  }

  // ---------------------------------------------------------------------------
  // Mutations

  /**
   * Create one main agent and, unless `config.start` is false, its Session.
   * @param name - display name; must be unique.
   * @param config - initial configuration.
   * @param actor - who performs the operation.
   * @returns the created agent.
   */
  async create(name: string, config: MainAgentConfig, actor: MainAgentActor): Promise<MainAgentView> {
    const domain = await this.ready
    const cleanName = this.validName(name)
    const mode = config.mode ?? this.options.defaultMode
    await this.validateMode(mode)
    const permissions = this.validPermissions({
      preset: config.permissions?.preset ?? this.options.defaultPermissionPreset,
      agentAdministration: config.permissions?.agentAdministration ?? false,
    })
    const workspace = config.workspace === undefined ? undefined : this.validWorkspace(config.workspace)
    const now = new Date().toISOString()
    const record = await this.serialize(async () => {
      this.assertNameFree(cleanName)
      const created: MainAgentRecord = {
        id: this.freshId(cleanName),
        name: cleanName,
        description: config.description?.trim() ?? '',
        instructions: config.instructions?.trim() ?? '',
        status: config.start === false ? 'stopped' : 'running',
        mode,
        ...config.model === undefined ? {} : { model: this.validModel(config.model) },
        tools: { allow: normalizeToolList(config.tools?.allow), deny: normalizeToolList(config.tools?.deny) },
        ...workspace === undefined ? {} : { workspace },
        permissions,
        previousSessionIds: [],
        createdAt: now,
        updatedAt: now,
        createdBy: actor.kind === 'user' ? 'user' : actor.sessionId,
        activity: [{ at: now, kind: 'created', text: `Created by ${actorName(actor)}` }],
      }
      await domain.table('agents').put(created.id, created)
      return created
    })
    this.ctx.emit('main-agents/changed', record)
    if (record.status === 'running') return this.view(await this.ensureSession(record))
    return this.view(record)
  }

  /**
   * Copy one main agent's configuration into a new agent with its own fresh Session.
   * @param idOrName - source agent.
   * @param newName - unique name for the copy.
   * @param actor - who performs the operation.
   * @returns the new agent.
   */
  async clone(idOrName: string, newName: string, actor: MainAgentActor): Promise<MainAgentView> {
    await this.ready
    const source = this.require(idOrName)
    return this.create(newName, {
      description: source.description,
      instructions: source.instructions,
      mode: source.mode,
      ...source.model === undefined ? {} : { model: source.model },
      tools: source.tools,
      ...source.workspace === undefined ? {} : { workspace: source.workspace },
      permissions: source.permissions,
      start: source.status === 'running',
    }, actor)
  }

  /**
   * Apply configuration changes. A mode or workspace change starts a new Session
   * (Session mode and cwd are fixed at creation); the earlier Session is retained.
   * @param idOrName - target agent.
   * @param changes - fields to change.
   * @param actor - who performs the operation.
   * @returns the updated agent.
   */
  async edit(idOrName: string, changes: MainAgentChanges, actor: MainAgentActor): Promise<MainAgentView> {
    const domain = await this.ready
    const current = this.require(idOrName)
    if (changes.mode !== undefined) await this.validateMode(changes.mode)
    const name = changes.name === undefined ? undefined : this.validName(changes.name)
    const model = changes.model === undefined ? undefined : this.validModel(changes.model)
    const permissions = changes.permissions === undefined
      ? undefined
      : this.validPermissions({ ...current.permissions, ...changes.permissions })
    const workspace = changes.workspace === undefined || changes.workspace === null
      ? changes.workspace
      : this.validWorkspace(changes.workspace)
    const rebind = (changes.mode !== undefined && changes.mode !== current.mode)
      || (workspace !== undefined && (workspace ?? undefined) !== current.workspace)
    const summary = Object.keys(changes).join(', ')
    const updated = await this.serialize(async () => {
      const latest = this.require(current.id)
      if (name !== undefined && name.toLowerCase() !== latest.name.toLowerCase()) this.assertNameFree(name, latest.id)
      const tools: MainAgentTools = changes.tools === undefined ? latest.tools : {
        allow: changes.tools.allow === undefined ? latest.tools.allow : normalizeToolList(changes.tools.allow),
        deny: changes.tools.deny === undefined ? latest.tools.deny : normalizeToolList(changes.tools.deny),
      }
      const { workspace: _workspace, sessionId: _sessionId, ...rest } = latest
      const nextWorkspace = workspace === undefined ? latest.workspace : workspace ?? undefined
      const nextSessionId = rebind ? undefined : latest.sessionId
      const next: MainAgentRecord = {
        ...rest,
        ...name === undefined ? {} : { name },
        ...changes.description === undefined ? {} : { description: changes.description.trim() },
        ...changes.instructions === undefined ? {} : { instructions: changes.instructions.trim() },
        ...changes.mode === undefined ? {} : { mode: changes.mode },
        ...model === undefined ? {} : { model },
        ...permissions === undefined ? {} : { permissions },
        tools,
        ...nextWorkspace === undefined ? {} : { workspace: nextWorkspace },
        ...nextSessionId === undefined ? {} : { sessionId: nextSessionId },
        previousSessionIds: rebind && latest.sessionId !== undefined
          ? [...latest.previousSessionIds, latest.sessionId]
          : latest.previousSessionIds,
        updatedAt: new Date().toISOString(),
        activity: appendActivity(latest.activity, 'edited', `${actorName(actor)} changed ${summary}`),
      }
      await domain.table('agents').put(next.id, next)
      return next
    })
    this.ctx.emit('main-agents/changed', updated)
    if (updated.status === 'running' && (rebind || updated.sessionId === undefined)) {
      return this.view(await this.ensureSession(updated))
    }
    if (updated.sessionId !== undefined && updated.status !== 'archived') {
      await this.applySessionConfig(updated, {
        model: model !== undefined,
        permissions: permissions !== undefined && permissions.preset !== current.permissions.preset,
        title: name !== undefined,
      })
    }
    return this.view(updated)
  }

  /**
   * Archive one main agent: cancel its work and hide it from default listings.
   * Its Sessions remain readable; `start` restores it.
   * @param idOrName - target agent.
   * @param actor - who performs the operation.
   * @returns the archived agent.
   */
  async archive(idOrName: string, actor: MainAgentActor): Promise<MainAgentView> {
    await this.ready
    const record = this.require(idOrName)
    this.cancelLive(record)
    return this.view(await this.setStatus(record.id, 'archived', 'archived', `Archived by ${actorName(actor)}`))
  }

  /**
   * Start (or restore) one main agent and ensure its Session is loaded.
   * @param idOrName - target agent.
   * @param actor - who performs the operation.
   * @returns the running agent.
   */
  async start(idOrName: string, actor: MainAgentActor): Promise<MainAgentView> {
    await this.ready
    const record = this.require(idOrName)
    const running = await this.setStatus(record.id, 'running', 'started', `Started by ${actorName(actor)}`)
    return this.view(await this.ensureSession(running))
  }

  /**
   * Stop one main agent: cancel the active turn and its queued work, and refuse
   * registry messages and delegated tasks until it is started again.
   * @param idOrName - target agent.
   * @param actor - who performs the operation.
   * @returns the stopped agent.
   */
  async stop(idOrName: string, actor: MainAgentActor): Promise<MainAgentView> {
    await this.ready
    const record = this.require(idOrName)
    if (record.status === 'archived') throw new MainAgentError('archived', `main agent "${record.name}" is archived`)
    this.cancelLive(record)
    return this.view(await this.setStatus(record.id, 'stopped', 'stopped', `Stopped by ${actorName(actor)}`))
  }

  /**
   * Stop then start one main agent.
   * @param idOrName - target agent.
   * @param actor - who performs the operation.
   * @returns the running agent.
   */
  async restart(idOrName: string, actor: MainAgentActor): Promise<MainAgentView> {
    await this.stop(idOrName, actor)
    return this.start(idOrName, actor)
  }

  /**
   * Assign a provider and model to one main agent's Session.
   * @param idOrName - target agent.
   * @param model - provider route, model id, and optional reasoning effort.
   * @param actor - who performs the operation.
   * @returns the updated agent.
   */
  assignModel(idOrName: string, model: MainAgentModel, actor: MainAgentActor): Promise<MainAgentView> {
    return this.edit(idOrName, { model }, actor)
  }

  /**
   * Assign a mode (agent preset). A changed mode starts a new Session.
   * @param idOrName - target agent.
   * @param mode - agent preset id.
   * @param actor - who performs the operation.
   * @returns the updated agent.
   */
  assignMode(idOrName: string, mode: string, actor: MainAgentActor): Promise<MainAgentView> {
    return this.edit(idOrName, { mode }, actor)
  }

  /**
   * Assign tool allow/deny lists.
   * @param idOrName - target agent.
   * @param tools - lists to replace; an omitted list is unchanged.
   * @param actor - who performs the operation.
   * @returns the updated agent.
   */
  assignTools(idOrName: string, tools: Partial<MainAgentTools>, actor: MainAgentActor): Promise<MainAgentView> {
    return this.edit(idOrName, { tools }, actor)
  }

  /**
   * Assign a workspace directory, or `null` for the default. A changed workspace starts a new Session.
   * @param idOrName - target agent.
   * @param workspace - absolute directory path or null.
   * @param actor - who performs the operation.
   * @returns the updated agent.
   */
  assignWorkspace(idOrName: string, workspace: string | null, actor: MainAgentActor): Promise<MainAgentView> {
    return this.edit(idOrName, { workspace }, actor)
  }

  /**
   * Change one main agent's permissions through the KairoForge permission-preset system.
   * @param idOrName - target agent.
   * @param permissions - permission fields to change.
   * @param actor - who performs the operation.
   * @returns the updated agent.
   */
  managePermissions(
    idOrName: string,
    permissions: Partial<MainAgentPermissions>,
    actor: MainAgentActor,
  ): Promise<MainAgentView> {
    return this.edit(idOrName, { permissions }, actor)
  }

  /**
   * Create sub-agent teammates under one main agent, which is the Lead of its
   * own Agent Team, and report the team roster.
   * @param idOrName - target main agent.
   * @param members - teammates to create; empty only reports the roster.
   * @param actor - who performs the operation.
   * @param signal - cancellation for teammate creation.
   * @returns the agent, the created teammate names, and the full roster.
   */
  async createTeam(
    idOrName: string,
    members: readonly MainAgentTeammateRequest[],
    actor: MainAgentActor,
    signal: AbortSignal,
  ): Promise<{ agent: MainAgentView; created: string[]; members: MainAgentTeamMember[] }> {
    await this.ready
    const record = this.requireActive(idOrName)
    const teams = this.ctx.get('agentTeams')
    if (teams === undefined) {
      throw new MainAgentError('unavailable', 'Agent Teams is not enabled in this KairoForge profile')
    }
    const agent = await this.liveAgent(await this.ensureSession(record))
    const created: string[] = []
    for (const member of members) {
      const result = await teams.spawnTeammate(agent, {
        name: member.name,
        description: member.description,
        prompt: [
          { type: 'text', text: `<system-reminder>\nYou are teammate "${member.name.trim()}" in the sub-agent team of main agent "${record.name}".\nYour Team Lead is named "lead".\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\n</system-reminder>\n\n` },
          { type: 'text', text: member.prompt },
        ],
        context: 'fresh',
        provider: this.options.teamProvider,
        signal,
      })
      created.push(result.member.name)
    }
    if (created.length > 0) {
      await this.note(record.id, 'team', `${actorName(actor)} added teammates: ${created.join(', ')}`)
    }
    const roster = teams.listMembers(agent).map(member => ({
      name: member.name,
      role: member.role,
      status: member.status,
    }))
    return { agent: this.view(this.require(record.id)), created, members: roster }
  }

  /**
   * Send one message to a main agent (by id or name) or to a top-level Session
   * (by Session id, for replies to Lead). The message enters the target's chat
   * and starts or queues a turn.
   * @param target - main agent id/name or top-level Session id.
   * @param message - message text.
   * @param actor - sender.
   * @returns delivery receipt.
   */
  async sendMessage(target: string, message: string, actor: MainAgentActor): Promise<MainAgentDelivery> {
    await this.ready
    const text = message.trim()
    if (text === '') throw new MainAgentError('invalid', 'message must not be empty')
    const record = this.find(target)
    if (record === undefined) {
      const sessionId = await this.topLevelSession(target)
      await this.prompt(sessionId, frame('message', actor, `Session ${sessionId}`, text))
      return { target, sessionId, status: 'accepted' }
    }
    const active = this.requireDeliverable(record)
    const bound = await this.ensureSession(active)
    const sessionId = this.sessionIdOf(bound)
    await this.prompt(sessionId, frame('message', actor, `main agent "${bound.name}"`, text))
    await this.note(bound.id, 'message', `Message from ${actorName(actor)}`)
    return { target: bound.id, sessionId, status: 'accepted' }
  }

  /**
   * Delegate one task to a main agent; the agent works on it in its own Session.
   * @param idOrName - target main agent.
   * @param task - complete task description.
   * @param actor - delegator.
   * @returns delivery receipt.
   */
  async delegateTask(idOrName: string, task: string, actor: MainAgentActor): Promise<MainAgentDelivery> {
    await this.ready
    const text = task.trim()
    if (text === '') throw new MainAgentError('invalid', 'task must not be empty')
    const record = this.requireDeliverable(this.require(idOrName))
    const bound = await this.ensureSession(record)
    const sessionId = this.sessionIdOf(bound)
    await this.prompt(sessionId, frame('task', actor, `main agent "${bound.name}"`, text))
    await this.note(bound.id, 'task', `Task from ${actorName(actor)}: ${text.slice(0, 80)}`)
    return { target: bound.id, sessionId, status: 'accepted' }
  }

  // ---------------------------------------------------------------------------
  // Internals

  private view(record: MainAgentRecord): MainAgentView {
    const live = record.sessionId === undefined ? undefined : this.ctx.agents.get(SessionId(record.sessionId))
    const runtime = live === undefined ? 'unloaded' : live.status === 'running' ? 'busy' : 'idle'
    return { ...record, runtime }
  }

  private find(idOrName: string): MainAgentRecord | undefined {
    const table = this.domain?.table('agents')
    if (table === undefined) return undefined
    const key = idOrName.trim()
    const direct = table.get(key)
    if (direct !== undefined) return direct
    const lower = key.toLowerCase()
    for (const [, record] of table.entries()) {
      if (record.name.toLowerCase() === lower) return record
    }
    return undefined
  }

  private require(idOrName: string): MainAgentRecord {
    const record = this.find(idOrName)
    if (record === undefined) throw new MainAgentError('not-found', `no main agent named "${idOrName}"`)
    return record
  }

  private requireActive(idOrName: string): MainAgentRecord {
    const record = this.require(idOrName)
    if (record.status === 'archived') throw new MainAgentError('archived', `main agent "${record.name}" is archived; start it to restore it`)
    return record
  }

  private requireDeliverable(record: MainAgentRecord): MainAgentRecord {
    if (record.status === 'archived') throw new MainAgentError('archived', `main agent "${record.name}" is archived; start it to restore it`)
    if (record.status === 'stopped') throw new MainAgentError('stopped', `main agent "${record.name}" is stopped; start it before sending work`)
    return record
  }

  private sessionIdOf(record: MainAgentRecord): SessionId {
    if (record.sessionId === undefined) throw new MainAgentError('unavailable', `main agent "${record.name}" has no Session`)
    return SessionId(record.sessionId)
  }

  private validName(name: string): string {
    const clean = name.trim().replaceAll(/\s+/g, ' ')
    if (clean === '') throw new MainAgentError('invalid', 'name must not be empty')
    if (clean.length > NAME_LIMIT) throw new MainAgentError('invalid', `name must be at most ${String(NAME_LIMIT)} characters`)
    if (RESERVED_IDS.has(clean.toLowerCase())) throw new MainAgentError('invalid', `"${clean}" is reserved for the built-in Lead`)
    return clean
  }

  private assertNameFree(name: string, except?: string): void {
    const lower = name.toLowerCase()
    for (const [, record] of this.domain?.table('agents').entries() ?? []) {
      if (record.id !== except && record.name.toLowerCase() === lower) {
        throw new MainAgentError('conflict', `a main agent named "${record.name}" already exists`)
      }
    }
  }

  private freshId(name: string): string {
    const table = this.domain?.table('agents')
    const stem = slugOf(name)
    const base = RESERVED_IDS.has(stem) ? `${stem}-agent` : stem
    let id = base
    for (let suffix = 2; table?.get(id) !== undefined; suffix++) id = `${base}-${String(suffix)}`
    return id
  }

  private validModel(model: MainAgentModel): MainAgentModel {
    const provider = model.provider.trim()
    const id = model.model.trim()
    if (provider === '' || id === '') throw new MainAgentError('invalid', 'model requires provider and model')
    const effort = model.reasoningEffort?.trim()
    return effort === undefined || effort === '' ? { provider, model: id } : { provider, model: id, reasoningEffort: effort }
  }

  private validWorkspace(workspace: string): string {
    const path = workspace.trim()
    if (!isAbsolute(path)) throw new MainAgentError('invalid', 'workspace must be an absolute directory path')
    return path
  }

  private validPermissions(permissions: MainAgentPermissions): MainAgentPermissions {
    const presets = this.ctx.get('permissionPresets')
    if (presets !== undefined) {
      try {
        presets.resolve(permissions.preset)
      } catch (error) {
        throw new MainAgentError('invalid', `unknown permission preset "${permissions.preset}": ${String(error)}`)
      }
    }
    return { preset: permissions.preset, agentAdministration: permissions.agentAdministration }
  }

  private async validateMode(mode: string): Promise<void> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return
    try {
      await presets.resolve(mode)
    } catch (error) {
      throw new MainAgentError('invalid', `unknown mode "${mode}": ${String(error)}`)
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => {})
    return next
  }

  private async setStatus(
    id: string,
    status: MainAgentRecord['status'],
    kind: MainAgentActivity['kind'],
    text: string,
  ): Promise<MainAgentRecord> {
    const domain = await this.ready
    const updated = await this.serialize(async () => {
      const latest = this.require(id)
      const next: MainAgentRecord = {
        ...latest,
        status,
        updatedAt: new Date().toISOString(),
        activity: appendActivity(latest.activity, kind, text),
      }
      await domain.table('agents').put(id, next)
      return next
    })
    this.ctx.emit('main-agents/changed', updated)
    return updated
  }

  private async note(id: string, kind: MainAgentActivity['kind'], text: string): Promise<void> {
    const domain = await this.ready
    await this.serialize(async () => {
      const latest = this.require(id)
      await domain.table('agents').put(id, {
        ...latest,
        updatedAt: new Date().toISOString(),
        activity: appendActivity(latest.activity, kind, text),
      })
    })
  }

  private cancelLive(record: MainAgentRecord): void {
    if (record.sessionId === undefined) return
    this.ctx.agents.get(SessionId(record.sessionId))?.cancel({ kind: 'user' }, { keepInbox: false })
  }

  private async liveAgent(record: MainAgentRecord): Promise<Agent> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.sessionIdOf(record))
    if ('error' in resolved) {
      throw new MainAgentError('unavailable', `main agent "${record.name}" Session is unavailable: ${resolved.error.message}`)
    }
    return resolved.agent
  }

  /**
   * Bind the record to a loaded Session, creating one when it has none or its
   * Session no longer exists. The Session id is committed before creation so
   * Agent-scoped installers recognize the Session from its first event.
   */
  private async ensureSession(record: MainAgentRecord): Promise<MainAgentRecord> {
    const domain = await this.ready
    if (record.sessionId !== undefined) {
      const resolved = await this.ctx.sessionController.resolveAgent(SessionId(record.sessionId))
      if (!('error' in resolved)) return this.require(record.id)
      if (resolved.error.code !== 'session/not-found') {
        throw new MainAgentError('unavailable', `main agent "${record.name}" Session is unavailable: ${resolved.error.message}`)
      }
    }
    const sessionId = SessionId(`session-${randomUUID()}`)
    const bound = await this.serialize(async () => {
      const latest = this.require(record.id)
      const next: MainAgentRecord = {
        ...latest,
        sessionId,
        previousSessionIds: latest.sessionId === undefined || latest.previousSessionIds.includes(latest.sessionId)
          ? latest.previousSessionIds
          : [...latest.previousSessionIds, latest.sessionId],
        updatedAt: new Date().toISOString(),
        activity: appendActivity(latest.activity, 'session', `Chat session ${sessionId} started`),
      }
      await domain.table('agents').put(next.id, next)
      return next
    })
    try {
      await this.ctx.sessionController.create({
        sessionId,
        agentPreset: bound.mode,
        ...bound.workspace === undefined ? {} : { cwd: bound.workspace },
      })
    } catch (error) {
      await this.serialize(async () => {
        const { sessionId: _failed, ...rest } = this.require(record.id)
        await domain.table('agents').put(rest.id, { ...rest, updatedAt: new Date().toISOString() })
      })
      throw new MainAgentError('unavailable', `could not create a Session for "${bound.name}": ${String(error)}`)
    }
    this.ctx.emit('main-agents/changed', bound)
    await this.applySessionConfig(bound, { model: bound.model !== undefined, permissions: true, title: true })
    return this.require(record.id)
  }

  /** Push registry configuration into the agent's Session through the existing Session and permission services. */
  private async applySessionConfig(
    record: MainAgentRecord,
    what: { readonly model: boolean; readonly permissions: boolean; readonly title: boolean },
  ): Promise<void> {
    if (!what.model && !what.permissions && !what.title) return
    const sessionId = this.sessionIdOf(record)
    const controller = this.ctx.sessionController
    if (what.model && record.model !== undefined) {
      // Session model selection also rewrites the global default; restore it so
      // a main agent's model never changes Lead's default.
      const defaults = this.ctx.get('agentDefaultModel')
      const previous = defaults?.currentSelection()
      await controller.selectModel({ sessionId, ...record.model })
      if (defaults !== undefined && previous !== undefined) await defaults.saveSelection(previous)
    }
    const agent = await this.liveAgent(record)
    if (what.permissions) this.ctx.get('permissionPresets')?.set(agent.session, record.permissions.preset)
    if (what.title && this.ctx.get('sessionTitle') !== undefined) {
      await controller.rename({ sessionId, title: record.name }).catch((error: unknown) => {
        this.ctx.logger.warn(`main-agents: could not title Session ${sessionId}: ${String(error)}`)
      })
    }
  }

  private async topLevelSession(target: string): Promise<SessionId> {
    const sessionId = SessionId(target.trim())
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw new MainAgentError('not-found', `no main agent or Session named "${target}"`)
    if (!isTopLevelSession(resolved.agent.session.header)) {
      throw new MainAgentError('forbidden', `Session "${target}" is a sub-agent; use the Agent Team send_message tool instead`)
    }
    return sessionId
  }

  private async prompt(sessionId: SessionId, text: string): Promise<void> {
    await this.ctx.sessionController.prompt({
      requestId: brandString<SessionRequestId>(`main-agents-${randomUUID()}`),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, AbortSignal.timeout(30_000))
  }
}

/** Short actor label for activity lines and message frames. */
function actorName(actor: MainAgentActor): string {
  return actor.kind === 'user' ? 'the user' : `${actor.name} (${actor.sessionId})`
}

function appendActivity(
  activity: readonly MainAgentActivity[],
  kind: MainAgentActivity['kind'],
  text: string,
): MainAgentActivity[] {
  return [...activity, { at: new Date().toISOString(), kind, text }].slice(-ACTIVITY_LIMIT)
}

/** Frame an agent-to-agent message so the recipient knows the sender and how to reply. */
function frame(kind: 'message' | 'task', actor: MainAgentActor, recipient: string, text: string): string {
  const header = kind === 'task' ? '[KairoForge delegated task]' : '[KairoForge agent message]'
  const lines = [header, `From: ${actor.kind === 'user' ? 'the user (Agents panel)' : `${actor.name} (Session ${actor.sessionId})`}`, `To: ${recipient}`]
  if (actor.kind === 'session') {
    lines.push(kind === 'task'
      ? `When the task is done, report the result with send_agent_message({ agent_id: "${actor.sessionId}", message: "..." }).`
      : `Reply with send_agent_message({ agent_id: "${actor.sessionId}", message: "..." }) when the sender needs an answer or a result; do not reply to acknowledgements or thanks.`)
  }
  return `${lines.join('\n')}\n\n${text}`
}
