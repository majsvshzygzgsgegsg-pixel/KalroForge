/**
 * Voice toolbelt. The spoken conversation resends its whole tool list with
 * every model call, so it starts from a small core and adds a capability group
 * only when the request names it, its depth needs it, or the model opens it
 * with `use_tools`. Hiding a tool grants nothing: every call still passes the
 * normal permission path.
 */
import { CAPABILITY_CATEGORIES, categoryOf, type CapabilityCategory } from './capabilities.ts'
import type { Depth } from './classifier.ts'

/** The tool that opens more capability groups for the rest of the request. */
export const USE_TOOLS = 'use_tools'

/** Groups every working request starts with: cheap, and enough for most spoken requests. */
const CORE_CATEGORIES: readonly CapabilityCategory[] = ['FILES', 'SEARCH', 'TERMINAL', 'PROJECT']

/** Depths answered from what the model already knows, so they start with no tools but {@link USE_TOOLS}. */
const LEAN_DEPTHS: ReadonlySet<Depth> = new Set(['direct', 'clarify'])

/** Single tools outside the core groups that every working request starts with. */
const CORE_TOOLS: ReadonlySet<string> = new Set([
  USE_TOOLS, 'ask_user_question', 'list_projects', 'list_capabilities', 'query_memory',
  'open_holo', 'close_holo', 'holo_status', 'holo_add', 'holo_update', 'holo_remove',
  'list_main_agents', 'recommend_agent', 'delegate_to_main_agent', 'list_background_tasks', 'start_background_task',
  'pause_task', 'resume_task', 'cancel_task', 'update_task',
  'mac_action', 'applescript', 'applescript_dictionary',
])

/**
 * Groups opened up front because the request names them. A bare "cursor" means the Cursor editor
 * (FILES/SEARCH tools), not screen control; only "move the cursor" or "mouse" opens COMPUTER.
 */
const NAMED: ReadonlyArray<readonly [CapabilityCategory, RegExp]> = [
  ['COMPUTER', new RegExp([
    String.raw`\b(?:screen|screenshot|click|double[- ]click|tap|press|keyboard|mouse|move (?:the )?cursor|scroll|drag|hotkey|shortcut|clipboard|menu`,
    String.raw`|window|windows|desktop|dock|finder|launch|quit|switch to|volume|brightness|spotify|music|computer|mac`,
    String.raw`|apple ?script|osascript|automator)\b`,
  ].join(''), 'i')],
  ['BROWSER', /\b(?:browser|website|web ?page|tab|tabs|url|navigate|go to|safari|chrome|firefox)\b/i],
  ['GIT', /\b(?:git|checkpoints?|commit|undo|roll ?back|rollback|restore|revert)\b/i],
  ['GITHUB', /\b(?:github|pull requests?|prs?|issues?)\b/i],
  ['AGENTS', /\b(?:agents?|team|teammates?|delegate|hand (?:it|this) (?:off|over)|reviewer|second opinion)\b/i],
  ['WORKFLOWS', /\b(?:workflows?|multi[- ]step plan)\b/i],
  ['BACKGROUND_TASKS', /\b(?:background|schedule|scheduled|remind|monitor|watch for|every (?:day|hour|morning|night|week)|tasks?)\b/i],
]

/** Groups a depth needs regardless of wording. */
const BY_DEPTH: Partial<Record<Depth, readonly CapabilityCategory[]>> = {
  agent: ['AGENTS'],
  workflow: ['WORKFLOWS', 'AGENTS'],
  background: ['BACKGROUND_TASKS'],
}

/** The tool groups open for one request. */
export interface VoiceToolbelt {
  /** No tools but {@link USE_TOOLS}: a question or small talk the model can answer directly. */
  readonly lean: boolean
  readonly open: ReadonlySet<CapabilityCategory>
}

/**
 * The toolbelt for one request: the core plus the groups it names or its depth needs,
 * or nothing but {@link USE_TOOLS} for a direct answer that names no group.
 * @param request - the user's message.
 * @param depth - its classified depth, when known.
 * @param opened - groups the model already opened with {@link USE_TOOLS} for this request.
 * @returns the open groups.
 */
export function voiceToolbelt(request: string, depth: Depth | undefined, opened: Iterable<CapabilityCategory> = []): VoiceToolbelt {
  const extra = new Set<CapabilityCategory>([...depth === undefined ? [] : BY_DEPTH[depth] ?? [], ...opened])
  for (const [category, pattern] of NAMED) if (pattern.test(request)) extra.add(category)
  if (extra.size === 0 && depth !== undefined && LEAN_DEPTHS.has(depth)) return { lean: true, open: extra }
  return { lean: false, open: new Set([...CORE_CATEGORIES, ...extra]) }
}

/**
 * Keep only the categories this toolbelt knows, in canonical order.
 * @param names - requested category names (any case).
 * @returns the valid categories.
 */
export function parseCategories(names: readonly string[]): CapabilityCategory[] {
  const wanted = new Set(names.map(name => name.trim().toUpperCase()))
  return CAPABILITY_CATEGORIES.filter(category => wanted.has(category))
}

/** Requests about the screen itself: the only typed requests that see screen-driving tools up front. */
const SCREEN_REQUEST = new RegExp([
  String.raw`\b(?:screen|screenshot|click|double[- ]click|mouse|pointer|move (?:the )?(?:mouse )?cursor|mouse cursor|scroll|drag`,
  String.raw`|what(?:'s| is) on|look at (?:my|the) (?:screen|window)|see my|computer use|touch|press (?:the |that |a )?button|tick|checkbox`,
  String.raw`|fill (?:in|out)|hands|(?:full )?control (?:of )?my (?:computer|mac|screen))\b`,
].join(''), 'i')

/**
 * Typed coordinator requests: everything except screen-driving tools, which
 * take several slow model steps per action. They stay available when the
 * request is about the screen or the model opens COMPUTER with {@link USE_TOOLS};
 * mac_action and applescript are never hidden.
 * @param tools - every tool the Session has.
 * @param request - the user's message.
 * @param opened - groups the model opened with {@link USE_TOOLS} for this request.
 * @returns the visible subset, in the original order.
 */
export function typedTools<T extends { readonly name: string }>(
  tools: readonly T[],
  request: string,
  opened: Iterable<CapabilityCategory> = [],
): T[] {
  if (SCREEN_REQUEST.test(request) || [...opened].includes('COMPUTER')) return [...tools]
  return tools.filter(tool => CORE_TOOLS.has(tool.name) || categoryOf(tool.name) !== 'COMPUTER')
}

/**
 * The voice conversation's tools for one request.
 * @param tools - every tool the Session has.
 * @param belt - the request's toolbelt.
 * @returns the visible subset, in the original order.
 */
export function voiceTools<T extends { readonly name: string }>(tools: readonly T[], belt: VoiceToolbelt): T[] {
  return tools.filter((tool) => {
    if (tool.name === USE_TOOLS) return true
    if (belt.lean) return false
    if (CORE_TOOLS.has(tool.name)) return true
    const category = categoryOf(tool.name)
    return category !== undefined && belt.open.has(category)
  })
}
