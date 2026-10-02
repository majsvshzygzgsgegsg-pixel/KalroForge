/** Linear-light RGB, each channel 0..1. This is what shaders receive. */
export type RGB = readonly [number, number, number]

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
}

/**
 * Parse `#rgb` or `#rrggbb` into linear-light RGB.
 * @param hex - colour in hex notation.
 * @returns linear-light channels.
 */
export function hexToLinear(hex: string): RGB {
  let digits = hex.trim().replace(/^#/, '')
  if (digits.length === 3) digits = digits.replaceAll(/./g, '$&$&')
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) throw new Error(`Invalid hex colour: ${hex}`)
  const n = Number.parseInt(digits, 16)
  return [
    srgbChannelToLinear(((n >> 16) & 255) / 255),
    srgbChannelToLinear(((n >> 8) & 255) / 255),
    srgbChannelToLinear((n & 255) / 255),
  ]
}

/**
 * Linear blend of two colours.
 * @param a - start colour.
 * @param b - end colour.
 * @param t - blend factor, 0 gives `a`.
 * @returns the blended colour.
 */
export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
