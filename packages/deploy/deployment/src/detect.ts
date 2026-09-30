/**
 * Project detection: read a directory and decide what publishing it actually
 * requires.
 *
 * The planner cannot ask the user "is this a static site or a container?" — it
 * needs an answer from the project itself, and it needs to be able to justify
 * that answer. Every fact that shaped the verdict is recorded in
 * {@link ProjectPlan.reasons}, so a plan can be argued with instead of trusted:
 * a wrong verdict is then a wrong line, not an unexplainable choice.
 *
 * The detector is deliberately conservative. It reports what it can see on
 * disk, never what it hopes is true: an unrecognisable directory comes back
 * `unknown` with no capabilities, which makes the manager stop and ask the user
 * rather than guess a provider for a project nobody described.
 * @module @deepseek-ai/dsh-deployment/detect
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeployCapability, ProjectKind, ProjectPlan } from './types.ts'

/** Framework dependency → the capabilities publishing it needs. */
const FRAMEWORK_CAPABILITIES: Readonly<Record<string, readonly DeployCapability[]>> = {
  next: ['serverless'],
  nuxt: ['serverless'],
  remix: ['serverless'],
  '@remix-run/dev': ['serverless'],
  '@sveltejs/kit': ['serverless'],
  astro: ['static'],
  gatsby: ['static'],
  vite: ['static'],
  'react-scripts': ['static'],
  svelte: ['static'],
  vue: ['static'],
  express: ['serverless'],
  fastify: ['serverless'],
  hono: ['serverless'],
  koa: ['serverless'],
}

/** Framework dependency → the directory its production build writes. */
const FRAMEWORK_OUTPUT: Readonly<Record<string, string>> = {
  vite: 'dist',
  astro: 'dist',
  gatsby: 'public',
  'react-scripts': 'build',
  svelte: 'build',
  vue: 'dist',
}

/** Dependencies that imply a database the deployment must be able to reach. */
const DATABASE_DEPENDENCIES = [
  'prisma', '@prisma/client', 'drizzle-orm', 'knex', 'sequelize', 'typeorm',
  'pg', 'mysql2', 'mongodb', 'better-sqlite3', 'redis', 'ioredis',
]

/** Dependencies that imply a long-lived worker the deployment must run. */
const WORKER_DEPENDENCIES = ['bullmq', 'bull', 'agenda', 'celery', 'sidekiq']

/** Lockfile name → package manager. */
const LOCKFILES: readonly (readonly [string, ProjectPlan['packageManager']])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
]

/** The command that runs one package script under a package manager. */
function runScript(manager: NonNullable<ProjectPlan['packageManager']>, script: string): string {
  return manager === 'npm' ? `npm run ${script}` : `${manager} run ${script}`
}

/** Read and parse a JSON file, or undefined when it is absent or malformed. */
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** The dependency names a package.json declares across every dependency field. */
function dependencyNames(pkg: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const group = pkg[field]
    if (typeof group !== 'object' || group === null || Array.isArray(group)) continue
    for (const name of Object.keys(group)) names.add(name)
  }
  return names
}

/** The script names a package.json declares. */
function scriptNames(pkg: Record<string, unknown>): Set<string> {
  const scripts = pkg['scripts']
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return new Set()
  return new Set(Object.keys(scripts))
}

/** Merge capability hints, keeping a stable order. */
function withCapabilities(base: readonly DeployCapability[], extra: readonly DeployCapability[]): DeployCapability[] {
  const merged = [...base]
  for (const capability of extra) if (!merged.includes(capability)) merged.push(capability)
  return merged
}

/**
 * Detect what a directory needs in order to be published.
 *
 * @param projectDir - absolute project directory; it does not have to be a git repository.
 * @returns the plan, with one `reasons` line per fact that shaped it.
 */
export async function detectProject(projectDir: string): Promise<ProjectPlan> {
  const reasons: string[] = []
  const entries = await readdir(projectDir).catch((): string[] => [])

  let packageManager: ProjectPlan['packageManager']
  for (const [lockfile, manager] of LOCKFILES) {
    if (entries.includes(lockfile) && manager !== undefined) {
      packageManager = manager
      reasons.push(`${lockfile} selects the ${manager} package manager`)
      break
    }
  }
  if (packageManager === undefined && entries.includes('package.json')) {
    packageManager = 'npm'
    reasons.push('no lockfile found; falling back to npm')
  }

  let capabilities: DeployCapability[] = []
  let kind: ProjectKind = 'unknown'
  let outputDir: string | undefined
  let buildCommand: string | undefined
  let startCommand: string | undefined

  const pkg = entries.includes('package.json')
    ? await readJson(join(projectDir, 'package.json'))
    : undefined
  const dependencies = pkg === undefined ? new Set<string>() : dependencyNames(pkg)
  const scripts = pkg === undefined ? new Set<string>() : scriptNames(pkg)

  for (const framework of Object.keys(FRAMEWORK_CAPABILITIES)) {
    if (!dependencies.has(framework)) continue
    const mapped = FRAMEWORK_CAPABILITIES[framework] ?? []
    capabilities = withCapabilities(capabilities, mapped)
    const frameworkOutput = FRAMEWORK_OUTPUT[framework]
    if (frameworkOutput !== undefined && outputDir === undefined) outputDir = frameworkOutput
    reasons.push(`${framework} in dependencies publishes as ${mapped.join(' + ') || 'an unknown shape'}`)
  }

  if (entries.includes('Dockerfile')) {
    kind = 'container'
    capabilities = withCapabilities(capabilities, ['container'])
    reasons.push('Dockerfile present: the project ships as a container image')
  } else if (pkg !== undefined) {
    kind = 'node-app'
    if (capabilities.length === 0) {
      if (scripts.has('build')) {
        capabilities = ['static']
        outputDir ??= 'dist'
        reasons.push('no web framework detected; a build script is treated as a static output')
      } else if (scripts.has('start')) {
        capabilities = ['serverless']
        reasons.push('no web framework detected; a start script needs a long-lived process')
      } else {
        reasons.push('package.json declares neither a build nor a start script')
      }
    }
  } else if (entries.includes('requirements.txt') || entries.includes('pyproject.toml')) {
    kind = 'python-app'
    capabilities = withCapabilities(capabilities, ['serverless'])
    reasons.push('a Python project manifest is present')
  } else if (entries.includes('index.html')) {
    kind = 'static-site'
    capabilities = withCapabilities(capabilities, ['static'])
    reasons.push('index.html at the project root with no package manifest')
  } else {
    reasons.push('no package manifest, Python manifest, Dockerfile, or index.html was found')
  }

  if (pkg !== undefined) {
    if (scripts.has('build') && packageManager !== undefined) {
      buildCommand = runScript(packageManager, 'build')
      reasons.push(`package.json declares a build script: ${buildCommand}`)
    }
    if (scripts.has('start') && packageManager !== undefined) {
      startCommand = runScript(packageManager, 'start')
      reasons.push(`package.json declares a start script: ${startCommand}`)
    }
  }

  const databaseHints: DeployCapability[] = []
  for (const dependency of DATABASE_DEPENDENCIES) {
    if (!dependencies.has(dependency)) continue
    databaseHints.push('database')
    reasons.push(`${dependency} in dependencies needs a reachable database`)
    break
  }
  for (const dependency of WORKER_DEPENDENCIES) {
    if (!dependencies.has(dependency)) continue
    databaseHints.push('worker')
    reasons.push(`${dependency} in dependencies needs a background worker`)
    break
  }
  if (databaseHints.length === 0) {
    const example = entries.includes('.env.example') ? await readFile(join(projectDir, '.env.example'), 'utf8').catch(() => '') : ''
    if (/^DATABASE_URL=/mu.test(example)) {
      databaseHints.push('database')
      reasons.push('.env.example declares DATABASE_URL, so a database is expected in every environment')
    }
  }
  capabilities = withCapabilities(capabilities, databaseHints)

  const plan: ProjectPlan = {
    projectDir,
    kind,
    capabilities,
    reasons,
    ...outputDir !== undefined ? { outputDir } : {},
    ...buildCommand !== undefined ? { buildCommand } : {},
    ...startCommand !== undefined ? { startCommand } : {},
    ...packageManager !== undefined ? { packageManager } : {},
  }
  return plan
}

/** Whether the detector could say anything at all about a directory. */
export function isRecognised(plan: ProjectPlan): boolean {
  return plan.kind !== 'unknown' && plan.capabilities.length > 0
}
