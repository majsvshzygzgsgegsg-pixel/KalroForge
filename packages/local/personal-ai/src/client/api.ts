/**
 * Browser wire for the Command Center: the JSON shapes `/personal-ai/*`
 * returns and the requests it accepts. The client keeps its own copy of these
 * shapes because the Host types live outside the client composite project.
 */

/** Assistant states the HUD shows. */
export type AssistantState = 'IDLE' | 'LISTENING' | 'THINKING' | 'DELEGATING' | 'WORKING' | 'WAITING_FOR_APPROVAL' | 'SPEAKING'

/** Galaxy orb looks. */
export type OrbState = 'idle' | 'arming' | 'listening' | 'processing' | 'speaking' | 'error'

/** Voice phase the browser reports. */
export type VoicePhase = 'off' | 'arming' | 'listening' | 'speaking'

/** How deep the coordinator goes for one request. */
export type Depth = 'direct' | 'clarify' | 'tool' | 'agent' | 'workflow' | 'background' | 'approval'

/** Coordinator decision for the latest request. */
export interface Decision {
  readonly depth: Depth
  readonly reason: string
  readonly category: string
  readonly categoryReason: string
  readonly at: string
}

/** `GET /personal-ai/state`. */
export interface StateView {
  readonly state: AssistantState
  readonly text: string
  readonly orb: OrbState
  readonly sessionId?: string
  readonly tool?: string
  readonly decision?: Decision
  readonly pendingApprovals: number
  readonly delegatedWork: number
  readonly voice: VoicePhase
  readonly at: string
  /** Holo Hands open state and scene revision. */
  readonly holo?: HoloView
}

/** Holo Hands open state. */
export interface HoloView {
  readonly open: boolean
  readonly revision: number
  readonly url: string
}

/** One item KairoForge placed on the Holo deck. */
export interface HoloItem {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly text?: string
  readonly color?: string
  readonly shape?: string
  readonly url?: string
  readonly html?: string
  readonly prompt?: string
  readonly signal?: string
  readonly x: number
  readonly y: number
  readonly scale: number
  readonly posRev: number
}

/** One connector between Holo items. */
export interface HoloConnector {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly label?: string
  readonly color?: string
}

/** `GET /personal-ai/holo`. */
export interface HoloSnapshot extends HoloView {
  readonly scene: { readonly revision: number; readonly items: readonly HoloItem[]; readonly connectors: readonly HoloConnector[] }
  readonly camera: string
}

/** `POST /personal-ai/holo/open`. */
export interface HoloOpenResult extends HoloView {
  readonly server: 'running' | 'started' | 'missing' | 'failed'
  readonly detail?: string
}

/** Personality settings. */
export interface Personality {
  readonly name: string
  readonly instructions: string
  readonly speakingStyle: string
  readonly verbosity: 'brief' | 'balanced' | 'detailed'
  readonly voice: { readonly name?: string; readonly rate: number }
  readonly notifications: 'all' | 'important' | 'off'
  readonly handsFree: boolean
}

/** Memory scopes. */
export type MemoryScope = 'session' | 'project' | 'user' | 'agent'

/** One memory. */
export interface Memory {
  readonly id: string
  readonly scope: MemoryScope
  readonly scopeId?: string
  readonly text: string
  readonly tags: readonly string[]
  readonly status: 'active' | 'disabled'
  readonly source: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Verified project commands. */
export interface ProjectCommands {
  readonly dev?: string
  readonly build?: string
  readonly test?: string
  readonly lint?: string
}

/** One registered project. */
export interface Project {
  readonly id: string
  readonly name: string
  readonly path?: string
  readonly description: string
  readonly stack: readonly string[]
  readonly commands: ProjectCommands
  readonly agentIds: readonly string[]
  readonly decisions: ReadonlyArray<{ readonly at: string; readonly text: string }>
  readonly docs: readonly string[]
  readonly status: 'active' | 'archived'
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastOpenedAt?: string
}

/** One background task with the derived state. */
export interface BackgroundTask {
  readonly id: string
  readonly agentId: string
  readonly title: string
  readonly prompt: string
  readonly status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  readonly state: string
  readonly progress: {
    readonly percent?: number
    readonly note?: string
    readonly steps: number
    readonly toolCalls: number
    readonly lastTool?: string
  }
  readonly result?: string
  readonly error?: string
  readonly createdAt: string
  readonly sessionId?: string
}

/** One workflow summary. */
export interface WorkflowSummary {
  readonly id: string
  readonly title: string
  readonly status: 'running' | 'integrating' | 'completed' | 'failed' | 'cancelled'
  readonly ownerName: string
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string }>
  readonly createdAt: string
}

/** What a control targets. */
export interface TaskRef {
  readonly kind: 'background' | 'workflow' | 'session'
  readonly id: string
}

/** Control actions. */
export type ControlAction = 'pause' | 'resume' | 'cancel' | 'update' | 'constrain'

/** One recorded control with its observed outcome. */
export interface ControlRecord {
  readonly id: string
  readonly ref: TaskRef
  readonly action: ControlAction
  readonly text?: string
  readonly outcome: 'applied' | 'delivered' | 'rejected'
  readonly detail: string
  readonly state?: string
  readonly by: string
  readonly at: string
}

/** One notification. */
export interface Notice {
  readonly id: string
  readonly at: string
  readonly level: 'info' | 'success' | 'warning' | 'error'
  readonly kind: string
  readonly text: string
}

/** Aggregate over turns. */
export interface TurnStats {
  readonly turns: number
  readonly avgDurationMs: number
  readonly avgSteps: number
  readonly avgToolCalls: number
  readonly avgTokens?: number
  readonly successRate: number
}

/** Metrics summary. */
export interface MetricsSummary {
  readonly overall: TurnStats
  readonly byDepth: Partial<Record<Depth, TurnStats>>
  readonly byMode: Readonly<Record<string, TurnStats>>
  readonly delegatedTurns: number
  readonly approvals: number
}

/** One finished turn. */
export interface TurnRecord {
  readonly at: string
  readonly sessionId: string
  readonly mode: string
  readonly depth: Depth
  readonly category: string
  readonly durationMs: number
  readonly steps: number
  readonly toolCalls: number
  readonly tokens?: number
  readonly delegated: boolean
  readonly approvals: number
  readonly ok: boolean
}

/** `GET /personal-ai/overview`. */
export interface Overview {
  readonly state: StateView
  readonly personality: Personality
  readonly coordinator: boolean
  readonly activeProject: Project | null
  readonly counts: {
    readonly agents: number
    readonly agentsBusy: number
    readonly projects: number
    readonly memories: number
    readonly background: number
    readonly workflows: number
  }
  readonly background: readonly BackgroundTask[]
  readonly workflows: readonly WorkflowSummary[]
  readonly controls: readonly ControlRecord[]
  readonly notifications: readonly Notice[]
  readonly metrics: MetricsSummary
}

/** One main agent as a selection candidate. */
export interface AgentCandidate {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly status: 'running' | 'stopped' | 'archived'
  readonly runtime: 'busy' | 'idle' | 'unloaded'
  readonly preset: string
  readonly template?: string
  readonly tags?: readonly string[]
  readonly projectIds: readonly string[]
  readonly hasModel: boolean
}

/** One ranked agent. */
export interface AgentScore {
  readonly id: string
  readonly name: string
  readonly score: number
  readonly reasons: readonly string[]
}

/** Tools grouped by capability. */
export interface ToolGroups {
  readonly sessionId?: string
  readonly categories: Readonly<Record<string, readonly string[]>>
  readonly other: readonly string[]
}

/** A failed request with the server's message. */
export class PersonalAiRequestError extends Error {
  override readonly name = 'PersonalAiRequestError'
}

const BASE = 'personal-ai/'

/** One Command Center turn answered in the conversation Session. */
/** One live progress update of a running turn (see the Host's `ConverseUpdate`). */
export type ConverseUpdate =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'tool'; readonly category: string; readonly changes: boolean }
  | { readonly kind: 'approval' }

export interface ConverseTurn {
  readonly id: string
  readonly sessionId: string
  readonly status: 'running' | 'done' | 'failed'
  readonly updates?: readonly ConverseUpdate[]
  readonly reply?: string
  readonly error?: string
  readonly startedAt: string
  readonly finishedAt?: string
}

/**
 * Call one `/personal-ai/*` route: GET without a body, POST with one.
 * @param path - path below `/personal-ai/`.
 * @param body - JSON body for POST.
 * @returns the parsed response.
 */
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const response = await fetch(new URL(BASE + path, document.baseURI), init)
  const text = await response.text()
  // An empty or non-JSON body still reports the HTTP status below.
  let payload: unknown
  try {
    payload = text === '' ? undefined : JSON.parse(text)
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && typeof Reflect.get(payload, 'message') === 'string'
      ? String(Reflect.get(payload, 'message'))
      : String(response.status)
    throw new PersonalAiRequestError(message)
  }
  return payload as T
}

const id = (value: string): string => encodeURIComponent(value)

/** Command Center API. */
export const api = {
  state: (sessionId?: string) => request<StateView>(sessionId === undefined ? 'state' : `state?session=${id(sessionId)}`),
  overview: () => request<Overview>('overview'),
  memories: (query: { readonly q?: string; readonly scope?: MemoryScope; readonly disabled?: boolean }) => {
    const params = new URLSearchParams()
    if (query.q !== undefined && query.q !== '') params.set('q', query.q)
    if (query.scope !== undefined) params.set('scope', query.scope)
    if (query.disabled === true) params.set('disabled', '1')
    return request<Memory[]>(`memory?${params.toString()}`)
  },
  addMemory: (text: string, scope: MemoryScope = 'user', scopeId?: string) =>
    request<Memory>('memory', { scope, text, ...scopeId === undefined ? {} : { scopeId } }),
  updateMemory: (memoryId: string, changes: { readonly text?: string; readonly status?: 'active' | 'disabled' }) =>
    request<Memory>(`memory/${id(memoryId)}`, changes),
  deleteMemory: (memoryId: string) => request<Memory>(`memory/${id(memoryId)}/delete`, {}),
  projects: (archived: boolean) => request<{ projects: Project[]; activeProjectId: string | null }>(archived ? 'projects?archived=1' : 'projects'),
  createProject: (input: {
    readonly name: string
    readonly path?: string
    readonly description?: string
    readonly stack?: readonly string[]
  }) =>
    request<Project>('project', input),
  updateProject: (projectId: string, changes: Record<string, unknown>) => request<Project>(`project/${id(projectId)}`, changes),
  openProject: (projectId: string) => request<Project>(`project/${id(projectId)}/open`, {}),
  archiveProject: (projectId: string) => request<Project>(`project/${id(projectId)}/archive`, {}),
  assignAgent: (projectId: string, agentId: string, unassign = false) =>
    request<Project>(`project/${id(projectId)}/assign`, { agentId, ...unassign ? { unassign } : {} }),
  projectStatus: (projectId: string) => request<Record<string, unknown>>(`project/${id(projectId)}/status`),
  personality: () => request<{ personality: Personality; coordinator: boolean }>('personality'),
  savePersonality: (changes: Partial<Personality>) => request<Personality>('personality', changes),
  setCoordinator: (enabled: boolean) => request<{ coordinator: boolean }>('coordinator', { enabled }),
  control: (ref: TaskRef, action: ControlAction, text?: string) =>
    request<ControlRecord>('control', { ...ref, action, ...text === undefined ? {} : { text } }),
  controls: () => request<ControlRecord[]>('controls'),
  notifications: (since?: string) => request<Notice[]>(since === undefined ? 'notifications' : `notifications?since=${id(since)}`),
  metrics: () => request<{ summary: MetricsSummary; recent: TurnRecord[] }>('metrics'),
  background: () => request<BackgroundTask[]>('background'),
  agents: () => request<{ agents: AgentCandidate[]; tags: string[] }>('agents'),
  setAgentTags: (agentId: string, tags: readonly string[]) => request<{ tags: string[] }>(`agent/${id(agentId)}/tags`, { tags }),
  recommend: (task: string) => request<AgentScore[]>('recommend', { task }),
  tools: (sessionId?: string) => request<ToolGroups>(sessionId === undefined ? 'tools' : `tools?session=${id(sessionId)}`),
  voice: (phase: VoicePhase) => request<StateView>('voice', { phase }),
  converse: (text: string) => request<ConverseTurn>('converse', { text }),
  converseTurn: (turnId: string) => request<ConverseTurn>(`converse/${id(turnId)}`),
  holo: () => request<HoloSnapshot>('holo'),
  holoOpen: () => request<HoloOpenResult>('holo/open', {}),
  holoClose: () => request<HoloView>('holo/close', {}),
  holoPerception: (report: unknown) => request<{ ok: boolean }>('holo/perception', report),
  holoLayout: (items: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number; readonly scale?: number }>) =>
    request<{ ok: boolean }>('holo/layout', { items }),
  holoActivate: (itemId: string, value?: string) =>
    request<{ prompt: string | null }>('holo/activate', { id: itemId, ...value === undefined ? {} : { value } }),
}
