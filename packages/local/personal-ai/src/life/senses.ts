/**
 * The nervous system: what KairoForge notices on this Mac, each sense behind
 * its own opt-in switch. Focus watching powers stuck detection and routine
 * learning; clipboard awareness classifies copied text locally and keeps it in
 * memory only (secrets are dropped on sight); the notification router reads
 * delivered macOS notifications, decides urgency locally, and speaks up only
 * for urgent ones. Nothing here sends data off the machine.
 */
import { execFile } from 'node:child_process'
import { findSensitive } from '../core/sensitive.ts'
import {
  appName, classifyClip, clock, learnRoutines, routeNotification, StuckDetector, stuckMessage, summarizeNotification,
  type AppActivation, type ClipInsight, type IncomingNotification, type NotificationRoute, type Routine, type RoutingRules,
} from '../core/senses.ts'
import type { NativeHelper, WatchSample } from '../native.ts'
import type { Vault } from '../vault.ts'

const WATCH_INTERVAL_SECONDS = 5
const NOTIFICATION_POLL_MS = 10_000
const ROUTINE_TICK_MS = 30_000
const ACTIVITY_LIMIT = 6000
const ACTIVITY_DAYS = 21
const NOTIFICATION_LOG_LIMIT = 300
const CLIP_FRESH_MS = 20 * 60_000
const CLIP_CONTEXT_CHARS = 4000
const OFFER_FRESH_MS = 10 * 60_000
const RESTART_DELAY_MS = 15_000

/** Which senses are on. */
export interface SenseSwitches {
  readonly focus: boolean
  readonly clipboard: boolean
  readonly notifications: boolean
  readonly stuckSeconds: number
  readonly approvedRoutines: readonly string[]
}

/** One routed notification as logged. */
export interface RoutedNotification extends IncomingNotification {
  readonly route: NotificationRoute
  readonly reason: string
  readonly summary: string
}

/** What a sense reports to the user. */
export interface SenseNotice {
  readonly level: 'info' | 'success' | 'warning'
  readonly kind: string
  readonly text: string
}

/** Senses status for the Command Center. */
export interface SensesStatus {
  readonly supported: boolean
  readonly watching: boolean
  readonly front?: { readonly app?: string; readonly title?: string; readonly idle?: number }
  readonly clip?: { readonly insight: ClipInsight; readonly at: string }
  readonly clipsIgnored: number
  readonly routines: readonly Routine[]
  readonly approvedRoutines: readonly string[]
  readonly notifications: { readonly enabled: boolean; readonly error?: string; readonly recent: readonly RoutedNotification[] }
  readonly offer?: { readonly text: string; readonly at: string }
  readonly error?: string
}

/** Dependencies the senses need from the service. */
export interface SensesHost {
  readonly native: NativeHelper
  readonly vault: Vault
  switches(): SenseSwitches
  rules(): RoutingRules
  notify(notice: SenseNotice): void
  warn(text: string): void
}

/** The senses. */
export class Senses {
  private stopWatch: (() => void) | undefined
  private watchStarting = false
  private watchClipboard = false
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private notificationTimer: ReturnType<typeof setInterval> | undefined
  private routineTimer: ReturnType<typeof setInterval> | undefined
  private readonly stuck = new StuckDetector()
  private front: WatchSample | undefined
  private activations: AppActivation[] = []
  private activityDirty = false
  private routines: Routine[] = []
  private readonly firedToday = new Map<string, string>()
  private clip: { insight: ClipInsight; text: string; at: number } | undefined
  private clipsIgnored = 0
  private notificationsSince = 0
  private notificationError: string | undefined
  private notificationLog: RoutedNotification[] = []
  private offer: { text: string; at: number } | undefined
  private error: string | undefined
  private loaded: Promise<void> | undefined
  private disposed = false

  /**
   * @param host - service callbacks.
   */
  constructor(private readonly host: SensesHost) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.activations = await this.host.vault.get<AppActivation[]>('activity') ?? []
        this.notificationLog = await this.host.vault.get<RoutedNotification[]>('notification-log') ?? []
        this.routines = learnRoutines(this.activations)
      } catch (error) {
        this.error = `could not read activity: ${error instanceof Error ? error.message : String(error)}`
      }
    })()
    return this.loaded
  }

  /** Start or stop each sense to match the switches. */
  async sync(): Promise<void> {
    if (this.disposed) return
    await this.load()
    const switches = this.host.switches()
    const wantWatch = this.host.native.supported() && (switches.focus || switches.clipboard)
    if (!wantWatch && this.stopWatch !== undefined) {
      this.stopWatch()
      this.stopWatch = undefined
      this.front = undefined
    }
    if (wantWatch && this.stopWatch !== undefined && this.watchClipboard !== switches.clipboard) {
      this.stopWatch()
      this.stopWatch = undefined
    }
    if (wantWatch && this.stopWatch === undefined) await this.startWatch(switches.clipboard)
    if (!switches.clipboard) this.clip = undefined

    if (switches.notifications && this.host.native.supported() && this.notificationTimer === undefined) {
      this.notificationsSince = Date.now() / 1000
      this.notificationTimer = setInterval(() => { void this.pollNotifications() }, NOTIFICATION_POLL_MS)
    } else if (!switches.notifications && this.notificationTimer !== undefined) {
      clearInterval(this.notificationTimer)
      this.notificationTimer = undefined
    }

    if (this.routineTimer === undefined) this.routineTimer = setInterval(() => { void this.tick() }, ROUTINE_TICK_MS)
  }

  private async startWatch(clipboard: boolean): Promise<void> {
    if (this.watchStarting) return
    this.watchStarting = true
    try {
      this.watchClipboard = clipboard
      this.stopWatch = await this.host.native.watch(WATCH_INTERVAL_SECONDS, clipboard, (sample) => { this.observe(sample) }, (reason) => {
        this.stopWatch = undefined
        this.error = `the watcher stopped: ${reason}`
        clearTimeout(this.restartTimer)
        this.restartTimer = setTimeout(() => { void this.sync() }, RESTART_DELAY_MS)
      })
      this.error = undefined
    } catch (error) {
      this.error = `the watcher could not start: ${error instanceof Error ? error.message : String(error)}`
      this.host.warn(this.error)
    } finally {
      this.watchStarting = false
    }
  }

  private observe(sample: WatchSample): void {
    const switches = this.host.switches()
    const now = Date.now()
    if (sample.app !== undefined && sample.app !== this.front?.app && switches.focus) {
      this.activations.push({ app: sample.app, ...sample.bundleId === undefined ? {} : { bundleId: sample.bundleId }, at: now })
      if (this.activations.length > ACTIVITY_LIMIT) this.activations.splice(0, this.activations.length - ACTIVITY_LIMIT)
      this.activityDirty = true
    }
    this.front = sample
    if (switches.focus) {
      const moment = this.stuck.observe({ at: now, ...sample }, switches.stuckSeconds)
      if (moment !== undefined) {
        const text = stuckMessage(moment)
        this.offer = { text, at: now }
        this.host.notify({ level: 'warning', kind: 'stuck', text })
      }
    }
    if (switches.clipboard && sample.clipboard !== undefined && sample.clipboard.trim() !== '') {
      if (findSensitive(sample.clipboard).sensitive) {
        this.clip = undefined
        this.clipsIgnored++
      } else {
        this.clip = { insight: classifyClip(sample.clipboard), text: sample.clipboard.slice(0, CLIP_CONTEXT_CHARS), at: now }
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.activityDirty) {
      this.activityDirty = false
      const since = Date.now() - ACTIVITY_DAYS * 86_400_000
      this.activations = this.activations.filter(item => item.at >= since)
      this.routines = learnRoutines(this.activations)
      await this.host.vault.put('activity', this.activations).catch((error: unknown) => {
        this.host.warn(`senses: activity not saved: ${String(error)}`)
      })
    }
    const approved = new Set(this.host.switches().approvedRoutines)
    const now = new Date()
    const minute = now.getHours() * 60 + now.getMinutes()
    const today = now.toDateString()
    for (const routine of this.routines) {
      if (!approved.has(routine.id) || this.firedToday.get(routine.id) === today) continue
      const lead = (routine.minute - minute + 1440) % 1440
      if (lead > 1) continue
      this.firedToday.set(routine.id, today)
      const opened = await Promise.all(routine.apps.map(app => openApp(app).then(() => app, () => undefined)))
      const ready = opened.filter((app): app is string => app !== undefined)
      this.host.notify({
        level: ready.length > 0 ? 'success' : 'warning',
        kind: 'routine',
        text: ready.length > 0
          ? `Your ${clock(routine.minute)} routine is ready: ${ready.join(', ')}.`
          : `Your ${clock(routine.minute)} routine could not open ${routine.apps.join(', ')}.`,
      })
    }
  }

  private async pollNotifications(): Promise<void> {
    try {
      const since = this.notificationsSince
      const { notifications } = await this.host.native.call<{ notifications: IncomingNotification[] }>(['notifications', String(since)])
      this.notificationError = undefined
      for (const item of notifications) {
        this.notificationsSince = Math.max(this.notificationsSince, item.at + 0.001)
        await this.ingest({ ...item, app: appName(item.app) })
      }
    } catch (error) {
      this.notificationError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Route one notification (from macOS, or posted by the phone or a Shortcut).
   * @param item - notification.
   * @returns the routing decision.
   */
  async ingest(item: IncomingNotification): Promise<RoutedNotification> {
    await this.load()
    const decision = routeNotification(item, this.host.rules())
    const sensitive = findSensitive([item.title, item.subtitle, item.body].filter(Boolean).join(' ')).sensitive
    const summary = sensitive ? `${item.app}: (a notification that looks like it contains a code or secret)` : summarizeNotification(item)
    const title = sensitive || item.title === undefined ? {} : { title: item.title }
    const text = sensitive || item.body === undefined ? {} : { body: item.body.slice(0, 500) }
    const routed: RoutedNotification = {
      at: item.at, app: item.app, route: decision.route, reason: decision.reason, summary, ...title, ...text,
    }
    this.notificationLog.push(routed)
    const excess = this.notificationLog.length - NOTIFICATION_LOG_LIMIT
    if (excess > 0) this.notificationLog.splice(0, excess)
    void this.host.vault.put('notification-log', this.notificationLog).catch(() => {})
    if (decision.route === 'urgent') this.host.notify({ level: 'warning', kind: 'urgent', text: `Urgent \u2014 ${summary} (${decision.reason})` })
    else if (decision.route === 'normal') this.host.notify({ level: 'info', kind: 'notification', text: summary })
    return routed
  }

  /**
   * Prompt context for one request: a fresh proactive offer and the clipboard.
   * @param request - the user's message.
   * @returns context lines.
   */
  contextFor(request: string): string[] {
    const lines: string[] = []
    const now = Date.now()
    if (this.offer !== undefined && now - this.offer.at < OFFER_FRESH_MS) {
      lines.push(`You recently offered proactively: "${this.offer.text}" If the user says yes, start a debugging main agent or background task on it.`)
    }
    if (this.clip !== undefined && now - this.clip.at < CLIP_FRESH_MS && this.host.switches().clipboard) {
      const minutes = Math.max(1, Math.round((now - this.clip.at) / 60_000))
      const head = this.clip.text.trim().slice(0, 40)
      const referenced = /\b(?:clipboard|copied|paste[d]?|this (?:code|error|snippet|log|stack ?trace|text))\b/i.test(request)
        || (head.length >= 12 && request.includes(head))
      lines.push(`Clipboard awareness: the user copied ${this.clip.insight.summary} ${minutes} min ago.`)
      if (referenced) lines.push('Copied text:', '```', this.clip.text, '```')
    }
    return lines
  }

  /** Senses status. */
  status(): SensesStatus {
    const switches = this.host.switches()
    return {
      supported: this.host.native.supported(),
      watching: this.stopWatch !== undefined,
      ...this.front === undefined ? {} : {
        front: {
          ...this.front.app === undefined ? {} : { app: this.front.app },
          ...this.front.title === undefined ? {} : { title: this.front.title },
          ...this.front.idle === undefined ? {} : { idle: Math.round(this.front.idle) },
        },
      },
      ...this.clip === undefined ? {} : { clip: { insight: this.clip.insight, at: new Date(this.clip.at).toISOString() } },
      clipsIgnored: this.clipsIgnored,
      routines: this.routines,
      approvedRoutines: switches.approvedRoutines,
      notifications: {
        enabled: this.notificationTimer !== undefined,
        ...this.notificationError === undefined ? {} : { error: this.notificationError },
        recent: this.notificationLog.toReversed().slice(0, 40),
      },
      ...this.offer === undefined ? {} : { offer: { text: this.offer.text, at: new Date(this.offer.at).toISOString() } },
      ...this.error === undefined ? {} : { error: this.error },
    }
  }

  /** Stop every sense and save activity. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.stopWatch?.()
    clearTimeout(this.restartTimer)
    clearInterval(this.notificationTimer)
    clearInterval(this.routineTimer)
    if (this.activityDirty) await this.host.vault.put('activity', this.activations).catch(() => {})
  }
}

function openApp(app: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-a', app], { timeout: 15_000 }, (error) => {
      if (error === null) resolve()
      else reject(new Error(error.message))
    })
  })
}
