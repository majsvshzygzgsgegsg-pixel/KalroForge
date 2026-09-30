import { useMemo, useState } from 'react'
import { IconGlobeOutlineMedium, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PhoneConnectAction.module.css'

export type PhoneConnectActionProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'settings'>

function phoneConnectDetails() {
  const current = new URL(globalThis.location?.href ?? 'http://127.0.0.1:3080/')
  const token = current.searchParams.get('token') ?? ''
  const port = current.port === '' ? '3080' : current.port
  const loopback = current.hostname === '127.0.0.1' || current.hostname === 'localhost' || current.hostname === '[::1]'
  const host = loopback ? 'YOUR-MAC-IP' : current.hostname
  const url = new URL(current)
  url.hostname = host
  url.port = port
  if (token !== '') url.searchParams.set('token', token)
  const code = token === '' ? 'OPEN-SERVER-FIRST' : token
  return { code, url: url.toString(), loopback }
}

/**
 * Sidebar footer action that teaches a phone how to join the Mac-hosted
 * KairoForge server. The server still owns authentication; this component only
 * surfaces the current token and a LAN URL format.
 */
export function PhoneConnectAction({ wide, t }: PhoneConnectActionProps) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'url' | 'code' | null>(null)
  const details = useMemo(phoneConnectDetails, [open])
  const copy = async (kind: 'url' | 'code', value: string) => {
    await navigator.clipboard?.writeText(value)
    setCopied(kind)
    window.setTimeout(() => { setCopied(null) }, 1400)
  }

  const trigger = (
    <button type="button" className={css.trigger} aria-label={t('phoneConnect.trigger')} onClick={() => { setOpen(true) }}>
      <IconGlobeOutlineMedium size={wide ? 16 : 18} />
      {wide && <span className={css.triggerLabel}>{t('phoneConnect.trigger')}</span>}
    </button>
  )

  return (
    <>
      {wide
        ? trigger
        : (
          <Tooltip portal label={t('phoneConnect.trigger')} side="right" delayMs={500}>
            {trigger}
          </Tooltip>
        )}
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('phoneConnect.title')}
        description={t('phoneConnect.description')}
        closeLabel={t('close')}
      >
        <div className={css.body}>
          <div className={css.hero}>
            <div className={css.heroIcon}><IconGlobeOutlineMedium size={22} /></div>
            <div>
              <div className={css.heroTitle}>{t('phoneConnect.sameWifi')}</div>
              <div className={css.heroText}>{t('phoneConnect.sameWifiHelp')}</div>
            </div>
          </div>

          <div className={css.field}>
            <div className={css.label}>{t('phoneConnect.url')}</div>
            <div className={css.copyRow}>
              <code className={css.value}>{details.url}</code>
              <button type="button" className={css.copy} onClick={() => void copy('url', details.url)}>
                {copied === 'url' ? t('phoneConnect.copied') : t('phoneConnect.copy')}
              </button>
            </div>
          </div>

          <div className={css.field}>
            <div className={css.label}>{t('phoneConnect.code')}</div>
            <div className={css.copyRow}>
              <code className={css.value}>{details.code}</code>
              <button type="button" className={css.copy} onClick={() => void copy('code', details.code)}>
                {copied === 'code' ? t('phoneConnect.copied') : t('phoneConnect.copy')}
              </button>
            </div>
          </div>

          <ol className={css.steps}>
            <li>{t('phoneConnect.step.launch')}</li>
            <li>{details.loopback ? t('phoneConnect.step.ip') : t('phoneConnect.step.open')}</li>
            <li>{t('phoneConnect.step.code')}</li>
          </ol>
        </div>
      </Modal>
    </>
  )
}
