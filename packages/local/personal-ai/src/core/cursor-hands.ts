/**
 * Cursor as KairoForge's hands: requests to do something on the Mac are handed
 * to the Cursor agent CLI, which acts through AppleScript and the Cua Driver's
 * visible agent cursor. This module holds the pure parts: the instructions and
 * permissions of Cursor's workspace, and the reading of its stream-json output.
 */

/** The one tool KairoForge uses for the computer while Cursor is its hands. */
export const CURSOR_COMPUTER = 'cursor_computer'

/** What Cursor reads (AGENTS.md) in the workspace it acts from. */
export const HANDS_INSTRUCTIONS = [
  '# KairoForge hands: execution protocol',
  '',
  'You are the hands of KairoForge, the user\'s personal AI, on this Mac. Every prompt is something the user wants done on their',
  'computer. Do it now, end to end, without asking questions.',
  '',
  '1. Zero fluff, instant action. Do not narrate, plan out loud, or say "Sure", "I will", or "Let me". Your first output is the tool',
  '   call. Your only message is the final one: one short sentence saying what happened (and what failed, if anything).',
  '2. Native apps = AppleScript only. For Notes, Mail, Finder, Calendar, Reminders, Music, Messages, Contacts, System Settings, and',
  '   volume, use the native-app-control execute_applescript tool (or `osascript -e`) on the app\'s own objects, for example',
  '   `tell application "Notes" to make new note with properties {body:"hi"}`. Never click or send keystrokes to these apps.',
  '   Check an app\'s terms with applescript_dictionary instead of guessing.',
  '3. Web = URL injection, never visual search. Open the direct URL with AppleScript in the user\'s browser (Google Chrome when it is',
  '   running, otherwise Safari): `tell application "Google Chrome" to open location "https://www.youtube.com/results?search_query=lofi+beats"`.',
  '   URLs: YouTube search https://www.youtube.com/results?search_query=Q · Google https://www.google.com/search?q=Q ·',
  '   Maps https://www.google.com/maps/search/Q · Amazon https://www.amazon.com/s?k=Q · Wikipedia https://en.wikipedia.org/w/index.php?search=Q',
  '   · Reddit https://www.reddit.com/search/?q=Q · GitHub https://github.com/search?q=Q · Gmail compose',
  '   https://mail.google.com/mail/?view=cm&to=A&su=S&body=B (URL-encode Q, spaces as +). Never type into a search bar or click menus to',
  '   get somewhere a URL reaches.',
  '4. Parallel execution. When the prompt has independent tasks ("open Notes and open YouTube"), issue all their tool calls together',
  '   in the same turn; do not wait for one to finish before starting the next.',
  '5. Fail fast, no loops. If a call fails or hangs for more than about 3 seconds, note it in one sentence and switch to the fallback',
  '   (AppleScript, then a URL, then the cua-driver tools). Never run the same failing command more than once more.',
  '6. Visible clicks only as the last resort, for a button or field that no AppleScript object or URL reaches: use the cua-driver',
  '   tools, which move a visible agent cursor without taking the user\'s mouse or keyboard. Call set_agent_cursor_enabled',
  '   {enabled: true} first, take pid and window_id from list_apps and list_windows, element_token values from get_window_state,',
  '   then click, type_text, hotkey, or scroll with them.',
  '',
  'Also: reuse apps that are already running. Never use pyautogui, pynput, cliclick, or screen-coordinate scripts. Never click macOS',
  'security or permission dialogs; say which one is waiting for the user. Do not edit files in this folder or touch code projects',
  'unless asked. Report only what a tool result showed; check a change you made when a read-back is quick.',
  '',
].join('\n')

/** Cursor CLI permissions for the hands workspace: AppleScript, `open`, and the two Mac-control MCP servers. */
export const HANDS_PERMISSIONS = {
  permissions: {
    allow: ['Shell(osascript)', 'Shell(open)', 'Mcp(native-app-control:*)', 'Mcp(cua-driver:*)'],
    deny: [],
  },
} as const

/** What one Cursor run did, read from its stream-json output. */
export interface CursorRunSummary {
  readonly ok: boolean
  /** Cursor's final reply, or the reason it failed. */
  readonly reply: string
  /** The actions it took, in order (MCP tool or shell command). */
  readonly actions: string[]
  readonly durationMs?: number
}

const MAX_ACTION = 120

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Name one started tool call for the action log.
 * @param call - the `tool_call` object of a stream-json event.
 * @returns a short label, or undefined for schema lookups and unknown shapes.
 */
export function actionOf(call: unknown): string | undefined {
  const outer = record(call)
  if (outer === undefined) return undefined
  const kind = Object.keys(outer).find(key => key.endsWith('ToolCall'))
  if (kind === undefined || kind === 'getMcpToolsToolCall') return undefined
  const args = record(record(outer[kind])?.args) ?? {}
  let label: string
  if (kind === 'mcpToolCall') {
    label = `${str(args.providerIdentifier, 'mcp')}/${str(args.toolName, str(args.name, 'tool'))}`
  } else if (kind === 'shellToolCall') {
    label = `shell: ${str(args.command)}`
  } else {
    label = kind.replace(/ToolCall$/, '')
  }
  return label.replaceAll(/\s+/g, ' ').slice(0, MAX_ACTION)
}

/**
 * Read a Cursor CLI `--output-format stream-json` transcript.
 * @param lines - output lines; non-JSON lines are ignored.
 * @returns the final reply, success, and the actions taken.
 */
export function readCursorStream(lines: Iterable<string>): CursorRunSummary {
  const actions: string[] = []
  let assistant = ''
  let result: Record<string, unknown> | undefined
  for (const line of lines) {
    let event: Record<string, unknown> | undefined
    try {
      event = record(JSON.parse(line) as unknown)
    } catch {
      continue
    }
    if (event === undefined) continue
    if (event.type === 'tool_call' && event.subtype === 'started') {
      const action = actionOf(event.tool_call)
      if (action !== undefined) actions.push(action)
    } else if (event.type === 'assistant') {
      const content = record(event.message)?.content
      const text = Array.isArray(content)
        ? content.map(block => record(block)?.type === 'text' ? str(record(block)?.text) : '').join('')
        : ''
      if (text.trim() !== '') assistant = text.trim()
    } else if (event.type === 'result') {
      result = event
    }
  }
  if (result === undefined) return { ok: false, reply: assistant === '' ? 'Cursor stopped without a result.' : assistant, actions }
  // `result` joins every message of the run ("I'll check…I opened…"); the last message is the report.
  const reply = assistant !== '' ? assistant : str(result.result).trim()
  return {
    ok: result.is_error !== true && result.subtype === 'success',
    reply: reply === '' ? 'Cursor finished without saying what happened.' : reply,
    actions,
    ...typeof result.duration_ms === 'number' ? { durationMs: result.duration_ms } : {},
  }
}
