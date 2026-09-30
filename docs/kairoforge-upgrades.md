# KairoForge upgrade blueprint

English | [中文](kairoforge-upgrades.zh.md)

KairoForge is a product layer over DeepSeek Harness, not a replacement runtime. The fork keeps
the upstream MIT attribution, plugin contracts, permission gates, bounded tools, durable session
format, and local-first defaults. It does not copy or emulate any model's hidden reasoning.

## Capability map

| Area | Foundation already in the repository | KairoForge direction |
|---|---|---|
| Visual workflows | Workflow tools, durable run events, run UI | Node canvas, templates, validation, replay-from-node |
| Team control room | Experimental durable Agent Teams service and roster/task UI | Timeline, cost/status overview, worktree isolation, operator controls |
| Memory control | Session persistence, compaction, projection cache | Search, pin/edit/delete controls, provenance and retention policies |
| Voice | Optional local SenseVoice bundle and microphone UI | Push-to-talk, continuous mode, interruption, provider choice |
| Model router | Provider registry, model settings, model selection | Rule-based routing, fallback, budgets, latency/quality telemetry |
| Evaluation lab | Replay fixtures, trajectory UI, snapshots | Dataset runner, side-by-side grading, regression dashboards |
| Plugin marketplace | Plugin registry and install/enable/remove UI | Trust metadata, compatibility checks, curated collections |
| Git workspace | Workspace changes, files, terminal, review surfaces | Branch/worktree manager, commit/PR flow, conflict assistant |
| Security | Permission presets, approvals, sandbox policy | Unified audit log, secret posture, network/filesystem capability view |
| Offline app | Relative asset build, manifest, desktop packaging | Full PWA cache policy, offline diagnostics, signed installers |
| Design studio | Theme tokens, appearance settings, slot system | Live token editor, reusable themes, layout presets |
| Mobile | Responsive shell foundations, install metadata, Chat-mode PWA launch | Touch navigation and compact control room |

## Delivery rules

1. Stable repository capabilities are surfaced before parallel replacements are created.
2. Experimental features stay labeled and opt-in until their failure and migration contracts are stable.
3. Destructive, network, shell, and write operations remain gated by the existing permission system.
4. Every product-visible phase includes focused UI tests and an assembled-app snapshot before release.
5. Model providers remain configurable; KairoForge does not bundle or imitate proprietary model internals.

## Brand profile

Run `pnpm run kairoforge` or `make kairoforge`. The `kairoforge` build profile supplies the
KairoForge title, sidebar wordmark, conversation mark, favicon, and installable-app manifest. The
`official` build profile remains available for upstream-compatible DeepSeek Harness artifacts.

The primary concept asset is [`brand/kairoforge-mark-concept.png`](brand/kairoforge-mark-concept.png).
The shipped UI uses a lightweight SVG interpretation so it scales cleanly and follows application
theme tokens.
