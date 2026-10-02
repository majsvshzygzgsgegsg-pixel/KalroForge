/**
 * Holo Hands (`ctx.holoDeck`): KairoForge's side of the Holo Gestures deck.
 * It owns the persisted scene (items and connectors KairoForge placed), the
 * full-screen open state the browser follows, the latest camera perception the
 * deck reported (derived numbers only, kept in memory, never stored), and the
 * local Holo server it starts from the fixed `python3 server.py` in the Holo
 * checkout. Nothing here runs model-chosen commands.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  checkItemFields, defaultPosition, describePerception, describeScene, HOLO_KINDS, HOLO_LIMITS, HOLO_SHAPES, HOLO_SIGNALS,
  HoloSceneError, normalizeColor, requireKindFields,
  type HoloConnector, type HoloItem, type HoloItemInput, type HoloPerception, type HoloScene,
} from './core/holo-scene.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Holo Hands: the Holo Gestures deck scene, open state, and camera perception. */
    holoDeck: HoloDeck
  }
}

/** Holo deck configuration. */
export interface HoloConfig {
  /** The Holo Gestures checkout (`~` expands). */
  readonly dir: string
  /** Port the Holo server listens on. */
  readonly port: number
  /** Start the server from the checkout when it is not running. */
  readonly autoStart: boolean
}

/** Default configuration. */
export const DEFAULT_HOLO_CONFIG: HoloConfig = { dir: '~/holo', port: 4890, autoStart: true }

/** What the browser needs to show or hide the deck. */
export interface HoloView {
  readonly open: boolean
  readonly revision: number
  readonly url: string
}

/** Where the user moved one item by hand. */
export interface LayoutEntry {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly scale?: number
}

/** Result of opening the deck. */
export interface HoloOpenResult extends HoloView {
  readonly server: 'running' | 'started' | 'missing' | 'failed'
  readonly detail?: string
}

const PERCEPTION_FRESH_MS = 4000
const ACTIVATE_GAP_MS = 8000
const SERVER_WAIT_MS = 8000
const VALUE_CHARS = 300

const itemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(HOLO_KINDS),
  title: z.string().max(HOLO_LIMITS.title),
  text: z.string().max(HOLO_LIMITS.text).optional(),
  color: z.string().optional(),
  shape: z.enum(HOLO_SHAPES).optional(),
  url: z.string().max(HOLO_LIMITS.url).optional(),
  html: z.string().max(HOLO_LIMITS.html).optional(),
  prompt: z.string().max(HOLO_LIMITS.prompt).optional(),
  signal: z.enum(HOLO_SIGNALS).optional(),
  x: z.number(),
  y: z.number(),
  scale: z.number(),
  posRev: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict().transform(value => compact(value) as HoloItem)

const connectorSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().max(HOLO_LIMITS.label).optional(),
  color: z.string().optional(),
  createdAt: z.string().min(1),
}).strict().transform(value => compact(value) as HoloConnector)

interface HoloGlobal {
  readonly revision?: number
  readonly nextId?: number
}

const globalSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  nextId: z.number().int().positive().optional(),
}).strict().transform(value => compact(value) as HoloGlobal)

const EMPTY_GLOBAL: HoloGlobal = {}

/** Holo scene domain: `~/.dsh/storages/holo_scene.json` under the default JSON backend. */
export const holoDomain = defineDomain({
  name: 'holo_scene',
  version: 1,
  tables: {
    items: domainTable<string, HoloItem>(itemSchema),
    connectors: domainTable<string, HoloConnector>(connectorSchema),
  },
  global: { schema: globalSchema, initial: EMPTY_GLOBAL },
})

type HoloDomain = Domain<typeof holoDomain>

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T
}

function rows<V>(table: { entries(): IterableIterator<[string, V]> } | undefined): V[] {
  return table === undefined ? [] : [...table.entries()].map(([, value]) => value)
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function byCreation<T extends { readonly createdAt: string; readonly id: string }>(a: T, b: T): number {
  return a.createdAt === b.createdAt ? a.id.localeCompare(b.id, undefined, { numeric: true }) : a.createdAt.localeCompare(b.createdAt)
}

/** Holo deck service. */
export class HoloDeck extends Service {
  static inject = ['storageDomain']

  private readonly config: HoloConfig
  private readonly ready: Promise<HoloDomain>
  private domain: HoloDomain | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private opened = false
  private latest: { readonly at: number; readonly report: HoloPerception } | undefined
  private lastActivation = 0
  private starting: Promise<HoloOpenResult['server']> | undefined

  /**
   * @param ctx - Host context.
   * @param config - checkout, port, and auto-start.
   */
  constructor(ctx: Context, config: Partial<HoloConfig> = {}) {
    super(ctx, 'holoDeck')
    this.config = { ...DEFAULT_HOLO_CONFIG, ...config }
    this.ready = ctx.storageDomain.open(holoDomain).then((domain) => {
      this.domain = domain
      return domain
    })
    ctx.effect(() => async () => {
      const domain = await this.ready
      await this.chain.catch(() => {})
      await domain.close()
    }, 'holo: domain')
  }

  /** Resolve once storage is open. */
  async whenReady(): Promise<void> {
    await this.ready
  }

  /** The deck page address. */
  url(): string {
    return `http://127.0.0.1:${String(this.config.port)}`
  }

  /** The Holo checkout directory. */
  dir(): string {
    return expandHome(this.config.dir)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => {})
    return next
  }

  private global(): HoloGlobal {
    return this.domain?.global.get() ?? {}
  }

  /** Open/closed state and the scene revision. */
  view(): HoloView {
    return { open: this.opened, revision: this.global().revision ?? 0, url: this.url() }
  }

  /** The current scene. */
  scene(): HoloScene {
    const items = rows(this.domain?.table('items')).toSorted(byCreation)
    const connectors = rows(this.domain?.table('connectors')).toSorted(byCreation)
    return { revision: this.global().revision ?? 0, items, connectors }
  }

  private item(id: string): HoloItem {
    const found = this.domain?.table('items').get(id)
    if (found === undefined) throw new HoloSceneError(`no Holo item "${id}"; holo_status lists the items`)
    return found
  }

  /** Title of one item, if it exists. */
  titleOf(id: string): string | undefined {
    return this.domain?.table('items').get(id)?.title
  }

  private async bump(domain: HoloDomain, ids = 0): Promise<{ revision: number; firstId: number }> {
    const current = domain.global.get()
    const firstId = current.nextId ?? 1
    const revision = (current.revision ?? 0) + 1
    await domain.global.set({ ...current, revision, nextId: firstId + ids })
    return { revision, firstId }
  }

  /**
   * Open the deck full screen, starting the Holo server first when needed.
   * @returns open state and server status.
   */
  async open(): Promise<HoloOpenResult> {
    const server = await this.ensureServer()
    const ok = server === 'running' || server === 'started'
    if (ok) this.opened = true
    const detail = server === 'missing'
      ? `No Holo checkout with server.py and holo.html at ${this.dir()}.`
      : server === 'failed' ? `The Holo server did not answer on ${this.url()}; see ${join(this.dir(), 'state', 'server.log')}.` : undefined
    return { ...this.view(), server, ...detail === undefined ? {} : { detail } }
  }

  /** Close the full-screen deck. */
  close(): HoloView {
    this.opened = false
    return this.view()
  }

  private async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url()}/api/props`, { signal: AbortSignal.timeout(1200) })
      return res.ok
    } catch {
      // Connection refused or timed out: the server is not running.
      return false
    }
  }

  private async ensureServer(): Promise<HoloOpenResult['server']> {
    if (await this.probe()) return 'running'
    const dir = this.dir()
    if (!existsSync(join(dir, 'server.py')) || !existsSync(join(dir, 'holo.html'))) return 'missing'
    if (!this.config.autoStart) return 'failed'
    this.starting ??= this.start(dir).finally(() => { this.starting = undefined })
    return this.starting
  }

  private async start(dir: string): Promise<HoloOpenResult['server']> {
    mkdirSync(join(dir, 'state'), { recursive: true })
    const log = openSync(join(dir, 'state', 'server.log'), 'a')
    try {
      const child = spawn('python3', ['server.py'], {
        cwd: dir,
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, HOLO_PORT: String(this.config.port) },
      })
      child.on('error', (error) => { this.ctx.logger.warn(`holo: server failed to start: ${error.message}`) })
      child.unref()
    } finally {
      closeSync(log)
    }
    const deadline = Date.now() + SERVER_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 300) })
      if (await this.probe()) return 'started'
    }
    return 'failed'
  }

  /**
   * Add one item.
   * @param input - kind, title, and kind-specific fields.
   * @returns the stored item.
   */
  async add(input: HoloItemInput & { readonly kind: HoloItem['kind'] }): Promise<HoloItem> {
    const domain = await this.ready
    return this.serialize(async () => {
      const table = domain.table('items')
      if (table.size >= HOLO_LIMITS.items) throw new HoloSceneError(`the deck already holds ${String(HOLO_LIMITS.items)} items; remove some first`)
      const fields = checkItemFields(input.kind, input)
      const { firstId } = await this.bump(domain, 1)
      const spot = defaultPosition(table.size)
      const now = new Date().toISOString()
      const item: HoloItem = compact({
        ...fields,
        id: `h${String(firstId)}`,
        kind: input.kind,
        title: fields.title ?? input.kind,
        x: fields.x ?? spot.x,
        y: fields.y ?? spot.y,
        scale: fields.scale ?? 1,
        posRev: 1,
        createdAt: now,
        updatedAt: now,
      })
      requireKindFields(item)
      await table.put(item.id, item)
      return item
    })
  }

  /**
   * Change fields of one item. Setting x/y moves it on the deck.
   * @param id - item id.
   * @param input - fields to change; an empty string clears an optional field.
   * @returns the updated item.
   */
  async update(id: string, input: HoloItemInput): Promise<HoloItem> {
    const domain = await this.ready
    return this.serialize(async () => {
      const current = this.item(id)
      const kind = input.kind ?? current.kind
      const cleared = Object.entries(input).filter(([, value]) => value === '').map(([key]) => key)
      const given = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== '')) as HoloItemInput
      const fields = checkItemFields(kind, given)
      const moved = fields.x !== undefined || fields.y !== undefined
      const posRev = moved ? current.posRev + 1 : current.posRev
      const next: Record<string, unknown> = { ...current, ...fields, kind, posRev, updatedAt: new Date().toISOString() }
      for (const key of cleared) if (key !== 'title' && key !== 'kind') Reflect.deleteProperty(next, key)
      const item = next as unknown as HoloItem
      requireKindFields(item)
      await this.bump(domain)
      await domain.table('items').put(id, item)
      return item
    })
  }

  /**
   * Remove items and their connectors.
   * @param ids - item ids, or "all".
   * @returns removed ids.
   */
  async remove(ids: readonly string[] | 'all'): Promise<string[]> {
    const domain = await this.ready
    return this.serialize(async () => {
      const items = domain.table('items')
      const targets = ids === 'all' ? [...items.keys()] : ids
      for (const id of targets) this.item(id)
      const gone = new Set(targets)
      for (const link of rows(domain.table('connectors'))) {
        if (gone.has(link.from) || gone.has(link.to)) await domain.table('connectors').delete(link.id)
      }
      for (const id of targets) await items.delete(id)
      await this.bump(domain)
      return [...gone]
    })
  }

  /**
   * Connect two items: values emitted by `from` reach `to`.
   * @param from - source item id.
   * @param to - target item id.
   * @param options - label and colour.
   * @returns the connector.
   */
  async connect(from: string, to: string, options: { readonly label?: string; readonly color?: string } = {}): Promise<HoloConnector> {
    const domain = await this.ready
    return this.serialize(async () => {
      this.item(from)
      this.item(to)
      if (from === to) throw new HoloSceneError('an item cannot connect to itself')
      const table = domain.table('connectors')
      const existing = rows(table).find(link => link.from === from && link.to === to)
      if (existing !== undefined) return existing
      if (table.size >= HOLO_LIMITS.connectors) throw new HoloSceneError(`the deck already has ${String(HOLO_LIMITS.connectors)} connectors`)
      const label = options.label?.trim()
      if (label !== undefined && label.length > HOLO_LIMITS.label) throw new HoloSceneError(`label is longer than ${String(HOLO_LIMITS.label)} characters`)
      const { firstId } = await this.bump(domain, 1)
      const link: HoloConnector = {
        id: `c${String(firstId)}`,
        from,
        to,
        ...label === undefined || label === '' ? {} : { label },
        ...options.color === undefined ? {} : { color: normalizeColor(options.color) },
        createdAt: new Date().toISOString(),
      }
      await table.put(link.id, link)
      return link
    })
  }

  /**
   * Remove connectors by id, or every connector between two items.
   * @param target - connector id, or the two item ids.
   * @returns removed connector ids.
   */
  async disconnect(target: { readonly id: string } | { readonly from: string; readonly to: string }): Promise<string[]> {
    const domain = await this.ready
    return this.serialize(async () => {
      const table = domain.table('connectors')
      const matches = 'id' in target
        ? [table.get(target.id)].filter(link => link !== undefined)
        : rows(table).filter(link => (link.from === target.from && link.to === target.to)
          || (link.from === target.to && link.to === target.from))
      if (matches.length === 0) throw new HoloSceneError('no matching connector')
      for (const link of matches) await table.delete(link.id)
      await this.bump(domain)
      return matches.map(link => link.id)
    })
  }

  /**
   * Record where the user moved items by hand. Does not bump the revision.
   * @param entries - id with new position and scale.
   */
  async layout(entries: readonly LayoutEntry[]): Promise<void> {
    const domain = await this.ready
    await this.serialize(async () => {
      const table = domain.table('items')
      for (const entry of entries) {
        const current = table.get(entry.id)
        if (current === undefined) continue
        const fields = checkItemFields(current.kind, { x: entry.x, y: entry.y, ...entry.scale === undefined ? {} : { scale: entry.scale } })
        await table.put(entry.id, { ...current, ...fields })
      }
    })
  }

  /**
   * Keep the latest perception report (memory only).
   * @param report - derived tracking data.
   */
  perceive(report: HoloPerception): void {
    this.latest = { at: Date.now(), report }
  }

  /** The latest perception when it is fresh. */
  perception(): HoloPerception | undefined {
    if (this.latest === undefined || Date.now() - this.latest.at > PERCEPTION_FRESH_MS) return undefined
    return this.latest.report
  }

  /** One sentence about what the camera sees, or why it cannot say. */
  seeing(): string {
    if (!this.opened) return 'Holo Hands is closed, so the camera is off.'
    const report = this.perception()
    if (report === undefined) return 'Holo Hands is open but has not reported tracking in the last few seconds (camera starting, blocked, or the page is hidden).'
    return describePerception(report, id => this.titleOf(id))
  }

  /**
   * The user pinched or clicked an action item. Returns the prompt to send to
   * KairoForge when the item has one and the rate limit allows it.
   * @param id - item id.
   * @param value - value that reached the item through a connector.
   * @returns the prompt, or undefined when there is nothing to send.
   */
  activation(id: string, value?: string): string | undefined {
    const item = this.item(id)
    if (item.kind !== 'action' || item.prompt === undefined) return undefined
    const now = Date.now()
    if (now - this.lastActivation < ACTIVATE_GAP_MS) throw new HoloSceneError('another Holo action was sent moments ago; wait a few seconds')
    this.lastActivation = now
    const given = (value ?? '').slice(0, VALUE_CHARS)
    return item.prompt.includes('{value}') ? item.prompt.replaceAll('{value}', given) : item.prompt
  }

  /** Runtime context line for the coordinator while the deck is open. */
  contextLine(): string {
    if (!this.opened) return ''
    return [
      `Holo Hands is open full screen in KairoForge: ${describeScene(this.scene())}.`,
      `Camera: ${this.seeing()}`,
      `Use the holo_* tools to add, change, connect, or remove things; "this"/"that" usually means the item a hand is holding or over. The Holo app source is ${this.dir()} (holo.html, server.py) for code-level upgrades through your normal file tools.`,
    ].join('\n')
  }
}
