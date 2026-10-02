/**
 * Browser face of the Personal AI: the Command Center main panel (galaxy HUD
 * plus sections) reached from the sidebar, the compact state bar in every
 * chat header, app-wide notification toasts, and the bridge to the Call
 * plugin's voice runtime when it is installed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { api } from './api.ts'
import { CommandCenter, type CommandCenterInjected } from './CommandCenter.tsx'
import { CommandCenterIcon } from './Icon.tsx'
import { en, NS, zh, type PersonalAiKey } from './locales.ts'
import { Notifications, type NotificationsInjected } from './Notifications.tsx'
import { StateBar, type StateBarInjected } from './StateBar.tsx'
import { createLiveStore } from './store.ts'
import { browserVoiceProvider } from './voice.ts'

const PANEL_ID = 'personal-ai' as MainPanelId
const AGENTS_PANEL_ID = 'main-agents' as MainPanelId

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Command Center, HUD, and state bar copy. */
    'personalAi': PersonalAiKey
  }
}

export type { VoiceProvider, SpeechToTextProvider, TextToSpeechProvider } from './voice.ts'

/** Required services: slots, dictionaries, panel selection, and Session navigation. */
export const inject = ['slots', 'locale', 'layout', 'uiWorkspace']

/**
 * Register the Command Center, the state bar, notifications, and the voice bridge.
 * @param ctx - browser services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'personal-ai: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createLiveStore()
  ctx.effect(() => () => { store.dispose() }, 'personal-ai: live store')
  const hooks = { live: store.live }
  const openCommandCenter = (): void => { ctx.layout.selectPanel(PANEL_ID) }
  const openAgents = (): void => { ctx.layout.selectPanel(AGENTS_PANEL_ID) }
  // Leaving the panel first shows the conversation the navigation selects.
  const openSession = (sessionId: string): void => {
    ctx.layout.selectPanel(null)
    ctx.uiWorkspace.openSession(sessionId as SessionId)
  }

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: (): CommandCenterInjected => ({ hooks, store, openAgents, openSession }),
  }, CommandCenter))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 4,
    locale: NS,
    label: () => t('panel'),
  }, CommandCenterIcon))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'personal-ai-state',
    order: -10,
    locale: NS,
    inject: (): StateBarInjected => ({ hooks, store, openCommandCenter }),
  }, StateBar))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'personal-ai-notifications',
    locale: NS,
    inject: (): NotificationsInjected => ({ hooks, store }),
  }, Notifications))

  // The Call plugin publishes its runtime as `voiceCall`; without it the HUD shows text-only controls.
  ctx.inject(['voiceCall'], (scoped) => {
    const provider = browserVoiceProvider(scoped.voiceCall)
    scoped.effect(() => store.setProvider(provider), 'personal-ai: voice bridge')
    void api.personality().then(({ personality }) => {
      provider.tts.setVoice({ name: personality.voice.name ?? '', rate: personality.voice.rate })
    }, () => {})
  })
}
