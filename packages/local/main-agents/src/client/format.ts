/** Display helpers shared by the orchestration views. */
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'

/** Statuses meaning work is in flight. */
const ONGOING = new Set(['running', 'integrating', 'busy', 'starting', 'recovering', 'open'])
/** Statuses meaning work ended badly. */
const FAILED = new Set(['failed', 'recurred', 'error'])
/** Statuses waiting on something. */
const WAITING = new Set(['queued', 'pending', 'paused', 'cancelled', 'skipped', 'archived'])

/**
 * Map any orchestration status to a state dot.
 * @param status - workflow, task, background, delegation, loop, or agent status.
 * @returns the dot state.
 */
export function statusDot(status: string): StateDotState {
  if (ONGOING.has(status)) return 'ongoing'
  if (FAILED.has(status)) return 'error'
  if (WAITING.has(status)) return 'warning'
  if (status === 'completed' || status === 'recovered' || status === 'success') return 'done'
  return 'idle'
}

/**
 * Map any orchestration status to a tag tone.
 * @param status - the status.
 * @returns the tone.
 */
export function statusTone(status: string): TagTone {
  if (ONGOING.has(status)) return 'info'
  if (FAILED.has(status)) return 'danger'
  if (WAITING.has(status)) return 'warning'
  if (status === 'completed' || status === 'recovered' || status === 'success') return 'success'
  return 'neutral'
}

/**
 * Short local time for an ISO timestamp.
 * @param iso - ISO-8601 time.
 * @returns e.g. `14:03:12`, with the date when not today.
 */
export function shortTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const today = new Date().toDateString() === date.toDateString()
  return today ? date.toLocaleTimeString() : date.toLocaleString()
}

/**
 * Compact duration.
 * @param ms - milliseconds.
 * @returns e.g. `4m 12s`.
 */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * Compact token count.
 * @param tokens - token count.
 * @returns e.g. `12.4k`.
 */
export function tokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

/**
 * Group workflow tasks into dependency levels, so tasks in one level can run in parallel.
 * @param tasks - tasks with `dependsOn` ids.
 * @returns levels, first to run first; tasks in a cycle land in the last level.
 */
export function dependencyLevels<T extends { readonly id: string; readonly dependsOn: readonly string[] }>(tasks: readonly T[]): T[][] {
  const level = new Map<string, number>()
  const byId = new Map(tasks.map(task => [task.id, task]))
  const visit = (task: T, trail: Set<string>): number => {
    const known = level.get(task.id)
    if (known !== undefined) return known
    if (trail.has(task.id)) return tasks.length
    trail.add(task.id)
    const deps = task.dependsOn.map(id => byId.get(id)).filter(dep => dep !== undefined)
    const value = deps.length === 0 ? 0 : Math.max(...deps.map(dep => visit(dep, trail))) + 1
    trail.delete(task.id)
    level.set(task.id, Math.min(value, tasks.length))
    return Math.min(value, tasks.length)
  }
  for (const task of tasks) visit(task, new Set())
  const levels: T[][] = []
  for (const task of tasks) {
    const index = level.get(task.id) ?? 0
    const group = levels[index] ?? []
    group.push(task)
    levels[index] = group
  }
  return levels.filter(group => group.length > 0)
}
