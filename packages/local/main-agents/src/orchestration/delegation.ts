/**
 * Agent-to-agent delegation with ownership and depth. Each delegation records
 * who asked, who owns the work, its depth in the chain, and the chain of
 * Sessions above it. Nested delegations inherit the chain of the delegation
 * the sender is currently working on; chains deeper than the configured limit
 * and cycles back to an agent already in the chain are rejected. Only the
 * delegatee can return the result, and the result always goes back to the
 * delegator, which stays responsible for its own final answer.
 */
import { shortId, type Orchestrator } from './service.ts'
import type { DelegationKind, DelegationRecord, OrchestrationActor } from './types.ts'

const DELEGATION_LIMIT = 300
/** Messages allowed between one ordered pair of agents per window before replies are refused as a likely ping-pong. */
const PAIR_MESSAGE_LIMIT = 12
const PAIR_WINDOW_MS = 10 * 60_000

/** Delegation manager. */
export class DelegationManager {
  private readonly pairs = new Map<string, number[]>()

  constructor(private readonly service: Orchestrator) {}

  /**
   * List delegations, newest first.
   * @param sessionIds - optional filter on sender or recipient Session.
   * @returns records.
   */
  list(sessionIds?: ReadonlySet<string>): DelegationRecord[] {
    return [...this.service.store.table('delegations').entries()]
      .map(([, record]) => record)
      .filter(record => sessionIds === undefined || sessionIds.has(record.from.sessionId) || sessionIds.has(record.toSessionId))
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Read one delegation.
   * @param id - delegation id.
   * @returns the record.
   */
  get(id: string): DelegationRecord {
    const record = this.service.store.table('delegations').get(id)
    if (record === undefined) throw new DelegationError(`no delegation "${id}"`)
    return record
  }

  /**
   * The open delegation a Session is currently working on (newest first).
   * @param sessionId - delegatee Session id.
   * @returns the delegation, if any.
   */
  activeFor(sessionId: string): DelegationRecord | undefined {
    return this.list().find(record => record.toSessionId === sessionId && record.status === 'open')
  }

  /**
   * Delegate a task or a review to a main agent.
   * @param from - delegator.
   * @param target - main agent id or name.
   * @param task - complete task text.
   * @param kind - task or review.
   * @returns the open delegation.
   */
  async delegate(from: OrchestrationActor, target: string, task: string, kind: DelegationKind = 'task'): Promise<DelegationRecord> {
    const text = task.trim()
    if (text === '') throw new DelegationError('a delegation needs a task')
    const agent = await this.service.registry.get(target)
    if (agent.sessionId === from.sessionId) throw new DelegationError('an agent cannot delegate to itself')
    const parent = from.sessionId === 'user' ? undefined : this.activeFor(from.sessionId)
    const depth = (parent?.depth ?? 0) + 1
    const { maxDepth } = this.service.settings().delegation
    if (depth > maxDepth) {
      throw new DelegationError(`delegation depth ${String(depth)} exceeds the limit of ${String(maxDepth)}; do this work yourself or return what you have to ${parent?.from.name ?? 'your delegator'}`)
    }
    const chain = [...parent?.chain ?? [], from.sessionId]
    if (agent.sessionId !== undefined && chain.includes(agent.sessionId)) {
      throw new DelegationError(`"${agent.name}" is already part of this delegation chain; delegating back to it would create a cycle`)
    }
    const id = shortId(kind === 'review' ? 'rv' : 'dl')
    const header = kind === 'review' ? '[KairoForge review request]' : '[KairoForge delegated task]'
    const framed = [
      header,
      `Delegation: ${id} (depth ${String(depth)} of ${String(maxDepth)})`,
      `From: ${from.sessionId === 'user' ? 'the user (Agents panel)' : `${from.name} (Session ${from.sessionId})`}`,
      `To: main agent "${agent.name}"`,
      `You own this ${kind === 'review' ? 'review' : 'task'}. When done, call return_task_result({ delegation_id: "${id}", result: "...", status: "completed" | "failed" }); the result goes back to the delegator automatically.`,
      depth >= maxDepth ? 'This is the deepest allowed delegation level: do not delegate further.' : 'Delegate further only for clearly separable sub-work.',
      '',
      text,
    ].join('\n')
    const delivery = await this.service.registry.promptAgent(agent.id, framed, { kind: 'task', text: `${kind === 'review' ? 'Review' : 'Task'} from ${from.name}: ${text}` })
    const record: DelegationRecord = {
      id,
      kind,
      from,
      toAgentId: agent.id,
      toName: agent.name,
      toSessionId: delivery.sessionId,
      depth,
      rootId: parent?.rootId ?? id,
      ...parent === undefined ? {} : { parentId: parent.id },
      chain,
      task: text.slice(0, 8000),
      status: 'open',
      createdAt: new Date().toISOString(),
    }
    await this.save(record)
    this.service.notify({ level: 'info', kind: 'delegation', text: `${from.name} delegated a ${kind} to ${agent.name}.`, agentId: agent.id })
    return record
  }

  /**
   * Return a delegation's result to its delegator.
   * @param caller - returning Session; must be the delegatee.
   * @param id - delegation id.
   * @param result - result text.
   * @param status - completed or failed.
   * @returns the closed delegation.
   */
  async returnResult(caller: OrchestrationActor, id: string, result: string, status: 'completed' | 'failed' = 'completed'): Promise<DelegationRecord> {
    const record = this.get(id)
    if (record.toSessionId !== caller.sessionId) throw new DelegationError(`delegation ${id} is owned by "${record.toName}"; only it can return the result`)
    if (record.status !== 'open') throw new DelegationError(`delegation ${id} is already ${record.status}`)
    const closed: DelegationRecord = { ...record, status, result: result.trim().slice(0, 20_000), completedAt: new Date().toISOString() }
    await this.save(closed)
    if (record.from.sessionId === 'user') {
      this.service.notify({ level: status === 'completed' ? 'success' : 'error', kind: 'delegation', text: `${record.toName} ${status} your ${record.kind}: ${result.slice(0, 160)}`, agentId: record.toAgentId })
    } else {
      await this.service.registry.promptSession(record.from.sessionId, [
        `[KairoForge task result] ${record.kind === 'review' ? 'Review' : 'Delegation'} ${record.id} ${status} by ${record.toName}`,
        `Original ${record.kind}: ${record.task.slice(0, 300)}`,
        'You remain responsible for your own task and final answer; integrate this result instead of re-delegating it.',
        '',
        closed.result ?? '',
      ].join('\n'))
    }
    return closed
  }

  /**
   * Count one direct agent message and refuse a likely ping-pong.
   * @param from - sender Session id.
   * @param to - recipient id/name/Session.
   * @returns a refusal reason, or undefined when allowed.
   */
  admitMessage(from: string, to: string): string | undefined {
    const key = `${from}\u0000${to.trim().toLowerCase()}`
    const now = Date.now()
    const times = (this.pairs.get(key) ?? []).filter(time => now - time < PAIR_WINDOW_MS)
    if (times.length >= PAIR_MESSAGE_LIMIT) {
      this.pairs.set(key, times)
      return `More than ${String(PAIR_MESSAGE_LIMIT)} messages to "${to}" in ten minutes; this looks like a message loop. Stop messaging and finish your own work.`
    }
    times.push(now)
    this.pairs.set(key, times)
    return undefined
  }

  private async save(record: DelegationRecord): Promise<void> {
    const domain = await this.service.whenReady()
    await this.service.serialize(async () => {
      await domain.table('delegations').put(record.id, record)
      await this.service.prune('delegations', DELEGATION_LIMIT, value => (value as DelegationRecord).status === 'open')
    })
  }
}

/** Delegation failure surfaced to tools and routes. */
export class DelegationError extends Error {
  override readonly name = 'DelegationError'
}
