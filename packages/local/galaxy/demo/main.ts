import { createGalaxy, ORB_STATES, type Galaxy, type OrbState } from '../src/index.ts'

const stage = document.querySelector<HTMLElement>('#stage')
const controls = document.querySelector<HTMLElement>('#controls')
if (stage === null || controls === null) throw new Error('demo markup missing')

const requested = new URLSearchParams(location.search).get('state')
const initial: OrbState = ORB_STATES.find(state => state === requested) ?? 'idle'
let galaxy: Galaxy = createGalaxy(stage, { state: initial })
const stateButtons = new Map<OrbState, HTMLButtonElement>()

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = label
  element.addEventListener('click', onClick)
  controls?.append(element)
  return element
}

function showState(next: OrbState): void {
  galaxy.setState(next)
  for (const [state, element] of stateButtons) element.setAttribute('aria-pressed', String(state === next))
}

for (const state of ORB_STATES) stateButtons.set(state, button(state, () => showState(state)))
showState(initial)

let micStream: MediaStream | undefined
const micButton = button('Use microphone', () => {
  if (micStream !== undefined) {
    galaxy.disconnectAudio('mic')
    for (const track of micStream.getTracks()) track.stop()
    micStream = undefined
    micButton.textContent = 'Use microphone'
    return
  }
  showState('arming')
  void navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    micStream = stream
    galaxy.connectAudio('mic', stream)
    micButton.textContent = 'Stop microphone'
    showState('listening')
  }).catch(() => showState('error'))
})

// A speech-like test tone, played and tapped as the AI's playback voice.
let tone: { context: AudioContext; stop: () => void } | undefined
const toneButton = button('Play test tone', () => {
  if (tone !== undefined) {
    tone.stop()
    tone = undefined
    galaxy.disconnectAudio('playback')
    toneButton.textContent = 'Play test tone'
    return
  }
  const context = new AudioContext()
  const voice = context.createOscillator()
  voice.type = 'sawtooth'
  voice.frequency.value = 170
  const filter = context.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = 900
  filter.Q.value = 0.8
  const gain = context.createGain()
  gain.gain.value = 0
  const syllables = context.createOscillator()
  syllables.frequency.value = 4.5
  const depth = context.createGain()
  depth.gain.value = 0.18
  syllables.connect(depth).connect(gain.gain)
  const output = context.createMediaStreamDestination()
  voice.connect(filter).connect(gain)
  gain.connect(context.destination)
  gain.connect(output)
  voice.start()
  syllables.start()
  galaxy.connectAudio('playback', output.stream)
  tone = { context, stop: () => { voice.stop(); syllables.stop(); void context.close() } }
  toneButton.textContent = 'Stop test tone'
  showState('speaking')
})

button('Destroy + recreate', () => {
  const current = galaxy.getState()
  galaxy.destroy()
  galaxy = createGalaxy(stage, { state: current })
  if (micStream !== undefined) galaxy.connectAudio('mic', micStream)
})

const source = document.createElement('span')
source.className = 'label'
controls.append(source)
setInterval(() => { source.textContent = `audio: ${galaxy.getAudioSource()}` }, 250)
