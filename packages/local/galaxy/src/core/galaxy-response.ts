import { clamp01 } from './easing.ts'

/** How the star network and sky answer the AI's voice on one frame. */
export interface GalaxyResponse {
  /** Link opacity: about 12% at rest, up to 65% at full voice. */
  readonly lineOpacity: number
  /** Node brightness multiplier. */
  readonly nodeBrightness: number
  /** Node size multiplier. */
  readonly nodeSize: number
  /** Network scale: a few percent of swell. */
  readonly swell: number
  /** Rotation speed multiplier. */
  readonly rotationBoost: number
  /** Camera push-in, world units. */
  readonly push: number
  /** Camera shake amplitude, world units: almost imperceptible. */
  readonly shake: number
  /** Extra nebula brightness, 0..1. */
  readonly nebulaBoost: number
  /** Extra bloom brightness. */
  readonly bloomBoost: number
}

/** Resting link opacity. */
export const REST_LINE_OPACITY = 0.12
/** Link opacity at full voice. */
export const PEAK_LINE_OPACITY = 0.65

/**
 * The galaxy answers the AI, not the user: `response` is the state's galaxy
 * response (0 while listening), `level` the AI's voice level.
 * @param response - state weight, 0..1.
 * @param level - voice level, 0..1.
 * @returns this frame's network and sky drive.
 */
export function galaxyResponse(response: number, level: number): GalaxyResponse {
  const drive = clamp01(response * (0.2 + level * 1.1))
  return {
    lineOpacity: REST_LINE_OPACITY + (PEAK_LINE_OPACITY - REST_LINE_OPACITY) * drive,
    nodeBrightness: 1 + drive * 0.9,
    nodeSize: 1 + drive * 0.35,
    swell: 1 + drive * 0.04,
    rotationBoost: 1 + drive * 2.5,
    push: drive * 2.5,
    shake: drive * 0.035,
    nebulaBoost: drive,
    bloomBoost: drive * 0.8,
  }
}
