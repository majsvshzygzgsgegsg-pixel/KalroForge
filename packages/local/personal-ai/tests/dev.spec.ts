import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { editorContextText, sanitizeSnapshot, type EditorSnapshot } from '../src/core/editor.ts'
import { canonicalArgs, LOOP_LIMITS, LoopBreaker, malformedArgsHint, missingPathOf, suggestPaths } from '../src/core/reliability.ts'
import { extractSymbols, rankFiles, renderRepoMap, searchTerms, type RepoFile } from '../src/core/repomap.ts'
import { classifyRisk, withoutPlainPushes } from '../src/core/risk.ts'
import { EXTENSION_MANIFEST, EXTENSION_SOURCE } from '../src/dev/extension-source.ts'
import { githubGate, githubUrl, parseRemote, parseSlug, renderGithubResponse, slimGithub } from '../src/dev/github.ts'
import { RepoIndex } from '../src/dev/repo-index.ts'
import { APPLESCRIPT_COOKBOOK, appleScriptDictionary, summariseSdef } from '../src/dev/applescript.ts'
import { asText, MAC_ACTION_NAMES, macActionScript, type MacActionArgs } from '../src/core/mac-actions.ts'
import { runOsascript, simulatedInputReason } from '../src/dev/install.ts'
import { compareVersions } from '../src/dev/service.ts'
import { checkSyntax } from '../src/dev/syntax.ts'

const NOW = Date.parse('2026-10-02T12:00:00Z')

function snapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    editor: 'Cursor',
    workspaceFolders: ['/repo'],
    activeFile: '/repo/src/auth.ts',
    language: 'typescript',
    cursor: { line: 12, column: 4 },
    excerpt: { startLine: 10, text: 'const a = 1\nconst b = 2\nexport function login() {}' },
    openFiles: ['/repo/src/auth.ts', '/repo/src/db.ts'],
    diagnostics: [
      { file: '/repo/src/db.ts', line: 3, severity: 'warning', message: 'unused import' },
      { file: '/repo/src/auth.ts', line: 12, severity: 'error', message: 'Cannot find name "sesion"', source: 'ts' },
      { file: '/repo/src/auth.ts', line: 1, severity: 'info', message: 'fyi' },
    ],
    at: new Date(NOW - 5000).toISOString(),
    ...overrides,
  }
}

describe('editor context', () => {
  it('describes the file, cursor, code, problems, and tabs', () => {
    const text = editorContextText(sanitizeSnapshot(snapshot()), NOW)
    expect(text).toContain('Active file: /repo/src/auth.ts (typescript), cursor at line 12 col 4')
    expect(text).toContain('>   12| export function login() {}')
    expect(text.indexOf('src/auth.ts:12')).toBeLessThan(text.indexOf('src/db.ts:3'))
    expect(text).not.toContain('fyi')
    expect(text).toContain('Other open tabs: src/db.ts')
  })

  it('prefers the selection over the excerpt', () => {
    const text = editorContextText(snapshot({ selection: { startLine: 11, endLine: 11, text: 'const b = 2' } }), NOW)
    expect(text).toContain('Selected lines 11-11')
    expect(text).not.toContain('Code around the cursor')
  })

  it('ignores stale reports', () => {
    expect(editorContextText(snapshot({ at: new Date(NOW - 60 * 60_000).toISOString() }), NOW)).toBe('')
    expect(editorContextText(undefined, NOW)).toBe('')
  })

  it('drops the contents of secret files and scrubs keys from code', () => {
    const secret = sanitizeSnapshot(snapshot({ activeFile: '/repo/.env', selection: { startLine: 1, endLine: 1, text: 'API_KEY=abc' } }))
    expect(secret.selection).toBeUndefined()
    expect(secret.excerpt).toBeUndefined()
    const key = sanitizeSnapshot(snapshot({ excerpt: { startLine: 1, text: '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----' } }))
    expect(key.excerpt?.text).toBe('[private key removed]')
  })
})

describe('repo map', () => {
  it('extracts top-level symbols across languages', () => {
    expect(extractSymbols('a.ts', 'export async function loadUser() {}\nexport class AuthService {}\nexport interface Session {}\nconst x = 1')).toEqual(['loadUser', 'AuthService', 'Session'])
    expect(extractSymbols('a.py', 'def refresh_token(x):\n  pass\nclass Cache:\n  pass')).toEqual(expect.arrayContaining(['refresh_token', 'Cache']))
    expect(extractSymbols('a.go', 'func (s *Server) Handle() {}\ntype Config struct {}')).toEqual(expect.arrayContaining(['Handle', 'Config']))
    expect(extractSymbols('README.md', '# Setup\n## Auth flow')).toEqual(['Setup', 'Auth flow'])
  })

  it('splits identifiers into search terms', () => {
    expect(searchTerms('fix the refreshToken bug in auth_module')).toEqual(['refresh', 'token', 'bug', 'auth', 'module'])
  })

  it('ranks files by path, symbols, and editor focus', () => {
    const files: RepoFile[] = [
      { path: 'src/auth/session.ts', symbols: ['refreshToken', 'SessionStore'], mtime: 0 },
      { path: 'src/db/pool.ts', symbols: ['createPool'], mtime: 0 },
      { path: 'tests/auth/session.spec.ts', symbols: [], mtime: 0 },
      { path: 'src/ui/Button.tsx', symbols: ['Button'], mtime: 0 },
    ]
    const ranked = rankFiles('why does refreshToken fail in the auth session', files, {}, NOW)
    expect(ranked[0]?.path).toBe('src/auth/session.ts')
    expect(ranked.map(file => file.path)).not.toContain('src/db/pool.ts')
    expect(rankFiles('hello there', files, {}, NOW)).toEqual([])
    const map = renderRepoMap('/repo', ranked)
    expect(map).toContain('- src/auth/session.ts: refreshToken, SessionStore')
    expect(renderRepoMap('/repo', [])).toBe('')
  })
})

describe('reliability', () => {
  it('reads the missing path out of tool errors', () => {
    expect(missingPathOf('cannot read "src/autth.ts": not found')).toBe('src/autth.ts')
    expect(missingPathOf('The path /repo/x.py does not exist. Please provide a valid path.')).toBe('/repo/x.py')
    expect(missingPathOf('permission denied')).toBeUndefined()
  })

  it('suggests the files the model meant', () => {
    const files = ['src/auth/session.ts', 'src/auth/index.ts', 'src/db/session.sql', 'README.md']
    expect(suggestPaths('src/session.ts', files)[0]).toBe('src/auth/session.ts')
    expect(suggestPaths('src/auth/sesion.ts', files)[0]).toBe('src/auth/session.ts')
    expect(suggestPaths('totally/unrelated.go', files)).toEqual([])
  })

  it('canonicalizes arguments regardless of key order', () => {
    expect(canonicalArgs({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalArgs({ a: { c: 3, d: 2 }, b: 1 }))
  })

  it('stops identical calls and repeated identical failures, and resets', () => {
    const breaker = new LoopBreaker()
    for (let i = 0; i < LOOP_LIMITS.identical; i++) {
      expect(breaker.check('s', 'read', { file_path: 'a' })).toBeUndefined()
      breaker.record('s', 'read', { file_path: 'a' })
    }
    expect(breaker.check('s', 'read', { file_path: 'a' })).toMatch(/identical arguments 10 times/)
    expect(breaker.check('s', 'read', { file_path: 'b' })).toBeUndefined()
    breaker.reset('s')
    for (let i = 0; i < LOOP_LIMITS.failing; i++) breaker.record('s', 'bash', { command: 'npm test' }, 'exit 1: missing script')
    expect(breaker.check('s', 'bash', { command: 'npm test' })).toMatch(/failed 5 times/)
    breaker.record('t', 'job_output', { id: 1 })
    for (let i = 0; i < 20; i++) breaker.record('t', 'job_output', { id: 1 })
    expect(breaker.check('t', 'job_output', { id: 1 })).toBeUndefined()
  })

  it('explains malformed JSON arguments', () => {
    expect(malformedArgsHint('{"a": "b",}')).toMatch(/not valid JSON/)
    expect(malformedArgsHint({ a: 1 })).toBeUndefined()
  })
})

describe('syntax checks and the workspace index', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kf-dev-spec-'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'good.json'), '{"a": 1}')
    await writeFile(join(dir, 'bad.json'), '{\n  "a": 1,\n}')
    await writeFile(join(dir, 'src', 'good.ts'), 'export function ok(a: number): number { return a }\n')
    await writeFile(join(dir, 'src', 'bad.ts'), 'export function broken( {\n  return 1\n')
    await writeFile(join(dir, 'bad.js'), 'const x = ;\n')
    await writeFile(join(dir, 'bad.py'), 'def f(:\n  pass\n')
    await writeFile(join(dir, 'bad.sh'), 'if true; then\n echo hi\n')
    await writeFile(join(dir, 'notes.txt'), 'plain')
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('passes valid files and pinpoints broken ones', async () => {
    expect(await checkSyntax(join(dir, 'good.json'))).toMatchObject({ ok: true })
    expect(await checkSyntax(join(dir, 'bad.json'))).toMatchObject({ ok: false, checker: 'json' })
    expect(await checkSyntax(join(dir, 'src', 'good.ts'))).toMatchObject({ ok: true, checker: 'typescript' })
    expect(await checkSyntax(join(dir, 'src', 'bad.ts'))).toMatchObject({ ok: false, checker: 'typescript' })
    expect(await checkSyntax(join(dir, 'bad.js'))).toMatchObject({ ok: false, line: 1 })
    expect(await checkSyntax(join(dir, 'bad.py'))).toMatchObject({ ok: false, line: 1 })
    expect(await checkSyntax(join(dir, 'bad.sh'))).toMatchObject({ ok: false })
    expect(await checkSyntax(join(dir, 'notes.txt'))).toBeUndefined()
  })

  it('indexes source files and their symbols', async () => {
    const index = new RepoIndex(dir)
    expect(index.ready).toBe(false)
    await index.refreshIfStale()
    expect(index.ready).toBe(true)
    expect(index.entries().find(file => file.path === 'src/good.ts')?.symbols).toEqual(['ok'])
    expect(index.allPaths()).toContain('notes.txt')
  })
})

describe('editor extension package', () => {
  it('is a valid manifest with an activation entry point that parses', async () => {
    expect(EXTENSION_MANIFEST.main).toBe('./extension.js')
    expect(EXTENSION_SOURCE).toContain('function activate(context)')
    expect(EXTENSION_SOURCE).not.toContain('${')
    const dir = await mkdtemp(join(tmpdir(), 'kf-ext-spec-'))
    await writeFile(join(dir, 'extension.js'), EXTENSION_SOURCE)
    expect(await checkSyntax(join(dir, 'extension.js'))).toMatchObject({ ok: true })
    await rm(dir, { recursive: true, force: true })
  })

  it('polls a running turn quickly and keeps itself connected', () => {
    expect(EXTENSION_SOURCE).toContain('setTimeout(resolve, 400)')
    expect(EXTENSION_SOURCE).toContain('fs.watchFile(BRIDGE_FILE')
  })

  it('compares extension versions numerically for auto-upgrade', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0)
    expect(['0.10.0', '0.2.0', '0.9.1'].sort(compareVersions).pop()).toBe('0.10.0')
  })

  it('registers every command it contributes, including the mode commands', () => {
    const commands = EXTENSION_MANIFEST.contributes.commands.map(entry => entry.command)
    expect(commands).toEqual(expect.arrayContaining(['kairoforge.askInMode', 'kairoforge.chooseMode']))
    for (const command of commands) expect(EXTENSION_SOURCE).toContain(`registerCommand('${command}'`)
    expect(EXTENSION_MANIFEST.contributes.configuration.properties['kairoforge.mode'].default).toBe('standard')
  })
})

describe('simulated input refusal', () => {
  it('refuses pyautogui-style scripts and points at the applescript tool', () => {
    for (const command of ['pip install pyautogui', 'python3 -c "import pyautogui; pyautogui.click(10, 10)"', 'cliclick c:100,200', 'pip3 install pynput']) {
      expect(simulatedInputReason('bash', { command }), command).toMatch(/applescript tool/)
    }
    expect(simulatedInputReason('write', { file_path: 'a.py', content: 'import os\nimport pyautogui\n' })).toMatch(/applescript tool/)
    expect(simulatedInputReason('edit', { file_path: 'a.py', old_string: 'x', new_string: 'from pynput import mouse' })).toMatch(/applescript tool/)
  })

  it('lets ordinary commands, edits, and AppleScript through', () => {
    expect(simulatedInputReason('bash', { command: 'pnpm test' })).toBeUndefined()
    expect(simulatedInputReason('bash', { command: 'osascript -e \'tell application "Music" to play\'' })).toBeUndefined()
    expect(simulatedInputReason('write', { file_path: 'notes.md', content: 'We stopped using pyautogui.' })).toBeUndefined()
    expect(simulatedInputReason('applescript', { script: 'tell application "Finder" to activate' })).toBeUndefined()
  })
})

const SAMPLE_ARGS: MacActionArgs = {
  app: 'Notes', text: 'He said "hi"\\there\nline two', title: 'Plan', to: 'friend@example.com', subject: 'Meeting', body: 'What time "tomorrow"?',
  url: 'https://example.com/?a=1&b=2', query: 'chinese food near me', path: '/Users/me/Desktop', menu: 'File', item: 'New Window',
  command: 'playpause', level: 40,
}

describe('mac actions', () => {
  it('escapes any text into a safe AppleScript string', () => {
    expect(asText('say "hi"')).toBe('"say \\"hi\\""')
    expect(asText('a\\b')).toBe('"a\\\\b"')
    expect(asText('one\ntwo')).toBe('"one" & linefeed & "two"')
  })

  it('builds the exact script for common requests', () => {
    expect(macActionScript('new_note', { body: 'hi there' })).toContain('make new note with properties {name:"hi there", body:"hi there"}')
    expect(macActionScript('maps_search', { query: 'chinese food' })).toBe('open location "https://www.google.com/maps/search/chinese%20food"')
    expect(macActionScript('gmail_compose', { to: 'a@b.co', subject: 'Hi', body: 'What time?' }))
      .toBe('open location "https://mail.google.com/mail/?view=cm&fs=1&to=a%40b.co&su=Hi&body=What%20time%3F"')
    expect(macActionScript('open_url', { url: 'https://x.co', browser: 'Google Chrome' })).toContain('quoted form of "Google Chrome"')
    expect(macActionScript('volume', { level: 140 })).toBe('set volume output volume 100')
  })

  it('makes a new note for typing into Notes instead of typing into whichever note is selected', () => {
    expect(macActionScript('type_text', { app: 'Notes', text: '67' })).toContain('make new note with properties {name:"67", body:"67"}')
    expect(macActionScript('type_text', { app: 'Apple Notes', text: '67' })).not.toContain('keystroke')
    expect(macActionScript('type_text', { app: 'TextEdit', text: '67' })).toContain('keystroke "67"')
  })

  it('lists browser tabs with each browser\'s own terms', async () => {
    expect(macActionScript('browser_tabs', {})).toBe('tell application "Google Chrome" to get {title, URL} of every tab of front window')
    const safari = macActionScript('browser_tabs', { browser: 'Safari' })
    expect(safari).toBe('tell application "Safari" to get {name, URL} of every tab of front window')
    if (process.platform !== 'darwin') return
    const { execFile } = await import('node:child_process')
    const dir = await mkdtemp(join(tmpdir(), 'kf-mac-'))
    const error = await new Promise<string | undefined>((done) => {
      execFile('/usr/bin/osacompile', ['-o', join(dir, 'x.scpt'), '-e', safari], (failure, _out, stderr) => { done(failure === null ? undefined : stderr) })
    })
    await rm(dir, { recursive: true, force: true })
    expect(error).toBeUndefined()
  }, 30_000)

  it('names what is missing and rejects unknown actions', () => {
    expect(() => macActionScript('mail_send', { to: 'a@b.co' })).toThrow('mail_send needs subject, body.')
    expect(() => macActionScript('teleport', {})).toThrow(/Unknown action "teleport"/)
    expect(() => macActionScript('music', { command: 'louder' })).toThrow(/music command must be/)
  })

  it.runIf(process.platform === 'darwin')('compiles every action against the real apps', async () => {
    const { execFile } = await import('node:child_process')
    const dir = await mkdtemp(join(tmpdir(), 'kf-mac-'))
    for (const action of MAC_ACTION_NAMES) {
      const script = macActionScript(action, action === 'music' ? { command: 'next' } : SAMPLE_ARGS)
      const error = await new Promise<string | undefined>((done) => {
        execFile('/usr/bin/osacompile', ['-o', join(dir, 'x.scpt'), '-e', script], (failure, _out, stderr) => { done(failure === null ? undefined : stderr) })
      })
      expect(error, `${action}: ${script}`).toBeUndefined()
    }
    await rm(dir, { recursive: true, force: true })
  }, 60_000)
})

describe('applescript dictionary summary', () => {
  it('lists commands with parameters and classes with properties, keeping class-extensions separate', () => {
    const xml = [
      '<dictionary><suite name="S">',
      '<command name="play" description="Start playing"><parameter name="once" code="x"/></command>',
      '<class-extension extends="window" description="A window."><property name="current tab" type="tab"/></class-extension>',
      '<class name="tab" description="A tab."><property name="URL" type="text"/><property name="URL" type="text"/><element type="item"/></class>',
      '</suite></dictionary>',
    ].join('')
    expect(summariseSdef(xml)).toEqual([
      'command play — Start playing (parameters: once)',
      'class window — A window.\n    properties: current tab',
      'class tab — A tab.\n    properties: URL\n    elements: item',
    ])
    expect(summariseSdef(xml, 'tab')).toHaveLength(2)
  })
})

describe.runIf(process.platform === 'darwin')('applescript knowledge on this Mac', () => {
  it('reads a real app dictionary without Xcode', async () => {
    const text = await appleScriptDictionary('Finder', 'trash')
    expect(text).toContain('command empty')
    await expect(appleScriptDictionary('No Such App Xyz')).rejects.toThrow(/Could not find/)
  }, 30_000)

  it('ships only cookbook scripts that compile', async () => {
    const { execFile } = await import('node:child_process')
    const scripts = APPLESCRIPT_COOKBOOK.flatMap(line => line.replace(/^[^:"]+:\s*/, '').split(' | ')).map(part => part.trim()).filter(part => !part.startsWith('...'))
    expect(scripts.length).toBeGreaterThan(15)
    const dir = await mkdtemp(join(tmpdir(), 'kf-osa-'))
    for (const script of scripts) {
      const error = await new Promise<string | undefined>((done) => {
        execFile('/usr/bin/osacompile', ['-o', join(dir, 'x.scpt'), '-e', script], (failure, _out, stderr) => { done(failure === null ? undefined : stderr) })
      })
      expect(error, script).toBeUndefined()
    }
    await rm(dir, { recursive: true, force: true })
  }, 60_000)
})

describe.runIf(process.platform === 'darwin')('applescript tool', () => {
  it('returns the script result and reports script errors as failures', async () => {
    expect(await runOsascript('return 2 + 3', 'AppleScript', AbortSignal.timeout(20_000))).toBe('5')
    expect(await runOsascript('[1, 2].length * 7', 'JavaScript', AbortSignal.timeout(20_000))).toBe('14')
    await expect(runOsascript('this is not applescript (', 'AppleScript', AbortSignal.timeout(20_000))).rejects.toThrow(/AppleScript failed/)
  })
})

describe('github tool helpers', () => {
  const prot = ['main', 'master']

  it('finds the repository behind https and ssh remotes', () => {
    expect(parseRemote('https://github.com/me/KalroForge.git\n')).toEqual({ owner: 'me', repo: 'KalroForge' })
    expect(parseRemote('git@github.com:me/site.git')).toEqual({ owner: 'me', repo: 'site' })
    expect(parseRemote('https://gitlab.com/me/x.git')).toBeUndefined()
    expect(parseSlug('me/x')).toEqual({ owner: 'me', repo: 'x' })
    expect(parseSlug('not a repo')).toBeUndefined()
  })

  it('fills {owner}/{repo} and stays on api.github.com', () => {
    expect(githubUrl('/repos/{owner}/{repo}/pulls?state=open', { owner: 'me', repo: 'x' }).href).toBe('https://api.github.com/repos/me/x/pulls?state=open')
    expect(githubUrl('repos/a/b', undefined).pathname).toBe('/repos/a/b')
    expect(() => githubUrl('/repos/{owner}/{repo}', undefined)).toThrow(/no github.com remote/)
    expect(() => githubUrl('https://evil.example/x', undefined)).toThrow(/only api.github.com/)
    expect(() => githubUrl('//evil.example/x', undefined)).toThrow()
    expect(() => githubUrl('/repos/a/b/../../user', undefined)).toThrow()
  })

  it('lets everyday repo work through and gates account-level or protected-branch changes', () => {
    expect(githubGate('GET', '/repos/me/x', undefined, prot)).toBeUndefined()
    expect(githubGate('POST', '/repos/me/x/pulls', { title: 't' }, prot)).toBeUndefined()
    expect(githubGate('PUT', '/repos/me/x/pulls/3/merge', {}, prot)).toBeUndefined()
    expect(githubGate('POST', '/repos/me/x/releases', { tag_name: 'v1' }, prot)).toBeUndefined()
    expect(githubGate('PATCH', '/repos/me/x/git/refs/heads/master', { sha: 'abc' }, prot)).toBeUndefined()
    expect(githubGate('PATCH', '/repos/me/x', { description: 'new' }, prot)).toBeUndefined()
    expect(githubGate('POST', '/user/repos', { name: 'new' }, prot)).toBeUndefined()
    expect(githubGate('PATCH', '/repos/me/x/git/refs/heads/main', { sha: 'abc', force: true }, prot)?.kind).toBe('deny')
    expect(githubGate('DELETE', '/repos/me/x/git/refs/heads/master', undefined, prot)?.kind).toBe('deny')
    expect(githubGate('DELETE', '/repos/me/x/git/refs/heads/feature', undefined, prot)).toBeUndefined()
    expect(githubGate('DELETE', '/repos/me/x', undefined, prot)?.kind).toBe('ask')
    expect(githubGate('PATCH', '/repos/me/x', { private: false }, prot)?.kind).toBe('ask')
    expect(githubGate('PUT', '/repos/me/x/collaborators/bob', {}, prot)?.kind).toBe('ask')
    expect(githubGate('PUT', '/repos/me/x/actions/secrets/TOKEN', {}, prot)?.kind).toBe('ask')
    expect(githubGate('PUT', '/repos/me/x/branches/main/protection', {}, prot)?.kind).toBe('ask')
    expect(githubGate('POST', '/repos/me/x/transfer', {}, prot)?.kind).toBe('ask')
  })

  it('slims responses and never echoes the token', () => {
    expect(slimGithub({ id: 1, url: 'u', html_url: 'h', comments_url: 'c', node_id: 'n', user: { login: 'me', avatar_url: 'a' } }))
      .toEqual({ id: 1, html_url: 'h', user: { login: 'me' } })
    const token = 'gho_abcdefghijklmnopqrstuvwxyz0123456789'
    const out = renderGithubResponse(201, JSON.stringify({ note: `token ${token}` }), token)
    expect(out.startsWith('HTTP 201')).toBe(true)
    expect(out).not.toContain(token)
  })
})

describe('direct push modes', () => {
  it('treats plain pushes as ordinary work and keeps destructive pushes sensitive', () => {
    expect(withoutPlainPushes('git push origin HEAD && git push origin HEAD:master')).toBe('git status && git status')
    expect(withoutPlainPushes('git push --force origin main')).toBe('git push --force origin main')
    expect(withoutPlainPushes('git push origin :old')).toBe('git push origin :old')
    expect(withoutPlainPushes('git push origin +main')).toBe('git push origin +main')
    const push = { command: 'git push origin HEAD:master' }
    expect(classifyRisk('bash', push).risk).toBe('SENSITIVE')
    expect(classifyRisk('bash', push, { directPush: true }).risk).not.toBe('SENSITIVE')
    expect(classifyRisk('bash', { command: 'git push -f origin main' }, { directPush: true }).risk).toBe('SENSITIVE')
    expect(classifyRisk('bash', { command: 'git push && rm -rf build' }, { directPush: true }).risk).toBe('SENSITIVE')
    expect(classifyRisk('github', { method: 'GET', path: '/repos/{owner}/{repo}' }).risk).toBe('LOW_RISK')
  })
})
