/**
 * Verification against a real HTTP server.
 *
 * The fixture is a real `node:http` server on an ephemeral loopback port, not a
 * stubbed transport: these checks exist to describe what a published URL
 * actually answered, so a test that mocked the network would prove nothing
 * about the status codes, bodies, and 404s the report names. Only what a
 * loopback server cannot be — a TLS host, a non-Error rejection, a deadline —
 * is injected through `fetchImpl`, which is exactly why that seam exists; the
 * two filesystem boundaries below are spied so a scan fault and an absent
 * sibling scanner can be posed on demand, and every other test uses the real
 * modules.
 * @module @deepseek-ai/dsh-deployment/tests/verify
 */

import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { reachabilityOf, verifyDeployment } from '../src/verify.ts'
import type { VerificationCheck, VerificationReport } from '../src/types.ts'

// Spied, never replaced: the canonical scanner and this spec keep the real
// readFile/readdir/stat, while the two boundaries a loopback fixture cannot
// produce — a scan temp root the filesystem refuses, and a sibling secret
// scanner that is not there — become one `vi.mocked(...)` call inside the test
// that needs them.
vi.mock('node:fs', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs')>()
  return { ...native, existsSync: vi.fn(native.existsSync) }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>()
  return { ...native, mkdtemp: vi.fn(native.mkdtemp) }
})

/** The page marker a deployable build is expected to ship. */
const MARKER = 'KAIRO-DEPLOY-MARKER'

/** Body of the healthy fixture asset. */
const ASSET_BODY = 'globalThis.kairoAsset = "served"'

/**
 * A fake GitHub-shaped token, assembled from fragments so no contiguous
 * credential literal exists in this file for a push-time secret scanner to flag.
 */
const FAKE_TOKEN = `ghp_${'z'.repeat(36)}`

/** One fixture route: the status, the optional content type, and the exact body served. */
interface FixtureRoute {
  readonly status: number
  readonly contentType?: string
  readonly body: string
}

/** Every route the fixture serves; anything else is a 404. */
const ROUTES: Readonly<Record<string, FixtureRoute>> = {
  '/': {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>fixture</title></head><body><div id="app-root">${MARKER}</div><script src="/assets/app.js"></script></body></html>`,
  },
  '/markup': { status: 200, body: '<!doctype html><html><body>markup served with no content type</body></html>' },
  '/text': { status: 200, contentType: 'text/plain', body: 'this is not markup at all' },
  '/plain': { status: 200, body: 'no content type and not markup either' },
  '/empty': { status: 200, contentType: 'text/html', body: '' },
  '/error': { status: 500, contentType: 'text/html', body: '<!doctype html><html><body>boom</body></html>' },
  '/secret.html': {
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><body><script>const token = '${FAKE_TOKEN}'</script></body></html>`,
  },
  // A GitHub user-to-server prefix the canonical scanner's own pattern set does
  // not cover, with no keyword for its generic assignment pattern: only the
  // built-in floor in verify.ts can name this one.
  '/floor.html': {
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><body><script>const k = 'ghu_${'q'.repeat(36)}'</script></body></html>`,
  },
  // The same credential twice, which is one leak and must be reported as one.
  '/secret-twice.html': {
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><body><script>const a = '${FAKE_TOKEN}'</script><script>const b = '${FAKE_TOKEN}'</script></body></html>`,
  },
  '/assets/app.js': { status: 200, contentType: 'application/javascript', body: ASSET_BODY },
  '/assets/empty.js': { status: 200, contentType: 'application/javascript', body: '' },
  '/api/health': { status: 200, contentType: 'application/json', body: '{"status":"ok"}' },
  '/api/broken': { status: 500, contentType: 'application/json', body: '{"status":"broken"}' },
}

/** The check ids every report carries, in the order the checks run. */
const CHECK_IDS = [
  'url-resolves',
  'https',
  'main-page',
  'html-markers',
  'api-endpoints',
  'static-assets',
  'no-exposed-secrets',
  'reachability',
] as const

/** One of the check ids above. */
type CheckId = (typeof CHECK_IDS)[number]

let server: Server
let origin: string

beforeAll(async () => {
  server = createServer(serveFixture)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not bind a TCP port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
})

/** Serve one fixture route, holding `/slow` open so a deadline has something to cut off. */
function serveFixture(request: IncomingMessage, response: ServerResponse): void {
  const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
  if (path === '/slow') {
    request.on('close', () => response.destroy())
    return
  }
  const route = ROUTES[path]
  if (route === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('fixture has no such route')
    return
  }
  response.writeHead(route.status, route.contentType === undefined ? {} : { 'content-type': route.contentType })
  response.end(route.body)
}

/** A loopback port nothing is listening on: bound for the kernel to choose it, then released. */
async function refusedPort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  if (address === null || typeof address === 'string') throw new Error('probe server did not bind a TCP port')
  const port = address.port
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve()
    })
  })
  return port
}

/** The one check with this id, after proving the report carries every id exactly once. */
function checkById(report: VerificationReport, id: CheckId): VerificationCheck {
  expect(report.checks.map(entry => entry.id)).toEqual([...CHECK_IDS])
  const matches = report.checks.filter(entry => entry.id === id)
  expect(matches).toHaveLength(1)
  return matches[0]!
}

/** Prove a required check failed, which must make the whole report unhealthy. */
function expectRequiredFailure(report: VerificationReport, id: CheckId): VerificationCheck {
  const entry = checkById(report, id)
  expect(entry.status).toBe('fail')
  expect(entry.required).toBe(true)
  expect(report.healthy).toBe(false)
  expect(entry.detail.length).toBeGreaterThan(0)
  return entry
}

describe('verifyDeployment', () => {
  it('reports a healthy local deployment when every required check passes', async () => {
    const report = await verifyDeployment({
      url: `${origin}/`,
      htmlMustContain: [MARKER],
      apiPaths: [{ path: '/api/health' }],
      assetPaths: ['/assets/app.js'],
    })

    expect(report.url).toBe(`${origin}/`)
    expect(report.reachability).toBe('local')
    expect(report.healthy).toBe(true)
    expect(new Date(report.checkedAt).toISOString()).toBe(report.checkedAt)

    expect(checkById(report, 'url-resolves').status).toBe('pass')
    expect(checkById(report, 'main-page').detail).toContain('bytes of HTML')
    expect(checkById(report, 'html-markers').detail).toContain(MARKER)
    expect(checkById(report, 'api-endpoints').detail).toContain('GET /api/health 200')
    expect(checkById(report, 'static-assets').detail).toContain('/assets/app.js 200')
    expect(checkById(report, 'no-exposed-secrets').detail).toContain('no exposed secrets')

    const reachability = checkById(report, 'reachability')
    expect(reachability.status).toBe('pass')
    expect(reachability.required).toBe(false)
    expect(reachability.detail).toContain('reachability is local')
  })

  it('skips, never omits, the evidence a caller did not ask for', async () => {
    const report = await verifyDeployment({ url: `${origin}/` })

    expect(report.healthy).toBe(true)
    for (const id of ['html-markers', 'api-endpoints', 'static-assets'] as const) {
      const entry = checkById(report, id)
      expect(entry.status).toBe('skip')
      expect(entry.required).toBe(false)
      expect(entry.detail).toContain('is empty')
    }
    expect(checkById(report, 'no-exposed-secrets').status).toBe('pass')
  })

  it('fails html-markers when the page is missing a marker', async () => {
    const report = await verifyDeployment({ url: `${origin}/`, htmlMustContain: [MARKER, 'absent-marker'] })

    const markers = expectRequiredFailure(report, 'html-markers')
    expect(markers.detail).toContain('absent-marker')
    expect(markers.detail).toContain('missing 1 of 2')
  })

  it('fails api-endpoints and names every failing path', async () => {
    const report = await verifyDeployment({
      url: `${origin}/`,
      apiPaths: [{ path: '/api/health' }, { path: '/api/broken' }, { path: '/api/gone' }],
    })

    const api = expectRequiredFailure(report, 'api-endpoints')
    expect(api.detail).toContain('GET /api/broken answered 500')
    expect(api.detail).toContain('GET /api/gone answered 404')
    expect(api.detail).toContain('2 of 3')
  })

  it('fails static-assets for a missing or empty asset', async () => {
    const report = await verifyDeployment({
      url: `${origin}/`,
      assetPaths: ['/assets/app.js', '/missing.js', '/assets/empty.js'],
    })

    const assets = expectRequiredFailure(report, 'static-assets')
    expect(assets.detail).toContain('/missing.js answered 404')
    expect(assets.detail).toContain('/assets/empty.js answered 200 with an empty body')
    expect(assets.detail).toContain('2 of 3')
  })

  it('fails url-resolves without throwing when the port refuses connections', async () => {
    const port = await refusedPort()
    const report = await verifyDeployment({
      url: `http://127.0.0.1:${port}/`,
      htmlMustContain: [MARKER],
      assetPaths: ['/assets/app.js'],
      apiPaths: [{ path: `http://127.0.0.1:${port}/api/health` }],
    })

    expect(expectRequiredFailure(report, 'url-resolves').detail).toContain('failed')
    expect(checkById(report, 'main-page').status).toBe('skip')
    expect(checkById(report, 'html-markers').status).toBe('skip')
    expect(checkById(report, 'no-exposed-secrets').status).toBe('skip')
    expect(expectRequiredFailure(report, 'static-assets').detail).toContain('/assets/app.js failed')
    expect(expectRequiredFailure(report, 'api-endpoints').detail).toContain('/api/health failed')
  })

  it('skips the https check on an http deployment when TLS was not required', async () => {
    const report = await verifyDeployment({ url: `${origin}/`, requireHttps: false })

    const https = checkById(report, 'https')
    expect(https.status).toBe('skip')
    expect(https.required).toBe(false)
    expect(https.detail).toContain('TLS was not required')
    expect(report.healthy).toBe(true)
  })

  it('fails https on an http deployment when the caller requires TLS', async () => {
    const report = await verifyDeployment({ url: `${origin}/`, requireHttps: true })

    expect(expectRequiredFailure(report, 'https').detail).toContain('requireHttps is set')
  })

  it('passes https for a TLS deployment and skips it when the TLS request fails', async () => {
    const page = '<!doctype html><html><body>served over tls</body></html>'
    const tls = await verifyDeployment({
      url: 'https://deploy.example.test/',
      requireHttps: true,
      fetchImpl: async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }),
    })

    expect(checkById(tls, 'https').status).toBe('pass')
    expect(tls.reachability).toBe('public')
    expect(checkById(tls, 'reachability').detail).toContain('reachability is public')
    expect(tls.healthy).toBe(true)

    const refused = await verifyDeployment({
      url: 'https://deploy.example.test/',
      requireHttps: true,
      fetchImpl: async () => {
        throw new Error('tls handshake refused')
      },
    })

    const https = checkById(refused, 'https')
    expect(https.status).toBe('skip')
    expect(https.required).toBe(true)
    expect(expectRequiredFailure(refused, 'url-resolves').detail).toContain('tls handshake refused')
  })

  it('fails main-page for a non-2xx, empty, or non-HTML page', async () => {
    const failed = await verifyDeployment({ url: `${origin}/error` })
    expect(expectRequiredFailure(failed, 'main-page').detail).toContain('answered 500')

    const empty = await verifyDeployment({ url: `${origin}/empty` })
    expect(expectRequiredFailure(empty, 'main-page').detail).toContain('empty body')

    const text = await verifyDeployment({ url: `${origin}/text` })
    expect(expectRequiredFailure(text, 'main-page').detail).toContain('text/plain content, not HTML')

    const plain = await verifyDeployment({ url: `${origin}/plain` })
    expect(expectRequiredFailure(plain, 'main-page').detail).toContain('unlabeled content, not HTML')
  })

  it('accepts a page whose host serves no content type at all', async () => {
    const report = await verifyDeployment({ url: `${origin}/markup` })

    expect(checkById(report, 'main-page').status).toBe('pass')
    expect(report.healthy).toBe(true)
  })

  it('fails no-exposed-secrets when the deployed HTML carries a token', async () => {
    const report = await verifyDeployment({ url: `${origin}/secret.html` })

    const secrets = expectRequiredFailure(report, 'no-exposed-secrets')
    expect(secrets.detail).toContain('ghp_')
    expect(secrets.detail).not.toContain(FAKE_TOKEN)
  })

  it('flags a credential only the built-in floor knows, with the canonical scanner present', async () => {
    const report = await verifyDeployment({ url: `${origin}/floor.html` })

    const secrets = expectRequiredFailure(report, 'no-exposed-secrets')
    expect(secrets.detail).toContain('github-token')
    expect(secrets.detail).toContain('ghu_')
  })

  it('scans with the built-in floor when the sibling scanner module is not there', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(false)
    const report = await verifyDeployment({ url: `${origin}/secret.html` })

    const secrets = expectRequiredFailure(report, 'no-exposed-secrets')
    expect(secrets.detail).toContain('ghp_')
    expect(secrets.detail).toContain('the main page')
    expect(secrets.detail).not.toContain(FAKE_TOKEN)
  })

  it('counts one finding per credential kind, not one per occurrence', async () => {
    const report = await verifyDeployment({ url: `${origin}/secret-twice.html` })

    expect(expectRequiredFailure(report, 'no-exposed-secrets').detail).toContain('found 1 likely exposed secret')
  })

  it('reports a scan fault as a failed check instead of rejecting', async () => {
    vi.mocked(mkdtemp).mockRejectedValueOnce(new Error('scan root is not writable'))
    const report = await verifyDeployment({ url: `${origin}/` })

    const secrets = expectRequiredFailure(report, 'no-exposed-secrets')
    expect(secrets.detail).toContain('could not be scanned')
    expect(secrets.detail).toContain('scan root is not writable')
  })

  it('skips secret scanning when the caller disables it', async () => {
    const report = await verifyDeployment({ url: `${origin}/secret.html`, scanForSecrets: false })

    const secrets = checkById(report, 'no-exposed-secrets')
    expect(secrets.status).toBe('skip')
    expect(secrets.required).toBe(false)
    expect(report.healthy).toBe(true)
  })

  it('honours an explicit accept list and reports an impossible one', async () => {
    const mismatch = await verifyDeployment({
      url: `${origin}/`,
      apiPaths: [{ path: '/api/health', expectStatus: [204] }],
    })
    expect(expectRequiredFailure(mismatch, 'api-endpoints').detail).toContain('expected one of 204')

    const impossible = await verifyDeployment({
      url: `${origin}/`,
      apiPaths: [{ path: '/api/health', expectStatus: [] }],
    })
    expect(expectRequiredFailure(impossible, 'api-endpoints').detail).toContain('no status can pass')

    const accepted = await verifyDeployment({
      url: `${origin}/`,
      apiPaths: [{ path: '/api/health', method: 'post', expectStatus: [200] }],
    })
    expect(checkById(accepted, 'api-endpoints').detail).toContain('POST /api/health 200')
    expect(accepted.healthy).toBe(true)
  })

  it('names a configured path it cannot resolve instead of throwing', async () => {
    const report = await verifyDeployment({
      url: `${origin}/`,
      apiPaths: [{ path: 'http://[' }],
      assetPaths: ['http://['],
    })

    expect(expectRequiredFailure(report, 'api-endpoints').detail).toContain('could not be resolved')
    expect(expectRequiredFailure(report, 'static-assets').detail).toContain('could not be resolved')
  })

  it('rejects a base URL that is not absolute http(s)', async () => {
    const relative = await verifyDeployment({
      url: 'not-a-url',
      htmlMustContain: [MARKER],
      apiPaths: [{ path: '/api/health' }],
      assetPaths: ['/assets/app.js'],
    })

    expect(expectRequiredFailure(relative, 'url-resolves').detail).toContain('not an absolute http(s) URL')
    for (const id of ['https', 'main-page', 'html-markers', 'api-endpoints', 'static-assets', 'no-exposed-secrets'] as const) {
      expect(checkById(relative, id).status).toBe('skip')
    }
    expect(checkById(relative, 'https').required).toBe(false)
    expect(checkById(relative, 'reachability').detail).toContain('reachability is unknown')
    expect(relative.reachability).toBe('unknown')

    const ftp = await verifyDeployment({ url: 'ftp://files.example.com/app' })
    expect(expectRequiredFailure(ftp, 'url-resolves').detail).toContain('not an absolute http(s) URL')
  })

  it('turns a non-Error rejection into a failed check', async () => {
    const text = await verifyDeployment({
      url: 'http://127.0.0.1:1/',
      fetchImpl: async () => {
        throw 'connection reset by peer'
      },
    })
    expect(expectRequiredFailure(text, 'url-resolves').detail).toContain('connection reset by peer')

    const other = await verifyDeployment({
      url: 'http://127.0.0.1:1/',
      fetchImpl: async () => {
        throw 42
      },
    })
    expect(expectRequiredFailure(other, 'url-resolves').detail).toContain('non-Error value')
  })

  it('bounds a hanging request by timeoutMs', async () => {
    const started = Date.now()
    const report = await verifyDeployment({ url: `${origin}/slow`, timeoutMs: 250 })

    expect(Date.now() - started).toBeLessThan(5000)
    expect(expectRequiredFailure(report, 'url-resolves').detail).toContain('failed')
  })

  it('keeps a long observed fact on one bounded line', async () => {
    const report = await verifyDeployment({
      url: `${origin}/`,
      htmlMustContain: [`absent-${'x'.repeat(600)}`, 'missing\nwith a newline'],
    })

    const markers = expectRequiredFailure(report, 'html-markers')
    expect(markers.detail).not.toContain('\n')
    expect(markers.detail.length).toBeLessThanOrEqual(520)
    expect(markers.detail.endsWith('...')).toBe(true)
  })
})

describe('reachabilityOf', () => {
  it('classifies a public host as public', () => {
    expect(reachabilityOf('https://app.example.com')).toBe('public')
  })

  it('classifies loopback, wildcard, and private hosts as local', () => {
    expect(reachabilityOf('http://127.0.0.1:3000')).toBe('local')
    expect(reachabilityOf('http://localhost:5173')).toBe('local')
    expect(reachabilityOf('http://0.0.0.0:4000')).toBe('local')
    expect(reachabilityOf('http://[::1]:4000')).toBe('local')
    expect(reachabilityOf('http://10.0.0.5:8080')).toBe('local')
    expect(reachabilityOf('http://172.16.4.2')).toBe('local')
    expect(reachabilityOf('http://192.168.1.44:8080')).toBe('local')
    expect(reachabilityOf('http://169.254.10.1')).toBe('local')
    expect(reachabilityOf('https://foo.local')).toBe('local')
  })

  it('does not widen a private range to its neighbours', () => {
    expect(reachabilityOf('http://172.32.0.9')).toBe('public')
    expect(reachabilityOf('https://10.example.com')).toBe('public')
  })

  it('reports unknown for a URL it cannot classify', () => {
    expect(reachabilityOf('not-a-url')).toBe('unknown')
    expect(reachabilityOf('file:///tmp/site')).toBe('unknown')
  })
})
