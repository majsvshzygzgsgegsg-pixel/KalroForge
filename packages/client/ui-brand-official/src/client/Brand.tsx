import { useId } from 'react'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

/** Shared presentation accepted by every KairoForge mark surface. */
type KairoForgeMarkProps = SidebarBrandMarkOwnerProps & Pick<HeroBrandMarkOwnerProps, 'className'>

/**
 * Render the original KairoForge mark: a forged K orbit with a live spark at
 * the center. The geometry intentionally stays simple at tiny sidebar sizes.
 * @param props - Host-supplied mark presentation.
 * @returns the KairoForge product mark.
 */
export function KairoForgeBrandMark({ size, className }: KairoForgeMarkProps) {
  const shellGradient = useId()
  const coreGradient = useId()
  const glowGradient = useId()
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
        <linearGradient id={shellGradient} x1="7" x2="58" y1="6" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor="#20e7ff" />
          <stop offset="0.44" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#ffb020" />
        </linearGradient>
        <radialGradient id={coreGradient} cx="0" cy="0" r="1" gradientTransform="matrix(0 20 -20 0 32 31)" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" />
          <stop offset="0.38" stopColor="#dff9ff" />
          <stop offset="1" stopColor="#6d28d9" />
        </radialGradient>
        <radialGradient id={glowGradient} cx="0" cy="0" r="1" gradientTransform="matrix(0 29 -29 0 32 32)" gradientUnits="userSpaceOnUse">
          <stop stopColor="#38bdf8" stopOpacity="0.7" />
          <stop offset="0.62" stopColor="#8b5cf6" stopOpacity="0.24" />
          <stop offset="1" stopColor="#020617" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="29" fill={`url(#${glowGradient})`} />
      <path
        d="M31.8 5.5c9.2 0 17.5 4.8 22.2 12.6a3.7 3.7 0 0 1-1.3 5.1l-6.9 4.1a3.7 3.7 0 0 1-5.1-1.3 10.2 10.2 0 1 0-8.9 15.2 10 10 0 0 0 7.5-3.3 3.7 3.7 0 0 1 5.2-.2l6.2 5.2a3.7 3.7 0 0 1 .4 5.3 25.8 25.8 0 1 1-19.3-42.7Z"
        fill={`url(#${shellGradient})`}
      />
      <path
        d="M23.5 17.7c0-1.6 1.3-2.9 2.9-2.9h5.1c1.6 0 2.9 1.3 2.9 2.9v10.5l9.2-11.1a3.7 3.7 0 0 1 2.9-1.3h5.1c2.5 0 3.8 2.9 2.2 4.8L43 33l11.9 12.5c1.8 1.9.5 5-2.1 5h-5.7a3.8 3.8 0 0 1-2.8-1.2l-9.9-10.7v9c0 1.6-1.3 2.9-2.9 2.9h-5.1a2.9 2.9 0 0 1-2.9-2.9V17.7Z"
        fill="#050816"
        fillOpacity="0.88"
      />
      <path
        d="m32 21.5 2.7 7.8 7.8 2.7-7.8 2.7-2.7 7.8-2.7-7.8-7.8-2.7 7.8-2.7 2.7-7.8Z"
        fill={`url(#${coreGradient})`}
      />
      <circle cx="50.5" cy="16" r="3.4" fill="#fbbf24" />
      <circle cx="15" cy="49.5" r="2.7" fill="#22d3ee" />
    </svg>
  )
}

/** Distinct KairoForge marks for model and mode surfaces. */
export type KairoForgeModelMarkVariant = 'flash' | 'pro' | 'omni' | 'agent'

/**
 * Render a compact model badge that can be used beside KairoForge model rows.
 * @param props - Visual variant, size, and optional class name.
 * @returns a model badge.
 */
export function KairoForgeModelMark({
  variant,
  size = 28,
  className,
}: { variant: KairoForgeModelMarkVariant; size?: number; className?: string }) {
  const gradient = useId()
  const glyph = {
    flash: '⚡',
    pro: '◆',
    omni: '✦',
    agent: '✺',
  }[variant]
  const start = {
    flash: '#38bdf8',
    pro: '#a78bfa',
    omni: '#34d399',
    agent: '#f59e0b',
  }[variant]
  const end = {
    flash: '#2563eb',
    pro: '#ec4899',
    omni: '#06b6d4',
    agent: '#ef4444',
  }[variant]
  return (
    <svg
      aria-hidden="true"
      className={className}
      height={size}
      viewBox="0 0 40 40"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradient} x1="6" x2="34" y1="5" y2="35" gradientUnits="userSpaceOnUse">
          <stop stopColor={start} />
          <stop offset="1" stopColor={end} />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="32" height="32" rx="12" fill={`url(#${gradient})`} />
      <circle cx="20" cy="20" r="11" fill="#050816" fillOpacity="0.28" />
      <text
        dominantBaseline="central"
        fill="#fff"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
        fontSize="15"
        fontWeight="800"
        textAnchor="middle"
        x="20"
        y="20"
      >
        {glyph}
      </text>
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
