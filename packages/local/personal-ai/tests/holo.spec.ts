import { describe, expect, it } from 'vitest'
import {
  checkItemFields, defaultPosition, describePerception, describeScene, HoloSceneError, normalizeColor, requireKindFields,
  type HoloItem, type HoloScene,
} from '../src/core/holo-scene.ts'

function item(fields: Partial<HoloItem> & Pick<HoloItem, 'id' | 'kind' | 'title'>): HoloItem {
  return { x: 0.5, y: 0.5, scale: 1, posRev: 1, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...fields }
}

describe('holo scene', () => {
  it('normalizes colours and rejects anything else', () => {
    expect(normalizeColor('Teal')).toBe('#2dd4bf')
    expect(normalizeColor('#ABC')).toBe('#abc')
    expect(() => normalizeColor('url(javascript:1)')).toThrow(HoloSceneError)
  })

  it('clamps positions and scale, and only accepts web addresses for urls', () => {
    expect(checkItemFields('note', { x: -2, y: 9, scale: 99 })).toEqual({ x: 0.03, y: 0.97, scale: 4 })
    expect(checkItemFields('web', { url: 'https://example.com/a' }).url).toBe('https://example.com/a')
    expect(() => checkItemFields('web', { url: 'javascript:alert(1)' })).toThrow(/https:\/\/ or http:\/\//)
    expect(() => checkItemFields('web', { url: 'file:///etc/passwd' })).toThrow(HoloSceneError)
    expect(checkItemFields('image', { url: 'data:image/png;base64,iVBORw0KGgo=' }).url).toMatch(/^data:image\/png/)
    expect(() => checkItemFields('web', { url: 'data:image/png;base64,iVBORw0KGgo=' })).toThrow(HoloSceneError)
  })

  it('refuses secrets in saved text and widget code', () => {
    expect(() => checkItemFields('note', { title: 'Keys', text: 'my password is hunter2' })).toThrow(/secrets are refused/)
    expect(() => checkItemFields('widget', { html: '<script>const key = "sk-abcdefghijklmnopqrstuvwxyz123456"</script>' }))
      .toThrow(/API key or token/)
    expect(checkItemFields('widget', { html: '<button>Count</button>' }).html).toBe('<button>Count</button>')
  })

  it('requires what each kind needs to render', () => {
    expect(() => { requireKindFields({ kind: 'widget' }) }).toThrow(/needs html/)
    expect(() => { requireKindFields({ kind: 'web' }) }).toThrow(/needs a url/)
    expect(() => { requireKindFields({ kind: 'sensor' }) }).toThrow(/needs a signal/)
    expect(() => { requireKindFields({ kind: 'model' }) }).toThrow(/\.glb/)
    expect(() => { requireKindFields({ kind: 'shape' }) }).not.toThrow()
    expect(() => { requireKindFields({ kind: 'model', text: 'triceratops.glb' }) }).not.toThrow()
  })

  it('spreads new items around the centre inside the deck', () => {
    const spots = Array.from({ length: 40 }, (_, index) => defaultPosition(index))
    for (const spot of spots) {
      expect(spot.x).toBeGreaterThanOrEqual(0.03)
      expect(spot.x).toBeLessThanOrEqual(0.97)
      expect(spot.y).toBeGreaterThanOrEqual(0.03)
      expect(spot.y).toBeLessThanOrEqual(0.97)
    }
    expect(new Set(spots.map(spot => `${spot.x.toFixed(3)},${spot.y.toFixed(3)}`)).size).toBe(40)
  })

  it('describes what the camera sees in plain words', () => {
    const titles: Record<string, string> = { h1: 'Counter' }
    const seen = describePerception({
      face: { present: true, looking: 'left', smile: 0.8, distance: 'near' },
      hands: [{ side: 'right', gesture: 'pinch', x: 0.4, y: 0.5, holding: 'h1' }],
      pose: { present: true, armsUp: 'both' },
      events: ['smile', 'smile', 'pinch'],
    }, id => titles[id])
    expect(seen).toBe('face visible, looking left, near, smiling (80%); right hand pinch holding "Counter"; both arms raised; recent: smile, pinch')
    expect(describePerception({ face: null, hands: [], events: [] }, () => undefined)).toBe('no face in view; no hands in view')
  })

  it('summarizes the scene with ids the model can use', () => {
    const scene: HoloScene = {
      revision: 3,
      items: [item({ id: 'h1', kind: 'widget', title: 'Counter', html: '<b>0</b>' }), item({ id: 'h2', kind: 'text', title: 'Total' })],
      connectors: [{ id: 'c3', from: 'h1', to: 'h2', createdAt: '2026-10-02T00:00:00.000Z' }],
    }
    expect(describeScene(scene)).toBe('2 item(s): h1 widget "Counter", h2 text "Total"; connectors: h1→h2')
    expect(describeScene({ revision: 0, items: [], connectors: [] })).toBe('the deck has none of your items yet')
  })
})
