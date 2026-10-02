/**
 * Orchestration service (`ctx.orchestration`). It layers workflows, Git
 * checkpoints, loop recovery, background tasks, delegation tracking, and model
 * routing on the existing Agent Registry, Agent Team, Session controller, tool
 * hooks, and storage. It owns durable orchestration records plus bounded
 * in-memory telemetry per Session (recent tool calls, context usage, errors).
 */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { MainAgentRegistry } from '../registry.ts'
import type { MainAgentRecord } from '../types.ts'
import { BackgroundRunner } from './background.ts'
import { CheckpointManager } from './checkpoints.ts'
import { DelegationManager } from './delegation.ts'
import { LoopDetector } from './loop-detector.ts'
import { redact } from './shell-policy.ts'
import { orchestrationDomain, type StoredSettings } from './storage.ts'
import {
  DEFAULT_SETTINGS,
  type AgentMeta, type LoopEvent, type LoopMetrics, type OrchestrationActor, type OrchestrationSettings, type RouteDecision, type TestRun,
} from './types.ts'
import { WorkflowEngine } from './workflows.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Agent orchestration layered on the Agent Registry. */
    orchestration: Orchestrator
  }
}

type OrchestrationDomain = Domain<typeof orchestrationDomain>
type Tables = OrchestrationDomain extends { table(name: infer N): unknown } ? N : never

/** One recent tool call shown in the activity dashboard (arguments redacted and truncated). */
export interface ToolCallView {
  readonly at: string
  readonly name: string
  readonly summary: string
  readonly ok: boolean
  /** Redacted error text of a failed call. */
  readonly error?: string
}

/** One UI notification. */
export interface OrchestrationNotification {
  readonly id: string
  readonly at: string
  readonly level: 'info' | 'success' | 'warning' | 'error'
  readonly kind: 'background' | 'workflow' | 'loop' | 'checkpoint' | 'delegation'
  readonly text: string
  readonly agentId?: string
}

/** Bounded live telemetry for one Session. */
export interface SessionTelemetry {
  readonly tools: ToolCallView[]
  readonly errors: Array<{ readonly at: string; readonly text: string }>
  lastAssistantText: string
  lastUserText: string
  lastUserHasImage: boolean
  contextTokens?: number
  contextWindow?: number
  provider?: string
  model?: string
  steps: number
  toolCalls: number
  busySince?: number
  runtimeMs: number
  lastTestRun?: TestRun
  /** True when the last turn reported an agent error. */
  erroredTurn: boolean
}

const TOOL_HISTORY = 25
const ERROR_HISTORY = 10
const NOTIFICATION_LIMIT = 60
const LOOP_LIMIT = 300

/** Orchestration service. */
export class Orchestrator extends Service {
  static inject = ['agents', 'storageDomain', 'sessionController', 'mainAgents']

  readonly checkpoints: CheckpointManager
  readonly workflows: WorkflowEngine
  readonly background: BackgroundRunner
  readonly delegations: DelegationManager

  private readonly ready: Promise<OrchestrationDomain>
  private domain: OrchestrationDomain | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly telemetry = new Map<string, SessionTelemetry>()
  private readonly detectors = new Map<string, LoopDetector>()
  private readonly notices: OrchestrationNotification[] = []
  /** Latest decision per Session, visible before its write is persisted. */
  private readonly liveRoutes = new Map<string, RouteDecision>()
  private readonly windows = new Map<string, number>()

  /**
   * @param ctx - Host context.
   */
  constructor(ctx: Context) {
    super(ctx, 'orchestration')
    this.checkpoints = new CheckpointManager(this)
    this.workflows = new WorkflowEngine(this)
    this.background = new BackgroundRunner(this)
    this.delegations = new DelegationManager(this)
    this.ready = ctx.storageDomain.open(orchestrationDomain).then((domain) => {
      this.domain = domain
      return domain
    })
    ctx.effect(() => async () => {
      const domain = await this.ready
      await this.chain.catch(() => {})
      await domain.close()
    }, 'main-agents: orchestration domain')
  }

  /** The Agent Registry. */
  get registry(): MainAgentRegistry {
    return this.ctx.mainAgents
  }

  /** Host context for managers. */
  get host(): Context {
    return this.ctx
  }

  /** Resolve after the durable domain is open. */
  async whenReady(): Promise<OrchestrationDomain> {
    return this.ready
  }

  /** Open domain; throws before readiness. */
  get store(): OrchestrationDomain {
    if (this.domain === undefined) throw new Error('orchestration storage is not open yet')
    return this.domain
  }

  /**
   * Run one storage mutation after every earlier one.
   * @param operation - the mutation.
   * @returns its result.
   */
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => {})
    return next
  }

  /**
   * Keep only the newest `limit` rows of one table.
   * @param table - table name.
   * @param limit - rows to keep.
   * @param keep - rows that must never be pruned.
   */
  async prune(table: Tables, limit: number, keep: (value: { createdAt?: string; at?: string }) => boolean = () => false): Promise<void> {
    const handle = this.store.table(table) as unknown as {
      entries(): IterableIterator<[string, { createdAt?: string; at?: string }]>
      delete(key: string): Promise<boolean>
    }
    const rows = [...handle.entries()].toSorted(([, a], [, b]) => (b.createdAt ?? b.at ?? '').localeCompare(a.createdAt ?? a.at ?? ''))
    for (const [key, value] of rows.slice(limit)) {
      if (!keep(value)) await handle.delete(key)
    }
  }

  // ---------------------------------------------------------------------------
  // Settings and metadata

  /** Effective settings with defaults filled in. */
  settings(): OrchestrationSettings {
    const stored: StoredSettings = this.domain?.global.get() ?? {}
    return {
      routing: { ...DEFAULT_SETTINGS.routing, ...stored.routing },
      loops: { ...DEFAULT_SETTINGS.loops, ...stored.loops },
      checkpoints: { ...DEFAULT_SETTINGS.checkpoints, ...stored.checkpoints },
      delegation: { ...DEFAULT_SETTINGS.delegation, ...stored.delegation },
      background: { ...DEFAULT_SETTINGS.background, ...stored.background },
    }
  }

  /**
   * Merge settings changes and persist them.
   * @param changes - groups and fields to change.
   * @returns effective settings.
   */
  async updateSettings(changes: StoredSettings): Promise<OrchestrationSettings> {
    const domain = await this.ready
    await this.serialize(async () => {
      const stored = domain.global.get()
      const next: Record<string, unknown> = { ...stored }
      for (const [group, value] of Object.entries(changes)) {
        next[group] = { ...(stored as Record<string, object | undefined>)[group], ...value }
      }
      await domain.global.set(next)
    })
    for (const detector of this.detectors.values()) detector.reset()
    this.detectors.clear()
    return this.settings()
  }

  /**
   * Orchestration metadata for one main agent.
   * @param agentId - registry id.
   * @returns metadata, possibly empty.
   */
  meta(agentId: string): AgentMeta {
    return this.domain?.table('meta').get(agentId) ?? { agentId }
  }

  /**
   * Change one main agent's orchestration metadata.
   * @param agentId - registry id.
   * @param changes - fields to change.
   * @returns the stored metadata.
   */
  async setMeta(agentId: string, changes: Partial<Omit<AgentMeta, 'agentId'>>): Promise<AgentMeta> {
    const domain = await this.ready
    return this.serialize(async () => {
      const next: AgentMeta = { ...this.meta(agentId), ...changes, agentId }
      await domain.table('meta').put(agentId, next)
      return next
    })
  }

  // ---------------------------------------------------------------------------
  // Attribution

  /**
   * Main agent that owns a Session, directly or as an ancestor of a sub-agent Session.
   * @param sessionId - any Session id.
   * @returns the owning main agent, if any.
   */
  mainAgentOf(sessionId: string): MainAgentRecord | undefined {
    let current: string | undefined = sessionId
    for (let hops = 0; current !== undefined && hops < 8; hops++) {
      const record = this.registry.recordForSession(current)
      if (record !== undefined) return record
      current = this.ctx.agents.get(SessionId(current))?.session.header.parentSession
    }
    return undefined
  }

  /**
   * Root (top-level) Session of a Session chain.
   * @param sessionId - any Session id.
   * @returns the top-level ancestor id (itself when top-level or unloaded).
   */
  rootSessionOf(sessionId: string): string {
    let current = sessionId
    for (let hops = 0; hops < 8; hops++) {
      const parent = this.ctx.agents.get(SessionId(current))?.session.header.parentSession
      if (parent === undefined) return current
      current = parent
    }
    return current
  }

  /**
   * Whether orchestration hooks with `managed` scope apply to one Agent: main
   * agents, their sub-agents and workflow workers, and Fast Mode Sessions.
   * @param agent - live Agent.
   * @returns true when managed.
   */
  isManaged(agent: Agent): boolean {
    if (this.registry.modeOf(agent) === 'fast') return true
    return this.mainAgentOf(agent.session.id) !== undefined || this.workflows.isWorker(agent.session.id)
  }

  /**
   * Actor for one live Agent.
   * @param agent - live Agent.
   * @returns session id and display name.
   */
  actorOf(agent: Agent): OrchestrationActor {
    const record = this.registry.recordForSession(agent.session.id)
    if (record !== undefined) return { sessionId: agent.session.id, name: record.name }
    if (agent.session.header.origin === 'subagent') {
      const member = this.ctx.get('agentTeams')?.tryMembership(agent)
      const owner = this.mainAgentOf(agent.session.id)
      return { sessionId: agent.session.id, name: `${member?.name ?? 'sub-agent'}${owner === undefined ? '' : ` (${owner.name})`}` }
    }
    return { sessionId: agent.session.id, name: this.registry.modeOf(agent) === 'cordis' ? 'Creator' : 'Lead' }
  }

  // ---------------------------------------------------------------------------
  // Telemetry

  /**
   * Live telemetry for one Session, created on first use.
   * @param sessionId - Session id.
   * @returns mutable telemetry.
   */
  telemetryOf(sessionId: string): SessionTelemetry {
    let entry = this.telemetry.get(sessionId)
    if (entry === undefined) {
      entry = { tools: [], errors: [], lastAssistantText: '', lastUserText: '', lastUserHasImage: false, steps: 0, toolCalls: 0, runtimeMs: 0, erroredTurn: false }
      this.telemetry.set(sessionId, entry)
    }
    return entry
  }

  /** Telemetry if it exists. */
  peekTelemetry(sessionId: string): SessionTelemetry | undefined {
    return this.telemetry.get(sessionId)
  }

  /**
   * Record one completed tool call.
   * @param sessionId - calling Session.
   * @param call - call facts.
   */
  recordTool(sessionId: string, call: Omit<ToolCallView, 'at'>): void {
    const entry = this.telemetryOf(sessionId)
    entry.toolCalls++
    entry.tools.push({
      at: new Date().toISOString(),
      name: call.name,
      summary: redact(call.summary).slice(0, 160),
      ok: call.ok,
      ...call.error === undefined ? {} : { error: redact(call.error).slice(0, 300) },
    })
    if (entry.tools.length > TOOL_HISTORY) entry.tools.shift()
  }

  /**
   * Record one agent error.
   * @param sessionId - Session.
   * @param text - error text (redacted before storage).
   */
  recordError(sessionId: string, text: string): void {
    const entry = this.telemetryOf(sessionId)
    entry.erroredTurn = true
    entry.errors.push({ at: new Date().toISOString(), text: redact(text).slice(0, 400) })
    if (entry.errors.length > ERROR_HISTORY) entry.errors.shift()
  }

  /**
   * Resolve and cache the context window of one provider/model route.
   * @param sessionId - Session to update.
   * @param provider - provider route.
   * @param model - model id.
   */
  noteModel(sessionId: string, provider: string, model: string): void {
    const entry = this.telemetryOf(sessionId)
    entry.provider = provider
    entry.model = model
    const key = `${provider}\u0000${model}`
    const cached = this.windows.get(key)
    if (cached !== undefined) {
      entry.contextWindow = cached
      return
    }
    const llm = this.ctx.get('llm')
    if (llm === undefined) return
    void llm.resolveModelInfo(provider, model).then((info) => {
      const window = info.context?.contextWindow
      if (window === undefined) return
      this.windows.set(key, window)
      entry.contextWindow = window
    }).catch(() => undefined)
  }

  /**
   * Loop detector for one Session.
   * @param sessionId - Session id.
   * @returns the detector.
   */
  detectorOf(sessionId: string): LoopDetector {
    let detector = this.detectors.get(sessionId)
    if (detector === undefined) {
      const { noProgressSteps } = this.settings().loops
      detector = new LoopDetector({
        repeatedReads: 4, similarEdits: 3, failingCommand: 3, sameError: 3, alternatingCycles: 3, noProgressSteps, recoveryWindow: 12,
      })
      this.detectors.set(sessionId, detector)
    }
    return detector
  }

  /**
   * Forget one Session's live state when its Agent is disposed.
   * @param sessionId - Session id.
   */
  forget(sessionId: string): void {
    this.detectors.delete(sessionId)
    const entry = this.telemetry.get(sessionId)
    if (entry?.busySince !== undefined) {
      entry.runtimeMs += Date.now() - entry.busySince
      delete entry.busySince
    }
  }

  // ---------------------------------------------------------------------------
  // Loop events and routing decisions

  /**
   * Persist one loop event.
   * @param event - the event.
   */
  async saveLoop(event: LoopEvent): Promise<void> {
    const domain = await this.ready
    await this.serialize(async () => {
      await domain.table('loops').put(event.id, event)
      await this.prune('loops', LOOP_LIMIT)
    })
  }

  /**
   * Update one loop event's outcome.
   * @param id - event id.
   * @param changes - fields to change.
   */
  async updateLoop(id: string, changes: Partial<Pick<LoopEvent, 'outcome' | 'delegatedDiagnosis'>>): Promise<void> {
    const domain = await this.ready
    await this.serialize(async () => {
      const current = domain.table('loops').get(id)
      if (current !== undefined) await domain.table('loops').put(id, { ...current, ...changes })
    })
  }

  /**
   * Recent loop events, newest first.
   * @param sessionIds - optional Session filter.
   * @returns events.
   */
  loops(sessionIds?: ReadonlySet<string>): LoopEvent[] {
    return [...this.domain?.table('loops').entries() ?? []]
      .map(([, event]) => event)
      .filter(event => sessionIds === undefined || sessionIds.has(event.sessionId))
      .toSorted((a, b) => b.at.localeCompare(a.at))
  }

  /** Aggregated loop metrics. */
  loopMetrics(): LoopMetrics {
    const events = this.loops()
    const byKind: Partial<Record<LoopEvent['kind'], number>> = {}
    for (const event of events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1
    return {
      detections: events.length,
      recovered: events.filter(event => event.outcome === 'recovered').length,
      recurred: events.filter(event => event.outcome === 'recurred').length,
      byKind,
    }
  }

  /**
   * Persist the latest routing decision for one Session when it changed.
   * @param decision - the decision.
   */
  async saveRoute(decision: RouteDecision): Promise<void> {
    this.liveRoutes.set(decision.sessionId, decision)
    if (this.liveRoutes.size > 500) this.liveRoutes.delete(this.liveRoutes.keys().next().value ?? '')
    const domain = await this.ready
    const previous = domain.table('routes').get(decision.sessionId)
    if (previous !== undefined && previous.category === decision.category && previous.model === decision.model
      && previous.provider === decision.provider && previous.routed === decision.routed && previous.reason === decision.reason
      && JSON.stringify(previous.base) === JSON.stringify(decision.base)) return
    await this.serialize(async () => {
      await domain.table('routes').put(decision.sessionId, decision)
      await this.prune('routes', 500)
    })
  }

  /**
   * Latest routing decision for one Session.
   * @param sessionId - Session id.
   * @returns the decision, if any.
   */
  routeOf(sessionId: string): RouteDecision | undefined {
    return this.liveRoutes.get(sessionId) ?? this.domain?.table('routes').get(sessionId)
  }

  // ---------------------------------------------------------------------------
  // Notifications

  /**
   * Publish one UI notification.
   * @param notice - notification without id and time.
   */
  notify(notice: Omit<OrchestrationNotification, 'id' | 'at'>): void {
    this.notices.push({ ...notice, text: redact(notice.text).slice(0, 300), id: randomUUID(), at: new Date().toISOString() })
    if (this.notices.length > NOTIFICATION_LIMIT) this.notices.shift()
  }

  /**
   * Notifications newer than a timestamp.
   * @param since - ISO time; omitted returns all retained notifications.
   * @returns notifications, oldest first.
   */
  notifications(since?: string): OrchestrationNotification[] {
    return since === undefined ? [...this.notices] : this.notices.filter(notice => notice.at > since)
  }

  /**
   * Last assistant text of one Session, as observed since this host started.
   * @param sessionId - Session id.
   * @returns text, possibly empty.
   */
  lastAssistantText(sessionId: string): string {
    return this.telemetry.get(sessionId)?.lastAssistantText ?? ''
  }
}

/**
 * Join the text blocks of a message content array.
 * @param content - content blocks.
 * @returns concatenated text.
 */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null || (block as { type?: unknown }).type !== 'text') return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .filter(text => text !== '')
    .join('\n')
    .trim()
}

/** Short random id with a prefix. */
export function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}
