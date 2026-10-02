/**
 * Workflow engine. A Main Agent (or Lead) plans a task graph with free-form
 * specialist roles; the engine runs each task as an Agent Team teammate of the
 * owning Session, respecting dependencies and a parallel cap, retrying failed
 * tasks with a fresh worker, passing dependency results forward, mirroring
 * tasks onto the existing Team task board, and finally handing every result
 * back to the owner for integration.
 *
 * Worker completion is observed host-side from the worker Session's status and
 * final assistant message, so a workflow keeps running without any browser tab.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { SessionId } from '@deepseek-ai/dsh-session'
import { shortId, type Orchestrator } from './service.ts'
import type { OrchestrationActor, WorkflowRecord, WorkflowTaskRecord, WorkflowTaskSpec } from './types.ts'
import { WORKFLOW_LIMITS, allSettled, dependencyContext, propagateFailures, readyTasks, validateTasks } from './workflow-graph.ts'

const WORKFLOW_LIMIT = 100
const FAILED_PREFIX = /^\s*TASK FAILED:/i

/** Workflow creation input. */
export interface CreateWorkflowInput {
  readonly title: string
  readonly goal: string
  readonly tasks: readonly WorkflowTaskSpec[]
  readonly maxParallel?: number
  /** Capture a Git checkpoint before workers start; defaults to true. */
  readonly checkpoint?: boolean
}

interface WorkerRef {
  readonly workflowId: string
  readonly taskId: string
  sawRunning: boolean
}

function slug(text: string, max: number): string {
  const value = text.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')
  return value === '' ? 'worker' : value
}

/** Workflow engine. */
export class WorkflowEngine {
  private readonly workers = new Map<string, WorkerRef>()
  private readonly integrating = new Map<string, { workflowId: string; sawRunning: boolean }>()
  private readonly pumping = new Map<string, Promise<void>>()

  constructor(private readonly service: Orchestrator) {}

  /**
   * Whether a Session is a live workflow worker.
   * @param sessionId - Session id.
   * @returns true for workers.
   */
  isWorker(sessionId: string): boolean {
    return this.workers.has(sessionId)
  }

  /**
   * List workflows, newest first.
   * @param ownerSessionIds - optional owner filter.
   * @returns records.
   */
  list(ownerSessionIds?: ReadonlySet<string>): WorkflowRecord[] {
    return [...this.service.store.table('workflows').entries()]
      .map(([, record]) => record)
      .filter(record => ownerSessionIds === undefined || ownerSessionIds.has(record.ownerSessionId))
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Read one workflow.
   * @param id - workflow id.
   * @returns the record.
   */
  get(id: string): WorkflowRecord {
    const record = this.service.store.table('workflows').get(id)
    if (record === undefined) throw new WorkflowError(`no workflow "${id}"`)
    return record
  }

  /**
   * Create and start one workflow owned by a live top-level Agent.
   * @param owner - owning Agent (the Team Lead of the workers).
   * @param input - plan.
   * @returns the started workflow.
   */
  async create(owner: Agent, input: CreateWorkflowInput): Promise<WorkflowRecord> {
    const teams = this.service.host.get('agentTeams')
    if (teams === undefined) throw new WorkflowError('Agent Teams is not enabled in this KairoForge profile')
    if (owner.session.header.origin === 'subagent') throw new WorkflowError('only a top-level agent (Lead or a main agent) can own a workflow')
    const specs = validateTasks(input.tasks)
    const actor = this.service.actorOf(owner)
    const mainAgent = this.service.registry.recordForSession(owner.session.id)
    const now = new Date().toISOString()
    const id = shortId('wf')
    let record: WorkflowRecord = {
      id,
      title: input.title.trim() === '' ? 'Workflow' : input.title.trim().slice(0, 120),
      goal: input.goal.trim(),
      ownerSessionId: owner.session.id,
      ownerName: actor.name,
      ...mainAgent === undefined ? {} : { ownerAgentId: mainAgent.id },
      status: 'running',
      maxParallel: Math.max(1, Math.min(WORKFLOW_LIMITS.parallel, Math.trunc(input.maxParallel ?? 3))),
      tasks: specs.map(spec => ({ ...spec, status: 'pending', attempts: 0, workers: [] })),
      createdAt: now,
      updatedAt: now,
    }
    if (input.checkpoint !== false) {
      const checkpoint = await this.service.checkpoints.create(owner.session.header.cwd ?? process.cwd(), {
        agent: actor, reason: 'workflow', task: `${record.title}: ${record.goal}`, workflowId: id,
      }).catch((error: unknown) => {
        this.service.host.logger.warn(`main-agents: workflow checkpoint failed: ${String(error)}`)
        return undefined
      })
      if (checkpoint !== undefined) record = { ...record, checkpointId: checkpoint.id }
    }
    record = await this.mirrorToTeamBoard(owner, record)
    await this.save(record)
    this.service.notify({
      level: 'info', kind: 'workflow', text: `${actor.name} started workflow "${record.title}" with ${String(record.tasks.length)} task(s).`,
      ...mainAgent === undefined ? {} : { agentId: mainAgent.id },
    })
    void this.pump(id)
    return this.get(id)
  }

  /**
   * Cancel a workflow: interrupt running workers and cancel pending tasks.
   * @param id - workflow id.
   * @param actor - who cancels.
   * @returns the cancelled workflow.
   */
  async cancel(id: string, actor: OrchestrationActor): Promise<WorkflowRecord> {
    const current = this.get(id)
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') return current
    const owner = await this.ownerAgent(current).catch(() => undefined)
    const teams = this.service.host.get('agentTeams')
    const now = new Date().toISOString()
    for (const task of current.tasks) {
      if (task.status !== 'running') continue
      const worker = task.workers.at(-1)
      if (owner !== undefined && teams !== undefined && worker !== undefined) {
        try {
          teams.interrupt(owner, worker)
        } catch {
          // Already idle or gone; the task is cancelled either way.
        }
      }
      if (task.workerSessionId !== undefined) this.workers.delete(task.workerSessionId)
    }
    const next: WorkflowRecord = {
      ...current,
      status: 'cancelled',
      error: `Cancelled by ${actor.name}`,
      tasks: current.tasks.map(task => task.status === 'running' || task.status === 'pending'
        ? { ...task, status: 'cancelled', finishedAt: now }
        : task),
      updatedAt: now,
    }
    this.integrating.delete(current.ownerSessionId)
    await this.save(next)
    this.service.notify({ level: 'warning', kind: 'workflow', text: `Workflow "${current.title}" was cancelled by ${actor.name}.`, ...this.agentIdOf(current) })
    return next
  }

  /**
   * Retry one failed, skipped, or cancelled task (and re-open its skipped dependants).
   * @param id - workflow id.
   * @param taskId - task id.
   * @returns the workflow.
   */
  async retryTask(id: string, taskId: string): Promise<WorkflowRecord> {
    const current = this.get(id)
    const task = current.tasks.find(candidate => candidate.id === taskId)
    if (task === undefined) throw new WorkflowError(`workflow "${id}" has no task "${taskId}"`)
    if (task.status === 'running' || task.status === 'pending' || task.status === 'completed') {
      throw new WorkflowError(`task "${taskId}" is ${task.status}; only failed, skipped, or cancelled tasks can be retried`)
    }
    const reopen = new Set([taskId])
    let grew = true
    while (grew) {
      grew = false
      for (const candidate of current.tasks) {
        if (!reopen.has(candidate.id) && candidate.status === 'skipped' && candidate.dependsOn.some(dep => reopen.has(dep))) {
          reopen.add(candidate.id)
          grew = true
        }
      }
    }
    const { error: _error, ...rest } = current
    const next: WorkflowRecord = {
      ...rest,
      status: 'running',
      tasks: current.tasks.map((candidate) => {
        if (!reopen.has(candidate.id)) return candidate
        const { error: _taskError, finishedAt: _finished, ...taskRest } = candidate
        return { ...taskRest, status: 'pending', retries: candidate.id === taskId ? candidate.retries + 1 : candidate.retries }
      }),
      updatedAt: new Date().toISOString(),
    }
    await this.save(next)
    void this.pump(id)
    return next
  }

  /**
   * Record the owner's integrated final result.
   * @param id - workflow id.
   * @param caller - calling Session id; must be the owner.
   * @param result - integrated result.
   * @param failed - whether the owner judged the workflow failed.
   * @returns the finished workflow.
   */
  async finish(id: string, caller: string, result: string, failed = false): Promise<WorkflowRecord> {
    const current = this.get(id)
    if (current.ownerSessionId !== caller) throw new WorkflowError('only the agent that owns a workflow can finish it')
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') return current
    if (current.tasks.some(task => task.status === 'running' || task.status === 'pending')) {
      throw new WorkflowError('the workflow still has pending or running tasks; wait for them or cancel the workflow')
    }
    this.integrating.delete(current.ownerSessionId)
    const { error: _error, ...rest } = current
    const next: WorkflowRecord = {
      ...rest,
      status: failed ? 'failed' : 'completed',
      finalResult: result.trim().slice(0, 20_000),
      ...failed ? { error: 'Owner reported the workflow failed' } : {},
      updatedAt: new Date().toISOString(),
    }
    await this.save(next)
    this.service.notify({
      level: failed ? 'error' : 'success', kind: 'workflow',
      text: `Workflow "${current.title}" ${failed ? 'failed' : 'completed'}.`, ...this.agentIdOf(current),
    })
    return next
  }

  // ---------------------------------------------------------------------------
  // Runtime observation (called from hooks)

  /**
   * Observe one Agent status change.
   * @param sessionId - Session id.
   * @param status - new status.
   */
  onStatus(sessionId: string, status: 'idle' | 'running'): void {
    const worker = this.workers.get(sessionId)
    if (worker !== undefined) {
      if (status === 'running') worker.sawRunning = true
      else if (worker.sawRunning) void this.settleWorker(sessionId)
    }
    const integration = this.integrating.get(sessionId)
    if (integration !== undefined) {
      if (status === 'running') integration.sawRunning = true
      else if (integration.sawRunning) void this.autoFinish(sessionId, integration.workflowId)
    }
  }

  /**
   * Observe one agent error in a worker Session.
   * @param sessionId - Session id.
   * @param message - error text.
   */
  onError(sessionId: string, message: string): void {
    const worker = this.workers.get(sessionId)
    if (worker === undefined) return
    void this.finishTask(worker.workflowId, worker.taskId, sessionId, { ok: false, text: `Worker error: ${message}` })
  }

  /** Resume workflows that were running when the host stopped. */
  async resumeAfterRestart(): Promise<void> {
    for (const workflow of this.list()) {
      if (workflow.status !== 'running' && workflow.status !== 'integrating') continue
      const now = new Date().toISOString()
      const tasks = workflow.tasks.map((task): WorkflowTaskRecord => {
        if (task.status !== 'running') return task
        const live = task.workerSessionId === undefined ? undefined : this.service.host.agents.get(SessionId(task.workerSessionId))
        if (live !== undefined && task.workerSessionId !== undefined) {
          this.workers.set(task.workerSessionId, { workflowId: workflow.id, taskId: task.id, sawRunning: live.status === 'running' })
          return task
        }
        return task.attempts <= task.retries
          ? { ...task, status: 'pending', error: 'Worker was interrupted by a KairoForge restart; retrying' }
          : { ...task, status: 'failed', error: 'Worker was interrupted by a KairoForge restart', finishedAt: now }
      })
      await this.save({ ...workflow, tasks, updatedAt: now })
      if (workflow.status === 'running') void this.pump(workflow.id)
      else this.integrating.set(workflow.ownerSessionId, { workflowId: workflow.id, sawRunning: false })
    }
  }

  // ---------------------------------------------------------------------------
  // Internals

  private agentIdOf(workflow: WorkflowRecord): { agentId?: string } {
    return workflow.ownerAgentId === undefined ? {} : { agentId: workflow.ownerAgentId }
  }

  private async save(record: WorkflowRecord): Promise<void> {
    const domain = await this.service.whenReady()
    await this.service.serialize(async () => {
      await domain.table('workflows').put(record.id, record)
      await this.service.prune('workflows', WORKFLOW_LIMIT, value => (value as WorkflowRecord).status === 'running')
    })
  }

  private async ownerAgent(workflow: WorkflowRecord): Promise<Agent> {
    const resolved = await this.service.host.sessionController.resolveAgent(SessionId(workflow.ownerSessionId))
    if ('error' in resolved) throw new WorkflowError(`workflow owner Session is unavailable: ${resolved.error.message}`)
    return resolved.agent
  }

  private async mirrorToTeamBoard(owner: Agent, record: WorkflowRecord): Promise<WorkflowRecord> {
    const teams = this.service.host.get('agentTeams')
    if (teams === undefined) return record
    const teamIds = new Map<string, string>()
    const tasks: WorkflowTaskRecord[] = []
    try {
      for (const task of record.tasks) {
        const blockedBy = task.dependsOn.map(dep => teamIds.get(dep)).filter((value): value is string => value !== undefined)
        const created = await teams.createTask(owner, {
          subject: `[${record.id}] ${task.title}`.slice(0, 200),
          description: `${task.role}: ${task.instructions}`.slice(0, 4000),
          blockedBy: blockedBy as never[],
        })
        teamIds.set(task.id, String(created.id))
        tasks.push({ ...task, teamTaskId: String(created.id) })
      }
    } catch (error) {
      this.service.host.logger.debug(`main-agents: team board mirroring skipped: ${String(error)}`)
      return record
    }
    return { ...record, tasks }
  }

  private async syncTeamTask(owner: Agent, task: WorkflowTaskRecord, action: 'reassign' | 'complete', worker?: string): Promise<void> {
    const teams = this.service.host.get('agentTeams')
    if (teams === undefined || task.teamTaskId === undefined) return
    try {
      const current = teams.getTask(owner, task.teamTaskId as never)
      if (current.status === 'completed' || current.status === 'deleted') return
      if (action === 'reassign' && worker !== undefined) {
        await teams.updateTask(owner, { taskId: current.id, expectedRevision: current.revision, action: 'reassign', owner: worker })
      } else if (action === 'complete') {
        const owned = current.ownerName === undefined
          ? await teams.updateTask(owner, { taskId: current.id, expectedRevision: current.revision, action: 'claim' })
          : current
        await teams.updateTask(owner, { taskId: owned.id, expectedRevision: owned.revision, action: 'complete' })
      }
    } catch (error) {
      this.service.host.logger.debug(`main-agents: team task ${task.teamTaskId} ${action} skipped: ${String(error)}`)
    }
  }

  /** Start ready tasks or finalize; one pump per workflow at a time. */
  private pump(id: string): Promise<void> {
    const previous = this.pumping.get(id) ?? Promise.resolve()
    const next = previous.then(() => this.pumpOnce(id)).catch((error: unknown) => {
      this.service.host.logger.warn(`main-agents: workflow ${id} pump failed: ${String(error)}`)
    })
    this.pumping.set(id, next)
    return next
  }

  private async pumpOnce(id: string): Promise<void> {
    let workflow = this.get(id)
    if (workflow.status !== 'running') return
    const propagated = propagateFailures(workflow.tasks)
    if (propagated.some((task, index) => task !== workflow.tasks[index])) {
      workflow = { ...workflow, tasks: propagated, updatedAt: new Date().toISOString() }
      await this.save(workflow)
    }
    if (allSettled(workflow.tasks)) {
      await this.integrate(workflow)
      return
    }
    const ready = readyTasks(workflow)
    if (ready.length === 0) return
    const owner = await this.ownerAgent(workflow)
    for (const task of ready) await this.startTask(owner, workflow.id, task.id)
  }

  private async startTask(owner: Agent, workflowId: string, taskId: string): Promise<void> {
    const teams = this.service.host.get('agentTeams')
    if (teams === undefined) throw new WorkflowError('Agent Teams is not enabled')
    const workflow = this.get(workflowId)
    const task = workflow.tasks.find(candidate => candidate.id === taskId)
    if (task?.status !== 'pending') return
    const attempt = task.attempts + 1
    const name = `${slug(task.role, 18)}-${slug(task.id, 14)}-${workflowId.slice(3, 9)}-${String(attempt)}`.slice(0, 64).replace(/-+$/, '')
    const previousError = task.error === undefined ? '' : `\n\nA previous attempt failed with:\n${task.error.slice(0, 2000)}\nUse a different approach than the failed attempt.`
    const prompt = [
      '<system-reminder>',
      `You are "${name}", a ${task.role} worker in workflow "${workflow.title}" (${workflow.id}) run by ${workflow.ownerName}.`,
      `Overall goal: ${workflow.goal}`,
      'Do only your task. Inspect before changing files, keep changes small, and verify what you can.',
      'Your final message is returned to the workflow automatically: end with a concise result summary (what you did, files changed, what you verified).',
      'If you cannot complete the task, begin your final message with "TASK FAILED:" and explain why.',
      '</system-reminder>',
      '',
      `## Task ${task.id}: ${task.title}`,
      task.instructions,
    ].join('\n') + dependencyContext(workflow, task) + previousError
    await this.updateTask(workflowId, taskId, current => ({
      ...current,
      status: 'running',
      attempts: attempt,
      workers: [...current.workers, name],
      startedAt: new Date().toISOString(),
    }))
    try {
      const spawned = await teams.spawnTeammate(owner, {
        name,
        description: `${task.role} for workflow ${workflow.id} task ${task.id}`.slice(0, 200),
        prompt: [{ type: 'text', text: prompt }],
        context: 'fresh',
        provider: 'spawn',
        signal: AbortSignal.timeout(120_000),
      })
      const sessionId = String(spawned.member.id)
      await this.updateTask(workflowId, taskId, current => ({ ...current, workerSessionId: sessionId }))
      if (spawned.member.status === 'failed') {
        await this.finishTask(workflowId, taskId, sessionId, { ok: false, text: `Worker failed to start: ${spawned.member.diagnostics.join('; ')}` })
        return
      }
      const live = this.service.host.agents.get(SessionId(sessionId))
      this.workers.set(sessionId, { workflowId, taskId, sawRunning: live?.status === 'running' })
      void this.syncTeamTask(owner, { ...task, workers: [name] }, 'reassign', name)
      // The worker may already have finished (and been disposed) while spawning resolved.
      if (live === undefined || (live.status !== 'running' && this.service.lastAssistantText(sessionId) !== '')) {
        void this.settleWorker(sessionId)
      }
    } catch (error) {
      await this.finishTask(workflowId, taskId, undefined, { ok: false, text: `Could not start worker: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  private async settleWorker(sessionId: string): Promise<void> {
    const worker = this.workers.get(sessionId)
    if (worker === undefined) return
    const text = this.service.lastAssistantText(sessionId)
    const telemetry = this.service.peekTelemetry(sessionId)
    if (text === '' && telemetry?.erroredTurn === true) {
      await this.finishTask(worker.workflowId, worker.taskId, sessionId, { ok: false, text: telemetry.errors.at(-1)?.text ?? 'Worker turn failed' })
      return
    }
    await this.finishTask(worker.workflowId, worker.taskId, sessionId, FAILED_PREFIX.test(text)
      ? { ok: false, text }
      : { ok: true, text: text === '' ? '(the worker finished without a summary)' : text })
  }

  private async finishTask(
    workflowId: string,
    taskId: string,
    sessionId: string | undefined,
    outcome: { ok: boolean; text: string },
  ): Promise<void> {
    if (sessionId !== undefined) this.workers.delete(sessionId)
    const workflow = this.get(workflowId)
    const task = workflow.tasks.find(candidate => candidate.id === taskId)
    if (task?.status !== 'running') return
    if (sessionId !== undefined && task.workerSessionId !== undefined && task.workerSessionId !== sessionId) return
    const now = new Date().toISOString()
    const retry = !outcome.ok && task.attempts <= task.retries
    await this.updateTask(workflowId, taskId, (current) => {
      if (outcome.ok) {
        const { error: _error, ...rest } = current
        return { ...rest, status: 'completed', result: outcome.text.slice(0, 20_000), finishedAt: now }
      }
      return retry
        ? { ...current, status: 'pending', error: outcome.text.slice(0, 4000) }
        : { ...current, status: 'failed', error: outcome.text.slice(0, 4000), finishedAt: now }
    })
    if (outcome.ok) {
      const owner = await this.ownerAgent(workflow).catch(() => undefined)
      if (owner !== undefined) void this.syncTeamTask(owner, task, 'complete')
    }
    if (!outcome.ok && !retry) {
      this.service.notify({ level: 'error', kind: 'workflow', text: `Task "${task.title}" in workflow "${workflow.title}" failed.`, ...this.agentIdOf(workflow) })
    }
    await this.pump(workflowId)
  }

  private async updateTask(workflowId: string, taskId: string, change: (task: WorkflowTaskRecord) => WorkflowTaskRecord): Promise<void> {
    const domain = await this.service.whenReady()
    await this.service.serialize(async () => {
      const current = domain.table('workflows').get(workflowId)
      if (current === undefined) return
      await domain.table('workflows').put(workflowId, {
        ...current,
        tasks: current.tasks.map(task => task.id === taskId ? change(task) : task),
        updatedAt: new Date().toISOString(),
      })
    })
  }

  private async integrate(workflow: WorkflowRecord): Promise<void> {
    const failed = workflow.tasks.filter(task => task.status !== 'completed')
    const next: WorkflowRecord = { ...workflow, status: 'integrating', updatedAt: new Date().toISOString() }
    await this.save(next)
    const sections = workflow.tasks.map(task => [
      `### ${task.id}: ${task.title} (${task.role}) — ${task.status}${task.attempts > 1 ? `, ${String(task.attempts)} attempts` : ''}`,
      task.status === 'completed' ? (task.result ?? '').slice(0, 6000) : `Error: ${(task.error ?? 'did not run').slice(0, 2000)}`,
    ].join('\n'))
    const text = [
      `[KairoForge workflow ${failed.length === 0 ? 'complete' : 'finished with failures'}] ${workflow.title} (${workflow.id})`,
      `Goal: ${workflow.goal}`,
      workflow.checkpointId === undefined ? '' : `Checkpoint taken before the workflow: ${workflow.checkpointId}`,
      '',
      ...sections,
      '',
      failed.length === 0
        ? 'Integrate these results into the final result, verify it (build/tests as appropriate), then call finish_workflow({ workflow_id, result }).'
        : `Some tasks did not complete (${failed.map(task => task.id).join(', ')}). Decide whether to retry them with retry_workflow_task, fix the gap yourself, or finish with finish_workflow({ workflow_id, result, failed: true }).`,
    ].filter(line => line !== '').join('\n\n')
    this.integrating.set(workflow.ownerSessionId, { workflowId: workflow.id, sawRunning: false })
    try {
      await this.service.registry.promptSession(workflow.ownerSessionId, text)
    } catch (error) {
      this.integrating.delete(workflow.ownerSessionId)
      await this.save({ ...next, status: 'failed', error: `Could not return results to the owner: ${String(error)}`, updatedAt: new Date().toISOString() })
    }
  }

  /** The owner finished its integration turn without calling finish_workflow: record its reply as the result. */
  private async autoFinish(ownerSessionId: string, workflowId: string): Promise<void> {
    this.integrating.delete(ownerSessionId)
    const workflow = this.get(workflowId)
    if (workflow.status !== 'integrating') return
    const text = this.service.lastAssistantText(ownerSessionId)
    const failed = workflow.tasks.some(task => task.status !== 'completed')
    await this.save({
      ...workflow,
      status: failed ? 'failed' : 'completed',
      finalResult: text.slice(0, 20_000),
      ...failed ? { error: 'Some tasks did not complete' } : {},
      updatedAt: new Date().toISOString(),
    })
    this.service.notify({
      level: failed ? 'error' : 'success', kind: 'workflow',
      text: `Workflow "${workflow.title}" ${failed ? 'finished with failures' : 'completed'}.`, ...this.agentIdOf(workflow),
    })
  }
}

/** Workflow failure surfaced to tools and routes. */
export class WorkflowError extends Error {
  override readonly name = 'WorkflowError'
}
