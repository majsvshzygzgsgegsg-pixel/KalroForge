/**
 * Life OS (`ctx.lifeOs`): the layer that makes KairoForge proactive and
 * personal. It owns the Vault, the local brain (vector index + knowledge
 * graph), the senses (focus, clipboard, notifications, routines), self-healing
 * for background work, self-written tools, Air-Gap mode, and the phone
 * companion. Every sense is opt-in and off by default; switches live in the
 * `life_os` storage domain, while everything personal it collects is sealed
 * by the Vault under `~/.kairoforge`.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { hostname } from 'node:os'
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { LOCAL_PROVIDERS } from '../core/autonomy.ts'
import type { GraphFact } from '../core/graph.ts'
import type { RoutingRules } from '../core/senses.ts'
import { findSensitive } from '../core/sensitive.ts'
import { NativeHelper } from '../native.ts'
import type { PersonalAi } from '../service.ts'
import { Vault, type VaultStatus } from '../vault.ts'
import { Brain, expandPath, type BrainStatus } from './brain.ts'
import { debuggerName, Healer, type HealRecord } from './healer.ts'
import { Senses, type SensesStatus } from './senses.ts'
import { UserTools, type UserToolManifest } from './user-tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Life OS: brain, senses, vault, self-healing, self-written tools, Air-Gap mode, phone companion. */
    lifeOs: LifeOs
  }
  interface Events {
    /**
     * A self-written tool was saved or deleted; coordinator toolbelts rebuild.
     * @mode emit
     */
    'personal-ai/user-tools'(): void
  }
}

/** A provider and model. */
export interface ModelRef {
  readonly provider: string
  readonly model: string
}

/** Life OS switches. */
export interface LifeSettings {
  readonly focus: boolean
  readonly clipboard: boolean
  readonly notifications: boolean
  readonly stuckSeconds: number
  readonly roots: readonly string[]
  readonly approvedRoutines: readonly string[]
  readonly vips: readonly string[]
  readonly urgentWords: readonly string[]
  readonly mutedApps: readonly string[]
  readonly healing: boolean
  readonly airGap: boolean
  readonly localModel?: ModelRef
  readonly lan: boolean
}

/** Defaults: every sense off, self-healing on, cloud allowed. */
export const DEFAULT_LIFE_SETTINGS: LifeSettings = {
  focus: false, clipboard: false, notifications: false, stuckSeconds: 45,
  roots: [], approvedRoutines: [], vips: [], urgentWords: [], mutedApps: [],
  healing: true, airGap: false, lan: false,
}

const list = z.array(z.string().min(1).max(300)).max(100)
const settingsSchema = z.object({
  focus: z.boolean().optional(),
  clipboard: z.boolean().optional(),
  notifications: z.boolean().optional(),
  stuckSeconds: z.number().int().min(20).max(900).optional(),
  roots: list.optional(),
  approvedRoutines: list.optional(),
  vips: list.optional(),
  urgentWords: list.optional(),
  mutedApps: list.optional(),
  healing: z.boolean().optional(),
  airGap: z.boolean().optional(),
  localModel: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict().optional(),
  lan: z.boolean().optional(),
}).strict()

/** Partial switches as stored and as accepted by {@link LifeOs.update}. */
export type LifeSettingsPatch = z.infer<typeof settingsSchema>

/** Schema for settings changes from the Command Center. */
export const lifeSettingsPatch = settingsSchema

/** One voice note from the phone. */
const noteSchema = z.object({ at: z.string().min(1), text: z.string().min(1).max(4000) }).strict()

/** Life OS switches domain: `~/.dsh/storages/life_os.json`. Personal data never goes here. */
export const lifeDomain = defineDomain({
  name: 'life_os',
  version: 1,
  tables: { notes: domainTable<string, z.infer<typeof noteSchema>>(noteSchema) },
  global: { schema: settingsSchema, initial: {} },
})

type LifeDomain = Domain<typeof lifeDomain>

/** Air-Gap state. */
export interface AirGapStatus {
  readonly on: boolean
  readonly localModel?: ModelRef
  readonly ready: boolean
  readonly detail: string
  readonly providers: readonly string[]
}

/** Everything the Command Center shows. */
export interface LifeStatus {
  readonly settings: LifeSettings
  readonly vault: VaultStatus
  readonly brain: BrainStatus
  readonly senses: SensesStatus
  readonly healing: readonly HealRecord[]
  readonly tools: readonly UserToolManifest[]
  readonly airGap: AirGapStatus
  readonly phone: { readonly path: string; readonly lanUrl?: string; readonly advertising: boolean }
  readonly graph: readonly GraphFact[]
}

const ROLE_WORDS = ['boss', 'manager', 'ceo', 'cto', 'lead', 'client', 'wife', 'husband', 'partner', 'mom', 'dad', 'family']
const PHONE_PATH = '/personal-ai/life/phone'

/** Life OS service. */
export class LifeOs extends Service {
  static inject = ['storageDomain', 'personalAi', 'orchestration', 'mainAgents']

  readonly native = new NativeHelper()
  readonly vault = new Vault(this.native)
  readonly brain: Brain
  readonly senses: Senses
  readonly healer: Healer
  readonly userTools = new UserTools()
  private readonly ready: Promise<LifeDomain>
  private domain: LifeDomain | undefined
  private mdns: ChildProcess | undefined
  private lanHost: string | undefined

  /**
   * @param ctx - Host context.
   */
  constructor(ctx: Context) {
    super(ctx, 'lifeOs')
    const warn = (text: string): void => { ctx.logger.warn(`life-os: ${text}`) }
    const personal = (): PersonalAi => ctx.personalAi
    this.brain = new Brain(this.vault, this.native, warn)
    this.senses = new Senses({
      native: this.native,
      vault: this.vault,
      switches: () => this.settings(),
      rules: () => this.rules(),
      notify: (notice) => { personal().notify(notice) },
      warn,
    })
    this.healer = new Healer({
      vault: this.vault,
      enabled: () => this.settings().healing,
      tasks: () => ctx.orchestration.background.list(),
      createTask: (input, actor) => ctx.orchestration.background.create(input, actor),
      agent: id => ctx.mainAgents.get(id).catch(() => undefined),
      debugger: workspace => this.debuggerAgent(workspace),
      notify: (level, text) => { personal().notify({ level, kind: 'self-healing', text }) },
      warn,
    })
    this.ready = ctx.storageDomain.open(lifeDomain).then((domain) => {
      this.domain = domain
      return domain
    })
    void this.ready.then(() => this.boot()).catch((error: unknown) => { warn(`start failed: ${String(error)}`) })
    ctx.effect(() => async () => {
      this.healer.dispose()
      this.stopAdvertising()
      await Promise.all([this.senses.dispose(), this.brain.dispose()]).catch(() => {})
      const domain = await this.ready
      await domain.close()
    }, 'personal-ai: life os')
  }

  private async boot(): Promise<void> {
    const settings = this.settings()
    await this.userTools.list().catch(() => [])
    if (settings.roots.length > 0) await this.brain.setRoots(settings.roots)
    else await this.brain.load()
    await this.senses.sync()
    this.healer.start()
    this.resolveLanHost()
    if (settings.lan) this.advertise()
  }

  private resolveLanHost(): void {
    if (process.platform !== 'darwin') return
    execFile('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: 5000 }, (error, stdout) => {
      this.lanHost = error === null && stdout.trim() !== '' ? `${stdout.trim()}.local` : `${hostname().replace(/\.local$/, '')}.local`
    })
  }

  /** Resolve once the switches are readable. */
  async whenReady(): Promise<void> {
    await this.ready
  }

  /** Effective switches. */
  settings(): LifeSettings {
    const stored = Object.fromEntries(Object.entries(this.domain?.global.get() ?? {}).filter(([, value]) => value !== undefined))
    return { ...DEFAULT_LIFE_SETTINGS, ...stored }
  }

  /** Tell coordinators that a self-written tool was saved or deleted. */
  toolsChanged(): void {
    this.ctx.emit('personal-ai/user-tools')
  }

  /**
   * Change switches and apply them.
   * @param changes - fields to change.
   * @returns effective switches.
   */
  async update(changes: LifeSettingsPatch): Promise<LifeSettings> {
    const domain = await this.ready
    const before = this.settings()
    const roots = changes.roots?.map(expandPath)
    await domain.global.set({ ...domain.global.get(), ...changes, ...roots === undefined ? {} : { roots } })
    const after = this.settings()
    if (roots !== undefined) await this.brain.setRoots(after.roots)
    await this.senses.sync()
    if (after.lan !== before.lan) {
      if (after.lan) this.advertise()
      else this.stopAdvertising()
    }
    if (after.airGap !== before.airGap) {
      const air = this.airGapStatus()
      this.ctx.personalAi.notify({
        level: after.airGap && !air.ready ? 'warning' : 'info',
        kind: 'air-gap',
        text: after.airGap ? `Air-Gap mode is on. ${air.detail}` : 'Air-Gap mode is off; cloud models and web access are allowed again.',
      })
    }
    return after
  }

  private rules(): RoutingRules {
    const settings = this.settings()
    return {
      vips: [...new Set([...settings.vips, ...this.brain.holdersOf(ROLE_WORDS)])],
      urgentWords: settings.urgentWords,
      mutedApps: settings.mutedApps,
    }
  }

  // ---------------------------------------------------------------------------
  // Air-Gap mode

  /** Air-Gap status: whether it is on and whether a local model can serve. */
  airGapStatus(): AirGapStatus {
    const settings = this.settings()
    const providers = (this.ctx.get('llm')?.listProviders() ?? []).map(provider => provider.id)
    const local = settings.localModel
    const ready = local !== undefined && providers.includes(local.provider)
    const detail = local === undefined
      ? 'No local model is chosen yet: install Ollama (or LM Studio), add it as a provider in KairoForge, then pick it here. Until then, model calls are refused rather than sent to the cloud.'
      : ready
        ? `Model calls run on ${local.provider}/${local.model}; web, browser, GitHub, and network commands are blocked.`
        : `The local provider "${local.provider}" is not registered in KairoForge, so model calls are refused rather than sent to the cloud.`
    return { on: settings.airGap, ...local === undefined ? {} : { localModel: local }, ready, detail, providers }
  }

  /**
   * The model a call must use under Air-Gap mode.
   * @param proposed - the provider and model the call would use.
   * @returns the local model, the proposed one when already local, or an error.
   */
  airGapModel(proposed: ModelRef): ModelRef | { readonly error: string } {
    const settings = this.settings()
    if (!settings.airGap) return proposed
    const local = settings.localModel
    if (local !== undefined && proposed.provider === local.provider) return proposed
    if (local === undefined && LOCAL_PROVIDERS.has(proposed.provider.toLowerCase())) return proposed
    const status = this.airGapStatus()
    if (!status.ready || local === undefined) return { error: `Air-Gap mode blocked a cloud model call. ${status.detail}` }
    return local
  }

  // ---------------------------------------------------------------------------
  // Self-healing

  private async debuggerAgent(workspace: string | undefined): Promise<{ readonly id: string; readonly name: string }> {
    const name = debuggerName(workspace)
    const existing = (await this.ctx.mainAgents.list()).find(agent => agent.name === name)
    if (existing !== undefined) return existing
    return this.ctx.mainAgents.create(name, {
      description: 'Self-healing Debugger: reproduces and fixes build, test, and runtime failures from other agents\' background tasks so they can be retried.',
      instructions: [
        'You are the Debugger. You receive a failed task and its error log.',
        'Reproduce the failure, find the root cause, make the smallest correct fix, and re-run the failing command until it passes.',
        'Never weaken or delete tests, disable checks, or force-push to make something pass.',
        'Finish with "FIXED:" and what you changed, or "TASK FAILED:" and why. Never claim a fix you did not verify.',
      ].join('\n'),
      permissions: { preset: 'workspace-write', agentAdministration: false },
      ...workspace === undefined ? {} : { workspace },
      start: true,
    }, { kind: 'user' })
  }

  // ---------------------------------------------------------------------------
  // Phone companion

  /**
   * Take a voice note from the phone: index it, remember it, and start drafting a response.
   * @param text - transcribed note.
   * @returns whether it was saved to memory and the drafting turn.
   */
  async voiceNote(text: string): Promise<{ readonly saved: boolean; readonly turnId?: string; readonly reason?: string }> {
    const body = text.trim()
    if (body === '') throw new Error('the note is empty')
    const finding = findSensitive(body)
    if (finding.sensitive) {
      this.ctx.personalAi.notify({ level: 'warning', kind: 'voice-note', text: 'A phone note looked like it contained a secret, so it was not stored.' })
      return { saved: false, reason: `not stored: it ${finding.reason ?? 'looks sensitive'}` }
    }
    const domain = await this.ready
    const at = new Date().toISOString()
    await domain.table('notes').put(`note-${Date.now()}`, { at, text: body.slice(0, 4000) })
    await this.ctx.personalAi.remember({ scope: 'user', text: `Voice note (${at.slice(0, 16).replace('T', ' ')}): ${body.slice(0, 1800)}`, tags: ['voice-note'] }, 'user')
    this.ctx.personalAi.notify({ level: 'info', kind: 'voice-note', text: `Voice note from your phone: ${body.slice(0, 120)}` })
    const turn = await this.ctx.personalAi.converse([
      `Voice note from my phone: "${body.slice(0, 3000)}"`,
      'It is already saved to memory. If it asks for something, start drafting the response or plan here on the desktop and tell me briefly what you drafted.',
      'Do not send messages, email, or take irreversible actions without asking me first.',
    ].join('\n')).catch(() => undefined)
    return { saved: true, ...turn === undefined ? {} : { turnId: turn.id } }
  }

  private advertise(): void {
    if (this.mdns !== undefined || process.platform !== 'darwin') return
    const port = Number(process.env.KAIROFORGE_PORT ?? '3080')
    const child = spawn('/usr/bin/dns-sd', ['-R', 'KairoForge', '_kairoforge._tcp', 'local', String(port), `path=${PHONE_PATH}`], { stdio: 'ignore' })
    child.on('exit', () => { if (this.mdns === child) this.mdns = undefined })
    child.on('error', () => { if (this.mdns === child) this.mdns = undefined })
    this.mdns = child
  }

  private stopAdvertising(): void {
    this.mdns?.kill()
    this.mdns = undefined
  }

  // ---------------------------------------------------------------------------
  // Context and status

  /**
   * Prompt context for one coordinator request.
   * @param request - the user's message.
   * @returns context text, or empty.
   */
  contextFor(request: string): string {
    const lines = [...this.brain.contextFor(request), ...this.senses.contextFor(request)]
    if (this.settings().airGap) lines.push('Air-Gap mode is ON: no web, browser, GitHub, or network commands; work only with local files and tools.')
    const tools = this.userTools.known()
    if (tools.length > 0) lines.push(`Your self-written tools: ${tools.map(tool => `user_tool__${tool.name} (${tool.description.slice(0, 60)})`).join('; ')}.`)
    return lines.join('\n')
  }

  /** Everything the Command Center shows. */
  async status(): Promise<LifeStatus> {
    await this.ready
    const port = process.env.KAIROFORGE_PORT ?? '3080'
    return {
      settings: this.settings(),
      vault: await this.vault.status(),
      brain: this.brain.status(),
      senses: this.senses.status(),
      healing: this.healer.history(),
      tools: await this.userTools.list(),
      airGap: this.airGapStatus(),
      phone: { path: PHONE_PATH, ...this.lanHost === undefined ? {} : { lanUrl: `http://${this.lanHost}:${port}${PHONE_PATH}` }, advertising: this.mdns !== undefined },
      graph: this.brain.facts(60),
    }
  }
}
