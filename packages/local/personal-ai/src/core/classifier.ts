/**
 * Coordinator depth classifier. Decides how much machinery one request
 * deserves before the model sees it, so a greeting is answered directly and
 * only genuinely large work reaches workflows or background tasks. It is a
 * hint, not a cage: the coordinator may go deeper when the work demands it.
 */

/** Execution depths, cheapest first. */
export const DEPTHS = ['direct', 'clarify', 'tool', 'agent', 'workflow', 'background', 'approval'] as const

/** One execution depth. */
export type Depth = typeof DEPTHS[number]

/** Classification of one request. */
export interface DepthDecision {
  readonly depth: Depth
  /** Short human reason shown in the Activity view. */
  readonly reason: string
}

const SMALL_TALK = new RegExp(String.raw`^(?:hi|hii+|hello|hey|yo|sup|hiya|howdy|thanks|thank you|thx|ty|ok(?:ay)?|cool|nice|great|good (?:morning|afternoon|evening|night)|gm|gn|how are you(?: doing)?|what'?s up|bye|see you|cheers)\b[\s!.?,:)]*(?:kairoforge|there|friend|buddy)?[\s!.?,:)]*$`, 'i')
const DESTRUCTIVE = new RegExp([
  String.raw`\brm\s+-[a-z]*r[a-z]*f`, String.raw`\bforce[- ]push`, String.raw`\bpush\s+(?:-f|--force)`, String.raw`\breset\s+--hard`,
  String.raw`\bdrop\s+(?:table|database|schema)`, String.raw`\b(?:delete|wipe|erase|destroy|purge)\b.{0,40}\b(?:all|every|repo|repository|branch(?:es)?|database|files?|folder|directory|history|account|project)\b`,
  String.raw`\bformat\s+(?:the\s+)?(?:disk|drive)`, String.raw`\b(?:send|email|post|tweet|publish|message|dm)\b.{0,50}\b(?:everyone|client|customer|boss|team|public|twitter|x\.com|linkedin|slack)\b`,
  String.raw`\b(?:pay|purchase|buy|transfer money|wire)\b`, String.raw`\b(?:revoke|rotate)\s+(?:the\s+)?(?:keys?|tokens?|credentials?)`,
  String.raw`\bdeploy\b.{0,30}\bprod(?:uction)?\b`, String.raw`\buninstall\b`,
].join('|'), 'i')
const BACKGROUND = new RegExp(String.raw`\b(?:in the background|as a background task|background task|while i(?:'m| am)\b|overnight|keep (?:working|going|an eye)|monitor|watch for|every (?:day|hour|morning|night|week)|let me know when (?:it'?s|you'?re) done|when you'?re done,? (?:let me know|ping me|tell me))\b`, 'i')
const AGENT = new RegExp(String.raw`\b(?:ask|delegate|hand (?:this|it) (?:off|over)|assign)\b.{0,40}\b(?:agent|engineer|reviewer|researcher|team)\b|\b(?:engineer|main) agent\b|\bhave (?:the |my )?\w+ agent\b|\bget a (?:second opinion|review) from\b`, 'i')
const BUILD = /\b(?:build|create|implement|develop|set up|scaffold|migrate|refactor|rewrite|port|design and build)\b/i
const LARGE = new RegExp(String.raw`\b(?:full|complete|entire|whole|end-to-end|production[- ]ready|from scratch|app(?:lication)?|platform|system|service|website|dashboard|backend and frontend|frontend and backend|with (?:auth|tests|a database|deployment))\b`, 'i')
const VAGUE = new RegExp(String.raw`^(?:do it|fix it|fix this|make it (?:better|work|nicer)|change it|update it|that one|the other one|continue|go on|again|same thing|you know what i mean)[\s!.?]*$`, 'i')
const ACTION = new RegExp(String.raw`\b(?:open|read|show|list|find|search|grep|run|execute|check|look (?:up|at|into)|edit|write|create|make|add|remove|rename|move|copy|fix|install|test|build|commit|diff|status|git|file|folder|directory|repo|terminal|command|browser|website|url|screenshot|click|type|download|upload|summari[sz]e (?:this|the|my)|analy[sz]e (?:this|the|my))\b`, 'i')
const QUESTION = /^(?:what|why|how|who|when|where|which|is|are|can|could|should|would|does|do|explain|tell me|define)\b|\?\s*$/i
const NUMBERED = /(?:^|\n)\s*(?:\d+[.)]|[-*•])\s+\S/g

function words(text: string): number {
  return text.trim().split(/\s+/).filter(word => word !== '').length
}

/**
 * Classify one request into the cheapest depth that can handle it.
 * @param input - the user's message text (framing headers already removed).
 * @returns depth and reason.
 */
export function classifyDepth(input: string): DepthDecision {
  const text = input.trim()
  if (text === '') return { depth: 'direct', reason: 'empty message' }
  if (SMALL_TALK.test(text)) return { depth: 'direct', reason: 'greeting or small talk' }
  if (DESTRUCTIVE.test(text)) return { depth: 'approval', reason: 'destructive or sensitive action; confirm before acting' }
  if (BACKGROUND.test(text)) return { depth: 'background', reason: 'asked to run in the background or keep watching' }
  if (AGENT.test(text)) return { depth: 'agent', reason: 'asked to involve another agent' }
  const steps = text.match(NUMBERED)?.length ?? 0
  if (BUILD.test(text) && (LARGE.test(text) || steps >= 3 || words(text) > 60)) {
    return { depth: 'workflow', reason: 'large multi-part build' }
  }
  if (VAGUE.test(text)) return { depth: 'clarify', reason: 'no clear target; ask what to act on' }
  if (ACTION.test(text)) return { depth: 'tool', reason: 'needs tools on files, terminal, browser, or the computer' }
  if (QUESTION.test(text) || words(text) <= 25) return { depth: 'direct', reason: 'question or short request answerable directly' }
  return { depth: 'tool', reason: 'longer request that may need tools' }
}

/** Coordinator guidance for each depth, phrased for the model. */
export const DEPTH_GUIDANCE: Readonly<Record<Depth, string>> = {
  direct: 'Answer directly and briefly. Do not call tools, start workflows, or delegate.',
  clarify: 'The request has no clear target. Ask one short clarifying question before doing anything.',
  tool: 'Use only the tools this needs, yourself. Do not delegate or start a workflow for it.',
  agent: 'Pick the best main agent (recommend_agent), confirm the choice in one line, then delegate with delegate_to_main_agent.',
  workflow: 'This is large. Plan it, then run it with create_workflow (or propose the plan first if scope is unclear).',
  background: 'Run it with start_background_task on a suitable main agent and tell the user how to follow it.',
  approval: 'This is destructive or sensitive. State exactly what would happen and get explicit confirmation before any tool call.',
}
