/**
 * Local vector search for the brain. Embeddings are computed on this machine
 * by feature hashing (words, word pairs, and character trigrams, TF weighted
 * and L2 normalized), so no file content ever goes to an embedding API. The
 * index is a flat cosine scan, which stays fast for tens of thousands of
 * chunks and serializes compactly for the Vault.
 */

/** Embedding width. */
export const DIMENSIONS = 512
const CHUNK_CHARS = 900
const CHUNK_OVERLAP = 150
const SNIPPET_CHARS = 700

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with', 'as', 'at', 'by', 'be', 'this', 'that', 'are', 'was', 'from'])

/**
 * Lowercased word tokens without stop words.
 * @param text - input.
 * @returns tokens.
 */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(token => token.length > 1 && !STOP.has(token))
}

function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193)
  }
  return value >>> 0
}

/**
 * Embed text into a unit vector.
 * @param text - input.
 * @returns a {@link DIMENSIONS}-wide normalized vector (all zeros for empty text).
 */
export function embed(text: string): Float32Array {
  const vector = new Float32Array(DIMENSIONS)
  const tokens = tokenize(text)
  const add = (feature: string, weight: number): void => {
    const h = hash(feature)
    vector[h % DIMENSIONS] = (vector[h % DIMENSIONS] ?? 0) + ((h & 0x80000000) === 0 ? weight : -weight)
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? ''
    add(`w:${token}`, 1)
    const next = tokens[index + 1]
    if (next !== undefined) add(`b:${token} ${next}`, 0.7)
    for (let start = 0; start + 3 <= token.length && token.length > 3; start++) add(`c:${token.slice(start, start + 3)}`, 0.25)
  }
  let norm = 0
  for (const value of vector) norm += value * value
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm)
    for (let index = 0; index < vector.length; index++) vector[index] = (vector[index] ?? 0) * scale
  }
  return vector
}

/**
 * Cosine similarity of two unit vectors.
 * @param a - one vector.
 * @param b - the other.
 * @returns similarity in [-1, 1].
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let index = 0; index < a.length; index++) dot += (a[index] ?? 0) * (b[index] ?? 0)
  return dot
}

/**
 * Split text into overlapping chunks, preferring paragraph and line breaks.
 * @param text - document text.
 * @returns chunks with their start offsets.
 */
export function chunkText(text: string): Array<{ readonly offset: number; readonly text: string }> {
  const chunks: Array<{ offset: number; text: string }> = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS)
    if (end < text.length) {
      const window = text.slice(start, end)
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
      if (cut > CHUNK_CHARS / 2) end = start + cut
    }
    const piece = text.slice(start, end).trim()
    if (piece !== '') chunks.push({ offset: start, text: piece })
    if (end >= text.length) break
    start = Math.max(end - CHUNK_OVERLAP, start + 1)
  }
  return chunks
}

/** One stored chunk. */
interface Entry {
  readonly doc: string
  readonly offset: number
  readonly snippet: string
  readonly vector: Float32Array
}

/** One search hit. */
export interface VectorHit {
  readonly doc: string
  readonly offset: number
  readonly snippet: string
  readonly score: number
}

/** Serialized index. */
export interface SerializedIndex {
  readonly version: 1
  readonly docs: Record<string, { readonly mtime: number; readonly size: number }>
  readonly entries: Array<{ readonly doc: string; readonly offset: number; readonly snippet: string; readonly vector: string }>
}

/** Flat cosine index over document chunks. */
export class VectorIndex {
  private entries: Entry[] = []
  private readonly docs = new Map<string, { mtime: number; size: number }>()

  /** Indexed document count. */
  get documentCount(): number {
    return this.docs.size
  }

  /** Indexed chunk count. */
  get chunkCount(): number {
    return this.entries.length
  }

  /**
   * Whether a document is indexed at this version.
   * @param doc - document id (path).
   * @param mtime - modification time.
   * @param size - byte size.
   * @returns true when unchanged.
   */
  isCurrent(doc: string, mtime: number, size: number): boolean {
    const known = this.docs.get(doc)
    return known?.mtime === mtime && known.size === size
  }

  /**
   * Whether a document is indexed at any version.
   * @param doc - document id.
   * @returns true when indexed.
   */
  has(doc: string): boolean {
    return this.docs.has(doc)
  }

  /** Every indexed document id. */
  documents(): string[] {
    return [...this.docs.keys()]
  }

  /**
   * Replace one document's chunks.
   * @param doc - document id (path).
   * @param text - full text.
   * @param version - modification time and size.
   * @param version.mtime - modification time.
   * @param version.size - byte size.
   */
  upsert(doc: string, text: string, version: { mtime: number; size: number }): void {
    this.remove(doc)
    for (const chunk of chunkText(text)) {
      this.entries.push({ doc, offset: chunk.offset, snippet: chunk.text.slice(0, SNIPPET_CHARS), vector: embed(`${doc}\n${chunk.text}`) })
    }
    this.docs.set(doc, version)
  }

  /**
   * Drop one document.
   * @param doc - document id.
   */
  remove(doc: string): void {
    if (!this.docs.delete(doc)) return
    this.entries = this.entries.filter(entry => entry.doc !== doc)
  }

  /**
   * Best chunks for a query, at most one per document.
   * @param query - question or keywords.
   * @param limit - maximum hits.
   * @returns hits, best first.
   */
  search(query: string, limit = 6): VectorHit[] {
    const vector = embed(query)
    const best = new Map<string, VectorHit>()
    for (const entry of this.entries) {
      const score = cosine(vector, entry.vector)
      const current = best.get(entry.doc)
      if (score > 0 && (current === undefined || score > current.score)) {
        best.set(entry.doc, { doc: entry.doc, offset: entry.offset, snippet: entry.snippet, score })
      }
    }
    return [...best.values()].toSorted((a, b) => b.score - a.score).slice(0, limit)
  }

  /** Compact form for storage. */
  serialize(): SerializedIndex {
    return {
      version: 1,
      docs: Object.fromEntries(this.docs),
      entries: this.entries.map(entry => ({
        doc: entry.doc, offset: entry.offset, snippet: entry.snippet,
        vector: Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength).toString('base64'),
      })),
    }
  }

  /**
   * Rebuild from {@link serialize} output.
   * @param data - serialized index.
   * @returns the index.
   */
  static from(data: SerializedIndex | undefined): VectorIndex {
    const index = new VectorIndex()
    if (data?.version !== 1) return index
    for (const [doc, version] of Object.entries(data.docs)) index.docs.set(doc, { ...version })
    for (const entry of data.entries) {
      const bytes = Buffer.from(entry.vector, 'base64')
      const vector = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      if (vector.length === DIMENSIONS) index.entries.push({ doc: entry.doc, offset: entry.offset, snippet: entry.snippet, vector })
    }
    return index
  }
}
