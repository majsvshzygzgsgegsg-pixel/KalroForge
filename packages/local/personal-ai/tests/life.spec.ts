import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { airGapBlock, classifyFailure, debuggerPrompt, healAction, isLoopbackUrl, userToolNameError } from '../src/core/autonomy.ts'
import { categoryOf } from '../src/core/capabilities.ts'
import { KnowledgeGraph } from '../src/core/graph.ts'
import { classifyRisk, isSecretPath } from '../src/core/risk.ts'
import {
  appName, classifyClip, learnRoutines, routeNotification, StuckDetector, stuckMessage, summarizeNotification, type AppActivation,
} from '../src/core/senses.ts'
import { chunkText, cosine, embed, VectorIndex, type SerializedIndex } from '../src/core/vectors.ts'
import { voiceToolbelt, voiceTools } from '../src/core/voice-tools.ts'
import { Healer, debuggerName, type HealerHost } from '../src/life/healer.ts'
import { UserTools } from '../src/life/user-tools.ts'
import type { NativeHelper } from '../src/native.ts'
import { openBytes, sealBytes, Vault } from '../src/vault.ts'

describe('local vectors', () => {
  it('embeds related text closer than unrelated text', () => {
    const query = embed('react hook error in the login form')
    const near = embed('The login form throws an error from a React hook (useEffect)')
    const far = embed('Grocery list: apples, bread, oat milk')
    expect(cosine(query, near)).toBeGreaterThan(cosine(query, far))
    expect(cosine(near, near)).toBeCloseTo(1, 5)
  })

  it('chunks long text with overlap and keeps every part', () => {
    const text = Array.from({ length: 60 }, (_, index) => `Line ${String(index)} talks about topic ${String(index % 7)}.`).join('\n')
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.at(-1)?.text).toContain('Line 59')
    expect(chunkText('')).toEqual([])
  })

  it('searches, replaces, removes, and survives serialization', () => {
    const index = new VectorIndex()
    index.upsert('/notes/auth.md', 'The auth module validates JWT sessions. Last Tuesday a bug broke token refresh.', { mtime: 1, size: 10 })
    index.upsert('/notes/food.md', 'Dinner ideas: pasta, curry, tacos.', { mtime: 1, size: 10 })
    expect(index.search('token refresh bug in auth')[0]?.doc).toBe('/notes/auth.md')
    expect(index.isCurrent('/notes/auth.md', 1, 10)).toBe(true)
    expect(index.isCurrent('/notes/auth.md', 2, 10)).toBe(false)

    const restored = VectorIndex.from(JSON.parse(JSON.stringify(index.serialize())) as SerializedIndex)
    expect(restored.documentCount).toBe(2)
    expect(restored.search('pasta dinner')[0]?.doc).toBe('/notes/food.md')

    restored.remove('/notes/food.md')
    expect(restored.has('/notes/food.md')).toBe(false)
    expect(restored.search('pasta dinner').some(hit => hit.doc === '/notes/food.md')).toBe(false)
  })
})

describe('knowledge graph', () => {
  it('links, answers two hops, finds mentions, and unlinks', () => {
    const graph = new KnowledgeGraph()
    graph.link('Michael', 'is', 'boss', { fromKind: 'person' })
    graph.link('KairoForge', 'is', 'main project')
    graph.link('that bug from last Tuesday', 'affects', 'auth module')
    graph.link('auth module', 'part of', 'KairoForge')
    graph.link('Michael', 'is', 'boss')
    expect(graph.size()).toEqual({ entities: 6, relations: 4 })
    expect(graph.about('auth module')).toEqual(expect.arrayContaining([
      'that bug from last Tuesday affects auth module', 'auth module part of KairoForge', 'KairoForge is main project',
    ]))
    expect(graph.mentioned('What did michael say about the auth module?').map(entity => entity.id)).toEqual(['auth module', 'michael'])
    expect(graph.holdersOf(['Boss'])).toEqual(['Michael'])
    expect(graph.unlink('Michael', 'boss')).toBe(1)
    expect(graph.holdersOf(['boss'])).toEqual([])
    expect(new KnowledgeGraph(graph.toJSON()).size()).toEqual(graph.size())
  })
})

describe('senses', () => {
  it('pings once when a dev window sits idle past the threshold, then cools down', () => {
    const detector = new StuckDetector()
    expect(detector.observe({ at: 0, app: 'Code', title: 'useAuth.ts — TypeError: undefined', idle: 30 })).toBeUndefined()
    const moment = detector.observe({ at: 1000, app: 'Code', title: 'useAuth.ts — TypeError: undefined', idle: 50 })
    expect(moment).toMatchObject({ app: 'Code', errorish: true, seconds: 50 })
    expect(stuckMessage(moment ?? { app: '', seconds: 0, errorish: false })).toContain('sub-agent')
    expect(detector.observe({ at: 5000, app: 'Code', title: 'useAuth.ts — TypeError: undefined', idle: 60 })).toBeUndefined()
    expect(detector.observe({ at: 2000, app: 'Spotify', idle: 600 })).toBeUndefined()
  })

  it('learns apps opened around the same time on several days', () => {
    const day = (offset: number, hour: number, minute: number): number => new Date(2026, 8, 20 + offset, hour, minute).getTime()
    const activations: AppActivation[] = []
    for (let offset = 0; offset < 4; offset++) {
      activations.push({ app: 'Terminal', at: day(offset, 16, offset) }, { app: 'Spotify', at: day(offset, 16, 2 + offset) })
    }
    activations.push({ app: 'Xcode', at: day(0, 9, 0) })
    const routines = learnRoutines(activations, day(4, 12, 0))
    expect(routines).toHaveLength(1)
    expect(routines[0]?.apps.toSorted()).toEqual(['Spotify', 'Terminal'])
    expect(routines[0]?.minute).toBeGreaterThanOrEqual(16 * 60)
    expect(routines[0]?.days).toBe(4)
  })

  it('classifies clipboard text locally', () => {
    expect(classifyClip('TypeError: Cannot read properties of undefined\n    at useAuth (src/useAuth.ts:12:5)').kind).toBe('error')
    expect(classifyClip('const [user, setUser] = useState(null)\nuseEffect(() => {}, [])')).toMatchObject({ kind: 'code', language: 'React' })
    expect(classifyClip('{"a": 1}').kind).toBe('json')
    expect(classifyClip('https://github.com/acme/repo').kind).toBe('url')
    expect(classifyClip('Remember to call mom').kind).toBe('text')
  })

  it('routes notifications by VIP, urgency, and noise', () => {
    const rules = { vips: ['Michael'], urgentWords: [], mutedApps: ['News'] }
    const at = 0
    expect(routeNotification({ at, app: 'Slack', title: 'Michael', body: 'Prod is down, need you asap' }, rules).route).toBe('urgent')
    expect(routeNotification({ at, app: 'Slack', title: 'Michael', body: 'Can you look at the doc later?' }, rules).route).toBe('normal')
    expect(routeNotification({ at, app: 'Slack', title: '#random', body: 'lol this meme' }, rules).route).toBe('silent')
    expect(routeNotification({ at, app: 'News', title: 'Breaking', body: 'urgent update' }, rules).route).toBe('silent')
    expect(summarizeNotification({ at, app: 'Slack', title: 'Michael', body: 'x'.repeat(400) }).length).toBeLessThanOrEqual(200)
    expect(appName('com.tinyspeck.slackmacgap')).toBe('Slack')
    expect(appName('com.example.coolapp')).toBe('Coolapp')
  })
})

describe('autonomy rules', () => {
  it('classifies failures and bounds healing', () => {
    expect(classifyFailure('Error 429: rate limit exceeded')).toBe('rate-limit')
    expect(classifyFailure('TASK FAILED: error TS2322 in build')).toBe('build')
    expect(classifyFailure('cancelled by the user')).toBe('cancelled')
    expect(healAction('rate-limit', { retries: 0, debugs: 0 }, false)).toMatchObject({ kind: 'retry' })
    expect(healAction('rate-limit', { retries: 2, debugs: 0 }, false).kind).toBe('give-up')
    expect(healAction('build', { retries: 0, debugs: 0 }, false).kind).toBe('debug')
    expect(healAction('build', { retries: 0, debugs: 1 }, false).kind).toBe('give-up')
    expect(healAction('build', { retries: 0, debugs: 0 }, true).kind).toBe('give-up')
    expect(debuggerPrompt({ title: 't', prompt: 'p', error: 'boom', agent: 'Builder' })).toContain('TASK FAILED:')
  })

  it('blocks network paths in Air-Gap mode', () => {
    expect(airGapBlock('web_search', {})).toBeDefined()
    expect(airGapBlock('browser_navigate', {})).toBeDefined()
    expect(airGapBlock('github_create_issue', {})).toBeDefined()
    expect(airGapBlock('bash', { command: 'curl https://example.com' })).toBeDefined()
    expect(airGapBlock('bash', { command: 'git push origin main' })).toBeDefined()
    expect(airGapBlock('bash', { command: 'pnpm install' })).toBeDefined()
    expect(airGapBlock('bash', { command: 'ls -la && npm test' })).toBeUndefined()
    expect(airGapBlock('bash', { command: 'curl http://127.0.0.1:3080/state' })).toBeDefined()
    expect(airGapBlock('read', { path: '/tmp/x' })).toBeUndefined()
    expect(isLoopbackUrl('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLoopbackUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('gates tool writing and keeps new tools visible to the voice toolbelt', () => {
    expect(classifyRisk('create_tool', {}).risk).toBe('SENSITIVE')
    expect(classifyRisk('search_brain', {}).risk).toBe('LOW_RISK')
    expect(classifyRisk('graph_query', {}).risk).toBe('LOW_RISK')
    expect(categoryOf('search_brain')).toBe('SEARCH')
    expect(categoryOf('user_tool__resize_images')).toBe('TERMINAL')
    const belt = voiceToolbelt('index my notes folder and search it', 'tool')
    expect(voiceTools([{ name: 'search_brain' }, { name: 'link_entities' }, { name: 'user_tool__resize_images' }], belt).map(tool => tool.name))
      .toEqual(['search_brain', 'link_entities', 'user_tool__resize_images'])
    expect(userToolNameError('resize_images')).toBeUndefined()
    expect(userToolNameError('../evil')).toBeDefined()
  })

  it('treats credential and env paths as secret', () => {
    expect(isSecretPath('/Users/me/.ssh/id_ed25519')).toBe(true)
    expect(isSecretPath('/Users/me/project/.env.local')).toBe(true)
    expect(isSecretPath('/Users/me/notes/plan.md')).toBe(false)
  })
})

describe('vault', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'kf-vault-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('seals with AES-GCM and rejects tampering or the wrong key', () => {
    const key = Buffer.alloc(32, 7)
    const sealed = sealBytes(key, Buffer.from('brain'))
    expect(openBytes(key, sealed).toString()).toBe('brain')
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1
    expect(() => openBytes(key, tampered)).toThrow()
    expect(() => openBytes(Buffer.alloc(32, 8), sealed)).toThrow()
  })

  it('falls back to an owner-only key file without a Secure Enclave and never writes plaintext', async () => {
    const native = { supported: () => false, call: () => Promise.reject(new Error('no helper')) } as unknown as NativeHelper
    const vault = new Vault(native, home)
    await vault.put('graph', { secretish: 'Michael is boss' })
    expect(await vault.get('graph')).toEqual({ secretish: 'Michael is boss' })
    expect(readFileSync(join(home, 'brain', 'graph.sealed')).includes(Buffer.from('Michael'))).toBe(false)
    expect((await vault.status()).mode).toBe('file')
    expect(await new Vault(native, home).get('graph')).toEqual({ secretish: 'Michael is boss' })
    await expect(vault.put('../escape', {})).rejects.toThrow()
  })
})

describe('self-written tools', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'kf-tools-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('saves, runs with stdin args and a minimal environment, and refuses secrets', async () => {
    const tools = new UserTools(root)
    process.env.KF_TEST_PRIVATE = 'should-not-leak'
    await tools.create({
      name: 'echo_args', description: 'Echo', language: 'bash',
      script: 'read -r input; echo "args=$input private=${KF_TEST_PRIVATE:-none} env=$KF_ARGS"',
      parameters: [{ name: 'text', description: 'Text', required: true }],
    })
    expect((await tools.list()).map(tool => tool.name)).toEqual(['echo_args'])
    const run = await tools.run('echo_args', { text: 'hi' }, root)
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('args={"text":"hi"}')
    expect(run.stdout).toContain('private=none')
    await expect(tools.create({ name: 'leaky', description: 'x', language: 'bash', script: 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD' })).rejects.toThrow()
    expect(await tools.remove('echo_args')).toBe(true)
    expect(await tools.list()).toEqual([])
    delete process.env.KF_TEST_PRIVATE
  })

  it('flags scripts that reach the network', async () => {
    const tools = new UserTools(root)
    const manifest = await tools.create({ name: 'fetcher', description: 'x', language: 'python', script: 'import requests\nprint(requests.get("https://x.dev").text)' })
    expect(manifest.reachesNetwork).toBe(true)
  })
})

describe('self-healing', () => {
  type Task = ReturnType<HealerHost['tasks']>[number]
  const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
    id, agentId: 'builder', title: `Build ${id}`, prompt: 'build it', status, progress: { steps: 0, toolCalls: 0 },
    createdBy: 'user', createdAt: new Date().toISOString(), ...extra,
  })
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'kf-heal-')) })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(home, { recursive: true, force: true })
  })

  const setup = (tasks: Task[]) => {
    const native = { supported: () => false, call: () => Promise.reject(new Error('no helper')) } as unknown as NativeHelper
    const created: Array<{ agentId: string; title: string; prompt: string }> = []
    const notices: string[] = []
    let next = 0
    const host: HealerHost = {
      vault: new Vault(native, home),
      enabled: () => true,
      tasks: () => tasks,
      createTask: (input) => {
        created.push(input)
        const record = task(`heal-${String(next++)}`, 'queued', { agentId: input.agentId, title: input.title, prompt: input.prompt })
        tasks.unshift(record)
        return Promise.resolve(record)
      },
      agent: id => Promise.resolve({ id, name: 'Builder', workspace: '/work/app' }),
      debugger: workspace => Promise.resolve({ id: 'debugger', name: debuggerName(workspace) }),
      notify: (_level, text) => { notices.push(text) },
      warn: () => {},
    }
    return { healer: new Healer(host), created, notices, tasks }
  }

  it('ignores failures from before it started, then debugs a build failure and retries after the fix', async () => {
    const tasks = [task('old', 'failed', { error: 'TASK FAILED: build' })]
    const { healer, created, notices } = setup(tasks)
    await healer.poll()
    expect(created).toEqual([])

    tasks.unshift(task('new', 'failed', { error: 'TASK FAILED: error TS2322 while compiling' }))
    await healer.poll()
    expect(created[0]).toMatchObject({ agentId: 'debugger', title: 'Debug: Build new' })
    expect(created[0]?.prompt).toContain('error TS2322')
    expect(notices.at(-1)).toContain('Debugger app')

    const debugTask = tasks[0]
    if (debugTask === undefined) throw new Error('missing debug task')
    tasks[0] = { ...debugTask, status: 'completed', result: 'FIXED: typed the prop' }
    await healer.poll()
    expect(created[1]).toMatchObject({ agentId: 'builder', title: 'Build new', prompt: 'build it' })

    const retry = tasks[0]
    if (retry === undefined) throw new Error('missing retry')
    tasks[0] = { ...retry, status: 'failed', error: 'TASK FAILED: still broken, error TS2322' }
    await healer.poll()
    expect(created).toHaveLength(2)
    expect(notices.at(-1)).toContain('self-healing stopped')
    expect(healer.history()).toHaveLength(2)
  })

  it('re-queues rate-limited tasks after a pause', async () => {
    vi.useFakeTimers()
    const tasks: Task[] = []
    const { healer, created } = setup(tasks)
    await healer.poll()
    tasks.unshift(task('limited', 'failed', { error: '429 Too Many Requests' }))
    await healer.poll()
    expect(created).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(created[0]).toMatchObject({ agentId: 'builder', title: 'Build limited' })
    healer.dispose()
  })
})

describe('brain file filters', () => {
  it('never indexes secret-looking files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kf-brain-'))
    try {
      writeFileSync(join(dir, 'plan.md'), 'The auth module rewrite starts Monday.')
      writeFileSync(join(dir, '.env'), 'TOKEN=abc')
      writeFileSync(join(dir, 'notes.txt'), 'deploy key: ghp_abcdefghijklmnopqrstuvwxyz0123456789')
      const { Brain } = await import('../src/life/brain.ts')
      const native = { supported: () => false, call: () => Promise.reject(new Error('no helper')) } as unknown as NativeHelper
      const brain = new Brain(new Vault(native, join(dir, '.kf')), native, () => {})
      await brain.setRoots([dir])
      await brain.reindex()
      const status = brain.status()
      expect(status.documents).toBe(1)
      expect(status.skippedSensitive).toBe(1)
      expect((await brain.search('auth rewrite'))[0]?.doc).toBe(join(dir, 'plan.md'))
      await brain.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
