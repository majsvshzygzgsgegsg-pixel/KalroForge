/**
 * Browser wire for the Agents page: the JSON shapes `/main-agents/*` returns
 * and the requests it accepts. The client keeps its own copy of these shapes
 * because the Host types live outside the client composite project.
 */

/** Lifecycle of one main agent. */
export type AgentStatus = 'running' | 'stopped' | 'archived'

/** One model selection. */
export interface AgentModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One main agent as the registry reports it. */
export interface AgentView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly status: AgentStatus
  readonly mode: string
  readonly model?: AgentModel
  readonly tools: { readonly allow: readonly string[]; readonly deny: readonly string[] }
  readonly workspace?: string
  readonly permissions: { readonly preset: string; readonly agentAdministration: boolean }
  readonly sessionId?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly createdBy: string
  readonly runtime: 'busy' | 'idle' | 'unloaded'
}

/** One selectable agent mode. */
export interface ModeOption {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One selectable permission preset. */
export interface PresetOption {
  readonly value: string
  readonly name: string
  readonly description?: string
}

/** One provider's selectable models. */
export interface ModelGroup {
  readonly provider: string
  readonly name: string
  readonly models: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/** Complete page state from `GET /main-agents/state`. */
export interface AgentsState {
  readonly agents: readonly AgentView[]
  readonly settings: { readonly administratorModes: readonly string[] }
  readonly options: {
    readonly modes: readonly ModeOption[]
    readonly permissionPresets: readonly PresetOption[]
    readonly models: readonly ModelGroup[]
  }
}

/** Fields the create and edit forms submit. */
export interface AgentDraft {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly mode: string
  readonly model?: AgentModel
  readonly workspace: string
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly preset: string
  readonly agentAdministration: boolean
}

/** Per-agent actions the page issues. */
export type AgentAction = 'start' | 'stop' | 'restart' | 'archive'

/** A failed request with the registry's message. */
export class AgentsRequestError extends Error {
  override readonly name = 'AgentsRequestError'
}

const BASE = 'main-agents/'

async function request<T>(path: string, body?: unknown): Promise<T> {
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
    throw new AgentsRequestError(message)
  }
  return payload as T
}

const agentPath = (id: string, action: string) => `agent/${encodeURIComponent(id)}/${action}`

/**
 * Read the registry, options, and settings.
 * @param archived - whether to include archived agents.
 * @returns the page state.
 */
export function loadState(archived: boolean): Promise<AgentsState> {
  return request<AgentsState>(archived ? 'state?archived=1' : 'state')
}

/**
 * Create one main agent from a form draft.
 * @param draft - the submitted form.
 * @returns the created agent.
 */
export function createAgent(draft: AgentDraft): Promise<AgentView> {
  return request<AgentView>('create', {
    name: draft.name,
    config: {
      description: draft.description,
      instructions: draft.instructions,
      mode: draft.mode,
      ...draft.model === undefined ? {} : { model: draft.model },
      ...draft.workspace === '' ? {} : { workspace: draft.workspace },
      tools: { allow: draft.allow, deny: draft.deny },
      permissions: { preset: draft.preset, agentAdministration: draft.agentAdministration },
    },
  })
}

const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((entry, index) => entry === right[index])

/**
 * Apply only the fields a form draft changed, so an untouched model or
 * permission selection is not re-applied to the agent's Session.
 * @param agent - the agent as the form opened it.
 * @param draft - the submitted form.
 * @returns the edited agent.
 */
export function editAgent(agent: AgentView, draft: AgentDraft): Promise<AgentView> {
  const workspace = draft.workspace === '' ? undefined : draft.workspace
  const modelChanged = draft.model !== undefined
    && (draft.model.provider !== agent.model?.provider || draft.model.model !== agent.model.model)
  const toolsChanged = !sameList(draft.allow, agent.tools.allow) || !sameList(draft.deny, agent.tools.deny)
  const permissionsChanged = draft.preset !== agent.permissions.preset
    || draft.agentAdministration !== agent.permissions.agentAdministration
  return request<AgentView>(agentPath(agent.id, 'edit'), {
    changes: {
      ...draft.name === agent.name ? {} : { name: draft.name },
      ...draft.description === agent.description ? {} : { description: draft.description },
      ...draft.instructions === agent.instructions ? {} : { instructions: draft.instructions },
      ...draft.mode === agent.mode ? {} : { mode: draft.mode },
      ...modelChanged ? { model: draft.model } : {},
      ...workspace === agent.workspace ? {} : { workspace: workspace ?? null },
      ...toolsChanged ? { tools: { allow: draft.allow, deny: draft.deny } } : {},
      ...permissionsChanged ? { permissions: { preset: draft.preset, agentAdministration: draft.agentAdministration } } : {},
    },
  })
}

/**
 * Clone one agent under a new name.
 * @param id - the source agent id.
 * @param newName - the clone's name.
 * @returns the clone.
 */
export function cloneAgent(id: string, newName: string): Promise<AgentView> {
  return request<AgentView>(agentPath(id, 'clone'), { newName })
}

/**
 * Run one lifecycle action.
 * @param id - the agent id.
 * @param action - the action.
 * @returns the updated agent.
 */
export function runAction(id: string, action: AgentAction): Promise<AgentView> {
  return request<AgentView>(agentPath(id, action), {})
}

/**
 * Replace which modes may administer main agents.
 * @param administratorModes - the mode ids holding Agent Administration.
 * @returns the saved settings.
 */
export function saveAdministratorModes(administratorModes: readonly string[]): Promise<unknown> {
  return request('settings', { administratorModes })
}
