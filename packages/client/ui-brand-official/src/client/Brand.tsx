import { useId } from 'react'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

/** Shared presentation accepted by every KairoForge mark surface. */
type KairoForgeMarkProps = SidebarBrandMarkOwnerProps & Pick<HeroBrandMarkOwnerProps, 'className'>

/**
 * Render the KairoForge mark from the shipped app icon.
 * @param props - Host-supplied mark presentation.
 * @returns the KairoForge product mark.
 */
export function KairoForgeBrandMark({ size = 32, className }: KairoForgeMarkProps) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={className}
      height={size}
      src="/kairoforge-logo.png"
      style={{ borderRadius: Math.max(6, Math.round(size * 0.24)) }}
      width={size}
    />
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
    flash: '#d9e7ff',
    pro: '#eef2ff',
    omni: '#dbeafe',
    agent: '#cbd5e1',
  }[variant]
  const end = {
    flash: '#415a77',
    pro: '#514f78',
    omni: '#1f3a5f',
    agent: '#263241',
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
