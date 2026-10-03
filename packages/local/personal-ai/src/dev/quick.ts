/**
 * Quick commands without a model round trip. When a coordinator request is a
 * plain Mac command, that step is served by a local "instant" route which
 * issues the one matching mac_action call — through the normal tool and
 * permission path — and, once it succeeds, a one-line reply. A failed call
 * hands the rest of the turn back to the Session's own model.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmProviderInfo, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { messageBody } from '@local/main-agents'
import { parseQuickCommand, type AppResolver, type QuickCommand } from '../core/quick-commands.ts'
import type { PersonalAi } from '../service.ts'
import { resolveInstalledApp } from './apps.ts'

/** The local route that serves quick-command steps. */
export const INSTANT_PROVIDER = 'kairoforge-instant'
const INSTANT_MODEL = 'quick-commands'
const MAC_ACTION = 'mac_action'

interface Plan {
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly command: QuickCommand
  ok?: boolean
}

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

/** Serves the planned quick command for the calling Session: the tool call first, then the reply. */
class InstantAdapter extends LlmAdapter {
  constructor(private readonly planOf: (sessionId: string) => Plan | undefined) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'KairoForge quick commands' }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    const plan = options.sessionId === undefined ? undefined : this.planOf(String(options.sessionId))
    if (plan === undefined) {
      yield * textChunks('I lost track of that request; please say it again.')
      return
    }
    const answered = options.messages.some(message =>
      'role' in message && message.role === 'tool' && String(message.toolCallId) === plan.callId)
    const { action, args } = plan.command
    yield * answered ? textChunks(plan.command.done) : toolCallChunks(plan.callId, MAC_ACTION, { action, ...args })
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
 * Install quick commands on coordinator Sessions (macOS only).
 * @param ctx - Host context.
 * @param service - Personal AI service.
 * @param resolve - maps a spoken app name to an installed app.
 */
export function installQuickCommands(ctx: Context, service: PersonalAi, resolve: AppResolver = resolveInstalledApp): void {
  if (process.platform !== 'darwin') return
  const plans = new Map<string, Plan>()
  const routes = new Map<string, { readonly provider: string; readonly model: string }>()
  ctx.llm.registerAdapter([INSTANT_PROVIDER], new InstantAdapter(sessionId => plans.get(sessionId)))

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const sessionId = payload.agent.session.id
    const request = lastUserRequest(payload.messages)
    if (request === undefined) return decision
    plans.delete(sessionId)
    if (decision.kind !== 'enter' || service.coordinatorLive(sessionId) === undefined) return decision
    const command = parseQuickCommand(request, resolve)
    if (command !== undefined) plans.set(sessionId, { turn: payload.turn, step: payload.step, callId: `kf-quick-${randomUUID()}`, command })
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
    const plan = plans.get(sessionId)
    if (plan === undefined || plan.turn !== turn) return base
    if (step === plan.step || (step === plan.step + 1 && plan.ok === true)) {
      const { reasoningEffort: _effort, ...rest } = base
      return { ...rest, provider: INSTANT_PROVIDER, model: INSTANT_MODEL }
    }
    plans.delete(sessionId)
    return base
  }, true)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const plan = exec.agent === undefined ? undefined : plans.get(exec.agent.session.id)
    if (plan !== undefined && String(exec.callId) === plan.callId) plan.ok = !result.isError && decision.kind === 'accept'
    return decision
  })
}
