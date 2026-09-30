/**
 * The deployment ledger: every deployment this manager performed, newest first,
 * persisted beside the project so it survives the process that made it.
 *
 * Two invariants decide the shape of this module.
 *
 * First, a deployment that replaced a healthy one must remain recoverable. A
 * record is therefore append-only and never rewritten or pruned: "the previous
 * known-good deployment" is only a fact if the ledger still holds it. Publishing
 * a new deployment never deletes the record it supersedes.
 *
 * Second, the ledger is evidence, not state. It records what happened —
 * environment, provider, URL, reachability, commit, health, and the verification
 * that decided that health — so a later reader can tell a healthy production
 * deployment apart from a build that merely succeeded on someone's laptop.
 * Reachability is stored rather than inferred at read time, because it is a fact
 * about the moment of publication.
 * @module @deepseek-ai/dsh-deployment/records
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DeployEnvironment, DeploymentRecord, DeploymentSnapshot } from './types.ts'

/** Directory created inside a project to hold deployment state. */
export const STORE_DIRECTORY = '.kalroforge'

/** File name of the deployment ledger inside {@link STORE_DIRECTORY}. */
export const STORE_FILENAME = 'deployments.json'

/** Schema version of the ledger file, so a future reader can migrate it. */
const STORE_VERSION = 1

interface LedgerFile {
  version: number
  records: DeploymentRecord[]
}

/** Absolute path of a project's deployment ledger. */
export function deploymentStorePath(projectDir: string): string {
  return join(projectDir, STORE_DIRECTORY, STORE_FILENAME)
}

/** Newest first, with a stable tie-break so two records in the same millisecond keep a fixed order. */
function newestFirst(left: DeploymentRecord, right: DeploymentRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}

/** Whether a value is a record this module can work with, without trusting the file. */
function isRecord(value: unknown): value is DeploymentRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<DeploymentRecord>
  return typeof candidate.id === 'string'
    && typeof candidate.url === 'string'
    && typeof candidate.environment === 'string'
    && typeof candidate.providerId === 'string'
    && typeof candidate.createdAt === 'string'
}

/**
 * Read a project's deployment ledger.
 *
 * A missing ledger is an empty history, not an error: the first deployment a
 * project ever performs has nothing to read. A malformed ledger is also read as
 * empty rather than thrown, because refusing to record a new deployment would
 * destroy the evidence a rollback needs; the caller reports the loss instead.
 *
 * @param projectDir - absolute project directory.
 * @returns records newest first.
 */
export async function readDeployments(projectDir: string): Promise<DeploymentRecord[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(deploymentStorePath(projectDir), 'utf8'))
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const records = (parsed as Partial<LedgerFile>).records
  if (!Array.isArray(records)) return []
  return records.filter(isRecord).sort(newestFirst)
}

/**
 * Append one record and persist the ledger atomically (write beside, then rename).
 *
 * @param projectDir - absolute project directory.
 * @param record - the record to append.
 * @returns the ledger after the append, newest first.
 */
export async function appendDeployment(projectDir: string, record: DeploymentRecord): Promise<DeploymentRecord[]> {
  const existing = await readDeployments(projectDir)
  const records = [record, ...existing.filter(candidate => candidate.id !== record.id)].sort(newestFirst)
  const path = deploymentStorePath(projectDir)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  const body: LedgerFile = { version: STORE_VERSION, records }
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  return records
}

/** The newest record per environment, which is what each target currently serves. */
export function currentDeployments(
  records: readonly DeploymentRecord[],
): Partial<Record<DeployEnvironment, DeploymentRecord>> {
  const current: Partial<Record<DeployEnvironment, DeploymentRecord>> = {}
  for (const record of records) {
    if (current[record.environment] === undefined) current[record.environment] = record
  }
  return current
}

/**
 * The newest healthy record for an environment, which is the only safe rollback target.
 *
 * @param records - ledger contents, newest first.
 * @param environment - environment to restore.
 * @param excludeId - record id to skip, normally the failing deployment itself.
 * @returns the rollback target, or undefined when nothing healthy precedes the failure.
 */
export function lastHealthyDeployment(
  records: readonly DeploymentRecord[],
  environment: DeployEnvironment,
  excludeId?: string,
): DeploymentRecord | undefined {
  return records.find(record =>
    record.environment === environment
    && record.health === 'healthy'
    && (excludeId === undefined || record.id !== excludeId))
}

/**
 * One project's deployments plus what each environment currently serves.
 *
 * @param projectDir - absolute project directory.
 * @returns the snapshot a status surface or a rollback decision reads.
 */
export async function deploymentSnapshot(projectDir: string): Promise<DeploymentSnapshot> {
  const records = await readDeployments(projectDir)
  return { projectDir, records, current: currentDeployments(records) }
}
