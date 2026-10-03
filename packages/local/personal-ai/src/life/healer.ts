/**
 * Self-healing background work. When a main agent's background task fails,
 * the healer either re-queues it after a pause (rate limits, quota, overload)
 * or hands the error log to a Debugger main agent in the same workspace; when
 * the Debugger reports a fix, the original task is queued again. Every step
 * is an ordinary background task under the agents' own permission presets,
 * the Debugger never gets administration or full access, and each lineage is
 * bounded (two retries, one debug cycle) so nothing loops forever.
 */
import { basename } from 'node:path'
import type { Orchestration } from '@local/main-agents'
import { classifyFailure, debuggerPrompt, healAction } from '../core/autonomy.ts'
import type { Vault } from '../vault.ts'

type Task = Orchestration.BackgroundTaskRecord

const POLL_MS = 15_000
const LOG_LIMIT = 200
const HANDLED_LIMIT = 2000
const ACTOR = { sessionId: 'user', name: 'KairoForge self-healing' } as const
const FAILED_REPORT = /^\s*TASK FAILED:/i

/** One healing step. */
export interface HealRecord {
  /** The follow-up task this step created. */
  readonly id: string
  /** The task that started the lineage. */
  readonly origin: string
  /** The task whose outcome triggered this step. */
  readonly trigger: string
  readonly kind: 'retry' | 'debug' | 'retry-after-fix'
  readonly retries: number
  readonly debugs: number
  readonly at: string
  readonly note: string
}

/** Persisted healer state. */
interface HealState {
  readonly log: HealRecord[]
  readonly handled: string[]
}

/** What the healer needs from KairoForge. */
export interface HealerHost {
  readonly vault: Vault
  enabled(): boolean
  tasks(): Task[]
  createTask(input: { agentId: string; title: string; prompt: string }, actor: typeof ACTOR): Promise<Task>
  agent(id: string): Promise<{ readonly id: string; readonly name: string; readonly workspace?: string } | undefined>
  debugger(workspace: string | undefined): Promise<{ readonly id: string; readonly name: string }>
  notify(level: 'info' | 'success' | 'warning', text: string): void
  warn(text: string): void
}

/** Background-task healer. */
export class Healer {
  private log: HealRecord[] = []
  private readonly handled = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private loaded: Promise<void> | undefined
  private busy = false
  private readonly pendingRetries = new Set<ReturnType<typeof setTimeout>>()

  /**
   * @param host - KairoForge callbacks.
   */
  constructor(private readonly host: HealerHost) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const state = await this.host.vault.get<HealState>('heal-state').catch(() => undefined)
      if (state === undefined) {
        // First run: failures from before healing existed are history, not work.
        for (const task of this.host.tasks()) if (task.status === 'failed') this.handled.add(task.id)
        await this.save()
        return
      }
      this.log = state.log
      for (const id of state.handled) this.handled.add(id)
    })()
    return this.loaded
  }

  private async save(): Promise<void> {
    const handled = [...this.handled].slice(-HANDLED_LIMIT)
    await this.host.vault.put('heal-state', { log: this.log.slice(-LOG_LIMIT), handled } satisfies HealState).catch((error: unknown) => {
      this.host.warn(`healer: state not saved: ${String(error)}`)
    })
  }

  /** Start polling. */
  start(): void {
    this.timer ??= setInterval(() => { void this.poll() }, POLL_MS)
  }

  /** Recent healing steps, newest first. */
  history(): HealRecord[] {
    return this.log.toReversed().slice(0, 50)
  }

  /**
   * Check background tasks once.
   * @returns once handled.
   */
  async poll(): Promise<void> {
    if (this.busy || !this.host.enabled()) return
    this.busy = true
    try {
      await this.load()
      for (const task of this.host.tasks()) {
        if (this.handled.has(task.id)) continue
        const step = this.log.find(record => record.id === task.id)
        if (task.status === 'failed') {
          this.handled.add(task.id)
          await this.heal(task, step)
          await this.save()
        } else if (task.status === 'completed' && step?.kind === 'debug') {
          this.handled.add(task.id)
          await this.afterDebug(task, step)
          await this.save()
        } else if ((task.status === 'completed' || task.status === 'cancelled') && step !== undefined) {
          this.handled.add(task.id)
          if (task.status === 'completed') this.host.notify('success', `Self-healing worked: "${task.title}" finished after ${step.kind === 'retry' ? 'a retry' : 'the Debugger\'s fix'}.`)
          await this.save()
        }
      }
    } catch (error) {
      this.host.warn(`healer: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busy = false
    }
  }

  private async heal(task: Task, step: HealRecord | undefined): Promise<void> {
    const errorText = `${task.error ?? ''}\n${task.result ?? ''}`.trim()
    const kind = classifyFailure(errorText)
    const history = { retries: step?.retries ?? 0, debugs: step?.debugs ?? 0 }
    const action = healAction(kind, history, step?.kind === 'debug')
    const origin = step?.origin ?? task.id
    const agent = await this.host.agent(task.agentId)
    const agentName = agent?.name ?? task.agentId
    if (action.kind === 'give-up') {
      if (kind !== 'cancelled') this.host.notify('warning', `"${task.title}" failed and self-healing stopped: ${action.reason}.`)
      return
    }
    if (action.kind === 'retry') {
      this.host.notify('info', `"${task.title}" hit a rate limit; retrying in ${Math.round(action.delayMs / 60_000)} min.`)
      const timer = setTimeout(() => {
        this.pendingRetries.delete(timer)
        void this.createStep(origin, task, 'retry', { agentId: task.agentId, title: task.title, prompt: task.prompt }, {
          retries: history.retries + 1, debugs: history.debugs, note: action.reason,
        })
      }, action.delayMs)
      this.pendingRetries.add(timer)
      return
    }
    const fixer = await this.host.debugger(agent?.workspace)
    const prompt = debuggerPrompt({ title: task.title, prompt: task.prompt, error: errorText || 'no error text was recorded', agent: agentName })
    await this.createStep(origin, task, 'debug', { agentId: fixer.id, title: `Debug: ${task.title}`.slice(0, 120), prompt }, {
      retries: history.retries, debugs: history.debugs + 1, note: `${action.reason}; ${fixer.name} is on it`,
    })
    this.host.notify('info', `"${task.title}" failed (${action.reason}). ${fixer.name} is debugging it; the task retries once it is fixed.`)
  }

  private async afterDebug(task: Task, step: HealRecord): Promise<void> {
    const report = task.result ?? ''
    if (FAILED_REPORT.test(report)) {
      this.host.notify('warning', `The Debugger could not fix "${task.title.replace(/^Debug: /, '')}". Its report is in the task.`)
      return
    }
    const original = this.host.tasks().find(item => item.id === step.trigger)
    if (original === undefined) return
    await this.createStep(step.origin, task, 'retry-after-fix', { agentId: original.agentId, title: original.title, prompt: original.prompt }, {
      retries: step.retries, debugs: step.debugs, note: 'the Debugger reported a fix',
    })
  }

  private async createStep(
    origin: string,
    trigger: Task,
    kind: HealRecord['kind'],
    input: { agentId: string; title: string; prompt: string },
    counts: { retries: number; debugs: number; note: string },
  ): Promise<void> {
    try {
      const created = await this.host.createTask(input, ACTOR)
      this.log.push({
        id: created.id, origin, trigger: trigger.id, kind,
        retries: counts.retries, debugs: counts.debugs, at: new Date().toISOString(), note: counts.note,
      })
      await this.save()
    } catch (error) {
      this.host.notify('warning', `Self-healing could not queue the ${kind} for "${trigger.title}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Stop polling and pending retries. */
  dispose(): void {
    clearInterval(this.timer)
    for (const timer of this.pendingRetries) clearTimeout(timer)
    this.pendingRetries.clear()
  }
}

/**
 * Name of the Debugger main agent for a workspace.
 * @param workspace - workspace folder, if any.
 * @returns agent name.
 */
export function debuggerName(workspace: string | undefined): string {
  return workspace === undefined ? 'Debugger' : `Debugger ${basename(workspace)}`.slice(0, 60)
}
