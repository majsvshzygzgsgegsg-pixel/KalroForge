/**
 * Runner for `kf-native`: compiles the helper from {@link KF_NATIVE_SOURCE}
 * once per source version into `~/.kairoforge/bin`, runs one-shot commands,
 * and streams `watch` lines. macOS only; elsewhere every call reports
 * `unsupported` instead of pretending.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { KF_NATIVE_SOURCE } from './native-source.ts'

/** KairoForge's own per-user directory (tools, brain, vault key). */
export const KAIROFORGE_HOME = process.env.KAIROFORGE_HOME ?? join(homedir(), '.kairoforge')

const RUN_TIMEOUT_MS = 30_000
const BUILD_TIMEOUT_MS = 180_000
const MAX_OUTPUT = 8 * 1024 * 1024

/** A native helper failure with the helper's own message. */
export class NativeError extends Error {
  override readonly name = 'NativeError'
}

/** One `watch` sample. */
export interface WatchSample {
  readonly app?: string
  readonly bundleId?: string
  readonly title?: string
  readonly idle?: number
  readonly clipboard?: string
}

function run(file: string, args: readonly string[], input: string | undefined, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, [...args], { timeout, maxBuffer: MAX_OUTPUT, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null && stdout.trim() === '') {
        reject(new NativeError(stderr.trim() === '' ? error.message : stderr.trim().slice(0, 500)))
        return
      }
      resolve(stdout)
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** The compiled helper and its commands. */
export class NativeHelper {
  private built: Promise<string> | undefined

  /** Whether this platform can run the helper at all. */
  supported(): boolean {
    return process.platform === 'darwin'
  }

  /**
   * Path of the compiled helper, compiling it when this source version has not been built.
   * @returns the binary path.
   */
  binary(): Promise<string> {
    if (!this.supported()) return Promise.reject(new NativeError('unsupported: the native helper needs macOS'))
    this.built ??= this.build().catch((error: unknown) => {
      this.built = undefined
      throw error
    })
    return this.built
  }

  private async build(): Promise<string> {
    const version = createHash('sha256').update(KF_NATIVE_SOURCE).digest('hex').slice(0, 12)
    const dir = join(KAIROFORGE_HOME, 'bin')
    const binary = join(dir, `kf-native-${version}`)
    if (existsSync(binary)) return binary
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const source = join(dir, `kf-native-${version}.swift`)
    writeFileSync(source, KF_NATIVE_SOURCE, { mode: 0o600 })
    await run('/usr/bin/xcrun', ['swiftc', '-O', '-o', binary, source], undefined, BUILD_TIMEOUT_MS).catch((error: unknown) => {
      throw new NativeError(`could not compile the native helper (install Xcode Command Line Tools): ${error instanceof Error ? error.message : String(error)}`)
    })
    return binary
  }

  /**
   * Run one command and parse its JSON answer.
   * @param args - subcommand and arguments.
   * @param input - optional stdin.
   * @returns the parsed value.
   */
  async call<T>(args: readonly string[], input?: string): Promise<T> {
    const out = await run(await this.binary(), args, input, RUN_TIMEOUT_MS)
    const line = out.trim().split('\n').at(-1) ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new NativeError(`unexpected helper output for ${args[0] ?? '?'}`)
    }
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) throw new NativeError(String(parsed.error))
    return parsed as T
  }

  /**
   * Stream samples until stopped.
   * @param intervalSeconds - seconds between samples.
   * @param clipboard - include clipboard text when it changes.
   * @param onSample - receives each sample.
   * @param onExit - called once if the helper stops by itself.
   * @returns a stop function.
   */
  async watch(
    intervalSeconds: number,
    clipboard: boolean,
    onSample: (sample: WatchSample) => void,
    onExit: (reason: string) => void,
  ): Promise<() => void> {
    const binary = await this.binary()
    const child = spawn(binary, ['watch', String(intervalSeconds), ...clipboard ? ['--clipboard'] : []], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stopped = false
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try {
        onSample(JSON.parse(line) as WatchSample)
      } catch {
        // A partial line from a dying helper carries nothing usable.
      }
    })
    child.on('exit', (code) => { if (!stopped) onExit(`helper exited (${String(code)})`) })
    child.on('error', (error) => { if (!stopped) onExit(error.message) })
    return () => {
      stopped = true
      lines.close()
      child.kill()
    }
  }
}
