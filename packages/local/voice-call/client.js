/**
 * Browser half of the Call plugin: a Call control on every chat bar that turns
 * the composer into a spoken conversation, plus a live transcript strip that
 * stays on the chat while you talk.
 *
 * Registration surface: `conversation.input.activity` owns the call control —
 * the same seat the shipped voice bundle's Call button uses, so this package is
 * the resident call control rather than a second microphone beside it — and
 * `conversation.input.dock` owns the caption strip above the composer.
 *
 * Speech runs on the browser's own engines — SpeechRecognition for the
 * microphone, speechSynthesis for the spoken reply — so the plugin needs no
 * model download, no Host service, and no configuration to work.
 */
window.__ModuleLoader__.load({
  id: '@local/voice-call',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CALL_SLOT = 'conversation.input.activity'
    const CAPTION_SLOT = 'conversation.input.dock'
    const STORAGE_KEY = 'dsh.voice-call.settings.v2'
    /** Earlier preferences: kept, except talk-over, which was stored as the old default rather than chosen. */
    const LEGACY_STORAGE_KEY = 'dsh.voice-call.settings.v1'
    const REPLY_SETTLE_MS = 1400
    const ECHO_HOLD_MS = 700
    const BARGE_IN_ECHO_HOLD_MS = 350
    const BARGE_IN_ARM_MS = 1200
    const BARGE_IN_MIN_CHARS = 8
    const BARGE_IN_MIN_WORDS = 2
    /** Near-matches against what the assistant just said are its own voice. */
    const ECHO_OVERLAP_LIMIT = 0.6
    const ECHO_WINDOW_CHARS = 240
    /** Suppress a repeated transcript arriving inside this window. */
    const DUPLICATE_WINDOW_MS = 6000
    const RESTART_DELAY_MS = 450
    const SPEAK_WATCHDOG_MS = 90000
    const MIN_SPOKEN_CHARS = 2
    const MAX_SPOKEN_CHARS = 4000
    /** A progress line is a sentence, not an answer. */
    const MAX_PROGRESS_CHARS = 300
    /** How often a playing line is checked, and how many quiet checks mean it ended. */
    const SPEECH_WATCH_MS = 400
    const SPEECH_QUIET_TICKS = 2
    /** Speaking time estimate (about 14 characters a second at rate 1), its floor, and the slack before a line counts as lost. */
    const SPEECH_MS_PER_CHAR = 70
    const SPEECH_MIN_MS = 1000
    const SPEECH_LOST_MS = 4000

    const STYLE = `
.vc-group { position: relative; display: inline-flex; align-items: center; gap: 2px; }
.vc-btn {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 1; white-space: nowrap; cursor: pointer;
}
.vc-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.vc-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.vc-btn:disabled { cursor: default; opacity: .45; }
.vc-btn[data-live="true"] {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.vc-btn[data-error="true"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.vc-glyph { display: inline-flex; flex: none; }
.vc-caret { gap: 0; width: 20px; padding: 0; justify-content: center; border-color: transparent; }
.vc-pop {
  position: fixed; z-index: 60;
  width: 238px; padding: 6px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
}
.vc-pop[hidden] { display: none; }
.vc-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border: 0; border-radius: 7px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 1.3; text-align: left; cursor: pointer;
}
.vc-item:hover { background: var(--dsw-alias-bg-layer-2); }
.vc-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.vc-check { width: 14px; flex: none; color: var(--dsw-alias-brand-primary); }
.vc-hint { margin: 0; padding: 6px 8px 2px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.35; }
.vc-sep { height: 1px; margin: 5px 4px; background: var(--dsw-alias-border-l1); }
.vc-caption {
  display: flex; align-items: flex-start; gap: 8px;
  margin: 0 0 6px; padding: 7px 10px; max-width: 100%;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font-size: 12.5px; line-height: 1.45;
}
.vc-caption[data-error="true"] { border-color: var(--dsw-alias-state-error-primary); }
.vc-tag {
  flex: none; padding: 1px 6px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
}
.vc-tag[data-live="true"] { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.vc-body { min-width: 0; flex: 1; }
.vc-text { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.vc-text[data-partial="true"] { color: var(--dsw-alias-label-secondary); }
.vc-status { display: flex; align-items: center; gap: 7px; margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.vc-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.vc-dot[data-live="true"] { background: var(--dsw-alias-brand-primary); animation: vc-pulse 1.1s ease-in-out infinite; }
.vc-dot[data-busy="true"] { background: var(--dsw-alias-state-warn-primary); animation: vc-pulse 1.1s ease-in-out infinite; }
@keyframes vc-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.82); } }
@media (prefers-reduced-motion: reduce) { .vc-dot[data-live="true"], .vc-dot[data-busy="true"] { animation: none; } }
`

    const CHECK = 'M3.5 8.5l3 3 6-7'
    const MIC = 'M12 3.5a2.6 2.6 0 0 1 2.6 2.6v5.4a2.6 2.6 0 0 1-5.2 0V6.1A2.6 2.6 0 0 1 12 3.5Z M6 11.2a6 6 0 0 0 12 0 M12 17.2V20.5'
    const STOP = 'M7 7h10v10H7z'
    const CARET = 'M5.5 8.5 12 15l6.5-6.5'

    /** The browser's SpeechRecognition constructor, when this browser has one. */
    function speechRecognitionType() {
      return window.SpeechRecognition || window.webkitSpeechRecognition || null
    }

    /** The app language the recognizer and the copy should use. */
    function detectLocale() {
      return String(document.documentElement.lang || navigator.language || 'en').toLowerCase()
    }

    /** UI copy for the resolved language. */
    function copyFor(locale) {
      if (locale.indexOf('zh') === 0) {
        return {
          call: '通话',
          hangUp: '结束通话',
          callAgain: '再次通话',
          menuLabel: '语音通话选项',
          autoSend: '说完自动发送',
          speak: '朗读助手回复',
          handsFree: '保持聆听（连续对话）',
          speakingLabel: '朗读中',
          bargeIn: '聆听时也开着麦克风（说话即可打断）',
          listeningLabel: '聆听中',
          thinkingLabel: '等待助手回复…',
          you: '你',
          assistant: '助手',
          optionsHint: '直接使用浏览器的麦克风与语音合成。',
          unsupported: '此浏览器不支持语音识别，请使用 Chrome 或 Edge。',
          denied: '麦克风被拒绝。请在地址栏中允许本站麦克风权限。',
          failed: '语音识别失败',
          captionHint: '点击麦克风开始语音通话。',
        }
      }
      return {
        call: 'Call',
        hangUp: 'End call',
        callAgain: 'Call again',
        menuLabel: 'Voice call options',
        autoSend: 'Send as soon as I stop talking',
        speak: 'Read the reply out loud',
        handsFree: 'Keep listening (continuous call)',
        speakingLabel: 'Speaking',
        bargeIn: 'Keep the microphone open while speaking (talk to interrupt)',
        listeningLabel: 'Listening',
        thinkingLabel: 'Waiting for the assistant…',
        you: 'You',
        assistant: 'Assistant',
        optionsHint: 'Uses the browser microphone and speech synthesis directly.',
        unsupported: 'This browser has no speech recognition. Use Chrome or Edge.',
        denied: 'Microphone blocked. Allow it for this site in the browser address bar.',
        failed: 'Speech recognition failed',
        captionHint: 'Press the microphone to start a voice call.',
      }
    }

    /**
     * Open the microphone once with echo cancellation, noise suppression and
     * automatic gain control, then release it: the recognizer picks up the same
     * preference for the session afterwards. Without this the assistant's own
     * voice can satisfy the recognizer and cause a false interruption on a
     * laptop's speakers, and track settings stay unconstrained.
     */
    async function preflightMicrophone() {
      const media = navigator.mediaDevices
      if (media === undefined || typeof media.getUserMedia !== 'function') return
      let stream = null
      try {
        stream = await media.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      } catch (failure) {
        // A denied or absent device surfaces through the recognizer's own error.
        return
      }
      try {
        const tracks = stream.getAudioTracks()
        for (let index = 0; index < tracks.length; index++) tracks[index].stop()
      } catch (_error) {
        // Releasing the preflight track is best-effort.
      }
    }

    /** One stored preference snapshot. */
    function readSettings() {
      const fallback = { autoSend: true, speak: true, handsFree: true, bargeIn: false }
      try {
        let raw = window.localStorage.getItem(STORAGE_KEY)
        const legacy = raw === null || raw === ''
        if (legacy) raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
        if (raw === null || raw === '') return fallback
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return fallback
        return {
          autoSend: parsed.autoSend !== false,
          speak: parsed.speak !== false,
          handsFree: parsed.handsFree !== false,
          // Off unless chosen: browser speech output is not echo-cancelled, so an
          // open microphone hears the reply, and a misheard copy of it slips past
          // the self-echo filter as the user talking.
          bargeIn: !legacy && parsed.bargeIn === true,
        }
      } catch (_error) {
        return fallback
      }
    }

    /** Persist one preference snapshot; a storage refusal must not break the call. */
    function writeSettings(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch (_error) {
        // Private mode or a quota refusal only loses the preference, never the call.
      }
    }

    /** One monochrome stroked glyph from the plugin's own path table. */
    function Glyph(props) {
      return h('svg', {
        width: props.size, height: props.size, viewBox: '0 0 24 24',
        'aria-hidden': 'true', focusable: 'false',
        fill: props.fill === true ? 'currentColor' : 'none',
        stroke: props.fill === true ? 'none' : 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: props.d }))
    }

    /** The transcript column the Chat view renders its nodes into. */
    function transcriptRoot() {
      const columns = document.querySelectorAll('[data-chat-flow]')
      return columns.length > 0 ? columns[columns.length - 1] : document.body
    }

    /** Readable text of one chat node, with the node's interactive chrome removed. */
    function readNodeText(node) {
      const clone = node.cloneNode(true)
      const drop = clone.querySelectorAll('button,[role="button"],svg,time,[data-turn-process-hidden]')
      for (let index = 0; index < drop.length; index++) {
        const element = drop[index]
        if (element.parentNode !== null) element.parentNode.removeChild(element)
      }
      const raw = typeof clone.innerText === 'string' && clone.innerText !== ''
        ? clone.innerText
        : clone.textContent || ''
      return raw.replace(/\s+/g, ' ').trim()
    }

    /** Every rendered chat node of the active transcript, in reading order. */
    function flowNodes() {
      return Array.prototype.slice.call(document.querySelectorAll('[data-chat-flow-kind]'))
    }

    /** Describe any thrown value without assuming its shape. */
    function describe(failure) {
      if (failure instanceof Error && typeof failure.message === 'string') return failure.message
      return String(failure)
    }

    /**
     * Build the browser-side voice runtime: recognition, speech synthesis, the
     * reply watcher, and the observable view its two slot entries render.
     */
    function createRuntime() {
      const Recognizer = speechRecognitionType()
      const locale = detectLocale()
      const copy = copyFor(locale)
      const voice = window.speechSynthesis === undefined ? null : window.speechSynthesis
      const settings = readSettings()
      const listeners = new Set()
      const voicePreference = { name: '', rate: 1 }

      const runtime = {
        supported: Recognizer !== null,
        speakingSupported: voice !== null,
        copy,
        settings,
        live: false,
        phase: 'idle',
        caption: '',
        partial: false,
        reply: '',
        error: '',
        heard: '',
        toggle,
        start,
        startWith,
        say,
        stopSpeaking,
        interruptAndListen,
        setOption,
        setVoice,
        listVoices,
        bindActions,
        subscribe,
        dispose,
        snapshot: null,
      }

      // React publishes a value by reference: the observable read must hand back
      // a NEW object for every committed change, or useSyncExternalStore bails
      // out and the slot never re-renders.
      function publishSnapshot() {
        runtime.snapshot = {
          live: runtime.live,
          phase: runtime.phase,
          caption: runtime.caption,
          partial: runtime.partial,
          reply: runtime.reply,
          error: runtime.error,
          heard: runtime.heard,
          channel: channel === null ? null : channel.name,
          settings,
          copy,
          supported: runtime.supported,
          speakingSupported: runtime.speakingSupported,
        }
        return runtime.snapshot
      }

      let actions = null
      let actionsSession = null
      /**
       * Where a call started by another plugin sends its turns instead of the
       * on-screen composer: `{ name, send(text) => Promise<string> }`, resolving
       * with the reply to speak. Null for an ordinary chat call.
       */
      let channel = null
      let channelTurn = 0

      publishSnapshot()

      let recognition = null
      let wantListening = false
      let speaking = false
      let echoUntil = 0
      let submittedTurn = false
      let restartTimer = null
      let restartCount = 0
      let observer = null
      let observedRoot = null
      let pollTimer = null
      let settingsTimer = null

      let lastReplyText = ''
      let lastReplyAt = 0
      let lastSpokenLength = 0
      let spokenKeys = new Set()
      const speakQueue = []
      let currentUtterance = null
      let speechWatch = null
      let voiceList = []
      let voiceSubscribed = false
      let speakStartedAt = 0
      let bargeInArmedAt = 0
      let bargedIn = false
      /** Sliding window of the words the assistant recently spoke aloud. */
      let spokenEcho = ''
      let lastSubmittedText = ''
      let lastSubmittedAt = 0

      function notify() {
        publishSnapshot()
        listeners.forEach(function (listener) { listener() })
      }

      function subscribe(listener) {
        listeners.add(listener)
        return function () { listeners.delete(listener) }
      }

      function setPhase(phase) {
        if (runtime.phase === phase) return
        runtime.phase = phase
        notify()
      }

      function setError(message) {
        if (message === '') {
          if (runtime.error === '' && runtime.phase !== 'error') return
          runtime.error = ''
          if (runtime.phase === 'error') runtime.phase = runtime.live ? 'listening' : 'idle'
        } else {
          runtime.error = message
          runtime.phase = 'error'
        }
        notify()
      }

      function setCaption(text, partial) {
        if (runtime.caption === text && runtime.partial === partial) return
        runtime.caption = text
        runtime.partial = partial
        notify()
      }

      function setReply(text) {
        if (runtime.reply === text) return
        runtime.reply = text
        notify()
      }

      function bindActions(next, sessionId) {
        if (actions === next && actionsSession === sessionId) return
        actions = next
        if (actionsSession !== sessionId) {
          actionsSession = sessionId
          // A channel call is not tied to the chat on screen; navigating keeps it.
          if (channel !== null) return
          // A different conversation: nothing spoken here has been heard yet.
          if (runtime.live) stopSession()
          spokenKeys = new Set()
          lastReplyText = ''
          lastReplyAt = 0
          setReply('')
          setCaption('', false)
          notify()
        }
      }

      // ---- microphone -------------------------------------------------------

      function echoHeld() {
        return Date.now() < echoUntil
      }

      /** Stop the microphone without ending the call. */
      function stopRecognition() {
        const active = recognition
        recognition = null
        if (active === null) return
        active.onresult = null
        active.onerror = null
        active.onend = null
        // Its handlers are gone, so nothing waits for a final result: abort releases the microphone at once.
        try {
          if (typeof active.abort === 'function') active.abort()
          else active.stop()
        } catch (_error) { /* already stopped */ }
      }

      function scheduleRestart() {
        if (!runtime.live || !wantListening) return
        if (restartTimer !== null) return
        const delay = Math.min(RESTART_DELAY_MS + restartCount * 200, 2500)
        restartTimer = window.setTimeout(function () {
          restartTimer = null
          beginRecognition()
        }, delay)
      }

      /** Begin one recognition session; restarting is the caller's decision. */
      function beginRecognition() {
        if (!runtime.live || !wantListening || recognition !== null || Recognizer === null) return
        // The reply's end reopens the microphone; a restart timer must not open it mid-reply.
        if (speaking && !settings.bargeIn) return
        if (echoHeld() && !speaking) { scheduleRestart(); return }
        let session
        try {
          session = new Recognizer()
        } catch (failure) {
          setError(copy.failed + ': ' + describe(failure))
          return
        }
        session.lang = locale
        session.continuous = true
        session.interimResults = true
        session.maxAlternatives = 1
        recognition = session
        submittedTurn = false
        if (!speaking || bargedIn) setPhase('listening')

        session.onstart = function () {
          restartCount = 0
          setError('')
          if (!speaking || bargedIn) setPhase('listening')
        }
        session.onresult = function (event) {
          let interim = ''
          let final = ''
          for (let index = event.resultIndex; index < event.results.length; index++) {
            const result = event.results[index]
            const alternative = result[0]
            if (alternative === undefined) continue
            if (result.isFinal) final += alternative.transcript
            else interim += alternative.transcript
          }
          if (interim !== '') {
            // While the assistant speaks, interim text is only meaningful when it
            // is the user interrupting; anything that looks like the spoken reply
            // is the assistant hearing itself and is dropped entirely.
            if (isBargeInSpeech(interim)) bargeIn(interim)
            // The assistant's own words are never shown as the user's.
            else if ((!speaking || bargedIn) && !isSelfEcho(interim)) setCaption(interim, true)
          }
          if (final.trim() === '') return
          const text = final.trim()
          if (speaking && !bargedIn) return
          if (!acceptsTurn(text)) return
          setCaption(text, false)
          // After a barge-in the turn is the user's, so it goes out even while the
          // cancelled voice is still unwinding.
          const canSend = channel !== null || (settings.autoSend && actions !== null)
          if (canSend && !submittedTurn && (!speaking || bargedIn)) submitTranscript(text)
        }
        session.onerror = function (event) {
          const code = event !== null && typeof event.error === 'string' ? event.error : ''
          if (code === 'no-speech' || code === 'aborted') return
          if (code === 'not-allowed' || code === 'service-not-allowed') {
            wantListening = false
            stopRecognition()
            setError(copy.denied)
            return
          }
          setError(copy.failed + (code === '' ? '' : ' (' + code + ')'))
        }
        session.onend = function () {
          if (recognition === session) recognition = null
          if (!runtime.live || !wantListening) {
            if (runtime.live && !speaking) setPhase('idle')
            return
          }
          restartCount = Math.min(restartCount + 1, 8)
          scheduleRestart()
        }

        try {
          session.start()
        } catch (failure) {
          recognition = null
          setError(copy.failed + ': ' + describe(failure))
        }
      }

      /** Submit one final transcript through the composer the user is looking at. */
      function submitTranscript(text) {
        if (channel !== null) { submitToChannel(text); return }
        if (actions === null) return
        try {
          actions.setDraft(text + '\n')
          actions.submit()
          submittedTurn = true
          lastSubmittedText = text.trim().toLowerCase()
          lastSubmittedAt = Date.now()
          // The turn now lives in the chat itself; the strip moves on to the answer.
          setCaption('', false)
          setPhase(settings.speak && voice !== null ? 'waiting' : 'idle')
        } catch (failure) {
          setError(copy.failed + ': ' + describe(failure))
        }
      }

      /** Send one final transcript through the channel and speak whatever it answers. */
      function submitToChannel(text) {
        const target = channel
        const turn = ++channelTurn
        submittedTurn = true
        lastSubmittedText = text.trim().toLowerCase()
        lastSubmittedAt = Date.now()
        runtime.heard = text
        setError('')
        setReply('')
        setCaption('', false)
        setPhase('waiting')
        const say = function (line) {
          if (turn !== channelTurn || !runtime.live || !submittedTurn) return
          const progress = typeof line === 'string' ? line.slice(0, MAX_PROGRESS_CHARS).trim() : ''
          if (progress === '') return
          setReply(progress)
          if (settings.speak && voice !== null) speakAfterCurrent(progress)
        }
        let pending
        try { pending = target.send(text, say) } catch (failure) { pending = Promise.reject(failure) }
        Promise.resolve(pending).then(function (answer) {
          if (turn !== channelTurn || !runtime.live) return
          submittedTurn = false
          const spoken = typeof answer === 'string' ? answer.slice(0, MAX_SPOKEN_CHARS).trim() : ''
          setReply(spoken)
          if (spoken !== '' && settings.speak && voice !== null) speakAfterCurrent(spoken)
          else if (!speaking) { setPhase('listening'); beginRecognition() }
        }, function (failure) {
          if (turn !== channelTurn || !runtime.live) return
          submittedTurn = false
          setError(copy.failed + ': ' + describe(failure))
          beginRecognition()
        })
      }

      /**
       * The user started talking over the reply: cut the voice immediately and
       * keep the microphone, which is already live, as the listening channel.
       */
      function bargeIn(heard) {
        if (bargedIn) return
        bargedIn = true
        speaking = false
        echoUntil = 0
        speakStartedAt = 0
        silenceVoice()
        setReply('')
        if (heard !== undefined && heard !== '') setCaption(heard, true)
        submittedTurn = false
        setPhase('listening')
      }

      /** Words of one phrase, lower-cased and stripped of punctuation. */
      function words(text) {
        return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
      }

      /**
       * Whether a transcript is the assistant hearing its own voice. Speaker
       * bleed arrives as a near-verbatim copy of what is being spoken, so a high
       * word overlap with the recent spoken window is treated as echo, never as
       * an interruption.
       */
      function isSelfEcho(text) {
        if (spokenEcho === '') return false
        const said = words(text)
        if (said.length === 0) return false
        const recent = new Set(words(spokenEcho))
        let shared = 0
        for (let index = 0; index < said.length; index++) if (recent.has(said[index])) shared++
        return shared / said.length >= ECHO_OVERLAP_LIMIT
      }

      /** One interim transcript that is a person interrupting, not speaker bleed. */
      function isBargeInSpeech(text) {
        if (!settings.bargeIn || !speaking || bargedIn) return false
        if (Date.now() - bargeInArmedAt < BARGE_IN_ARM_MS) return false
        const trimmed = text.trim()
        if (trimmed.length < BARGE_IN_MIN_CHARS) return false
        if (words(trimmed).length < BARGE_IN_MIN_WORDS) return false
        return !isSelfEcho(trimmed)
      }

      /** Whether a settled transcript may still become the next turn. */
      function acceptsTurn(text) {
        if (isSelfEcho(text)) return false
        const normalized = text.trim().toLowerCase()
        if (normalized === '') return false
        const repeat = normalized === lastSubmittedText
          && Date.now() - lastSubmittedAt < DUPLICATE_WINDOW_MS
        return !repeat
      }

      /** Remember the words being spoken so their echo can be recognised. */
      function noteSpoken(text) {
        spokenEcho = (text + ' ' + spokenEcho).slice(0, ECHO_WINDOW_CHARS)
      }

      // ---- spoken replies ---------------------------------------------------

      function refreshVoices() {
        if (voice === null) return
        const list = voice.getVoices()
        if (list !== null && list.length > 0) voiceList = list
      }

      /** Names and languages of the installed speech voices, for a settings picker. */
      function listVoices() {
        refreshVoices()
        const out = []
        for (let index = 0; index < voiceList.length; index++) {
          out.push({ name: voiceList[index].name, lang: voiceList[index].lang, local: voiceList[index].localService === true })
        }
        return out
      }

      /** Prefer one named voice (empty restores the automatic choice) and a speaking rate (0.5-2). */
      function setVoice(preference) {
        if (preference !== null && typeof preference === 'object') {
          if (typeof preference.name === 'string') voicePreference.name = preference.name
          if (typeof preference.rate === 'number' && preference.rate >= 0.5 && preference.rate <= 2) voicePreference.rate = preference.rate
        }
      }

      function preferredVoice() {
        if (voiceList.length === 0) refreshVoices()
        if (voicePreference.name !== '') {
          for (let index = 0; index < voiceList.length; index++) {
            if (voiceList[index].name === voicePreference.name) return voiceList[index]
          }
        }
        let exact = null
        let match = null
        let named = null
        const head = locale.split('-')[0]
        for (let index = 0; index < voiceList.length; index++) {
          const candidate = voiceList[index]
          if (candidate.localService !== true) continue
          const language = typeof candidate.lang === 'string' ? candidate.lang : ''
          if (language === locale && exact === null) exact = candidate
          if (language.indexOf(head) === 0 && match === null) match = candidate
          if (named === null && /samantha|alex|ava|allison|serena|daniel|google/i.test(candidate.name)) named = candidate
        }
        return exact || match || named || voiceList[0] || null
      }

      /** Split one reply into speakable sentences so a long answer stays interruptible. */
      function speechChunks(text) {
        const parts = text.slice(0, MAX_SPOKEN_CHARS).split(/(?<=[.!?。！？])\s+/)
        const chunks = []
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index].trim()
          if (part !== '') chunks.push(part)
        }
        return chunks.length > 0 ? chunks : [text.slice(0, MAX_SPOKEN_CHARS)]
      }

      function speakNext() {
        if (voice === null || speakQueue.length === 0) {
          currentUtterance = null
          speaking = false
          if (runtime.live && channel !== null && submittedTurn && !bargedIn) {
            // A progress line ended while the answer is still coming: keep waiting.
            setPhase('waiting')
            return
          }
          if (bargedIn) {
            // The user owns the microphone now; the recognizer never stopped.
            setPhase('listening')
          } else if (runtime.live && wantListening && !settings.bargeIn) {
            // The microphone was closed for the reply; give it back now.
            echoUntil = Date.now() + ECHO_HOLD_MS
            setPhase('listening')
            beginRecognition()
          } else if (runtime.live && wantListening) {
            echoUntil = Date.now() + ECHO_HOLD_MS
            setPhase('listening')
            beginRecognition()
          } else {
            setPhase('idle')
          }
          return
        }
        bargeInArmedAt = Date.now()
        const queued = speakQueue.shift()
        noteSpoken(queued)
        const utterance = new window.SpeechSynthesisUtterance(queued)
        if (!voiceSubscribed) {
          voiceSubscribed = true
          voice.onvoiceschanged = refreshVoices
          refreshVoices()
        }
        const chosen = preferredVoice()
        if (chosen !== null) utterance.voice = chosen
        utterance.rate = voicePreference.rate
        utterance.pitch = 1.04
        utterance.volume = 1
        // Only the utterance now playing may advance the queue: a cancelled one
        // reports its end late (or, in Safari, during cancel()) and must not.
        const finish = function () {
          if (currentUtterance !== utterance) return
          clearSpeechWatch()
          currentUtterance = null
          speakNext()
        }
        utterance.onend = finish
        utterance.onerror = finish
        currentUtterance = utterance
        // A synthesizer left paused (an interrupted audio session) queues forever without this.
        if (voice.paused === true && typeof voice.resume === 'function') voice.resume()
        voice.speak(utterance)
        watchSpeech(finish, queued)
      }

      /** The least time a line takes to say out loud at the chosen rate. */
      function sayingMs(text) {
        return Math.max(SPEECH_MIN_MS, (text.length * SPEECH_MS_PER_CHAR) / voicePreference.rate)
      }

      /**
       * Safari can drop an utterance's end event (it still plays), which would
       * leave the answer queued behind it until something else cancels speech.
       * Its speaking flag is not trustworthy either, so a line never counts as
       * finished before it could have been said (ending it early reopens the
       * microphone onto the assistant's own voice): after that, a quiet
       * synthesizer has finished, and a line still "speaking" long past its
       * length is treated as lost.
       */
      function watchSpeech(finish, text) {
        clearSpeechWatch()
        if (typeof voice.speaking !== 'boolean') return
        const earliest = Date.now() + sayingMs(text)
        const latest = earliest + sayingMs(text) + SPEECH_LOST_MS
        let quiet = 0
        speechWatch = window.setInterval(function () {
          const now = Date.now()
          if (now < earliest) return
          if (now >= latest) { finish(); return }
          if (voice.speaking || voice.pending) { quiet = 0; return }
          quiet++
          if (quiet >= SPEECH_QUIET_TICKS) finish()
        }, SPEECH_WATCH_MS)
      }

      function clearSpeechWatch() {
        if (speechWatch !== null) { window.clearInterval(speechWatch); speechWatch = null }
      }

      /** Drop everything queued or playing; the queue is emptied first so a late end event finds nothing. */
      function silenceVoice() {
        speakQueue.length = 0
        currentUtterance = null
        clearSpeechWatch()
        if (voice !== null) voice.cancel()
      }

      function speak(text) {
        if (voice === null || text.trim() === '') return
        speaking = true
        bargedIn = false
        bargeInArmedAt = Date.now()
        speakStartedAt = Date.now()
        // By default the microphone closes while the reply is spoken: an open
        // microphone hears the assistant's own voice through the speakers and
        // mistakes it for the user. Keeping it open is the opt-in interruption
        // mode, and even then the self-echo filter and the level gate must both
        // agree before a word counts as the user.
        if (!settings.bargeIn) stopRecognition()
        setPhase('speaking')
        // cancel() right before speak() makes Safari lose the next end event, so
        // the synthesizer is only cancelled when something is actually playing.
        if (currentUtterance !== null || voice.speaking === true || voice.pending === true) silenceVoice()
        const chunks = speechChunks(text)
        speakQueue.length = 0
        for (let index = 0; index < chunks.length; index++) speakQueue.push(chunks[index])
        speakNext()
      }

      /**
       * Speak after the sentence now playing instead of cutting it off. Lines
       * still queued are dropped: the newest progress (or the answer) replaces
       * anything that is already out of date.
       */
      function speakAfterCurrent(text) {
        const stalled = voice !== null && voice.speaking === false && voice.pending === false
        if (!speaking || currentUtterance === null || stalled) { speak(text); return }
        const chunks = speechChunks(text)
        speakQueue.length = 0
        for (let index = 0; index < chunks.length; index++) speakQueue.push(chunks[index])
      }

      /**
       * Speak one line outside a call (a typed question's answer), when spoken
       * replies are on. A live call speaks its own turns, so this stays silent then.
       */
      function say(text) {
        if (runtime.live || !settings.speak || voice === null || typeof text !== 'string') return
        const line = text.slice(0, MAX_SPOKEN_CHARS).trim()
        if (line !== '') speakAfterCurrent(line)
      }

      function stopSpeaking() {
        silenceVoice()
        const wasSpeaking = speaking
        speaking = false
        if (!runtime.live) {
          if (runtime.phase === 'speaking') setPhase('idle')
          return
        }
        echoUntil = Date.now() + ECHO_HOLD_MS
        setPhase('idle')
        if (wasSpeaking && wantListening) beginRecognition()
      }

      /** Cut the reply and start listening at once, for a manual interrupt. */
      function interruptAndListen() {
        const wasSpeaking = speaking
        silenceVoice()
        speaking = false
        bargedIn = false
        speakStartedAt = 0
        if (!runtime.live) {
          if (runtime.phase === 'speaking') setPhase('idle')
          return
        }
        echoUntil = wasSpeaking ? Date.now() + BARGE_IN_ECHO_HOLD_MS : 0
        setPhase('listening')
        if (wantListening) beginRecognition()
      }

      // ---- reply watcher ----------------------------------------------------

      /** One pass over the rendered transcript: caption, settle, and speak. */
      function pollReply() {
        if (!runtime.live) return
        if (speaking && Date.now() - speakStartedAt > SPEAK_WATCHDOG_MS) {
          // A synthesis engine that never reports completion must not mute the call.
          stopSpeaking()
          return
        }
        const nodes = flowNodes()
        let lastUser = -1
        let lastAssistant = -1
        let assistantCount = 0
        for (let index = 0; index < nodes.length; index++) {
          const kind = nodes[index].getAttribute('data-chat-flow-kind')
          if (kind === 'user' || kind === 'steering') lastUser = index
          if (kind === 'assistant-step') { lastAssistant = index; assistantCount++ }
        }
        if (lastAssistant < 0 || lastUser > lastAssistant) {
          // No answer yet, or a newer user turn already consumed the last one.
          if (runtime.reply !== '') setReply('')
          if (runtime.phase === 'waiting') setPhase(speaking ? 'speaking' : submittedTurn ? 'waiting' : 'listening')
          return
        }
        const text = readNodeText(nodes[lastAssistant]).slice(0, MAX_SPOKEN_CHARS)
        if (text.length < MIN_SPOKEN_CHARS) return
        if (text !== lastReplyText) {
          lastReplyText = text
          lastReplyAt = Date.now()
          setReply(text)
          if (!speaking && runtime.phase !== 'error') setPhase('waiting')
          return
        }
        if (Date.now() - lastReplyAt < REPLY_SETTLE_MS) return
        // A shorter answer at the same node is a streaming rewrite, not a new answer.
        if (text.length < lastSpokenLength) lastSpokenLength = 0
        const key = assistantCount + ':' + text.length
        if (spokenKeys.has(key)) return
        spokenKeys.add(key)
        lastSpokenLength = text.length
        setReply(text)
        if (settings.speak && voice !== null) speak(text)
        else if (runtime.live && !speaking) setPhase('listening')
      }

      function syncWatcher() {
        if (!runtime.live || channel !== null) {
          if (observer !== null) { observer.disconnect(); observer = null; observedRoot = null }
          if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null }
          return
        }
        const root = transcriptRoot()
        if (observer === null || observedRoot !== root) {
          if (observer !== null) observer.disconnect()
          observedRoot = root
          observer = new window.MutationObserver(function () { pollReply() })
          observer.observe(root, { childList: true, subtree: true, characterData: true })
        }
        if (pollTimer === null) pollTimer = window.setInterval(pollReply, 800)
      }

      // ---- session control --------------------------------------------------

      function startSession() {
        if (!runtime.supported) { setError(copy.unsupported); return }
        void preflightMicrophone()
        runtime.live = true
        wantListening = true
        submittedTurn = false
        spokenEcho = ''
        lastSubmittedText = ''
        lastSubmittedAt = 0
        restartCount = 0
        lastSpokenLength = 0
        setError('')
        setCaption('', false)
        setPhase('listening')
        notify()
        syncWatcher()
        beginRecognition()
      }

      function stopSession() {
        runtime.live = false
        channel = null
        channelTurn++
        runtime.heard = ''
        wantListening = false
        speaking = false
        echoUntil = 0
        submittedTurn = false
        if (restartTimer !== null) { window.clearTimeout(restartTimer); restartTimer = null }
        stopRecognition()
        silenceVoice()
        syncWatcher()
        runtime.caption = ''
        runtime.partial = false
        runtime.reply = ''
        runtime.error = ''
        runtime.phase = 'idle'
        notify()
      }

      function toggle() {
        if (runtime.live) stopSession()
        else startSession()
      }

      /** Begin a call from the button; a no-op when one is already running. */
      function start() {
        if (!runtime.live) startSession()
      }

      /**
       * Begin a call whose turns go to `next` instead of the chat composer, so
       * another surface (the Command Center) can hold a spoken conversation
       * without a chat on screen. An ordinary chat call is ended first.
       */
      function startWith(next) {
        if (next === null || typeof next !== 'object' || typeof next.send !== 'function') return
        if (runtime.live && channel !== null && channel.send === next.send) return
        if (runtime.live) stopSession()
        channel = { name: typeof next.name === 'string' ? next.name : 'channel', send: next.send }
        startSession()
      }

      function setOption(key, value) {
        if (!(key in settings)) return
        settings[key] = value
        writeSettings(settings)
        if (key === 'speak' && value === false) stopSpeaking()
        if (key === 'handsFree' && value === false) wantListening = false
        if (key === 'bargeIn' && value === false) {
          // Returning to the safe mode silences any interruption already in flight.
          bargedIn = false
          if (speaking) stopRecognition()
        }
        if (key === 'bargeIn' && value === true && runtime.live && wantListening && !speaking) {
          beginRecognition()
        }
        notify()
      }

      function watchSettings() {
        settingsTimer = window.setInterval(function () {
          const next = readSettings()
          let changed = false
          const keys = Object.keys(next)
          for (let index = 0; index < keys.length; index++) {
            const key = keys[index]
            if (settings[key] !== next[key]) { settings[key] = next[key]; changed = true }
          }
          if (changed) notify()
        }, 4000)
      }

      function dispose() {
        stopSession()
        if (settingsTimer !== null) { window.clearInterval(settingsTimer); settingsTimer = null }
        if (voice !== null && voiceSubscribed) voice.onvoiceschanged = null
        listeners.clear()
      }

      watchSettings()
      if (voice !== null) refreshVoices()
      return runtime
    }

    /** Subscribe one component to the runtime's observable surface. */
    function useRuntime(runtime) {
      return React.useSyncExternalStore(
        runtime.subscribe,
        function () { return runtime.snapshot },
        function () { return runtime.snapshot },
      )
    }

    /** One checkbox row inside the microphone's options popover. */
    function OptionRow(props) {
      const checked = props.state.settings[props.option] === true
      return h('button', {
        type: 'button',
        className: 'vc-item',
        role: 'menuitemcheckbox',
        'aria-checked': checked ? 'true' : 'false',
        onClick: function () { props.runtime.setOption(props.option, !checked) },
      },
        h('span', { className: 'vc-check' }, checked ? h(Glyph, { d: CHECK, size: 13 }) : null),
        h('span', null, props.label))
    }

    /** The call control on the chat bar: it replaces the stock Call button. */
    function CallControl(props) {
      const runtime = props.runtime
      const state = useRuntime(runtime)
      const [open, setOpen] = React.useState(false)
      const [place, setPlace] = React.useState(null)
      const groupRef = React.useRef(null)
      const popRef = React.useRef(null)
      const actionsRef = React.useRef(null)
      const sessionRef = React.useRef(null)
      actionsRef.current = props.inputActions === undefined ? null : props.inputActions
      sessionRef.current = props.sessionId
      React.useEffect(function () {
        runtime.bindActions(actionsRef.current, sessionRef.current)
        // The activity seat hides the accessory controls while expanded; a call
        // keeps the ordinary row so the transcript strip stays readable. The seat
        // value is optional, so a host that omits it must not break the control.
        if (typeof props.onActiveChange === 'function') props.onActiveChange(false)
        const onDocumentDown = function (event) {
          const inside = (groupRef.current !== null && groupRef.current.contains(event.target))
            || (popRef.current !== null && popRef.current.contains(event.target))
          if (!inside) setOpen(false)
        }
        const onKey = function (event) { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDocumentDown)
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('mousedown', onDocumentDown)
          document.removeEventListener('keydown', onKey)
          if (typeof props.onActiveChange === 'function') props.onActiveChange(false)
        }
      }, [runtime])
      // The slot re-renders with fresh action identities; keep the bound pair current.
      runtime.bindActions(actionsRef.current, sessionRef.current)

      // The menu is anchored with fixed coordinates so no ancestor's overflow or
      // scroll container can clip it, and it flips above the composer when the
      // space below the button is too short.
      React.useEffect(function () {
        if (!open) return undefined
        const measure = function () {
          const anchor = groupRef.current
          const pop = popRef.current
          if (anchor === null || pop === null) return
          const rect = anchor.getBoundingClientRect()
          const width = pop.offsetWidth
          const height = pop.offsetHeight
          const margin = 8
          const fitsBelow = window.innerHeight - rect.bottom > height + margin
          const left = Math.min(
            Math.max(margin, rect.left),
            Math.max(margin, window.innerWidth - width - margin),
          )
          const top = fitsBelow
            ? rect.bottom + 6
            : Math.max(margin, rect.top - height - 6)
          setPlace({ left: left, top: top })
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return function () {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [open])

      const live = state.live
      const speaking = state.phase === 'speaking'
      const label = speaking ? state.copy.hangUp
        : live ? state.copy.hangUp
          : state.copy.call
      const disabled = props.locked === true || !state.supported

      return h('div', { className: 'vc-group', ref: groupRef },
        h('button', {
          type: 'button',
          className: 'vc-btn',
          'data-live': live ? 'true' : undefined,
          'data-error': state.error !== '' ? 'true' : undefined,
          disabled,
          'aria-pressed': live ? 'true' : 'false',
          'aria-label': label,
          title: state.error !== '' ? state.error : label,
          onMouseDown: function (event) { event.preventDefault() },
          onClick: function () {
            if (speaking) runtime.interruptAndListen()
            else if (live) runtime.toggle()
            else runtime.start()
          },
        },
          h('span', { className: 'vc-glyph' },
            speaking ? h(Glyph, { d: STOP, size: 14, fill: true }) : h(Glyph, { d: MIC, size: 15 })),
          h('span', null, label)),
        h('button', {
          type: 'button',
          className: 'vc-btn vc-caret',
          'aria-label': state.copy.menuLabel,
          title: state.copy.menuLabel,
          'aria-expanded': open ? 'true' : 'false',
          'aria-haspopup': 'menu',
          onMouseDown: function (event) { event.preventDefault() },
          onClick: function () { setOpen(!open) },
        }, h(Glyph, { d: CARET, size: 13 })),
        h('div', {
          className: 'vc-pop',
          ref: popRef,
          role: 'menu',
          'aria-label': state.copy.menuLabel,
          hidden: !open,
          style: place === null ? undefined : { left: place.left + 'px', top: place.top + 'px' },
        },
          h(OptionRow, { runtime, state, option: 'autoSend', label: state.copy.autoSend }),
          h(OptionRow, { runtime, state, option: 'speak', label: state.copy.speak }),
          h(OptionRow, { runtime, state, option: 'handsFree', label: state.copy.handsFree }),
          h(OptionRow, { runtime, state, option: 'bargeIn', label: state.copy.bargeIn }),
          h('div', { className: 'vc-sep' }),
          h('p', { className: 'vc-hint' }, state.copy.optionsHint)))
    }

    /** The live transcript strip on the chat, above the composer. */
    function CaptionStrip(props) {
      const runtime = props.runtime
      const state = useRuntime(runtime)
      if (!state.live && state.error === '') return null
      const isError = state.error !== ''
      // The spoken answer keeps the strip until the next turn replaces it, so the
      // call reads as one transcript instead of a line that blinks away.
      const showReply = !isError && state.reply !== '' && state.caption === ''
        && state.settings.speak && state.speakingSupported
      const status = state.phase === 'speaking' ? state.copy.speakingLabel
        : state.phase === 'waiting' ? state.copy.thinkingLabel
          : state.copy.listeningLabel
      const fromAssistant = showReply || state.phase === 'speaking'
      const busy = state.phase === 'waiting' || state.phase === 'speaking'
      const line = isError ? state.error
        : showReply ? state.reply
          : state.caption !== '' ? state.caption
            : state.phase === 'waiting' ? state.copy.thinkingLabel
              : state.copy.listeningLabel
      return h('div', {
        className: 'vc-caption',
        'data-error': isError ? 'true' : undefined,
        role: 'status',
        'aria-live': 'polite',
      },
        h('span', { className: 'vc-tag', 'data-live': state.live && !isError ? 'true' : undefined },
          fromAssistant ? state.copy.assistant : state.copy.you),
        h('div', { className: 'vc-body' },
          h('p', {
            className: 'vc-text',
            'data-partial': state.partial && !showReply && !isError ? 'true' : undefined,
          }, line),
          state.live && !isError
            ? h('div', { className: 'vc-status' },
              h('span', {
                className: 'vc-dot',
                'data-live': busy ? undefined : 'true',
                'data-busy': busy ? 'true' : undefined,
              }),
              h('span', null, status))
            : null))
    }

    /** Install the plugin's stylesheet for this page's lifetime. */
    function installStyles() {
      const tag = document.createElement('style')
      tag.setAttribute('data-dsh-plugin', '@local/voice-call')
      tag.textContent = STYLE
      document.head.append(tag)
      return function () { tag.remove() }
    }

    return {
      name: '@local/voice-call',
      inject: ['slots'],
      apply(ctx) {
        const runtime = createRuntime()
        ctx.effect(function () { return installStyles() })
        ctx.effect(function () { return function () { runtime.dispose() } })
        // Other browser plugins (the Personal AI HUD) observe and steer the call through this service.
        ctx.provide('voiceCall', runtime)
        ctx.slots.inject(CALL_SLOT, function () {
          return ctx.slots.register({
            name: CALL_SLOT,
            id: 'voice-call-control',
            priority: -20,
            order: -20,
            inject: function () { return { runtime: runtime } },
          }, CallControl)
        })
        ctx.slots.inject(CAPTION_SLOT, function () {
          return ctx.slots.register({
            name: CAPTION_SLOT,
            id: 'voice-call-caption',
            order: 30,
            inject: function () { return { runtime: runtime } },
          }, CaptionStrip)
        })
      },
    }
  },
})
