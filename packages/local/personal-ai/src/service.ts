/**
 * Personal AI service (`ctx.personalAi`). It is the memory, project registry,
 * personality, task-control, and live-state layer of KairoForge's coordinator.
 * Real work always runs through existing services: the Agent Registry,
 * orchestration (workflows, background tasks, delegation, routing), and the
 * Session controller. Nothing here bypasses permissions.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { classifyModelCategory, headState, messageBody, redact, repoRoot, type MainAgentRegistry, type Orchestrator } from '@local/main-agents'
import { deriveState, orbStateOf, STATE_TEXT, type AssistantState, type OrbState, type VoicePhase } from './core/assistant-state.ts'
import { rankAgents, agentTags, type AgentCandidate, type AgentScore, type AgentTag } from './core/capabilities.ts'
import { classifyDepth } from './core/classifier.ts'
import { searchMemories, type MemoryQuery, type MemoryScope } from './core/memory.ts'
import { summarizeTurns, type MetricsSummary, type TurnRecord } from './core/metrics.ts'
import { MAX_SAY_CHARS, MAX_UPDATES, repeatsUpdate, toolUpdate } from './core/narration.ts'
import { findSensitive } from './core/sensitive.ts'
import { personalAiDomain } from './storage.ts'
import {
  DEFAULT_PERSONALITY, PersonalAiError,
  type ControlAction, type ConverseTurn, type ConverseUpdate, type ControlRecord, type CoordinatorDecision, type MemoryEntry,
  type Personality, type ProjectCommands, type ProjectRecord, type StoredPersonalSettings, type TaskRef,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** KairoForge Personal AI: memory, projects, personality, task control, and assistant state. */
    personalAi: PersonalAi
  }
  interface Events {
    /**
     * Personality or the coordinator switch changed; coordinator prompts rebuild.
     * @mode emit
     * @param personality - effective personality.
     */
    'personal-ai/personality'(personality: Personality): void
  }
}

type PersonalDomain = Domain<typeof personalAiDomain>

const run = promisify(execFile)
const MEMORY_LIMIT = 2000
const CONTROL_LIMIT = 300
const TURN_LIMIT = 500
const NOTICE_LIMIT = 60
const CONVERSE_LIMIT = 50
const CONVERSE_MAX_CHARS = 4000
const CONVERSE_REPLY_CHARS = 8000
/** A conversation whose last model call sent more than this many tokens continues in a fresh Session: every turn resends the history. */
const CONVERSE_FRESH_TOKENS = 90_000

/** A Command Center turn still running in its conversation Session. */
interface PendingConverse {
  readonly turnId: string
  started: boolean
  reply: string
  /** The current step's tool calls came with the model's own words. */
  narrated: boolean
}

/** Live facts about one coordinator Session. */
interface LiveSession {
  busy: boolean
  tool?: string
  readonly pending: Set<string>
  errored: boolean
  turnStart?: number
  steps: number
  toolCalls: number
  approvals: number
  delegated: boolean
  /** Tokens used by this turn's model calls so far. */
  tokens: number
  mode: string
  lastActive: number
}

/** Result of applying one control before it is recorded. */
interface ControlOutcome {
  readonly outcome: ControlRecord['outcome']
  readonly detail: string
  readonly state?: string
}

/** One Personal AI notification. */
export interface PersonalNotice {
  readonly id: string
  readonly at: string
  readonly level: 'info' | 'success' | 'warning' | 'error'
  readonly kind: string
  readonly text: string
}

/** Assistant state as the browser sees it. */
export interface AssistantStateView {
  readonly state: AssistantState
  readonly text: string
  readonly orb: OrbState
  readonly sessionId?: string
  readonly tool?: string
  readonly decision?: CoordinatorDecision
  readonly pendingApprovals: number
  readonly delegatedWork: number
  readonly voice: VoicePhase
  readonly at: string
}

/** Fields accepted when creating a project. */
export interface ProjectInput {
  readonly name: string
  readonly path?: string
  readonly description?: string
  readonly stack?: readonly string[]
  readonly commands?: ProjectCommands
  readonly docs?: readonly string[]
}

/** Personal AI service. */
export class PersonalAi extends Service {
  static inject = ['storageDomain', 'orchestration', 'mainAgents', 'agents', 'sessionController']

  private readonly ready: Promise<PersonalDomain>
  private domain: PersonalDomain | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly live = new Map<string, LiveSession>()
  private readonly decisions = new Map<string, CoordinatorDecision>()
  private readonly approvals = new Map<string, Set<string>>()
  private readonly notices: PersonalNotice[] = []
  private readonly conversation = new Map<string, ConverseTurn>()
  private readonly converseBySession = new Map<string, PendingConverse>()
  private voice: VoicePhase = 'off'
  private focus: string | undefined

  /**
   * @param ctx - Host context.
   */
  constructor(ctx: Context) {
    super(ctx, 'personalAi')
    this.ready = ctx.storageDomain.open(personalAiDomain).then((domain) => {
      this.domain = domain
      return domain
    })
    ctx.effect(() => async () => {
      const domain = await this.ready
      await this.chain.catch(() => {})
      await domain.close()
    }, 'personal-ai: domain')
  }

  /** Resolve once storage is open. */
  async whenReady(): Promise<PersonalDomain> {
    return this.ready
  }

  private get store(): PersonalDomain {
    if (this.domain === undefined) throw new Error('personal-ai storage is not open yet')
    return this.domain
  }

  private get orchestration(): Orchestrator {
    return this.ctx.orchestration
  }

  private get registry(): MainAgentRegistry {
    return this.ctx.mainAgents
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => {})
    return next
  }

  private settings(): StoredPersonalSettings {
    return this.domain?.global.get() ?? {}
  }

  private async patchSettings(changes: StoredPersonalSettings): Promise<void> {
    const domain = await this.ready
    await this.serialize(async () => {
      await domain.global.set({ ...domain.global.get(), ...changes })
    })
  }

  /**
   * Publish one notification.
   * @param notice - level, kind, and text.
   */
  notify(notice: Omit<PersonalNotice, 'id' | 'at'>): void {
    this.notices.push({ ...notice, text: redact(notice.text).slice(0, 300), id: randomUUID(), at: new Date().toISOString() })
    if (this.notices.length > NOTICE_LIMIT) this.notices.shift()
  }

  // ---------------------------------------------------------------------------
  // Personality and coordinator switch

  /** Effective personality. */
  personality(): Personality {
    const stored = this.settings().personality ?? {}
    return { ...DEFAULT_PERSONALITY, ...stored, voice: { ...DEFAULT_PERSONALITY.voice, ...stored.voice } }
  }

  /**
   * Change personality fields.
   * @param changes - fields to change.
   * @returns effective personality.
   */
  async updatePersonality(changes: Partial<Personality>): Promise<Personality> {
    const current = this.settings().personality ?? {}
    await this.patchSettings({ personality: { ...current, ...changes } })
    this.ctx.emit('personal-ai/personality', this.personality())
    return this.personality()
  }

  /** Whether the coordinator prompt is active on Lead Sessions. */
  coordinatorEnabled(): boolean {
    return this.settings().coordinator ?? true
  }

  /**
   * Turn the coordinator on or off.
   * @param enabled - new value.
   */
  async setCoordinator(enabled: boolean): Promise<void> {
    await this.patchSettings({ coordinator: enabled })
    this.ctx.emit('personal-ai/personality', this.personality())
  }

  // ---------------------------------------------------------------------------
  // Memory

  /**
   * Search memories.
   * @param query - filter and text.
   * @returns ranked entries.
   */
  memories(query: MemoryQuery = {}): MemoryEntry[] {
    return searchMemories(rows(this.domain?.table('memory')), query)
  }

  /**
   * Save one memory. Sensitive text is rejected, never stored.
   * @param input - scope, text, tags.
   * @param by - `user` or the saving Session id.
   * @returns the stored entry.
   */
  async remember(
    input: { readonly scope: MemoryScope; readonly scopeId?: string; readonly text: string; readonly tags?: readonly string[] },
    by: string,
  ): Promise<MemoryEntry> {
    const text = input.text.trim()
    if (text === '') throw new PersonalAiError('invalid', 'a memory needs text')
    const finding = findSensitive(text)
    if (finding.sensitive) throw new PersonalAiError('sensitive', `not saved: the text ${finding.reason ?? 'looks sensitive'}. Secrets and credentials never become memory; use KairoForge's credential storage instead.`)
    if ((input.scope === 'project' || input.scope === 'agent' || input.scope === 'session') && input.scopeId === undefined) {
      throw new PersonalAiError('invalid', `a ${input.scope} memory needs a scopeId`)
    }
    const scoped = input.scopeId === undefined ? {} : { scopeId: input.scopeId }
    const duplicate = this.memories({ scope: input.scope, ...scoped, includeDisabled: true })
      .find(entry => entry.text.toLowerCase() === text.toLowerCase())
    if (duplicate !== undefined) return duplicate
    const now = new Date().toISOString()
    const entry: MemoryEntry = {
      id: `mem-${randomUUID().slice(0, 8)}`,
      scope: input.scope,
      ...input.scope === 'user' || input.scopeId === undefined ? {} : { scopeId: input.scopeId },
      text: text.slice(0, 2000),
      tags: [...new Set((input.tags ?? []).map(tag => tag.trim().toLowerCase()).filter(tag => tag !== ''))].slice(0, 8),
      status: 'active',
      source: by === 'user' ? 'user' : 'assistant',
      createdBy: by,
      createdAt: now,
      updatedAt: now,
    }
    const domain = await this.ready
    await this.serialize(async () => {
      await domain.table('memory').put(entry.id, entry)
      await this.pruneTable('memory', MEMORY_LIMIT)
    })
    this.notify({ level: 'info', kind: 'memory', text: `Remembered (${entry.scope}): ${entry.text.slice(0, 80)}` })
    return entry
  }

  /**
   * Correct, disable, or re-enable a memory.
   * @param id - memory id.
   * @param changes - new text, tags, or status.
   * @returns the updated entry.
   */
  async updateMemory(id: string, changes: { readonly text?: string; readonly tags?: readonly string[]; readonly status?: 'active' | 'disabled' }): Promise<MemoryEntry> {
    const current = this.requireMemory(id)
    if (changes.text !== undefined) {
      const finding = findSensitive(changes.text)
      if (finding.sensitive) throw new PersonalAiError('sensitive', `not saved: the text ${finding.reason ?? 'looks sensitive'}`)
      if (changes.text.trim() === '') throw new PersonalAiError('invalid', 'a memory needs text')
    }
    const next: MemoryEntry = {
      ...current,
      ...changes.text === undefined ? {} : { text: changes.text.trim().slice(0, 2000) },
      ...changes.tags === undefined ? {} : { tags: changes.tags.map(tag => tag.trim().toLowerCase()).filter(tag => tag !== '').slice(0, 8) },
      ...changes.status === undefined ? {} : { status: changes.status },
      updatedAt: new Date().toISOString(),
    }
    const domain = await this.ready
    await this.serialize(async () => { await domain.table('memory').put(id, next) })
    return next
  }

  /**
   * Delete a memory.
   * @param id - memory id.
   * @returns the deleted entry.
   */
  async forget(id: string): Promise<MemoryEntry> {
    const current = this.requireMemory(id)
    const domain = await this.ready
    await this.serialize(async () => { await domain.table('memory').delete(id) })
    return current
  }

  private requireMemory(id: string): MemoryEntry {
    const entry = this.domain?.table('memory').get(id)
    if (entry === undefined) throw new PersonalAiError('not-found', `no memory "${id}"`)
    return entry
  }

  // ---------------------------------------------------------------------------
  // Projects

  /**
   * List projects, most recently used first.
   * @param includeArchived - include archived projects.
   * @returns projects.
   */
  projects(includeArchived = false): ProjectRecord[] {
    return rows(this.domain?.table('projects'))
      .filter(project => includeArchived || project.status === 'active')
      .toSorted((a, b) => (b.lastOpenedAt ?? b.updatedAt).localeCompare(a.lastOpenedAt ?? a.updatedAt))
  }

  /**
   * Find one project by id or name.
   * @param idOrName - project id or case-insensitive name.
   * @returns the project.
   */
  project(idOrName: string): ProjectRecord {
    const key = idOrName.trim()
    const table = this.domain?.table('projects')
    const found = table?.get(key) ?? rows(table).find(project => project.name.toLowerCase() === key.toLowerCase())
    if (found === undefined) throw new PersonalAiError('not-found', `no project named "${idOrName}"`)
    return found
  }

  /** The project the user is working in, if any. */
  activeProject(): ProjectRecord | undefined {
    const id = this.settings().activeProjectId
    if (id === undefined) return undefined
    const project = this.domain?.table('projects').get(id)
    return project?.status === 'active' ? project : undefined
  }

  /**
   * Register a project. Facts not given are left empty, never guessed.
   * @param input - name and known facts.
   * @returns the project.
   */
  async createProject(input: ProjectInput): Promise<ProjectRecord> {
    const name = input.name.trim()
    if (name === '') throw new PersonalAiError('invalid', 'a project needs a name')
    if (this.projects(true).some(project => project.name.toLowerCase() === name.toLowerCase())) {
      throw new PersonalAiError('conflict', `a project named "${name}" already exists`)
    }
    const now = new Date().toISOString()
    const project: ProjectRecord = {
      id: `prj-${randomUUID().slice(0, 8)}`,
      name: name.slice(0, 80),
      ...input.path === undefined || input.path.trim() === '' ? {} : { path: input.path.trim() },
      description: (input.description ?? '').trim().slice(0, 1000),
      stack: [...input.stack ?? []].map(item => item.trim()).filter(item => item !== '').slice(0, 20),
      commands: input.commands ?? {},
      agentIds: [],
      decisions: [],
      docs: [...input.docs ?? []].slice(0, 20),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    await this.saveProject(project)
    this.notify({ level: 'info', kind: 'project', text: `Project "${project.name}" created.` })
    return project
  }

  /**
   * Change project facts, or record a decision.
   * @param idOrName - project.
   * @param changes - fields to change; `decision` appends to the decision log.
   * @returns the project.
   */
  async updateProject(
    idOrName: string,
    changes: Partial<Pick<ProjectRecord, 'name' | 'description' | 'stack' | 'docs'>> & { readonly path?: string | null; readonly commands?: ProjectCommands; readonly decision?: string },
  ): Promise<ProjectRecord> {
    const current = this.project(idOrName)
    const { path, decision, commands, ...rest } = changes
    const base: ProjectRecord = { ...current, ...rest }
    const withPath: ProjectRecord = path === undefined
      ? base
      : path === null || path.trim() === '' ? dropKey(base, 'path') : { ...base, path: path.trim() }
    const next: ProjectRecord = {
      ...withPath,
      ...commands === undefined ? {} : { commands: { ...current.commands, ...commands } },
      ...decision === undefined || decision.trim() === '' ? {} : { decisions: [...current.decisions, { at: new Date().toISOString(), text: decision.trim().slice(0, 500) }].slice(-100) },
      updatedAt: new Date().toISOString(),
    }
    await this.saveProject(next)
    return next
  }

  /**
   * Make a project the active one.
   * @param idOrName - project.
   * @returns the project.
   */
  async openProject(idOrName: string): Promise<ProjectRecord> {
    const current = this.project(idOrName)
    if (current.status === 'archived') throw new PersonalAiError('conflict', `project "${current.name}" is archived`)
    const next: ProjectRecord = { ...current, lastOpenedAt: new Date().toISOString() }
    await this.saveProject(next)
    await this.patchSettings({ activeProjectId: next.id })
    return next
  }

  /**
   * Archive a project; it is kept, hidden, and no longer active.
   * @param idOrName - project.
   * @returns the project.
   */
  async archiveProject(idOrName: string): Promise<ProjectRecord> {
    const current = this.project(idOrName)
    const next: ProjectRecord = { ...current, status: 'archived', updatedAt: new Date().toISOString() }
    await this.saveProject(next)
    if (this.settings().activeProjectId === current.id) {
      const domain = await this.ready
      await this.serialize(async () => {
        await domain.global.set(dropKey(domain.global.get(), 'activeProjectId'))
      })
    }
    return next
  }

  /**
   * Assign or unassign a main agent to a project.
   * @param idOrName - project.
   * @param agentIdOrName - main agent.
   * @param assigned - false removes the assignment.
   * @returns the project.
   */
  async assignAgent(idOrName: string, agentIdOrName: string, assigned = true): Promise<ProjectRecord> {
    const current = this.project(idOrName)
    const agent = await this.registry.get(agentIdOrName)
    const ids = new Set(current.agentIds)
    if (assigned) ids.add(agent.id)
    else ids.delete(agent.id)
    const next: ProjectRecord = { ...current, agentIds: [...ids], updatedAt: new Date().toISOString() }
    await this.saveProject(next)
    return next
  }

  /**
   * Live project status: Git state, assigned agents, and running work.
   * @param idOrName - project; defaults to the active project.
   * @returns status facts.
   */
  async projectStatus(idOrName?: string): Promise<Record<string, unknown>> {
    const project = idOrName === undefined ? this.activeProject() : this.project(idOrName)
    if (project === undefined) throw new PersonalAiError('not-found', 'no active project; open one first')
    let git: Record<string, unknown> = { available: false }
    if (project.path !== undefined) {
      const root = await repoRoot(project.path).catch(() => undefined)
      if (root !== undefined) {
        const head = await headState(root)
        const porcelain = await run('git', ['-C', root, 'status', '--porcelain=v1'], { timeout: 10_000 }).then(result => result.stdout, () => '')
        const lines = porcelain.split('\n').filter(line => line.trim() !== '')
        git = {
          available: true,
          root,
          branch: head.branch ?? '(detached)',
          head: head.head?.slice(0, 12),
          changed: lines.length,
          untracked: lines.filter(line => line.startsWith('??')).length,
          files: lines.slice(0, 15).map(line => line.slice(3)),
        }
      }
    }
    const agents = await this.registry.list()
    const assigned = agents.filter(agent => project.agentIds.includes(agent.id))
    const background = this.orchestration.background.list()
      .filter(task => project.agentIds.includes(task.agentId) && (task.status === 'running' || task.status === 'queued' || task.status === 'paused'))
    return {
      project: {
        id: project.id, name: project.name, path: project.path, stack: project.stack, commands: project.commands, docs: project.docs,
      },
      git,
      agents: assigned.map(agent => ({ id: agent.id, name: agent.name, status: agent.status, runtime: agent.runtime })),
      background: background.map(task => ({ id: task.id, title: task.title, status: task.status, progress: task.progress })),
      recentDecisions: project.decisions.slice(-5),
    }
  }

  private async saveProject(project: ProjectRecord): Promise<void> {
    const domain = await this.ready
    await this.serialize(async () => { await domain.table('projects').put(project.id, project) })
  }

  // ---------------------------------------------------------------------------
  // Task control

  /**
   * Pause, resume, cancel, update, or constrain running work. The outcome
   * says exactly what happened; nothing reports success it did not observe.
   * @param ref - background task, workflow, or Session (main agent id or name accepted).
   * @param action - control action.
   * @param text - update or constraint text.
   * @param by - `user` or the controlling Session id.
   * @returns the recorded outcome.
   */
  async control(ref: TaskRef, action: ControlAction, text: string | undefined, by: string): Promise<ControlRecord> {
    if ((action === 'update' || action === 'constrain') && (text === undefined || text.trim() === '')) {
      throw new PersonalAiError('invalid', `${action} needs text`)
    }
    const outcome: ControlOutcome = await this.applyControl(ref, action, text?.trim() ?? '').catch((error: unknown) => ({
      outcome: 'rejected' as const, detail: error instanceof Error ? error.message : String(error),
    }))
    const record: ControlRecord = {
      id: `ctl-${randomUUID().slice(0, 8)}`,
      ref,
      action,
      ...text === undefined || text.trim() === '' ? {} : { text: redact(text.trim()).slice(0, 1000) },
      outcome: outcome.outcome,
      detail: outcome.detail,
      ...outcome.state === undefined ? {} : { state: outcome.state },
      by,
      at: new Date().toISOString(),
    }
    const domain = await this.ready
    await this.serialize(async () => {
      await domain.table('controls').put(record.id, record)
      await this.pruneTable('controls', CONTROL_LIMIT)
    })
    this.notify({
      level: record.outcome === 'rejected' ? 'warning' : 'success',
      kind: 'control',
      text: `${action} ${ref.kind} ${ref.id}: ${record.outcome} — ${record.detail}`,
    })
    return record
  }

  /** Recent controls, newest first. */
  controls(limit = 50): ControlRecord[] {
    return rows(this.domain?.table('controls')).toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
  }

  private async applyControl(ref: TaskRef, action: ControlAction, text: string): Promise<ControlOutcome> {
    const framed = (header: string): string => `[KairoForge ${header}]\n\n${text}`
    if (ref.kind === 'background') {
      const runner = this.orchestration.background
      const task = runner.get(ref.id)
      switch (action) {
        case 'pause': {
          if (task.status !== 'running' && task.status !== 'queued') return { outcome: 'rejected', detail: `task is ${task.status}; only running or queued tasks can be paused`, state: task.status }
          const next = await runner.pause(ref.id)
          return { outcome: 'applied', detail: task.status === 'running' ? 'paused; the running turn was interrupted' : 'paused before it started', state: next.status }
        }
        case 'resume': {
          if (task.status !== 'paused') return { outcome: 'rejected', detail: `task is ${task.status}; only paused tasks can be resumed`, state: task.status }
          const next = await runner.resume(ref.id)
          return { outcome: 'applied', detail: 'resumed; it continues from where it stopped', state: next.status }
        }
        case 'cancel': {
          if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return { outcome: 'rejected', detail: `task already ${task.status}`, state: task.status }
          const next = await runner.cancel(ref.id)
          return { outcome: 'applied', detail: 'cancelled', state: next.status }
        }
        default: {
          if (task.status === 'running' && task.sessionId !== undefined) {
            await this.registry.promptSession(task.sessionId, framed(action === 'update' ? `task update for ${task.id}` : `task constraint for ${task.id}`))
            return { outcome: 'delivered', detail: 'sent to the running agent; it applies the change at its next step', state: task.status }
          }
          if (task.status === 'queued' || task.status === 'paused') {
            const next = await runner.amend(ref.id, action === 'constrain' ? `Constraint: ${text}` : text)
            return { outcome: 'applied', detail: 'added to the task; it applies when the task starts or resumes', state: next.status }
          }
          return { outcome: 'rejected', detail: `task already ${task.status}`, state: task.status }
        }
      }
    }
    if (ref.kind === 'workflow') {
      const workflow = this.orchestration.workflows.get(ref.id)
      const active = workflow.status === 'running' || workflow.status === 'integrating'
      if (action === 'pause' || action === 'resume') return { outcome: 'rejected', detail: 'workflows cannot be paused; cancel it, or update it with new instructions', state: workflow.status }
      if (action === 'cancel') {
        if (!active) return { outcome: 'rejected', detail: `workflow already ${workflow.status}`, state: workflow.status }
        const next = await this.orchestration.workflows.cancel(ref.id, { sessionId: 'user', name: 'the user' })
        return { outcome: 'applied', detail: 'cancelled; running workers were interrupted', state: next.status }
      }
      if (!active) return { outcome: 'rejected', detail: `workflow already ${workflow.status}`, state: workflow.status }
      const workers = workflow.tasks.filter(task => task.status === 'running' && task.workerSessionId !== undefined)
      const header = action === 'update' ? `workflow update for ${workflow.id}` : `workflow constraint for ${workflow.id}`
      await this.registry.promptSession(workflow.ownerSessionId, framed(header))
      for (const task of workers) {
        if (task.workerSessionId !== undefined) await this.deliverToSession(task.workerSessionId, framed(header))
      }
      return { outcome: 'delivered', detail: `sent to the workflow owner and ${String(workers.length)} running worker(s)`, state: workflow.status }
    }
    const sessionId = await this.resolveSession(ref.id)
    const live = this.ctx.agents.get(SessionId(sessionId))
    const running = live?.status === 'running'
    if (action === 'pause' || action === 'resume') return { outcome: 'rejected', detail: 'a chat turn can be cancelled or updated, not paused', state: running ? 'running' : 'idle' }
    if (!running) return { outcome: 'rejected', detail: 'nothing is running in that Session; send a normal message instead', state: 'idle' }
    if (action === 'cancel') {
      live.cancel({ kind: 'user' }, { keepInbox: false })
      return { outcome: 'applied', detail: 'the running turn was cancelled', state: 'cancelling' }
    }
    await this.registry.promptSession(sessionId, framed(action === 'update' ? 'task update' : 'task constraint'))
    return { outcome: 'delivered', detail: 'sent into the running turn; the agent applies it at its next step', state: 'running' }
  }

  private async deliverToSession(sessionId: string, text: string): Promise<void> {
    const live = this.ctx.agents.get(SessionId(sessionId))
    if (live === undefined) return
    await this.ctx.sessionController.prompt({
      requestId: brandString<SessionRequestId>(`personal-ai-${randomUUID()}`),
      sessionId: SessionId(sessionId),
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, AbortSignal.timeout(30_000))
  }

  private async resolveSession(idOrAgent: string): Promise<string> {
    if (this.ctx.agents.get(SessionId(idOrAgent)) !== undefined) return idOrAgent
    const agent = await this.registry.get(idOrAgent).catch(() => undefined)
    if (agent?.sessionId !== undefined) return agent.sessionId
    throw new PersonalAiError('not-found', `no live Session or main agent "${idOrAgent}"`)
  }

  // ---------------------------------------------------------------------------
  // Conversation: talking to KairoForge from the Command Center, without a chat on screen

  /**
   * Send one user turn into the conversation Session (created on first use and
   * kept across restarts). It is an ordinary KairoForge turn: the coordinator,
   * permissions, and approvals apply exactly as in the chat.
   * @param text - what the user said or typed.
   * @returns the turn, still running; poll {@link converseTurn} for the reply.
   */
  async converse(text: string): Promise<ConverseTurn> {
    const body = text.trim()
    if (body === '') throw new PersonalAiError('invalid', 'say or type something first')
    if (body.length > CONVERSE_MAX_CHARS) throw new PersonalAiError('invalid', `keep a spoken turn under ${String(CONVERSE_MAX_CHARS)} characters`)
    const sessionId = await this.conversationSession()
    const turn: ConverseTurn = { id: randomUUID(), sessionId, status: 'running', startedAt: new Date().toISOString() }
    this.conversation.set(turn.id, turn)
    this.converseBySession.set(sessionId, { turnId: turn.id, started: false, reply: '', narrated: false })
    while (this.conversation.size > CONVERSE_LIMIT) {
      const oldest = this.conversation.keys().next().value
      if (oldest === undefined) break
      this.conversation.delete(oldest)
    }
    try {
      await this.ctx.sessionController.prompt({
        requestId: brandString<SessionRequestId>(`personal-ai-${randomUUID()}`),
        sessionId: SessionId(sessionId),
        mode: 'queue',
        content: [{ type: 'text', text: body }],
      }, AbortSignal.timeout(30_000))
    } catch (error) {
      this.finishConverse(sessionId, `the message was not accepted: ${error instanceof Error ? error.message : String(error)}`)
      throw new PersonalAiError('conflict', `KairoForge could not take the message: ${error instanceof Error ? error.message : String(error)}`)
    }
    return turn
  }

  /**
   * One Command Center turn.
   * @param id - turn id.
   * @returns the turn with its reply once finished.
   */
  converseTurn(id: string): ConverseTurn {
    const turn = this.conversation.get(id)
    if (turn === undefined) throw new PersonalAiError('not-found', `no conversation turn "${id}"`)
    return turn
  }

  /** The conversation Session id, when one exists. */
  conversationSessionId(): string | undefined {
    return this.settings().conversationSessionId
  }

  /**
   * Observe the run state of the conversation Session (installed by the hooks).
   * @param sessionId - Session id.
   * @param event - `running` or `idle`.
   */
  noteConversation(sessionId: string, event: 'running' | 'idle'): void {
    const pending = this.converseBySession.get(sessionId)
    if (pending === undefined) return
    if (event === 'running') pending.started = true
    else if (pending.started) this.finishConverse(sessionId)
  }

  /**
   * Observe one assistant message of the conversation Session. Words written
   * alongside tool calls are the model telling the user what it is doing, so
   * they become a spoken update; words without tool calls are the answer.
   * @param sessionId - Session id.
   * @param text - the message's text.
   * @param toolCalls - how many tool calls the message makes.
   */
  noteConversationMessage(sessionId: string, text: string, toolCalls: number): void {
    const pending = this.converseBySession.get(sessionId)
    if (pending === undefined) return
    if (toolCalls === 0) {
      if (text !== '') pending.reply = text
      return
    }
    pending.narrated = text !== ''
    if (pending.narrated) this.pushUpdate(pending, { kind: 'say', text: redact(text).slice(0, MAX_SAY_CHARS) })
  }

  /**
   * Observe a tool the permission path allowed to run in the conversation
   * Session. Skipped when the model already said what this step does.
   * @param sessionId - Session id.
   * @param tool - tool name.
   * @param args - tool arguments.
   */
  noteConversationTool(sessionId: string, tool: string, args: unknown): void {
    const pending = this.converseBySession.get(sessionId)
    if (pending === undefined || pending.narrated) return
    this.pushUpdate(pending, toolUpdate(tool, args))
  }

  /**
   * Observe an approval prompt in the conversation Session.
   * @param sessionId - Session id.
   */
  noteConversationApproval(sessionId: string): void {
    const pending = this.converseBySession.get(sessionId)
    if (pending !== undefined) this.pushUpdate(pending, { kind: 'approval' })
  }

  private pushUpdate(pending: PendingConverse, update: ConverseUpdate): void {
    const turn = this.conversation.get(pending.turnId)
    if (turn === undefined || turn.status !== 'running') return
    const updates = turn.updates ?? []
    if (updates.length >= MAX_UPDATES || repeatsUpdate(updates.at(-1), update)) return
    this.conversation.set(turn.id, { ...turn, updates: [...updates, update] })
  }

  /**
   * Mark the conversation turn of a Session failed (the agent errored).
   * @param sessionId - Session id.
   * @param error - reason.
   */
  failConversation(sessionId: string, error: string): void {
    if (this.converseBySession.has(sessionId)) this.finishConverse(sessionId, error)
  }

  private finishConverse(sessionId: string, error?: string): void {
    const pending = this.converseBySession.get(sessionId)
    if (pending === undefined) return
    this.converseBySession.delete(sessionId)
    const turn = this.conversation.get(pending.turnId)
    if (turn === undefined) return
    const finishedAt = new Date().toISOString()
    this.conversation.set(turn.id, error === undefined
      ? { ...turn, status: 'done', reply: redact(pending.reply).slice(0, CONVERSE_REPLY_CHARS), finishedAt }
      : { ...turn, status: 'failed', error: redact(error).slice(0, 300), finishedAt })
  }

  /**
   * Start a fresh conversation Session. The old one stays in the chat list.
   * @returns the new Session id.
   */
  async newConversation(): Promise<{ readonly sessionId: string }> {
    const current = this.settings().conversationSessionId
    if (current !== undefined && this.converseBySession.has(current)) {
      throw new PersonalAiError('conflict', 'wait for the current answer, or stop it, before starting a new chat')
    }
    return { sessionId: await this.createConversation() }
  }

  /** Whether the last model call in a conversation sent so much history that the next turn should start fresh. */
  private outgrown(sessionId: string): boolean {
    const last = this.metrics(sessionId).recent[0]
    return last !== undefined && (last.tokens ?? 0) / Math.max(1, last.steps) > CONVERSE_FRESH_TOKENS
  }

  private async conversationSession(): Promise<string> {
    const known = this.settings().conversationSessionId
    if (known !== undefined && !this.outgrown(known)) {
      const resolved = await this.ctx.sessionController.resolveAgent(SessionId(known)).catch(() => undefined)
      if (resolved !== undefined && !('error' in resolved)) return known
    }
    return this.createConversation()
  }

  private async createConversation(): Promise<string> {
    const project = this.activeProject()
    const created = await this.ctx.sessionController.create({
      agentPreset: 'standard',
      ...project?.path === undefined ? {} : { cwd: project.path },
    })
    await this.patchSettings({ conversationSessionId: created.sessionId })
    await this.ctx.sessionController.rename({ sessionId: created.sessionId, title: `${this.personality().name} — voice` }).catch(() => {})
    return created.sessionId
  }

  // ---------------------------------------------------------------------------
  // Agents: capability tags and selection

  /**
   * Set an agent's capability tags (empty clears back to inferred tags).
   * @param agentIdOrName - main agent.
   * @param tags - tags.
   * @returns the effective tags.
   */
  async setAgentTags(agentIdOrName: string, tags: readonly AgentTag[]): Promise<AgentTag[]> {
    const agent = await this.registry.get(agentIdOrName)
    const domain = await this.ready
    await this.serialize(async () => {
      if (tags.length === 0) await domain.table('profiles').delete(agent.id)
      else await domain.table('profiles').put(agent.id, { agentId: agent.id, tags: [...new Set(tags)] })
    })
    return agentTags({ ...agent, tags: [...tags], ...this.templateOf(agent.id) })
  }

  private templateOf(agentId: string): { template?: string } {
    const template = this.orchestration.meta(agentId).template
    return template === undefined ? {} : { template }
  }

  /** Every non-archived main agent as a selection candidate. */
  async candidates(): Promise<AgentCandidate[]> {
    const agents = await this.registry.list()
    const projects = this.projects()
    const recent = new Map<string, Set<string>>()
    for (const task of this.orchestration.background.list().slice(0, 100)) {
      const project = projects.find(item => item.agentIds.includes(task.agentId))
      if (project !== undefined) recent.set(task.agentId, (recent.get(task.agentId) ?? new Set()).add(project.id))
    }
    return agents.map((agent) => {
      const tags = this.domain?.table('profiles').get(agent.id)?.tags
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
        status: agent.status,
        runtime: agent.runtime,
        preset: agent.permissions.preset,
        ...this.templateOf(agent.id),
        ...tags === undefined ? {} : { tags },
        projectIds: projects.filter(project => project.agentIds.includes(agent.id)).map(project => project.id),
        recentProjectIds: [...recent.get(agent.id) ?? []],
        hasModel: agent.model !== undefined,
      }
    })
  }

  /**
   * Rank main agents for a task.
   * @param task - task text.
   * @param projectId - project; defaults to the active project.
   * @returns ranked agents with reasons.
   */
  async recommend(task: string, projectId?: string): Promise<AgentScore[]> {
    const project = projectId ?? this.activeProject()?.id
    return rankAgents(await this.candidates(), task, project)
  }

  // ---------------------------------------------------------------------------
  // Coordinator decisions, live state, and metrics

  /**
   * Classify the latest request of one Session and remember the decision.
   * @param sessionId - Session id.
   * @param text - request text (framing headers are dropped).
   * @param hasImage - whether the request carries an image.
   * @returns the decision.
   */
  decide(sessionId: string, text: string, hasImage = false): CoordinatorDecision {
    const body = messageBody(text)
    const depth = classifyDepth(body)
    const category = classifyModelCategory({ mode: 'standard', lastUserText: text, hasImage, worker: false })
    const decision: CoordinatorDecision = {
      sessionId,
      depth: depth.depth,
      reason: depth.reason,
      category: category.category === 'STANDARD' ? 'GENERAL' : category.category,
      categoryReason: category.reason,
      at: new Date().toISOString(),
    }
    this.decisions.set(sessionId, decision)
    if (this.decisions.size > 200) this.decisions.delete(this.decisions.keys().next().value ?? '')
    return decision
  }

  /**
   * Latest decision of one Session.
   * @param sessionId - Session id.
   * @returns the decision, if any.
   */
  decisionOf(sessionId: string): CoordinatorDecision | undefined {
    return this.decisions.get(sessionId)
  }

  /**
   * Live facts of one coordinator Session, created on first use.
   * @param sessionId - Session id.
   * @param mode - Session mode.
   * @returns mutable facts.
   */
  liveOf(sessionId: string, mode = 'standard'): LiveSession {
    let entry = this.live.get(sessionId)
    if (entry === undefined) {
      entry = {
        busy: false, pending: new Set(), errored: false, mode, lastActive: Date.now(),
        steps: 0, toolCalls: 0, approvals: 0, delegated: false, tokens: 0,
      }
      this.live.set(sessionId, entry)
    }
    return entry
  }

  /**
   * Note that a coordinator Session became active, making it the HUD's focus.
   * @param sessionId - Session id.
   */
  touch(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (live === undefined) return
    live.lastActive = Date.now()
    this.focus = sessionId
  }

  /**
   * Track an approval prompt in any Session (background workers included).
   * @param sessionId - Session id.
   * @param id - approval id.
   * @param open - true when asked, false when decided.
   */
  noteApproval(sessionId: string, id: string, open: boolean): void {
    const pending = this.approvals.get(sessionId) ?? new Set<string>()
    if (open) pending.add(id)
    else pending.delete(id)
    if (pending.size === 0) this.approvals.delete(sessionId)
    else this.approvals.set(sessionId, pending)
  }

  /**
   * Whether a Session is blocked on an approval prompt.
   * @param sessionId - Session id.
   * @returns true while a prompt is open.
   */
  awaitingApproval(sessionId: string): boolean {
    return (this.approvals.get(sessionId)?.size ?? 0) > 0
  }

  /**
   * Background tasks with the derived `waiting-for-approval` state.
   * @returns tasks, newest first.
   */
  backgroundTasks(): Array<ReturnType<Orchestrator['background']['list']>[number] & { readonly state: string }> {
    return this.orchestration.background.list().map(task => ({
      ...task,
      state: task.status === 'running' && task.sessionId !== undefined && this.awaitingApproval(task.sessionId) ? 'waiting-for-approval' : task.status,
    }))
  }

  /**
   * Live facts of a coordinator Session, or undefined for any other Session.
   * @param sessionId - Session id.
   * @returns facts registered by the coordinator installer.
   */
  coordinatorLive(sessionId: string): LiveSession | undefined {
    return this.live.get(sessionId)
  }

  /**
   * Forget a disposed Session.
   * @param sessionId - Session id.
   */
  drop(sessionId: string): void {
    this.live.delete(sessionId)
    this.approvals.delete(sessionId)
    if (this.focus === sessionId) this.focus = undefined
  }

  /**
   * Record a finished turn.
   * @param sessionId - Session id.
   */
  async finishTurn(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId)
    if (live?.turnStart === undefined) return
    const tokens = live.tokens > 0 ? live.tokens : undefined
    const decision = this.decisions.get(sessionId)
    const record: TurnRecord = {
      at: new Date().toISOString(),
      sessionId,
      mode: live.mode,
      depth: decision?.depth ?? 'direct',
      category: decision?.category ?? 'GENERAL',
      durationMs: Date.now() - live.turnStart,
      steps: live.steps,
      toolCalls: live.toolCalls,
      ...tokens === undefined ? {} : { tokens },
      delegated: live.delegated,
      approvals: live.approvals,
      ok: !live.errored,
    }
    delete live.turnStart
    const domain = await this.ready
    await this.serialize(async () => {
      await domain.table('turns').put(`${record.at}-${sessionId}`, record)
      await this.pruneTable('turns', TURN_LIMIT)
    })
  }

  /**
   * Turn metrics.
   * @param sessionId - optional Session filter.
   * @returns summary plus the latest turns.
   */
  metrics(sessionId?: string): { readonly summary: MetricsSummary; readonly recent: TurnRecord[] } {
    const turns = rows(this.domain?.table('turns'))
      .filter(row => sessionId === undefined || row.sessionId === sessionId)
      .toSorted((a, b) => b.at.localeCompare(a.at))
    return { summary: summarizeTurns(turns), recent: turns.slice(0, 20) }
  }

  /**
   * Voice phase reported by the browser.
   * @param phase - new phase.
   */
  setVoice(phase: VoicePhase): void {
    this.voice = phase
  }

  /** Work this coordinator started that is still running. */
  private delegatedWork(sessionId: string): number {
    const ids = new Set([sessionId])
    const workflows = this.orchestration.workflows.list(ids).filter(workflow => workflow.status === 'running' || workflow.status === 'integrating').length
    const delegations = this.orchestration.delegations.list(ids).filter(record => record.status === 'open').length
    return workflows + delegations
  }

  /**
   * Current assistant state for the HUD and state bar.
   * @param sessionId - Session to describe; defaults to the most recently active coordinator Session.
   * @returns the state view.
   */
  assistantState(sessionId?: string): AssistantStateView {
    const id = sessionId ?? this.focus
    const live = id === undefined ? undefined : this.live.get(id)
    const facts = {
      busy: live?.busy ?? false,
      ...live?.tool === undefined ? {} : { tool: live.tool },
      pendingApprovals: live?.pending.size ?? 0,
      delegatedWork: id === undefined ? 0 : this.delegatedWork(id),
      voice: this.voice,
      errored: live?.errored ?? false,
    }
    const state = deriveState(facts)
    const decision = id === undefined ? undefined : this.decisions.get(id)
    return {
      state,
      text: STATE_TEXT[state],
      orb: orbStateOf(state, facts),
      ...id === undefined ? {} : { sessionId: id },
      ...live?.tool === undefined ? {} : { tool: live.tool },
      ...decision === undefined ? {} : { decision },
      pendingApprovals: facts.pendingApprovals,
      delegatedWork: facts.delegatedWork,
      voice: this.voice,
      at: new Date().toISOString(),
    }
  }

  /**
   * Notifications newer than a time, filtered by the user's preference. The
   * `important` level keeps successes, warnings, and errors.
   * @param since - ISO time.
   * @returns notifications, oldest first.
   */
  notifications(since?: string): PersonalNotice[] {
    const level = this.personality().notifications
    if (level === 'off') return []
    const orchestration: PersonalNotice[] = this.orchestration.notifications(since)
      .map(notice => ({ id: notice.id, at: notice.at, level: notice.level, kind: notice.kind, text: notice.text }))
    const own = since === undefined ? this.notices : this.notices.filter(notice => notice.at > since)
    return [...orchestration, ...own]
      .filter(notice => level === 'all' || notice.level !== 'info')
      .toSorted((a, b) => a.at.localeCompare(b.at))
  }

  private async pruneTable(table: 'memory' | 'controls' | 'turns', limit: number): Promise<void> {
    const handle = this.store.table(table) as unknown as {
      entries(): IterableIterator<[string, { createdAt?: string; at?: string }]>
      delete(key: string): Promise<boolean>
    }
    const rows = [...handle.entries()].toSorted(([, a], [, b]) => (b.createdAt ?? b.at ?? '').localeCompare(a.createdAt ?? a.at ?? ''))
    for (const [key] of rows.slice(limit)) await handle.delete(key)
  }
}

function rows<V>(table: { entries(): IterableIterator<[string, V]> } | undefined): V[] {
  return table === undefined ? [] : [...table.entries()].map(([, value]) => value)
}

function dropKey<T extends object>(value: T, key: keyof T): T {
  const { [key]: _dropped, ...rest } = value
  return rest as T
}
