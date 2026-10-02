/**
 * Live assistant store shared by the HUD, the header state bar, and the
 * Command Center: polls `/personal-ai/state` over the existing web connection
 * while anything watches it, follows the voice provider, reports voice-phase
 * changes to the Host, and queues proactive notifications.
 */
import { api, type ConverseUpdate, type HoloOpenResult, type Notice, type StateView, type VoicePhase } from './api.ts'
import { holoShortcut } from './holo-intent.ts'
import type { CallSnapshot, VoiceProvider } from './voice.ts'

/** Polling cadence while the page is visible and hidden. */
const VISIBLE_MS = 700
const HIDDEN_MS = 4000
const NOTICE_MS = 4000
const MAX_TOASTS = 4
const ANSWER_POLL_MS = 600
/** Long enough for a turn that waits on an approval; the conversation keeps going after this. */
const ANSWER_TIMEOUT_MS = 15 * 60_000
/** A quick answer needs no acknowledgement; anything slower gets "On it" first. */
const ACK_MS = 1500

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

/** What KairoForge says while a turn runs: a Host update, or the acknowledgement once a turn is slow. */
export type Progress = ConverseUpdate | { readonly kind: 'ack' }

/** One question to KairoForge from the Command Center and its answer. */
export interface Exchange {
  readonly question: string
  readonly pending: boolean
  /** The latest progress while pending. */
  readonly progress?: Progress
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
   * @param text - the question.
   * @param onProgress - called with each new progress update while it works.
   * @returns the reply text (empty when the turn answered only with work).
   */
  ask(text: string, onProgress?: (progress: Progress) => void): Promise<string>
  /**
   * Start a voice call whose turns go to {@link ask}, speaking progress as it comes.
   * @param describe - the words for one progress update.
   * @returns false when voice is unavailable.
   */
  talk(describe: (progress: Progress) => string): boolean
  /** Refresh now (after a user action). */
  refresh(): Promise<void>
  dismissToast(id: string): void
  dispose(): void
}

/** Words the store says for requests it answers itself. */
export interface LiveStoreOptions {
  /** The reply to the Holo Hands shortcut: the open result, or "closed". */
  readonly holoReply?: (outcome: HoloOpenResult | 'closed') => string
  /** Words for a typed question's progress and failure, so its answer is spoken as well as shown. */
  readonly speech?: {
    readonly progress: (progress: Progress) => string
    readonly failed: (message: string) => string
  }
}

/**
 * Create the live store.
 * @param options - replies for requests answered without a model turn.
 * @returns the store.
 */
export function createLiveStore(options: LiveStoreOptions = {}): LiveStore {
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
    void api.voice(phase).then((state) => {
      const holo = state.holo ?? snapshot.state?.holo
      publish({ state: holo === undefined ? state : { ...state, holo } })
    }, () => {})
  }

  // A voice call speaks its own turns (it passes `onProgress`); a typed question is spoken here.
  const aloud = (onProgress: ((progress: Progress) => void) | undefined): ((line: string) => void) | undefined => {
    if (onProgress !== undefined || options.speech === undefined) return undefined
    return (line) => { if (provider?.snapshot()?.live !== true) provider?.tts.say(line) }
  }

  let asking = 0
  const ask = async (text: string, onProgress?: (progress: Progress) => void): Promise<string> => {
    const speak = aloud(onProgress)
    if (speak === undefined) return answer(text, onProgress)
    const words = options.speech
    const turn = asking + 1
    // A question asked after this one owns the voice; this one goes quiet.
    const say = (line: string): void => { if (turn === asking) speak(line) }
    try {
      const reply = await answer(text, (progress) => { if (words !== undefined) say(words.progress(progress)) })
      if (reply !== '') say(reply)
      return reply
    } catch (error) {
      if (words !== undefined) say(words.failed(error instanceof Error ? error.message : String(error)))
      throw error
    }
  }

  const answer = async (text: string, onProgress?: (progress: Progress) => void): Promise<string> => {
    const mine = ++asking
    let sessionId: string | undefined
    let said = 0
    let finished = false
    const report = (progress: Progress): void => {
      if (finished || mine !== asking) return
      said++
      publish({ exchange: { question: text, pending: true, progress, ...sessionId === undefined ? {} : { sessionId } } })
      onProgress?.(progress)
    }
    const shortcut = holoShortcut(text)
    if (shortcut !== undefined && options.holoReply !== undefined) return holo(text, shortcut, options.holoReply, mine)
    const ack = setTimeout(() => { if (said === 0) report({ kind: 'ack' }) }, ACK_MS)
    publish({ exchange: { question: text, pending: true } })
    try {
      const started = await api.converse(text)
      sessionId = started.sessionId
      if (snapshot.exchange?.progress === undefined && mine === asking) publish({ exchange: { question: text, pending: true, sessionId } })
      void poll()
      const deadline = Date.now() + ANSWER_TIMEOUT_MS
      let turn = started
      let seen = 0
      while (turn.status === 'running') {
        if (disposed) throw new Error('closed')
        if (Date.now() > deadline) throw new Error('no answer yet; it is still working in the conversation')
        await new Promise((resolve) => { setTimeout(resolve, ANSWER_POLL_MS) })
        turn = await api.converseTurn(started.id)
        const updates = turn.updates ?? []
        // Several updates in one poll: only the newest is still true, so only it is said.
        const latest = updates.length > seen ? updates.at(-1) : undefined
        seen = updates.length
        if (latest !== undefined && turn.status === 'running') report(latest)
      }
      finished = true
      if (turn.status === 'failed') throw new Error(turn.error ?? 'the turn failed')
      const reply = turn.reply ?? ''
      if (mine === asking) publish({ exchange: { question: text, pending: false, reply, sessionId: turn.sessionId } })
      return reply
    } catch (error) {
      finished = true
      const message = error instanceof Error ? error.message : String(error)
      if (mine === asking) {
        publish({ exchange: { question: text, pending: false, error: message, ...sessionId === undefined ? {} : { sessionId } } })
      }
      throw error
    } finally {
      clearTimeout(ack)
    }
  }

  // "Open holo hands" needs no model turn: open the deck, then say what actually happened.
  const holo = async (text: string, action: 'open' | 'close', reply: NonNullable<LiveStoreOptions['holoReply']>, mine: number): Promise<string> => {
    publish({ exchange: { question: text, pending: true } })
    try {
      const said = reply(action === 'open' ? await api.holoOpen() : (await api.holoClose(), 'closed'))
      await poll()
      if (mine === asking) publish({ exchange: { question: text, pending: false, reply: said } })
      return said
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (mine === asking) publish({ exchange: { question: text, pending: false, error: message } })
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
    talk(describe) {
      if (provider?.converse === undefined) return false
      provider.converse({
        name: 'personal-ai',
        send: (text, say) => ask(text, say === undefined ? undefined : (progress) => { say(describe(progress)) }),
      })
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
