import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureCheckpoint, changesSince, checkpointRefExists, deleteCheckpointRef, diffSince, restoreChanges } from '../src/orchestration/git.ts'
import { escalationGuidance, LoopDetector, normalizeError, recoveryGuidance, similarity } from '../src/orchestration/loop-detector.ts'
import { classify, messageBody, route } from '../src/orchestration/routing.ts'
import { gitGuard, isReadOnlyCommand, isTestCommand, redact } from '../src/orchestration/shell-policy.ts'
import { DEFAULT_SETTINGS, type WorkflowRecord, type WorkflowTaskRecord } from '../src/orchestration/types.ts'
import { allSettled, dependencyContext, propagateFailures, readyTasks, validateTasks } from '../src/orchestration/workflow-graph.ts'
import { dependencyLevels, duration, statusDot, statusTone } from '../src/client/format.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('loop detector', () => {
  it('detects repeated reads of one file without edits', () => {
    const detector = new LoopDetector()
    const detections = Array.from({ length: 4 }, () => detector.observe({ name: 'read', args: { path: 'a.ts' }, ok: true }))
    expect(detections.slice(0, 3).every(d => d === undefined)).toBe(true)
    expect(detections[3]?.kind).toBe('repeated-read')
    expect(detector.observe({ name: 'read', args: { path: 'a.ts' }, ok: true })).toBeUndefined()
  })

  it('does not flag reads interleaved with edits of the same file', () => {
    const detector = new LoopDetector()
    for (let i = 0; i < 6; i++) {
      expect(detector.observe({ name: 'read', args: { path: 'a.ts' }, ok: true })).toBeUndefined()
      detector.observe({ name: 'edit', args: { path: 'a.ts', old_string: String(i), new_string: `value ${String(i * 7919)} unique ${'x'.repeat(i)}` }, ok: true })
    }
  })

  it('detects nearly identical edits', () => {
    const detector = new LoopDetector()
    const kinds = [0, 1, 2].map(i => detector.observe({ name: 'edit', args: { path: 'b.ts', old_string: 'x', new_string: `const answer = computeTheValue(input, options) + ${String(i)}` }, ok: true })?.kind)
    expect(kinds).toEqual([undefined, undefined, 'similar-edit'])
  })

  it('detects the same failing command and reports recovery outcome', () => {
    const detector = new LoopDetector({ ...DEFAULT_THRESHOLDS_FOR_TEST, recoveryWindow: 3 })
    const fail = { name: 'bash', args: { command: 'pnpm test' }, ok: false, error: 'exit code 1: 3 failed' }
    detector.observe(fail)
    detector.observe(fail)
    const detection = detector.observe(fail)
    expect(detection?.kind).toBe('failing-command')
    let outcome: boolean | undefined
    detector.watch(detection?.key ?? '', (recurred) => { outcome = recurred })
    for (const path of ['x', 'y', 'z']) detector.observe({ name: 'read', args: { path }, ok: true })
    expect(outcome).toBe(false)
  })

  it('reports recurrence when the pattern repeats after detection', () => {
    const detector = new LoopDetector()
    const fail = { name: 'bash', args: { command: 'make' }, ok: false, error: 'boom' }
    detector.observe(fail)
    detector.observe(fail)
    const detection = detector.observe(fail)
    let outcome: boolean | undefined
    detector.watch(detection?.key ?? '', (recurred) => { outcome = recurred })
    detector.observe(fail)
    expect(outcome).toBe(true)
  })

  it('detects the same error across different actions', () => {
    const detector = new LoopDetector()
    detector.observe({ name: 'bash', args: { command: 'node a.js' }, ok: false, error: 'TypeError: x is undefined at line 12' })
    detector.observe({ name: 'bash', args: { command: 'node b.js' }, ok: false, error: 'TypeError: x is undefined at line 40' })
    expect(detector.observe({ name: 'bash', args: { command: 'node c.js' }, ok: false, error: 'TypeError: x is undefined at line 7' })?.kind).toBe('same-error')
  })

  it('detects alternating actions', () => {
    const detector = new LoopDetector()
    const kinds: Array<string | undefined> = []
    for (let i = 0; i < 6; i++) {
      kinds.push(detector.observe(i % 2 === 0
        ? { name: 'bash', args: { command: 'git stash' }, ok: true }
        : { name: 'bash', args: { command: 'git stash pop' }, ok: true })?.kind)
    }
    expect(kinds.at(-1)).toBe('alternating')
  })

  it('detects excessive steps without progress', () => {
    const detector = new LoopDetector({ ...DEFAULT_THRESHOLDS_FOR_TEST, noProgressSteps: 10, repeatedReads: 99 })
    const kinds = Array.from({ length: 10 }, (_, i) => detector.observe({ name: 'grep', args: { pattern: `p${String(i)}` }, ok: true })?.kind)
    expect(kinds.at(-1)).toBe('no-progress')
  })

  it('normalizes errors and measures similarity', () => {
    expect(normalizeError('Error at 0xdeadbeef line 12')).toBe(normalizeError('Error at 0xcafe line 99'))
    expect(similarity('abcdef', 'abcdef')).toBe(1)
    expect(similarity('abcdef', 'zzzzzz')).toBe(0)
  })

  it('produces a recovery protocol that pauses rather than stops', () => {
    const text = recoveryGuidance({ kind: 'failing-command', key: 'k', summary: 's', attempts: ['a'] }, true)
    expect(text).toContain('Pause the current strategy')
    expect(text).toContain('spawn_teammate')
    expect(text).toContain('different plan')
  })

  it('escalates a recurrence toward diagnosis or a user report', () => {
    const detection = { kind: 'failing-command' as const, key: 'k', summary: 's', attempts: ['a'] }
    expect(escalationGuidance(detection, true)).toContain('spawn_teammate')
    expect(escalationGuidance(detection, false)).not.toContain('spawn_teammate')
    expect(escalationGuidance(detection, false)).toContain('stop and report to the user')
  })
})

const DEFAULT_THRESHOLDS_FOR_TEST = {
  repeatedReads: 4, similarEdits: 3, failingCommand: 3, sameError: 3, alternatingCycles: 3, noProgressSteps: 40, recoveryWindow: 12,
}

describe('model routing', () => {
  const base = { mode: 'standard', lastUserText: '', hasImage: false, worker: false } as const
  const available = new Set(['deepseek', 'openai'])
  const current = { provider: 'deepseek', model: 'deepseek-v4-pro' }

  it('classifies requests', () => {
    expect(classify({ ...base, hasImage: true }).category).toBe('VISION')
    expect(classify({ ...base, mode: 'fast', lastUserText: 'refactor the parser' }).category).toBe('FAST')
    expect(classify({ ...base, lastUserText: 'please review this diff' }).category).toBe('REVIEW')
    // KairoForge framing headers are not part of the request.
    const framed = '[KairoForge agent message]\nFrom: the user (Agents panel)\nTo: main agent "Router"\n\nhi'
    expect(messageBody(framed)).toBe('hi')
    expect(classify({ ...base, lastUserText: framed }).category).toBe('FAST')
    expect(classify({ ...base, lastUserText: '[KairoForge review request] Delegation: d-1\n\nlook at it' }).category).toBe('REVIEW')
    expect(classify({ ...base, lastUserText: 'What is the root cause of the deadlock and the trade-offs?' }).category).toBe('DEEP_REASONING')
    expect(classify({ ...base, lastUserText: 'implement the login endpoint and add tests for it in the server package please' }).category).toBe('CODING')
    expect(classify({ ...base, lastUserText: 'hi there' }).category).toBe('FAST')
    expect(classify({ ...base, template: 'engineer', lastUserText: 'add a flag' }).category).toBe('CODING')
    expect(classify({ ...base, override: 'REVIEW', lastUserText: 'hi' }).category).toBe('REVIEW')
  })

  it('routes only to configured, available models and explains why', () => {
    const settings = { ...DEFAULT_SETTINGS.routing, categories: { FAST: { provider: 'deepseek', model: 'deepseek-v4-flash' }, VISION: { provider: 'missing', model: 'm' } } }
    const fast = route(settings, { ...base, lastUserText: 'hi' }, current, available)
    expect(fast).toMatchObject({ category: 'FAST', routed: true, model: { model: 'deepseek-v4-flash' } })
    const vision = route(settings, { ...base, hasImage: true }, current, available)
    expect(vision.routed).toBe(false)
    expect(vision.reason).toContain('not configured')
    const unmapped = route(settings, { ...base, lastUserText: 'review my change' }, current, available)
    expect(unmapped.routed).toBe(false)
    expect(unmapped.reason).toContain('no model configured')
    expect(route({ ...settings, enabled: false }, { ...base, lastUserText: 'hi' }, current, available).routed).toBe(false)
    expect(route(settings, { ...base, override: 'off', lastUserText: 'hi' }, current, available).routed).toBe(false)
  })
})

describe('shell policy', () => {
  it('classifies read-only, mutating, and test commands', () => {
    expect(isReadOnlyCommand('git status && ls -la')).toBe(true)
    expect(isReadOnlyCommand('rg foo src | head')).toBe(true)
    expect(isReadOnlyCommand('echo hi > out.txt')).toBe(false)
    expect(isReadOnlyCommand('npm install')).toBe(false)
    expect(isTestCommand('pnpm vitest run')).toBe(true)
    expect(isTestCommand('pnpm run typecheck')).toBe(true)
    expect(isTestCommand('ls')).toBe(false)
  })

  it('guards protected branches and uncommitted work', () => {
    const prot = ['main', 'master']
    expect(gitGuard('git push --force origin main', 'feature', prot)?.kind).toBe('deny')
    expect(gitGuard('git push origin +main', 'feature', prot)?.kind).toBe('deny')
    expect(gitGuard('git push origin :master', 'feature', prot)?.kind).toBe('deny')
    expect(gitGuard('git push', 'main', prot)?.kind).toBe('ask')
    expect(gitGuard('git push origin HEAD:main', 'feature', prot)?.kind).toBe('ask')
    expect(gitGuard('git push -u origin kairoforge/fix', 'kairoforge/fix', prot)).toBeUndefined()
    expect(gitGuard('git push --force origin kairoforge/fix', 'kairoforge/fix', prot)?.kind).toBe('ask')
    expect(gitGuard('git reset --hard HEAD~1', 'x', prot)?.kind).toBe('ask')
    expect(gitGuard('git clean -fd', 'x', prot)?.kind).toBe('ask')
    expect(gitGuard('git checkout -- .', 'x', prot)?.kind).toBe('ask')
    expect(gitGuard('git stash drop', 'x', prot)?.kind).toBe('ask')
    expect(gitGuard('git status && git commit -m x', 'main', prot)).toBeUndefined()
  })

  it('redacts credentials', () => {
    const text = redact('key sk-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz1234 token=supersecretvalue')
    expect(text).not.toContain('sk-abcdefghijklmnop1234')
    expect(text).not.toContain('ghp_')
    expect(text).not.toContain('supersecretvalue')
    expect(text).toContain('token=[redacted]')
  })
})

describe('workflow graph', () => {
  const spec = (id: string, dependsOn: string[] = [], retries = 0) => ({ id, title: id, role: 'worker', instructions: `do ${id}`, dependsOn, retries })
  const record = (tasks: WorkflowTaskRecord[]): WorkflowRecord => ({
    id: 'w', title: 't', goal: 'g', ownerSessionId: 's', ownerName: 'o', status: 'running', maxParallel: 2, tasks, createdAt: 'now', updatedAt: 'now',
  })
  const task = (id: string, status: WorkflowTaskRecord['status'], dependsOn: string[] = [], result?: string): WorkflowTaskRecord => ({
    ...spec(id, dependsOn), status, attempts: 0, workers: [], ...result === undefined ? {} : { result },
  })

  it('validates ids, dependencies, and cycles', () => {
    expect(validateTasks([spec('a'), spec('b', ['a'])])).toHaveLength(2)
    expect(() => validateTasks([spec('a'), spec('a')])).toThrow(/duplicate/)
    expect(() => validateTasks([spec('a', ['zz'])])).toThrow(/unknown/)
    expect(() => validateTasks([spec('a', ['b']), spec('b', ['a'])])).toThrow(/cycle/)
    expect(validateTasks([spec('a', [], 99)])[0]?.retries).toBe(3)
  })

  it('schedules parallel ready tasks within the cap and passes results', () => {
    const wf = record([task('a', 'completed', [], 'A-result'), task('b', 'pending', ['a']), task('c', 'pending', ['a']), task('d', 'pending', ['a']), task('e', 'pending', ['b', 'c'])])
    expect(readyTasks(wf).map(t => t.id)).toEqual(['b', 'c'])
    expect(dependencyContext(wf, wf.tasks[1] as WorkflowTaskRecord)).toContain('A-result')
  })

  it('skips dependants of failed tasks and settles', () => {
    const tasks = propagateFailures([task('a', 'failed'), task('b', 'pending', ['a']), task('c', 'pending', ['b'])])
    expect(tasks.map(t => t.status)).toEqual(['failed', 'skipped', 'skipped'])
    expect(allSettled(tasks)).toBe(true)
  })
})

describe('git checkpoints', () => {
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-repo-'))
    roots.push(root)
    const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    run('init', '-q', '-b', 'main')
    run('config', 'user.email', 't@t')
    run('config', 'user.name', 't')
    writeFileSync(join(root, 'a.txt'), 'a1\n')
    writeFileSync(join(root, 'keep.txt'), 'keep1\n')
    writeFileSync(join(root, '.gitignore'), 'secret.env\n')
    run('add', '.')
    run('commit', '-qm', 'init')
    return root
  }
  const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

  it('captures without touching index, HEAD, or files and restores only chosen paths', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'a2-user-uncommitted\n')
    writeFileSync(join(root, 'staged.txt'), 'staged\n')
    git(root, 'add', 'staged.txt')
    writeFileSync(join(root, 'secret.env'), 'API_KEY=x\n')
    const statusBefore = git(root, 'status', '--porcelain')
    const headBefore = git(root, 'rev-parse', 'HEAD')

    const cp = await captureCheckpoint(join(root), 'cp1', 'checkpoint')
    expect(cp).toBeDefined()
    if (cp === undefined) return
    expect(git(root, 'status', '--porcelain')).toBe(statusBefore)
    expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(cp.dirty.toSorted()).toEqual(['a.txt', 'staged.txt'])
    expect(git(root, 'ls-tree', '-r', '--name-only', cp.tree)).not.toContain('secret.env')
    expect(await checkpointRefExists(root, cp.ref)).toBe(true)

    // Agent work after the checkpoint, plus an unrelated user edit.
    writeFileSync(join(root, 'a.txt'), 'broken by agent\n')
    writeFileSync(join(root, 'new.txt'), 'agent created\n')
    writeFileSync(join(root, 'keep.txt'), 'user edit after checkpoint\n')
    const changes = await changesSince(root, cp.tree)
    expect(changes.toSorted((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.txt', status: 'M' }, { path: 'keep.txt', status: 'M' }, { path: 'new.txt', status: 'A' },
    ])
    expect(await diffSince(root, cp.tree, ['a.txt'])).toContain('broken by agent')

    const agentOnly = changes.filter(change => change.path !== 'keep.txt')
    const outcome = await restoreChanges(root, cp.tree, agentOnly)
    expect(outcome).toEqual({ restored: ['a.txt'], deleted: ['new.txt'] })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a2-user-uncommitted\n')
    expect(existsSync(join(root, 'new.txt'))).toBe(false)
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('user edit after checkpoint\n')
    expect(readFileSync(join(root, 'secret.env'), 'utf8')).toBe('API_KEY=x\n')
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('staged.txt')

    await deleteCheckpointRef(root, cp.ref)
    expect(await checkpointRefExists(root, cp.ref)).toBe(false)
  })

  it('returns undefined outside a repository and rejects escaping paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-repo-'))
    roots.push(dir)
    mkdirSync(join(dir, 'x'))
    expect(await captureCheckpoint(join(dir, 'x'), 'cp', 'm')).toBeUndefined()
    const root = repo()
    const cp = await captureCheckpoint(root, 'cp2', 'm')
    await expect(restoreChanges(root, cp?.tree ?? '', [{ path: '../outside', status: 'M' }])).rejects.toThrow(/escapes/)
  })
})

describe('workflow view helpers', () => {
  it('lays tasks out in dependency levels so parallel work shares a level', () => {
    const levels = dependencyLevels([
      { id: 'integrate', dependsOn: ['api', 'ui'] },
      { id: 'api', dependsOn: ['plan'] },
      { id: 'plan', dependsOn: [] },
      { id: 'ui', dependsOn: ['plan'] },
    ])
    expect(levels.map(level => level.map(task => task.id))).toEqual([['plan'], ['api', 'ui'], ['integrate']])
  })

  it('terminates on a dependency cycle instead of recursing forever', () => {
    const levels = dependencyLevels([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }])
    expect(levels.flat().map(task => task.id).toSorted()).toEqual(['a', 'b'])
  })

  it('maps every orchestration status to a dot and tone', () => {
    expect(statusDot('running')).toBe('ongoing')
    expect(statusDot('failed')).toBe('error')
    expect(statusDot('paused')).toBe('warning')
    expect(statusDot('completed')).toBe('done')
    expect(statusTone('recurred')).toBe('danger')
    expect(statusTone('recovered')).toBe('success')
    expect(duration(252_000)).toBe('4m 12s')
  })
})
