import test from 'node:test'
import assert from 'node:assert/strict'
import { readWav, manifest } from './wav.js'
import {
  analyseMelody, shapedCurve, segmentNotes, detect,
  medianFix, octaveFix, bridgeGaps, dropRuns, HOP,
} from '../src/audio/pitch.js'

const SHAPE_NEUTRAL = { semis: 0, vib: 1, quant: 0 }
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12)

function analyse(file) {
  const { samples, sampleRate } = readWav(file)
  const m = analyseMelody(samples, sampleRate)
  if (!m) return null
  const shaped = shapedCurve(m, SHAPE_NEUTRAL)
  return { m, shaped, notes: segmentNotes(m, shaped, 12) }
}

/* ── detect() isoliert ──────────────────────────────────── */
test('detect findet die Frequenz eines reinen Sinus', () => {
  const sr = 44100
  const buf = new Float32Array(4096)
  for (const hz of [420, 880, 1500, 2600, 4000]) {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * hz * i) / sr)
    const r = detect(buf, 0, 1024, sr)
    const cents = Math.abs(1200 * Math.log2(r.hz / hz))
    assert.ok(cents < 12, `${hz} Hz → ${r.hz.toFixed(1)} Hz (${cents.toFixed(1)} Cent daneben)`)
    assert.ok(r.clarity > 0.9, `Klarheit bei ${hz} Hz nur ${r.clarity.toFixed(2)}`)
  }
})

test('detect schweigt bei Stille und außerhalb des Pfeifbereichs', () => {
  const sr = 44100
  const silence = new Float32Array(1024)
  assert.equal(detect(silence, 0, 1024, sr).hz, 0)

  const low = new Float32Array(4096)
  for (let i = 0; i < low.length; i++) low[i] = Math.sin((2 * Math.PI * 120 * i) / sr)
  assert.equal(detect(low, 0, 1024, sr).hz, 0, '120 Hz liegt unter FMIN und darf nicht gemeldet werden')

  assert.equal(detect(silence, -5, 1024, sr).hz, 0, 'Offset außerhalb des Puffers')
  assert.equal(detect(silence, 900, 1024, sr).hz, 0, 'Frame ragt über das Ende hinaus')
})

/* ── Korrekturstufen ────────────────────────────────────── */
test('medianFix entfernt Einzelausreißer, lässt Nullen Nullen', () => {
  const a = Float32Array.from([880, 880, 1760, 880, 880, 0, 880])
  medianFix(a, 5)
  assert.equal(a[2], 880)
  assert.equal(a[5], 0)
})

test('octaveFix holt Halbierungen und Verdopplungen zurück', () => {
  const a = Float32Array.from([880, 880, 880, 1760, 880, 880, 440, 880, 880])
  octaveFix(a)
  assert.equal(a[3], 880)
  assert.equal(a[6], 880)
})

test('bridgeGaps überbrückt kurze Löcher, dropRuns wirft Splitter weg', () => {
  const a = Float32Array.from([880, 880, 0, 0, 880, 880])
  bridgeGaps(a, 4)
  assert.ok(a[2] > 0 && a[3] > 0, 'Zweiframe-Loch muss geschlossen werden')

  const b = Float32Array.from([0, 880, 880, 0, 0, 880, 880, 880, 880, 880, 880, 880])
  dropRuns(b, 6)
  assert.equal(b[1], 0, 'Zweiframe-Schnipsel muss verschwinden')
  assert.equal(b[6], 880, 'Siebenframe-Lauf muss bleiben')
})

/* ── Fixtures ───────────────────────────────────────────── */
const fixtures = manifest().filter((f) => f.mode === 'melody')
const withNotes = fixtures.filter((f) => Array.isArray(f.expect.notes))

for (const f of withNotes) {
  // whistle-reverb: siehe todo-Test unten.
  const known = f.file === 'whistle-reverb.wav'
  test(`${f.file}: Tonhöhen stimmen`, () => {
    const r = analyse(f.file)
    assert.ok(r, 'Analyse darf hier nicht null liefern')
    // Unabhängig von der Segmentierung: in der Mitte jeder erwarteten Note
    // muss die erkannte Tonhöhe stimmen.
    for (const want of f.expect.notes) {
      const mid = (want.start + want.end) / 2
      const i = Math.round((mid * r.m.sr) / HOP)
      const cents = Math.abs(1200 * Math.log2(r.shaped[i] / midiToHz(want.midi)))
      assert.ok(cents < 55, `bei ${mid.toFixed(2)} s erwartet ${want.midi}, ${cents.toFixed(0)} Cent daneben`)
    }
  })

  if (!known)
    test(`${f.file}: Noten werden richtig getrennt`, () => {
      const { notes } = analyse(f.file)
      assert.equal(notes.length, f.expect.notes.length)
      notes.forEach((n, i) => {
        const want = f.expect.notes[i]
        assert.equal(n.midi, want.midi, `Note ${i}`)
        const startSec = n.start / (44100 / HOP)
        assert.ok(Math.abs(startSec - want.start) < 0.06, `Note ${i} beginnt bei ${startSec.toFixed(2)} statt ${want.start}`)
      })
    })
}

test(
  'whistle-reverb.wav: Hallfahne trennt die Phrasen nicht',
  { todo: 'Die Fahne bleibt stimmhaft, drei Phrasen verschmelzen zu einer Note. Bekannte Schwäche der Segmentierung.' },
  () => {
    const { notes } = analyse('whistle-reverb.wav')
    assert.equal(notes.length, 3)
  },
)

test('whistle-glide.wav: ein Glissando bleibt eine Note', () => {
  const f = manifest().find((x) => x.file === 'whistle-glide.wav')
  const { notes, shaped } = analyse('whistle-glide.wav')
  assert.equal(notes.length, f.expect.notes, 'Die Kontur gehört in den Bend, nicht in neue Noten')
  const root = notes[0].midi
  assert.ok(Math.abs(root - f.expect.from) <= 2, `Grundton ${root} sollte am Anfang des Glissandos (${f.expect.from}) liegen`)
  let top = 0
  for (const v of shaped) if (v > top) top = v
  const cents = Math.abs(1200 * Math.log2(top / midiToHz(f.expect.to)))
  assert.ok(cents < 60, `Zielton des Glissandos ${cents.toFixed(0)} Cent daneben`)
})

for (const f of fixtures.filter((x) => x.expect.fails))
  test(`${f.file}: liefert sauber null statt Unsinn`, () => {
    const { samples, sampleRate } = readWav(f.file)
    assert.equal(analyseMelody(samples, sampleRate), null)
  })
