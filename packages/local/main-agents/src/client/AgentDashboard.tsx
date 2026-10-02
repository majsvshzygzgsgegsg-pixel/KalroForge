/** One main agent's activity dashboard, rendered in a modal and refreshed while open. */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Modal, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { duration, shortTime, statusDot, statusTone, tokens } from './format.ts'
import {
  cancelWorkflow, loadDashboard, MODEL_CATEGORIES, retryTask, setAgentRouting,
  type AgentDashboard as Dashboard, type AgentRouting, type WorkItem,
} from './orchestration-api.ts'
import { WorkflowGraph } from './WorkflowGraph.tsx'
import css from './Orchestration.module.css'

const REFRESH_MS = 3000

/** Props for {@link AgentDashboard}. */
export interface AgentDashboardProps {
  /** Agent to show; undefined closes the modal. */
  readonly agentId: string | undefined
  readonly t: TranslateNS<'mainAgents.page'>
  /** Display name for a mode id. */
  readonly modeName: (id: string) => string
  /** Display name for a permission preset. */
  readonly presetName: (value: string) => string
  readonly openSession: (sessionId: string) => void
  readonly onClose: () => void
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className={css.fact}>
      <span className={css.factLabel}>{label}</span>
      <span className={css.factValue}>{children}</span>
    </div>
  )
}

function Section({ title, count, open = false, children }: {
  readonly title: string
  readonly count?: number
  readonly open?: boolean
  readonly children: ReactNode
}) {
  return (
    <details className={css.section} open={open}>
      <summary className={css.sectionTitle}>
        {title}
        {count !== undefined && <span className={css.count}>{count}</span>}
      </summary>
      <div className={css.sectionBody}>{children}</div>
    </details>
  )
}

/**
 * Render the dashboard.
 * @param props - agent id, copy, and navigation.
 * @returns the modal.
 */
export function AgentDashboard({ agentId, t, modeName, presetName, openSession, onClose }: AgentDashboardProps) {
  const [data, setData] = useState<Dashboard | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (agentId === undefined) return
    try {
      setData(await loadDashboard(agentId))
      setError(undefined)
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [agentId])

  useEffect(() => {
    setData(undefined)
    if (agentId === undefined) return
    void refresh()
    const timer = setInterval(() => { void refresh() }, REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [agentId, refresh])

  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await operation()
      setError(undefined)
    } catch (cause) {
      setError(t('error.generic', { message: errorText(cause) }))
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const workList = (items: readonly WorkItem[]) => items.length === 0
    ? <p className={css.muted}>{t('dash.none')}</p>
    : (
      <ul className={css.rows}>
        {items.map(item => (
          <li key={item.id} className={css.rowHead}>
            <StateDot state={statusDot(item.status)} size={10} />
            <Tag tone="quiet">{t(`work.kind.${item.kind}`)}</Tag>
            <span className={css.ellipsis}>{item.title}</span>
            <span className={css.spacer} />
            <span className={css.muted}>{shortTime(item.at)}</span>
          </li>
        ))}
      </ul>
    )

  const agent = data?.agent
  const live = data?.live
  const contextPercent = live?.contextTokens !== undefined && live.contextWindow !== undefined && live.contextWindow > 0
    ? Math.min(100, Math.round(live.contextTokens / live.contextWindow * 100))
    : undefined

  return (
    <Modal
      open={agentId !== undefined}
      onClose={onClose}
      title={agent === undefined ? t('dash.title') : t('dash.titleFor', { name: agent.name })}
      closeLabel={t('form.close')}
      className={css.dashModal ?? ''}
      contentClassName={css.dashContent ?? ''}
    >
      {error !== undefined && <p className={css.errorText} role="alert">{error}</p>}
      {data === undefined || agent === undefined || live === undefined
        ? error === undefined && <p className={css.muted}>{t('page.loading')}</p>
        : (
          <div className={css.dash}>
            <div className={css.facts}>
              <Fact label={t('dash.status')}>
                <StateDot state={live.status === 'busy' ? 'ongoing' : agent.status === 'running' ? 'done' : 'idle'} size={10} />
                {' '}{t(`status.${agent.status}`)} · {t(`runtime.${live.status}`)}
              </Fact>
              <Fact label={t('dash.task')}>{live.currentTask ?? t('dash.noTask')}</Fact>
              <Fact label={t('dash.session')}>
                {agent.sessionId === undefined
                  ? t('dash.none')
                  : (
                    <Button size="sm" variant="ghost" onClick={() => { if (agent.sessionId !== undefined) openSession(agent.sessionId) }}>
                      {agent.sessionId.slice(-12)}
                    </Button>
                  )}
              </Fact>
              <Fact label={t('dash.model')}>
                {live.model === undefined ? t('tag.defaultModel') : `${live.provider ?? ''}/${live.model}`}
              </Fact>
              <Fact label={t('dash.mode')}>{modeName(agent.mode)}{data.template === undefined ? '' : ` · ${data.template}`}</Fact>
              <Fact label={t('dash.workspace')}>{live.cwd ?? agent.workspace ?? t('dash.defaultWorkspace')}</Fact>
              <Fact label={t('dash.permissions')}>
                {presetName(agent.permissions.preset)}
                {agent.permissions.agentAdministration ? ` · ${t('tag.admin')}` : ''}
              </Fact>
              <Fact label={t('dash.runtime')}>
                {duration(live.runtimeMs)} · {t('dash.steps', { steps: live.steps, calls: live.toolCalls })}
              </Fact>
              <Fact label={t('dash.context')}>
                {live.contextTokens === undefined
                  ? t('dash.none')
                  : (
                    <span className={css.meterRow}>
                      <span className={css.meter} aria-hidden="true">
                        <span className={css.meterFill} style={{ width: `${contextPercent ?? 0}%` }} />
                      </span>
                      {live.contextWindow === undefined
                        ? tokens(live.contextTokens)
                        : `${tokens(live.contextTokens)} / ${tokens(live.contextWindow)}`}
                    </span>
                  )}
              </Fact>
            </div>

            <div className={css.routingRow}>
              <label className={css.fieldLabel} htmlFor="main-agents-dash-routing">{t('dash.routing')}</label>
              <select
                id="main-agents-dash-routing"
                className={css.select}
                value={data.routing}
                disabled={busy}
                onChange={(event) => {
                  const routing = event.target.value as AgentRouting
                  void act(() => setAgentRouting(agent.id, routing))
                }}
              >
                <option value="auto">{t('routing.auto')}</option>
                <option value="off">{t('routing.off')}</option>
                {MODEL_CATEGORIES.map(category => <option key={category} value={category}>{t(`category.${category}`)}</option>)}
              </select>
              {data.route !== undefined && (
                <span className={css.muted}>
                  {t('dash.lastRoute', { category: t(`category.${data.route.category}`), model: data.route.model, reason: data.route.reason })}
                </span>
              )}
            </div>

            <div className={css.workCounts}>
              {(['queued', 'running', 'completed', 'failed'] as const).map(bucket => (
                <Tag key={bucket} tone={statusTone(bucket === 'queued' ? 'queued' : bucket)}>
                  {t(`work.${bucket}`, { n: data.work[bucket].length })}
                </Tag>
              ))}
            </div>

            <Section title={t('dash.work')} open={data.work.running.length > 0}>
              {(['running', 'queued', 'failed', 'completed'] as const).filter(bucket => data.work[bucket].length > 0).map(bucket => (
                <div key={bucket}>
                  <span className={css.factLabel}>{t(`work.${bucket}`, { n: data.work[bucket].length })}</span>
                  {workList(data.work[bucket])}
                </div>
              ))}
              {Object.values(data.work).every(items => items.length === 0) && <p className={css.muted}>{t('dash.none')}</p>}
            </Section>

            <Section title={t('dash.subAgents')} count={data.subAgents.length} open={data.subAgents.length > 0}>
              {data.subAgents.length === 0
                ? <p className={css.muted}>{t('dash.none')}</p>
                : (
                  <ul className={css.rows}>
                    {data.subAgents.map(member => (
                      <li key={member.sessionId} className={css.rowHead}>
                        <StateDot state={statusDot(member.status)} size={10} />
                        <span className={css.strong}>{member.name}</span>
                        <span className={css.ellipsis}>{member.description ?? ''}</span>
                        <span className={css.spacer} />
                        <Button size="sm" variant="ghost" onClick={() => { openSession(member.sessionId) }}>{t('action.open')}</Button>
                      </li>
                    ))}
                  </ul>
                )}
            </Section>

            <Section title={t('dash.workflows')} count={data.workflows.length} open={data.workflows.some(item => item.status === 'running')}>
              {data.workflows.length === 0
                ? <p className={css.muted}>{t('dash.none')}</p>
                : data.workflows.map(workflow => (
                  <WorkflowGraph
                    key={workflow.id}
                    workflow={workflow}
                    t={t}
                    busy={busy}
                    onCancel={(item) => { void act(() => cancelWorkflow(item.id)) }}
                    onRetry={(item, taskId) => { void act(() => retryTask(item.id, taskId)) }}
                  />
                ))}
            </Section>

            <Section title={t('dash.tools')} count={data.recentTools.length}>
              {data.recentTools.length === 0
                ? <p className={css.muted}>{t('dash.none')}</p>
                : (
                  <ul className={css.rows}>
                    {data.recentTools.map(call => (
                      <li key={`${call.at}:${call.name}`} className={css.rowHead}>
                        <StateDot state={call.ok ? 'done' : 'error'} size={10} />
                        <code className={css.code}>{call.name}</code>
                        <span className={css.ellipsis} title={call.error}>{call.error ?? call.summary}</span>
                        <span className={css.spacer} />
                        <span className={css.muted}>{shortTime(call.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              {live.tools.length > 0 && (
                <p className={css.muted}>{t('dash.available', { n: live.tools.length })}: {live.tools.join(', ')}</p>
              )}
            </Section>

            <Section title={t('dash.checkpoints')} count={data.checkpoints.length}>
              {data.checkpoints.length === 0
                ? <p className={css.muted}>{t('dash.none')}</p>
                : (
                  <ul className={css.rows}>
                    {data.checkpoints.map(row => (
                      <li key={row.id} className={css.rowHead}>
                        <code className={css.code}>{row.id}</code>
                        <Tag tone="quiet">{t(`checkpoint.reason.${row.reason}`)}</Tag>
                        <span className={css.ellipsis}>{row.task ?? ''}</span>
                        <span className={css.spacer} />
                        {row.proposal !== undefined && <Tag tone="warning">{t('checkpoint.proposed')}</Tag>}
                        <span className={css.muted}>{shortTime(row.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </Section>

            <Section title={t('dash.loops')} count={data.loops.length} open={data.loops.some(event => event.outcome === 'recovering')}>
              {data.loops.length === 0
                ? <p className={css.muted}>{t('dash.none')}</p>
                : (
                  <ul className={css.rows}>
                    {data.loops.map(event => (
                      <li key={event.id} className={css.rowHead}>
                        <StateDot state={statusDot(event.outcome)} size={10} />
                        <span className={css.ellipsis}>{event.summary}</span>
                        <span className={css.spacer} />
                        <Tag tone={statusTone(event.outcome)}>{t(`loop.outcome.${event.outcome}`)}</Tag>
                      </li>
                    ))}
                  </ul>
                )}
            </Section>

            <Section title={t('dash.errors')} count={data.errors.length}>
              {data.errors.length === 0
                ? <p className={css.muted}>{t('dash.none')}</p>
                : (
                  <ul className={css.rows}>
                    {data.errors.map(entry => (
                      <li key={`${entry.at}:${entry.text}`} className={css.rowHead}>
                        <span className={css.errorText}>{entry.text}</span>
                        <span className={css.spacer} />
                        <span className={css.muted}>{shortTime(entry.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </Section>

            <Section title={t('dash.activity')} count={data.activity.length}>
              {data.activity.length === 0
                ? <p className={css.muted}>{t('dash.none')}</p>
                : (
                  <ul className={css.rows}>
                    {data.activity.map(entry => (
                      <li key={`${entry.at}:${entry.kind}:${entry.text}`} className={css.rowHead}>
                        <Tag tone="quiet">{entry.kind}</Tag>
                        <span className={css.ellipsis}>{entry.text}</span>
                        <span className={css.spacer} />
                        <span className={css.muted}>{shortTime(entry.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </Section>
          </div>
        )}
    </Modal>
  )
}
