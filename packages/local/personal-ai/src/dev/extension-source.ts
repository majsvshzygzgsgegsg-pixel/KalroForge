/**
 * Source of the KairoForge editor extension (VS Code and Cursor). KairoForge
 * packages it as a .vsix and installs it through the editor's own CLI. The
 * extension reads the bridge file KairoForge writes (local URL plus a random
 * token, readable only by this user) and reports editor state to it.
 */

/** Extension version; bump when the source changes. */
export const EXTENSION_VERSION = '0.3.1'
/** Marketplace-style id (publisher.name). */
export const EXTENSION_ID = 'kairoforge.kairoforge-editor'

/** The extension manifest. */
export const EXTENSION_MANIFEST = {
  name: 'kairoforge-editor',
  displayName: 'KairoForge',
  publisher: 'kairoforge',
  version: EXTENSION_VERSION,
  description: 'Connects this editor to your local KairoForge: it sees your file, cursor, selection, and problems, and you can ask it from here.',
  engines: { vscode: '^1.80.0' },
  main: './extension.js',
  activationEvents: ['onStartupFinished'],
  categories: ['Other'],
  contributes: {
    commands: [
      { command: 'kairoforge.ask', title: 'Ask KairoForge', category: 'KairoForge' },
      { command: 'kairoforge.askSelection', title: 'Ask About Selection', category: 'KairoForge' },
      { command: 'kairoforge.explain', title: 'Explain Selection', category: 'KairoForge' },
      { command: 'kairoforge.fixProblems', title: 'Fix Problems in This File', category: 'KairoForge' },
      { command: 'kairoforge.askInMode', title: 'Ask in Mode…', category: 'KairoForge' },
      { command: 'kairoforge.chooseMode', title: 'Choose Mode…', category: 'KairoForge' },
      { command: 'kairoforge.open', title: 'Open Command Center', category: 'KairoForge' },
    ],
    keybindings: [{ command: 'kairoforge.ask', key: 'ctrl+alt+k', mac: 'cmd+alt+k' }],
    menus: {
      'editor/context': [
        { command: 'kairoforge.explain', when: 'editorHasSelection', group: 'kairoforge@1' },
        { command: 'kairoforge.askSelection', when: 'editorHasSelection', group: 'kairoforge@2' },
        { command: 'kairoforge.fixProblems', group: 'kairoforge@3' },
      ],
    },
    configuration: {
      title: 'KairoForge',
      properties: {
        'kairoforge.shareEditorContext': {
          type: 'boolean',
          default: true,
          description: 'Send the active file path, cursor, selection, nearby code, open tabs, and problems to KairoForge on this Mac. Secret files (.env, keys) send only their path.',
        },
        'kairoforge.mode': {
          type: 'string',
          default: 'standard',
          description: 'KairoForge mode questions from this editor run in, e.g. standard (Lead), self-edit (Self-Edit + GitHub), cordis (Creator), builder, fast, or chat.',
        },
      },
    },
  },
} as const

/** extension.js */
export const EXTENSION_SOURCE = String.raw`'use strict'
const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')

const BRIDGE_FILE = path.join(process.env.KAIROFORGE_HOME || path.join(os.homedir(), '.kairoforge'), 'editor-bridge.json')
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.netrc|\.pgpass|credentials(\.[a-z]+)?|secrets?(\.[a-z]+)?)$/i
const SEVERITY = ['error', 'warning', 'info', 'hint']
const MAX_TEXT = 20000

let bridge
let status
let output
let pushTimer
let lastBody = ''
let lastPush = 0
let connected = false
let updateOffered = false
const RETRY_MS = 5000
const HEARTBEAT_MS = 30000

function readBridge() {
  try { bridge = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8')) } catch { bridge = undefined }
  return bridge
}

async function call(method, route, body, retried) {
  const target = bridge || readBridge()
  if (!target) throw new Error('KairoForge is not running on this Mac.')
  let response
  try {
    response = await fetch(target.url + '/kairoforge-editor' + route, {
      method,
      headers: { authorization: 'Bearer ' + target.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    bridge = undefined
    throw new Error('KairoForge is not reachable: ' + (error && error.message ? error.message : String(error)))
  }
  if (response.status === 401) {
    bridge = undefined
    const fresh = readBridge()
    if (!retried && fresh && fresh.token !== target.token) return call(method, route, body, true)
    throw new Error('KairoForge restarted; try again.')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || ('KairoForge answered ' + response.status))
  return data
}

function currentMode() {
  return vscode.workspace.getConfiguration('kairoforge').get('mode', 'standard') || 'standard'
}

function setConnected(value) {
  connected = value
  if (!status) return
  const mode = currentMode()
  const suffix = mode === 'standard' ? '' : ' · ' + mode
  status.text = (value ? '$(sparkle) KairoForge' : '$(debug-disconnect) KairoForge') + suffix
  status.tooltip = value ? 'KairoForge sees this editor. Click to ask (Cmd+Alt+K).' : 'KairoForge is not reachable. This retries every few seconds and reconnects by itself.'
}

function sharing() {
  return vscode.workspace.getConfiguration('kairoforge').get('shareEditorContext', true)
}

function snapshot() {
  const editor = vscode.window.activeTextEditor
  const openFiles = []
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = tab.input && tab.input.uri
      if (uri && uri.scheme === 'file' && !openFiles.includes(uri.fsPath)) openFiles.push(uri.fsPath)
    }
  }
  const diagnostics = []
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') continue
    for (const item of list) {
      if (item.severity > 1 || diagnostics.length >= 150) continue
      const entry = { file: uri.fsPath, line: item.range.start.line + 1, severity: SEVERITY[item.severity], message: String(item.message).slice(0, 400) }
      if (item.source) entry.source = String(item.source)
      diagnostics.push(entry)
    }
  }
  const snap = {
    editor: vscode.env.appName,
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath),
    openFiles: openFiles.slice(0, 50),
    diagnostics,
    at: new Date().toISOString(),
  }
  if (editor && editor.document.uri.scheme === 'file') {
    const doc = editor.document
    const position = editor.selection.active
    snap.activeFile = doc.uri.fsPath
    snap.language = doc.languageId
    snap.cursor = { line: position.line + 1, column: position.character + 1 }
    snap.dirty = doc.isDirty
    if (!SECRET.test(doc.uri.fsPath)) {
      if (!editor.selection.isEmpty) {
        snap.selection = { startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1, text: doc.getText(editor.selection).slice(0, MAX_TEXT) }
      }
      const start = Math.max(0, position.line - 40)
      const end = Math.min(doc.lineCount - 1, position.line + 40)
      snap.excerpt = { startLine: start + 1, text: doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length)).slice(0, MAX_TEXT) }
    }
  }
  return snap
}

async function push(force) {
  if (!sharing()) return
  const snap = snapshot()
  const { at, ...rest } = snap
  const body = JSON.stringify(rest)
  if (!force && body === lastBody) return
  try {
    await call('POST', '/context', snap)
    lastBody = body
    lastPush = Date.now()
    setConnected(true)
  } catch {
    setConnected(false)
  }
}

function schedule(delay) {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => { void push(false) }, delay)
}

function log(text) {
  output.appendLine(text)
}

function versionParts(value) {
  return String(value).split('.').map(part => Number.parseInt(part, 10) || 0)
}

function newerInstalled(context) {
  const running = versionParts(context.extension.packageJSON.version)
  const prefix = context.extension.id.toLowerCase() + '-'
  let entries = []
  try { entries = fs.readdirSync(path.dirname(context.extensionPath)) } catch { return undefined }
  for (const entry of entries) {
    if (!entry.toLowerCase().startsWith(prefix)) continue
    const version = entry.slice(prefix.length)
    const parts = versionParts(version)
    for (let index = 0; index < 3; index++) {
      if ((parts[index] || 0) !== (running[index] || 0)) {
        if ((parts[index] || 0) > (running[index] || 0)) return version
        break
      }
    }
  }
  return undefined
}

async function offerUpdate(context) {
  if (updateOffered) return
  const version = newerInstalled(context)
  if (!version) return
  updateOffered = true
  const choice = await vscode.window.showInformationMessage('KairoForge ' + version + ' is installed. Reload this window to use it.', 'Reload Window')
  if (choice) void vscode.commands.executeCommand('workbench.action.reloadWindow')
}

async function pickMode() {
  let modes
  try {
    modes = (await call('GET', '/modes')).modes || []
  } catch (error) {
    void vscode.window.showErrorMessage('KairoForge: ' + error.message)
    return undefined
  }
  const current = currentMode()
  const items = modes.map(mode => ({ label: mode.name, description: mode.id + (mode.id === current ? ' (current)' : ''), id: mode.id }))
  const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'KairoForge mode for this question', ignoreFocusOut: true })
  return chosen ? chosen.id : undefined
}

async function ask(prompt, label, mode) {
  if (!prompt || !prompt.trim()) return
  await push(true)
  const folder = (vscode.workspace.workspaceFolders || [])[0]
  const chosen = mode || currentMode()
  let turn
  try {
    turn = await call('POST', '/ask', { prompt, mode: chosen, ...(folder ? { workspace: folder.uri.fsPath } : {}) })
  } catch (error) {
    void vscode.window.showErrorMessage('KairoForge: ' + error.message)
    return
  }
  output.show(true)
  log('')
  log('▶ ' + (label || prompt) + (chosen === 'standard' ? '' : '  [' + chosen + ']'))
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'KairoForge', cancellable: false }, async (progress) => {
    const started = Date.now()
    let shown = 0
    let warned = false
    while (Date.now() - started < 30 * 60 * 1000) {
      await new Promise(resolve => setTimeout(resolve, 400))
      let current
      try { current = await call('GET', '/turn/' + encodeURIComponent(turn.id)) } catch { continue }
      const updates = current.updates || []
      for (; shown < updates.length; shown++) log('  … ' + updates[shown])
      if (current.awaitingApproval && !warned) {
        warned = true
        progress.report({ message: 'needs your approval in the Command Center' })
        const choice = await vscode.window.showWarningMessage('KairoForge is waiting for your approval.', 'Open Command Center')
        if (choice) void vscode.commands.executeCommand('kairoforge.open')
      } else if (!current.awaitingApproval) {
        warned = false
        progress.report({ message: updates.length > 0 ? updates[updates.length - 1] : 'working…' })
      }
      if (current.status !== 'running') {
        if (current.status === 'failed') log('✖ ' + (current.error || 'failed'))
        log(current.reply ? current.reply : '(done — no written reply; see the session in KairoForge)')
        return
      }
    }
    log('Still running after 30 minutes; follow it in the Command Center.')
  })
}

function activate(context) {
  output = vscode.window.createOutputChannel('KairoForge')
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  status.command = 'kairoforge.ask'
  setConnected(false)
  status.show()
  context.subscriptions.push(output, status)

  const selectionNote = () => {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.selection.isEmpty) return ''
    return ' (about my selection: lines ' + (editor.selection.start.line + 1) + '-' + (editor.selection.end.line + 1) + ' of ' + path.basename(editor.document.fileName) + ')'
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('kairoforge.ask', async () => {
      const prompt = await vscode.window.showInputBox({ prompt: 'Ask KairoForge — it sees your file, cursor, selection, and problems', ignoreFocusOut: true })
      if (prompt) await ask(prompt + selectionNote(), prompt)
    }),
    vscode.commands.registerCommand('kairoforge.askSelection', async () => {
      const prompt = await vscode.window.showInputBox({ prompt: 'Ask KairoForge about the selected code', ignoreFocusOut: true })
      if (prompt) await ask(prompt + selectionNote(), prompt)
    }),
    vscode.commands.registerCommand('kairoforge.explain', () => ask('Explain the selected code: what it does, anything surprising, and any bugs you see.' + selectionNote(), 'Explain selection')),
    vscode.commands.registerCommand('kairoforge.fixProblems', () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const file = editor.document.uri.fsPath
      return ask('Fix the errors and warnings the editor reports in ' + file + ', then re-check that the file is clean. Keep unrelated code unchanged.', 'Fix problems in ' + path.basename(file))
    }),
    vscode.commands.registerCommand('kairoforge.askInMode', async () => {
      const mode = await pickMode()
      if (!mode) return
      const prompt = await vscode.window.showInputBox({ prompt: 'Ask KairoForge in ' + mode + ' mode', ignoreFocusOut: true })
      if (prompt) await ask(prompt + selectionNote(), prompt, mode)
    }),
    vscode.commands.registerCommand('kairoforge.chooseMode', async () => {
      const mode = await pickMode()
      if (mode) await vscode.workspace.getConfiguration('kairoforge').update('mode', mode, vscode.ConfigurationTarget.Global)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('kairoforge.mode')) setConnected(connected) }),
    vscode.commands.registerCommand('kairoforge.open', () => {
      const target = bridge || readBridge()
      if (target) void vscode.env.openExternal(vscode.Uri.parse(target.url + '/'))
    }),
    vscode.window.onDidChangeActiveTextEditor(() => schedule(150)),
    vscode.window.onDidChangeTextEditorSelection(() => schedule(600)),
    vscode.workspace.onDidChangeTextDocument((event) => { if (event.document === (vscode.window.activeTextEditor || {}).document) schedule(1500) }),
    vscode.workspace.onDidSaveTextDocument(() => schedule(300)),
    vscode.languages.onDidChangeDiagnostics(() => schedule(800)),
    vscode.window.tabGroups.onDidChangeTabs(() => schedule(800)),
    vscode.window.onDidChangeWindowState((state) => { if (state.focused) void push(true) }),
  )
  const heartbeat = setInterval(() => {
    if (!connected || Date.now() - lastPush >= HEARTBEAT_MS) void push(true)
  }, RETRY_MS)
  const onBridgeChange = () => {
    readBridge()
    void push(true)
    void offerUpdate(context)
  }
  fs.watchFile(BRIDGE_FILE, { interval: 2000 }, onBridgeChange)
  const updateCheck = setInterval(() => { void offerUpdate(context) }, 10 * 60000)
  context.subscriptions.push({
    dispose: () => {
      clearInterval(heartbeat)
      clearInterval(updateCheck)
      clearTimeout(pushTimer)
      fs.unwatchFile(BRIDGE_FILE, onBridgeChange)
    },
  })
  void push(true)
  void offerUpdate(context)
}

function deactivate() {}

module.exports = { activate, deactivate }
`
