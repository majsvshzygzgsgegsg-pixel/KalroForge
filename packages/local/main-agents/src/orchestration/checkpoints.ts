/**
 * Checkpoint manager: create, list, compare, restore, and delete Git
 * checkpoints, plus automatic checkpoints before an agent's first mutating
 * tool call in a turn and rollback proposals when tests break.
 *
 * Every restore first captures a `pre-restore` safety checkpoint of the
 * current state, and restores only the chosen paths; files outside that set,
 * the user's index, HEAD, and branches are never touched.
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  captureCheckpoint, changesSince, checkpointRefExists, deleteCheckpointRef, diffSince, restoreChanges, type RestoreOutcome,
} from './git.ts'
import { shortId, type Orchestrator } from './service.ts'
import type { CheckpointChange, CheckpointReason, CheckpointRecord, OrchestrationActor, TestRun } from './types.ts'

const CHECKPOINT_LIMIT = 200

/** Comparison of one checkpoint against the current working tree. */
export interface CheckpointComparison {
  readonly checkpoint: CheckpointRecord
  readonly changes: readonly (CheckpointChange & { readonly touchedByAgent: boolean })[]
  readonly diff: string
}

/** Restore request scope. */
export type RestoreScope = 'touched' | 'all'

/** Result of one restore. */
export interface RestoreResult extends RestoreOutcome {
  readonly checkpointId: string
  readonly safetyCheckpointId?: string
  /** Changed paths deliberately left as they are. */
  readonly skipped: string[]
}

/** Checkpoint manager. */
export class CheckpointManager {
  /** Root Sessions that already took an automatic checkpoint in the current turn. */
  private readonly turnCheckpoints = new Map<string, string>()

  constructor(private readonly service: Orchestrator) {}

  /**
   * Capture one checkpoint.
   * @param cwd - directory inside the repository.
   * @param input - attribution and reason.
   * @returns the record, or undefined outside a Git work tree.
   */
  async create(cwd: string, input: {
    readonly agent: OrchestrationActor
    readonly reason: CheckpointReason
    readonly task?: string
    readonly workflowId?: string
  }): Promise<CheckpointRecord | undefined> {
    const domain = await this.service.whenReady()
    const id = shortId('cp')
    const message = `KairoForge checkpoint ${id} (${input.reason}) by ${input.agent.name}${input.task === undefined ? '' : `: ${input.task.slice(0, 120)}`}`
    const captured = await captureCheckpoint(cwd, id, message)
    if (captured === undefined) return undefined
    const testsBefore = this.service.peekTelemetry(this.service.rootSessionOf(input.agent.sessionId))?.lastTestRun
    const record: CheckpointRecord = {
      id,
      ref: captured.ref,
      commit: captured.commit,
      tree: captured.tree,
      ...captured.head === undefined ? {} : { head: captured.head },
      ...captured.branch === undefined ? {} : { branch: captured.branch },
      repo: captured.repo,
      dirty: captured.dirty.slice(0, 500),
      touched: [],
      ...testsBefore === undefined ? {} : { testsBefore },
      agent: input.agent,
      ...input.task === undefined ? {} : { task: input.task.slice(0, 500) },
      ...input.workflowId === undefined ? {} : { workflowId: input.workflowId },
      reason: input.reason,
      createdAt: new Date().toISOString(),
    }
    const pruned: CheckpointRecord[] = []
    await this.service.serialize(async () => {
      await domain.table('checkpoints').put(id, record)
      const rows = [...domain.table('checkpoints').entries()].map(([, row]) => row).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      for (const old of rows.slice(CHECKPOINT_LIMIT)) {
        if (old.proposal !== undefined) continue
        await domain.table('checkpoints').delete(old.id)
        pruned.push(old)
      }
    })
    for (const old of pruned) await deleteCheckpointRef(old.repo, old.ref)
    return record
  }

  /**
   * List checkpoints, newest first.
   * @param filter - optional attribution filter.
   * @returns records.
   */
  list(filter: { readonly sessionIds?: ReadonlySet<string>; readonly workflowId?: string } = {}): CheckpointRecord[] {
    return [...this.service.store.table('checkpoints').entries()]
      .map(([, record]) => record)
      .filter(record => filter.sessionIds === undefined || filter.sessionIds.has(record.agent.sessionId))
      .filter(record => filter.workflowId === undefined || record.workflowId === filter.workflowId)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Read one checkpoint.
   * @param id - checkpoint id.
   * @returns the record.
   */
  get(id: string): CheckpointRecord {
    const record = this.service.store.table('checkpoints').get(id)
    if (record === undefined) throw new CheckpointError(`no checkpoint "${id}"`)
    return record
  }

  /**
   * Compare a checkpoint with the current working tree.
   * @param id - checkpoint id.
   * @param withDiff - include a unified diff.
   * @returns changes since the checkpoint, flagged by agent authorship.
   */
  async compare(id: string, withDiff = true): Promise<CheckpointComparison> {
    const checkpoint = this.get(id)
    await this.assertRef(checkpoint)
    const touched = new Set(checkpoint.touched)
    const changes = (await changesSince(checkpoint.repo, checkpoint.tree))
      .map(change => ({ ...change, touchedByAgent: touched.has(change.path) }))
    const diff = withDiff ? await diffSince(checkpoint.repo, checkpoint.tree) : ''
    return { checkpoint, changes, diff }
  }

  /**
   * Restore paths to a checkpoint after capturing a safety checkpoint.
   * @param id - checkpoint id.
   * @param input - scope (`touched` = only files agents wrote since the checkpoint) or explicit paths.
   * @param actor - who restores.
   * @returns what was restored, deleted, and left alone.
   */
  async restore(
    id: string,
    input: { readonly scope?: RestoreScope; readonly paths?: readonly string[] },
    actor: OrchestrationActor,
  ): Promise<RestoreResult> {
    const checkpoint = this.get(id)
    await this.assertRef(checkpoint)
    const changes = await changesSince(checkpoint.repo, checkpoint.tree)
    let chosen: CheckpointChange[]
    if (input.paths !== undefined && input.paths.length > 0) {
      const wanted = new Set(input.paths.map(path => normalizePath(checkpoint.repo, path)))
      chosen = changes.filter(change => wanted.has(change.path))
    } else if ((input.scope ?? 'touched') === 'touched') {
      const touched = new Set(checkpoint.touched)
      chosen = changes.filter(change => touched.has(change.path))
    } else {
      chosen = changes
    }
    const skipped = changes.filter(change => !chosen.includes(change)).map(change => change.path)
    if (chosen.length === 0) return { checkpointId: id, restored: [], deleted: [], skipped }
    const safety = await this.create(checkpoint.repo, { agent: actor, reason: 'pre-restore', task: `Before restoring ${id}` })
    const outcome = await restoreChanges(checkpoint.repo, checkpoint.tree, chosen)
    const domain = await this.service.whenReady()
    await this.service.serialize(async () => {
      const latest = domain.table('checkpoints').get(id)
      if (latest !== undefined) {
        const { proposal: _proposal, ...rest } = latest
        await domain.table('checkpoints').put(id, { ...rest, restoredAt: new Date().toISOString() })
      }
    })
    this.service.notify({
      level: 'success',
      kind: 'checkpoint',
      text: `Restored ${String(outcome.restored.length + outcome.deleted.length)} file(s) from checkpoint ${id}; safety checkpoint ${safety?.id ?? 'unavailable'}.`,
    })
    return { checkpointId: id, ...outcome, skipped, ...safety === undefined ? {} : { safetyCheckpointId: safety.id } }
  }

  /**
   * Delete one checkpoint and its ref.
   * @param id - checkpoint id.
   */
  async delete(id: string): Promise<void> {
    const checkpoint = this.get(id)
    await deleteCheckpointRef(checkpoint.repo, checkpoint.ref)
    const domain = await this.service.whenReady()
    await this.service.serialize(async () => { await domain.table('checkpoints').delete(id) })
  }

  /**
   * Record an agent's rollback proposal; restoring still requires the user.
   * @param id - checkpoint id.
   * @param reason - why rollback is proposed.
   * @param by - proposing agent name.
   * @returns the updated record.
   */
  async propose(id: string, reason: string, by: string): Promise<CheckpointRecord> {
    const domain = await this.service.whenReady()
    const updated = await this.service.serialize(async () => {
      const next: CheckpointRecord = { ...this.get(id), proposal: { reason: reason.slice(0, 500), at: new Date().toISOString(), by } }
      await domain.table('checkpoints').put(id, next)
      return next
    })
    const owner = this.service.mainAgentOf(updated.agent.sessionId)
    this.service.notify({
      level: 'warning',
      kind: 'checkpoint',
      text: `${by} proposes rolling back to checkpoint ${id}: ${reason}`,
      ...owner === undefined ? {} : { agentId: owner.id },
    })
    return updated
  }

  // ---------------------------------------------------------------------------
  // Automatic checkpoints and test tracking

  /**
   * Take the automatic checkpoint for a root Session's current turn when none exists yet.
   * @param rootSessionId - top-level Session that owns the work.
   * @param cwd - working directory.
   * @param agent - acting agent.
   * @param task - current task text.
   * @returns the checkpoint id, or undefined when none was taken.
   */
  async ensureTurnCheckpoint(rootSessionId: string, cwd: string, agent: OrchestrationActor, task: string): Promise<string | undefined> {
    const existing = this.turnCheckpoints.get(rootSessionId)
    if (existing !== undefined) return existing
    // Reserve first so concurrent mutating calls in one turn share one checkpoint.
    this.turnCheckpoints.set(rootSessionId, 'pending')
    try {
      const record = await this.create(cwd, { agent, reason: 'auto', ...task === '' ? {} : { task } })
      this.turnCheckpoints.set(rootSessionId, record?.id ?? 'none')
      return record?.id
    } catch (error) {
      this.turnCheckpoints.set(rootSessionId, 'none')
      this.service.host.logger.warn(`main-agents: automatic checkpoint failed: ${String(error)}`)
      return undefined
    }
  }

  /**
   * End a root Session's turn so its next mutating call takes a fresh checkpoint.
   * @param rootSessionId - top-level Session id.
   */
  endTurn(rootSessionId: string): void {
    this.turnCheckpoints.delete(rootSessionId)
  }

  /**
   * Newest checkpoint owned by a root Session or its descendants.
   * @param rootSessionId - top-level Session id.
   * @returns the record, if any.
   */
  latestFor(rootSessionId: string): CheckpointRecord | undefined {
    return this.list().find(record => record.reason !== 'pre-restore' && this.service.rootSessionOf(record.agent.sessionId) === rootSessionId)
  }

  /**
   * Remember that an agent wrote a file after the latest checkpoint.
   * @param rootSessionId - top-level Session id.
   * @param cwd - the writer's working directory.
   * @param path - written path (absolute or cwd-relative).
   */
  async noteTouched(rootSessionId: string, cwd: string, path: string): Promise<void> {
    const latest = this.latestFor(rootSessionId)
    if (latest === undefined) return
    const absolute = canonicalPath(isAbsolute(path) ? path : resolve(cwd, path))
    const rel = relative(canonicalPath(latest.repo), absolute)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
    const normalized = rel.split('\\').join('/')
    if (latest.touched.includes(normalized)) return
    const domain = await this.service.whenReady()
    await this.service.serialize(async () => {
      const current = domain.table('checkpoints').get(latest.id)
      if (current === undefined || current.touched.includes(normalized)) return
      await domain.table('checkpoints').put(latest.id, { ...current, touched: [...current.touched, normalized].slice(-1000) })
    })
  }

  /**
   * Record a test/build run against the latest checkpoint.
   * @param rootSessionId - top-level Session id.
   * @param run - the run.
   * @returns the checkpoint when this run broke tests that passed before it.
   */
  async noteTestRun(rootSessionId: string, run: TestRun): Promise<CheckpointRecord | undefined> {
    this.service.telemetryOf(rootSessionId).lastTestRun = run
    const latest = this.latestFor(rootSessionId)
    if (latest === undefined) return undefined
    const domain = await this.service.whenReady()
    await this.service.serialize(async () => {
      const current = domain.table('checkpoints').get(latest.id)
      if (current !== undefined) await domain.table('checkpoints').put(latest.id, { ...current, testsAfter: run })
    })
    return latest.testsBefore?.ok === true && !run.ok ? latest : undefined
  }

  private async assertRef(checkpoint: CheckpointRecord): Promise<void> {
    if (!(await checkpointRefExists(checkpoint.repo, checkpoint.ref))) {
      throw new CheckpointError(`checkpoint "${checkpoint.id}" no longer exists in ${checkpoint.repo}`)
    }
  }
}

/** Resolve symlinks (e.g. macOS /var → /private/var) through the nearest existing ancestor; the leaf may be deleted. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(canonicalPath(parent), basename(path))
  }
}

/** Checkpoint failure surfaced to tools and routes. */
export class CheckpointError extends Error {
  override readonly name = 'CheckpointError'
}

function normalizePath(repo: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(repo, path)
  return relative(repo, absolute).split('\\').join('/')
}
