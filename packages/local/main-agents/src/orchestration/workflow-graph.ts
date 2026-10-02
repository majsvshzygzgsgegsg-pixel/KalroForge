/**
 * Pure workflow-graph logic: validate a planned task graph, pick the tasks
 * that may start, propagate failures to dependants, and decide when the
 * workflow is finished. The engine owns all side effects.
 */
import type { WorkflowRecord, WorkflowTaskRecord, WorkflowTaskSpec } from './types.ts'

/** Hard caps that keep one workflow bounded. */
export const WORKFLOW_LIMITS = { tasks: 24, retries: 3, parallel: 6 } as const

/**
 * Validate and normalize planned tasks.
 * @param specs - tasks as requested.
 * @returns normalized specs.
 * @throws Error naming the first problem: duplicate id, unknown dependency, cycle, or limit.
 */
export function validateTasks(specs: readonly WorkflowTaskSpec[]): WorkflowTaskSpec[] {
  if (specs.length === 0) throw new Error('a workflow needs at least one task')
  if (specs.length > WORKFLOW_LIMITS.tasks) throw new Error(`a workflow may have at most ${String(WORKFLOW_LIMITS.tasks)} tasks`)
  const ids = new Set<string>()
  const tasks = specs.map((spec) => {
    const id = spec.id.trim()
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id)) throw new Error(`task id "${spec.id}" must be 1-40 letters, digits, - or _`)
    if (ids.has(id)) throw new Error(`duplicate task id "${id}"`)
    ids.add(id)
    if (spec.instructions.trim() === '') throw new Error(`task "${id}" needs instructions`)
    return {
      id,
      title: spec.title.trim() === '' ? id : spec.title.trim(),
      role: spec.role.trim() === '' ? 'worker' : spec.role.trim(),
      instructions: spec.instructions.trim(),
      dependsOn: [...new Set(spec.dependsOn.map(dep => dep.trim()))],
      retries: Math.max(0, Math.min(WORKFLOW_LIMITS.retries, Math.trunc(spec.retries))),
    }
  })
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`task "${task.id}" depends on unknown task "${dep}"`)
      if (dep === task.id) throw new Error(`task "${task.id}" depends on itself`)
    }
  }
  const byId = new Map(tasks.map(task => [task.id, task]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, path: string[]): void => {
    const mark = state.get(id)
    if (mark === 'done') return
    if (mark === 'visiting') throw new Error(`dependency cycle: ${[...path, id].join(' -> ')}`)
    state.set(id, 'visiting')
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...path, id])
    state.set(id, 'done')
  }
  for (const task of tasks) visit(task.id, [])
  return tasks
}

/**
 * Tasks that may start now: pending, every dependency completed, within the parallel cap.
 * @param workflow - current workflow.
 * @returns tasks to start, in plan order.
 */
export function readyTasks(workflow: WorkflowRecord): WorkflowTaskRecord[] {
  if (workflow.status !== 'running') return []
  const status = new Map(workflow.tasks.map(task => [task.id, task.status]))
  const running = workflow.tasks.filter(task => task.status === 'running').length
  const slots = Math.max(0, workflow.maxParallel - running)
  return workflow.tasks
    .filter(task => task.status === 'pending' && task.dependsOn.every(dep => status.get(dep) === 'completed'))
    .slice(0, slots)
}

/**
 * Mark pending tasks whose dependency failed, was cancelled, or was skipped as skipped.
 * @param tasks - current tasks.
 * @returns tasks with failures propagated.
 */
export function propagateFailures(tasks: readonly WorkflowTaskRecord[]): WorkflowTaskRecord[] {
  const out = [...tasks]
  let changed = true
  while (changed) {
    changed = false
    const status = new Map(out.map(task => [task.id, task.status]))
    for (let i = 0; i < out.length; i++) {
      const task = out[i]
      if (task?.status !== 'pending') continue
      const blocker = task.dependsOn.find(dep => ['failed', 'cancelled', 'skipped'].includes(status.get(dep) ?? ''))
      if (blocker !== undefined) {
        out[i] = { ...task, status: 'skipped', error: `dependency "${blocker}" did not complete`, finishedAt: new Date().toISOString() }
        changed = true
      }
    }
  }
  return out
}

/**
 * Whether every task reached a terminal state.
 * @param tasks - current tasks.
 * @returns true when no task is pending or running.
 */
export function allSettled(tasks: readonly WorkflowTaskRecord[]): boolean {
  return tasks.every(task => task.status !== 'pending' && task.status !== 'running')
}

/**
 * Dependency results handed to a task's worker.
 * @param workflow - current workflow.
 * @param task - the task about to start.
 * @returns prompt text with each dependency's result, possibly empty.
 */
export function dependencyContext(workflow: WorkflowRecord, task: WorkflowTaskRecord): string {
  const results = task.dependsOn
    .map(dep => workflow.tasks.find(candidate => candidate.id === dep))
    .filter((dep): dep is WorkflowTaskRecord => dep !== undefined)
    .map(dep => `### Result of "${dep.title}" (${dep.id}, ${dep.role})\n${(dep.result ?? '').slice(0, 6000)}`)
  return results.length === 0 ? '' : `\n\nResults from the tasks you depend on:\n\n${results.join('\n\n')}`
}
