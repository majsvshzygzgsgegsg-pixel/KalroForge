/**
 * Voice provider interfaces. Speech-to-text and text-to-speech are pluggable;
 * the default provider adapts the existing Call plugin (`@local/voice-call`,
 * browser SpeechRecognition + speechSynthesis), which publishes its runtime
 * as the `voiceCall` client service. Nothing here records or uploads audio.
 */
import type { VoicePhase } from './api.ts'

/** Phases the Call plugin reports. */
export type CallPhase = 'idle' | 'listening' | 'waiting' | 'speaking' | 'error'

/** Snapshot the Call plugin publishes on every change. */
export interface CallSnapshot {
  readonly live: boolean
  readonly phase: CallPhase
  readonly caption: string
  readonly partial: boolean
  readonly reply: string
  readonly error: string
  /** Last transcript sent through a channel call. */
  readonly heard?: string
  /** Channel name while a channel call is live, otherwise null. */
  readonly channel?: string | null
  readonly supported: boolean
  readonly speakingSupported: boolean
  readonly settings: { readonly autoSend: boolean; readonly speak: boolean; readonly handsFree: boolean; readonly bargeIn: boolean }
}

/** One installed speech voice. */
export interface VoiceOption {
  readonly name: string
  readonly lang: string
  readonly local: boolean
}

/** The `voiceCall` service surface the Personal AI uses. */
export interface VoiceCallRuntime {
  readonly snapshot: CallSnapshot | null
  toggle(): void
  stopSpeaking(): void
  interruptAndListen(): void
  setOption(key: 'autoSend' | 'speak' | 'handsFree' | 'bargeIn', value: boolean): void
  subscribe(listener: () => void): () => void
  setVoice?(preference: { readonly name?: string; readonly rate?: number }): void
  listVoices?(): VoiceOption[]
  /** Start a call whose turns go to `channel` instead of the chat composer. */
  startWith?(channel: VoiceChannel): void
}

/** Where a channel call sends what the user said; resolves with the reply to speak. */
export interface VoiceChannel {
  readonly name: string
  send(text: string): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser voice runtime published by `@local/voice-call`, when installed. */
    voiceCall: VoiceCallRuntime
  }
}

/** Speech-to-text provider. */
export interface SpeechToTextProvider {
  readonly id: string
  readonly available: boolean
  /** Start listening (push-to-talk press or hands-free on). */
  start(): void
  /** Stop listening. */
  stop(): void
  /** Hands-free keeps listening after each reply. */
  setHandsFree(enabled: boolean): void
}

/** Text-to-speech provider. */
export interface TextToSpeechProvider {
  readonly id: string
  readonly available: boolean
  /** Stop speaking now. */
  stop(): void
  /** Interrupt the reply and start listening. */
  interrupt(): void
  setVoice(preference: { readonly name?: string; readonly rate?: number }): void
  voices(): VoiceOption[]
}

/** A voice provider pair plus its observable phase. */
export interface VoiceProvider {
  readonly stt: SpeechToTextProvider
  readonly tts: TextToSpeechProvider
  /** Current phase for the assistant state. */
  phase(): VoicePhase
  snapshot(): CallSnapshot | null
  subscribe(listener: () => void): () => void
  /** Hold a spoken conversation through `channel` without a chat on screen (absent when unsupported). */
  converse?: ((channel: VoiceChannel) => void) | undefined
}

/**
 * Map the Call plugin's phase to the assistant's voice phase.
 * @param snapshot - Call snapshot.
 * @returns voice phase.
 */
export function voicePhaseOf(snapshot: CallSnapshot | null): VoicePhase {
  if (snapshot === null || !snapshot.live) return 'off'
  if (snapshot.phase === 'speaking') return 'speaking'
  if (snapshot.phase === 'listening') return 'listening'
  // `waiting` is KairoForge working on the answer: the Host's busy state shows THINKING.
  return 'off'
}

/**
 * Adapt the Call runtime into the provider interfaces.
 * @param runtime - `voiceCall` service.
 * @returns the browser voice provider.
 */
export function browserVoiceProvider(runtime: VoiceCallRuntime): VoiceProvider {
  const live = (): boolean => runtime.snapshot?.live === true
  return {
    stt: {
      id: 'browser-speech-recognition',
      get available() { return runtime.snapshot?.supported === true },
      start: () => { if (!live()) runtime.toggle() },
      stop: () => { if (live()) runtime.toggle() },
      setHandsFree: (enabled) => { runtime.setOption('handsFree', enabled) },
    },
    tts: {
      id: 'browser-speech-synthesis',
      get available() { return runtime.snapshot?.speakingSupported === true },
      stop: () => { runtime.stopSpeaking() },
      interrupt: () => { runtime.interruptAndListen() },
      setVoice: (preference) => { runtime.setVoice?.(preference) },
      voices: () => runtime.listVoices?.() ?? [],
    },
    phase: () => voicePhaseOf(runtime.snapshot),
    snapshot: () => runtime.snapshot,
    subscribe: listener => runtime.subscribe(listener),
    converse: runtime.startWith === undefined ? undefined : (channel) => { runtime.startWith?.(channel) },
  }
}
