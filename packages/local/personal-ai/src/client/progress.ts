/** The words KairoForge says for each progress update while it works. */
import type { PersonalAiKey, Translate } from './locales.ts'
import type { Progress } from './store.ts'

/** Reading and changing phrasings per tool category. */
const TOOL_KEYS: Readonly<Record<string, readonly [read: PersonalAiKey, change: PersonalAiKey]>> = {
  FILES: ['progress.filesRead', 'progress.filesChange'],
  TERMINAL: ['progress.terminalRead', 'progress.terminalChange'],
  SEARCH: ['progress.search', 'progress.search'],
  BROWSER: ['progress.browser', 'progress.browser'],
  GIT: ['progress.git', 'progress.git'],
  GITHUB: ['progress.github', 'progress.github'],
  COMPUTER: ['progress.computerRead', 'progress.computerChange'],
  PROJECT: ['progress.projectRead', 'progress.projectChange'],
  AGENTS: ['progress.agents', 'progress.agents'],
  WORKFLOWS: ['progress.workflows', 'progress.workflows'],
  BACKGROUND_TASKS: ['progress.background', 'progress.background'],
}

/** One of a phrase's `|`-separated wordings, fixed by the update so a re-render says the same thing. */
function variant(lines: string, pick: number): string {
  const all = lines.split('|')
  return all[pick % all.length] ?? lines
}

/**
 * One progress update as a short spoken line.
 * @param progress - the update.
 * @param t - translator.
 * @returns the line.
 */
export function describeProgress(progress: Progress, t: Translate): string {
  switch (progress.kind) {
    case 'ack': return variant(t('progress.ack'), progress.pick)
    case 'still': return variant(t('progress.still'), progress.pick)
    case 'approval': return t('progress.approval')
    case 'say': return progress.text
    case 'tool': {
      const keys = TOOL_KEYS[progress.category]
      if (keys === undefined) return t('progress.other')
      return t(progress.changes ? keys[1] : keys[0])
    }
  }
}
