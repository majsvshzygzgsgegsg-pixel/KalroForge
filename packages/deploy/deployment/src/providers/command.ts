/**
 * The generic command provider: one operator-configured CLI per environment.
 *
 * This adapter exists so that a new hosting company is a configuration row rather
 * than a source file. Vercel, Netlify, Cloudflare, Fly, Railway, and plain
 * `rsync`/`ssh` to a VPS all attach through it, and none of them is special: the
 * deploy command, its working directory, its timeout, the capabilities it
 * satisfies, and the pattern that finds the deployed URL are operator inputs.
 *
 * It refuses three things deliberately. First, it never takes a command from
 * model-supplied arguments — the model may ask for a deployment, but it never
 * writes the shell line that performs it, because an invented command is
 * arbitrary shell execution the operator never approved. Second, it never reports
 * a deployment without a URL: a deployment a user cannot open is not a
 * deployment, so an unresolvable URL is a failed publish, not a warning. Third,
 * it never reports a rollback it did not run: with no rollback command
 * configured, restore throws instead of implying that the previous release is
 * serving again.
 *
 * Secret hygiene: credential names are the operator's, and the deployment MANAGER
 * checks them against the process environment. This adapter writes those names
 * into logs and nothing else — never a value, never the command text (an
 * operator's command line may embed a token) — and it redacts every configured
 * value out of the command's own output before that output is logged, retained,
 * or quoted in an error, because a CLI that echoes its environment must not be
 * able to write a secret into the deployment record.
 * @module @deepseek-ai/dsh-deployment/providers/command
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type {
  DeployCapability, DeployEnvironment, DeploymentRecord, ProjectPlan, ProviderAdapter, ProviderContext, ProviderDescriptor, PublishOutcome,
} from '../types.ts'

/** Per-command timeout used when an environment does not set one: 15 minutes. */
const DEFAULT_TIMEOUT_MS = 900_000

/** Capabilities assumed for an environment that does not declare any. */
const DEFAULT_CAPABILITIES: readonly DeployCapability[] = ['static', 'serverless']

/** Environments in reporting order, so a descriptor built from a partial map is deterministic. */
const ENVIRONMENT_ORDER: readonly DeployEnvironment[] = ['preview', 'staging', 'production']

/** Output lines kept for an error tail. The URL is matched as lines arrive, never from this window. */
const RETAINED_LINES = 200

/** Output lines quoted in a failure message. */
const TAIL_LINES = 10

/** One environment's commands, as configured by the operator. */
export interface CommandEnvironmentConfig {
  /** Shell command that publishes this environment. Required. */
  deployCommand: string
  /** Shell command that republishes a previously recorded deployment. Optional. */
  rollbackCommand?: string
  /** Regex (source text) with capture group 1 holding the deployed URL. */
  urlPattern?: string
  /** Extra environment variable names this provider needs. */
  credentials?: readonly string[]
  /** Working directory relative to the project; defaults to the project root. */
  cwd?: string
  /** Per-command timeout in ms; defaults to 900000 (15 minutes). */
  timeoutMs?: number
  /** Whether running this command can create an account or cost money. Defaults to true. */
  consequential?: boolean
  /** Capabilities this provider satisfies; defaults to ['static','serverless']. */
  capabilities?: readonly DeployCapability[]
  /** For rollback URLs: the recorded URL is reused when no rollbackCommand exists. */
  environmentNote?: string
}

/** Everything one command-based provider knows: its identity and its per-environment commands. */
export interface CommandProviderOptions {
  /** Provider id exposed to the planner, e.g. `vercel`. Required. */
  id: string
  /** Human label. Required. */
  label: string
  /** One config per environment. */
  environments: Partial<Record<DeployEnvironment, CommandEnvironmentConfig>>
}

/** A compiled `urlPattern`, kept with its source text so errors can name it. */
interface CompiledPattern {
  /** The operator's pattern source, quoted verbatim in errors. */
  source: string
  /** The pattern itself. */
  pattern: RegExp
}

/** Everything one command run needs beyond the command text. */
interface CommandRunOptions {
  /** Working directory for the child process. */
  cwd: string
  /** Milliseconds before the child is killed. */
  timeoutMs: number
  /** Caller's cancellation, when one was supplied. */
  signal?: AbortSignal | undefined
  /** Rewrites one output line before it is logged, retained, or quoted. */
  redact: (line: string) => string
  /** Called once per completed output line, in arrival order. */
  onLine: (line: string) => void
}

/** What one command run resolved. */
interface RunOutcome {
  /** The URL the command's output named, when any line matched. */
  url: string | undefined
  /** The output window kept for error tails, already redacted. */
  lines: readonly string[]
}

/**
 * Create a command-based provider for one hosting CLI.
 * @param options - provider identity plus one command configuration per environment.
 * @returns the adapter, whose descriptor unions the configured environments.
 */
export function createCommandProvider(options: CommandProviderOptions): ProviderAdapter {
  const descriptor = descriptorFor(options)

  /** Run one configured command, logging every output line and matching the URL as lines arrive. */
  async function runConfigured(
    command: string, config: CommandEnvironmentConfig, ctx: ProviderContext, compiled: CompiledPattern | undefined,
  ): Promise<RunOutcome> {
    let url: string | undefined
    const lines = await runCommand(command, {
      cwd: commandCwd(ctx.projectDir, config),
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: ctx.signal,
      redact: createRedactor(descriptor.credentials),
      onLine: (line: string): void => {
        ctx.log(line)
        // Matched here, not from the retained window: a long deployment may
        // scroll the URL line out of the window, and it is still the URL.
        if (compiled !== undefined && url === undefined) url = matchUrl(compiled.pattern, line)
      },
    })
    return { url, lines }
  }

  async function publish(ctx: ProviderContext): Promise<PublishOutcome> {
    const config = requireEnvironment(options, ctx.environment)
    logEnvironment(ctx, descriptor, options.id, ctx.environment, config)
    const compiled = compilePattern(options.id, config.urlPattern)
    const { url, lines } = await runConfigured(config.deployCommand, config, ctx, compiled)
    if (url === undefined) throw unresolvableUrl(options.id, ctx.environment, compiled, lines)
    return { url }
  }

  async function restore(ctx: ProviderContext, record: DeploymentRecord): Promise<PublishOutcome> {
    if (record.providerId !== options.id) {
      throw new Error(`command provider "${options.id}" cannot restore record ${record.id}: it was published by "${record.providerId}"`)
    }
    const config = requireEnvironment(options, ctx.environment)
    logEnvironment(ctx, descriptor, options.id, ctx.environment, config)
    const rollbackCommand = config.rollbackCommand
    if (rollbackCommand === undefined || rollbackCommand.trim() === '') {
      throw new Error(`command provider "${options.id}" cannot roll back ${ctx.environment}: no rollbackCommand is configured for it, so nothing was run`)
    }

    ctx.log(`rollback: running the configured ${ctx.environment} rollback command`)
    const compiled = compilePattern(options.id, config.urlPattern)
    const { url } = await runConfigured(rollbackCommand, config, ctx, compiled)
    if (url === undefined) {
      // The rollback republished the recorded deployment, so the recorded URL is
      // still the address it serves. This is the only reuse this adapter does:
      // the command itself did run, and only its URL was missing.
      ctx.log(`rollback: the rollback command named no URL; keeping the recorded URL ${record.url}`)
    }
    return { url: url ?? record.url }
  }

  return {
    descriptor,
    supports: (plan: ProjectPlan): boolean =>
      plan.capabilities.length > 0 && plan.capabilities.every(capability => descriptor.capabilities.includes(capability)),
    publish,
    restore,
  }
}

/**
 * Build the one descriptor this adapter exposes.
 *
 * The manager selects adapters from a descriptor, but commands are configured per
 * environment, so capabilities and credential names are the union over every
 * configured environment — the adapter can do everything any of its environments
 * can. `consequential` is true when any environment can create an account or cost
 * money (the default). `supportsRollback` is true when at least one environment
 * declares a rollback command; an environment that declares none still fails
 * loudly from {@link ProviderAdapter.restore}.
 * @param options - the provider's configuration.
 * @returns the descriptor for the planner.
 */
function descriptorFor(options: CommandProviderOptions): ProviderDescriptor {
  const environments = configuredEnvironments(options)
  return {
    id: options.id,
    label: options.label,
    capabilities: unique(environments.flatMap(config => [...(config.capabilities ?? DEFAULT_CAPABILITIES)])),
    consequential: environments.some(config => config.consequential ?? true),
    credentials: unique(environments.flatMap(config => [...(config.credentials ?? [])])),
    supportsRollback: environments.some(config => config.rollbackCommand !== undefined && config.rollbackCommand.trim() !== ''),
  }
}

/** Every configured environment, in reporting order. */
function configuredEnvironments(options: CommandProviderOptions): CommandEnvironmentConfig[] {
  return ENVIRONMENT_ORDER.flatMap((environment) => {
    const config = options.environments[environment]
    return config === undefined ? [] : [config]
  })
}

/** Deduplicate while keeping declaration order. */
function unique<T>(values: readonly T[]): T[] {
  const seen = new Set<T>()
  const result: T[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** The environment's commands, or a refusal naming the environment that is missing them. */
function requireEnvironment(options: CommandProviderOptions, environment: DeployEnvironment): CommandEnvironmentConfig {
  const config = options.environments[environment]
  if (config === undefined) {
    throw new Error(`command provider "${options.id}" has no ${environment} environment configured, so no command was run`)
  }
  return config
}

/**
 * Log what the manager will check and where the command runs, without ever
 * echoing the command text: an operator's command line may embed a token, and a
 * log line is copied into the deployment record.
 * @param ctx - the running provider context.
 * @param descriptor - the adapter's descriptor, whose credentials are the union of every environment.
 * @param providerId - the adapter id.
 * @param environment - the environment being published or restored.
 * @param config - that environment's configuration.
 */
function logEnvironment(
  ctx: ProviderContext,
  descriptor: ProviderDescriptor,
  providerId: string,
  environment: DeployEnvironment,
  config: CommandEnvironmentConfig,
): void {
  const credentials = descriptor.credentials.length === 0 ? 'none declared' : descriptor.credentials.join(', ')
  ctx.log(`${providerId} ${environment}: credential names (values never logged) that the deployment manager checks first: ${credentials}`)
  if (config.environmentNote !== undefined) ctx.log(config.environmentNote)
}

/** The directory the command runs in. */
function commandCwd(projectDir: string, config: CommandEnvironmentConfig): string {
  return config.cwd === undefined ? resolve(projectDir) : resolve(projectDir, config.cwd)
}

/** Compile an operator's `urlPattern`, or explain why it cannot be compiled. */
function compilePattern(providerId: string, source: string | undefined): CompiledPattern | undefined {
  if (source === undefined) return undefined
  try {
    return { source, pattern: new RegExp(source) }
  } catch (error) {
    throw new Error(`command provider "${providerId}" has an unusable urlPattern "${source}": ${String(error)}`)
  }
}

/** The URL one output line names, when the pattern's first group holds one. */
function matchUrl(pattern: RegExp, line: string): string | undefined {
  const captured = pattern.exec(line)?.[1]?.trim()
  return captured === undefined || captured === '' ? undefined : captured
}

/**
 * The failure a publish reports when the command succeeded but named no URL.
 * @param providerId - the adapter id.
 * @param environment - the environment that was published.
 * @param compiled - the compiled pattern, or `undefined` when none is configured.
 * @param lines - the redacted output window.
 * @returns the error to throw.
 */
function unresolvableUrl(
  providerId: string, environment: DeployEnvironment, compiled: CompiledPattern | undefined, lines: readonly string[],
): Error {
  const pattern = compiled === undefined
    ? 'no urlPattern is configured for this environment'
    : `urlPattern "${compiled.source}"`
  return new Error(
    `command provider "${providerId}" published but ${pattern} matched no output line for ${environment}; a deployment with no resolvable URL is not a successful deployment; last output:\n${tailOf(lines)}`,
  )
}

/**
 * Build a redactor over every credential name this provider knows.
 *
 * Values are read from the process environment only to be removed from output;
 * they are never logged, returned, or embedded in an error. Longer values are
 * replaced first so a value that contains another one cannot leak its tail, and
 * empty values are ignored — replacing the empty string would destroy the log.
 * @param names - credential names declared by any environment.
 * @returns a function that rewrites one line.
 */
function createRedactor(names: readonly string[]): (line: string) => string {
  const secrets = names
    .flatMap((name) => {
      const value = process.env[name]
      return value === undefined || value === '' ? [] : [{ name, value }]
    })
    .sort((left, right) => right.value.length - left.value.length)
  return (line: string): string => {
    let redacted = line
    for (const secret of secrets) redacted = redacted.split(secret.value).join(`<redacted ${secret.name}>`)
    return redacted
  }
}

/** The last few redacted output lines, for a failure message. */
function tailOf(lines: readonly string[]): string {
  if (lines.length === 0) return '  (no output)'
  return lines.slice(-TAIL_LINES).map(line => `  ${line}`).join('\n')
}

/**
 * Run one operator-configured command with a real shell.
 *
 * `shell: true` is deliberate — operators configure shell lines, pipelines
 * included — and it is also why the command text never comes from a model. The
 * child inherits the process environment, because credentials are the manager's
 * contract with the process and this adapter holds no secrets of its own.
 *
 * Output is streamed line by line into `onLine` as it arrives, so a long deploy
 * reports progress instead of buffering. The command is killed on timeout and on
 * cancellation; both kill the shell this adapter started, and a grandchild that
 * detached from it may outlive the kill.
 * @param command - the shell command, from operator configuration.
 * @param options - cwd, timeout, cancellation, redaction, and the line sink.
 * @returns the retained output window.
 * @throws when the command cannot start, times out, is cancelled, is killed, or exits non-zero.
 */
async function runCommand(command: string, options: CommandRunOptions): Promise<readonly string[]> {
  const { cwd, timeoutMs, signal } = options
  if (signal?.aborted === true) throw new Error('the deployment was cancelled before the command started')

  const retained: string[] = []
  const child = spawn(command, { shell: true, cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const record = (raw: string): void => {
    const line = options.redact(raw)
    retained.push(line)
    if (retained.length > RETAINED_LINES) retained.shift()
    options.onLine(line)
  }
  const pump = (stream: Readable): void => {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      let end = buffer.indexOf('\n')
      while (end !== -1) {
        record(buffer.slice(0, end).replace(/\r$/u, ''))
        buffer = buffer.slice(end + 1)
        end = buffer.indexOf('\n')
      }
    })
    stream.on('end', () => {
      if (buffer !== '') record(buffer)
    })
  }
  pump(child.stdout)
  pump(child.stderr)

  // Set by the timeout and the cancellation listener, read after 'exit'. One
  // reason, not two flags: the message a run reports is decided where the kill
  // is ordered, which is the only place that knows why it happened.
  let killReason: string | undefined
  const timer = setTimeout(() => {
    killReason = `the command timed out after ${timeoutMs} ms`
    child.kill('SIGKILL')
  }, timeoutMs)
  const onAbort = (): void => {
    killReason = 'the deployment was cancelled while the command was running'
    child.kill('SIGKILL')
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const exited = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (exitCode, exitSignal) => {
      resolveExit([exitCode, exitSignal])
    })
  })
  // stdio drains after 'exit', so a finished command is judged only once every
  // line has been recorded. A kill this adapter ordered is judged at 'exit'
  // instead: the pipe can stay open behind a grandchild the shell left running.
  const drained = new Promise<void>((resolveDrain) => {
    child.once('close', () => {
      resolveDrain()
    })
  })

  try {
    const [code, killedBy] = await exited
    if (killReason !== undefined) throw new Error(`${killReason}; last output:\n${tailOf(retained)}`)
    await drained
    if (code !== 0 || killedBy !== null) {
      throw new Error(`the command failed with exit code ${String(code)} (terminating signal: ${String(killedBy)}); last output:\n${tailOf(retained)}`)
    }
    return retained
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
