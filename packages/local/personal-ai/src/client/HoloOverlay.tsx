/**
 * Holo Hands, full screen: the Holo Gestures deck in a frame that may use the
 * camera, with KairoForge's galaxy docked bottom-right (state, last exchange,
 * ask box, talk). The deck talks to this page only by origin-checked
 * postMessage; this page relays to the Host over the signed-in connection, so
 * the deck never holds KairoForge credentials. Perception is derived numbers
 * only — no images leave the deck.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OrbState } from '@local/galaxy'
import { api, type HoloSnapshot, type HoloView } from './api.ts'
import { AskForm, useMicWhileListening } from './GalaxyHud.tsx'
import { GalaxyView } from './GalaxyView.tsx'
import type { NS, Translate } from './locales.ts'
import { readHudPrefs } from './prefs.ts'
import { describeProgress } from './progress.ts'
import type { LiveSnapshot, LiveStore, Observable } from './store.ts'
import css from './HoloOverlay.module.css'

const PERCEPTION_GAP_MS = 250
const STALL_MS = 15_000

/** What the overlay receives from the plugin. */
export interface HoloOverlayInjected {
  readonly hooks: { readonly live: Observable<LiveSnapshot> }
  readonly store: LiveStore
  /** Show one Session's chat (approvals are answered there). */
  readonly openSession: (sessionId: string) => void
}

/** Full props. */
export type HoloOverlayProps = PropsRuntime<'shell.overlay'> & InjectFace<HoloOverlayInjected> & PropsLocale<typeof NS>

interface LayoutEntry {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly scale?: number
}

type DeckMessage =
  | { readonly kf: 'ready' }
  | { readonly kf: 'perception'; readonly report: unknown }
  | { readonly kf: 'layout'; readonly items: readonly LayoutEntry[] }
  | { readonly kf: 'activate'; readonly id: string; readonly value?: string }

function deckMessage(data: unknown): DeckMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = data as Record<string, unknown>
  switch (message.kf) {
    case 'ready': return { kf: 'ready' }
    case 'perception': return { kf: 'perception', report: message.report }
    case 'layout': return Array.isArray(message.items) ? { kf: 'layout', items: message.items as LayoutEntry[] } : undefined
    case 'activate':
      if (typeof message.id !== 'string') return undefined
      return { kf: 'activate', id: message.id, ...typeof message.value === 'string' ? { value: message.value } : {} }
    default: return undefined
  }
}

/**
 * Render Holo Hands while the Host says it is open.
 * @param props - live store, navigation, and copy.
 * @returns the full-screen deck, or nothing.
 */
export function HoloOverlay({ useLive, store, openSession, t }: HoloOverlayProps) {
  const live = useLive(snapshot => snapshot)
  const holo = live.state?.holo
  if (holo?.open !== true) return null
  return <HoloStage holo={holo} live={live} store={store} openSession={openSession} t={t} />
}

function HoloStage({ holo, live, store, openSession, t }: {
  readonly holo: HoloView
  readonly live: LiveSnapshot
  readonly store: LiveStore
  readonly openSession: (sessionId: string) => void
  readonly t: Translate
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [minimized, setMinimized] = useState(false)
  const [snapshot, setSnapshot] = useState<HoloSnapshot | undefined>()
  const [name, setName] = useState('KairoForge')
  const origin = useMemo(() => new URL(holo.url).origin, [holo.url])
  const src = useMemo(
    () => `${holo.url}/?embed=kairoforge&parent=${encodeURIComponent(window.location.origin)}&attempt=${String(attempt)}`,
    [holo.url, attempt],
  )

  useEffect(() => {
    void api.personality().then(({ personality }) => { setName(personality.name) }, () => {})
  }, [])

  useEffect(() => {
    let alive = true
    void api.holo().then((next) => { if (alive) setSnapshot(next) }, () => {})
    return () => { alive = false }
  }, [holo.revision])

  useEffect(() => {
    if (!ready || snapshot === undefined) return
    frame.current?.contentWindow?.postMessage({ kf: 'scene', scene: snapshot.scene }, origin)
  }, [ready, snapshot, origin])

  useEffect(() => {
    let lastPerception = 0
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return
      const message = deckMessage(event.data)
      if (message === undefined) return
      switch (message.kf) {
        case 'ready':
          setReady(true)
          setStalled(false)
          break
        case 'perception':
          if (Date.now() - lastPerception < PERCEPTION_GAP_MS) return
          lastPerception = Date.now()
          void api.holoPerception(message.report).catch(() => {})
          break
        case 'layout':
          void api.holoLayout(message.items).catch(() => {})
          break
        case 'activate':
          void api.holoActivate(message.id, message.value).then(({ prompt }) => {
            if (prompt !== null) void store.ask(prompt).catch(() => {})
          }, () => {})
          break
        default:
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [origin, store])

  useEffect(() => {
    if (ready) return
    const timer = setTimeout(() => { setStalled(true) }, STALL_MS)
    return () => { clearTimeout(timer) }
  }, [ready, attempt])

  const close = (): void => {
    void api.holoClose().then(() => store.refresh(), () => {})
  }

  useEffect(() => {
    if (!minimized) stage.current?.querySelector<HTMLInputElement>('aside input')?.focus()
  }, [minimized])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !minimized) setMinimized(true)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [minimized])

  const retry = (): void => {
    setReady(false)
    setStalled(false)
    void api.holoOpen().finally(() => { setAttempt(value => value + 1) })
  }

  const scene = snapshot?.scene
  return (
    <>
      <div
        ref={stage}
        className={minimized ? `${css.stage ?? ''} ${css.hidden ?? ''}` : css.stage}
        role="dialog"
        aria-modal={!minimized}
        aria-label={t('holo.label')}
        aria-hidden={minimized}
      >
        <iframe
          ref={frame}
          className={css.frame}
          src={src}
          title={t('holo.label')}
          allow="camera; autoplay; fullscreen"
          onLoad={() => { setStalled(false) }}
        />
        {!ready && (
          <div className={css.notice}>
            <div>
              <p>{stalled ? t('holo.offline', { url: holo.url }) : t('holo.loading')}</p>
              {stalled && <Button size="sm" variant="primary" onClick={retry}>{t('holo.retry')}</Button>}
            </div>
          </div>
        )}
        <div className={css.top}>
          {scene !== undefined && <span className={css.meta}>{t('holo.items', { count: String(scene.items.length), links: String(scene.connectors.length) })}</span>}
          <Button size="sm" variant="outline" onClick={() => { setMinimized(true) }}>{t('common.close')}</Button>
          <Button size="sm" variant="outline" onClick={close}>{t('holo.close')}</Button>
        </div>
        <OrbDock live={live} store={store} openSession={(id) => { setMinimized(true); openSession(id) }} t={t} name={name} />
      </div>
      {minimized && (
        <Button className={css.pill} size="sm" variant="primary" onClick={() => { setMinimized(false) }}>{t('holo.label')}</Button>
      )}
    </>
  )
}

function OrbDock({ live, store, openSession, t, name }: {
  readonly live: LiveSnapshot
  readonly store: LiveStore
  readonly openSession: (sessionId: string) => void
  readonly t: Translate
  readonly name: string
}) {
  const state = live.state
  const orb: OrbState = live.error !== undefined ? 'error' : state?.orb ?? 'idle'
  const voice = store.provider()
  const mic = useMicWhileListening(state?.voice === 'listening')
  const prefs = useMemo(readHudPrefs, [])
  const exchange = live.exchange
  const awaiting = exchange?.pending === true && (state?.pendingApprovals ?? 0) > 0
  const caption = live.voice?.live === true ? live.voice.caption : ''
  const line = live.error !== undefined ? t('state.offline', { message: live.error }) : state === undefined ? t('state.connecting') : t(`state.${state.state}`)
  const said = exchange === undefined
    ? ''
    : exchange.pending
      ? awaiting ? t('ask.needsApproval') : exchange.progress === undefined ? t('ask.thinking') : describeProgress(exchange.progress, t)
      : exchange.error !== undefined ? t('ask.failed', { message: exchange.error }) : exchange.reply === '' || exchange.reply === undefined ? t('ask.noText') : exchange.reply
  return (
    <aside className={css.dock}>
      <div className={css.panel}>
        <p className={css.state}>{line}</p>
        {(caption !== '' || exchange !== undefined) && (
          <div className={css.lines} aria-live="polite">
            <p className={css.line}><b>{t('ask.you')}</b> {caption !== '' ? caption : exchange?.question}</p>
            {said !== '' && caption === '' && <p className={css.line}><b>{name}</b> {said}</p>}
          </div>
        )}
        {exchange?.sessionId !== undefined && awaiting && (
          <Button size="sm" variant="primary" onClick={() => { if (exchange.sessionId !== undefined) openSession(exchange.sessionId) }}>{t('ask.openToApprove')}</Button>
        )}
        <AskForm store={store} t={t} busy={exchange?.pending === true} assistantName={name} />
        {voice !== undefined && live.voiceAvailable && (
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
        )}
      </div>
      <GalaxyView
        className={css.orb}
        state={orb}
        labels={{ idle: t('state.IDLE'), arming: t('state.WAITING_FOR_APPROVAL'), listening: t('state.LISTENING'), processing: t('state.THINKING'), speaking: t('state.SPEAKING'), error: t('state.error') }}
        micStream={mic}
        performance={prefs.performance}
        reducedMotion={prefs.reducedMotion}
      />
    </aside>
  )
}
