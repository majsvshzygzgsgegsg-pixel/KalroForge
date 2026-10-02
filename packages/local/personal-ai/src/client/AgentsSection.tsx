/** Agents: capability tags per main agent and the ranked recommendation for a task. */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type AgentCandidate, type AgentScore } from './api.ts'
import { errorText } from './format.ts'
import type { Translate } from './locales.ts'
import css from './CommandCenter.module.css'

const GROW = css.grow ?? ''

/** Agents section props. */
export interface AgentsSectionProps {
  readonly t: Translate
  /** Open the Agents page to create or edit agents. */
  readonly openAgents: () => void
}

/**
 * Render the agents section.
 * @param props - copy and navigation.
 * @returns the section.
 */
export function AgentsSection({ t, openAgents }: AgentsSectionProps) {
  const [agents, setAgents] = useState<readonly AgentCandidate[]>([])
  const [tags, setTags] = useState<readonly string[]>([])
  const [error, setError] = useState<string | undefined>()
  const [task, setTask] = useState('')
  const [ranked, setRanked] = useState<readonly AgentScore[] | undefined>()

  const load = useCallback(async () => {
    try {
      const result = await api.agents()
      setAgents(result.agents.filter(agent => agent.status !== 'archived'))
      setTags(result.tags)
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const toggleTag = async (agent: AgentCandidate, tag: string): Promise<void> => {
    const current = agent.tags ?? []
    const next = current.includes(tag) ? current.filter(entry => entry !== tag) : [...current, tag]
    try {
      await api.setAgentTags(agent.id, next)
    } catch (failure) {
      setError(errorText(failure))
    }
    await load()
  }

  return (
    <div className={css.section}>
      <div className={css.row}>
        <p className={`${css.muted} ${css.grow}`}>{t('agents.subtitle')}</p>
        <Button size="sm" variant="outline" onClick={openAgents}>{t('agents.manage')}</Button>
      </div>
      <form
        className={css.row}
        onSubmit={(event) => {
          event.preventDefault()
          if (task.trim() === '') return
          void api.recommend(task.trim()).then(setRanked, (failure: unknown) => { setError(errorText(failure)) })
        }}
      >
        <Input className={GROW} value={task} placeholder={t('agents.recommendPlaceholder')} aria-label={t('agents.recommend')} onChange={(event) => { setTask(event.target.value) }} />
        <Button size="sm" variant="primary" type="submit" disabled={task.trim() === ''}>{t('agents.recommend')}</Button>
      </form>
      {ranked !== undefined && (
        ranked.length === 0
          ? <p className={css.muted}>{t('agents.noCandidates')}</p>
          : (
            <ol className={css.list}>
              {ranked.slice(0, 5).map(row => (
                <li key={row.id} className={css.listRow}>
                  <span className={css.strong}>{row.name}</span>
                  <Tag>{row.score.toFixed(1)}</Tag>
                  <span className={css.grow}>{row.reasons.join(' · ')}</span>
                </li>
              ))}
            </ol>
          )
      )}
      {error !== undefined && <p className={css.warning} role="alert">{error}</p>}
      {agents.length === 0
        ? <p className={css.muted}>{t('agents.empty')}</p>
        : (
          <ul className={css.list}>
            {agents.map(agent => (
              <li key={agent.id} className={css.item}>
                <div className={css.row}>
                  <StateDot state={agent.status === 'stopped' ? 'idle' : agent.runtime === 'busy' ? 'ongoing' : 'done'} />
                  <span className={css.strong}>{agent.name}</span>
                  <Tag tone="quiet">{agent.preset}</Tag>
                  <span className={css.muted}>{agent.description}</span>
                </div>
                <div className={css.chips} role="group" aria-label={t('agents.tags', { name: agent.name })}>
                  {tags.map(tag => (
                    <button
                      key={tag}
                      type="button"
                      className={css.chipButton}
                      aria-pressed={agent.tags?.includes(tag) === true}
                      onClick={() => { void toggleTag(agent, tag) }}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
                {agent.tags === undefined && <p className={css.muted}>{t('agents.inferred')}</p>}
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
