/**
 * Runtime hooks for orchestration. Every hook observes or enriches through the
 * existing waterfalls and never bypasses them:
 *
 * - `session/event`, `agent/status`, `agent/error`: telemetry, worker and
 *   background-task completion, turn boundaries for automatic checkpoints.
 * - `tools/pre-execute`: protected-branch and uncommitted-work Git guard
 *   (deny or ask through the normal approval path), message ping-pong guard,
 *   and the automatic checkpoint before the first mutating call of a turn.
 * - `tools/post-execute`: recent tool calls, touched files, test results,
 *   loop detection with recovery guidance, and rollback proposals.
 * - `agent/request`: model routing, recorded with its reason.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContextFormed, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { headState, repoRoot } from './git.ts'
import { describeCall, escalationGuidance, recoveryGuidance, type LoopDetection } from './loop-detector.ts'
import { messageBody, route } from './routing.ts'
import { textOf, shortId, type Orchestrator } from './service.ts'
import { gitGuard, isReadOnlyCommand, isTestCommand } from './shell-policy.ts'
import type { RouteDecision } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'kairoforge-orchestration': { kind: 'kairoforge-orchestration' } & ContextFormed
  }
}

const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'str_replace'])
const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const DIAGNOSIS_TOOLS = new Set(['spawn_teammate', 'delegate_to_main_agent', 'request_agent_review', 'subagent'])
const MESSAGE_TOOLS = new Set(['send_agent_message'])

function stringArg(args: unknown, ...names: string[]): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  for (const name of names) {
    const value = (args as Record<string, unknown>)[name]
    if (typeof value === 'string') return value
  }
  return undefined
}

interface UserMessageData { readonly content: unknown; readonly source?: { readonly kind?: string; readonly form?: string } }

/** Injected context (runtime snapshots, notices) is not a request from the user or another agent. */
function isInjected(message: UserMessageData): boolean {
  return message.source?.form !== undefined || message.source?.kind === 'runtime-context'
}

/** Text and image presence of the last real request among `messages`, if any. */
function lastRequest(messages: readonly UserMessageData[]): { text: string; hasImage: boolean } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message === undefined || isInjected(message)) continue
    const text = textOf(message.content)
    const hasImage = Array.isArray(message.content) && message.content.some(block => (block as { type?: string }).type === 'image')
    if (text !== '' || hasImage) return { text: text.slice(0, 4000), hasImage }
  }
  return undefined
}

/**
 * Undo a previous routing choice in the proposed request config. The agent loop seeds later requests from the
 * last logged header, which carries the routed model; when the proposal is exactly that choice, the Session's own
 * model (recorded with the decision) is what it really asked for. A different proposal is a deliberate model change.
 */
function sessionModel(config: LlmCallConfig, prior: RouteDecision | undefined): LlmCallConfig {
  if (prior?.routed !== true || prior.base === undefined) return config
  if (config.provider !== prior.provider || config.model !== prior.model) return config
  const { reasoningEffort: _effort, maxTokens: _max, ...rest } = config
  return {
    ...rest,
    provider: prior.base.provider,
    model: prior.base.model,
    ...prior.base.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(prior.base.reasoningEffort) },
    ...prior.base.maxTokens === undefined ? {} : { maxTokens: prior.base.maxTokens },
  }
}

function notice(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'kairoforge-orchestration', form: 'notice', summary: summary.slice(0, 110) } as never,
  })
}

function outcomeOf(
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
): { ok: boolean; exitCode: number | null | undefined; error?: string } {
  const shell = SHELL_TOOLS.has(exec.name)
  const value = result.isError ? undefined : result.value as { exitCode?: number | null } | null
  const exitCode = shell && value !== null && typeof value === 'object' ? value.exitCode : undefined
  const ok = !result.isError && (exitCode === undefined || exitCode === 0)
  if (ok) return { ok, exitCode }
  const text = textOf(result.content)
  const error = (text === '' ? result.isError ? result.error.message : `exit code ${String(exitCode)}` : text).slice(-800)
  return { ok, exitCode, error }
}

/**
 * Install orchestration hooks.
 * @param ctx - Host context.
 * @param service - orchestration service.
 */
export function installOrchestrationHooks(ctx: Context, service: Orchestrator): void {
  /** Detections that recurred after guidance, escalated on that Session's current call. */
  const escalations: Array<{ readonly sessionId: string; readonly detection: LoopDetection }> = []

  ctx.on('session/event', (session, event) => {
    const sessionId = session.id
    // Queued prompts are inbox splices before they are committed as user messages, and the first request of
    // their turn (where routing decides) is prepared in between.
    if (event.type === 'user/message' || event.type === 'agent/inbox/spliced') {
      const messages = event.type === 'user/message'
        ? [event.data as UserMessageData]
        : (event.data as { inserted: readonly UserMessageData[] }).inserted
      const request = lastRequest(messages)
      if (request === undefined) return
      const telemetry = service.telemetryOf(sessionId)
      telemetry.lastUserText = request.text
      telemetry.lastUserHasImage = request.hasImage
      if (event.type === 'user/message' && messages[0]?.source?.kind === 'user') service.detectorOf(sessionId).reset()
      return
    }
    if (event.type === 'assistant/message') {
      const data = event.data as {
        message: { content: unknown; provider?: string; model?: string }
        usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
      }
      const telemetry = service.telemetryOf(sessionId)
      telemetry.steps++
      const text = textOf(data.message.content)
      if (text !== '') {
        telemetry.lastAssistantText = text.slice(0, 20_000)
        telemetry.erroredTurn = false
      }
      if (data.usage !== undefined) {
        const usage = data.usage
        telemetry.contextTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
      }
      const { provider, model } = data.message
      if (provider !== undefined && model !== undefined) service.noteModel(sessionId, provider, model)
      service.background.onActivity(sessionId)
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = agent.session.id
    const telemetry = service.telemetryOf(sessionId)
    if (status === 'running') {
      telemetry.busySince ??= Date.now()
      telemetry.erroredTurn = false
    } else {
      if (telemetry.busySince !== undefined) telemetry.runtimeMs += Date.now() - telemetry.busySince
      delete telemetry.busySince
      if (agent.session.header.parentSession === undefined) service.checkpoints.endTurn(sessionId)
    }
    service.workflows.onStatus(sessionId, status)
    service.background.onStatus(sessionId, status)
  })

  ctx.on('agent/error', ({ agent, error }) => {
    const message = error instanceof Error ? error.message : String(error)
    service.recordError(agent.session.id, message)
    service.workflows.onError(agent.session.id, message)
  })

  ctx.on('agent/disposed', ({ agent }) => { service.forget(agent.session.id) })

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined) return next()
    const managed = service.isManaged(agent)
    const settings = service.settings()
    const cwd = agent.session.header.cwd ?? process.cwd()

    if (MESSAGE_TOOLS.has(exec.name) && agent.session.header.parentSession === undefined) {
      const refusal = service.delegations.admitMessage(agent.session.id, stringArg(exec.arguments, 'agent_id') ?? '')
      if (refusal !== undefined) return { kind: 'deny', reason: refusal }
    }

    const command = SHELL_TOOLS.has(exec.name) ? stringArg(exec.arguments, 'command') ?? '' : ''
    let guard: ReturnType<typeof gitGuard>
    const directPush = settings.checkpoints.directPushModes.includes(service.registry.modeOf(agent))
    if ((managed || directPush) && /\bgit\b/.test(command)) {
      const root = await repoRoot(cwd)
      const branch = root === undefined ? undefined : (await headState(root)).branch
      guard = gitGuard(command, branch, settings.checkpoints.protectedBranches, { directPush })
      if (guard?.kind === 'deny') return { kind: 'deny', reason: guard.reason }
      // Direct-push sessions outside Main Agents keep their own approval rules; only the hard denials apply.
      if (!managed) guard = undefined
    }

    const decision = await next()
    if (decision.kind === 'deny' || decision.kind === 'cancel') return decision

    const mutating = EDIT_TOOLS.has(exec.name) || (command !== '' && !isReadOnlyCommand(command))
    if (managed && mutating && settings.checkpoints.auto && !service.workflows.isWorker(agent.session.id)) {
      const root = service.rootSessionOf(agent.session.id)
      const task = messageBody(service.peekTelemetry(root)?.lastUserText ?? '').slice(0, 300)
      await service.checkpoints.ensureTurnCheckpoint(root, cwd, service.actorOf(agent), task)
    }

    if (guard?.kind === 'ask' && decision.kind === 'allow') {
      return { kind: 'ask', reason: `${guard.reason} (${exec.name})`, displayReason: { en: `${guard.reason}.`, zh: `${guard.reason}。` } }
    }
    return decision
  })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    const agent = exec.agent
    if (agent === undefined) return downstream
    const sessionId = agent.session.id
    const root = service.rootSessionOf(sessionId)
    const cwd = agent.session.header.cwd ?? process.cwd()
    const outcome = outcomeOf(exec, result)
    const call = { name: exec.name, args: exec.arguments, ok: outcome.ok, ...outcome.error === undefined ? {} : { error: outcome.error } }
    service.recordTool(sessionId, {
      name: exec.name, summary: describeCall(call), ok: outcome.ok, ...outcome.error === undefined ? {} : { error: outcome.error },
    })
    service.background.onActivity(sessionId, exec.name)
    const contexts: UserMessage[] = []

    if (outcome.ok && EDIT_TOOLS.has(exec.name)) {
      const path = stringArg(exec.arguments, 'path', 'file_path')
      if (path !== undefined) await service.checkpoints.noteTouched(root, cwd, path).catch(() => undefined)
    }

    const command = SHELL_TOOLS.has(exec.name) ? stringArg(exec.arguments, 'command') ?? '' : ''
    if (command !== '' && isTestCommand(command)) {
      const broke = await service.checkpoints.noteTestRun(root, {
        command: command.slice(0, 300), ok: outcome.ok, exitCode: outcome.exitCode ?? null, at: new Date().toISOString(),
      }).catch(() => undefined)
      if (broke !== undefined && service.isManaged(agent)) {
        contexts.push(notice([
          '<system-reminder>',
          `[KairoForge checkpoint] Tests or the build passed at checkpoint ${broke.id} (${broke.testsBefore?.command ?? 'earlier run'}) but now fail.`,
          'Diagnose the regression first. If the damage is broad and you cannot fix it quickly, inspect compare_checkpoint and propose a rollback with propose_rollback; the user decides whether to restore.',
          '</system-reminder>',
        ].join('\n'), `checkpoint ${broke.id}: tests regressed`))
      }
    }

    if (service.settings().loops.enabled) {
      const detector = service.detectorOf(sessionId)
      if (DIAGNOSIS_TOOLS.has(exec.name)) {
        const recent = service.loops(new Set([sessionId])).find(event => event.outcome === 'recovering')
        if (recent !== undefined && recent.delegatedDiagnosis !== true) void service.updateLoop(recent.id, { delegatedDiagnosis: true })
      }
      const canDelegate = ctx.get('agentTeams') !== undefined && agent.session.header.origin !== 'subagent'
      const owner = service.mainAgentOf(sessionId)
      const ownerId = owner === undefined ? {} : { agentId: owner.id }
      const actor = service.actorOf(agent)
      let recurredDetection: LoopDetection | undefined
      const detection = detector.observe(call)
      // Watchers settle inside observe(), so a recurrence seen on this call is known here.
      for (const watched of escalations.splice(0)) {
        if (watched.sessionId === sessionId) recurredDetection = watched.detection
        else escalations.push(watched)
      }
      if (recurredDetection !== undefined) {
        service.notify({ level: 'warning', kind: 'loop', text: `${actor.name}: the loop recurred after recovery guidance; escalated.`, ...ownerId })
        contexts.push(notice(escalationGuidance(recurredDetection, canDelegate), `loop escalation: ${recurredDetection.kind}`))
      }
      if (detection !== undefined) {
        const id = shortId('loop')
        await service.saveLoop({
          id, sessionId, agentName: actor.name, kind: detection.kind, summary: detection.summary,
          attempts: detection.attempts.slice(0, 8), at: new Date().toISOString(), outcome: 'recovering',
        })
        detector.watch(detection.key, (recurred) => {
          void service.updateLoop(id, { outcome: recurred ? 'recurred' : 'recovered' })
          if (recurred) escalations.push({ sessionId, detection })
        })
        service.notify({ level: 'warning', kind: 'loop', text: `${actor.name}: ${detection.summary} Recovery started.`, ...ownerId })
        contexts.push(notice(recoveryGuidance(detection, canDelegate), `loop recovery: ${detection.kind}`))
      }
    }

    if (contexts.length === 0) return downstream
    return { ...downstream, additionalContexts: [...contexts, ...downstream.additionalContexts ?? []] }
  })

  ctx.on('agent/request', async ({ agent }, next) => {
    const proposed = await next()
    const sessionId = agent.session.id
    const config = sessionModel(proposed, service.routeOf(sessionId))
    const settings = service.settings().routing
    const managed = service.isManaged(agent)
    if (settings.scope === 'managed' && !managed) return config
    const owner = service.mainAgentOf(sessionId)
    const meta = owner === undefined ? undefined : service.meta(owner.id)
    const telemetry = service.telemetryOf(sessionId)
    const available = new Set((ctx.get('llm')?.listProviders() ?? []).map(provider => provider.id))
    const decision = route(settings, {
      mode: service.registry.modeOf(agent),
      ...meta?.template === undefined ? {} : { template: meta.template },
      ...meta?.routing === undefined ? {} : { override: meta.routing },
      lastUserText: telemetry.lastUserText,
      hasImage: telemetry.lastUserHasImage,
      worker: agent.session.header.origin === 'subagent',
    }, { provider: config.provider, model: config.model }, available)
    const chosen = decision.routed && decision.model !== undefined ? decision.model : { provider: config.provider, model: config.model }
    void service.saveRoute({
      sessionId,
      category: decision.category,
      provider: chosen.provider,
      model: chosen.model,
      routed: decision.routed,
      reason: decision.reason,
      at: new Date().toISOString(),
      base: {
        provider: config.provider,
        model: config.model,
        ...config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) },
        ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
      },
    }).catch(() => undefined)
    if (!decision.routed || decision.model === undefined) return config
    // The Session's effort and output cap belong to its own model; the routed model uses its own defaults.
    const { reasoningEffort: _effort, maxTokens: _max, ...rest } = config
    return {
      ...rest,
      provider: decision.model.provider,
      model: decision.model.model,
      ...decision.model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(decision.model.reasoningEffort) },
    }
  })
}
