/**
 * Pre-publish secret scanning for the deployment manager.
 *
 * The manager runs this immediately before a provider publishes a project, and
 * again against the build output, because the build output — not the source
 * tree — is what a provider actually uploads. A key that only lives in `dist/`
 * is exactly as public as one in `src/`, and a `.env` that a build copied into
 * its output directory is downloadable by anyone who guesses the name, even
 * when every line in it looks unremarkable.
 *
 * Two invariants make the result usable as a deployment boundary:
 *
 * - A finding never carries a secret. `masked` is always the result of
 *   {@link maskSecret}, which keeps a short identifying prefix and nothing
 *   else, so a report can be logged, rendered in the UI, and written into a
 *   deployment record without becoming a second leak.
 * - A scan never throws for anything it finds *below* the root: an unreadable,
 *   binary, oversized, or symlinked instance is skipped rather than reported,
 *   because a scan that fails is a deployment that cannot be evaluated at all.
 *   `clean` therefore means "read every readable file and found nothing", never
 *   "gave up" — which is why a root that cannot be listed is the one failure
 *   this module refuses to swallow.
 *
 * It must never mutate the scanned project, follow a symlink out of the tree,
 * or report `clean` for a tree it could not list.
 * @module @deepseek-ai/dsh-deployment/secrets
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import type { SecretFinding, SecretScanResult } from './types.ts'

/** One pattern the scanner applies. */
export interface SecretPattern {
  /** Stable kind recorded on every {@link SecretFinding} this pattern produces. */
  id: string
  /** Human label for reports and the UI. */
  label: string
  /**
   * Pattern tried against each line. The scanner rebuilds it with the global
   * flag before use, so a caller-supplied pattern may carry any flags and a
   * stale `lastIndex` can never change what a scan reports.
   */
  regex: RegExp
}

/** Caller-tunable knobs for one scan. */
export interface SecretScanOptions {
  /** Extra patterns merged with the built-ins. */
  extraPatterns?: readonly SecretPattern[]
  /** Directory names never descended into. Defaults to ['.git', 'node_modules']. */
  skipDirectories?: readonly string[]
  /** Files larger than this many bytes are skipped. Defaults to 1 MiB. */
  maxFileBytes?: number
}

/**
 * Directory names never descended into: version-control internals and
 * dependency stores are never published, so a secret there cannot ship.
 * Build output is deliberately *not* on this list — it is what gets published.
 */
const DEFAULT_SKIP_DIRECTORIES: readonly string[] = ['.git', 'node_modules']

/** Files above this size are skipped instead of read. */
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024

/**
 * Bytes inspected for a NUL when deciding whether a file is binary. Minified
 * bundles, images, and archives all carry one early; decoding them as text
 * would only produce byte noise dressed up as findings.
 */
const BINARY_SNIFF_BYTES = 8 * 1024

/** Kind reported for an environment file that would be published. */
const ENV_FILE_KIND = 'env-file'

/**
 * Kind of the catch-all assignment pattern. Its matches are dropped whenever a
 * named pattern matched the same span, so one key is reported once.
 */
const GENERIC_SECRET_KIND = 'generic-secret'

/** Name fragments that mark a committed env template rather than a live env file. */
const ENV_TEMPLATE_NAME_FRAGMENTS: readonly string[] = ['example', 'sample', 'template']

const BUILT_IN_SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'private-key',
    label: 'Private key',
    // Only the PEM header line is needed: the header alone proves the body is
    // there, and matching the body would make the finding's mask impossible.
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  },
  {
    id: 'aws-access-key-id',
    label: 'AWS access key ID',
    regex: /(?:AKIA|ASIA)[0-9A-Z]{12,}/,
  },
  {
    id: 'aws-secret-access-key',
    label: 'AWS secret access key',
    // Anchored on the variable name, because a bare 40-character base64 run is
    // too common to be evidence on its own.
    // `A-Z0-9` without `a-z`: the `i` flag already covers lower case, and a
    // second range would be a duplicate character class.
    regex: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Z0-9/+=]{40}/i,
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    regex: /\b(?:gh[pors]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    id: 'stripe-live-key',
    label: 'Stripe live secret key',
    // `sk_live_` only: test-mode keys are not worth blocking a deploy over.
    regex: /\bsk_live_[A-Za-z0-9]{16,}\b/,
  },
  {
    id: 'openai-key',
    label: 'OpenAI API key',
    // The negative lookahead keeps Anthropic's `sk-ant-…` keys on their own
    // pattern instead of reporting two findings for one key.
    regex: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/,
  },
  {
    id: 'anthropic-key',
    label: 'Anthropic API key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{20,}/,
  },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/,
  },
  {
    id: 'database-url',
    label: 'Database URL with an embedded password',
    // Requires `user:password@`, so a plain connection string with no
    // credentials is not a finding.
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s"',;]*/,
  },
  {
    id: GENERIC_SECRET_KIND,
    label: 'Secret-looking assignment',
    // The catch-all a human would still want flagged: a secret-named variable
    // assigned a 12+ character value. It intentionally accepts values that are
    // not really random (`process.env.TOKEN`, placeholders) because the cost of
    // a false positive is one explicit approval, while the cost of a false
    // negative is a published credential.
    regex: /[\w.-]*(?:api[_-]?key|apikey|secret(?:[_-]?key)?|password|passwd|token|private[_-]?key)["']?\s*[:=]\s*["']?[^\s"',;]{12,}/i,
  },
]

/**
 * Mask all but a short identifying prefix of a secret.
 *
 * The mask keeps at most the first 4 characters and the last 2, and always
 * drops at least one character in between, so no input — however short — can
 * survive whole inside the result. The longest possible mask is 7 characters,
 * well under the 16-character budget, which is what makes a finding safe to
 * log and to store on a deployment record.
 * @param value - The matched secret text.
 * @returns A masked value that never contains the full input.
 */
export function maskSecret(value: string): string {
  if (value.length < 5) return '•••'
  // Length 5 and 6 would let a 4-character head and a 2-character tail cover
  // the whole value, so the tail shrinks until one character stays hidden.
  const tailLength = Math.min(2, value.length - 5)
  const tail = tailLength === 0 ? '' : value.slice(-tailLength)
  return `${value.slice(0, 4)}…${tail}`
}

/** One pattern match on one line, with the offsets overlap detection needs. */
interface LineMatch {
  kind: string
  start: number
  end: number
  text: string
}

/** Return the pattern's flags with the stateful ones removed and `g` ensured. */
function globalFlags(regex: RegExp): string {
  return `${regex.flags.replaceAll('g', '').replaceAll('y', '')}g`
}

/** Apply every pattern to one line. */
function matchLine(line: string, patterns: readonly SecretPattern[]): LineMatch[] {
  const matches: LineMatch[] = []
  for (const pattern of patterns) {
    // A fresh RegExp per line keeps scan output independent of traversal
    // order even when a caller passes one shared `/g` pattern object.
    const regex = new RegExp(pattern.regex.source, globalFlags(pattern.regex))
    for (const match of line.matchAll(regex)) {
      const text = match[0]
      // A caller's zero-width pattern (a bare lookahead) would otherwise turn
      // into an empty finding whose mask says nothing.
      if (text.length === 0) continue
      matches.push({ kind: pattern.id, start: match.index, end: match.index + text.length, text })
    }
  }
  return matches
}

/** Whether two line matches cover any of the same characters. */
function overlaps(left: LineMatch, right: LineMatch): boolean {
  return left.start < right.end && right.start < left.end
}

/**
 * Keep one finding per key: a generic assignment whose span is also covered by
 * a named pattern adds nothing, and two findings for one line would make the
 * report look like two leaks.
 */
function dropSubsumedMatches(matches: LineMatch[]): LineMatch[] {
  return matches.filter(match => match.kind !== GENERIC_SECRET_KIND
    || !matches.some(other => other.kind !== GENERIC_SECRET_KIND && overlaps(match, other)))
}

/** Scan one file's text, line by line, in line order. */
function scanText(relativePath: string, text: string, patterns: readonly SecretPattern[]): SecretFinding[] {
  const findings: SecretFinding[] = []
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue
    for (const match of dropSubsumedMatches(matchLine(line, patterns))) {
      findings.push({
        file: relativePath,
        line: index + 1,
        kind: match.kind,
        masked: maskSecret(match.text),
      })
    }
  }
  return findings
}

/**
 * Whether a file name is an environment file that would ship.
 *
 * The name is the evidence, not the contents: `.env` is a published credential
 * the moment it reaches a provider's output, whatever it currently holds, so
 * its presence is reported even when nothing in it matches a pattern. The
 * `example`/`sample`/`template` fragment exclusion keeps the committed
 * documentation files that exist to be copied.
 */
function isEnvFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (ENV_TEMPLATE_NAME_FRAGMENTS.some(fragment => lower.includes(fragment))) return false
  return lower.startsWith('.env.') || lower.endsWith('.env')
}

/**
 * Read one file as text, or `undefined` when it must be skipped.
 *
 * Skipped files are not counted as scanned: `SecretScanResult.scannedFiles`
 * counts the files whose text was actually searched.
 */
async function readTextFile(absolutePath: string, maxFileBytes: number): Promise<string | undefined> {
  try {
    // Size is checked before reading so a stray multi-gigabyte artifact cannot
    // be pulled into memory by a scan that runs on every deploy.
    const stats = await stat(absolutePath)
    if (stats.size > maxFileBytes) return undefined
    const buffer = await readFile(absolutePath)
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined
    return buffer.toString('utf8')
  } catch {
    // Permissions, a racing delete, a directory that replaced the file: an
    // unreadable file is skipped, never fatal, and never silently "clean" —
    // the caller still sees it missing from `scannedFiles`.
    return undefined
  }
}

/** Collect file paths relative to `root`, sorted, skipping excluded directory names. */
async function collectFiles(
  directory: string,
  root: string,
  skipDirectories: ReadonlySet<string>,
  collected: string[],
  isRoot: boolean,
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    // Anywhere below the root an unreadable directory costs findings, not the
    // deploy. The root itself is different: reporting `clean` for a tree that
    // was never listed would be a false assurance about what is being
    // published, so that failure propagates to the caller.
    if (isRoot) throw new Error(`secret scan root cannot be listed: ${directory}`, { cause: error })
    return
  }
  for (const entry of entries) {
    // Symlinks are skipped rather than resolved: following one could read a
    // file that is not part of the tree being published and report it as if it
    // were, or walk out of the tree entirely.
    if (entry.isSymbolicLink()) continue
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (skipDirectories.has(entry.name)) continue
      await collectFiles(absolutePath, root, skipDirectories, collected, false)
      continue
    }
    // Sockets, FIFOs, and devices are not publishable files, and reading one
    // could block forever.
    if (!entry.isFile()) continue
    collected.push(relative(root, absolutePath))
  }
}

/**
 * Scan a tree for likely secrets. Deterministic: sorted by file, then line.
 * @param root - Directory to scan; normally the build output about to be published.
 * @param options - Extra patterns, skipped directories, and the file-size ceiling.
 * @returns Every finding, with masked values, and whether the tree is clean.
 * @throws When `root` itself cannot be listed, because an unlisted tree has not been scanned.
 */
export async function scanForSecrets(root: string, options: SecretScanOptions = {}): Promise<SecretScanResult> {
  const absoluteRoot = resolve(root)
  const skipDirectories = new Set(options.skipDirectories ?? DEFAULT_SKIP_DIRECTORIES)
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  // Built-ins first so a caller's extra patterns can only add kinds, never
  // shadow a named built-in kind for the same span.
  const patterns: readonly SecretPattern[] = [...BUILT_IN_SECRET_PATTERNS, ...(options.extraPatterns ?? [])]

  const files: string[] = []
  await collectFiles(absoluteRoot, absoluteRoot, skipDirectories, files, true)
  // `readdir` order is filesystem-dependent; sorting is what makes a scan
  // reproducible and its report diffable between deployments.
  files.sort()

  const findings: SecretFinding[] = []
  let scannedFiles = 0
  for (const relativePath of files) {
    const name = basename(relativePath)
    if (isEnvFileName(name)) {
      // The file name is safe to show and is the whole point: the mask here is
      // the name, not a secret extracted from the contents.
      findings.push({ file: relativePath, line: 1, kind: ENV_FILE_KIND, masked: name })
    }
    const text = await readTextFile(join(absoluteRoot, relativePath), maxFileBytes)
    if (text === undefined) continue
    scannedFiles += 1
    findings.push(...scanText(relativePath, text, patterns))
  }

  return { root: absoluteRoot, scannedFiles, findings, clean: findings.length === 0 }
}
