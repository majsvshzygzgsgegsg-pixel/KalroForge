# KairoForge Creator Mode

Creator mode is the KairoForge mode for changing KairoForge itself, building project features, creating reusable team members, and publishing verified updates to the configured GitHub project.

## Permanent agent members

Creator mode uses [`.kairoforge/agent-members.json`](../.kairoforge/agent-members.json) as the durable roster for permanent agent members. The default roster starts with Lead plus Architect, Builder, and Publisher specialists.

When the user asks Creator mode to make a permanent agent member, KairoForge should update that roster instead of only spawning a temporary subagent. A member entry needs:

- a stable lowercase `id`;
- a visible `name`;
- a clear `description`;
- a `defaultPrompt` that explains what the member does;
- a focused `capabilities` list;
- `fileAccess.mode`, normally `workspace-write`;
- `permanent: true`;
- `status: active`.

Temporary subagents are still useful for one-off work. Permanent members are for roles the user wants to keep across later sessions.

## Main agents and the Agent Registry

A main agent is a persistent top-level agent that sits alongside Lead. It is not a sub-agent: each main agent owns its own chat Session, model, mode, tool limits, optional workspace, permission preset, and sub-agent team, and it survives KairoForge restarts. The Agent Registry in [`@local/main-agents`](../packages/local/main-agents/README.md) is the source of truth; it persists to `~/.dsh/storages/main_agents.json`.

Manage main agents in two ways:

- the **Agents** page in the sidebar, which has a **Create Main Agent** button and Start, Stop, Restart, Edit, Clone, Archive, and Open chat actions;
- the Agent Administration tools, `create_main_agent`, `clone_main_agent`, `edit_main_agent`, `archive_main_agent`, `start_main_agent`, `stop_main_agent`, `restart_main_agent`, `get_main_agent`, `list_main_agents`, `assign_model`, `assign_mode`, `assign_tools`, `assign_workspace`, `create_agent_team`, `manage_agent_permissions`, `send_agent_message`, and `delegate_task`.

Creator and Lead sessions hold Agent Administration by default; the modes that do are configured on the Agents page. A main agent receives Agent Administration only when the user grants it. Every top-level Session, main agent or Lead, can use `list_main_agents`, `get_main_agent`, `send_agent_message`, and `delegate_task`; sub-agents cannot.

Permissions go through the existing permission presets. New main agents start with `workspace-write` and no Agent Administration. A model-initiated call that archives an agent, grants Agent Administration, selects a preset wider than `workspace-write`, sets a workspace, or changes tool limits asks the user for approval first. Full access is granted only with `/permission` inside the agent's own chat.

## Agent orchestration

The orchestration layer lives in `@local/main-agents` under `src/orchestration/`. It builds on the Agent Registry, the Agent Team, sessions, permissions, and the provider and model configuration; it does not replace any of them. It persists to `~/.dsh/storages/main_agent_orchestration.json`, so workflows, checkpoints, loop events, background tasks, delegations, routing decisions, and settings survive restarts.

Most features apply to **managed** sessions: main agents, their sub-agents and workflow workers, and Fast Mode sessions. Plain Lead chats behave as before unless model routing scope is set to `all`.

The Agents page has four tabs:

- **Agents** — the registry, plus an **Activity** button per agent that opens a live dashboard. It shows status, current task, model and provider, mode, workspace, permissions, runtime, steps, tool calls, context usage, routing override, tasks, sub-agents, workflows, recent tool calls, checkpoints, loop events, errors, and the activity log.
- **Orchestration** — the Lead → main agents → sub-agents tree, workflow graphs, delegations, loop recovery metrics, model routing settings, recent routing decisions, and notifications.
- **Background tasks** — queue, pause, resume, cancel, and open tasks.
- **Checkpoints** — create, compare, restore, and delete Git checkpoints.

### Workflows

A main agent splits work with `create_workflow`. Each task gets a dynamically named specialist role, optional `dependsOn` tasks, and a retry budget. Tasks run in parallel unless one depends on another. Results of finished dependencies are passed into dependent tasks. When every task settles, the owning main agent receives the results and integrates them with `finish_workflow`. Use `workflow_status`, `cancel_workflow`, and `retry_workflow_task` to manage a run; the Orchestration tab shows the graph and has Retry and Cancel buttons.

### Git checkpoints and rollback

A checkpoint stores the whole workspace, including uncommitted and untracked files, as a Git ref under `refs/kairoforge/checkpoints/`. It never touches the branch, index, or working tree. Each record keeps the agent, task, branch, HEAD, dirty files, agent-written files, and test results before and after.

Checkpoints are taken automatically before the first mutating tool call of a managed turn, at workflow start, and before every restore. Agents use `create_checkpoint`, `list_checkpoints`, `compare_checkpoint`, `propose_rollback`, `restore_checkpoint`, and `delete_checkpoint`.

Restore protects your work:

- The default scope, `touched`, restores only files an agent wrote. A file that changed since the checkpoint and was not written by an agent is skipped and reported.
- Scope `all` must be chosen explicitly and acknowledged in the UI.
- A pre-restore safety checkpoint is always taken first, so a restore can itself be undone.
- An agent-initiated restore or delete asks for approval.

### Git protection

For managed sessions, agent Git commands go through a guard. Force-pushing or deleting a protected branch is denied. A plain push to a protected branch, any force-push, `git reset --hard`, `git clean -f`, `git checkout .` and `git restore .`, and `git stash drop` or `clear` all ask for approval. Protected branches default to `main` and `master`.

### Loop detection and recovery

The detector watches for:

- repeated reads;
- near-identical edits;
- the same failing command or the same error;
- alternating actions;
- too many steps without progress.

On a detection the agent is **not** stopped. It receives recovery guidance: pause, summarize what happened, question the assumption behind the repeated step, consider delegating a diagnosis to a teammate, and continue with a new plan. If the pattern recurs after that guidance, the agent receives an escalation telling it to delegate a diagnosis or stop and report to the user. Each detection posts a notification and shows on the Orchestration tab and the agent's dashboard, with counts of detections, recoveries, recurrences, and delegated diagnoses.

### Background tasks

Use the Background tasks tab or `start_background_task` to queue work for a main agent. The agent reports progress with `report_task_progress` and finishes with `return_task_result`. Tasks can be paused, resumed, and cancelled, and they keep running when you leave the chat or close the browser. After a KairoForge restart, interrupted tasks resume automatically. Completion and failure post notifications, which the Agents page shows as toasts.

### Delegation between main agents

A main agent can:

- hand a task to another main agent with `delegate_to_main_agent`;
- ask for a review with `request_agent_review`;
- send a message with the existing `send_agent_message`.

The receiving agent answers with `return_task_result`, and the result is delivered back to the requester's session. Each delegation records its owner, depth, and chain. Self-delegation, cycles, and chains deeper than `delegation.maxDepth` (default 3) are refused.

### Model routing

Routing classifies each managed turn as FAST, STANDARD, DEEP_REASONING, CODING, REVIEW, or VISION. If that category has a configured provider and model, the turn runs on it; otherwise the session's own model is used. Either way the decision and its reason are recorded and shown.

Routing reuses the existing provider configuration: categories reference providers and models already set up in KairoForge, and API keys are never stored, logged, or displayed by the routing layer. If a routed model fails, KairoForge reports the provider error (with secrets redacted); it does not silently retry on another model.

Configure categories on the Orchestration tab. Each agent's dashboard has a routing select: Automatic, Off, or a pinned category.

### Fast Mode

`fast` is a new agent preset, selectable like any other mode, including for main agents. Compared with KairoForge mode it:

- skips plan mode and goal tools;
- has no sub-agent tool group, no workflows, and no outgoing delegation;
- compacts context earlier and prunes tool results more tightly;
- routes to the FAST model category when one is configured.

Fast Mode keeps `return_task_result` and `report_task_progress`, so it can still answer delegated and background work. Permissions, approvals, Git protection, checkpoints, loop detection, and honest test reporting are unchanged.

### KairoForge Engineer

On first start the registry creates a stopped **KairoForge Engineer** main agent. It follows INSPECT → PLAN → CHECKPOINT → IMPLEMENT → TEST → DEBUG → REVIEW → VERIFY → PREPARE CHANGE, works on a `kairoforge/<topic>` branch, and never pushes to `main` or `master` directly. It uses the default model, never stores credentials, and has `workspace-write` permissions. Start it from the Agents page when you want it.

### Disabling features

| Feature | How to disable |
| --- | --- |
| The whole orchestration layer | Set `orchestration: false` in the `local-main-agents` plugin config (`packages/bundle/web-app/cordis.patch.yml` or the Plugins page). The registry and Agents page keep working. |
| KairoForge Engineer | Set `engineer: false`, or archive the agent. |
| Model routing | Turn off the **Model routing** switch on the Orchestration tab (`routing.enabled`). Per agent, set routing to **Off** in its dashboard. Set scope to `managed` (the default) to leave Lead chats alone. |
| Loop recovery | Turn off the **Loop recovery** switch (`loops.enabled`). Tune `loops.noProgressSteps` (default 40). |
| Automatic checkpoints | `checkpoints.auto: false`. Manual checkpoints still work. |
| Protected branches | Edit `checkpoints.protectedBranches` (default `main`, `master`). |
| Delegation depth | `delegation.maxDepth` (1–8, default 3). |
| Resuming background tasks after restart | `background.resumeOnRestart: false`. |
| Fast Mode | Don't select the `fast` mode, or remove `presets/fast.patch.yml` from the web-app bundle. |
| Orchestration tools in tool-free modes | Modes in `toolFreeModes` (default `chat`, `minimal`) never receive main-agent or orchestration tools. |

The settings above are saved through `POST /main-agents/orchestration/settings` by the Orchestration tab and stored in the orchestration storage file.

## File access

Creator mode file access is workspace-scoped. The active workspace is the project root shown to the session, and permanent members must not silently read or write outside that workspace. Members may edit files, run project commands, commit, push, and restart the app when the user asks for those outcomes, but they must preserve unrelated dirty files and never stage secrets, local caches, build outputs, or private folders.

## Publishing

When the user says to publish after a Creator change, KairoForge should:

1. inspect `git status`;
2. stage only files changed for the requested update;
3. run the narrowest useful verification;
4. commit with a clear message;
5. push to the configured branch;
6. confirm the pushed commit;
7. restart the local KairoForge server if the app changed;
8. open the newest local version for the user.

If GitHub authentication, branch protection, missing remotes, tests, or build errors block publishing, KairoForge should say exactly what blocked it and avoid pretending the publish happened.

## Plugin catalog

KairoForge tracks plugin catalog setup in [`.kairoforge/plugin-catalog.json`](../.kairoforge/plugin-catalog.json). The Awesome DSH Plugin repository is a curated list, not a single bundle that should be installed all at once. Installing every listed plugin would execute large amounts of third-party code with the user's permissions and can break the profile.

Use `dshmarket` as the installed market interface for that catalog. It lets the user browse and install catalog entries one at a time from inside KairoForge. If a plugin is rejected by runtime compatibility checks, do not grant an exact-version exemption unless the user explicitly accepts the named risk for that exact plugin version and KairoForge runtime.

## External connectors

KairoForge tracks external service connectors in `.kairoforge/connectors/*.json`.
The Holo Gestures connector is `.kairoforge/connectors/holo-gestures.json`.
It points at `https://github.com/zubair-trabzada/holo-gestures.git`, installs to
`~/holo`, and starts with `python3 server.py` from that checkout.

Creator mode may clone, inspect, edit, and run the Holo checkout when the user
asks for Holo Gestures changes. Keep Holo source edits in `~/holo` separate from
KairoForge connector UI/config edits in this repository, and do not stage
secrets, caches, virtual environments, or generated artifacts.
