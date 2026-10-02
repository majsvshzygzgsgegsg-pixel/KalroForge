/**
 * Coordinator tools for Holo Hands. They change only the deck scene and the
 * open state; every call still passes the normal `tools/pre-execute`
 * permission path like any other tool.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { HOLO_KINDS, HOLO_SHAPES, HOLO_SIGNALS, HoloSceneError, type HoloItemInput } from './core/holo-scene.ts'
import type { HoloDeck } from './holo.ts'

/** Holo Hands tools. */
export const HOLO_TOOLS = ['open_holo', 'close_holo', 'holo_status', 'holo_add', 'holo_update', 'holo_remove', 'holo_connect', 'holo_disconnect'] as const

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

async function guarded(operation: () => Promise<unknown>): Promise<JsonValue> {
  return toJson(await operation())
}

const KIND_GUIDE = [
  'Kinds: note (title + text card; tap opens it; incoming values append),',
  'text (a big label; incoming values replace it),',
  `shape (3D ${HOLO_SHAPES.join('/')} with color; grab, twist, stretch; flashes or recolours on incoming values),`,
  'model (3D .glb: url, or text naming a file in the Holo props folder),',
  'image (url: https or data:image), web (a live web page from url),',
  'widget (ANYTHING else: a self-contained HTML/CSS/JS snippet in html, sandboxed with no network; its script can call',
  'holo.emit(value) to send along connectors and holo.onInput((value, from) => …) to receive; hand taps arrive as clicks),',
  'action (a button: tapping it emits its text, or title, along connectors and, when prompt is set, sends prompt to you as a request',
  '— {value} is replaced by the incoming value; normal approvals still apply),',
  `sensor (emits when the camera sees signal: ${HOLO_SIGNALS.join(', ')}).`,
  'x/y are 0–1 fractions of the screen (0,0 top-left; keep clear of the bottom-right corner where your orb sits); scale 0.3–4.',
].join(' ')

const ITEM_FIELDS = {
  title: { type: 'string', description: 'Short label shown on the item.' },
  text: { type: 'string', description: 'Body text (note/text/action), or a props file name for model.' },
  color: { type: 'string', description: 'Hex like #2dd4bf, or teal/cyan/blue/purple/pink/red/orange/yellow/green/white/gray/gold.' },
  shape: { type: 'string', enum: [...HOLO_SHAPES] },
  url: { type: 'string', description: 'image/web/model address.' },
  html: { type: 'string', description: 'widget markup with inline <style>/<script>; up to 60k characters.' },
  prompt: { type: 'string', description: 'action: request sent to you when tapped; may contain {value}.' },
  signal: { type: 'string', enum: [...HOLO_SIGNALS] },
  x: { type: 'number', description: '0–1 from the left.' },
  y: { type: 'number', description: '0–1 from the top.' },
  scale: { type: 'number', description: '0.3–4, default 1.' },
} as const

/**
 * Holo Hands tools for one coordinator.
 * @param deck - Holo deck service.
 * @returns tool definitions.
 */
export function holoTools(deck: HoloDeck): unknown[] {
  return [
    defineTool({
      name: 'open_holo',
      description: 'Open Holo Hands (also "holo", "holo gestures", "holo hands") full screen inside KairoForge: the camera deck that tracks the user\'s face, hands, and body, where you can place and connect items. Use it when the user asks to open holo. Starts the local Holo server when needed and reports whether it worked.',
      parameters: {},
      output: JSON_OUTPUT,
      execute() {
        return guarded(() => deck.open())
      },
    }),
    defineTool({
      name: 'close_holo',
      description: 'Close the full-screen Holo Hands deck (the scene is kept).',
      parameters: {},
      output: JSON_OUTPUT,
      execute() {
        return guarded(() => Promise.resolve(deck.close()))
      },
    }),
    defineTool({
      name: 'holo_status',
      description: 'What is on the Holo Hands deck (items with ids, connectors) and what the camera sees right now: face (looking where, smiling, mouth open, eyebrows), each hand\'s gesture and the item it holds or hovers, raised arms, and recent signals like nod or wave.',
      parameters: {},
      output: JSON_OUTPUT,
      execute() {
        const status = { ...deck.view(), scene: deck.scene(), camera: deck.seeing(), perception: deck.perception() ?? null }
        return guarded(() => Promise.resolve(status))
      },
    }),
    defineTool({
      name: 'holo_add',
      description: `Add one item to the Holo Hands deck; the user can grab and move it by hand. ${KIND_GUIDE}`,
      parameters: { kind: { type: 'string', enum: [...HOLO_KINDS], required: true }, ...ITEM_FIELDS },
      output: JSON_OUTPUT,
      execute(args) {
        return guarded(() => deck.add(args as HoloItemInput & { kind: typeof args.kind }))
      },
    }),
    defineTool({
      name: 'holo_update',
      description: 'Change an item on the Holo Hands deck: retitle, recolour, new text/html/url/prompt, move (x/y), or resize (scale). An empty string clears an optional field.',
      parameters: { id: { type: 'string', required: true }, kind: { type: 'string', enum: [...HOLO_KINDS] }, ...ITEM_FIELDS },
      output: JSON_OUTPUT,
      execute(args) {
        const { id, ...changes } = args
        return guarded(() => deck.update(id, changes as HoloItemInput))
      },
    }),
    defineTool({
      name: 'holo_remove',
      description: 'Remove items (and their connectors) from the Holo Hands deck. Pass ids, or all: true to clear everything you placed.',
      parameters: { ids: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' } },
      output: JSON_OUTPUT,
      execute(args) {
        return guarded(async () => {
          if (args.all === true) return { removed: await deck.remove('all') }
          if (args.ids === undefined || args.ids.length === 0) throw new HoloSceneError('pass ids, or all: true')
          return { removed: await deck.remove(args.ids) }
        })
      },
    }),
    defineTool({
      name: 'holo_connect',
      description: 'Connect two Holo items with a glowing link so values flow from one to the other: a widget\'s holo.emit, a tapped action, a sensor signal, or a tapped note travels along it and the target reacts (widget onInput, text replaced, note appended, shape flashes/recolours, action fires).',
      parameters: {
        from: { type: 'string', required: true, description: 'Source item id.' },
        to: { type: 'string', required: true, description: 'Target item id.' },
        label: { type: 'string' },
        color: { type: 'string' },
      },
      output: JSON_OUTPUT,
      execute(args) {
        const options = {
          ...args.label === undefined ? {} : { label: args.label },
          ...args.color === undefined ? {} : { color: args.color },
        }
        return guarded(() => deck.connect(args.from, args.to, options))
      },
    }),
    defineTool({
      name: 'holo_disconnect',
      description: 'Remove a connector by id, or every connector between two items (from + to).',
      parameters: { id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
      output: JSON_OUTPUT,
      execute(args) {
        return guarded(() => {
          if (args.id !== undefined) return deck.disconnect({ id: args.id })
          if (args.from !== undefined && args.to !== undefined) return deck.disconnect({ from: args.from, to: args.to })
          throw new HoloSceneError('pass a connector id, or from and to')
        })
      },
    }),
  ]
}
