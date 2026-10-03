/**
 * Ready-made Mac actions. The model picks an action and fills in values; the
 * script is built here from templates that compile as written, with every
 * value escaped, so common requests never depend on hand-written AppleScript.
 */

/** Values a Mac action can take. */
export interface MacActionArgs {
  readonly app?: string
  readonly text?: string
  readonly title?: string
  readonly to?: string
  readonly subject?: string
  readonly body?: string
  readonly url?: string
  readonly query?: string
  readonly path?: string
  readonly browser?: string
  readonly menu?: string
  readonly item?: string
  readonly command?: string
  readonly level?: number
}

/** How an action is gated: reads only, changes something, or always needs the user. */
export type MacActionRisk = 'read' | 'change' | 'sensitive'

interface MacActionSpec {
  readonly summary: string
  readonly required: readonly (keyof MacActionArgs)[]
  readonly risk: MacActionRisk | ((args: MacActionArgs) => MacActionRisk)
  readonly build: (args: MacActionArgs) => string
}

/**
 * An AppleScript string expression for any text: quotes and backslashes escaped, newlines joined with linefeed.
 * @param value - raw text.
 * @returns AppleScript source that evaluates to the text.
 */
export function asText(value: string): string {
  return value.replaceAll('\r\n', '\n').split('\n')
    .map(line => `"${line.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(' & linefeed & ')
}

const need = (args: MacActionArgs, key: keyof MacActionArgs): string => String(args[key] ?? '')
const openUrl = (url: string, browser?: string): string => browser === undefined || browser.trim() === ''
  ? `open location ${asText(url)}`
  : `do shell script "open -a " & quoted form of ${asText(browser)} & " " & quoted form of ${asText(url)}`

const query = (params: Record<string, string | undefined>): string => Object.entries(params)
  .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
  .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  .join('&')

const mailMessage = (args: MacActionArgs, visible: boolean): string[] => [
  'tell application "Mail"',
  `  set newMessage to make new outgoing message with properties {subject:${asText(need(args, 'subject'))}, content:${asText(need(args, 'body'))}, visible:${String(visible)}}`,
  `  tell newMessage to make new to recipient at end of to recipients with properties {address:${asText(need(args, 'to'))}}`,
]

const MUSIC: Readonly<Record<string, string>> = {
  play: 'play', pause: 'pause', playpause: 'playpause', next: 'next track', previous: 'previous track',
}

/** Every Mac action, by name. */
export const MAC_ACTIONS = {
  open_app: { summary: 'open or focus an app (app)', required: ['app'], risk: 'change', build: args => `tell application ${asText(need(args, 'app'))} to activate` },
  quit_app: { summary: 'quit an app (app)', required: ['app'], risk: 'change', build: args => `tell application ${asText(need(args, 'app'))} to quit` },
  open_url: {
    summary: 'open a web page (url; optional browser, e.g. "Google Chrome"; default browser otherwise)',
    required: ['url'],
    risk: 'change',
    build: args => openUrl(need(args, 'url'), args.browser),
  },
  web_search: {
    summary: 'Google search in the browser (query; optional browser)',
    required: ['query'],
    risk: 'change',
    build: args => openUrl(`https://www.google.com/search?${query({ q: args.query })}`, args.browser),
  },
  maps_search: {
    summary: 'search Google Maps, e.g. "chinese food near me" (query; optional browser)',
    required: ['query'],
    risk: 'change',
    build: args => openUrl(`https://www.google.com/maps/search/${encodeURIComponent(need(args, 'query'))}`, args.browser),
  },
  gmail_compose: {
    summary: 'open a filled-in Gmail draft in the browser; the user presses Send (to; optional subject, body, browser)',
    required: ['to'],
    risk: 'change',
    build: args => openUrl(`https://mail.google.com/mail/?${query({ view: 'cm', fs: '1', to: args.to, su: args.subject, body: args.body })}`, args.browser),
  },
  mail_draft: {
    summary: 'open a filled-in Apple Mail message; the user presses Send (to, subject, body)',
    required: ['to'],
    risk: 'change',
    build: args => [...mailMessage(args, true), '  activate', 'end tell'].join('\n'),
  },
  mail_send: {
    summary: 'send an email from Apple Mail right away (to, subject, body); always asks the user first',
    required: ['to', 'subject', 'body'],
    risk: 'sensitive',
    build: args => [...mailMessage(args, false), '  send newMessage', 'end tell'].join('\n'),
  },
  new_note: {
    summary: 'create an Apple Notes note and show it (body; optional title)',
    required: ['body'],
    risk: 'change',
    build: (args) => {
      const title = args.title?.trim() || need(args, 'body').split('\n')[0]?.slice(0, 80) || 'Note'
      return ['tell application "Notes"', '  activate', `  show (make new note with properties {name:${asText(title)}, body:${asText(need(args, 'body'))}})`, 'end tell'].join('\n')
    },
  },
  new_reminder: {
    summary: 'create a Reminders item (title; optional body)',
    required: ['title'],
    risk: 'change',
    build: args => `tell application "Reminders" to make new reminder with properties {name:${asText(need(args, 'title'))}, body:${asText(args.body ?? '')}}`,
  },
  type_text: {
    summary: 'type text into an app that has no better action, after focusing it (text; optional app)',
    required: ['text'],
    risk: 'change',
    build: args => [
      ...args.app === undefined || args.app.trim() === '' ? [] : [`tell application ${asText(args.app)} to activate`, 'delay 0.5'],
      `tell application "System Events" to keystroke ${asText(need(args, 'text'))}`,
    ].join('\n'),
  },
  click_menu: {
    summary: 'click a menu item by name (app, menu, item), e.g. Safari / File / New Window',
    required: ['app', 'menu', 'item'],
    risk: 'change',
    build: args => [
      `tell application ${asText(need(args, 'app'))} to activate`,
      `tell application "System Events" to tell process ${asText(need(args, 'app'))} to click menu item ${asText(need(args, 'item'))} of menu ${asText(need(args, 'menu'))} of menu bar 1`,
    ].join('\n'),
  },
  music: {
    summary: 'control Music (command: play, pause, playpause, next, previous, now_playing)',
    required: ['command'],
    risk: args => args.command === 'now_playing' ? 'read' : 'change',
    build: (args) => {
      if (args.command === 'now_playing') return 'tell application "Music" to get {name, artist} of current track'
      const verb = MUSIC[need(args, 'command')]
      if (verb === undefined) throw new Error('music command must be play, pause, playpause, next, previous, or now_playing')
      return `tell application "Music" to ${verb}`
    },
  },
  volume: {
    summary: 'set the output volume (level 0-100), or read it when level is omitted',
    required: [],
    risk: args => args.level === undefined ? 'read' : 'change',
    build: args => args.level === undefined
      ? 'get output volume of (get volume settings)'
      : `set volume output volume ${String(Math.min(100, Math.max(0, Math.round(args.level))))}`,
  },
  notify: {
    summary: 'show a macOS notification (text; optional title)',
    required: ['text'],
    risk: 'change',
    build: args => `display notification ${asText(need(args, 'text'))} with title ${asText(args.title ?? 'KairoForge')}`,
  },
  reveal_in_finder: {
    summary: 'show a file or folder in Finder (path)',
    required: ['path'],
    risk: 'change',
    build: args => ['tell application "Finder"', '  activate', `  reveal POSIX file ${asText(need(args, 'path'))}`, 'end tell'].join('\n'),
  },
  frontmost_app: {
    summary: 'name of the app in front',
    required: [],
    risk: 'read',
    build: () => 'tell application "System Events" to get name of first application process whose frontmost is true',
  },
  running_apps: {
    summary: 'names of the open apps',
    required: [],
    risk: 'read',
    build: () => 'tell application "System Events" to get name of every application process whose background only is false',
  },
  safari_url: {
    summary: 'URL and title of the front Safari tab',
    required: [],
    risk: 'read',
    build: () => 'tell application "Safari" to get {URL, name} of current tab of front window',
  },
  clipboard_get: { summary: 'read the clipboard text', required: [], risk: 'read', build: () => 'get the clipboard as text' },
  clipboard_set: { summary: 'put text on the clipboard (text)', required: ['text'], risk: 'change', build: args => `set the clipboard to ${asText(need(args, 'text'))}` },
} satisfies Record<string, MacActionSpec>

/** Name of one Mac action. */
export type MacActionName = keyof typeof MAC_ACTIONS

/** Every action name, in catalog order. */
export const MAC_ACTION_NAMES = Object.keys(MAC_ACTIONS) as MacActionName[]

function specOf(action: string): MacActionSpec | undefined {
  return Object.hasOwn(MAC_ACTIONS, action) ? (MAC_ACTIONS as Record<string, MacActionSpec>)[action] : undefined
}

/**
 * The AppleScript for one action.
 * @param action - action name.
 * @param args - its values.
 * @returns script source.
 */
export function macActionScript(action: string, args: MacActionArgs): string {
  const spec = specOf(action)
  if (spec === undefined) throw new Error(`Unknown action "${action}". Use one of: ${MAC_ACTION_NAMES.join(', ')}.`)
  const missing = spec.required.filter(key => args[key] === undefined || String(args[key]).trim() === '')
  if (missing.length > 0) throw new Error(`${action} needs ${missing.join(', ')}.`)
  return spec.build(args)
}

/**
 * How one action is gated.
 * @param action - action name.
 * @param args - its values.
 * @returns its risk, or `change` for an unknown action.
 */
export function macActionRisk(action: string, args: MacActionArgs): MacActionRisk {
  const spec = specOf(action)
  if (spec === undefined) return 'change'
  return typeof spec.risk === 'function' ? spec.risk(args) : spec.risk
}

/** One line per action for the tool description. */
export function macActionCatalog(): string {
  return MAC_ACTION_NAMES.map(name => `- ${name}: ${MAC_ACTIONS[name].summary}`).join('\n')
}
