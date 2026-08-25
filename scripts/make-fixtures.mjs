/**
 * Erzeugt die Testaufnahmen in fixtures/.
 *
 * Alles synthetisch und deterministisch (eigener LCG statt Math.random), damit
 * dieselbe Datei auf jedem Rechner byte-gleich herauskommt. Die Ground Truth
 * kommt aus den Syntheseparametern, nicht aus der Analyse — sonst würde der
 * Test nur bestätigen, was der Code ohnehin tut.
 *
 *   npm run fixtures
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const SR = 44100

/* ── Werkzeug ───────────────────────────────────────────── */
let seed = 12345
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const noise = () => rnd() * 2 - 1
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12)

function biquad(input, type, freq, q) {
  const w0 = (2 * Math.PI * freq) / SR
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const alpha = sin / (2 * q)
  let b0, b1, b2
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2
  } else {
    b0 = alpha; b1 = 0; b2 = -alpha
  }
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  const out = new Float32Array(input.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2
    out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0
  }
  return out
}

/** Schroeder-Nachhall: vier Kammfilter parallel, zwei Allpässe dahinter. */
function reverb(x, mix = 0.35) {
  const combs = [1116, 1188, 1277, 1356].map((d) => ({ d, buf: new Float32Array(d), i: 0, g: 0.82 }))
  const allpass = [556, 441].map((d) => ({ d, buf: new Float32Array(d), i: 0, g: 0.7 }))
  const out = new Float32Array(x.length)
  for (let n = 0; n < x.length; n++) {
    let s = 0
    for (const c of combs) {
      const v = c.buf[c.i]
      c.buf[c.i] = x[n] + v * c.g
      c.i = (c.i + 1) % c.d
      s += v
    }
    s /= combs.length
    for (const a of allpass) {
      const v = a.buf[a.i]
      const y = -a.g * s + v
      a.buf[a.i] = s + a.g * y
      a.i = (a.i + 1) % a.d
      s = y
    }
    out[n] = x[n] * (1 - mix) + s * mix
  }
  return out
}

function mixInto(dst, src, atSec, gain = 1) {
  const o = Math.round(atSec * SR)
  for (let i = 0; i < src.length && o + i < dst.length; i++) dst[o + i] += src[i] * gain
}

function normalize(x, peak = 0.85) {
  let m = 0
  for (const v of x) m = Math.max(m, Math.abs(v))
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] = (x[i] / m) * peak
  return x
}

function writeWav(name, x) {
  const len = x.length
  const ab = new ArrayBuffer(44 + len * 2)
  const v = new DataView(ab)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8, 'WAVEfmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, len * 2, true)
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, x[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  writeFileSync(join(OUT, name), Buffer.from(ab))
  return (len / SR).toFixed(2)
}

/* ── Bausteine ──────────────────────────────────────────── */
/**
 * Ein gepfiffener Ton.
 * @param glideFrom  optionale Startfrequenz für ein Glissando in den Ton
 * @param h2         Pegel des zweiten Teiltons (Köder für Oktavfehler)
 */
function whistle(midi, dur, { vibrato = 0.35, breath = 0.012, glideFrom = null, h2 = 0.05 } = {}) {
  const n = Math.round(dur * SR)
  const x = new Float32Array(n)
  const target = midiToHz(midi)
  let phase = 0
  let phase2 = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const glide = glideFrom ? Math.min(1, t / 0.12) : 1
    const base = glideFrom ? glideFrom * Math.pow(target / glideFrom, glide) : target
    const f = base * Math.pow(2, (vibrato * 0.28 * Math.sin(2 * Math.PI * 5.4 * t)) / 12)
    phase += (2 * Math.PI * f) / SR
    phase2 += (2 * Math.PI * f * 2) / SR
    // weiches Ein- und Ausblenden, sonst klickt der Frameanfang
    const env = Math.min(1, t / 0.035) * Math.min(1, (dur - t) / 0.06)
    x[i] = env * (Math.sin(phase) + h2 * Math.sin(phase2) + breath * noise())
  }
  return x
}

function kick(dur = 0.35) {
  const n = Math.round(dur * SR)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const f = 50 + (120 - 50) * Math.exp(-t / 0.035)
    phase += (2 * Math.PI * f) / SR
    x[i] = Math.sin(phase) * Math.exp(-t / 0.09)
  }
  return x
}

function snare(dur = 0.2) {
  const n = Math.round(dur * SR)
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) raw[i] = noise()
  const hp = biquad(raw, 'highpass', 1100, 0.8)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    phase += (2 * Math.PI * 190) / SR
    x[i] = (hp[i] * 0.9 + Math.sin(phase) * 0.35) * Math.exp(-t / 0.055)
  }
  return x
}

function hat(dur = 0.10) {
  const n = Math.round(dur * SR)
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) raw[i] = noise()
  const hp = biquad(biquad(raw, 'highpass', 7500, 0.8), 'highpass', 7500, 0.8)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = hp[i] * Math.exp(-(i / SR) / 0.020)
  return x
}

/* ── Fixtures ───────────────────────────────────────────── */
mkdirSync(OUT, { recursive: true })
const manifest = []

/** Eine Melodie aus Einzeltönen mit Pausen dazwischen. */
function melodyFixture({ file, label, midis, dur = 0.42, gap = 0.09, opts = {}, post = (x) => x, lead = 0.15 }) {
  const total = lead * 2 + midis.length * (dur + gap)
  const x = new Float32Array(Math.round(total * SR))
  const notes = []
  let t = lead
  for (const m of midis) {
    mixInto(x, whistle(m, dur, opts), t)
    notes.push({ midi: m, start: +t.toFixed(3), end: +(t + dur).toFixed(3) })
    t += dur + gap
  }
  const y = normalize(post(x))
  const sec = writeWav(file, y)
  manifest.push({ file, label, mode: 'melody', seconds: +sec, expect: { notes } })
}

melodyFixture({
  file: 'whistle-clean.wav',
  label: 'Pfeifen — sauber',
  midis: [81, 83, 85, 86, 88],
})

melodyFixture({
  file: 'whistle-vibrato.wav',
  label: 'Pfeifen — starkes Vibrato',
  midis: [79, 81, 84],
  dur: 0.7,
  opts: { vibrato: 1.6 },
})

melodyFixture({
  file: 'whistle-reverb.wav',
  label: 'Pfeifen — verhallt',
  midis: [81, 84, 86],
  dur: 0.5,
  gap: 0.14,
  post: (x) => reverb(x, 0.28),
})

melodyFixture({
  file: 'whistle-noisy.wav',
  label: 'Pfeifen — mit Raumrauschen',
  midis: [83, 85, 88],
  dur: 0.5,
  post: (x) => {
    const room = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) room[i] = noise()
    const lp = biquad(room, 'lowpass', 900, 0.7)
    const out = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) out[i] = x[i] + lp[i] * 0.10
    return out
  },
})

melodyFixture({
  file: 'whistle-octave-bait.wav',
  label: 'Pfeifen — starker 2. Teilton',
  midis: [81, 85, 88],
  dur: 0.5,
  opts: { h2: 0.65 },
})

// Glissando: eine durchgehende Phrase, die der Pitch Bend tragen soll.
{
  const dur = 1.6
  const lead = 0.15
  const x = new Float32Array(Math.round((dur + lead * 2) * SR))
  mixInto(x, whistle(88, dur, { glideFrom: midiToHz(79), vibrato: 0.2 }), lead)
  const sec = writeWav('whistle-glide.wav', normalize(x))
  manifest.push({
    file: 'whistle-glide.wav',
    label: 'Pfeifen — ein Glissando',
    mode: 'melody',
    seconds: +sec,
    // Eine einzige Phrase. Der Grundton der Note ist der *Anfang* des
    // Glissandos — den Rest der Kontur trägt der Pitch Bend, nicht eine
    // zweite Note. Deshalb steht hier from/to statt einer festen Note.
    expect: { notes: 1, from: 79, to: 88 },
  })
}

// Zu leise: muss am RMS-Gate scheitern.
{
  const x = new Float32Array(Math.round(2 * SR))
  mixInto(x, whistle(84, 1.2), 0.3)
  normalize(x, 0.002)
  const sec = writeWav('error-quiet.wav', x)
  manifest.push({ file: 'error-quiet.wav', label: 'Fehlerfall — zu leise', mode: 'melody', seconds: +sec, expect: { fails: true } })
}

// Nur Rauschen: keine Tonhöhe, aber auch kein Absturz.
{
  const n = Math.round(2 * SR)
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) raw[i] = noise()
  const x = normalize(biquad(raw, 'lowpass', 3000, 0.7), 0.5)
  const sec = writeWav('error-noise.wav', x)
  manifest.push({ file: 'error-noise.wav', label: 'Fehlerfall — nur Rauschen', mode: 'melody', seconds: +sec, expect: { fails: true } })
}

/** Ein Beat aus Kick / Snare / Hat. */
function beatFixture({ file, label, bpm, pattern, bars = 2, lead = 0.15 }) {
  const beat = 60 / bpm
  const barLen = beat * 4
  const total = lead + bars * barLen + 0.6
  const x = new Float32Array(Math.round(total * SR))
  const hits = []
  for (let b = 0; b < bars; b++) {
    for (const [step, type] of pattern) {
      const t = lead + b * barLen + step * (beat / 4)
      const src = type === 'kick' ? kick() : type === 'snare' ? snare() : hat()
      mixInto(x, src, t, type === 'hat' ? 0.9 : 1)
      hits.push({ t: +t.toFixed(4), type })
    }
  }
  hits.sort((a, b) => a.t - b.t)
  const sec = writeWav(file, normalize(x))
  manifest.push({ file, label, mode: 'beat', seconds: +sec, expect: { bpm, hits } })
}

beatFixture({
  file: 'beat-simple.wav',
  label: 'Beat — gerade, 100 BPM',
  bpm: 100,
  // Jeder Schlag auf einem eigenen Sechzehntel: zwei Schläge zur selben Zeit
  // sind für eine Onset-Erkennung per Definition ein einziger Einsatz.
  pattern: [
    [0, 'kick'], [2, 'hat'], [4, 'snare'], [6, 'hat'],
    [8, 'kick'], [10, 'hat'], [12, 'snare'], [14, 'hat'],
  ],
})

beatFixture({
  file: 'beat-fast.wav',
  label: 'Beat — Sechzehntel, 140 BPM',
  bpm: 140,
  pattern: [
    [0, 'kick'], [6, 'kick'], [4, 'snare'], [12, 'snare'],
    ...[1, 2, 3, 5, 7, 8, 9, 10, 11, 13, 14, 15].map((i) => [i, 'hat']),
  ],
})

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(manifest.map((m) => `${m.file.padEnd(26)} ${String(m.seconds).padStart(5)} s  ${m.label}`).join('\n'))
console.log(`\n${manifest.length} Fixtures in fixtures/`)
