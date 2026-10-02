/**
 * Pause / resume / cancel / update / constrain buttons for one piece of
 * running work. Every press shows the outcome the Host observed: applied,
 * delivered to the running agent, or rejected with the reason.
 */
import { useState } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type ControlAction, type ControlRecord, type TaskRef } from './api.ts'
import type { Translate } from './locales.ts'
import css from './CommandCenter.module.css'

const GROW = css.grow ?? ''

/** Control bar props. */
export interface ControlBarProps {
  readonly target: TaskRef
  readonly actions: readonly ControlAction[]
  readonly t: Translate
  readonly onDone?: () => void
}

const OUTCOME_TONE = { applied: 'success', delivered: 'info', rejected: 'warning' } as const

/**
 * Render the control bar.
 * @param props - target, allowed actions, and copy.
 * @returns buttons, an optional text field, and the last outcome.
 */
export function ControlBar({ target, actions, t, onDone }: ControlBarProps) {
  const [busy, setBusy] = useState(false)
  const [compose, setCompose] = useState<'update' | 'constrain' | undefined>()
  const [text, setText] = useState('')
  const [result, setResult] = useState<ControlRecord | { readonly outcome: 'rejected'; readonly detail: string } | undefined>()

  const send = async (action: ControlAction, value?: string): Promise<void> => {
    setBusy(true)
    try {
      setResult(await api.control(target, action, value))
      setCompose(undefined)
      setText('')
    } catch (error) {
      setResult({ outcome: 'rejected', detail: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
      onDone?.()
    }
  }

  return (
    <div className={css.controls}>
      <div className={css.row}>
        {actions.map(action => (
          <Button
            key={action}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (action === 'update' || action === 'constrain') setCompose(compose === action ? undefined : action)
              else void send(action)
            }}
          >
            {t(`control.${action}`)}
          </Button>
        ))}
      </div>
      {compose !== undefined && (
        <form
          className={css.row}
          onSubmit={(event) => {
            event.preventDefault()
            if (text.trim() !== '') void send(compose, text.trim())
          }}
        >
          <Input
            className={GROW}
            value={text}
            placeholder={t(compose === 'update' ? 'control.updatePlaceholder' : 'control.constrainPlaceholder')}
            aria-label={t(compose === 'update' ? 'control.update' : 'control.constrain')}
            onChange={(event) => { setText(event.target.value) }}
          />
          <Button size="sm" variant="primary" type="submit" disabled={busy || text.trim() === ''}>{t('control.send')}</Button>
        </form>
      )}
      {result !== undefined && (
        <p className={css.outcome} role="status">
          <Tag tone={OUTCOME_TONE[result.outcome]}>{t(`outcome.${result.outcome}`)}</Tag>
          <span>{result.detail}</span>
        </p>
      )}
    </div>
  )
}
