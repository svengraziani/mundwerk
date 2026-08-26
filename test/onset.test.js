import test from 'node:test'
import assert from 'node:assert/strict'
import { readWav, manifest } from './wav.js'
import { analyseBeat, detectHits, estimateBPM, gridded } from '../src/audio/onset.js'

const TOL = 0.045 // s — so nah muss ein Treffer am erwarteten Schlag liegen
const family = (t) => (t === 'openhat' || t === 'hat' ? 'hihat' : t)
const beats = manifest().filter((x) => x.mode === 'beat')

function run(file, sens = 0.5) {
  const { samples, sampleRate } = readWav(file)
  const beat = analyseBeat(samples, sampleRate)
  assert.ok(beat, file + ': analyseBeat darf hier nicht null liefern')
  const { hits, bpm } = detectHits(beat, sens)
  beat.hits = hits
  beat.bpm = bpm
  return { beat, hits, bpm }
}

/** Erwartete Schläge auf erkannte abbilden. */
function pair(file, sens = 0.5) {
  const { hits, bpm } = run(file, sens)
  const want = manifest().find((x) => x.file === file).expect.hits
  const pairs = want.map((w) => ({ w, h: hits.find((x) => Math.abs(x.t - w.t) <= TOL) }))
  return { hits, bpm, want, pairs, matched: pairs.filter((p) => p.h) }
}

/**
 * Ein Beat direkt aus Hüllkurven bauen, ohne Audio. Damit lässt sich das
 * Zusammenspiel zweier Schläge exakt stellen, statt es aus einer Fixture zu
 * hoffen. `band`: 0 = tief, 1 = mitte, 2 = hoch.
 */
function fakeBeat(events, seconds = 2) {
  const sr = 44100
  const frameH = Math.round(sr * 0.005)
  const frameSec = frameH / sr
  const n = Math.floor((seconds * sr) / frameH)
  const env = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (const e of events) {
    const i0 = Math.round(e.t / frameSec)
    for (let k = 0; i0 + k < n; k++) env[e.band][i0 + k] += e.gain * Math.exp(-(k * frameSec) / e.decay)
  }
  const tot = new Float32Array(n)
  for (let i = 0; i < n; i++) tot[i] = env[0][i] + env[1][i] + env[2][i]
  let pk = 0
  for (let i = 0; i < n; i++) pk = Math.max(pk, tot[i])
  for (let b = 0; b < 3; b++) for (let i = 0; i < n; i++) env[b][i] /= pk
  for (let i = 0; i < n; i++) tot[i] /= pk
  return { buf: new Float32Array(Math.round(seconds * sr)), sr, env, tot, frameH, hits: [], bpm: 0 }
}

const at = (hits, t) => hits.find((h) => Math.abs(h.t - t) <= TOL)

/* ══════════════ Fixtures ══════════════ */
for (const f of beats) {
  test(`${f.file}: findet die Schläge`, () => {
    const { hits, want, matched } = pair(f.file)
    const recall = matched.length / want.length
    assert.ok(recall >= 0.92, `nur ${matched.length}/${want.length} Schläge gefunden`)

    // Doppelauslöser auf der Kick sind bekannt und noch offen — siehe den
    // todo-Test unten. Hier nur die Obergrenze, damit es nicht schlimmer wird.
    const extra = hits.length - matched.length
    assert.ok(extra <= Math.ceil(want.length * 0.25), `${extra} Schläge zu viel bei ${want.length} erwarteten`)
  })

  test(`${f.file}: ordnet jeden Schlag exakt zu`, () => {
    const { matched } = pair(f.file)
    const wrong = matched.filter((p) => p.h.type !== p.w.type)
    assert.equal(
      wrong.length,
      0,
      wrong.map((p) => `${p.w.t.toFixed(2)} s: ${p.w.type} → ${p.h.type}`).join(', '),
    )
  })

  test(`${f.file}: schätzt das Tempo`, () => {
    const { bpm } = pair(f.file)
    const off = Math.abs(bpm - f.expect.bpm) / f.expect.bpm
    assert.ok(off < 0.1, `${bpm} BPM statt ${f.expect.bpm}`)
  })
}

/* ══════════════ offen gegen geschlossen ══════════════ */
test('geschlossene Hi-Hats bleiben geschlossen', () => {
  for (const file of ['beat-simple.wav', 'beat-fast.wav']) {
    const { matched } = pair(file)
    const hats = matched.filter((p) => p.w.type === 'hat')
    assert.ok(hats.length >= 4, file + ': zu wenige Hi-Hats zum Prüfen')
    const open = hats.filter((p) => p.h.type !== 'hat')
    assert.equal(open.length, 0, `${file}: ${open.map((p) => p.w.t.toFixed(2)).join(', ')} als offen gemeldet`)
  }
})

test('offene Hi-Hats werden auch als offen erkannt', () => {
  // Gegenprobe zum Test darüber: ein Fix, der 'openhat' einfach nie mehr
  // vergibt, muss hier durchfallen.
  const { matched } = pair('beat-openhat.wav')
  const open = matched.filter((p) => p.w.type === 'openhat')
  assert.ok(open.length >= 3, 'zu wenige offene Hi-Hats in der Fixture')
  assert.ok(
    open.every((p) => p.h.type === 'openhat'),
    open.map((p) => `${p.w.t.toFixed(2)}: ${p.h.type}`).join(', '),
  )
})

test('die Abklingmessung läuft nicht in den nächsten Schlag', () => {
  // Geschlossene Hi-Hat, 100 ms später eine Kick. Deren Energie darf die
  // Abklingdauer der Hi-Hat nicht verlängern.
  const dicht = detectHits(
    fakeBeat([
      { t: 0.3, band: 2, gain: 1, decay: 0.02 },
      { t: 0.4, band: 0, gain: 1.2, decay: 0.09 },
    ]),
  ).hits
  assert.equal(at(dicht, 0.3).type, 'hat', 'die Kick dahinter macht die Hi-Hat nicht offen')
  assert.equal(at(dicht, 0.4).type, 'kick')

  // Dieselbe Hi-Hat mit langer Fahne und Platz dahinter bleibt offen.
  const offen = detectHits(fakeBeat([{ t: 0.3, band: 2, gain: 1, decay: 0.25 }])).hits
  assert.equal(at(offen, 0.3).type, 'openhat')
})

test('eine kurze Hi-Hat bleibt kurz, egal wie eng der nächste Schlag steht', () => {
  for (const gap of [0.06, 0.1, 0.2, 0.5]) {
    const hits = detectHits(
      fakeBeat([
        { t: 0.3, band: 2, gain: 1, decay: 0.02 },
        { t: 0.3 + gap, band: 0, gain: 1.2, decay: 0.09 },
      ]),
    ).hits
    assert.equal(at(hits, 0.3).type, 'hat', `Abstand ${gap} s`)
  }
})

/* ══════════════ Ausläufer des Vorgängers ══════════════ */
test('der Ausläufer der Kick färbt den nächsten Schlag nicht ein', () => {
  // Kick, 120 ms später eine leise Hi-Hat. Zu dem Zeitpunkt liegt im tiefen
  // Band noch gut ein Viertel der Kick an — absolut gemessen sähe das nach
  // Snare aus.
  const hits = detectHits(
    fakeBeat([
      { t: 0.3, band: 0, gain: 1, decay: 0.09 },
      { t: 0.42, band: 2, gain: 0.5, decay: 0.02 },
    ]),
  ).hits
  assert.equal(at(hits, 0.3).type, 'kick')
  assert.equal(at(hits, 0.42).type, 'hat')
})

test('in dichten Mustern bleibt die Hi-Hat nach einer Kick eine Hi-Hat', () => {
  const { matched } = pair('beat-fast.wav')
  const kicks = matched.filter((p) => p.w.type === 'kick').map((p) => p.w.t)
  const nachKick = matched.filter((p) => p.w.type === 'hat' && kicks.some((k) => p.w.t - k > 0 && p.w.t - k < 0.15))
  assert.ok(nachKick.length >= 3, 'zu wenige Hi-Hats direkt nach einer Kick')
  const wrong = nachKick.filter((p) => family(p.h.type) !== 'hihat')
  assert.equal(wrong.length, 0, wrong.map((p) => `${p.w.t.toFixed(2)}: ${p.h.type}`).join(', '))
})

/* ══════════════ Rest ══════════════ */
test(
  'die Kick löst nicht doppelt aus',
  {
    todo:
      'Etwa 90 ms nach einer Kick meldet die Flusserkennung einen zweiten Einsatz. ' +
      'Die Refraktärzeit von 55 ms greift nicht, und sie hochzudrehen würde ' +
      'Sechzehntel ab 140 BPM verschlucken.',
  },
  () => {
    for (const f of beats) {
      const { hits, matched } = pair(f.file)
      assert.equal(hits.length, matched.length, `${f.file}: ${hits.length - matched.length} Schläge zu viel`)
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
