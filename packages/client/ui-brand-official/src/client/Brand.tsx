import { useId } from 'react'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

/** Shared presentation accepted by every KairoForge mark surface. */
type KairoForgeMarkProps = SidebarBrandMarkOwnerProps & Pick<HeroBrandMarkOwnerProps, 'className'>

/**
 * Render the original KairoForge lattice: four agent paths converging on one
 * supervised execution core.
 * @param props - Host-supplied mark presentation.
 * @returns the KairoForge product mark.
 */
export function KairoForgeBrandMark({ size, className }: KairoForgeMarkProps) {
  const gradient = useId()
  return (
    <svg
      aria-hidden="true"
      className={className}
      height={size}
      viewBox="0 0 64 64"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradient} x1="8" x2="56" y1="8" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--dsw-static-blue-400)" />
          <stop offset="0.52" stopColor="var(--dsw-static-deepseek-450)" />
          <stop offset="1" stopColor="var(--dsw-static-blue-600)" />
        </linearGradient>
      </defs>
      <path
        d="M32 5c5.2 0 9.4 4.2 9.4 9.4 0 2.1-.7 4.1-1.9 5.7l4.4 7.6 8.8-.1a9.4 9.4 0 1 1 0 8.8l-8.8-.1-4.4 7.6a9.4 9.4 0 1 1-15 0l-4.4-7.6-8.8.1a9.4 9.4 0 1 1 0-8.8l8.8.1 4.4-7.6a9.4 9.4 0 0 1 7.5-15.1Z"
        fill={`url(#${gradient})`}
        fillRule="evenodd"
      />
      <path
        d="m32 23 3 6 6 3-6 3-3 6-3-6-6-3 6-3 3-6Z"
        fill="var(--dsw-static-amber-400)"
      />
      <circle cx="32" cy="14" r="4" fill="var(--dsw-static-neutral-1000)" fillOpacity="0.72" />
      <circle cx="14" cy="32" r="4" fill="var(--dsw-static-neutral-1000)" fillOpacity="0.72" />
      <circle cx="50" cy="32" r="4" fill="var(--dsw-static-neutral-1000)" fillOpacity="0.72" />
      <circle cx="32" cy="50" r="4" fill="var(--dsw-static-neutral-1000)" fillOpacity="0.72" />
    </svg>
  )
}

/** Render the KairoForge name independently from the mark. */
export function KairoForgeBrandName() {
  return <span className={css.kairoForgeWordmark}>KairoForge</span>
}

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the KairoForge mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <KairoForgeBrandMark size={size} />
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name wordmark.
 */
export function OfficialBrandName() {
  return <KairoForgeBrandName />
}
