/** Command Center sections fed by the shared overview: overview, tasks, workflows, background, activity, tools. */
import { useEffect, useState } from 'react'
import { StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type BackgroundTask, type Overview, type ToolGroups, type TurnRecord } from './api.ts'
import { ControlBar } from './ControlBar.tsx'
import { ago, duration, errorText } from './format.ts'
import type { Translate } from './locales.ts'
import css from './CommandCenter.module.css'

/** Props every overview-fed section receives. */
export interface SectionProps {
  readonly overview: Overview
  readonly t: Translate
  readonly refresh: () => void
}

const ACTIVE = new Set(['queued', 'running', 'paused', 'waiting-for-approval'])

function taskDot(state: string): StateDotState {
  if (state === 'running') return 'ongoing'
  if (state === 'completed') return 'done'
  if (state === 'failed') return 'error'
  if (state === 'waiting-for-approval' || state === 'paused') return 'warning'
  return 'idle'
}

function taskActions(task: BackgroundTask): Array<'pause' | 'resume' | 'cancel' | 'update' | 'constrain'> {
  if (task.status === 'running') return ['pause', 'cancel', 'update', 'constrain']
  if (task.status === 'queued') return ['pause', 'cancel', 'update', 'constrain']
  if (task.status === 'paused') return ['resume', 'cancel', 'update', 'constrain']
  return []
}

/**
 * Overview: state, active project, counts, metrics, recent notifications.
 * @param props - overview data and copy.
 * @returns the overview section.
 */
export function OverviewSection({ overview, t }: SectionProps) {
  const { counts, metrics, activeProject } = overview
  return (
    <div className={css.section}>
      <div className={css.cards}>
        <div className={css.card}>
          <h3 className={css.cardTitle}>{t('overview.project')}</h3>
          {activeProject === null
            ? <p className={css.muted}>{t('overview.noProject')}</p>
            : (
              <>
                <p className={css.strong}>{activeProject.name}</p>
                {activeProject.path !== undefined && <p className={css.mono}>{activeProject.path}</p>}
                {activeProject.stack.length > 0 && <p className={css.muted}>{activeProject.stack.join(' · ')}</p>}
              </>
            )}
        </div>
        <div className={css.card}>
          <h3 className={css.cardTitle}>{t('overview.work')}</h3>
          <p>{t('overview.counts', { background: String(counts.background), workflows: String(counts.workflows) })}</p>
          <p className={css.muted}>{t('overview.agents', { agents: String(counts.agents), busy: String(counts.agentsBusy) })}</p>
          <p className={css.muted}>{t('overview.memory', { memories: String(counts.memories), projects: String(counts.projects) })}</p>
        </div>
        <div className={css.card}>
          <h3 className={css.cardTitle}>{t('overview.metrics')}</h3>
          <p>{t('overview.turns', { turns: String(metrics.overall.turns), avg: duration(metrics.overall.avgDurationMs) })}</p>
          <p className={css.muted}>{t('overview.steps', { steps: String(metrics.overall.avgSteps), tools: String(metrics.overall.avgToolCalls) })}</p>
          <p className={css.muted}>{t('overview.delegated', { delegated: String(metrics.delegatedTurns), approvals: String(metrics.approvals) })}</p>
        </div>
        <div className={css.card}>
          <h3 className={css.cardTitle}>{t('overview.coordinator')}</h3>
          <p>{overview.coordinator ? t('overview.coordinatorOn', { name: overview.personality.name }) : t('overview.coordinatorOff')}</p>
        </div>
      </div>
      <h3 className={css.subheading}>{t('overview.recent')}</h3>
      <NoticeList overview={overview} t={t} limit={6} />
    </div>
  )
}

function NoticeList({ overview, t, limit }: { overview: Overview; t: Translate; limit: number }) {
  const notices = overview.notifications.toReversed().slice(0, limit)
  if (notices.length === 0) return <p className={css.muted}>{t('activity.empty')}</p>
  return (
    <ul className={css.list}>
      {notices.map(notice => (
        <li key={notice.id} className={css.listRow}>
          <Tag tone={notice.level === 'error' ? 'danger' : notice.level === 'warning' ? 'warning' : notice.level === 'success' ? 'success' : 'quiet'}>{notice.kind}</Tag>
          <span className={css.grow}>{notice.text}</span>
          <span className={css.muted}>{ago(notice.at)}</span>
        </li>
      ))}
    </ul>
  )
}

function TaskRow({ task, t, refresh }: { task: BackgroundTask; t: Translate; refresh: () => void }) {
  return (
    <li className={css.item}>
      <div className={css.row}>
        <StateDot state={taskDot(task.state)} />
        <span className={css.strong}>{task.title}</span>
        <Tag tone={task.state === 'waiting-for-approval' ? 'warning' : 'outline'}>{t(`task.${task.state}` as 'task.running')}</Tag>
        <span className={css.muted}>{task.agentId}</span>
        <span className={css.grow} />
        <span className={css.muted}>{ago(task.createdAt)}</span>
      </div>
      <p className={css.muted}>
        {task.progress.percent === undefined ? '' : `${String(task.progress.percent)}% · `}
        {t('task.progress', { steps: String(task.progress.steps), tools: String(task.progress.toolCalls) })}
        {task.progress.note === undefined ? '' : ` · ${task.progress.note}`}
      </p>
      {task.error !== undefined && <p className={css.warning}>{task.error}</p>}
      {task.result !== undefined && <p className={css.result}>{task.result.slice(0, 400)}</p>}
      {taskActions(task).length > 0 && <ControlBar target={{ kind: 'background', id: task.id }} actions={taskActions(task)} t={t} onDone={refresh} />}
    </li>
  )
}

/**
 * Active tasks: running and queued background work and running workflows, with controls.
 * @param props - overview data and copy.
 * @returns the section.
 */
export function TasksSection({ overview, t, refresh }: SectionProps) {
  const tasks = overview.background.filter(task => ACTIVE.has(task.state))
  const workflows = overview.workflows.filter(workflow => workflow.status === 'running' || workflow.status === 'integrating')
  const focus = overview.state.sessionId
  return (
    <div className={css.section}>
      {focus !== undefined && overview.state.state !== 'IDLE' && (
        <div className={css.item}>
          <div className={css.row}>
            <StateDot state="ongoing" />
            <span className={css.strong}>{t('tasks.chat')}</span>
            <Tag>{t(`state.${overview.state.state}`)}</Tag>
          </div>
          <ControlBar target={{ kind: 'session', id: focus }} actions={['cancel', 'update', 'constrain']} t={t} onDone={refresh} />
        </div>
      )}
      {tasks.length === 0 && workflows.length === 0 && (focus === undefined || overview.state.state === 'IDLE') && <p className={css.muted}>{t('tasks.empty')}</p>}
      {tasks.length > 0 && <ul className={css.list}>{tasks.map(task => <TaskRow key={task.id} task={task} t={t} refresh={refresh} />)}</ul>}
      {workflows.length > 0 && <WorkflowsSection overview={{ ...overview, workflows }} t={t} refresh={refresh} />}
      <h3 className={css.subheading}>{t('tasks.controls')}</h3>
      <ControlHistory overview={overview} t={t} />
    </div>
  )
}

function ControlHistory({ overview, t }: { overview: Overview; t: Translate }) {
  if (overview.controls.length === 0) return <p className={css.muted}>{t('tasks.noControls')}</p>
  return (
    <ul className={css.list}>
      {overview.controls.map(control => (
        <li key={control.id} className={css.listRow}>
          <Tag tone={control.outcome === 'applied' ? 'success' : control.outcome === 'delivered' ? 'info' : 'warning'}>{t(`outcome.${control.outcome}`)}</Tag>
          <span className={css.strong}>{t(`control.${control.action}`)}</span>
          <span className={css.mono}>{control.ref.kind}:{control.ref.id}</span>
          <span className={css.grow}>{control.detail}</span>
          <span className={css.muted}>{ago(control.at)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Workflows with their task states.
 * @param props - overview data and copy.
 * @returns the section.
 */
export function WorkflowsSection({ overview, t, refresh }: SectionProps) {
  if (overview.workflows.length === 0) return <p className={css.muted}>{t('workflows.empty')}</p>
  return (
    <ul className={css.list}>
      {overview.workflows.map((workflow) => {
        const active = workflow.status === 'running' || workflow.status === 'integrating'
        return (
          <li key={workflow.id} className={css.item}>
            <div className={css.row}>
              <StateDot state={active ? 'ongoing' : workflow.status === 'completed' ? 'done' : workflow.status === 'failed' ? 'error' : 'idle'} />
              <span className={css.strong}>{workflow.title}</span>
              <Tag>{workflow.status}</Tag>
              <span className={css.muted}>{workflow.ownerName}</span>
              <span className={css.grow} />
              <span className={css.muted}>{ago(workflow.createdAt)}</span>
            </div>
            <div className={css.chips}>
              {workflow.tasks.map(task => <Tag key={task.id} tone={task.status === 'completed' ? 'success' : task.status === 'failed' ? 'danger' : 'outline'}>{task.title}: {task.status}</Tag>)}
            </div>
            {active && <ControlBar target={{ kind: 'workflow', id: workflow.id }} actions={['cancel', 'update', 'constrain']} t={t} onDone={refresh} />}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Every background task with its state, progress, and result.
 * @param props - overview data and copy.
 * @returns the section.
 */
export function BackgroundSection({ overview, t, refresh }: SectionProps) {
  if (overview.background.length === 0) return <p className={css.muted}>{t('background.empty')}</p>
  return <ul className={css.list}>{overview.background.map(task => <TaskRow key={task.id} task={task} t={t} refresh={refresh} />)}</ul>
}

/**
 * Live activity: notifications, controls, and recent turns with their depth.
 * @param props - overview data and copy.
 * @returns the section.
 */
export function ActivitySection({ overview, t }: SectionProps) {
  const [turns, setTurns] = useState<readonly TurnRecord[]>([])
  useEffect(() => {
    void api.metrics().then((result) => { setTurns(result.recent) }, () => {})
  }, [overview])
  return (
    <div className={css.section}>
      <h3 className={css.subheading}>{t('activity.turns')}</h3>
      {turns.length === 0
        ? <p className={css.muted}>{t('activity.noTurns')}</p>
        : (
          <ul className={css.list}>
            {turns.map(turn => (
              <li key={`${turn.at}-${turn.sessionId}`} className={css.listRow}>
                <Tag tone={turn.ok ? 'outline' : 'danger'}>{t(`depth.${turn.depth}`)}</Tag>
                <span className={css.muted}>{turn.mode}</span>
                <span className={css.grow}>
                  {t('activity.turn', { duration: duration(turn.durationMs), steps: String(turn.steps), tools: String(turn.toolCalls) })}
                  {turn.delegated ? ` · ${t('activity.delegated')}` : ''}
                  {turn.approvals > 0 ? ` · ${t('activity.approvals', { count: String(turn.approvals) })}` : ''}
                </span>
                <span className={css.muted}>{ago(turn.at)}</span>
              </li>
            ))}
          </ul>
        )}
      <h3 className={css.subheading}>{t('activity.notifications')}</h3>
      <NoticeList overview={overview} t={t} limit={30} />
      <h3 className={css.subheading}>{t('tasks.controls')}</h3>
      <ControlHistory overview={overview} t={t} />
    </div>
  )
}

/**
 * The tools Lead currently has, grouped by capability.
 * @param props - copy.
 * @returns the section.
 */
export function ToolsSection({ overview, t }: SectionProps) {
  const [groups, setGroups] = useState<ToolGroups | undefined>()
  const [error, setError] = useState<string | undefined>()
  const sessionId = overview.state.sessionId
  useEffect(() => {
    void api.tools(sessionId).then(setGroups, (failure: unknown) => { setError(errorText(failure)) })
  }, [sessionId])
  if (error !== undefined) return <p className={css.warning}>{error}</p>
  if (groups === undefined) return <p className={css.muted}>{t('page.loading')}</p>
  if (groups.sessionId === undefined) return <p className={css.muted}>{t('tools.noSession')}</p>
  return (
    <div className={css.section}>
      <p className={css.muted}>{t('tools.subtitle')}</p>
      <div className={css.cards}>
        {Object.entries(groups.categories).map(([category, names]) => (
          <div key={category} className={css.card}>
            <h3 className={css.cardTitle}>{t(`category.${category}` as 'category.FILES')} <span className={css.muted}>({names.length})</span></h3>
            <div className={css.chips}>{names.length === 0 ? <span className={css.muted}>{t('tools.none')}</span> : names.map(name => <Tag key={name}>{name}</Tag>)}</div>
          </div>
        ))}
        {groups.other.length > 0 && (
          <div className={css.card}>
            <h3 className={css.cardTitle}>{t('tools.other')}</h3>
            <div className={css.chips}>{groups.other.map(name => <Tag key={name}>{name}</Tag>)}</div>
          </div>
        )}
      </div>
    </div>
  )
}
