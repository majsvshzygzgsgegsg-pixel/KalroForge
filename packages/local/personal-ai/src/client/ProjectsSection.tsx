/** Projects: register, open, inspect live status, assign agents, and archive. */
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Input, RiskConfirmation, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type AgentCandidate, type Project } from './api.ts'
import { ago, errorText } from './format.ts'
import type { Translate } from './locales.ts'
import css from './CommandCenter.module.css'

/**
 * Render the projects section.
 * @param props - copy.
 * @returns the section.
 */
export function ProjectsSection({ t }: { readonly t: Translate }) {
  const [projects, setProjects] = useState<readonly Project[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [agents, setAgents] = useState<readonly AgentCandidate[]>([])
  const [archived, setArchived] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [form, setForm] = useState({ name: '', path: '', description: '' })
  const [status, setStatus] = useState<{ readonly id: string; readonly value: Record<string, unknown> } | undefined>()
  const [archiving, setArchiving] = useState<Project | undefined>()
  const [acknowledged, setAcknowledged] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, roster] = await Promise.all([api.projects(archived), api.agents()])
      setProjects(list.projects)
      setActiveId(list.activeProjectId)
      setAgents(roster.agents)
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [archived])

  useEffect(() => { void load() }, [load])

  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation()
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
    await load()
  }

  return (
    <div className={css.section}>
      <p className={css.muted}>{t('projects.subtitle')}</p>
      <form
        className={css.formGrid}
        onSubmit={(event) => {
          event.preventDefault()
          if (form.name.trim() === '') return
          void act(async () => {
            await api.createProject({
              name: form.name.trim(),
              ...form.path.trim() === '' ? {} : { path: form.path.trim() },
              ...form.description.trim() === '' ? {} : { description: form.description.trim() },
            })
            setForm({ name: '', path: '', description: '' })
          })
        }}
      >
        <Input value={form.name} placeholder={t('projects.name')} aria-label={t('projects.name')} onChange={(event) => { setForm({ ...form, name: event.target.value }) }} />
        <Input value={form.path} placeholder={t('projects.path')} aria-label={t('projects.path')} onChange={(event) => { setForm({ ...form, path: event.target.value }) }} />
        <Input value={form.description} placeholder={t('projects.description')} aria-label={t('projects.description')} onChange={(event) => { setForm({ ...form, description: event.target.value }) }} />
        <Button size="sm" variant="primary" type="submit" disabled={form.name.trim() === ''}>{t('projects.create')}</Button>
      </form>
      <Checkbox checked={archived} onChange={setArchived} label={t('projects.showArchived')} />
      {error !== undefined && <p className={css.warning} role="alert">{error}</p>}
      {projects.length === 0
        ? <p className={css.muted}>{t('projects.empty')}</p>
        : (
          <ul className={css.list}>
            {projects.map(project => (
              <li key={project.id} className={css.item}>
                <div className={css.row}>
                  <span className={css.strong}>{project.name}</span>
                  {project.id === activeId && <Tag tone="solid">{t('projects.active')}</Tag>}
                  {project.status === 'archived' && <Tag tone="warning">{t('projects.archived')}</Tag>}
                  {project.path !== undefined && <span className={css.mono}>{project.path}</span>}
                  <span className={css.grow} />
                  <span className={css.muted}>{ago(project.updatedAt)}</span>
                </div>
                {project.description !== '' && <p className={css.muted}>{project.description}</p>}
                <div className={css.chips}>
                  {project.stack.map(item => <Tag key={item} tone="quiet">{item}</Tag>)}
                  {Object.entries(project.commands).map(([key, value]) => <Tag key={key}>{key}: {value}</Tag>)}
                </div>
                {project.status === 'active' && (
                  <div className={css.row}>
                    {project.id !== activeId && <Button size="sm" variant="outline" onClick={() => { void act(() => api.openProject(project.id)) }}>{t('projects.open')}</Button>}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (status?.id === project.id) {
                          setStatus(undefined)
                          return
                        }
                        void api.projectStatus(project.id).then(
                          (value) => { setStatus({ id: project.id, value }) },
                          (failure: unknown) => { setError(errorText(failure)) },
                        )
                      }}
                    >
                      {t('projects.status')}
                    </Button>
                    <select
                      className={css.select}
                      value=""
                      aria-label={t('projects.assign')}
                      onChange={(event) => {
                        const agentId = event.target.value
                        if (agentId !== '') void act(() => api.assignAgent(project.id, agentId, project.agentIds.includes(agentId)))
                      }}
                    >
                      <option value="">{t('projects.assign')}</option>
                      {agents.map(agent => (
                        <option key={agent.id} value={agent.id}>{project.agentIds.includes(agent.id) ? `✓ ${agent.name}` : agent.name}</option>
                      ))}
                    </select>
                    <span className={css.grow} />
                    <Button size="sm" variant="ghost" onClick={() => { setAcknowledged(false); setArchiving(project) }}>{t('projects.archive')}</Button>
                  </div>
                )}
                {project.agentIds.length > 0 && (
                  <p className={css.muted}>{t('projects.agents', { agents: project.agentIds.map(id => agents.find(agent => agent.id === id)?.name ?? id).join(', ') })}</p>
                )}
                {status?.id === project.id && <pre className={`${css.json} ${css.mono}`}>{JSON.stringify(status.value, null, 2)}</pre>}
              </li>
            ))}
          </ul>
        )}
      <RiskConfirmation
        open={archiving !== undefined}
        title={t('projects.archiveTitle')}
        description={t('projects.archiveDescription', { name: archiving?.name ?? '' })}
        acknowledgeLabel={t('projects.archiveAcknowledge')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        confirmLabel={t('projects.archive')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setArchiving(undefined) }}
        onConfirm={() => {
          const target = archiving
          setArchiving(undefined)
          if (target !== undefined) void act(() => api.archiveProject(target.id))
        }}
      />
    </div>
  )
}
