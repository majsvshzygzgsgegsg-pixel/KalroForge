/**
 * Intelligent model routing. A request is classified into a category from the
 * Session's mode, the main agent's template or override, and the latest user
 * message; the category maps to a model only when the user configured one, so
 * routing never invents a provider route or touches credentials.
 */
import type { ModelCategory, OrchestrationSettings, RoutedModel } from './types.ts'

/** Facts available when one request is about to be sent. */
export interface RouteInput {
  /** Agent preset id of the Session. */
  readonly mode: string
  /** Main-agent template, when the Session belongs to one. */
  readonly template?: string
  /** Per-agent routing override. */
  readonly override?: 'auto' | 'off' | ModelCategory
  /** Latest user message text, if any. */
  readonly lastUserText: string
  /** Whether the latest user message carries an image. */
  readonly hasImage: boolean
  /** Whether the Session is a workflow worker or teammate. */
  readonly worker: boolean
}

/** Classification result. */
export interface Classification {
  readonly category: ModelCategory
  readonly reason: string
}

const REVIEW = /\b(review|audit|critique|code review|look over|check (?:my|this|the) (?:diff|pr|change))\b|\[KairoForge review request\]/i
const DEEP = new RegExp(String.raw`\b(architect(?:ure)?|design (?:a|the)|trade-?offs?|root cause|why does|prove`
  + String.raw`|reason (?:about|through)|plan (?:the|a) migration|algorithm|complex)\b`, 'i')
const CODING = new RegExp(String.raw`\b(implement|refactor|fix|bug|function|class|compile|typecheck|test(?:s)?|build|lint|code`
  + String.raw`|endpoint|component|stack trace|error:)\b|${'`'.repeat(3)}`, 'i')
const SIMPLE_LIMIT = 160

/** Drop a leading `[KairoForge …]` framing header (everything up to the first blank line) so only the request is classified. */
export function messageBody(text: string): string {
  if (!text.startsWith('[KairoForge ')) return text
  const split = text.indexOf('\n\n')
  return split === -1 ? text : text.slice(split + 2)
}

/**
 * Classify one request.
 * @param input - request facts.
 * @returns category and a short human reason.
 */
export function classify(input: RouteInput): Classification {
  if (input.override !== undefined && input.override !== 'auto' && input.override !== 'off') {
    return { category: input.override, reason: `agent override fixes ${input.override}` }
  }
  if (input.hasImage) return { category: 'VISION', reason: 'latest message includes an image' }
  if (input.mode === 'fast') return { category: 'FAST', reason: 'Fast Mode session' }
  if (REVIEW.test(input.lastUserText)) return { category: 'REVIEW', reason: 'review request' }
  const text = messageBody(input.lastUserText)
  if (input.template === 'engineer') {
    return DEEP.test(text)
      ? { category: 'DEEP_REASONING', reason: 'engineer template, design or root-cause question' }
      : { category: 'CODING', reason: 'KairoForge Engineer template' }
  }
  if (DEEP.test(text)) return { category: 'DEEP_REASONING', reason: 'design, architecture, or root-cause question' }
  if (CODING.test(text)) return { category: 'CODING', reason: input.worker ? 'coding task for a worker' : 'coding request' }
  if (text.trim() !== '' && text.length <= SIMPLE_LIMIT && !input.worker) return { category: 'FAST', reason: 'short, simple request' }
  return { category: 'STANDARD', reason: 'general request' }
}

/** Final routing decision for one request. */
export interface RouteResult {
  readonly category: ModelCategory
  readonly model?: RoutedModel
  readonly routed: boolean
  readonly reason: string
}

/**
 * Resolve a classification against the configured category models.
 * @param settings - routing settings.
 * @param input - request facts.
 * @param current - the Session's own model.
 * @param available - provider routes that are currently configured and routable.
 * @returns the decision; `routed` is false when the Session model is kept.
 */
export function route(
  settings: OrchestrationSettings['routing'],
  input: RouteInput,
  current: { readonly provider: string; readonly model: string },
  available: ReadonlySet<string>,
): RouteResult {
  const { category, reason } = classify(input)
  if (!settings.enabled) return { category, routed: false, reason: 'routing disabled; using the session model' }
  if (input.override === 'off') return { category, routed: false, reason: 'routing off for this agent; using the session model' }
  const configured = settings.categories[category]
  if (configured === undefined) return { category, routed: false, reason: `${reason}; no model configured for ${category}, using the session model` }
  if (!available.has(configured.provider)) {
    return { category, routed: false, reason: `${reason}; provider "${configured.provider}" for ${category} is not configured, using the session model` }
  }
  if (configured.provider === current.provider && configured.model === current.model) {
    return { category, model: configured, routed: false, reason: `${reason}; session model already matches ${category}` }
  }
  return { category, model: configured, routed: true, reason }
}
