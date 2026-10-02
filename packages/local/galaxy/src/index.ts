/**
 * KairoForge's living galaxy: one renderer, one WebGL context. The maths in
 * `core/` is pure and unit-tested; `render/` only draws numbers it is given.
 */
export { createGalaxy, type Galaxy, type GalaxyOptions, type GalaxyPerformance } from './engine.ts'
export { AudioTaps, type AudioKind, type AudioSource } from './audio/tap.ts'
export { ATTACK, bandLevels, boostMic, DECAY, MIC_BOOST, MIC_FLOOR, smoothLevels, SYNTHETIC_PEAK, syntheticSpeech } from './core/audio.ts'
export { motionSpeed, REDUCED_MOTION_SPEED } from './core/motion.ts'
export { LOW_FPS, LOW_FPS_SECONDS, PerformanceMonitor, type PerformanceMode } from './core/performance.ts'
export { galaxyResponse, PEAK_LINE_OPACITY, REST_LINE_OPACITY, type GalaxyResponse } from './core/galaxy-response.ts'
export { buildNetworkLayout, CLUSTER_HUES, DEFAULT_SEED, LINK_DISTANCE, type NetworkLayout, type NetworkNode } from './core/network-layout.ts'
export { seededRandom, type Random } from './core/random.ts'
export { hexToLinear, mixRGB, type RGB } from './core/color.ts'
export { approach, clamp, clamp01, easeFactor } from './core/easing.ts'
export { breath, highOctaveMix, MAX_DISPLACEMENT, orbActivity, orbScale, SILENCE, type AudioLevels } from './core/orb-motion.ts'
export {
  approachParams,
  buildStateTable,
  cloneParams,
  DEFAULT_PALETTE,
  ORB_STATES,
  STATE_LABELS,
  type OrbState,
  type Palette,
  type StateTable,
  type VisualParams,
} from './core/states.ts'
