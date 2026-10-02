import { describe, expect, it } from 'vitest'
import { galaxyResponse, PEAK_LINE_OPACITY, REST_LINE_OPACITY } from '../src/core/galaxy-response.ts'
import { buildNetworkLayout, LINK_DISTANCE } from '../src/core/network-layout.ts'
import { seededRandom } from '../src/core/random.ts'

describe('seeded random', () => {
  it('repeats exactly for the same seed and differs between seeds', () => {
    const a = seededRandom(7)
    const b = seededRandom(7)
    const c = seededRandom(8)
    const seqA = Array.from({ length: 5 }, a)
    expect(Array.from({ length: 5 }, b)).toEqual(seqA)
    expect(Array.from({ length: 5 }, c)).not.toEqual(seqA)
    for (const value of seqA) expect(value >= 0 && value < 1).toBe(true)
  })
})

describe('network layout', () => {
  it('is identical for the same seed', () => {
    expect(buildNetworkLayout({ seed: 42 })).toEqual(buildNetworkLayout({ seed: 42 }))
    expect(buildNetworkLayout({ seed: 42 })).not.toEqual(buildNetworkLayout({ seed: 43 }))
  })

  it('has eight clusters of 6–8 nodes on a 13–25 unit shell, about 100 nodes, and a dust shell', () => {
    const layout = buildNetworkLayout()
    expect(layout.nodes).toHaveLength(100)
    for (let cluster = 0; cluster < 8; cluster++) {
      const members = layout.nodes.filter(node => node.cluster === cluster)
      expect(members.length).toBeGreaterThanOrEqual(6)
      expect(members.length).toBeLessThanOrEqual(8)
      const centre = [0, 1, 2].map(axis => members.reduce((sum, node) => sum + (node.position[axis] ?? 0), 0) / members.length)
      const radius = Math.hypot(centre[0] ?? 0, centre[1] ?? 0, centre[2] ?? 0)
      expect(radius).toBeGreaterThan(9)
      expect(radius).toBeLessThan(29)
    }
    expect(layout.dust.length).toBeGreaterThan(200)
  })

  it('only links nodes closer than the link distance', () => {
    const layout = buildNetworkLayout()
    expect(layout.links.length).toBeGreaterThan(50)
    for (const [a, b] of layout.links) {
      const pa = layout.nodes[a]?.position ?? [0, 0, 0]
      const pb = layout.nodes[b]?.position ?? [0, 0, 0]
      expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2])).toBeLessThan(LINK_DISTANCE)
    }
  })

  it('thins to a subset of the same galaxy in performance mode', () => {
    const full = buildNetworkLayout()
    const thin = buildNetworkLayout({ density: 0.5 })
    expect(thin.nodes.length).toBeLessThan(full.nodes.length)
    expect(thin.nodes.length).toBeGreaterThan(25)
    expect(thin.dust.length).toBeLessThan(full.dust.length)
    const fullPositions = new Set(full.nodes.map(node => node.position.join(',')))
    for (const node of thin.nodes) expect(fullPositions.has(node.position.join(','))).toBe(true)
  })
})

describe('galaxy response', () => {
  it('stays at rest for the user voice and lights up with the AI voice', () => {
    const rest = galaxyResponse(0, 1)
    expect(rest.lineOpacity).toBe(REST_LINE_OPACITY)
    expect(rest.swell).toBe(1)
    const loud = galaxyResponse(1, 1)
    expect(loud.lineOpacity).toBeCloseTo(PEAK_LINE_OPACITY, 6)
    expect(loud.swell).toBeGreaterThan(1.03)
    expect(loud.swell).toBeLessThanOrEqual(1.05)
    expect(loud.shake).toBeLessThan(0.05)
    expect(galaxyResponse(1, 0.5).lineOpacity).toBeGreaterThan(galaxyResponse(1, 0.1).lineOpacity)
  })
})
