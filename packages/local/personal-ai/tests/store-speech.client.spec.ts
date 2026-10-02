import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/client/api.ts'
import { createLiveStore, type LiveStore, type Progress } from '../src/client/store.ts'
import { browserVoiceProvider, type CallSnapshot, type VoiceCallRuntime, type VoiceChannel } from '../src/client/voice.ts'

vi.mock('../src/client/api.ts', () => ({
  api: {
    state: vi.fn(async () => ({ state: 'IDLE' })),
    notifications: vi.fn(async () => []),
    voice: vi.fn(async () => ({ state: 'IDLE' })),
    converse: vi.fn(),
    converseTurn: vi.fn(),
    holoOpen: vi.fn(async () => ({ open: true, server: 'running', url: 'http://127.0.0.1:4890' })),
  },
}))

function runtime(live = false): VoiceCallRuntime & { said: string[]; channel?: VoiceChannel } {
  const snapshot = {
    live, phase: 'idle', caption: '', partial: false, reply: '', error: '', supported: true, speakingSupported: true,
    settings: { autoSend: true, speak: true, handsFree: true, bargeIn: true },
  } satisfies CallSnapshot
  const fake: VoiceCallRuntime & { said: string[]; channel?: VoiceChannel } = {
    said: [],
    snapshot,
    toggle() {},
    stopSpeaking() {},
    interruptAndListen() {},
    setOption() {},
    subscribe: () => () => {},
    say(text) { fake.said.push(text) },
    startWith(channel) { fake.channel = channel },
  }
  return fake
}

const words = { progress: (progress: Progress) => progress.kind === 'say' ? progress.text : progress.kind, failed: (message: string) => `failed: ${message}` }

let store: LiveStore | undefined
afterEach(() => {
  store?.dispose()
  store = undefined
  vi.mocked(api.converse).mockReset()
})

describe('typed questions are spoken', () => {
  it('speaks the answer of a typed question', async () => {
    vi.mocked(api.converse).mockResolvedValue({ id: 't1', status: 'done', reply: 'Added a counter to your deck.', sessionId: 's1' } as never)
    const voice = runtime()
    store = createLiveStore({ speech: words })
    store.setProvider(browserVoiceProvider(voice))
    await expect(store.ask('add a counter')).resolves.toBe('Added a counter to your deck.')
    expect(voice.said).toEqual(['Added a counter to your deck.'])
  })

  it('speaks a failure instead of going quiet', async () => {
    vi.mocked(api.converse).mockRejectedValue(new Error('offline'))
    const voice = runtime()
    store = createLiveStore({ speech: words })
    store.setProvider(browserVoiceProvider(voice))
    await expect(store.ask('add a counter')).rejects.toThrow('offline')
    expect(voice.said).toEqual(['failed: offline'])
  })

  it('speaks the holo shortcut reply', async () => {
    const voice = runtime()
    store = createLiveStore({ speech: words, holoReply: () => 'Holo Hands is open.' })
    store.setProvider(browserVoiceProvider(voice))
    await store.ask('open holo hands')
    expect(voice.said).toEqual(['Holo Hands is open.'])
  })

  it('leaves a live call to speak its own turns', async () => {
    vi.mocked(api.converse).mockResolvedValue({ id: 't2', status: 'done', reply: 'Spoken once.', sessionId: 's1' } as never)
    const voice = runtime(true)
    store = createLiveStore({ speech: words })
    store.setProvider(browserVoiceProvider(voice))
    expect(store.talk(progress => progress.kind)).toBe(true)
    await expect(voice.channel?.send('hello', () => {})).resolves.toBe('Spoken once.')
    expect(voice.said).toEqual([])
  })

  it('stays silent without speech words', async () => {
    vi.mocked(api.converse).mockResolvedValue({ id: 't3', status: 'done', reply: 'Text only.', sessionId: 's1' } as never)
    const voice = runtime()
    store = createLiveStore()
    store.setProvider(browserVoiceProvider(voice))
    await store.ask('hello')
    expect(voice.said).toEqual([])
  })
})
