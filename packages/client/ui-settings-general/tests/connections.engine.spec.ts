/**
 * The connection engine against a scripted provider: every method must end in a
 * committed credential record and a catalog entry reported as connected, and
 * every refusal must end in the phase the card renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogEntryView, ConnectionStore } from '../src/connections/engine.ts'
import { ConnectError, ConnectionEngine } from '../src/connections/engine.ts'

/** One process-local credential store. */
class MemoryStore implements ConnectionStore {
  readonly records = new Map<string, unknown>()
  async read(key: string): Promise<unknown | undefined> { return this.records.get(key) }
  async write(key: string, payload: unknown): Promise<void> { this.records.set(key, payload) }
  async remove(key: string): Promise<void> { this.records.delete(key) }
  async keys(): Promise<readonly string[]> { return [...this.records.keys()] }
}

/** A JSON response, as a provider would send it. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Poll until the attempt reaches a terminal phase. */
async function settled(engine: ConnectionEngine, id: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const view = engine.view(id)
    if (view === undefined) throw new Error('attempt disappeared')
    if (view.phase === 'connected' || view.phase === 'failed' || view.phase === 'cancelled') return view
    if (Date.now() > deadline) throw new Error(`attempt stuck in ${view.phase}`)
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

/** Poll until the attempt reaches one exact phase. */
async function phase(engine: ConnectionEngine, id: string, want: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const view = engine.view(id)
    if (view === undefined) throw new Error('attempt disappeared')
    if (view.phase === want) return view
    if (view.phase === 'failed' || view.phase === 'cancelled') throw new Error(`attempt ended as ${view.phase}: ${String(view.error)}`)
    if (Date.now() > deadline) throw new Error(`attempt stuck in ${view.phase}, wanted ${want}`)
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

/** An engine over a fresh store, with a browser opener that records URLs. */
function harness(fetchImpl: typeof fetch, attemptTimeoutMs?: number) {
  const store = new MemoryStore()
  const opened: string[] = []
  const engine = new ConnectionEngine({
    store,
    openUrl: (url) => { opened.push(url) },
    fetch: fetchImpl,
    ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
  })
  return { engine, store, opened }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('catalog', () => {
  it('offers every service with at least one method and orders curated methods first', async () => {
    const { engine } = harness(vi.fn())
    const catalog = await engine.catalog()
    expect(catalog.length).toBeGreaterThanOrEqual(200)
    for (const service of catalog) expect(service.methods.length).toBeGreaterThan(0)
    // Zero-setup methods lead: a first press must reach a real sign-in without
    // sending the operator to register an OAuth app first.
    const github = catalog.find(service => service.id === 'github')
    expect(github?.methods.map(method => method.kind)).toEqual(['token', 'device', 'oauth'])
    const githubOauth = github?.methods.find(method => method.kind === 'oauth')
    expect(githubOauth !== undefined && 'authorizeUrl' in githubOauth).toBe(true)
    // A service with no curated recipe still carries an honest generic method.
    const midjourney = catalog.find(service => service.id === 'midjourney')
    expect(midjourney?.methods[0]?.kind).toBe('token')
  })
})

describe('token method', () => {
  it('asks for the credential, verifies it, and reports the connection', async () => {
    const fetchImpl = vi.fn(async () => json({ object: 'list', data: [] }))
    const { engine, store } = harness(fetchImpl)
    const started = engine.start('openai', undefined, 'http://127.0.0.1:3080')
    const question = await phase(engine, started.id, 'waiting-input')
    expect(question.prompt?.kind).toBe('secret')
    expect(question.url).toBe('https://platform.openai.com/api-keys')

    engine.answer(started.id, 'sk-test')
    const done = await settled(engine, started.id)
    expect(done.phase).toBe('connected')
    expect(done.verified).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({ method: 'GET' }))
    expect(store.records.get('kairoforge-connections/openai')).toMatchObject({
      service: 'openai', verified: true, fields: { secret: 'sk-test' },
    })
    const catalog = await engine.catalog()
    expect(catalog.find(service => service.id === 'openai')?.connection).toMatchObject({ status: 'connected', verified: true })
  })

  it('fails the attempt when the provider rejects the credential', async () => {
    const { engine } = harness(vi.fn(async () => json({ error: 'nope' }, 401)))
    const started = engine.start('openai', undefined, 'http://127.0.0.1:3080')
    await phase(engine, started.id, 'waiting-input')
    engine.answer(started.id, 'sk-bad')
    const done = await settled(engine, started.id)
    expect(done.phase).toBe('failed')
    expect(done.error).toContain('401')
  })

  it('reads the account name out of the provider profile', async () => {
    const { engine } = harness(vi.fn(async () => json({ login: 'octocat' })))
    const started = engine.start('github', 'token', 'http://127.0.0.1:3080')
    await phase(engine, started.id, 'waiting-input')
    engine.answer(started.id, 'ghp_test')
    const done = await settled(engine, started.id)
    expect(done.phase).toBe('connected')
    expect(done.account).toBe('octocat')
  })
})

describe('oauth method', () => {
  it('asks for the app once, then completes the PKCE redirect and stores tokens', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'at-123', refresh_token: 'rt-456' })
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ email: 'you@example.com' })
      throw new Error(`unexpected fetch ${url}`)
    })
    const { engine, store, opened } = harness(fetchImpl)
    const started = engine.start('google-drive', undefined, 'http://127.0.0.1:3080')
    const question = await phase(engine, started.id, 'waiting-input')
    expect(question.prompt?.label).toContain('OAuth client ID')
    expect(question.url).toBe('https://console.cloud.google.com/apis/credentials')

    engine.answer(started.id, 'client-abc')
    const waiting = await phase(engine, started.id, 'waiting-browser')
    const authorize = new URL(String(waiting.url))
    expect(authorize.origin + authorize.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('client_id')).toBe('client-abc')
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3080/kairoforge/connect/callback')
    expect(opened).toEqual([String(waiting.url)])

    const state = authorize.searchParams.get('state')
    const page = engine.callback(new URL(`http://127.0.0.1:3080/kairoforge/connect/callback?code=code-1&state=${String(state)}`))
    expect(page?.status).toBe(200)
    const done = await settled(engine, started.id)
    expect(done.phase).toBe('connected')
    expect(done.account).toBe('you@example.com')
    expect(calls).toContain('https://oauth2.googleapis.com/token')
    expect(store.records.get('kairoforge-connections-app/google-drive')).toMatchObject({ clientId: 'client-abc' })
    expect(store.records.get('kairoforge-connections/google-drive')).toMatchObject({
      account: 'you@example.com', tokens: { access_token: 'at-123', refresh_token: 'rt-456' },
    })
  })

  it('ignores a callback whose state belongs to no attempt', () => {
    const { engine } = harness(vi.fn())
    expect(engine.callback(new URL('http://127.0.0.1:3080/kairoforge/connect/callback?code=x&state=nope'))).toBeUndefined()
  })

  it('reports a refusal from the token endpoint as a failed attempt', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'invalid_grant' }, 400))
    const { engine } = harness(fetchImpl)
    const started = engine.start('google-drive', undefined, 'http://127.0.0.1:3080')
    await phase(engine, started.id, 'waiting-input')
    engine.answer(started.id, 'client-abc')
    const waiting = await phase(engine, started.id, 'waiting-browser')
    const state = new URL(String(waiting.url)).searchParams.get('state')
    engine.callback(new URL(`http://127.0.0.1:3080/kairoforge/connect/callback?code=code-1&state=${String(state)}`))
    const done = await settled(engine, started.id)
    expect(done.phase).toBe('failed')
    expect(done.error).toContain('refused the sign-in')
  })
})

describe('device method', () => {
  it('shows the user code, polls, and connects', async () => {
    let polls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://github.com/login/device/code') {
        return json({ device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 })
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        polls += 1
        return polls === 1
          ? new Response(new URLSearchParams({ error: 'authorization_pending' }).toString(), { status: 200 })
          : new Response(new URLSearchParams({ access_token: 'gho_1' }).toString(), { status: 200 })
      }
      if (url === 'https://api.github.com/user') return json({ login: 'octocat' })
      throw new Error(`unexpected fetch ${url}`)
    })
    const { engine, opened } = harness(fetchImpl)
    const started = engine.start('github', 'device', 'http://127.0.0.1:3080')
    const question = await phase(engine, started.id, 'waiting-input')
    expect(question.prompt?.label).toContain('OAuth client ID')
    engine.answer(started.id, 'client-abc')
    const waiting = await phase(engine, started.id, 'waiting-code')
    expect(waiting.code).toBe('ABCD-1234')
    expect(opened).toEqual(['https://github.com/login/device'])
    const done = await settled(engine, started.id, 5000)
    expect(done.phase).toBe('connected')
    expect(done.account).toBe('octocat')
    expect(polls).toBe(2)
  })
})

describe('lifecycle', () => {
  it('refuses a second attempt for the same service while one is running', () => {
    const { engine } = harness(vi.fn())
    engine.start('openai', undefined, 'http://127.0.0.1:3080')
    expect(() => engine.start('openai', undefined, 'http://127.0.0.1:3080')).toThrow(ConnectError)
  })

  it('times a stranded attempt out and keeps the outcome readable', async () => {
    const { engine } = harness(vi.fn(), 20)
    const started = engine.start('openai', undefined, 'http://127.0.0.1:3080')
    const done = await settled(engine, started.id)
    expect(done.phase).toBe('failed')
    expect(done.error).toContain('timed out')
    expect(engine.view(started.id)?.phase).toBe('failed')
  })

  it('cancels a waiting attempt and drops its connection', async () => {
    const { engine, store } = harness(vi.fn())
    store.records.set('kairoforge-connections/openai', { version: 1, service: 'openai', method: 'token', verified: true, connectedAt: 'x' })
    const started = engine.start('openai', undefined, 'http://127.0.0.1:3080')
    expect(engine.cancel(started.id).phase).toBe('cancelled')
    await engine.disconnect('openai')
    expect(store.records.has('kairoforge-connections/openai')).toBe(false)
    const catalog = await engine.catalog()
    expect(catalog.find(service => service.id === 'openai')?.connection).toBeUndefined()
  })

  it('refuses an unknown service or method', () => {
    const { engine } = harness(vi.fn())
    expect(() => engine.start('nope', undefined, 'http://127.0.0.1:3080')).toThrow(/unknown service/)
    expect(() => engine.start('github', 'nope', 'http://127.0.0.1:3080')).toThrow(/unknown method/)
  })
})

describe('catalog entries', () => {
  it('never reports a connection for an unconnected service', async () => {
    const { engine } = harness(vi.fn())
    const catalog: readonly CatalogEntryView[] = await engine.catalog()
    expect(catalog.every(service => service.connection === undefined)).toBe(true)
  })
})
