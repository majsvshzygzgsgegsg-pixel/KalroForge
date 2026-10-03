/**
 * Capability router: groups the tools a Session already has into capability
 * categories (it never implements a tool itself), infers capability tags for
 * main agents, and ranks agents for a task.
 */

/** Capability categories the coordinator reasons about. */
export const CAPABILITY_CATEGORIES = [
  'FILES', 'TERMINAL', 'BROWSER', 'GIT', 'GITHUB', 'COMPUTER', 'SEARCH', 'PROJECT', 'AGENTS', 'WORKFLOWS', 'BACKGROUND_TASKS',
] as const

/** One capability category. */
export type CapabilityCategory = typeof CAPABILITY_CATEGORIES[number]

const EXACT: Readonly<Record<string, CapabilityCategory>> = {
  read: 'FILES', write: 'FILES', edit: 'FILES', str_replace_editor: 'FILES', apply_patch: 'FILES', read_image: 'FILES', present: 'FILES',
  glob: 'SEARCH', grep: 'SEARCH', lsp: 'SEARCH', web_search: 'SEARCH', web_fetch: 'SEARCH', session_search: 'SEARCH',
  bash: 'TERMINAL', pwsh: 'TERMINAL', job_list: 'TERMINAL', job_output: 'TERMINAL', job_kill: 'TERMINAL',
  create_checkpoint: 'GIT', list_checkpoints: 'GIT', compare_checkpoint: 'GIT', restore_checkpoint: 'GIT', delete_checkpoint: 'GIT', propose_rollback: 'GIT',
  create_project: 'PROJECT', open_project: 'PROJECT', update_project: 'PROJECT', archive_project: 'PROJECT', assign_agent_to_project: 'PROJECT', project_status: 'PROJECT',
  remember: 'PROJECT', recall: 'PROJECT', forget: 'PROJECT',
  search_brain: 'SEARCH', index_folder: 'PROJECT', link_entities: 'PROJECT', unlink_entities: 'PROJECT', graph_query: 'PROJECT',
  create_tool: 'TERMINAL', list_user_tools: 'TERMINAL',
  editor_context: 'FILES', open_in_editor: 'FILES', repo_map: 'SEARCH',
  create_workflow: 'WORKFLOWS', workflow_status: 'WORKFLOWS', cancel_workflow: 'WORKFLOWS', retry_workflow_task: 'WORKFLOWS', finish_workflow: 'WORKFLOWS', ralph: 'WORKFLOWS',
  start_background_task: 'BACKGROUND_TASKS', list_background_tasks: 'BACKGROUND_TASKS', control_background_task: 'BACKGROUND_TASKS', report_task_progress: 'BACKGROUND_TASKS',
  pause_task: 'BACKGROUND_TASKS', resume_task: 'BACKGROUND_TASKS', cancel_task: 'BACKGROUND_TASKS', update_task: 'BACKGROUND_TASKS', add_task_constraint: 'BACKGROUND_TASKS',
  schedule_create: 'BACKGROUND_TASKS', schedule_list: 'BACKGROUND_TASKS', schedule_update: 'BACKGROUND_TASKS', schedule_delete: 'BACKGROUND_TASKS',
}

const PATTERNS: ReadonlyArray<readonly [RegExp, CapabilityCategory]> = [
  [/^terminal_|^user_tool__/, 'TERMINAL'],
  [/github|^gh_|pull_request|webhook/, 'GITHUB'],
  [/(?:^|_)git(?:_|$)|checkpoint/, 'GIT'],
  [/computer|cua|screenshot|mouse|keyboard|(?:^|_)click|type_text|press_key|launch_app|open_app|applescript|window/, 'COMPUTER'],
  [/browser|navigate|stagehand|playwright|page_|tab_|devtools/, 'BROWSER'],
  [/main_agent|delegate|agent_message|send_message|teammate|team_task|list_agents|wait_agent|interrupt_agent|agent_team|recommend_agent|propose_agent|subagent/, 'AGENTS'],
  [/workflow/, 'WORKFLOWS'],
  [/background|schedule|_task$/, 'BACKGROUND_TASKS'],
  [/search|fetch|mcp_resource/, 'SEARCH'],
  [/file|fs_|dir|path/, 'FILES'],
]

/**
 * Category of one registered tool.
 * @param name - tool name as registered.
 * @returns category, or undefined for tools outside every category.
 */
export function categoryOf(name: string): CapabilityCategory | undefined {
  const exact = EXACT[name]
  if (exact !== undefined) return exact
  const lower = name.toLowerCase()
  return PATTERNS.find(([pattern]) => pattern.test(lower))?.[1]
}

/** Tools grouped by capability category. */
export interface ToolGroups {
  readonly categories: Record<CapabilityCategory, string[]>
  readonly other: string[]
}

/**
 * Group tool names by category.
 * @param names - registered tool names.
 * @returns every category (possibly empty) plus uncategorized tools.
 */
export function groupTools(names: readonly string[]): ToolGroups {
  const categories = Object.fromEntries(CAPABILITY_CATEGORIES.map(category => [category, [] as string[]])) as ToolGroups['categories']
  const other: string[] = []
  for (const name of [...new Set(names)].toSorted()) {
    const category = categoryOf(name)
    if (category === undefined) other.push(name)
    else categories[category].push(name)
  }
  return { categories, other }
}

// ---------------------------------------------------------------------------
// Agent capability tags and selection

/** Capability tags a main agent can carry. */
export const AGENT_TAGS = ['coding', 'review', 'testing', 'research', 'writing', 'design', 'devops', 'data', 'browser', 'computer', 'planning'] as const

/** One agent capability tag. */
export type AgentTag = typeof AGENT_TAGS[number]

const TAG_WORDS: Readonly<Record<AgentTag, RegExp>> = {
  coding: /\b(?:code|coding|engineer|developer|implement|refactor|bug|typescript|python|javascript|react|api|backend|frontend|program)/i,
  review: /\b(?:review|audit|critique|quality|security review|code review|lint)/i,
  testing: /\b(?:test|tests|testing|qa|e2e|vitest|jest|coverage)/i,
  research: /\b(?:research|investigate|find out|compare|survey|sources|look up|analy[sz]e)/i,
  writing: /\b(?:write|writing|docs|documentation|copy|blog|readme|summar|email|report)/i,
  design: /\b(?:design|ui|ux|layout|css|figma|visual|brand|style)/i,
  devops: /\b(?:deploy|devops|ci|docker|kubernetes|infra|server|pipeline|release)/i,
  data: /\b(?:data|sql|database|csv|spreadsheet|analytics|chart|metrics)/i,
  browser: /\b(?:browser|website|web page|scrape|crawl|navigate)/i,
  computer: /\b(?:computer|desktop|app control|click|automation|macos)/i,
  planning: /\b(?:plan|planning|roadmap|architecture|coordinate|organi[sz]e)/i,
}

/**
 * Tags whose keywords appear in a text.
 * @param text - task or agent description.
 * @returns matching tags.
 */
export function tagsIn(text: string): AgentTag[] {
  return AGENT_TAGS.filter(tag => TAG_WORDS[tag].test(text))
}

/** What selection knows about one main agent. */
export interface AgentCandidate {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly status: 'running' | 'stopped' | 'archived'
  readonly runtime: 'busy' | 'idle' | 'unloaded'
  readonly preset: string
  readonly template?: string
  /** User-set tags; when absent, tags are inferred from the description. */
  readonly tags?: readonly AgentTag[]
  readonly projectIds: readonly string[]
  /** Projects the agent recently worked on (delegations, background tasks). */
  readonly recentProjectIds?: readonly string[]
  readonly hasModel: boolean
}

/**
 * Capability tags for an agent: user-set tags win, otherwise inferred.
 * @param agent - candidate.
 * @returns tags.
 */
export function agentTags(agent: Pick<AgentCandidate, 'tags' | 'description' | 'instructions' | 'template' | 'name'>): AgentTag[] {
  if (agent.tags !== undefined && agent.tags.length > 0) return [...agent.tags]
  const inferred = new Set(tagsIn(`${agent.name} ${agent.description} ${agent.instructions}`))
  if (agent.template === 'engineer') for (const tag of ['coding', 'testing', 'review'] as const) inferred.add(tag)
  return AGENT_TAGS.filter(tag => inferred.has(tag))
}

/** One ranked candidate with the reasons behind its score. */
export interface AgentScore {
  readonly id: string
  readonly name: string
  readonly score: number
  readonly reasons: readonly string[]
}

const WRITE_WORDS = /\b(?:edit|change|fix|implement|write|create|refactor|update|delete|install|commit)\b/i
const READ_ONLY_PRESETS = new Set(['read-only'])

/**
 * Rank main agents for a task by capability, availability, project, model,
 * permissions, and prior context. Archived agents are never candidates.
 * @param candidates - agents to consider.
 * @param task - task text.
 * @param projectId - active project, if any.
 * @returns best first.
 */
export function rankAgents(candidates: readonly AgentCandidate[], task: string, projectId?: string): AgentScore[] {
  const wanted = tagsIn(task)
  const writes = WRITE_WORDS.test(task)
  return candidates
    .filter(agent => agent.status !== 'archived')
    .map((agent) => {
      const reasons: string[] = []
      let score = 0
      const tags = agentTags(agent)
      const matched = wanted.filter(tag => tags.includes(tag))
      if (matched.length > 0) {
        score += matched.length * 3
        reasons.push(`capabilities: ${matched.join(', ')}`)
      } else if (wanted.length > 0) {
        reasons.push(`no matching capability (${wanted.join(', ')})`)
      }
      if (agent.status === 'running' && agent.runtime !== 'busy') {
        score += 2
        reasons.push('available now')
      } else if (agent.runtime === 'busy') {
        score -= 1
        reasons.push('busy with another turn')
      } else {
        reasons.push('stopped (will be started)')
      }
      if (projectId !== undefined && agent.projectIds.includes(projectId)) {
        score += 3
        reasons.push('assigned to the active project')
      } else if (projectId !== undefined && agent.recentProjectIds?.includes(projectId) === true) {
        score += 1
        reasons.push('worked on this project before')
      }
      if (agent.hasModel) score += 0.5
      if (writes && READ_ONLY_PRESETS.has(agent.preset)) {
        score -= 4
        reasons.push('read-only permissions cannot make the changes')
      }
      return { id: agent.id, name: agent.name, score, reasons }
    })
    .toSorted((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/** A main-agent configuration proposed to the user before anything is created. */
export interface AgentProposal {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly mode: string
  readonly permissions: { readonly preset: string; readonly agentAdministration: false }
  readonly tags: readonly AgentTag[]
  readonly tools: { readonly deny: readonly string[] }
}

/**
 * Propose a main agent for a described need. Read-only work gets the
 * read-only preset; nothing ever proposes administration or full access.
 * @param need - what the agent is for.
 * @param name - preferred name, if the user gave one.
 * @returns the proposal.
 */
export function proposeAgent(need: string, name?: string): AgentProposal {
  const tags = tagsIn(need)
  const readOnly = (tags.includes('review') || tags.includes('research')) && !WRITE_WORDS.test(need)
  const primary = tags[0] ?? 'planning'
  const title = name?.trim() !== undefined && name.trim() !== '' ? name.trim() : `${primary[0]?.toUpperCase() ?? ''}${primary.slice(1)} Agent`
  return {
    name: title.slice(0, 60),
    description: need.trim().slice(0, 200),
    instructions: [
      `Focus: ${need.trim()}`,
      'Verify your work before reporting it. Never claim something is done without evidence.',
      readOnly ? 'You review and report; you do not change files.' : 'Keep changes small and explain what you changed.',
    ].join('\n'),
    mode: 'standard',
    permissions: { preset: readOnly ? 'read-only' : 'workspace-write', agentAdministration: false },
    tags: tags.length > 0 ? tags : ['planning'],
    tools: { deny: readOnly ? ['write', 'edit', 'str_replace_editor', 'apply_patch'] : [] },
  }
}
