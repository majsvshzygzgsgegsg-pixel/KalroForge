/**
 * Per-Session loop detector. It observes completed tool calls and reports
 * patterns that indicate an agent is stuck: repeated reads of one file,
 * nearly identical edits, the same failing command, an alternating pair of
 * actions, the same error, and long stretches without progress.
 *
 * Exact identical repeats of one call are left to the bundled
 * `repeat-tool-reminder`; this detector catches the broader patterns that one
 * cannot. It never blocks a call: callers turn a detection into recovery
 * guidance for the next model request.
 */
import type { LoopKind } from './types.ts'

/** One completed tool call as seen by the detector. */
export interface ObservedCall {
  readonly name: string
  readonly args: unknown
  readonly ok: boolean
  /** Failure text (tool error or failing command output), when not ok. */
  readonly error?: string
}

/** One detection. */
export interface LoopDetection {
  readonly kind: LoopKind
  /** Stable key so one pattern is reported once until it changes. */
  readonly key: string
  readonly summary: string
  readonly attempts: readonly string[]
}

/** Detector thresholds. */
export interface LoopThresholds {
  readonly repeatedReads: number
  readonly similarEdits: number
  readonly failingCommand: number
  readonly sameError: number
  readonly alternatingCycles: number
  readonly noProgressSteps: number
  /** Calls after a detection with no recurrence that count as recovered. */
  readonly recoveryWindow: number
}

/** Defaults tuned to catch loops without flagging ordinary iteration. */
export const DEFAULT_THRESHOLDS: LoopThresholds = {
  repeatedReads: 4,
  similarEdits: 3,
  failingCommand: 3,
  sameError: 3,
  alternatingCycles: 3,
  noProgressSteps: 40,
  recoveryWindow: 12,
}

const READ_TOOLS = new Set(['read', 'read_image', 'read_file', 'view'])
const EDIT_TOOLS = new Set(['edit', 'write', 'str_replace', 'apply_patch'])
const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const HISTORY = 60

/** Recursively sort object keys so argument order never changes identity. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
}

function field(args: unknown, ...names: string[]): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string') return value
  }
  return undefined
}

/** Normalize error text: drop numbers, hex ids, paths' line:col, and whitespace runs. */
export function normalizeError(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/0x[0-9a-f]+|[0-9a-f]{12,}/g, '#')
    .replaceAll(/\d+/g, '#')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** Character-bigram Dice similarity in [0, 1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  let overlap = 0
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2)
    const count = grams.get(gram) ?? 0
    if (count > 0) {
      grams.set(gram, count - 1)
      overlap++
    }
  }
  return (2 * overlap) / (a.length + b.length - 2)
}

interface Entry {
  readonly call: ObservedCall
  /** Coarse action signature used for alternation (tool + target). */
  readonly action: string
  readonly label: string
}

/** Label one call for summaries without echoing large arguments. */
export function describeCall(call: ObservedCall): string {
  const target = field(call.args, 'path', 'file_path', 'file', 'command', 'pattern', 'query')
  const short = target === undefined ? '' : ` ${target.replaceAll(/\s+/g, ' ').slice(0, 100)}`
  return `${call.name}${short}${call.ok ? '' : ' (failed)'}`
}

/** One Session's detector state. */
export class LoopDetector {
  private readonly history: Entry[] = []
  private readonly reported = new Map<string, number>()
  private stepsSinceProgress = 0
  private readonly seenSuccesses = new Set<string>()
  private readonly pending: Array<{ readonly key: string; readonly at: number; resolve: (recurred: boolean) => void }> = []
  private calls = 0

  constructor(private readonly thresholds: LoopThresholds = DEFAULT_THRESHOLDS) {}

  /** Forget the pattern state, for example after a new user message. */
  reset(): void {
    this.history.length = 0
    this.reported.clear()
    this.stepsSinceProgress = 0
    this.seenSuccesses.clear()
  }

  /**
   * Register a recovery watcher for one detection.
   * @param key - detection key.
   * @param resolve - called once with true when the pattern recurs, false when it stays absent for the recovery window.
   */
  watch(key: string, resolve: (recurred: boolean) => void): void {
    this.pending.push({ key, at: this.calls, resolve })
  }

  /**
   * Record one completed call and report at most one new detection.
   * @param call - the completed call.
   * @returns the detection, or undefined.
   */
  observe(call: ObservedCall): LoopDetection | undefined {
    this.calls++
    const entry: Entry = { call, action: this.actionOf(call), label: describeCall(call) }
    this.history.push(entry)
    if (this.history.length > HISTORY) this.history.shift()
    this.trackProgress(call)

    const detection = this.repeatedRead() ?? this.similarEdit() ?? this.failingCommand()
      ?? this.sameError() ?? this.alternating() ?? this.noProgress()
    this.settleWatchers(detection?.key)
    if (detection === undefined) return undefined
    if (this.reported.has(detection.key)) {
      this.reported.set(detection.key, this.calls)
      return undefined
    }
    this.reported.set(detection.key, this.calls)
    return detection
  }

  private settleWatchers(recurringKey: string | undefined): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const watcher = this.pending[i]
      if (watcher === undefined) continue
      if (recurringKey === watcher.key && this.calls > watcher.at) {
        this.pending.splice(i, 1)
        watcher.resolve(true)
      } else if (this.calls - watcher.at >= this.thresholds.recoveryWindow) {
        this.pending.splice(i, 1)
        watcher.resolve(false)
      }
    }
  }

  private actionOf(call: ObservedCall): string {
    const target = field(call.args, 'path', 'file_path', 'command') ?? JSON.stringify(canonical(call.args)).slice(0, 200)
    return `${call.name}:${target}`
  }

  private trackProgress(call: ObservedCall): void {
    const signature = JSON.stringify([call.name, canonical(call.args)])
    const mutating = EDIT_TOOLS.has(call.name) || SHELL_TOOLS.has(call.name)
    if (call.ok && mutating && !this.seenSuccesses.has(signature)) {
      this.seenSuccesses.add(signature)
      this.stepsSinceProgress = 0
      return
    }
    this.stepsSinceProgress++
  }

  private recent(count: number): Entry[] {
    return this.history.slice(-count)
  }

  private repeatedRead(): LoopDetection | undefined {
    const last = this.history.at(-1)
    if (last === undefined || !READ_TOOLS.has(last.call.name)) return undefined
    const path = field(last.call.args, 'path', 'file_path', 'file')
    if (path === undefined) return undefined
    let reads = 0
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i]
      if (entry === undefined) break
      const entryPath = field(entry.call.args, 'path', 'file_path', 'file')
      if (EDIT_TOOLS.has(entry.call.name) && entryPath === path) break
      if (READ_TOOLS.has(entry.call.name) && entryPath === path) reads++
    }
    if (reads < this.thresholds.repeatedReads) return undefined
    return {
      kind: 'repeated-read',
      key: `repeated-read:${path}`,
      summary: `Read ${path} ${String(reads)} times without changing it.`,
      attempts: this.recent(6).map(entry => entry.label),
    }
  }

  private similarEdit(): LoopDetection | undefined {
    const last = this.history.at(-1)
    if (last === undefined || !EDIT_TOOLS.has(last.call.name)) return undefined
    const path = field(last.call.args, 'path', 'file_path', 'file')
    const body = field(last.call.args, 'new_string', 'newString', 'content', 'patch') ?? ''
    if (path === undefined) return undefined
    const edits = this.history.filter(entry => EDIT_TOOLS.has(entry.call.name) && field(entry.call.args, 'path', 'file_path', 'file') === path)
    const similar = edits.filter(entry => similarity(field(entry.call.args, 'new_string', 'newString', 'content', 'patch') ?? '', body) >= 0.9)
    if (similar.length < this.thresholds.similarEdits) return undefined
    return {
      kind: 'similar-edit',
      key: `similar-edit:${path}`,
      summary: `Made ${String(similar.length)} nearly identical edits to ${path}.`,
      attempts: similar.slice(-5).map(entry => entry.label),
    }
  }

  private failingCommand(): LoopDetection | undefined {
    const last = this.history.at(-1)
    if (last === undefined || last.call.ok || !SHELL_TOOLS.has(last.call.name)) return undefined
    const command = (field(last.call.args, 'command') ?? '').replaceAll(/\s+/g, ' ').trim()
    const failures = this.history.filter(entry => !entry.call.ok && SHELL_TOOLS.has(entry.call.name)
      && (field(entry.call.args, 'command') ?? '').replaceAll(/\s+/g, ' ').trim() === command)
    if (failures.length < this.thresholds.failingCommand) return undefined
    return {
      kind: 'failing-command',
      key: `failing-command:${command}`,
      summary: `Ran the same failing command ${String(failures.length)} times: ${command.slice(0, 120)}`,
      attempts: failures.slice(-5).map(entry => `${entry.label}: ${(entry.call.error ?? '').slice(0, 160)}`),
    }
  }

  private sameError(): LoopDetection | undefined {
    const last = this.history.at(-1)
    if (last === undefined || last.call.ok || last.call.error === undefined) return undefined
    const error = normalizeError(last.call.error)
    if (error === '') return undefined
    const matches = this.history
      .filter(entry => !entry.call.ok && entry.call.error !== undefined && normalizeError(entry.call.error) === error)
    const distinctActions = new Set(matches.map(entry => entry.action)).size
    // A single repeated command is `failing-command`; the same error across different actions is this pattern.
    if (matches.length < this.thresholds.sameError || distinctActions < 2) return undefined
    return {
      kind: 'same-error',
      key: `same-error:${error.slice(0, 120)}`,
      summary: `Hit the same error ${String(matches.length)} times across different attempts: ${(last.call.error).slice(0, 160)}`,
      attempts: matches.slice(-5).map(entry => entry.label),
    }
  }

  private alternating(): LoopDetection | undefined {
    const span = this.thresholds.alternatingCycles * 2
    const window = this.recent(span)
    if (window.length < span) return undefined
    const [a, b] = [window[0]?.action, window[1]?.action]
    if (a === undefined || b === undefined || a === b) return undefined
    const alternates = window.every((entry, index) => entry.action === (index % 2 === 0 ? a : b))
    if (!alternates) return undefined
    const pair = [a, b].toSorted().join(' <-> ')
    return {
      kind: 'alternating',
      key: `alternating:${pair}`,
      summary: `Alternated between the same two actions ${String(this.thresholds.alternatingCycles)} times.`,
      attempts: window.map(entry => entry.label),
    }
  }

  private noProgress(): LoopDetection | undefined {
    if (this.stepsSinceProgress < this.thresholds.noProgressSteps) return undefined
    const bucket = Math.floor(this.stepsSinceProgress / this.thresholds.noProgressSteps)
    return {
      kind: 'no-progress',
      key: `no-progress:${String(bucket)}`,
      summary: `${String(this.stepsSinceProgress)} tool calls without a new successful change or command.`,
      attempts: this.recent(8).map(entry => entry.label),
    }
  }
}

/**
 * Model-facing recovery protocol for one detection. It pauses the current
 * strategy instead of stopping the agent.
 * @param detection - the detected pattern.
 * @param canDelegate - whether the agent can spawn a diagnostic teammate.
 * @returns guidance text for the next request.
 */
export function recoveryGuidance(detection: LoopDetection, canDelegate: boolean): string {
  return [
    '<system-reminder>',
    `[KairoForge loop recovery] Possible loop detected (${detection.kind}): ${detection.summary}`,
    'Recent attempts:',
    ...detection.attempts.map(line => `- ${line}`),
    '',
    'Pause the current strategy before your next tool call and work through these steps:',
    '1. Summarize in two or three sentences what you have attempted so far.',
    '2. Name the failure that keeps repeating and the evidence for it.',
    '3. List the assumptions behind the current approach and say which one is most likely wrong.',
    canDelegate
      ? '4. If the cause is still unclear, delegate a focused diagnosis to a fresh teammate (spawn_teammate) with the evidence above, or ask another main agent for a review.'
      : '4. If the cause is still unclear, gather one new piece of evidence that you have not looked at yet.',
    '5. Write a different plan that does not repeat the failed steps.',
    '6. Continue with the new plan if it is safe; if it is not, explain the blocker to the user instead of retrying.',
    '</system-reminder>',
  ].join('\n')
}

/**
 * Build the stronger reminder injected when a pattern recurs after recovery guidance.
 * The agent keeps running; it is told to stop repeating the step and change course.
 * @param detection - the original detection.
 * @param canDelegate - whether the agent can spawn a diagnosis teammate.
 * @returns the reminder text.
 */
export function escalationGuidance(detection: LoopDetection, canDelegate: boolean): string {
  return [
    '<system-reminder>',
    `[KairoForge loop recovery — escalation] The pattern recurred after recovery guidance (${detection.kind}): ${detection.summary}`,
    'Another identical attempt will fail the same way, so do not repeat the failing step unless something material has changed.',
    canDelegate
      ? 'Next, either delegate a focused diagnosis to a fresh teammate (spawn_teammate) with the evidence, or stop and report to the user:'
      : 'Next, stop and report to the user:',
    'what you tried, the failure that keeps repeating, the assumption you now doubt, and what would unblock you',
    '(for example a credential, environment setting, or decision only the user can provide).',
    '</system-reminder>',
  ].join('\n')
}
