import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { maskSecret, scanForSecrets, type SecretPattern } from '../src/secrets.ts'

// Unreadable files, unreadable directories, and non-regular entries are
// injected rather than produced with chmod/mkfifo: the product's rule is "skip
// it and keep scanning" on every platform, while chmod 0 is not an unreadable
// file on Windows and no temp directory portably holds a socket.
const fsControl = vi.hoisted(() => ({
  /** Absolute path whose `readFile` rejects. */
  denyReadFile: undefined as string | undefined,
  /** Absolute path whose `readdir` rejects. */
  denyReaddir: undefined as string | undefined,
  /** Directory whose listing is replaced by `entries`, for entry kinds a temp dir cannot hold. */
  fabricatedDirectory: undefined as { path: string; entries: unknown[] } | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn((async (path: unknown, ...rest: never[]) => {
      if (fsControl.denyReadFile !== undefined && String(path) === fsControl.denyReadFile) {
        throw Object.assign(new Error('EACCES: injected unreadable file'), { code: 'EACCES' })
      }
      return (actual.readFile as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.readFile),
    readdir: vi.fn((async (path: unknown, ...rest: never[]) => {
      if (fsControl.denyReaddir !== undefined && String(path) === fsControl.denyReaddir) {
        throw Object.assign(new Error('EACCES: injected unreadable directory'), { code: 'EACCES' })
      }
      const fabricated = fsControl.fabricatedDirectory
      if (fabricated !== undefined && String(path) === fabricated.path) return fabricated.entries
      return (actual.readdir as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.readdir),
  }
})

/**
 * A `Dirent` stand-in reporting `name` as either a regular file or a socket.
 * The walker reads only `name` and the kind predicates; the cast covers the
 * members (`path`, device predicates) it never touches.
 */
function fakeDirent(name: string, isFile: boolean): Dirent {
  return {
    name,
    parentPath: '',
    isFile: () => isFile,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  } as unknown as Dirent
}

const roots: string[] = []

/** Create a real temp tree from `relative path -> contents` and remember it for cleanup. */
async function tree(files: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secret-scan-'))
  roots.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, contents)
  }
  return root
}

afterEach(async () => {
  fsControl.denyReadFile = undefined
  fsControl.denyReaddir = undefined
  fsControl.fabricatedDirectory = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('built-in pattern classes', () => {
  const samples: ReadonlyArray<{ name: string; kind: string; line: string }> = [
    { name: 'a PEM private key header', kind: 'private-key', line: '-----BEGIN RSA' + ' PRIVATE KEY-----' },
    { name: 'an AWS access key id', kind: 'aws-access-key-id', line: 'AKIA' + 'IOSFODNN7EXAMPLE' },
    {
      name: 'an AWS secret access key',
      kind: 'aws-secret-access-key',
      line: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
    { name: 'a GitHub classic token', kind: 'github-token', line: 'ghp_' + '16C7e42F292c6912E7710c838347Ae178B4a' },
    {
      name: 'a GitHub fine-grained token',
      kind: 'github-token',
      line: 'github_pat_' + '11ABCDEFG0abcdefghijkl_klmnopqrstuvwxyz0123456789ABCDEFGH',
    },
    { name: 'a Slack token', kind: 'slack-token', line: 'xoxb' + '-123456789012-abcdefghijklmnopqrstuv' },
    { name: 'a Stripe live key', kind: 'stripe-live-key', line: 'sk_live_' + '51H8xYzABCdefGHIjklMNOpqr' },
    {
      name: 'an OpenAI key',
      kind: 'openai-key',
      line: 'OPENAI_API_KEY=sk-proj-' + 'abcdefghijklmnopqrstuvwxyz0123456789',
    },
    {
      name: 'an Anthropic key',
      kind: 'anthropic-key',
      line: 'ANTHROPIC_API_KEY=sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123456789',
    },
    { name: 'a Google API key', kind: 'google-api-key', line: 'AIza' + 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY' },
    {
      name: 'a JWT',
      kind: 'jwt',
      line: 'eyJhbGciOiJIUzI1NiIs' + 'InR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    },
    { name: 'a Postgres URL with a password', kind: 'database-url', line: 'postgres:' + '//user:s3cr3tp4ss@db.example.com:5432/app' },
    { name: 'a MySQL URL with a password', kind: 'database-url', line: 'mysql:' + '//root:hunter2hunter2@localhost/appdb' },
    {
      name: 'a MongoDB SRV URL with a password',
      kind: 'database-url',
      line: 'mongodb+' + 'srv://admin:sup3rs3cret@cluster0.example.mongodb.net/app',
    },
    { name: 'a quoted api_key assignment', kind: 'generic-secret', line: 'api_key = "supersecretvalue123"' },
    { name: 'a bare password assignment', kind: 'generic-secret', line: 'password: hunter2hunter2' },
    { name: 'a token assignment', kind: 'generic-secret', line: 'token = "abcdef1234567890"' },
    { name: 'a private_key assignment', kind: 'generic-secret', line: 'private_key = "abcdefghijklmnop"' },
    { name: 'a secret_key assignment', kind: 'generic-secret', line: 'secret_key=abcd1234efgh5678' },
  ]

  for (const sample of samples) {
    it(`reports ${sample.name}`, async () => {
      const root = await tree({ 'app/config.txt': `${sample.line}\n` })
      const result = await scanForSecrets(root)
      expect(result.clean).toBe(false)
      expect(result.findings.map(finding => finding.kind)).toContain(sample.kind)
      // The report must never be a second copy of the secret it reports.
      for (const finding of result.findings) expect(finding.masked).not.toContain(sample.line)
    })
  }

  it('reports one finding per key when a named and the generic pattern overlap', async () => {
    const root = await tree({ 'src/config.ts': 'OPENAI_API_KEY=sk-proj-' + 'abcdefghijklmnopqrstuvwxyz0123456789\n' })
    const result = await scanForSecrets(root)
    expect(result.findings.map(finding => finding.kind)).toEqual(['openai-key'])
  })

  it('scans build output, because build output is what gets published', async () => {
    const root = await tree({ 'dist/bundle.js': 'const k = "sk_live_' + '51H8xYzABCdefGHIjklMNOpqr"\n' })
    const result = await scanForSecrets(root)
    expect(result.findings.map(finding => finding.kind)).toEqual(['stripe-live-key'])
    expect(result.findings.map(finding => finding.file)).toEqual(['dist/bundle.js'])
  })
})

describe('environment files', () => {
  it('reports env files themselves and ignores committed templates', async () => {
    const root = await tree({
      '.env': 'PORT=3000\n',
      '.env.production': 'PORT=3000\n',
      'dist/.env': 'PORT=3000\n',
      'config/app.env': 'PORT=3000\n',
      '.env.example': 'PORT=3000\n',
      'config/app.env.sample': 'PORT=3000\n',
      'config/app.env.template': 'PORT=3000\n',
      'docs/environment.txt': 'PORT=3000\n',
    })
    const result = await scanForSecrets(root)
    const envFindings = result.findings.filter(finding => finding.kind === 'env-file')
    // A `.env` that would ship is a finding even when its contents look
    // unremarkable, so these three files are the entire report.
    expect(envFindings.map(finding => finding.file)).toEqual(['.env', '.env.production', 'config/app.env', 'dist/.env'])
    expect(envFindings.map(finding => finding.masked)).toEqual(['.env', '.env.production', 'app.env', '.env'])
    for (const finding of envFindings) expect(finding.line).toBe(1)
    expect(result.findings).toEqual(envFindings)
  })
})

describe('masking', () => {
  it('keeps at most the first four and the last two characters', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd…op')
    expect(maskSecret('abcdef')).toBe('abcd…f')
    expect(maskSecret('abcde')).toBe('abcd…')
  })

  it('masks values shorter than five characters entirely', () => {
    expect(maskSecret('')).toBe('•••')
    expect(maskSecret('abcd')).toBe('•••')
  })

  it('never returns a value that contains the whole secret', () => {
    for (let length = 1; length <= 40; length += 1) {
      const value = 'sekritValue'.repeat(4).slice(0, length)
      const masked = maskSecret(value)
      expect(masked.length).toBeLessThan(16)
      expect(masked).not.toContain(value)
      if (length < 5) expect(masked).toBe('•••')
      else expect(masked).toContain('…')
    }
  })

  it('masks every finding through maskSecret', async () => {
    const secret = 'supersecretvalue123'
    const root = await tree({ 'src/config.ts': `API_KEY=${secret}\n` })
    const result = await scanForSecrets(root)
    const finding = result.findings.at(0)
    expect(finding?.kind).toBe('generic-secret')
    expect(finding?.masked).toBe(maskSecret(`API_KEY=${secret}`))
    expect(finding?.masked).not.toContain(secret)
  })
})

describe('clean trees and determinism', () => {
  it('reports a clean tree as clean with no findings', async () => {
    const root = await tree({
      'src/index.js': 'export const greet = name => `hello ${name}`\n',
      'README.md': '# project\n\nSet the port with the PORT environment variable.\n',
      'dist/assets/app.css': 'body { margin: 0 }\n',
    })
    const result = await scanForSecrets(root)
    expect(result.findings).toEqual([])
    expect(result.clean).toBe(true)
    expect(result.root).toBe(root)
    expect(result.scannedFiles).toBe(3)
  })

  it('is deterministic and ordered by file, then line', async () => {
    const root = await tree({
      // Created out of order on purpose: the report must not follow readdir order.
      'z/last.txt': 'token = "abcdef1234567890"\n',
      'a/first.txt': 'AKIA' + 'IOSFODNN7EXAMPLE\nclean line\nsk_live_' + '51H8xYzABCdefGHIjklMNOpqr\n',
      'm/middle.txt': 'password: hunter2hunter2\n',
    })
    const first = await scanForSecrets(root)
    const second = await scanForSecrets(root)
    expect(second).toEqual(first)
    expect(first.findings.map(finding => [finding.file, finding.line])).toEqual([
      ['a/first.txt', 1],
      ['a/first.txt', 3],
      ['m/middle.txt', 1],
      ['z/last.txt', 1],
    ])
    expect(first.scannedFiles).toBe(3)
  })

  it('is unaffected by caller-supplied stateful patterns', async () => {
    const stateful: SecretPattern = { id: 'marker', label: 'Marker', regex: /MARKER-[0-9]{4}/g }
    const zeroWidth: SecretPattern = { id: 'marker-word', label: 'Marker word', regex: /(?=MARKER)/ }
    const root = await tree({ 'src/markers.txt': 'MARKER-1234 and MARKER-5678\n' })
    const options = { extraPatterns: [stateful, zeroWidth] }
    const first = await scanForSecrets(root, options)
    const second = await scanForSecrets(root, options)
    expect(second).toEqual(first)
    // The zero-width pattern contributes no empty finding.
    expect(first.findings.map(finding => finding.kind)).toEqual(['marker', 'marker'])
    expect(first.findings.map(finding => finding.masked)).toEqual(['MARK…34', 'MARK…78'])
  })
})

describe('skipping what must not be read', () => {
  it('skips binary files', async () => {
    const binary = Buffer.concat([
      Buffer.from('binary\u0000', 'utf8'),
      Buffer.from('API_KEY=supersecretvalue123\n', 'utf8'),
    ])
    const root = await tree({ 'assets/logo.bin': binary, 'src/index.js': 'export {}\n' })
    const result = await scanForSecrets(root)
    expect(result.findings).toEqual([])
    expect(result.scannedFiles).toBe(1)
  })

  it('skips only files larger than the configured ceiling', async () => {
    const line = 'API_KEY=supersecretvalue123\n'
    const root = await tree({
      'at-limit.txt': line,
      'over-limit.txt': `${line}x`,
      'ignored.txt': 'plain text\n',
    })
    const result = await scanForSecrets(root, { maxFileBytes: line.length })
    expect(result.findings.map(finding => finding.file)).toEqual(['at-limit.txt'])
    expect(result.scannedFiles).toBe(2)
  })

  it('skips files larger than the 1 MiB default', async () => {
    const root = await tree({ 'huge.txt': `API_KEY=supersecretvalue123\n${'x'.repeat(1024 * 1024)}` })
    const result = await scanForSecrets(root)
    expect(result.findings).toEqual([])
    expect(result.scannedFiles).toBe(0)
  })

  it('never follows a symlink out of the tree', async () => {
    const outside = await tree({ 'loot.txt': 'AKIA' + 'IOSFODNN7EXAMPLE\n' })
    const root = await tree({ 'src/index.js': 'export {}\n' })
    try {
      await symlink(join(outside, 'loot.txt'), join(root, 'linked.txt'))
      await symlink(outside, join(root, 'linked-dir'))
    } catch {
      // Windows may deny symlink creation without Developer Mode; the rule is
      // "never follow one", so the assertions below hold either way.
    }
    const result = await scanForSecrets(root)
    expect(result.findings).toEqual([])
    expect(result.scannedFiles).toBe(1)
  })

  it('ignores directory entries that are not regular files', async () => {
    const root = await tree({ 'runtime/marker.txt': 'plain text\n' })
    fsControl.fabricatedDirectory = {
      path: join(root, 'runtime'),
      entries: [fakeDirent('plugin.sock', false), fakeDirent('marker.txt', true)],
    }
    const result = await scanForSecrets(root)
    expect(result.findings).toEqual([])
    expect(result.scannedFiles).toBe(1)
  })

  it('skips unreadable files and keeps scanning', async () => {
    const root = await tree({ 'src/index.js': 'export {}\n', 'src/keys.txt': 'AKIA' + 'IOSFODNN7EXAMPLE\n' })
    fsControl.denyReadFile = join(root, 'src', 'index.js')
    const result = await scanForSecrets(root)
    expect(result.scannedFiles).toBe(1)
    expect(result.findings.map(finding => finding.file)).toEqual(['src/keys.txt'])
  })

  it('skips unreadable subdirectories and still reports the rest', async () => {
    const root = await tree({ 'src/index.js': 'export {}\n', 'vendor/keys.txt': 'AKIA' + 'IOSFODNN7EXAMPLE\n' })
    fsControl.denyReaddir = join(root, 'vendor')
    const result = await scanForSecrets(root)
    expect(result.findings).toEqual([])
    expect(result.scannedFiles).toBe(1)
  })

  it('refuses to call an unlistable root clean', async () => {
    const root = await tree({ 'src/index.js': 'export {}\n' })
    fsControl.denyReaddir = root
    await expect(scanForSecrets(root)).rejects.toThrow(/secret scan root cannot be listed/)
  })
})

describe('options', () => {
  it('merges extra patterns and replaces the skipped directory names', async () => {
    const root = await tree({
      'src/index.js': 'const internal = "INT-ABCDEFGH"\n',
      'node_modules/pkg/index.js': 'AKIA' + 'IOSFODNN7EXAMPLE\n',
      'vendor/pkg/index.js': 'AKIA' + 'IOSFODNN7EXAMPLE\n',
    })
    const result = await scanForSecrets(root, {
      extraPatterns: [{ id: 'internal-token', label: 'Internal token', regex: /INT-[A-Z0-9]{8}/ }],
      skipDirectories: ['vendor'],
    })
    expect(result.findings.map(finding => finding.file)).toEqual(['node_modules/pkg/index.js', 'src/index.js'])
    expect(result.findings.map(finding => finding.kind)).toEqual(['aws-access-key-id', 'internal-token'])
  })

  it('skips .git and node_modules by default', async () => {
    const root = await tree({
      '.git/config': 'AKIA' + 'IOSFODNN7EXAMPLE\n',
      'node_modules/pkg/index.js': 'AKIA' + 'IOSFODNN7EXAMPLE\n',
      'src/index.js': 'AKIA' + 'IOSFODNN7EXAMPLE\n',
    })
    const result = await scanForSecrets(root)
    expect(result.findings.map(finding => finding.file)).toEqual(['src/index.js'])
    expect(result.scannedFiles).toBe(1)
  })
})
