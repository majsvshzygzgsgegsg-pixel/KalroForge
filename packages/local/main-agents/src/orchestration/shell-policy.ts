/**
 * Shell-command classification for orchestration: which commands mutate the
 * workspace (automatic checkpoints), which run tests or builds (checkpoint
 * test results), and which Git operations must be denied or approved to
 * protect branches and uncommitted work. Also redacts secrets from text shown
 * in the UI.
 */

const READ_ONLY = new RegExp(`^(?:${[
  'ls', 'll', 'pwd', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'echo', 'printf', 'which', 'type', 'whoami', 'date',
  'env', 'printenv', 'file', 'stat', 'du', 'df', 'tree', 'find', 'fd', 'rg', 'grep', 'egrep', 'fgrep', 'ag', 'awk',
  'sed -n', 'jq', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'basename', 'dirname', 'realpath', 'readlink', 'node --version',
  'npm (?:ls|list|view|outdated)', 'pnpm (?:ls|list|why|outdated)',
  'git (?:status|log|diff|show|branch(?: --list| -a| -r| -v)?$|remote -v|rev-parse|ls-files|blame|describe'
  + '|tag(?: -l| --list)?$|config --get|grep|shortlog|reflog)',
].join('|')})\\b`)
const TEST = /\b(?:test|tests|vitest|jest|mocha|pytest|cargo test|go test|tsc|typecheck|lint|eslint|oxlint|build|check)\b/

/** Split a shell line into simple commands joined by control operators. */
function segments(command: string): string[] {
  return command.split(/&&|\|\||;|\n/).map(part => part.trim()).filter(part => part !== '')
}

/**
 * Whether a shell command only reads state.
 * @param command - shell text.
 * @returns true when every segment is a known read-only command.
 */
export function isReadOnlyCommand(command: string): boolean {
  const parts = segments(command)
  if (parts.length === 0) return true
  return parts.every((part) => {
    if (/(^|[^>])>{1,2}(?!&)/.test(part.replace(/2>&1|>\s*\/dev\/null/g, ''))) return false
    const first = part.split('|')[0]?.trim() ?? ''
    return READ_ONLY.test(first)
  })
}

/**
 * Whether a shell command runs tests, type checks, lint, or a build.
 * @param command - shell text.
 * @returns true for verification commands.
 */
export function isTestCommand(command: string): boolean {
  return TEST.test(command) && !/^\s*(?:cat|less|head|tail|rg|grep)\b/.test(command)
}

/** Decision for one Git command. */
export type GitDecision =
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason: string }

/**
 * Classify Git operations that could damage protected branches or uncommitted work.
 * @param command - shell text.
 * @param currentBranch - checked-out branch, when known.
 * @param protectedBranches - branch names agents must not push to directly.
 * @param options - `directPush` lets ordinary (non-force, non-delete) pushes reach protected branches without asking.
 * @returns a decision, or undefined when the command needs no extra gate.
 */
export function gitGuard(
  command: string,
  currentBranch: string | undefined,
  protectedBranches: readonly string[],
  options: { readonly directPush?: boolean } = {},
): GitDecision | undefined {
  const isProtected = (name: string | undefined): boolean => name !== undefined && protectedBranches.includes(name)
  for (const part of segments(command)) {
    const git = /^git\s+(.*)$/.exec(part)
    if (git === null) continue
    const rest = git[1] ?? ''
    const words = rest.split(/\s+/).filter(word => word !== '')
    const sub = words[0]
    if (sub === 'push') {
      const force = words.some(word => word === '-f' || word === '--force' || word.startsWith('--force-with-lease') || word.startsWith('+'))
      const positional = words.slice(1).filter(word => !word.startsWith('-'))
      const refspecs = positional.slice(1)
      const targets = refspecs.length > 0
        ? refspecs.map(spec => spec.replace(/^\+/, '').split(':').at(-1)?.replace(/^refs\/heads\//, '') ?? spec)
        : [currentBranch]
      const deletes = words.includes('--delete') || words.includes('-d') || refspecs.some(spec => spec.startsWith(':'))
      const hitsProtected = targets.some(isProtected) || words.includes('--all') || words.includes('--mirror')
      if (hitsProtected && (force || deletes)) {
        return { kind: 'deny', reason: `Force-pushing or deleting a protected branch (${protectedBranches.join(', ')}) is not allowed for agents.` }
      }
      if (hitsProtected && !(options.directPush === true && !words.includes('--mirror'))) {
        return { kind: 'ask', reason: `Push directly to protected branch ${targets.filter(isProtected).join(', ') || 'main/master'}` }
      }
      if (force) return { kind: 'ask', reason: 'Force-push a branch' }
      continue
    }
    if (sub === 'reset' && words.includes('--hard')) return { kind: 'ask', reason: 'git reset --hard discards uncommitted work' }
    if (sub === 'clean' && words.some(word => /^-[a-zA-Z]*f/.test(word))) return { kind: 'ask', reason: 'git clean deletes untracked files' }
    if ((sub === 'checkout' || sub === 'restore') && (words.includes('.') || words.includes('--') && words.at(-1) === '.')) {
      return { kind: 'ask', reason: `git ${sub} . discards uncommitted changes` }
    }
    if (sub === 'stash' && (words[1] === 'drop' || words[1] === 'clear')) return { kind: 'ask', reason: `git stash ${words[1]} deletes stashed work` }
    if (sub === 'branch' && words.some(word => word === '-D') && words.some(isProtected)) {
      return { kind: 'deny', reason: 'Deleting a protected branch is not allowed for agents.' }
    }
  }
  return undefined
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /((?:api[_-]?key|token|secret|password|passwd|authorization|bearer)["']?\s*[:=]\s*["']?)[^\s"',]{6,}/gi,
]

/**
 * Replace credential-looking substrings with a marker.
 * @param text - text that may contain secrets.
 * @returns redacted text.
 */
export function redact(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match: string, prefix?: unknown) => typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]')
  }
  return out
}
