# Agent Note: KairoForge Chat and coding modes are separate presets

Status: implemented

English | [中文](2026-09-29-kairoforge-chat-code-modes.zh.md)

## Problem

The Web product exposed coding-agent presets but had no ordinary answer-only mode. A visual toggle alone could hide tool UI while still sending schemas to the model, which would falsely promise that the assistant cannot act. The product persona also continued to describe a generic coding agent instead of the KairoForge application identity.

## Decision

Ship `chat` as a first-party agent preset containing only a complete KairoForge persona. It mounts no tool, command, workspace, skill, memory, compaction, or delegation plugin, and suppresses runtime context. The preset composition boundary therefore makes its provider request carry no tool schemas.

The existing `standard` preset is the KairoForge coding mode. A compact localized Chat/KairoForge segmented control leads the conversation header's right-aligned utility band. It selects a different preset in place only while the session is blank. Once a turn has started, choosing the other mode stages that preset and opens a fresh task, preserving the existing rule that a session's tool and prompt composition cannot change beneath durable history.

Every shipped Web persona names KairoForge and explicitly rejects the legacy DeepSeek Harness product identity. The identity lives in preset and Web system-prompt composition rather than any provider adapter, so DeepSeek, OpenAI-compatible, and other configured providers receive the same application identity.

This extends [declarative agent presets](../architecture/2026-09-18-declarative-agent-presets.md) and does not supersede it. The prior decision remains the owner of preset lifecycle and immutability.

## Alternatives considered

**Hide tools only in the browser.** Rejected because the model would retain callable schemas and Host execution paths.

**Recompose an active session.** Rejected because earlier assistant messages and tool results were produced under a different capability contract.

**Implement provider-specific identity prompts.** Rejected because provider routing is independent of product identity and would allow adapters to drift.

## Verification

The shipped-composition test creates a `chat` agent and asserts its exact complete KairoForge prompt, empty assembled tool array, empty runtime tool roster, absent goal command, and absent preset-scoped filesystem service. Component tests cover both selected states and mode requests. The full GUI suite covers slot registration, localization, disposal, and surrounding header behavior.

## Consequences

Chat mode is structurally answer-only rather than cosmetically restricted. Coding mode retains the existing agent capabilities and design. Switching an active conversation intentionally creates a new task, and custom or advanced presets remain available through the existing settings and new-session surfaces.
