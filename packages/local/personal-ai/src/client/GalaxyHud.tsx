/**
 * The HUD: the living galaxy driven by the live assistant state, the state
 * line, and the voice controls (talk, stop speaking, interrupt). The
 * microphone is tapped for the visuals only while the Call is listening and
 * only when the browser already granted microphone access, so the HUD never
 * raises its own permission prompt.
 */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrbState } from '@local/galaxy'
import type { LiveSnapshot, LiveStore } from './store.ts'
import { GalaxyView } from './GalaxyView.tsx'
import { readHudPrefs } from './prefs.ts'
import type { Translate } from './locales.ts'
import css from './CommandCenter.module.css'

/** HUD props. */
export interface GalaxyHudProps {
  readonly live: LiveSnapshot
  readonly store: LiveStore
  readonly t: Translate
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

function useMicWhileListening(listening: boolean): MediaStream | undefined {
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
 * Render the HUD.
 * @param props - live snapshot, store, and copy.
 * @returns the galaxy with its state line and voice controls.
 */
export function GalaxyHud({ live, store, t }: GalaxyHudProps) {
  const state = live.state
  const orb: OrbState = live.error !== undefined ? 'error' : state?.orb ?? 'idle'
  const voice = store.provider()
  const listening = state?.voice === 'listening'
  const mic = useMicWhileListening(listening)
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
  const line = live.error !== undefined
    ? t('state.offline', { message: live.error })
    : state === undefined ? t('state.connecting') : t(`state.${state.state}`)

  return (
    <section className={css.hud} aria-label={t('hud.label')}>
      <GalaxyView
        className={css.galaxy}
        state={orb}
        labels={labels}
        micStream={mic}
        performance={prefs.performance}
        reducedMotion={prefs.reducedMotion}
      />
      <div className={css.hudInfo}>
        <p className={css.stateLine}>{line}</p>
        {state?.tool !== undefined && <p className={css.muted}>{t('state.tool', { tool: state.tool })}</p>}
        {state?.decision !== undefined && (
          <p className={css.muted}>{t('state.decision', { depth: t(`depth.${state.decision.depth}`), category: state.decision.category })}</p>
        )}
        {(state?.pendingApprovals ?? 0) > 0 && <p className={css.warning}>{t('state.approvals', { count: String(state?.pendingApprovals ?? 0) })}</p>}
        {(state?.delegatedWork ?? 0) > 0 && <p className={css.muted}>{t('state.delegated', { count: String(state?.delegatedWork ?? 0) })}</p>}
        {live.voice?.caption !== undefined && live.voice.caption !== '' && <p className={css.caption}>{t('voice.caption', { text: live.voice.caption })}</p>}
        <div className={css.row}>
          {voice === undefined || !live.voiceAvailable
            ? <span className={css.muted}>{t('voice.unavailable')}</span>
            : (
              <>
                <Button size="sm" variant={live.voice?.live === true ? 'outline' : 'primary'} onClick={() => { if (live.voice?.live === true) voice.stt.stop(); else voice.stt.start() }}>
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
