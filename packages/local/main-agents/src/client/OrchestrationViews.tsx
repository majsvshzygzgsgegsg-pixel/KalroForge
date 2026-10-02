/** The Orchestration, Background tasks, and Checkpoints tabs of the Agents page. */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, Input, Modal, RiskConfirmation, SegmentedControl, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentView, ModelGroup } from './api.ts'
import { shortTime, statusDot, statusTone } from './format.ts'
import {
  backgroundAction, cancelWorkflow, compareCheckpoint, createBackgroundTask, createCheckpoint, deleteCheckpoint, MODEL_CATEGORIES,
  restoreCheckpoint, retryTask, saveSettings,
  type Checkpoint, type CheckpointComparison, type ModelCategory, type OrchestrationNode, type OrchestrationState,
} from './orchestration-api.ts'
import { WorkflowGraph } from './WorkflowGraph.tsx'
import css from './Orchestration.module.css'

type T = TranslateNS<'mainAgents.page'>

/** Props shared by every tab. */
export interface OrchestrationTabProps {
  readonly state: OrchestrationState
  readonly agents: readonly AgentView[]
  readonly t: T
  /** True while any request runs. */
  readonly busy: boolean
  /** Run one request, then refresh; errors surface on the page. */
  readonly act: (key: string, operation: () => Promise<unknown>) => Promise<void>
  readonly openSession: (sessionId: string) => void
  readonly openDashboard: (agentId: string) => void
}

const modelKey = (provider: string, model: string) => `${provider}\u0000${model}`

function Panel({ title, aside, children }: { readonly title: string; readonly aside?: ReactNode; readonly children: ReactNode }) {
  return (
    <section className={css.panel}>
      <div className={css.rowHead}>
        <h2 className={css.panelTitle}>{title}</h2>
        <span className={css.spacer} />
        {aside}
      </div>
      {children}
    </section>
  )
}

function TreeNode({ node, t, openSession, openDashboard }: {
  readonly node: OrchestrationNode
  readonly t: T
  readonly openSession: (sessionId: string) => void
  readonly openDashboard: (agentId: string) => void
}) {
  return (
    <li className={css.treeItem}>
      <div className={css.rowHead}>
        <StateDot state={statusDot(node.status)} size={10} />
        <span className={css.strong}>{node.name}</span>
        <Tag tone="quiet">{t(`tree.kind.${node.kind}`)}</Tag>
        <span className={css.muted}>{node.status}</span>
        {node.detail !== undefined && <span className={css.ellipsis}>{node.detail}</span>}
        <span className={css.spacer} />
        {node.agentId !== undefined && (
          <Button size="sm" variant="ghost" onClick={() => { if (node.agentId !== undefined) openDashboard(node.agentId) }}>{t('action.activity')}</Button>
        )}
        {node.sessionId !== undefined && (
          <Button size="sm" variant="ghost" onClick={() => { if (node.sessionId !== undefined) openSession(node.sessionId) }}>{t('action.open')}</Button>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className={css.tree}>
          {node.children.map(child => (
            <TreeNode key={child.id} node={child} t={t} openSession={openSession} openDashboard={openDashboard} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * Orchestration tab: live tree, workflows, delegations, loop recovery, routing.
 * @param props - state, copy, actions, and the provider model catalog.
 * @returns the tab.
 */
export function OrchestrationView({ state, t, busy, act, openSession, openDashboard, models }: OrchestrationTabProps & {
  readonly models: readonly ModelGroup[]
}) {
  const routing = state.settings.routing
  const setCategory = (category: ModelCategory, value: string) => {
    const [provider, model] = value.split('\u0000')
    const choice = value === '' || provider === undefined || model === undefined ? null : { provider, model }
    void act(`routing:${category}`, () => saveSettings({ routing: { categories: { [category]: choice } } }))
  }
  const metrics = state.loopMetrics
  return (
    <div className={css.tab}>
      <Panel title={t('orch.tree')}>
        <ul className={css.tree}>
          {state.tree.map(node => <TreeNode key={node.id} node={node} t={t} openSession={openSession} openDashboard={openDashboard} />)}
        </ul>
      </Panel>

      <Panel title={t('orch.workflows')} aside={<span className={css.muted}>{state.workflows.length}</span>}>
        {state.workflows.length === 0
          ? <p className={css.muted}>{t('orch.noWorkflows')}</p>
          : state.workflows.slice(0, 8).map(workflow => (
            <WorkflowGraph
              key={workflow.id}
              workflow={workflow}
              t={t}
              busy={busy}
              onCancel={(item) => { void act(`workflow:${item.id}`, () => cancelWorkflow(item.id)) }}
              onRetry={(item, taskId) => { void act(`workflow:${item.id}`, () => retryTask(item.id, taskId)) }}
            />
          ))}
      </Panel>

      <Panel title={t('orch.delegations')} aside={<span className={css.muted}>{state.delegations.length}</span>}>
        {state.delegations.length === 0
          ? <p className={css.muted}>{t('orch.noDelegations')}</p>
          : (
            <ul className={css.rows}>
              {state.delegations.slice(0, 15).map(record => (
                <li key={record.id} className={css.rowHead}>
                  <StateDot state={statusDot(record.status)} size={10} />
                  <span className={css.strong}>{record.from.name} → {record.toName}</span>
                  <Tag tone="quiet">{t(`delegation.kind.${record.kind}`)}</Tag>
                  <span className={css.muted}>{t('delegation.depth', { n: record.depth })}</span>
                  <span className={css.ellipsis}>{record.task}</span>
                  <span className={css.spacer} />
                  <Tag tone={statusTone(record.status)}>{t(`delegation.status.${record.status}`)}</Tag>
                </li>
              ))}
            </ul>
          )}
      </Panel>

      <Panel
        title={t('orch.loops')}
        aside={(
          <label className={css.switchLabel}>
            <span>{t('orch.loopsEnabled')}</span>
            <Switch
              checked={state.settings.loops.enabled}
              label={t('orch.loopsEnabled')}
              disabled={busy}
              onChange={(enabled) => { void act('loops', () => saveSettings({ loops: { enabled } })) }}
            />
          </label>
        )}
      >
        <div className={css.workCounts}>
          <Tag tone="neutral">{t('loop.detections', { n: metrics.detections })}</Tag>
          <Tag tone="success">{t('loop.recovered', { n: metrics.recovered })}</Tag>
          <Tag tone={metrics.recurred > 0 ? 'danger' : 'neutral'}>{t('loop.recurred', { n: metrics.recurred })}</Tag>
          {Object.entries(metrics.byKind).map(([kind, count]) => <Tag key={kind} tone="quiet">{`${kind}: ${count}`}</Tag>)}
        </div>
        {state.loops.length === 0
          ? <p className={css.muted}>{t('orch.noLoops')}</p>
          : (
            <ul className={css.rows}>
              {state.loops.slice(0, 10).map(event => (
                <li key={event.id} className={css.rowHead}>
                  <StateDot state={statusDot(event.outcome)} size={10} />
                  <span className={css.strong}>{event.agentName}</span>
                  <span className={css.ellipsis}>{event.summary}</span>
                  <span className={css.spacer} />
                  {event.delegatedDiagnosis === true && <Tag tone="info">{t('loop.diagnosis')}</Tag>}
                  <Tag tone={statusTone(event.outcome)}>{t(`loop.outcome.${event.outcome}`)}</Tag>
                  <span className={css.muted}>{shortTime(event.at)}</span>
                </li>
              ))}
            </ul>
          )}
      </Panel>

      <Panel
        title={t('orch.routing')}
        aside={(
          <label className={css.switchLabel}>
            <span>{t('orch.routingEnabled')}</span>
            <Switch
              checked={routing.enabled}
              label={t('orch.routingEnabled')}
              disabled={busy}
              onChange={(enabled) => { void act('routing', () => saveSettings({ routing: { enabled } })) }}
            />
          </label>
        )}
      >
        <p className={css.hintText}>{t('orch.routingHint')}</p>
        <div className={css.rowHead}>
          <span className={css.fieldLabel}>{t('orch.routingScope')}</span>
          <SegmentedControl
            id="main-agents-routing-scope"
            label={t('orch.routingScope')}
            value={routing.scope}
            options={[{ value: 'managed', label: t('orch.scopeManaged') }, { value: 'all', label: t('orch.scopeAll') }]}
            onChange={(scope) => { void act('routing', () => saveSettings({ routing: { scope } })) }}
          />
        </div>
        <div className={css.categoryGrid}>
          {MODEL_CATEGORIES.map((category) => {
            const chosen = routing.categories[category]
            return (
              <div key={category} className={css.categoryRow}>
                <label className={css.fieldLabel} htmlFor={`main-agents-route-${category}`}>{t(`category.${category}`)}</label>
                <select
                  id={`main-agents-route-${category}`}
                  className={css.select}
                  disabled={busy}
                  value={chosen === undefined ? '' : modelKey(chosen.provider, chosen.model)}
                  onChange={(event) => { setCategory(category, event.target.value) }}
                >
                  <option value="">{t('orch.sessionModel')}</option>
                  {models.map(group => (
                    <optgroup key={group.provider} label={group.name}>
                      {group.models.map(model => <option key={model.id} value={modelKey(group.provider, model.id)}>{model.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
        {state.routes.length > 0 && (
          <ul className={css.rows}>
            {state.routes.slice(0, 8).map(route => (
              <li key={`${route.sessionId}:${route.at}`} className={css.rowHead}>
                <Tag tone={route.routed ? 'info' : 'quiet'}>{t(`category.${route.category}`)}</Tag>
                <code className={css.code}>{`${route.provider}/${route.model}`}</code>
                <span className={css.ellipsis}>{route.reason}</span>
                <span className={css.spacer} />
                <span className={css.muted}>{shortTime(route.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={t('orch.notifications')}>
        {state.notifications.length === 0
          ? <p className={css.muted}>{t('orch.noNotifications')}</p>
          : (
            <ul className={css.rows}>
              {state.notifications.slice(0, 12).map(notice => (
                <li key={notice.id} className={css.rowHead}>
                  <StateDot state={notice.level === 'error' ? 'error' : notice.level === 'warning' ? 'warning' : 'done'} size={10} />
                  <Tag tone="quiet">{notice.kind}</Tag>
                  <span className={css.ellipsis}>{notice.text}</span>
                  <span className={css.spacer} />
                  <span className={css.muted}>{shortTime(notice.at)}</span>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </div>
  )
}

/**
 * Background tasks tab: queue, progress, pause/resume/cancel.
 * @param props - state, agents, copy, and actions.
 * @returns the tab.
 */
export function BackgroundView({ state, agents, t, busy, act, openSession }: OrchestrationTabProps) {
  const runnable = agents.filter(agent => agent.status !== 'archived')
  const [agentId, setAgentId] = useState('')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const target = agentId === '' ? runnable[0]?.id : agentId
  const agentName = (id: string) => agents.find(agent => agent.id === id)?.name ?? id
  return (
    <div className={css.tab}>
      <Panel title={t('bg.new')}>
        {runnable.length === 0
          ? <p className={css.muted}>{t('bg.noAgents')}</p>
          : (
            <div className={css.form}>
              <div className={css.fieldRow}>
                <select className={css.select} aria-label={t('bg.agent')} value={target ?? ''} onChange={(event) => { setAgentId(event.target.value) }}>
                  {runnable.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
                <Input aria-label={t('bg.title')} placeholder={t('bg.title')} value={title} onChange={(event) => { setTitle(event.target.value) }} />
              </div>
              <textarea
                className={css.textarea}
                aria-label={t('bg.prompt')}
                placeholder={t('bg.prompt')}
                rows={3}
                value={prompt}
                onChange={(event) => { setPrompt(event.target.value) }}
              />
              <div className={css.rowHead}>
                <span className={css.hintText}>{t('bg.hint')}</span>
                <span className={css.spacer} />
                <Button
                  variant="primary"
                  disabled={busy || target === undefined || prompt.trim() === ''}
                  onClick={() => {
                    if (target === undefined) return
                    const text = prompt.trim()
                    void act('bg:create', async () => {
                      await createBackgroundTask(target, title.trim() === '' ? text.slice(0, 60) : title.trim(), text)
                      setTitle('')
                      setPrompt('')
                    })
                  }}
                >
                  {t('bg.queue')}
                </Button>
              </div>
            </div>
          )}
      </Panel>

      <Panel title={t('bg.tasks')} aside={<span className={css.muted}>{state.background.length}</span>}>
        {state.background.length === 0
          ? <p className={css.muted}>{t('bg.empty')}</p>
          : (
            <ul className={css.cards}>
              {state.background.map(task => (
                <li key={task.id} className={css.itemCard}>
                  <div className={css.rowHead}>
                    <StateDot state={statusDot(task.status)} size={10} />
                    <span className={css.strong}>{task.title}</span>
                    <Tag tone={statusTone(task.status)}>{t(`bg.status.${task.status}`)}</Tag>
                    <span className={css.muted}>{agentName(task.agentId)}</span>
                    <span className={css.spacer} />
                    <span className={css.muted}>{shortTime(task.createdAt)}</span>
                  </div>
                  <div className={css.meterRow}>
                    {task.progress.percent !== undefined && (
                      <span className={css.meter} aria-hidden="true">
                        <span className={css.meterFill} style={{ width: `${task.progress.percent}%` }} />
                      </span>
                    )}
                    <span className={css.muted}>
                      {t('dash.steps', { steps: task.progress.steps, calls: task.progress.toolCalls })}
                      {task.progress.lastTool === undefined ? '' : ` · ${task.progress.lastTool}`}
                      {task.resumedAfterRestart === undefined ? '' : ` · ${t('bg.resumed', { n: task.resumedAfterRestart })}`}
                    </span>
                  </div>
                  {task.progress.note !== undefined && <span className={css.secondary}>{task.progress.note}</span>}
                  {task.error !== undefined && <span className={css.errorText}>{task.error.slice(0, 300)}</span>}
                  {task.result !== undefined && <span className={css.secondary}>{task.result.slice(0, 300)}</span>}
                  <div className={css.actionsRow}>
                    {task.status === 'running' || task.status === 'queued'
                      ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void act(`bg:${task.id}`, () => backgroundAction(task.id, 'pause')) }}>{t('bg.pause')}</Button>
                      : null}
                    {task.status === 'paused' && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void act(`bg:${task.id}`, () => backgroundAction(task.id, 'resume')) }}>{t('bg.resume')}</Button>
                    )}
                    {['queued', 'running', 'paused'].includes(task.status) && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void act(`bg:${task.id}`, () => backgroundAction(task.id, 'cancel')) }}>{t('bg.cancel')}</Button>
                    )}
                    {task.sessionId !== undefined && (
                      <Button size="sm" variant="ghost" onClick={() => { if (task.sessionId !== undefined) openSession(task.sessionId) }}>{t('action.open')}</Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </div>
  )
}

/**
 * Checkpoints tab: create, compare, restore (scoped, with a safety checkpoint), delete.
 * @param props - state, agents, copy, and actions.
 * @returns the tab.
 */
export function CheckpointsView({ state, agents, t, busy, act }: OrchestrationTabProps) {
  const runnable = agents.filter(agent => agent.status !== 'archived')
  const [agentId, setAgentId] = useState('')
  const [label, setLabel] = useState('')
  const [comparing, setComparing] = useState<CheckpointComparison | undefined>()
  const [restoring, setRestoring] = useState<Checkpoint | undefined>()
  const [scope, setScope] = useState<'touched' | 'all'>('touched')
  const [acknowledged, setAcknowledged] = useState(false)
  const [deleting, setDeleting] = useState<Checkpoint | undefined>()
  const [deleteAck, setDeleteAck] = useState(false)
  const [outcome, setOutcome] = useState<string | undefined>()
  const target = agentId === '' ? runnable[0]?.id : agentId
  const tests = (row: Checkpoint) => [row.testsBefore, row.testsAfter].map(run => run === undefined ? '–' : run.ok ? '✓' : '✗').join(' → ')

  return (
    <div className={css.tab}>
      <Panel title={t('cp.new')}>
        {runnable.length === 0
          ? <p className={css.muted}>{t('bg.noAgents')}</p>
          : (
            <div className={css.fieldRow}>
              <select className={css.select} aria-label={t('bg.agent')} value={target ?? ''} onChange={(event) => { setAgentId(event.target.value) }}>
                {runnable.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
              <Input aria-label={t('cp.label')} placeholder={t('cp.label')} value={label} onChange={(event) => { setLabel(event.target.value) }} />
              <Button
                variant="outline"
                disabled={busy || target === undefined}
                onClick={() => {
                  if (target === undefined) return
                  void act('cp:create', async () => { await createCheckpoint(target, label.trim()); setLabel('') })
                }}
              >
                {t('cp.create')}
              </Button>
            </div>
          )}
        <p className={css.hintText}>{t('cp.hint')}</p>
      </Panel>

      {outcome !== undefined && <p className={css.notice} role="status">{outcome}</p>}

      <Panel title={t('cp.list')} aside={<span className={css.muted}>{state.checkpoints.length}</span>}>
        {state.checkpoints.length === 0
          ? <p className={css.muted}>{t('cp.empty')}</p>
          : (
            <ul className={css.cards}>
              {state.checkpoints.map(row => (
                <li key={row.id} className={css.itemCard}>
                  <div className={css.rowHead}>
                    <code className={css.code}>{row.id}</code>
                    <Tag tone="quiet">{t(`checkpoint.reason.${row.reason}`)}</Tag>
                    {row.proposal !== undefined && <Tag tone="warning">{t('checkpoint.proposed')}</Tag>}
                    {row.restoredAt !== undefined && <Tag tone="info">{t('cp.restored')}</Tag>}
                    <span className={css.spacer} />
                    <span className={css.muted}>{shortTime(row.createdAt)}</span>
                  </div>
                  <span className={css.secondary}>
                    {t('cp.meta', {
                      agent: row.agent.name,
                      branch: row.branch ?? '–',
                      head: row.head?.slice(0, 8) ?? '–',
                      dirty: row.dirty.length,
                      touched: row.touched.length,
                      tests: tests(row),
                    })}
                  </span>
                  {row.task !== undefined && <span className={css.ellipsis}>{row.task}</span>}
                  {row.proposal !== undefined && (
                    <span className={css.warningText}>{t('cp.proposal', { by: row.proposal.by, reason: row.proposal.reason })}</span>
                  )}
                  <div className={css.actionsRow}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => { void act(`cp:${row.id}`, async () => { setComparing(await compareCheckpoint(row.id)) }) }}
                    >
                      {t('cp.compare')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setScope('touched'); setAcknowledged(false); setRestoring(row) }}>
                      {t('cp.restore')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDeleteAck(false); setDeleting(row) }}>{t('cp.delete')}</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Panel>

      <Modal
        open={comparing !== undefined}
        onClose={() => { setComparing(undefined) }}
        title={t('cp.compareTitle', { id: comparing?.checkpoint.id ?? '' })}
        closeLabel={t('form.close')}
        className={css.dashModal ?? ''}
        contentClassName={css.dashContent ?? ''}
      >
        {comparing !== undefined && (
          <div className={css.dash}>
            {comparing.changes.length === 0
              ? <p className={css.muted}>{t('cp.noChanges')}</p>
              : (
                <ul className={css.rows}>
                  {comparing.changes.map(change => (
                    <li key={change.path} className={css.rowHead}>
                      <code className={css.code}>{change.status}</code>
                      <span className={css.ellipsis}>{change.path}</span>
                      <span className={css.spacer} />
                      <Tag tone={change.touchedByAgent ? 'info' : 'warning'}>{change.touchedByAgent ? t('cp.byAgent') : t('cp.byOther')}</Tag>
                    </li>
                  ))}
                </ul>
              )}
            {comparing.diff !== '' && <pre className={css.diff}>{comparing.diff.slice(0, 20_000)}</pre>}
          </div>
        )}
      </Modal>

      <Modal
        open={restoring !== undefined}
        onClose={() => { setRestoring(undefined) }}
        title={t('cp.restoreTitle', { id: restoring?.id ?? '' })}
        closeLabel={t('form.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setRestoring(undefined) }}>{t('form.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!acknowledged || busy}
              onClick={() => {
                const row = restoring
                setRestoring(undefined)
                if (row === undefined) return
                void act(`cp:${row.id}`, async () => {
                  const result = await restoreCheckpoint(row.id, scope)
                  setOutcome(t('cp.restoreDone', {
                    restored: result.restored.length,
                    deleted: result.deleted.length,
                    skipped: result.skipped.length,
                    safety: result.safetyCheckpointId ?? '–',
                  }))
                })
              }}
            >
              {t('cp.restore')}
            </Button>
          </>
        )}
      >
        <div className={css.form}>
          <span>{t('cp.restoreDescription')}</span>
          <SegmentedControl
            id="main-agents-restore-scope"
            label={t('cp.scope')}
            value={scope}
            options={[{ value: 'touched', label: t('cp.scopeTouched') }, { value: 'all', label: t('cp.scopeAll') }]}
            onChange={setScope}
          />
          <span className={scope === 'all' ? css.warningText : css.hintText}>{scope === 'all' ? t('cp.scopeAllHint') : t('cp.scopeTouchedHint')}</span>
          <Checkbox checked={acknowledged} onChange={setAcknowledged} label={t('cp.restoreAck')} />
        </div>
      </Modal>

      <RiskConfirmation
        open={deleting !== undefined}
        title={t('cp.deleteTitle', { id: deleting?.id ?? '' })}
        description={t('cp.deleteDescription')}
        acknowledgeLabel={t('cp.deleteAck')}
        cancelLabel={t('form.cancel')}
        closeLabel={t('form.close')}
        confirmLabel={t('cp.delete')}
        acknowledged={deleteAck}
        onAcknowledgedChange={setDeleteAck}
        onCancel={() => { setDeleting(undefined) }}
        onConfirm={() => {
          const row = deleting
          setDeleting(undefined)
          if (row !== undefined) void act(`cp:${row.id}`, () => deleteCheckpoint(row.id))
        }}
      />
    </div>
  )
}
