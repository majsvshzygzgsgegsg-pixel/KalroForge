/**
 * ForgePilot plugin: playwright-mcp-bridge
 *
 * Bridges the upstream Playwright MCP server (`@playwright/mcp`) into ForgePilot
 * browser tools. The upstream server speaks newline-delimited JSON-RPC over
 * stdio; this plugin is the client.
 *
 * Safety properties:
 *  - The upstream repository is untrusted third-party code. It is NOT vendored
 *    into this plugin; the operator points the plugin at an executable they have
 *    installed and reviewed themselves.
 *  - The MCP server executable must be a bare executable name resolved through
 *    PATH. Absolute paths are rejected, mirroring ForgePilot's own McpConfig.
 *  - Shell metacharacters and command-shaped names are rejected.
 *  - If the transport cannot be constructed the plugin fails closed by
 *    registering its tools in a disabled state that always throws, rather than
 *    silently returning an empty tool list.
 *  - Every tool declares a capability that maps to a permission the manifest
 *    explicitly requests, so PluginManager's load-time checks are meaningful.
 */

import { spawn } from "node:child_process";

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_NAME = "forgepilot-playwright-mcp-bridge";
const CLIENT_VERSION = "1.0.0";
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND = "npx";

/** Executables that must never be launched by this bridge. */
const FORBIDDEN_COMMANDS = new Set(["sh", "bash", "zsh", "fish", "csh", "ksh", "env", "sudo", "su", "eval", "exec"]);
const SAFE_COMMAND = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const UNSAFE_ARG = /[;&|`$(){}<>\n\r\0"']/;

export const BRIDGE_METHODS = Object.freeze({
  browser_open: "browser_navigate",
  browser_snapshot: "browser_snapshot",
  browser_click: "browser_click",
  browser_type: "browser_type",
  browser_close: "browser_close",
});

/**
 * Resolve the executable that will host the Playwright MCP server.
 * Fails closed: returns { ok: false, reason } rather than guessing.
 */
export function resolveServerCommand(env = process.env) {
  const command = env.FORGEPILOT_PLAYWRIGHT_MCP_COMMAND?.trim() || DEFAULT_COMMAND;
  if (command.includes("/") || command.includes("\\")) {
    return { ok: false, reason: `Refusing an absolute or relative path for the MCP command: ${command}. Use a bare executable name resolved through PATH.` };
  }
  if (!SAFE_COMMAND.test(command)) {
    return { ok: false, reason: `Unsafe MCP command name: ${command}` };
  }
  if (FORBIDDEN_COMMANDS.has(command)) {
    return { ok: false, reason: `Refusing to launch a shell interpreter as the MCP command: ${command}` };
  }

  const rawArgs = env.FORGEPILOT_PLAYWRIGHT_MCP_ARGS;
  const args = rawArgs === undefined || rawArgs.trim() === ""
    ? ["-y", "@playwright/mcp@latest"]
    : rawArgs.split(",").map((part) => part.trim()).filter(Boolean);
  for (const arg of args) {
    if (UNSAFE_ARG.test(arg)) return { ok: false, reason: `Unsafe MCP argument: ${arg}` };
  }
  return { ok: true, command, args };
}

/** Newline-delimited JSON-RPC 2.0 client over a child process' stdio. */
export class StdioMcpClient {
  #child;
  #pending = new Map();
  #nextId = 1;
  #buffer = "";
  #closed = false;
  #stderr = "";

  constructor({ command, args, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.timeoutMs = timeoutMs;
    this.#child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env },
      shell: false,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.#child.stderr.on("data", (chunk) => { this.#stderr = `${this.#stderr}${chunk}`.slice(-4_000); });
    this.#child.on("error", (error) => this.#failAll(new Error(`MCP server failed to start: ${error.message}`)));
    this.#child.on("exit", (code) => {
      if (!this.#closed) this.#failAll(new Error(`MCP server exited (code ${code}). ${this.#stderr.trim()}`.trim()));
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_RESPONSE_BYTES) {
      this.#failAll(new Error("MCP server response exceeded the size limit"));
      return;
    }
    let index;
    while ((index = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { continue; }
      if (message.id === undefined) continue; // notifications are not awaited
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`MCP error ${message.error.code ?? ""}: ${message.error.message ?? "unknown"}`.trim()));
      else pending.resolve(message.result);
    }
  }

  #failAll(error) {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #send(message) {
    if (this.#closed) throw new Error("MCP server connection is closed");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error("MCP server connection is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
    this.notify("notifications/initialized");
    return result;
  }

  async listTools() {
    const result = await this.request("tools/list");
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result?.isError) {
      const text = (result.content ?? []).map((part) => part?.text).filter(Boolean).join(" ");
      throw new Error(`Playwright MCP tool ${name} failed: ${text || "unknown error"}`);
    }
    return result;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP client closed"));
    }
    this.#pending.clear();
    try { this.#child.stdin.end(); } catch { /* already closed */ }
    await new Promise((resolve) => {
      const done = () => resolve();
      this.#child.once("exit", done);
      setTimeout(() => { try { this.#child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 2_000).unref?.();
    });
  }
}

/** Flatten an MCP tool result into a compact JSON-safe payload. */
export function summarizeResult(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map((part) => (part?.type === "text" ? part.text : part?.type ? `[${part.type}]` : "")).filter(Boolean).join("\n");
  const summary = { content: text.slice(0, 50_000) };
  if (result?.structuredContent !== undefined) summary.structuredContent = result.structuredContent;
  if (parts.some((part) => part?.type === "image")) summary.imagesOmitted = parts.filter((part) => part?.type === "image").length;
  return summary;
}

/** A plugin tool that always fails closed, used when the transport is unavailable. */
function unavailableTool(spec, reason) {
  return {
    ...spec,
    execute: async () => { throw new Error(`playwright-mcp-bridge is unavailable: ${reason}`); },
  };
}

function defineTool(name, description, capability, riskLevel, properties, required, method) {
  return {
    name,
    version: "1.0.0",
    description,
    capabilities: [capability],
    riskLevel,
    inputSchema: { type: "object", properties, ...(required ? { required } : {}) },
    source: { type: "plugin", id: "playwright-mcp-bridge" },
    _mcpMethod: method,
  };
}

export const TOOL_SPECS = Object.freeze([
  defineTool("pw_open", "Open a URL in the Playwright MCP browser and return a page snapshot.", "browser.read", "network", { url: { type: "string" } }, ["url"], BRIDGE_METHODS.browser_open),
  defineTool("pw_snapshot", "Return the accessibility snapshot of the current Playwright MCP page.", "browser.read", "safe", {}, null, BRIDGE_METHODS.browser_snapshot),
  defineTool("pw_click", "Click an element in the Playwright MCP page, selected by accessible name or CSS.", "browser.write", "high-risk", { element: { type: "string" }, ref: { type: "string" } }, ["element"], BRIDGE_METHODS.browser_click),
  defineTool("pw_type", "Type text into a Playwright MCP page field.", "browser.write", "high-risk", { element: { type: "string" }, ref: { type: "string" }, text: { type: "string" } }, ["text"], BRIDGE_METHODS.browser_type),
  defineTool("pw_close", "Close the Playwright MCP browser session and stop the server.", "browser.read", "safe", {}, null, BRIDGE_METHODS.browser_close),
]);

/**
 * Build the plugin's tools.
 *
 * `createClient` is injectable so the tool contract can be tested without
 * spawning a real MCP server or downloading Playwright.
 */
export async function createTools(context = {}, { env = process.env, createClient } = {}) {
  const resolved = resolveServerCommand(env);
  if (!resolved.ok) {
    // Fail closed but remain visible: the operator sees why in `tools list`.
    return TOOL_SPECS.map((spec) => unavailableTool(spec, resolved.reason));
  }

  let client;
  let connectError;
  const connect = async () => {
    if (client) return client;
    if (connectError) throw connectError;
    try {
      client = createClient
        ? await createClient({ command: resolved.command, args: resolved.args })
        : new StdioMcpClient({ command: resolved.command, args: resolved.args, env });
      await client.initialize();
      return client;
    } catch (error) {
      connectError = error;
      throw error;
    }
  };

  return TOOL_SPECS.map((spec) => {
    const { _mcpMethod, ...tool } = spec;
    return {
      ...tool,
      execute: async (args) => {
        const connection = await connect();
        const payload = { ...args };
        delete payload.__proto__;
        const result = await connection.callTool(_mcpMethod, payload);
        if (_mcpMethod === BRIDGE_METHODS.browser_close && typeof connection.close === "function") await connection.close();
        return summarizeResult(result);
      },
    };
  });
}

export default createTools;
