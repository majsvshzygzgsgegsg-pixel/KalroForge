import { easeFactor, clamp01 } from './easing.ts'
import type { AudioLevels } from './orb-motion.ts'

/** Mic gain so the orb answers normal speaking volume. */
export const MIC_BOOST = 2.4
/** Mic floor so the orb never looks dead between syllables. */
export const MIC_FLOOR = 0.03
/** Smoothing rates per 1/60 s: fast attack, slow decay. */
export const ATTACK = 0.45
export const DECAY = 0.08
/** Synthetic speech peak, matching what an analyser reads from ordinary speech. */
export const SYNTHETIC_PEAK = 0.42

function average(bins: ArrayLike<number>, from: number, to: number): number {
  const start = Math.max(0, Math.floor(from))
  const end = Math.min(bins.length, Math.ceil(to))
  if (end <= start) return 0
  let sum = 0
  for (let i = start; i < end; i++) sum += bins[i] ?? 0
  return sum / (end - start) / 255
}

/**
 * Read one analyser frame: voice is bins 10–60%, bass the first 6 bins, treble 65% and up.
 * @param bins - byte frequency data, 0..255 per bin.
 * @returns raw levels, 0..1.
 */
export function bandLevels(bins: ArrayLike<number>): AudioLevels {
  const n = bins.length
  return {
    level: average(bins, n * 0.1, n * 0.6),
    bass: average(bins, 0, Math.min(6, n)),
    treble: average(bins, n * 0.65, n),
  }
}

/**
 * Boost mic levels with a small floor.
 * @param levels - raw mic levels.
 * @returns boosted levels.
 */
export function boostMic(levels: AudioLevels): AudioLevels {
  return {
    level: clamp01(MIC_FLOOR + levels.level * MIC_BOOST),
    bass: clamp01(levels.bass * MIC_BOOST * 0.8),
    treble: clamp01(levels.treble * MIC_BOOST),
  }
}

function smoothChannel(current: number, target: number, dt: number): number {
  const rate = target > current ? ATTACK : DECAY
  return current + (target - current) * easeFactor(rate, dt)
}

/**
 * Fast attack, slow decay, frame-rate independent: the orb breathes instead of twitching.
 * @param current - previous smoothed levels.
 * @param target - this frame's raw levels.
 * @param dt - elapsed seconds.
 * @returns new smoothed levels.
 */
export function smoothLevels(current: AudioLevels, target: AudioLevels, dt: number): AudioLevels {
  return {
    level: smoothChannel(current.level, target.level, dt),
    bass: smoothChannel(current.bass, target.bass, dt),
    treble: smoothChannel(current.treble, target.treble, dt),
  }
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/**
 * A deterministic envelope that looks like speech: syllables at ~4–6 Hz, words,
 * and phrase-length pauses. Used when no real audio is available.
 * @param t - seconds.
 * @returns levels, 0..1.
 */
export function syntheticSpeech(t: number): AudioLevels {
  const syllableRate = 4.6
  const s = t * syllableRate
  const index = Math.floor(s)
  const phase = s - index
  const syllable = Math.pow(Math.sin(Math.PI * phase), 1.6) * (0.45 + 0.55 * hash(index))
  const word = hash(Math.floor(s / 3.3) + 17) < 0.18 ? 0.15 : 1
  const phraseT = t / 4.2
  const phrase = phraseT - Math.floor(phraseT) > 0.86 ? 0.05 : 1
  const level = clamp01(syllable * word * phrase * SYNTHETIC_PEAK)
  return {
    level,
    bass: clamp01(level * (0.55 + 0.35 * hash(index + 5))),
    treble: clamp01(level * (0.25 + 0.35 * hash(index + 9))),
  }
}
