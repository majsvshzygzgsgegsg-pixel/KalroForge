# @local/main-agents

The KairoForge Agent Registry: persistent **main agents** that sit alongside Lead. A main agent is not a sub-agent. Each one is a registry record bound to its own top-level chat Session, so it has:

- its own chat, opened from the Agents page;
- its own mode, model, and provider, which leave the global default model untouched;
- its own tool limits and optional workspace;
- its own permission preset, applied through the existing permission system;
- its own Agent Team, because every top-level Session leads one.

Records persist in the `main_agents` storage domain at `~/.dsh/storages/main_agents.json`, so main agents survive restarts. A running agent resumes its existing Session on the next start. If persistence never kept the Session, for example a blank one, the agent is bound to a fresh Session and the old id is kept in `previousSessionIds`.

## Using it

- **Agents page.** Open **Agents** in the sidebar. Use **Create Main Agent** for a new agent and the row actions to Start, Stop, Restart, Edit, Clone, Archive, or Open chat. Lead's card holds the Agent Administration mode toggles.
- **Tools.** Sessions with Agent Administration get `create_main_agent`, `clone_main_agent`, `edit_main_agent`, `archive_main_agent`, `start_main_agent`, `stop_main_agent`, `restart_main_agent`, `assign_model`, `assign_mode`, `assign_tools`, `assign_workspace`, `create_agent_team`, and `manage_agent_permissions`. Every top-level Session gets `list_main_agents`, `get_main_agent`, `send_agent_message`, and `delegate_task`.
- **REST.** The page uses `GET /main-agents/state` together with `POST /main-agents/create`, `POST /main-agents/settings`, and `POST /main-agents/agent/<id>/<action>`. Every route uses the web connection's authentication and its Host and Origin checks.

## Security model

- Agent Administration belongs to top-level Sessions whose mode is listed in `administratorModes`. By default that is `cordis` (Creator) and `standard` (KairoForge Lead). A main agent holds it only when the user grants it. Sub-agents never hold it.
- New agents default to the `workspace-write` preset without Agent Administration. The form offers only `read-only` and `workspace-write`; full access needs `/permission` inside the agent's chat.
- Model-initiated calls ask the user for approval through the standard approval flow before they archive an agent, grant Agent Administration, widen the preset, set a workspace, or change tool limits.
- An agent's tool lists are enforced at execution time for every tool. Tools outside the allow list, and tools on the deny list, are also hidden from the model where the tool registry allows it.

## Development

```sh
pnpm vitest run packages/local/main-agents/tests/registry.spec.ts
npx tsc -b packages/local/main-agents/tsconfig.host.json packages/local/main-agents/tsconfig.client.json
pnpm --filter @local/main-agents run bundle
```
