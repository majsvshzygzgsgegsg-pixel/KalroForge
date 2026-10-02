import { clamp01 } from './easing.ts'

/** Audio levels for one frame, each 0..1. */
export interface AudioLevels {
  /** Voice band average. */
  level: number
  /** Low bins. */
  bass: number
  /** High bins. */
  treble: number
}

/** No sound at all. */
export const SILENCE: AudioLevels = { level: 0, bass: 0, treble: 0 }

/** Breathing speed, rad/s. */
export const BREATH_RATE = 0.7
/** Breathing depth in displacement units. */
export const BREATH_DEPTH = 0.04
/** Largest outward or inward vertex displacement. */
export const MAX_DISPLACEMENT = 0.45

/**
 * Slow breathing term, 0..BREATH_DEPTH.
 * @param t - animation clock in seconds.
 * @returns displacement contribution.
 */
export function breath(t: number): number {
  return BREATH_DEPTH * (0.5 + 0.5 * Math.sin(t * BREATH_RATE))
}

/**
 * How much the noise should move the surface. The noise itself is unit-scale;
 * this multiplier is what keeps the orb calm at rest and lively when loud.
 * @param baseDisplacement - state baseline.
 * @param amplitude - state audio gain.
 * @param audio - current levels.
 * @param t - animation clock in seconds.
 * @returns displacement multiplier.
 */
export function orbActivity(baseDisplacement: number, amplitude: number, audio: AudioLevels, t: number): number {
  return baseDisplacement + breath(t) + audio.level * amplitude * 0.55 + audio.bass * amplitude * 0.35
}

/**
 * Weight of the high-frequency octave: silent orbs don't get fine detail.
 * @param audio - current levels.
 * @returns 0..1 weight.
 */
export function highOctaveMix(audio: AudioLevels): number {
  return clamp01(audio.level * 3 + audio.treble * 2)
}

/**
 * Orb scale for the current levels.
 * @param audio - current levels.
 * @returns uniform scale.
 */
export function orbScale(audio: AudioLevels): number {
  return 1 + audio.level * 0.08 + audio.bass * 0.05
}
