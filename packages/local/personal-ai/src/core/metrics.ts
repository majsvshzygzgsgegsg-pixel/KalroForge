/** Coordinator observability: one record per finished turn, summarized on demand. */
import type { Depth } from './classifier.ts'

/** One finished coordinator turn. */
export interface TurnRecord {
  readonly at: string
  readonly sessionId: string
  /** Agent preset of the Session (`standard` = Lead, `fast` = Fast Mode). */
  readonly mode: string
  readonly depth: Depth
  /** Model-routing category the request classified as. */
  readonly category: string
  readonly durationMs: number
  readonly steps: number
  readonly toolCalls: number
  readonly tokens?: number
  readonly delegated: boolean
  readonly approvals: number
  readonly ok: boolean
}

/** Aggregate over a group of turns. */
export interface TurnStats {
  readonly turns: number
  readonly avgDurationMs: number
  readonly avgSteps: number
  readonly avgToolCalls: number
  readonly avgTokens?: number
  readonly successRate: number
}

/** Summary shown in the Command Center. */
export interface MetricsSummary {
  readonly overall: TurnStats
  readonly byDepth: Partial<Record<Depth, TurnStats>>
  readonly byMode: Record<string, TurnStats>
  readonly delegatedTurns: number
  readonly approvals: number
}

function stats(rows: readonly TurnRecord[]): TurnStats {
  const count = rows.length
  const avg = (pick: (row: TurnRecord) => number): number => (count === 0 ? 0 : rows.reduce((sum, row) => sum + pick(row), 0) / count)
  const withTokens = rows.filter(row => row.tokens !== undefined)
  return {
    turns: count,
    avgDurationMs: Math.round(avg(row => row.durationMs)),
    avgSteps: Number(avg(row => row.steps).toFixed(2)),
    avgToolCalls: Number(avg(row => row.toolCalls).toFixed(2)),
    ...withTokens.length === 0
      ? {}
      : { avgTokens: Math.round(withTokens.reduce((sum, row) => sum + (row.tokens ?? 0), 0) / withTokens.length) },
    successRate: count === 0 ? 0 : Number((rows.filter(row => row.ok).length / count).toFixed(3)),
  }
}

function groupBy<K extends string>(rows: readonly TurnRecord[], key: (row: TurnRecord) => K): Map<K, TurnRecord[]> {
  const groups = new Map<K, TurnRecord[]>()
  for (const row of rows) {
    const group = groups.get(key(row)) ?? []
    group.push(row)
    groups.set(key(row), group)
  }
  return groups
}

/**
 * Summarize turns.
 * @param rows - finished turns.
 * @returns overall, per-depth, and per-mode stats.
 */
export function summarizeTurns(rows: readonly TurnRecord[]): MetricsSummary {
  return {
    overall: stats(rows),
    byDepth: Object.fromEntries([...groupBy(rows, row => row.depth)].map(([depth, group]) => [depth, stats(group)])),
    byMode: Object.fromEntries([...groupBy(rows, row => row.mode)].map(([mode, group]) => [mode, stats(group)])),
    delegatedTurns: rows.filter(row => row.delegated).length,
    approvals: rows.reduce((sum, row) => sum + row.approvals, 0),
  }
}
