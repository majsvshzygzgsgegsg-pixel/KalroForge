/**
 * Exclusive computer use through an installed Cua Driver MCP executable.
 * The MCP client owns discovery, execution, image admission, and reconnection.
 * @module
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-computer-use'

/** Cordis plugin identity for the installed Cua Driver provider. */
export const name = 'experimental-computer-use-cua-driver-mcp'

/** The shared reservation and tool registry must exist before connection. */
export const inject = ['computerUse', 'tools']

/** Installed executable and MCP connection overrides. */
export interface Config {
  /** Executable path or PATH command; defaults to `cua-driver`. */
  command: string
  /** Arguments passed without a shell; defaults to `['mcp']`. */
  args: string[]
  /** Per-call timeout in milliseconds; omission uses the MCP client's default. */
  toolCallTimeoutMs?: number
  /** Reconnection overrides; defaults to the MCP client's policy. */
  reconnect: McpClient.ReconnectConfig
  /** Keep the driver's visible agent cursor on, so the user can watch every pointer and keyboard action. */
  agentCursor: boolean
}

/** Validate executable options; the MCP client resolves connection defaults. */
export const Config: z<Partial<Config>, Config> = z.object({
  command: z.string().pattern(/[^\s]/u).default('cua-driver'),
  args: z.array(String).default(['mcp']),
  toolCallTimeoutMs: z.number().min(1),
  reconnect: z.object({
    enabled: z.boolean(),
    initialDelayMs: z.number().min(1),
    maxDelayMs: z.number().min(1),
    maxAttempts: z.number().min(1).step(1),
  }),
  agentCursor: z.boolean().default(false),
})

const SERVER_NAME = 'cua-driver-mcp'
const PREFIX = `mcp__${SERVER_NAME}__`
const CURSOR_TOOL = `${PREFIX}set_agent_cursor_enabled`
/** Tools that only read state, or manage the cursor themselves, never re-enable it. */
const PASSIVE = /^(?:get_|list_|check_|health_|verify_|describe|set_agent_cursor_|start_session|end_session|zoom$)/
/** The driver's implicit session expires after five idle minutes; re-enable well before. */
const CURSOR_REFRESH_MS = 60_000

/** Keys of structured results that only repeat the text content. */
const TEXT_DUPLICATES = new Set(['_note', 'tree_markdown'])

/** Structured text beyond this many characters is cut; `max_elements` bounds a large window. */
const STRUCTURED_TEXT_LIMIT = 60_000

/**
 * The model sees only text content, while window ids and element tokens exist
 * only in `structuredContent`; render it as one compact JSON text block.
 * @param value - canonical MCP result value.
 * @returns the text, or undefined when the result has nothing structured to add.
 */
export function structuredText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const structured = (value as { structuredContent?: unknown }).structuredContent
  if (typeof structured !== 'object' || structured === null) return undefined
  const kept = Array.isArray(structured)
    ? structured
    : Object.fromEntries(Object.entries(structured).filter(([key]) => !TEXT_DUPLICATES.has(key)))
  let text = JSON.stringify(kept)
  if (text === '{}' || text === '[]') return undefined
  if (text.length > STRUCTURED_TEXT_LIMIT) {
    text = `${text.slice(0, STRUCTURED_TEXT_LIMIT)}… [structured result cut at ${String(STRUCTURED_TEXT_LIMIT)} characters; pass max_elements or max_depth]`
  }
  return `structured: ${text}`
}

/**
 * Reserve computer use and activate the installed Cua Driver's MCP tools.
 * Initial connection or discovery failure rejects activation and rolls back.
 * Disposal retains the reservation until the MCP child has finished teardown.
 * @param ctx - context providing computer use and the tool registry.
 * @param config - validated executable options and optional connection overrides.
 * @returns initial MCP tool-discovery completion.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const connection = McpClient.Config({
    command: config.command,
    args: config.args,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    reconnect: config.reconnect,
    transport: 'stdio',
    serverName: SERVER_NAME,
    failOnStartupError: true,
  })
  // One effect orders child shutdown before release; separate fiber effects
  // unload concurrently and could otherwise admit another live driver.
  let child!: Fiber
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName(SERVER_NAME))
    child = ctx.plugin(McpClient, connection)
    yield child.dispose
  }, 'computer-use-cua-driver-mcp.connection')

  let cursorAt = Number.NEGATIVE_INFINITY
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (!exec.name.startsWith(PREFIX)) return next()
    if (config.agentCursor && !PASSIVE.test(exec.name.slice(PREFIX.length)) && Date.now() - cursorAt > CURSOR_REFRESH_MS) {
      const cursor = ctx.tools.get(CURSOR_TOOL)
      if (cursor !== undefined) {
        // A missing overlay must not block the action it would have shown.
        const quiet = { ...exec, deferContext() {}, concludeTurn() {} }
        await Promise.resolve(cursor.execute({ enabled: true }, quiet)).then(() => { cursorAt = Date.now() }, () => undefined)
      }
    }
    return next()
  })
  // Content, not value: replacing the value would void the MCP client's image projection.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!exec.name.startsWith(PREFIX) || result.isError || decision.kind !== 'accept') return decision
    if (Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision
    const text = structuredText(result.value)
    if (text === undefined) return decision
    return {
      kind: 'accept',
      content: [...result.content, { type: 'text', text }],
      ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
    }
  })
  await child.await()
}
