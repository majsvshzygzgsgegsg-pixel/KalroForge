import { approach } from './easing.ts'

/** Animation speed under reduced motion: everything still lives, just slowly. */
export const REDUCED_MOTION_SPEED = 0.25
/** How quickly the animation clock changes speed when the preference flips. */
const MOTION_EASE_RATE = 0.05

/**
 * Ease the animation clock's speed toward its target. Phases integrate this speed,
 * so switching reduced motion slows things down without any phase jump — unlike
 * multiplying absolute time, which would make every phase leap.
 * @param current - current clock speed.
 * @param reduced - whether reduced motion is wanted.
 * @param dt - real elapsed seconds.
 * @returns new clock speed.
 */
export function motionSpeed(current: number, reduced: boolean, dt: number): number {
  return approach(current, reduced ? REDUCED_MOTION_SPEED : 1, MOTION_EASE_RATE, dt)
}
