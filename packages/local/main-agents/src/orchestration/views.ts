/**
 * Read models for the Agents UI: one main agent's activity dashboard and the
 * orchestration tree (Lead → main agents → sub-agents and workflow workers).
 * Everything here is assembled from the registry, Agent Team rosters, durable
 * orchestration records, and redacted live telemetry; no secrets are read.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { isTopLevelSession } from '../registry.ts'
import type { MainAgentView } from '../types.ts'
import { messageBody } from './routing.ts'
import type { Orchestrator, OrchestrationNotification, ToolCallView } from './service.ts'
import { TEMPLATES } from './templates.ts'
import type {
  AgentMeta, BackgroundTaskRecord, CheckpointRecord, DelegationRecord, LoopEvent, LoopMetrics, OrchestrationSettings, RouteDecision,
  WorkflowRecord,
} from './types.ts'

/** Working directory of a live Session, else the agent's assigned workspace. */
function cwdOf(live: Agent | undefined, agent: MainAgentView): { cwd?: string } {
  const cwd = live?.session.header.cwd ?? agent.workspace
  return cwd === undefined ? {} : { cwd }
}

/** One sub-agent row. */
export interface SubAgentView {
  readonly name: string
  readonly sessionId: string
  readonly status: string
  readonly description?: string
  readonly workflowTask?: { readonly workflowId: string; readonly taskId: string }
}

/** One queued/running/finished unit of work attributed to an agent. */
export interface WorkItemView {
  readonly id: string
  readonly kind: 'workflow-task' | 'background' | 'delegation'
  readonly title: string
  readonly status: string
  readonly at: string
}

/** Activity dashboard for one main agent. */
export interface AgentDashboard {
  readonly agent: MainAgentView
  readonly template?: string
  readonly routing: NonNullable<AgentMeta['routing']>
  readonly live: {
    readonly status: 'busy' | 'idle' | 'unloaded'
    readonly currentTask?: string
    readonly provider?: string
    readonly model?: string
    readonly contextTokens?: number
    readonly contextWindow?: number
    readonly runtimeMs: number
    readonly steps: number
    readonly toolCalls: number
    readonly cwd?: string
    readonly tools: readonly string[]
  }
  readonly route?: RouteDecision
  readonly subAgents: readonly SubAgentView[]
  readonly work: {
    readonly queued: WorkItemView[]
    readonly running: WorkItemView[]
    readonly completed: WorkItemView[]
    readonly failed: WorkItemView[]
  }
  readonly recentTools: readonly ToolCallView[]
  readonly workflows: readonly WorkflowRecord[]
  readonly checkpoints: readonly CheckpointRecord[]
  readonly delegations: readonly DelegationRecord[]
  readonly background: readonly BackgroundTaskRecord[]
  readonly loops: readonly LoopEvent[]
  readonly errors: ReadonlyArray<{ readonly at: string; readonly text: string }>
  readonly activity: ReadonlyArray<{ readonly at: string; readonly kind: string; readonly text: string }>
}

/** One node of the orchestration tree. */
export interface OrchestrationNode {
  readonly id: string
  readonly kind: 'lead' | 'main-agent' | 'sub-agent'
  readonly name: string
  readonly status: string
  readonly sessionId?: string
  readonly agentId?: string
  readonly detail?: string
  readonly children: readonly OrchestrationNode[]
}

/** Full orchestration state for the UI. */
export interface OrchestrationState {
  readonly tree: readonly OrchestrationNode[]
  readonly workflows: readonly WorkflowRecord[]
  readonly delegations: readonly DelegationRecord[]
  readonly background: readonly BackgroundTaskRecord[]
  readonly checkpoints: readonly CheckpointRecord[]
  readonly loops: readonly LoopEvent[]
  readonly loopMetrics: LoopMetrics
  readonly routes: readonly RouteDecision[]
  readonly notifications: readonly OrchestrationNotification[]
  readonly settings: OrchestrationSettings
  readonly templates: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

function liveMembers(service: Orchestrator, live: Agent | undefined): SubAgentView[] {
  const teams = service.host.get('agentTeams')
  if (live === undefined || teams === undefined) return []
  try {
    return teams.listMembers(live).filter(member => member.role === 'teammate').map((member) => {
      const sessionId = String(member.id)
      const task = service.workflows.list(new Set([live.session.id])).flatMap(workflow => workflow.tasks.map(item => ({ workflow, item })))
        .find(({ item }) => item.workerSessionId === sessionId)
      return {
        name: member.name,
        sessionId,
        status: member.status === 'running' ? 'running' : member.status === 'failed' ? 'failed' : member.status === 'provisioning' ? 'starting' : 'idle',
        ...member.description === undefined ? {} : { description: member.description },
        ...task === undefined ? {} : { workflowTask: { workflowId: task.workflow.id, taskId: task.item.id } },
      }
    })
  } catch {
    return []
  }
}

function liveAgent(service: Orchestrator, sessionId: string | undefined): Agent | undefined {
  return sessionId === undefined ? undefined : service.host.agents.get(SessionId(sessionId))
}

/**
 * Build one main agent's activity dashboard.
 * @param service - orchestration service.
 * @param idOrName - main agent id or name.
 * @returns the dashboard.
 */
export async function agentDashboard(service: Orchestrator, idOrName: string): Promise<AgentDashboard> {
  const agent = await service.registry.get(idOrName)
  const sessions = new Set([...agent.previousSessionIds, ...agent.sessionId === undefined ? [] : [agent.sessionId]])
  const live = liveAgent(service, agent.sessionId)
  const telemetry = agent.sessionId === undefined ? undefined : service.peekTelemetry(agent.sessionId)
  const meta = service.meta(agent.id)
  const workflows = service.workflows.list(sessions).slice(0, 10)
  const background = service.background.list(agent.id).slice(0, 20)
  const delegations = service.delegations.list(sessions).slice(0, 20)
  const runningBackground = background.find(task => task.status === 'running')
  const openDelegation = delegations.find(record => record.status === 'open' && sessions.has(record.toSessionId))

  const items: WorkItemView[] = [
    ...workflows.flatMap(workflow => workflow.tasks.map(task => ({
      id: `${workflow.id}/${task.id}`, kind: 'workflow-task' as const, title: `${task.title} (${task.role})`,
      status: task.status, at: task.finishedAt ?? task.startedAt ?? workflow.createdAt,
    }))),
    ...background.map(task => ({ id: task.id, kind: 'background' as const, title: task.title, status: task.status, at: task.finishedAt ?? task.startedAt ?? task.createdAt })),
    ...delegations.filter(record => sessions.has(record.toSessionId)).map(record => ({
      id: record.id, kind: 'delegation' as const, title: `${record.kind === 'review' ? 'Review' : 'Task'} from ${record.from.name}: ${record.task.slice(0, 80)}`,
      status: record.status === 'open' ? 'running' : record.status, at: record.completedAt ?? record.createdAt,
    })),
  ].toSorted((a, b) => b.at.localeCompare(a.at))
  const bucket = (statuses: readonly string[]) => items.filter(item => statuses.includes(item.status)).slice(0, 15)

  const busy = live?.status === 'running'
  const currentTask = runningBackground?.title
    ?? (openDelegation === undefined ? undefined : openDelegation.task.slice(0, 200))
    ?? (busy && telemetry !== undefined ? messageBody(telemetry.lastUserText).slice(0, 200) : undefined)
  const route = agent.sessionId === undefined ? undefined : service.routeOf(agent.sessionId)
  let tools: string[] = []
  const scope = live === undefined ? undefined : scopeOf(live.ctx)
  const prompt = service.host.get('systemPrompt')
  if (scope !== undefined && prompt !== undefined) {
    tools = await prompt.assemble({ scope }).then(assembled => assembled.tools.map(tool => tool.name).toSorted(), () => [])
  }
  const notices = service.notifications()
    .filter(notice => notice.agentId === agent.id)
    .map(notice => ({ at: notice.at, kind: notice.kind, text: notice.text }))
  const activity = [...agent.activity.map(line => ({ at: line.at, kind: line.kind, text: line.text })), ...notices]
    .toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, 30)
  const provider = telemetry?.provider ?? route?.provider ?? agent.model?.provider
  const model = telemetry?.model ?? route?.model ?? agent.model?.model
  const currentLive = agent.sessionId === undefined ? undefined : service.peekTelemetry(agent.sessionId)
  const runtimeMs = (currentLive?.runtimeMs ?? 0) + (currentLive?.busySince === undefined ? 0 : Date.now() - currentLive.busySince)

  return {
    agent,
    ...meta.template === undefined ? {} : { template: meta.template },
    routing: meta.routing ?? 'auto',
    live: {
      status: agent.runtime,
      ...currentTask === undefined || currentTask === '' ? {} : { currentTask },
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
      ...telemetry?.contextTokens === undefined ? {} : { contextTokens: telemetry.contextTokens },
      ...telemetry?.contextWindow === undefined ? {} : { contextWindow: telemetry.contextWindow },
      runtimeMs,
      steps: telemetry?.steps ?? 0,
      toolCalls: telemetry?.toolCalls ?? 0,
      ...cwdOf(live, agent),
      tools,
    },
    ...route === undefined ? {} : { route },
    subAgents: liveMembers(service, live),
    work: {
      queued: bucket(['queued', 'pending', 'paused']),
      running: bucket(['running', 'integrating']),
      completed: bucket(['completed']),
      failed: bucket(['failed', 'cancelled', 'skipped']),
    },
    recentTools: [...telemetry?.tools ?? []].toReversed(),
    workflows,
    checkpoints: service.checkpoints.list()
      .filter(row => sessions.has(service.rootSessionOf(row.agent.sessionId)) || sessions.has(row.agent.sessionId))
      .slice(0, 15),
    delegations,
    background,
    loops: service.loops().filter(event => sessions.has(event.sessionId) || event.agentName.endsWith(`(${agent.name})`)).slice(0, 15),
    errors: [...telemetry?.errors ?? []].toReversed(),
    activity,
  }
}

/**
 * Build the orchestration tree and recent records.
 * @param service - orchestration service.
 * @returns state for the Orchestration view.
 */
export async function orchestrationState(service: Orchestrator): Promise<OrchestrationState> {
  const agents = await service.registry.list(false)
  const delegations = service.delegations.list().slice(0, 50)
  const workflows = service.workflows.list().slice(0, 20)
  const agentNodes: OrchestrationNode[] = agents.map((agent) => {
    const live = liveAgent(service, agent.sessionId)
    const members = liveMembers(service, live)
    const background = service.background.list(agent.id).find(task => task.status === 'running')
    const telemetry = agent.sessionId === undefined ? undefined : service.peekTelemetry(agent.sessionId)
    return {
      id: `agent:${agent.id}`,
      kind: 'main-agent',
      name: agent.name,
      status: agent.status !== 'running' ? agent.status : agent.runtime,
      agentId: agent.id,
      ...agent.sessionId === undefined ? {} : { sessionId: agent.sessionId },
      ...background !== undefined
        ? { detail: `Background: ${background.title}` }
        : agent.runtime === 'busy' && telemetry !== undefined && telemetry.lastUserText !== ''
          ? { detail: messageBody(telemetry.lastUserText).slice(0, 100) }
          : {},
      children: members.map(member => ({
        id: `sub:${member.sessionId}`,
        kind: 'sub-agent' as const,
        name: member.name,
        status: member.status,
        sessionId: member.sessionId,
        ...member.workflowTask === undefined ? member.description === undefined ? {} : { detail: member.description } : { detail: `Workflow ${member.workflowTask.workflowId} · task ${member.workflowTask.taskId}` },
        children: [],
      })),
    }
  })
  const mainSessions = new Set(agents.flatMap(agent => agent.sessionId === undefined ? [] : [agent.sessionId]))
  const leads = service.host.agents.list()
    .filter(agent => isTopLevelSession(agent.session.header)
      && !mainSessions.has(agent.session.id)
      && service.registry.recordForSession(agent.session.id) === undefined)
    .slice(-8)
  const leadNodes: OrchestrationNode[] = leads.map((lead) => {
    const delegated = new Set(delegations.filter(record => record.from.sessionId === lead.session.id).map(record => record.toAgentId))
    const members = liveMembers(service, lead)
    return {
      id: `lead:${lead.session.id}`,
      kind: 'lead',
      name: service.registry.modeOf(lead) === 'cordis' ? 'Creator' : 'Lead',
      status: lead.status === 'running' ? 'busy' : 'idle',
      sessionId: lead.session.id,
      detail: `${service.registry.modeOf(lead)} · ${lead.session.id.slice(-8)}`,
      children: [
        ...agentNodes.filter(node => node.agentId !== undefined && delegated.has(node.agentId)).map(node => ({ ...node, id: `${node.id}@${lead.session.id}` })),
        ...members.map(member => ({ id: `sub:${member.sessionId}`, kind: 'sub-agent' as const, name: member.name, status: member.status, sessionId: member.sessionId, children: [] })),
      ],
    }
  })
  const routes = [...service.store.table('routes').entries()].map(([, decision]) => decision).toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, 30)
  return {
    tree: [
      { id: 'lead:root', kind: 'lead', name: 'Lead', status: leads.some(lead => lead.status === 'running') ? 'busy' : 'idle', detail: 'KairoForge coordinator', children: [...leadNodes, ...agentNodes] },
    ],
    workflows,
    delegations,
    background: service.background.list().slice(0, 50),
    checkpoints: service.checkpoints.list().slice(0, 30),
    loops: service.loops().slice(0, 30),
    loopMetrics: service.loopMetrics(),
    routes,
    notifications: service.notifications(),
    settings: service.settings(),
    templates: [...TEMPLATES.values()].map(template => ({ id: template.id, name: template.name })),
  }
}
