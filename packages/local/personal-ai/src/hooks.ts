/**
 * Runtime hooks for the coordinator. They observe coordinator Sessions to
 * drive the live assistant state and turn metrics, and they can only make the
 * permission path stricter: a SENSITIVE call that the preset would run
 * silently becomes a normal confirmation. They never turn an `ask` or `deny`
 * into an `allow`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { textOf } from '@local/main-agents'
import { isDelegatingTool } from './core/assistant-state.ts'
import { classifyRisk } from './core/risk.ts'
import type { Config } from './index.ts'
import type { PersonalAi } from './service.ts'

/** Personal AI tools whose SENSITIVE calls always ask, whatever the preset says. */
const OWN_GATED = new Set(['forget', 'archive_project', 'remember', 'create_tool'])

interface UserMessageData { readonly source?: { readonly kind?: string; readonly form?: string } }

function toolCallCount(content: unknown): number {
  if (!Array.isArray(content)) return 0
  return content.filter(block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call').length
}

/**
 * Install coordinator hooks.
 * @param ctx - Host context.
 * @param service - Personal AI service.
 * @param config - plugin configuration.
 */
export function installPersonalAiHooks(ctx: Context, service: PersonalAi, config: Config): void {
  ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked' || event.type === 'approval/decided') {
      service.noteApproval(session.id, (event.data as { id: string }).id, event.type === 'approval/asked')
    }
    if (event.type === 'approval/asked') service.noteConversationApproval(session.id)
    if (event.type === 'assistant/message') {
      const content = (event.data as { message: { content: unknown } }).message.content
      service.noteConversationMessage(session.id, textOf(content), toolCallCount(content))
    }
    const live = service.coordinatorLive(session.id)
    if (live === undefined) return
    switch (event.type) {
      case 'user/message': {
        const source = (event.data as UserMessageData).source
        if (source?.kind === 'user' && source.form === undefined) service.touch(session.id)
        return
      }
      case 'assistant/message': {
        live.steps++
        const usage = (event.data as { usage?: { inputTokens: number; outputTokens: number } }).usage
        if (usage !== undefined) live.tokens += usage.inputTokens + usage.outputTokens
        return
      }
      case 'approval/asked': {
        live.pending.add((event.data as { id: string }).id)
        live.approvals++
        return
      }
      case 'approval/decided': {
        live.pending.delete((event.data as { id: string }).id)
        return
      }
      default:
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    service.noteConversation(agent.session.id, status === 'running' ? 'running' : 'idle')
    const live = service.coordinatorLive(agent.session.id)
    if (live === undefined) return
    if (status === 'running') {
      live.busy = true
      if (live.turnStart === undefined) {
        live.turnStart = Date.now()
        live.steps = 0
        live.toolCalls = 0
        live.approvals = 0
        live.tokens = 0
        live.delegated = false
        live.errored = false
      }
      service.touch(agent.session.id)
      return
    }
    live.busy = false
    delete live.tool
    live.pending.clear()
    void service.finishTurn(agent.session.id).catch((error: unknown) => {
      ctx.logger.warn(`personal-ai: turn metrics not saved: ${String(error)}`)
    })
  })

  ctx.on('agent/error', ({ agent, error }) => {
    service.failConversation(agent.session.id, error instanceof Error ? error.message : String(error))
    const live = service.coordinatorLive(agent.session.id)
    if (live === undefined) return
    live.errored = true
    service.notify({ level: 'error', kind: 'turn-error', text: `The last request failed: ${error instanceof Error ? error.message : String(error)}` })
  })

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const decision = await next()
    const sessionId = exec.agent?.session.id
    if (sessionId === undefined || decision.kind !== 'allow') return decision
    const live = service.coordinatorLive(sessionId)
    // A main agent may hold a full-access preset; its sensitive calls still ask the user.
    const mainAgent = live === undefined && ctx.get('mainAgents')?.recordForSession(sessionId) !== undefined
    if (live === undefined && !mainAgent) {
      service.noteConversationTool(sessionId, exec.name, exec.arguments)
      return decision
    }
    const mode = exec.agent === undefined ? undefined : ctx.get('mainAgents')?.modeOf(exec.agent)
    const directPush = mode !== undefined && (ctx.get('orchestration')?.settings().checkpoints.directPushModes ?? []).includes(mode)
    const risk = classifyRisk(exec.name, exec.arguments, { directPush })
    const gated = risk.risk === 'SENSITIVE' && (OWN_GATED.has(exec.name) || config.confirmSensitive)
    if (gated) {
      return {
        kind: 'ask',
        reason: `Sensitive action: ${risk.reason}`,
        displayReason: { en: `Sensitive action — ${risk.reason}. Confirm to continue.`, zh: `敏感操作 — ${risk.reason}。确认后继续。` },
      }
    }
    if (live === undefined) return decision
    live.tool = exec.name
    service.noteConversationTool(sessionId, exec.name, exec.arguments)
    return decision
  })

  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const agent = exec.agent
    const live = agent === undefined ? undefined : service.coordinatorLive(agent.session.id)
    if (live !== undefined) {
      live.toolCalls++
      if (isDelegatingTool(exec.name)) live.delegated = true
      if (live.tool === exec.name) delete live.tool
    }
    return next()
  })
}
