/**
 * Thin React wrapper around the framework-free galaxy engine. One engine per
 * mounted view; state changes ease inside the engine; unmount destroys the
 * WebGL context so repeated navigation never leaks contexts.
 */
import { useEffect, useRef } from 'react'
import { createGalaxy, type Galaxy, type OrbState, type PerformanceMode } from '@local/galaxy'

/** Galaxy view props. */
export interface GalaxyViewProps {
  readonly state: OrbState
  /** Live-region labels per state (the engine announces state changes politely). */
  readonly labels?: Partial<Record<OrbState, string>>
  /** Microphone stream to tap while listening; the engine never plays it back. */
  readonly micStream?: MediaStream | undefined
  readonly performance?: PerformanceMode
  readonly reducedMotion?: boolean | 'auto'
  readonly className?: string | undefined
  readonly seed?: number
}

/**
 * Render the living galaxy.
 * @param props - target state, audio, and quality settings.
 * @returns the container the engine draws into.
 */
export function GalaxyView({ state, labels, micStream, performance = 'auto', reducedMotion = 'auto', className, seed = 7 }: GalaxyViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const galaxy = useRef<Galaxy | undefined>(undefined)

  useEffect(() => {
    const element = container.current
    if (element === null) return
    const engine = createGalaxy(element, { state, seed, performance, reducedMotion, ...labels === undefined ? {} : { labels } })
    galaxy.current = engine
    return () => {
      galaxy.current = undefined
      engine.destroy()
    }
    // The engine is created once per mount; later prop changes go through its setters below.
  }, [seed])

  useEffect(() => { galaxy.current?.setState(state) }, [state])
  useEffect(() => { galaxy.current?.setPerformanceMode(performance) }, [performance])
  useEffect(() => { galaxy.current?.setReducedMotion(reducedMotion) }, [reducedMotion])
  useEffect(() => {
    const engine = galaxy.current
    if (engine === undefined || micStream === undefined) return
    engine.connectAudio('mic', micStream)
    return () => { engine.disconnectAudio('mic') }
  }, [micStream])

  return <div ref={container} className={className} />
}
