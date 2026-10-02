/**
 * Agent-scoped orchestration tools for top-level Sessions (Lead, Creator, and
 * main agents): workflows, checkpoints, delegation, and background tasks.
 * Fast Mode Sessions receive only the checkpoint tools. Restoring or deleting
 * a checkpoint always asks the user through the existing approval path.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { syncDeferred } from '../deferred-sync.ts'
import { isTopLevelSession } from '../registry.ts'
import type { Orchestrator } from './service.ts'

/** Workflow tools. */
export const WORKFLOW_TOOLS = ['create_workflow', 'workflow_status', 'cancel_workflow', 'retry_workflow_task', 'finish_workflow'] as const
/** Checkpoint tools. */
export const CHECKPOINT_TOOLS = ['create_checkpoint', 'list_checkpoints', 'compare_checkpoint', 'restore_checkpoint', 'delete_checkpoint', 'propose_rollback'] as const
/** Delegation tools. */
export const DELEGATION_TOOLS = ['delegate_to_main_agent', 'request_agent_review', 'return_task_result'] as const
/** Background-task tools. */
export const BACKGROUND_TOOLS = ['start_background_task', 'list_background_tasks', 'control_background_task', 'report_task_progress'] as const
/** Orchestration tools a restricted main agent always keeps so delegated work can be returned. */
export const ORCHESTRATION_KEEP = ['return_task_result', 'report_task_progress', 'finish_workflow', 'workflow_status'] as const

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

const GUIDE = `Orchestration (KairoForge):
- For work that splits into parts, create_workflow plans tasks with any specialist roles you choose, dependencies, parallelism, and retries; the host runs each task as a teammate and sends you "[KairoForge workflow complete]" with every result. Workflow workers report automatically: do not act on their individual "subagent finished" notices; integrate when the workflow message arrives, then call finish_workflow.
- delegate_to_main_agent hands a task to another main agent and request_agent_review asks one for a review; results come back as "[KairoForge task result]". You stay responsible for your own final answer.
- When you receive "[KairoForge delegated task]" or "[KairoForge review request]", finish it and call return_task_result with its delegation id.
- Checkpoints: create_checkpoint before risky changes; compare_checkpoint shows what changed; propose_rollback asks the user to restore. Never claim tests passed unless you ran them.`

/**
 * Install orchestration tools on every top-level Agent.
 * @param ctx - Host context.
 * @param service - orchestration service.
 */
export function installOrchestrationTools(ctx: Context, service: Orchestrator): void {
  /** Installed tool sets keyed by Agent, with the mode they were built for. */
  const installed = new Map<Agent, { readonly mode: string; readonly dispose: () => void }>()

  const caller = (agent: Agent | undefined, tool: string): Agent => {
    /* v8 ignore next -- scoped tools are discovered only with their calling Agent. */
    if (agent === undefined) throw new Error(`${tool} requires a calling Agent`)
    return agent
  }

  const register = (agent: Agent, mode: string): () => void => {
    const scoped = agent.ctx
    const fast = mode === 'fast'
    const tools: unknown[] = [
      defineTool({
        name: 'create_checkpoint',
        description: 'Capture a Git checkpoint of the whole working tree (tracked and untracked files, respecting .gitignore) without touching the index, HEAD, or files.',
        parameters: { task: { type: 'string', description: 'What you are about to do.' } },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          const self = caller(exec.agent, 'create_checkpoint')
          const record = await service.checkpoints.create(self.session.header.cwd ?? process.cwd(), {
            agent: service.actorOf(self), reason: 'manual', ...args.task === undefined ? {} : { task: args.task },
          })
          return toJson(record ?? { error: 'The working directory is not inside a Git repository; no checkpoint was taken.' })
        },
      }),
      defineTool({
        name: 'list_checkpoints',
        description: 'List Git checkpoints taken by you (or all agents), newest first, with files, tests before/after, and proposals.',
        parameters: { all: { type: 'boolean', description: 'Include checkpoints from every agent.' } },
        output: JSON_OUTPUT,
        execute(args, exec) {
          const self = caller(exec.agent, 'list_checkpoints')
          const rows = service.checkpoints.list()
            .filter(row => args.all === true || service.rootSessionOf(row.agent.sessionId) === self.session.id)
          return Promise.resolve(toJson(rows.slice(0, 30).map(row => ({
            id: row.id, createdAt: row.createdAt, reason: row.reason, agent: row.agent.name, task: row.task, branch: row.branch,
            dirtyBefore: row.dirty.length, touched: row.touched, testsBefore: row.testsBefore, testsAfter: row.testsAfter,
            restoredAt: row.restoredAt, proposal: row.proposal,
          }))))
        },
      }),
      defineTool({
        name: 'compare_checkpoint',
        description: 'Show which files changed since a checkpoint (and which of them agents wrote), optionally with the diff.',
        parameters: {
          checkpoint_id: { type: 'string', required: true },
          diff: { type: 'boolean', description: 'Include the unified diff (truncated). Defaults to false.' },
        },
        output: JSON_OUTPUT,
        async execute(args) {
          const comparison = await service.checkpoints.compare(args.checkpoint_id, args.diff ?? false)
          return toJson({
            checkpoint: comparison.checkpoint.id,
            changes: comparison.changes,
            ...args.diff === true ? { diff: comparison.diff } : {},
          })
        },
      }),
      defineTool({
        name: 'restore_checkpoint',
        description: 'Restore files to a checkpoint. scope "touched" (default) restores only files agents wrote since the checkpoint; "all" restores every changed file; paths restores exactly those. A safety checkpoint of the current state is taken first. Requires user approval.',
        parameters: {
          checkpoint_id: { type: 'string', required: true },
          scope: { type: 'string', enum: ['touched', 'all'] },
          paths: { type: 'array', items: { type: 'string' } },
        },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          const self = caller(exec.agent, 'restore_checkpoint')
          return toJson(await service.checkpoints.restore(args.checkpoint_id, {
            ...args.scope === undefined ? {} : { scope: args.scope },
            ...args.paths === undefined ? {} : { paths: args.paths },
          }, service.actorOf(self)))
        },
      }),
      defineTool({
        name: 'delete_checkpoint',
        description: 'Delete a checkpoint and its Git ref. Requires user approval.',
        parameters: { checkpoint_id: { type: 'string', required: true } },
        output: JSON_OUTPUT,
        async execute(args) {
          await service.checkpoints.delete(args.checkpoint_id)
          return toJson({ deleted: args.checkpoint_id })
        },
      }),
      defineTool({
        name: 'propose_rollback',
        description: 'Propose restoring a checkpoint because the build or tests broke badly. This does not change files; the user sees the proposal and decides.',
        parameters: { checkpoint_id: { type: 'string', required: true }, reason: { type: 'string', required: true } },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          const self = caller(exec.agent, 'propose_rollback')
          const record = await service.checkpoints.propose(args.checkpoint_id, args.reason, service.actorOf(self).name)
          return toJson({ proposed: record.id, note: 'The user was notified and can restore it from the Agents page.' })
        },
      }),
    ]
    if (!fast) {
      tools.push(
        defineTool({
          name: 'create_workflow',
          description: 'Plan and start a workflow: tasks run as teammates with the roles you choose (any specialist, not a fixed list), in parallel where dependencies allow, with retries. Results of dependencies are passed to dependants; you receive every result for final integration.',
          parameters: {
            title: { type: 'string', required: true },
            goal: { type: 'string', required: true, description: 'Overall outcome and success criteria.' },
            tasks: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true, description: 'Short id such as "api" or "tests".' },
                  title: { type: 'string', required: true },
                  role: { type: 'string', required: true, description: 'Specialist role for the worker, chosen for this task.' },
                  instructions: { type: 'string', required: true, description: 'Complete, self-contained instructions with the expected result.' },
                  depends_on: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
                  retries: { type: 'integer', description: 'Extra attempts after a failure (0-3). Defaults to 1.' },
                },
              },
            },
            max_parallel: { type: 'integer', description: 'Workers running at once (1-6). Defaults to 3.' },
            checkpoint: { type: 'boolean', description: 'Take a Git checkpoint first. Defaults to true.' },
          },
          output: JSON_OUTPUT,
          async execute(args, exec) {
            const self = caller(exec.agent, 'create_workflow')
            const workflow = await service.workflows.create(self, {
              title: args.title,
              goal: args.goal,
              tasks: args.tasks.map(task => ({
                id: task.id, title: task.title, role: task.role, instructions: task.instructions,
                dependsOn: task.depends_on ?? [], retries: task.retries ?? 1,
              })),
              ...args.max_parallel === undefined ? {} : { maxParallel: args.max_parallel },
              ...args.checkpoint === undefined ? {} : { checkpoint: args.checkpoint },
            })
            return toJson({
              id: workflow.id,
              status: workflow.status,
              checkpointId: workflow.checkpointId,
              tasks: workflow.tasks.map(task => ({ id: task.id, status: task.status })),
            })
          },
        }),
        defineTool({
          name: 'workflow_status',
          description: 'Read one workflow (or your recent workflows) with task states, attempts, results, and errors.',
          parameters: { workflow_id: { type: 'string' } },
          output: JSON_OUTPUT,
          execute(args, exec) {
            const self = caller(exec.agent, 'workflow_status')
            if (args.workflow_id !== undefined) return Promise.resolve(toJson(service.workflows.get(args.workflow_id)))
            return Promise.resolve(toJson(service.workflows.list(new Set([self.session.id])).slice(0, 10).map(workflow => ({
              id: workflow.id, title: workflow.title, status: workflow.status,
              tasks: workflow.tasks.map(task => ({ id: task.id, role: task.role, status: task.status, attempts: task.attempts })),
            }))))
          },
        }),
        defineTool({
          name: 'cancel_workflow',
          description: 'Cancel a workflow: interrupt running workers and cancel pending tasks.',
          parameters: { workflow_id: { type: 'string', required: true } },
          output: JSON_OUTPUT,
          async execute(args, exec) {
            const self = caller(exec.agent, 'cancel_workflow')
            return toJson(await service.workflows.cancel(args.workflow_id, service.actorOf(self)))
          },
        }),
        defineTool({
          name: 'retry_workflow_task',
          description: 'Retry a failed, skipped, or cancelled workflow task with a fresh worker; skipped dependants are re-opened.',
          parameters: { workflow_id: { type: 'string', required: true }, task_id: { type: 'string', required: true } },
          output: JSON_OUTPUT,
          async execute(args) {
            return toJson(await service.workflows.retryTask(args.workflow_id, args.task_id))
          },
        }),
        defineTool({
          name: 'finish_workflow',
          description: 'Record the integrated final result of a workflow you own after all tasks settled.',
          parameters: {
            workflow_id: { type: 'string', required: true },
            result: { type: 'string', required: true },
            failed: { type: 'boolean', description: 'Set when the workflow did not achieve its goal.' },
          },
          output: JSON_OUTPUT,
          async execute(args, exec) {
            const self = caller(exec.agent, 'finish_workflow')
            const workflow = await service.workflows.finish(args.workflow_id, self.session.id, args.result, args.failed ?? false)
            return toJson({ id: workflow.id, status: workflow.status })
          },
        }),
        defineTool({
          name: 'delegate_to_main_agent',
          description: 'Delegate a complete task to another running main agent. Depth and ownership are tracked; the result returns to you as "[KairoForge task result]".',
          parameters: {
            agent_id: { type: 'string', required: true, description: 'Main agent id or name.' },
            task: { type: 'string', required: true, description: 'Complete, self-contained task with the expected result.' },
          },
          output: JSON_OUTPUT,
          async execute(args, exec) {
            const self = caller(exec.agent, 'delegate_to_main_agent')
            const record = await service.delegations.delegate(service.actorOf(self), args.agent_id, args.task, 'task')
            return toJson({ delegation_id: record.id, to: record.toName, depth: record.depth, status: record.status })
          },
        }),
        defineTool({
          name: 'request_agent_review',
          description: 'Ask another main agent to review work (a diff, design, or result). Its findings return to you as "[KairoForge task result]".',
          parameters: {
            agent_id: { type: 'string', required: true },
            subject: { type: 'string', required: true, description: 'What to review.' },
            details: { type: 'string', required: true, description: 'Context, file paths, diff, and what feedback you need.' },
          },
          output: JSON_OUTPUT,
          async execute(args, exec) {
            const self = caller(exec.agent, 'request_agent_review')
            const record = await service.delegations.delegate(service.actorOf(self), args.agent_id, `Review: ${args.subject}\n\n${args.details}`, 'review')
            return toJson({ delegation_id: record.id, to: record.toName, depth: record.depth })
          },
        }),
        defineTool({
          name: 'start_background_task',
          description: 'Run a task in the background on a main agent (host-side; continues when the browser closes). You are notified when it completes or fails.',
          parameters: {
            agent_id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            prompt: { type: 'string', required: true, description: 'Complete task description.' },
          },
          output: JSON_OUTPUT,
          async execute(args, exec) {
            const self = caller(exec.agent, 'start_background_task')
            const input = { agentId: args.agent_id, title: args.title, prompt: args.prompt }
            return toJson(await service.background.create(input, service.actorOf(self)))
          },
        }),
        defineTool({
          name: 'list_background_tasks',
          description: 'List background tasks with status and progress.',
          parameters: { agent_id: { type: 'string' } },
          output: JSON_OUTPUT,
          execute(args) {
            return Promise.resolve(toJson(service.background.list(args.agent_id).slice(0, 30)))
          },
        }),
        defineTool({
          name: 'control_background_task',
          description: 'Pause, resume, or cancel a background task.',
          parameters: { task_id: { type: 'string', required: true }, action: { type: 'string', required: true, enum: ['pause', 'resume', 'cancel'] } },
          output: JSON_OUTPUT,
          async execute(args) {
            const runner = service.background
            const record = args.action === 'pause' ? await runner.pause(args.task_id) : args.action === 'resume' ? await runner.resume(args.task_id) : await runner.cancel(args.task_id)
            return toJson(record)
          },
        }),
      )
    }
    // Answering work handed to this agent stays available in every tool mode, Fast included:
    // a delegated task or background task must be able to report back.
    tools.push(
      defineTool({
        name: 'return_task_result',
        description: 'Return the result of a delegated task or review you own to the agent that delegated it.',
        parameters: {
          delegation_id: { type: 'string', required: true },
          result: { type: 'string', required: true },
          status: { type: 'string', enum: ['completed', 'failed'] },
        },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          const self = caller(exec.agent, 'return_task_result')
          const status = args.status === 'failed' ? 'failed' : 'completed'
          const record = await service.delegations.returnResult(service.actorOf(self), args.delegation_id, args.result, status)
          return toJson({ delegation_id: record.id, status: record.status, returned_to: record.from.name })
        },
      }),
      defineTool({
        name: 'report_task_progress',
        description: 'Report progress on the background task you are running.',
        parameters: {
          task_id: { type: 'string', required: true },
          percent: { type: 'number', description: '0-100.' },
          note: { type: 'string', description: 'Short milestone note.' },
        },
        output: JSON_OUTPUT,
        async execute(args, exec) {
          const self = caller(exec.agent, 'report_task_progress')
          const record = await service.background.reportProgress(args.task_id, self.session.id, {
            ...args.percent === undefined ? {} : { percent: args.percent },
            ...args.note === undefined ? {} : { note: args.note },
          })
          return toJson({ id: record.id, progress: record.progress })
        },
      }),
    )
    const disposers: Array<() => unknown> = tools.map(tool => scoped.tools.register(tool as Parameters<typeof scoped.tools.register>[0]))
    if (!fast) {
      disposers.push(scoped.systemPrompt.section({
        name: 'main-agents:orchestration',
        order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY') + 6,
        text: GUIDE,
      }))
    }
    return () => { for (const dispose of disposers.toReversed()) dispose() }
  }

  const release = (agent: Agent): void => {
    installed.get(agent)?.dispose()
    installed.delete(agent)
  }

  /** Install, rebuild, or remove one Agent's tools to match its current mode; a no-op when nothing changed. */
  const sync = (agent: Agent): void => {
    if (ctx.agents.get(agent.id) !== agent || !isTopLevelSession(agent.session.header)) return
    const mode = service.registry.modeOf(agent)
    const wanted = service.registry.allowsTools(agent)
    const current = installed.get(agent)
    if (current !== undefined && wanted && current.mode === mode) return
    if (current !== undefined) release(agent)
    if (wanted) installed.set(agent, { mode, dispose: register(agent, mode) })
  }

  let active = true
  const syncAll = (): void => { if (active) syncDeferred(ctx.agents.list(), sync) }
  // A blank Session can switch preset (RPC select or in-process recompose); the
  // composition then announces a tool change. Batched so our own registrations
  // never re-enter a sync.
  let pending = false
  const scheduleSyncAll = (): void => {
    if (pending || !active) return
    pending = true
    queueMicrotask(() => {
      pending = false
      syncAll()
    })
  }

  void service.registry.whenReady().then(syncAll)
  ctx.on('agent/created', ({ agent }) => {
    void service.registry.whenReady().then(() => { if (active) syncDeferred([agent], sync) })
  })
  ctx.on('agent/disposed', ({ agent }) => { release(agent) })
  ctx.on('agent-preset/selected', scheduleSyncAll)
  ctx.on('tools/change', scheduleSyncAll)
  ctx.effect(() => () => {
    active = false
    for (const agent of [...installed.keys()]) release(agent)
  }, 'main-agents: orchestration tools')

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    if (exec.agent === undefined || !installed.has(exec.agent)) return next()
    const reason = exec.name === 'restore_checkpoint'
      ? 'Restore files from a Git checkpoint'
      : exec.name === 'delete_checkpoint' ? 'Delete a Git checkpoint' : undefined
    if (reason === undefined) return next()
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    return { kind: 'ask', reason: `${reason} (${exec.name})`, displayReason: { en: `${reason}.`, zh: `${reason}。` } }
  })
}
