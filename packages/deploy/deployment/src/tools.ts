/**
 * Agent-facing deployment tools.
 *
 * These descriptions are the contract the model is held to, so they state the
 * two facts this feature exists to enforce: a successful build is not a
 * successful deployment, and a URL that only resolves locally is not a live
 * application. Every tool that can change a production system names the boundary
 * it stops at (credentials, approval, secret findings) and returns the exact
 * action the user must take, rather than improvising a workaround.
 * @module @deepseek-ai/dsh-deployment/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { DeploymentManager } from './manager.ts'
import type {
  DeployEnvironment, DeployOutcome, DeployPlan, DeploymentSnapshot, SecretScanResult, VerificationReport,
} from './types.ts'

/** JSON-safe value the tool boundary carries. */
type ToolValue = string | number | boolean | null | ToolValue[] | { [key: string]: ToolValue }

/**
 * Convert a manager result for the tool boundary.
 *
 * The manager returns plain data — strings, numbers, arrays, and nested objects —
 * so the boundary's JSON requirement is satisfied by construction. Recording that
 * once here is what keeps it a documented fact instead of a cast at every return.
 */
function asToolResult(value: unknown): Record<string, ToolValue> {
  return value as Record<string, ToolValue>
}

/** The render side receives the JSON the output schema described; these restore the manager's types. */
const asPlan = (value: unknown): DeployPlan => value as DeployPlan
const asOutcome = (value: unknown): DeployOutcome => value as DeployOutcome
const asSnapshot = (value: unknown): DeploymentSnapshot => value as DeploymentSnapshot
const asReport = (value: unknown): VerificationReport => value as VerificationReport
const asScan = (value: unknown): SecretScanResult => value as SecretScanResult

/** Coerce a tool argument to a known environment, defaulting to production. */
function asEnvironment(value: string | undefined): DeployEnvironment {
  return value === 'preview' || value === 'staging' || value === 'production' ? value : 'production'
}

/** Render a verification report as a compact, ordered checklist. */
function renderReport(report: VerificationReport): string {
  const lines = report.checks.map(check => `  [${check.status}] ${check.id}: ${check.detail}`)
  return [
    `url: ${report.url}`,
    `reachability: ${report.reachability}`,
    `healthy: ${report.healthy ? 'yes' : 'no'}`,
    ...lines,
  ].join('\n')
}

/** Render one deploy or rollback outcome without ever overstating it. */
function renderOutcome(outcome: DeployOutcome): string {
  if (outcome.status === 'blocked') {
    const boundary = outcome.blocked
    return [
      `status: blocked (${boundary.reason})`,
      `detail: ${boundary.detail}`,
      ...boundary.requiredAction === undefined ? [] : [`required action: ${boundary.requiredAction}`],
      ...boundary.missingEnv === undefined ? [] : [`missing environment: ${boundary.missingEnv.join(', ')}`],
    ].join('\n')
  }
  if (outcome.status === 'failed') {
    return ['status: failed', `error: ${outcome.error}`, '', 'last log lines:', ...outcome.logs.slice(-15).map(line => `  ${line}`)].join('\n')
  }
  const record = outcome.record
  return [
    'status: deployed and verified',
    `deployment: ${record.id}`,
    `environment: ${record.environment}`,
    `provider: ${record.providerId}`,
    `url: ${record.url}`,
    `reachability: ${record.reachability}`,
    ...record.commit === undefined ? [] : [`commit: ${record.commit}`],
    ...record.rolledBackFrom === undefined ? [] : [`restored: ${record.rolledBackFrom}`],
    '',
    renderReport(outcome.report),
  ].join('\n')
}

/** Render a plan, including the boundary that blocks it. */
function renderPlan(plan: DeployPlan): string {
  const lines = [
    `project: ${plan.project.projectDir}`,
    `kind: ${plan.project.kind}`,
    `capabilities: ${plan.project.capabilities.join(', ') || 'none detected'}`,
    ...plan.project.buildCommand === undefined ? [] : [`build: ${plan.project.buildCommand}`],
    ...plan.project.outputDir === undefined ? [] : [`output: ${plan.project.outputDir}`],
    '',
    'why:',
    ...plan.project.reasons.map(reason => `  - ${reason}`),
    '',
    plan.provider === undefined
      ? 'provider: none available'
      : `provider: ${plan.provider.id} (${plan.provider.label})${plan.provider.consequential ? ' — consequential: needs your explicit approval' : ''}`,
  ]
  if (plan.blocked !== undefined) {
    lines.push('', `blocked (${plan.blocked.reason}): ${plan.blocked.detail}`)
    if (plan.blocked.requiredAction !== undefined) lines.push(`required action: ${plan.blocked.requiredAction}`)
    if (plan.blocked.missingEnv !== undefined) lines.push(`missing environment: ${plan.blocked.missingEnv.join(', ')}`)
  }
  return lines.join('\n')
}

/** Render a deployment history snapshot. */
function renderSnapshot(snapshot: DeploymentSnapshot): string {
  const lines = [`project: ${snapshot.projectDir}`, `recorded deployments: ${snapshot.records.length}`, '']
  for (const environment of ['production', 'staging', 'preview'] as const) {
    const current = snapshot.current[environment]
    lines.push(`${environment}: ${current === undefined ? 'nothing recorded' : `${current.url} (${current.health}, ${current.providerId}, ${current.id})`}`)
  }
  if (snapshot.records.length > 0) {
    lines.push('', 'history (newest first):')
    for (const record of snapshot.records.slice(0, 20)) {
      lines.push(`  ${record.createdAt} ${record.environment} ${record.health} ${record.providerId} ${record.url} ${record.id}${record.commit === undefined ? '' : ` @${record.commit.slice(0, 8)}`}${record.rolledBackFrom === undefined ? '' : ` (restored ${record.rolledBackFrom})`}`)
    }
  }
  return lines.join('\n')
}

/** Render a secret scan. */
function renderScan(scan: SecretScanResult): string {
  if (scan.clean) return `clean: no likely secrets in ${scan.scannedFiles} file(s) under ${scan.root}`
  return [
    `${scan.findings.length} finding(s) in ${scan.scannedFiles} file(s) under ${scan.root}:`,
    ...scan.findings.slice(0, 50).map(finding => `  ${finding.file}:${finding.line} ${finding.kind} ${finding.masked}`),
  ].join('\n')
}

/**
 * Register every deployment tool.
 *
 * @param ctx - context carrying the tools registry and the deployment manager.
 * @param manager - the manager the tools drive.
 * @returns a disposer that unregisters them all.
 */
export function registerDeploymentTools(ctx: Context, manager: DeploymentManager): () => void {
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'deployment_providers',
      description: 'List the deployment providers this KairoForge can publish through, with the capabilities each covers, the environment variables each needs, and whether using it is consequential (can create an account, change billing, or buy a domain). Call this before planning a deployment when you do not know what is connected.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute() {
        return asToolResult({ providers: manager.providers(), releaseRoot: manager.releaseRoot })
      },
    })),

    ctx.tools.register(defineTool({
      name: 'deployment_plan',
      description: 'Detect how a project builds and what publishing it requires, and choose the provider that would serve it. Read-only: this publishes nothing. Returns the detected project kind, the capabilities needed, the reason for every fact, and either the chosen provider or the exact boundary that blocks deployment (missing credentials, missing approval, unknown project).',
      parameters: {
        project_dir: { type: 'string', required: true, description: 'Absolute path of the project to plan a deployment for.' },
        provider_id: { type: 'string', description: 'Force one provider id instead of letting the planner choose.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderPlan(asPlan(value)) }],
      },
      async execute(args) {
        return asToolResult(await manager.plan({
          projectDir: args.project_dir,
          ...args.provider_id === undefined ? {} : { providerId: args.provider_id },
        }))
      },
    })),

    ctx.tools.register(defineTool({
      name: 'deployment_publish',
      description: [
        'Build, publish, verify, and record a deployment of a project.',
        'Success requires verification of the published URL — a successful build is not a successful deployment. A production deployment whose URL is not publicly reachable comes back as failed: never describe a localhost URL as a deployed application.',
        'Returns blocked with the exact required action when credentials are missing, when the provider is consequential and the user has not approved it, or when a likely secret was found.',
        'Set approve_consequential only after asking the user and receiving an explicit instruction, and put their words in approval_note; without that note the call is refused.',
        'After a failure, call deployment_status to find the last healthy deployment and offer a rollback.',
      ].join(' '),
      parameters: {
        project_dir: { type: 'string', required: true, description: 'Absolute path of the project to deploy.' },
        environment: { type: 'string', enum: ['preview', 'staging', 'production'], description: 'Target environment; defaults to production.' },
        provider_id: { type: 'string', description: 'Provider id to publish through; omitted lets the planner choose.' },
        public_url: { type: 'string', description: 'The URL to verify when it differs from what the provider reports, e.g. a custom domain.' },
        commit: { type: 'string', description: 'Git commit this deployment is built from.' },
        branch: { type: 'string', description: 'Git branch this deployment is built from.' },
        note: { type: 'string', description: 'Free-text note stored on the deployment record.' },
        approve_consequential: { type: 'boolean', description: 'True only when the user explicitly approved using this provider, which may create an account, change billing, or buy a domain.' },
        approval_note: { type: 'string', description: 'The user\'s own words approving this deployment. Required with approve_consequential.' },
        allow_secret_findings: { type: 'boolean', description: 'Publish even though the secret scan found something. Only set this on an explicit user instruction; the findings are recorded either way.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderOutcome(asOutcome(value)) }],
      },
      async execute(args) {
        const environment = asEnvironment(args.environment)
        if (args.approve_consequential === true && (args.approval_note === undefined || args.approval_note.trim() === '')) {
          return asToolResult({
            status: 'blocked',
            blocked: {
              reason: 'approval',
              detail: 'approve_consequential was set without the user\'s own words in approval_note',
              requiredAction: 'ask the user to approve this provider explicitly, then repeat the call with their words in approval_note',
            },
          })
        }
        return asToolResult(await manager.deploy({
          projectDir: args.project_dir,
          environment,
          ...args.provider_id === undefined ? {} : { providerId: args.provider_id },
          ...args.public_url === undefined ? {} : { publicUrl: args.public_url },
          ...args.commit === undefined ? {} : { commit: args.commit },
          ...args.branch === undefined ? {} : { branch: args.branch },
          ...args.note === undefined ? {} : { note: args.note },
          ...args.allow_secret_findings === true ? { allowSecretFindings: true } : {},
          ...args.approve_consequential === true && args.approval_note !== undefined
            ? { approval: { action: `deploy to ${environment}${args.provider_id === undefined ? '' : ` with ${args.provider_id}`}`, approvedAt: new Date().toISOString(), note: args.approval_note } }
            : {},
        }))
      },
    })),

    ctx.tools.register(defineTool({
      name: 'deployment_status',
      description: 'Read a project\'s deployment history: what each environment currently serves, every recorded deployment with its provider, URL, commit, health and verification, and which earlier deployments can be restored. Call this before claiming anything about a live application, and after a failed deployment to find the last healthy one.',
      parameters: {
        project_dir: { type: 'string', required: true, description: 'Absolute path of the project whose deployments to read.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderSnapshot(asSnapshot(value)) }],
      },
      async execute(args) {
        return asToolResult(await manager.status(args.project_dir))
      },
    })),

    ctx.tools.register(defineTool({
      name: 'deployment_verify',
      description: 'Verify a deployment URL without deploying anything: URL resolution, HTTPS, main page, required markers, API endpoints, static assets, and exposed secrets. Reachability is reported as public or local, so this is also how you check whether a URL is genuinely live for other people.',
      parameters: {
        url: { type: 'string', required: true, description: 'The absolute URL to verify.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderReport(asReport(value)) }],
      },
      async execute(args) {
        return asToolResult(await manager.verify(args.url))
      },
    })),

    ctx.tools.register(defineTool({
      name: 'deployment_rollback',
      description: 'Restore an earlier recorded deployment for an environment and verify the restored URL. Defaults to the newest healthy predecessor of what is live now. Providers that are consequential need the user\'s approval in approval_note. This never deletes the deployment it replaces, and it reports exactly what was restored.',
      parameters: {
        project_dir: { type: 'string', required: true, description: 'Absolute path of the project to restore.' },
        environment: { type: 'string', required: true, enum: ['preview', 'staging', 'production'], description: 'Environment to restore.' },
        record_id: { type: 'string', description: 'Restore this exact recorded deployment instead of the newest healthy predecessor.' },
        approval_note: { type: 'string', description: 'The user\'s own words approving this restore, when the provider is consequential.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderOutcome(asOutcome(value)) }],
      },
      async execute(args) {
        const environment = asEnvironment(args.environment)
        return asToolResult(await manager.rollback({
          projectDir: args.project_dir,
          environment,
          ...args.record_id === undefined ? {} : { recordId: args.record_id },
          ...args.approval_note === undefined
            ? {}
            : { approval: { action: `roll back ${environment}`, approvedAt: new Date().toISOString(), note: args.approval_note } },
        }))
      },
    })),

    ctx.tools.register(defineTool({
      name: 'deployment_secrets_scan',
      description: 'Scan a project, or one directory inside it, for secrets that must not ship: API keys, tokens, private keys, database URLs with credentials, and environment files. Run this before publishing anything. Findings block deployment_publish unless the user explicitly overrides them.',
      parameters: {
        project_dir: { type: 'string', required: true, description: 'Absolute path of the project to scan.' },
        path: { type: 'string', description: 'Optional subdirectory to scan instead of the whole project, e.g. the build output.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderScan(asScan(value)) }],
      },
      async execute(args) {
        return asToolResult(await manager.scanSecrets(args.project_dir, args.path))
      },
    })),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
