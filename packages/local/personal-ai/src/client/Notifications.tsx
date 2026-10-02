/**
 * Proactive notifications: one app-wide toast per new notice, filtered by the
 * user's preference on the Host (off, important, all).
 */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { LiveSnapshot, LiveStore, Observable } from './store.ts'
import type { NS } from './locales.ts'

/** What the overlay receives from the plugin. */
export interface NotificationsInjected {
  readonly hooks: { readonly live: Observable<LiveSnapshot> }
  readonly store: LiveStore
}

/** Full props. */
export type NotificationsProps = PropsRuntime<'shell.overlay'> & InjectFace<NotificationsInjected> & PropsLocale<typeof NS>

/**
 * Render the oldest pending notice as a toast.
 * @param props - live store.
 * @returns one toast, or nothing.
 */
export function Notifications({ useLive, store }: NotificationsProps) {
  const toast = useLive(snapshot => snapshot.toasts[0])
  if (toast === undefined) return null
  return (
    <Toast
      key={toast.id}
      text={toast.text}
      {...toast.level === 'success' ? { tone: 'success' as const } : {}}
      onDone={() => { store.dismissToast(toast.id) }}
    />
  )
}
