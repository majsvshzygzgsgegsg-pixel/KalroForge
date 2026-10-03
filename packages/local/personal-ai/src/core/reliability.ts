/**
 * Reliability rules for the agent loop: "did you mean" suggestions when the
 * model names a file that does not exist, a hard stop for runaway loops (the
 * repeat-tool-reminder only nudges), and a clearer message when the model's
 * tool arguments were not valid JSON.
 */

const MISSING_PATH = [
  /cannot [a-z]+ "([^"]+)": (?:not found|a parent path segment is not a directory|parent traversal crosses a missing directory)/,
  /The path (\S+) does not exist/,
  /ENOENT[^'"]*['"]([^'"]+)['"]/,
]

/**
 * The path a "not found" tool error is about.
 * @param message - tool error text.
 * @returns the missing path, or undefined when the error is something else.
 */
export function missingPathOf(message: string): string | undefined {
  for (const pattern of MISSING_PATH) {
    const path = pattern.exec(message)?.[1]
    if (path !== undefined && path !== '') return path.replace(/[.,;:]$/, '')
  }
  return undefined
}

/**
 * Edit distance between two short strings.
 * @param a - first string.
 * @param b - second string.
 * @returns the Levenshtein distance.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost))
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

function baseOf(path: string): string {
  return path.split('/').pop() ?? path
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '').toLowerCase()
}

/**
 * Existing files the model most likely meant.
 * @param target - the missing path as the model wrote it (relative or absolute).
 * @param candidates - existing workspace-relative file paths.
 * @param limit - maximum suggestions.
 * @returns best matches, best first; empty when nothing is close.
 */
export function suggestPaths(target: string, candidates: readonly string[], limit = 3): string[] {
  const wantedBase = baseOf(target).toLowerCase()
  const wantedStem = stem(wantedBase)
  const wantedDirs = target.toLowerCase().split('/').slice(0, -1).filter(part => part !== '' && part !== '.')
  const scored: Array<{ path: string; score: number }> = []
  for (const path of candidates) {
    const base = baseOf(path).toLowerCase()
    let score: number
    if (base === wantedBase) score = 10
    else if (stem(base) === wantedStem) score = 7
    else {
      const distance = levenshtein(stem(base), wantedStem)
      const allowed = Math.max(1, Math.floor(wantedStem.length / 4))
      if (distance > allowed) continue
      score = 6 - distance
    }
    const dirs = path.toLowerCase().split('/').slice(0, -1)
    score += wantedDirs.filter(dir => dirs.includes(dir)).length
    if (target.toLowerCase().endsWith(path.toLowerCase())) score += 5
    scored.push({ path, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, limit).map(entry => entry.path)
}

/**
 * Deep key-sorted JSON so argument objects compare by value.
 * @param value - parsed tool arguments.
 * @returns a canonical string.
 */
export function canonicalArgs(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort)
    if (input !== null && typeof input === 'object') {
      const record = input as Record<string, unknown>
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, sort(record[key])]))
    }
    return input
  }
  return JSON.stringify(sort(value) ?? null)
}

/** When the loop breaker steps in. */
export const LOOP_LIMITS = {
  /** The same call with identical arguments, back to back (the reminder already nudged at 3, 5, 8). */
  identical: 10,
  /** The same call failing with the same error, back to back. */
  failing: 5,
} as const

/** Tools that legitimately repeat while waiting on something. */
const POLLING_TOOL = /(?:^|_)(?:wait|sleep|poll|status|output|logs?|read_terminal|terminal_read|job_output)(?:_|$)/

interface Streak {
  signature: string
  count: number
  failure?: string
  failures: number
}

/**
 * Hard stop for runaway loops. Counts per agent session; a different call or
 * a new user message resets the streak.
 */
export class LoopBreaker {
  private readonly streaks = new Map<string, Streak>()

  /**
   * Whether a pending call must be refused.
   * @param key - agent session id.
   * @param tool - tool name.
   * @param args - parsed arguments.
   * @returns the refusal reason, or undefined to let it run.
   */
  check(key: string, tool: string, args: unknown): string | undefined {
    if (POLLING_TOOL.test(tool)) return undefined
    const streak = this.streaks.get(key)
    if (streak?.signature !== `${tool}\u0000${canonicalArgs(args)}`) return undefined
    if (streak.failures >= LOOP_LIMITS.failing) {
      return `Stopped: ${tool} has failed ${String(streak.failures)} times in a row with the same arguments and the same error (${streak.failure ?? 'unknown'}). `
        + 'Running it again will fail again. Read the error, change the input or approach, or tell the user what is blocking you.'
    }
    if (streak.count >= LOOP_LIMITS.identical) {
      return `Stopped: you have called ${tool} with identical arguments ${String(streak.count)} times in a row. `
        + 'The result will not change. Use what you already have, try a different action, or finish and report to the user.'
    }
    return undefined
  }

  /**
   * Record a finished call.
   * @param key - agent session id.
   * @param tool - tool name.
   * @param args - parsed arguments.
   * @param error - the error message when the call failed.
   */
  record(key: string, tool: string, args: unknown, error?: string): void {
    const signature = `${tool}\u0000${canonicalArgs(args)}`
    const streak = this.streaks.get(key)
    if (streak?.signature !== signature) {
      const fresh: Streak = { signature, count: 1, failures: error === undefined ? 0 : 1 }
      if (error !== undefined) fresh.failure = error.slice(0, 160)
      this.streaks.set(key, fresh)
      return
    }
    streak.count++
    if (error === undefined) {
      streak.failures = 0
      delete streak.failure
    } else if (streak.failure === error.slice(0, 160)) {
      streak.failures++
    } else {
      streak.failure = error.slice(0, 160)
      streak.failures = 1
    }
  }

  /**
   * Forget an agent's streak (new user message or session closed).
   * @param key - agent session id.
   */
  reset(key: string): void {
    this.streaks.delete(key)
  }
}

/**
 * A clearer error when the model's tool arguments were not valid JSON.
 * @param args - the arguments as received (a raw string means JSON.parse failed).
 * @returns guidance to append, or undefined.
 */
export function malformedArgsHint(args: unknown): string | undefined {
  if (typeof args !== 'string') return undefined
  const trimmed = args.trim()
  let detail = 'it is not a JSON object'
  try {
    JSON.parse(trimmed)
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error)
  }
  return `Your tool arguments were not valid JSON (${detail}). Send one JSON object with every string properly quoted and escaped `
    + '(newlines as \\n, quotes as \\"), no trailing commas, and nothing before or after the object.'
}
