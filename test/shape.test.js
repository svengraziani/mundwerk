import test from 'node:test'
import assert from 'node:assert/strict'
import { readWav } from './wav.js'
import { analyseMelody, shapedCurve, segmentNotes } from '../src/audio/pitch.js'

const { samples, sampleRate } = readWav('whistle-vibrato.wav')
const m = analyseMelody(samples, sampleRate)
const voiced = (a) => [...a].filter((v, i) => m.pitch[i] > 0)
const cents = (a, b) => 1200 * Math.log2(a / b)

test('neutrale Reglerstellung lässt die Tonhöhe, wie sie gepfiffen wurde', () => {
  const s = shapedCurve(m, { semis: 0, vib: 1, quant: 0 })
  for (let i = 0; i < s.length; i++) {
    if (!m.pitch[i]) continue
    assert.ok(Math.abs(cents(s[i], m.pitch[i])) < 1, `Frame ${i} wurde um ${cents(s[i], m.pitch[i]).toFixed(1)} Cent verschoben`)
  }
})

test('Lage verschiebt exakt um Halbtöne', () => {
  for (const semis of [-24, -12, -5, 7]) {
    const s = shapedCurve(m, { semis, vib: 1, quant: 0 })
    for (let i = 0; i < s.length; i++) {
      if (!m.pitch[i]) continue
      assert.ok(Math.abs(cents(s[i], m.pitch[i]) - semis * 100) < 1)
    }
  }
})

test('Vibrato 0 glättet die schnelle Bewegung, ohne die Melodie zu verschieben', () => {
  const full = voiced(shapedCurve(m, { semis: 0, vib: 1, quant: 0 }))
  const none = voiced(shapedCurve(m, { semis: 0, vib: 0, quant: 0 }))

  const wobble = (a) => {
    let s = 0
    for (let i = 1; i < a.length; i++) s += Math.abs(cents(a[i], a[i - 1]))
    return s / a.length
  }
  assert.ok(wobble(none) < wobble(full) * 0.4, `${wobble(none).toFixed(2)} gegen ${wobble(full).toFixed(2)} Cent pro Frame`)

  const mean = (a) => a.reduce((x, y) => x + Math.log2(y), 0) / a.length
  assert.ok(Math.abs(mean(none) - mean(full)) * 1200 < 12, 'die Melodie darunter darf nicht wandern')
})

test('Quantisierung auf 0 % lässt Glissandi vollständig stehen', () => {
  const g = readWav('whistle-glide.wav')
  const gm = analyseMelody(g.samples, g.sampleRate)
  const raw = shapedCurve(gm, { semis: 0, vib: 1, quant: 0 })

  let maxOff = 0
  for (let i = 0; i < raw.length; i++) {
    if (!gm.pitch[i]) continue
    const c = 1200 * Math.log2(raw[i] / 440)
    maxOff = Math.max(maxOff, Math.abs(c - Math.round(c / 100) * 100))
  }
  assert.ok(maxOff > 30, `bei 0 % darf nichts aufs Raster gezogen werden, größte Abweichung nur ${maxOff.toFixed(0)} Cent`)

  const snapped = shapedCurve(gm, { semis: 0, vib: 0, quant: 1 })
  let worst = 0
  for (let i = 0; i < snapped.length; i++) {
    if (!gm.pitch[i]) continue
    const c = 1200 * Math.log2(snapped[i] / 440)
    worst = Math.max(worst, Math.abs(c - Math.round(c / 100) * 100))
  }
  assert.ok(worst < 15, `bei 100 % sollte alles auf Halbtönen sitzen, ${worst.toFixed(0)} Cent daneben`)
})

test('Der Bend-Umfang bestimmt, wann eine neue Note anfängt', () => {
  const g = readWav('whistle-glide.wav')
  const gm = analyseMelody(g.samples, g.sampleRate)
  const shaped = shapedCurve(gm, { semis: 0, vib: 1, quant: 0 })
  const wide = segmentNotes(gm, shaped, 24)
  const narrow = segmentNotes(gm, shaped, 2)
  assert.equal(wide.length, 1, 'mit ±24 trägt der Bend das ganze Glissando')
  assert.ok(narrow.length > wide.length, 'mit ±2 muss es in mehrere Noten zerfallen')
})
