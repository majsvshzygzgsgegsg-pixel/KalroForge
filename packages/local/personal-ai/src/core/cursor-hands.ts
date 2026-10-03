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
  '# KairoForge hands',
  '',
  'You are the hands of KairoForge, the user\'s personal AI, on this Mac. Every prompt is something the user wants done on their computer.',
  'Do it now, end to end, without asking questions, then reply in one or two plain sentences saying what you did and what you checked.',
  '',
  '- Use AppleScript first: the native-app-control execute_applescript tool (or `osascript -e`). Check an app\'s terms with',
  '  applescript_dictionary instead of guessing.',
  '- For anything AppleScript cannot reach (clicking buttons, typing into windows, menus, canvases), use the cua-driver tools. They',
  '  move a visible agent cursor so the user can watch you, without taking their own mouse or keyboard. Call',
  '  set_agent_cursor_enabled {enabled: true} before your first cua-driver action. Take pid and window_id from list_apps and',
  '  list_windows, get element_token values from get_window_state, then click, type_text, hotkey, or scroll with them.',
  '- Reuse apps that are already running; do not open a second copy.',
  '- Never use pyautogui, pynput, cliclick, or screen-coordinate scripts.',
  '- Never click macOS security or permission dialogs; say which one is waiting for the user.',
  '- Do not edit files in this folder, and do not touch code projects unless the prompt asks for it.',
  '- Verify the result (read it back with AppleScript or a fresh get_window_state) and report only what you saw.',
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
