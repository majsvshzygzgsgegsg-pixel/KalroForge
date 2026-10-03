/**
 * Quick commands: plain, unambiguous Mac requests ("open Notes and type hi",
 * "search YouTube for lofi", "volume 30") recognised without a model, each
 * mapped to exactly one mac_action call. Anything less clear returns
 * undefined and goes to the model as usual.
 */
import type { MacActionArgs } from './mac-actions.ts'

/** One recognised request: the mac_action to run and what to say once it succeeded. */
export interface QuickCommand {
  readonly action: string
  readonly args: MacActionArgs
  readonly done: string
}

/** Resolves a spoken app name to an installed app's exact name, or undefined when none is installed. */
export type AppResolver = (name: string) => string | undefined

const SITES: Readonly<Record<string, string>> = {
  'youtube': 'https://www.youtube.com',
  'gmail': 'https://mail.google.com',
  'google': 'https://www.google.com',
  'google maps': 'https://www.google.com/maps',
  'google drive': 'https://drive.google.com',
  'google docs': 'https://docs.google.com',
  'github': 'https://github.com',
  'netflix': 'https://www.netflix.com',
  'reddit': 'https://www.reddit.com',
  'twitter': 'https://x.com',
  'chatgpt': 'https://chatgpt.com',
  'amazon': 'https://www.amazon.com',
  'facebook': 'https://www.facebook.com',
  'instagram': 'https://www.instagram.com',
  'linkedin': 'https://www.linkedin.com',
  'wikipedia': 'https://www.wikipedia.org',
  'twitch': 'https://www.twitch.tv',
  'tiktok': 'https://www.tiktok.com',
}

const BROWSERS: Readonly<Record<string, string>> = {
  'chrome': 'Google Chrome',
  'google chrome': 'Google Chrome',
  'safari': 'Safari',
  'firefox': 'Firefox',
  'arc': 'Arc',
  'brave': 'Brave Browser',
  'edge': 'Microsoft Edge',
}

const MUSIC: Readonly<Record<string, { readonly command: string; readonly done: string }>> = {
  play: { command: 'play', done: 'Playing music.' },
  pause: { command: 'pause', done: 'Paused the music.' },
  next: { command: 'next', done: 'Skipped to the next track.' },
  previous: { command: 'previous', done: 'Back to the previous track.' },
}

const NAME = String.raw`([a-z0-9][\w .'&+-]{0,40}?)`
const GO = String.raw`(?:open|launch|start|pull up|bring up|go to|go on|go into|get on|hop on|jump on|switch to)`
const TYPE = String.raw`(?:type|write|say|put|enter)`
const MESSAGING = /^(?:Messages|Mail|WhatsApp|Slack|Discord|Telegram|Signal|Microsoft Teams|Microsoft Outlook|Messenger)$/i
const BROWSER = String.raw`(?:\s+(?:on|in|with|using)\s+(google chrome|chrome|safari|firefox|arc|brave|edge))?`
const LEAD = /^(?:(?:hey|ok|okay)\s+)?(?:kairo ?forge[,\s]+)?(?:(?:please|can you|could you|would you|will you|go ahead and|just)\s+)*/i
const TAIL = /(?:[,\s]+(?:please|thanks|thank you|for me|now|right now))*[\s.!?]*$/i
/** Requests that need judgement (which video, when, what it says) stay with the model. */
const NEEDS_MODEL = /\b(?:latest|newest|recent|first|last|best|top|most|and then|after that|then)\b/i
const TIMED = /\d|\b(?:tomorrow|tonight|today|morning|afternoon|evening|every|week|month|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i

function clean(text: string): string {
  return text.trim().replace(LEAD, '').replace(TAIL, '').trim()
}

function unquote(text: string): string {
  return text.trim().replace(/^["'“‘](.*)["'”’]$/s, '$1').trim()
}

function stripApp(name: string): string {
  return name.trim().replace(/^(?:my|the)\s+/i, '').replace(/\s+app(?:lication)?$/i, '').trim()
}

function site(name: string): { readonly url: string; readonly label: string } | undefined {
  const key = name.toLowerCase()
  const known = SITES[key]
  if (known !== undefined) {
    return { url: known, label: key === 'youtube' ? 'YouTube' : key.replace(/\b\w/g, char => char.toUpperCase()) }
  }
  if (/^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(name)) {
    return { url: /^https?:\/\//i.test(name) ? name : `https://${name}`, label: name }
  }
  return undefined
}

function youtubeSearch(query: string, browser: string | undefined): QuickCommand {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
  return { action: 'open_url', args: { url, ...browser === undefined ? {} : { browser } }, done: `Searched YouTube for "${query}".` }
}

function inBrowser(browser: string | undefined): string {
  return browser === undefined ? '' : ` in ${browser}`
}

function typeInto(app: string, text: string, resolve: AppResolver): QuickCommand | undefined {
  const name = stripApp(app)
  if (/^(?:apple\s+)?notes?$/i.test(name)) return { action: 'new_note', args: { body: text }, done: `Made a new note in Notes that says "${text}".` }
  const resolved = resolve(name.replace(/^apple\s+/i, '')) ?? resolve(name)
  // Who a message goes to needs judgement, so messaging apps stay with the model.
  if (resolved === undefined || text === '' || MESSAGING.test(resolved)) return undefined
  return { action: 'type_text', args: { app: resolved, text }, done: `Typed "${text}" into ${resolved}.` }
}

/**
 * Recognise one plain Mac request.
 * @param input - the user's message.
 * @param resolve - maps an app name to an installed app.
 * @returns the single action to run, or undefined when the model should handle it.
 */
export function parseQuickCommand(input: string, resolve: AppResolver): QuickCommand | undefined {
  if (input.length > 160 || input.includes('\n')) return undefined
  const original = clean(input)
  const text = original.toLowerCase()
  if (/\b(?:and then|after that|then)\b/.test(text)) return undefined
  // "Cursor" is the code editor; activating the app only shows its Agents window, so the model opens the project in it instead.
  if (/\bcursor\b/.test(text)) return undefined
  let match: RegExpExecArray | null

  // Typing keeps the user's own capitalisation, so it reads the original text.
  if ((match = new RegExp(String.raw`^${GO}\s+(?:up\s+)?${NAME}\s+and\s+${TYPE}\s+(.+)$`, 'i').exec(original)) !== null) {
    return typeInto(match[1] ?? '', unquote(match[2] ?? ''), resolve)
  }
  if ((match = new RegExp(String.raw`^${TYPE}\s+(.+?)\s+(?:in|into|on)\s+${NAME}$`, 'i').exec(original)) !== null) {
    return typeInto(match[2] ?? '', unquote(match[1] ?? ''), resolve)
  }
  if ((match = new RegExp(String.raw`^(?:in|on|into)\s+${NAME}[,\s]+${TYPE}\s+(.+)$`, 'i').exec(original)) !== null) {
    return typeInto(match[1] ?? '', unquote(match[2] ?? ''), resolve)
  }
  const NOTE = /^(?:make|create|take|add|write|start)\s+(?:a\s+)?(?:new\s+)?note\s*(?:that says|saying|with|:|-)?\s+(.+)$/i
  if ((match = NOTE.exec(original)) !== null) {
    const body = unquote(match[1] ?? '')
    return body === '' ? undefined : { action: 'new_note', args: { body }, done: `Made a new note in Notes that says "${body}".` }
  }
  if ((match = /^remind me to\s+(.+)$/i.exec(original) ?? /^add\s+(.+?)\s+to\s+my\s+reminders$/i.exec(original)) !== null) {
    const title = unquote(match[1] ?? '')
    if (title === '' || TIMED.test(title)) return undefined
    return { action: 'new_reminder', args: { title }, done: `Added a reminder: "${title}".` }
  }

  if (NEEDS_MODEL.test(text)) return undefined

  if ((match = new RegExp(String.raw`^open\s+youtube${BROWSER}\s+and\s+(?:search(?:\s+for)?|look up|find|play)\s+(.+)$`).exec(text)) !== null) {
    return youtubeSearch(unquote(match[2] ?? ''), BROWSERS[match[1] ?? ''])
  }
  if ((match = new RegExp(String.raw`^(?:search|look up|find|play)\s+(.+?)\s+on\s+youtube${BROWSER}$`).exec(text)) !== null) {
    return youtubeSearch(unquote(match[1] ?? ''), BROWSERS[match[2] ?? ''])
  }
  if ((match = new RegExp(String.raw`^(?:search\s+)?youtube\s+(?:for\s+)?(.+?)${BROWSER}$`).exec(text)) !== null) {
    return youtubeSearch(unquote(match[1] ?? ''), BROWSERS[match[2] ?? ''])
  }
  if ((match = new RegExp(String.raw`^(?:google|search google for|google search|search (?:the web|online|google) for)\s+(.+?)${BROWSER}$`).exec(text)) !== null) {
    const query = unquote(match[1] ?? '')
    const browser = BROWSERS[match[2] ?? '']
    return { action: 'web_search', args: { query, ...browser === undefined ? {} : { browser } }, done: `Searched Google for "${query}"${inBrowser(browser)}.` }
  }
  if ((match = /^(?:find|show me|search for|look for)?\s*(.+?\s+near me)$/.exec(text)) !== null
    || (match = /^(?:directions to|find|show|search for)\s+(.+?)\s+on\s+(?:google\s+)?maps?$/.exec(text)) !== null
    || (match = /^directions to\s+(.+)$/.exec(text)) !== null) {
    const query = unquote(match[1] ?? '')
    return { action: 'maps_search', args: { query }, done: `Searched Google Maps for "${query}".` }
  }

  if ((match = new RegExp(String.raw`^${GO}\s+(?:up\s+)?${NAME}${BROWSER}$`).exec(text)) !== null) {
    const target = stripApp(match[1] ?? '')
    const browser = BROWSERS[match[2] ?? '']
    const page = site(target)
    if (page !== undefined) return { action: 'open_url', args: { url: page.url, ...browser === undefined ? {} : { browser } }, done: `Opened ${page.label}${inBrowser(browser)}.` }
    if (browser !== undefined) return undefined
    const app = resolve(target.replace(/^apple\s+/, '')) ?? resolve(target)
    return app === undefined ? undefined : { action: 'open_app', args: { app }, done: `Opened ${app}.` }
  }
  if ((match = new RegExp(String.raw`^(?:quit|close|exit)\s+${NAME}$`).exec(text)) !== null) {
    const target = stripApp(match[1] ?? '')
    const app = resolve(target.replace(/^apple\s+/, '')) ?? resolve(target)
    return app === undefined ? undefined : { action: 'quit_app', args: { app }, done: `Quit ${app}.` }
  }

  if ((match = /^(?:(?:set|turn|put)\s+(?:the\s+)?)?volume\s+(?:to\s+)?(\d{1,3})\s*%?$/.exec(text)) !== null) {
    const level = Math.min(100, Number(match[1]))
    return { action: 'volume', args: { level }, done: `Volume set to ${String(level)}%.` }
  }
  if (/^mute(?:\s+(?:the\s+)?(?:volume|sound|mac|computer))?$/.test(text)) return { action: 'volume', args: { level: 0 }, done: 'Muted.' }
  const MUSIC_WORDS: ReadonlyArray<readonly [RegExp, keyof typeof MUSIC]> = [
    [/^(?:play|resume)(?:\s+(?:the\s+)?music)?$/, 'play'],
    [/^(?:pause|stop)(?:\s+(?:the\s+)?music)?$/, 'pause'],
    [/^(?:next|skip)(?:\s+(?:this\s+)?(?:song|track))?$/, 'next'],
    [/^(?:previous|go back a)\s+(?:song|track)$/, 'previous'],
  ]
  const word = MUSIC_WORDS.find(([pattern]) => pattern.test(text))?.[1]
  const music = word === undefined ? undefined : MUSIC[word]
  if (music !== undefined) return { action: 'music', args: { command: music.command }, done: music.done }
  return undefined
}
