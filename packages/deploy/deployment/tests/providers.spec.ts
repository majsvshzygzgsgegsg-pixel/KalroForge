/**
 * Provider adapter coverage: the local static server publishes real release
 * directories and serves them over a real HTTP socket, and the command adapter
 * drives real shell commands from operator configuration. Every assertion here
 * observes bytes, status codes, on-disk state, escaped output, or captured log
 * lines — the things a deployment surface is allowed to claim.
 */

import { createServer, request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCommandProvider } from '../src/providers/command.ts'
import { createLocalStaticProvider } from '../src/providers/local-static.ts'
import type { DeployCapability, DeployEnvironment, DeploymentRecord, ProjectPlan, ProviderAdapter, ProviderContext } from '../src/types.ts'

const roots: string[] = []
const closers: (() => Promise<void>)[] = []
const savedEnv = new Map<string, string>()
const envWasUnset = new Set<string>()
let deploymentCounter = 0

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  for (const [name, value] of savedEnv) process.env[name] = value
  for (const name of envWasUnset) Reflect.deleteProperty(process.env, name)
  savedEnv.clear()
  envWasUnset.clear()
  deploymentCounter = 0
})

/** Remember one name's value before the test touches it, so the restore is faithful. */
function rememberTestEnv(name: string): void {
  const previous = process.env[name]
  if (previous === undefined) {
    envWasUnset.add(name)
    savedEnv.delete(name)
  } else {
    savedEnv.set(name, previous)
    envWasUnset.delete(name)
  }
}

/** Set one environment variable for the test, restored afterwards. */
function setTestEnv(name: string, value: string): void {
  rememberTestEnv(name)
  process.env[name] = value
}

/** Unset one environment variable for the test, restored afterwards. */
function unsetTestEnv(name: string): void {
  rememberTestEnv(name)
  Reflect.deleteProperty(process.env, name)
}

/** A temp directory removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** Track a provider so its server is always stopped. */
function tracked<T extends ProviderAdapter & { close(): Promise<void> }>(provider: T): T {
  closers.push(() => provider.close())
  return provider
}

/** The restore half of an adapter, which every adapter in this package implements. */
function restorerOf(provider: ProviderAdapter): NonNullable<ProviderAdapter['restore']> {
  if (provider.restore === undefined) throw new Error('this adapter does not implement restore')
  return provider.restore.bind(provider)
}

/** A context whose logs the test can read. */
function contextFor(projectDir: string, options: {
  logs?: string[]
  deploymentId?: string
  environment?: DeployEnvironment
  signal?: AbortSignal
  plan?: ProjectPlan
} = {}): ProviderContext {
  deploymentCounter += 1
  return {
    deploymentId: options.deploymentId ?? `dep_test_${String(deploymentCounter).padStart(4, '0')}`,
    projectDir,
    environment: options.environment ?? 'production',
    plan: options.plan ?? { projectDir, kind: 'static-site', capabilities: ['static'], reasons: ['fixture'] },
    history: [],
    log: line => options.logs?.push(line),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

/** A record shaped the way the manager would hand one back. */
function recordFor(options: {
  id: string
  projectDir: string
  url: string
  createdAt: string
  providerId?: string
  externalId?: string
  environment?: DeployEnvironment
}): DeploymentRecord {
  return {
    id: options.id,
    projectDir: options.projectDir,
    environment: options.environment ?? 'production',
    providerId: options.providerId ?? 'local-static',
    url: options.url,
    reachability: 'local',
    createdAt: options.createdAt,
    health: 'unknown',
    ...(options.externalId === undefined ? {} : { externalId: options.externalId }),
  }
}

/** One request over a raw socket, so a path is sent exactly as written. */
async function rawRequest(port: number, path: string, method = 'GET'): Promise<{ status: number; body: string }> {
  const { promise, resolve: settle } = Promise.withResolvers<{ status: number; body: string }>()
  const request = httpRequest({ host: '127.0.0.1', port, path, method }, (response) => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => { body += chunk })
    response.on('end', () => {
      settle({ status: response.statusCode ?? 0, body })
    })
  })
  request.end()
  return promise
}

describe('local-static provider', () => {
  interface Fixture {
    provider: ProviderAdapter & { close(): Promise<void> }
    root: string
    projectDir: string
    dist: string
    plan: ProjectPlan
  }

  async function fixture(): Promise<Fixture> {
    const root = await tempDir('dsh-local-static-root-')
    const projectDir = await tempDir('dsh-local-static-project-')
    const dist = join(projectDir, 'dist')
    await mkdir(dist)
    await mkdir(join(dist, 'empty'))
    const provider = tracked(createLocalStaticProvider({ rootDir: root }))
    return { provider, root, projectDir, dist, plan: { projectDir, kind: 'static-site', capabilities: ['static'], outputDir: 'dist', reasons: ['fixture'] } }
  }

  /** The slug directory a published URL routes to. */
  function slugDirOf(root: string, url: string): string {
    return join(root, new URL(url).pathname.replaceAll('/', ''))
  }

  it('publishes a two-file site and serves index, asset bytes, and honest HTTP errors', async () => {
    const site = await fixture()
    const html = '<!doctype html><title>local</title>\n'
    const script = 'export const value = 1\n'
    await writeFile(join(site.dist, 'index.html'), html)
    await writeFile(join(site.dist, 'app.js'), script)
    await writeFile(join(site.dist, 'blob.bin'), 'BLOB')
    await writeFile(join(site.dist, '.env'), 'SECRET=1\n')

    const logs: string[] = []
    const outcome = await site.provider.publish(contextFor(site.projectDir, { logs, plan: site.plan, deploymentId: 'dep_site_one' }))

    expect(outcome.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-z0-9-]+\/$/u)
    // The release is named after the manager's deployment id, which is what makes a later restore exact.
    expect(outcome.externalId).toBe('dep_site_one')
    expect(logs.some(line => line.startsWith('copying '))).toBe(true)
    expect(logs.some(line => line.includes('current -> dep_site_one'))).toBe(true)
    expect(logs.some(line => line.includes(`serving ${outcome.url}`))).toBe(true)

    const index = await fetch(outcome.url)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await index.text()).toBe(html)

    const asset = await fetch(new URL('app.js', outcome.url))
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(await readFile(join(site.dist, 'app.js')))

    const opaque = await fetch(new URL('blob.bin', outcome.url))
    expect(opaque.headers.get('content-type')).toBe('application/octet-stream')

    const port = Number(new URL(outcome.url).port)
    const slugPath = new URL(outcome.url).pathname
    expect((await fetch(new URL('missing.html', outcome.url))).status).toBe(404)
    // No directory listing and no default document at the root: only a slug resolves.
    expect((await fetch(new URL('/', outcome.url))).status).toBe(404)
    // Dotfiles are never served, even though the release contains one.
    expect((await fetch(new URL('.env', outcome.url))).status).toBe(404)
    expect((await rawRequest(port, `${slugPath}.env`)).status).toBe(404)
    // A directory resolves to its index.html; one without an index is a 404, never a listing.
    expect((await rawRequest(port, slugPath)).status).toBe(200)
    expect((await rawRequest(port, `${slugPath}empty/`)).status).toBe(404)
    // Traversal, in raw and percent-encoded form, is refused as a bad request.
    expect((await rawRequest(port, '/../../etc/passwd')).status).toBe(400)
    expect((await rawRequest(port, '/%2e%2e/%2e%2e/etc/passwd')).status).toBe(400)
    expect((await rawRequest(port, `${slugPath}%00`)).status).toBe(400)
    expect((await rawRequest(port, `${slugPath}%zz`)).status).toBe(400)
    // HEAD is answered without a body; anything else is not a read.
    const head = await rawRequest(port, slugPath, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect((await rawRequest(port, slugPath, 'POST')).status).toBe(405)
    // A slug that never published has no pointer, so there is nothing to serve.
    expect((await rawRequest(port, '/no-such-slug/')).status).toBe(404)
    // A query string still routes to the same release.
    expect((await rawRequest(port, `${slugPath}?v=2`)).status).toBe(200)
    // A tampered pointer is refused rather than resolved outside the releases tree.
    await writeFile(join(slugDirOf(site.root, outcome.url), 'current'), '../outside\n')
    expect((await rawRequest(port, slugPath)).status).toBe(404)
  })

  it('accepts only static plans', async () => {
    const site = await fixture()
    expect(site.provider.supports({ ...site.plan, capabilities: ['static'] })).toBe(true)
    expect(site.provider.supports({ ...site.plan, capabilities: ['static', 'database'] })).toBe(false)
    expect(site.provider.supports({ ...site.plan, capabilities: [] })).toBe(false)
    expect(site.provider.descriptor).toEqual({
      id: 'local-static',
      label: 'Local static server',
      capabilities: ['static'],
      consequential: false,
      credentials: [],
      supportsRollback: true,
    })
  })

  it('keeps every release, repoints current, and restores the release a record names', async () => {
    const site = await fixture()
    const restore = restorerOf(site.provider)
    const indexPath = join(site.dist, 'index.html')
    await writeFile(indexPath, 'first\n')
    const first = await site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: 'dep_first_release' }))

    await writeFile(indexPath, 'second\n')
    const second = await site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: 'dep_second_release' }))
    expect(second.url).toBe(first.url)
    expect(await (await fetch(second.url)).text()).toBe('second\n')

    // A rollback must still be possible: publishing never removes a release.
    const releases = await readdir(join(slugDirOf(site.root, second.url), 'releases'))
    expect([...releases].sort()).toEqual(['dep_first_release', 'dep_second_release'])

    // The manager may key its record differently from the deployment id; then the
    // record's own release id is the exact mapping.
    const byExternalId = await restore(contextFor(site.projectDir, { plan: site.plan }), recordFor({
      id: 'rec_by_external_id',
      projectDir: site.projectDir,
      url: first.url,
      createdAt: new Date().toISOString(),
      ...(first.externalId === undefined ? {} : { externalId: first.externalId }),
    }))
    expect(byExternalId.url).toBe(first.url)
    expect(await (await fetch(first.url)).text()).toBe('first\n')

    // The mapping is durable: the restore above left a pointer a restart can read.
    const pointerLogs: string[] = []
    await restore(contextFor(site.projectDir, { logs: pointerLogs, plan: site.plan }), recordFor({
      id: 'rec_by_external_id',
      projectDir: site.projectDir,
      url: first.url,
      createdAt: new Date().toISOString(),
    }))
    expect(pointerLogs.some(line => line.includes('matched by record-pointer'))).toBe(true)

    // A record whose id is the deployment id needs no external id at all.
    const pointerById = await restore(contextFor(site.projectDir, { plan: site.plan }), recordFor({
      id: 'dep_first_release',
      projectDir: site.projectDir,
      url: first.url,
      createdAt: new Date().toISOString(),
    }))
    expect(pointerById.externalId).toBe('dep_first_release')
    expect(await (await fetch(first.url)).text()).toBe('first\n')
  })

  it('refuses to restore a release that is gone instead of serving the current one', async () => {
    const site = await fixture()
    const restore = restorerOf(site.provider)
    await writeFile(join(site.dist, 'index.html'), 'first\n')
    await site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: 'dep_kept' }))
    await writeFile(join(site.dist, 'index.html'), 'second\n')
    const second = await site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: 'dep_removed' }))
    const secondRecord = recordFor({
      id: 'dep_removed',
      projectDir: site.projectDir,
      url: second.url,
      createdAt: new Date().toISOString(),
      ...(second.externalId === undefined ? {} : { externalId: second.externalId }),
    })

    await rm(join(slugDirOf(site.root, second.url), 'releases', 'dep_removed'), { recursive: true })
    await writeFile(join(site.dist, 'index.html'), 'third\n')
    await site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: 'dep_third' }))

    await expect(restore(contextFor(site.projectDir, { plan: site.plan }), secondRecord))
      .rejects.toThrow(/no longer exists; refusing to serve a different release/u)
    expect(await (await fetch(second.url)).text()).toBe('third\n')
  })

  it('refuses to guess when a record carries no mapping to a release', async () => {
    const site = await fixture()
    const restore = restorerOf(site.provider)
    await writeFile(join(site.dist, 'index.html'), 'first\n')
    const first = await site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: 'dep_mapped' }))

    await expect(restore(contextFor(site.projectDir, { plan: site.plan }), recordFor({
      id: 'rec_unknown',
      projectDir: site.projectDir,
      url: first.url,
      createdAt: new Date().toISOString(),
    }))).rejects.toThrow(/refuses to guess which release to serve/u)

    // A record naming a release that never existed is reported, not substituted.
    await expect(restore(contextFor(site.projectDir, { plan: site.plan }), recordFor({
      id: 'rec_named_nowhere',
      projectDir: site.projectDir,
      url: first.url,
      createdAt: new Date().toISOString(),
      externalId: 'dep_never_published',
    }))).rejects.toThrow(/release directory .*dep_never_published no longer exists/u)

    await expect(restore(contextFor(site.projectDir, { plan: site.plan }), recordFor({
      id: 'rec_foreign',
      projectDir: site.projectDir,
      url: first.url,
      createdAt: new Date().toISOString(),
      providerId: 'vercel',
    }))).rejects.toThrow(/it was published by "vercel"/u)
  })

  it('keeps a manager deployment id that is not a path segment inside the releases directory', async () => {
    const site = await fixture()
    const rawId = 'release/one #2'
    await writeFile(join(site.dist, 'index.html'), 'escaped\n')
    const outcome = await site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: rawId }))

    expect(outcome.externalId).toMatch(/^dep_release-one-2-[0-9a-f]{8}$/u)
    const releases = await readdir(join(slugDirOf(site.root, outcome.url), 'releases'))
    expect(releases).toEqual([outcome.externalId])
    expect(await (await fetch(outcome.url)).text()).toBe('escaped\n')

    // An id with nothing usable left after sanitizing still names a release.
    const unnamed = await site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: '###' }))
    expect(unnamed.externalId).toMatch(/^dep_deployment-[0-9a-f]{8}$/u)

    const restore = restorerOf(site.provider)
    const restored = await restore(contextFor(site.projectDir, { plan: site.plan }), recordFor({
      id: rawId,
      projectDir: site.projectDir,
      url: outcome.url,
      createdAt: new Date().toISOString(),
    }))
    expect(restored.externalId).toBe(outcome.externalId)
  })

  it('names a project whose directory name has no usable characters', async () => {
    const root = await tempDir('dsh-local-static-root-')
    const projectDir = join(await tempDir('dsh-local-static-project-'), '###')
    const dist = join(projectDir, 'dist')
    await mkdir(dist, { recursive: true })
    await writeFile(join(dist, 'index.html'), 'odd\n')
    const plan: ProjectPlan = { projectDir, kind: 'static-site', capabilities: ['static'], outputDir: 'dist', reasons: ['fixture'] }
    const provider = tracked(createLocalStaticProvider({ rootDir: root }))

    const outcome = await provider.publish(contextFor(projectDir, { plan }))
    expect(new URL(outcome.url).pathname).toMatch(/^\/project-production-[0-9a-f]{8}\/$/u)
    expect(await (await fetch(outcome.url)).text()).toBe('odd\n')
  })

  it('refuses to republish over an existing release directory', async () => {
    const site = await fixture()
    await writeFile(join(site.dist, 'index.html'), 'first\n')
    await site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: 'dep_once' }))
    await expect(site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: 'dep_once' })))
      .rejects.toThrow(/already exists, and a release is immutable/u)
  })

  it('refuses to publish over a release index it cannot read', async () => {
    const site = await fixture()
    await writeFile(join(site.dist, 'index.html'), 'first\n')
    const first = await site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: 'dep_index' }))
    const indexPath = join(slugDirOf(site.root, first.url), 'releases.json')

    for (const corrupt of [
      'not json at all',
      '{"id":"dep_index"}',
      '["dep_index"]',
      '[null]',
      '[{"id":"dep_index"}]',
      '[{"id":"a","url":1}]',
      '[{"id":"a","url":"u","createdAt":1}]',
      '[{"id":"a","url":"u","createdAt":"c","environment":1}]',
      '[{"id":"a","url":"u","createdAt":"c","environment":"nowhere"}]',
    ]) {
      await writeFile(indexPath, corrupt)
      await expect(site.provider.publish(contextFor(site.projectDir, { plan: site.plan, deploymentId: 'dep_next' })))
        .rejects.toThrow(/release index is not a release list/u)
    }
  })

  it('names the missing build output instead of publishing an empty release', async () => {
    const site = await fixture()
    const plan: ProjectPlan = { ...site.plan, outputDir: 'missing-dist' }
    await expect(site.provider.publish(contextFor(site.projectDir, { plan }))).rejects.toThrow(/is not a directory/u)

    // With no output directory the project root itself is the artifact, so a
    // project root that is not there is still a missing build.
    const gone = join(site.projectDir, 'gone')
    await expect(site.provider.publish(contextFor(gone, {
      plan: { projectDir: gone, kind: 'static-site', capabilities: ['static'], reasons: ['fixture'] },
    }))).rejects.toThrow(/is not a directory \(plan\.outputDir=unset\)/u)
  })

  it('publishes the project directory when the plan names no output directory', async () => {
    const site = await fixture()
    await writeFile(join(site.projectDir, 'index.html'), 'root artifact\n')
    const plan: ProjectPlan = { projectDir: site.projectDir, kind: 'static-site', capabilities: ['static'], reasons: ['fixture'] }

    const outcome = await site.provider.publish(contextFor(site.projectDir, { plan }))
    expect(await (await fetch(outcome.url)).text()).toBe('root artifact\n')
  })

  it('reports a port conflict and can still publish after the port frees up', async () => {
    const site = await fixture()
    await writeFile(join(site.dist, 'index.html'), 'first\n')
    const blocker = createServer()
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    if (address === null || typeof address === 'string') throw new Error('blocker did not bind a TCP port')

    const provider = tracked(createLocalStaticProvider({ rootDir: site.root, port: address.port }))
    await expect(provider.publish(contextFor(site.projectDir, { plan: site.plan }))).rejects.toThrow(/EADDRINUSE/u)

    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    const outcome = await provider.publish(contextFor(site.projectDir, { plan: site.plan }))
    expect(Number(new URL(outcome.url).port)).toBe(address.port)

    // close() is idempotent: the second call has no server left to stop.
    await provider.close()
    await provider.close()
  })
})

describe('command provider', () => {
  /** A shell line that prints the deployment URL the pattern looks for. */
  function printUrl(url: string): string {
    return `node -e "console.log('url: ${url}')"`
  }

  it('runs the configured deploy command and resolves the URL from its output', async () => {
    const projectDir = await tempDir('dsh-command-')
    const logs: string[] = []
    const provider = createCommandProvider({
      id: 'example-cli',
      label: 'Example CLI',
      environments: { production: { deployCommand: printUrl('https://example.test/app'), urlPattern: 'url: (\\S+)' } },
    })

    const outcome = await provider.publish(contextFor(projectDir, { logs }))
    expect(outcome.url).toBe('https://example.test/app')
    expect(logs).toContain('url: https://example.test/app')
    expect(provider.descriptor).toEqual({
      id: 'example-cli',
      label: 'Example CLI',
      capabilities: ['static', 'serverless'],
      consequential: true,
      credentials: [],
      supportsRollback: false,
    })
  })

  it('describes itself from the environments it was configured with', async () => {
    const provider = createCommandProvider({
      id: 'union-cli',
      label: 'Union CLI',
      environments: {
        preview: { deployCommand: printUrl('https://preview.test'), capabilities: ['static'], consequential: false },
        production: {
          deployCommand: printUrl('https://prod.test'),
          rollbackCommand: 'true',
          credentials: ['UNION_TOKEN'],
          capabilities: ['static', 'serverless', 'container'],
          consequential: false,
        },
      },
    })
    const projectDir = await tempDir('dsh-command-')
    const planFor = (capabilities: DeployCapability[]): ProjectPlan => ({ projectDir, kind: 'unknown', capabilities, reasons: ['fixture'] })

    expect(provider.descriptor.capabilities).toEqual(['static', 'serverless', 'container'])
    expect(provider.descriptor.credentials).toEqual(['UNION_TOKEN'])
    expect(provider.descriptor.consequential).toBe(false)
    expect(provider.descriptor.supportsRollback).toBe(true)
    expect(provider.supports(planFor(['container']))).toBe(true)
    expect(provider.supports(planFor(['database']))).toBe(false)
    expect(provider.supports(planFor([]))).toBe(false)
  })

  it('refuses an environment with no command and surfaces the operator note', async () => {
    const projectDir = await tempDir('dsh-command-')
    const logs: string[] = []
    const provider = createCommandProvider({
      id: 'partial-cli',
      label: 'Partial CLI',
      environments: {
        production: {
          deployCommand: printUrl('https://example.test/app'),
          urlPattern: 'url: (\\S+)',
          environmentNote: 'production publishes straight to the live host',
        },
      },
    })
    const record = recordFor({ id: 'rec_cmd', projectDir, url: 'https://example.test/app', createdAt: new Date().toISOString(), providerId: 'partial-cli' })

    await expect(provider.publish(contextFor(projectDir, { environment: 'staging', logs })))
      .rejects.toThrow(/has no staging environment configured/u)
    await expect(restorerOf(provider)(contextFor(projectDir, { logs }), record))
      .rejects.toThrow(/no rollbackCommand is configured for it, so nothing was run/u)

    const published = await provider.publish(contextFor(projectDir, { logs }))
    expect(published.url).toBe('https://example.test/app')
    expect(logs).toContain('production publishes straight to the live host')
  })

  it('returns the URL the rollback command prints, and reuses the recorded URL when it prints none', async () => {
    const projectDir = await tempDir('dsh-command-')
    const record = recordFor({ id: 'rec_rollback', projectDir, url: 'https://example.test/recorded', createdAt: new Date().toISOString(), providerId: 'rollback-cli' })
    const quiet = createCommandProvider({
      id: 'rollback-cli',
      label: 'Rollback CLI',
      environments: { production: { deployCommand: printUrl('https://example.test/app'), rollbackCommand: 'true', urlPattern: 'url: (\\S+)' } },
    })
    const quietLogs: string[] = []
    const quietOutcome = await restorerOf(quiet)(contextFor(projectDir, { logs: quietLogs }), record)
    expect(quietOutcome.url).toBe('https://example.test/recorded')
    expect(quietLogs.some(line => line.includes('keeping the recorded URL https://example.test/recorded'))).toBe(true)

    const loud = createCommandProvider({
      id: 'rollback-cli',
      label: 'Rollback CLI',
      environments: {
        production: {
          deployCommand: printUrl('https://example.test/app'),
          rollbackCommand: printUrl('https://example.test/previous'),
          urlPattern: 'url: (\\S+)',
        },
      },
    })
    const loudOutcome = await restorerOf(loud)(contextFor(projectDir, {}), record)
    expect(loudOutcome.url).toBe('https://example.test/previous')
  })

  it('refuses a record another provider published', async () => {
    const projectDir = await tempDir('dsh-command-')
    const provider = createCommandProvider({
      id: 'owner-cli',
      label: 'Owner CLI',
      environments: { production: { deployCommand: printUrl('https://example.test/app'), rollbackCommand: 'true' } },
    })
    const record = recordFor({ id: 'rec_other', projectDir, url: 'https://example.test/app', createdAt: new Date().toISOString(), providerId: 'other-cli' })
    await expect(restorerOf(provider)(contextFor(projectDir, {}), record))
      .rejects.toThrow(/it was published by "other-cli"/u)
  })

  it('fails a command that exits non-zero, reporting the exit code and the tail', async () => {
    const projectDir = await tempDir('dsh-command-')
    const logs: string[] = []
    const provider = createCommandProvider({
      id: 'failing-cli',
      label: 'Failing CLI',
      environments: { production: { deployCommand: 'node -e "console.log(\'deploying\'); process.exitCode = 3"', urlPattern: 'url: (\\S+)' } },
    })
    const failure = await provider.publish(contextFor(projectDir, { logs })).catch((error: unknown) => error)
    if (!(failure instanceof Error)) throw new Error('a non-zero exit did not reject')
    expect(failure.message).toMatch(/exit code 3/u)
    expect(failure.message).toContain('deploying')
    expect(logs).toContain('deploying')

    const silent = createCommandProvider({
      id: 'silent-cli',
      label: 'Silent CLI',
      environments: { production: { deployCommand: 'node -e "process.exitCode = 9"', urlPattern: 'url: (\\S+)' } },
    })
    await expect(silent.publish(contextFor(projectDir, {}))).rejects.toThrow(/exit code 9[\s\S]*\(no output\)/u)
  })

  it('fails a publish that never names a URL, naming the pattern it looked for', async () => {
    const projectDir = await tempDir('dsh-command-')
    const provider = createCommandProvider({
      id: 'quiet-cli',
      label: 'Quiet CLI',
      environments: { production: { deployCommand: 'node -e "console.log(\'deployed, no url here\')"', urlPattern: 'url: (\\S+)' } },
    })
    const failure = await provider.publish(contextFor(projectDir, {})).catch((error: unknown) => error)
    if (!(failure instanceof Error)) throw new Error('a URL-less publish did not reject')
    expect(failure.message).toContain('url: (\\S+)')
    expect(failure.message).toContain('deployed, no url here')

    const unpatterned = createCommandProvider({
      id: 'unpatterned-cli',
      label: 'Unpatterned CLI',
      environments: { production: { deployCommand: 'true' } },
    })
    await expect(unpatterned.publish(contextFor(projectDir, {}))).rejects.toThrow(/no urlPattern is configured/u)

    const broken = createCommandProvider({
      id: 'broken-cli',
      label: 'Broken CLI',
      environments: { production: { deployCommand: 'true', urlPattern: 'url: (\\S+' } },
    })
    await expect(broken.publish(contextFor(projectDir, {}))).rejects.toThrow(/unusable urlPattern/u)

    // A pattern whose group captured nothing is no URL either.
    const emptyCapture = createCommandProvider({
      id: 'empty-cli',
      label: 'Empty CLI',
      environments: { production: { deployCommand: 'node -e "console.log(\'url: \')"', urlPattern: 'url: (\\S*)' } },
    })
    await expect(emptyCapture.publish(contextFor(projectDir, {}))).rejects.toThrow(/matched no output line/u)
  })

  it('records a final output line that has no trailing newline', async () => {
    const projectDir = await tempDir('dsh-command-')
    const logs: string[] = []
    const provider = createCommandProvider({
      id: 'unterminated-cli',
      label: 'Unterminated CLI',
      environments: { production: { deployCommand: 'node -e "process.stdout.write(\'url: https://example.test/app\')"', urlPattern: 'url: (\\S+)' } },
    })
    const outcome = await provider.publish(contextFor(projectDir, { logs }))
    expect(outcome.url).toBe('https://example.test/app')
    expect(logs).toContain('url: https://example.test/app')
  })

  it('kills a command that outlives its timeout', async () => {
    const projectDir = await tempDir('dsh-command-')
    const provider = createCommandProvider({
      id: 'slow-cli',
      label: 'Slow CLI',
      environments: { production: { deployCommand: 'node -e "setTimeout(() => {}, 3000)"', timeoutMs: 200, urlPattern: 'url: (\\S+)' } },
    })
    await expect(provider.publish(contextFor(projectDir, {}))).rejects.toThrow(/timed out after 200 ms/u)
  })

  it('cancels a running command and refuses one that was already cancelled', async () => {
    const projectDir = await tempDir('dsh-command-')
    const logs: string[] = []
    const provider = createCommandProvider({
      id: 'cancellable-cli',
      label: 'Cancellable CLI',
      environments: { production: { deployCommand: 'node -e "console.log(\'started\'); setTimeout(() => {}, 3000)"', urlPattern: 'url: (\\S+)' } },
    })
    const controller = new AbortController()
    const running = provider.publish(contextFor(projectDir, { logs, signal: controller.signal }))
    await vi.waitFor(() => { expect(logs).toContain('started') })
    controller.abort()
    await expect(running).rejects.toThrow(/cancelled while the command was running/u)

    const preCancelled = new AbortController()
    preCancelled.abort()
    await expect(provider.publish(contextFor(projectDir, { logs, signal: preCancelled.signal })))
      .rejects.toThrow(/cancelled before the command started/u)
  })

  it('never logs or reports a credential value, only its name', async () => {
    const secret = 'sk-test-secret-value-9876'
    const shorterSecret = 'shorter-value'
    setTestEnv('SOME_TEST_SECRET', secret)
    setTestEnv('SHORT_TEST_SECRET', shorterSecret)
    // A declared name that is set to nothing, and one that is not set at all:
    // neither may be mistaken for a value worth redacting.
    setTestEnv('EMPTY_TEST_SECRET', '')
    unsetTestEnv('UNSET_TEST_SECRET')
    const projectDir = await tempDir('dsh-command-')
    const appUrl = 'https://example.test/app'
    const secretLine = "console.log('token=' + process.env.SOME_TEST_SECRET)"
    const echoSecretThenExit = (code: number): string => `node -e "${secretLine}; process.exitCode = ${String(code)}"`
    const credentials = ['SOME_TEST_SECRET', 'SHORT_TEST_SECRET', 'EMPTY_TEST_SECRET', 'UNSET_TEST_SECRET']

    const logs: string[] = []
    const provider = createCommandProvider({
      id: 'secret-cli',
      label: 'Secret CLI',
      environments: {
        production: {
          deployCommand: `node -e "${secretLine}; console.log('url: ${appUrl}')"`,
          urlPattern: 'url: (\\S+)',
          credentials,
        },
      },
    })
    const outcome = await provider.publish(contextFor(projectDir, { logs }))
    expect(outcome.url).toBe(appUrl)
    expect(logs.some(line => line.includes('<redacted SOME_TEST_SECRET>'))).toBe(true)
    expect(logs.some(line => line.includes('SOME_TEST_SECRET, SHORT_TEST_SECRET'))).toBe(true)
    expect(logs.join('\n')).not.toContain(secret)
    expect(logs.join('\n')).not.toContain(shorterSecret)

    const failing = createCommandProvider({
      id: 'secret-cli',
      label: 'Secret CLI',
      environments: {
        production: {
          deployCommand: echoSecretThenExit(2),
          urlPattern: 'url: (\\S+)',
          credentials,
        },
      },
    })
    const failure = await failing.publish(contextFor(projectDir, { logs: [] })).catch((error: unknown) => error)
    if (!(failure instanceof Error)) throw new Error('a failing publish did not reject')
    expect(failure.message).not.toContain(secret)
    expect(failure.message).toContain('<redacted SOME_TEST_SECRET>')
    expect(failure.message).toMatch(/exit code 2/u)
  })

  it('runs the command in the configured working directory', async () => {
    const projectDir = await tempDir('dsh-command-')
    const nested = join(projectDir, 'sub')
    const fileName = 'here.txt'
    await mkdir(nested)
    await writeFile(join(nested, fileName), 'nested\n')
    const provider = createCommandProvider({
      id: 'cwd-cli',
      label: 'CWD CLI',
      environments: {
        production: {
          deployCommand: `node -e "console.log('url: https://example.test/' + require('node:fs').readFileSync('${fileName}', 'utf8').trim())"`,
          cwd: 'sub',
          urlPattern: 'url: (\\S+)',
        },
      },
    })
    const outcome = await provider.publish(contextFor(projectDir, {}))
    expect(outcome.url).toBe('https://example.test/nested')
  })

  it('keeps a long deployment readable and still finds a URL printed early', async () => {
    const projectDir = await tempDir('dsh-command-')
    const logs: string[] = []
    const appUrl = 'https://example.test/app'
    const lineCount = 400
    const provider = createCommandProvider({
      id: 'chatty-cli',
      label: 'Chatty CLI',
      environments: {
        production: {
          deployCommand: `node -e "console.log('url: ${appUrl}'); for (let i = 0; i < ${String(lineCount)}; i += 1) console.log('line ' + i)"`,
          urlPattern: 'url: (\\S+)',
        },
      },
    })
    const outcome = await provider.publish(contextFor(projectDir, { logs }))
    expect(outcome.url).toBe(appUrl)
    expect(logs.filter(line => line.startsWith('line '))).toHaveLength(lineCount)
    expect(logs.at(-1)).toBe('line 399')
  })
})
