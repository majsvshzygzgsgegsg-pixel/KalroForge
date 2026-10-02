/** The Agents page: Lead plus every persistent main agent, with lifecycle actions and the create form. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, Checkbox, IconArchiveOutlineRegular, IconCopyOutlineRegular, IconEditOutlineRegular, IconPauseOutlineRegular,
  IconPlayOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Input, Modal, RiskConfirmation, SegmentedTabs, StateDot,
  Switch, Tag, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  cloneAgent, createAgent, editAgent, loadState, runAction, saveAdministratorModes,
  type AgentAction, type AgentDraft, type AgentView, type AgentsState,
} from './api.ts'
import { AgentDashboard } from './AgentDashboard.tsx'
import { AgentEditor } from './AgentEditor.tsx'
import { modeLabel } from './labels.ts'
import { loadOrchestration, type Notification, type OrchestrationState } from './orchestration-api.ts'
import { BackgroundView, CheckpointsView, OrchestrationView } from './OrchestrationViews.tsx'
import css from './AgentsPage.module.css'

/** Polling interval for status changes made by agents or other windows. */
const REFRESH_MS = 4000
const DEFAULT_MODE = 'standard'
const TOAST_MS = 5000

/** Tabs of the page. */
type View = 'agents' | 'orchestration' | 'background' | 'checkpoints'
const VIEWS = ['agents', 'orchestration', 'background', 'checkpoints'] as const

/** Navigation the page borrows from the workspace UI. */
export interface AgentsInjected {
  /** Show one Session's conversation. */
  readonly openSession: (sessionId: string) => void
  /** Start a new Lead chat. */
  readonly startSession: () => void
}

/** Props of the main-panel page. */
export type AgentsPageProps = PropsRuntime<'main'> & InjectFace<AgentsInjected> & PropsLocale<'mainAgents.page'>

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function dotState(agent: AgentView): StateDotState {
  if (agent.status === 'archived') return 'warning'
  if (agent.status === 'stopped') return 'idle'
  return agent.runtime === 'busy' ? 'ongoing' : 'done'
}

/**
 * Render the Agents page.
 * @param props - navigation callbacks and localized copy.
 * @returns the page.
 */
export function AgentsPage({ openSession, startSession, t }: AgentsPageProps) {
  const [state, setState] = useState<AgentsState | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [actionError, setActionError] = useState<string | undefined>()
  const [archived, setArchived] = useState(false)
  const [busy, setBusy] = useState<string | undefined>()
  const [editor, setEditor] = useState<{ readonly agent: AgentView | undefined } | undefined>()
  const [cloning, setCloning] = useState<AgentView | undefined>()
  const [cloneName, setCloneName] = useState('')
  const [archiving, setArchiving] = useState<AgentView | undefined>()
  const [acknowledged, setAcknowledged] = useState(false)
  const [view, setView] = useState<View>('agents')
  const [orchestration, setOrchestration] = useState<OrchestrationState | undefined>()
  const [dashboard, setDashboard] = useState<string | undefined>()
  const [toasts, setToasts] = useState<readonly Notification[]>([])
  const seen = useRef<Set<string> | undefined>(undefined)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++generation.current
    // Orchestration may be disabled in config; the Agents tab works without it.
    const [registry, orchestrated] = await Promise.allSettled([loadState(archived), loadOrchestration()])
    if (mine !== generation.current) return
    if (registry.status === 'fulfilled') {
      setState(registry.value)
      setLoadError(undefined)
    } else {
      setLoadError(errorText(registry.reason))
    }
    if (orchestrated.status === 'rejected') {
      setOrchestration(undefined)
      return
    }
    setOrchestration(orchestrated.value)
    const notices = orchestrated.value.notifications
    if (seen.current === undefined) {
      seen.current = new Set(notices.map(notice => notice.id))
      return
    }
    const known = seen.current
    const fresh = notices.filter(notice => !known.has(notice.id)).toReversed()
    for (const notice of fresh) known.add(notice.id)
    if (fresh.length > 0) setToasts(queue => [...queue, ...fresh].slice(-5))
  }, [archived])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

  const act = async (key: string, operation: () => Promise<unknown>) => {
    setBusy(key)
    setActionError(undefined)
    try {
      await operation()
    } catch (error) {
      setActionError(t('error.generic', { message: errorText(error) }))
    } finally {
      setBusy(undefined)
      await refresh()
    }
  }

  const lifecycle = (agent: AgentView, action: AgentAction) => act(`${agent.id}:${action}`, () => runAction(agent.id, action))

  const submitEditor = async (draft: AgentDraft) => {
    const agent = editor?.agent
    await (agent === undefined ? createAgent(draft) : editAgent(agent, draft))
    setEditor(undefined)
    await refresh()
  }

  const toggleAdminMode = (mode: string, enabled: boolean) => {
    const modes = state?.settings.administratorModes ?? []
    const next = enabled ? [...new Set([...modes, mode])] : modes.filter(entry => entry !== mode)
    void act(`settings:${mode}`, () => saveAdministratorModes(next))
  }

  const modeName = (id: string) => modeLabel(id, state?.options.modes.find(mode => mode.id === id)?.name ?? id, t)
  const presetName = (value: string) => state?.options.permissionPresets.find(option => option.value === value)?.name ?? value
  const modelName = (agent: AgentView) => {
    if (agent.model === undefined) return t('tag.defaultModel')
    const group = state?.options.models.find(entry => entry.provider === agent.model?.provider)
    return group?.models.find(entry => entry.id === agent.model?.model)?.name ?? `${agent.model.provider}/${agent.model.model}`
  }

  const tabProps = (current: OrchestrationState, registry: AgentsState) => ({
    state: current,
    agents: registry.agents,
    t,
    busy: busy !== undefined,
    act,
    openSession,
    openDashboard: setDashboard,
  })

  const actionButton = (agent: AgentView, label: string, icon: ReactNode, onClick: () => void, disabled = false) => (
    <Button
      size="sm"
      variant="ghost"
      icon={icon}
      aria-label={t('action.label', { action: label, name: agent.name })}
      disabled={disabled || busy !== undefined}
      onClick={onClick}
    >
      {label}
    </Button>
  )

  return (
    <div className={css.page}>
      <div className={css.scroll}>
        <div className={css.content}>
          <header className={css.header}>
            <div className={css.heading}>
              <h1 className={css.title}>{t('page.title')}</h1>
              <p className={css.subtitle}>{t('page.subtitle')}</p>
            </div>
            <Button variant="primary" icon={<IconPlusOutlineRegular size={16} />} onClick={() => { setEditor({ agent: undefined }) }}>
              {t('page.create')}
            </Button>
          </header>

          {orchestration !== undefined && (
            <SegmentedTabs<View>
              label={t('tabs.label')}
              value={view}
              onChange={setView}
              items={[
                { value: 'agents', label: t('tabs.agents'), id: 'main-agents-tab-agents', panelId: 'main-agents-panel-agents' },
                ...VIEWS.slice(1).map(value => ({ value, label: t(`tabs.${value}`), id: `main-agents-tab-${value}`, panelId: `main-agents-panel-${value}` })),
              ]}
            />
          )}

          {actionError !== undefined && <p className={css.error} role="alert">{actionError}</p>}

          {orchestration !== undefined && state !== undefined && view !== 'agents' && (
            <div id={`main-agents-panel-${view}`} role="tabpanel" aria-labelledby={`main-agents-tab-${view}`}>
              {view === 'orchestration' && (
                <OrchestrationView {...tabProps(orchestration, state)} models={state.options.models} />
              )}
              {view === 'background' && <BackgroundView {...tabProps(orchestration, state)} />}
              {view === 'checkpoints' && <CheckpointsView {...tabProps(orchestration, state)} />}
            </div>
          )}

          {(orchestration === undefined || view === 'agents') && (
            <div id="main-agents-panel-agents" role="tabpanel" aria-labelledby="main-agents-tab-agents" className={css.panelBody}>
              <section className={css.card}>
                <div className={css.cardHead}>
                  <StateDot state="done" />
                  <span className={css.agentName}>{t('lead.name')}</span>
                  <span className={css.spacer} />
                  <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={14} />} onClick={startSession}>{t('lead.newChat')}</Button>
                </div>
                <p className={css.description}>{t('lead.description')}</p>
                {state !== undefined && state.options.modes.length > 0 && (
                  <div className={css.adminBox}>
                    <span className={css.fieldLabel}>{t('admin.title')}</span>
                    <span className={css.hint}>{t('admin.description')}</span>
                    <div className={css.adminModes}>
                      {state.options.modes.map(mode => (
                        <Checkbox
                          key={mode.id}
                          label={modeName(mode.id)}
                          checked={state.settings.administratorModes.includes(mode.id)}
                          disabled={busy !== undefined}
                          onChange={(next) => { toggleAdminMode(mode.id, next) }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <div className={css.toolbar}>
                <label className={css.switchLabel}>
                  <span>{t('page.showArchived')}</span>
                  <Switch checked={archived} onChange={setArchived} label={t('page.showArchived')} />
                </label>
              </div>

              {state === undefined && loadError === undefined && <p className={css.muted}>{t('page.loading')}</p>}
              {loadError !== undefined && (
                <div className={css.error} role="alert">
                  {t('page.loadError', { message: loadError })}
                  <Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('page.retry')}</Button>
                </div>
              )}
              {state !== undefined && state.agents.length === 0 && <p className={css.muted}>{t('page.empty')}</p>}

              <ul className={css.list}>
                {state?.agents.map(agent => (
                  <li key={agent.id} className={css.card}>
                    <div className={css.cardHead}>
                      <StateDot state={dotState(agent)} />
                      <span className={css.agentName}>{agent.name}</span>
                      <span className={css.muted}>
                        {t(`status.${agent.status}`)}
                        {agent.status === 'running' ? ` · ${t(`runtime.${agent.runtime}`)}` : ''}
                      </span>
                      <span className={css.spacer} />
                      {agent.status !== 'archived' && agent.sessionId !== undefined && (
                        <Button size="sm" variant="outline" onClick={() => { if (agent.sessionId !== undefined) openSession(agent.sessionId) }}>
                          {t('action.open')}
                        </Button>
                      )}
                    </div>
                    {agent.description !== '' && <p className={css.description}>{agent.description}</p>}
                    <div className={css.tags}>
                      <Tag>{modeName(agent.mode)}</Tag>
                      <Tag>{modelName(agent)}</Tag>
                      <Tag>{presetName(agent.permissions.preset)}</Tag>
                      {agent.permissions.agentAdministration && <Tag tone="info">{t('tag.admin')}</Tag>}
                      {agent.workspace !== undefined && <Tag>{t('tag.workspace', { path: agent.workspace })}</Tag>}
                      {(agent.tools.allow.length > 0 || agent.tools.deny.length > 0) && <Tag>{t('tag.tools')}</Tag>}
                    </div>
                    <div className={css.actions}>
                      {agent.status === 'archived'
                        ? actionButton(agent, t('action.restore'), <IconPlayOutlineRegular size={14} />, () => { void lifecycle(agent, 'start') })
                        : (
                          <>
                            {agent.status === 'running'
                              ? actionButton(agent, t('action.stop'), <IconPauseOutlineRegular size={14} />, () => { void lifecycle(agent, 'stop') })
                              : actionButton(agent, t('action.start'), <IconPlayOutlineRegular size={14} />, () => { void lifecycle(agent, 'start') })}
                            {actionButton(agent, t('action.restart'), <IconRefreshOutlineRegular size={14} />, () => { void lifecycle(agent, 'restart') })}
                            {actionButton(agent, t('action.edit'), <IconEditOutlineRegular size={14} />, () => { setEditor({ agent }) })}
                            {actionButton(agent, t('action.clone'), <IconCopyOutlineRegular size={14} />, () => { setCloneName(''); setCloning(agent) })}
                            {actionButton(agent, t('action.archive'), <IconArchiveOutlineRegular size={14} />, () => { setAcknowledged(false); setArchiving(agent) })}
                          </>
                        )}
                      {orchestration !== undefined && (
                        <>
                          <span className={css.spacer} />
                          {actionButton(agent, t('action.activity'), undefined, () => { setDashboard(agent.id) })}
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <AgentDashboard
        agentId={dashboard}
        t={t}
        modeName={modeName}
        presetName={presetName}
        openSession={(sessionId) => { setDashboard(undefined); openSession(sessionId) }}
        onClose={() => { setDashboard(undefined) }}
      />

      {toasts[0] !== undefined && (
        <Toast
          key={toasts[0].id}
          text={toasts[0].text}
          {...toasts[0].level === 'success' ? { tone: 'success' as const } : {}}
          holdMs={TOAST_MS}
          onDone={() => { setToasts(queue => queue.slice(1)) }}
        />
      )}

      {state !== undefined && (
        <AgentEditor
          open={editor !== undefined}
          agent={editor?.agent}
          options={state.options}
          defaultMode={DEFAULT_MODE}
          t={t}
          onClose={() => { setEditor(undefined) }}
          onSubmit={submitEditor}
        />
      )}

      <Modal
        open={cloning !== undefined}
        onClose={() => { setCloning(undefined) }}
        title={t('clone.title', { name: cloning?.name ?? '' })}
        closeLabel={t('form.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCloning(undefined) }}>{t('form.cancel')}</Button>
            <Button
              variant="primary"
              disabled={cloneName.trim() === '' || busy !== undefined}
              onClick={() => {
                const source = cloning
                setCloning(undefined)
                if (source !== undefined) void act(`${source.id}:clone`, () => cloneAgent(source.id, cloneName.trim()))
              }}
            >
              {t('clone.confirm')}
            </Button>
          </>
        )}
      >
        <div className={css.form}>
          <label className={css.fieldLabel} htmlFor="main-agents-clone-name">{t('clone.name')}</label>
          <Input id="main-agents-clone-name" value={cloneName} onChange={(event) => { setCloneName(event.target.value) }} />
        </div>
      </Modal>

      <RiskConfirmation
        open={archiving !== undefined}
        title={t('archive.title', { name: archiving?.name ?? '' })}
        description={t('archive.description')}
        acknowledgeLabel={t('archive.acknowledge')}
        cancelLabel={t('form.cancel')}
        closeLabel={t('form.close')}
        confirmLabel={t('archive.confirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setArchiving(undefined) }}
        onConfirm={() => {
          const target = archiving
          setArchiving(undefined)
          if (target !== undefined) void lifecycle(target, 'archive')
        }}
      />
    </div>
  )
}
