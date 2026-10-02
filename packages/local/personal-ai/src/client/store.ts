/**
 * Live assistant store shared by the HUD, the header state bar, and the
 * Command Center: polls `/personal-ai/state` over the existing web connection
 * while anything watches it, follows the voice provider, reports voice-phase
 * changes to the Host, and queues proactive notifications.
 */
import { api, type Notice, type StateView, type VoicePhase } from './api.ts'
import type { CallSnapshot, VoiceProvider } from './voice.ts'

/** Polling cadence while the page is visible and hidden. */
const VISIBLE_MS = 700
const HIDDEN_MS = 4000
const NOTICE_MS = 4000
const MAX_TOASTS = 4
const ANSWER_POLL_MS = 600
/** Long enough for a turn that waits on an approval; the conversation keeps going after this. */
const ANSWER_TIMEOUT_MS = 15 * 60_000

/** Everything the live surfaces render. */
export interface LiveSnapshot {
  readonly state?: StateView
  readonly error?: string | undefined
  readonly voice: CallSnapshot | null
  readonly voiceAvailable: boolean
  readonly toasts: readonly Notice[]
  /** The latest Command Center exchange (spoken or typed). */
  readonly exchange?: Exchange
}

/** One question to KairoForge from the Command Center and its answer. */
export interface Exchange {
  readonly question: string
  readonly pending: boolean
  readonly reply?: string
  readonly error?: string
  readonly sessionId?: string
}

/** Observable snapshot in the shape slot hooks consume. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The live store. */
export interface LiveStore {
  readonly live: Observable<LiveSnapshot>
  /** Install or remove the voice provider. */
  setProvider(provider: VoiceProvider | undefined): () => void
  provider(): VoiceProvider | undefined
  /**
   * Ask KairoForge in the conversation Session and wait for the answer.
   * @returns the reply text (empty when the turn answered only with work).
   */
  ask(text: string): Promise<string>
  /** Start a voice call whose turns go to {@link ask}; false when voice is unavailable. */
  talk(): boolean
  /** Refresh now (after a user action). */
  refresh(): Promise<void>
  dismissToast(id: string): void
  dispose(): void
}

/**
 * Create the live store.
 * @returns the store.
 */
export function createLiveStore(): LiveStore {
  let snapshot: LiveSnapshot = { voice: null, voiceAvailable: false, toasts: [] }
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let noticeTimer: ReturnType<typeof setInterval> | undefined
  let provider: VoiceProvider | undefined
  let reportedPhase: VoicePhase = 'off'
  let lastNoticeAt: string | undefined
  let disposed = false

  const publish = (changes: Partial<LiveSnapshot>): void => {
    snapshot = { ...snapshot, ...changes }
    for (const listener of listeners) listener()
  }

  const poll = async (): Promise<void> => {
    try {
      const state = await api.state()
      publish({ state, error: undefined })
    } catch (error) {
      publish({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  const schedule = (): void => {
    if (disposed || listeners.size === 0) return
    const delay = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? HIDDEN_MS : VISIBLE_MS
    timer = setTimeout(() => {
      void poll().finally(schedule)
    }, delay)
  }

  const pollNotices = async (): Promise<void> => {
    try {
      const notices = await api.notifications(lastNoticeAt)
      if (lastNoticeAt === undefined) {
        // The first read only marks where "new" starts; old notices are in the Activity view.
        lastNoticeAt = notices.at(-1)?.at ?? new Date().toISOString()
        return
      }
      if (notices.length === 0) return
      lastNoticeAt = notices.at(-1)?.at ?? lastNoticeAt
      const fresh = notices.filter(notice => !snapshot.toasts.some(toast => toast.id === notice.id))
      if (fresh.length > 0) publish({ toasts: [...snapshot.toasts, ...fresh].slice(-MAX_TOASTS) })
    } catch {
      // Notifications are best-effort; the Activity view shows the full history.
    }
  }

  const start = (): void => {
    if (timer !== undefined || disposed) return
    void poll()
    schedule()
  }

  const stop = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const onVoice = (): void => {
    if (provider === undefined) return
    const phase = provider.phase()
    publish({ voice: provider.snapshot(), voiceAvailable: provider.stt.available || provider.tts.available })
    if (phase === reportedPhase) return
    reportedPhase = phase
    void api.voice(phase).then((state) => { publish({ state }) }, () => {})
  }

  let asking = 0
  const ask = async (text: string): Promise<string> => {
    const mine = ++asking
    publish({ exchange: { question: text, pending: true } })
    try {
      const started = await api.converse(text)
      publish({ exchange: { question: text, pending: true, sessionId: started.sessionId } })
      void poll()
      const deadline = Date.now() + ANSWER_TIMEOUT_MS
      let turn = started
      while (turn.status === 'running') {
        if (disposed) throw new Error('closed')
        if (Date.now() > deadline) throw new Error('no answer yet; it is still working in the conversation')
        await new Promise((resolve) => { setTimeout(resolve, ANSWER_POLL_MS) })
        turn = await api.converseTurn(started.id)
      }
      if (turn.status === 'failed') throw new Error(turn.error ?? 'the turn failed')
      const reply = turn.reply ?? ''
      if (mine === asking) publish({ exchange: { question: text, pending: false, reply, sessionId: turn.sessionId } })
      return reply
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (mine === asking) publish({ exchange: { ...snapshot.exchange, question: text, pending: false, error: message } })
      throw error
    }
  }

  noticeTimer = setInterval(() => { void pollNotices() }, NOTICE_MS)
  void pollNotices()

  return {
    live: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        start()
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) stop()
        }
      },
    },
    setProvider(next) {
      provider = next
      if (next === undefined) {
        publish({ voice: null, voiceAvailable: false })
        return () => {}
      }
      const unsubscribe = next.subscribe(onVoice)
      onVoice()
      return () => {
        unsubscribe()
        if (provider === next) {
          provider = undefined
          publish({ voice: null, voiceAvailable: false })
          if (reportedPhase !== 'off') {
            reportedPhase = 'off'
            void api.voice('off').catch(() => {})
          }
        }
      }
    },
    provider: () => provider,
    ask,
    talk() {
      if (provider?.converse === undefined) return false
      provider.converse({ name: 'personal-ai', send: ask })
      return true
    },
    refresh: poll,
    dismissToast(id) {
      publish({ toasts: snapshot.toasts.filter(toast => toast.id !== id) })
    },
    dispose() {
      disposed = true
      stop()
      if (noticeTimer !== undefined) clearInterval(noticeTimer)
      noticeTimer = undefined
      listeners.clear()
    },
  }
}
