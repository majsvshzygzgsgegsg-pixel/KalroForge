/** Memory ranking: plain token overlap plus recency, deterministic and explainable. */

/** Memory scopes. */
export const MEMORY_SCOPES = ['session', 'project', 'user', 'agent'] as const

/** One memory scope. */
export type MemoryScope = typeof MEMORY_SCOPES[number]

/** Fields ranking needs. */
export interface RankableMemory {
  readonly id: string
  readonly scope: MemoryScope
  readonly scopeId?: string
  readonly text: string
  readonly tags: readonly string[]
  readonly status: 'active' | 'disabled'
  readonly updatedAt: string
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'i', 'my', 'me', 'you', 'it', 'this', 'that', 'with', 'be', 'do', 'what', 'how'])

/**
 * Lower-case content words of a text.
 * @param text - any text.
 * @returns distinct tokens.
 */
export function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1 && !STOP.has(word)))
}

/** Search filter. */
export interface MemoryQuery {
  readonly text?: string
  readonly scope?: MemoryScope
  readonly scopeId?: string
  readonly includeDisabled?: boolean
  readonly limit?: number
}

/**
 * Filter and rank memories. Without query text, newest first.
 * @param entries - all memories.
 * @param query - filter and query text.
 * @returns ranked matches.
 */
export function searchMemories<T extends RankableMemory>(entries: readonly T[], query: MemoryQuery): T[] {
  const wanted = tokens(query.text ?? '')
  const filtered = entries.filter(entry =>
    (query.includeDisabled === true || entry.status === 'active')
    && (query.scope === undefined || entry.scope === query.scope)
    && (query.scopeId === undefined || entry.scopeId === query.scopeId))
  const scored = filtered.map((entry) => {
    if (wanted.size === 0) return { entry, score: 0 }
    const have = tokens(`${entry.text} ${entry.tags.join(' ')}`)
    let overlap = 0
    for (const word of wanted) if (have.has(word)) overlap++
    return { entry, score: overlap / wanted.size }
  })
  return scored
    .filter(item => wanted.size === 0 || item.score > 0)
    .toSorted((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, query.limit ?? 50)
    .map(item => item.entry)
}

/**
 * Memories worth putting in front of the model for one request: every active
 * user preference (they are few and always relevant), then project and agent
 * memories matching the request.
 * @param entries - all memories.
 * @param request - latest request text.
 * @param scopes - the active project and agent ids.
 * @param limit - maximum entries.
 * @returns selected memories.
 */
export function relevantMemories<T extends RankableMemory>(
  entries: readonly T[],
  request: string,
  scopes: { readonly projectId?: string; readonly agentId?: string; readonly sessionId?: string },
  limit = 8,
): T[] {
  const picked = new Map<string, T>()
  const add = (items: readonly T[]): void => {
    for (const item of items) if (picked.size < limit) picked.set(item.id, item)
  }
  add(searchMemories(entries, { scope: 'user', limit: 4 }))
  if (scopes.sessionId !== undefined) add(searchMemories(entries, { scope: 'session', scopeId: scopes.sessionId, limit: 3 }))
  if (scopes.projectId !== undefined) {
    const project = searchMemories(entries, { scope: 'project', scopeId: scopes.projectId, text: request, limit: 3 })
    add(project.length > 0 ? project : searchMemories(entries, { scope: 'project', scopeId: scopes.projectId, limit: 2 }))
  }
  if (scopes.agentId !== undefined) add(searchMemories(entries, { scope: 'agent', scopeId: scopes.agentId, limit: 3 }))
  add(searchMemories(entries, { scope: 'user', text: request, limit }))
  return [...picked.values()]
}
