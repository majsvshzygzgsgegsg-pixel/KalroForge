/** KairoForge connections catalog: press Connect once and sign in for real. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ConnectionsCard.module.css'

/** Styles forwarded to primitives: their `className` accepts `string`, not `string | undefined`. */
const classes = css

/**
 * One stylesheet class name for a primitive that takes a plain string.
 * @param name - the class key in this module's stylesheet.
 * @returns the generated class name, or an empty string for a key the stylesheet does not define.
 */
const classOf = (name: string): string => classes[name] ?? ''

/** Same-origin HTTP base of the Host connections service. */
const CONNECT_BASE = '/kairoforge/connect'

/** How often a transient attempt is re-read, in ms. */
const ATTEMPT_POLL_MS = 800
/** First read of a new attempt: the Host needs a moment to ask its first question. */
const ATTEMPT_FIRST_POLL_MS = 200

/** A method kind the Host can drive end to end. */
type ConnectMethodKind = 'oauth' | 'device' | 'token' | 'cli'

/** One sign-in method offered by a connector (most preferred first). */
interface ConnectMethod {
  readonly id: string
  readonly label: string
  readonly kind: ConnectMethodKind
}

/** The stored account connection of a connector, or null while unconnected. */
interface ConnectConnection {
  readonly status: string
  readonly account: string
  readonly connectedAt: string
  readonly verified: boolean
  readonly method: string
}

/** One connector row from the Host catalog. */
interface ConnectService {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly methods: readonly ConnectMethod[]
  readonly connection: ConnectConnection | null
}

/** The typed input one attempt asks the user for. */
interface ConnectPrompt {
  readonly kind: 'secret' | 'text'
  readonly label: string
  readonly placeholder: string
  readonly help?: string
}

/** Attempt lifecycle; the first four phases are transient and are polled. */
type ConnectPhase =
  | 'waiting-browser' | 'waiting-code' | 'waiting-input' | 'exchanging'
  | 'connected' | 'failed' | 'cancelled'

/** One live sign-in attempt owned by the Host. */
interface ConnectAttempt {
  readonly id: string
  readonly service: string
  readonly serviceName?: string
  readonly method: string
  readonly phase: ConnectPhase
  readonly message?: string
  readonly url?: string
  readonly code?: string
  readonly prompt?: ConnectPrompt
  readonly account?: string
  readonly verified?: boolean
  readonly error?: string
}

/** The catalog payload plus its connected tally. */
interface ConnectCatalog {
  readonly services: readonly ConnectService[]
  readonly connectedCount: number
}

/** The connector whose connected row is open in the manage view. */
interface ManageTarget {
  readonly service: ConnectService
  readonly connection: ConnectConnection
}

/** Phases worth polling and worth cancelling when the dialog closes. */
const TRANSIENT_PHASES: readonly ConnectPhase[] = ['waiting-browser', 'waiting-code', 'waiting-input', 'exchanging']

/** Whether an attempt is still in flight (poll and offer Cancel). */
const isTransient = (phase: ConnectPhase): boolean => TRANSIENT_PHASES.includes(phase)

/** A Host-reported failure carrying the machine code when one was sent. */
class ConnectError extends Error {
  /** @param message - user-facing sentence. @param code - Host error code when present. */
  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

/** Read a JSON body, rejecting the documented Host error envelope. */
async function readJson(response: Response): Promise<unknown> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const failure = body as { code?: unknown; message?: unknown } | undefined
    throw new ConnectError(
      typeof failure?.message === 'string' ? failure.message : `Request failed (HTTP ${response.status})`,
      typeof failure?.code === 'string' ? failure.code : undefined,
    )
  }
  return body
}

/** Pull a typed field off an unknown JSON payload. */
function field(value: unknown, key: string): unknown {
  return (value as Record<string, unknown> | null | undefined)?.[key]
}

/** One JSON request against the Host connections service. */
async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  return readJson(await fetch(`${CONNECT_BASE}${path}`, {
    credentials: 'same-origin',
    ...body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    ...signal === undefined ? {} : { signal },
  }))
}

/** Load the connector catalog. A missing `connection` field means "not connected". */
async function fetchCatalog(signal: AbortSignal): Promise<ConnectCatalog> {
  const payload = await request('/catalog', undefined, signal)
  const services = ((field(payload, 'services') as ConnectService[] | undefined) ?? [])
    .map(service => ({ ...service, connection: service.connection ?? null }))
  return { services, connectedCount: (field(payload, 'connectedCount') as number | undefined) ?? 0 }
}

/** Start a sign-in attempt for one method. */
async function startAttempt(service: string, method: string): Promise<ConnectAttempt> {
  return field(await request('/start', { service, method }), 'attempt') as ConnectAttempt | undefined
    ?? Promise.reject(new ConnectError('The service did not return a sign-in attempt.'))
}

/** Read the current state of one attempt. */
async function fetchAttempt(id: string, signal?: AbortSignal): Promise<ConnectAttempt> {
  return field(await request(`/attempt?id=${encodeURIComponent(id)}`, undefined, signal), 'attempt') as ConnectAttempt | undefined
    ?? Promise.reject(new ConnectError('The service did not return the sign-in attempt.'))
}

/** Answer the input one attempt is waiting for. */
async function answerAttempt(id: string, value: string): Promise<ConnectAttempt> {
  return field(await request('/answer', { id, value }), 'attempt') as ConnectAttempt | undefined
    ?? Promise.reject(new ConnectError('The service did not return the sign-in attempt.'))
}

/** Abandon an attempt on the Host. */
async function cancelAttempt(id: string): Promise<ConnectAttempt> {
  return field(await request('/cancel', { id }), 'attempt') as ConnectAttempt | undefined
    ?? Promise.reject(new ConnectError('The service did not return the sign-in attempt.'))
}

/** Remove a stored connection. */
async function disconnectService(service: string): Promise<void> {
  await request('/disconnect', { service })
}

/** A local failed attempt standing in for a Host-called-off start. */
function failedAttempt(service: ConnectService, method: ConnectMethod, error: string): ConnectAttempt {
  return { id: `local:${service.id}:${method.id}`, service: service.id, serviceName: service.name, method: method.id, phase: 'failed', error }
}

/** Work around the browser's `window.open` returning null without throwing. */
function mayBeBlockedByPopup(url: string): boolean {
  let opened: Window | null = null
  try {
    opened = window.open(url, '_blank', 'noopener')
  } catch {
    return true
  }
  return opened === null
}

/** Labels and command for one already-connected catalog row. */
interface ConnectedRowProps {
  readonly connection: ConnectConnection
  readonly name: string
  readonly labels: { readonly connected: string; readonly manage: string }
  readonly onManage: (connection: ConnectConnection) => void
}

/**
 * Render a connected row: the success chip naming the account plus Manage.
 * @param props - the stored connection, service name, labels, and manage command.
 * @returns the row's right-hand control column.
 */
function ConnectedRow({ connection, name, labels, onManage }: ConnectedRowProps) {
  const state = `${labels.connected}: ${connection.account}`
  return <div className={css.connected}>
    <span className={css.connectedChip} title={state} aria-label={state}>{labels.connected}</span>
    <Button size="sm" variant="ghost" aria-label={`${labels.manage}: ${name}`}
      onClick={() => { onManage(connection) }}>
      {labels.manage}
    </Button>
  </div>
}

/**
 * Render the connector catalog and drive a real sign-in from a single press.
 * @param props - settings runtime and localized copy.
 * @returns the General Settings connections row.
 */
export function ConnectionsCard({ t }: PropsRuntime<'settings.general.item'> & PropsLocale<'settings'>) {
  const [catalog, setCatalog] = useState<ConnectCatalog | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [attempt, setAttempt] = useState<ConnectAttempt | null>(null)
  const [manage, setManage] = useState<ManageTarget | null>(null)
  const [startingService, setStartingService] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState('')
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  // The Host answers a start request before its flow has asked anything, so the
  // first poll of a new attempt is early and the rest settle into the interval.
  const polledAttempt = useRef<string | null>(null)

  /** Read the catalog, reporting failure inline instead of throwing. */
  const load = useCallback(async (): Promise<void> => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setLoadError(null)
    try {
      const value = await fetchCatalog(next.signal)
      if (next.signal.aborted) return
      setCatalog(value)
    } catch (error) {
      if (next.signal.aborted) return
      setCatalog(current => current ?? { services: [], connectedCount: 0 })
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void load()
    return () => { controller.current?.abort() }
  }, [load])

  // Transient phases follow the Host: one early read, then every 800ms until a
  // terminal phase lands. At most one poll is ever in flight, because the timer
  // is keyed on the attempt snapshot each poll replaces.
  useEffect(() => {
    if (attempt === null || !isTransient(attempt.phase)) return
    const id = attempt.id
    const first = polledAttempt.current !== id
    polledAttempt.current = id
    const timer = window.setTimeout(() => {
      void fetchAttempt(id).then(setAttempt).catch(() => { /* a failed poll is ignored; the next one retries */ })
    }, first ? ATTEMPT_FIRST_POLL_MS : ATTEMPT_POLL_MS)
    return () => { window.clearTimeout(timer) }
  }, [attempt])

  // connected: the stored catalog no longer matches the Host; reload it once.
  useEffect(() => {
    if (attempt?.phase === 'connected') void load()
  }, [attempt, load])

  // cancelled: the Host closed the attempt, so leave the dialog.
  useEffect(() => {
    if (attempt?.phase === 'cancelled') setAttempt(null)
  }, [attempt])

  // A stale copy label must not survive into the next device code.
  useEffect(() => { setCopied(false) }, [attempt?.code])

  // The flash label returns to Copy on its own, like the phone-connect panel.
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => { setCopied(false) }, 1500)
    return () => { window.clearTimeout(timer) }
  }, [copied])

  /** Close the dialog, asking the Host to abandon a still-live attempt first. */
  const closeDialog = useCallback((): void => {
    setAttempt((current) => {
      if (current !== null && isTransient(current.phase) && !current.id.startsWith('local:')) {
        void cancelAttempt(current.id).catch(() => { /* the attempt expires on its own */ })
      }
      return null
    })
  }, [])

  /** POST /start in the same press, then show the live attempt. */
  const connect = useCallback((service: ConnectService): void => {
    const method = service.methods[0]
    setManage(null)
    setNotice(null)
    if (method === undefined) {
      setAttempt(failedAttempt(service, { id: 'unavailable', label: '', kind: 'token' }, t('connections.noMethod')))
      return
    }
    setStartingService(service.id)
    void startAttempt(service.id, method.id)
      .then((value) => { setAttempt(value) })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error))
      })
      .finally(() => { setStartingService(null) })
  }, [t])

  /** Re-run the method of the attempt that just failed. */
  const retry = useCallback((): void => {
    if (attempt === null || attempt.phase !== 'failed' || startingService !== null) return
    const service = catalog?.services.find(item => item.id === attempt.service)
    if (service !== undefined) {
      connect(service)
      return
    }
    // The catalog is gone or no longer lists it: try the same ids anyway.
    setStartingService(attempt.service)
    void startAttempt(attempt.service, attempt.method)
      .then((value) => { setAttempt(value) })
      .catch((error: unknown) => { setNotice(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setStartingService(null) })
  }, [attempt, catalog, connect, startingService])

  /** Copy the device code and flash the confirmation label. */
  const copyCode = useCallback((code: string): void => {
    const clipboard = navigator.clipboard as Clipboard | undefined
    void clipboard?.writeText(code).then(() => { setCopied(true) }, () => { /* manual selection still works */ })
  }, [])

  /** Send the typed secret or code back to the Host. */
  const submitAnswer = useCallback((): void => {
    const current = attempt
    if (current === null || answer.trim() === '' || busy) return
    setBusy(true)
    void answerAttempt(current.id, answer)
      .then((value) => { setAttempt(value); setAnswer('') })
      .catch((error: unknown) => { setNotice(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setBusy(false) })
  }, [answer, attempt, busy])

  /** Open the sign-in page; a blocked popup keeps the URL reachable. */
  const openSignIn = useCallback((url: string): void => {
    if (mayBeBlockedByPopup(url)) setNotice(t('connections.popupBlocked'))
  }, [t])

  /** Drop the stored connection, then close and re-read the catalog. */
  const disconnect = useCallback((service: ConnectService): void => {
    if (busy) return
    setBusy(true)
    void disconnectService(service.id)
      .then(() => {
        setManage(null)
        setCatalog(current => current === null ? current : {
          ...current,
          services: current.services.map(item => item.id === service.id ? { ...item, connection: null } : item),
          connectedCount: Math.max(0, current.connectedCount - 1),
        })
        void load()
      })
      .catch((error: unknown) => { setNotice(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setBusy(false) })
  }, [busy, load])

  const categories = useMemo(
    () => ['All', ...Array.from(new Set((catalog?.services ?? []).map(service => service.category)))],
    [catalog],
  )
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (catalog?.services ?? []).filter(service =>
      (category === 'All' || service.category === category)
      && (needle === '' || service.name.toLowerCase().includes(needle) || service.category.toLowerCase().includes(needle)))
  }, [catalog, category, query])

  const count = catalog?.services.length ?? 0
  const connectedCount = catalog?.connectedCount ?? 0
  const loading = catalog === null && loadError === null
  const dialogOpen = attempt !== null || manage !== null
  const dialogService = attempt !== null
    ? (catalog?.services.find(item => item.id === attempt.service) ?? null)
    : manage?.service ?? null
  const dialogName = attempt?.serviceName ?? dialogService?.name ?? attempt?.service ?? manage?.service.name ?? ''
  const dialogTitle = manage === null
    ? t('connections.connectTitle', { service: dialogName })
    : t('connections.manageTitle', { service: dialogName })
  const phase = attempt?.phase
  const attemptMessage = attempt?.message
  const attemptUrl = attempt?.url
  const attemptPrompt = attempt?.prompt
  const attemptCode = attempt?.code
  const attemptAccount = attempt?.account
  const attemptError = attempt?.error
  // Read every dialog field through the optional chain: the JSX below narrows
  // nothing, so a nullable binding may not be dereferenced in a child position.
  const attemptBusy = phase !== undefined && isTransient(phase)
  const attemptVerified = attempt?.verified === true
  const promptLabel = attemptPrompt?.label ?? ''
  const promptKind = attemptPrompt?.kind ?? 'text'
  const promptPlaceholder = attemptPrompt?.placeholder
  const promptHelp = attemptPrompt?.help
  const manageAccount = manage?.connection.account ?? ''
  const manageConnectedAt = manage?.connection.connectedAt
  const manageConnectedText = manageConnectedAt === undefined ? '' : new Date(manageConnectedAt).toLocaleString()
  const manageVerified = manage?.connection.verified === true
  const manageMethod = manage?.service.methods.find(candidate => candidate.id === manage.connection.method)?.label
    ?? manage?.connection.method ?? ''

  return <div className={css.row}>
    <div className={css.header}>
      <div>
        <div className={css.title}>{t('connections.title')}</div>
        <div className={css.description}>{t('connections.description')}</div>
      </div>
      <div className={css.badges}>
        <div className={css.badge}>{t('connections.count', { count })}</div>
        {connectedCount > 0 && <div className={css.badgeConnected}>
          {t('connections.connectedCount', { count: connectedCount })}
        </div>}
      </div>
    </div>
    <div className={css.toolbar}>
      <input className={css.search} value={query} type="search" placeholder={t('connections.search')}
        aria-label={t('connections.search')} onChange={(event) => { setQuery(event.currentTarget.value) }} />
      <select className={css.select} value={category} aria-label={t('connections.category')}
        onChange={(event) => { setCategory(event.currentTarget.value) }}>
        {categories.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </div>
    {notice !== null && <div className={css.error} role="alert">
      <div className={css.errorText}>{notice}</div>
      <Button size="sm" onClick={() => { setNotice(null) }}>{t('connections.dismiss')}</Button>
    </div>}
    {loading && <div className={css.grid} aria-busy="true">
      {Array.from({ length: 8 }, (_, index) => <div className={css.skeleton} key={index} />)}
      <div className={css.empty} role="status">{t('connections.loading')}</div>
    </div>}
    {loadError !== null && <div className={css.error} role="alert">
      <div className={css.errorText}>{t('connections.loadFailed')}: {loadError}</div>
      <Button size="sm" onClick={() => { void load() }}>{t('connections.retry')}</Button>
    </div>}
    {!loading && visible.length === 0 && <div className={css.empty}>{t('connections.empty')}</div>}
    {!loading && visible.length > 0 && <div className={css.grid}>
      {visible.map(service => <div className={css.card} key={service.id}>
        <div className={css.service}>
          <div className={css.name} title={service.name}>{service.name}</div>
          <div className={css.category}>{service.category}</div>
        </div>
        {service.connection === null
          ? <Button size="sm" variant="outline" disabled={startingService === service.id}
            onClick={() => { connect(service) }}>
            {t('connections.connect')}
          </Button>
          : <ConnectedRow connection={service.connection} name={service.name}
            labels={{ connected: t('connections.connected'), manage: t('connections.manage') }}
            onManage={(connection) => { setAttempt(null); setManage({ service, connection }) }} />}
      </div>)}
    </div>}
    <Modal
      open={dialogOpen}
      onClose={closeDialog}
      title={dialogTitle}
      closeLabel={t('close')}
      className={classOf('modal')}
      contentClassName={classOf('modalContent')}
    >
      {manage !== null && <div className={css.modalBody}>
        <div className={css.manageAccount}>{manageAccount}</div>
        <dl className={css.meta}>
          <dt className={css.metaLabel}>{t('connections.method')}</dt>
          <dd className={css.metaValue}>{manageMethod}</dd>
          <dt className={css.metaLabel}>{t('connections.connectedAt')}</dt>
          <dd className={css.metaValue}>{manageConnectedText}</dd>
          <dt className={css.metaLabel}>{t('connections.status')}</dt>
          <dd className={css.metaValue}>
            {manageVerified ? t('connections.verified') : t('connections.savedNotVerified')}
          </dd>
        </dl>
        <div className={css.actions}>
          <Button variant="primary" disabled={busy} onClick={() => { disconnect(manage.service) }}>
            {t('connections.disconnect')}
          </Button>
          <Button onClick={() => { setManage(null) }}>{t('connections.close')}</Button>
        </div>
      </div>}
      {manage === null && attempt !== null && <div className={css.modalBody}>
        {phase !== 'connected' && phase !== 'failed' && phase !== 'cancelled' && attemptUrl !== undefined
            && <div className={css.actions}>
              <Button variant="primary" onClick={() => { openSignIn(attemptUrl) }}>
                {phase === 'waiting-code' ? t('connections.openPage') : t('connections.openSignIn')}
              </Button>
            </div>}
        {attemptCode !== undefined && <div className={css.codeRow}>
          <code className={css.code}>{attemptCode}</code>
          <Button size="sm" variant="outline" onClick={() => { copyCode(attemptCode) }}>
            {copied ? t('connections.copied') : t('connections.copy')}
          </Button>
        </div>}
        {attemptMessage !== undefined && <p className={css.message}>{attemptMessage}</p>}
        {attemptBusy && <div className={css.busy} role="status">
          <span className={css.spinner} aria-hidden="true" />
          <span>{phase === 'exchanging' ? t('connections.finishing') : t('connections.waiting')}</span>
        </div>}
        {phase === 'waiting-input' && attemptPrompt !== undefined && <form className={css.form} onSubmit={(event) => {
          event.preventDefault()
          submitAnswer()
        }}>
          <label className={css.promptLabel} htmlFor="kairoforge-connect-answer">{promptLabel}</label>
          <Input id="kairoforge-connect-answer" className={classOf('promptInput')}
            type={promptKind === 'secret' ? 'password' : 'text'}
            value={answer} placeholder={promptPlaceholder}
            onChange={(event) => { setAnswer(event.currentTarget.value) }} />
          {promptHelp !== undefined && <div className={css.promptHelp}>{promptHelp}</div>}
          <div className={css.actions}>
            <Button type="submit" variant="primary" disabled={busy || answer.trim() === ''}>
              {t('connections.submit')}
            </Button>
          </div>
        </form>}
        {phase === 'connected' && <>
          <div className={css.connectedAs}>
            {attemptAccount === undefined
              ? t('connections.connectedNoAccount')
              : t('connections.connectedAs', { account: attemptAccount })}
          </div>
          <div className={css.verifyLine}>
            {attemptVerified ? t('connections.verified') : t('connections.savedNotVerified')}
          </div>
          <div className={css.actions}>
            <Button variant="primary" onClick={() => { setAttempt(null) }}>{t('connections.done')}</Button>
          </div>
        </>}
        {phase === 'failed' && <>
          <div className={css.failedLine} role="alert">{attemptError ?? t('connections.failed')}</div>
          <div className={css.actions}>
            <Button variant="primary" disabled={startingService !== null} onClick={retry}>
              {t('connections.tryAgain')}
            </Button>
            <Button onClick={closeDialog}>{t('connections.close')}</Button>
          </div>
        </>}
        {attemptBusy && <div className={css.actions}>
          <Button variant="outline" onClick={closeDialog}>{t('connections.cancel')}</Button>
        </div>}
      </div>}
    </Modal>
  </div>
}
