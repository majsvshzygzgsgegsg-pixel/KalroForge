/**
 * Tools KairoForge writes for itself. Each lives in
 * `~/.kairoforge/tools/<name>/` as a `tool.json` manifest plus one script, and
 * appears in the coordinator's toolbelt as `user_tool__<name>`. Writing one is
 * a SENSITIVE action (the user approves the code once); running one is an
 * ordinary tool call through the permission path. Scripts get their arguments
 * as JSON on stdin and in `KF_ARGS`, run with a minimal environment (no API
 * keys or tokens from KairoForge's own environment), and are time-limited.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { USER_TOOL_LANGUAGES, userToolNameError, userToolRuntime, type UserToolLanguage } from '../core/autonomy.ts'
import { findSensitive } from '../core/sensitive.ts'
import { KAIROFORGE_HOME } from '../native.ts'

const MAX_SCRIPT_CHARS = 60_000
const RUN_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 4 * 1024 * 1024
const KEEP_STDOUT = 12_000
const KEEP_STDERR = 4000
const NETWORK_CODE = new RegExp(String.raw`\b(?:requests|urllib|http\.client|httpx|aiohttp|socket|fetch\(|axios|XMLHttpRequest|`
  + String.raw`curl|wget|ssh|scp|nc)\b|https?://(?!(?:localhost|127\.0\.0\.1)[:/])`)

/** Fields for a new self-written tool. */
export interface UserToolInput {
  readonly name: string
  readonly description: string
  readonly language: string
  readonly script: string
  readonly parameters?: readonly UserToolParameter[]
}

/** One parameter of a self-written tool (all values arrive as strings). */
export interface UserToolParameter {
  readonly name: string
  readonly description: string
  readonly required: boolean
}

/** A self-written tool's manifest. */
export interface UserToolManifest {
  readonly name: string
  readonly description: string
  readonly language: UserToolLanguage
  readonly parameters: readonly UserToolParameter[]
  readonly createdAt: string
  readonly reachesNetwork: boolean
}

/** What running a tool produced. */
export interface UserToolRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** Self-written tool store. */
export class UserTools {
  private cache: UserToolManifest[] | undefined
  revision = 0

  /**
   * @param root - tools directory; defaults to `~/.kairoforge/tools`.
   */
  constructor(readonly root = join(KAIROFORGE_HOME, 'tools')) {}

  /**
   * Every saved tool.
   * @returns manifests, sorted by name.
   */
  async list(): Promise<UserToolManifest[]> {
    if (this.cache !== undefined) return this.cache
    if (!existsSync(this.root)) return (this.cache = [])
    const manifests: UserToolManifest[] = []
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || userToolNameError(entry.name) !== undefined) continue
      try {
        const manifest = JSON.parse(await readFile(join(this.root, entry.name, 'tool.json'), 'utf8')) as UserToolManifest
        if (manifest.name === entry.name && (USER_TOOL_LANGUAGES as readonly string[]).includes(manifest.language)) manifests.push(manifest)
      } catch {
        // A folder without a readable manifest is not a tool.
      }
    }
    return (this.cache = manifests.toSorted((a, b) => a.name.localeCompare(b.name)))
  }

  /** Cached manifests (empty until {@link list} has run once). */
  known(): readonly UserToolManifest[] {
    return this.cache ?? []
  }

  /**
   * Save a new tool or replace one.
   * @param input - name, description, language (python, node, or bash), full script, parameters.
   * @returns the manifest.
   */
  async create(input: UserToolInput): Promise<UserToolManifest> {
    const nameError = userToolNameError(input.name)
    if (nameError !== undefined) throw new Error(nameError)
    if (!(USER_TOOL_LANGUAGES as readonly string[]).includes(input.language)) throw new Error(`language must be ${USER_TOOL_LANGUAGES.join(', ')}`)
    if (input.script.trim() === '' || input.script.length > MAX_SCRIPT_CHARS) throw new Error(`the script must be 1-${String(MAX_SCRIPT_CHARS)} characters`)
    const finding = findSensitive(input.script)
    if (finding.sensitive) throw new Error(`not saved: the script ${finding.reason ?? 'contains something that looks like a secret'}. Read credentials from the environment instead.`)
    const language = input.language as UserToolLanguage
    const manifest: UserToolManifest = {
      name: input.name,
      description: input.description.trim().slice(0, 400) || input.name,
      language,
      parameters: (input.parameters ?? []).slice(0, 12).map(parameter => ({
        name: parameter.name.replace(/[^a-z0-9_]/gi, '_').slice(0, 40),
        description: parameter.description.slice(0, 200),
        required: parameter.required,
      })),
      createdAt: new Date().toISOString(),
      reachesNetwork: NETWORK_CODE.test(input.script),
    }
    const dir = join(this.root, input.name)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, userToolRuntime(language).file), input.script, { mode: 0o700 })
    await writeFile(join(dir, 'tool.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    this.cache = undefined
    this.revision++
    await this.list()
    return manifest
  }

  /**
   * Delete a tool.
   * @param name - tool name.
   * @returns whether it existed.
   */
  async remove(name: string): Promise<boolean> {
    if (userToolNameError(name) !== undefined) return false
    const dir = join(this.root, name)
    if (!existsSync(dir)) return false
    await rm(dir, { recursive: true, force: true })
    this.cache = undefined
    this.revision++
    await this.list()
    return true
  }

  /**
   * Run a tool.
   * @param name - tool name.
   * @param args - string arguments.
   * @param cwd - working directory.
   * @returns exit code and output tails.
   */
  async run(name: string, args: Record<string, unknown>, cwd: string): Promise<UserToolRun> {
    const manifest = (await this.list()).find(tool => tool.name === name)
    if (manifest === undefined) throw new Error(`no self-written tool "${name}"`)
    const runtime = userToolRuntime(manifest.language)
    const script = join(this.root, name, runtime.file)
    const payload = JSON.stringify(args)
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
      HOME: process.env.HOME ?? '',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      USER: process.env.USER ?? '',
      KF_ARGS: payload,
      KF_TOOL_DIR: join(this.root, name),
    }
    return new Promise((resolve) => {
      const child = execFile(runtime.command, [script], { cwd, env, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: 'utf8' }, (error, stdout, stderr) => {
        const timedOut = error?.killed ?? false
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
        resolve({ exitCode: code, stdout: stdout.slice(-KEEP_STDOUT), stderr: stderr.slice(-KEEP_STDERR), timedOut })
      })
      child.stdin?.end(payload)
    })
  }
}
