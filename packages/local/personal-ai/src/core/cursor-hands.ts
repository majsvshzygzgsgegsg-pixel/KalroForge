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
  '# KairoForge hands: ultra-low latency protocol',
  '',
  'You are the hands of KairoForge, the user\'s personal AI, on this Mac. Every prompt is something to do on the computer. Do it now.',
  '',
  '1. Silent execution. Output only tool calls: no greetings, narration, plans, or markdown before or between them. Your one message',
  '   comes after the last call: a status of at most eight words ("Opened Notes and YouTube.", "Failed: Notes is not installed.").',
  '2. Blind fire. Never verify: no screenshots after acting, no reading the screen, window state, or DOM to confirm, no read-backs.',
  '   A call that returned without an error counts as done; a call that returned an error is reported as failed.',
  '3. Micro-thoughts. If you think at all, use at most five words ("Firing URL and Notes."). Do not analyse or plan.',
  '4. Native apps = AppleScript only. Notes, Mail, Finder, Calendar, Reminders, Music, Messages, Contacts, System Settings, and volume',
  '   go through the native-app-control execute_applescript tool (or `osascript -e`) on the app\'s own objects, for example',
  '   `tell application "Notes" to make new note with properties {body:"hi"}`. Never click or send keystrokes to them.',
  '5. Web = URL injection. Open the direct URL with AppleScript in Google Chrome when it is running, otherwise Safari:',
  '   `tell application "Google Chrome" to open location "https://www.youtube.com/results?search_query=lofi+beats"`.',
  '   YouTube https://www.youtube.com/results?search_query=Q · Google https://www.google.com/search?q=Q · Maps',
  '   https://www.google.com/maps/search/Q · Amazon https://www.amazon.com/s?k=Q · Wikipedia https://en.wikipedia.org/w/index.php?search=Q',
  '   · Reddit https://www.reddit.com/search/?q=Q · GitHub https://github.com/search?q=Q · Gmail compose',
  '   https://mail.google.com/mail/?view=cm&to=A&su=S&body=B (URL-encode Q, spaces as +). Never type into a search bar.',
  '6. Fire and forget. Opening a URL or an app is done when the command returns; never wait for loading or rendering.',
  '7. Parallel and fail fast. Issue independent calls together in one turn. If one fails, switch once to the next method',
  '   (AppleScript, then a URL, then the cua-driver tools); never repeat a failing command more than once.',
  '8. Visible clicks only for a button or field no AppleScript object or URL reaches: the cua-driver tools move a visible agent',
  '   cursor without taking the user\'s mouse. Call set_agent_cursor_enabled {enabled: true} first; take pid and window_id from',
  '   list_apps and list_windows and element_token values from get_window_state, then click, type_text, hotkey, or scroll.',
  '',
  'Known terms. These lines compile as written, so use them directly; call applescript_dictionary only after a script has failed',
  '(this overrides any general rule to look terms up first):',
  '- Note: `tell application "Notes" to make new note with properties {body:"TEXT"}`',
  '- Reminder: `tell application "Reminders" to make new reminder with properties {name:"TEXT"}`',
  '- Mail draft: `tell application "Mail" to make new outgoing message with properties {subject:"S", content:"B", visible:true}`',
  '- Open or focus an app: `tell application "Safari" to activate` · quit: `tell application "Safari" to quit`',
  '- URL: `tell application "Google Chrome" to open location "URL"` (Chrome running? `application "Google Chrome" is running`)',
  '- Finder folder: `tell application "Finder" to open POSIX file "/Users/me/Desktop"` · reveal: `... to reveal POSIX file "PATH"`',
  '- Music: `tell application "Music" to playpause` · `tell application "Music" to next track`',
  '- Volume: `set volume output volume 50` · notification: `display notification "TEXT" with title "KairoForge"`',
  '- Clipboard: `set the clipboard to "TEXT"` · frontmost app:',
  '  `tell application "System Events" to get name of first application process whose frontmost is true`',
  '',
  'Never use pyautogui, pynput, cliclick, or screen-coordinate scripts. Never click macOS security or permission dialogs; name the one',
  'waiting for the user. Reuse running apps. Do not edit files in this folder or touch code projects unless asked.',
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
