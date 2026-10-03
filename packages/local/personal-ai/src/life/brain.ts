/**
 * The brain: a local, encrypted index of the folders the user chose (notes,
 * documents, PDFs, code) plus the knowledge graph. Files are watched through
 * FSEvents (`fs.watch` recursive) and re-indexed when they change. Credential
 * files, env files, and files whose content looks like a secret are never
 * indexed. Everything is stored sealed by the Vault.
 */
import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { KnowledgeGraph, type GraphData, type GraphFact, type LinkOptions } from '../core/graph.ts'
import { isSecretPath } from '../core/risk.ts'
import { findSensitive } from '../core/sensitive.ts'
import { VectorIndex, type SerializedIndex, type VectorHit } from '../core/vectors.ts'
import type { NativeHelper } from '../native.ts'
import type { Vault } from '../vault.ts'

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.org', '.rst', '.tex', '.csv', '.log',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.swift', '.rs', '.go', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.m', '.mm', '.rb', '.php', '.cs', '.scala', '.lua', '.dart', '.vue', '.svelte', '.sh', '.zsh', '.fish', '.sql', '.graphql',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.xml', '.html', '.htm', '.css', '.scss', '.less',
])
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'lib', 'out', 'target', '.next', '.nuxt', '.cache', '.turbo', 'coverage',
  'vendor', 'Pods', 'DerivedData', '.venv', 'venv', '__pycache__', '.Trash', 'Library', '.kairoforge', '.dsh', 'chat vault',
])
const SECRET_NAME = new RegExp(String.raw`(?:secret|credential|password|passwd|token|private[_-]?key|id_rsa|id_ed25519|`
  + String.raw`\.pem$|\.key$|\.p12$|\.pfx$|\.keystore$|\.kdbx$)`, 'i')
const MAX_TEXT_BYTES = 1_500_000
const MAX_PDF_BYTES = 40_000_000
const MAX_FILES_PER_ROOT = 25_000
const SAVE_DELAY_MS = 4000
const CHANGE_DELAY_MS = 1500

/** What the Command Center shows about the brain. */
export interface BrainStatus {
  readonly roots: readonly string[]
  readonly documents: number
  readonly chunks: number
  readonly indexing: boolean
  readonly progress?: { readonly root: string; readonly seen: number }
  readonly lastIndexedAt?: string
  readonly skippedSensitive: number
  readonly graph: { readonly entities: number; readonly relations: number }
  readonly watching: number
  readonly error?: string
}

/**
 * Expand `~` and resolve a folder path.
 * @param path - user-entered path.
 * @returns absolute path.
 */
export function expandPath(path: string): string {
  const trimmed = path.trim()
  return resolve(trimmed === '~' ? homedir() : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed)
}

function indexable(path: string): 'text' | 'pdf' | undefined {
  if (isSecretPath(path) || SECRET_NAME.test(path.split(sep).at(-1) ?? '')) return undefined
  const extension = extname(path).toLowerCase()
  if (extension === '.pdf') return 'pdf'
  return TEXT_EXTENSIONS.has(extension) ? 'text' : undefined
}

function skippedDir(name: string): boolean {
  return SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.github')
}

/** Local brain: vector index and knowledge graph. */
export class Brain {
  private index = new VectorIndex()
  private graph = new KnowledgeGraph()
  private roots: string[] = []
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly changed = new Set<string>()
  private changeTimer: ReturnType<typeof setTimeout> | undefined
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private indexing: { root: string; seen: number } | undefined
  private queue: Promise<void> = Promise.resolve()
  private lastIndexedAt: string | undefined
  /** Files skipped for secret-looking content, by path, at the modification time they were checked. */
  private readonly skipped = new Map<string, number>()
  private error: string | undefined
  private loaded: Promise<void> | undefined
  private disposed = false

  /**
   * @param vault - encrypted storage.
   * @param native - native helper (PDF text).
   * @param warn - logs a warning.
   */
  constructor(private readonly vault: Vault, private readonly native: NativeHelper, private readonly warn: (text: string) => void) {}

  /** Load the sealed index and graph once. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.index = VectorIndex.from(await this.vault.get<SerializedIndex>('brain-index'))
        this.graph = new KnowledgeGraph(await this.vault.get<GraphData>('brain-graph'))
      } catch (error) {
        this.error = `could not open the brain: ${error instanceof Error ? error.message : String(error)}`
        this.warn(this.error)
      }
    })()
    return this.loaded
  }

  /**
   * Set the indexed folders: new ones are indexed and watched, removed ones are dropped from the index.
   * @param roots - absolute folder paths.
   */
  async setRoots(roots: readonly string[]): Promise<void> {
    await this.load()
    const next = [...new Set(roots.map(expandPath))]
    const removed = this.roots.filter(root => !next.includes(root))
    this.roots = next
    for (const root of removed) {
      this.watchers.get(root)?.close()
      this.watchers.delete(root)
      for (const doc of this.index.documents()) if (doc === root || doc.startsWith(`${root}${sep}`)) this.index.remove(doc)
    }
    if (removed.length > 0) this.scheduleSave()
    for (const root of next) {
      if (!this.watchers.has(root)) this.watchRoot(root)
      this.enqueue(() => this.scan(root))
    }
  }

  /**
   * Re-scan every root now.
   * @returns once queued scans finish.
   */
  reindex(): Promise<void> {
    for (const root of this.roots) this.enqueue(() => this.scan(root))
    return this.queue
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.error = error instanceof Error ? error.message : String(error)
      this.warn(`brain: ${this.error}`)
    })
  }

  private watchRoot(root: string): void {
    try {
      const watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => {
        if (name === null) return
        const path = join(root, name)
        if (path.split(sep).some(part => skippedDir(part))) return
        this.changed.add(path)
        clearTimeout(this.changeTimer)
        this.changeTimer = setTimeout(() => { this.enqueue(() => this.flushChanges()) }, CHANGE_DELAY_MS)
      })
      watcher.on('error', () => { this.watchers.delete(root) })
      this.watchers.set(root, watcher)
    } catch (error) {
      this.warn(`brain: cannot watch ${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async flushChanges(): Promise<void> {
    const paths = [...this.changed]
    this.changed.clear()
    let dirty = false
    for (const path of paths) {
      const info = await stat(path).catch(() => undefined)
      if (info === undefined || !info.isFile()) {
        if (this.index.has(path)) {
          this.index.remove(path)
          dirty = true
        }
        continue
      }
      if (await this.indexFile(path, info.mtimeMs, info.size)) dirty = true
    }
    if (dirty) this.scheduleSave()
  }

  private async scan(root: string): Promise<void> {
    if (this.disposed) return
    const info = await stat(root).catch(() => undefined)
    if (info?.isDirectory() !== true) {
      this.error = `${root} is not a folder`
      return
    }
    this.indexing = { root, seen: 0 }
    const present = new Set<string>()
    const stack = [root]
    let dirty = false
    try {
      while (stack.length > 0 && present.size < MAX_FILES_PER_ROOT) {
        const dir = stack.pop() ?? root
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!skippedDir(entry.name)) stack.push(path)
            continue
          }
          if (!entry.isFile() || indexable(path) === undefined) continue
          present.add(path)
          const file = await stat(path).catch(() => undefined)
          if (file === undefined || this.index.isCurrent(path, file.mtimeMs, file.size) || this.skipped.get(path) === file.mtimeMs) continue
          if (await this.indexFile(path, file.mtimeMs, file.size)) dirty = true
          this.indexing.seen++
          // Yield so a big first scan never stalls the server.
          if (this.indexing.seen % 25 === 0) await new Promise(resolve => setImmediate(resolve))
        }
      }
      for (const doc of this.index.documents()) {
        if (doc.startsWith(`${root}${sep}`) && !present.has(doc)) {
          this.index.remove(doc)
          dirty = true
        }
      }
      this.lastIndexedAt = new Date().toISOString()
    } finally {
      this.indexing = undefined
    }
    if (dirty) this.scheduleSave()
  }

  private async indexFile(path: string, mtime: number, size: number): Promise<boolean> {
    const kind = indexable(path)
    if (kind === undefined || !this.roots.some(root => path.startsWith(`${root}${sep}`))) return false
    let text: string
    try {
      if (kind === 'pdf') {
        if (size > MAX_PDF_BYTES || !this.native.supported()) return false
        text = (await this.native.call<{ text: string }>(['pdf-text', path])).text
      } else {
        if (size > MAX_TEXT_BYTES) return false
        text = await readFile(path, 'utf8')
        if (text.includes('\u0000')) return false
      }
    } catch {
      return false
    }
    if (findSensitive(text).sensitive) {
      this.skipped.set(path, mtime)
      const wasIndexed = this.index.has(path)
      this.index.remove(path)
      return wasIndexed
    }
    this.skipped.delete(path)
    if (text.trim() === '') return false
    this.index.upsert(path, text, { mtime, size })
    return true
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { void this.save() }, SAVE_DELAY_MS)
  }

  private async save(): Promise<void> {
    try {
      await this.vault.put('brain-index', this.index.serialize())
    } catch (error) {
      this.warn(`brain: index not saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async saveGraph(): Promise<void> {
    await this.vault.put('brain-graph', this.graph.toJSON())
  }

  /**
   * Search the indexed files.
   * @param query - question or keywords.
   * @param limit - maximum hits.
   * @returns best chunks, one per file.
   */
  async search(query: string, limit = 6): Promise<VectorHit[]> {
    await this.load()
    return this.index.search(query, limit)
  }

  /**
   * Link two entities in the knowledge graph.
   * @param from - subject.
   * @param relation - relation.
   * @param to - object.
   * @param options - kinds and note.
   * @returns the stored fact.
   */
  async link(from: string, relation: string, to: string, options: LinkOptions = {}): Promise<string> {
    await this.load()
    for (const text of [from, relation, to, options.note ?? '']) {
      const finding = findSensitive(text)
      if (finding.sensitive) throw new Error(`not linked: ${finding.reason ?? 'that looks sensitive'}. Secrets never enter the knowledge graph.`)
    }
    const stored = this.graph.link(from, relation, to, options)
    await this.saveGraph()
    return `${from.trim()} ${stored.relation} ${to.trim()}`
  }

  /**
   * Remove links.
   * @param from - subject.
   * @param to - object.
   * @param relation - optional relation.
   * @returns removed count.
   */
  async unlink(from: string, to: string, relation?: string): Promise<number> {
    await this.load()
    const removed = this.graph.unlink(from, to, relation)
    if (removed > 0) await this.saveGraph()
    return removed
  }

  /**
   * Facts about an entity.
   * @param name - entity name.
   * @returns sentences.
   */
  async about(name: string): Promise<string[]> {
    await this.load()
    return this.graph.about(name)
  }

  /**
   * Every fact, newest first.
   * @param limit - maximum facts.
   * @returns facts.
   */
  facts(limit = 200): GraphFact[] {
    return this.graph.facts(limit)
  }

  /**
   * Entity names holding a role.
   * @param roles - roles like "boss".
   * @returns names.
   */
  holdersOf(roles: readonly string[]): string[] {
    return this.graph.holdersOf(roles)
  }

  /**
   * Prompt context for one request: graph facts about named entities and the best file matches.
   * @param request - the user's message.
   * @returns context lines (empty when nothing relevant).
   */
  contextFor(request: string): string[] {
    if (request.trim().length < 3) return []
    const lines: string[] = []
    const facts = new Set<string>()
    for (const entity of this.graph.mentioned(request).slice(0, 4)) for (const fact of this.graph.about(entity.name, 1)) facts.add(fact)
    if (facts.size > 0) lines.push('Knowledge graph (facts the user linked):', ...[...facts].slice(0, 10).map(fact => `- ${fact}`))
    if (request.trim().split(/\s+/).length >= 4 && this.index.chunkCount > 0) {
      const hits = this.index.search(request, 3).filter(hit => hit.score >= 0.32)
      if (hits.length > 0) {
        lines.push('From the user\'s indexed files (local brain; use search_brain for more):')
        for (const hit of hits) lines.push(`- ${hit.doc}: ${hit.snippet.replace(/\s+/g, ' ').slice(0, 280)}`)
      }
    }
    return lines
  }

  /** Brain status. */
  status(): BrainStatus {
    return {
      roots: this.roots,
      documents: this.index.documentCount,
      chunks: this.index.chunkCount,
      indexing: this.indexing !== undefined,
      ...this.indexing === undefined ? {} : { progress: { ...this.indexing } },
      ...this.lastIndexedAt === undefined ? {} : { lastIndexedAt: this.lastIndexedAt },
      skippedSensitive: this.skipped.size,
      graph: this.graph.size(),
      watching: this.watchers.size,
      ...this.error === undefined ? {} : { error: this.error },
    }
  }

  /** Stop watching and flush the index. */
  async dispose(): Promise<void> {
    this.disposed = true
    clearTimeout(this.changeTimer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      await this.save()
    }
  }
}
