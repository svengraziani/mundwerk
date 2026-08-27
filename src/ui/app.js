/**
 * Zustand, Regler, Events. Alles, was DOM anfasst.
 *
 * Die Audio-Module unter src/audio/ kennen weder Elemente noch Regler — die
 * Werte werden hier ausgelesen und als Parameter durchgereicht. Wer hier eine
 * Berechnung findet, hat sie am falschen Ort.
 */

import './style.css'
import {
  analyseMelody, shapedCurve, segmentNotes, detect, decimate, decimFactor,
  noteName, profileOf, DEFAULT_PROFILE,
} from '../audio/pitch.js'
import { analyseBeat, detectHits, gridded } from '../audio/onset.js'
import { renderMix, toWav } from '../audio/synth.js'
import { buildMidi, buildMpe, MPE_BEND_RANGE } from '../audio/midi.js'
import { melodyCurve, beatCurve, hitTable, toCsv, toJson } from '../audio/curve.js'
import { INSTRUMENTS, KITS, findInstrument, findKit } from '../data/instruments.js'
import { clear, drawLive, drawMelody, drawBeat } from './canvas.js'

const $ = (id) => document.getElementById(id)
const AC = window.AudioContext || window.webkitAudioContext
const MAX_SEC = 60

/**
 * Was ins Mikrofon kommt.
 *
 * Der Analyseteil steht in pitch.js (PROFILES), hier daneben nur, was das für
 * die Oberfläche heißt: Beschriftung, Vorgabe für die Lage und der
 * Frequenzbereich, über den die Live-Linie gezeichnet wird.
 */
const SOURCES = {
  whistle: {
    tag: 'PFEIFEN',
    hint: 'Pfeif eine Melodie, bis eine Minute.',
    nothing: 'Keine klare Tonhöhe gefunden. Näher ans Mikro, ruhiger Raum, durchgehend pfeifen.',
    original: 'dein Pfeifen',
    // Pfeifen liegt zwei Oktaven über dem, was ein Blasinstrument gern spielt.
    lage: -12,
    lageHint: 'Pfeifen liegt hoch. Runterziehen bringt die Melodie dahin, wo das Instrument natürlich klingt.',
    view: { lo: 400, hi: 4000 },
  },
  voice: {
    tag: 'GESANG',
    hint: 'Sing, summ oder lalala — bis eine Minute.',
    nothing: 'Keine klare Tonhöhe gefunden. Näher ans Mikro, ruhiger Raum, und einen Vokal halten statt zu sprechen.',
    original: 'dein Gesang',
    lage: 0,
    lageHint: 'Gesang liegt schon dort, wo die meisten Instrumente spielen. Verschieben nur, wenn es klingen soll wie ein anderes.',
    view: { lo: 70, hi: 1200 },
  },
}

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
let source = DEFAULT_PROFILE

const S = { melody: null, beat: null }
let renderCache = { melody: null, beat: null, both: null }
let curInst = 'bone'
let curKit = 'room'
let midiFormat = 'classic'

const cv = $('cv')

function say(t, err) {
  const e = $('status')
  e.textContent = t || ''
  e.className = 'status' + (err ? ' err' : '')
}

async function ensureCtx() {
  // Nach close() ist ein Kontext endgültig hin; dann muss ein neuer her.
  if (!ctx || ctx.state === 'closed') {
    ctx = new AC()
    invalidate()
  }
  // Safari startet den Kontext suspendiert und erlaubt resume() nur aus einer
  // Nutzergeste heraus — deshalb hängt jeder Aufruf an einem Klick.
  // 'interrupted' ist Safaris eigener Zustand nach Anruf, Siri oder
  // App-Wechsel. Er steht nicht in der Spezifikation, verhält sich aber wie
  // 'suspended' — wer nur auf 'suspended' prüft, spielt ins Leere.
  if (ctx.state === 'suspended' || ctx.state === 'interrupted') await ctx.resume()
  return ctx
}

/**
 * Den Kontext der Aufnahme wegwerfen.
 *
 * iOS schaltet die Audio-Session beim ersten `createMediaStreamSource` auf
 * „aufnehmen und abspielen“ und legt die Ausgabe damit auf den Hörer am oberen
 * Rand statt auf den Lautsprecher. Die Mikrofonspur zu stoppen reicht nicht:
 * solange derselbe AudioContext lebt, bleibt die Session in diesem Modus, und
 * jede Wiedergabe danach kommt bestenfalls flüsterleise aus dem Hörer. Ein
 * frischer Kontext ist der einzige Weg zurück auf den Lautsprecher.
 */
function dropRecordingCtx() {
  const old = ctx
  ctx = null
  srcNode = null
  node = null
  stream = null
  playing = null
  if (old && old.state !== 'closed') old.close().catch(() => {})
  // Die neue Rate kann eine andere sein — Gerendertes gilt nicht mehr.
  invalidate()
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
const curveRate = () => +$('curveRate').value
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
  $('srcRow').classList.toggle('hidden', mode !== 'melody')
  $('recHint').textContent =
    mode === 'melody'
      ? SOURCES[source].hint
      : 'Mach einen Beat: bumm für Kick, ksch für Snare, ts für Hi-Hat. Bis eine Minute.'
  refresh()
}

/* ══════════════ QUELLE: PFEIFEN ODER GESANG ══════════════ */
document.querySelectorAll('[data-src]').forEach((b) => {
  b.addEventListener('click', () => setSource(b.dataset.src))
})

/**
 * Umschalten zwischen Pfeif- und Gesangsprofil.
 *
 * Die Rohaufnahme bleibt liegen, also wird sie neu ausgewertet statt verworfen
 * — wer nach dem Aufnehmen merkt, dass er im falschen Profil war, soll nicht
 * nochmal singen müssen. `keep` unterdrückt das nur dort, wo direkt danach
 * ohnehin frisches Material kommt.
 */
function setSource(s, keep) {
  if (!SOURCES[s]) return
  const prev = source
  source = s
  document.querySelectorAll('[data-src]').forEach((b) => {
    const on = b.dataset.src === source
    b.classList.toggle('on', on)
    b.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  $('srcTag').textContent = SOURCES[source].tag
  $('octHint').textContent = SOURCES[source].lageHint
  if (mode === 'melody') $('recHint').textContent = SOURCES[source].hint

  // Die Lage wie den Bend-Umfang behandeln: nur nachziehen, solange sie noch
  // auf der Vorgabe des anderen Profils steht. Wer selbst geschoben hat,
  // behält seinen Wert.
  const oct = $('oct')
  if (+oct.value === SOURCES[prev].lage && +oct.value !== SOURCES[source].lage) {
    oct.value = SOURCES[source].lage
    oct.dispatchEvent(new Event('input'))
  }
  if (keep || prev === source) return
  reanalyse()
}

/**
 * Die liegende Rohaufnahme mit dem aktuellen Profil noch einmal auswerten.
 *
 * Wie nach der Aufnahme über einen Timeout: eine Minute Material braucht ein
 * paar Sekunden, und ohne den Umweg käme der Hinweis erst danach auf den
 * Schirm — also nie.
 */
function reanalyse() {
  const d = S.melody
  if (!d || d.profile === source) return
  const want = source
  say('Wird neu ausgewertet …')
  setTimeout(() => {
    // Zwischenzeitlich umgeschaltet? Dann gilt der spätere Lauf.
    if (want !== source || S.melody !== d) return
    try {
      const m = analyseMelody(d.buf, d.sr, want)
      if (!m) {
        say(SOURCES[want].nothing, true)
        return
      }
      S.melody = m
      invalidate('melody')
      recomputeMelody()
      refresh()
      say('Neu ausgewertet als ' + SOURCES[want].tag.toLowerCase() + ': ' + m.notes.length + ' Noten.')
    } catch (e) {
      say('Analyse fehlgeschlagen: ' + e.message, true)
    }
  }, 30)
}

function refresh() {
  const d = S[mode]
  $('panelM').classList.toggle('hidden', mode !== 'melody' || !S.melody)
  $('panelB').classList.toggle('hidden', mode !== 'beat' || !S.beat)
  $('out').classList.toggle('hidden', !d)
  $('playBoth').classList.toggle('hidden', !(S.melody && S.beat))
  $('recTitle').textContent = d ? 'Neu aufnehmen' : 'Aufnehmen'
  $('playMain').textContent = mode === 'melody' ? 'Instrument abspielen' : 'Drums abspielen'
  $('dlCsv').textContent = mode === 'melody' ? 'CSV sichern' : 'Hüllkurven als CSV'
  $('dlCsvHits').classList.toggle('hidden', !S.beat)
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
    const m = analyseMelody(buf, sr, source)
    if (!m) {
      say(SOURCES[source].nothing, true)
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
  // Safari-Versionen, und eine Minute Mono kostet keine 12 MB.
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
  dropRecordingCtx()
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

/**
 * Tonhöhe des letzten Frames, im aktuellen Profil.
 *
 * Dieselbe Kette wie in `analyseMelody`, nur auf dem Schwanz des Puffers:
 * beim Gesang wird auch hier erst dezimiert, sonst zeigt die Anzeige einen
 * anderen Ton an als die spätere Analyse.
 */
function livePitch() {
  const p = profileOf(source)
  const f = decimFactor(p, recSR)
  const need = p.win * f
  if (acc.length < need) return 0
  const a = decimate(acc.subarray(acc.length - need), recSR, f)
  return detect(a.buf, a.buf.length - p.win, p.win, a.sr, p).hz
}

function liveTick(d) {
  const m = new Float32Array(acc.length + d.length)
  m.set(acc)
  m.set(d, acc.length)
  acc = m.length > 4096 ? m.slice(m.length - 4096) : m
  if (acc.length < 1024) return

  if (mode === 'melody') {
    const hz = livePitch()
    live.push(hz)
    $('readout').textContent = hz > 0 ? Math.round(hz) + ' Hz · ' + noteName(hz) : '—'
  } else {
    let s = 0
    for (let i = acc.length - 1024; i < acc.length; i++) s += acc[i] * acc[i]
    const rms = Math.sqrt(s / 1024)
    live.push(rms)
    $('readout').textContent = Math.round(Math.min(100, rms * 400)) + ' %'
  }
  if (live.length > 460) live.shift()
  drawLive(cv, live, mode, SOURCES[source].view)
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
      if (f.source) o.dataset.source = f.source
      o.textContent = f.label
      sel.appendChild(o)
    })
    sel.addEventListener('change', async () => {
      const opt = sel.selectedOptions[0]
      if (!sel.value) return
      if (opt.dataset.mode && opt.dataset.mode !== mode) setMode(opt.dataset.mode)
      // `keep`: gleich danach kommt neues Material, die alte Aufnahme noch
      // einmal durchzurechnen wäre nur Wartezeit.
      if (opt.dataset.source) setSource(opt.dataset.source, true)
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
    // Ausgeben wird mit der Rate des Kontexts, der es abspielt — nicht mit der
    // der Quelle. Eine geladene Datei bringt ihre eigene mit, und iOS-Safari
    // legt einen OfflineAudioContext mit fremder Rate gern lahm.
    renderRate: ctx ? ctx.sampleRate : sourceRate(),
    melodyOpts: S.melody
      ? { instrument: findInstrument(curInst), shaped: S.melody.shaped, breath: +$('breath').value / 100 }
      : null,
    beatOpts: S.beat ? { kit: findKit(curKit), hits: griddedHits(), tune: +$('dtune').value } : null,
  })
  // Nur echte Puffer merken: ein leeres Ergebnis als Treffer zu speichern
  // hieße, den Fehler bei jedem weiteren Tippen zu wiederholen.
  if (b) renderCache[which] = b
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
  // Ein Kontext, der nicht läuft, spielt lautlos weiter — ohne Fehler, ohne
  // Hinweis. Lieber einmal zu viel sagen, als den Nutzer aufs Nichts starren
  // lassen.
  if (ctx.state !== 'running') {
    say('Der Ton hängt: Audio-Kontext steht auf „' + ctx.state + '“. Nochmal tippen.', true)
    return
  }
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
    else say('Das Rendern hat nichts geliefert — nichts zum Abspielen da.', true)
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
  playBuf(b, mode === 'melody' ? SOURCES[source].original : 'dein Beat')
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
  const mpe = midiFormat === 'mpe'
  try {
    const bytes = (mpe ? buildMpe : buildMidi)({
      melody: S.melody,
      notes: S.melody ? S.melody.notes : [],
      shaped: S.melody ? S.melody.shaped : null,
      instrument: findInstrument(curInst),
      beat: S.beat,
      hits: griddedHits(),
      bendRange: bendRange(),
    })
    download(new Blob([bytes], { type: 'audio/midi' }), mpe ? 'mundwerk-mpe.mid' : 'mundwerk.mid')
    const parts = []
    if (S.melody) parts.push(S.melody.notes.length + (mpe ? ' Noten auf eigenen Kanälen' : ' Noten mit Bend'))
    if (S.beat) parts.push(S.beat.hits.length + ' Drum-Schläge')
    say(
      (mpe ? 'MPE gesichert: ' : 'MIDI gesichert: ') +
        parts.join(', ') +
        (mpe
          ? '. Der Bend-Umfang ±' + bendRange() + ' steht auf jedem Stimmkanal — nichts von Hand nachstellen.'
          : '. Bend-Umfang im Ziel-Instrument auf ±' + bendRange() + ' stellen.'),
    )
  } catch (e) {
    say('MIDI-Export fehlgeschlagen: ' + e.message, true)
  }
}

/* ══════════════ ROHKURVE ══════════════ */
/** Was in eine Datei geschrieben wird — ohne DOM, das rechnet curve.js. */
const melodyTable = () => melodyCurve(S.melody, S.melody.shaped, { rate: curveRate() })
const beatTable = () => beatCurve(S.beat, { rate: curveRate() })

/** Reglerstellung und Quelle mit in die JSON-Datei, damit sie nachvollziehbar bleibt. */
const curveMeta = () => ({
  app: 'mundwerk',
  sampleRate: sourceRate(),
  source: S.melody ? S.melody.profile : source,
  shape: melodyShape(),
  instrument: findInstrument(curInst).id,
  bpm: S.beat ? S.beat.bpm : 0,
})

function saveCsv(table, name) {
  download(new Blob([toCsv(table)], { type: 'text/csv;charset=utf-8' }), 'mundwerk-' + name + '.csv')
  say(table.rows.length + ' Zeilen gesichert (' + name + ').')
}

$('dlCsv').onclick = () => {
  try {
    if (mode === 'melody' && S.melody) saveCsv(melodyTable(), 'melodie')
    else if (mode === 'beat' && S.beat) saveCsv(beatTable(), 'beat')
    else say('Für diesen Modus liegt keine Aufnahme vor.', true)
  } catch (e) {
    say('CSV-Export fehlgeschlagen: ' + e.message, true)
  }
}

$('dlCsvHits').onclick = () => {
  if (!S.beat) return
  try {
    saveCsv(hitTable(griddedHits()), 'schlaege')
  } catch (e) {
    say('CSV-Export fehlgeschlagen: ' + e.message, true)
  }
}

$('dlJson').onclick = () => {
  if (!S.melody && !S.beat) {
    say('Erst etwas aufnehmen.', true)
    return
  }
  try {
    const tables = []
    if (S.melody) tables.push(melodyTable())
    if (S.beat) tables.push(beatTable(), hitTable(griddedHits()))
    download(
      new Blob([toJson(tables, curveMeta())], { type: 'application/json' }),
      'mundwerk-kurve.json',
    )
    say('JSON gesichert: ' + tables.map((t) => t.name).join(', ') + '.')
  } catch (e) {
    say('JSON-Export fehlgeschlagen: ' + e.message, true)
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
  showBendRange()
  if (S.melody) {
    recomputeMelody()
    refresh()
  }
})

/* ══════════════ MIDI-FORMAT ══════════════ */
/**
 * Der Bend-Umfang ist derselbe Regler für beide Formate — er entscheidet ja
 * auch, wann `segmentNotes` eine neue Note anfängt. Nur die Grenzen und der
 * Vorgabewert unterscheiden sich: MPE erlaubt bis ±96 und setzt ±48 voraus.
 */
const BEND_MAX = { classic: 24, mpe: 96 }
const BEND_DEFAULT = { classic: 12, mpe: MPE_BEND_RANGE }
const BEND_HINT = {
  classic: 'Wird als RPN mitgeschickt. Muss im Ziel-Instrument gleich eingestellt sein, sonst klingen die Bends falsch.',
  mpe: 'Steht auf jedem Stimmkanal in der Datei — MPE-Instrumente stellen sich selbst darauf ein. Je weiter, desto seltener muss eine Phrase in mehrere Noten zerfallen.',
}

const showBendRange = () => {
  $('bendRangeV').textContent = '±' + $('bendRange').value + ' Halbtöne'
}

function setMidiFormat(f) {
  midiFormat = f
  document.querySelectorAll('[data-fmt]').forEach((b) => {
    const on = b.dataset.fmt === f
    b.classList.toggle('on', on)
    b.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  $('listClassic').classList.toggle('hidden', f !== 'classic')
  $('listMpe').classList.toggle('hidden', f === 'classic')

  // Den Wert vor dem Verschieben der Obergrenze lesen: sonst hat der Browser
  // ihn schon geklemmt, und aus „steht noch auf der Vorgabe“ wird nie etwas.
  const el = $('bendRange')
  const prev = +el.value
  const other = f === 'mpe' ? 'classic' : 'mpe'
  el.max = BEND_MAX[f]
  el.value = prev === BEND_DEFAULT[other] ? BEND_DEFAULT[f] : Math.min(prev, BEND_MAX[f])
  $('bendHint').textContent = BEND_HINT[f]
  showBendRange()

  if (S.melody) {
    recomputeMelody()
    refresh()
  }
}

document.querySelectorAll('[data-fmt]').forEach((b) => b.addEventListener('click', () => setMidiFormat(b.dataset.fmt)))

addEventListener('resize', () => {
  if (S[mode]) draw()
  else if (live.length) drawLive(cv, live, mode, SOURCES[source].view)
})

/* ══════════════ START ══════════════ */
export function start() {
  initFixtures()
  setSource(source, true)
  refresh()
}
