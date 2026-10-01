import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {
  IconBranchOutlineRegular,
  IconEnhanceOutlineRegular,
  IconGlobeOutlineRegular,
  IconRightUpOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './style.module.css'

const HOLO_KIND = 'holo-gestures'
const HOLO_ID = '@local/holo-gestures'
const HOLO_REPO = 'https://github.com/zubair-trabzada/holo-gestures.git'
const HOLO_DIR = '~/holo'
const HOLO_LOCAL_URL = 'http://127.0.0.1:4890'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Holo Gestures connector page. */
    'holo-gestures': Record<string, never>
  }
}

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: HOLO_ID,
    kind: HOLO_KIND,
    priority: 'extension',
    title: () => 'Holo Gestures',
    guide: [{
      id: 'holo-gestures',
      order: 42,
      title: () => 'Holo Gestures',
      description: () => 'Hand-gesture service, local install, and Creator editing access.',
      icon: IconEnhanceOutlineRegular,
    }],
  }), 'local-holo-gestures.type')

  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'holo-gestures',
    order: 12,
    label: 'Holo Gestures',
  }, function HoloSidebarAction(props: { readonly wide: boolean }): ReactNode {
    return <HoloSidebarButton {...props} open={() => { ctx.sidebarRight.openTab(HOLO_KIND) }} />
  })), 'local-holo-gestures.sidebar-action')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: HOLO_ID,
  }, HoloPanel)), 'local-holo-gestures.panel')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: HOLO_ID,
  }, HoloTitle)), 'local-holo-gestures.title')
}

function HoloSidebarButton({ wide, open }: { readonly wide: boolean; readonly open: () => void }): ReactNode {
  return (
    <Tooltip label="Holo Gestures" delayMs={500} disabled={wide}>
      <button type="button" className={css.sidebarButton} aria-label="Open Holo Gestures" onClick={open}>
        <IconEnhanceOutlineRegular size={wide ? 15 : 18} />
        {wide && <span>Holo</span>}
      </button>
    </Tooltip>
  )
}

function HoloTitle(): ReactNode {
  return <><IconEnhanceOutlineRegular className={css.titleIcon} />Holo Gestures</>
}

function HoloPanel(_props: PropsRuntime<'sidebar.right.pane.tab'>): ReactNode {
  return (
    <div className={css.panel}>
      <div className={css.hero}>
        <div className={css.logo}><IconEnhanceOutlineRegular size={34} /></div>
        <div>
          <h2>Holo Gestures</h2>
          <p>Local hand-gesture server with the KairoForge call bridge, voice, text, and Creator-mode handoff.</p>
        </div>
      </div>

      <section className={css.card}>
        <h3>Install and run</h3>
        <p>Run these commands in Terminal to install the Holo Gestures service locally:</p>
        <pre><code>{`git clone ${HOLO_REPO} ~/holo
cd ~/holo
python3 server.py`}</code></pre>
      </section>

      <section className={css.grid}>
        <a className={css.linkCard} href={HOLO_REPO} target="_blank" rel="noreferrer">
          <IconBranchOutlineRegular size={18} />
          <span>Open GitHub repo</span>
          <IconRightUpOutlineRegular size={14} />
        </a>
        <a className={css.linkCard} href={HOLO_LOCAL_URL} target="_blank" rel="noreferrer">
          <IconGlobeOutlineRegular size={18} />
          <span>Open local server</span>
          <IconRightUpOutlineRegular size={14} />
        </a>
      </section>

      <section className={css.card}>
        <h3>Creator mode access</h3>
        <p>
          Creator mode may clone, inspect, edit, and run the Holo project at <code>{HOLO_DIR}</code> when you ask for Holo changes.
          It should preserve unrelated files, avoid committing secrets, and publish KairoForge connector updates back to
          this GitHub project.
        </p>
      </section>

      <section className={css.card}>
        <h3>KairoForge Call</h3>
        <p>
          Open the local server and use the floating KairoForge Call panel near the bottom-right of Holo. Speaker reads
          replies aloud, Talk uses browser speech recognition when available, Keyboard opens the movable holographic keyboard,
          and Hang up ends the session. Commands such as “add 3D item”, “remove selected”, or “send this to Creator mode”
          are logged locally for guarded Creator-mode follow-up.
        </p>
      </section>
    </div>
  )
}
