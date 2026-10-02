import { bandLevels } from '../core/audio.ts'
import type { AudioLevels } from '../core/orb-motion.ts'

/** Which voice a tap listens to. */
export type AudioKind = 'mic' | 'playback'

/** Something the galaxy can listen to. */
export type AudioSource = MediaStream | HTMLMediaElement

interface Tap {
  readonly source: MediaStreamAudioSourceNode
  readonly analyser: AnalyserNode
  readonly bins: Uint8Array<ArrayBuffer>
}

interface CapturableMedia extends HTMLMediaElement {
  captureStream?: () => MediaStream
  mozCaptureStream?: () => MediaStream
}

function streamOf(source: AudioSource): MediaStream | undefined {
  if (source instanceof MediaStream) return source
  const media = source as CapturableMedia
  return media.captureStream?.() ?? media.mozCaptureStream?.()
}

/**
 * Analyser taps on the mic and playback streams. A tap only reads: it never
 * connects to the destination and never re-routes a media element, so what the
 * user hears is unchanged.
 */
export class AudioTaps {
  private context: AudioContext | undefined
  private readonly taps = new Map<AudioKind, Tap>()

  /**
   * Start listening to a source; replaces any earlier tap of the same kind.
   * @param kind - mic or playback.
   * @param source - stream, or a media element that supports captureStream.
   * @returns whether the tap is live.
   */
  connect(kind: AudioKind, source: AudioSource): boolean {
    const stream = streamOf(source)
    if (stream === undefined || stream.getAudioTracks().length === 0) return false
    this.disconnect(kind)
    this.context ??= new AudioContext()
    if (this.context.state === 'suspended') void this.context.resume()
    const node = this.context.createMediaStreamSource(stream)
    const analyser = this.context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.5
    node.connect(analyser)
    this.taps.set(kind, { source: node, analyser, bins: new Uint8Array(analyser.frequencyBinCount) })
    return true
  }

  /**
   * Stop listening to one kind.
   * @param kind - mic or playback.
   */
  disconnect(kind: AudioKind): void {
    const tap = this.taps.get(kind)
    if (tap === undefined) return
    tap.source.disconnect()
    tap.analyser.disconnect()
    this.taps.delete(kind)
  }

  /**
   * Whether a real source is attached.
   * @param kind - mic or playback.
   * @returns true when tapped.
   */
  has(kind: AudioKind): boolean {
    return this.taps.has(kind)
  }

  /**
   * Read the current frequency frame.
   * @param kind - mic or playback.
   * @returns raw levels, or undefined without a tap.
   */
  read(kind: AudioKind): AudioLevels | undefined {
    const tap = this.taps.get(kind)
    if (tap === undefined) return undefined
    tap.analyser.getByteFrequencyData(tap.bins)
    return bandLevels(tap.bins)
  }

  /** Disconnect every tap and close the audio context. */
  dispose(): void {
    this.disconnect('mic')
    this.disconnect('playback')
    void this.context?.close()
    this.context = undefined
  }
}
