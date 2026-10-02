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
