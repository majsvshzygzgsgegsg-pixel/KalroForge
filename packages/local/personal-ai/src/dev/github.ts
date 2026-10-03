/**
 * GitHub REST access for the GitHub-capable modes, without the GitHub CLI.
 * The token is the one Git already pushes with (its credential helper, or
 * GH_TOKEN / GITHUB_TOKEN); it is held in memory only and scrubbed from
 * every result. Account-level changes ask the user; rewriting or deleting a
 * protected branch is refused.
 */
import { execFile, spawn } from 'node:child_process'
import { redact } from '@local/main-agents'

/** HTTP methods the github tool accepts. */
export const GITHUB_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const
/** One accepted HTTP method. */
export type GithubMethod = typeof GITHUB_METHODS[number]

/** owner/name of a GitHub repository. */
export interface RepoSlug {
  readonly owner: string
  readonly repo: string
}

/** Extra gate for one GitHub call. */
export type GithubGate = { readonly kind: 'deny' | 'ask'; readonly reason: string } | undefined

const API_HOST = 'api.github.com'
const MAX_OUTPUT = 24_000
const TOKEN_TTL_MS = 10 * 60_000
const ACCOUNT_LEVEL = new RegExp([
  String.raw`/(?:collaborators|invitations|secrets|keys|hooks|environments|rulesets|protection|teams|variables|pages|transfer)(?:/|$)`,
  String.raw`/actions/permissions`,
].join('|'))
const REPO_SETTINGS = new Set(['private', 'visibility', 'archived', 'name', 'default_branch', 'security_and_analysis'])

/**
 * The GitHub repository behind a remote URL.
 * @param url - `git remote get-url` output.
 * @returns owner and name, when the remote is on github.com.
 */
export function parseRemote(url: string): RepoSlug | undefined {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match?.[1] === undefined || match[2] === undefined ? undefined : { owner: match[1], repo: match[2] }
}

/**
 * Parse an "owner/name" argument.
 * @param text - user or model supplied repository.
 * @returns the slug, when well formed.
 */
export function parseSlug(text: string): RepoSlug | undefined {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(text.trim())
  return match?.[1] === undefined || match[2] === undefined ? undefined : { owner: match[1], repo: match[2] }
}

/**
 * Resolve an API path to a URL on api.github.com. `{owner}` and `{repo}`
 * are filled from the repository the agent works in.
 * @param path - e.g. `/repos/{owner}/{repo}/pulls?state=open`.
 * @param slug - repository for the placeholders.
 * @returns the URL.
 */
export function githubUrl(path: string, slug: RepoSlug | undefined): URL {
  let text = path.trim()
  if (/^https?:/i.test(text)) {
    const given = new URL(text)
    if (given.host !== API_HOST) throw new Error(`only ${API_HOST} is allowed`)
    text = `${given.pathname}${given.search}`
  }
  if (!text.startsWith('/')) text = `/${text}`
  if (/[{]\s*(?:owner|repo)\s*[}]/.test(text)) {
    if (slug === undefined) throw new Error('this workspace has no github.com remote; pass repo as "owner/name"')
    text = text.replaceAll(/[{]\s*owner\s*[}]/g, slug.owner).replaceAll(/[{]\s*repo\s*[}]/g, slug.repo)
  }
  if (text.includes('..') || text.startsWith('//')) throw new Error('invalid API path')
  const url = new URL(text, `https://${API_HOST}`)
  if (url.host !== API_HOST) throw new Error(`only ${API_HOST} is allowed`)
  return url
}

/**
 * Which GitHub calls need more than the mode's own permissions.
 * @param method - HTTP method.
 * @param pathname - API path (no query).
 * @param body - parsed JSON body.
 * @param protectedBranches - branches that must never be rewritten or deleted.
 * @returns a gate, or undefined when the call may run.
 */
export function githubGate(method: GithubMethod, pathname: string, body: unknown, protectedBranches: readonly string[]): GithubGate {
  if (method === 'GET') return undefined
  const path = pathname.replace(/\/+$/, '')
  const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const ref = /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/.exec(path)?.[1]
  if (ref !== undefined && protectedBranches.includes(decodeURIComponent(ref))) {
    if (method === 'DELETE') return { kind: 'deny', reason: `Deleting protected branch ${ref} is not allowed.` }
    if (fields.force === true) return { kind: 'deny', reason: `Force-updating protected branch ${ref} is not allowed.` }
  }
  const branch = /^\/repos\/[^/]+\/[^/]+\/branches\/([^/]+)\/rename$/.exec(path)?.[1]
  if (branch !== undefined && protectedBranches.includes(decodeURIComponent(branch))) return { kind: 'ask', reason: `Rename protected branch ${branch}` }
  const repoRoot = /^\/repos\/[^/]+\/[^/]+$/.test(path)
  if (repoRoot && method === 'DELETE') return { kind: 'ask', reason: 'Delete a GitHub repository' }
  if (repoRoot && Object.keys(fields).some(key => REPO_SETTINGS.has(key))) return { kind: 'ask', reason: 'Change repository settings (name, visibility, archive, or default branch)' }
  if (ACCOUNT_LEVEL.test(path)) return { kind: 'ask', reason: 'Change account-level GitHub settings (access, secrets, keys, hooks, or protection)' }
  if (/^\/(?:orgs|user|admin|enterprises|authorizations|applications)(?:\/|$)/.test(path) && !/^\/user\/repos$/.test(path)) {
    return { kind: 'ask', reason: 'Change GitHub account or organization settings' }
  }
  return undefined
}

let cachedToken: { readonly token: string; readonly at: number } | undefined

/**
 * The GitHub token Git pushes with.
 * @returns the token, or undefined when Git has none for github.com.
 */
export async function githubToken(): Promise<string | undefined> {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  if (cachedToken !== undefined && Date.now() - cachedToken.at < TOKEN_TTL_MS) return cachedToken.token
  const output = await new Promise<string>((resolve) => {
    const child = spawn('git', ['credential', 'fill'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let text = ''
    const timer = setTimeout(() => { child.kill() }, 5000)
    child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(text) })
    child.stdin.end('protocol=https\nhost=github.com\n\n')
  })
  const token = /^password=(.+)$/m.exec(output)?.[1]?.trim()
  if (token === undefined || token === '') return undefined
  cachedToken = { token, at: Date.now() }
  return token
}

/** Forget the cached token (after a 401). */
export function forgetGithubToken(): void {
  cachedToken = undefined
}

/**
 * The GitHub repository a directory belongs to.
 * @param cwd - working directory.
 * @returns the `origin` repository, when it is on github.com.
 */
export function repoSlugOf(cwd: string | undefined): Promise<RepoSlug | undefined> {
  if (cwd === undefined) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 5000 }, (error, stdout) => {
      resolve(error === null ? parseRemote(stdout) : undefined)
    })
  })
}

/**
 * Drop GitHub's hypermedia noise (`*_url`, `node_id`, `_links`) so results stay small.
 * @param value - parsed response.
 * @returns the slimmed value.
 */
export function slimGithub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slimGithub)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    if (key === 'node_id' || key === '_links' || (key.endsWith('_url') && key !== 'html_url') || key === 'url') continue
    out[key] = slimGithub(field)
  }
  return out
}

/**
 * Render a response for the model, with any credential scrubbed.
 * @param status - HTTP status.
 * @param text - response body.
 * @param token - the token used, removed if echoed.
 * @returns tool output.
 */
export function renderGithubResponse(status: number, text: string, token: string): string {
  let body = text
  try {
    body = JSON.stringify(slimGithub(JSON.parse(text)))
  } catch { /* not JSON: keep the text */ }
  const clean = redact(body.replaceAll(token, '[redacted]'))
  const clipped = clean.length > MAX_OUTPUT ? `${clean.slice(0, MAX_OUTPUT)}… (${String(clean.length - MAX_OUTPUT)} more characters; narrow the request)` : clean
  return `HTTP ${String(status)}${clipped === '' ? '' : `\n${clipped}`}`
}
