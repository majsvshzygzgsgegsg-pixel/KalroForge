/** Project detection and the deployment ledger: the facts a plan and a rollback are decided from. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProject, isRecognised } from '../src/detect.ts'
import {
  appendDeployment, currentDeployments, deploymentStorePath, lastHealthyDeployment, readDeployments,
} from '../src/records.ts'
import type { DeploymentRecord } from '../src/types.ts'

const roots: string[] = []

/** Create a temporary project directory holding the given files. */
function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deploy-detect-'))
  roots.push(root)
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body, 'utf8')
  }
  return root
}

/** One ledger record with the fields a test cares about. */
function record(id: string, environment: DeploymentRecord['environment'], health: DeploymentRecord['health'], createdAt: string): DeploymentRecord {
  return {
    id,
    projectDir: '/tmp/project',
    environment,
    providerId: 'local-static',
    url: `http://127.0.0.1:4000/${id}`,
    reachability: 'local',
    createdAt,
    health,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('detectProject', () => {
  it('reads a static site as static with no build step', async () => {
    const plan = await detectProject(project({ 'index.html': '<h1>hi</h1>' }))

    expect(plan.kind).toBe('static-site')
    expect(plan.capabilities).toEqual(['static'])
    expect(plan.buildCommand).toBeUndefined()
    expect(isRecognised(plan)).toBe(true)
  })

  it('reads a vite project as static and names its build output', async () => {
    const plan = await detectProject(project({
      'package.json': JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
      'pnpm-lock.yaml': '',
    }))

    expect(plan.kind).toBe('node-app')
    expect(plan.capabilities).toEqual(['static'])
    expect(plan.packageManager).toBe('pnpm')
    expect(plan.buildCommand).toBe('pnpm run build')
    expect(plan.outputDir).toBe('dist')
  })

  it('reads a Dockerfile as a container even when a package.json is present', async () => {
    const plan = await detectProject(project({
      Dockerfile: 'FROM node:22',
      'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
    }))

    expect(plan.kind).toBe('container')
    expect(plan.capabilities).toContain('container')
  })

  it('adds the database capability when a driver is a dependency', async () => {
    const plan = await detectProject(project({
      'package.json': JSON.stringify({ dependencies: { express: '^4', pg: '^8' } }),
    }))

    expect(plan.capabilities).toContain('serverless')
    expect(plan.capabilities).toContain('database')
  })

  it('refuses to invent a plan for an unrecognisable directory', async () => {
    const plan = await detectProject(project({ 'notes.txt': 'hello' }))

    expect(plan.kind).toBe('unknown')
    expect(plan.capabilities).toEqual([])
    expect(isRecognised(plan)).toBe(false)
    expect(plan.reasons.join(' ')).toContain('no package manifest')
  })
})

describe('the deployment ledger', () => {
  it('reads a missing ledger as empty history rather than failing', async () => {
    await expect(readDeployments(project())).resolves.toEqual([])
  })

  it('keeps every record, newest first, and never drops the one a new deployment replaces', async () => {
    const root = project()
    await appendDeployment(root, record('dep_1', 'production', 'healthy', '2026-01-01T00:00:00.000Z'))
    await appendDeployment(root, record('dep_2', 'production', 'unhealthy', '2026-01-02T00:00:00.000Z'))

    const records = await readDeployments(root)
    expect(records.map(candidate => candidate.id)).toEqual(['dep_2', 'dep_1'])
  })

  it('reports what each environment currently serves, and the predecessor a rollback could restore', async () => {
    const root = project()
    await appendDeployment(root, record('dep_old', 'production', 'healthy', '2026-01-01T00:00:00.000Z'))
    await appendDeployment(root, record('dep_new', 'production', 'unhealthy', '2026-01-02T00:00:00.000Z'))
    await appendDeployment(root, record('dep_stage', 'staging', 'healthy', '2026-01-03T00:00:00.000Z'))

    const records = await readDeployments(root)
    const current = currentDeployments(records)
    expect(current.production?.id).toBe('dep_new')
    expect(current.staging?.id).toBe('dep_stage')
    expect(current.preview).toBeUndefined()

    // The failing deployment is not its own rollback target.
    expect(lastHealthyDeployment(records, 'production', 'dep_new')?.id).toBe('dep_old')
    expect(lastHealthyDeployment(records, 'production', 'dep_old')).toBeUndefined()
  })

  it('writes the ledger inside the project so a later process can still find it', async () => {
    const root = project()
    await appendDeployment(root, record('dep_1', 'preview', 'healthy', '2026-01-01T00:00:00.000Z'))

    expect(deploymentStorePath(root)).toBe(join(root, '.kalroforge', 'deployments.json'))
  })
})
