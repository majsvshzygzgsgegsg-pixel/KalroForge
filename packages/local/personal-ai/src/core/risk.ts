/**
 * Approval classes for coordinator tool calls. The KairoForge permission
 * presets stay the authority: LOW RISK and MODIFYING calls get exactly the
 * decision the preset gives; SENSITIVE calls additionally ask the user when
 * the preset would have allowed them silently. Nothing here ever turns an
 * `ask` or `deny` into an `allow`.
 */
import { isReadOnlyCommand } from '@local/main-agents'
import { categoryOf } from './capabilities.ts'
import { findSensitive } from './sensitive.ts'

/** Approval classes. */
export const RISK_CLASSES = ['LOW_RISK', 'MODIFYING', 'SENSITIVE'] as const

/** One approval class. */
export type RiskClass = typeof RISK_CLASSES[number]

/** Classification of one tool call. */
export interface RiskDecision {
  readonly risk: RiskClass
  readonly reason: string
}

const READ_TOOLS = new RegExp(String.raw`^(?:read|read_image|glob|grep|lsp|web_search|web_fetch|recall|project_status|list_[a-z_]+|get_[a-z_]+|[a-z_]+_status|compare_checkpoint|session_[a-z_]+|job_list|job_output|terminal_list|terminal_read|recommend_agent|propose_agent|list_capabilities|use_tools|wait_agent|search_brain|graph_query)$`)
const SENSITIVE_TOOLS: Readonly<Record<string, string>> = {
  create_tool: 'Write a new tool KairoForge can run later',
  archive_project: 'Archive a project',
  forget: 'Delete a memory',
  restore_checkpoint: 'Restore files from a checkpoint',
  delete_checkpoint: 'Delete a checkpoint',
  deployment_publish: 'Publish a deployment',
  deployment_rollback: 'Roll back a deployment',
  job_kill: 'Kill a running job',
}
const SENSITIVE_COMMAND = new RegExp([
  String.raw`\bgit\s+push\b`, String.raw`\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|rebase)\b`, String.raw`\brm\s+-[a-z]*r`,
  String.raw`\bsudo\b`, String.raw`\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z)?sh\b`, String.raw`\bchmod\s+-R\b`, String.raw`\bkillall\b`,
  String.raw`\b(?:npm|pnpm|yarn)\s+publish\b`, String.raw`\bgh\s+(?:pr\s+merge|release\s+create|repo\s+delete)\b`, String.raw`\bdropdb\b|\bDROP\s+(?:TABLE|DATABASE)\b`,
  String.raw`\b(?:security|defaults)\s+(?:delete|write)\b`, String.raw`\bosascript\b`, String.raw`\bshutdown\b|\breboot\b`,
  String.raw`\bdiskutil\s+(?:erase|partition|reformat|zero|secureErase)`, String.raw`\bmkfs\b`, String.raw`\bdd\b[^|;&]*\bof=`,
  String.raw`\blaunchctl\s+(?:load|unload|bootstrap|bootout|remove|disable)\b`, String.raw`\bcrontab\s+-r\b`, String.raw`\b(?:csrutil|spctl|nvram)\b`,
].join('|'), 'i')
/** Credentials and login items: any command touching them asks (an unconfined agent can read or replace them). */
const SECRET_PATH = new RegExp([
  String.raw`(?:^|[\s'"=:(])(?:~|\$HOME|/Users/[^/\s]+)?/?\.(?:ssh|aws|gnupg|kube)(?:/|\b)`,
  String.raw`\.netrc\b`, String.raw`\.docker/config\.json`, String.raw`Library/(?:Keychains|LaunchAgents|LaunchDaemons)\b`,
].join('|'))
/** Paths a file tool may not read or change silently: credentials, shell startup files, env files, system folders. */
const SENSITIVE_FILE = new RegExp([
  String.raw`(?:^|/)\.(?:zshrc|zprofile|zshenv|bashrc|bash_profile|profile)$`,
  String.raw`(?:^|/)\.env(?:\.[\w-]+)?$`, String.raw`^/(?:etc|System|Library)/`,
].join('|'))
const COMPUTER_READ = /screenshot|list|get_|read|observe|snapshot|describe|find/i

/**
 * Whether a path holds credentials, login items, shell startup files, env files, or system files.
 * @param path - absolute or relative path.
 * @returns true when it must never be indexed or read silently.
 */
export function isSecretPath(path: string): boolean {
  return SECRET_PATH.test(path) || SENSITIVE_FILE.test(path)
}

function stringField(args: unknown, ...names: string[]): string {
  if (typeof args !== 'object' || args === null) return ''
  for (const name of names) {
    const value = (args as Record<string, unknown>)[name]
    if (typeof value === 'string') return value
  }
  return ''
}

/**
 * Classify one tool call.
 * @param tool - tool name.
 * @param args - tool arguments.
 * @returns class and reason.
 */
export function classifyRisk(tool: string, args: unknown): RiskDecision {
  const fixed = SENSITIVE_TOOLS[tool]
  if (fixed !== undefined) return { risk: 'SENSITIVE', reason: fixed }
  if (tool === 'remember' && stringField(args, 'scope') === 'user') return { risk: 'SENSITIVE', reason: 'Save a long-term memory about you' }
  if (tool === 'bash' || tool === 'pwsh' || tool === 'terminal_send') {
    const command = stringField(args, 'command', 'text', 'input')
    if (SENSITIVE_COMMAND.test(command)) return { risk: 'SENSITIVE', reason: `Run a sensitive command: ${command.slice(0, 80)}` }
    if (SECRET_PATH.test(command)) return { risk: 'SENSITIVE', reason: `Touch credentials or login items: ${command.slice(0, 80)}` }
    return isReadOnlyCommand(command) ? { risk: 'LOW_RISK', reason: 'read-only command' } : { risk: 'MODIFYING', reason: 'command may change files' }
  }
  const category = categoryOf(tool)
  if (category === 'FILES') {
    const path = stringField(args, 'path', 'file_path', 'filePath')
    if (path !== '' && (SECRET_PATH.test(path) || SENSITIVE_FILE.test(path))) {
      return { risk: 'SENSITIVE', reason: `Open a credential, startup, or system file: ${path.slice(0, 80)}` }
    }
  }
  if (category === 'COMPUTER') {
    if (COMPUTER_READ.test(tool)) return { risk: 'LOW_RISK', reason: 'observes the screen' }
    const typed = stringField(args, 'text', 'value', 'keys')
    if (typed !== '' && findSensitive(typed).sensitive) return { risk: 'SENSITIVE', reason: 'Type sensitive text on the computer' }
    return { risk: 'MODIFYING', reason: 'controls the computer' }
  }
  if (READ_TOOLS.test(tool)) return { risk: 'LOW_RISK', reason: 'reads only' }
  return { risk: 'MODIFYING', reason: 'changes state' }
}
