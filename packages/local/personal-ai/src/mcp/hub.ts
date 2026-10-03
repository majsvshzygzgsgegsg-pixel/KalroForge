/**
 * MCP Hub: the MCP servers KairoForge connects to on its own. Entries live in
 * `~/.kairoforge/mcp.json` (mode 0600); servers KairoForge writes live in
 * `~/.kairoforge/mcp/<name>/server.mjs`. Each enabled server is one
 * `@deepseek-ai/dsh-mcp-client` instance on the host context, so its tools
 * (`mcp__<name>__<tool>`) reach every Session from the next step.
 */
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-tools'
import {
  clientConfig, createdServerProblems, createdServerSource, maskedEntry, MCP_SERVER_NAME, parseMcpJson,
  type CreatedServer, type McpServerEntry,
} from '../core/mcp-servers.ts'
import { KAIROFORGE_HOME } from '../native.ts'

const CONNECT_TIMEOUT_MS = 45_000

/** Connection state of one server. */
export interface McpServerStatus {
  readonly state: 'connected' | 'failed' | 'off'
  readonly tools: readonly string[]
  readonly error?: string
}

/** A server as the model and the Command Center see it. */
export type McpServerView = Record<string, unknown> & McpServerStatus

interface Fiber extends PromiseLike<unknown> {
  dispose(): Promise<unknown>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withTimeout(work: PromiseLike<unknown>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve(work),
      new Promise((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(`${what} did not connect within ${String(ms / 1000)}s`)) }, ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Owns the saved MCP servers and their live connections. */
export class McpHub {
  private entries: McpServerEntry[] = []
  private readonly live = new Map<string, Fiber>()
  private readonly status = new Map<string, McpServerStatus>()
  private loaded: Promise<void> | undefined

  /**
   * @param ctx - host context with the tool registry.
   * @param home - KairoForge home; `mcp.json` and created servers live here.
   * @param cursorFile - Cursor's MCP settings, read at connect time for imported servers.
   */
  constructor(
    private readonly ctx: Context,
    readonly home: string = KAIROFORGE_HOME,
    readonly cursorFile: string = join(homedir(), '.cursor', 'mcp.json'),
  ) {}

  private get file(): string {
    return join(this.home, 'mcp.json')
  }

  /** Load saved servers and connect the enabled ones. */
  start(): Promise<void> {
    this.loaded ??= (async () => {
      this.entries = await this.load()
      await Promise.all(this.entries.filter(entry => entry.enabled).map(entry => this.connect(entry)))
    })()
    return this.loaded
  }

  private async load(): Promise<McpServerEntry[]> {
    if (!existsSync(this.file)) return []
    try {
      const json = JSON.parse(await readFile(this.file, 'utf8')) as { servers?: unknown }
      return Array.isArray(json.servers) ? json.servers.filter(isEntry) : []
    } catch {
      return []
    }
  }

  private async save(): Promise<void> {
    await mkdir(this.home, { recursive: true })
    await writeFile(this.file, `${JSON.stringify({ servers: this.entries }, null, 2)}\n`, { mode: 0o600 })
    await chmod(this.file, 0o600)
  }

  private async resolve(entry: McpServerEntry): Promise<McpServerEntry> {
    if (entry.source !== 'cursor') return entry
    const found = parseMcpJson(JSON.parse(await readFile(this.cursorFile, 'utf8')) as unknown, 'cursor').find(item => item.name === entry.name)
    if (found === undefined) throw new Error(`Cursor's mcp.json no longer has a server named ${entry.name}`)
    return { ...found, enabled: entry.enabled }
  }

  private toolsOf(name: string): string[] {
    const prefix = `mcp__${name}__`
    return this.ctx.tools.schemas().map(schema => schema.name).filter(tool => tool.startsWith(prefix))
  }

  private async connect(entry: McpServerEntry): Promise<McpServerStatus> {
    await this.disconnect(entry.name)
    let status: McpServerStatus
    try {
      const fiber = this.ctx.plugin(McpClient, clientConfig(await this.resolve(entry))) as unknown as Fiber
      this.live.set(entry.name, fiber)
      await withTimeout(fiber, CONNECT_TIMEOUT_MS, entry.name)
      status = { state: 'connected', tools: this.toolsOf(entry.name) }
    } catch (error) {
      await this.disconnect(entry.name)
      status = { state: 'failed', tools: [], error: message(error).slice(0, 500) }
    }
    this.status.set(entry.name, status)
    return status
  }

  private async disconnect(name: string): Promise<void> {
    const fiber = this.live.get(name)
    this.live.delete(name)
    this.status.set(name, { state: 'off', tools: [] })
    await fiber?.dispose().catch(() => undefined)
  }

  private view(entry: McpServerEntry): McpServerView {
    return { ...maskedEntry(entry), ...this.status.get(entry.name) ?? { state: 'off', tools: [] } }
  }

  /** Every saved server with its state and tools; env and header values are masked. */
  async list(): Promise<McpServerView[]> {
    await this.start()
    return this.entries.map(entry => this.view(entry))
  }

  /**
   * Save a server (replacing one with the same name) and connect it when enabled.
   * @param entry - server to save.
   * @returns the saved server's view.
   */
  async add(entry: McpServerEntry): Promise<McpServerView> {
    await this.start()
    if (!MCP_SERVER_NAME.test(entry.name)) throw new Error(`server name "${entry.name}" must be 1-32 lowercase letters, digits, _ or -`)
    if (entry.source !== 'cursor' && entry.transport === 'stdio' && (entry.command ?? '') === '') throw new Error('a stdio server needs a command')
    if (entry.source !== 'cursor' && entry.transport === 'streamable-http' && !/^https?:\/\//.test(entry.url ?? '')) throw new Error('an HTTP server needs an http(s) URL')
    this.entries = [...this.entries.filter(item => item.name !== entry.name), entry]
    await this.save()
    if (entry.enabled) await this.connect(entry)
    else await this.disconnect(entry.name)
    return this.view(entry)
  }

  /**
   * Turn a saved server on or off, or reconnect it.
   * @param name - server name.
   * @param enabled - new state; omit to reconnect.
   * @returns the server's view.
   */
  async set(name: string, enabled?: boolean): Promise<McpServerView> {
    await this.start()
    const entry = this.entries.find(item => item.name === name)
    if (entry === undefined) throw new Error(`no MCP server named ${name}`)
    const next = enabled === undefined ? entry : { ...entry, enabled }
    this.entries = this.entries.map(item => item.name === name ? next : item)
    await this.save()
    if (next.enabled) await this.connect(next)
    else await this.disconnect(name)
    return this.view(next)
  }

  /**
   * Disconnect and forget a server; a server KairoForge wrote is deleted too.
   * @param name - server name.
   * @returns whether a server was removed.
   */
  async remove(name: string): Promise<boolean> {
    await this.start()
    const entry = this.entries.find(item => item.name === name)
    if (entry === undefined) return false
    await this.disconnect(name)
    this.status.delete(name)
    this.entries = this.entries.filter(item => item.name !== name)
    await this.save()
    if (entry.source === 'created') await rm(join(this.home, 'mcp', name), { recursive: true, force: true })
    return true
  }

  /**
   * Connect the servers set up in Cursor. Only names are saved; settings and secrets stay in Cursor's file.
   * @returns views of the newly imported servers.
   */
  async importCursor(): Promise<McpServerView[]> {
    await this.start()
    if (!existsSync(this.cursorFile)) throw new Error(`Cursor has no MCP settings at ${this.cursorFile}`)
    const found = parseMcpJson(JSON.parse(await readFile(this.cursorFile, 'utf8')) as unknown, 'cursor')
    const fresh = found.filter(item => !this.entries.some(entry => entry.name === item.name))
    const out: McpServerView[] = []
    for (const item of fresh) {
      out.push(await this.add({ name: item.name, transport: item.transport, enabled: item.enabled, source: 'cursor' }))
    }
    return out
  }

  /**
   * Write a dependency-free MCP server and connect it.
   * @param spec - server name, purpose, and tools with JavaScript bodies.
   * @returns the connected server's view.
   */
  async create(spec: CreatedServer): Promise<McpServerView> {
    const problems = createdServerProblems(spec, (code) => { new Script(`(async function (args, lib) {\n${code}\n})`) })
    if (problems.length > 0) throw new Error(problems.join('; '))
    const dir = join(this.home, 'mcp', spec.name)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'server.mjs')
    await writeFile(file, createdServerSource(spec), { mode: 0o700 })
    return this.add({
      name: spec.name, transport: 'stdio', command: process.execPath, args: [file], enabled: true, source: 'created', description: spec.description,
    })
  }

  /** Disconnect everything. */
  async dispose(): Promise<void> {
    await Promise.all([...this.live.keys()].map(name => this.disconnect(name)))
  }
}

function isEntry(value: unknown): value is McpServerEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<McpServerEntry>
  return typeof entry.name === 'string' && MCP_SERVER_NAME.test(entry.name)
    && (entry.transport === 'stdio' || entry.transport === 'streamable-http')
    && typeof entry.enabled === 'boolean'
    && (entry.source === 'added' || entry.source === 'cursor' || entry.source === 'created')
}
