/** Browser-local HUD preferences (visual quality only; nothing sensitive). */

const KEY = 'dsh.personal-ai.hud.v1'

/** HUD preferences. */
export interface HudPrefs {
  readonly performance: 'auto' | 'on' | 'off'
  readonly reducedMotion: boolean | 'auto'
  /** Show the compact state bar in chat headers. */
  readonly stateBar: boolean
}

const DEFAULTS: HudPrefs = { performance: 'auto', reducedMotion: 'auto', stateBar: true }

/**
 * Read the stored preferences.
 * @returns preferences with defaults filled in.
 */
export function readHudPrefs(): HudPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<HudPrefs>
    return {
      performance: parsed.performance === 'on' || parsed.performance === 'off' ? parsed.performance : 'auto',
      reducedMotion: typeof parsed.reducedMotion === 'boolean' ? parsed.reducedMotion : 'auto',
      stateBar: parsed.stateBar !== false,
    }
  } catch {
    // Unreadable storage falls back to defaults.
    return DEFAULTS
  }
}

/**
 * Store preferences and tell mounted views.
 * @param changes - fields to change.
 * @returns the new preferences.
 */
export function writeHudPrefs(changes: Partial<HudPrefs>): HudPrefs {
  const next = { ...readHudPrefs(), ...changes }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Private mode only loses the preference.
  }
  window.dispatchEvent(new Event('personal-ai:hud-prefs'))
  return next
}
