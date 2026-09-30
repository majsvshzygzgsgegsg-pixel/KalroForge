/**
 * GitHub Pages provider: publishes a static build to a branch of a GitHub
 * repository and derives the public HTTPS URL it will be served from.
 *
 * Two design decisions make this the "works with anything" adapter.
 *
 * The published artifact **is a git commit**. A deployment therefore cannot be
 * partially overwritten, an earlier deployment can never be destroyed by a later
 * one, and a rollback is exact and cheap: point the branch back at the commit
 * that was recorded with it. Nothing is re-uploaded and nothing is re-built.
 *
 * A project site lives under `/<repo>/`, so a build with root-absolute asset
 * URLs (`/assets/app.js`) breaks the moment it is served from a subpath — which
 * is every project site, every preview host, and `file://`. Unless told
 * otherwise, the adapter rewrites root-absolute URLs in the published HTML and
 * CSS to the base path, adds `.nojekyll` so asset directories that begin with an
 * underscore (Next.js `_next`) are served, and writes a `CNAME` file when a
 * custom domain is configured. The result is a build that works on GitHub Pages,
 * on any other static host, under any path prefix, or straight off disk.
 *
 * What it refuses to do: publish to `main`, `master`, or `HEAD`; log a remote URL
 * with credentials in it; or claim a URL it cannot derive.
 * @module @deepseek-ai/dsh-deployment/providers/github-pages
 */

import { spawn } from 'node:child_process'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import type { ProviderAdapter, ProviderContext, PublishOutcome, DeploymentRecord, ProjectPlan } from '../types.ts'

/** Directory under the adapter's root that holds the publishing work trees. */
const PAGES_DIRECTORY = 'pages'

/** Branch names this adapter refuses to publish to, in any spelling. */
const PROTECTED_BRANCHES = new Set(['main', 'master', 'head'])

/** Default branch a Pages site is published to. */
const DEFAULT_BRANCH = 'gh-pages'

/** File that tells GitHub Pages to skip Jekyll processing. */
const NOJEKYLL_FILE = '.nojekyll'

/** File that carries a custom domain. */
const CNAME_FILE = 'CNAME'

/** File extensions whose root-absolute URLs are rewritten for a subpath. */
const REWRITABLE_EXTENSIONS = new Set(['.html', '.htm', '.css'])

/** Files never copied from a build output into a release. */
const NEVER_PUBLISHED = new Set(['.git', '.env'])

/** Provider options. */
export interface GitHubPagesOptions {
  /** Directory that holds the publishing work trees. Required. */
  rootDir: string
  /**
   * Repository to publish to: `owner/name`, any Git remote URL, or a local path.
   * Omitted, the project's own `origin` remote is used.
   */
  repo?: string
  /** Branch the site is published to. Default `gh-pages`. */
  branch?: string
  /**
   * Custom domain the site answers on. When set it is the URL reported and
   * verified, and a `CNAME` file is written into the release.
   */
  domain?: string
  /**
   * The URL this branch is served from, for any host that publishes a git branch
   * but is not GitHub Pages (Netlify, Cloudflare Pages, a self-hosted Pages
   * server). Takes precedence over the derived URL and writes no `CNAME`.
   */
  publicUrl?: string
  /**
   * Path prefix the site is served under. Defaults to `/<repo>/` for a project
   * site and `/` for a `<owner>.github.io` site or a custom domain.
   */
  basePath?: string
  /** Rewrite root-absolute asset URLs for the base path. Default true. */
  rewriteAbsolutePaths?: boolean
  /** Author identity recorded on the published commit. */
  author?: { name: string; email: string }
  /** Per-command budget in milliseconds. Default 600000. */
  timeoutMs?: number
}

/** A GitHub repository this adapter can derive a Pages URL for. */
export interface ParsedRepo {
  /** Account or organization that owns the repository. */
  owner: string
  /** Repository name. */
  name: string
}

/**
 * Read a repository reference.
 *
 * Accepts `owner/name`, HTTPS and SSH remotes, and returns undefined for a local
 * path or anything else that cannot yield a public Pages URL — a caller then has
 * to name the domain it expects.
 *
 * @param remote - the configured reference or a git remote URL.
 * @returns owner and name, or undefined when the reference is not a GitHub repository.
 */
export function parseRepo(remote: string): ParsedRepo | undefined {
  const trimmed = remote.trim().replace(/\.git$/u, '')
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.startsWith('file://')) return undefined
  const shorthand = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u.exec(trimmed)
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) {
    return { owner: shorthand[1], name: shorthand[2] }
  }
  const scp = /^[^@/]+@[^:/]+:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u.exec(trimmed)
  if (scp?.[1] !== undefined && scp[2] !== undefined) return { owner: scp[1], name: scp[2] }
  const url = /^[a-z+]+:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u.exec(trimmed)
  if (url?.[1] !== undefined && url[2] !== undefined) return { owner: url[1], name: url[2] }
  return undefined
}

/**
 * The public URL a project site answers on.
 *
 * @param repo - parsed repository.
 * @returns the Pages URL, always with a trailing slash.
 */
export function pagesUrlFor(repo: ParsedRepo): string {
  const userSite = `${repo.owner.toLowerCase()}.github.io`
  return repo.name.toLowerCase() === userSite
    ? `https://${userSite}/`
    : `https://${userSite}/${repo.name}/`
}

/** The path prefix a project site is served under. */
export function basePathFor(repo: ParsedRepo | undefined, options: GitHubPagesOptions): string {
  if (options.basePath !== undefined) return normaliseBasePath(options.basePath)
  if (options.domain !== undefined) return '/'
  if (repo === undefined) return '/'
  return repo.name.toLowerCase() === `${repo.owner.toLowerCase()}.github.io` ? '/' : `/${repo.name}/`
}

/** Ensure one leading and one trailing slash. */
function normaliseBasePath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/gu, '')}/`
}

/** Strip credentials from a remote URL so it can be logged. */
export function redactRemote(remote: string): string {
  return remote.replace(/\/\/[^@/]*@/u, '//***@')
}

/** Description of one finished git invocation. */
interface GitResult {
  /** True when git exited zero. */
  ok: boolean
  /** Standard output, trimmed. */
  stdout: string
  /** Standard error, trimmed. */
  stderr: string
}

/** Run one git command without a shell. */
function git(args: readonly string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<GitResult> {
  return new Promise<GitResult>((resolveResult) => {
    const child = spawn('git', [...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const onAbort = (): void => { child.kill('SIGTERM') }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { child.kill('SIGTERM') }, timeoutMs)
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolveResult({ ok: false, stdout: '', stderr: String(error) })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolveResult({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

/** Run one git command and throw with its stderr when it fails. */
async function gitOrThrow(args: readonly string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const result = await git(args, cwd, timeoutMs, signal)
  if (!result.ok) {
    throw new Error(`git ${args[0] ?? ''} failed: ${redactRemote(result.stderr) || 'no output'}`)
  }
  return result.stdout
}

/** Every file under a directory, relative to it. */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, relative))
      continue
    }
    files.push(relative)
  }
  return files
}

/**
 * Rewrite root-absolute URLs in one file so the build works under a subpath.
 *
 * Only HTML attributes and CSS `url()` references are touched: a root-absolute
 * string inside JavaScript is a runtime concern this adapter cannot see, and
 * guessing there would be worse than leaving it.
 *
 * @param path - file to rewrite in place.
 * @param base - base path, with a trailing slash.
 * @returns whether the file changed.
 */
async function rewriteAbsolutePaths(path: string, base: string): Promise<boolean> {
  const extension = extname(path).toLowerCase()
  if (!REWRITABLE_EXTENSIONS.has(extension)) return false
  const original = await readFile(path, 'utf8')
  const rewritten = extension === '.css'
    ? original.replace(/url\(\s*(["']?)\/(?!\/)/gu, (_match, quote: string) => `url(${quote}${base}`)
    : original.replace(/\b(src|href)="\/(?!\/)/gu, (_match, attribute: string) => `${attribute}="${base}`)
  if (rewritten === original) return false
  await writeFile(path, rewritten, 'utf8')
  return true
}

/**
 * Create the GitHub Pages provider.
 *
 * @param options - adapter options; only `rootDir` is required.
 * @returns the adapter.
 */
export function createGitHubPagesProvider(options: GitHubPagesOptions): ProviderAdapter {
  const timeoutMs = options.timeoutMs ?? 600_000
  const branch = options.branch ?? DEFAULT_BRANCH
  const rewrite = options.rewriteAbsolutePaths !== false

  /** The URL this branch is served from: an explicit URL, a domain, then GitHub Pages. */
  const publicUrlFor = (repo: ParsedRepo | undefined): string => {
    if (options.publicUrl !== undefined) {
      return options.publicUrl.endsWith('/') ? options.publicUrl : `${options.publicUrl}/`
    }
    if (options.domain !== undefined) {
      return `https://${options.domain.replace(/^https?:\/\//u, '').replace(/\/$/u, '')}/`
    }
    if (repo === undefined) {
      throw new Error('github-pages cannot derive a public URL: set publicUrl, a domain, or a GitHub repository')
    }
    return pagesUrlFor(repo)
  }

  /** The repository this publish targets: configured, else the project's origin. */
  const resolveRemote = async (projectDir: string, log: (line: string) => void): Promise<string> => {
    if (options.repo !== undefined) return options.repo
    const result = await git(['remote', 'get-url', 'origin'], projectDir, timeoutMs)
    if (!result.ok || result.stdout === '') {
      throw new Error('github-pages has no repository: set the provider\'s repo option, or give the project a git origin remote')
    }
    log(`using the project's origin remote ${redactRemote(result.stdout)}`)
    return result.stdout
  }

  /** The work tree for one repository, prepared with the target branch checked out. */
  const prepareWorkTree = async (remote: string, log: (line: string) => void): Promise<string> => {
    const slug = remote.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(-80)
    const work = join(options.rootDir, PAGES_DIRECTORY, slug === '' ? 'default' : slug)
    await mkdir(work, { recursive: true })
    if (!existsSync(join(work, '.git'))) {
      await gitOrThrow(['init', '--quiet'], work, timeoutMs)
      await gitOrThrow(['remote', 'add', 'origin', remote], work, timeoutMs)
      log(`prepared a publishing work tree for ${redactRemote(remote)}`)
    } else {
      await gitOrThrow(['remote', 'set-url', 'origin', remote], work, timeoutMs)
    }
    if (options.author !== undefined) {
      await gitOrThrow(['config', 'user.name', options.author.name], work, timeoutMs)
      await gitOrThrow(['config', 'user.email', options.author.email], work, timeoutMs)
    }
    return work
  }

  /** Replace the work tree's contents with one build output. */
  const stageRelease = async (work: string, plan: ProjectPlan, ctx: ProviderContext, base: string): Promise<string[]> => {
    const source = plan.outputDir === undefined ? ctx.projectDir : resolve(ctx.projectDir, plan.outputDir)
    const files = (await listFiles(source)).filter(file => !NEVER_PUBLISHED.has(file.split('/')[0] ?? ''))
    for (const entry of await readdir(work)) {
      if (entry === '.git') continue
      await rm(join(work, entry), { recursive: true, force: true })
    }
    await cp(source, work, {
      recursive: true,
      filter: from => !NEVER_PUBLISHED.has(from.split('/').pop() ?? '') && !from.includes('/.git/'),
    })
    await writeFile(join(work, NOJEKYLL_FILE), '', 'utf8')
    if (options.domain !== undefined) await writeFile(join(work, CNAME_FILE), `${options.domain}\n`, 'utf8')
    if (rewrite && base !== '/') {
      let rewritten = 0
      for (const file of files) {
        if (await rewriteAbsolutePaths(join(work, file), base)) rewritten += 1
      }
      ctx.log(`rewrote root-absolute URLs for the ${base} base path in ${rewritten} file(s)`)
    }
    return files
  }

  return {
    descriptor: {
      id: 'github-pages',
      label: 'GitHub Pages',
      capabilities: ['static'],
      // Publishing is public and immediately visible, and Pages has to be enabled
      // for the repository, so this never runs on the model's initiative.
      consequential: true,
      credentials: [],
      supportsRollback: true,
    },
    supports(plan: ProjectPlan): boolean {
      return plan.capabilities.length > 0 && plan.capabilities.every(capability => capability === 'static')
    },
    async publish(ctx: ProviderContext): Promise<PublishOutcome> {
      if (PROTECTED_BRANCHES.has(branch.toLowerCase())) {
        throw new Error(`github-pages refuses to publish to "${branch}": configure a dedicated branch such as gh-pages`)
      }
      const remote = await resolveRemote(ctx.projectDir, ctx.log)
      const repo = parseRepo(remote)
      if (options.publicUrl === undefined && options.domain === undefined && repo === undefined) {
        throw new Error(`github-pages cannot derive a public URL from ${redactRemote(remote)}: set publicUrl, a domain, or a GitHub repository`)
      }
      const base = basePathFor(repo, options)
      const work = await prepareWorkTree(remote, ctx.log)
      const files = await stageRelease(work, ctx.plan, ctx, base)
      ctx.log(`staged ${files.length} file(s) from ${ctx.plan.outputDir ?? '.'}`)

      await gitOrThrow(['checkout', '--quiet', '--orphan', branch], work, timeoutMs).catch(async () => {
        // The orphan branch already exists in this work tree: rebuild it in place.
        await gitOrThrow(['checkout', '--quiet', branch], work, timeoutMs)
      })
      await gitOrThrow(['add', '--all', '--force'], work, timeoutMs)
      const commit = await git(['commit', '--quiet', '-m', `deploy ${ctx.deploymentId} (${ctx.environment})`], work, timeoutMs)
      if (!commit.ok && !commit.stdout.includes('nothing to commit') && !commit.stderr.includes('nothing to commit')) {
        throw new Error(`github-pages could not commit the release: ${redactRemote(commit.stderr) || 'unknown git failure'}`)
      }
      const sha = await gitOrThrow(['rev-parse', 'HEAD'], work, timeoutMs)
      await gitOrThrow(['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`], work, timeoutMs)

      const url = publicUrlFor(repo)
      ctx.log(`pushed ${sha.slice(0, 8)} to ${branch}; expected URL ${url}`)
      ctx.log(`if that URL does not answer yet, enable Pages for the repository with source "${branch}"`)
      return { url, externalId: sha, logs: [`branch ${branch}`, `commit ${sha}`, `base ${base}`] }
    },
    async restore(ctx: ProviderContext, record: DeploymentRecord): Promise<PublishOutcome> {
      const sha = record.externalId
      if (sha === undefined) {
        throw new Error(`github-pages cannot restore ${record.id}: the record carries no commit to point the branch back at`)
      }
      if (PROTECTED_BRANCHES.has(branch.toLowerCase())) {
        throw new Error(`github-pages refuses to publish to "${branch}"`)
      }
      const remote = await resolveRemote(ctx.projectDir, ctx.log)
      const work = await prepareWorkTree(remote, ctx.log)
      await gitOrThrow(['fetch', '--quiet', 'origin', branch], work, timeoutMs)
      await gitOrThrow(['cat-file', '-e', `${sha}^{commit}`], work, timeoutMs)
      await gitOrThrow(['push', '--quiet', '--force', 'origin', `${sha}:refs/heads/${branch}`], work, timeoutMs)
      const url = publicUrlFor(parseRepo(remote))
      ctx.log(`restored ${branch} to ${sha.slice(0, 8)} (the superseded commit is still in the repository)`)
      return { url, externalId: sha, logs: [`restored ${branch} to ${sha}`] }
    },
  }
}
