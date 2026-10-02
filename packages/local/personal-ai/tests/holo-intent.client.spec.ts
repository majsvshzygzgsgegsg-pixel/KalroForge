import { describe, expect, it } from 'vitest'
import { holoShortcut } from '../src/client/holo-intent.ts'

describe('holo shortcut', () => {
  it.each([
    'open holo hands', 'Open Holo Hands.', 'open holo', 'open hollow hands', 'open halo hands please', 'launch the holo deck',
    'hey KairoForge, open holo hands', 'can you open holo gestures', 'open hello hands', 'bring up holo hands now',
  ])('opens on %j', (text) => {
    expect(holoShortcut(text)).toBe('open')
  })

  it.each(['close holo hands', 'Close Holo.', 'exit holo hands', 'hide the holo deck'])('closes on %j', (text) => {
    expect(holoShortcut(text)).toBe('close')
  })

  it.each([
    'open holo hands and add a cube', 'open the hologram file', 'what is holo hands?', 'open my notes', 'holo hands', 'hello',
    'open holo hands in a new repo and delete everything',
  ])('leaves %j to KairoForge', (text) => {
    expect(holoShortcut(text)).toBeUndefined()
  })
})
