import { describe, expect, it } from 'vitest'
import {
  bandLevels,
  boostMic,
  MIC_BOOST,
  MIC_FLOOR,
  smoothLevels,
  SYNTHETIC_PEAK,
  syntheticSpeech,
} from '../src/core/audio.ts'
import { SILENCE } from '../src/core/orb-motion.ts'

function binsWith(length: number, fill: (index: number) => number): number[] {
  return Array.from({ length }, (_, index) => fill(index))
}

describe('bandLevels', () => {
  it('reads voice from bins 10–60%, bass from the first 6, treble from 65% up', () => {
    const voiceOnly = bandLevels(binsWith(100, i => (i >= 10 && i < 60 ? 255 : 0)))
    expect(voiceOnly.level).toBeCloseTo(1)
    expect(voiceOnly.treble).toBe(0)

    const bassOnly = bandLevels(binsWith(100, i => (i < 6 ? 255 : 0)))
    expect(bassOnly.bass).toBeCloseTo(1)
    expect(bassOnly.level).toBe(0)

    const trebleOnly = bandLevels(binsWith(100, i => (i >= 65 ? 255 : 0)))
    expect(trebleOnly.treble).toBeCloseTo(1)
    expect(trebleOnly.level).toBe(0)
  })

  it('is silent for empty or zero frames', () => {
    expect(bandLevels([])).toEqual(SILENCE)
    expect(bandLevels(binsWith(256, () => 0))).toEqual(SILENCE)
  })
})

describe('boostMic', () => {
  it('boosts the voice level with a floor and clamps to 1', () => {
    expect(boostMic(SILENCE).level).toBeCloseTo(MIC_FLOOR)
    expect(boostMic({ level: 0.1, bass: 0, treble: 0 }).level).toBeCloseTo(MIC_FLOOR + 0.1 * MIC_BOOST)
    expect(boostMic({ level: 0.9, bass: 0.9, treble: 0.9 })).toEqual({ level: 1, bass: 1, treble: 1 })
  })
})

describe('smoothLevels', () => {
  it('attacks faster than it decays', () => {
    const rising = smoothLevels(SILENCE, { level: 1, bass: 1, treble: 1 }, 1 / 60)
    const falling = smoothLevels({ level: 1, bass: 1, treble: 1 }, SILENCE, 1 / 60)
    expect(rising.level).toBeCloseTo(0.45)
    expect(1 - falling.level).toBeCloseTo(0.08)
  })

  it('is frame-rate independent', () => {
    const target = { level: 0.8, bass: 0.4, treble: 0.2 }
    let at60 = { ...SILENCE }
    let at30 = { ...SILENCE }
    for (let i = 0; i < 60; i++) at60 = smoothLevels(at60, target, 1 / 60)
    for (let i = 0; i < 30; i++) at30 = smoothLevels(at30, target, 1 / 30)
    expect(at30.level).toBeCloseTo(at60.level, 6)
    expect(at30.bass).toBeCloseTo(at60.bass, 6)
  })
})

describe('syntheticSpeech', () => {
  const samples = binsWith(2400, i => i / 120).map(t => syntheticSpeech(t))

  it('is deterministic', () => {
    expect(syntheticSpeech(3.217)).toEqual(syntheticSpeech(3.217))
  })

  it('stays within a realistic speaking range', () => {
    for (const sample of samples) {
      expect(sample.level).toBeGreaterThanOrEqual(0)
      expect(sample.level).toBeLessThanOrEqual(SYNTHETIC_PEAK + 1e-9)
      expect(sample.bass).toBeLessThanOrEqual(sample.level + 1e-9)
    }
  })

  it('has syllables and pauses rather than a steady tone', () => {
    const levels = samples.map(sample => sample.level)
    const quiet = levels.filter(level => level < 0.03).length / levels.length
    const loud = levels.filter(level => level > SYNTHETIC_PEAK * 0.5).length / levels.length
    expect(quiet).toBeGreaterThan(0.1)
    expect(loud).toBeGreaterThan(0.1)
  })
})
