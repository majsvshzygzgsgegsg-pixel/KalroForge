/**
 * The deployment pipeline end to end: planning boundaries, publish, verification,
 * recording, and rollback — with a real HTTP server standing in for a host, so
 * verification is exercised rather than stubbed.
 */

import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { DeploymentManager } from '../src/manager.ts'
import { readDeployments } from '../src/records.ts'
import type { DeployCapability, DeploymentRecord, ProjectPlan, ProviderAdapter, ProviderContext, PublishOutcome } from '../src/types.ts'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A temporary project directory. */
function project(files: Readonly<Record<string, string>> = { 'index.html': '<h1>site</h1>' }): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deploy-project-'))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  return writeFiles(root, files)
}

/** Write files into a directory, creating parents. */
function writeFiles(root: string, files: Readonly<Record<string, string>>): string {
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body, 'utf8')
  }
  return root
}

/** A stand-in host: a real server whose body the adapter can swap, so a rollback can be observed. */
interface FakeHost {
  adapter: ProviderAdapter
  url: string
  served(): string
  publishes: number
  /** Make the next publish report a URL that cannot answer, to exercise a failed deployment. */
  fail(): void
}

/**
 * Build a provider that serves one HTML body over a real local HTTP server.
 * @param options - capability, credential and outcome knobs the tests vary.
 */
async function fakeHost(options: {
  capabilities?: readonly DeployCapability[]
  consequential?: boolean
  credentials?: readonly string[]
  url?: string
  rollback?: boolean
} = {}): Promise<FakeHost> {
  let body = '<html><body>initial</body></html>'
  let failing = false
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const url = options.url ?? `http://127.0.0.1:${port}/`
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))

  const host: FakeHost = {
    url,
    publishes: 0,
    served: () => body,
    fail: () => { failing = true },
    adapter: {
      descriptor: {
        id: 'fake-host',
        label: 'Fake host',
        capabilities: options.capabilities ?? ['static'],
        consequential: options.consequential ?? false,
        credentials: options.credentials ?? [],
        supportsRollback: options.rollback !== false,
      },
      supports: (plan: ProjectPlan) => plan.capabilities.every(capability => (options.capabilities ?? ['static']).includes(capability)),
      publish: async (context: ProviderContext): Promise<PublishOutcome> => {
        host.publishes += 1
        if (failing) return { url: 'http://127.0.0.1:1/' }
        body = `<html><body>release ${context.deploymentId}</body></html>`
        context.log(`fake host published ${context.deploymentId}`)
        return { url }
      },
      restore: async (_context: ProviderContext, record: DeploymentRecord): Promise<PublishOutcome> => {
        failing = false
        body = `<html><body>release ${record.id}</body></html>`
        return { url }
      },
    },
  }
  return host
}

/** Mount a manager with one adapter and return both. */
async function managerWith(
  adapter: ProviderAdapter,
  releaseRoot: string,
  options: { autoRollback?: boolean } = {},
): Promise<{ ctx: Context; manager: DeploymentManager }> {
  const ctx = new Context()
  await ctx.plugin(DeploymentManager, {
    releaseRoot,
    ...options.autoRollback === undefined ? {} : { autoRollback: options.autoRollback },
  })
  const manager = ctx.deployments
  manager.registerProvider(adapter)
  cleanups.push(() => ctx.fiber.dispose())
  return { ctx, manager }
}

/** A release root inside a temporary directory. */
function releaseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deploy-releases-'))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

describe('deployment planning', () => {
  it('plans a static project through the registered adapter without publishing anything', async () => {
    const host = await fakeHost()
    const { manager } = await managerWith(host.adapter, releaseRoot())
    const plan = await manager.plan({ projectDir: project() })

    expect(plan.provider?.id).toBe('fake-host')
    expect(plan.blocked).toBeUndefined()
    expect(host.publishes).toBe(0)
  })

  it('stops at an unrecognisable project instead of guessing a provider', async () => {
    const host = await fakeHost()
    const { manager } = await managerWith(host.adapter, releaseRoot())
    const plan = await manager.plan({ projectDir: project({ 'notes.txt': 'nothing to deploy' }) })

    expect(plan.blocked?.reason).toBe('unknown-project')
    expect(plan.blocked?.requiredAction).toBeDefined()
  })

  it('names the environment variable that blocks a credentialed provider', async () => {
    const host = await fakeHost({ credentials: ['DSH_TEST_DEPLOY_TOKEN'] })
    const { manager } = await managerWith(host.adapter, releaseRoot())
    const plan = await manager.plan({ projectDir: project() })

    expect(plan.blocked?.reason).toBe('credentials')
    expect(plan.blocked?.missingEnv).toEqual(['DSH_TEST_DEPLOY_TOKEN'])
    expect(plan.blocked?.requiredAction).toContain('DSH_TEST_DEPLOY_TOKEN')
  })

  it('refuses to publish through a consequential provider without the user\'s approval', async () => {
    const host = await fakeHost({ consequential: true })
    const { manager } = await managerWith(host.adapter, releaseRoot())
    const root = project()

    const blocked = await manager.deploy({ projectDir: root, environment: 'staging' })
    expect(blocked.status).toBe('blocked')
    expect(blocked.status === 'blocked' ? blocked.blocked.reason : '').toBe('approval')

    const approved = await manager.deploy({
      projectDir: root,
      environment: 'staging',
      approval: { action: 'deploy to staging', approvedAt: new Date().toISOString(), note: 'go ahead' },
    })
    expect(approved.status).toBe('deployed')
  })
})

describe('publishing', () => {
  it('publishes, verifies the live URL, and records what it did', async () => {
    const host = await fakeHost()
    const { manager } = await managerWith(host.adapter, releaseRoot())
    const root = project()

    const outcome = await manager.deploy({ projectDir: root, environment: 'preview', commit: 'abc1234' })
    expect(outcome.status).toBe('deployed')
    if (outcome.status !== 'deployed') return

    expect(outcome.report.healthy).toBe(true)
    expect(outcome.report.reachability).toBe('local')
    expect(outcome.record.commit).toBe('abc1234')
    expect(outcome.record.health).toBe('healthy')
    expect(outcome.record.url).toBe(host.url)

    const records = await readDeployments(root)
    expect(records.map(record => record.id)).toEqual([outcome.record.id])
  })

  it('blocks a publish when the project holds a likely secret', async () => {
    const host = await fakeHost()
    const { manager } = await managerWith(host.adapter, releaseRoot())
    const root = project({
      'index.html': '<h1>site</h1>',
      'src/config.ts': 'export const key = "-----BEGIN RSA' + ' PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA' + ' PRIVATE KEY-----"\n',
    })

    const outcome = await manager.deploy({ projectDir: root, environment: 'preview' })
    expect(outcome.status).toBe('blocked')
    expect(outcome.status === 'blocked' ? outcome.blocked.reason : '').toBe('secrets')
    expect(host.publishes).toBe(0)
  })

  it('fails the deployment when the build command fails', async () => {
    const host = await fakeHost()
    const { manager } = await managerWith(host.adapter, releaseRoot())
    const root = project({
      'package.json': JSON.stringify({ scripts: { build: 'node -e "process.exit(3)"' } }),
    })

    const outcome = await manager.deploy({ projectDir: root, environment: 'preview' })
    expect(outcome.status).toBe('failed')
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('build command failed')
    expect(host.publishes).toBe(0)
  })

  it('never reports a production deployment served from a local address', async () => {
    const host = await fakeHost()
    const { manager } = await managerWith(host.adapter, releaseRoot())
    const root = project()

    const outcome = await manager.deploy({ projectDir: root, environment: 'production' })
    expect(outcome.status).toBe('failed')
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('public-reachability')

    // The attempt is still recorded, because that is what a rollback reads.
    const records = await readDeployments(root)
    expect(records[0]?.health).toBe('unhealthy')
    expect(records[0]?.reachability).toBe('local')
    expect(records[0]?.verification?.checks.some(check => check.id === 'public-reachability' && check.status === 'fail')).toBe(true)
  })
})

describe('rollback', () => {
  it('restores the previous healthy deployment and records what it restored', async () => {
    const host = await fakeHost()
    const { manager } = await managerWith(host.adapter, releaseRoot())
    const root = project()

    const first = await manager.deploy({ projectDir: root, environment: 'preview' })
    expect(first.status).toBe('deployed')
    if (first.status !== 'deployed') return

    // A second publish whose URL cannot answer: the host reports a dead port.
    host.fail()
    const second = await manager.deploy({ projectDir: root, environment: 'preview', providerId: 'fake-host' })
    expect(second.status).toBe('failed')

    const restored = await manager.rollback({ projectDir: root, environment: 'preview' })
    expect(restored.status).toBe('deployed')
    if (restored.status !== 'deployed') return

    expect(restored.record.rolledBackFrom).toBe(first.record.id)
    // The rollback really changed what the host serves, not just the ledger.
    expect(host.served()).toContain(first.record.id)

    const records = await readDeployments(root)
    expect(records.map(record => record.id)).toContain(first.record.id)
    expect(records).toHaveLength(3)
  })

  it('refuses when nothing healthy precedes the current deployment', async () => {
    const host = await fakeHost()
    const { manager } = await managerWith(host.adapter, releaseRoot())
    const root = project()

    const outcome = await manager.rollback({ projectDir: root, environment: 'production' })
    expect(outcome.status).toBe('blocked')
    expect(outcome.status === 'blocked' ? outcome.blocked.reason : '').toBe('no-target')
  })
})
