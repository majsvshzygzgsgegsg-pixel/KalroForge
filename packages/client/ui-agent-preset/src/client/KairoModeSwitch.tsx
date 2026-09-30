/** The compact Chat/KairoForge selector in the conversation header. */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconCodeOutlineRegular, IconNewChatOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation header-utilities slot into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './KairoModeSwitch.module.css'

/** The two product modes deliberately exposed by the quick switch. */
export type KairoMode = 'chat' | 'standard'

/** Registration-side actions for the quick mode switch. */
export interface KairoModeSwitchInjected {
  /** Select immediately for a blank session, or open a new session when the current one has started. */
  switchMode: (sessionId: SessionId, mode: KairoMode) => Promise<string | undefined>
}

/** Full component props. */
export type KairoModeSwitchProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<KairoModeSwitchInjected>

/** Render a small two-way product mode selector without changing the surrounding header design. */
export function KairoModeSwitch({ sessionId, useSessions, switchMode, t }: KairoModeSwitchProps) {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : 'standard'
  })
  const active: KairoMode = preset === 'chat' ? 'chat' : 'standard'
  const [busy, setBusy] = useState(false)

  const select = (mode: KairoMode): void => {
    if (busy || mode === active) return
    setBusy(true)
    void switchMode(sessionId, mode).finally(() => { setBusy(false) })
  }

  return (
    <div className={css.switch} role="group" aria-label={t('modeSwitchLabel')}>
      <button
        type="button"
        className={active === 'chat' ? css.active : css.option}
        aria-pressed={active === 'chat'}
        title={t('modeChatHint')}
        disabled={busy}
        onClick={() => { select('chat') }}
      >
        <IconNewChatOutlineRegular size={14} />
        <span>{t('presetChatName')}</span>
      </button>
      <button
        type="button"
        className={active === 'standard' ? css.active : css.option}
        aria-pressed={active === 'standard'}
        title={t('modeCodeHint')}
        disabled={busy}
        onClick={() => { select('standard') }}
      >
        <IconCodeOutlineRegular size={14} />
        <span>{t('presetStandardName')}</span>
      </button>
    </div>
  )
}
