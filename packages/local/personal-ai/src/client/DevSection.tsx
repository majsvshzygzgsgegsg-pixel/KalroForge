/**
 * Dev: what makes KairoForge an in-editor coding agent — the VS Code / Cursor
 * extension and live editor state, the repo map, the agent-loop safety nets
 * (path hints, syntax checks, loop stops), context limits, and model
 * connection warm-up.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type DevStatus, type EditorKind } from './api.ts'
import { ago, errorText } from './format.ts'
import type { Translate } from './locales.ts'
import css from './CommandCenter.module.css'

const REFRESH_MS = 4000

/**
 * Render the Dev section.
 * @param props - copy.
 * @returns the section.
 */
export function DevSection({ t }: { readonly t: Translate }) {
  const [status, setStatus] = useState<DevStatus | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState<EditorKind | undefined>()
  const [note, setNote] = useState<string | undefined>()

  const load = useCallback(async () => {
    try {
      setStatus(await api.dev())
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [load])

  const install = async (editor: EditorKind): Promise<void> => {
    setBusy(editor)
    setNote(undefined)
    try {
      const result = await api.devInstall(editor)
      setNote(result.installed ? t('dev.installed', { version: result.version }) : `${t('dev.installFailed')} ${result.detail}`)
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
    setBusy(undefined)
    await load()
  }

  if (status === undefined) return <p className={css.muted}>{error ?? t('page.loading')}</p>
  const { editor, extensions, index, counters, warm, context } = status

  return (
    <div className={css.section}>
      <p className={css.muted}>{t('dev.subtitle')}</p>
      {error !== undefined && <p className={css.warning} role="alert">{error}</p>}

      <h3 className={css.subheading}>{t('dev.editor')}</h3>
      <div className={css.row}>
        <Tag tone={editor.connected ? 'success' : 'quiet'}>{editor.connected ? t('dev.connected') : t('dev.disconnected')}</Tag>
        <span className={css.grow}>
          {editor.activeFile === undefined ? (editor.name ?? t('dev.noEditor')) : `${editor.name ?? ''} — ${editor.activeFile}`}
        </span>
        {editor.lastSeen !== undefined && <span className={css.muted}>{ago(editor.lastSeen)}</span>}
      </div>
      {editor.problems > 0 && <p className={css.muted}>{t('dev.problems', { count: editor.problems })}</p>}
      <ul className={css.list}>
        {extensions.map(extension => (
          <li className={css.listRow} key={extension.editor}>
            <Tag tone={extension.installed ? 'success' : 'quiet'}>{t(`dev.editor.${extension.editor}`)}</Tag>
            <span className={css.grow}>
              {!extension.available ? t('dev.notInstalledApp') : extension.installed ? t('dev.installed', { version: extension.version ?? '' }) : t('dev.notInstalled')}
            </span>
            {extension.available && (
              <Button disabled={busy !== undefined} onClick={() => { void install(extension.editor) }}>
                {busy === extension.editor ? t('dev.installing') : extension.installed ? t('dev.reinstall') : t('dev.install')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {note !== undefined && <p className={css.muted}>{note}</p>}
      <p className={css.muted}>{t('dev.howTo')}</p>

      <h3 className={css.subheading}>{t('dev.context')}</h3>
      <p className={css.muted}>
        {index === undefined ? t('dev.noIndex') : t('dev.index', { root: index.root, files: index.files })}
      </p>
      <ul className={css.list}>
        <li className={css.listRow}><span className={css.grow}>{t('dev.compact')}</span><span className={css.muted}>{context.compactAt}</span></li>
        <li className={css.listRow}><span className={css.grow}>{t('dev.spill')}</span><span className={css.muted}>{context.spillAbove}</span></li>
        <li className={css.listRow}><span className={css.grow}>{t('dev.prune')}</span><span className={css.muted}>{context.prunedAbove}</span></li>
        <li className={css.listRow}><span className={css.grow}>{t('dev.repoMaps')}</span><span className={css.muted}>{counters.repoMaps}</span></li>
      </ul>

      <h3 className={css.subheading}>{t('dev.reliability')}</h3>
      <ul className={css.list}>
        <li className={css.listRow}><span className={css.grow}>{t('dev.syntax')}</span><span className={css.muted}>{t('dev.syntaxCount', { checks: counters.syntaxChecks, failures: counters.syntaxFailures })}</span></li>
        <li className={css.listRow}><span className={css.grow}>{t('dev.pathHints')}</span><span className={css.muted}>{counters.pathHints}</span></li>
        <li className={css.listRow}><span className={css.grow}>{t('dev.loopStops')}</span><span className={css.muted}>{counters.loopStops}</span></li>
        <li className={css.listRow}><span className={css.grow}>{t('dev.jsonHints')}</span><span className={css.muted}>{counters.jsonHints}</span></li>
      </ul>

      <h3 className={css.subheading}>{t('dev.speed')}</h3>
      <p className={css.muted}>
        {warm.origins.length === 0 ? t('dev.noOrigins') : t('dev.origins', { origins: warm.origins.join(', ') })}
      </p>
      <p className={css.muted}>
        {t('dev.warmups', { count: counters.warmups })}
        {counters.lastWarmMs === undefined ? '' : ` ${t('dev.lastWarm', { ms: counters.lastWarmMs })}`}
      </p>
    </div>
  )
}
