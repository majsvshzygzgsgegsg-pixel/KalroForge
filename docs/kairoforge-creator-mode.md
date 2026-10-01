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
