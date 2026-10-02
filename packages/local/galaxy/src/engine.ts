import { WebGLRenderer } from 'three'
import { AudioTaps, type AudioKind, type AudioSource } from './audio/tap.ts'
import { boostMic, smoothLevels, syntheticSpeech } from './core/audio.ts'
import { mixRGB } from './core/color.ts'
import { galaxyResponse } from './core/galaxy-response.ts'
import { buildNetworkLayout, DEFAULT_SEED } from './core/network-layout.ts'
import { highOctaveMix, orbActivity, orbScale, SILENCE, type AudioLevels } from './core/orb-motion.ts'
import { approachParams, buildStateTable, cloneParams, DEFAULT_PALETTE, type OrbState } from './core/states.ts'
import { NetworkLayer } from './render/network.ts'
import { OrbLayer } from './render/orb.ts'
import { SkyLayer } from './render/sky.ts'

/** Options for {@link createGalaxy}. */
export interface GalaxyOptions {
  /** Accent colour as hex. Defaults to a calm teal. */
  readonly accent?: string
  /** Star-network seed: the same seed always draws the same galaxy. */
  readonly seed?: number
  /** Initial state. */
  readonly state?: OrbState
  /** Use a speech-like synthetic envelope when no real audio is available (default true). */
  readonly syntheticAudio?: boolean
}

/** A running galaxy scene. */
export interface Galaxy {
  readonly canvas: HTMLCanvasElement
  /** Current target state. */
  getState(): OrbState
  /** Ease toward another state; nothing snaps. */
  setState(state: OrbState): void
  /**
   * Tap a mic or playback source. Read-only: what the user hears is unchanged.
   * @returns whether the tap is live.
   */
  connectAudio(kind: AudioKind, source: AudioSource): boolean
  /** Stop tapping one kind; the synthetic envelope takes over. */
  disconnectAudio(kind: AudioKind): void
  /** Feed levels from an engine that reports its own (null clears it). */
  setAudioLevels(kind: AudioKind, levels: AudioLevels | null): void
  /** Which source drove the last frame: a real tap, external levels, synthetic, or none. */
  getAudioSource(): 'tap' | 'external' | 'synthetic' | 'none'
  /** Stop the loop and release every GPU, audio and DOM resource. */
  destroy(): void
}

const MAX_PIXEL_RATIO = 2
const ORB_DETAIL = 24
/** Fraction of remaining distance covered per 1/60 s when easing between states. */
const STATE_EASE_RATE = 0.06
const MAX_FRAME_DT = 0.1
/** Resting network rotation, rad/s. */
const NETWORK_ROTATION = 0.012

/**
 * Mount a galaxy into a container.
 * @param container - element the canvas fills.
 * @param options - appearance options.
 * @returns the running scene.
 */
export function createGalaxy(container: HTMLElement, options: GalaxyOptions = {}): Galaxy {
  const table = buildStateTable({ ...DEFAULT_PALETTE, accent: options.accent ?? DEFAULT_PALETTE.accent })
  let state: OrbState = options.state ?? 'idle'
  const params = cloneParams(table[state])
  const synthetic = options.syntheticAudio ?? true

  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.setAttribute('aria-hidden', 'true')
  container.append(canvas)

  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
  renderer.setClearColor(0x03050b, 1)
  renderer.autoClear = false

  const sky = new SkyLayer()
  const network = new NetworkLayer(buildNetworkLayout({ seed: options.seed ?? DEFAULT_SEED }))
  const orb = new OrbLayer(ORB_DETAIL)
  const taps = new AudioTaps()
  const external = new Map<AudioKind, AudioLevels>()

  const resize = (): void => {
    const width = Math.max(1, container.clientWidth)
    const height = Math.max(1, container.clientHeight)
    renderer.setSize(width, height, false)
    const pixelRatio = renderer.getPixelRatio()
    sky.setSize(width * pixelRatio, height * pixelRatio)
    network.setViewport(width / height, pixelRatio)
    orb.setAspect(width / height)
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)
  resize()

  // Speeds integrate into phases so a speed change never makes a phase jump.
  const clock = { anim: 0, noise: 0, push: 0, rotation: 0, ring: 0, network: 0 }
  let audio: AudioLevels = { ...SILENCE }
  let audioSource: 'tap' | 'external' | 'synthetic' | 'none' = 'none'

  const rawAudio = (): AudioLevels => {
    const kind: AudioKind | undefined = state === 'listening' ? 'mic' : state === 'speaking' ? 'playback' : undefined
    if (kind === undefined) {
      audioSource = 'none'
      return SILENCE
    }
    const fed = external.get(kind)
    if (fed !== undefined) {
      audioSource = 'external'
      return fed
    }
    const tapped = taps.read(kind)
    if (tapped !== undefined) {
      audioSource = 'tap'
      return kind === 'mic' ? boostMic(tapped) : tapped
    }
    audioSource = synthetic ? 'synthetic' : 'none'
    return synthetic ? syntheticSpeech(clock.anim) : SILENCE
  }

  let last = performance.now()
  let raf = 0
  let destroyed = false

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_FRAME_DT)
    last = now

    approachParams(params, table[state], STATE_EASE_RATE, dt)
    audio = smoothLevels(audio, rawAudio(), dt)

    clock.anim += dt
    clock.noise += dt * params.noiseSpeed
    clock.push += dt * (2 + audio.bass * 6)
    clock.rotation += dt * params.rotationSpeed
    clock.ring += dt

    const cycle = params.cycle * (0.5 + 0.5 * Math.sin(clock.anim * 0.45))
    const colorA = mixRGB(params.colorA, params.cycleColor, cycle)
    const pulse = params.pulse * Math.sin(clock.anim * 2.4)

    orb.update({
      colorA,
      colorB: params.colorB,
      opacity: params.opacity,
      fresnelPower: params.fresnelPower,
      glow: params.glow * (1 + pulse * 0.18),
      ringOpacity: params.ringOpacity,
      noiseTime: clock.noise,
      activity: orbActivity(params.baseDisplacement, params.amplitude, audio, clock.anim),
      highMix: highOctaveMix(audio),
      bass: audio.bass,
      pushPhase: clock.push,
      scale: orbScale(audio) * (1 + pulse * 0.012),
      rotationY: clock.rotation,
      rotationX: Math.sin(clock.anim * 0.11) * 0.18,
      ringPhase: clock.ring,
    })

    const drive = galaxyResponse(params.galaxyResponse, audio.level)
    clock.network += dt * NETWORK_ROTATION * drive.rotationBoost
    network.update({
      rotation: clock.network,
      time: clock.anim,
      lineOpacity: drive.lineOpacity,
      nodeBrightness: drive.nodeBrightness,
      nodeSize: drive.nodeSize,
      swell: drive.swell,
      push: drive.push,
      shake: drive.shake,
    })
    sky.update({ time: clock.anim, bloomColor: colorA, bloom: params.glow + drive.bloomBoost, nebulaBoost: drive.nebulaBoost })

    renderer.clear()
    renderer.render(sky.scene, sky.camera)
    renderer.render(network.scene, network.camera)
    renderer.clearDepth()
    renderer.render(orb.scene, orb.camera)
  }
  raf = requestAnimationFrame(frame)

  return {
    canvas,
    getState: () => state,
    setState(next: OrbState): void {
      state = next
    },
    connectAudio: (kind, source) => taps.connect(kind, source),
    disconnectAudio(kind): void {
      taps.disconnect(kind)
    },
    setAudioLevels(kind, levels): void {
      if (levels === null) external.delete(kind)
      else external.set(kind, levels)
    },
    getAudioSource: () => audioSource,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      taps.dispose()
      orb.dispose()
      network.dispose()
      sky.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
