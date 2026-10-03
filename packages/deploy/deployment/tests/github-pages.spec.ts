/**
 * GitHub Pages provider: repository reference parsing, URL derivation, the
 * subpath rewrite that makes a build portable, and a real publish/rollback round
 * trip against a local bare repository.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  basePathFor, createGitHubPagesProvider, pagesUrlFor, parseRepo, redactRemote,
} from '../src/providers/github-pages.ts'
import type { DeploymentRecord, ProjectPlan, ProviderContext } from '../src/types.ts'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A temporary directory removed after the test. */
function temporary(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** Run one git command and return its trimmed stdout. */
function gitOut(args: readonly string[], cwd?: string): string {
  const result = spawnSync('git', [...args], { encoding: 'utf8', ...cwd === undefined ? {} : { cwd } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** A bare repository standing in for GitHub. */
function bareRepository(): string {
  const dir = temporary('dsh-pages-bare-')
  gitOut(['init', '--bare', '--quiet', '-b', 'main', dir])
  return dir
}

/** A built static site whose assets are root-absolute, so the rewrite matters. */
function builtSite(): string {
  const dir = temporary('dsh-pages-site-')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, '_next'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<html><head><link rel="stylesheet" href="/assets/app.css"></head><body><script src="/assets/app.js"></script></body></html>\n')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("site")\n')
  writeFileSync(join(dir, 'assets', 'app.css'), 'body{background:url(/assets/bg.png)}\n')
  writeFileSync(join(dir, '_next', 'chunk.js'), 'export default 1\n')
  return dir
}

/** The plan the detector would produce for that site. */
function staticPlan(projectDir: string): ProjectPlan {
  return { projectDir, kind: 'static-site', capabilities: ['static'], reasons: ['test'] }
}

/** A provider context for one deployment attempt. */
function context(projectDir: string, deploymentId: string): ProviderContext {
  return {
    deploymentId,
    projectDir,
    environment: 'production',
    plan: staticPlan(projectDir),
    history: [],
    log: () => {},
  }
}

describe('repository references', () => {
  it('reads GitHub remotes, shorthand, and refuses local paths', () => {
    expect(parseRepo('owner/name')).toEqual({ owner: 'owner', name: 'name' })
    expect(parseRepo('https://github.com/owner/name.git')).toEqual({ owner: 'owner', name: 'name' })
    expect(parseRepo('git@github.com:owner/name.git')).toEqual({ owner: 'owner', name: 'name' })
    expect(parseRepo('https://github.com/owner/name')).toEqual({ owner: 'owner', name: 'name' })
    expect(parseRepo('/tmp/some/repo')).toBeUndefined()
    expect(parseRepo('file:///tmp/repo')).toBeUndefined()
    expect(parseRepo('https://gitlab.com/owner/name')).toBeUndefined()
  })

  it('derives a project-site URL, a user-site URL, and the base path each is served under', () => {
    expect(pagesUrlFor({ owner: 'acme', name: 'shop' })).toBe('https://acme.github.io/shop/')
    expect(pagesUrlFor({ owner: 'acme', name: 'acme.github.io' })).toBe('https://acme.github.io/')

    expect(basePathFor({ owner: 'acme', name: 'shop' }, { rootDir: '/tmp' })).toBe('/shop/')
    expect(basePathFor({ owner: 'acme', name: 'acme.github.io' }, { rootDir: '/tmp' })).toBe('/')
    expect(basePathFor({ owner: 'acme', name: 'shop' }, { rootDir: '/tmp', domain: 'shop.example.com' })).toBe('/')
    expect(basePathFor({ owner: 'acme', name: 'shop' }, { rootDir: '/tmp', basePath: 'preview' })).toBe('/preview/')
  })

  it('never logs credentials embedded in a remote', () => {
    expect(redactRemote('https://x-access-token:ghs_secret@github.com/owner/name.git'))
      .toBe('https://***@github.com/owner/name.git')
  })
})

describe('publishing a static build', () => {
  it('pushes the build to the site branch, makes it portable, and reports the commit', async () => {
    const bare = bareRepository()
    const site = builtSite()
    const provider = createGitHubPagesProvider({
      rootDir: temporary('dsh-pages-root-'),
      repo: bare,
      publicUrl: 'https://example.test/',
      basePath: '/shop/',
      author: { name: 'KairoForge', email: 'deploy@example.test' },
    })

    const outcome = await provider.publish(context(site, 'dep_one'))

    const files = gitOut(['-C', bare, 'ls-tree', '-r', '--name-only', 'gh-pages']).split('\n')
    expect(files).toContain('index.html')
    expect(files).toContain('assets/app.js')
    // GitHub Pages skips Jekyll unless this file exists, and Jekyll drops the
    // underscore directories modern bundlers emit.
    expect(files).toContain('.nojekyll')
    expect(files).toContain('_next/chunk.js')

    // The published HTML and CSS point at the subpath the site is served from.
    expect(gitOut(['-C', bare, 'show', 'gh-pages:index.html'])).toContain('src="/shop/assets/app.js"')
    expect(gitOut(['-C', bare, 'show', 'gh-pages:index.html'])).toContain('href="/shop/assets/app.css"')
    expect(gitOut(['-C', bare, 'show', 'gh-pages:assets/app.css'])).toContain('url(/shop/assets/bg.png)')

    expect(outcome.url).toBe('https://example.test/')
    expect(outcome.externalId).toBe(gitOut(['-C', bare, 'rev-parse', 'gh-pages']))
  })

  it('writes a CNAME file and reports the custom domain when one is configured', async () => {
    const bare = bareRepository()
    const site = builtSite()
    const provider = createGitHubPagesProvider({
      rootDir: temporary('dsh-pages-root-'),
      repo: bare,
      domain: 'shop.example.com',
      author: { name: 'KairoForge', email: 'deploy@example.test' },
    })

    const outcome = await provider.publish(context(site, 'dep_cname'))

    expect(gitOut(['-C', bare, 'show', 'gh-pages:CNAME'])).toBe('shop.example.com')
    expect(outcome.url).toBe('https://shop.example.com/')
    // A custom domain serves from the root, so nothing is rewritten.
    expect(gitOut(['-C', bare, 'show', 'gh-pages:index.html'])).toContain('src="/assets/app.js"')
  })

  it('refuses a protected branch and an unnameable public URL', async () => {
    const site = builtSite()
    const protectedBranch = createGitHubPagesProvider({
      rootDir: temporary('dsh-pages-root-'), repo: bareRepository(), branch: 'main', publicUrl: 'https://example.test/',
    })
    await expect(protectedBranch.publish(context(site, 'dep_main'))).rejects.toThrow(/refuses to publish to "main"/u)

    const unnameable = createGitHubPagesProvider({ rootDir: temporary('dsh-pages-root-'), repo: bareRepository() })
    await expect(unnameable.publish(context(site, 'dep_nourl'))).rejects.toThrow(/cannot derive a public URL/u)
  })

  it('uses the project\'s own origin remote when none is configured', async () => {
    const bare = bareRepository()
    const site = builtSite()
    gitOut(['init', '--quiet'], site)
    gitOut(['remote', 'add', 'origin', bare], site)
    const provider = createGitHubPagesProvider({
      rootDir: temporary('dsh-pages-root-'),
      publicUrl: 'https://example.test/',
      author: { name: 'KairoForge', email: 'deploy@example.test' },
    })

    await provider.publish(context(site, 'dep_origin'))

    expect(gitOut(['-C', bare, 'ls-tree', '-r', '--name-only', 'gh-pages'])).toContain('index.html')
  })
})

describe('rolling back a published site', () => {
  it('points the branch back at the recorded commit and keeps the superseded one', async () => {
    const bare = bareRepository()
    const site = builtSite()
    const provider = createGitHubPagesProvider({
      rootDir: temporary('dsh-pages-root-'),
      repo: bare,
      publicUrl: 'https://example.test/',
      author: { name: 'KairoForge', email: 'deploy@example.test' },
    })

    const first = await provider.publish(context(site, 'dep_first'))
    writeFileSync(join(site, 'index.html'), '<html><body>second release</body></html>\n')
    const second = await provider.publish(context(site, 'dep_second'))
    expect(second.externalId).not.toBe(first.externalId)

    const firstCommit = first.externalId
    expect(firstCommit).toBeDefined()
    const record: DeploymentRecord = {
      id: 'dep_first',
      projectDir: site,
      environment: 'production',
      providerId: 'github-pages',
      url: 'https://example.test/',
      reachability: 'public',
      createdAt: '2026-01-01T00:00:00.000Z',
      health: 'healthy',
      ...firstCommit === undefined ? {} : { externalId: firstCommit },
    }
    // Rollback is part of this adapter's contract; assert it rather than assume it.
    if (provider.restore === undefined) throw new Error('github-pages must implement restore')
    const restored = await provider.restore(context(site, 'dep_restore'), record)

    expect(gitOut(['-C', bare, 'rev-parse', 'gh-pages'])).toBe(first.externalId)
    expect(restored.externalId).toBe(first.externalId)
    // Rolling back must not delete the deployment it replaced.
    expect(gitOut(['-C', bare, 'cat-file', '-e', `${second.externalId}^{commit}`])).toBe('')
  })
})
