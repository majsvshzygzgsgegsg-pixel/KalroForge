/**
 * Behavioral check for the Voice Call browser half.
 *
 * Loads client.js under the real handoff contract (window.__ModuleLoader__.load),
 * materializes the factory, and drives the plugin against a small harness: a fake
 * slot registry, a fake composer input face, a fake chat transcript, and fake
 * speech engines. It asserts the microphone submits speech, the live caption
 * carries it, the settled reply is spoken exactly once, and the call ends.
 */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const CHECKOUT = '/Users/franksmith/Documents/KalroForge'
const { JSDOM } = require(path.join(CHECKOUT, 'node_modules/jsdom'))
const REACT_DIR = path.join(CHECKOUT, 'packages/client/ui-conversation/node_modules')
  const React = require(path.join(REACT_DIR, 'react'))
const { createRoot } = require(path.join(REACT_DIR, 'react-dom/client'))

const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')

async function main() {


  const dom = new JSDOM(
    '<!doctype html><html lang="en"><head></head><body><div data-chat-flow></div></body></html>',
    { pretendToBeVisual: true, url: 'http://localhost:3080/' },
  )
  const { window } = dom

// React DOM reads the ambient browser globals; give it this document.
globalThis.window = window
globalThis.document = window.document
globalThis.navigator = window.navigator
globalThis.MutationObserver = window.MutationObserver
globalThis.HTMLElement = window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true

  /** Wait for a condition with a generous budget instead of fixed sleeps. */
  async function until(label, predicate, budgetMs = 8000) {
    const started = Date.now()
    for (;;) {
      const value = predicate()
      if (value) return value
      if (Date.now() - started > budgetMs) throw new Error('timed out waiting for ' + label)
      await new Promise(resolve => window.setTimeout(resolve, 40))
    }
  }

  // ---- fake speech engines -------------------------------------------------
  const started = []
  class FakeRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.ended = false }
    start() {
      started.push(this)
      if (this.onstart) this.onstart()
    }
    /**
     * Browsers fire onend whether or not a listener is attached, so the engine
     * marks the session ended whenever it fires; the runtime only nulls the
     * handlers when it is discarding the session, and it is then already gone.
     */
    _end() {
      this.ended = true
      const handler = this.onend
      if (handler) handler()
    }
    stop() { this._end() }
    abort() { this._end() }
  }
  window.SpeechRecognition = FakeRecognition

  const spoken = []
  let activeUtterance = null
  let cancelCount = 0
  class FakeUtterance {
    constructor(text) { this.text = text; this.voice = null; this.rate = 1; this.pitch = 1; this.volume = 1 }
  }
  window.SpeechSynthesisUtterance = FakeUtterance
  window.speechSynthesis = {
    getVoices: () => [{ name: 'Samantha', lang: 'en-US', localService: true }],
    speak(utterance) { spoken.push(utterance.text); activeUtterance = utterance },
    cancel() { cancelCount++; activeUtterance = null },
    onvoiceschanged: null,
  }
  /** Wait for the runtime to have one live recognizer session, and return it. */
  async function currentSession() {
    return until('a live recognition session',
      () => started.filter(session => !session.ended).pop())
  }

  /** Let the current utterance finish normally. */
  function finishUtterance() {
    const utterance = activeUtterance
    activeUtterance = null
    if (utterance && utterance.onend) utterance.onend()
  }

  const storage = new Map()
  window.localStorage.getItem = key => (storage.has(key) ? storage.get(key) : null)
  window.localStorage.setItem = (key, value) => { storage.set(key, value) }

  // ---- module loader handoff ----------------------------------------------
  let registered = null
  window.__ModuleLoader__ = { load: handoff => { registered = handoff } }
  const run = new window.Function('window', 'globalThis', 'document', 'navigator', source)
  run(window, window, window.document, window.navigator)
  assert.ok(registered !== null, 'the bundle registered a factory')
  assert.equal(registered.id, '@local/voice-call', 'the factory is registered under the package id')

  const plugin = registered.factory(spec => {
    if (spec === 'react') return React
    throw new Error('unexpected module request: ' + spec)
  })
  assert.equal(typeof plugin.apply, 'function', 'the factory returned an installable plugin')
  assert.deepEqual(plugin.inject, ['slots'], 'the plugin gates on the slots service')

  // ---- slot harness --------------------------------------------------------
  const entries = []
  const effects = []
  const provided = new Map()
  const ctx = {
    effect(callback) { const dispose = callback(); effects.push(dispose); return () => {} },
    provide(name, value) { provided.set(name, value); return () => { provided.delete(name) } },
    slots: {
      inject(key, callback) { callback(); return () => {} },
      register(options, component) { entries.push({ options, component }); return () => {} },
    },
  }
  plugin.apply(ctx)

  assert.deepEqual(
    entries.map(entry => entry.options.name).sort(),
    ['conversation.input.activity', 'conversation.input.dock'],
    'the call control and the caption strip registered into their slots',
  )
  const micEntry = entries.find(entry => entry.options.id === 'voice-call-control')
  const captionEntry = entries.find(entry => entry.options.id === 'voice-call-caption')
  assert.ok(micEntry !== undefined && captionEntry !== undefined, 'both entries carry id, priority, and order')
  assert.equal(micEntry.options.priority, -20, 'the call control shadows the built-in activity without slot collisions')
  assert.equal(micEntry.options.order, -20, 'the call control keeps a deterministic visual order')

  const runtime = micEntry.options.inject('session-1').runtime
  assert.equal(provided.get('voiceCall'), runtime, 'the runtime is provided as the voiceCall service')
  assert.equal(typeof runtime.setVoice, 'function', 'the runtime accepts a voice preference')
  assert.ok(Array.isArray(runtime.listVoices()), 'the runtime lists installed voices')
  runtime.setVoice({ rate: 5 })
  runtime.setVoice({ name: '', rate: 1.25 })
  assert.equal(runtime.supported, true, 'the runtime detected speech recognition')
  assert.equal(runtime.settings.bargeIn, true, 'talking over the reply works out of the box')
  assert.equal(runtime.speakingSupported, true, 'the runtime detected speech synthesis')

  // ---- render the microphone control and the caption strip -----------------
  const drafts = []
  let submits = 0
  const inputActions = { setDraft(text) { drafts.push(text) }, submit() { submits++ } }

  const container = window.document.createElement('div')
  const stripContainer = window.document.createElement('div')
  window.document.body.append(container)
  window.document.body.append(stripContainer)
  const root = createRoot(container)
  const stripRoot = createRoot(stripContainer)

  React.act(() => {
    root.render(React.createElement(micEntry.component, {
      sessionId: 'session-1', inputActions, locked: false, runtime,
    }))
    stripRoot.render(React.createElement(captionEntry.component, { runtime }))
  })

  const micButton = container.querySelector('button[aria-pressed]')
  assert.ok(micButton !== null, 'the call button rendered')
  assert.equal(micButton.getAttribute('data-live'), null, 'the button is idle before the call')
  assert.match(micButton.textContent, /Call/, 'the button reads as a call control')
  assert.equal(stripContainer.querySelector('.vc-caption'), null, 'no caption strip before the call')

  // ---- start the call ------------------------------------------------------
  React.act(() => { micButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(started.length, 1, 'the recognizer started once')
  assert.equal(started[0].continuous, true, 'continuous recognition requested')
  assert.equal(started[0].interimResults, true, 'interim results requested')
  assert.equal(started[0].lang, 'en', 'the recognizer followed the document language')
  assert.equal(runtime.live, true, 'the call is live')
  await until('the caption strip', () => stripContainer.querySelector('.vc-caption') !== null)
  assert.equal(micButton.getAttribute('aria-pressed'), 'true', 'the button reports the live call')

  // ---- the options menu ----------------------------------------------------
  const caret = container.querySelectorAll('button')[1]
  const pop = container.querySelector('.vc-pop')
  assert.ok(caret !== undefined && pop !== null, 'the options trigger and menu rendered')
  assert.equal(pop.hasAttribute('hidden'), true, 'the menu starts closed')
  React.act(() => { caret.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(pop.hasAttribute('hidden'), false, 'the menu opened')
  assert.equal(caret.getAttribute('aria-expanded'), 'true', 'the trigger reports expansion')
  const firstOption = pop.querySelector('[role="menuitemcheckbox"]')
  assert.ok(firstOption !== null, 'the menu offers preference rows')
  assert.equal(firstOption.getAttribute('aria-checked'), 'true', 'preferences default on')
  React.act(() => { firstOption.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(firstOption.getAttribute('aria-checked'), 'false', 'a preference toggled off')
  assert.equal(runtime.settings.autoSend, false, 'the preference reached the runtime')
  React.act(() => { firstOption.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(runtime.settings.autoSend, true, 'the preference toggled back on')
  React.act(() => { caret.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(pop.hasAttribute('hidden'), true, 'the menu closed again')

  // ---- interim caption, then a final transcript ----------------------------
  const session = started[0]
  React.act(() => {
    session.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'hello there' }], { isFinal: false })],
    })
  })
  assert.equal(runtime.caption, 'hello there', 'the interim caption is live')
  assert.equal(runtime.partial, true, 'interim text is marked partial')
  assert.match(stripContainer.textContent, /hello there/, 'the strip shows the interim words')

  React.act(() => {
    session.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'what is the weather' }], { isFinal: true })],
    })
  })
  assert.deepEqual(drafts, ['what is the weather\n'], 'the final transcript reached the composer')
  assert.equal(submits, 1, 'the composer submitted once')
  assert.equal(runtime.phase, 'waiting', 'the call waits for the reply')

  // ---- the assistant answers ----------------------------------------------
  const column = window.document.querySelector('[data-chat-flow]')
  const reply = window.document.createElement('div')
  reply.setAttribute('data-chat-flow-kind', 'assistant-step')
  reply.textContent = 'It is sunny and warm today.'
  React.act(() => { column.append(reply) })

  await until('the reply to settle and be spoken', () => spoken.length > 0)
  assert.deepEqual(spoken, ['It is sunny and warm today.'], 'the settled reply was spoken exactly once')
  assert.equal(runtime.reply, 'It is sunny and warm today.', 'the runtime captured the reply text')
  assert.match(stripContainer.textContent, /sunny and warm/, 'the strip carries the spoken reply')
  assert.match(stripContainer.textContent, /Assistant/i, 'the strip labels the assistant turn')
  assert.equal(runtime.phase, 'speaking', 'the call reports that it is speaking')
  assert.match(micButton.textContent, /End call/, 'the button offers to end the call')

  // The assistant must never turn its own words into a turn. The microphone is
  // live, so the gates are what protect it.
  const before = drafts.length
  const hotSession = await until('a live recognition session during speech',
    () => started.filter(session => !session.ended).pop())

  // Arming window: a blip in the first moment of the reply is not an interrupt.
  React.act(() => {
    hotSession.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'wait hold on a second' }], { isFinal: false })],
    })
  })
  assert.equal(runtime.phase, 'speaking', 'a phrase inside the arming window did not interrupt')

  // Past the arming window, the evidence gates decide.
  await new Promise(resolve => window.setTimeout(resolve, 1300))
  React.act(() => {
    hotSession.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'uh' }], { isFinal: false })] })
  })
  assert.equal(runtime.phase, 'speaking', 'a two-letter noise did not interrupt')

  // Self-echo gate: the assistant's own words, heard back, are not an interrupt.
  React.act(() => {
    hotSession.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'it is sunny and warm today' }], { isFinal: false })],
    })
  })
  assert.equal(runtime.phase, 'speaking', 'the assistant hearing itself did not interrupt')

  // Nor may its own words arrive as a settled turn.
  React.act(() => {
    hotSession.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'it is sunny and warm today.' }], { isFinal: true })],
    })
  })
  assert.equal(drafts.length, before, 'the assistant never submits its own words')

  // A real interruption still works, and its turn is the one that goes out.
  const cancelsBefore = cancelCount
  React.act(() => {
    hotSession.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'wait hold on a second' }], { isFinal: false })],
    })
  })
  assert.equal(runtime.phase, 'listening', 'a real phrase interrupted the reply')
  assert.ok(cancelCount > cancelsBefore, 'the spoken reply was cancelled')
  assert.equal(runtime.caption, 'wait hold on a second', 'the strip shows what it is hearing')

  React.act(() => {
    hotSession.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'explain that differently please' }], { isFinal: true })],
    })
  })
  assert.deepEqual(drafts, ['what is the weather\n', 'explain that differently please\n'],
    'the interrupting turn was submitted')
  assert.equal(submits, 2, 'the interrupting turn submitted once')

  // A transcript repeated inside the window must not send the same turn twice.
  React.act(() => {
    const last = started.filter(session => !session.ended).pop() || hotSession
    if (typeof last.onresult === 'function') {
      last.onresult({
        resultIndex: 0,
        results: [Object.assign([{ transcript: 'explain that differently please' }], { isFinal: true })],
      })
    }
  })
  assert.equal(submits, 2, 'a repeated transcript did not resubmit the turn')

  // ---- manual interrupt: the button hands the floor back ------------------
  React.act(() => {
    const fourth = window.document.createElement('div')
    fourth.setAttribute('data-chat-flow-kind', 'assistant-step')
    fourth.textContent = 'Here is yet another answer for you.'
    column.append(fourth)
  })
  await until('the fourth answer to be spoken', () => runtime.phase === 'speaking')
  React.act(() => { micButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(runtime.phase, 'listening', 'the button cut the voice and started listening')
  assert.equal(runtime.live, true, 'the call is still live after a manual interrupt')

  // ---- ending the call -----------------------------------------------------
  React.act(() => { micButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.equal(runtime.live, false, 'the call ended')
  assert.equal(runtime.phase, 'idle', 'the runtime returned to idle')
  await until('the strip to leave', () => stripContainer.querySelector('.vc-caption') === null)

  // ---- channel call: another surface owns the conversation ----------------
  const sent = []
  let answer = null
  const channel = {
    name: 'personal-ai',
    send(text) { sent.push(text); return new Promise((resolve) => { answer = resolve }) },
  }
  const draftsBeforeChannel = drafts.length
  spoken.length = 0
  React.act(() => { runtime.startWith(channel) })
  assert.equal(runtime.live, true, 'a channel call is live')
  assert.equal(runtime.snapshot.channel, 'personal-ai', 'the snapshot names the channel')
  const channelSession = await currentSession()
  React.act(() => {
    channelSession.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'what time is my meeting' }], { isFinal: true })],
    })
  })
  assert.deepEqual(sent, ['what time is my meeting'], 'the final transcript went to the channel')
  assert.equal(drafts.length, draftsBeforeChannel, 'a channel call never types into the composer')
  assert.equal(runtime.heard, 'what time is my meeting', 'the runtime remembers what it sent')
  assert.equal(runtime.phase, 'waiting', 'the call waits for the channel to answer')
  await React.act(async () => { answer('Your meeting is at three.') })
  await until('the channel answer to be spoken', () => spoken.length > 0)
  assert.deepEqual(spoken, ['Your meeting is at three.'], 'the channel answer was spoken')
  assert.equal(runtime.phase, 'speaking', 'the call speaks the channel answer')
  // Chat navigation must not end a call that is not tied to the chat.
  React.act(() => {
    root.render(React.createElement(micEntry.component, {
      sessionId: 'session-other', inputActions, locked: false, runtime,
    }))
  })
  assert.equal(runtime.live, true, 'opening another chat keeps the channel call')
  React.act(() => { runtime.toggle() })
  assert.equal(runtime.live, false, 'the channel call ended')
  assert.equal(runtime.snapshot.channel, null, 'ending the call drops the channel')

  React.act(() => { root.unmount(); stripRoot.unmount() })
  for (const dispose of effects) if (typeof dispose === 'function') dispose()

  console.log('voice-call behavioral check: PASS')
}

main().catch(error => {
  console.error('voice-call behavioral check: FAIL')
  console.error(error)
  process.exit(1)
})
