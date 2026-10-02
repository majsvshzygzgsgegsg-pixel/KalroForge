/**
 * Top-level assistant state. The host knows whether the coordinator is
 * thinking, working, delegating, or waiting for approval; the browser knows
 * whether the voice loop is listening or speaking. One pure function merges
 * both into the single state the HUD and state bar show.
 */

/** Top-level assistant states. */
export const ASSISTANT_STATES = ['IDLE', 'LISTENING', 'THINKING', 'DELEGATING', 'WORKING', 'WAITING_FOR_APPROVAL', 'SPEAKING'] as const

/** One assistant state. */
export type AssistantState = typeof ASSISTANT_STATES[number]

/** Voice loop phase reported by the browser. */
export type VoicePhase = 'off' | 'arming' | 'listening' | 'speaking'

/** Galaxy orb states (kept in sync with `@local/galaxy`). */
export type OrbState = 'idle' | 'arming' | 'listening' | 'processing' | 'speaking' | 'error'

/** Facts the state is derived from. */
export interface StateFacts {
  readonly busy: boolean
  /** Tool currently executing, if any. */
  readonly tool?: string
  readonly pendingApprovals: number
  /** Delegations, workflows, or background tasks this coordinator started that are still running. */
  readonly delegatedWork: number
  readonly voice: VoicePhase
  /** The last turn ended in an error. */
  readonly errored: boolean
}

const DELEGATING_TOOLS = /delegate|workflow|background_task|spawn_teammate|send_agent_message|request_agent_review|wait_agent/

/**
 * Whether a tool hands work to another agent, workflow, or background task.
 * @param tool - tool name.
 * @returns true for delegating tools.
 */
export function isDelegatingTool(tool: string): boolean {
  return DELEGATING_TOOLS.test(tool)
}

/**
 * Derive the assistant state.
 * @param facts - host and voice facts.
 * @returns the state.
 */
export function deriveState(facts: StateFacts): AssistantState {
  if (facts.pendingApprovals > 0) return 'WAITING_FOR_APPROVAL'
  if (facts.voice === 'speaking') return 'SPEAKING'
  if (facts.voice === 'listening' || facts.voice === 'arming') return 'LISTENING'
  if (facts.busy && facts.tool !== undefined) return isDelegatingTool(facts.tool) ? 'DELEGATING' : 'WORKING'
  if (facts.busy) return 'THINKING'
  if (facts.delegatedWork > 0) return 'DELEGATING'
  return 'IDLE'
}

/**
 * Orb state for the galaxy. Waiting for approval shows the ember "waiting on
 * you" look; an errored idle turn shows the error look.
 * @param state - assistant state.
 * @param facts - the same facts, for arming and error.
 * @returns orb state.
 */
export function orbStateOf(state: AssistantState, facts: Pick<StateFacts, 'voice' | 'errored'>): OrbState {
  switch (state) {
    case 'LISTENING': return facts.voice === 'arming' ? 'arming' : 'listening'
    case 'SPEAKING': return 'speaking'
    case 'THINKING':
    case 'WORKING':
    case 'DELEGATING': return 'processing'
    case 'WAITING_FOR_APPROVAL': return 'arming'
    case 'IDLE': return facts.errored ? 'error' : 'idle'
  }
}

/** Human label for the state bar. */
export const STATE_TEXT: Readonly<Record<AssistantState, string>> = {
  IDLE: 'Idle',
  LISTENING: 'Listening',
  THINKING: 'Thinking',
  DELEGATING: 'Delegating',
  WORKING: 'Working',
  WAITING_FOR_APPROVAL: 'Waiting for approval',
  SPEAKING: 'Speaking',
}
