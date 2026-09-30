const $ = (selector) => document.querySelector(selector);
const state = { current: null, runId: null, poller: null, sessions: JSON.parse(localStorage.getItem("forgepilot.sessions") || "[]") };

function save() { localStorage.setItem("forgepilot.sessions", JSON.stringify(state.sessions.slice(0, 30))); }
function currentSession() { return state.sessions.find((session) => session.id === state.current); }
function renderSessions() {
  $("#sessions").replaceChildren(...state.sessions.map((session) => {
    const button = document.createElement("button");
    button.className = `session${session.id === state.current ? " active" : ""}`;
    button.textContent = session.title;
    button.onclick = () => { state.current = session.id; render(); };
    return button;
  }));
}
function messageElement(role, text) {
  const item = document.createElement("article");
  item.className = `message ${role}`;
  const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.textContent = role === "assistant" ? "F" : "U";
  const body = document.createElement("div"); body.className = "message-body";
  const label = document.createElement("span"); label.className = "label"; label.textContent = role === "assistant" ? "ForgePilot" : "You";
  const content = document.createElement("div"); content.textContent = text;
  body.append(label, content); item.append(avatar, body); return item;
}
function render() {
  const session = currentSession();
  $("#chat-title").textContent = session?.title ?? "New session";
  $("#welcome").classList.toggle("hidden", Boolean(session?.messages.length));
  $("#messages").querySelectorAll(".message").forEach((node) => node.remove());
  for (const message of session?.messages ?? []) $("#messages").append(messageElement(message.role, message.text));
  renderSessions();
  window.scrollTo({ top: document.body.scrollHeight });
}
function newSession() {
  state.current = crypto.randomUUID();
  state.sessions.unshift({ id: state.current, title: "New session", sessionId: null, messages: [] });
  save(); render();
}
async function api(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function setRunning(running, label = "Ready") { $("#send").disabled = running; $("#run-state").textContent = label; }
async function submit(prompt) {
  if (!state.current) newSession();
  const session = currentSession();
  if (session.title === "New session") session.title = prompt.slice(0, 42);
  session.messages.push({ role: "user", text: prompt }); save(); render(); setRunning(true, "Starting…");
  try {
    const run = await api("/api/runs", { method: "POST", body: JSON.stringify({ prompt, sessionId: session.sessionId }) });
    state.runId = run.id; poll();
  } catch (error) { session.messages.push({ role: "assistant", text: `Error: ${error.message}` }); save(); render(); setRunning(false); }
}
async function poll() {
  clearTimeout(state.poller);
  try {
    const run = await api(`/api/runs/${state.runId}`);
    const last = run.events.at(-1);
    setRunning(true, run.status === "awaiting_approval" ? "Waiting for approval" : last?.type === "tool" ? `Using ${last.name}` : run.status === "running" ? "Thinking…" : run.status);
    if (run.approval) {
      $("#approval").classList.remove("hidden");
      $("#approval").dataset.id = run.approval.id;
      $("#approval-text").textContent = `${run.approval.request.name} · ${JSON.stringify(run.approval.request.args)}`;
    } else $("#approval").classList.add("hidden");
    if (["completed", "failed"].includes(run.status)) {
      const session = currentSession();
      session.messages.push({ role: "assistant", text: run.status === "completed" ? run.result.text || "Completed without a text response." : `Error: ${run.error}` });
      if (run.result?.sessionId) session.sessionId = run.result.sessionId;
      state.runId = null; save(); render(); setRunning(false, run.status === "completed" ? "Completed" : "Failed"); return;
    }
    state.poller = setTimeout(poll, 600);
  } catch (error) { setRunning(false, `Error: ${error.message}`); }
}
async function decide(allowed) {
  const approvalId = $("#approval").dataset.id;
  await api(`/api/runs/${state.runId}/approval`, { method: "POST", body: JSON.stringify({ approvalId, allowed }) });
  $("#approval").classList.add("hidden"); poll();
}

$("#composer").addEventListener("submit", (event) => { event.preventDefault(); const prompt = $("#prompt").value.trim(); if (!prompt || state.runId) return; $("#prompt").value = ""; submit(prompt); });
$("#prompt").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#composer").requestSubmit(); } });
$("#new-chat").onclick = newSession;
$("#approve").onclick = () => decide(true); $("#reject").onclick = () => decide(false);
document.querySelectorAll("[data-prompt]").forEach((button) => { button.onclick = () => { $("#prompt").value = button.dataset.prompt; $("#prompt").focus(); }; });

api("/api/health").then((health) => {
  $("#server-dot").classList.add("online"); $("#server-state").textContent = "Local server online";
  $("#server-detail").textContent = health.apiKeyConfigured ? `${health.tools} tools ready` : "API key missing";
  $("#model-label").textContent = health.model; $("#workspace").textContent = health.workspace.split("/").at(-1);
}).catch((error) => { $("#server-state").textContent = "Server unavailable"; $("#server-detail").textContent = error.message; });
render();
