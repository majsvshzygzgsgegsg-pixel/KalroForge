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
  /** Bring the app to the front (new_note); actions otherwise work in the background where they can. */
  readonly show?: boolean
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

const NOTES_APP = /^(?:apple\s+)?notes$/i

function newNote(body: string, title?: string, show = false): string {
  const name = title?.trim() || body.split('\n')[0]?.slice(0, 80) || 'Note'
  const make = `make new note with properties {name:${asText(name)}, body:${asText(body)}}`
  return show ? ['tell application "Notes"', '  activate', `  show (${make})`, 'end tell'].join('\n') : `tell application "Notes" to ${make}`
}

// Background UI: System Events reaches an app's window through Accessibility without bringing it forward.
const CONTROLS = `{${['AXButton', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXMenuButton', 'AXLink', 'AXTab', 'AXDisclosureTriangle', 'AXCell']
  .map(role => `"${role}"`).join(', ')}}`
const FIELDS = '{"AXTextField", "AXTextArea", "AXComboBox"}'
/** Buttons whose press sends, deletes, pays, or signs out: they need the user like mail_send does. */
const RISKY_CONTROL = new RegExp(String.raw`\b(?:send|delete|remove|erase|trash|pay|buy|purchase|order|checkout|transfer|confirm|submit`
  + String.raw`|sign out|log out|unsubscribe|uninstall)\b`, 'i')
const LABEL_OF = [
  'on labelOf(e)',
  '  tell application "System Events"',
  '    set l to missing value',
  '    try',
  '      set l to name of e',
  '    end try',
  '    if l is missing value or l is "" then',
  '      try',
  '        set l to description of e',
  '      end try',
  '    end if',
  '    if l is missing value or l is "" then',
  '      try',
  '        set l to title of e',
  '      end try',
  '    end if',
  '    if l is missing value then return ""',
  '    return l as text',
  '  end tell',
  'end labelOf',
]

/** Opens a System Events block on the app's main window `w` (an open panel or palette can be window 1 of a background app). */
const windowOf = (app: string): string[] => [
  `tell application "System Events" to tell process ${asText(app)}`,
  `  if (count of windows) is 0 then error ${asText(`${app} has no open window.`)}`,
  '  set w to missing value',
  '  try',
  '    set w to value of attribute "AXMainWindow"',
  '  end try',
  '  if w is missing value then',
  '    try',
  '      set w to value of attribute "AXFocusedWindow"',
  '    end try',
  '  end if',
  '  if w is missing value then set w to window 1',
]

function uiList(app: string): string {
  return [...LABEL_OF,
    `tell application "System Events" to if not (exists process ${asText(app)}) then return ${asText(`${app} is not running.`)}`,
    ...windowOf(app),
    '  set out to {"Main window of " & ' + asText(app) + ' & ": " & (name of w as text)}',
    '  with timeout of 20 seconds',
    '    set found to entire contents of w',
    '  end timeout',
    '  repeat with e in found',
    '    try',
    '      set r to role of e',
    `      if r is in ${CONTROLS} or r is in ${FIELDS} then`,
    '        set entry to (text 3 thru -1 of r) & " " & quote & my labelOf(e) & quote',
    `        if r is in ${FIELDS} then`,
    '          try',
    '            set v to value of e as text',
    '            if length of v > 40 then set v to (text 1 thru 40 of v) & "..."',
    '            set entry to entry & " = " & quote & v & quote',
    '          end try',
    '        end if',
    '        set end of out to entry',
    '      end if',
    '    end try',
    '    if (count of out) > 80 then exit repeat',
    '  end repeat',
    'end tell',
    'set AppleScript\'s text item delimiters to linefeed',
    'return out as text',
  ].join('\n')
}

const findIn = (roles: string, label: string): string[] => [
  '  set target to missing value',
  '  with timeout of 20 seconds',
  '    set found to entire contents of w',
  '  end timeout',
  '  repeat with e in found',
  '    try',
  '      set r to role of e',
  `      if r is in ${roles} then`,
  `        if my labelOf(e) is ${asText(label)} then`,
  '          set target to contents of e',
  '          exit repeat',
  '        end if',
  '      end if',
  '    end try',
  '  end repeat',
]

function uiClick(app: string, label: string): string {
  return [...LABEL_OF, ...windowOf(app), ...findIn(CONTROLS, label),
    `  if target is missing value then error ${asText(`No button or control named "${label}" in the main window of ${app}. Use ui_list to see the names.`)}`,
    '  perform action "AXPress" of target',
    'end tell',
    `return ${asText(`Clicked "${label}" in ${app}.`)}`,
  ].join('\n')
}

/** Fill a named field, or append to the focused (else first) text field, without bringing the app forward. */
function uiTypeBody(app: string, text: string, label: string | undefined): string[] {
  if (label !== undefined && label.trim() !== '') {
    return [...windowOf(app), ...findIn(FIELDS, label),
      `  if target is missing value then error ${asText(`No text field named "${label}" in the main window of ${app}. Use ui_list to see the names.`)}`,
      `  set value of target to ${asText(text)}`,
      'end tell',
      `return ${asText(`Typed into "${label}" in ${app}.`)}`,
    ]
  }
  return [...windowOf(app),
    '  set target to missing value',
    '  try',
    '    set target to value of attribute "AXFocusedUIElement"',
    '    set r to role of target',
    `    if r is not in ${FIELDS} then set target to missing value`,
    '    if (name of (value of attribute "AXWindow" of target) as text) is not (name of w as text) then set target to missing value',
    '  end try',
    '  if target is missing value then',
    '    repeat with e in (entire contents of w)',
    '      try',
    '        set r to role of e',
    `        if r is in ${FIELDS} then`,
    '          set target to contents of e',
    '          exit repeat',
    '        end if',
    '      end try',
    '    end repeat',
    '  end if',
    `  if target is missing value then error ${asText(`${app} has no text field to type into.`)}`,
    '  set oldText to ""',
    '  try',
    '    set oldText to value of target as text',
    '  end try',
    `  set value of target to oldText & ${asText(text)}`,
    'end tell',
    `return ${asText(`Typed into ${app} in the background.`)}`,
  ]
}

const indent = (lines: string[]): string[] => lines.map(line => `  ${line}`)

function typeText(args: MacActionArgs): string {
  const text = need(args, 'text')
  const app = args.app?.trim() ?? ''
  // Keystrokes into Notes land in whichever note is selected; a new note is what "type this in Notes" means.
  if (NOTES_APP.test(app)) return newNote(text, undefined, args.show === true)
  const keystroke = `tell application "System Events" to keystroke ${asText(text)}`
  if (app === '') return keystroke
  // Background first; only an app with no reachable text field is brought forward and typed into.
  return [...LABEL_OF, 'try', ...indent(uiTypeBody(app, text, undefined)), 'on error',
    `  tell application ${asText(app)} to activate`, '  delay 0.5', `  ${keystroke}`, 'end try'].join('\n')
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
    summary: 'create an Apple Notes note in the background (body; optional title; show: true to bring Notes forward on it)',
    required: ['body'],
    risk: 'change',
    build: args => newNote(need(args, 'body'), args.title, args.show === true),
  },
  new_reminder: {
    summary: 'create a Reminders item (title; optional body)',
    required: ['title'],
    risk: 'change',
    build: args => `tell application "Reminders" to make new reminder with properties {name:${asText(need(args, 'title'))}, body:${asText(args.body ?? '')}}`,
  },
  type_text: {
    summary: 'type text into an app (text; optional app): into its focused text field in the background, else it is brought forward; Notes makes a new note',
    required: ['text'],
    risk: 'change',
    build: typeText,
  },
  click_menu: {
    summary: 'click a menu item by name (app, menu, item), e.g. Safari / File / New Window; in the background when the app allows it',
    required: ['app', 'menu', 'item'],
    risk: 'change',
    build: (args) => {
      const click = `tell application "System Events" to tell process ${asText(need(args, 'app'))} to click menu item ${asText(need(args, 'item'))} of menu ${asText(need(args, 'menu'))} of menu bar 1`
      return ['try', `  ${click}`, 'on error', `  tell application ${asText(need(args, 'app'))} to activate`, '  delay 0.3', `  ${click}`, 'end try'].join('\n')
    },
  },
  ui_list: {
    summary: 'list the buttons, checkboxes, links, and text fields (with their values) in an app\'s main window, by name, without bringing it forward (app)',
    required: ['app'],
    risk: 'read',
    build: args => uiList(need(args, 'app')),
  },
  ui_click: {
    summary: 'press a button, checkbox, tab, or link by its name in an app\'s main window, in the background (app, item); names come from ui_list',
    required: ['app', 'item'],
    risk: args => RISKY_CONTROL.test(args.item ?? '') ? 'sensitive' : 'change',
    build: args => uiClick(need(args, 'app'), need(args, 'item')),
  },
  ui_type: {
    summary: 'fill in a text field in an app\'s main window, in the background (app, text; item: the field\'s name from ui_list, else the focused field gets the text added)',
    required: ['app', 'text'],
    risk: 'change',
    build: args => [...LABEL_OF, ...uiTypeBody(need(args, 'app'), need(args, 'text'), args.item)].join('\n'),
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
  browser_tabs: {
    summary: 'titles and URLs of every tab in the front browser window (optional browser: "Google Chrome" by default, "Safari", or another Chromium browser)',
    required: [],
    risk: 'read',
    build: (args) => {
      const browser = args.browser?.trim() || 'Google Chrome'
      return /^safari$/i.test(browser)
        ? 'tell application "Safari" to get {name, URL} of every tab of front window'
        : `tell application ${asText(browser)} to get {title, URL} of every tab of front window`
    },
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
