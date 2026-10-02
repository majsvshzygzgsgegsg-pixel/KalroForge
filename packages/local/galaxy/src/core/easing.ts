/**
 * Clamp a value into a range.
 * @param value - input.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns the clamped value.
 */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Clamp a value into 0..1.
 * @param value - input.
 * @returns the clamped value.
 */
export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/**
 * Fraction of the remaining distance to cover this frame.
 *
 * `rate` is the fraction covered per reference frame of 1/60 s. Raising the
 * complement to the number of reference frames that elapsed makes the result
 * independent of frame rate: two 1/60 s steps land exactly where one 1/30 s step does.
 * @param rate - fraction per 1/60 s.
 * @param dt - elapsed seconds.
 * @returns fraction to cover now.
 */
export function easeFactor(rate: number, dt: number): number {
  if (dt <= 0) return 0
  const r = clamp01(rate)
  if (r >= 1) return 1
  return 1 - Math.pow(1 - r, dt * 60)
}

/**
 * Move a value part of the way toward a target.
 * @param current - present value.
 * @param target - destination.
 * @param rate - fraction per 1/60 s.
 * @param dt - elapsed seconds.
 * @returns the eased value.
 */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * easeFactor(rate, dt)
}
