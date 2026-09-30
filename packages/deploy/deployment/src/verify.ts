/**
 * Production verification: the pass that decides whether a deployment may be
 * reported as a success.
 *
 * A build passing is not a deployment passing. A bundler proves the sources
 * compile; it says nothing about whether the published URL answers at all,
 * whether the served page still carries the mount marker the app needs, whether
 * asset and API routes survived the provider's rewrite rules, or whether the
 * published HTML shipped a live credential by accident. So this module asks the
 * real URL those questions over the network and records every answer as one
 * {@link VerificationCheck} on a {@link VerificationReport}.
 *
 * Two invariants keep that record trustworthy. Nothing here throws on a network
 * fault: an unreachable host, a refused TLS handshake, and a timeout each become
 * a failed required check, because a verification that rejects teaches its
 * caller nothing about the deployment. And reachability is derived from the URL
 * itself, never from a provider's claim — a URL on `127.0.0.1`, `localhost`,
 * `0.0.0.0`, `::1`, `*.local`, or a private IP literal is recorded as `local`,
 * so no surface can present a laptop dev server as a publicly reachable
 * deployment however green its checks are.
 * @module @deepseek-ai/dsh-deployment/verify
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Reachability, VerificationCheck, VerificationReport } from './types.ts'

/** Path appended to the base URL, e.g. `/api/health`. */
export interface ApiProbe {
  /** Path appended to the base URL, e.g. `/api/health`. */
  path: string
  /** HTTP method, default GET. */
  method?: string
  /** Statuses that count as a pass; default 200-299. */
  expectStatus?: readonly number[]
}

/** One deployment to verify, plus the evidence the caller wants gathered. */
export interface VerificationRequest {
  /** Base URL of the deployment. */
  url: string
  /** Require an https URL that answers over TLS. Default false. */
  requireHttps?: boolean
  /** Asset paths to fetch, e.g. `/assets/app.js`. */
  assetPaths?: readonly string[]
  /** API endpoints that must answer. */
  apiPaths?: readonly ApiProbe[]
  /** Strings the main page HTML must contain. */
  htmlMustContain?: readonly string[]
  /** Scan the fetched HTML for likely exposed secrets. Default true. */
  scanForSecrets?: boolean
  /** Per-request timeout. Default 15000. */
  timeoutMs?: number
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/** Per-request deadline applied when the caller does not name one. */
const DEFAULT_TIMEOUT_MS = 15_000

/** Longest detail kept on one check; a longer observed fact is truncated, never wrapped. */
const MAX_DETAIL_LENGTH = 500

/** Hostnames that only ever answer from the machine running the check. */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

/** Loopback, link-local, and RFC1918 IPv4 literals: a LAN address is not a public deployment. */
const PRIVATE_HOST_PATTERN = /^(?:(?:127|10)(?:\.\d{1,3}){3}|(?:192\.168|169\.254|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2})$/

/**
 * Source-plane path of the canonical secret scanner, which a sibling module owns.
 *
 * Annotated as `string`, never left as the literal: a literal specifier would
 * make TypeScript resolve the import at build time and fail the package on a
 * module another owner has not landed yet.
 */
const SIBLING_SCANNER_MODULE: string = './secrets.ts'

/** Opening markup of a page served without a content type. */
const HTML_BODY_PATTERN = /^\s*(?:<!doctype\s+html|<html[\s>])/i

/** Human labels for the check ids, kept in one place so a report row never drifts from its id. */
const CHECK_LABELS = {
  'url-resolves': 'Base URL resolves',
  https: 'HTTPS',
  'main-page': 'Main page HTML',
  'html-markers': 'HTML markers',
  'api-endpoints': 'API endpoints',
  'static-assets': 'Static assets',
  'no-exposed-secrets': 'No exposed secrets',
  reachability: 'Reachability',
} as const

/**
 * High-signal credential shapes used when the sibling secret scanner is absent.
 *
 * These are a floor, not a replacement: `src/secrets.ts` owns the canonical
 * patterns, and its findings win per credential kind. The floor exists so a
 * deployed page is still scanned when that module is missing, unpublished, or
 * shaped differently than this module expects — a verification that silently
 * stopped checking for exposed credentials would be worse than one that finds
 * nothing. Kinds are spelled exactly as the scanner spells them so the two
 * never report one credential twice.
 */
const FALLBACK_SECRET_PATTERNS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/ },
  { kind: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'stripe-live-key', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
]

/** One HTTP exchange, reduced to the facts the checks report. */
interface ProbeResponse {
  /** Final status code, after any redirect the fetch followed. */
  readonly status: number
  /** Response content type, or an empty string when the response named none. */
  readonly contentType: string
  /** Response body decoded as text. */
  readonly body: string
  /** Body size in bytes, so a skip-level "empty" body is reported as a number. */
  readonly bytes: number
}

/** The outcome of one request: an answer, or the transport fault that replaced one. */
type ProbeAttempt =
  | { readonly ok: true; readonly response: ProbeResponse }
  | { readonly ok: false; readonly error: string }

/** The main-page attempt, including the case where no request could be aimed at all. */
type PageProbe =
  | { readonly state: 'invalid'; readonly problem: string }
  | { readonly state: 'failed'; readonly problem: string }
  | { readonly state: 'answered'; readonly response: ProbeResponse }

/** One fetched body handed to the secret scan, materialized under a temp scan root. */
interface ScannedSource {
  /** How the source is named in a finding, e.g. `the main page`. */
  readonly label: string
  /** File name inside the scan root, extension included so extension-aware scanners read it. */
  readonly fileName: string
  /** The fetched text. */
  readonly text: string
  /** Size of `text` in bytes. */
  readonly bytes: number
}

/** Result of scanning the fetched content: finding labels, or why no scan happened. */
type SecretScanOutcome =
  | { readonly ok: true; readonly labels: readonly string[] }
  | { readonly ok: false; readonly error: string }

/** One finding, reduced to the kind that names it and the one line a report may print. */
interface SecretLabel {
  /** Credential kind, spelled as the canonical scanner spells it. */
  readonly kind: string
  /** Masked one-line description. */
  readonly label: string
}

/** The sibling scanner's exported entry point, narrowed to the shape this module calls. */
type SiblingScanner = (root: string) => unknown

/** One check's status, taken from the frozen report contract. */
type CheckStatus = VerificationCheck['status']

/**
 * Verify a published deployment against its real URL.
 *
 * The checks run in a fixed order — URL, TLS, main page, markers, API, assets,
 * secret exposure, reachability — and each emits exactly one
 * {@link VerificationCheck}, so a reader can diff two reports position by
 * position. The report is healthy only when no *required* check failed; a check
 * that does not apply (no markers requested, TLS not required, scanning turned
 * off) is a `skip` and never decides health.
 *
 * @param request - The deployment URL plus the evidence to gather.
 * @returns The report, resolved even when the deployment is unreachable.
 */
export async function verifyDeployment(request: VerificationRequest): Promise<VerificationReport> {
  const fetchImpl = request.fetchImpl ?? fetch
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const reachability = reachabilityOf(request.url)
  const requiresHttps = request.requireHttps === true
  const parsed = parseHttpUrl(request.url)
  const htmlMarkers = request.htmlMustContain ?? []
  const apiProbes = request.apiPaths ?? []
  const assetPaths = request.assetPaths ?? []
  const scansForSecrets = request.scanForSecrets !== false
  const checks: VerificationCheck[] = []

  const pageProbe = await probePage(parsed, request.url, fetchImpl, timeoutMs)
  const page = pageProbe.state === 'answered' ? pageProbe.response : undefined
  const pageGap = pageProbe.state === 'answered' ? '' : `: ${pageProbe.problem}`
  const sources: ScannedSource[] = page === undefined
    ? []
    : [{ label: 'the main page', fileName: 'index.html', text: page.body, bytes: page.bytes }]

  // 1. url-resolves: an absolute http(s) URL whose main page request completed.
  checks.push(pageProbe.state === 'answered'
    ? check('url-resolves', 'pass', `base URL answered ${pageProbe.response.status} with ${pageProbe.response.bytes} bytes: ${request.url}`, true)
    : check('url-resolves', 'fail', pageProbe.problem, true))

  // 2. https: required only when the caller demands TLS; otherwise an http page is a fact, not a fault.
  if (parsed === undefined) {
    checks.push(check('https', 'skip', `https was not evaluated because the base URL is not an absolute http(s) URL: ${request.url}`, requiresHttps))
  } else if (parsed.protocol !== 'https:') {
    checks.push(requiresHttps
      ? check('https', 'fail', `requireHttps is set but the deployment is served over http, so the page never answered over TLS: ${parsed.origin}`, true)
      : check('https', 'skip', `TLS was not required (requireHttps is false) and the deployment is served over http: ${parsed.origin}`, false))
  } else if (page === undefined) {
    checks.push(check('https', 'skip', `the base URL uses https but the page request did not complete${pageGap}`, requiresHttps))
  } else {
    checks.push(check('https', 'pass', `page answered over https (status ${page.status}) from ${parsed.origin}`, requiresHttps))
  }

  // 3. main-page: a 2xx status with a non-empty body that is actually HTML.
  if (page === undefined) {
    checks.push(check('main-page', 'skip', `main page HTML was not checked${pageGap}`, true))
  } else if (page.status < 200 || page.status > 299) {
    checks.push(check('main-page', 'fail', `base URL answered ${page.status} instead of a 2xx HTML page: ${request.url}`, true))
  } else if (page.bytes === 0) {
    checks.push(check('main-page', 'fail', `base URL answered ${page.status} with an empty body (0 bytes): ${request.url}`, true))
  } else if (!looksLikeHtml(page)) {
    checks.push(check('main-page', 'fail', `base URL answered ${page.status} with ${page.bytes} bytes of ${contentTypeLabel(page)} content, not HTML: ${request.url}`, true))
  } else {
    checks.push(check('main-page', 'pass', `base URL answered ${page.status} with ${page.bytes} bytes of HTML`, true))
  }

  // 4. html-markers: every requested string is in the served page.
  if (htmlMarkers.length === 0) {
    checks.push(check('html-markers', 'skip', 'no HTML markers were requested (htmlMustContain is empty)', false))
  } else if (page === undefined) {
    checks.push(check('html-markers', 'skip', `markers were not checked because the main page HTML is unavailable${pageGap}`, true))
  } else {
    const missing = htmlMarkers.filter(marker => !page.body.includes(marker))
    checks.push(missing.length === 0
      ? check('html-markers', 'pass', `page HTML contains every requested marker (${htmlMarkers.length}): ${htmlMarkers.join(', ')}`, true)
      : check('html-markers', 'fail', `page HTML is missing ${missing.length} of ${htmlMarkers.length} markers: ${missing.join(', ')}`, true))
  }

  // 5. api-endpoints: every probe answers an accepted status; the detail names every failure.
  if (apiProbes.length === 0) {
    checks.push(check('api-endpoints', 'skip', 'no API endpoints were requested (apiPaths is empty)', false))
  } else if (parsed === undefined) {
    checks.push(check('api-endpoints', 'skip', `API endpoints were not checked because the base URL is not an absolute http(s) URL: ${request.url}`, true))
  } else {
    const answered: string[] = []
    const failed: string[] = []
    for (const probe of apiProbes) {
      const method = (probe.method ?? 'GET').toUpperCase()
      const target = resolveTarget(parsed, probe.path)
      if (target === undefined) {
        failed.push(`${method} ${probe.path} could not be resolved against ${parsed.origin}`)
        continue
      }
      const attempt = await probeUrl(target, method, fetchImpl, timeoutMs)
      if (!attempt.ok) {
        failed.push(`${method} ${probe.path} failed: ${attempt.error}`)
      } else if (isAcceptedStatus(attempt.response.status, probe.expectStatus)) {
        answered.push(`${method} ${probe.path} ${attempt.response.status}`)
      } else {
        failed.push(`${method} ${probe.path} answered ${attempt.response.status} (expected ${describeAcceptedStatuses(probe.expectStatus)})`)
      }
    }
    checks.push(failed.length === 0
      ? check('api-endpoints', 'pass', `all requested API endpoints answered an accepted status (${apiProbes.length}): ${answered.join(', ')}`, true)
      : check('api-endpoints', 'fail', `${failed.length} of ${apiProbes.length} API endpoints failed: ${failed.join('; ')}`, true))
  }

  // 6. static-assets: every asset answers 2xx with a body that survived the publish.
  if (assetPaths.length === 0) {
    checks.push(check('static-assets', 'skip', 'no static assets were requested (assetPaths is empty)', false))
  } else if (parsed === undefined) {
    checks.push(check('static-assets', 'skip', `assets were not checked because the base URL is not an absolute http(s) URL: ${request.url}`, true))
  } else {
    const served: string[] = []
    const failed: string[] = []
    for (const assetPath of assetPaths) {
      const target = resolveTarget(parsed, assetPath)
      if (target === undefined) {
        failed.push(`${assetPath} could not be resolved against ${parsed.origin}`)
        continue
      }
      const attempt = await probeUrl(target, 'GET', fetchImpl, timeoutMs)
      if (!attempt.ok) {
        failed.push(`${assetPath} failed: ${attempt.error}`)
      } else if (attempt.response.status < 200 || attempt.response.status > 299) {
        failed.push(`${assetPath} answered ${attempt.response.status} instead of a 2xx status`)
      } else if (attempt.response.bytes === 0) {
        failed.push(`${assetPath} answered ${attempt.response.status} with an empty body (0 bytes)`)
      } else {
        served.push(`${assetPath} ${attempt.response.status} (${attempt.response.bytes} bytes)`)
        sources.push({
          label: assetPath,
          fileName: target.pathname.replace(/[^A-Za-z0-9._-]/g, '_'),
          text: attempt.response.body,
          bytes: attempt.response.bytes,
        })
      }
    }
    checks.push(failed.length === 0
      ? check('static-assets', 'pass', `every requested asset answered 2xx with a body (${assetPaths.length}): ${served.join(', ')}`, true)
      : check('static-assets', 'fail', `${failed.length} of ${assetPaths.length} static assets failed: ${failed.join('; ')}`, true))
  }

  // 7. no-exposed-secrets: the published bytes are scanned, never assumed clean.
  if (!scansForSecrets) {
    checks.push(check('no-exposed-secrets', 'skip', 'secret scanning was disabled (scanForSecrets is false)', false))
  } else if (sources.length === 0) {
    checks.push(check('no-exposed-secrets', 'skip', `deployed content was not scanned because no response body was fetched${pageGap}`, true))
  } else {
    const scannedBytes = sources.reduce((total, source) => total + source.bytes, 0)
    const scan = await scanExposedSecrets(sources)
    if (!scan.ok) {
      checks.push(check('no-exposed-secrets', 'fail', `deployed content could not be scanned: ${scan.error}`, true))
    } else if (scan.labels.length === 0) {
      checks.push(check('no-exposed-secrets', 'pass', `scanned ${scannedBytes} bytes across ${sources.length} responses and found no exposed secrets`, true))
    } else {
      checks.push(check('no-exposed-secrets', 'fail', `found ${scan.labels.length} likely exposed secrets in deployed content: ${scan.labels.join('; ')}`, true))
    }
  }

  // 8. reachability: always reported, never required — it classifies, it does not gate.
  checks.push(check('reachability', 'pass', reachabilityDetail(reachability, request.url), false))

  return {
    url: request.url,
    reachability,
    checkedAt: new Date().toISOString(),
    checks,
    healthy: checks.every(entry => !entry.required || entry.status !== 'fail'),
  }
}

/**
 * Classify a URL as publicly reachable or local-only.
 *
 * The classification comes from the URL alone so a provider's answer cannot
 * upgrade a local server into a public deployment: loopback, wildcard,
 * link-local, and RFC1918 hosts are `local`, `*.local` names are `local`
 * (Bonjour/mDNS names resolve only on the local network), and a URL that cannot
 * be parsed, or that has no host at all, is `unknown` rather than assumed
 * public.
 *
 * @param url - The URL a provider returned or a user supplied.
 * @returns `public`, `local`, or `unknown`.
 */
export function reachabilityOf(url: string): Reachability {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return 'unknown'
  }
  if (hostname === '') return 'unknown'
  if (LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.local') || PRIVATE_HOST_PATTERN.test(hostname)) return 'local'
  return 'public'
}

/**
 * Parse a URL that verification can actually be aimed at.
 *
 * @param url - Candidate base URL.
 * @returns The parsed URL, or `undefined` when it is not absolute http(s).
 */
function parseHttpUrl(url: string): URL | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
}

/**
 * Resolve a configured path against the deployment base.
 *
 * @param base - The parsed base URL.
 * @param path - Path or absolute URL configured by the caller.
 * @returns The absolute target, or `undefined` when the pair is not a usable URL.
 */
function resolveTarget(base: URL, path: string): URL | undefined {
  try {
    return new URL(path, base)
  } catch {
    return undefined
  }
}

/**
 * Attempt the main page, keeping "no request was possible" distinct from "the
 * request failed" so the check detail names which one happened.
 *
 * @param parsed - The base URL, when it was absolute http(s).
 * @param url - The original URL, for the detail.
 * @param fetchImpl - Fetch implementation to use.
 * @param timeoutMs - Per-request deadline.
 * @returns The page attempt.
 */
async function probePage(parsed: URL | undefined, url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<PageProbe> {
  if (parsed === undefined) return { state: 'invalid', problem: `base URL is not an absolute http(s) URL: ${url}` }
  const attempt = await probeUrl(parsed, 'GET', fetchImpl, timeoutMs)
  return attempt.ok
    ? { state: 'answered', response: attempt.response }
    : { state: 'failed', problem: `request to ${url} failed: ${attempt.error}` }
}

/**
 * Perform one bounded request and reduce it to reportable facts.
 *
 * @param target - Absolute URL to request.
 * @param method - HTTP method.
 * @param fetchImpl - Fetch implementation to use.
 * @param timeoutMs - Per-request deadline.
 * @returns The answer, or the transport fault that replaced it.
 */
async function probeUrl(target: URL, method: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<ProbeAttempt> {
  try {
    const response = await fetchImpl(target, { method, signal: AbortSignal.timeout(timeoutMs) })
    const body = await response.text()
    return {
      ok: true,
      response: {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body,
        bytes: Buffer.byteLength(body),
      },
    }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

/**
 * Scan fetched bodies for likely credentials, from a temp file.
 *
 * Every fetched body is written under a fresh temp root so the canonical tree
 * scanner (`./secrets.ts`, which scans a directory) reads exactly what the
 * deployment served — a scanner that only ever sees the source tree cannot
 * notice a credential that a build inlined into the published HTML. That root
 * is removed before this returns.
 *
 * @param sources - The fetched bodies to scan.
 * @returns Finding labels, already masked, or why no scan could run.
 */
async function scanExposedSecrets(sources: readonly ScannedSource[]): Promise<SecretScanOutcome> {
  let root: string
  try {
    root = await createScanRoot(sources)
  } catch (error) {
    // A filesystem fault on the scan root is not a network fault, but it is
    // still the verification's problem to report: the deployment cannot be
    // called clean when its content could not be scanned at all.
    return { ok: false, error: describeError(error) }
  }
  try {
    return { ok: true, labels: (await collectSecretLabels(sources, root)).map(finding => finding.label) }
  } finally {
    /* v8 ignore next 2 -- the scan root is disposable; a teardown fault must not replace the check result. */
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Materialize fetched bodies under a fresh temp root.
 *
 * @param sources - The fetched bodies to write.
 * @returns The temp root holding one file per fetched body.
 * @throws When the filesystem refuses the root or a write, which the caller turns into a failed check.
 */
async function createScanRoot(sources: readonly ScannedSource[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-deploy-verify-'))
  await Promise.all(sources.map((source, index) => writeFile(join(root, `${index}-${source.fileName}`), source.text)))
  return root
}

/**
 * Collect one finding per credential kind from the canonical scanner and the
 * built-in floor.
 *
 * The canonical scanner is asked first and wins for every kind it reports, so
 * its kinds, its masks, and its per-file line numbers are what a deployment
 * record keeps. The built-in floor then fills the kinds it did not report,
 * which is what keeps this check meaningful when the sibling module is absent
 * or answers in an unexpected shape.
 *
 * @param sources - The fetched bodies, scanned in memory by the floor.
 * @param root - The temp root holding the same bytes for the tree scanner.
 * @returns Deduplicated findings, one per kind.
 */
async function collectSecretLabels(sources: readonly ScannedSource[], root: string): Promise<readonly SecretLabel[]> {
  const byKind = new Map<string, string>()
  const scanner = await loadSiblingScanner()
  if (scanner !== undefined) {
    for (const finding of await scanWithSiblingScanner(scanner, root)) {
      if (!byKind.has(finding.kind)) byKind.set(finding.kind, finding.label)
    }
  }
  for (const { kind, pattern } of FALLBACK_SECRET_PATTERNS) {
    if (byKind.has(kind)) continue
    for (const source of sources) {
      const found = findFirstMatch(source.text, pattern)
      if (found !== undefined) {
        byKind.set(kind, `${kind} (${maskSecret(found)}) in ${source.label}`)
        break
      }
    }
  }
  return [...byKind].map(([kind, label]) => ({ kind, label }))
}

/**
 * Load the canonical secret scanner when the sibling module exists.
 *
 * `src/secrets.ts` is owned by another module and may not have landed yet, so
 * the import is resolved at runtime through a non-literal specifier and every
 * failure mode (missing file, missing export, throwing module) degrades to the
 * built-in pattern floor instead of failing the verification. A built `lib/`
 * build finds no sibling `.ts` here and uses the floor as well.
 *
 * @returns The sibling scanner, or `undefined` when it is unavailable.
 */
async function loadSiblingScanner(): Promise<SiblingScanner | undefined> {
  if (!existsSync(new URL(SIBLING_SCANNER_MODULE, import.meta.url))) return undefined
  /* v8 ignore start -- defensive: a missing or differently-shaped sibling export degrades to the floor. */
  try {
    const loaded: unknown = await import(SIBLING_SCANNER_MODULE)
    if (typeof loaded !== 'object' || loaded === null) return undefined
    const candidate = (loaded as { scanForSecrets?: unknown }).scanForSecrets
    return typeof candidate === 'function' ? (candidate as SiblingScanner) : undefined
  } catch {
    return undefined
  }
  /* v8 ignore stop */
}

/**
 * Ask the sibling scanner for findings and reduce them to kind plus one line.
 *
 * The canonical scanner returns a `SecretScanResult`; anything else — a
 * different signature, a rejection, a root it refuses to list — yields no
 * findings here so the built-in floor decides, and the check still reports.
 *
 * @param scanner - The sibling module's `scanForSecrets` export.
 * @param root - The temp root holding the fetched bodies.
 * @returns One entry per finding, already masked by the scanner.
 */
async function scanWithSiblingScanner(scanner: SiblingScanner, root: string): Promise<readonly SecretLabel[]> {
  /* v8 ignore start -- the result-shape guards below exist for a module this package does not own; a mismatch must degrade, not throw. */
  let result: unknown
  try {
    result = await scanner(root)
  } catch {
    return []
  }
  if (typeof result !== 'object' || result === null) return []
  const findings = (result as { findings?: unknown }).findings
  if (!Array.isArray(findings)) return []
  const entries: readonly unknown[] = findings
  const labels: SecretLabel[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const { kind, file, line, masked } = entry as { kind?: unknown; file?: unknown; line?: unknown; masked?: unknown }
    const kindLabel = typeof kind === 'string' ? kind : 'secret'
    const where = typeof file === 'string' ? file : 'deployed content'
    const lineLabel = typeof line === 'number' ? `:${line}` : ''
    const maskLabel = typeof masked === 'string' && masked !== '' ? ` (${masked})` : ''
    labels.push({ kind: kindLabel, label: `${kindLabel}${maskLabel} in ${where}${lineLabel}` })
  }
  return labels
  /* v8 ignore stop */
}

/**
 * Find the first match of a pattern in a body.
 *
 * @param text - Body text to search.
 * @param pattern - A non-global pattern, so `exec` never carries `lastIndex` state.
 * @returns The matched text, or `undefined` when the pattern is absent.
 */
function findFirstMatch(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text)
  return match === null ? undefined : match[0]
}

/**
 * Mask a matched credential down to a short recognisable prefix.
 *
 * @param value - The matched secret.
 * @returns A prefix plus the match length, safe to print in a report.
 */
function maskSecret(value: string): string {
  return `${value.slice(0, 4)}...(${value.length} chars)`
}

/**
 * Build one check, normalizing the detail to a single bounded line.
 *
 * @param id - Stable check id.
 * @param status - Observed status.
 * @param detail - One line naming what was observed.
 * @param required - Whether a failure makes the deployment unhealthy.
 * @returns The report entry.
 */
function check(id: keyof typeof CHECK_LABELS, status: CheckStatus, detail: string, required: boolean): VerificationCheck {
  return { id, label: CHECK_LABELS[id], status, detail: oneLine(detail), required }
}

/**
 * Collapse a detail onto one bounded line.
 *
 * @param detail - Raw detail, possibly carrying a multi-line observed value.
 * @returns Whitespace-collapsed, trimmed, length-bounded text.
 */
function oneLine(detail: string): string {
  const collapsed = detail.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_DETAIL_LENGTH ? `${collapsed.slice(0, MAX_DETAIL_LENGTH)}...` : collapsed
}

/**
 * Describe a transport fault without ever throwing on an exotic rejection.
 *
 * @param error - Whatever the fetch rejected with.
 * @returns A one-line description, including the cause chain when there is one.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message
  }
  return typeof error === 'string' ? `request rejected with: ${error}` : 'request rejected with a non-Error value'
}

/**
 * Decide whether a response body is HTML.
 *
 * A declared `text/html` content type is enough; otherwise the body must open
 * with a doctype or `<html>`, which covers static hosts that serve no content
 * type on their entry document.
 *
 * @param response - The probed response.
 * @returns Whether the body can serve as the main page.
 */
function looksLikeHtml(response: ProbeResponse): boolean {
  return response.contentType.includes('html') || HTML_BODY_PATTERN.test(response.body)
}

/**
 * Name a response's content type for a failure detail.
 *
 * @param response - The probed response.
 * @returns The declared content type, or `unlabeled`.
 */
function contentTypeLabel(response: ProbeResponse): string {
  return response.contentType === '' ? 'unlabeled' : response.contentType
}

/**
 * Decide whether a status is accepted for one API probe.
 *
 * @param status - Observed status code.
 * @param expectStatus - Caller's accept list, or `undefined` for the 2xx default.
 * @returns Whether the probe passes.
 */
function isAcceptedStatus(status: number, expectStatus: readonly number[] | undefined): boolean {
  if (expectStatus === undefined) return status >= 200 && status <= 299
  return expectStatus.includes(status)
}

/**
 * Describe an accept list for a failure detail.
 *
 * @param expectStatus - Caller's accept list, or `undefined` for the 2xx default.
 * @returns A phrase naming what would have passed.
 */
function describeAcceptedStatuses(expectStatus: readonly number[] | undefined): string {
  if (expectStatus === undefined) return 'a 2xx status'
  if (expectStatus.length === 0) return 'an empty accept list, so no status can pass'
  return `one of ${expectStatus.join(', ')}`
}

/**
 * Name the reachability classification as an observed fact.
 *
 * The literal classification is in the detail as well as in
 * {@link VerificationReport.reachability}, so a reader of the check list alone
 * still sees that this URL is local and must not be presented as a deployment.
 *
 * @param reachability - Classification from {@link reachabilityOf}.
 * @param url - The verified URL.
 * @returns One line naming what that classification means.
 */
function reachabilityDetail(reachability: Reachability, url: string): string {
  switch (reachability) {
    case 'public': return `reachability is public: ${url} is reachable from the public internet`
    case 'local': return `reachability is local: ${url} answers from this machine only and is not a public deployment`
    case 'unknown': return `reachability is unknown: ${url} could not be classified as public or local`
  }
}
