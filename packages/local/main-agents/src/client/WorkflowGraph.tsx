/** Visual workflow: tasks laid out in dependency levels, with cancel and retry. */
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { dependencyLevels, shortTime, statusDot, statusTone } from './format.ts'
import type { Workflow } from './orchestration-api.ts'
import css from './Orchestration.module.css'

/** Props for {@link WorkflowGraph}. */
export interface WorkflowGraphProps {
  readonly workflow: Workflow
  readonly t: TranslateNS<'mainAgents.page'>
  /** Disable actions while another request runs. */
  readonly busy: boolean
  readonly onCancel: (workflow: Workflow) => void
  readonly onRetry: (workflow: Workflow, taskId: string) => void
}

const ACTIVE = new Set(['running', 'integrating'])

/**
 * Render one workflow.
 * @param props - the workflow, copy, and actions.
 * @returns the workflow card.
 */
export function WorkflowGraph({ workflow, t, busy, onCancel, onRetry }: WorkflowGraphProps) {
  const levels = dependencyLevels(workflow.tasks)
  const done = workflow.tasks.filter(task => task.status === 'completed').length
  return (
    <article className={css.workflow} aria-label={t('workflow.label', { title: workflow.title })}>
      <div className={css.rowHead}>
        <StateDot state={statusDot(workflow.status)} />
        <span className={css.strong}>{workflow.title}</span>
        <Tag tone={statusTone(workflow.status)}>{t(`workflow.status.${workflow.status}`)}</Tag>
        <span className={css.muted}>{t('workflow.progress', { done, total: workflow.tasks.length })}</span>
        <span className={css.spacer} />
        <span className={css.muted}>{t('workflow.owner', { name: workflow.ownerName })} · {shortTime(workflow.createdAt)}</span>
        {ACTIVE.has(workflow.status) && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { onCancel(workflow) }}>{t('workflow.cancel')}</Button>
        )}
      </div>
      <p className={css.secondary}>{workflow.goal}</p>
      <div className={css.graph} role="list" aria-label={t('workflow.tasks')}>
        {levels.map((level, index) => (
          <div key={level.map(task => task.id).join(',')} className={css.level}>
            <span className={css.levelLabel}>{t('workflow.level', { n: index + 1 })}</span>
            {level.map(task => (
              <div key={task.id} className={css.task} role="listitem" data-status={task.status}>
                <div className={css.rowHead}>
                  <StateDot state={statusDot(task.status)} size={10} />
                  <span className={css.strong}>{task.title}</span>
                </div>
                <span className={css.muted}>
                  {task.role}
                  {task.attempts > 1 ? ` · ${t('workflow.attempts', { n: task.attempts })}` : ''}
                  {task.dependsOn.length > 0 ? ` · ${t('workflow.after', { ids: task.dependsOn.join(', ') })}` : ''}
                </span>
                {task.error !== undefined && <span className={css.errorText}>{task.error.slice(0, 160)}</span>}
                {task.error === undefined && task.result !== undefined && (
                  <span className={css.secondary}>{task.result.slice(0, 160)}</span>
                )}
                {task.status === 'failed' && workflow.status !== 'cancelled' && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => { onRetry(workflow, task.id) }}>{t('workflow.retry')}</Button>
                )}
              </div>
            ))}
          </div>
        ))}
        <div className={css.level}>
          <span className={css.levelLabel}>{t('workflow.integration')}</span>
          <div className={css.task} data-status={workflow.status === 'completed' ? 'completed' : workflow.status === 'integrating' ? 'running' : 'pending'}>
            <div className={css.rowHead}>
              <StateDot state={workflow.status === 'completed' ? 'done' : workflow.status === 'integrating' ? 'ongoing' : 'idle'} size={10} />
              <span className={css.strong}>{workflow.ownerName}</span>
            </div>
            {workflow.finalResult !== undefined && <span className={css.secondary}>{workflow.finalResult.slice(0, 200)}</span>}
            {workflow.error !== undefined && <span className={css.errorText}>{workflow.error.slice(0, 200)}</span>}
          </div>
        </div>
      </div>
    </article>
  )
}
