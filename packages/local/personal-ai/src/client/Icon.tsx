/** Decorative sidebar glyph for the Command Center: a small orbit. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the orbit glyph at the size the sidebar asks for; the sidebar owns the label.
 * @param props - the sidebar's icon share.
 * @returns decorative icon.
 */
export function CommandCenterIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <circle cx="12" cy="12" r="3.2" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-28 12 12)" />
      <circle cx="19.2" cy="8.4" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}
