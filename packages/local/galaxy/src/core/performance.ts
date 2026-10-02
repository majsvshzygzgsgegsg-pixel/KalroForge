/** Performance mode: decide automatically, or force it on or off. */
export type PerformanceMode = 'auto' | 'on' | 'off'

/** Below this frame rate the scene is considered struggling. */
export const LOW_FPS = 45
/** How long the frame rate must stay low before degrading, seconds. */
export const LOW_FPS_SECONDS = 3
/** Frame-rate sample window, seconds. */
const SAMPLE_SECONDS = 0.5
/** A frame longer than this is a pause (tab switch, debugger), not slowness. */
const PAUSE_SECONDS = 0.25

/**
 * Watches frame times and trips once the frame rate stays under {@link LOW_FPS}
 * for {@link LOW_FPS_SECONDS}. Tripping is sticky so the scene never flickers
 * between layouts.
 */
export class PerformanceMonitor {
  mode: PerformanceMode
  private tripped = false
  private sampleFrames = 0
  private sampleTime = 0
  private lowTime = 0
  private lastFps = 60

  constructor(mode: PerformanceMode = 'auto') {
    this.mode = mode
  }

  /**
   * Record one frame.
   * @param dt - real elapsed seconds since the previous frame.
   * @returns whether the scene should run degraded.
   */
  sample(dt: number): boolean {
    if (this.mode !== 'auto' || this.tripped) return this.degraded
    if (!(dt > 0) || dt > PAUSE_SECONDS) {
      this.sampleFrames = 0
      this.sampleTime = 0
      return this.degraded
    }
    this.sampleFrames += 1
    this.sampleTime += dt
    if (this.sampleTime >= SAMPLE_SECONDS) {
      this.lastFps = this.sampleFrames / this.sampleTime
      this.lowTime = this.lastFps < LOW_FPS ? this.lowTime + this.sampleTime : 0
      this.sampleFrames = 0
      this.sampleTime = 0
      if (this.lowTime >= LOW_FPS_SECONDS) this.tripped = true
    }
    return this.degraded
  }

  /** Whether the scene should run degraded right now. */
  get degraded(): boolean {
    return this.mode === 'on' || (this.mode === 'auto' && this.tripped)
  }

  /** Frame rate of the last complete sample window. */
  get fps(): number {
    return this.lastFps
  }
}
