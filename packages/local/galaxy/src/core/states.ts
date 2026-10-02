import { hexToLinear, mixRGB, type RGB } from './color.ts'
import { easeFactor } from './easing.ts'

/** What the AI is doing, as the face shows it. */
export type OrbState = 'idle' | 'arming' | 'listening' | 'processing' | 'speaking' | 'error'

/** Every state, in display order. */
export const ORB_STATES: readonly OrbState[] = ['idle', 'arming', 'listening', 'processing', 'speaking', 'error']

/** Every visual parameter that varies by state. Defined for every state in {@link buildStateTable} only. */
export interface VisualParams {
  /** Main wireframe colour. */
  colorA: RGB
  /** Secondary colour: outward-pushed parts of the mesh. */
  colorB: RGB
  /** Colour the main colour drifts toward on a slow cycle (processing). */
  cycleColor: RGB
  /** How far the main colour drifts toward {@link VisualParams.cycleColor}, 0..1. */
  cycle: number
  /** Overall orb opacity. */
  opacity: number
  /** Fresnel exponent. Higher is a thinner, sharper edge. */
  fresnelPower: number
  /** Speed of the noise field's evolution, in noise units per second. */
  noiseSpeed: number
  /** Baseline displacement when nothing is happening. */
  baseDisplacement: number
  /** How strongly audio drives displacement. */
  amplitude: number
  /** Glow shell intensity. */
  glow: number
  /** Small rhythmic glow and scale pulse, 0..1 (processing). */
  pulse: number
  /** Orb rotation speed, rad/s. */
  rotationSpeed: number
  /** Orbital ring opacity. */
  ringOpacity: number
  /** How much the AI's voice drives the star network and sky, 0..1. Listening is the user's voice: 0. */
  galaxyResponse: number
}

/** One full parameter set per state. */
export type StateTable = Record<OrbState, VisualParams>

/** Colours a host may override. */
export interface Palette {
  /** The accent colour, used for idle and speaking. */
  accent: string
}

/** Calm teal accent. */
export const DEFAULT_PALETTE: Palette = { accent: '#3cc8b4' }

/**
 * Build the state table: the single place every per-state visual target lives.
 * @param palette - accent override.
 * @returns targets for every state.
 */
export function buildStateTable(palette: Palette = DEFAULT_PALETTE): StateTable {
  const accent = hexToLinear(palette.accent)
  const ice = hexToLinear('#7fe0ff')
  const purple = hexToLinear('#8a5cff')
  const none = { cycleColor: accent, cycle: 0, pulse: 0 }
  return {
    idle: {
      ...none,
      colorA: accent,
      colorB: ice,
      opacity: 0.5,
      fresnelPower: 2.2,
      noiseSpeed: 0.18,
      baseDisplacement: 0.012,
      amplitude: 0.35,
      glow: 0.32,
      rotationSpeed: 0.06,
      ringOpacity: 0,
      galaxyResponse: 0,
    },
    arming: {
      ...none,
      colorA: hexToLinear('#b8562a'),
      colorB: hexToLinear('#e08a4a'),
      opacity: 0.42,
      fresnelPower: 2.4,
      noiseSpeed: 0.22,
      baseDisplacement: 0.03,
      amplitude: 0.3,
      glow: 0.26,
      rotationSpeed: 0.07,
      ringOpacity: 0,
      galaxyResponse: 0,
    },
    listening: {
      ...none,
      colorA: hexToLinear('#ffc23a'),
      colorB: hexToLinear('#fff0b8'),
      opacity: 0.85,
      fresnelPower: 1.8,
      noiseSpeed: 0.4,
      baseDisplacement: 0.05,
      amplitude: 0.95,
      glow: 0.9,
      rotationSpeed: 0.1,
      ringOpacity: 0,
      galaxyResponse: 0,
    },
    processing: {
      colorA: accent,
      colorB: ice,
      cycleColor: purple,
      cycle: 1,
      pulse: 1,
      opacity: 0.7,
      fresnelPower: 2,
      noiseSpeed: 0.45,
      baseDisplacement: 0.06,
      amplitude: 0.5,
      glow: 0.55,
      rotationSpeed: 0.32,
      ringOpacity: 0.55,
      galaxyResponse: 0.6,
    },
    speaking: {
      ...none,
      colorA: hexToLinear('#5cf2dc'),
      colorB: ice,
      opacity: 0.85,
      fresnelPower: 1.9,
      noiseSpeed: 0.38,
      baseDisplacement: 0.04,
      amplitude: 1,
      glow: 0.8,
      rotationSpeed: 0.14,
      ringOpacity: 0,
      galaxyResponse: 1,
    },
    error: {
      ...none,
      colorA: hexToLinear('#ff3b4e'),
      colorB: hexToLinear('#ff8a8a'),
      opacity: 0.8,
      fresnelPower: 3.6,
      noiseSpeed: 0.04,
      baseDisplacement: 0.01,
      amplitude: 0.1,
      glow: 0.4,
      rotationSpeed: 0.015,
      ringOpacity: 0,
      galaxyResponse: 0,
    },
  }
}

/**
 * Fresh copy of a parameter set.
 * @param params - source parameters.
 * @returns an independent copy.
 */
export function cloneParams(params: VisualParams): VisualParams {
  return { ...params, colorA: [...params.colorA], colorB: [...params.colorB], cycleColor: [...params.cycleColor] }
}

/**
 * Move every parameter of `current` part of the way toward `target`, in place.
 * @param current - parameters being eased (mutated).
 * @param target - destination state.
 * @param rate - fraction of remaining distance covered per 1/60 s.
 * @param dt - elapsed seconds.
 * @returns `current`.
 */
export function approachParams(current: VisualParams, target: VisualParams, rate: number, dt: number): VisualParams {
  const k = easeFactor(rate, dt)
  for (const key of NUMBER_KEYS) current[key] += (target[key] - current[key]) * k
  for (const key of COLOR_KEYS) current[key] = mixRGB(current[key], target[key], k)
  return current
}

type NumberKey = { [K in keyof VisualParams]: VisualParams[K] extends number ? K : never }[keyof VisualParams]
type ColorKey = Exclude<keyof VisualParams, NumberKey>

const COLOR_KEYS: readonly ColorKey[] = ['colorA', 'colorB', 'cycleColor']
const NUMBER_KEYS: readonly NumberKey[] = [
  'cycle',
  'opacity',
  'fresnelPower',
  'noiseSpeed',
  'baseDisplacement',
  'amplitude',
  'glow',
  'pulse',
  'rotationSpeed',
  'ringOpacity',
  'galaxyResponse',
]
