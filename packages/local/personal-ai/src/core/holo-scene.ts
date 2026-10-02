/**
 * Holo Hands scene model: the items KairoForge places on the Holo deck, the
 * connectors that carry values between them, and the camera perception the
 * deck reports. Pure data and validation; the Host service persists it and the
 * deck page renders it. Perception is derived numbers only (no images).
 */
import { redact } from '@local/main-agents'
import { findSensitive } from './sensitive.ts'

/** Things that can be placed on the deck. */
export const HOLO_KINDS = ['note', 'text', 'shape', 'model', 'image', 'web', 'widget', 'action', 'sensor'] as const
/** One item kind. */
export type HoloKind = typeof HOLO_KINDS[number]

/** 3D primitives a `shape` item renders. */
export const HOLO_SHAPES = ['cube', 'sphere', 'torus', 'knot', 'cone', 'cylinder', 'pyramid', 'ring', 'icosahedron', 'capsule'] as const
/** One primitive. */
export type HoloShape = typeof HOLO_SHAPES[number]

/** Camera signals a `sensor` item emits when they happen. */
export const HOLO_SIGNALS = [
  'face_seen', 'look_away', 'smile', 'blink', 'mouth_open', 'brow_raise', 'nod', 'shake',
  'pinch', 'fist', 'open_palm', 'point', 'peace', 'hands_up', 'wave',
] as const
/** One sensor signal. */
export type HoloSignal = typeof HOLO_SIGNALS[number]

/** Limits that keep one scene small enough to render and persist. */
export const HOLO_LIMITS = {
  items: 80,
  connectors: 160,
  title: 120,
  text: 4000,
  html: 60_000,
  url: 2000,
  prompt: 1000,
  label: 60,
} as const

/** One placed item. Positions are viewport fractions so they survive resizes. */
export interface HoloItem {
  readonly id: string
  readonly kind: HoloKind
  readonly title: string
  readonly text?: string
  readonly color?: string
  readonly shape?: HoloShape
  readonly url?: string
  readonly html?: string
  readonly prompt?: string
  readonly signal?: HoloSignal
  readonly x: number
  readonly y: number
  readonly scale: number
  /** Bumped when a tool moves the item; the deck re-seats it only then. */
  readonly posRev: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** One connector: values emitted by `from` are delivered to `to`. */
export interface HoloConnector {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly label?: string
  readonly color?: string
  readonly createdAt: string
}

/** The whole scene. */
export interface HoloScene {
  readonly revision: number
  readonly items: readonly HoloItem[]
  readonly connectors: readonly HoloConnector[]
}

/** Fields a tool may set when adding or updating an item. */
export interface HoloItemInput {
  readonly kind?: HoloKind
  readonly title?: string
  readonly text?: string
  readonly color?: string
  readonly shape?: HoloShape
  readonly url?: string
  readonly html?: string
  readonly prompt?: string
  readonly signal?: HoloSignal
  readonly x?: number
  readonly y?: number
  readonly scale?: number
}

/** A rejected scene change, with words the model can relay. */
export class HoloSceneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HoloSceneError'
  }
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const NAMED: Readonly<Record<string, string>> = {
  teal: '#2dd4bf', cyan: '#22d3ee', blue: '#60a5fa', purple: '#a78bfa', pink: '#f472b6', red: '#f87171',
  orange: '#fb923c', yellow: '#facc15', green: '#4ade80', white: '#f8fafc', gray: '#94a3b8', grey: '#94a3b8', gold: '#fbbf24',
}

/**
 * Normalize a colour to `#rrggbb`/`#rgb`, accepting a few plain names.
 * @param value - hex or colour name.
 * @returns the hex colour.
 */
export function normalizeColor(value: string): string {
  const trimmed = value.trim().toLowerCase()
  const named = NAMED[trimmed]
  if (named !== undefined) return named
  if (HEX.test(trimmed)) return trimmed
  throw new HoloSceneError(`colour "${value}" is not a hex colour like #2dd4bf or one of: ${Object.keys(NAMED).join(', ')}`)
}

function checkUrl(url: string, kind: HoloKind): string {
  const trimmed = url.trim()
  if (trimmed.length > HOLO_LIMITS.url) throw new HoloSceneError(`url is longer than ${String(HOLO_LIMITS.url)} characters`)
  if (kind === 'image' && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(trimmed)) return trimmed
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    // An unparsable URL is reported in words the model can act on.
    throw new HoloSceneError(`url "${trimmed.slice(0, 80)}" is not a valid address`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new HoloSceneError('url must start with https:// or http://')
  return parsed.toString()
}

function checkText(field: string, value: string, max: number): string {
  if (value.length > max) throw new HoloSceneError(`${field} is longer than ${String(max)} characters`)
  const finding = findSensitive(value)
  if (finding.sensitive) throw new HoloSceneError(`${field} ${finding.reason ?? 'looks sensitive'}; Holo items are saved to disk, so secrets are refused`)
  return value
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(0.97, Math.max(0.03, value))
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(4, Math.max(0.3, value))
}

/**
 * Validate and normalize the fields of one item.
 * @param kind - the item's kind.
 * @param input - fields to check.
 * @returns the normalized fields.
 */
export function checkItemFields(kind: HoloKind, input: HoloItemInput): Partial<HoloItem> {
  const out: Record<string, unknown> = {}
  if (input.title !== undefined) out.title = checkText('title', input.title.trim(), HOLO_LIMITS.title)
  if (input.text !== undefined) out.text = checkText('text', input.text, HOLO_LIMITS.text)
  if (input.prompt !== undefined) out.prompt = checkText('prompt', input.prompt.trim(), HOLO_LIMITS.prompt)
  if (input.html !== undefined) {
    if (input.html.length > HOLO_LIMITS.html) throw new HoloSceneError(`html is longer than ${String(HOLO_LIMITS.html)} characters`)
    if (redact(input.html) !== input.html) throw new HoloSceneError('html contains an API key or token; secrets are refused')
    out.html = input.html
  }
  if (input.color !== undefined) out.color = normalizeColor(input.color)
  if (input.url !== undefined) out.url = checkUrl(input.url, kind)
  if (input.shape !== undefined) {
    if (!(HOLO_SHAPES as readonly string[]).includes(input.shape)) throw new HoloSceneError(`shape must be one of: ${HOLO_SHAPES.join(', ')}`)
    out.shape = input.shape
  }
  if (input.signal !== undefined) {
    if (!(HOLO_SIGNALS as readonly string[]).includes(input.signal)) throw new HoloSceneError(`signal must be one of: ${HOLO_SIGNALS.join(', ')}`)
    out.signal = input.signal
  }
  if (input.x !== undefined) out.x = clampUnit(input.x)
  if (input.y !== undefined) out.y = clampUnit(input.y)
  if (input.scale !== undefined) out.scale = clampScale(input.scale)
  return out
}

/** What each kind needs before it can render. */
export function requireKindFields(item: Pick<HoloItem, 'kind' | 'url' | 'html' | 'shape' | 'signal' | 'prompt' | 'text'>): void {
  switch (item.kind) {
    case 'image':
    case 'web':
      if (item.url === undefined) throw new HoloSceneError(`a ${item.kind} item needs a url`)
      break
    case 'widget':
      if (item.html === undefined || item.html.trim() === '') throw new HoloSceneError('a widget item needs html (a self-contained HTML/CSS/JS snippet)')
      break
    case 'sensor':
      if (item.signal === undefined) throw new HoloSceneError(`a sensor item needs a signal: ${HOLO_SIGNALS.join(', ')}`)
      break
    case 'model':
      if (item.url === undefined && item.text === undefined) throw new HoloSceneError('a model item needs a url to a .glb file, or text naming a prop in ~/holo/props')
      break
    case 'shape':
    case 'note':
    case 'text':
    case 'action':
    default:
  }
}

/** Default spot for the n-th new item: a loose spiral around the centre, clear of the HUD corner. */
export function defaultPosition(index: number): { x: number; y: number } {
  const angle = index * 2.399963
  const radius = 0.08 + 0.035 * Math.sqrt(index)
  return { x: clampUnit(0.5 + Math.cos(angle) * radius * 1.4), y: clampUnit(0.46 + Math.sin(angle) * radius) }
}

/** Head pose and expression read from the face tracker. */
export interface HoloFace {
  readonly present: boolean
  readonly yaw?: number
  readonly pitch?: number
  readonly roll?: number
  readonly looking?: 'screen' | 'left' | 'right' | 'up' | 'down'
  readonly smile?: number
  readonly mouthOpen?: number
  readonly blink?: number
  readonly browRaise?: number
  readonly frown?: number
  readonly distance?: 'near' | 'mid' | 'far'
}

/** One tracked hand. */
export interface HoloHand {
  readonly side: 'left' | 'right' | 'unknown'
  readonly gesture: 'open' | 'fist' | 'pinch' | 'point' | 'peace' | 'relaxed'
  readonly x: number
  readonly y: number
  readonly hover?: string
  readonly holding?: string
}

/** Body pose summary. */
export interface HoloPose {
  readonly present: boolean
  readonly armsUp?: 'none' | 'left' | 'right' | 'both'
  readonly lean?: 'left' | 'right' | 'center'
}

/** One perception report from the deck. */
export interface HoloPerception {
  readonly face?: HoloFace | null
  readonly hands: readonly HoloHand[]
  readonly pose?: HoloPose | null
  /** Signals seen in the last few seconds, newest last. */
  readonly events: readonly HoloSignal[]
  readonly fps?: number
}

const pct = (value: number | undefined): number => Math.round((value ?? 0) * 100)

/**
 * One plain sentence describing what the camera sees.
 * @param perception - latest report.
 * @param titleOf - item title for an id.
 * @returns the sentence.
 */
export function describePerception(perception: HoloPerception, titleOf: (id: string) => string | undefined): string {
  const parts: string[] = []
  const face = perception.face
  if (face?.present === true) {
    const mood: string[] = []
    if ((face.smile ?? 0) > 0.45) mood.push(`smiling (${String(pct(face.smile))}%)`)
    if ((face.mouthOpen ?? 0) > 0.4) mood.push('mouth open')
    if ((face.browRaise ?? 0) > 0.45) mood.push('eyebrows raised')
    if ((face.frown ?? 0) > 0.45) mood.push('frowning')
    if ((face.blink ?? 0) > 0.6) mood.push('eyes closed')
    const looking = face.looking === undefined || face.looking === 'screen' ? 'looking at the screen' : `looking ${face.looking}`
    parts.push(`face visible, ${looking}${face.distance === undefined ? '' : `, ${face.distance}`}${mood.length === 0 ? '' : `, ${mood.join(', ')}`}`)
  } else {
    parts.push('no face in view')
  }
  const name = (id: string | undefined): string => id === undefined ? '' : `"${titleOf(id) ?? id}"`
  for (const hand of perception.hands) {
    const where = hand.holding !== undefined ? ` holding ${name(hand.holding)}` : hand.hover !== undefined ? ` over ${name(hand.hover)}` : ''
    parts.push(`${hand.side === 'unknown' ? 'a' : hand.side} hand ${hand.gesture}${where}`)
  }
  if (perception.hands.length === 0) parts.push('no hands in view')
  const pose = perception.pose
  if (pose?.present === true && pose.armsUp !== undefined && pose.armsUp !== 'none') parts.push(`${pose.armsUp === 'both' ? 'both arms' : `${pose.armsUp} arm`} raised`)
  if (perception.events.length > 0) parts.push(`recent: ${[...new Set(perception.events)].join(', ')}`)
  return parts.join('; ')
}

/**
 * Short scene summary for the model's runtime context.
 * @param scene - the scene.
 * @returns one line.
 */
export function describeScene(scene: HoloScene): string {
  if (scene.items.length === 0) return 'the deck has none of your items yet'
  const shown = scene.items.slice(0, 12).map(item => `${item.id} ${item.kind} "${item.title}"`).join(', ')
  const more = scene.items.length > 12 ? ` and ${String(scene.items.length - 12)} more` : ''
  const links = scene.connectors.slice(0, 12).map(link => `${link.from}→${link.to}`).join(', ')
  return `${String(scene.items.length)} item(s): ${shown}${more}${scene.connectors.length === 0 ? '' : `; connectors: ${links}`}`
}
