import { describe, expect, it } from 'vitest'
import { hexToLinear, mixRGB } from '../src/core/color.ts'
import { approach, easeFactor } from '../src/core/easing.ts'
import { breath, BREATH_DEPTH, highOctaveMix, orbActivity, orbScale, SILENCE } from '../src/core/orb-motion.ts'
import { approachParams, buildStateTable, cloneParams, ORB_STATES } from '../src/core/states.ts'

describe('easing', () => {
  it('is zero for no elapsed time and never exceeds one', () => {
    expect(easeFactor(0.1, 0)).toBe(0)
    expect(easeFactor(0.1, -1)).toBe(0)
    expect(easeFactor(0.5, 100)).toBeLessThanOrEqual(1)
    expect(easeFactor(1, 1 / 60)).toBe(1)
  })

  it('covers exactly `rate` of the distance in one 1/60 s frame', () => {
    expect(easeFactor(0.1, 1 / 60)).toBeCloseTo(0.1, 12)
  })

  it('lands in the same place after 60 small steps and 30 double-length steps', () => {
    let a = 0
    for (let i = 0; i < 60; i++) a = approach(a, 1, 0.08, 1 / 60)
    let b = 0
    for (let i = 0; i < 30; i++) b = approach(b, 1, 0.08, 1 / 30)
    expect(a).toBeCloseTo(b, 10)
  })

  it('lands in the same place at 120 fps and with irregular frames', () => {
    let a = 5
    for (let i = 0; i < 240; i++) a = approach(a, -3, 0.05, 1 / 120)
    let b = 5
    for (const dt of [0.01, 0.03, 0.005, 0.2, 0.755, 1]) b = approach(b, -3, 0.05, dt)
    expect(a).toBeCloseTo(b, 10)
  })

  it('moves monotonically toward the target without overshoot', () => {
    let value = 0
    let previous = value
    for (let i = 0; i < 200; i++) {
      value = approach(value, 1, 0.2, 1 / 60)
      expect(value).toBeGreaterThanOrEqual(previous)
      expect(value).toBeLessThanOrEqual(1)
      previous = value
    }
  })
})

describe('colour', () => {
  it('converts sRGB hex to linear light', () => {
    expect(hexToLinear('#000')).toEqual([0, 0, 0])
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1])
    expect(hexToLinear('#808080')[0]).toBeCloseTo(0.2159, 3)
    expect(() => hexToLinear('teal')).toThrow()
  })

  it('mixes linearly', () => {
    expect(mixRGB([0, 0, 0], [1, 0.5, 0.25], 0.5)).toEqual([0.5, 0.25, 0.125])
  })
})

describe('orb motion', () => {
  it('barely ripples at rest and stays within the breath depth', () => {
    for (let t = 0; t < 20; t += 0.37) {
      expect(breath(t)).toBeGreaterThanOrEqual(0)
      expect(breath(t)).toBeLessThanOrEqual(BREATH_DEPTH)
    }
    const idle = buildStateTable().idle
    expect(orbActivity(idle.baseDisplacement, idle.amplitude, SILENCE, 0)).toBeLessThan(0.07)
  })

  it('grows with voice and bass, and only enables fine detail with audio', () => {
    const loud = { level: 0.8, bass: 0.6, treble: 0.3 }
    expect(orbActivity(0.03, 1, loud, 0)).toBeGreaterThan(orbActivity(0.03, 1, SILENCE, 0) + 0.5)
    expect(highOctaveMix(SILENCE)).toBe(0)
    expect(highOctaveMix(loud)).toBe(1)
    expect(orbScale(SILENCE)).toBe(1)
    expect(orbScale(loud)).toBeGreaterThan(1.05)
  })
})

describe('state table', () => {
  const table = buildStateTable()

  it('defines every parameter for every state', () => {
    const keys = Object.keys(table.idle).toSorted()
    for (const state of ORB_STATES) {
      expect(Object.keys(table[state]).toSorted()).toEqual(keys)
      for (const value of Object.values(table[state])) {
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
        else expect(value).toHaveLength(3)
      }
    }
  })

  it('keeps listening as the only warm, galaxy-silent state and lets the AI voice drive the galaxy', () => {
    expect(table.listening.galaxyResponse).toBe(0)
    expect(table.speaking.galaxyResponse).toBe(1)
    expect(table.processing.ringOpacity).toBeGreaterThan(0)
    for (const state of ORB_STATES) if (state !== 'processing') expect(table[state].ringOpacity).toBe(0)
    const [r, g, b] = table.listening.colorA
    expect(r).toBeGreaterThan(b)
    expect(g).toBeGreaterThan(b)
  })

  it('eases parameters toward the target without mutating the table', () => {
    const target = table.speaking
    const snapshot = JSON.stringify(target)
    const current = cloneParams(table.idle)
    for (let i = 0; i < 600; i++) approachParams(current, target, 0.06, 1 / 60)
    expect(current.opacity).toBeCloseTo(target.opacity, 6)
    expect(current.colorA[0]).toBeCloseTo(target.colorA[0], 6)
    expect(JSON.stringify(target)).toBe(snapshot)
  })

  it('changes state visibly within about a second', () => {
    const current = cloneParams(table.idle)
    for (let i = 0; i < 60; i++) approachParams(current, table.listening, 0.06, 1 / 60)
    const covered = (current.glow - table.idle.glow) / (table.listening.glow - table.idle.glow)
    expect(covered).toBeGreaterThan(0.95)
  })

  it('applies a custom accent', () => {
    expect(buildStateTable({ accent: '#ff0000' }).idle.colorA).toEqual([1, 0, 0])
  })
})
