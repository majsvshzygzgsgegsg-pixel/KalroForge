/**
 * The HUD: the living galaxy driven by the live assistant state, the state
 * line, and the voice controls (talk, stop speaking, interrupt). The
 * microphone is tapped for the visuals only while the Call is listening and
 * only when the browser already granted microphone access, so the HUD never
 * raises its own permission prompt.
 */
import { type RefObject, useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrbState } from '@local/galaxy'
import type { LiveSnapshot, LiveStore } from './store.ts'
import { GalaxyView } from './GalaxyView.tsx'
import { readHudPrefs } from './prefs.ts'
import type { Translate } from './locales.ts'
import { describeProgress } from './progress.ts'
import css from './CommandCenter.module.css'

const GROW = css.grow ?? ''

/** HUD props. */
export interface GalaxyHudProps {
  readonly live: LiveSnapshot
  readonly store: LiveStore
  readonly t: Translate
  /** Open the conversation Session in the chat view (approvals are answered there). */
  readonly openSession: (sessionId: string) => void
  /** The personality's name, for the transcript. */
  readonly assistantName: string
}

/**
 * Typed questions to KairoForge: the text fallback for the spoken conversation.
 * @param props - store and copy.
 * @returns the ask form.
 */
export function AskForm({ store, t, busy, assistantName }: {
  readonly store: LiveStore
  readonly t: Translate
  readonly busy: boolean
  readonly assistantName: string
}) {
  const [text, setText] = useState('')
  return (
    <form
      className={css.row}
      onSubmit={(event) => {
        event.preventDefault()
        const question = text.trim()
        if (question === '' || busy) return
        setText('')
        void store.ask(question).catch(() => {})
      }}
    >
      <Input
        className={GROW}
        value={text}
        maxLength={4000}
        placeholder={t('ask.placeholder', { name: assistantName })}
        aria-label={t('ask.label')}
        onChange={(event) => { setText(event.target.value) }}
        // App-wide key handling swallows the form's implicit Enter submission.
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          event.currentTarget.form?.requestSubmit()
        }}
      />
      <Button size="sm" variant="primary" type="submit" disabled={busy || text.trim() === ''}>{t('ask.send')}</Button>
    </form>
  )
}

async function micGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' })
    return status.state === 'granted'
  } catch {
    // Browsers without the Permissions API for microphones simply skip the tap.
    return false
  }
}

/**
 * Whether the Call is listening right now, from its own snapshot rather than the
 * polled Host state: Safari holds a reply back while any microphone capture is
 * open, so the visuals tap must close the moment the Call starts speaking.
 * @param live - live snapshot.
 * @returns whether the Call is listening.
 */
export function callListening(live: LiveSnapshot): boolean {
  return live.voice?.live === true && live.voice.phase === 'listening'
}

/**
 * The microphone stream for the galaxy visuals while the Call is listening.
 * @param listening - whether the Call is listening.
 * @returns the stream, when the browser already granted the microphone.
 */
export function useMicWhileListening(listening: boolean): MediaStream | undefined {
  const [stream, setStream] = useState<MediaStream | undefined>()
  useEffect(() => {
    if (!listening) return
    const abort = new AbortController()
    let opened: MediaStream | undefined
    const open = async (): Promise<void> => {
      if (!await micGranted()) return
      opened = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => undefined)
      if (abort.signal.aborted) {
        for (const track of opened?.getTracks() ?? []) track.stop()
        return
      }
      setStream(opened)
    }
    void open()
    return () => {
      abort.abort()
      for (const track of opened?.getTracks() ?? []) track.stop()
      setStream(undefined)
    }
  }, [listening])
  return stream
}

/**
 * Full-screen state for the galaxy stage: the browser's full screen when it allows
 * it, otherwise a fixed overlay; Esc or leaving browser full screen closes it.
 * @returns the stage ref, whether it is full screen, and a toggle.
 */
function useFullScreen(): { readonly stage: RefObject<HTMLDivElement>; readonly full: boolean; readonly toggle: () => void } {
  const stage = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (!full) return
    const element = stage.current
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setFull(false) }
    const onChange = (): void => { if (document.fullscreenElement === null) setFull(false) }
    const enter = async (): Promise<void> => {
      try {
        await element?.requestFullscreen()
      } catch {
        // No browser full screen (or refused): the fixed overlay still fills the window.
      }
    }
    void enter()
    window.addEventListener('keydown', onKey)
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('fullscreenchange', onChange)
      if (element !== null && document.fullscreenElement === element) void document.exitFullscreen().catch(() => {})
    }
  }, [full])
  return { stage, full, toggle: () => { setFull(value => !value) } }
}

/**
 * Render the HUD.
 * @param props - live snapshot, store, and copy.
 * @returns the galaxy with its state line and voice controls.
 */
export function GalaxyHud({ live, store, t, openSession, assistantName }: GalaxyHudProps) {
  const state = live.state
  const orb: OrbState = live.error !== undefined ? 'error' : state?.orb ?? 'idle'
  const voice = store.provider()
  const mic = useMicWhileListening(callListening(live))
  const { stage, full, toggle } = useFullScreen()
  const [newChatError, setNewChatError] = useState<string | undefined>()
  const [prefs, setPrefs] = useState(readHudPrefs)
  useEffect(() => {
    const onChange = (): void => { setPrefs(readHudPrefs()) }
    window.addEventListener('personal-ai:hud-prefs', onChange)
    return () => { window.removeEventListener('personal-ai:hud-prefs', onChange) }
  }, [])

  const labels: Partial<Record<OrbState, string>> = {
    idle: t('state.IDLE'),
    arming: t('state.WAITING_FOR_APPROVAL'),
    listening: t('state.LISTENING'),
    processing: t('state.THINKING'),
    speaking: t('state.SPEAKING'),
    error: t('state.error'),
  }
  const exchange = live.exchange
  const awaiting = exchange?.pending === true && (state?.pendingApprovals ?? 0) > 0
  // While the microphone is hearing words, show them; otherwise the last question asked.
  const caption = live.voice?.live === true ? live.voice.caption : ''
  const heardNow = caption !== '' ? caption : exchange?.question ?? ''
  const line = live.error !== undefined
    ? t('state.offline', { message: live.error })
    : state === undefined ? t('state.connecting') : t(`state.${state.state}`)
  const saying = exchange === undefined
    ? ''
    : exchange.pending
      ? awaiting ? t('ask.needsApproval') : exchange.progress === undefined ? t('ask.thinking') : describeProgress(exchange.progress, t)
      : exchange.error ?? exchange.reply ?? ''

  return (
    <section className={css.hud} aria-label={t('hud.label')}>
      <div
        ref={stage}
        role="button"
        tabIndex={0}
        className={full ? `${css.galaxyStage} ${css.galaxyFull}` : css.galaxyStage}
        aria-label={full ? t('hud.exitFullScreen') : t('hud.fullScreen')}
        title={full ? t('hud.exitFullScreen') : t('hud.fullScreen')}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        }}
      >
        <GalaxyView
          className={css.galaxy}
          state={orb}
          labels={labels}
          micStream={mic}
          performance={prefs.performance}
          reducedMotion={prefs.reducedMotion}
        />
        {full && (
          <div className={css.fullCaption}>
            <p className={css.stateLine}>{line}</p>
            {heardNow !== '' && <p className={css.muted}>{heardNow}</p>}
            {saying !== '' && <p>{saying}</p>}
          </div>
        )}
      </div>
      <div className={css.hudInfo}>
        <p className={css.stateLine}>{line}</p>
        {state?.tool !== undefined && <p className={css.muted}>{t('state.tool', { tool: state.tool })}</p>}
        {state?.decision !== undefined && (
          <p className={css.muted}>{t('state.decision', { depth: t(`depth.${state.decision.depth}`), category: state.decision.category })}</p>
        )}
        {(state?.pendingApprovals ?? 0) > 0 && <p className={css.warning}>{t('state.approvals', { count: String(state?.pendingApprovals ?? 0) })}</p>}
        {(state?.delegatedWork ?? 0) > 0 && <p className={css.muted}>{t('state.delegated', { count: String(state?.delegatedWork ?? 0) })}</p>}
        <div className={css.transcript} aria-live="polite">
          {heardNow !== '' && (
            <p className={css.turn}>
              <span className={css.speaker}>{t('ask.you')}</span>
              <span className={live.voice?.partial === true ? css.partial : undefined}>{heardNow}</span>
            </p>
          )}
          {exchange !== undefined && heardNow === exchange.question && (
            <p className={css.turn}>
              <span className={css.speaker}>{assistantName}</span>
              {exchange.pending
                ? <span className={css.muted}>
                  {awaiting
                    ? t('ask.needsApproval')
                    : exchange.progress === undefined ? t('ask.thinking') : describeProgress(exchange.progress, t)}
                </span>
                : exchange.error !== undefined
                  ? <span className={css.warning}>{t('ask.failed', { message: exchange.error })}</span>
                  : <span>{exchange.reply === '' || exchange.reply === undefined ? t('ask.noText') : exchange.reply}</span>}
            </p>
          )}
          <div className={css.row}>
            {exchange?.sessionId !== undefined && (
              <Button size="sm" variant={awaiting ? 'primary' : 'ghost'} onClick={() => { if (exchange.sessionId !== undefined) openSession(exchange.sessionId) }}>
                {awaiting ? t('ask.openToApprove') : t('ask.openConversation')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={exchange?.pending === true}
              onClick={() => {
                setNewChatError(undefined)
                store.newChat().catch((error: unknown) => { setNewChatError(error instanceof Error ? error.message : String(error)) })
              }}
            >
              {t('ask.newChat')}
            </Button>
          </div>
          {newChatError !== undefined && <p className={css.warning} role="alert">{t('ask.newChatFailed', { message: newChatError })}</p>}
        </div>
        <AskForm store={store} t={t} busy={exchange?.pending === true} assistantName={assistantName} />
        <div className={css.row}>
          {voice === undefined || !live.voiceAvailable
            ? <span className={css.muted}>{t('voice.unavailable')}</span>
            : (
              <>
                <Button
                  size="sm"
                  variant={live.voice?.live === true ? 'outline' : 'primary'}
                  onClick={() => {
                    if (live.voice?.live === true) voice.stt.stop()
                    else if (!store.talk(progress => describeProgress(progress, t))) voice.stt.start()
                  }}
                >
                  {live.voice?.live === true ? t('voice.endCall') : t('voice.talk')}
                </Button>
                <Button size="sm" variant="outline" disabled={state?.voice !== 'speaking'} onClick={() => { voice.tts.stop() }}>{t('voice.stop')}</Button>
                <Button size="sm" variant="outline" disabled={state?.voice !== 'speaking'} onClick={() => { voice.tts.interrupt() }}>{t('voice.interrupt')}</Button>
              </>
            )}
        </div>
      </div>
    </section>
  )
}
