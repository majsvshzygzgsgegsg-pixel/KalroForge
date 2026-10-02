/**
 * Browser face of the Agent Registry: an "Agents" main panel listing Lead and
 * every persistent main agent, reached from the sidebar panel list. The page
 * talks to the Host's `/main-agents/*` routes and navigates through
 * ui-workspace to open an agent's own chat.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AgentsIcon } from './AgentsIcon.tsx'
import { AgentsPage, type AgentsInjected } from './AgentsPage.tsx'
import { en, NS, zh, type MainAgentsKey } from './locales.ts'

const PANEL_ID = 'main-agents' as MainPanelId

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agents management page copy. */
    'mainAgents.page': MainAgentsKey
  }
}

/** Required services for the page, its sidebar entry, panel selection, and Session navigation. */
export const inject = ['slots', 'locale', 'layout', 'uiWorkspace']

/**
 * Register the Agents page and its sidebar entry.
 * @param ctx - browser services used by these contributions.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'main-agents: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: (): AgentsInjected => ({
      // Leaving the panel first shows the conversation the navigation selects.
      openSession: (sessionId) => {
        ctx.layout.selectPanel(null)
        ctx.uiWorkspace.openSession(sessionId as SessionId)
      },
      startSession: () => {
        ctx.layout.selectPanel(null)
        ctx.uiWorkspace.startSession()
      },
    }),
  }, AgentsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 5,
    locale: NS,
    label: () => t('panel'),
  }, AgentsIcon))
}
