/**
 * The deployment manager: the one place that knows the difference between a
 * project that builds and a deployment that is live.
 *
 * The pipeline is plan → scan → build → scan → publish → verify → record, and
 * every stage can stop the run rather than let a later stage paper over it. The
 * two rules that give this module its shape:
 *
 * - **A build passing is not a deployment.** Health comes from verification of
 *   the published URL, never from the build exit code, and a production
 *   deployment whose URL is not publicly reachable is a failed deployment even
 *   when every check on that URL passed. That is what stops a localhost server
 *   from ever being reported as a live application.
 * - **A failure must leave the previous deployment recoverable.** Every attempt
 *   is recorded — including the ones that failed verification — because the
 *   previous healthy deployment is only findable if the ledger still holds it.
 *
 * Consequential provider actions (anything that can create an account, change
 * billing, or buy a domain) stop at an approval boundary: the manager returns
 * `blocked` naming exactly what the user must do, and never performs them on the
 * model's initiative.
 * @module @deepseek-ai/dsh-deployment/manager
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { detectProject, isRecognised } from './detect.ts'
import { appendDeployment, currentDeployments, deploymentSnapshot, lastHealthyDeployment, readDeployments } from './records.ts'
import { scanForSecrets } from './secrets.ts'
import { reachabilityOf, verifyDeployment } from './verify.ts'
import type {
  DeployApproval, DeployBlocked, DeployEnvironment, DeployOutcome, DeployPlan, DeployRequest,
  DeploymentRecord, DeploymentSnapshot, ProjectPlan, ProviderAdapter, ProviderDescriptor,
  PublishOutcome, RollbackRequest, SecretFinding, SecretScanResult, VerificationCheck, VerificationReport,
} from './types.ts'

/** Default per-command budget for a project build. */
const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000

/** Default per-request budget for verification. */
const DEFAULT_VERIFY_TIMEOUT_MS = 15 * 1000

/** Log lines kept on a record; the full log stays in the manager's own output. */
const RECORDED_LOG_LINES = 200

/** Asset extensions worth probing on a published static surface. */
const PROBE_EXTENSIONS = new Set(['.js', '.mjs', '.css'])

/** How many built assets verification probes. */
const PROBE_ASSET_COUNT = 2

declare module '@deepseek-ai/cordis' {
  interface Context {
    deployments: DeploymentManager
  }
}

/** Manager options, supplied by the plugin Config. */
export interface DeploymentManagerOptions {
  /** Directory that holds published releases for the local adapter. */
  releaseRoot: string
  /** Provider id used when a request names none. */
  defaultProvider?: string
  /**
   * Restore the previous healthy production deployment automatically when a
   * production publish fails verification. Off by default: an automatic
   * restore is a production change and the user should have asked for it.
   */
  autoRollback?: boolean
  /** Per-command build budget. */
  buildTimeoutMs?: number
  /** Per-request verification budget. */
  verifyTimeoutMs?: number
}

/** One finished child process. */
interface CommandOutcome {
  /** True when the process exited zero. */
  ok: boolean
  /** Exit code, or null when the process was killed by a signal. */
  code: number | null
  /** Combined stdout and stderr, line by line. */
  logs: string[]
}

/** Split streamed chunks into lines, keeping the unterminated tail for the next chunk. */
function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let pending = ''
  return (chunk: string) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  }
}

/** A short, sortable identifier for one deployment attempt. */
function newDeploymentId(): string {
  return `dep_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
}

/** URL path for one built file, always posix-separated. */
function urlPathFor(root: string, file: string): string {
  return `/${relative(root, file).split(sep).join('/')}`
}

/**
 * The deployment manager service (`ctx.deployments`).
 *
 * Adapters are registered into it, never imported by it, which is what keeps a
 * provider choice a composition decision instead of a code change.
 */
export class DeploymentManager extends Service {
  private readonly adapters = new Map<string, ProviderAdapter>()
  private readonly options: DeploymentManagerOptions

  /**
   * @param ctx - owning Cordis context; the service registers as `ctx.deployments`.
   * @param options - validated plugin configuration.
   */
  constructor(ctx: Context, options: DeploymentManagerOptions) {
    super(ctx, 'deployments')
    this.options = options
  }

  /**
   * Register one provider adapter.
   *
   * @param adapter - the adapter to make selectable.
   * @returns a disposer that removes it again.
   */
  registerProvider(adapter: ProviderAdapter): () => void {
    const id = adapter.descriptor.id
    if (this.adapters.has(id)) {
      throw new Error(`a deployment provider with id "${id}" is already registered`)
    }
    this.adapters.set(id, adapter)
    return () => {
      if (this.adapters.get(id) === adapter) this.adapters.delete(id)
    }
  }

  /** Every registered adapter's descriptor, ordered by id. */
  providers(): ProviderDescriptor[] {
    return [...this.adapters.values()]
      .map(adapter => adapter.descriptor)
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /** The directory this manager publishes local releases into. */
  get releaseRoot(): string {
    return this.options.releaseRoot
  }

  /**
   * Inspect a project and decide what would publish it.
   *
   * @param request - the project, the target environment, and an optional exact provider.
   * @returns the detection result beside the chosen provider, or why none is usable.
   */
  async plan(request: { projectDir: string; environment?: DeployEnvironment; providerId?: string }): Promise<DeployPlan> {
    const project = await detectProject(request.projectDir)
    if (!isRecognised(project)) {
      return {
        project,
        blocked: {
          reason: 'unknown-project',
          detail: 'the detector could not tell how this directory builds or serves',
          requiredAction: 'tell me how the project builds and what serves it, or add a package.json build script, a Dockerfile, or an index.html',
        },
      }
    }

    const requested = request.providerId ?? this.options.defaultProvider
    const candidates = [...this.adapters.values()]
      .filter(adapter => adapter.supports(project))
      .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id))

    if (candidates.length === 0) {
      return {
        project,
        blocked: {
          reason: 'no-provider',
          detail: `no registered provider can publish a ${project.kind} needing ${project.capabilities.join(' + ') || 'nothing'}`,
          requiredAction: `connect a provider for ${project.capabilities.join(' + ') || 'this project'}, then deploy`,
        },
      }
    }

    const chosen = requested === undefined
      ? candidates.find(candidate => this.missingCredentials(candidate.descriptor).length === 0) ?? candidates[0]
      : candidates.find(candidate => candidate.descriptor.id === requested)
    if (chosen === undefined) {
      return {
        project,
        blocked: {
          reason: 'no-provider',
          detail: `provider "${requested}" is not registered or cannot publish this project`,
          requiredAction: `use one of: ${candidates.map(candidate => candidate.descriptor.id).join(', ')}`,
        },
      }
    }

    const missingEnv = this.missingCredentials(chosen.descriptor)
    if (missingEnv.length > 0) {
      return {
        project,
        provider: chosen.descriptor,
        blocked: {
          reason: 'credentials',
          detail: `${chosen.descriptor.label} needs ${missingEnv.join(', ')} before it can publish`,
          requiredAction: `set ${missingEnv.join(', ')} in the environment that runs KairoForge, then deploy again`,
          missingEnv,
        },
      }
    }

    return { project, provider: chosen.descriptor }
  }

  /**
   * Publish a project and verify the result before calling it deployed.
   *
   * @param request - the deployment request.
   * @returns the recorded deployment, or the exact boundary that stopped it.
   */
  async deploy(request: DeployRequest): Promise<DeployOutcome> {
    const plan = await this.plan({
      projectDir: request.projectDir,
      environment: request.environment,
      ...request.providerId === undefined ? {} : { providerId: request.providerId },
    })
    if (plan.provider === undefined || plan.blocked !== undefined) {
      return { status: 'blocked', blocked: plan.blocked ?? { reason: 'no-provider', detail: 'no provider was selected' } }
    }
    const adapter = this.adapters.get(plan.provider.id)
    if (adapter === undefined) {
      return { status: 'blocked', blocked: { reason: 'no-provider', detail: `provider "${plan.provider.id}" disappeared between plan and publish` } }
    }
    if (adapter.descriptor.consequential && request.approval === undefined) {
      return { status: 'blocked', blocked: this.approvalBoundary(adapter.descriptor, request.environment) }
    }

    const logs: string[] = []
    const log = (line: string): void => {
      logs.push(line)
      this.ctx.logger.info(`deploy[${plan.project.projectDir}]: ${line}`)
    }

    const sourceScan = await scanForSecrets(request.projectDir)
    if (!sourceScan.clean && request.allowSecretFindings !== true) {
      return { status: 'blocked', blocked: this.secretBoundary(sourceScan, 'source') }
    }
    log(`secret scan of the project: ${sourceScan.findings.length} finding(s) in ${sourceScan.scannedFiles} file(s)`)

    if (plan.project.buildCommand !== undefined) {
      const build = await this.runCommand(
        plan.project.buildCommand,
        plan.project.projectDir,
        this.options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
        log,
      )
      if (!build.ok) {
        return {
          status: 'failed',
          error: `build command failed (exit ${build.code ?? 'signal'}): ${plan.project.buildCommand}`,
          logs: logs.slice(-RECORDED_LOG_LINES),
        }
      }
    }

    const outputScan = plan.project.outputDir === undefined
      ? undefined
      : await scanForSecrets(resolve(plan.project.projectDir, plan.project.outputDir))
    if (outputScan !== undefined && !outputScan.clean && request.allowSecretFindings !== true) {
      return { status: 'blocked', blocked: this.secretBoundary(outputScan, 'build output') }
    }
    if (outputScan !== undefined) {
      log(`secret scan of ${plan.project.outputDir}: ${outputScan.findings.length} finding(s) in ${outputScan.scannedFiles} file(s)`)
    }

    const id = newDeploymentId()
    const history = await readDeployments(plan.project.projectDir)
    let published: PublishOutcome
    try {
      published = await adapter.publish({
        deploymentId: id,
        projectDir: plan.project.projectDir,
        environment: request.environment,
        plan: plan.project,
        history,
        log,
      })
    } catch (error: unknown) {
      return { status: 'failed', error: `publish failed: ${String(error)}`, logs: logs.slice(-RECORDED_LOG_LINES) }
    }
    log(`published at ${published.url}`)

    const report = await this.verifyPublished(published.url, plan.project, request)
    const record = this.buildRecord({
      id, request, plan: plan.project, providerId: adapter.descriptor.id,
      url: published.url, report, logs,
      ...published.externalId !== undefined ? { externalId: published.externalId } : {},
      ...request.allowSecretFindings === true && !sourceScan.clean ? { secretFindings: sourceScan.findings } : {},
    })
    await appendDeployment(plan.project.projectDir, record)

    if (report.healthy) return { status: 'deployed', record, report }

    const autoRollback = this.options.autoRollback === true && request.environment === 'production'
    if (autoRollback) {
      const restored = await this.rollback({ projectDir: plan.project.projectDir, environment: request.environment })
      if (restored.status === 'deployed') {
        return {
          status: 'failed',
          error: `${this.failedChecks(report)}; automatically restored ${restored.record.id} (${restored.record.url})`,
          logs: logs.slice(-RECORDED_LOG_LINES),
        }
      }
    }
    return {
      status: 'failed',
      error: `${this.failedChecks(report)}${autoRollback ? '; automatic rollback did not restore a healthy deployment' : ''}`,
      logs: logs.slice(-RECORDED_LOG_LINES),
    }
  }

  /**
   * Restore an earlier deployment.
   *
   * The target is the newest healthy record for the environment unless the caller
   * names one, and the restore itself is verified before it is reported.
   *
   * @param request - which environment to restore, and optionally which record.
   * @returns the restoring deployment's outcome.
   */
  async rollback(request: RollbackRequest): Promise<DeployOutcome> {
    const records = await readDeployments(request.projectDir)
    const current = currentDeployments(records)[request.environment]
    const target = request.recordId === undefined
      ? lastHealthyDeployment(records, request.environment, current?.id)
      : records.find(record => record.id === request.recordId)
    if (target === undefined) {
      return {
        status: 'blocked',
        blocked: {
          reason: 'no-target',
          detail: request.recordId === undefined
            ? `no healthy ${request.environment} deployment precedes the current one`
            : `no deployment ${request.recordId} is recorded for this project`,
          requiredAction: 'deploy a healthy version first, or name a record that exists in the deployment history',
        },
      }
    }
    const adapter = this.adapters.get(target.providerId)
    if (adapter?.restore === undefined || !adapter.descriptor.supportsRollback) {
      return {
        status: 'blocked',
        blocked: {
          reason: 'unreachable-provider',
          detail: `provider "${target.providerId}" cannot republish an earlier deployment`,
          requiredAction: 'restore it in the provider\'s own dashboard, or deploy a fix forward',
        },
      }
    }
    if (adapter.descriptor.consequential && request.approval === undefined) {
      return { status: 'blocked', blocked: this.approvalBoundary(adapter.descriptor, request.environment, 'rollback') }
    }

    const logs: string[] = []
    const log = (line: string): void => {
      logs.push(line)
      this.ctx.logger.info(`rollback[${request.projectDir}]: ${line}`)
    }
    const id = newDeploymentId()
    const plan = await detectProject(request.projectDir)
    let restored: PublishOutcome
    try {
      restored = await adapter.restore({
        deploymentId: id,
        projectDir: request.projectDir,
        environment: request.environment,
        plan,
        history: records,
        log,
      }, target)
    } catch (error: unknown) {
      return { status: 'failed', error: `restore failed: ${String(error)}`, logs: logs.slice(-RECORDED_LOG_LINES) }
    }

    const report = await this.verifyUrl(restored.url, request.environment, plan)
    const record = this.buildRecord({
      id,
      request: { projectDir: request.projectDir, environment: request.environment },
      plan,
      providerId: adapter.descriptor.id,
      url: restored.url,
      report,
      logs,
      rolledBackFrom: target.id,
      note: `restored ${target.id}`,
    })
    await appendDeployment(request.projectDir, record)
    if (!report.healthy) {
      return { status: 'failed', error: `restored deployment did not verify: ${this.failedChecks(report)}`, logs: logs.slice(-RECORDED_LOG_LINES) }
    }
    return { status: 'deployed', record, report }
  }

  /**
   * Read a project's deployment history and what each environment currently serves.
   *
   * @param projectDir - absolute project directory.
   * @returns the snapshot.
   */
  async status(projectDir: string): Promise<DeploymentSnapshot> {
    return deploymentSnapshot(projectDir)
  }

  /**
   * Verify one URL without deploying anything.
   *
   * @param url - the URL to check.
   * @returns the verification report.
   */
  async verify(url: string): Promise<VerificationReport> {
    return this.verifyUrl(url)
  }

  /**
   * Scan a project, or one directory inside it, for secrets.
   *
   * @param projectDir - root to scan.
   * @param path - optional subdirectory, relative to the root.
   * @returns the scan result.
   */
  async scanSecrets(projectDir: string, path?: string): Promise<SecretScanResult> {
    return scanForSecrets(path === undefined ? projectDir : resolve(projectDir, path))
  }

  /** Provider credentials this environment does not satisfy. */
  private missingCredentials(descriptor: ProviderDescriptor): string[] {
    return descriptor.credentials.filter((name) => {
      const value = process.env[name]
      return value === undefined || value === ''
    })
  }

  /** The boundary a consequential provider action stops at. */
  private approvalBoundary(descriptor: ProviderDescriptor, environment: DeployEnvironment, action = 'deploy'): DeployBlocked {
    return {
      reason: 'approval',
      detail: `${descriptor.label} can create an account, change billing, or buy a domain, so it may not ${action} to ${environment} without your approval`,
      requiredAction: `tell me to ${action} to ${environment} with ${descriptor.label}, and I will record your approval on the deployment`,
    }
  }

  /** The boundary a secret finding stops at. */
  private secretBoundary(scan: SecretScanResult, where: string): DeployBlocked {
    const first = scan.findings[0]
    const preview = first === undefined ? '' : `${first.file}:${first.line} (${first.kind}, ${first.masked})`
    return {
      reason: 'secrets',
      detail: `${scan.findings.length} likely secret(s) found in the ${where}: ${preview}`,
      requiredAction: 'move the values into environment variables or a secret store, then deploy again; only an explicit instruction can publish over a finding',
    }
  }

  /** The failed required checks, as one line. */
  private failedChecks(report: VerificationReport): string {
    const failed = report.checks.filter(check => check.required && check.status === 'fail')
    return failed.length === 0
      ? 'deployment verification failed'
      : `deployment verification failed: ${failed.map(check => `${check.id} (${check.detail})`).join('; ')}`
  }

  /** Verify a URL with the manager's timeout and, for production, the public-reachability requirement. */
  private async verifyUrl(url: string, environment?: DeployEnvironment, project?: ProjectPlan): Promise<VerificationReport> {
    const assetPaths = project === undefined ? [] : await this.probeAssets(project)
    const report = await verifyDeployment({
      url,
      timeoutMs: this.options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      ...assetPaths.length > 0 ? { assetPaths } : {},
    })
    if (environment !== 'production' || report.reachability === 'public') return report
    const check: VerificationCheck = {
      id: 'public-reachability',
      label: 'Public reachability',
      status: 'fail',
      required: true,
      detail: `${url} resolves to a ${report.reachability} address; a production deployment must be publicly reachable`,
    }
    return { ...report, healthy: false, checks: [...report.checks, check] }
  }

  /** Verification for a publish, which adds asset probes derived from the built output. */
  private verifyPublished(url: string, project: ProjectPlan, request: DeployRequest): Promise<VerificationReport> {
    return this.verifyUrl(request.publicUrl ?? url, request.environment, project)
  }

  /** Probe the built output for a couple of real asset URLs to fetch. */
  private async probeAssets(project: ProjectPlan): Promise<string[]> {
    const root = project.outputDir === undefined ? project.projectDir : resolve(project.projectDir, project.outputDir)
    const found: string[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (found.length >= PROBE_ASSET_COUNT || depth > 3) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (found.length >= PROBE_ASSET_COUNT) return
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(path, depth + 1)
          continue
        }
        if (PROBE_EXTENSIONS.has(extname(entry.name))) found.push(urlPathFor(root, path))
      }
    }
    await walk(root, 0)
    return found
  }

  /** Assemble the record for one attempt. */
  private buildRecord(input: {
    id: string
    request: {
      projectDir: string
      environment: DeployEnvironment
      commit?: string
      branch?: string
      approval?: DeployApproval
      note?: string
      publicUrl?: string
    }
    plan: ProjectPlan
    providerId: string
    url: string
    report: VerificationReport
    logs: readonly string[]
    externalId?: string
    secretFindings?: readonly SecretFinding[]
    rolledBackFrom?: string
    note?: string
  }): DeploymentRecord {
    const note = input.note ?? input.request.note
    return {
      id: input.id,
      projectDir: input.request.projectDir,
      environment: input.request.environment,
      providerId: input.providerId,
      url: input.url,
      reachability: reachabilityOf(input.url),
      createdAt: new Date().toISOString(),
      health: input.report.healthy ? 'healthy' : 'unhealthy',
      verification: input.report,
      logs: input.logs.slice(-RECORDED_LOG_LINES),
      ...input.request.commit !== undefined ? { commit: input.request.commit } : {},
      ...input.request.branch !== undefined ? { branch: input.request.branch } : {},
      ...input.externalId !== undefined ? { externalId: input.externalId } : {},
      ...input.secretFindings !== undefined ? { secretFindings: input.secretFindings } : {},
      ...input.rolledBackFrom !== undefined ? { rolledBackFrom: input.rolledBackFrom } : {},
      ...note !== undefined ? { note } : {},
    }
  }

  /** Run one shell command, streaming its output through `log`. */
  private runCommand(command: string, cwd: string, timeoutMs: number, log: (line: string) => void): Promise<CommandOutcome> {
    return new Promise<CommandOutcome>((resolveOutcome) => {
      const logs: string[] = []
      const record = (line: string): void => {
        if (line.length === 0) return
        logs.push(line)
        log(line)
      }
      const child = spawn(command, { cwd, shell: true, env: process.env })
      const out = lineReader(record)
      const err = lineReader(record)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { out(chunk) })
      child.stderr.on('data', (chunk: string) => { err(chunk) })
      const timer = setTimeout(() => {
        record(`command exceeded ${timeoutMs}ms; terminating`)
        child.kill('SIGTERM')
      }, timeoutMs)
      child.on('error', (error: Error) => {
        clearTimeout(timer)
        resolveOutcome({ ok: false, code: null, logs: [...logs, String(error)] })
      })
      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        resolveOutcome({ ok: code === 0, code, logs })
      })
    })
  }
}
