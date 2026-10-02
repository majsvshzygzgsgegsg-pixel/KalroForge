/** Display names for agent modes. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Name a mode for display: Creator and the default KairoForge mode get their
 * product names, while every other mode keeps its catalog name.
 * @param id - the mode id.
 * @param name - the catalog name, which falls back to the id.
 * @param t - localized copy.
 * @returns the display name.
 */
export function modeLabel(id: string, name: string, t: TranslateNS<'mainAgents.page'>): string {
  if (id === 'cordis') return t('mode.cordis')
  if (id === 'standard') return t('mode.standard')
  return name
}
