/**
 * Compact assistant state in every chat header: a state dot (CSS, no extra
 * WebGL context), the state word, a stop-speaking button while speaking, and
 * a shortcut to the Command Center.
 */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { LiveSnapshot, LiveStore, Observable } from './store.ts'
import { readHudPrefs } from './prefs.ts'
import type { NS } from './locales.ts'
import css from './CommandCenter.module.css'

/** What the state bar receives from the plugin. */
export interface StateBarInjected {
  readonly hooks: { readonly live: Observable<LiveSnapshot> }
  readonly store: LiveStore
  readonly openCommandCenter: () => void
}

/** Full props. */
export type StateBarProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<StateBarInjected> & PropsLocale<typeof NS>

/**
 * Render the state bar.
 * @param props - live store, navigation, and copy.
 * @returns the compact state indicator.
 */
export function StateBar({ sessionId, useLive, store, openCommandCenter, t }: StateBarProps) {
  const live = useLive(snapshot => snapshot)
  const [enabled, setEnabled] = useState(() => readHudPrefs().stateBar)
  useEffect(() => {
    const onChange = (): void => { setEnabled(readHudPrefs().stateBar) }
    window.addEventListener('personal-ai:hud-prefs', onChange)
    return () => { window.removeEventListener('personal-ai:hud-prefs', onChange) }
  }, [])
  if (!enabled) return null
  const state = live.state
  const elsewhere = state?.sessionId !== undefined && state.sessionId !== String(sessionId) && state.state !== 'IDLE'
  const word = live.error !== undefined ? t('state.error') : state === undefined ? t('state.connecting') : t(`state.${state.state}`)
  return (
    <div className={css.stateBar} data-state={live.error !== undefined ? 'error' : state?.orb ?? 'idle'}>
      <button type="button" className={css.stateBarButton} onClick={openCommandCenter} title={t('hud.open')} aria-label={`${t('hud.open')}: ${word}`}>
        <span className={css.dot} aria-hidden="true" />
        <span className={css.stateWord} aria-live="polite">{elsewhere ? t('state.elsewhere', { state: word }) : word}</span>
      </button>
      {state?.voice === 'speaking' && (
        <Button size="sm" variant="ghost" onClick={() => { store.provider()?.tts.stop() }}>{t('voice.stop')}</Button>
      )}
    </div>
  )
}
