/**
 * Workspace index behind the repo map and the "did you mean" path hints. It
 * lists files the way git does (respecting .gitignore), extracts top-level
 * symbols, and refreshes in the background so prompt assembly never waits.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { extractSymbols, SOURCE_EXTENSIONS, type RepoFile } from '../core/repomap.ts'
import { isSecretPath } from '../core/risk.ts'

const MAX_FILES = 8000
const MAX_FILE_BYTES = 256 * 1024
const STALE_MS = 2 * 60_000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'lib', 'out', 'coverage', '.next', '.turbo', '.cache', 'vendor', 'target', '__pycache__', '.venv', 'venv'])
/** Committed files under these are generated or third-party even in a git checkout. */
const GIT_SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', '.yarn'])

function gitFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? stdout.split('\n').filter(line => line !== '') : undefined)
    })
  })
}

async function walk(root: string, dir = '', out: string[] = []): Promise<string[]> {
  if (out.length >= MAX_FILES * 2) return out
  const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, path, out)
    } else if (entry.isFile()) {
      out.push(path)
    }
  }
  return out
}

/** Index of one workspace root. */
export class RepoIndex {
  private files = new Map<string, RepoFile>()
  private paths: string[] = []
  private builtAt = 0
  private building: Promise<void> | undefined

  /**
   * @param root - absolute workspace root.
   */
  constructor(readonly root: string) {}

  /** Indexed source files (possibly from the previous refresh). */
  entries(): RepoFile[] {
    return [...this.files.values()]
  }

  /** Every listed file path, source or not (for path suggestions). */
  allPaths(): readonly string[] {
    return this.paths
  }

  /** Whether an index exists yet. */
  get ready(): boolean {
    return this.builtAt > 0
  }

  /**
   * Start a refresh when the index is older than two minutes. Never waits.
   * @returns the running refresh, for callers that do want to wait.
   */
  refreshIfStale(): Promise<void> {
    if (this.building !== undefined) return this.building
    if (Date.now() - this.builtAt < STALE_MS) return Promise.resolve()
    this.building = this.build().finally(() => { this.building = undefined })
    return this.building
  }

  private async build(): Promise<void> {
    const tracked = await gitFiles(this.root)
    const listed = tracked?.filter(path => !path.split('/').some(part => GIT_SKIP_DIRS.has(part))) ?? (await walk(this.root))
    const paths = listed.slice(0, MAX_FILES * 2)
    const next = new Map<string, RepoFile>()
    let processed = 0
    for (const path of paths) {
      if (next.size >= MAX_FILES) break
      const extension = extname(path).slice(1).toLowerCase()
      if (!SOURCE_EXTENSIONS.has(extension) || isSecretPath(path) || /\.min\.|\.lock$|lock\.json$/.test(path)) continue
      const info = await stat(join(this.root, path)).catch(() => undefined)
      if (info?.isFile() !== true || info.size > MAX_FILE_BYTES) continue
      const previous = this.files.get(path)
      if (previous !== undefined && previous.mtime === info.mtimeMs) {
        next.set(path, previous)
        continue
      }
      const text = await readFile(join(this.root, path), 'utf8').catch(() => '')
      next.set(path, { path, symbols: extractSymbols(path, text), mtime: info.mtimeMs })
      if (++processed % 50 === 0) await new Promise(resolve => setImmediate(resolve))
    }
    this.files = next
    this.paths = paths
    this.builtAt = Date.now()
  }
}
