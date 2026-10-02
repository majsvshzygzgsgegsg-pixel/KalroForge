/** Create and edit form for one main agent, rendered in a modal. */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button, Checkbox, Input, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDraft, AgentModel, AgentView, AgentsState } from './api.ts'
import { modeLabel } from './labels.ts'
import css from './AgentsPage.module.css'

/** Presets the form may select; wider access stays behind `/permission`. */
const FORM_PRESETS = ['read-only', 'workspace-write']

/** Props for {@link AgentEditor}. */
export interface AgentEditorProps {
  /** Whether the modal is shown. */
  readonly open: boolean
  /** The agent being edited; undefined creates a new agent. */
  readonly agent: AgentView | undefined
  /** Registry options for the mode, model, and permission fields. */
  readonly options: AgentsState['options']
  /** Mode new agents start in. */
  readonly defaultMode: string
  /** Localized copy. */
  readonly t: TranslateNS<'mainAgents.page'>
  /** Close without saving. */
  readonly onClose: () => void
  /** Persist the draft; a rejection keeps the modal open with its message. */
  readonly onSubmit: (draft: AgentDraft) => Promise<void>
}

const splitList = (value: string) => value.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
const modelKey = (model: AgentModel | undefined) => model === undefined ? '' : `${model.provider}\u0000${model.model}`

function Field({ id, label, children }: { readonly id: string; readonly label: string; readonly children: ReactNode }) {
  return (
    <div className={css.field}>
      <label className={css.fieldLabel} htmlFor={id}>{label}</label>
      {children}
    </div>
  )
}

/**
 * Render the main-agent form.
 * @param props - the agent, options, copy, and callbacks.
 * @returns the modal form.
 */
export function AgentEditor({ open, agent, options, defaultMode, t, onClose, onSubmit }: AgentEditorProps) {
  const id = useId()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [mode, setMode] = useState(defaultMode)
  const [model, setModel] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [allow, setAllow] = useState('')
  const [deny, setDeny] = useState('')
  const [preset, setPreset] = useState('workspace-write')
  const [admin, setAdmin] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!open) return
    setName(agent?.name ?? '')
    setDescription(agent?.description ?? '')
    setInstructions(agent?.instructions ?? '')
    setMode(agent?.mode ?? defaultMode)
    setModel(modelKey(agent?.model))
    setWorkspace(agent?.workspace ?? '')
    setAllow(agent?.tools.allow.join(', ') ?? '')
    setDeny(agent?.tools.deny.join(', ') ?? '')
    setPreset(agent?.permissions.preset ?? 'workspace-write')
    setAdmin(agent?.permissions.agentAdministration ?? false)
    setSaving(false)
    setError(undefined)
  }, [open, agent, defaultMode])

  const presets = options.permissionPresets.filter(option => FORM_PRESETS.includes(option.value))
  // An agent already granted a wider preset keeps it visible rather than silently narrowing.
  const current = options.permissionPresets.find(option => option.value === preset)
  const presetOptions = (current !== undefined && !presets.includes(current) ? [...presets, current] : presets)
    .map(option => ({ value: option.value, label: option.name }))
  const modes = options.modes.some(option => option.id === mode) ? options.modes : [...options.modes, { id: mode, name: mode }]

  const submit = async () => {
    const selected = options.models.flatMap(group => group.models.map(entry => ({ provider: group.provider, model: entry.id })))
      .find(entry => modelKey(entry) === model)
    setSaving(true)
    setError(undefined)
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        mode,
        ...selected === undefined ? {} : { model: selected },
        workspace: workspace.trim(),
        allow: splitList(allow),
        deny: splitList(deny),
        preset,
        agentAdministration: admin,
      })
    } catch (failure) {
      setError(t('error.generic', { message: failure instanceof Error ? failure.message : String(failure) }))
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={agent === undefined ? t('form.createTitle') : t('form.editTitle', { name: agent.name })}
      closeLabel={t('form.close')}
      className={css.formModal ?? ''}
      contentClassName={css.formContent ?? ''}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('form.cancel')}</Button>
          <Button variant="primary" disabled={saving || name.trim() === ''} onClick={() => { void submit() }}>
            {saving ? t('form.saving') : agent === undefined ? t('form.create') : t('form.save')}
          </Button>
        </>
      )}
    >
      <div className={css.form}>
        <Field id={`${id}-name`} label={t('form.name')}>
          <Input id={`${id}-name`} value={name} placeholder={t('form.namePlaceholder')} onChange={(event) => { setName(event.target.value) }} />
        </Field>
        <Field id={`${id}-description`} label={t('form.description')}>
          <Input id={`${id}-description`} value={description} placeholder={t('form.descriptionPlaceholder')} onChange={(event) => { setDescription(event.target.value) }} />
        </Field>
        <Field id={`${id}-instructions`} label={t('form.instructions')}>
          <textarea
            id={`${id}-instructions`}
            className={css.textarea}
            rows={4}
            value={instructions}
            placeholder={t('form.instructionsPlaceholder')}
            onChange={(event) => { setInstructions(event.target.value) }}
          />
        </Field>
        <div className={css.fieldRow}>
          <Field id={`${id}-mode`} label={t('form.mode')}>
            <select id={`${id}-mode`} className={css.select} value={mode} onChange={(event) => { setMode(event.target.value) }}>
              {modes.map(option => <option key={option.id} value={option.id}>{modeLabel(option.id, option.name, t)}</option>)}
            </select>
          </Field>
          <Field id={`${id}-model`} label={t('form.model')}>
            <select id={`${id}-model`} className={css.select} value={model} onChange={(event) => { setModel(event.target.value) }}>
              <option value="">{t('form.modelDefault')}</option>
              {options.models.map(group => (
                <optgroup key={group.provider} label={group.name}>
                  {group.models.map(entry => (
                    <option key={entry.id} value={modelKey({ provider: group.provider, model: entry.id })}>{entry.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
        </div>
        <Field id={`${id}-workspace`} label={t('form.workspace')}>
          <Input id={`${id}-workspace`} value={workspace} placeholder={t('form.workspacePlaceholder')} onChange={(event) => { setWorkspace(event.target.value) }} />
        </Field>
        <div className={css.fieldRow}>
          <Field id={`${id}-allow`} label={t('form.allow')}>
            <Input id={`${id}-allow`} value={allow} placeholder={t('form.toolsPlaceholder')} onChange={(event) => { setAllow(event.target.value) }} />
          </Field>
          <Field id={`${id}-deny`} label={t('form.deny')}>
            <Input id={`${id}-deny`} value={deny} placeholder={t('form.toolsPlaceholder')} onChange={(event) => { setDeny(event.target.value) }} />
          </Field>
        </div>
        {presetOptions.length > 0 && (
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('form.permissions')}</span>
            <SegmentedControl id={`${id}-preset`} label={t('form.permissions')} value={preset} options={presetOptions} onChange={setPreset} />
            <span className={css.hint}>{t('form.permissionsHint')}</span>
          </div>
        )}
        <Checkbox checked={admin} onChange={setAdmin} label={t('form.admin')} />
        <span className={css.hint}>{t('form.approvalHint')}</span>
        {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
