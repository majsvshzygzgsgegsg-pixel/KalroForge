/**
 * The Command Center: the galaxy HUD on top and eleven sections (overview,
 * active tasks, agents, projects, workflows, background tasks, memory, Life
 * OS, activity, tools, settings) in a vertical tab list.
 */
import { useCallback, useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { api, type Overview } from './api.ts'
import { AgentsSection } from './AgentsSection.tsx'
import { errorText } from './format.ts'
import { GalaxyHud } from './GalaxyHud.tsx'
import { LifeSection } from './LifeSection.tsx'
import { MemorySection } from './MemorySection.tsx'
import { ProjectsSection } from './ProjectsSection.tsx'
import { ActivitySection, BackgroundSection, OverviewSection, TasksSection, ToolsSection, WorkflowsSection } from './sections.tsx'
import { SettingsSection } from './SettingsSection.tsx'
import type { LiveSnapshot, LiveStore, Observable } from './store.ts'
import type { NS } from './locales.ts'
import css from './CommandCenter.module.css'

/** Sections in display order. */
export const SECTIONS = ['overview', 'tasks', 'agents', 'projects', 'workflows', 'background', 'memory', 'life', 'activity', 'tools', 'settings'] as const

/** One section. */
export type Section = typeof SECTIONS[number]

const OVERVIEW_MS = 3000

/** What the page receives from the plugin. */
export interface CommandCenterInjected {
  readonly hooks: { readonly live: Observable<LiveSnapshot> }
  readonly store: LiveStore
  /** Open the Agents page (create/edit agents, model routing). */
  readonly openAgents: () => void
  /** Leave the panel and show one Session's chat. */
  readonly openSession: (sessionId: string) => void
}

/** Full props. */
export type CommandCenterProps = PropsRuntime<'main'> & InjectFace<CommandCenterInjected> & PropsLocale<typeof NS>

/**
 * Render the Command Center.
 * @param props - live store, navigation, and copy.
 * @returns the page.
 */
export function CommandCenter({ useLive, store, openAgents, openSession, t }: CommandCenterProps) {
  const live = useLive(snapshot => snapshot)
  const [section, setSection] = useState<Section>('overview')
  const [overview, setOverview] = useState<Overview | undefined>()
  const [error, setError] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    try {
      setOverview(await api.overview())
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, OVERVIEW_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

  const props = overview === undefined ? undefined : { overview, t, refresh: () => { void refresh(); void store.refresh() } }

  return (
    <div className={css.page}>
      <div className={css.scroll}>
        <div className={css.content}>
          <header className={css.header}>
            <h1 className={css.title}>{t('page.title')}</h1>
            <p className={css.muted}>{t('page.subtitle')}</p>
          </header>
          <GalaxyHud live={live} store={store} t={t} openSession={openSession} assistantName={overview?.personality.name ?? 'KairoForge'} />
          {error !== undefined && <p className={css.warning} role="alert">{t('page.loadError', { message: error })}</p>}
          <div className={css.layout}>
            <nav className={css.nav} role="tablist" aria-orientation="vertical" aria-label={t('nav.label')}>
              {SECTIONS.map(value => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  id={`personal-ai-tab-${value}`}
                  aria-controls={`personal-ai-panel-${value}`}
                  aria-selected={section === value}
                  className={css.navItem}
                  onClick={() => { setSection(value) }}
                >
                  {t(`nav.${value}`)}
                </button>
              ))}
            </nav>
            <section className={css.panel} id={`personal-ai-panel-${section}`} role="tabpanel" aria-labelledby={`personal-ai-tab-${section}`}>
              <h2 className={css.panelTitle}>{t(`nav.${section}`)}</h2>
              {props === undefined && section !== 'memory' && section !== 'projects' && section !== 'agents' && section !== 'settings' && section !== 'life'
                ? <p className={css.muted}>{t('page.loading')}</p>
                : (
                  <>
                    {section === 'overview' && props !== undefined && <OverviewSection {...props} />}
                    {section === 'tasks' && props !== undefined && <TasksSection {...props} />}
                    {section === 'workflows' && props !== undefined && <WorkflowsSection {...props} />}
                    {section === 'background' && props !== undefined && <BackgroundSection {...props} />}
                    {section === 'activity' && props !== undefined && <ActivitySection {...props} />}
                    {section === 'tools' && props !== undefined && <ToolsSection {...props} />}
                    {section === 'agents' && <AgentsSection t={t} openAgents={openAgents} />}
                    {section === 'projects' && <ProjectsSection t={t} />}
                    {section === 'memory' && <MemorySection t={t} />}
                    {section === 'life' && <LifeSection t={t} />}
                    {section === 'settings' && <SettingsSection t={t} store={store} openAgents={openAgents} />}
                  </>
                )}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
