/**
 * Zustand, Regler, Events. Alles, was DOM anfasst.
 *
 * Die Audio-Module unter src/audio/ kennen weder Elemente noch Regler — die
 * Werte werden hier ausgelesen und als Parameter durchgereicht. Wer hier eine
 * Berechnung findet, hat sie am falschen Ort.
 */

import './style.css'
import { analyseMelody, shapedCurve, segmentNotes, detect, noteName } from '../audio/pitch.js'
import { analyseBeat, detectHits, gridded } from '../audio/onset.js'
import { renderMix, toWav } from '../audio/synth.js'
import { buildMidi } from '../audio/midi.js'
import { INSTRUMENTS, KITS, findInstrument, findKit } from '../data/instruments.js'
import { clear, drawLive, drawMelody, drawBeat } from './canvas.js'

const $ = (id) => document.getElementById(id)
const AC = window.AudioContext || window.webkitAudioContext
const MAX_SEC = 20

let ctx = null
let stream = null
let node = null
let srcNode = null
let recording = false
let chunks = []
let recSR = 48000
let startT = 0
let timer = null
let playing = null
let mode = 'melody'

const S = { melody: null, beat: null }
let renderCache = { melody: null, beat: null, both: null }
let curInst = 'bone'
let curKit = 'room'

const cv = $('cv')

function say(t, err) {
  const e = $('status')
  e.textContent = t || ''
  e.className = 'status' + (err ? ' err' : '')
}

async function ensureCtx() {
  if (!ctx) ctx = new AC()
  // Safari startet den Kontext suspendiert und erlaubt resume() nur aus einer
  // Nutzergeste heraus — deshalb hängt jeder Aufruf an einem Klick.
  if (ctx.state === 'suspended') await ctx.resume()
  return ctx
}

function invalidate(k) {
  if (k) renderCache[k] = null
  else renderCache = { melody: null, beat: null, both: null }
  renderCache.both = null
}

/* ══════════════ REGLERWERTE ══════════════ */
const melodyShape = () => ({
  semis: +$('oct').value,
  vib: +$('vib').value / 100,
  quant: +$('quant').value / 100,
})
const bendRange = () => +$('bendRange').value
const gridAmount = () => +$('dgrid').value / 100
const griddedHits = () => gridded(S.beat, gridAmount())
const sourceRate = () => (S.melody ? S.melody.sr : S.beat ? S.beat.sr : recSR)

function recomputeMelody() {
  const d = S.melody
  if (!d) return
  d.shaped = shapedCurve(d, melodyShape())
  d.notes = segmentNotes(d, d.shaped, bendRange())
}

function recomputeBeat() {
  const d = S.beat
  if (!d) return
  const { hits, bpm } = detectHits(d, +$('dsens').value / 100)
  d.hits = hits
  d.bpm = bpm
  $('bpmOut').textContent = bpm ? '≈ ' + bpm + ' BPM' : 'Tempo unklar'
}

/* ══════════════ MODUS ══════════════ */
document.querySelectorAll('.mode').forEach((b) => {
  b.addEventListener('click', () => {
    setMode(b.dataset.m)
  })
})

function setMode(m) {
  mode = m
  document.querySelectorAll('.mode').forEach((x) => {
    const on = x.dataset.m === mode
    x.classList.toggle('on', on)
    x.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  $('recHint').textContent =
    mode === 'melody'
      ? 'Pfeif eine kurze Melodie, bis 20 Sekunden.'
      : 'Mach einen Beat: bumm für Kick, ksch für Snare, ts für Hi-Hat.'
  refresh()
}

function refresh() {
  const d = S[mode]
  $('panelM').classList.toggle('hidden', mode !== 'melody' || !S.melody)
  $('panelB').classList.toggle('hidden', mode !== 'beat' || !S.beat)
  $('out').classList.toggle('hidden', !d)
  $('playBoth').classList.toggle('hidden', !(S.melody && S.beat))
  $('recTitle').textContent = d ? 'Neu aufnehmen' : 'Aufnehmen'
  $('playMain').textContent = mode === 'melody' ? 'Instrument abspielen' : 'Drums abspielen'
  $('empty').style.display = d ? 'none' : 'flex'
  $('empty').textContent = mode === 'melody' ? 'Noch keine Melodie' : 'Noch kein Beat'
  if (d) {
    $('dur').textContent =
      mode === 'melody'
        ? (d.buf.length / d.sr).toFixed(1) + ' s · ' + d.notes.length + ' Noten'
        : (d.buf.length / d.sr).toFixed(1) + ' s · ' + d.hits.length + ' Schläge'
    draw()
  } else {
    clear(cv)
  }
}

function draw() {
  if (mode === 'melody') {
    if (S.melody) drawMelody(cv, S.melody, S.melody.shaped)
  } else if (S.beat) {
    drawBeat(cv, S.beat, griddedHits(), gridAmount() > 0)
  }
}

/* ══════════════ MATERIAL ANNEHMEN ══════════════ */
/** Einziger Einstieg in die Analyse — egal ob Mikrofon oder Datei. */
function ingest(buf, sr) {
  if (mode === 'melody') {
    const m = analyseMelody(buf, sr)
    if (!m) {
      say('Keine klare Tonhöhe gefunden. Näher ans Mikro, ruhiger Raum, durchgehend pfeifen.', true)
      refresh()
      return
    }
    S.melody = m
    invalidate('melody')
    recomputeMelody()
    refresh()
    say('Fertig. ' + m.notes.length + ' Noten erkannt.')
  } else {
    const b = analyseBeat(buf, sr)
    if (!b) {
      say('Nichts gehört. Lauter und näher am Mikro.', true)
      refresh()
      return
    }
    S.beat = b
    invalidate('beat')
    recomputeBeat()
    refresh()
    say('Fertig. ' + b.hits.length + ' Schläge, geschätzt ' + b.bpm + ' BPM.')
  }
}

/* ══════════════ AUFNAHME ══════════════ */
$('rec').addEventListener('click', async () => {
  if (recording) {
    stopRec()
    return
  }
  try {
    await ensureCtx()
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
  } catch (e) {
    say('Kein Zugriff aufs Mikrofon. Erlaubnis prüfen und erneut tippen.', true)
    return
  }
  recSR = ctx.sampleRate
  chunks = []
  recording = true
  startT = performance.now()
  live.length = 0
  acc = new Float32Array(0)

  srcNode = ctx.createMediaStreamSource(stream)
  // ScriptProcessor statt AudioWorklet: läuft überall gleich, auch in älteren
  // Safari-Versionen, und 20 Sekunden Mono kosten nichts.
  node = ctx.createScriptProcessor(2048, 1, 1)
  node.onaudioprocess = (e) => {
    if (!recording) return
    const d = e.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(d))
    liveTick(d)
    if ((performance.now() - startT) / 1000 >= MAX_SEC) stopRec()
  }
  srcNode.connect(node)
  const m = ctx.createGain()
  m.gain.value = 0
  node.connect(m)
  m.connect(ctx.destination)

  $('rec').classList.add('armed')
  $('rec').setAttribute('aria-label', 'Aufnahme beenden')
  $('readout').classList.add('on')
  $('empty').style.display = 'none'
  say('')
  timer = setInterval(() => {
    $('recTitle').textContent = 'Läuft — ' + ((performance.now() - startT) / 1000).toFixed(1) + ' s'
  }, 100)
})

function stopRec() {
  if (!recording) return
  recording = false
  clearInterval(timer)
  try {
    node.disconnect()
    srcNode.disconnect()
  } catch (e) {}
  stream.getTracks().forEach((t) => t.stop())
  $('rec').classList.remove('armed')
  $('rec').setAttribute('aria-label', 'Aufnahme starten')
  $('readout').classList.remove('on')

  let n = 0
  chunks.forEach((c) => (n += c.length))
  if (n < recSR * 0.4) {
    say('Zu kurz. Mindestens eine halbe Sekunde.', true)
    refresh()
    return
  }
  const buf = new Float32Array(n)
  let o = 0
  chunks.forEach((c) => {
    buf.set(c, o)
    o += c.length
  })
  say(mode === 'melody' ? 'Tonhöhe wird ausgelesen …' : 'Schläge werden gesucht …')
  setTimeout(() => {
    try {
      ingest(buf, recSR)
    } catch (e) {
      say('Analyse fehlgeschlagen: ' + e.message, true)
    }
  }, 30)
}

/* ══════════════ LIVE-VORSCHAU ══════════════ */
const live = []
let acc = new Float32Array(0)

function liveTick(d) {
  const m = new Float32Array(acc.length + d.length)
  m.set(acc)
  m.set(d, acc.length)
  acc = m.length > 4096 ? m.slice(m.length - 4096) : m
  if (acc.length < 1024) return

  if (mode === 'melody') {
    const r = detect(acc, acc.length - 1024, 1024, recSR)
    live.push(r.hz)
    $('readout').textContent = r.hz > 0 ? Math.round(r.hz) + ' Hz · ' + noteName(r.hz) : '—'
  } else {
    let s = 0
    for (let i = acc.length - 1024; i < acc.length; i++) s += acc[i] * acc[i]
    const rms = Math.sqrt(s / 1024)
    live.push(rms)
    $('readout').textContent = Math.round(Math.min(100, rms * 400)) + ' %'
  }
  if (live.length > 460) live.shift()
  drawLive(cv, live, mode)
}

/* ══════════════ DATEI STATT MIKROFON ══════════════ */
function toMono(audio) {
  if (audio.numberOfChannels === 1) return Float32Array.from(audio.getChannelData(0))
  const a = audio.getChannelData(0)
  const b = audio.getChannelData(1)
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2
  return out
}

function decode(arrayBuffer) {
  // Safari kennt nur die Callback-Form von decodeAudioData.
  return new Promise((res, rej) => {
    const p = ctx.decodeAudioData(arrayBuffer, res, rej)
    if (p && typeof p.then === 'function') p.then(res, rej)
  })
}

async function ingestArrayBuffer(ab, label) {
  await ensureCtx()
  say('Wird dekodiert …')
  try {
    const audio = await decode(ab)
    const buf = toMono(audio)
    if (buf.length < audio.sampleRate * 0.4) {
      say('Zu kurz. Mindestens eine halbe Sekunde.', true)
      return
    }
    recSR = audio.sampleRate
    say(mode === 'melody' ? 'Tonhöhe wird ausgelesen …' : 'Schläge werden gesucht …')
    ingest(buf, audio.sampleRate)
  } catch (e) {
    say('Datei konnte nicht gelesen werden' + (label ? ' (' + label + ')' : '') + ': ' + e.message, true)
  }
}

$('loadBtn').addEventListener('click', () => $('file').click())
$('file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0]
  if (!f) return
  await ingestArrayBuffer(await f.arrayBuffer(), f.name)
  e.target.value = '' // dieselbe Datei erneut wählbar lassen
})

/**
 * Testaufnahmen aus fixtures/. Nur im Dev-Server — die Fixtures landen
 * absichtlich nicht im Build.
 */
async function initFixtures() {
  const sel = $('fixture')
  if (!import.meta.env.DEV) {
    sel.classList.add('hidden')
    return
  }
  try {
    const res = await fetch('/fixtures/manifest.json')
    if (!res.ok) throw new Error(res.status)
    const list = await res.json()
    list.forEach((f) => {
      const o = document.createElement('option')
      o.value = f.file
      o.dataset.mode = f.mode
      o.textContent = f.label
      sel.appendChild(o)
    })
    sel.addEventListener('change', async () => {
      const opt = sel.selectedOptions[0]
      if (!sel.value) return
      if (opt.dataset.mode && opt.dataset.mode !== mode) setMode(opt.dataset.mode)
      const r = await fetch('/fixtures/' + sel.value)
      await ingestArrayBuffer(await r.arrayBuffer(), sel.value)
    })
  } catch (e) {
    sel.classList.add('hidden')
  }
}

/* ══════════════ INSTRUMENTE ══════════════ */
const ig = $('instGrid')
INSTRUMENTS.forEach((ins) => {
  const b = document.createElement('button')
  b.className = 'inst' + (ins.id === curInst ? ' on' : '')
  b.dataset.id = ins.id
  b.setAttribute('aria-pressed', ins.id === curInst ? 'true' : 'false')
  b.innerHTML = '<span class="iname">' + ins.name + '</span><span class="idesc">' + ins.desc + '</span>'
  b.onclick = () => {
    curInst = ins.id
    invalidate('melody')
    ;[...ig.children].forEach((c) => {
      const on = c.dataset.id === curInst
      c.classList.toggle('on', on)
      c.setAttribute('aria-pressed', on ? 'true' : 'false')
    })
    say('')
  }
  ig.appendChild(b)
})
$('instCount').textContent = INSTRUMENTS.length + ' Klangfarben'

/* ══════════════ KITS ══════════════ */
const kg = $('kitGrid')
KITS.forEach((k) => {
  const b = document.createElement('button')
  b.className = 'inst kit' + (k.id === curKit ? ' on' : '')
  b.dataset.id = k.id
  b.setAttribute('aria-pressed', k.id === curKit ? 'true' : 'false')
  b.innerHTML = '<span class="iname">' + k.name + '</span><span class="idesc">' + k.desc + '</span>'
  b.onclick = () => {
    curKit = k.id
    invalidate('beat')
    ;[...kg.children].forEach((c) => {
      const on = c.dataset.id === curKit
      c.classList.toggle('on', on)
      c.setAttribute('aria-pressed', on ? 'true' : 'false')
    })
    say('')
  }
  kg.appendChild(b)
})
$('kitCount').textContent = KITS.length + ' Kits'

/* ══════════════ RENDERN & ABSPIELEN ══════════════ */
async function render(which) {
  if (renderCache[which]) return renderCache[which]
  const b = await renderMix(which, {
    melody: S.melody,
    beat: S.beat,
    sr: sourceRate(),
    melodyOpts: S.melody
      ? { instrument: findInstrument(curInst), shaped: S.melody.shaped, breath: +$('breath').value / 100 }
      : null,
    beatOpts: S.beat ? { kit: findKit(curKit), hits: griddedHits(), tune: +$('dtune').value } : null,
  })
  renderCache[which] = b
  return b
}

function stopPlay() {
  if (playing) {
    try {
      playing.stop()
    } catch (e) {}
    playing = null
  }
}

async function playBuf(b, label) {
  await ensureCtx()
  stopPlay()
  const s = ctx.createBufferSource()
  s.buffer = b
  s.connect(ctx.destination)
  s.start()
  playing = s
  say('Spielt: ' + label)
}

async function withRender(btn, which, label) {
  await ensureCtx()
  stopPlay()
  const old = btn.textContent
  btn.disabled = true
  btn.textContent = 'Wird gerechnet …'
  try {
    const b = await render(which)
    btn.disabled = false
    btn.textContent = old
    if (b) playBuf(b, label)
  } catch (e) {
    btn.disabled = false
    btn.textContent = old
    say('Rendern fehlgeschlagen: ' + e.message, true)
  }
}

$('playMain').onclick = (e) =>
  withRender(e.currentTarget, mode, mode === 'melody' ? findInstrument(curInst).name : findKit(curKit).name)
$('playBoth').onclick = (e) => withRender(e.currentTarget, 'both', 'Melodie + Beat')
$('playOrig').onclick = async () => {
  const d = S[mode]
  if (!d) return
  await ensureCtx()
  const b = ctx.createBuffer(1, d.buf.length, d.sr)
  b.copyToChannel(d.buf, 0)
  playBuf(b, mode === 'melody' ? 'dein Pfeifen' : 'dein Beat')
}

function download(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

$('dlWav').onclick = async (e) => {
  const btn = e.currentTarget
  const old = btn.textContent
  btn.disabled = true
  btn.textContent = '…'
  try {
    const which = S.melody && S.beat ? 'both' : mode
    const b = await render(which)
    btn.disabled = false
    btn.textContent = old
    if (!b) return
    download(toWav(b), 'mundwerk.wav')
    say('WAV gesichert.')
  } catch (err) {
    btn.disabled = false
    btn.textContent = old
    say('Export fehlgeschlagen.', true)
  }
}

$('dlMidi').onclick = () => {
  if (!S.melody && !S.beat) {
    say('Erst etwas aufnehmen.', true)
    return
  }
  try {
    const bytes = buildMidi({
      melody: S.melody,
      notes: S.melody ? S.melody.notes : [],
      shaped: S.melody ? S.melody.shaped : null,
      instrument: findInstrument(curInst),
      beat: S.beat,
      hits: griddedHits(),
      bendRange: bendRange(),
    })
    download(new Blob([bytes], { type: 'audio/midi' }), 'mundwerk.mid')
    const parts = []
    if (S.melody) parts.push(S.melody.notes.length + ' Noten mit Bend')
    if (S.beat) parts.push(S.beat.hits.length + ' Drum-Schläge')
    say('MIDI gesichert: ' + parts.join(', ') + '. Bend-Umfang im Ziel-Instrument auf ±' + bendRange() + ' stellen.')
  } catch (e) {
    say('MIDI-Export fehlgeschlagen: ' + e.message, true)
  }
}

/* ══════════════ REGLER ══════════════ */
;['oct', 'vib', 'quant', 'breath'].forEach((id) =>
  $(id).addEventListener('input', () => {
    const v = +$(id).value
    if (id === 'oct') $('octV').textContent = (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v) + ' Halbtöne'
    else $(id + 'V').textContent = v + ' %'
    invalidate('melody')
    if (S.melody) {
      recomputeMelody()
      refresh()
    }
  }),
)
;['dsens', 'dgrid', 'dtune'].forEach((id) =>
  $(id).addEventListener('input', () => {
    const v = +$(id).value
    if (id === 'dtune') $('dtuneV').textContent = (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v)
    else $(id + 'V').textContent = v + ' %'
    invalidate('beat')
    if (S.beat) {
      if (id === 'dsens') recomputeBeat()
      refresh()
    }
  }),
)
$('bendRange').addEventListener('input', () => {
  $('bendRangeV').textContent = '±' + $('bendRange').value + ' Halbtöne'
  if (S.melody) {
    recomputeMelody()
    refresh()
  }
})

addEventListener('resize', () => {
  if (S[mode]) draw()
  else if (live.length) drawLive(cv, live, mode)
})

/* ══════════════ START ══════════════ */
export function start() {
  initFixtures()
  refresh()
}
