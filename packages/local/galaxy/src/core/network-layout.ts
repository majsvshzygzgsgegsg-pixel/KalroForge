import { hexToLinear, type RGB } from './color.ts'
import { seededRandom, type Random } from './random.ts'

/** One glowing node of the star network. */
export interface NetworkNode {
  readonly position: readonly [number, number, number]
  readonly color: RGB
  /** World-space sprite size. */
  readonly size: number
  /** Cluster index, or -1 for a stray. */
  readonly cluster: number
}

/** The whole network, ready to upload. */
export interface NetworkLayout {
  readonly nodes: readonly NetworkNode[]
  /** Index pairs into {@link NetworkLayout.nodes}. */
  readonly links: ReadonlyArray<readonly [number, number]>
  readonly dust: ReadonlyArray<readonly [number, number, number]>
}

/** Layout options. */
export interface NetworkLayoutOptions {
  readonly seed?: number
  /** Fraction of nodes and dust kept, 0..1. Performance mode uses less; the galaxy stays the same. */
  readonly density?: number
}

/** Cool cluster palette: teal, cyan, blue, purple, green-teal, indigo, blue-teal, violet. */
export const CLUSTER_HUES: readonly string[] = ['#2fd4b8', '#3ad8ff', '#3f7dff', '#9a5cff', '#3fe0a0', '#5a5cff', '#2fa8d8', '#c06cff']
const STRAY_HEX = '#6f86a8'
const CLUSTER_COUNT = 8
const TOTAL_NODES = 100
const DUST_COUNT = 360
/** Nodes closer than this are joined by a line. */
export const LINK_DISTANCE = 10
/** Default seed: the layout is identical for every run that uses it. */
export const DEFAULT_SEED = 0x6b46

function onSphere(random: Random): [number, number, number] {
  const z = random() * 2 - 1
  const angle = random() * Math.PI * 2
  const r = Math.sqrt(1 - z * z)
  return [r * Math.cos(angle), r * Math.sin(angle), z]
}

function scale(v: readonly [number, number, number], s: number): [number, number, number] {
  return [v[0] * s, v[1] * s, v[2] * s]
}

function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/**
 * Build the seeded star network: eight coloured clusters on a 13–25 unit shell,
 * stray nodes filling out about 100 in total, faint links under {@link LINK_DISTANCE},
 * and a dust shell. The random sequence never depends on `density`, so a thinner
 * layout is the same galaxy with fewer points.
 * @param options - seed and density.
 * @returns the layout.
 */
export function buildNetworkLayout(options: NetworkLayoutOptions = {}): NetworkLayout {
  const random = seededRandom(options.seed ?? DEFAULT_SEED)
  const density = Math.min(1, Math.max(0, options.density ?? 1))
  const all: NetworkNode[] = []

  for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) {
    const center = scale(onSphere(random), 13 + random() * 12)
    const count = 6 + Math.floor(random() * 3)
    const color = hexToLinear(CLUSTER_HUES[cluster % CLUSTER_HUES.length] ?? STRAY_HEX)
    for (let i = 0; i < count; i++) {
      const offset = scale(onSphere(random), Math.pow(random(), 0.7) * 3.6)
      all.push({
        position: [center[0] + offset[0], center[1] + offset[1], center[2] + offset[2]],
        color,
        size: 0.9 + random() * 0.9,
        cluster,
      })
    }
  }
  const stray = hexToLinear(STRAY_HEX)
  while (all.length < TOTAL_NODES) {
    all.push({ position: scale(onSphere(random), 6 + random() * 24), color: stray, size: 0.5 + random() * 0.5, cluster: -1 })
  }
  const allDust: Array<[number, number, number]> = []
  for (let i = 0; i < DUST_COUNT; i++) allDust.push(scale(onSphere(random), 55 + random() * 70))
  // One keep-roll per point, drawn after everything else so density never shifts the layout.
  const keepNode = all.map(() => random())
  const keepDust = allDust.map(() => random())

  const nodes = all.filter((_node, index) => (keepNode[index] ?? 1) < density || density >= 1)
  const dust = allDust.filter((_point, index) => (keepDust[index] ?? 1) < density || density >= 1)
  const links: Array<readonly [number, number]> = []
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const na = nodes[a]
      const nb = nodes[b]
      if (na !== undefined && nb !== undefined && distance(na.position, nb.position) < LINK_DISTANCE) links.push([a, b])
    }
  }
  return { nodes, links, dust }
}
