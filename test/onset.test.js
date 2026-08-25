import test from 'node:test'
import assert from 'node:assert/strict'
import { readWav, manifest } from './wav.js'
import { analyseBeat, detectHits, estimateBPM, gridded } from '../src/audio/onset.js'

const TOL = 0.045 // s — so nah muss ein Treffer am erwarteten Schlag liegen
const family = (t) => (t === 'openhat' || t === 'hat' ? 'hihat' : t)

function run(file, sens = 0.5) {
  const { samples, sampleRate } = readWav(file)
  const beat = analyseBeat(samples, sampleRate)
  assert.ok(beat, file + ': analyseBeat darf hier nicht null liefern')
  const { hits, bpm } = detectHits(beat, sens)
  return { beat: { ...beat, hits, bpm }, hits, bpm }
}

for (const f of manifest().filter((x) => x.mode === 'beat')) {
  test(`${f.file}: findet die Schläge`, () => {
    const { hits } = run(f.file)
    const want = f.expect.hits

    const matched = want.filter((w) => hits.some((h) => Math.abs(h.t - w.t) <= TOL))
    const recall = matched.length / want.length
    assert.ok(recall >= 0.92, `nur ${matched.length}/${want.length} Schläge gefunden`)

    // Doppelauslöser sind bekannt (siehe todo unten), aber begrenzt.
    const extra = hits.length - matched.length
    assert.ok(extra <= Math.ceil(want.length * 0.25), `${extra} Schläge zu viel bei ${want.length} erwarteten`)
  })

  test(`${f.file}: ordnet Kick, Snare und Hi-Hat richtig zu`, () => {
    const { hits } = run(f.file)
    const wrong = []
    let checked = 0
    for (const w of f.expect.hits) {
      const h = hits.find((x) => Math.abs(x.t - w.t) <= TOL)
      if (!h) continue
      checked++
      if (family(h.type) !== family(w.type)) wrong.push(`${w.t.toFixed(2)} s: ${w.type} → ${h.type}`)
    }
    assert.ok(checked > f.expect.hits.length * 0.9, 'zu wenige Schläge zum Bewerten')
    const rate = (checked - wrong.length) / checked
    // 85 %: bei dichten Mustern färbt der Ausläufer des Vorgängers die
    // Bandverteilung ein (siehe todo unten). Sinkt die Quote darunter, ist
    // wirklich etwas kaputt.
    assert.ok(rate >= 0.85, `nur ${(rate * 100).toFixed(0)} % richtig — ${wrong.join(', ')}`)
  })

  test(`${f.file}: schätzt das Tempo`, () => {
    const { bpm } = run(f.file)
    const off = Math.abs(bpm - f.expect.bpm) / f.expect.bpm
    assert.ok(off < 0.1, `${bpm} BPM statt ${f.expect.bpm}`)
  })
}

test(
  'geschlossene Hi-Hats bleiben geschlossen',
  {
    todo:
      'Die Abklingmessung schaut 350 ms voraus und läuft dabei in den nächsten Schlag. ' +
      'Bei allem ab ~170 BPM wird jede Hi-Hat als offen gemeldet.',
  },
  () => {
    const { hits } = run('beat-simple.wav')
    const hats = hits.filter((h) => family(h.type) === 'hihat')
    assert.ok(hats.length > 0)
    assert.ok(hats.every((h) => h.type === 'hat'), hats.map((h) => h.type).join(' '))
  },
)

test(
  'ein Schlag direkt nach der Kick wird nicht von deren Ausläufer eingefärbt',
  {
    todo:
      'Das 30-ms-Fenster nach dem Einsatz misst bei dichten Mustern noch den ' +
      'Vorgänger mit. In beat-fast.wav kippen dadurch vier Hi-Hats zu Snare bzw. Kick.',
  },
  () => {
    const { hits } = run('beat-fast.wav')
    const want = manifest().find((x) => x.file === 'beat-fast.wav').expect.hits
    for (const w of want) {
      const h = hits.find((x) => Math.abs(x.t - w.t) <= TOL)
      if (h) assert.equal(family(h.type), family(w.type), `bei ${w.t.toFixed(2)} s`)
    }
  },
)

test('Empfindlichkeit wirkt monoton', () => {
  const few = run('beat-simple.wav', 0.15).hits.length
  const many = run('beat-simple.wav', 0.85).hits.length
  assert.ok(many >= few, `${many} bei 85 % gegen ${few} bei 15 %`)
})

test('estimateBPM braucht genug Material', () => {
  assert.equal(estimateBPM([]), 0)
  assert.equal(estimateBPM([{ t: 0 }, { t: 0.5 }, { t: 1 }]), 0, 'unter vier Schlägen keine Schätzung')
})

test('gridded lässt das Timing bei 0 % unangetastet', () => {
  const { beat } = run('beat-simple.wav')
  const raw = gridded(beat, 0)
  assert.deepEqual(raw.map((h) => h.t), beat.hits.map((h) => h.t))

  const snapped = gridded(beat, 1)
  const step = 60 / beat.bpm / 4
  for (const h of snapped) {
    const off = Math.abs(h.t / step - Math.round(h.t / step))
    assert.ok(off < 1e-6, 'bei 100 % muss jeder Schlag exakt auf dem Sechzehntel sitzen')
  }
})
