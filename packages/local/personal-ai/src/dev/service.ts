/**
 * DevKit: what makes KairoForge work like an in-editor coding agent.
 * - Editor bridge: the VS Code / Cursor extension reports the active file,
 *   cursor, selection, nearby code, tabs, and problems, and can ask
 *   KairoForge from the editor (an ordinary session: permissions and
 *   approvals apply).
 * - Repo map: ranked files and symbols for each request.
 * - Reliability counters for the agent-loop hooks (path hints, syntax
 *   checks, loop stops).
 * - Provider warm-up: opens the model connection while the user is still
 *   typing, so the first token is not waiting on DNS + TLS.
 */
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { textOf } from '@local/main-agents'
import { isLoopbackUrl } from '../core/autonomy.ts'
import { editorContextText, sanitizeSnapshot, type EditorSnapshot } from '../core/editor.ts'
import { isSecretPath } from '../core/risk.ts'
import { LoopBreaker, suggestPaths } from '../core/reliability.ts'
import { rankFiles, renderRepoMap } from '../core/repomap.ts'
import type {} from '../life/service.ts'
import { KAIROFORGE_HOME } from '../native.ts'
import { PersonalAiError } from '../types.ts'
import { EXTENSION_ID, EXTENSION_MANIFEST, EXTENSION_SOURCE, EXTENSION_VERSION } from './extension-source.ts'
import { RepoIndex } from './repo-index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DevKit: editor bridge, repo map, agent-loop reliability, provider warm-up. */
    devKit: DevKit
  }
}

/** Editors KairoForge can install its extension into. */
export const EDITORS = ['cursor', 'vscode'] as const
/** One supported editor. */
export type EditorKind = typeof EDITORS[number]
/** The editor KairoForge opens files in and codes alongside. */
export const PREFERRED_EDITOR: EditorKind = 'cursor'

const APP_DIRS = ['/Applications', join(homedir(), 'Applications')]
const EDITOR_CLI: Readonly<Record<EditorKind, readonly string[]>> = {
  cursor: [...APP_DIRS.map(dir => join(dir, 'Cursor.app/Contents/Resources/app/bin/cursor')), '/usr/local/bin/cursor', '/opt/homebrew/bin/cursor'],
  vscode: [...APP_DIRS.map(dir => join(dir, 'Visual Studio Code.app/Contents/Resources/app/bin/code')), '/usr/local/bin/code', '/opt/homebrew/bin/code'],
}
/**
 * The Git repository a folder belongs to.
 * @param dir - absolute folder path.
 * @returns the repository root, when the folder is in one.
 */
function gitRootOf(dir: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 5000 }, (error, stdout) => {
      const root = stdout.trim()
      done(error === null && root !== '' ? root : undefined)
    })
  })
}

/** Whether the Cursor app is running (exit status only; nothing about the process is read). */
function cursorRunning(): Promise<boolean> {
  // pgrep cannot see GUI apps from a launchd-started server; AppleScript can.
  return new Promise((done) => {
    execFile('/usr/bin/osascript', ['-e', 'application "Cursor" is running'], { timeout: 5000 }, (error, stdout) => {
      done(error === null && stdout.trim() === 'true')
    })
  })
}

/** Minimum gap between files KairoForge opens by itself, so parallel workers do not flood the editor. */
const FOLLOW_GAP_MS = 1500
/** How often KairoForge re-checks for editors that need the extension (a newly installed VS Code, an old version). */
const AUTO_INSTALL_EVERY_MS = 10 * 60_000
/** The extension counts as connected when it reported this recently (it heartbeats every 30 s). */
const CONNECTED_MS = 3 * 60_000
/** At most one "open this project in Cursor" per project in this window, so a disconnected editor is never spammed. */
const BRING_UP_GAP_MS = 60_000

/**
 * Compare dotted versions numerically.
 * @param a - version.
 * @param b - version.
 * @returns negative, zero, or positive.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
const EDITOR_EXTENSIONS_DIR: Readonly<Record<EditorKind, string>> = {
  cursor: join(homedir(), '.cursor', 'extensions'),
  vscode: join(homedir(), '.vscode', 'extensions'),
}
const DEFAULT_ORIGINS: Readonly<Record<string, string>> = {
  'deepseek-official': 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai',
}
const BRIDGE_FILE = join(KAIROFORGE_HOME, 'editor-bridge.json')
const SESSIONS_FILE = join(KAIROFORGE_HOME, 'editor-sessions.json')
/** Mode editor questions use unless the extension picks another. */
export const DEFAULT_EDITOR_MODE = 'standard'
const MODE_NAMES: Readonly<Record<string, string>> = {
  'standard': 'KairoForge (Lead)',
  'self-edit': 'Self-Edit + GitHub',
  'cordis': 'Creator mode',
  'builder': 'Builder mode',
  'fast': 'Fast mode',
  'chat': 'Chat (answer only)',
  'minimal': 'Minimal mode',
  'ptc': 'PTC mode',
}
const MAX_INDEXES = 4
const WARM_EVERY_MS = 2500
const MIN_MAP_SCORE = 3

/** One question asked from the editor. */
export interface EditorTurn {
  readonly id: string
  readonly sessionId: string
  status: 'running' | 'done' | 'failed'
  updates: string[]
  reply?: string
  error?: string
  awaitingApproval: boolean
  started: boolean
  readonly startedAt: string
  finishedAt?: string
}

/** Running totals shown in the Command Center. */
export interface DevCounters {
  pathHints: number
  syntaxChecks: number
  /** Edited files KairoForge opened in Cursor by itself. */
  followedEdits?: number
  /** Projects KairoForge opened in Cursor because a request needed it and Cursor was not connected. */
  editorLaunches?: number
  /** Simulated mouse/keyboard scripts refused in favour of the applescript tool. */
  simulatedInputStops?: number
  syntaxFailures: number
  loopStops: number
  jsonHints: number
  repoMaps: number
  warmups: number
  lastWarmMs?: number
}

/** Whether one editor has the extension. */
export interface ExtensionState {
  readonly editor: EditorKind
  readonly available: boolean
  readonly installed: boolean
  readonly version?: string
}

/** Everything the Command Center shows. */
export interface DevStatus {
  readonly editor: {
    readonly connected: boolean
    /** A window on a real project is reporting (not only a scratch, test, or folderless window). */
    readonly onProject: boolean
    readonly name?: string
    readonly lastSeen?: string
    readonly activeFile?: string
    readonly workspace?: readonly string[]
    readonly problems: number
  }
  readonly extensions: readonly ExtensionState[]
  readonly index?: { readonly root: string; readonly files: number; readonly ready: boolean }
  readonly counters: DevCounters
  readonly warm: { readonly origins: readonly string[] }
  readonly context: { readonly compactAt: string; readonly spillAbove: string; readonly prunedAbove: string }
}

/** The slice of the settings service warm-up reads (provider endpoints, secrets redacted). */
interface SettingsReader {
  describe(options: { redactSecrets: boolean }): ReadonlyArray<{ readonly ns: string; readonly value: unknown }>
}

function run(command: string, args: readonly string[], cwd?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const options = { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...cwd === undefined ? {} : { cwd } }
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, output: `${stdout}${stderr}`.trim() })
    })
  })
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

const SCRATCH_ROOTS = [...new Set([tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'])]

/**
 * Whether an editor window has no real project: no folder at all (Cursor's
 * Agents window, an empty window) or only temporary folders (a scratch or test
 * window). Such a window never stands in for the user's project window.
 * @param folders - the window's workspace folders.
 * @returns true when the window is not on a project.
 */
export function isScratchWorkspace(folders: readonly string[]): boolean {
  return folders.every(folder => SCRATCH_ROOTS.some(root => within(folder, root)))
}

/** Whether a report comes from a window on the user's work: a real project folder, or a lone file outside temporary folders. */
function onProjectWindow(snapshot: EditorSnapshot): boolean {
  if (snapshot.workspaceFolders.length > 0) return !isScratchWorkspace(snapshot.workspaceFolders)
  return snapshot.activeFile !== undefined && !isScratchWorkspace([snapshot.activeFile])
}

/** DevKit service. */
export class DevKit extends Service {
  static inject = ['sessionController', 'personalAi']

  readonly loops = new LoopBreaker()
  readonly counters: DevCounters = {
    pathHints: 0, syntaxChecks: 0, syntaxFailures: 0, loopStops: 0, jsonHints: 0, repoMaps: 0, warmups: 0,
    followedEdits: 0, editorLaunches: 0, simulatedInputStops: 0,
  }
  private readonly token = randomBytes(24).toString('base64url')
  private snapshot: EditorSnapshot | undefined
  private seenAt = 0
  private readonly indexes = new Map<string, RepoIndex>()
  private readonly frozen = new Map<string, { request: string; text: string }>()
  private readonly turns = new Map<string, EditorTurn>()
  private readonly turnBySession = new Map<string, string>()
  private editorSessions: Record<string, string> | undefined
  private readonly warmedAt = new Map<string, number>()
  private lastProvider: string | undefined
  private autoInstalling = false
  /** Files already opened in Cursor per session, for the current user request. */
  private readonly followed = new Map<string, Set<string>>()
  private lastFollowAt = 0
  /** When each project was last opened in Cursor because the editor was not connected. */
  private readonly broughtUp = new Map<string, number>()

  /**
   * @param ctx - Host context.
   */
  constructor(ctx: Context) {
    super(ctx, 'devKit')
    ctx.effect(() => {
      void this.writeBridge().catch((error: unknown) => { ctx.logger.warn(`devkit: editor bridge file: ${String(error)}`) })
      return async () => { await this.removeBridge() }
    }, 'personal-ai: editor bridge file')
    ctx.effect(() => {
      const first = setTimeout(() => { void this.autoInstall() }, 8000)
      const timer = setInterval(() => { void this.autoInstall() }, AUTO_INSTALL_EVERY_MS)
      return () => { clearTimeout(first); clearInterval(timer) }
    }, 'personal-ai: editor extension auto-install')
    ctx.on('session/event', (session, event) => { this.observe(session.id, event.type, event.data) })
    ctx.on('agent/status', ({ agent, status }) => { this.observeStatus(agent.session.id, status) })
  }

  /** Bearer token the editor extension must present. */
  authorized(header: string | undefined): boolean {
    if (header === undefined || !header.startsWith('Bearer ')) return false
    const given = Buffer.from(header.slice(7))
    const expected = Buffer.from(this.token)
    if (given.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < given.length; i++) diff |= (given[i] ?? 0) ^ (expected[i] ?? 0)
    return diff === 0
  }

  private async writeBridge(): Promise<void> {
    await mkdir(KAIROFORGE_HOME, { recursive: true, mode: 0o700 })
    const port = process.env.KAIROFORGE_PORT ?? '3080'
    await writeFile(BRIDGE_FILE, `${JSON.stringify({ url: `http://127.0.0.1:${port}`, token: this.token, pid: process.pid })}\n`, { mode: 0o600 })
  }

  private async removeBridge(): Promise<void> {
    const current = await readFile(BRIDGE_FILE, 'utf8').then(text => JSON.parse(text) as { pid?: number }).catch(() => undefined)
    if (current?.pid === process.pid) await rm(BRIDGE_FILE, { force: true })
  }

  // ---------------------------------------------------------------------------
  // Editor state

  /**
   * Store a report from the editor extension.
   * @param raw - validated report.
   */
  noteEditor(raw: EditorSnapshot): void {
    const next = sanitizeSnapshot(raw)
    // A scratch or folderless window must not replace a project window that is still reporting.
    if (!onProjectWindow(next) && this.onProject()) return
    this.snapshot = next
    this.seenAt = Date.now()
    const root = this.snapshot.workspaceFolders[0]
    if (root !== undefined) void this.indexFor(root).refreshIfStale()
  }

  /** Latest editor report from a window on the user's work, when one is fresh. */
  editor(): EditorSnapshot | undefined {
    const snapshot = this.snapshot
    return snapshot !== undefined && Date.now() - this.seenAt < 15 * 60_000 && onProjectWindow(snapshot) ? snapshot : undefined
  }

  /** Whether the editor extension is reporting right now. */
  connected(): boolean {
    return this.snapshot !== undefined && Date.now() - this.seenAt < CONNECTED_MS
  }

  /**
   * Whether the Cursor app is running.
   * @returns true while Cursor is open.
   */
  cursorRunning(): Promise<boolean> {
    return cursorRunning()
  }

  /** Whether a Cursor window on a real project (not a scratch or folderless window) is reporting right now. */
  onProject(): boolean {
    return this.connected() && this.snapshot !== undefined && onProjectWindow(this.snapshot)
  }

  /**
   * Bring Cursor up for every message the user types while the extension is
   * not reporting: open the request's project in Cursor so the extension
   * activates and connects. Nothing happens while a Cursor window on a real
   * project is reporting (Cursor's Agents window or a scratch window does not
   * count), for the
   * home folder, when that project's window is already open in a running
   * Cursor (it only needs a reload), or more than once per project a minute.
   * @param cwd - the agent's working directory.
   * @returns the folder opened, when one was.
   */
  async bringUpEditor(cwd: string | undefined): Promise<string | undefined> {
    // A quit Cursor can still look connected for a few minutes after its last heartbeat.
    if (this.onProject() && await this.cursorRunning()) return undefined
    const cli = this.editorCli(PREFERRED_EDITOR)
    const where = this.workspaceRoot(cwd)
    if (cli === undefined || where === undefined || !existsSync(where)) return undefined
    const root = await gitRootOf(where) ?? where
    if (root === homedir() || root === '/') return undefined
    const now = Date.now()
    if (now - (this.broughtUp.get(root) ?? 0) < BRING_UP_GAP_MS) return undefined
    this.broughtUp.set(root, now)
    if (this.snapshot?.workspaceFolders.includes(root) === true && await this.cursorRunning()) return undefined
    execFile(cli, [root], { timeout: 20_000 }, (error) => {
      if (error !== null) this.ctx.logger.warn(`devkit: could not open ${root} in Cursor: ${error.message}`)
    })
    this.counters.editorLaunches = (this.counters.editorLaunches ?? 0) + 1
    this.ctx.logger.info(`devkit: Cursor was not connected; opened ${root} in Cursor for the current request`)
    return root
  }

  /**
   * The workspace a request is about: the editor's folder holding the active
   * file, else the agent's working directory, else the active project.
   * @param cwd - the agent's working directory.
   * @returns an absolute root, when one is known.
   */
  workspaceRoot(cwd?: string): string | undefined {
    const editor = this.editor()
    if (editor !== undefined) {
      const active = editor.activeFile
      const holding = active === undefined ? undefined : editor.workspaceFolders.find(root => within(active, root))
      const inCwd = cwd === undefined ? undefined : editor.workspaceFolders.find(root => within(cwd, root) || within(root, cwd))
      const chosen = inCwd ?? holding ?? (cwd === undefined ? editor.workspaceFolders[0] : undefined)
      if (chosen !== undefined) return chosen
    }
    return cwd ?? this.ctx.personalAi.activeProject()?.path
  }

  private indexFor(root: string): RepoIndex {
    let index = this.indexes.get(root)
    if (index !== undefined) {
      this.indexes.delete(root)
      this.indexes.set(root, index)
      return index
    }
    index = new RepoIndex(root)
    this.indexes.set(root, index)
    while (this.indexes.size > MAX_INDEXES) {
      const oldest = this.indexes.keys().next().value
      if (oldest === undefined) break
      this.indexes.delete(oldest)
    }
    return index
  }

  /**
   * Prompt context for one agent step: the editor and the repo map. Frozen per
   * user request so every step of a turn sends identical context (the
   * provider's prompt cache keeps hitting).
   * @param sessionId - agent session.
   * @param cwd - agent working directory.
   * @param request - the user's latest words.
   * @returns context text.
   */
  contextFor(sessionId: string, cwd: string | undefined, request: string): string {
    const frozen = this.frozen.get(sessionId)
    if (frozen?.request === request) return frozen.text
    const parts: string[] = []
    const editor = editorContextText(this.editor(), Date.now())
    if (editor !== '') parts.push(editor)
    const root = this.workspaceRoot(cwd)
    let complete = true
    if (root !== undefined && request.trim() !== '') {
      const index = this.indexFor(root)
      void index.refreshIfStale()
      if (index.ready) {
        const snapshot = this.editor()
        const relative = (path: string): string => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
        const focus = snapshot === undefined ? {} : {
          ...snapshot.activeFile === undefined ? {} : { active: relative(snapshot.activeFile) },
          open: snapshot.openFiles.map(relative),
        }
        const ranked = rankFiles(request, index.entries(), focus)
        if ((ranked[0]?.score ?? 0) >= MIN_MAP_SCORE) {
          parts.push(renderRepoMap(root, ranked))
          this.counters.repoMaps++
        }
      } else {
        complete = false
      }
    }
    const text = parts.join('\n\n')
    if (complete) this.frozen.set(sessionId, { request, text })
    return text
  }

  /**
   * Existing files the model probably meant.
   * @param missing - the path that was not found.
   * @param cwd - agent working directory.
   * @returns workspace-relative suggestions plus the root they are relative to.
   */
  async suggest(missing: string, cwd: string | undefined): Promise<{ root: string; paths: string[] } | undefined> {
    const root = this.workspaceRoot(cwd)
    if (root === undefined) return undefined
    const index = this.indexFor(root)
    if (!index.ready) await Promise.race([index.refreshIfStale(), new Promise(resolve => setTimeout(resolve, 4000))])
    if (!index.ready) return undefined
    const target = missing.startsWith(`${root}/`) ? missing.slice(root.length + 1) : missing
    const paths = suggestPaths(target, index.allPaths())
    return paths.length === 0 ? undefined : { root, paths }
  }

  /**
   * Ranked files for the repo_map tool.
   * @param query - what to look for.
   * @param cwd - agent working directory.
   * @returns the rendered map.
   */
  async repoMap(query: string, cwd: string | undefined): Promise<string> {
    const root = this.workspaceRoot(cwd)
    if (root === undefined) return 'No workspace is known: open a project or a folder in the editor first.'
    const index = this.indexFor(root)
    await index.refreshIfStale()
    const ranked = rankFiles(query, index.entries(), {}, Date.now(), 25)
    return renderRepoMap(root, ranked, 8000) || `Nothing in ${root} matches "${query}" (${String(index.entries().length)} files indexed).`
  }

  // ---------------------------------------------------------------------------
  // Asking from the editor

  /**
   * Modes (agent presets) an editor question can run in.
   * @returns preset ids and names.
   */
  async modes(): Promise<Array<{ id: string; name: string }>> {
    const presets = await this.ctx.get('agentPresets')?.list() ?? []
    const rows = presets
      .filter(preset => preset.broken === undefined)
      .map(preset => ({ id: preset.id, name: preset.name ?? MODE_NAMES[preset.id] ?? preset.id }))
    return rows.length === 0 ? [{ id: DEFAULT_EDITOR_MODE, name: DEFAULT_EDITOR_MODE }] : rows
  }

  private async sessionFor(workspace: string | undefined, mode: string): Promise<string> {
    const key = mode === DEFAULT_EDITOR_MODE ? workspace ?? 'default' : `${mode}:${workspace ?? 'default'}`
    this.editorSessions ??= await readFile(SESSIONS_FILE, 'utf8').then(text => JSON.parse(text) as Record<string, string>).catch(() => ({}))
    const known = this.editorSessions[key]
    if (known !== undefined) {
      const resolved = await this.ctx.sessionController.resolveAgent(SessionId(known)).catch(() => undefined)
      if (resolved !== undefined && !('error' in resolved)) return known
    }
    const created = await this.ctx.sessionController.create({ agentPreset: mode, ...workspace === undefined ? {} : { cwd: workspace } })
    const where = workspace === undefined ? 'editor' : basename(workspace)
    const title = `${this.ctx.personalAi.personality().name} — ${where} (editor${mode === DEFAULT_EDITOR_MODE ? '' : `, ${mode}`})`
    await this.ctx.sessionController.rename({ sessionId: created.sessionId, title }).catch(() => {})
    this.editorSessions[key] = created.sessionId
    await writeFile(SESSIONS_FILE, `${JSON.stringify(this.editorSessions)}\n`, { mode: 0o600 }).catch(() => {})
    return created.sessionId
  }

  /**
   * Ask KairoForge from the editor. An ordinary turn: coordinator,
   * permissions, and approvals apply.
   * @param prompt - the user's words.
   * @param workspace - the editor's workspace folder.
   * @param mode - agent preset to answer in (defaults to the coordinator mode).
   * @returns the running turn.
   */
  async ask(prompt: string, workspace?: string, mode?: string): Promise<EditorTurn> {
    const text = prompt.trim()
    if (text === '') throw new PersonalAiError('invalid', 'type a question first')
    const chosen = mode ?? DEFAULT_EDITOR_MODE
    if (chosen !== DEFAULT_EDITOR_MODE && !(await this.modes()).some(row => row.id === chosen)) {
      throw new PersonalAiError('invalid', `unknown mode "${chosen}"`)
    }
    const folder = workspace !== undefined && existsSync(workspace) ? workspace : undefined
    const sessionId = await this.sessionFor(folder, chosen)
    if (this.turnBySession.has(sessionId)) throw new PersonalAiError('conflict', 'KairoForge is still answering your last editor question')
    const turn: EditorTurn = { id: randomUUID(), sessionId, status: 'running', updates: [], awaitingApproval: false, started: false, startedAt: new Date().toISOString() }
    this.turns.set(turn.id, turn)
    this.turnBySession.set(sessionId, turn.id)
    while (this.turns.size > 50) {
      const oldest = this.turns.keys().next().value
      if (oldest === undefined) break
      this.turns.delete(oldest)
    }
    try {
      await this.ctx.sessionController.prompt({
        requestId: brandString<SessionRequestId>(`personal-ai-editor-${randomUUID()}`),
        sessionId: SessionId(sessionId),
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(30_000))
    } catch (error) {
      this.finish(sessionId, `not accepted: ${error instanceof Error ? error.message : String(error)}`)
      throw new PersonalAiError('conflict', `KairoForge could not take the question: ${error instanceof Error ? error.message : String(error)}`)
    }
    return turn
  }

  /**
   * One editor question.
   * @param id - turn id.
   * @returns the turn.
   */
  turn(id: string): EditorTurn {
    const turn = this.turns.get(id)
    if (turn === undefined) throw new PersonalAiError('not-found', `no editor question "${id}"`)
    return turn
  }

  private observe(sessionId: string, type: string, data: unknown): void {
    if (type === 'user/message') {
      const source = (data as { source?: { kind?: string; form?: string } }).source
      if (source?.kind === 'user' && source.form === undefined) {
        this.loops.reset(sessionId)
        this.frozen.delete(sessionId)
        this.followed.delete(sessionId)
      }
    }
    const id = this.turnBySession.get(sessionId)
    const turn = id === undefined ? undefined : this.turns.get(id)
    if (turn === undefined) return
    if (type === 'approval/asked') turn.awaitingApproval = true
    if (type === 'approval/decided') turn.awaitingApproval = false
    if (type === 'assistant/message') {
      const text = textOf((data as { message: { content: unknown } }).message.content).trim()
      if (text === '') return
      if (turn.reply !== undefined) turn.updates.push(turn.reply.split('\n')[0]?.slice(0, 160) ?? '')
      turn.reply = text
    }
  }

  private observeStatus(sessionId: string, status: string): void {
    const id = this.turnBySession.get(sessionId)
    const turn = id === undefined ? undefined : this.turns.get(id)
    if (turn === undefined) return
    if (status === 'running') turn.started = true
    else if (turn.started) this.finish(sessionId)
  }

  private finish(sessionId: string, error?: string): void {
    const id = this.turnBySession.get(sessionId)
    this.turnBySession.delete(sessionId)
    const turn = id === undefined ? undefined : this.turns.get(id)
    if (turn === undefined) return
    turn.status = error === undefined ? 'done' : 'failed'
    if (error !== undefined) turn.error = error
    turn.awaitingApproval = false
    turn.finishedAt = new Date().toISOString()
  }

  // ---------------------------------------------------------------------------
  // Extension install

  /**
   * The editor's command-line launcher.
   * @param editor - which editor.
   * @returns its absolute path, when installed.
   */
  editorCli(editor: EditorKind): string | undefined {
    return EDITOR_CLI[editor].find(path => existsSync(path))
  }

  private async installedVersion(editor: EditorKind): Promise<string | undefined> {
    const entries = await readdir(EDITOR_EXTENSIONS_DIR[editor]).catch(() => [])
    const versions = entries.filter(name => name.startsWith(`${EXTENSION_ID}-`)).map(name => name.slice(EXTENSION_ID.length + 1))
    return versions.sort(compareVersions).pop()
  }

  /**
   * Show a file an agent just edited in Cursor, once per file per request,
   * so the user watches the work happen in their editor.
   * @param sessionId - editing agent's session.
   * @param path - absolute path of the edited file.
   * @returns whether the file was opened.
   */
  followEdit(sessionId: string, path: string): boolean {
    const cli = this.editorCli(PREFERRED_EDITOR)
    if (cli === undefined || isSecretPath(path) || !existsSync(path)) return false
    const seen = this.followed.get(sessionId) ?? new Set<string>()
    const now = Date.now()
    if (seen.has(path) || now - this.lastFollowAt < FOLLOW_GAP_MS) return false
    seen.add(path)
    this.followed.set(sessionId, seen)
    this.lastFollowAt = now
    this.counters.followedEdits = (this.counters.followedEdits ?? 0) + 1
    void gitRootOf(dirname(path)).then((root) => {
      // Opening the project folder too puts the file in that project's Cursor window (reused when already open).
      const args = root === undefined || root === homedir() ? ['-g', path] : [root, '-g', path]
      execFile(cli, args, { timeout: 20_000 }, (error) => {
        if (error !== null) this.ctx.logger.warn(`devkit: could not open ${path} in Cursor: ${error.message}`)
      })
    })
    return true
  }

  /**
   * Keep the extension installed and current in every editor on this Mac,
   * so VS Code and Cursor are always connected without a manual step.
   * @returns editors that were installed or upgraded.
   */
  async autoInstall(): Promise<EditorKind[]> {
    if (this.autoInstalling) return []
    this.autoInstalling = true
    const done: EditorKind[] = []
    try {
      for (const editor of EDITORS) {
        if (this.editorCli(editor) === undefined) continue
        const version = await this.installedVersion(editor)
        if (version !== undefined && compareVersions(version, EXTENSION_VERSION) >= 0) continue
        const result = await this.installExtension(editor).catch((error: unknown) => {
          this.ctx.logger.warn(`devkit: extension install into ${editor} failed: ${String(error)}`)
          return undefined
        })
        if (result?.installed === true) {
          done.push(editor)
          this.ctx.logger.info(`devkit: KairoForge extension ${result.version} installed into ${editor}`)
        }
      }
    } finally {
      this.autoInstalling = false
    }
    return done
  }

  /**
   * Package the extension and install it with the editor's CLI.
   * @param editor - target editor.
   * @returns what the CLI reported.
   */
  async installExtension(editor: EditorKind): Promise<{ installed: boolean; version: string; detail: string }> {
    const cli = this.editorCli(editor)
    if (cli === undefined) throw new PersonalAiError('not-found', `${editor === 'cursor' ? 'Cursor' : 'VS Code'} is not installed in /Applications`)
    const dir = await mkdtemp(join(tmpdir(), 'kairoforge-vsix-'))
    try {
      await mkdir(join(dir, 'extension'))
      await writeFile(join(dir, 'extension', 'package.json'), `${JSON.stringify(EXTENSION_MANIFEST, null, 2)}\n`)
      await writeFile(join(dir, 'extension', 'extension.js'), EXTENSION_SOURCE)
      await writeFile(join(dir, 'extension.vsixmanifest'), vsixManifest())
      await writeFile(join(dir, '[Content_Types].xml'), CONTENT_TYPES)
      const vsix = join(dir, `kairoforge-editor-${EXTENSION_VERSION}.vsix`)
      const zipped = await run('/usr/bin/zip', ['-q', '-r', '-X', vsix, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], dir)
      if (zipped.code !== 0) throw new PersonalAiError('conflict', `could not package the extension: ${zipped.output}`)
      const result = await run(cli, ['--install-extension', vsix, '--force'])
      const version = await this.installedVersion(editor)
      return { installed: result.code === 0 && version !== undefined, version: version ?? EXTENSION_VERSION, detail: result.output.split('\n').slice(-3).join(' ') }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // ---------------------------------------------------------------------------
  // Speed: provider warm-up

  /**
   * Remember which provider the agent loop is using.
   * @param provider - provider id from an `agent/request`.
   */
  noteProvider(provider: string): void {
    this.lastProvider = provider
  }

  private origins(): string[] {
    const llm = this.ctx.get('llm')
    const settings = (this.ctx.get as (name: string) => unknown)('settings') as SettingsReader | undefined
    if (llm === undefined) return []
    const live = new Set(llm.listProviders().map(provider => provider.id))
    const namespaces = settings?.describe({ redactSecrets: true }) ?? []
    const byProvider = new Map<string, string>()
    for (const entry of llm.listConfigurableProviders()) {
      if (!live.has(entry.provider)) continue
      let profile: unknown = namespaces.find(namespace => namespace.ns === entry.settingsNs)?.value
      for (const key of entry.settingsPath) profile = typeof profile === 'object' && profile !== null ? Reflect.get(profile, key) : undefined
      const base: unknown = typeof profile === 'object' && profile !== null ? Reflect.get(profile, 'baseURL') : undefined
      const url = typeof base === 'string' && base !== '' ? base : DEFAULT_ORIGINS[entry.provider]
      if (url === undefined || isLoopbackUrl(url)) continue
      try {
        byProvider.set(entry.provider, new URL(url).origin)
      } catch {
        // A malformed base URL is the provider's problem to report, not warm-up's.
      }
    }
    if (this.lastProvider !== undefined && live.has(this.lastProvider)) {
      const preferred = byProvider.get(this.lastProvider)
      return preferred === undefined ? [] : [preferred]
    }
    return [...new Set(byProvider.values())].slice(0, 3)
  }

  /**
   * Open (or keep open) the model connection while the user is typing. Uses
   * the process's normal `fetch`, so the proxy policy and connection pool are
   * the ones the real request will use.
   * @returns the origins touched.
   */
  async warm(): Promise<{ origins: string[]; ms?: number }> {
    if (this.ctx.get('lifeOs')?.settings().airGap === true) return { origins: [] }
    const now = Date.now()
    const due = this.origins().filter(origin => now - (this.warmedAt.get(origin) ?? 0) >= WARM_EVERY_MS)
    if (due.length === 0) return { origins: [] }
    for (const origin of due) this.warmedAt.set(origin, now)
    const started = performance.now()
    await Promise.all(due.map(origin => fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      .then(async (response) => { await response.body?.cancel() })
      .catch(() => {})))
    const ms = Math.round(performance.now() - started)
    this.counters.warmups++
    this.counters.lastWarmMs = ms
    return { origins: due, ms }
  }

  // ---------------------------------------------------------------------------

  /** Command Center view. */
  async status(): Promise<DevStatus> {
    const editor = this.editor()
    const root = this.workspaceRoot()
    const index = root === undefined ? undefined : this.indexes.get(root)
    const extensions = await Promise.all(EDITORS.map(async (kind) => {
      const version = await this.installedVersion(kind)
      const state: ExtensionState = { editor: kind, available: this.editorCli(kind) !== undefined, installed: version !== undefined }
      return version === undefined ? state : { ...state, version }
    }))
    return {
      editor: {
        connected: this.connected(),
        onProject: this.onProject(),
        problems: editor?.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length ?? 0,
        ...editor === undefined ? {} : {
          name: editor.editor,
          lastSeen: new Date(this.seenAt).toISOString(),
          workspace: editor.workspaceFolders,
          ...editor.activeFile === undefined ? {} : { activeFile: editor.activeFile },
        },
      },
      extensions,
      ...root === undefined || index === undefined ? {} : { index: { root, files: index.entries().length, ready: index.ready } },
      counters: { ...this.counters },
      warm: { origins: this.origins() },
      context: { compactAt: '80% of the model context window', spillAbove: '12,500 tokens per tool result', prunedAbove: '8,192 characters in old tool results' },
    }
  }
}

function vsixManifest(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${EXTENSION_MANIFEST.name}" Version="${EXTENSION_VERSION}" Publisher="${EXTENSION_MANIFEST.publisher}" />
    <DisplayName>${EXTENSION_MANIFEST.displayName}</DisplayName>
    <Description xml:space="preserve">${EXTENSION_MANIFEST.description}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${EXTENSION_MANIFEST.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
`
