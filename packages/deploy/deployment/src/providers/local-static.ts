/**
 * The local static provider: real releases, on a real port, on this machine.
 *
 * This adapter exists because "deployed" has to mean something even when the
 * only reachable surface is localhost. It publishes the way a hosting company
 * does — an immutable release directory per publish, a `current` pointer flipped
 * atomically, one HTTP server shared by every project it serves — so a build can
 * be verified end to end (real URL, real bytes, real headers, real 404s) without
 * an account, a token, or a network round trip. It refuses to present that as a
 * public deployment: the descriptor is non-consequential and the URL it returns
 * is a loopback URL, which the report layer classifies `local`.
 *
 * It also refuses to destroy history or to fake a rollback. Every publish adds a
 * release and repoints `current`; nothing is ever deleted here, a release
 * directory is never reused (a second publish under a id that already has one is
 * an error, not a merge), and a rollback only repoints `current` back at the
 * release the record maps to. That mapping is written at publish time — the
 * release directory is named after the manager's `deploymentId`, and
 * `records/<record id>` names it durably — so a restore after a restart is exact.
 * When the recorded release is gone, or when a record carries no mapping at all,
 * this adapter throws instead of serving whatever happens to be current: a
 * rollback that silently serves a different build is worse than one that fails.
 * @module @deepseek-ai/dsh-deployment/providers/local-static
 */

import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, extname, join, resolve, sep } from 'node:path'
import type {
  DeployEnvironment, DeploymentRecord, ProjectPlan, ProviderAdapter, ProviderContext, ProviderDescriptor, PublishOutcome,
} from '../types.ts'

/** Stable adapter id, and the `providerId` of every record this adapter publishes. */
const PROVIDER_ID = 'local-static'

/** Per-slug directory holding the `releases/` tree, the index, and the `current` pointer. */
const RELEASES_DIR = 'releases'

/** Single-line pointer naming the release directory a slug currently serves. */
const POINTER_FILE = 'current'

/** Durable index of every release published for one slug, newest first. */
const INDEX_FILE = 'releases.json'

/** Directory of `record id -> release directory` pointers, written at publish and on restore. */
const RECORDS_DIR = 'records'

/** One path segment this adapter will create or accept: no separators, no dot segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/**
 * Explicit content types for the artifact kinds a static build ships. Anything
 * else is served as opaque bytes rather than guessed at: a wrong `content-type`
 * is a real bug (a stylesheet executed as HTML), while octet-stream is honest.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
}

/** Options for {@link createLocalStaticProvider}. */
export interface LocalStaticOptions {
  /** Directory that holds published releases. Required. */
  rootDir: string
  /** Port to serve on; defaults to 0 (an ephemeral port chosen by the OS). */
  port?: number
  /** Hostname to bind and report; defaults to 127.0.0.1. */
  hostname?: string
}

/** One published release, as recorded in the slug's index. */
interface ReleaseEntry {
  /** Release directory name. */
  id: string
  /** URL the release is reachable at. Stable per slug; `current` decides the bytes. */
  url: string
  /** ISO timestamp of publication. */
  createdAt: string
  /** Environment the release serves. Also part of the slug. */
  environment: DeployEnvironment
}

/** How a restore recognized the release a record names. */
type ReleaseVia = 'record-pointer' | 'external-id'

/** Result of mapping a record to a release directory. */
type ReleaseLookup =
  | { kind: 'found'; id: string; via: ReleaseVia }
  | { kind: 'gone'; id: string }
  | { kind: 'unmapped' }

/** A listening server plus the port it actually bound. */
interface RunningServer {
  server: Server
  port: number
}

/**
 * Create the local static provider.
 * @param options - release root, and optionally the port and hostname to bind.
 * @returns the adapter, plus `close()` so a caller can stop the server it started.
 */
export function createLocalStaticProvider(options: LocalStaticOptions): ProviderAdapter & { close(): Promise<void> } {
  const rootDir = resolve(options.rootDir)
  const hostname = options.hostname ?? '127.0.0.1'
  const configuredPort = options.port ?? 0
  let running: Promise<RunningServer> | undefined

  const descriptor: ProviderDescriptor = {
    id: PROVIDER_ID,
    label: 'Local static server',
    capabilities: ['static'],
    consequential: false,
    credentials: [],
    supportsRollback: true,
  }

  /** Start the one server this provider serves every slug from, or reuse the running one. */
  function ensureServer(): Promise<RunningServer> {
    running ??= new Promise<RunningServer>((resolveListen, rejectListen) => {
      const server = createServer((request, response) => {
        /* v8 ignore next 4 -- every expected miss is answered inline; this needs a filesystem fault after a successful stat. */
        handleRequest(rootDir, request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('internal error\n')
        })
      })
      server.once('error', rejectListen)
      server.listen(configuredPort, hostname, () => {
        server.removeListener('error', rejectListen)
        const address = server.address()
        /* v8 ignore next -- listen() with a numeric port and a host always yields AddressInfo; the guard exists for the type. */
        const port = address !== null && typeof address === 'object' ? address.port : configuredPort
        resolveListen({ server, port })
      })
    }).catch((error: unknown) => {
      // A port conflict is the operator's problem to fix, not a permanent
      // poisoning of this provider: the next publish may bind successfully.
      running = undefined
      throw error
    })
    return running
  }

  async function publish(ctx: ProviderContext): Promise<PublishOutcome> {
    const slug = slugFor(ctx.projectDir, ctx.environment)
    const slugDir = join(rootDir, slug)
    const releaseId = releaseDirNameFor(ctx.deploymentId)
    const releaseDir = join(slugDir, RELEASES_DIR, releaseId)
    const sourceDir = ctx.plan.outputDir === undefined
      ? resolve(ctx.projectDir)
      : resolve(ctx.projectDir, ctx.plan.outputDir)

    ctx.log(`copying ${sourceDir} -> ${releaseDir}`)
    const source = await stat(sourceDir).catch(() => undefined)
    if (source === undefined || !source.isDirectory()) {
      throw new Error(`local-static cannot publish: build output ${sourceDir} is not a directory (plan.outputDir=${ctx.plan.outputDir ?? 'unset'})`)
    }
    // Read the history before writing anything: an unreadable index must fail the
    // publish while the filesystem is still untouched, never after a release was
    // copied into place.
    const known = await readIndex(slugDir)
    if (await directoryExists(releaseDir)) {
      throw new Error(`local-static cannot publish deployment ${ctx.deploymentId}: release directory ${releaseDir} already exists, and a release is immutable`)
    }
    await mkdir(releaseDir, { recursive: true })
    await cp(sourceDir, releaseDir, { recursive: true })
    ctx.log(`release ${releaseId} staged`)

    const { port } = await ensureServer()
    const url = releaseUrl(hostname, port, slug)
    const entry: ReleaseEntry = { id: releaseId, url, createdAt: new Date().toISOString(), environment: ctx.environment }
    // Index and mapping first, `current` last: the pointer is flipped only after
    // the release it names is described by the history a restore reads.
    await writeIndex(slugDir, [entry, ...known])
    await writeRecordPointer(slugDir, ctx.deploymentId, releaseId)
    await writePointer(slugDir, releaseId)
    ctx.log(`current -> ${releaseId}`)
    ctx.log(`serving ${url} from ${rootDir}`)

    return { url, externalId: releaseId }
  }

  async function restore(ctx: ProviderContext, record: DeploymentRecord): Promise<PublishOutcome> {
    if (record.providerId !== PROVIDER_ID) {
      throw new Error(`local-static cannot restore record ${record.id}: it was published by "${record.providerId}"`)
    }
    const slug = slugFor(record.projectDir, record.environment)
    const slugDir = join(rootDir, slug)
    const lookup = await resolveRelease(slugDir, record)
    if (lookup.kind === 'unmapped') {
      throw new Error(
        `local-static cannot restore record ${record.id}: ${slugDir} holds no mapping for it (no records pointer and no externalId), so it refuses to guess which release to serve`,
      )
    }
    if (lookup.kind === 'gone') throw missingRelease(record, slugDir, lookup.id)

    const releaseDir = join(slugDir, RELEASES_DIR, lookup.id)
    if (!await directoryExists(releaseDir)) throw missingRelease(record, slugDir, lookup.id)

    await writePointer(slugDir, lookup.id)
    await writeRecordPointer(slugDir, record.id, lookup.id)
    const { port } = await ensureServer()
    const url = releaseUrl(hostname, port, slug)
    ctx.log(`restore: record ${record.id} -> release ${lookup.id} (matched by ${lookup.via})`)
    ctx.log(`restore: current -> ${lookup.id}; serving ${url}`)

    return { url, externalId: lookup.id }
  }

  return {
    descriptor,
    supports: (plan: ProjectPlan): boolean =>
      plan.capabilities.length > 0 && plan.capabilities.every(capability => capability === 'static'),
    publish,
    restore,
    /**
     * Stop the HTTP server and await its teardown. Idempotent: a provider that
     * never published has no server, and closing twice is not an error.
     */
    close: async (): Promise<void> => {
      const started = running
      running = undefined
      if (started === undefined) return
      const { server } = await started
      await new Promise<void>((resolveClose) => {
        // A close error means the server was already stopped, which is the state
        // this method promises, so it is not a failure to report.
        server.close(() => {
          resolveClose()
        })
        // Keep-alive sockets from a previous request would otherwise hold the
        // close callback open for as long as the client keeps them alive.
        server.closeAllConnections()
      })
    },
  }
}

/**
 * Slug for one project and environment. The name keeps the URL readable; the
 * digest keeps two projects with the same directory name — or the same project
 * in two environments — from sharing a `current` pointer and silently
 * republishing over each other.
 * @param projectDir - absolute project directory.
 * @param environment - target environment.
 * @returns a path-safe slug.
 */
function slugFor(projectDir: string, environment: DeployEnvironment): string {
  const absolute = resolve(projectDir)
  const named = basename(absolute).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  const digest = createHash('sha256').update(absolute).digest('hex').slice(0, 8)
  return `${named === '' ? 'project' : named}-${environment}-${digest}`
}

/**
 * The release directory name for the manager's deployment id.
 *
 * The id itself whenever it is a usable path segment, which is the normal case
 * and keeps a release directory recognizable. An id that is not — a manager that
 * hands out something path-shaped — is sanitized and suffixed with its own
 * digest, so a manager-assigned id can never escape the releases directory or
 * collide with another release.
 * @param deploymentId - the manager-assigned deployment id.
 * @returns a safe directory name.
 */
function releaseDirNameFor(deploymentId: string): string {
  if (SAFE_SEGMENT.test(deploymentId)) return deploymentId
  const named = deploymentId.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  const digest = createHash('sha256').update(deploymentId).digest('hex').slice(0, 8)
  return `dep_${named === '' ? 'deployment' : named}-${digest}`
}

/** The URL a slug is reachable at on the given port. */
function releaseUrl(hostname: string, port: number, slug: string): string {
  return `http://${hostname}:${String(port)}/${slug}/`
}

/** The error a restore makes when the recorded release is not on disk. */
function missingRelease(record: DeploymentRecord, slugDir: string, releaseId: string): Error {
  return new Error(
    `local-static cannot restore record ${record.id}: release directory ${join(slugDir, RELEASES_DIR, releaseId)} no longer exists; refusing to serve a different release`,
  )
}

/** Read the slug's release index, treating a never-published slug as empty. */
async function readIndex(slugDir: string): Promise<ReleaseEntry[]> {
  const raw = await readFile(join(slugDir, INDEX_FILE), 'utf8').catch(() => undefined)
  if (raw === undefined) return []
  const entries = parseIndex(raw)
  if (entries === undefined) {
    throw new Error(`local-static cannot read ${join(slugDir, INDEX_FILE)}: the release index is not a release list, so publishing would overwrite a history it cannot describe`)
  }
  return entries
}

/** Parse an index file, returning `undefined` when it is not a release list. */
function parseIndex(raw: string): ReleaseEntry[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  return parsed.every(isReleaseEntry) ? parsed : undefined
}

/** The environments a release index row may name. */
const DEPLOY_ENVIRONMENTS: readonly string[] = ['preview', 'staging', 'production']

/** Whether one parsed index row is a release entry. */
function isReleaseEntry(value: unknown): value is ReleaseEntry {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<keyof ReleaseEntry, unknown>>
  const environment = candidate.environment
  return typeof candidate.id === 'string'
    && typeof candidate.url === 'string'
    && typeof candidate.createdAt === 'string'
    && typeof environment === 'string'
    && DEPLOY_ENVIRONMENTS.includes(environment)
}

/** Replace the slug's release index, newest entry first. */
async function writeIndex(slugDir: string, entries: readonly ReleaseEntry[]): Promise<void> {
  await mkdir(slugDir, { recursive: true })
  await writeFile(join(slugDir, INDEX_FILE), `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
}

/** Point the slug's `current` at one release, atomically. */
async function writePointer(slugDir: string, releaseId: string): Promise<void> {
  const pointer = join(slugDir, POINTER_FILE)
  const temporary = `${pointer}.tmp-${randomBytes(3).toString('hex')}`
  await writeFile(temporary, `${releaseId}\n`, 'utf8')
  // rename() is atomic within a directory: a reader observes either the old
  // release or the new one, never a half-written pointer.
  await rename(temporary, pointer)
}

/** Remember which release a manager-assigned id was published to, durably. */
async function writeRecordPointer(slugDir: string, recordId: string, releaseId: string): Promise<void> {
  const recordsDir = join(slugDir, RECORDS_DIR)
  await mkdir(recordsDir, { recursive: true })
  // encodeURIComponent keeps an arbitrary manager id a single path segment.
  await writeFile(join(recordsDir, encodeURIComponent(recordId)), `${releaseId}\n`, 'utf8')
}

/**
 * Map a record to a release directory inside its slug.
 *
 * Only exact mappings are honored: the pointer written for the manager's
 * deployment id, then the release id the record itself carries. There is no
 * fallback to `current` and no timestamp guesswork, so an unmappable record is
 * reported rather than answered with whichever release happens to be live.
 * @param slugDir - the slug's directory.
 * @param record - the record being restored.
 * @returns the mapped release, a known-but-absent release, or no mapping.
 */
async function resolveRelease(slugDir: string, record: DeploymentRecord): Promise<ReleaseLookup> {
  const pointer = (await readFile(join(slugDir, RECORDS_DIR, encodeURIComponent(record.id)), 'utf8').catch(() => undefined))?.trim()
  if (pointer !== undefined && SAFE_SEGMENT.test(pointer)) return { kind: 'found', id: pointer, via: 'record-pointer' }

  const externalId = record.externalId
  if (externalId === undefined) return { kind: 'unmapped' }
  // The record names its release. Serve that one, or fail: substituting an
  // older release here is exactly the silent rollback this adapter refuses.
  if (SAFE_SEGMENT.test(externalId) && await directoryExists(join(slugDir, RELEASES_DIR, externalId))) {
    return { kind: 'found', id: externalId, via: 'external-id' }
  }
  return { kind: 'gone', id: externalId }
}

/** Whether one path exists and is a directory. */
async function directoryExists(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => undefined)
  return stats?.isDirectory() === true
}

/** Content type for a served file, by extension. */
function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** Answer a plain-text response. */
function respond(response: ServerResponse, status: number, body: string, headers: Readonly<Record<string, string>> = {}): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  response.end(body)
}

/** One 404, the only answer this server gives for a path it will not serve. */
function notFound(response: ServerResponse): void {
  respond(response, 404, 'not found\n')
}

/**
 * Serve one request from `<rootDir>/<slug>/<current>`, GET and HEAD only.
 *
 * The slug is the routing key; the release behind it comes from the `current`
 * pointer read on every request, so a republish or a rollback takes effect
 * immediately. Directory requests resolve to `index.html` and nothing else —
 * there is no listing — `..` segments and malformed escapes are 400, dotfiles
 * and unknown slugs are 404, and any other method is 405.
 * @param rootDir - absolute release root.
 * @param request - the incoming request.
 * @param response - the response to write.
 */
async function handleRequest(rootDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    respond(response, 405, 'method not allowed\n', { allow: 'GET, HEAD' })
    return
  }
  /* v8 ignore next -- node:http always sets url on server requests */
  const rawUrl = request.url ?? '/'
  const query = rawUrl.indexOf('?')
  const rawPath = query === -1 ? rawUrl : rawUrl.slice(0, query)
  let path = rawPath
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    respond(response, 400, 'bad request: malformed percent-encoding\n')
    return
  }
  if (path.includes('\0')) {
    respond(response, 400, 'bad request: malformed path\n')
    return
  }
  const segments = path.split('/').filter(segment => segment !== '')
  if (segments.some(segment => segment === '..')) {
    respond(response, 400, 'bad request: path traversal\n')
    return
  }
  const [slug, ...rest] = segments
  if (slug === undefined || !SAFE_SEGMENT.test(slug)) {
    notFound(response)
    return
  }
  if (rest.some(segment => segment.startsWith('.'))) {
    notFound(response)
    return
  }

  const slugDir = join(rootDir, slug)
  const releaseId = (await readFile(join(slugDir, POINTER_FILE), 'utf8').catch(() => undefined))?.trim()
  if (releaseId === undefined || !SAFE_SEGMENT.test(releaseId)) {
    notFound(response)
    return
  }
  const releaseDir = join(slugDir, RELEASES_DIR, releaseId)
  const target = resolve(releaseDir, ...rest)
  /* v8 ignore next -- validated segments cannot leave releaseDir on POSIX; only a Windows backslash segment can. */
  if (target !== releaseDir && !target.startsWith(releaseDir + sep)) {
    respond(response, 400, 'bad request: path traversal\n')
    return
  }

  const stats = await stat(target).catch(() => undefined)
  if (stats === undefined) {
    notFound(response)
    return
  }
  const filePath = stats.isDirectory() ? join(target, 'index.html') : target
  const body = await readFile(filePath).catch(() => undefined)
  if (body === undefined) {
    notFound(response)
    return
  }
  response.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'content-length': String(body.byteLength),
    // A repointed `current` must never be answered from a stale cache.
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  if (request.method === 'HEAD') response.end()
  else response.end(body)
}
