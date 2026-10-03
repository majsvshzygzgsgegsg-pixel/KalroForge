/**
 * The phone companion: one small page KairoForge serves at
 * `/personal-ai/life/phone` for a phone on the same Wi-Fi (signed in through
 * Phone Connect). The user dictates with the keyboard's microphone (browsers
 * only allow in-page speech recognition on HTTPS), and the note goes to the
 * Mac, which stores it, indexes it, and starts drafting a response.
 */

/** The companion page. */
export const PHONE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="KairoForge">
<meta name="theme-color" content="#05070d">
<title>KairoForge</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; font: 16px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    background: radial-gradient(circle at 50% 0%, #12304a 0%, #05070d 60%); color: #e6f1ff; display: flex; flex-direction: column;
    padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom)); gap: 14px; }
  h1 { margin: 4px 0 0; font-size: 20px; letter-spacing: .04em; }
  .orb { width: 64px; height: 64px; border-radius: 50%; margin: 6px auto 0;
    background: radial-gradient(circle at 35% 30%, #9ff4ff, #2dd4bf 40%, #0b3b52 75%); box-shadow: 0 0 40px #2dd4bf88; }
  .orb.busy { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { transform: scale(1.12); box-shadow: 0 0 70px #2dd4bfcc; } }
  p.hint { margin: 0; color: #8aa4bf; font-size: 14px; text-align: center; }
  textarea { width: 100%; min-height: 160px; resize: vertical; border-radius: 16px; border: 1px solid #23415c; background: #0a1420cc;
    color: inherit; font: inherit; padding: 14px; outline: none; }
  textarea:focus { border-color: #2dd4bf; }
  .row { display: flex; gap: 10px; }
  button { flex: 1; border: 0; border-radius: 14px; padding: 14px; font: 600 16px/1 inherit; color: #04201c; background: #2dd4bf; }
  button.secondary { background: #1b2c3d; color: #cfe3f7; }
  button:disabled { opacity: .5; }
  .card { border-radius: 16px; background: #0a1420cc; border: 1px solid #1b3247; padding: 14px; white-space: pre-wrap; }
  .muted { color: #8aa4bf; font-size: 13px; }
</style>
</head>
<body>
  <div class="orb" id="orb"></div>
  <h1>KairoForge</h1>
  <p class="hint">Tap the box, then the microphone on your keyboard, and whisper a note. Your Mac saves it, adds it to your memory, and starts drafting.</p>
  <textarea id="note" placeholder="Voice note…" autocapitalize="sentences"></textarea>
  <div class="row">
    <button id="send">Send to Mac</button>
    <button id="ask" class="secondary">Ask now</button>
  </div>
  <div id="status" class="muted"></div>
  <div id="reply" class="card" hidden></div>
<script>
const $ = id => document.getElementById(id)
const status = text => { $('status').textContent = text }
async function post(path, body) {
  const response = await fetch('/personal-ai/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || ('HTTP ' + response.status))
  return data
}
async function follow(turnId) {
  $('orb').classList.add('busy')
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const response = await fetch('/personal-ai/converse/' + encodeURIComponent(turnId), { credentials: 'same-origin' })
    const turn = await response.json().catch(() => ({}))
    if (turn.status === 'done' || turn.status === 'failed') {
      $('orb').classList.remove('busy')
      $('reply').hidden = false
      $('reply').textContent = turn.status === 'done' ? (turn.reply || 'Done.') : ('Failed: ' + (turn.error || 'unknown error'))
      return
    }
  }
  $('orb').classList.remove('busy')
}
async function send(kind) {
  const text = $('note').value.trim()
  if (!text) { status('Say or type something first.'); return }
  $('send').disabled = $('ask').disabled = true
  status(kind === 'note' ? 'Sending to your Mac…' : 'Asking…')
  try {
    const result = kind === 'note' ? await post('life/voice-note', { text }) : await post('converse', { text })
    $('note').value = ''
    status(kind === 'note' ? (result.saved ? 'Saved to memory. Drafting on your Mac…' : 'Received. Drafting on your Mac…') : 'Working on it…')
    const turnId = kind === 'note' ? result.turnId : result.id
    if (turnId) await follow(turnId)
  } catch (error) {
    status('Could not reach KairoForge: ' + error.message + '. Open the Phone Connect link on this phone first.')
  } finally {
    $('send').disabled = $('ask').disabled = false
  }
}
$('send').onclick = () => send('note')
$('ask').onclick = () => send('ask')
</script>
</body>
</html>
`
