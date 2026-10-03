/**
 * Repo map: the top-level symbols of every source file in a workspace, ranked
 * against the user's request so the model starts from the right files instead
 * of guessing paths or reading the whole tree. Extraction is regex-based and
 * language-agnostic enough for TS/JS, Python, Go, Rust, Swift, Kotlin, Java,
 * C#, Ruby, and PHP.
 */

/** One indexed file. `path` is workspace-relative. */
export interface RepoFile {
  readonly path: string
  readonly symbols: readonly string[]
  readonly mtime: number
}

/** Editor focus that boosts files the user is looking at. Paths are workspace-relative. */
export interface RepoFocus {
  readonly active?: string
  readonly open?: readonly string[]
}

/** One ranked file. */
export interface RankedFile extends RepoFile {
  readonly score: number
}

/** Files with these extensions are indexed. */
export const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'go', 'rs', 'swift', 'kt', 'kts', 'java', 'cs', 'rb', 'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm',
  'sh', 'sql', 'graphql', 'proto', 'css', 'scss', 'md', 'json', 'yaml', 'yml', 'toml',
])
const SYMBOL_LIMIT = 30
const SYMBOL_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?`
    + String.raw`(?:function\*?|class|interface|type|enum|const|let|var|abstract\s+class|namespace)\s+([A-Za-z_$][\w$]*)`, 'gm'),
  /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
  /^type\s+([A-Z]\w*)\s+(?:struct|interface)/gm,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\s+([A-Za-z_]\w*)/gm,
  new RegExp(String.raw`^\s*(?:public|private|internal|open|final|static|data|sealed|\s)*`
    + String.raw`(?:class|struct|protocol|interface|enum|object|func|fun|record)\s+([A-Za-z_]\w*)`, 'gm'),
  /^\s*(?:module|class)\s+([A-Z]\w*)/gm,
]
const MARKDOWN_HEADING = /^#{1,3}\s+(.+)$/gm
const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'what', 'why', 'how', 'can', 'you', 'please', 'make', 'fix', 'add',
  'file', 'files', 'code', 'function', 'does', 'did', 'are', 'was', 'its', 'not', 'but', 'all', 'any', 'use', 'get', 'set', 'new',
  'have', 'has', 'should', 'would', 'could', 'when', 'where', 'there', 'then', 'them', 'they', 'just', 'like', 'want', 'need',
])

/**
 * Top-level symbol names of one file.
 * @param path - file path (its extension picks Markdown handling).
 * @param text - file contents.
 * @returns up to 30 unique names in file order.
 */
export function extractSymbols(path: string, text: string): string[] {
  const found = new Set<string>()
  const patterns = /\.(?:md|mdx)$/i.test(path) ? [MARKDOWN_HEADING] : SYMBOL_PATTERNS
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1]?.trim()
      if (name !== undefined && name.length > 1 && name.length <= 80) found.add(name)
      if (found.size >= SYMBOL_LIMIT) return [...found]
    }
  }
  return [...found]
}

/**
 * Words of a request or identifier: camelCase, snake_case, and paths split,
 * lower-cased, stop words dropped.
 * @param text - free text.
 * @returns unique search terms of 3+ characters.
 */
export function searchTerms(text: string): string[] {
  const words = text
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3 && !STOP.has(word))
  return [...new Set(words)]
}

/**
 * Rank files for a request.
 * @param request - the user's words.
 * @param files - indexed files.
 * @param focus - what the editor has open.
 * @param now - current time in ms (recently changed files get a small boost).
 * @param limit - how many files to return.
 * @returns the best files, best first; empty when nothing relates to the request.
 */
export function rankFiles(request: string, files: readonly RepoFile[], focus: RepoFocus = {}, now = Date.now(), limit = 12): RankedFile[] {
  const terms = searchTerms(request)
  if (terms.length === 0) return []
  const lowered = request.toLowerCase()
  const open = new Set(focus.open ?? [])
  const ranked: RankedFile[] = []
  for (const file of files) {
    const pathTerms = new Set(searchTerms(file.path))
    const symbolTerms = file.symbols.map(symbol => new Set(searchTerms(symbol)))
    let relevance = 0
    for (const term of terms) {
      if (pathTerms.has(term)) relevance += 2
      else if ([...pathTerms].some(part => part.length > 4 && (part.startsWith(term) || term.startsWith(part)))) relevance += 1
      const hits = symbolTerms.filter(set => set.has(term)).length
      relevance += Math.min(hits, 3) * 1.5
    }
    const base = file.path.split('/').pop() ?? file.path
    if (base.length > 3 && lowered.includes(base.toLowerCase())) relevance += 6
    for (const symbol of file.symbols) {
      if (symbol.length > 3 && lowered.includes(symbol.toLowerCase())) relevance += 4
    }
    if (relevance === 0) continue
    let score = relevance
    if (file.path === focus.active) score += 3
    else if (open.has(file.path)) score += 1
    if (now - file.mtime < 86_400_000) score += 0.5
    if (/(?:^|\/)(?:tests?|__tests__|spec)\//.test(file.path) || /\.(?:spec|test)\./.test(file.path)) score -= 0.5
    ranked.push({ ...file, score })
  }
  return ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit)
}

/**
 * Render ranked files as compact prompt lines within a character budget.
 * @param root - workspace root shown in the header.
 * @param ranked - files from {@link rankFiles}.
 * @param budget - maximum characters.
 * @returns context text, or '' when nothing ranked.
 */
export function renderRepoMap(root: string, ranked: readonly RankedFile[], budget = 3500): string {
  if (ranked.length === 0) return ''
  const lines = [`Repo map for ${root} — files most related to this request (path: top-level symbols). Paths are real; read them before editing.`]
  let used = lines[0]?.length ?? 0
  for (const file of ranked) {
    const line = `- ${file.path}${file.symbols.length === 0 ? '' : `: ${file.symbols.slice(0, 12).join(', ')}`}`
    if (used + line.length > budget) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length > 1 ? lines.join('\n') : ''
}
