/**
 * Cursor as KairoForge's hands. `cursor_computer` hands a request to do
 * something on the Mac to the Cursor agent CLI, which acts from its own
 * workspace (~/.kairoforge/cursor-hands) with AppleScript and the Cua Driver's
 * visible agent cursor, and reports back what it did.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { CURSOR_COMPUTER, HANDS_INSTRUCTIONS, HANDS_PERMISSIONS, readCursorStream, type CursorRunSummary } from './core/cursor-hands.ts'
import { KAIROFORGE_HOME } from './native.ts'

/** Where the Cursor agent CLI installs itself, and the folder it acts from. */
export const DEFAULT_CURSOR_AGENT = {
  binary: join(homedir(), '.local', 'bin', 'cursor-agent'),
  workspace: join(KAIROFORGE_HOME, 'cursor-hands'),
  /** The quickest Cursor model at short computer tasks; '' uses Cursor's own default. */
  model: 'gpt-5.3-codex-low-fast',
} as const

const STATUS_TTL_MS = 5 * 60_000
const RUN_TIMEOUT_MS = 10 * 60_000
const MAX_LINES = 5_000

/** Runs Cursor agent requests and tracks whether the CLI is installed and signed in. */
export class CursorHands {
  private signedIn: boolean | undefined
  private checkedAt = 0
  private checking: Promise<boolean> | undefined

  /**
   * @param binary - the Cursor agent CLI.
   * @param workspace - the folder Cursor acts from; holds its instructions and permissions.
   * @param model - Cursor model for these runs; '' uses Cursor's default.
   */
  constructor(
    readonly binary: string = DEFAULT_CURSOR_AGENT.binary,
    readonly workspace: string = DEFAULT_CURSOR_AGENT.workspace,
    private model: string = DEFAULT_CURSOR_AGENT.model,
  ) {}

  /** Whether the Cursor agent CLI is installed. */
  installed(): boolean {
    return existsSync(this.binary)
  }

  /**
   * Whether Cursor can take requests now: installed and signed in, from the last check.
   * A stale check starts a new one in the background.
   */
  ready(): boolean {
    if (!this.installed()) return false
    if (Date.now() - this.checkedAt > STATUS_TTL_MS) void this.refresh()
    return this.signedIn === true
  }

  /** Ask the CLI whether it is signed in. */
  async refresh(): Promise<boolean> {
    if (!this.installed()) return false
    this.checking ??= this.output(['status'], 30_000).then((text) => {
      this.signedIn = /logged in as/i.test(text) && !/not logged in/i.test(text)
      this.checkedAt = Date.now()
      return this.signedIn
    }).finally(() => { this.checking = undefined })
    return this.checking
  }

  /** Write Cursor's instructions and permissions into its workspace. */
  async prepare(): Promise<void> {
    await mkdir(join(this.workspace, '.cursor'), { recursive: true })
    await writeFile(join(this.workspace, 'AGENTS.md'), HANDS_INSTRUCTIONS)
    await writeFile(join(this.workspace, '.cursor', 'cli.json'), `${JSON.stringify(HANDS_PERMISSIONS, null, 2)}\n`)
  }

  /**
   * Have Cursor do one request on the Mac.
   * @param task - the request, in the user's words plus any detail that helps.
   * @param signal - cancels the run.
   * @param timeoutMs - upper bound for the whole run.
   * @returns what Cursor did and said.
   */
  async run(task: string, signal?: AbortSignal, timeoutMs = RUN_TIMEOUT_MS): Promise<CursorRunSummary> {
    if (!this.installed()) return { ok: false, reply: 'The Cursor agent CLI is not installed (run `cursor agent` once to install it).', actions: [] }
    await this.prepare()
    const model = this.model === '' ? [] : ['--model', this.model]
    const args = ['-p', '--output-format', 'stream-json', '--approve-mcps', '--trust', '--workspace', this.workspace, ...model, task]
    const child = spawn(this.binary, args, { cwd: this.workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines: string[] = []
    let stderr = ''
    const stop = (): void => { child.kill('SIGTERM') }
    const timer = setTimeout(stop, timeoutMs)
    signal?.addEventListener('abort', stop, { once: true })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2_000) })
    createInterface({ input: child.stdout }).on('line', (line) => { if (lines.length < MAX_LINES) lines.push(line) })
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', (error) => { stderr += String(error); resolve(null) })
      child.once('close', resolve)
    })
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    const summary = readCursorStream(lines)
    if (summary.ok) return summary
    if (/not logged in|authenticat|login/i.test(stderr)) {
      this.signedIn = false
      this.checkedAt = Date.now()
      return { ...summary, reply: 'Cursor is not signed in. Run `cursor-agent login` and approve it in the browser.' }
    }
    if (signal?.aborted === true) return { ...summary, reply: 'Stopped before Cursor finished.' }
    // A model Cursor no longer offers: drop it for good and run once more on Cursor's default.
    if (this.model !== '' && summary.actions.length === 0 && /model/i.test(stderr)) {
      this.model = ''
      return this.run(task, signal, timeoutMs)
    }
    const why = stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? ''
    return code === 0 || why === '' ? summary : { ...summary, reply: `${summary.reply} (Cursor exited with ${String(code)}: ${why})` }
  }

  private async output(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      child.once('error', () => { clearTimeout(timer); resolve(text) })
      child.once('close', () => { clearTimeout(timer); resolve(text) })
    })
  }
}

const DESCRIPTION = [
  'Do something on the user\'s Mac through Cursor, which is your hands: open, use, and control apps and windows, click buttons, type,',
  'use menus, Finder, Safari, Music, Mail, Notes, Reminders, Calendar, settings, volume, and anything else a person does at the computer.',
  'Cursor acts with AppleScript and a visible agent cursor the user can watch, then reports what it did and checked.',
  'Pass the whole request in task, in the user\'s words plus any detail you know (names, text to type). One call per request.',
].join(' ')

/**
 * Register `cursor_computer` on the host when the Cursor agent CLI is installed.
 * @param ctx - host context with the tool registry.
 * @param hands - the Cursor runner.
 */
export function installCursorHands(ctx: Context, hands: CursorHands): void {
  if (!hands.installed()) return
  hands.refresh().catch(() => undefined)
  ctx.effect(() => ctx.tools.register(defineTool({
    name: CURSOR_COMPUTER,
    description: DESCRIPTION,
    parameters: {
      task: { type: 'string', required: true, description: 'What to do on the Mac, in full.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const started = Date.now()
      const summary = await hands.run(args.task, exec.signal)
      if (!summary.ok) {
        const tried = summary.actions.length === 0 ? '' : ` Actions it took: ${summary.actions.slice(0, 20).join('; ')}.`
        throw new Error(`Cursor did not finish: ${summary.reply}${tried}`)
      }
      return {
        reply: summary.reply,
        actions: summary.actions.slice(0, 40),
        seconds: Math.round((summary.durationMs ?? Date.now() - started) / 100) / 10,
      }
    },
  })), 'personal-ai.cursor-hands')
}
