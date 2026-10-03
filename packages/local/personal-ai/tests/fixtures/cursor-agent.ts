/** Test double for the Cursor agent CLI; it never touches the desktop. */

/** A stand-in Cursor agent CLI: `status` reports a sign-in; a run records its argv and streams a scripted transcript. */
export function fakeCursorAgent(root: string): string {
  return [
    `#!${process.execPath}`,
    'const { appendFileSync, existsSync } = require("node:fs")',
    'const { join } = require("node:path")',
    'const args = process.argv.slice(2)',
    `const root = ${JSON.stringify(root)}`,
    'if (args[0] === "status") { console.log("✓ Logged in as someone@example.com"); process.exit(0) }',
    'const workspace = args[args.indexOf("--workspace") + 1]',
    'if (args.includes("retired-model")) { console.error("Cannot use this model: retired-model"); process.exit(1) }',
    'appendFileSync(join(root, "runs.ndjson"), JSON.stringify({ args, instructions: existsSync(join(workspace, "AGENTS.md")) }) + "\\n")',
    'const task = args.at(-1)',
    'const out = (event) => console.log(JSON.stringify(event))',
    'out({ type: "system", subtype: "init", model: "Auto" })',
    'out({ type: "tool_call", subtype: "started", tool_call: { mcpToolCall: { args: { providerIdentifier: "native-app-control", toolName: "execute_applescript" } } } })',
    'if (task.includes("fail")) { out({ type: "result", subtype: "error", is_error: true, result: "Notes is not installed." }); process.exit(1) }',
    'out({ type: "assistant", message: { content: [{ type: "text", text: "Opened Notes and typed hi." }] } })',
    'out({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, result: "Let me open Notes.Opened Notes and typed hi." })',
  ].join('\n')
}
