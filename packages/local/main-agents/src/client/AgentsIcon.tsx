/** Decorative occupant for the Agents sidebar entry. */
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the agent glyph at the size the sidebar asks for; the sidebar owns
 * the accessible navigation label.
 * @param props - the sidebar's icon share.
 * @returns decorative agent icon.
 */
export function AgentsIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconAgentPresetOutlineRegular size={size} />
}
