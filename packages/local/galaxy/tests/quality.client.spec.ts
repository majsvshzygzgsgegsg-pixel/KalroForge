import { describe, expect, it } from 'vitest'
import { motionSpeed, REDUCED_MOTION_SPEED } from '../src/core/motion.ts'
import { LOW_FPS_SECONDS, PerformanceMonitor } from '../src/core/performance.ts'
import { ORB_STATES, STATE_LABELS } from '../src/core/states.ts'

function run(monitor: PerformanceMonitor, fps: number, seconds: number): boolean {
  let degraded = monitor.degraded
  for (let t = 0; t < seconds; t += 1 / fps) degraded = monitor.sample(1 / fps)
  return degraded
}

describe('PerformanceMonitor', () => {
  it('stays at full quality at a healthy frame rate', () => {
    expect(run(new PerformanceMonitor(), 60, 10)).toBe(false)
  })

  it('degrades only after the frame rate stays low for three seconds', () => {
    const monitor = new PerformanceMonitor()
    expect(run(monitor, 30, LOW_FPS_SECONDS - 0.6)).toBe(false)
    expect(run(monitor, 30, 1)).toBe(true)
  })

  it('forgives a short dip', () => {
    const monitor = new PerformanceMonitor()
    run(monitor, 30, 2)
    run(monitor, 60, 1)
    expect(run(monitor, 30, 2)).toBe(false)
  })

  it('is sticky once tripped', () => {
    const monitor = new PerformanceMonitor()
    run(monitor, 20, 4)
    expect(run(monitor, 120, 10)).toBe(true)
  })

  it('treats a long frame as a pause, not slowness', () => {
    const monitor = new PerformanceMonitor()
    for (let i = 0; i < 20; i++) monitor.sample(1)
    expect(monitor.degraded).toBe(false)
  })

  it('honours manual on and off', () => {
    const forced = new PerformanceMonitor('on')
    expect(run(forced, 120, 1)).toBe(true)
    const never = new PerformanceMonitor('off')
    expect(run(never, 10, 10)).toBe(false)
  })
})

describe('motionSpeed', () => {
  it('eases to the reduced speed and back without jumping', () => {
    let speed = 1
    let previous = speed
    for (let i = 0; i < 600; i++) {
      speed = motionSpeed(speed, true, 1 / 60)
      expect(previous - speed).toBeLessThan(0.05)
      previous = speed
    }
    expect(speed).toBeCloseTo(REDUCED_MOTION_SPEED, 3)
    for (let i = 0; i < 600; i++) speed = motionSpeed(speed, false, 1 / 60)
    expect(speed).toBeCloseTo(1, 3)
  })

  it('is frame-rate independent', () => {
    let at60 = 1
    let at30 = 1
    for (let i = 0; i < 60; i++) at60 = motionSpeed(at60, true, 1 / 60)
    for (let i = 0; i < 30; i++) at30 = motionSpeed(at30, true, 1 / 30)
    expect(at30).toBeCloseTo(at60, 6)
  })
})

describe('STATE_LABELS', () => {
  it('names every state for the live region', () => {
    for (const state of ORB_STATES) expect(STATE_LABELS[state].length).toBeGreaterThan(0)
  })
})
