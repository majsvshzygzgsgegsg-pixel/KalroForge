# ForgePilot

ForgePilot is an original, auditable agent harness for OpenAI-compatible APIs, with first-class
DeepSeek defaults. Version 0.2 expands the coding harness into a capability-driven platform with a
tool registry, plugins, Git and browser packs, bounded sub-agents, GitHub discovery, and diagnostics.

It is not affiliated with or endorsed by DeepSeek. “DeepSeek” identifies a compatible model
provider; ForgePilot does not copy proprietary code, UI, or branding.

## Status

| Area | Status | Notes |
| --- | --- | --- |
| Agent loop and OpenAI-compatible provider | Implemented | Bounded turns, output tokens, resumable JSONL sessions |
| Tool Registry and capability resolution | Implemented | Only task-relevant capabilities are exposed to the model |
| Built-in workspace and Git packs | Implemented | Git writes are approval-gated; safe revert creates backups |
| Plugin manifests and local installation | Implemented | Static validation, provenance, explicit permissions, disabled by default |
| GitHub tool discovery | Implemented | Metadata-only search; every result is marked untrusted/unverified |
| Browser pack | Experimental | Playwright adapter loads only when Playwright is already installed |
| Sub-agents | Implemented | Bounded count/depth/turns; explicit tools; parallel writes rejected |
| MCP configuration and adapter boundary | Experimental | Configuration commands work; runtime protocol transport is planned |
| Download/install directly from discovery | Planned | Intentionally separated from search until stronger artifact verification exists |
| OS-level JavaScript plugin sandbox | Planned | Current plugin isolation is capability-scoped API access, not a security sandbox |

## Quick start

```bash
export DEEPSEEK_API_KEY="your-key"
npm test
node src/cli.js doctor
node src/cli.js tools list
node src/cli.js run --workspace ./my-project "Inspect the code, fix the bug, and run tests"
```

## Local web app

ForgePilot includes an original local chat UI inspired by modern AI workspaces. It provides local
session history, responsive desktop/mobile layout, live tool status, resumable agent sessions, and
approval cards for write, network, system, and high-risk actions.

```bash
export DEEPSEEK_API_KEY="your-key"
npm run serve
```

Open [http://127.0.0.1:3210](http://127.0.0.1:3210). To operate on a particular project, start the
server from that directory or pass an explicit workspace:

```bash
node /path/to/forgepilot/src/cli.js serve --workspace /path/to/project --port 3210
```

The server binds to loopback only, rejects non-local Host and Origin values, caps request bodies,
uses a restrictive Content Security Policy, and never sends the provider key to the browser. Chat
runs execute asynchronously and pause for browser approval when a selected tool is risky. The UI
stores titles and rendered message history in browser local storage; authoritative agent checkpoints
remain under the workspace's `.forgepilot/sessions/` directory.

The runtime has no required third-party dependencies and does not automatically load `.env`. Use a
shell, secret manager, or Node's built-in environment-file support:

```bash
cp .env.example .env
node --env-file=.env src/cli.js run "Explain this repository"
```

## Architecture

```text
CLI
 └─ Agent orchestrator
     ├─ Model Router ──> OpenAI-compatible provider(s)
     ├─ Capability resolver ──> task-scoped tool definitions
     ├─ Approval policy
     ├─ JSONL session store
     ├─ Bounded sub-agent manager
     └─ Tool Registry
         ├─ workspace pack
         ├─ Git pack
         ├─ optional Playwright browser pack
         ├─ reviewed plugins
         └─ MCP adapter boundary (experimental)
```

Every tool uses the same registry contract:

```js
{
  name,
  version,
  description,
  capabilities,
  inputSchema,
  riskLevel, // safe | write | network | system | high-risk
  source,
  execute
}
```

The registry supports registration, removal, lookup, search, enable/disable state, capability
enumeration, model-schema generation, and execution. Duplicate or malformed tools fail closed.

## Tools and capabilities

The capability resolver maps a task to high-level needs such as `filesystem.read`,
`filesystem.write`, `process.execute`, `git.read`, `git.write`, `browser.read`, `browser.write`,
`network`, and `agent.delegate`. The model sees only matching registered tools. A tool call that was
not granted for the task is rejected even if that tool exists in the registry.

```bash
node src/cli.js tools list
node src/cli.js tools info git_diff
```

Built-in workspace tools preserve the original `list_files`, `read_file`, `write_file`, `search`,
and shell-free command execution behavior.

## Plugins

Project-local plugins live under `.forgepilot/plugins/`. A plugin directory must contain
`forgepilot.plugin.json`:

```json
{
  "name": "example-pack",
  "version": "1.0.0",
  "description": "Example tools",
  "entry": "index.js",
  "capabilities": ["filesystem.read"],
  "permissions": ["filesystem.read"],
  "forgepilot": ">=0.2.0",
  "source": {
    "url": "https://github.com/example/example-pack",
    "revision": "full-commit-sha"
  }
}
```

The entry module exports `createTools(context)` and returns registry-compatible tool descriptors.
ForgePilot passes only the workspace path and declared permission names as plugin context. A plugin
cannot register privileged capabilities it did not declare and receive permission for.

Local installation is deliberately two-step:

```bash
node src/cli.js tools install ../reviewed-example-pack
node src/cli.js tools enable example-pack
```

The installer inspects the manifest and entry path, rejects symlinks, limits file count/size, rejects
package lifecycle scripts and undeclared dependencies, shows an approval prompt, copies into a
project-local directory, records a SHA-256 and installation log, and leaves the plugin disabled.
Failures are logged in `.forgepilot/install-logs/` and never disable the core harness.

Important: enabled JavaScript plugins execute in the ForgePilot process. Permission metadata limits
the capabilities ForgePilot supplies and registers; it is not an operating-system sandbox. Review
source before enabling a plugin.

### Bundled example: `playwright-mcp-bridge`

`plugins-src/playwright-mcp-bridge/` is a reviewed, locally authored plugin that drives a browser
through the [Playwright MCP](https://github.com/microsoft/playwright-mcp) server over newline-
delimited JSON-RPC on stdio. It is the worked example of the plugin contract rather than a vendored
third-party repo: the upstream server is **not** copied into this project, so review and install it
yourself before enabling the bridge.

```bash
node src/cli.js tools install plugins-src/playwright-mcp-bridge --approval never
node src/cli.js tools enable playwright-mcp-bridge
```

It registers five tools, each mapped onto an upstream MCP method and declared with a capability that
matches a permission in its manifest:

| ForgePilot tool | MCP method | Capability | Risk |
| --- | --- | --- | --- |
| `pw_open` | `browser_navigate` | `browser.read` | network |
| `pw_snapshot` | `browser_snapshot` | `browser.read` | safe |
| `pw_click` | `browser_click` | `browser.write` | high-risk |
| `pw_type` | `browser_type` | `browser.write` | high-risk |
| `pw_close` | `browser_close` | `browser.read` | safe |

Configuration is environment-only, and the server command must be a bare executable name resolved
through `PATH` — absolute paths, shell interpreters, and shell metacharacters are rejected:

```bash
FORGEPILOT_PLAYWRIGHT_MCP_COMMAND=npx                      # default
FORGEPILOT_PLAYWRIGHT_MCP_ARGS="-y,@playwright/mcp@latest" # comma-separated, default
```

The bridge connects lazily on first tool use, so importing it never spawns a process or downloads
Playwright. If the configured command is unsafe, the tools stay visible but every call fails closed
with the reason, instead of the plugin silently registering nothing.

## GitHub discovery

```bash
node src/cli.js tools search "browser automation"
node src/cli.js tools search "github MCP" --json
```

Search uses GitHub's repository metadata API and reports repository, description, language, license,
update time, stars, clone URL, and compatibility state. Results are always `trusted: false` and
`compatibility: unverified`. Search does not clone, install, import, or execute repository code.
Set `GITHUB_TOKEN` in the environment only if you need higher API limits.

## Browser automation

The experimental browser pack uses Playwright when the `playwright` package is already available.
It provides open/navigate, structured snapshot, click, type, scroll, back/forward, tab listing, and
close operations. It returns DOM-derived text and links instead of guessing coordinates.

Network navigation is approval-gated. Click and type are marked high-risk because they can submit
forms or cause external side effects. ForgePilot does not install Playwright or browser binaries on
your behalf; `doctor` reports a warning when they are absent.

## Git-aware coding

The built-in Git pack provides status, diff, log, branch listing, branch creation, patch validation
and application, and safe reversion. Commands use argument arrays rather than a shell. Patch writes,
branch creation, and reversion pass through approval policy. Safe reversion requires explicit paths
and stores the current file versions in `.forgepilot/backups/` before restoring from `HEAD`.

## Sub-agents

The coordinator can delegate tasks through `delegate_task`. Every sub-agent receives a specific
task, explicit capabilities, a capped turn count, relevant tool definitions only, and an optional
cancellation signal. Limits are controlled by:

```text
FORGEPILOT_MAX_SUB_AGENTS=5
FORGEPILOT_MAX_SUB_AGENT_DEPTH=2
FORGEPILOT_MAX_PARALLEL_AGENTS=2
FORGEPILOT_MAX_SUB_AGENT_TURNS=8
```

Delegation capability is stripped from sub-agents, depth/count/parallel limits fail closed, and the
parallel API rejects tasks with write capabilities.

## MCP

MCP is behind an adapter so the core registry and agent do not depend on one provider or transport.
The current experimental commands manage disabled-by-default stdio server declarations:

```bash
node src/cli.js mcp list
node src/cli.js mcp add local-docs --command my-mcp-server --args "--stdio"
node src/cli.js mcp doctor
node src/cli.js mcp remove local-docs
```

The runtime connection, protocol negotiation, schema conversion, and call routing remain planned.
Configured MCP servers are not launched automatically.

## Configuration

CLI flags and environment variables preserve the original OpenAI-compatible settings:

```text
DEEPSEEK_API_KEY
FORGEPILOT_BASE_URL=https://api.deepseek.com
FORGEPILOT_MODEL=deepseek-chat
FORGEPILOT_MAX_TURNS=20
FORGEPILOT_MAX_OUTPUT_TOKENS=4096
FORGEPILOT_MAX_TOTAL_TOKENS=100000
FORGEPILOT_APPROVAL=on-risk
```

Internally configuration is grouped into model, agent, tools, and plugins views while legacy
top-level fields remain available for backward compatibility. No secrets are written to config or
session files by ForgePilot.

## Doctor

```bash
node src/cli.js doctor
node src/cli.js doctor --connect
node src/cli.js doctor --json
```

Doctor reports `PASS`, `WARNING`, or `FAIL` for Node, configuration, credentials, optional provider
connectivity, workspace access, Git, plugin manifests/load errors, Playwright, MCP, and session
storage. Optional component failures do not stop core startup.

## Approvals and security model

`--approval on-risk` is the default. Write, network, system, and high-risk tools require approval;
`always` gates every tool. `never` should only be used inside an external sandbox. Non-interactive
sessions fail closed when approval is required.

ForgePilot blocks lexical path traversal, rejects plugin symlinks, runs commands without shell-string
interpretation, caps captured command output, bounds agent loops, preserves Git backups, and keeps
discovery separate from installation. It remains a harness, not a complete security boundary. A
model, dependency, browser page, MCP server, or enabled plugin may be malicious. Use a disposable
checkout or container for untrusted work and never expose broad credentials.

## Development

```bash
npm test
npm run check
node src/cli.js tools list --json
node src/cli.js doctor
```

Tests cover the original provider and workspace behavior plus registry lifecycle, duplicate and
disabled tools, capability grants, approval risk, plugin validation and permissions, failed and
disabled installation, Git operations/backups, GitHub parsing, sub-agent limits and recursion,
session persistence, tool failures, traversal protection, and output caps.

## Next phase

The recommended next milestone is a real MCP stdio client plus OS-isolated plugin workers with
signed/checksummed remote artifacts. After those boundaries are proven, discovery can feed a
reviewable remote-fetch pipeline without collapsing “found on GitHub” into “trusted to execute.”

## License

MIT
