/**
 * Spoken progress for Command Center turns: what KairoForge says while it is
 * still working. Updates describe real events only, never a guess about how
 * close the work is to done.
 */
import type { ConverseUpdate } from '../types.ts'
import { categoryOf } from './capabilities.ts'
import { classifyRisk } from './risk.ts'

/** Updates kept per turn; a long tool loop must not grow the turn without bound. */
export const MAX_UPDATES = 20

/** Longest spoken narration line kept from the model. */
export const MAX_SAY_CHARS = 300

/**
 * The update for one tool that was allowed to run.
 * @param tool - tool name.
 * @param args - tool arguments, to tell reading from changing.
 * @returns a tool update.
 */
export function toolUpdate(tool: string, args: unknown): ConverseUpdate {
  return { kind: 'tool', category: categoryOf(tool) ?? 'OTHER', changes: classifyRisk(tool, args).risk !== 'LOW_RISK' }
}

/**
 * Whether a new update repeats the last one closely enough to stay silent
 * (the same kind of tool again, or the same words again).
 * @param last - the previous update, if any.
 * @param next - the candidate update.
 * @returns true to skip `next`.
 */
export function repeatsUpdate(last: ConverseUpdate | undefined, next: ConverseUpdate): boolean {
  if (last === undefined || last.kind !== next.kind) return false
  if (last.kind === 'tool' && next.kind === 'tool') return last.category === next.category && last.changes === next.changes
  if (last.kind === 'say' && next.kind === 'say') return last.text === next.text
  return true
}
