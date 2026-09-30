/**
 * Vault memory for the harness.
 *
 * Loads the KairoForge conversation vault and injects what it knows into the
 * system prompt, so the assistant begins each session already aware of the
 * user's history and measured writing style.
 *
 * HOW IT HOOKS IN
 *
 * `ctx.systemPrompt.section()` registers an ordered prompt section whose text
 * is a function evaluated at each assembly. That is the right seam for memory:
 * the vault can change between turns, and a static string would freeze the
 * first answer forever.
 *
 * DESIGN CONSTRAINTS
 *
 * The block is *bounded* (`maxCharacters`). It is prepended to every request,
 * so an unbounded block would grow without limit as the vault fills and
 * eventually crowd out the user's actual message.
 *
 * Injection is best-effort. If the vault, Python, or the CLI is unavailable,
 * the section contributes nothing and the conversation proceeds normally. A
 * memory subsystem that can break the assistant is worse than one that is
 * occasionally silent, so every failure path degrades to an empty string.
 *
 * The vault is read through the `vault_sync.py` CLI rather than reimplemented
 * here, so the SQLite schema and the style measurement live in one place.
 *
 * @module kairoforge-vault
 */

import type { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Where the memory section sits: just after the core tool sections, before
 *  per-deployment persona text, so it reads as context rather than identity. */
const MEMORY_SECTION_ORDER = 200
const MEMORY_SECTION_NAME = 'kairoforge:vault-memory'

/** Plugin configuration. */
export interface Config {
  /** KairoForge checkout root holding `scripts/vault_sync.py`. */
  kairoforgeDir?: string
  /** Maximum characters of memory injected per request. */
  maxCharacters?: number
  /** Seconds to wait for the vault CLI before giving up on memory. */
  timeoutSeconds?: number
  /** Cache lifetime in milliseconds; the vault changes only when the user talks. */
  cacheMs?: number
  /** Log what was injected, for diagnosing an empty or oversized block. */
  debug?: boolean
}

export const name = 'kairoforge-vault'

/**
 * Ask the vault for the memory block a new conversation should start with.
 *
 * @param dir - KairoForge checkout root.
 * @param timeoutSeconds - hard limit on the child process.
 * @returns the memory block, or an empty string when unavailable.
 */
async function readMemoryBlock(dir: string, timeoutSeconds: number): Promise<string> {
  const script = `${dir}/scripts/vault_sync.py`
  if (!existsSync(script)) return ''

  try {
    const { stdout } = await run('python3', [script, 'prompt'], {
      cwd: dir,
      timeout: timeoutSeconds * 1000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout.trim()
  } catch {
    // Missing vault, missing python, or an empty profile: continue without
    // memory rather than failing the conversation.
    return ''
  }
}

/**
 * Register vault memory with the harness.
 *
 * @param ctx - the plugin lifetime.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const dir =
    config.kairoforgeDir ??
    process.env.KAIROFORGE_DIR ??
    `${process.env.HOME ?? ''}/Documents/KalroForge`
  const maxCharacters = config.maxCharacters ?? 4000
  const timeoutSeconds = config.timeoutSeconds ?? 20
  const cacheMs = config.cacheMs ?? 60_000

  // Cached so a conversation does not spawn a subprocess on every request.
  let cached = ''
  let cachedAt = 0
  let inflight: Promise<string> | null = null

  const memory = async (): Promise<string> => {
    const now = Date.now()
    if (now - cachedAt < cacheMs) return cached
    // Collapse concurrent assemblies onto one CLI call.
    if (inflight) return inflight

    inflight = (async () => {
      let block = await readMemoryBlock(dir, timeoutSeconds)
      if (block.length > maxCharacters) {
        block = `${block.slice(0, maxCharacters)}\n...`
      }
      cached = block
      cachedAt = Date.now()
      inflight = null
      if (config.debug) {
        ctx.logger?.info(`kairoforge-vault: injected ${block.length} chars of memory`)
      }
      return block
    })()

    return inflight
  }

  ctx.systemPrompt.section({
    name: MEMORY_SECTION_NAME,
    order: MEMORY_SECTION_ORDER,
    // Evaluated per assembly, so memory that changes between turns is picked
    // up without re-registering the section.
    text: () => memory(),
  })
}
