/**
 * Settings: personality, voice, notifications, the coordinator switch, HUD
 * quality, and the Fast vs Standard comparison. Model routing stays on the
 * Agents page (Orchestration tab), which already owns it.
 */
import { useEffect, useState } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type MetricsSummary, type Personality } from './api.ts'
import { duration, errorText } from './format.ts'
import { readHudPrefs, writeHudPrefs, type HudPrefs } from './prefs.ts'
import type { LiveStore } from './store.ts'
import type { Translate } from './locales.ts'
import css from './CommandCenter.module.css'

/** Settings props. */
export interface SettingsSectionProps {
  readonly t: Translate
  readonly store: LiveStore
  readonly openAgents: () => void
}

/**
 * A switch with its label visible beside it (the primitive only labels for assistive tech).
 * @param props - state, label, and change handler.
 * @returns the labelled switch.
 */
function Toggle({ checked, label, onChange }: {
  readonly checked: boolean
  readonly label: string
  readonly onChange: (next: boolean) => void
}) {
  return (
    <div className={css.row}>
      <Switch checked={checked} label={label} onChange={onChange} />
      <span aria-hidden="true">{label}</span>
    </div>
  )
}

/**
 * Render the settings section.
 * @param props - copy, store, and navigation.
 * @returns the section.
 */
export function SettingsSection({ t, store, openAgents }: SettingsSectionProps) {
  const [personality, setPersonality] = useState<Personality | undefined>()
  const [coordinator, setCoordinator] = useState(true)
  const [metrics, setMetrics] = useState<MetricsSummary | undefined>()
  const [hud, setHud] = useState<HudPrefs>(readHudPrefs)
  const [message, setMessage] = useState<{ readonly tone: 'ok' | 'error'; readonly text: string } | undefined>()
  const voices = store.provider()?.tts.voices() ?? []

  useEffect(() => {
    void api.personality().then((result) => {
      setPersonality(result.personality)
      setCoordinator(result.coordinator)
    }, (failure: unknown) => { setMessage({ tone: 'error', text: errorText(failure) }) })
    void api.metrics().then((result) => { setMetrics(result.summary) }, () => {})
  }, [])

  if (personality === undefined) return <p className={css.muted}>{message?.text ?? t('page.loading')}</p>

  const save = async (): Promise<void> => {
    try {
      const saved = await api.savePersonality({
        name: personality.name,
        instructions: personality.instructions,
        speakingStyle: personality.speakingStyle,
        verbosity: personality.verbosity,
        voice: personality.voice,
        notifications: personality.notifications,
        handsFree: personality.handsFree,
      })
      setPersonality(saved)
      const provider = store.provider()
      provider?.tts.setVoice({ name: saved.voice.name ?? '', rate: saved.voice.rate })
      provider?.stt.setHandsFree(saved.handsFree)
      setMessage({ tone: 'ok', text: t('settings.saved') })
    } catch (failure) {
      setMessage({ tone: 'error', text: errorText(failure) })
    }
  }

  const modes = Object.entries(metrics?.byMode ?? {})

  return (
    <div className={css.section}>
      <h3 className={css.subheading}>{t('settings.personality')}</h3>
      <div className={css.formGrid}>
        <label className={css.field}>
          <span>{t('settings.name')}</span>
          <Input
            value={personality.name}
            maxLength={40}
            onChange={(event) => { setPersonality({ ...personality, name: event.target.value }) }}
          />
        </label>
        <label className={css.field}>
          <span>{t('settings.style')}</span>
          <Input
            value={personality.speakingStyle}
            maxLength={200}
            onChange={(event) => { setPersonality({ ...personality, speakingStyle: event.target.value }) }}
          />
        </label>
        <label className={css.field}>
          <span>{t('settings.verbosity')}</span>
          <select className={css.select} value={personality.verbosity} onChange={(event) => { setPersonality({ ...personality, verbosity: event.target.value as Personality['verbosity'] }) }}>
            {(['brief', 'balanced', 'detailed'] as const).map(value => <option key={value} value={value}>{t(`verbosity.${value}`)}</option>)}
          </select>
        </label>
        <label className={css.field}>
          <span>{t('settings.notifications')}</span>
          <select className={css.select} value={personality.notifications} onChange={(event) => { setPersonality({ ...personality, notifications: event.target.value as Personality['notifications'] }) }}>
            {(['all', 'important', 'off'] as const).map(value => <option key={value} value={value}>{t(`notifications.${value}`)}</option>)}
          </select>
        </label>
      </div>
      <label className={css.field}>
        <span>{t('settings.instructions')}</span>
        <textarea
          className={css.textarea}
          rows={4}
          maxLength={4000}
          value={personality.instructions}
          placeholder={t('settings.instructionsPlaceholder')}
          onChange={(event) => { setPersonality({ ...personality, instructions: event.target.value }) }}
        />
      </label>

      <h3 className={css.subheading}>{t('settings.voice')}</h3>
      <div className={css.formGrid}>
        <label className={css.field}>
          <span>{t('settings.voiceName')}</span>
          <select className={css.select} value={personality.voice.name ?? ''} onChange={(event) => { setPersonality({ ...personality, voice: { ...personality.voice, name: event.target.value } }) }}>
            <option value="">{t('settings.voiceAuto')}</option>
            {voices.map(voice => <option key={voice.name} value={voice.name}>{`${voice.name} (${voice.lang})`}</option>)}
          </select>
        </label>
        <label className={css.field}>
          <span>{t('settings.rate', { rate: personality.voice.rate.toFixed(2) })}</span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={personality.voice.rate}
            onChange={(event) => { setPersonality({ ...personality, voice: { ...personality.voice, rate: Number(event.target.value) } }) }}
          />
        </label>
      </div>
      <Toggle checked={personality.handsFree} label={t('settings.handsFree')} onChange={(next) => { setPersonality({ ...personality, handsFree: next }) }} />
      {voices.length === 0 && <p className={css.muted}>{t('settings.noVoices')}</p>}

      <div className={css.row}>
        <Button variant="primary" onClick={() => { void save() }}>{t('common.save')}</Button>
        {message !== undefined && <span className={message.tone === 'ok' ? css.success : css.warning} role="status">{message.text}</span>}
      </div>

      <h3 className={css.subheading}>{t('settings.coordinator')}</h3>
      <Toggle
        checked={coordinator}
        label={t('settings.coordinatorLabel')}
        onChange={(next) => {
          void api.setCoordinator(next).then((result) => { setCoordinator(result.coordinator) }, (failure: unknown) => { setMessage({ tone: 'error', text: errorText(failure) }) })
        }}
      />
      <p className={css.muted}>{t('settings.coordinatorHelp')}</p>
      <div className={css.row}>
        <p className={`${css.muted} ${css.grow}`}>{t('settings.routing')}</p>
        <Button size="sm" variant="outline" onClick={openAgents}>{t('settings.openRouting')}</Button>
      </div>

      <h3 className={css.subheading}>{t('settings.hud')}</h3>
      <div className={css.formGrid}>
        <label className={css.field}>
          <span>{t('settings.performance')}</span>
          <select className={css.select} value={hud.performance} onChange={(event) => { setHud(writeHudPrefs({ performance: event.target.value as HudPrefs['performance'] })) }}>
            {(['auto', 'on', 'off'] as const).map(value => <option key={value} value={value}>{t(`performance.${value}`)}</option>)}
          </select>
        </label>
        <label className={css.field}>
          <span>{t('settings.motion')}</span>
          <select
            className={css.select}
            value={String(hud.reducedMotion)}
            onChange={(event) => { setHud(writeHudPrefs({ reducedMotion: event.target.value === 'auto' ? 'auto' : event.target.value === 'true' })) }}
          >
            <option value="auto">{t('motion.auto')}</option>
            <option value="true">{t('motion.reduced')}</option>
            <option value="false">{t('motion.full')}</option>
          </select>
        </label>
      </div>
      <Toggle checked={hud.stateBar} label={t('settings.stateBar')} onChange={(next) => { setHud(writeHudPrefs({ stateBar: next })) }} />

      <h3 className={css.subheading}>{t('settings.metrics')}</h3>
      {modes.length === 0
        ? <p className={css.muted}>{t('activity.noTurns')}</p>
        : (
          <table className={css.table}>
            <thead>
              <tr>
                <th scope="col">{t('metrics.mode')}</th>
                <th scope="col">{t('metrics.turns')}</th>
                <th scope="col">{t('metrics.time')}</th>
                <th scope="col">{t('metrics.steps')}</th>
                <th scope="col">{t('metrics.tools')}</th>
                <th scope="col">{t('metrics.tokens')}</th>
                <th scope="col">{t('metrics.success')}</th>
              </tr>
            </thead>
            <tbody>
              {modes.map(([mode, stats]) => (
                <tr key={mode}>
                  <th scope="row">{mode === 'fast' ? t('metrics.fast') : mode === 'standard' ? t('metrics.standard') : mode}</th>
                  <td>{stats.turns}</td>
                  <td>{duration(stats.avgDurationMs)}</td>
                  <td>{stats.avgSteps}</td>
                  <td>{stats.avgToolCalls}</td>
                  <td>{stats.avgTokens ?? '—'}</td>
                  <td>{`${String(Math.round(stats.successRate * 100))}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  )
}
