/**
 * The Vault: encryption at rest for everything the Life OS layer keeps (the
 * brain index, knowledge graph, routines, activity, and notification logs).
 * A random 256-bit data key seals each file with AES-256-GCM. On a Mac with a
 * Secure Enclave the data key is stored only wrapped by an Enclave key that
 * never leaves the chip, so a copied disk cannot be read elsewhere. Without an
 * Enclave the key falls back to an owner-only file and the status says so.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KAIROFORGE_HOME, type NativeHelper } from './native.ts'

const MAGIC = Buffer.from('KFV1')
const IV_BYTES = 12
const TAG_BYTES = 16

/** How the data key is protected. */
export type VaultMode = 'secure-enclave' | 'file'

/** What the Command Center shows about the Vault. */
export interface VaultStatus {
  readonly mode: VaultMode | 'locked'
  readonly detail: string
  readonly sealedFiles: number
}

/**
 * Seal bytes with a key.
 * @param key - 32-byte key.
 * @param plain - plaintext.
 * @returns magic, IV, tag, and ciphertext.
 */
export function sealBytes(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
}

/**
 * Open bytes sealed by {@link sealBytes}.
 * @param key - 32-byte key.
 * @param sealed - sealed bytes.
 * @returns plaintext; throws when tampered with or sealed by another key.
 */
export function openBytes(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < MAGIC.length + IV_BYTES + TAG_BYTES || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a KairoForge vault file')
  }
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
  const tag = sealed.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()])
}

function writeAtomic(path: string, data: Buffer | string): void {
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, data, { mode: 0o600 })
  renameSync(temp, path)
}

/** Encrypted file store under `~/.kairoforge`. */
export class Vault {
  private key: Promise<{ readonly key: Buffer; readonly mode: VaultMode }> | undefined
  private failure: string | undefined
  private readonly keyDir: string
  readonly dataDir: string

  /**
   * @param native - the native helper (Secure Enclave access).
   * @param home - base directory; defaults to `~/.kairoforge`.
   */
  constructor(private readonly native: NativeHelper, home = KAIROFORGE_HOME) {
    this.keyDir = join(home, 'vault')
    this.dataDir = join(home, 'brain')
  }

  private unlock(): Promise<{ readonly key: Buffer; readonly mode: VaultMode }> {
    this.key ??= this.loadKey().then((loaded) => {
      this.failure = undefined
      return loaded
    }, (error: unknown) => {
      this.key = undefined
      this.failure = error instanceof Error ? error.message : String(error)
      throw error
    })
    return this.key
  }

  private async loadKey(): Promise<{ readonly key: Buffer; readonly mode: VaultMode }> {
    mkdirSync(this.keyDir, { recursive: true, mode: 0o700 })
    const deviceKey = join(this.keyDir, 'device.key')
    const wrapped = join(this.keyDir, 'data.key.wrapped')
    const plainKey = join(this.keyDir, 'data.key')
    if (existsSync(wrapped)) {
      const { secret } = await this.native.call<{ secret: string }>(['se-unwrap', deviceKey], readFileSync(wrapped, 'utf8'))
      return { key: Buffer.from(secret, 'base64'), mode: 'secure-enclave' }
    }
    if (existsSync(plainKey)) return { key: Buffer.from(readFileSync(plainKey, 'utf8'), 'base64'), mode: 'file' }
    const key = randomBytes(32)
    const enclave = this.native.supported()
      && await this.native.call<{ available: boolean }>(['se-available']).then(result => result.available, () => false)
    if (enclave) {
      await this.native.call(['se-create', deviceKey])
      const { wrapped: blob } = await this.native.call<{ wrapped: string }>(['se-wrap', deviceKey], key.toString('base64'))
      writeAtomic(wrapped, blob)
      return { key, mode: 'secure-enclave' }
    }
    writeAtomic(plainKey, key.toString('base64'))
    return { key, mode: 'file' }
  }

  /**
   * Encrypt and store one named record.
   * @param name - file name (no directories).
   * @param value - JSON-serializable value.
   */
  async put(name: string, value: unknown): Promise<void> {
    const { key } = await this.unlock()
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    writeAtomic(this.path(name), sealBytes(key, Buffer.from(JSON.stringify(value))))
  }

  /**
   * Read and decrypt one named record.
   * @param name - file name.
   * @returns the value, or undefined when absent.
   */
  async get<T>(name: string): Promise<T | undefined> {
    const path = this.path(name)
    if (!existsSync(path)) return undefined
    const { key } = await this.unlock()
    return JSON.parse(openBytes(key, readFileSync(path)).toString('utf8')) as T
  }

  private path(name: string): string {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid vault record name "${name}"`)
    return join(this.dataDir, `${name}.sealed`)
  }

  /**
   * How the Vault protects data right now.
   * @returns mode and sealed file count.
   */
  async status(): Promise<VaultStatus> {
    const sealedFiles = existsSync(this.dataDir) ? readdirSync(this.dataDir).filter(file => file.endsWith('.sealed')).length : 0
    try {
      const { mode } = await this.unlock()
      return {
        mode,
        detail: mode === 'secure-enclave'
          ? 'AES-256-GCM; the data key is wrapped by a Secure Enclave key that never leaves this Mac.'
          : 'AES-256-GCM; no Secure Enclave, so the data key is an owner-only file on this disk.',
        sealedFiles,
      }
    } catch {
      return { mode: 'locked', detail: `Vault unavailable: ${this.failure ?? 'unknown error'}`, sealedFiles }
    }
  }
}
