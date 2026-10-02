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
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './style.module.css'

const HOLO_KIND = 'holo-gestures'
const HOLO_ID = '@local/holo-gestures'
const HOLO_REPO = 'https://github.com/zubair-trabzada/holo-gestures.git'
const HOLO_DIR = '~/holo'
const HOLO_LOCAL_URL = 'http://127.0.0.1:4890'

/** Ask KairoForge to open Holo Hands full screen; the Personal AI overlay follows the Host's open state. */
async function openHoloHands(): Promise<{ readonly server?: string; readonly detail?: string }> {
  const res = await fetch(new URL('personal-ai/holo/open', document.baseURI), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
  return await res.json() as { readonly server?: string; readonly detail?: string }
}

interface HoloCommand {
  readonly id: string
  readonly command: string
  readonly source?: string
  readonly event?: string
  readonly status?: string
  readonly created_at?: number
}

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
    return <HoloSidebarButton {...props} open={() => { void openHoloHands().catch(() => { ctx.sidebarRight.openTab(HOLO_KIND) }) }} />
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
    <Tooltip label="Open Holo Hands" delayMs={500} disabled={wide}>
      <button type="button" className={css.sidebarButton} aria-label="Open Holo Hands" onClick={open}>
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
  const [commands, setCommands] = useState<readonly HoloCommand[]>([])
  const [connected, setConnected] = useState<'checking' | 'online' | 'offline'>('checking')
  const [copied, setCopied] = useState(false)
  const [opening, setOpening] = useState<string | undefined>()

  useEffect(() => {
    let alive = true
    async function refresh(): Promise<void> {
      try {
        const res = await fetch(`${HOLO_LOCAL_URL}/api/commands`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as { readonly pending?: readonly HoloCommand[] }
        if (!alive) return
        setConnected('online')
        setCommands(Array.isArray(data.pending) ? data.pending : [])
      } catch {
        if (!alive) return
        setConnected('offline')
        setCommands([])
      }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const creatorPrompt = useMemo(() => {
    const list = commands.length
      ? commands.map((item, index) => `${index + 1}. ${item.command}`).join('\n')
      : 'No pending Holo commands yet.'
    return `Continue the Holo Gestures work for KairoForge Creator mode.\n\nPending commands from the Holo voice/text call:\n${list}\n\nWork inside /Users/franksmith/Documents/KalroForge and /Users/franksmith/holo as needed. Inspect the current files first, preserve unrelated changes, implement the requested Holo/KairoForge edits safely, run relevant checks, commit KairoForge changes, publish to GitHub master, restart the local servers, and open the latest version. Do not give the browser page unrestricted hidden shell control; route computer/repo changes through the guarded KairoForge workflow.`
  }, [commands])

  async function copyCreatorPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(creatorPrompt)
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1800)
    } catch {
      setCopied(false)
    }
  }

  async function markHandled(id: string): Promise<void> {
    try {
      await fetch(`${HOLO_LOCAL_URL}/api/command-done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      setCommands(items => items.filter(item => item.id !== id))
    } catch {}
  }

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
        <div className={css.row}>
          <div>
            <h3>Holo Hands</h3>
            <p>
              Say or type “open holo hands” to KairoForge, or press Open. KairoForge starts the local server from
              <code> {HOLO_DIR}</code>, opens the deck full screen, tracks your face and hands on this computer, and can add
              and connect anything on it when you ask.
            </p>
          </div>
          <button
            type="button"
            className={css.actionButton}
            onClick={() => {
              setOpening('Opening…')
              void openHoloHands().then(
                (result) => { setOpening(result.detail ?? (result.server === 'started' ? 'Started the server and opened Holo Hands.' : 'Opened.')) },
                (error: unknown) => { setOpening(`Could not open: ${error instanceof Error ? error.message : String(error)}`) },
              )
            }}
          >
            Open Holo Hands
          </button>
        </div>
        {opening !== undefined && <p className={css.statusLine}>{opening}</p>}
      </section>

      <section className={css.card}>
        <h3>Install</h3>
        <p>Only needed on a computer without the Holo checkout:</p>
        <pre><code>{`git clone ${HOLO_REPO} ~/holo`}</code></pre>
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

      <section className={css.card}>
        <div className={css.row}>
          <div>
            <h3>Creator command queue</h3>
            <p className={css.statusLine}>
              Holo server is <span className={connected === 'online' ? css.ok : css.bad}>{connected}</span>.
              {connected === 'online' ? ` ${commands.length} pending command${commands.length === 1 ? '' : 's'}.` : ' Start ~/holo with python3 server.py.'}
            </p>
          </div>
          <button type="button" className={css.actionButton} onClick={() => { void copyCreatorPrompt() }}>
            {copied ? 'Copied' : 'Copy Creator prompt'}
          </button>
        </div>

        {commands.length ? (
          <div className={css.commandList}>
            {commands.map(item => (
              <div className={css.commandItem} key={item.id}>
                <div>
                  <strong>{item.command}</strong>
                  <span>{item.source || 'kairoforge-call'} · {item.status || 'pending'}</span>
                </div>
                <button type="button" onClick={() => { void markHandled(item.id) }}>Done</button>
              </div>
            ))}
          </div>
        ) : (
          <p className={css.empty}>No pending Holo voice/text commands yet. Say or type something in the KairoForge Call panel.</p>
        )}

        <pre className={css.promptBox}><code>{creatorPrompt}</code></pre>
      </section>
    </div>
  )
}
