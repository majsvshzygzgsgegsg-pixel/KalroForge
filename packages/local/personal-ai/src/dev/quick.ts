/**
 * Quick commands without a model round trip. When a typed request is a
 * plain Mac command, that step is served by a local "instant" route which
 * issues the one matching mac_action call — through the normal tool and
 * permission path — and, once it succeeds, a one-line reply. A failed call
 * hands the rest of the turn back to the Session's own model.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmProviderInfo, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { isTopLevelSession, messageBody } from '@local/main-agents'
import { CURSOR_COMPUTER } from '../core/cursor-hands.ts'
import { parseQuickCommand, type AppResolver } from '../core/quick-commands.ts'
import { isScreenRequest } from '../core/voice-tools.ts'
import { resolveInstalledApp } from './apps.ts'

/** The local route that serves quick-command steps. */
export const INSTANT_PROVIDER = 'kairoforge-instant'
const INSTANT_MODEL = 'quick-commands'
const MAC_ACTION = 'mac_action'

interface Plan {
  readonly turn: number
  readonly step: number
  readonly callId: string
  /** The one tool call to issue. */
  readonly call: { readonly name: string; readonly args: object }
  /** The reply once it succeeded; undefined replies with the tool's own `reply`. */
  readonly done?: string
  ok?: boolean
}

/** Screen requests that are about Holo Hands, not the computer. */
const HOLO = /\bholo\b/i

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallChunks(callId: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(callId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * Serves the planned quick command for the calling Session — the tool call first, then the reply — or,
 * after the model's own Cursor calls all succeeded, Cursor's status as the reply.
 */
class InstantAdapter extends LlmAdapter {
  constructor(
    private readonly planOf: (sessionId: string) => Plan | undefined,
    private readonly cursorReplyOf: (sessionId: string) => string | undefined,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'KairoForge quick commands' }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    const sessionId = options.sessionId === undefined ? '' : String(options.sessionId)
    const plan = this.planOf(sessionId)
    if (plan === undefined) {
      yield * textChunks(this.cursorReplyOf(sessionId) ?? 'I lost track of that request; please say it again.')
      return
    }
    const answer = options.messages.find(message =>
      'role' in message && message.role === 'tool' && String(message.toolCallId) === plan.callId)
    if (answer === undefined) {
      yield * toolCallChunks(plan.callId, plan.call.name, plan.call.args)
      return
    }
    yield * textChunks(plan.done ?? replyOf(answer) ?? 'Done.')
  }
}

/** The `reply` field of a JSON tool result. */
function replyOf(message: object): string | undefined {
  const content = (message as { content?: unknown }).content
  const text = Array.isArray(content)
    ? content.map((block) => {
      const { type, text: body } = block as { type?: unknown; text?: unknown }
      return type === 'text' && typeof body === 'string' ? body : ''
    }).join('')
    : typeof content === 'string' ? content : ''
  try {
    const reply = (JSON.parse(text) as { reply?: unknown }).reply
    return typeof reply === 'string' && reply.trim() !== '' ? reply.trim() : undefined
  } catch {
    return undefined
  }
}

function lastUserRequest(messages: readonly UserMessage[]): string | undefined {
  for (const message of messages.toReversed()) {
    if (message.source.kind !== 'user') continue
    return messageBody(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
  }
  return undefined
}

/**
 * Install quick commands on every top-level Session that has mac_action (macOS only).
 * While Cursor is the hands, screen requests (clicking, the mouse, "take control") go straight to `cursor_computer`.
 * @param ctx - Host context.
 * @param resolve - maps a spoken app name to an installed app.
 * @param cursorHands - whether Cursor is the hands right now.
 */
export function installQuickCommands(
  ctx: Context,
  resolve: AppResolver = resolveInstalledApp,
  cursorHands: () => boolean = () => false,
): void {
  if (process.platform !== 'darwin') return
  const plans = new Map<string, Plan>()
  const routes = new Map<string, { readonly provider: string; readonly model: string }>()
  /** Tool calls each Session finished since its last model request. */
  const settled = new Map<string, Array<{ readonly name: string; readonly reply?: string }>>()
  /** Cursor's status, served as the reply of the step after the model's own Cursor calls. */
  const cursorReplies = new Map<string, string>()
  ctx.llm.registerAdapter([INSTANT_PROVIDER], new InstantAdapter(sessionId => plans.get(sessionId), (sessionId) => {
    const reply = cursorReplies.get(sessionId)
    cursorReplies.delete(sessionId)
    return reply
  }))
  // Any top-level Session that can run mac_action (Lead, Fast, editor, and main-agent Sessions alike).
  const has = (agent: Agent, tool: string): boolean => {
    if (!isTopLevelSession(agent.session.header)) return false
    const scope = scopeOf(agent.ctx)
    return scope !== undefined && ctx.tools.get(tool, scope) !== undefined
  }
  const planFor = (agent: Agent, request: string): Pick<Plan, 'call' | 'done'> | undefined => {
    // A plain command fires its tested AppleScript at once — no model at all, so faster than any route through Cursor.
    const command = parseQuickCommand(request, resolve)
    if (command !== undefined && has(agent, MAC_ACTION)) {
      return { call: { name: MAC_ACTION, args: { action: command.action, ...command.args } }, done: command.done }
    }
    const forCursor = cursorHands() && has(agent, CURSOR_COMPUTER) && isScreenRequest(request) && !HOLO.test(request)
    return forCursor ? { call: { name: CURSOR_COMPUTER, args: { task: request } } } : undefined
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const sessionId = payload.agent.session.id
    const request = lastUserRequest(payload.messages)
    if (request === undefined) return decision
    plans.delete(sessionId)
    if (decision.kind !== 'enter') return decision
    const plan = planFor(payload.agent, request)
    if (plan !== undefined) plans.set(sessionId, { turn: payload.turn, step: payload.step, callId: `kf-quick-${randomUUID()}`, ...plan })
    return decision
  }, true)

  // The logged header carries the last route forward, so a step after a quick one is put back on the Session's own model.
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const config = await next()
    const sessionId = agent.session.id
    let base = config
    if (config.provider === INSTANT_PROVIDER) {
      const own = routes.get(sessionId) ?? { provider: agent.options.provider ?? '', model: agent.options.model ?? '' }
      base = { ...config, ...own }
    } else {
      routes.set(sessionId, { provider: config.provider, model: config.model })
    }
    const instant = (): typeof base => {
      const { reasoningEffort: _effort, ...rest } = base
      return { ...rest, provider: INSTANT_PROVIDER, model: INSTANT_MODEL }
    }
    const finished = settled.get(sessionId) ?? []
    settled.delete(sessionId)
    const plan = plans.get(sessionId)
    if (plan !== undefined && plan.turn === turn) {
      if (step === plan.step || (step === plan.step + 1 && plan.ok === true)) return instant()
      plans.delete(sessionId)
    } else if (plan !== undefined) {
      plans.delete(sessionId)
    }
    // Every call the model just made was a successful Cursor run: Cursor's status is the reply, without another model round trip.
    if (step > 1 && finished.length > 0 && finished.every(call => call.name === CURSOR_COMPUTER && call.reply !== undefined)) {
      cursorReplies.set(sessionId, finished.map(call => call.reply).join(' '))
      return instant()
    }
    return base
  }, true)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.agent === undefined) return decision
    const sessionId = exec.agent.session.id
    const plan = plans.get(sessionId)
    const ok = !result.isError && decision.kind === 'accept'
    if (plan !== undefined && String(exec.callId) === plan.callId) plan.ok = ok
    const value = result.isError ? undefined : result.value as { reply?: unknown } | null
    const reply = ok && typeof value?.reply === 'string' && value.reply.trim() !== '' ? value.reply.trim() : undefined
    settled.set(sessionId, [...settled.get(sessionId) ?? [], { name: exec.name, ...reply === undefined ? {} : { reply } }])
    return decision
  })
}
