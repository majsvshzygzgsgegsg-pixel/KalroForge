/**
 * Knowledge graph: named entities (people, projects, bugs, modules, places)
 * joined by short relations ("Michael" —is→ "boss", "login bug" —affects→
 * "auth module"). Facts enter only through an explicit link (a tool call or
 * the Command Center), never by silently mining conversations, and secrets are
 * refused before they get here.
 */

/** One entity. */
export interface GraphEntity {
  readonly id: string
  readonly name: string
  readonly kind?: string
}

/** One relation between two entities. */
export interface GraphRelation {
  readonly from: string
  readonly relation: string
  readonly to: string
  readonly at: string
  readonly note?: string
}

/** Serialized graph. */
export interface GraphData {
  readonly entities: GraphEntity[]
  readonly relations: GraphRelation[]
}

/** One relation in display form. */
export interface GraphFact {
  readonly from: string
  readonly relation: string
  readonly to: string
  readonly text: string
  readonly at: string
}

/** Optional details for a new link. */
export interface LinkOptions {
  readonly fromKind?: string
  readonly toKind?: string
  readonly note?: string
}

const MAX_NAME = 80
const MAX_RELATION = 40

/**
 * Stable id for an entity name.
 * @param name - display name.
 * @returns lowercased, whitespace-collapsed id.
 */
export function entityId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/** In-memory knowledge graph. */
export class KnowledgeGraph {
  private readonly entities = new Map<string, GraphEntity>()
  private relations: GraphRelation[] = []

  /**
   * @param data - previously serialized graph.
   */
  constructor(data?: GraphData) {
    for (const entity of data?.entities ?? []) this.entities.set(entity.id, entity)
    this.relations = [...data?.relations ?? []]
  }

  /** Entity and relation counts. */
  size(): { readonly entities: number; readonly relations: number } {
    return { entities: this.entities.size, relations: this.relations.length }
  }

  private ensure(name: string, kind?: string): GraphEntity {
    const clean = name.trim().slice(0, MAX_NAME)
    if (clean === '') throw new Error('an entity needs a name')
    const id = entityId(clean)
    const known = this.entities.get(id)
    if (known !== undefined) {
      if (kind !== undefined && known.kind === undefined) this.entities.set(id, { ...known, kind })
      return this.entities.get(id) ?? known
    }
    const entity: GraphEntity = { id, name: clean, ...kind === undefined ? {} : { kind } }
    this.entities.set(id, entity)
    return entity
  }

  /**
   * Link two entities, creating them when new; a repeated link is not duplicated.
   * @param from - subject name.
   * @param relation - short relation ("is", "works on", "affects").
   * @param to - object name.
   * @param options - kinds and a note.
   * @param options.fromKind - subject kind.
   * @param options.toKind - object kind.
   * @param options.note - free note.
   * @param now - timestamp.
   * @returns the relation.
   */
  link(from: string, relation: string, to: string, options: LinkOptions = {}, now = new Date().toISOString()): GraphRelation {
    const rel = relation.trim().toLowerCase().slice(0, MAX_RELATION)
    if (rel === '') throw new Error('a link needs a relation')
    const a = this.ensure(from, options.fromKind)
    const b = this.ensure(to, options.toKind)
    const existing = this.relations.find(item => item.from === a.id && item.relation === rel && item.to === b.id)
    if (existing !== undefined) return existing
    const note = options.note === undefined ? {} : { note: options.note.slice(0, 300) }
    const created: GraphRelation = { from: a.id, relation: rel, to: b.id, at: now, ...note }
    this.relations.push(created)
    return created
  }

  /**
   * Remove links between two entities (all relations when none is given); orphaned entities go too.
   * @param from - subject name.
   * @param to - object name.
   * @param relation - optional relation.
   * @returns removed count.
   */
  unlink(from: string, to: string, relation?: string): number {
    const a = entityId(from)
    const b = entityId(to)
    const rel = relation?.trim().toLowerCase()
    const before = this.relations.length
    this.relations = this.relations.filter(item => !(item.from === a && item.to === b && (rel === undefined || item.relation === rel)))
    for (const id of [a, b]) {
      if (!this.relations.some(item => item.from === id || item.to === id)) this.entities.delete(id)
    }
    return before - this.relations.length
  }

  /**
   * Everything known about one entity, as sentences.
   * @param name - entity name.
   * @param depth - hops to follow (1 or 2).
   * @returns facts.
   */
  about(name: string, depth = 2): string[] {
    const start = entityId(name)
    const seen = new Set<string>([start])
    let frontier = [start]
    const facts = new Set<string>()
    for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
      const next: string[] = []
      for (const id of frontier) {
        for (const item of this.relations) {
          if (item.from !== id && item.to !== id) continue
          facts.add(this.sentence(item))
          const other = item.from === id ? item.to : item.from
          if (!seen.has(other)) {
            seen.add(other)
            next.push(other)
          }
        }
      }
      frontier = next
    }
    return [...facts]
  }

  private sentence(item: GraphRelation): string {
    const from = this.entities.get(item.from)?.name ?? item.from
    const to = this.entities.get(item.to)?.name ?? item.to
    return `${from} ${item.relation} ${to}${item.note === undefined ? '' : ` (${item.note})`}`
  }

  /**
   * Entities whose names appear in a text, longest names first.
   * @param text - message.
   * @returns matching entities.
   */
  mentioned(text: string): GraphEntity[] {
    const lower = text.toLowerCase()
    return [...this.entities.values()]
      .filter(entity => entity.id.length > 1 && new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${escape(entity.id)}(?:$|[^\p{L}\p{N}])`, 'u').test(lower))
      .toSorted((a, b) => b.id.length - a.id.length)
  }

  /**
   * Names related to a role ("boss", "manager") through an "is" link.
   * @param roles - role names.
   * @returns entity names holding those roles.
   */
  holdersOf(roles: readonly string[]): string[] {
    const wanted = new Set(roles.map(entityId))
    return this.relations
      .filter(item => (item.relation === 'is' || item.relation === 'is my') && wanted.has(item.to))
      .map(item => this.entities.get(item.from)?.name ?? item.from)
  }

  /**
   * Every relation as a sentence, newest first.
   * @param limit - maximum facts.
   * @returns facts.
   */
  facts(limit = 200): GraphFact[] {
    return this.relations.toReversed().slice(0, limit).map(item => ({
      from: this.entities.get(item.from)?.name ?? item.from,
      relation: item.relation,
      to: this.entities.get(item.to)?.name ?? item.to,
      text: this.sentence(item),
      at: item.at,
    }))
  }

  /** Serializable form. */
  toJSON(): GraphData {
    return { entities: [...this.entities.values()], relations: this.relations }
  }
}
