/** Small display helpers for the Command Center. */

/**
 * Short relative time ("12s ago", "5m ago", "3h ago", or a date).
 * @param iso - ISO time.
 * @param now - current time in ms.
 * @returns display text.
 */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(seconds)) return iso
  if (seconds < 60) return `${String(seconds)}s ago`
  if (seconds < 3600) return `${String(Math.round(seconds / 60))}m ago`
  if (seconds < 86_400) return `${String(Math.round(seconds / 3600))}h ago`
  return new Date(iso).toLocaleDateString()
}

/**
 * Compact duration ("850 ms", "4.2 s", "3.1 min").
 * @param ms - milliseconds.
 * @returns display text.
 */
export function duration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}

/**
 * Error text of any thrown value.
 * @param error - thrown value.
 * @returns message.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
