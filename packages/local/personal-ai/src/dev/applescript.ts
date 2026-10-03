/**
 * AppleScript knowledge for the `applescript` tools: an app's real scripting
 * terms, read from the sdef in its bundle (no Xcode needed), and a cookbook of
 * scripts that compile as written, so the model does not guess syntax.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_DICTIONARY = 12_000
/** One command, class, or class-extension element (self-closing or with a body). */
const SDEF_ENTRY = /<(command|class-extension|class)(?=[\s/>])[^>]*?\/>|<(command|class-extension|class)(?=[\s/>])[^>]*>[\s\S]*?<\/\2>/g

/** Scripts that compile as written (checked with osacompile). */
export const APPLESCRIPT_COOKBOOK = [
  'Open/focus or quit an app: tell application "Safari" to activate | tell application "Safari" to quit',
  'Frontmost app: tell application "System Events" to get name of first application process whose frontmost is true',
  'Running apps: tell application "System Events" to get name of every application process whose background only is false',
  'Safari URL / tab titles: tell application "Safari" to get URL of current tab of front window | ... get name of every tab of front window',
  'Open a URL: tell application "Safari" to open location "https://example.com"',
  'Music: tell application "Music" to playpause | ... to next track | ... to get {name, artist} of current track',
  'Volume: set volume output volume 50 | get output volume of (get volume settings)',
  'Notification: display notification "Build finished" with title "KairoForge"',
  'Finder: tell application "Finder" to reveal POSIX file "/Users/me/Desktop" | ... get POSIX path of (target of front Finder window as alias)',
  'Menu item by name: tell application "System Events" to tell process "Safari" to click menu item "New Window" of menu "File" of menu bar 1',
  'List menu items: tell application "System Events" to tell process "Safari" to get name of every menu item of menu "File" of menu bar 1',
  'Button: tell application "System Events" to tell process "Safari" to click button 1 of window 1',
  'Clipboard: get the clipboard | set the clipboard to "text"',
  'Reminder / note: tell application "Reminders" to make new reminder with properties {name:"Buy milk"} | '
  + 'tell application "Notes" to make new note with properties {body:"Text"}',
  'Mail / Calendar: tell application "Mail" to get subject of messages 1 thru 5 of inbox | tell application "Calendar" to get name of every calendar',
]

function run(file: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((done) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      done({ ok: error === null, stdout })
    })
  })
}

function attr(tag: string, name: string): string {
  const value = new RegExp(String.raw`\s${name}="([^"]*)"`).exec(tag)?.[1] ?? ''
  return value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

const unique = (values: string[]): string[] => [...new Set(values.filter(value => value !== ''))]

/**
 * Summarise sdef XML into one entry per command and class.
 * @param xml - sdef document(s).
 * @param filter - optional word an entry must contain.
 * @returns summary lines.
 */
export function summariseSdef(xml: string, filter = ''): string[] {
  const wanted = filter.trim().toLowerCase()
  const blocks = xml.match(SDEF_ENTRY) ?? []
  const lines: string[] = []
  for (const block of blocks) {
    const open = /^<[^>]*>/.exec(block)?.[0] ?? ''
    const kind = open.startsWith('<command') ? 'command' : 'class'
    const name = attr(open, 'name') || attr(open, 'extends')
    if (name === '') continue
    const description = attr(open, 'description')
    let line = `${kind} ${name}${description === '' ? '' : ` — ${description}`}`
    if (kind === 'command') {
      const params = unique((block.match(/<parameter\b[^>]*>/g) ?? []).map(tag => attr(tag, 'name')))
      if (params.length > 0) line += ` (parameters: ${params.join(', ')})`
    } else {
      const props = unique((block.match(/<property\b[^>]*>/g) ?? []).map(tag => attr(tag, 'name')))
      const elements = unique((block.match(/<element\b[^>]*>/g) ?? []).map(tag => attr(tag, 'type')))
      if (props.length > 0) line += `\n    properties: ${props.join(', ')}`
      if (elements.length > 0) line += `\n    elements: ${elements.join(', ')}`
    }
    if (wanted === '' || line.toLowerCase().includes(wanted)) lines.push(line)
  }
  return lines
}

async function readSdef(appPath: string): Promise<string | undefined> {
  const resources = join(appPath, 'Contents', 'Resources')
  const plist = await run('/usr/bin/plutil', ['-extract', 'OSAScriptingDefinition', 'raw', join(appPath, 'Contents', 'Info.plist')], 10_000)
  const named = plist.ok ? plist.stdout.trim() : ''
  let file = named === '' ? '' : join(resources, named.endsWith('.sdef') ? named : `${named}.sdef`)
  if (file === '' || !existsSync(file)) {
    const found = existsSync(resources) ? readdirSync(resources).find(entry => entry.endsWith('.sdef')) : undefined
    file = found === undefined ? '' : join(resources, found)
  }
  if (file === '') return undefined
  const xml = await readFile(file, 'utf8')
  const includes = [...xml.matchAll(/<xi:include\s+href="file:\/\/(\/[^"]+)"/g)].map(match => decodeURI(match[1] ?? ''))
  const extra = await Promise.all(includes.map(path => readFile(path, 'utf8').catch(() => '')))
  return [xml, ...extra].join('\n')
}

/**
 * The commands and classes an app really supports, from its scripting dictionary.
 * @param app - app name, e.g. "Music" or "System Events".
 * @param filter - optional word to keep only matching entries.
 * @returns readable dictionary text.
 */
export async function appleScriptDictionary(app: string, filter = ''): Promise<string> {
  const name = app.trim()
  if (name === '') throw new Error('app is required')
  const located = await run('/usr/bin/osascript', ['-e', `POSIX path of (path to application ${JSON.stringify(name)})`], 20_000)
  if (!located.ok) throw new Error(`Could not find an app named "${name}".`)
  const path = located.stdout.trim().replace(/\/$/, '')
  const xml = await readSdef(path)
  if (xml === undefined) return `"${name}" has no AppleScript dictionary. Script it through System Events UI elements (menus and buttons by name).`
  const lines = summariseSdef(xml, filter)
  if (lines.length === 0) return `No commands or classes in "${name}" match "${filter}".`
  const text = `${name} scripting dictionary:\n${lines.join('\n')}`
  return text.length > MAX_DICTIONARY ? `${text.slice(0, MAX_DICTIONARY)}… (pass a filter word to narrow it)` : text
}
