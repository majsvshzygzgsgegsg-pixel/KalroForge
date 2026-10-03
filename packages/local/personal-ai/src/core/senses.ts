/**
 * Pure decision logic for the senses: "stuck" detection from focus and idle
 * time, daily routine learning from app activations, local clipboard
 * classification, and notification urgency routing. Nothing here touches the
 * OS, so every rule is unit tested.
 */

/** Seconds of no input on the same window before KairoForge offers help. */
export const STUCK_SECONDS = 45
const STUCK_COOLDOWN_MS = 10 * 60_000

const DEV_APPS = new RegExp(String.raw`^(?:code|visual studio code|cursor|xcode|terminal|iterm2?|warp|ghostty|alacritty|kitty|`
  + String.raw`webstorm|intellij idea|pycharm|sublime text|zed|nova|android studio)$`, 'i')
const ERRORISH = new RegExp(String.raw`\b(?:error|exception|failed|failure|traceback|panic|undefined|cannot|can't|unexpected|`
  + String.raw`warning|crash|stack ?trace|ts\d{4}|e\d{4})\b`, 'i')

/** One focus sample from the watcher. */
export interface FocusSample {
  readonly at: number
  readonly app?: string
  readonly title?: string
  readonly idle?: number
}

/** A stuck moment worth one proactive ping. */
export interface StuckMoment {
  readonly app: string
  readonly title?: string
  readonly seconds: number
  readonly errorish: boolean
}

/** Tracks focus and decides when to offer help, at most once per window per cooldown. */
export class StuckDetector {
  private readonly pinged = new Map<string, number>()

  /**
   * Feed one sample.
   * @param sample - focus and idle seconds.
   * @param threshold - idle seconds that count as stuck.
   * @returns a moment when the user should be offered help.
   */
  observe(sample: FocusSample, threshold = STUCK_SECONDS): StuckMoment | undefined {
    if (sample.app === undefined || sample.idle === undefined || !DEV_APPS.test(sample.app)) return undefined
    if (sample.idle < threshold) return undefined
    const key = `${sample.app}\u0000${sample.title ?? ''}`
    const last = this.pinged.get(key)
    if (last !== undefined && sample.at - last < STUCK_COOLDOWN_MS) return undefined
    this.pinged.set(key, sample.at)
    return {
      app: sample.app,
      ...sample.title === undefined ? {} : { title: sample.title },
      seconds: Math.round(sample.idle),
      errorish: sample.title !== undefined && ERRORISH.test(sample.title),
    }
  }
}

/**
 * The proactive offer for a stuck moment.
 * @param moment - detected moment.
 * @returns notice text.
 */
export function stuckMessage(moment: StuckMoment): string {
  const where = moment.title === undefined ? moment.app : `"${moment.title}" in ${moment.app}`
  const minutes = moment.seconds >= 90 ? `${Math.round(moment.seconds / 60)} minutes` : 'a minute'
  return moment.errorish
    ? `You've been stuck on ${where} for ${minutes}. Want me to spin up a sub-agent to debug it?`
    : `No typing on ${where} for ${minutes}. Stuck? I can spin up a sub-agent to dig in.`
}

/** One app activation. */
export interface AppActivation {
  readonly app: string
  readonly bundleId?: string
  readonly at: number
}

/** A learned daily habit. */
export interface Routine {
  readonly id: string
  readonly minute: number
  readonly apps: string[]
  readonly days: number
}

const ROUTINE_MIN_DAYS = 3
const ROUTINE_WINDOW_DAYS = 14
const ROUTINE_SPREAD_MINUTES = 20
const ROUTINE_MERGE_MINUTES = 10
const IGNORED_APPS = /^(?:finder|loginwindow|dock|systemuiserver|kairoforge|cursor|electron|notification center|control center|spotlight)$/i

function dayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function minuteOf(at: number): number {
  const date = new Date(at)
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * Format a minute of the day.
 * @param minute - 0..1439.
 * @returns "HH:MM".
 */
export function clock(minute: number): string {
  const safe = ((Math.round(minute) % 1440) + 1440) % 1440
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

/**
 * Learn routines: apps first opened at a similar time of day on several distinct days.
 * @param activations - recent activations.
 * @param now - current time.
 * @returns routines, earliest first.
 */
export function learnRoutines(activations: readonly AppActivation[], now = Date.now()): Routine[] {
  const since = now - ROUTINE_WINDOW_DAYS * 86_400_000
  const firsts = new Map<string, Map<string, number>>()
  for (const activation of activations) {
    if (activation.at < since || IGNORED_APPS.test(activation.app)) continue
    const byDay = firsts.get(activation.app) ?? new Map<string, number>()
    const day = dayKey(activation.at)
    const minute = minuteOf(activation.at)
    // Morning launches dominate "first open"; the hour-of-day bucket keeps an afternoon habit visible too.
    const key = `${day}@${Math.floor(minute / 60)}`
    if (!byDay.has(key)) byDay.set(key, minute)
    firsts.set(activation.app, byDay)
  }
  const habits: Array<{ app: string; minute: number; days: number }> = []
  for (const [app, byDay] of firsts) {
    const minutes = [...byDay.values()].toSorted((a, b) => a - b)
    let best: { minute: number; days: number } | undefined
    for (let start = 0; start < minutes.length; start++) {
      const first = minutes[start] ?? 0
      const cluster = minutes.filter(minute => minute >= first && minute <= first + ROUTINE_SPREAD_MINUTES)
      const days = new Set([...byDay].filter(([, minute]) => cluster.includes(minute)).map(([key]) => key.split('@')[0])).size
      if (days >= ROUTINE_MIN_DAYS && (best === undefined || days > best.days)) {
        best = { minute: cluster[Math.floor(cluster.length / 2)] ?? first, days }
      }
    }
    if (best !== undefined) habits.push({ app, ...best })
  }
  const routines: Routine[] = []
  for (const habit of habits.toSorted((a, b) => a.minute - b.minute)) {
    const near = routines.find(routine => Math.abs(routine.minute - habit.minute) <= ROUTINE_MERGE_MINUTES)
    if (near === undefined) {
      routines.push({ id: '', minute: habit.minute, apps: [habit.app], days: habit.days })
    } else {
      near.apps.push(habit.app)
    }
  }
  return routines.map(routine => ({ ...routine, id: `${clock(routine.minute)}:${routine.apps.toSorted().join('+')}` }))
}

/** What a copied block looks like. */
export interface ClipInsight {
  readonly kind: 'code' | 'error' | 'json' | 'url' | 'text'
  readonly language?: string
  readonly lines: number
  readonly summary: string
}

const LANGUAGES: ReadonlyArray<readonly [string, RegExp]> = [
  ['TypeScript', /\b(?:interface|type)\s+\w+\s*[={<]|:\s*(?:string|number|boolean)\b|\bimport\s+type\b/],
  ['React', /\buse(?:State|Effect|Memo|Callback|Ref)\s*\(|<\/?[A-Z]\w*[\s/>]/],
  ['JavaScript', /\b(?:const|let)\s+\w+\s*=|=>\s*[{(]|\bfunction\s+\w+\s*\(|require\(/],
  ['Python', /^\s*(?:def|class)\s+\w+.*:\s*$|^\s*(?:from\s+\w+\s+)?import\s+\w+|\bself\./m],
  ['Swift', /\b(?:func|guard let|if let|struct|@MainActor)\b.*\{|\bimport (?:SwiftUI|Foundation|UIKit)\b/],
  ['Rust', /\bfn\s+\w+\s*\(|\blet\s+mut\b|\bimpl\b|::new\(/],
  ['Go', /\bfunc\s+(?:\(\w+ \*?\w+\)\s*)?\w+\(|\bpackage\s+\w+|:=/],
  ['SQL', /\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE)\b/i],
  ['Shell', /^\s*(?:\$ |sudo |npm |pnpm |git |cd |brew |curl )/m],
  ['HTML', /<(?:div|span|html|body|head|script|a|p)\b[^>]*>/i],
  ['CSS', /^\s*[.#]?[\w-]+\s*\{[^}]*:[^}]*\}/m],
]

const ERROR_TEXT = /(?:^|\n)\s*(?:\w*Error|Exception|Traceback|panic:|error\[|ERR!|Uncaught|fatal:)|at\s+\S+\s+\(.+:\d+:\d+\)|\berror TS\d+/

/**
 * Classify copied text locally.
 * @param text - clipboard text (already screened for secrets).
 * @returns insight.
 */
export function classifyClip(text: string): ClipInsight {
  const trimmed = text.trim()
  const lines = trimmed === '' ? 0 : trimmed.split('\n').length
  const firstLine = trimmed.split('\n')[0]?.slice(0, 120) ?? ''
  if (/^https?:\/\/\S+$/.test(trimmed)) return { kind: 'url', lines, summary: `a link to ${trimmed.replace(/^https?:\/\//, '').split('/')[0] ?? ''}` }
  if (ERROR_TEXT.test(trimmed)) {
    const language = LANGUAGES.find(([, pattern]) => pattern.test(trimmed))?.[0]
    return { kind: 'error', ...language === undefined ? {} : { language }, lines, summary: `an error (${lines} lines): ${firstLine}` }
  }
  if (/^[[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed)
      return { kind: 'json', language: 'JSON', lines, summary: `JSON data (${lines} lines)` }
    } catch {
      // Not JSON; fall through to code detection.
    }
  }
  const language = LANGUAGES.find(([, pattern]) => pattern.test(trimmed))?.[0]
  if (language !== undefined && (lines > 1 || /[;{}()=]/.test(trimmed))) {
    return { kind: 'code', language, lines, summary: `${language} code (${lines} lines) starting "${firstLine}"` }
  }
  return { kind: 'text', lines, summary: `text (${trimmed.length} chars) starting "${firstLine.slice(0, 60)}"` }
}

const APP_NAMES: Readonly<Record<string, string>> = {
  'com.tinyspeck.slackmacgap': 'Slack', 'com.apple.MobileSMS': 'Messages', 'com.apple.mail': 'Mail', 'com.apple.iCal': 'Calendar',
  'com.microsoft.teams2': 'Teams', 'com.microsoft.teams': 'Teams', 'com.microsoft.Outlook': 'Outlook', 'net.whatsapp.WhatsApp': 'WhatsApp',
  'ru.keepcoder.Telegram': 'Telegram', 'com.hnc.Discord': 'Discord', 'com.apple.reminders': 'Reminders', 'com.google.Chrome': 'Chrome',
  'com.apple.Safari': 'Safari', 'com.apple.FaceTime': 'FaceTime', 'us.zoom.xos': 'Zoom', 'com.linear': 'Linear', 'notion.id': 'Notion',
}

/**
 * Friendly name for a notifying app.
 * @param identifier - bundle identifier or name.
 * @returns display name.
 */
export function appName(identifier: string): string {
  const known = APP_NAMES[identifier]
  if (known !== undefined) return known
  if (!identifier.includes('.')) return identifier
  const last = identifier.split('.').at(-1) ?? identifier
  return `${last.charAt(0).toUpperCase()}${last.slice(1)}`
}

/** One notification as macOS delivered it; `at` is in Unix seconds. */
export interface IncomingNotification {
  readonly at: number
  readonly app: string
  readonly title?: string
  readonly subtitle?: string
  readonly body?: string
}

/** Routing outcome. */
export type NotificationRoute = 'urgent' | 'normal' | 'silent'

/** Routing outcome with its reason. */
export interface NotificationDecision {
  readonly route: NotificationRoute
  readonly reason: string
}

/** Routing rules the user controls. */
export interface RoutingRules {
  readonly vips: readonly string[]
  readonly urgentWords: readonly string[]
  readonly mutedApps: readonly string[]
}

/** Defaults: obvious urgency words; no VIPs until the graph or user names them. */
export const DEFAULT_URGENT_WORDS = ['urgent', 'asap', 'emergency', 'outage', 'is down', 'production', 'call me', 'right now', 'immediately', 'blocker', 'p0', 'sev1']
const NOISE = /\b(?:meme|lol|lmao|haha|giphy|gif|sale|% off|promo|newsletter|digest|reacted|liked|joined the channel|left the channel)\b/i
const QUIET_CHANNEL = /#(?:general|random|memes?|fun|off-?topic|social|watercooler)\b/i

/**
 * Route one notification.
 * @param item - notification.
 * @param rules - user rules.
 * @returns route and the reason.
 */
export function routeNotification(item: IncomingNotification, rules: RoutingRules): NotificationDecision {
  const text = [item.title, item.subtitle, item.body].filter(Boolean).join(' \u2014 ')
  const lower = text.toLowerCase()
  if (rules.mutedApps.some(app => app.toLowerCase() === item.app.toLowerCase())) return { route: 'silent', reason: `${item.app} is muted` }
  const vip = rules.vips.find(name => name.trim() !== '' && lower.includes(name.toLowerCase()))
  const word = [...DEFAULT_URGENT_WORDS, ...rules.urgentWords].find(candidate => candidate.trim() !== '' && lower.includes(candidate.toLowerCase()))
  if (vip !== undefined && word !== undefined) return { route: 'urgent', reason: `${vip} says "${word}"` }
  if (word !== undefined && !NOISE.test(lower)) return { route: 'urgent', reason: `mentions "${word}"` }
  if (vip !== undefined) return { route: 'normal', reason: `from ${vip}` }
  if (NOISE.test(lower) || QUIET_CHANNEL.test(lower)) return { route: 'silent', reason: 'chatter' }
  return { route: 'normal', reason: 'ordinary' }
}

/**
 * One-line summary of a notification.
 * @param item - notification.
 * @returns summary under 200 characters.
 */
export function summarizeNotification(item: IncomingNotification): string {
  const head = [item.title, item.subtitle].filter(Boolean).join(' \u00b7 ')
  const body = (item.body ?? '').replace(/\s+/g, ' ').trim()
  const text = `${item.app}: ${head}${head !== '' && body !== '' ? ' \u2014 ' : ''}${body}`
  return text.length > 200 ? `${text.slice(0, 197)}...` : text
}
