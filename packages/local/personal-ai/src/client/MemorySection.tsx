/** Memory: view, search, add, correct, disable, and delete. Secrets are refused by the Host. */
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Input, RiskConfirmation, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type Memory, type MemoryScope } from './api.ts'
import { ago, errorText } from './format.ts'
import type { Translate } from './locales.ts'
import css from './CommandCenter.module.css'

const GROW = css.grow ?? ''

const SCOPES: readonly MemoryScope[] = ['user', 'project', 'agent', 'session']

/**
 * Render the memory section.
 * @param props - copy.
 * @returns the section.
 */
export function MemorySection({ t }: { readonly t: Translate }) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<MemoryScope | ''>('')
  const [disabled, setDisabled] = useState(false)
  const [rows, setRows] = useState<readonly Memory[]>([])
  const [error, setError] = useState<string | undefined>()
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string } | undefined>()
  const [deleting, setDeleting] = useState<Memory | undefined>()
  const [acknowledged, setAcknowledged] = useState(false)

  const load = useCallback(async () => {
    try {
      setRows(await api.memories({ q: query, ...scope === '' ? {} : { scope }, disabled }))
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [query, scope, disabled])

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
      <p className={css.muted}>{t('memory.subtitle')}</p>
      <form
        className={css.row}
        onSubmit={(event) => {
          event.preventDefault()
          if (draft.trim() === '') return
          void act(async () => {
            await api.addMemory(draft.trim())
            setDraft('')
          })
        }}
      >
        <Input className={GROW} value={draft} placeholder={t('memory.addPlaceholder')} aria-label={t('memory.add')} onChange={(event) => { setDraft(event.target.value) }} />
        <Button size="sm" variant="primary" type="submit" disabled={draft.trim() === ''}>{t('memory.add')}</Button>
      </form>
      <div className={css.row}>
        <Input className={GROW} value={query} placeholder={t('memory.search')} aria-label={t('memory.search')} onChange={(event) => { setQuery(event.target.value) }} />
        <select className={css.select} value={scope} aria-label={t('memory.scope')} onChange={(event) => { setScope(event.target.value as MemoryScope | '') }}>
          <option value="">{t('memory.allScopes')}</option>
          {SCOPES.map(value => <option key={value} value={value}>{t(`scope.${value}`)}</option>)}
        </select>
        <Checkbox checked={disabled} onChange={setDisabled} label={t('memory.showDisabled')} />
      </div>
      {error !== undefined && <p className={css.warning} role="alert">{error}</p>}
      {rows.length === 0
        ? <p className={css.muted}>{t('memory.empty')}</p>
        : (
          <ul className={css.list}>
            {rows.map(memory => (
              <li key={memory.id} className={css.item} data-disabled={memory.status === 'disabled'}>
                <div className={css.row}>
                  <Tag tone={memory.scope === 'user' ? 'solid' : 'outline'}>{t(`scope.${memory.scope}`)}</Tag>
                  {editing?.id === memory.id
                    ? (
                      <form
                        className={`${css.row} ${css.grow}`}
                        onSubmit={(event) => {
                          event.preventDefault()
                          void act(async () => {
                            await api.updateMemory(memory.id, { text: editing.text })
                            setEditing(undefined)
                          })
                        }}
                      >
                        <Input className={GROW} value={editing.text} aria-label={t('memory.edit')} onChange={(event) => { setEditing({ id: memory.id, text: event.target.value }) }} />
                        <Button size="sm" variant="primary" type="submit">{t('common.save')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(undefined) }}>{t('common.cancel')}</Button>
                      </form>
                    )
                    : <span className={css.grow}>{memory.text}</span>}
                  <span className={css.muted}>{ago(memory.updatedAt)}</span>
                </div>
                <div className={css.row}>
                  {memory.tags.map(tag => <Tag key={tag} tone="quiet">{tag}</Tag>)}
                  <span className={css.grow} />
                  <Button size="sm" variant="ghost" onClick={() => { setEditing({ id: memory.id, text: memory.text }) }}>{t('memory.edit')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { void act(() => api.updateMemory(memory.id, { status: memory.status === 'active' ? 'disabled' : 'active' })) }}>
                    {memory.status === 'active' ? t('memory.disable') : t('memory.enable')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setAcknowledged(false); setDeleting(memory) }}>{t('memory.delete')}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      <RiskConfirmation
        open={deleting !== undefined}
        title={t('memory.deleteTitle')}
        description={t('memory.deleteDescription', { text: deleting?.text ?? '' })}
        acknowledgeLabel={t('memory.deleteAcknowledge')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        confirmLabel={t('memory.delete')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setDeleting(undefined) }}
        onConfirm={() => {
          const target = deleting
          setDeleting(undefined)
          if (target !== undefined) void act(() => api.deleteMemory(target.id))
        }}
      />
    </div>
  )
}
