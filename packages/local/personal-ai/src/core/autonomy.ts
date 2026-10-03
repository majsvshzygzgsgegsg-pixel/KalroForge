/**
 * Pure rules for self-healing background work, Air-Gap mode, and tools that
 * KairoForge writes for itself.
 */
import { categoryOf } from './capabilities.ts'

/** Why a background task failed, as far as healing cares. */
export type FailureKind = 'rate-limit' | 'build' | 'cancelled' | 'other'

const RATE_LIMIT = /\b(?:429|rate[ -]?limit(?:ed)?|too many requests|quota|resource[_ ]exhausted|overloaded|retry after|503)\b/i
const BUILD = new RegExp(String.raw`\b(?:compil(?:e|ation)|build failed|tsc|typecheck|type error|error TS\d+|syntaxerror|`
  + String.raw`cannot find module|module not found|test(?:s)? failed|failing tests?|assertion|vitest|jest|pytest|cargo|exit code [1-9]|lint)\b`, 'i')
const CANCELLED = /\b(?:cancel(?:l)?ed|aborted|stopped by (?:the )?user)\b/i

/**
 * Classify a failed task's error text.
 * @param text - error or final report.
 * @returns failure kind.
 */
export function classifyFailure(text: string): FailureKind {
  if (CANCELLED.test(text)) return 'cancelled'
  if (RATE_LIMIT.test(text)) return 'rate-limit'
  if (BUILD.test(text)) return 'build'
  return 'other'
}

/** Healing limits. */
export const HEAL_LIMITS = { rateLimitRetries: 2, debugCycles: 1, backoffMs: [60_000, 180_000] } as const

/** What the healer should do with one failure. */
export type HealAction =
  | { readonly kind: 'retry'; readonly delayMs: number; readonly reason: string }
  | { readonly kind: 'debug'; readonly reason: string }
  | { readonly kind: 'give-up'; readonly reason: string }

/**
 * Decide the next healing step.
 * @param kind - failure kind.
 * @param history - healing already done for this lineage.
 * @param history.retries - rate-limit retries so far.
 * @param history.debugs - debugger cycles so far.
 * @param fromDebugger - whether the failed task was itself a debugger task.
 * @returns action.
 */
export function healAction(kind: FailureKind, history: { retries: number; debugs: number }, fromDebugger: boolean): HealAction {
  if (kind === 'cancelled') return { kind: 'give-up', reason: 'cancelled by the user' }
  if (kind === 'rate-limit') {
    if (history.retries >= HEAL_LIMITS.rateLimitRetries) return { kind: 'give-up', reason: `still rate limited after ${history.retries} retries` }
    return { kind: 'retry', delayMs: HEAL_LIMITS.backoffMs[history.retries] ?? 180_000, reason: 'rate limited; retrying after a pause' }
  }
  if (fromDebugger) return { kind: 'give-up', reason: 'the Debugger could not fix it' }
  if (history.debugs >= HEAL_LIMITS.debugCycles) return { kind: 'give-up', reason: 'already debugged once' }
  return { kind: 'debug', reason: kind === 'build' ? 'build or test failure' : 'task failed' }
}

/**
 * Prompt for a Debugger task.
 * @param task - the failed task.
 * @param task.title - title.
 * @param task.prompt - original prompt.
 * @param task.error - error text or final report.
 * @param task.agent - agent that ran it.
 * @returns debugger prompt.
 */
export function debuggerPrompt(task: { title: string; prompt: string; error: string; agent: string }): string {
  return [
    `A background task by ${task.agent} failed. Find the root cause and fix it so the task can be retried.`,
    `Task: ${task.title}`,
    'Original instructions:',
    task.prompt.slice(0, 4000),
    'Failure:',
    task.error.slice(-6000),
    'Reproduce the failure first (run the failing build or test), fix the code, and re-run it until it passes.',
    'Finish with "FIXED:" and what you changed, or "TASK FAILED:" and why it cannot be fixed. Never claim a fix you did not verify.',
  ].join('\n')
}

/** Providers that run on this machine. */
export const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'lm-studio', 'llamacpp', 'llama.cpp', 'local', 'mlx'])

/**
 * Whether a base URL points at this machine.
 * @param url - provider base URL.
 * @returns true for loopback hosts.
 */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (url === undefined || url === '') return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

const NETWORK_COMMAND = new RegExp([
  String.raw`\b(?:curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp)\b`,
  String.raw`\bgit\s+(?:push|pull|fetch|clone|ls-remote|submodule\s+update)\b`,
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|update|upgrade|publish|dlx)\b`, String.raw`\bnpx\b`,
  String.raw`\b(?:pip3?|uv|poetry|gem|cargo|go)\s+(?:install|add|get|publish)\b`, String.raw`\bbrew\s+(?:install|upgrade|update|tap)\b`,
  String.raw`\bgh\s+\w+`, String.raw`\b(?:open|xdg-open)\s+https?://`, String.raw`https?://(?!(?:localhost|127\.0\.0\.1)[:/])`,
].join('|'), 'i')

/**
 * Whether Air-Gap mode blocks a tool call (best effort for shell commands).
 * @param tool - tool name.
 * @param args - arguments.
 * @returns the reason it is blocked, or undefined when allowed.
 */
export function airGapBlock(tool: string, args: unknown): string | undefined {
  if (tool === 'web_search' || tool === 'web_fetch') return 'web access is off in Air-Gap mode'
  const category = categoryOf(tool)
  if (category === 'BROWSER') return 'the browser is off in Air-Gap mode'
  if (category === 'GITHUB') return 'GitHub is off in Air-Gap mode'
  if (tool === 'bash' || tool === 'pwsh' || tool === 'terminal_send') {
    const record = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
    const command = [record.command, record.text, record.input].find(value => typeof value === 'string')
    if (typeof command === 'string' && NETWORK_COMMAND.test(command)) return 'that command reaches the network, which Air-Gap mode blocks'
  }
  return undefined
}

/** Languages a self-written tool may use. */
export const USER_TOOL_LANGUAGES = ['python', 'node', 'bash'] as const

/** One self-written tool language. */
export type UserToolLanguage = typeof USER_TOOL_LANGUAGES[number]

/** Prefix that marks self-written tools in the toolbelt. */
export const USER_TOOL_PREFIX = 'user_tool__'

/**
 * Validate a self-written tool name.
 * @param name - proposed name.
 * @returns the error, or undefined when valid.
 */
export function userToolNameError(name: string): string | undefined {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(name)) return 'tool names are 2-40 lowercase letters, digits, or underscores, starting with a letter'
  return undefined
}

/**
 * Interpreter command for a language.
 * @param language - tool language.
 * @returns executable and file name.
 */
export function userToolRuntime(language: UserToolLanguage): { readonly command: string; readonly file: string } {
  if (language === 'python') return { command: 'python3', file: 'tool.py' }
  if (language === 'node') return { command: 'node', file: 'tool.mjs' }
  return { command: 'bash', file: 'tool.sh' }
}
