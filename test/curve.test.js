import test from 'node:test'
import assert from 'node:assert/strict'
import { readWav } from './wav.js'
import { analyseMelody, shapedCurve } from '../src/audio/pitch.js'
import { analyseBeat, detectHits, gridded } from '../src/audio/onset.js'
import { melodyCurve, beatCurve, hitTable, toCsv, toJson } from '../src/audio/curve.js'

function melodyFrom(file, shape = { semis: 0, vib: 1, quant: 0 }) {
  const { samples, sampleRate } = readWav(file)
  const m = analyseMelody(samples, sampleRate)
  return { m, shaped: shapedCurve(m, shape) }
}

function beatFrom(file) {
  const { samples, sampleRate } = readWav(file)
  const b = analyseBeat(samples, sampleRate)
  const { hits, bpm } = detectHits(b, 0.5)
  b.hits = hits
  b.bpm = bpm
  return b
}

/** CSV zurück in Zahlen lesen — die Tests prüfen die Datei, nicht das Objekt. */
function parseCsv(text) {
  const lines = text.split('\r\n').filter((l) => l.length)
  const head = lines[0].split(',')
  return { head, rows: lines.slice(1).map((l) => l.split(',')) }
}

const col = (table, key) => {
  const i = table.columns.findIndex((c) => c.key === key)
  assert.ok(i >= 0, `Spalte ${key} fehlt`)
  return table.rows.map((r) => r[i])
}

/* ── Melodiekurve ──────────────────────────────────────── */
test('Im Analyse-Raster steht eine Zeile pro Frame', () => {
  const { m, shaped } = melodyFrom('whistle-clean.wav')
  const t = melodyCurve(m, shaped)
  assert.equal(t.rate, m.frameRate)
  assert.equal(t.rows.length, m.pitch.length)

  // Die Zeitachse läuft gleichmäßig und fängt bei 0 an.
  const ts = col(t, 't_s')
  assert.equal(ts[0], 0)
  for (let i = 1; i < ts.length; i++) {
    assert.ok(Math.abs(ts[i] - ts[i - 1] - 1 / t.rate) < 1e-9)
  }
})

test('Die Kurve gibt wieder, was die Analyse erkannt hat', () => {
  const { m, shaped } = melodyFrom('whistle-clean.wav')
  const t = melodyCurve(m, shaped)
  const hz = col(t, 'hz')
  const raw = col(t, 'hz_raw')
  const voiced = col(t, 'voiced')
  const midi = col(t, 'midi')

  for (let i = 0; i < t.rows.length; i++) {
    const on = m.pitch[i] > 0 && shaped[i] > 0
    assert.equal(voiced[i], on ? 1 : 0, `Frame ${i} ist falsch als stimmhaft markiert`)
    if (!on) {
      assert.equal(hz[i], 0)
      assert.equal(raw[i], 0)
      assert.equal(midi[i], 0)
      continue
    }
    assert.ok(Math.abs(hz[i] - shaped[i]) < 1e-3)
    assert.ok(Math.abs(raw[i] - m.pitch[i]) < 1e-3)
    assert.ok(Math.abs(midi[i] - (69 + 12 * Math.log2(hz[i] / 440))) < 1e-9)
  }
  assert.ok(voiced.some((v) => v === 1), 'nichts als stimmhaft markiert')
})

test('hz folgt den Reglern, hz_raw nicht', () => {
  const { m, shaped } = melodyFrom('whistle-clean.wav', { semis: -12, vib: 1, quant: 0 })
  const t = melodyCurve(m, shaped)
  const hz = col(t, 'hz')
  const raw = col(t, 'hz_raw')
  let seen = 0
  for (let i = 0; i < t.rows.length; i++) {
    if (!raw[i]) continue
    seen++
    assert.ok(Math.abs(1200 * Math.log2(hz[i] / raw[i]) + 1200) < 2, `Frame ${i} ist nicht um eine Oktave versetzt`)
  }
  assert.ok(seen > 20)
})

test('norm spannt die Aufnahme über 0..1 auf', () => {
  const { m, shaped } = melodyFrom('whistle-clean.wav')
  const t = melodyCurve(m, shaped)
  const voiced = col(t, 'voiced')
  const norm = col(t, 'norm').filter((v, i) => voiced[i] === 1)
  assert.ok(norm.every((v) => v >= 0 && v <= 1))
  assert.ok(Math.min(...norm) < 0.01, 'der tiefste Ton liegt nicht bei 0')
  assert.ok(Math.max(...norm) > 0.99, 'der höchste Ton liegt nicht bei 1')

  // Eine Transposition verschiebt alles gleich — die Lage im eigenen Umfang
  // bleibt davon unberührt.
  const up = melodyFrom('whistle-clean.wav', { semis: 7, vib: 1, quant: 0 })
  const normUp = col(melodyCurve(up.m, up.shaped), 'norm').filter((v, i) => voiced[i] === 1)
  norm.forEach((v, i) => assert.ok(Math.abs(v - normUp[i]) < 1e-6, `Frame ${i} verschiebt sich mit der Lage`))
})

test('Ein festes Raster tastet neu ab, ohne die Kurve zu verbiegen', () => {
  const { m, shaped } = melodyFrom('whistle-vibrato.wav')
  const native = melodyCurve(m, shaped)
  const fixed = melodyCurve(m, shaped, { rate: 100 })

  assert.equal(fixed.rate, 100)
  assert.equal(fixed.rows.length, Math.floor(native.seconds * 100) + 1)
  assert.ok(Math.abs(fixed.seconds - native.seconds) < 1e-9)

  // Jede Zeile des festen Rasters muss nah an der Analyse liegen.
  let checked = 0
  fixed.rows.forEach((r) => {
    const i = Math.round(r[0] * m.frameRate)
    if (!(shaped[i] > 0) || !r[1]) return
    checked++
    assert.ok(Math.abs(1200 * Math.log2(r[1] / shaped[i])) < 25, `bei ${r[0]}s weicht die Kurve ab`)
  })
  assert.ok(checked > 50)
})

test('Stille bleibt Null, nicht interpoliert', () => {
  const { m, shaped } = melodyFrom('whistle-clean.wav', { semis: 0, vib: 1, quant: 0 })
  const t = melodyCurve(m, shaped, { rate: 200 })
  t.rows.forEach((r) => {
    if (r[6] === 0) assert.deepEqual(r.slice(1, 6), [0, 0, 0, 0, 0])
    else assert.ok(r[1] > 0 && r[2] > 0)
  })
  assert.ok(t.rows.some((r) => r[6] === 0), 'die Aufnahme hat Pausen, die Kurve nicht')
})

/* ── Beat ──────────────────────────────────────────────── */
test('Die Bandhüllkurven kommen normiert heraus', () => {
  const beat = beatFrom('beat-simple.wav')
  const t = beatCurve(beat)
  assert.equal(t.rate, beat.sr / beat.frameH)
  assert.equal(t.rows.length, beat.tot.length)
  const total = col(t, 'total')
  assert.ok(total.every((v) => v >= 0 && v <= 1.0001))
  assert.ok(Math.max(...total) > 0.99, 'die Summe ist nicht aufs Maximum bezogen')
  t.rows.forEach((r, i) => {
    assert.ok(Math.abs(r[1] + r[2] + r[3] - r[4]) < 1e-5, `Zeile ${i}: Bänder summieren sich nicht`)
  })
})

test('Die Schläge kommen als Tabelle, mit Typ als Text', () => {
  const beat = beatFrom('beat-simple.wav')
  const hits = gridded(beat, 0)
  const t = hitTable(hits)
  assert.equal(t.rows.length, hits.length)
  assert.deepEqual(col(t, 'type'), hits.map((h) => h.type))
  assert.deepEqual(col(t, 'vel'), hits.map((h) => h.vel))
})

/* ── Dateiformate ──────────────────────────────────────── */
test('CSV: Kopfzeile, feste Nachkommastellen, alles wieder einlesbar', () => {
  const { m, shaped } = melodyFrom('whistle-clean.wav')
  const t = melodyCurve(m, shaped, { rate: 100 })
  const { head, rows } = parseCsv(toCsv(t))

  assert.deepEqual(head, ['t_s', 'hz', 'hz_raw', 'midi', 'amp', 'norm', 'voiced'])
  assert.equal(rows.length, t.rows.length)
  rows.forEach((r, i) => {
    assert.equal(r.length, head.length, `Zeile ${i} hat ${r.length} Felder`)
    r.forEach((cell) => assert.ok(/^-?\d+(\.\d+)?$/.test(cell), `„${cell}“ ist keine Zahl`))
    assert.ok(Math.abs(Number(r[0]) - t.rows[i][0]) < 5e-5)
    assert.ok(Math.abs(Number(r[1]) - t.rows[i][1]) < 5e-4)
    assert.equal(Number(r[6]), t.rows[i][6])
  })
})

test('CSV: der Schlagtyp steht unverändert im Text', () => {
  const beat = beatFrom('beat-openhat.wav')
  const { rows } = parseCsv(toCsv(hitTable(gridded(beat, 0))))
  assert.ok(rows.length > 0)
  rows.forEach((r) => assert.ok(['kick', 'snare', 'hat', 'openhat'].includes(r[1])))
})

test('JSON: spaltenweise, mit Rate statt Zeitachse', () => {
  const { m, shaped } = melodyFrom('whistle-clean.wav')
  const beat = beatFrom('beat-simple.wav')
  const mel = melodyCurve(m, shaped, { rate: 100 })
  const obj = JSON.parse(
    toJson([mel, beatCurve(beat, { rate: 100 }), hitTable(gridded(beat, 0))], { sr: m.sr }),
  )

  assert.equal(obj.format, 'mundwerk-curve')
  assert.equal(obj.version, 1)
  assert.equal(obj.source.sr, m.sr)
  assert.deepEqual(Object.keys(obj.curves), ['melodie', 'beat', 'schlaege'])

  const c = obj.curves.melodie
  assert.equal(c.rate, 100)
  assert.equal(c.count, mel.rows.length)
  assert.deepEqual(Object.keys(c.lanes), ['t_s', 'hz', 'hz_raw', 'midi', 'amp', 'norm', 'voiced'])
  Object.values(c.lanes).forEach((lane) => assert.equal(lane.length, c.count))
  assert.ok(Math.abs(c.lanes.hz[10] - mel.rows[10][1]) < 5e-4)

  // Die Schläge haben kein Raster; ihre Zeit steht nur in t_s.
  assert.equal(obj.curves.schlaege.rate, 0)
  assert.equal(typeof obj.curves.schlaege.lanes.type[0], 'string')
})
