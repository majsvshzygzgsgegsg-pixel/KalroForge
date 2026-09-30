/**
 * The plugin's own wiring: it must start, register `ctx.deployments`, and ship
 * the local adapter.
 *
 * Tool registration is deliberately NOT asserted here: it happens through a
 * deferred injection into `ctx.tools`, and the tool runtime needs a larger
 * composition to start than a bare context provides. The Builder-mode
 * composition test in `apps/cli/tests/web-agent-presets.e2e.ts` is what proves
 * the seven deployment tools reach an agent, in the real shipped composition.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import Deployment from '../src/index.ts'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Mount the plugin on a fresh context and hand back both. */
async function mount(): Promise<{ ctx: Context; releaseRoot: string }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const releaseRoot = mkdtempSync(join(tmpdir(), 'dsh-deploy-plugin-'))
  cleanups.push(() => { rmSync(releaseRoot, { recursive: true, force: true }) })
  await ctx.plugin(Deployment, { releaseRoot })
  return { ctx, releaseRoot }
}

describe('the deployment plugin', () => {
  it('starts and provides ctx.deployments with the shipped local adapter', async () => {
    const { ctx, releaseRoot } = await mount()

    expect(ctx.deployments).toBeDefined()
    expect(ctx.deployments.releaseRoot).toBe(releaseRoot)
    // Two adapters ship with the plugin: a local static server, because that is
    // the one every project can have without an account, and GitHub Pages,
    // because that is the one that is publicly reachable without an account too.
    const providers = ctx.deployments.providers()
    expect(providers.map(provider => provider.id)).toEqual(['github-pages', 'local-static'])
    // Publishing publicly must never happen on the model's own initiative.
    expect(providers.find(provider => provider.id === 'github-pages')?.consequential).toBe(true)
    expect(providers.find(provider => provider.id === 'local-static')?.consequential).toBe(false)
  })

  it('registers a configured command provider beside the local adapter', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const releaseRoot = mkdtempSync(join(tmpdir(), 'dsh-deploy-plugin-'))
    cleanups.push(() => { rmSync(releaseRoot, { recursive: true, force: true }) })

    await ctx.plugin(Deployment, {
      releaseRoot,
      providers: [{
        id: 'example-host',
        label: 'Example host',
        environments: { production: { deployCommand: 'true', urlPattern: 'url: (\\S+)' } },
      }],
    })

    expect(ctx.deployments.providers().map(provider => provider.id)).toEqual(['example-host', 'github-pages', 'local-static'])
    const example = ctx.deployments.providers().find(provider => provider.id === 'example-host')
    // A CLI-based host usually creates an account or costs money, so the default
    // is the safe one: it takes the user's approval to run.
    expect(example?.consequential).toBe(true)
  })

  it('refuses a second provider with an id already registered', async () => {
    const { ctx } = await mount()

    const existing = ctx.deployments.providers()[0]
    expect(existing).toBeDefined()
    expect(() => ctx.deployments.registerProvider({
      descriptor: existing!,
      supports: () => true,
      publish: async () => ({ url: 'http://127.0.0.1:1/' }),
    })).toThrow(/already registered/)
  })
})
