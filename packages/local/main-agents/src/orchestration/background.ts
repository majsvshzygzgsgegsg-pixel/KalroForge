/**
 * Background agent tasks. A task runs in a main agent's own Session on the
 * host, so it continues when the browser tab closes or reloads; progress,
 * pause, resume, cancel, completion and failure are tracked durably. Tasks for
 * one agent run one at a time in creation order. After a host restart, tasks
 * that were running resume automatically unless disabled in settings.
 */
import { SessionId } from '@deepseek-ai/dsh-session'
import { shortId, type Orchestrator } from './service.ts'
import type { BackgroundTaskRecord, OrchestrationActor } from './types.ts'

const TASK_LIMIT = 200
const FAILED_PREFIX = /^\s*TASK FAILED:/i

interface Running {
  readonly taskId: string
  sawRunning: boolean
}

/** Background task runner. */
export class BackgroundRunner {
  private readonly running = new Map<string, Running>()
  private readonly pumping = new Map<string, Promise<void>>()
  /** Tasks whose start is still being recorded; settling waits for it. */
  private readonly starting = new Map<string, Promise<unknown>>()

  constructor(private readonly service: Orchestrator) {}

  /**
   * List tasks, newest first.
   * @param agentId - optional agent filter.
   * @returns records.
   */
  list(agentId?: string): BackgroundTaskRecord[] {
    return [...this.service.store.table('background').entries()]
      .map(([, record]) => record)
      .filter(record => agentId === undefined || record.agentId === agentId)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Read one task.
   * @param id - task id.
   * @returns the record.
   */
  get(id: string): BackgroundTaskRecord {
    const record = this.service.store.table('background').get(id)
    if (record === undefined) throw new BackgroundError(`no background task "${id}"`)
    return record
  }

  /**
   * Queue a background task for a main agent.
   * @param input - target agent, title, and complete prompt.
   * @param actor - creator; agent creators are notified on completion.
   * @returns the queued task.
   */
  async create(
    input: { readonly agentId: string; readonly title: string; readonly prompt: string },
    actor: OrchestrationActor,
  ): Promise<BackgroundTaskRecord> {
    const agent = await this.service.registry.get(input.agentId)
    if (agent.status === 'archived') throw new BackgroundError(`main agent "${agent.name}" is archived`)
    if (input.prompt.trim() === '') throw new BackgroundError('a background task needs a prompt')
    const record: BackgroundTaskRecord = {
      id: shortId('bg'),
      agentId: agent.id,
      title: (input.title.trim() === '' ? input.prompt.trim() : input.title.trim()).slice(0, 120),
      prompt: input.prompt.trim(),
      status: 'queued',
      progress: { steps: 0, toolCalls: 0 },
      ...actor.sessionId === 'user' || actor.sessionId === agent.sessionId ? {} : { notifySessionId: actor.sessionId },
      createdBy: actor.name,
      createdAt: new Date().toISOString(),
    }
    await this.save(record)
    void this.pump(agent.id)
    return record
  }

  /**
   * Pause a running or queued task; a running turn is interrupted.
   * @param id - task id.
   * @returns the paused task.
   */
  async pause(id: string): Promise<BackgroundTaskRecord> {
    const task = this.get(id)
    if (task.status !== 'running' && task.status !== 'queued') throw new BackgroundError(`task is ${task.status}; only running or queued tasks can be paused`)
    const next = await this.patch(id, { status: 'paused' })
    if (task.status === 'running') this.interrupt(task)
    void this.pump(task.agentId)
    return next
  }

  /**
   * Resume a paused task; it continues from where it stopped.
   * @param id - task id.
   * @returns the queued task.
   */
  async resume(id: string): Promise<BackgroundTaskRecord> {
    const task = this.get(id)
    if (task.status !== 'paused') throw new BackgroundError(`task is ${task.status}; only paused tasks can be resumed`)
    const next = await this.patch(id, { status: 'queued' })
    void this.pump(task.agentId)
    return next
  }

  /**
   * Cancel a task; a running turn is interrupted.
   * @param id - task id.
   * @returns the cancelled task.
   */
  async cancel(id: string): Promise<BackgroundTaskRecord> {
    const task = this.get(id)
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task
    const next = await this.patch(id, { status: 'cancelled', finishedAt: new Date().toISOString() })
    if (task.status === 'running') this.interrupt(task)
    this.service.notify({ level: 'warning', kind: 'background', text: `Background task "${task.title}" was cancelled.`, agentId: task.agentId })
    void this.pump(task.agentId)
    return next
  }

  /**
   * Add an instruction to a queued or paused task; it is part of the prompt
   * when the task starts or resumes. A running task is updated by messaging
   * its Session instead.
   * @param id - task id.
   * @param text - instruction to append.
   * @returns the amended task.
   */
  async amend(id: string, text: string): Promise<BackgroundTaskRecord> {
    const task = this.get(id)
    if (task.status !== 'queued' && task.status !== 'paused') throw new BackgroundError(`task is ${task.status}; only queued or paused tasks can be amended`)
    const addition = text.trim()
    if (addition === '') throw new BackgroundError('an amendment needs text')
    return this.patch(id, { prompt: `${task.prompt}\n\nUpdate from the user (${new Date().toISOString()}): ${addition}` })
  }

  /**
   * Record progress reported by the agent working on a task.
   * @param id - task id.
   * @param caller - reporting Session id; must be the task's Session.
   * @param progress - percent and note.
   * @returns the task.
   */
  async reportProgress(
    id: string,
    caller: string,
    progress: { readonly percent?: number; readonly note?: string },
  ): Promise<BackgroundTaskRecord> {
    const task = this.get(id)
    if (task.sessionId !== caller) throw new BackgroundError('only the agent running a background task can report its progress')
    return this.patch(id, {
      progress: {
        ...task.progress,
        ...progress.percent === undefined ? {} : { percent: Math.max(0, Math.min(100, progress.percent)) },
        ...progress.note === undefined ? {} : { note: progress.note.slice(0, 200) },
      },
    })
  }

  // ---------------------------------------------------------------------------
  // Runtime observation

  /**
   * Running background task for one Session, if any.
   * @param sessionId - Session id.
   * @returns task id.
   */
  taskForSession(sessionId: string): string | undefined {
    return this.running.get(sessionId)?.taskId
  }

  /**
   * Count one tool call or step for the Session's running task.
   * @param sessionId - Session id.
   * @param tool - tool name, or undefined for a model step.
   */
  onActivity(sessionId: string, tool?: string): void {
    const running = this.running.get(sessionId)
    if (running === undefined) return
    const task = this.service.store.table('background').get(running.taskId)
    if (task?.status !== 'running') return
    void this.patch(task.id, {
      progress: {
        ...task.progress,
        ...tool === undefined ? { steps: task.progress.steps + 1 } : { toolCalls: task.progress.toolCalls + 1, lastTool: tool },
      },
    })
  }

  /**
   * Observe one Agent status change.
   * @param sessionId - Session id.
   * @param status - new status.
   */
  onStatus(sessionId: string, status: 'idle' | 'running'): void {
    const running = this.running.get(sessionId)
    if (running === undefined) return
    if (status === 'running') {
      running.sawRunning = true
      return
    }
    if (!running.sawRunning) return
    this.running.delete(sessionId)
    void this.settle(running.taskId, sessionId)
  }

  /** Resume or fail tasks that were running when the host stopped. */
  async resumeAfterRestart(): Promise<void> {
    const resume = this.service.settings().background.resumeOnRestart
    const agents = new Set<string>()
    for (const task of this.list()) {
      if (task.status === 'running') {
        await this.patch(task.id, resume
          ? { status: 'queued', resumedAfterRestart: (task.resumedAfterRestart ?? 0) + 1 }
          : { status: 'failed', error: 'Interrupted by a KairoForge restart', finishedAt: new Date().toISOString() })
      }
      if (task.status === 'queued' || task.status === 'running') agents.add(task.agentId)
    }
    for (const agentId of agents) void this.pump(agentId)
  }

  // ---------------------------------------------------------------------------
  // Internals

  private interrupt(task: BackgroundTaskRecord): void {
    if (task.sessionId === undefined) return
    this.running.delete(task.sessionId)
    this.service.host.agents.get(SessionId(task.sessionId))?.cancel({ kind: 'user' }, { keepInbox: false })
  }

  private async save(record: BackgroundTaskRecord): Promise<void> {
    const domain = await this.service.whenReady()
    await this.service.serialize(async () => {
      await domain.table('background').put(record.id, record)
      await this.service.prune('background', TASK_LIMIT, (value) => {
        const status = (value as BackgroundTaskRecord).status
        return status === 'queued' || status === 'running' || status === 'paused'
      })
    })
  }

  private async patch(id: string, changes: Partial<BackgroundTaskRecord>): Promise<BackgroundTaskRecord> {
    const domain = await this.service.whenReady()
    return this.service.serialize(async () => {
      const current = domain.table('background').get(id)
      if (current === undefined) throw new BackgroundError(`no background task "${id}"`)
      const next = { ...current, ...changes } as BackgroundTaskRecord
      await domain.table('background').put(id, next)
      return next
    })
  }

  private pump(agentId: string): Promise<void> {
    const previous = this.pumping.get(agentId) ?? Promise.resolve()
    const next = previous.then(() => this.pumpOnce(agentId)).catch((error: unknown) => {
      this.service.host.logger.warn(`main-agents: background pump for ${agentId} failed: ${String(error)}`)
    })
    this.pumping.set(agentId, next)
    return next
  }

  private async pumpOnce(agentId: string): Promise<void> {
    const tasks = this.list(agentId)
    if (tasks.some(task => task.status === 'running')) return
    const next = tasks.filter(task => task.status === 'queued').at(-1)
    if (next === undefined) return
    let started: () => void = () => {}
    this.starting.set(next.id, new Promise<void>((resolve) => { started = resolve }))
    try {
      let agent = await this.service.registry.get(agentId)
      if (agent.status === 'stopped') agent = await this.service.registry.start(agentId, { kind: 'user' })
      const resumed = next.startedAt !== undefined
      const text = [
        `[KairoForge background task ${next.id}${resumed ? ' resumed' : ''}] ${next.title}`,
        resumed
          ? 'This task was paused or interrupted. Continue it from where you stopped; do not redo finished steps.'
          : 'Work on this task autonomously in the background; nobody is watching this chat live.',
        `Report milestones with report_task_progress({ task_id: "${next.id}", percent, note }).`,
        'Your final message is the task result: summarize what you did and what you verified. If you cannot finish, begin your final message with "TASK FAILED:" and explain.',
        '',
        next.prompt,
      ].join('\n')
      // Register before prompting: a fast turn can finish before promptAgent resolves.
      const delivery = await this.service.registry.promptAgent(agentId, text, { kind: 'task', text: `Background task: ${next.title}` }, (sessionId) => {
        const live = this.service.host.agents.get(SessionId(sessionId))
        this.running.set(sessionId, { taskId: next.id, sawRunning: live?.status === 'running' })
      })
      await this.patch(next.id, {
        status: 'running',
        sessionId: delivery.sessionId,
        ...next.startedAt === undefined ? { startedAt: new Date().toISOString() } : {},
      })
    } catch (error) {
      for (const [sessionId, entry] of this.running) if (entry.taskId === next.id) this.running.delete(sessionId)
      await this.patch(next.id, { status: 'failed', error: `Could not start: ${error instanceof Error ? error.message : String(error)}`, finishedAt: new Date().toISOString() })
      this.service.notify({ level: 'error', kind: 'background', text: `Background task "${next.title}" could not start.`, agentId })
      void this.pump(agentId)
    } finally {
      this.starting.delete(next.id)
      started()
    }
  }

  private async settle(taskId: string, sessionId: string): Promise<void> {
    await this.starting.get(taskId)
    const task = this.get(taskId)
    if (task.status !== 'running') {
      void this.pump(task.agentId)
      return
    }
    const text = this.service.lastAssistantText(sessionId)
    const telemetry = this.service.peekTelemetry(sessionId)
    const failed = FAILED_PREFIX.test(text) || (text === '' && telemetry?.erroredTurn === true)
    const next = await this.patch(taskId, failed
      ? { status: 'failed', error: (text === '' ? telemetry?.errors.at(-1)?.text ?? 'The agent turn failed' : text).slice(0, 8000), finishedAt: new Date().toISOString() }
      : { status: 'completed', result: text.slice(0, 20_000), progress: { ...task.progress, percent: 100 }, finishedAt: new Date().toISOString() })
    this.service.notify({
      level: failed ? 'error' : 'success',
      kind: 'background',
      text: `Background task "${task.title}" ${failed ? 'failed' : 'completed'}.`,
      agentId: task.agentId,
    })
    if (next.notifySessionId !== undefined) {
      const summary = failed ? next.error ?? '' : next.result ?? ''
      await this.service.registry.promptSession(next.notifySessionId, [
        `[KairoForge background task ${failed ? 'failed' : 'completed'}] ${task.title} (${task.id})`,
        `Agent: ${task.agentId}`,
        '',
        summary.slice(0, 6000),
      ].join('\n')).catch((error: unknown) => {
        this.service.host.logger.warn(`main-agents: could not notify ${next.notifySessionId ?? ''}: ${String(error)}`)
      })
    }
    void this.pump(task.agentId)
  }
}

/** Background task failure surfaced to tools and routes. */
export class BackgroundError extends Error {
  override readonly name = 'BackgroundError'
}
