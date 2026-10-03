/**
 * Installed macOS apps by spoken name, for quick commands. The app folders are
 * listed at most once a minute.
 */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FOLDERS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')]
const ALIASES: Readonly<Record<string, string>> = {
  'chrome': 'Google Chrome',
  'vs code': 'Visual Studio Code',
  'vscode': 'Visual Studio Code',
  'word': 'Microsoft Word',
  'excel': 'Microsoft Excel',
  'powerpoint': 'Microsoft PowerPoint',
  'outlook': 'Microsoft Outlook',
  'teams': 'Microsoft Teams',
  'settings': 'System Settings',
  'system preferences': 'System Settings',
  'preferences': 'System Settings',
  'mail': 'Mail',
  'email': 'Mail',
  'calculator': 'Calculator',
  'terminal': 'Terminal',
  'messages': 'Messages',
  'texts': 'Messages',
  'imessage': 'Messages',
  'facetime': 'FaceTime',
  'app store': 'App Store',
  'music': 'Music',
  'apple music': 'Music',
  'calendar': 'Calendar',
  'reminders': 'Reminders',
  'photos': 'Photos',
  'maps': 'Maps',
  'finder': 'Finder',
}
const TTL_MS = 60_000

let cache: { readonly at: number; readonly names: ReadonlyMap<string, string> } | undefined

function installed(): ReadonlyMap<string, string> {
  if (cache !== undefined && Date.now() - cache.at < TTL_MS) return cache.names
  const names = new Map<string, string>([['finder', 'Finder']])
  for (const folder of FOLDERS) {
    let entries: string[] = []
    try { entries = readdirSync(folder) } catch { continue }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue
      const name = entry.slice(0, -4)
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
    }
  }
  cache = { at: Date.now(), names }
  return names
}

/**
 * The installed app a spoken name refers to.
 * @param spoken - e.g. "notes", "chrome", "System Settings".
 * @returns the app's exact name, or undefined when no such app is installed.
 */
export function resolveInstalledApp(spoken: string): string | undefined {
  const key = spoken.trim().toLowerCase()
  if (key === '') return undefined
  const names = installed()
  const alias = ALIASES[key]
  if (alias !== undefined && names.has(alias.toLowerCase())) return names.get(alias.toLowerCase())
  return names.get(key)
}
