/**
 * Life OS: the switches and state of KairoForge's proactive layer — the
 * Vault, the local brain and knowledge graph, the senses (focus, clipboard,
 * notifications, routines), self-healing, self-written tools, Air-Gap mode,
 * and the phone companion. Every sense is off until the user turns it on.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type BrainHit, type LifeSettings, type LifeStatus } from './api.ts'
import { ago, errorText } from './format.ts'
import type { Translate } from './locales.ts'
import css from './CommandCenter.module.css'

const GROW = css.grow ?? ''
const REFRESH_MS = 4000

interface ToggleProps {
  readonly checked: boolean
  readonly label: string
  readonly onChange: (next: boolean) => void
}

function Toggle({ checked, label, onChange }: ToggleProps) {
  return (
    <div className={css.row}>
      <Switch checked={checked} label={label} onChange={onChange} />
      <span aria-hidden="true">{label}</span>
    </div>
  )
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

function words(value: string): string[] {
  return value.split(',').map(word => word.trim()).filter(word => word !== '')
}

/**
 * Render the Life OS section.
 * @param props - copy.
 * @returns the section.
 */
export function LifeSection({ t }: { readonly t: Translate }) {
  const [status, setStatus] = useState<LifeStatus | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [root, setRoot] = useState('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<readonly BrainHit[] | undefined>()
  const [link, setLink] = useState({ from: '', relation: '', to: '' })
  const [rules, setRules] = useState<{ vips: string; urgent: string; muted: string } | undefined>()
  const [model, setModel] = useState<{ provider: string; model: string } | undefined>()

  const load = useCallback(async () => {
    try {
      const next = await api.life()
      setStatus(next)
      setError(undefined)
      setRules(current => current ?? {
        vips: next.settings.vips.join(', '), urgent: next.settings.urgentWords.join(', '), muted: next.settings.mutedApps.join(', '),
      })
      setModel(current => current ?? next.settings.localModel ?? { provider: next.airGap.providers[0] ?? 'ollama', model: 'qwen2.5:7b' })
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [load])

  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation()
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
    await load()
  }
  const set = (changes: Partial<LifeSettings>): void => { void act(() => api.lifeSettings(changes)) }

  if (status === undefined) return <p className={css.muted}>{error ?? t('page.loading')}</p>
  const { settings, brain, senses, vault, airGap, phone } = status
  const phoneUrl = phone.lanUrl ?? `${location.origin}${phone.path}`

  return (
    <div className={css.section}>
      <p className={css.muted}>{t('life.subtitle')}</p>
      {error !== undefined && <p className={css.warning} role="alert">{error}</p>}

      <h3 className={css.subheading}>{t('life.vault')}</h3>
      <div className={css.row}>
        <Tag tone={vault.mode === 'secure-enclave' ? 'success' : vault.mode === 'file' ? 'warning' : 'danger'}>{t(`life.vault.${vault.mode}`)}</Tag>
        <span className={css.grow}>{vault.detail}</span>
        <span className={css.muted}>{t('life.vault.files', { count: vault.sealedFiles })}</span>
      </div>

      <h3 className={css.subheading}>{t('life.senses')}</h3>
      {!senses.supported && <p className={css.warning}>{t('life.senses.unsupported')}</p>}
      <Toggle checked={settings.focus} label={t('life.focus')} onChange={(next) => { set({ focus: next }) }} />
      <Toggle checked={settings.clipboard} label={t('life.clipboard')} onChange={(next) => { set({ clipboard: next }) }} />
      <Toggle checked={settings.notifications} label={t('life.notifications')} onChange={(next) => { set({ notifications: next }) }} />
      <label className={css.field}>
        <span>{t('life.stuckSeconds')}</span>
        <Input
          type="number"
          min={20}
          max={900}
          value={String(settings.stuckSeconds)}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isInteger(value) && value >= 20 && value <= 900) set({ stuckSeconds: value })
          }}
        />
      </label>
      <ul className={css.list}>
        {senses.front !== undefined && (
          <li className={css.listRow}>
            <Tag tone="quiet">{t('life.front')}</Tag>
            <span className={css.grow}>{`${senses.front.app ?? '?'}${senses.front.title === undefined ? '' : ` — ${senses.front.title}`}`}</span>
            <span className={css.muted}>{t('life.idle', { seconds: senses.front.idle ?? 0 })}</span>
          </li>
        )}
        {senses.clip !== undefined && (
          <li className={css.listRow}>
            <Tag tone="quiet">{t('life.clip')}</Tag>
            <span className={css.grow}>{senses.clip.insight.summary}</span>
            <span className={css.muted}>{ago(senses.clip.at)}</span>
          </li>
        )}
        {senses.offer !== undefined && (
          <li className={css.listRow}>
            <Tag tone="warning">{t('life.offer')}</Tag>
            <span className={css.grow}>{senses.offer.text}</span>
            <span className={css.muted}>{ago(senses.offer.at)}</span>
          </li>
        )}
      </ul>
      {senses.clipsIgnored > 0 && <p className={css.muted}>{t('life.clipsIgnored', { count: senses.clipsIgnored })}</p>}
      {senses.error !== undefined && <p className={css.warning}>{senses.error}</p>}

      <h3 className={css.subheading}>{t('life.routines')}</h3>
      <p className={css.muted}>{t('life.routinesHelp')}</p>
      {senses.routines.length === 0
        ? <p className={css.muted}>{t('life.routinesEmpty')}</p>
        : (
          <ul className={css.list}>
            {senses.routines.map(routine => (
              <li key={routine.id} className={css.listRow}>
                <Tag tone="outline">{clock(routine.minute)}</Tag>
                <span className={css.grow}>{routine.apps.join(', ')}</span>
                <span className={css.muted}>{t('life.routineDays', { count: routine.days })}</span>
                <Switch
                  checked={settings.approvedRoutines.includes(routine.id)}
                  label={t('life.routineApprove')}
                  onChange={(next) => { void act(() => api.lifeRoutine(routine.id, next)) }}
                />
              </li>
            ))}
          </ul>
        )}

      <h3 className={css.subheading}>{t('life.router')}</h3>
      <p className={css.muted}>{t('life.routerHelp')}</p>
      {rules !== undefined && (
        <form
          className={css.formGrid}
          onSubmit={(event) => {
            event.preventDefault()
            set({ vips: words(rules.vips), urgentWords: words(rules.urgent), mutedApps: words(rules.muted) })
          }}
        >
          <label className={css.field}><span>{t('life.vips')}</span><Input value={rules.vips} onChange={(event) => { setRules({ ...rules, vips: event.target.value }) }} /></label>
          <label className={css.field}><span>{t('life.urgentWords')}</span><Input value={rules.urgent} onChange={(event) => { setRules({ ...rules, urgent: event.target.value }) }} /></label>
          <label className={css.field}><span>{t('life.mutedApps')}</span><Input value={rules.muted} onChange={(event) => { setRules({ ...rules, muted: event.target.value }) }} /></label>
          <Button size="sm" variant="primary" type="submit">{t('common.save')}</Button>
        </form>
      )}
      {senses.notifications.error !== undefined && <p className={css.warning}>{t('life.notificationsError', { message: senses.notifications.error })}</p>}
      {senses.notifications.recent.length > 0 && (
        <ul className={css.list}>
          {senses.notifications.recent.slice(0, 12).map(item => (
            <li key={`${String(item.at)}-${item.summary}`} className={css.listRow}>
              <Tag tone={item.route === 'urgent' ? 'danger' : item.route === 'normal' ? 'outline' : 'quiet'}>{t(`life.route.${item.route}`)}</Tag>
              <span className={css.grow}>{item.summary}</span>
              <span className={css.muted}>{ago(new Date(item.at * 1000).toISOString())}</span>
            </li>
          ))}
        </ul>
      )}

      <h3 className={css.subheading}>{t('life.brain')}</h3>
      <p className={css.muted}>
        {t('life.brainStats', { documents: brain.documents, chunks: brain.chunks, entities: brain.graph.entities, relations: brain.graph.relations })}
        {brain.indexing && brain.progress !== undefined ? ` ${t('life.indexing', { root: brain.progress.root, seen: brain.progress.seen })}` : ''}
        {brain.skippedSensitive > 0 ? ` ${t('life.skipped', { count: brain.skippedSensitive })}` : ''}
      </p>
      {brain.error !== undefined && <p className={css.warning}>{brain.error}</p>}
      <ul className={css.list}>
        {settings.roots.map(path => (
          <li key={path} className={css.listRow}>
            <span className={`${css.grow} ${css.mono}`}>{path}</span>
            <Button size="sm" variant="ghost" onClick={() => { set({ roots: settings.roots.filter(item => item !== path) }) }}>{t('life.remove')}</Button>
          </li>
        ))}
      </ul>
      <form
        className={css.row}
        onSubmit={(event) => {
          event.preventDefault()
          if (root.trim() === '') return
          set({ roots: [...settings.roots, root.trim()] })
          setRoot('')
        }}
      >
        <Input className={GROW} value={root} placeholder={t('life.rootPlaceholder')} aria-label={t('life.addRoot')} onChange={(event) => { setRoot(event.target.value) }} />
        <Button size="sm" variant="primary" type="submit" disabled={root.trim() === ''}>{t('life.addRoot')}</Button>
        <Button size="sm" variant="ghost" onClick={() => { void act(() => api.lifeReindex()) }}>{t('life.reindex')}</Button>
      </form>
      <form
        className={css.row}
        onSubmit={(event) => {
          event.preventDefault()
          void api.lifeSearch(query).then((result) => { setHits(result.results) }, (failure: unknown) => { setError(errorText(failure)) })
        }}
      >
        <Input className={GROW} value={query} placeholder={t('life.searchPlaceholder')} aria-label={t('life.search')} onChange={(event) => { setQuery(event.target.value) }} />
        <Button size="sm" type="submit" disabled={query.trim() === ''}>{t('life.search')}</Button>
      </form>
      {hits !== undefined && (hits.length === 0
        ? <p className={css.muted}>{t('life.noHits')}</p>
        : (
          <ul className={css.list}>
            {hits.map(hit => (
              <li key={hit.doc} className={css.item}>
                <div className={`${css.mono} ${css.muted}`}>{`${hit.doc} · ${hit.score.toFixed(2)}`}</div>
                <div>{hit.snippet.slice(0, 400)}</div>
              </li>
            ))}
          </ul>
        ))}

      <h3 className={css.subheading}>{t('life.graph')}</h3>
      <form
        className={css.row}
        onSubmit={(event) => {
          event.preventDefault()
          void act(async () => {
            await api.lifeLink(link.from, link.relation, link.to)
            setLink({ from: '', relation: '', to: '' })
          })
        }}
      >
        <Input className={GROW} value={link.from} placeholder={t('life.linkFrom')} aria-label={t('life.linkFrom')} onChange={(event) => { setLink({ ...link, from: event.target.value }) }} />
        <Input value={link.relation} placeholder={t('life.linkRelation')} aria-label={t('life.linkRelation')} onChange={(event) => { setLink({ ...link, relation: event.target.value }) }} />
        <Input className={GROW} value={link.to} placeholder={t('life.linkTo')} aria-label={t('life.linkTo')} onChange={(event) => { setLink({ ...link, to: event.target.value }) }} />
        <Button size="sm" variant="primary" type="submit" disabled={link.from.trim() === '' || link.relation.trim() === '' || link.to.trim() === ''}>{t('life.link')}</Button>
      </form>
      {status.graph.length === 0
        ? <p className={css.muted}>{t('life.graphEmpty')}</p>
        : (
          <ul className={css.list}>
            {status.graph.map(fact => (
              <li key={`${fact.from}|${fact.relation}|${fact.to}`} className={css.listRow}>
                <span className={css.grow}>{fact.text}</span>
                <span className={css.muted}>{ago(fact.at)}</span>
                <Button size="sm" variant="ghost" onClick={() => { void act(() => api.lifeUnlink(fact.from, fact.to)) }}>{t('life.remove')}</Button>
              </li>
            ))}
          </ul>
        )}

      <h3 className={css.subheading}>{t('life.healing')}</h3>
      <Toggle checked={settings.healing} label={t('life.healingToggle')} onChange={(next) => { set({ healing: next }) }} />
      {status.healing.length > 0 && (
        <ul className={css.list}>
          {status.healing.slice(0, 10).map(step => (
            <li key={step.id} className={css.listRow}>
              <Tag tone="outline">{step.kind}</Tag>
              <span className={css.grow}>{`${step.id} — ${step.note}`}</span>
              <span className={css.muted}>{ago(step.at)}</span>
            </li>
          ))}
        </ul>
      )}

      <h3 className={css.subheading}>{t('life.tools')}</h3>
      {status.tools.length === 0
        ? <p className={css.muted}>{t('life.toolsEmpty')}</p>
        : (
          <ul className={css.list}>
            {status.tools.map(tool => (
              <li key={tool.name} className={css.listRow}>
                <Tag tone="outline">{tool.language}</Tag>
                <span className={css.mono}>{`user_tool__${tool.name}`}</span>
                <span className={css.grow}>{tool.description}</span>
                {tool.reachesNetwork && <Tag tone="warning">{t('life.network')}</Tag>}
                <Button size="sm" variant="ghost" onClick={() => { void act(() => api.lifeDeleteTool(tool.name)) }}>{t('life.remove')}</Button>
              </li>
            ))}
          </ul>
        )}

      <h3 className={css.subheading}>{t('life.airGap')}</h3>
      <Toggle checked={settings.airGap} label={t('life.airGapToggle')} onChange={(next) => { set({ airGap: next }) }} />
      <p className={airGap.on && !airGap.ready ? css.warning : css.muted}>{airGap.detail}</p>
      {model !== undefined && (
        <form
          className={css.row}
          onSubmit={(event) => {
            event.preventDefault()
            set({ localModel: model })
          }}
        >
          <select className={css.select} value={model.provider} aria-label={t('life.localProvider')} onChange={(event) => { setModel({ ...model, provider: event.target.value }) }}>
            {[...new Set([model.provider, ...airGap.providers])].map(provider => (
              <option key={provider} value={provider}>{provider}</option>
            ))}
          </select>
          <Input className={GROW} value={model.model} aria-label={t('life.localModel')} placeholder="qwen2.5:7b" onChange={(event) => { setModel({ ...model, model: event.target.value }) }} />
          <Button size="sm" type="submit">{t('life.useLocalModel')}</Button>
        </form>
      )}

      <h3 className={css.subheading}>{t('life.phone')}</h3>
      <p className={css.muted}>{t('life.phoneHelp')}</p>
      <div className={css.row}>
        <a className={`${css.mono} ${css.grow}`} href={phone.path} target="_blank" rel="noreferrer">{phoneUrl}</a>
      </div>
      <Toggle checked={settings.lan} label={t('life.lan')} onChange={(next) => { set({ lan: next }) }} />
    </div>
  )
}
