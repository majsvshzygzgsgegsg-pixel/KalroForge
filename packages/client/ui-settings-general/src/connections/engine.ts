/**
 * The connection engine: one in-flight sign-in attempt per service, and the
 * four real methods an attempt can run.
 *
 * Every method ends in the same place — a credential record committed through
 * the harness credential store and a connection the catalog reports as
 * connected. What differs is only how the credential is obtained:
 *
 * - `oauth` exchanges an authorization code for tokens after the browser
 *   returns to this Host's own callback route (PKCE, no implicit grants).
 * - `device` shows a user code and polls the provider's token endpoint.
 * - `token` asks for a provider token or app password and proves it against the
 *   provider (HTTP profile call, or an IMAP login for mailbox credentials).
 * - `cli` runs an installed provider CLI's own browser sign-in and then its
 *   `whoami`, so the account name comes from the provider.
 *
 * The engine is deliberately transport-free and Cordis-free: it takes a store
 * and an "open this URL" callback, which is what makes it testable and what
 * keeps HTTP concerns in `routes.ts`.
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { connect as tlsConnect } from 'node:tls'
import type {
  DeviceMethod, Method, OAuthMethod, ProfileRequest, ServiceRecipe, TokenMethod, CliMethod,
} from './registry.ts'
import { CATALOG, serviceById } from './registry.ts'

/** Transient phases are polled; terminal phases are not. */
export type Phase = 'waiting-browser' | 'waiting-code' | 'waiting-input' | 'exchanging' | 'connected' | 'failed' | 'cancelled'

/** One question the browser must answer for a running attempt. */
export interface PromptView {
  readonly kind: 'text' | 'secret'
  readonly label: string
  readonly placeholder?: string
  readonly help?: string
}

/** The browser-safe view of one attempt. */
export interface AttemptView {
  readonly id: string
  readonly service: string
  readonly serviceName: string
  readonly method: string
  readonly phase: Phase
  readonly message?: string
  readonly url?: string
  readonly code?: string
  readonly prompt?: PromptView
  readonly account?: string
  readonly verified?: boolean
  readonly error?: string
}

/** The browser-safe view of one completed connection. */
export interface ConnectionView {
  readonly status: 'connected'
  readonly account?: string
  readonly connectedAt: string
  readonly verified: boolean
  readonly method: string
}

/** One catalog row as the browser sees it. */
export interface CatalogEntryView extends ServiceRecipe {
  readonly connection?: ConnectionView
}

/** Credentials the engine reads and writes; one record per key. */
export interface ConnectionStore {
  /** The grant payload at a key, or undefined when nothing is stored. */
  read(key: string): Promise<unknown>
  /** Replace the grant payload at a key. */
  write(key: string, payload: unknown): Promise<void>
  /** Delete the record at a key. */
  remove(key: string): Promise<void>
  /** Every stored key, so the catalog can report connected services. */
  keys(): Promise<readonly string[]>
}

/** What the engine needs from its host. */
export interface EngineOptions {
  readonly store: ConnectionStore
  /** Hand a URL to the user's browser. */
  readonly openUrl: (url: string) => void
  /** Milliseconds an attempt may stay transient. Defaults to five minutes. */
  readonly attemptTimeoutMs?: number
  /** Injectable for tests. */
  readonly fetch?: typeof fetch
  /** Injectable for tests. */
  readonly now?: () => number
}

/** Scope of the connection records: the owning plugin, per the credential seam. */
const CONNECTION_SCOPE = 'kairoforge-connections'
/** Scope of the stored per-provider OAuth apps. */
const APP_SCOPE = 'kairoforge-connections-app'

/** A connection record's payload. */
interface ConnectionPayload {
  readonly version: 1
  readonly service: string
  readonly method: string
  readonly account?: string
  readonly verified: boolean
  readonly connectedAt: string
  /** Non-secret or secret fields the method collected, keyed by field id. */
  readonly fields?: Readonly<Record<string, string>>
  /** OAuth tokens, kept verbatim for whichever consumer needs them. */
  readonly tokens?: Readonly<Record<string, string>>
}

/** A stored OAuth app registration. */
interface AppPayload {
  readonly version: 1
  readonly clientId: string
  readonly clientSecret?: string
}

/** Mutable state of one attempt. */
interface Attempt {
  readonly id: string
  readonly service: ServiceRecipe
  readonly method: Method
  readonly origin: string
  readonly controller: AbortController
  phase: Phase
  message: string | undefined
  url: string | undefined
  code: string | undefined
  prompt: PromptView | undefined
  account: string | undefined
  verified: boolean | undefined
  error: string | undefined
  /** When the attempt reached a terminal phase; retained so a poll can read it. */
  finishedAt: number | undefined
  /** Set while the attempt waits for a typed answer. */
  pending: { readonly resolve: (value: string) => void; readonly reject: (error: Error) => void } | undefined
  /** Set while the attempt waits for the browser redirect. */
  callback: { readonly state: string; readonly settle: (code: string) => void; readonly fail: (error: Error) => void } | undefined
}

/** How long a finished attempt stays readable, so a late poll sees its outcome. */
const TERMINAL_RETENTION_MS = 10 * 60 * 1000

/** A failure the browser should read as a message rather than a crash. */
export class ConnectError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ConnectError'
  }
}

/** Base64url without padding, as PKCE and OAuth state require. */
function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** The PKCE pair for one attempt. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

/** A dot path into a decoded JSON value, tolerant of every missing step. */
function pathValue(value: unknown, path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'string' && current !== '' ? current : undefined
}

/** Substitute `{secret}` / `{account}` in a recipe template. */
function template(text: string, values: Readonly<Record<string, string>>): string {
  return text.replaceAll(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match)
}

/** Quote one IMAP argument. */
function imapQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Prove mailbox credentials by logging in to the provider's IMAP server.
 * @param host - IMAP host.
 * @param port - IMAP TLS port.
 * @param account - the mailbox address.
 * @param secret - the app password.
 * @param signal - aborts the attempt.
 * @returns the account when the provider accepts the login.
 * @throws {ConnectError} when the login is refused or the server is unreachable.
 */
export async function verifyImap(
  host: string, port: number, account: string, secret: string, signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host })
    let buffer = ''
    let sent = false
    const done = (error?: Error): void => {
      socket.removeAllListeners()
      socket.destroy()
      if (error === undefined) resolve(account)
      else reject(error)
    }
    const onAbort = (): void => { done(new ConnectError('the sign-in attempt was cancelled', 'cancelled')) }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.setTimeout(20_000, () => { done(new ConnectError(`no answer from ${host}:${String(port)}`, 'imap-timeout')) })
    socket.on('error', (error: Error) => {
      signal.removeEventListener('abort', onAbort)
      done(new ConnectError(`mailbox connection failed: ${error.message}`, 'imap-error'))
    })
    socket.on('close', () => { signal.removeEventListener('abort', onAbort) })
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (!sent) {
        if (!/^\* OK/m.test(buffer)) {
          if (/^\* (NO|BYE)/m.test(buffer)) done(new ConnectError('the mail server refused the connection', 'imap-refused'))
          return
        }
        sent = true
        socket.write(`a1 LOGIN ${imapQuote(account)} ${imapQuote(secret)}\r\n`)
        return
      }
      if (/^a1 OK/m.test(buffer)) { signal.removeEventListener('abort', onAbort); done() }
      else if (/^a1 (NO|BAD)/m.test(buffer)) {
        signal.removeEventListener('abort', onAbort)
        done(new ConnectError('the mail server rejected that address and password', 'imap-rejected'))
      }
    })
  })
}

/** Open a URL in the user's default browser, without waiting for it. */
export function defaultOpenUrl(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  const child = spawn(command, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
  child.on('error', () => { /* opening the browser is best effort; the URL is always shown too */ })
  child.unref()
}

/**
 * The connection engine. One attempt per service at a time; attempts are held
 * in memory because an unfinished sign-in is not durable state.
 */
export class ConnectionEngine {
  private readonly store: ConnectionStore
  private readonly openUrl: (url: string) => void
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly attempts = new Map<string, Attempt>()
  private readonly byService = new Map<string, string>()
  private sequence = 0

  constructor(options: EngineOptions) {
    this.store = options.store
    this.openUrl = options.openUrl
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())
    this.timeoutMs = options.attemptTimeoutMs ?? 300_000
  }

  /** Every catalog entry with its live connection state. */
  async catalog(): Promise<readonly CatalogEntryView[]> {
    const keys = await this.store.keys()
    const connected = new Set(keys
      .filter(key => key.startsWith(`${CONNECTION_SCOPE}/`))
      .map(key => key.slice(CONNECTION_SCOPE.length + 1)))
    const entries: CatalogEntryView[] = []
    for (const service of CATALOG) {
      if (!connected.has(service.id)) { entries.push(service); continue }
      const payload = await this.payloadOf(service.id)
      entries.push(payload === undefined ? service : { ...service, connection: connectionView(payload) })
    }
    return entries
  }

  /** The catalog entry for one service id. */
  entry(id: string): ServiceRecipe | undefined {
    return serviceById(id)
  }

  /** One attempt's current view. */
  view(id: string): AttemptView | undefined {
    const attempt = this.attempts.get(id)
    return attempt === undefined ? undefined : viewOf(attempt)
  }

  /**
   * Begin a sign-in. The returned attempt is already running: the browser has
   * been handed whatever page it needs, or the first question is on screen.
   * @param serviceId - the catalog id to connect.
   * @param methodId - the method to run; defaults to the service's first.
   * @param origin - this Host's browser origin, used to build the OAuth redirect.
   * @returns the new attempt's view.
   * @throws {ConnectError} when the service or method is unknown, or one attempt is already running.
   */
  start(serviceId: string, methodId: string | undefined, origin: string): AttemptView {
    const service = serviceById(serviceId)
    if (service === undefined) throw new ConnectError(`unknown service "${serviceId}"`, 'unknown-service')
    const method = methodId === undefined
      ? service.methods[0]
      : service.methods.find(candidate => candidate.id === methodId)
    if (method === undefined) throw new ConnectError(`unknown method "${String(methodId)}"`, 'unknown-method')
    const runningId = this.byService.get(serviceId)
    if (runningId !== undefined && this.isTransient(runningId)) {
      throw new ConnectError(`${service.name} already has a sign-in in progress`, 'already-running')
    }
    this.prune()
    this.sequence += 1
    const attempt: Attempt = {
      id: `att_${this.now().toString(36)}_${this.sequence.toString(36)}`,
      service, method, origin,
      controller: new AbortController(),
      phase: 'waiting-browser',
      message: `Starting ${method.label}…`,
      url: undefined, code: undefined, prompt: undefined, account: undefined,
      verified: undefined, error: undefined, finishedAt: undefined, pending: undefined, callback: undefined,
    }
    this.attempts.set(attempt.id, attempt)
    this.byService.set(serviceId, attempt.id)
    void this.run(attempt).catch((error: unknown) => {
      if (attempt.phase === 'connected' || attempt.phase === 'cancelled') return
      this.fail(attempt, error)
    })
    return viewOf(attempt)
  }

  /**
   * Answer the question a waiting attempt asked.
   * @param id - the attempt id.
   * @param value - what the human typed.
   * @returns the attempt's view after the answer was accepted.
   * @throws {ConnectError} when the attempt is unknown or is not waiting for an answer.
   */
  answer(id: string, value: string): AttemptView {
    const attempt = this.require(id)
    const pending = attempt.pending
    if (attempt.phase !== 'waiting-input' || pending === undefined) {
      throw new ConnectError('that attempt is not waiting for an answer', 'not-waiting')
    }
    attempt.pending = undefined
    attempt.prompt = undefined
    pending.resolve(value)
    return viewOf(attempt)
  }

  /**
   * Withdraw a running attempt.
   * @param id - the attempt id.
   * @returns the attempt's view, now cancelled — or unchanged when it had already finished.
   * @throws {ConnectError} when the attempt is unknown.
   */
  cancel(id: string): AttemptView {
    const attempt = this.require(id)
    this.settle(attempt, 'cancelled')
    return viewOf(attempt)
  }

  /** Whether an attempt is still in a phase the browser polls. */
  private isTransient(id: string): boolean {
    const attempt = this.attempts.get(id)
    if (attempt === undefined) return false
    return attempt.phase !== 'connected' && attempt.phase !== 'failed' && attempt.phase !== 'cancelled'
  }

  /** Drop finished attempts once nobody can still be polling them. */
  private prune(): void {
    const cutoff = this.now() - TERMINAL_RETENTION_MS
    for (const [id, attempt] of this.attempts) {
      if (attempt.finishedAt !== undefined && attempt.finishedAt < cutoff) this.attempts.delete(id)
    }
  }

  /**
   * Drop a stored connection.
   * @param serviceId - the catalog id to disconnect.
   * @returns after the record is gone.
   */
  async disconnect(serviceId: string): Promise<void> {
    await this.store.remove(connectionKey(serviceId))
    const runningId = this.byService.get(serviceId)
    if (runningId !== undefined) {
      const running = this.attempts.get(runningId)
      if (running !== undefined) this.settle(running, 'cancelled')
    }
  }

  /**
   * Resolve a provider redirect that landed on this Host.
   * @param url - the full callback URL.
   * @returns the page to answer with, or undefined when no attempt is waiting for that state.
   */
  callback(url: URL): { readonly status: number; readonly body: string } | undefined {
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    if (state === null) return undefined
    for (const attempt of this.attempts.values()) {
      const waiting = attempt.callback
      if (waiting === undefined || waiting.state !== state) continue
      attempt.callback = undefined
      if (code !== null && error === null) waiting.settle(code)
      else waiting.fail(new ConnectError(error ?? 'the provider refused the sign-in', 'authorize-refused'))
      return { status: 200, body: callbackPage(error === null) }
    }
    return undefined
  }

  /** The stored app registration for a service, when the operator supplied one. */
  private async app(serviceId: string): Promise<AppPayload | undefined> {
    const payload = await this.store.read(`${APP_SCOPE}/${serviceId}`)
    if (payload === null || typeof payload !== 'object') return undefined
    const candidate = payload as Partial<AppPayload>
    return typeof candidate.clientId === 'string' && candidate.clientId !== '' ? candidate as AppPayload : undefined
  }

  /** The stored connection payload for a service. */
  private async payloadOf(serviceId: string): Promise<ConnectionPayload | undefined> {
    const payload = await this.store.read(connectionKey(serviceId))
    if (payload === null || typeof payload !== 'object') return undefined
    return payload as ConnectionPayload
  }

  /** One attempt by id, or a refusal the route can render. */
  private require(id: string): Attempt {
    const attempt = this.attempts.get(id)
    if (attempt === undefined) throw new ConnectError('that sign-in attempt has expired', 'unknown-attempt')
    return attempt
  }

  /** Run one attempt to completion. */
  private async run(attempt: Attempt): Promise<void> {
    const timer = setTimeout(() => {
      this.settle(attempt, 'failed', new ConnectError('the sign-in attempt timed out', 'timeout'))
    }, this.timeoutMs)
    const onAbort = (): void => { this.settle(attempt, 'cancelled') }
    attempt.controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const method = attempt.method
      if (method.kind === 'oauth') await this.runOAuth(attempt, method)
      else if (method.kind === 'device') await this.runDevice(attempt, method)
      else if (method.kind === 'token') await this.runToken(attempt, method)
      else await this.runCli(attempt, method)
      if (attempt.phase !== 'connected' && attempt.phase !== 'cancelled') {
        throw new ConnectError(`${attempt.service.name} finished without a connection`, 'incomplete')
      }
    } finally {
      clearTimeout(timer)
      attempt.controller.signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Move an attempt to a terminal phase and release whoever waits on it. The
   * attempt stays readable until {@link prune}, because the browser learns its
   * outcome by polling and a deleted attempt would read as an expiry instead.
   */
  private settle(attempt: Attempt, phase: 'failed' | 'cancelled', error?: ConnectError): void {
    if (attempt.phase === 'connected' || attempt.phase === 'failed' || attempt.phase === 'cancelled') return
    attempt.phase = phase
    attempt.finishedAt = this.now()
    attempt.prompt = undefined
    if (error !== undefined) attempt.error = error.message
    attempt.callback = undefined
    const pending = attempt.pending
    attempt.pending = undefined
    if (this.byService.get(attempt.service.id) === attempt.id) this.byService.delete(attempt.service.id)
    // Aborting last, after the phase is terminal: the abort listener re-enters
    // this method, which returns immediately, so cancellation cannot recurse.
    attempt.controller.abort()
    pending?.reject(error ?? new ConnectError('the sign-in attempt was cancelled', 'cancelled'))
  }

  /** Record a failure without losing the message. */
  private fail(attempt: Attempt, error: unknown): void {
    const failure = error instanceof ConnectError
      ? error
      : new ConnectError(error instanceof Error ? error.message : String(error), 'failed')
    this.settle(attempt, 'failed', failure)
  }

  /**
   * Ask the human a question and wait for the answer.
   * @param attempt - the running attempt.
   * @param prompt - what to ask.
   * @param context - an optional page to open and a line to show beside the question.
   * @returns the typed answer.
   * @throws {ConnectError} when the attempt is cancelled while waiting.
   */
  private ask(
    attempt: Attempt,
    prompt: PromptView,
    context?: { readonly url?: string; readonly message?: string; readonly code?: string; readonly phase?: Phase },
  ): Promise<string> {
    attempt.phase = context?.phase ?? 'waiting-input'
    attempt.prompt = prompt
    if (context?.message !== undefined) attempt.message = context.message
    if (context?.url !== undefined) attempt.url = context.url
    if (context?.code !== undefined) attempt.code = context.code
    return new Promise<string>((resolve, reject) => {
      attempt.pending = { resolve, reject }
      if (attempt.controller.signal.aborted) {
        attempt.pending = undefined
        reject(new ConnectError('the sign-in attempt was cancelled', 'cancelled'))
      }
    })
  }

  /** The OAuth app this attempt will present, asking for one once per service. */
  private async resolveApp(attempt: Attempt, method: OAuthMethod | DeviceMethod): Promise<AppPayload> {
    const stored = await this.app(attempt.service.id)
    if (stored !== undefined) return stored
    if (method.clientId !== undefined) return { version: 1, clientId: method.clientId }
    const fromEnv = process.env[method.clientIdEnv]
    if (fromEnv !== undefined && fromEnv !== '') return { version: 1, clientId: fromEnv }
    const appHelp = 'appHelp' in method ? method.appHelp : undefined
    const clientId = (await this.ask(attempt, {
      kind: 'text',
      label: `${attempt.service.name} OAuth client ID`,
      placeholder: 'client id',
      help: [
        `One-time setup for ${attempt.service.name}: register an app once and every later sign-in is a single press.`,
        appHelp ?? '',
      ].filter(line => line !== '').join(' '),
    }, {
      message: `KairoForge needs a ${attempt.service.name} OAuth app before the browser can sign you in.`,
      ...(method.appUrl === undefined ? {} : { url: method.appUrl }),
    })).trim()
    if (clientId === '') throw new ConnectError('a client ID is required to sign in', 'client-id-required')
    let clientSecret: string | undefined
    if (method.kind === 'oauth' && method.secretRequired === true) {
      clientSecret = (await this.ask(attempt, {
        kind: 'secret',
        label: `${attempt.service.name} OAuth client secret`,
        placeholder: 'client secret',
        help: 'Stored once, in this profile only.',
      }, { phase: 'waiting-input' })).trim()
      if (clientSecret === '') clientSecret = undefined
    }
    const app: AppPayload = clientSecret === undefined
      ? { version: 1, clientId }
      : { version: 1, clientId, clientSecret }
    await this.store.write(`${APP_SCOPE}/${attempt.service.id}`, app)
    return app
  }

  /** Wait for the provider to redirect the browser back to this Host. */
  private awaitCallback(attempt: Attempt, state: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      attempt.callback = { state, settle: resolve, fail: reject }
      if (attempt.controller.signal.aborted) {
        attempt.callback = undefined
        reject(new ConnectError('the sign-in attempt was cancelled', 'cancelled'))
      }
    })
  }

  /** OAuth 2.0 authorization code + PKCE. */
  private async runOAuth(attempt: Attempt, method: OAuthMethod): Promise<void> {
    const app = await this.resolveApp(attempt, method)
    const { verifier, challenge } = pkce()
    const state = base64url(randomBytes(24))
    const redirectUri = `${attempt.origin}/kairoforge/connect/callback`
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: redirectUri,
      scope: method.scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...method.extraAuthParams,
    })
    const authorizeUrl = `${method.authorizeUrl}?${params.toString()}`
    attempt.phase = 'waiting-browser'
    attempt.message = 'Finish signing in with the browser window that just opened, then come back here.'
    attempt.url = authorizeUrl
    this.openUrl(authorizeUrl)
    const code = await this.awaitCallback(attempt, state)
    attempt.phase = 'exchanging'
    attempt.message = `Exchanging the authorization code with ${attempt.service.name}…`
    const tokens = await this.exchange(attempt, method, app, code, verifier, redirectUri)
    const profile = method.profile
    const account = profile === undefined ? undefined : await this.profile(attempt, profile, tokens.access_token ?? '')
    await this.commit(attempt, {
      method: method.id,
      verified: true,
      ...(account === undefined ? {} : { account }),
      tokens,
    })
  }

  /** Exchange an authorization code for tokens. */
  private async exchange(
    attempt: Attempt, method: OAuthMethod, app: AppPayload, code: string, verifier: string, redirectUri: string,
  ): Promise<Record<string, string>> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: app.clientId,
      code_verifier: verifier,
    })
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    }
    if (app.clientSecret !== undefined && app.clientSecret !== '') {
      if (method.tokenAuth === 'basic') {
        headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`
      } else {
        body.set('client_secret', app.clientSecret)
      }
    }
    const response = await this.fetchImpl(method.tokenUrl, {
      method: 'POST', headers, body: body.toString(), signal: attempt.controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new ConnectError(`${attempt.service.name} refused the sign-in: ${firstLine(text)}`, 'token-exchange-failed')
    }
    const parsed = parseTokenResponse(text, method.tokenFormat)
    const accessToken = parsed.access_token
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new ConnectError(`${attempt.service.name} returned no access token`, 'no-access-token')
    }
    const tokens: Record<string, string> = { access_token: accessToken }
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && name !== 'access_token') tokens[name] = value
    }
    return tokens
  }

  /** Prove a credential with the provider's own profile call. */
  private async profile(attempt: Attempt, request: ProfileRequest, secret: string): Promise<string | undefined> {
    const values = { secret, account: attempt.account ?? '' }
    const headers: Record<string, string> = { accept: 'application/json' }
    for (const [name, value] of Object.entries(request.headers ?? {})) headers[name] = template(value, values)
    const response = await this.fetchImpl(template(request.url, values), {
      method: request.method ?? 'GET',
      headers,
      ...(request.body === undefined ? {} : { body: template(request.body, values) }),
      signal: attempt.controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new ConnectError(`the provider rejected that credential (HTTP ${String(response.status)})`, 'profile-rejected')
    }
    if (request.accountHeader !== undefined) {
      const header = response.headers.get(request.accountHeader)
      if (header !== null && header !== '') return header
    }
    let decoded: unknown
    try { decoded = JSON.parse(text) } catch { return undefined }
    return pathValue(decoded, request.accountPath)
  }

  /** RFC 8628 device authorization. */
  private async runDevice(attempt: Attempt, method: DeviceMethod): Promise<void> {
    const app = await this.resolveApp(attempt, method)
    const start = await this.fetchImpl(method.deviceUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: app.clientId, scope: method.scopes.join(' ') }).toString(),
      signal: attempt.controller.signal,
    })
    const text = await start.text()
    if (!start.ok) throw new ConnectError(`${attempt.service.name} refused the device request: ${firstLine(text)}`, 'device-start-failed')
    const granted = parseTokenResponse(text, 'json')
    const deviceCode = granted.device_code
    const userCode = granted.user_code
    const verificationUrl = [granted.verification_uri, granted.verification_uri_complete]
      .find((value): value is string => typeof value === 'string' && value !== '')
    if (typeof deviceCode !== 'string' || typeof userCode !== 'string') {
      throw new ConnectError(`${attempt.service.name} returned no device code`, 'no-device-code')
    }
    const parsedInterval = Number(granted.interval)
    let intervalMs = (Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 5) * 1000
    const expiresAt = this.now() + (Number(granted.expires_in) > 0 ? Number(granted.expires_in) * 1000 : this.timeoutMs)
    attempt.phase = 'waiting-code'
    attempt.code = userCode
    attempt.message = `Enter this code at ${verificationUrl ?? method.deviceUrl} to finish signing in.`
    if (verificationUrl !== undefined) {
      attempt.url = verificationUrl
      this.openUrl(verificationUrl)
    }
    const access = await this.pollDevice(attempt, method, app, deviceCode, intervalMs, expiresAt, () => { intervalMs += 5000 })
    const account = method.profile === undefined ? undefined : await this.profile(attempt, method.profile, access)
    await this.commit(attempt, {
      method: method.id,
      verified: true,
      ...(account === undefined ? {} : { account }),
      tokens: { access_token: access },
    })
  }

  /** Poll a device grant until the provider admits, denies, or the code expires. */
  private async pollDevice(
    attempt: Attempt, method: DeviceMethod, app: AppPayload, deviceCode: string,
    intervalMs: number, expiresAt: number, slowDown: () => void,
  ): Promise<string> {
    for (;;) {
      if (attempt.controller.signal.aborted) throw new ConnectError('the sign-in attempt was cancelled', 'cancelled')
      if (this.now() > expiresAt) throw new ConnectError('the sign-in code expired', 'device-expired')
      await delay(intervalMs)
      const response = await this.fetchImpl(method.tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: app.clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
        signal: attempt.controller.signal,
      })
      const text = await response.text()
      const parsed = parseTokenResponse(text, method.tokenFormat)
      const token = parsed.access_token
      if (typeof token === 'string' && token !== '') return token
      switch (parsed.error) {
        case 'authorization_pending': break
        case 'slow_down': slowDown(); break
        case undefined: throw new ConnectError(`${attempt.service.name} returned no token`, 'no-access-token')
        default: {
          const reason = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)
          throw new ConnectError(`${attempt.service.name} refused the sign-in: ${reason}`, 'device-refused')
        }
      }
    }
  }

  /** A provider token or app password, proven before it is stored. */
  private async runToken(attempt: Attempt, method: TokenMethod): Promise<void> {
    const answers: Record<string, string> = {}
    for (const [index, field] of method.fields.entries()) {
      const first = index === 0
      const help = field.help ?? method.help
      const answer = (await this.ask(attempt, {
        kind: field.kind,
        label: field.label,
        ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
        ...(help === undefined ? {} : { help }),
      }, {
        ...(first ? { url: method.createUrl, message: `${attempt.service.name}: create the credential, then paste it here.` } : {}),
      })).trim()
      if (answer === '') throw new ConnectError(`${field.label} is required`, 'answer-required')
      answers[field.id] = answer
    }
    attempt.phase = 'exchanging'
    attempt.message = `Checking the credential with ${attempt.service.name}…`
    const secret = answers.secret ?? ''
    const account = answers.account
    let verified = false
    let resolved = account
    if (method.imap !== undefined && account !== undefined) {
      resolved = await verifyImap(method.imap.host, method.imap.port, account, secret, attempt.controller.signal)
      verified = true
    } else if (method.profile !== undefined) {
      attempt.account = account
      resolved = await this.profile(attempt, method.profile, secret)
      verified = true
    }
    await this.commit(attempt, {
      method: method.id,
      verified,
      ...(resolved === undefined ? {} : { account: resolved }),
      fields: answers,
    })
  }

  /** An installed provider CLI that performs its own browser sign-in. */
  private async runCli(attempt: Attempt, method: CliMethod): Promise<void> {
    attempt.phase = 'waiting-browser'
    attempt.message = method.help ?? `Finish signing in with the ${method.executable} window that just opened.`
    if (method.installUrl !== undefined) attempt.url = method.installUrl
    await run(attempt, method.executable, method.loginArgs)
    attempt.phase = 'exchanging'
    attempt.message = `Checking the sign-in with ${method.executable}…`
    const output = await run(attempt, method.executable, method.verifyArgs)
    const account = output.split('\n').map(line => line.trim()).find(line => line !== '')
    await this.commit(attempt, {
      method: method.id,
      verified: true,
      ...(account === undefined ? {} : { account }),
    })
  }

  /** Write the connection record and mark the attempt connected. */
  private async commit(
    attempt: Attempt,
    result: {
      readonly method: string
      readonly verified: boolean
      readonly account?: string
      readonly fields?: Readonly<Record<string, string>>
      readonly tokens?: Readonly<Record<string, string>>
    },
  ): Promise<void> {
    const payload: ConnectionPayload = {
      version: 1,
      service: attempt.service.id,
      method: result.method,
      verified: result.verified,
      connectedAt: new Date(this.now()).toISOString(),
      ...(result.account === undefined ? {} : { account: result.account }),
      ...(result.fields === undefined ? {} : { fields: result.fields }),
      ...(result.tokens === undefined ? {} : { tokens: result.tokens }),
    }
    await this.store.write(connectionKey(attempt.service.id), payload)
    attempt.account = result.account
    attempt.verified = result.verified
    attempt.phase = 'connected'
    attempt.finishedAt = this.now()
    attempt.message = result.account === undefined
      ? `${attempt.service.name} is connected.`
      : `${attempt.service.name} is connected as ${result.account}.`
    attempt.prompt = undefined
    attempt.code = undefined
    attempt.callback = undefined
    if (this.byService.get(attempt.service.id) === attempt.id) this.byService.delete(attempt.service.id)
  }
}

/** The credential key holding one service's connection. */
export function connectionKey(serviceId: string): string {
  return `${CONNECTION_SCOPE}/${serviceId}`
}

/** The record payload as the browser sees it. */
function connectionView(payload: ConnectionPayload): ConnectionView {
  return {
    status: 'connected',
    connectedAt: payload.connectedAt,
    verified: payload.verified,
    method: payload.method,
    ...(payload.account === undefined ? {} : { account: payload.account }),
  }
}

/** Serialize one attempt for the browser. */
function viewOf(attempt: Attempt): AttemptView {
  return {
    id: attempt.id,
    service: attempt.service.id,
    serviceName: attempt.service.name,
    method: attempt.method.id,
    phase: attempt.phase,
    ...(attempt.message === undefined ? {} : { message: attempt.message }),
    ...(attempt.url === undefined ? {} : { url: attempt.url }),
    ...(attempt.code === undefined ? {} : { code: attempt.code }),
    ...(attempt.prompt === undefined ? {} : { prompt: attempt.prompt }),
    ...(attempt.account === undefined ? {} : { account: attempt.account }),
    ...(attempt.verified === undefined ? {} : { verified: attempt.verified }),
    ...(attempt.error === undefined ? {} : { error: attempt.error }),
  }
}

/** The page the provider's redirect lands on. */
function callbackPage(success: boolean): string {
  const title = success ? 'Connected to KairoForge' : 'Sign-in was not completed'
  const body = success
    ? 'You can close this tab and return to KairoForge.'
    : 'Return to KairoForge and try again.'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>body{font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0;display:grid;place-items:center;height:100vh;'
    + 'background:#0b0b0f;color:#f5f5f7}main{text-align:center;max-width:26rem;padding:2rem}'
    + 'h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;opacity:.7}</style></head>'
    + `<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
}

/** First line of a provider error body, bounded. */
function firstLine(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? 'no detail'
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/** Decode a token endpoint answer in either format providers use. */
function parseTokenResponse(text: string, format: 'json' | 'form' | undefined): Record<string, unknown> {
  if (format === 'form') return Object.fromEntries(new URLSearchParams(text))
  try {
    const decoded: unknown = JSON.parse(text)
    return decoded !== null && typeof decoded === 'object' ? decoded as Record<string, unknown> : {}
  } catch {
    return Object.fromEntries(new URLSearchParams(text))
  }
}

/** Sleep, abortable only at the next poll boundary. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** Run one CLI invocation to completion, bounded, and return its stdout. */
function run(attempt: Attempt, executable: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new ConnectError(`${executable} did not finish in time`, 'cli-timeout'))
    }, 300_000)
    const onAbort = (): void => { child.kill('SIGKILL') }
    attempt.controller.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(error.code === 'ENOENT'
        ? new ConnectError(`${executable} is not installed; install it and try again`, 'cli-missing')
        : new ConnectError(`${executable} failed: ${error.message}`, 'cli-error'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      attempt.controller.signal.removeEventListener('abort', onAbort)
      if (attempt.controller.signal.aborted) { reject(new ConnectError('the sign-in attempt was cancelled', 'cancelled')); return }
      if (code === 0) resolve(stdout)
      else reject(new ConnectError(`${executable} exited with code ${String(code)}: ${firstLine(stderr)}`, 'cli-failed'))
    })
  })
}
