/**
 * Git plumbing for checkpoints. A checkpoint snapshots the whole working tree
 * (tracked and untracked, respecting .gitignore) through a scratch copy of the
 * index, writes it as a commit whose parent is HEAD, and pins it under
 * `refs/kairoforge/checkpoints/<id>`. Capturing never touches the user's
 * index, HEAD, branches, stash, or files. Restoring writes only the requested
 * paths through a scratch index, so unrelated files and the user's staging
 * area stay as they are.
 */
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { CheckpointChange } from './types.ts'

/** Ref namespace that holds checkpoint commits. */
export const CHECKPOINT_REF_PREFIX = 'refs/kairoforge/checkpoints/'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'KairoForge Checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@kairoforge.local',
  GIT_COMMITTER_NAME: 'KairoForge Checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@kairoforge.local',
}

const MAX_BUFFER = 64 * 1024 * 1024

/** Run git and resolve stdout; reject with stderr on a nonzero exit. */
function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`))
        return
      }
      resolvePromise(stdout)
    })
  })
}

/**
 * Repository top-level directory for a path.
 * @param cwd - any directory.
 * @returns the top-level directory, or undefined outside a work tree.
 */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return undefined
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return undefined
  }
}

/**
 * Current HEAD commit and branch.
 * @param root - repository root.
 * @returns HEAD commit (absent on an unborn branch) and branch (absent when detached).
 */
export async function headState(root: string): Promise<{ head?: string; branch?: string }> {
  const head = await git(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']).then(out => out.trim()).catch(() => '')
  const branch = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).then(out => out.trim()).catch(() => '')
  return { ...head === '' ? {} : { head }, ...branch === '' ? {} : { branch } }
}

/** Run one operation with a scratch index file, removed afterwards. */
async function withScratchIndex<T>(root: string, seed: boolean, run: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'kairoforge-index-'))
  const scratch = join(dir, 'index')
  try {
    if (seed) {
      const raw = (await git(root, ['rev-parse', '--git-path', 'index'])).trim()
      const real = isAbsolute(raw) ? raw : resolve(root, raw)
      await copyFile(real, scratch).catch(() => undefined)
    }
    return await run({ GIT_INDEX_FILE: scratch })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Snapshot the working tree as a tree object without touching the user's index.
 * @param root - repository root.
 * @returns tree id.
 */
export async function snapshotTree(root: string): Promise<string> {
  return withScratchIndex(root, true, async (env) => {
    // --ignore-errors keeps unreadable files from failing the snapshot; a
    // nonzero exit then still leaves every readable path staged.
    await git(root, ['add', '--all', '--ignore-errors', '--', '.'], env).catch(() => undefined)
    return (await git(root, ['write-tree'], env)).trim()
  })
}

/** Raw diff entry. */
interface RawEntry {
  readonly path: string
  readonly status: string
  readonly oldMode: string
  readonly newMode: string
}

/** Parse `git diff-tree -r -z --raw --no-renames` output. */
function parseRaw(output: string): RawEntry[] {
  const parts = output.split('\0')
  const entries: RawEntry[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i] ?? ''
    const path = parts[i + 1] ?? ''
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])/.exec(meta)
    if (match === null || path === '') continue
    entries.push({ oldMode: match[1] ?? '', newMode: match[2] ?? '', status: match[3] ?? 'M', path })
  }
  return entries
}

async function diffRaw(root: string, from: string, to: string): Promise<RawEntry[]> {
  return parseRaw(await git(root, ['diff-tree', '-r', '-z', '--raw', '--no-renames', from, to]))
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Result of capturing one checkpoint. */
export interface CapturedCheckpoint {
  readonly repo: string
  readonly ref: string
  readonly commit: string
  readonly tree: string
  readonly head?: string
  readonly branch?: string
  readonly dirty: string[]
}

/**
 * Capture a checkpoint commit for the working tree that contains `cwd`.
 * @param cwd - any directory inside the repository.
 * @param id - checkpoint id used in the ref name.
 * @param message - commit message.
 * @returns the captured checkpoint, or undefined outside a Git work tree.
 */
export async function captureCheckpoint(cwd: string, id: string, message: string): Promise<CapturedCheckpoint | undefined> {
  const repo = await repoRoot(cwd)
  if (repo === undefined) return undefined
  const { head, branch } = await headState(repo)
  const tree = await snapshotTree(repo)
  const commit = (await git(repo, ['commit-tree', tree, ...head === undefined ? [] : ['-p', head], '-m', message], IDENTITY)).trim()
  const ref = `${CHECKPOINT_REF_PREFIX}${id}`
  await git(repo, ['update-ref', ref, commit])
  const dirty = (await diffRaw(repo, head ?? EMPTY_TREE, tree)).map(entry => entry.path)
  return { repo, ref, commit, tree, ...head === undefined ? {} : { head }, ...branch === undefined ? {} : { branch }, dirty }
}

/**
 * Paths that differ between a checkpoint and the current working tree.
 * @param repo - repository root.
 * @param tree - checkpoint tree.
 * @returns changes since the checkpoint (submodule entries excluded).
 */
export async function changesSince(repo: string, tree: string): Promise<CheckpointChange[]> {
  const current = await snapshotTree(repo)
  return (await diffRaw(repo, tree, current))
    .filter(entry => entry.oldMode !== '160000' && entry.newMode !== '160000')
    .map(entry => ({ path: entry.path, status: entry.status === 'A' ? 'A' : entry.status === 'D' ? 'D' : 'M' }))
}

/**
 * Unified diff from a checkpoint to the current working tree.
 * @param repo - repository root.
 * @param tree - checkpoint tree.
 * @param paths - optional path filter.
 * @param maxChars - truncation limit.
 * @returns diff text.
 */
export async function diffSince(repo: string, tree: string, paths: readonly string[] = [], maxChars = 60_000): Promise<string> {
  const current = await snapshotTree(repo)
  const text = await git(repo, ['diff-tree', '-p', '--no-renames', '--no-color', tree, current, '--', ...paths])
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[diff truncated at ${String(maxChars)} characters]` : text
}

/** Outcome of restoring paths from a checkpoint. */
export interface RestoreOutcome {
  readonly restored: string[]
  readonly deleted: string[]
}

/**
 * Restore exactly the given changed paths to their checkpoint content.
 * Paths created after the checkpoint are deleted; every other file is untouched.
 * @param repo - repository root.
 * @param tree - checkpoint tree.
 * @param changes - changes (from {@link changesSince}) to revert.
 * @returns restored and deleted paths.
 */
export async function restoreChanges(repo: string, tree: string, changes: readonly CheckpointChange[]): Promise<RestoreOutcome> {
  const toCheckout = changes.filter(change => change.status !== 'A').map(change => change.path)
  const toDelete = changes.filter(change => change.status === 'A').map(change => change.path)
  for (const path of [...toCheckout, ...toDelete]) {
    const absolute = resolve(repo, path)
    const rel = relative(repo, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the repository: ${path}`)
  }
  if (toCheckout.length > 0) {
    await withScratchIndex(repo, false, async (env) => {
      await git(repo, ['read-tree', tree], env)
      for (let i = 0; i < toCheckout.length; i += 200) {
        await git(repo, ['checkout-index', '-f', '--', ...toCheckout.slice(i, i + 200)], env)
      }
    })
  }
  const deleted: string[] = []
  for (const path of toDelete) {
    const absolute = resolve(repo, path)
    const info = await stat(absolute).catch(() => undefined)
    if (info?.isFile() === true || info?.isSymbolicLink() === true) {
      await rm(absolute, { force: true })
      deleted.push(path)
    }
  }
  return { restored: toCheckout, deleted }
}

/**
 * Remove one checkpoint ref; the commit becomes unreachable and Git collects it later.
 * @param repo - repository root.
 * @param ref - checkpoint ref.
 */
export async function deleteCheckpointRef(repo: string, ref: string): Promise<void> {
  if (!ref.startsWith(CHECKPOINT_REF_PREFIX)) throw new Error(`not a checkpoint ref: ${ref}`)
  await git(repo, ['update-ref', '-d', ref]).catch(() => undefined)
}

/**
 * Whether a checkpoint ref still exists.
 * @param repo - repository root.
 * @param ref - checkpoint ref.
 * @returns true when the ref resolves.
 */
export async function checkpointRefExists(repo: string, ref: string): Promise<boolean> {
  return git(repo, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]).then(() => true, () => false)
}
