/**
 * The production-deployment contract.
 *
 * Every type here exists to keep one distinction honest: local development is
 * not a deployment. A dev server on `localhost` produces a build artifact and a
 * `local` reachability, and the report types below make that a recorded fact
 * rather than a claim — so no surface can present a localhost URL as a deployed,
 * publicly reachable application.
 *
 * Provider adapters implement {@link ProviderAdapter} and are registered into
 * the manager, so deployment is never hard-coded to one company: a new provider
 * is a new adapter, and a provider that would create an account, change billing,
 * or buy a domain declares itself {@link ProviderDescriptor.consequential} so the
 * manager stops and asks before acting.
 * @module @deepseek-ai/dsh-deployment/types
 */

/** Environment a target publishes to. Production is the only one that may report success publicly. */
export type DeployEnvironment = 'preview' | 'staging' | 'production'

/** One thing a project needs from whatever publishes it. */
export type DeployCapability = 'static' | 'serverless' | 'container' | 'vps' | 'database' | 'worker'

/** How the project detector classified a directory. */
export type ProjectKind = 'static-site' | 'node-app' | 'python-app' | 'container' | 'unknown'

/**
 * Whether a URL is reachable from this machine only or from the public internet.
 * Derived from the URL, never asserted by a provider: a provider that returns
 * `http://127.0.0.1:4000` is reporting a local server, not a deployment.
 */
export type Reachability = 'local' | 'public' | 'unknown'

/** Result of the verification pass recorded with a deployment. */
export type DeploymentHealth = 'healthy' | 'unhealthy' | 'unknown'

/** What one provider adapter can publish, and what using it costs the user. */
export interface ProviderDescriptor {
  /** Stable adapter id, e.g. `local-static`, `command`, `github-pages`. */
  id: string
  /** Human label for reports and the UI. */
  label: string
  /** Capabilities this adapter can satisfy. */
  capabilities: readonly DeployCapability[]
  /**
   * Whether using this provider can create an account, change billing, buy a
   * domain, or otherwise commit the user to something. The manager refuses to
   * publish through a consequential provider without an explicit approval.
   */
  consequential: boolean
  /** Environment variable names the adapter needs before it can publish. */
  credentials: readonly string[]
  /** Whether the adapter can republish an earlier deployment (rollback). */
  supportsRollback: boolean
}

/** Everything the detector learned about a project directory. */
export interface ProjectPlan {
  /** Absolute project directory. */
  projectDir: string
  /** Detected project kind. */
  kind: ProjectKind
  /** Capabilities the project needs from a provider. */
  capabilities: readonly DeployCapability[]
  /** Build command to run before publishing, when the project has one. */
  buildCommand?: string
  /** Directory the build writes, relative to the project. */
  outputDir?: string
  /** Long-running start command, for kinds that need a process. */
  startCommand?: string
  /** Package manager detected from the lockfile. */
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun'
  /** Why the detector concluded what it did, one line per fact. */
  reasons: readonly string[]
}

/** Explicit, recorded user approval for one consequential action. */
export interface DeployApproval {
  /** The action the user approved, verbatim, e.g. `deploy to production with vercel`. */
  action: string
  /** ISO timestamp of the approval. */
  approvedAt: string
  /** Optional note carried into the deployment record. */
  note?: string
}

/** One request to publish a project. */
export interface DeployRequest {
  /** Absolute project directory. */
  projectDir: string
  /** Target environment; defaults to `production` at the tool boundary. */
  environment: DeployEnvironment
  /** Explicit adapter id; omitted lets the manager choose from capabilities. */
  providerId?: string
  /** URL to verify when the adapter cannot know it (custom domain). */
  publicUrl?: string
  /** Git commit this deployment was built from. */
  commit?: string
  /** Git branch this deployment was built from. */
  branch?: string
  /** Free-text note stored on the record. */
  note?: string
  /** Present when the user approved a consequential action for this request. */
  approval?: DeployApproval
  /**
   * Publish even though the secret scan found findings. Only the user's explicit
   * instruction may set this, and the record always carries the findings.
   */
  allowSecretFindings?: boolean
}

/** Facts a running adapter is handed, including the history it must not destroy. */
export interface ProviderContext {
  /**
   * Manager-assigned id of the deployment being published. The adapter names
   * its own release/artifact after this id, which is what lets a later
   * {@link ProviderAdapter.restore} map a record back to the exact artifact it
   * published — without it a rollback could only guess which release was which.
   */
  deploymentId: string
  /** Absolute project directory. */
  projectDir: string
  /** Target environment. */
  environment: DeployEnvironment
  /** The plan the adapter was selected for. */
  plan: ProjectPlan
  /** Earlier records for this project and environment, newest first. */
  history: readonly DeploymentRecord[]
  /** Append one line to the deployment log. */
  log: (line: string) => void
  /** Aborts when the caller gives up. */
  signal?: AbortSignal
}

/** What an adapter produced. */
export interface PublishOutcome {
  /** The URL the provider says serves this deployment. */
  url: string
  /** The provider's own identifier for this deployment, when it has one. */
  externalId?: string
  /** Extra log lines worth keeping with the record. */
  logs?: readonly string[]
}

/** One deployment provider adapter. */
export interface ProviderAdapter {
  /** What this adapter is and needs. */
  descriptor: ProviderDescriptor
  /** Whether this adapter can publish the detected project. */
  supports(plan: ProjectPlan): boolean
  /** Publish the project and return the URL the provider serves it at. */
  publish(ctx: ProviderContext): Promise<PublishOutcome>
  /** Republish an earlier deployment's exact artifact, for rollback. */
  restore?(ctx: ProviderContext, record: DeploymentRecord): Promise<PublishOutcome>
}

/** One verification check's outcome. */
export interface VerificationCheck {
  /** Stable check id, e.g. `https`, `main-page`. */
  id: string
  /** Human label. */
  label: string
  /** Whether the check passed, failed, or could not apply. */
  status: 'pass' | 'fail' | 'skip'
  /** One line explaining what was observed. */
  detail: string
  /** A failed required check makes the deployment unhealthy. */
  required: boolean
}

/** The verification pass recorded with a deployment. */
export interface VerificationReport {
  /** The URL that was checked. */
  url: string
  /** Whether the URL is publicly reachable. */
  reachability: Reachability
  /** ISO timestamp of the check. */
  checkedAt: string
  /** Every check, in the order it ran. */
  checks: readonly VerificationCheck[]
  /** True only when every required check passed. */
  healthy: boolean
}

/** One secret found in a project or its build output. */
export interface SecretFinding {
  /** Path relative to the scanned root. */
  file: string
  /** 1-based line number. */
  line: number
  /** What kind of secret the pattern matched. */
  kind: string
  /** The match with all but a short prefix masked; safe to show. */
  masked: string
}

/** Result of scanning a tree for secrets before publishing it. */
export interface SecretScanResult {
  /** Root that was scanned. */
  root: string
  /** Files actually read. */
  scannedFiles: number
  /** Findings, in path order. */
  findings: readonly SecretFinding[]
  /** True when nothing was found. */
  clean: boolean
}

/** One recorded deployment. */
export interface DeploymentRecord {
  /** Manager-assigned id. */
  id: string
  /** Absolute project directory. */
  projectDir: string
  /** Environment this deployment serves. */
  environment: DeployEnvironment
  /** Adapter id that published it. */
  providerId: string
  /** Public or local URL the provider serves it at. */
  url: string
  /** Whether that URL is publicly reachable. */
  reachability: Reachability
  /** Git commit the deployment was built from. */
  commit?: string
  /** Git branch the deployment was built from. */
  branch?: string
  /** ISO timestamp of publication. */
  createdAt: string
  /** Health from the verification pass. */
  health: DeploymentHealth
  /** Provider's own deployment identifier. */
  externalId?: string
  /** The verification report that decided health. */
  verification?: VerificationReport
  /** Secret findings accepted by explicit instruction, when any. */
  secretFindings?: readonly SecretFinding[]
  /** Free-text note. */
  note?: string
  /** Log lines kept with the record. */
  logs?: readonly string[]
  /** Set when this record replaced another through rollback. */
  rolledBackFrom?: string
}

/** A project's deployments, newest first, for status surfaces. */
export interface DeploymentSnapshot {
  /** Absolute project directory. */
  projectDir: string
  /** Records newest first. */
  records: readonly DeploymentRecord[]
  /** The record currently serving each environment, when known. */
  current: Readonly<Partial<Record<DeployEnvironment, DeploymentRecord>>>
}

/** Why a deployment could not proceed. */
export interface DeployBlocked {
  /** The boundary that stopped it. */
  reason:
    | 'credentials'
    | 'approval'
    | 'secrets'
    | 'no-provider'
    | 'unknown-project'
    | 'no-target'
    | 'missing-build'
    | 'unreachable-provider'
  /** What happened, precisely. */
  detail: string
  /** The exact action the user must take to unblock, when one exists. */
  requiredAction?: string
  /** Environment variables that must be set, when the boundary is credentials. */
  missingEnv?: readonly string[]
}

/** A plan plus the provider that would serve it, or why none can. */
export interface DeployPlan {
  /** The detection result. */
  project: ProjectPlan
  /** The adapter that would publish, when one is available. */
  provider?: ProviderDescriptor
  /** Why no provider is available, when none is. */
  blocked?: DeployBlocked
}

/** Outcome of a publish or rollback attempt. */
export type DeployOutcome =
  | { status: 'deployed'; record: DeploymentRecord; report: VerificationReport }
  | { status: 'blocked'; blocked: DeployBlocked }
  | { status: 'failed'; error: string; logs: readonly string[] }

/** Rollback request. */
export interface RollbackRequest {
  /** Absolute project directory. */
  projectDir: string
  /** Environment to restore. */
  environment: DeployEnvironment
  /** Restore this exact record instead of the newest healthy predecessor. */
  recordId?: string
  /** Approval for the restore itself, when the adapter or environment asks for one. */
  approval?: DeployApproval
}
