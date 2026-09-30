/**
 * The deployment plugin: provides `ctx.deployments` together with the provider
 * adapters this build ships and the tools the agent drives them with.
 *
 * Providers are registered into the manager rather than selected by it, which is
 * what keeps a hosting choice a composition decision: adding a provider is
 * adding a row that calls {@link DeploymentManager.registerProvider}, not
 * editing the pipeline. The two adapters registered here are the local static
 * server (for previews and for verifying the pipeline itself) and the command
 * adapter, which is how every CLI-based host — Vercel, Netlify, Cloudflare, Fly,
 * Railway, or rsync to a VPS — attaches without a line of new code.
 *
 * The manager never runs a provider on its own initiative when the provider can
 * create an account, change billing, or buy a domain: it returns `blocked` with
 * the exact approval it needs. That boundary is the reason this plugin can be
 * enabled by default at all.
 * @module @deepseek-ai/dsh-deployment
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DeploymentManager } from './manager.ts'
import { createCommandProvider } from './providers/command.ts'
import { createLocalStaticProvider } from './providers/local-static.ts'
import { registerDeploymentTools } from './tools.ts'
import type { CommandEnvironmentConfig, CommandProviderOptions } from './providers/command.ts'
import type { DeployCapability, DeployEnvironment } from './types.ts'

export { DeploymentManager } from './manager.ts'
export { detectProject, isRecognised } from './detect.ts'
export { currentDeployments, deploymentSnapshot, lastHealthyDeployment, readDeployments } from './records.ts'
export { reachabilityOf, verifyDeployment } from './verify.ts'
export { scanForSecrets } from './secrets.ts'
export { createCommandProvider } from './providers/command.ts'
export { createLocalStaticProvider } from './providers/local-static.ts'
export type { CommandEnvironmentConfig, CommandProviderOptions } from './providers/command.ts'
export type { LocalStaticOptions } from './providers/local-static.ts'
export type * from './types.ts'

/** One command-backed provider, as configured by an operator. */
export interface CommandProviderConfig {
  /** Provider id exposed to the planner, e.g. `vercel`. */
  id: string
  /** Human label. */
  label: string
  /** Capabilities this provider satisfies. */
  capabilities?: DeployCapability[]
  /** Whether using it can create an account or cost money; defaults to true. */
  consequential?: boolean
  /** Environment variable names it needs. */
  credentials?: string[]
  /** One configuration per environment. */
  environments: Partial<Record<DeployEnvironment, CommandEnvironmentConfig>>
}

/** Plugin configuration. */
export interface Config {
  /**
   * Directory that holds published releases for the local static adapter.
   * Omitted, releases live under the harness home.
   */
  releaseRoot?: string
  /** Provider id used when a request names none. */
  defaultProvider?: string
  /**
   * Restore the previous healthy production deployment automatically when a
   * production publish fails verification. Off by default: an automatic restore
   * is itself a production change.
   */
  autoRollback?: boolean
  /** Port for the local static adapter; 0 (the default) asks the OS for a free port. */
  localPort?: number
  /** Command-backed providers, for hosts driven by their own CLI. */
  providers?: CommandProviderConfig[]
}

/** Where local releases live when the operator configures nothing. */
const DEFAULT_RELEASE_ROOT = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'deployments')

/** Capability vocabulary accepted by the provider schema. */
const CAPABILITIES = ['static', 'serverless', 'container', 'vps', 'database', 'worker'] as const

/** Environments a command provider can be configured for. */
const ENVIRONMENTS = ['preview', 'staging', 'production'] as const

/**
 * The deployment service as a Cordis plugin.
 *
 * Construction registers the shipped adapters; tool registration happens in
 * {@link Service.init} so `ctx.tools` is guaranteed to exist first, and every
 * registration is undone on disposal.
 */
export class Deployment extends DeploymentManager {
  // Inline schema call, like the other services that own a Config: the config
  // catalog walks `static Config` statically, and the validated object is what
  // reaches the constructor.
  static Config = z.object({
    releaseRoot: z.string(),
    defaultProvider: z.string(),
    autoRollback: z.boolean().default(false),
    localPort: z.number().step(1).min(0).max(65535).default(0),
    providers: z.array(z.object({
      id: z.string().required(),
      label: z.string().required(),
      capabilities: z.array(z.union(CAPABILITIES)).default(['static', 'serverless']),
      consequential: z.boolean().default(true),
      credentials: z.array(z.string()).default([]),
      environments: z.dict(z.object({
        deployCommand: z.string().required(),
        rollbackCommand: z.string(),
        urlPattern: z.string(),
        cwd: z.string(),
        timeoutMs: z.number().step(1).min(1).default(900_000),
      })),
    })),
  })

  /** The local adapter, kept so its server can be stopped on disposal. */
  private readonly local: ReturnType<typeof createLocalStaticProvider>

  /**
   * @param ctx - owning Cordis context; the service registers as `ctx.deployments`.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, {
      releaseRoot: config.releaseRoot ?? DEFAULT_RELEASE_ROOT,
      ...config.defaultProvider === undefined ? {} : { defaultProvider: config.defaultProvider },
      ...config.autoRollback === undefined ? {} : { autoRollback: config.autoRollback },
    })
    this.local = createLocalStaticProvider({
      rootDir: config.releaseRoot ?? DEFAULT_RELEASE_ROOT,
      port: config.localPort ?? 0,
    })
    this.registerProvider(this.local)
    for (const provider of config.providers ?? []) {
      this.registerProvider(createCommandProvider(toCommandOptions(provider)))
    }

    // Tool registration waits for the tool registry through an injection rather
    // than a static dependency: a deployment service that refused to start until
    // `tools` existed could not be composed anywhere the registry is absent, and
    // the preset loader reports that as a preset that never started. The effect
    // unregisters the tools, and stops the local server, with this service.
    ctx.inject(['tools'], (child) => {
      child.effect(() => registerDeploymentTools(child, this))
    })
    ctx.effect(() => () => this.local.close())
  }
}

/** Narrow one configured provider into the adapter's options. */
function toCommandOptions(config: CommandProviderConfig): CommandProviderOptions {
  return {
    id: config.id,
    label: config.label,
    ...config.capabilities === undefined ? {} : { capabilities: config.capabilities },
    ...config.consequential === undefined ? {} : { consequential: config.consequential },
    ...config.credentials === undefined ? {} : { credentials: config.credentials },
    environments: config.environments,
  }
}

/** Environment vocabulary exported for tests and configuration validation. */
export const deploymentEnvironments = ENVIRONMENTS

export default Deployment
