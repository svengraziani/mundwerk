import test from 'node:test'
import assert from 'node:assert/strict'
import { readWav } from './wav.js'
import { analyseMelody, shapedCurve, segmentNotes } from '../src/audio/pitch.js'
import { analyseBeat, detectHits, gridded } from '../src/audio/onset.js'
import {
  buildMidi, buildMpe, vlq, trackChunk, PPQ,
  MPE_BEND_RANGE, MPE_MEMBERS, MPE_MEMBERS_WITH_DRUMS,
} from '../src/audio/midi.js'
import { findInstrument } from '../src/data/instruments.js'

/* ── ein kleiner SMF-Leser, damit die Tests am Byte prüfen ── */
function parseSmf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (o, n) => String.fromCharCode(...bytes.slice(o, o + n))
  assert.equal(ascii(0, 4), 'MThd')
  assert.equal(dv.getUint32(4), 6)
  const header = { format: dv.getUint16(8), ntracks: dv.getUint16(10), ppq: dv.getUint16(12) }

  const tracks = []
  let p = 14
  while (p < bytes.length) {
    assert.equal(ascii(p, 4), 'MTrk', `Chunk bei ${p} ist kein MTrk`)
    const len = dv.getUint32(p + 4)
    const end = p + 8 + len
    assert.ok(end <= bytes.length, 'Track-Länge zeigt über das Dateiende hinaus')

    let q = p + 8
    let t = 0
    const events = []
    while (q < end) {
      let delta = 0
      for (;;) {
        const b = bytes[q++]
        delta = (delta << 7) | (b & 0x7f)
        if (!(b & 0x80)) break
      }
      t += delta
      const status = bytes[q++]
      assert.ok(status & 0x80, `laufender Status wird nicht unterstützt (Byte ${q - 1})`)
      if (status === 0xff) {
        const type = bytes[q++]
        let len2 = 0
        for (;;) {
          const b = bytes[q++]
          len2 = (len2 << 7) | (b & 0x7f)
          if (!(b & 0x80)) break
        }
        events.push({ t, meta: type, data: bytes.slice(q, q + len2) })
        q += len2
      } else {
        const hi = status & 0xf0
        const n = hi === 0xc0 || hi === 0xd0 ? 1 : 2
        events.push({ t, status, ch: status & 0x0f, kind: hi, data: bytes.slice(q, q + n) })
        q += n
      }
    }
    assert.equal(q, end, 'Track endet nicht exakt an der angegebenen Länge')
    const last = events[events.length - 1]
    assert.equal(last.meta, 0x2f, 'jeder Track muss mit End-of-Track schließen')
    tracks.push(events)
    p = end
  }
  return { header, tracks }
}

function melodyFrom(file, bendRange = 12) {
  const { samples, sampleRate } = readWav(file)
  const m = analyseMelody(samples, sampleRate)
  const shaped = shapedCurve(m, { semis: 0, vib: 1, quant: 0 })
  return { m, shaped, notes: segmentNotes(m, shaped, bendRange) }
}

/** Die Controller-Paare (Nummer, Wert) eines Kanals in Reihenfolge. */
const ccOf = (track, ch) =>
  track.filter((e) => e.kind === 0xb0 && e.ch === ch).map((e) => [e.data[0], e.data[1]])

function beatFrom(file) {
  const { samples, sampleRate } = readWav(file)
  const b = analyseBeat(samples, sampleRate)
  const { hits, bpm } = detectHits(b, 0.5)
  b.hits = hits
  b.bpm = bpm
  return b
}

/* ── Bausteine ─────────────────────────────────────────── */
test('vlq kodiert nach SMF-Regeln', () => {
  assert.deepEqual(vlq(0), [0x00])
  assert.deepEqual(vlq(127), [0x7f])
  assert.deepEqual(vlq(128), [0x81, 0x00])
  assert.deepEqual(vlq(8192), [0xc0, 0x00])
  assert.deepEqual(vlq(1048575), [0xbf, 0xff, 0x7f])
})

test('trackChunk sortiert nach Zeit und Priorität', () => {
  const chunk = trackChunk([
    { t: 10, d: [0x90, 60, 100], p: 2 },
    { t: 10, d: [0x80, 59, 0], p: 1 },
    { t: 0, d: [0x90, 59, 100], p: 2 },
  ])
  const bytes = Uint8Array.from(chunk)
  // Note-Off muss vor dem Note-On zur selben Zeit stehen.
  const noteOff = bytes.indexOf(0x80)
  const noteOn10 = bytes.lastIndexOf(0x90)
  assert.ok(noteOff < noteOn10, 'Note-Off gehört vor das Note-On derselben Zeit')
})

/* ── ganze Datei ───────────────────────────────────────── */
test('Melodie-Export: Kopf, Noten, Bend und Druck', () => {
  const { m, shaped, notes } = melodyFrom('whistle-clean.wav')
  const instrument = findInstrument('bansuri')
  const bytes = buildMidi({ melody: m, notes, shaped, instrument, beat: null, hits: [], bendRange: 12 })
  const { header, tracks } = parseSmf(bytes)

  assert.equal(header.format, 1)
  assert.equal(header.ppq, PPQ)
  assert.equal(header.ntracks, 2, 'Tempo-Track plus Melodie')
  assert.equal(tracks.length, header.ntracks)

  assert.ok(tracks[0].some((e) => e.meta === 0x51), 'Tempo-Meta fehlt')

  const mel = tracks[1]
  const on = mel.filter((e) => e.kind === 0x90)
  const off = mel.filter((e) => e.kind === 0x80)
  assert.equal(on.length, notes.length)
  assert.equal(off.length, notes.length)
  assert.deepEqual(on.map((e) => e.data[0]), notes.map((n) => n.midi))
  assert.ok(on.every((e) => e.data[1] > 0 && e.data[1] < 128), 'Velocity außerhalb 1..127')

  assert.ok(mel.some((e) => e.kind === 0xc0 && e.data[0] === instrument.gm - 1), 'Program Change fehlt')
  assert.ok(mel.filter((e) => e.kind === 0xe0).length > notes.length, 'zu wenige Bend-Werte')
  assert.ok(mel.some((e) => e.kind === 0xd0), 'Channel Pressure fehlt')
  assert.ok(mel.some((e) => e.kind === 0xb0 && e.data[0] === 11), 'CC11 fehlt')

  // RPN 0 mit dem Bend-Umfang, sonst spielt das Zielinstrument falsch.
  const cc = mel.filter((e) => e.kind === 0xb0).map((e) => [e.data[0], e.data[1]])
  assert.deepEqual(cc.slice(0, 4), [[101, 0], [100, 0], [6, 12], [38, 0]])

  // Alles auf Kanal 1, und der Bend steht am Ende wieder in der Mitte.
  assert.ok(mel.filter((e) => e.kind).every((e) => e.ch === 0))
  const lastBend = mel.filter((e) => e.kind === 0xe0).pop()
  assert.deepEqual([...lastBend.data], [0, 64])
})

test('Bend-Umfang landet in RPN und in der Skalierung', () => {
  const { m, shaped, notes } = melodyFrom('whistle-glide.wav')
  const instrument = findInstrument('bone')
  const wide = parseSmf(buildMidi({ melody: m, notes, shaped, instrument, beat: null, hits: [], bendRange: 24 }))
  const cc = wide.tracks[1].filter((e) => e.kind === 0xb0).map((e) => [e.data[0], e.data[1]])
  assert.deepEqual(cc.slice(0, 4), [[101, 0], [100, 0], [6, 24], [38, 0]])

  // Ein Glissando über neun Halbtöne muss innerhalb ±24 bleiben, aber deutlich
  // von der Mitte weg. 14 Bit, LSB zuerst.
  const vals = wide.tracks[1].filter((e) => e.kind === 0xe0).map((e) => e.data[0] | (e.data[1] << 7))
  assert.ok(vals.every((v) => v >= 0 && v <= 16383))
  assert.ok(Math.max(...vals) - Math.min(...vals) > 1500, 'der Bend bewegt sich kaum')
})

test('Drum-Export: Kanal 10, GM-Noten, jede Note wird beendet', () => {
  const beat = beatFrom('beat-simple.wav')
  const hits = gridded(beat, 0)
  const bytes = buildMidi({ melody: null, notes: [], shaped: null, instrument: findInstrument('bone'), beat, hits, bendRange: 12 })
  const { header, tracks } = parseSmf(bytes)

  assert.equal(header.ntracks, 2, 'Tempo-Track plus Drums, keine leere Melodiespur')
  const drums = tracks[1]
  const on = drums.filter((e) => e.kind === 0x90)
  const off = drums.filter((e) => e.kind === 0x80)
  assert.equal(on.length, hits.length)
  assert.equal(off.length, hits.length)
  assert.ok(on.every((e) => e.ch === 9), 'Drums müssen auf Kanal 10 liegen')
  assert.ok(on.every((e) => [36, 38, 42, 46].includes(e.data[0])))
})

test('Melodie und Beat zusammen ergeben drei Spuren', () => {
  const { m, shaped, notes } = melodyFrom('whistle-clean.wav')
  const beat = beatFrom('beat-simple.wav')
  const bytes = buildMidi({
    melody: m, notes, shaped, instrument: findInstrument('sax'),
    beat, hits: gridded(beat, 0), bendRange: 12,
  })
  const { header } = parseSmf(bytes)
  assert.equal(header.ntracks, 3)
})

test('Das Tempo folgt dem geschätzten Beat, sonst 120', () => {
  const { m, shaped, notes } = melodyFrom('whistle-clean.wav')
  const instrument = findInstrument('bone')
  const read = (bytes) => {
    const t = parseSmf(bytes).tracks[0].find((e) => e.meta === 0x51)
    return Math.round(60000000 / ((t.data[0] << 16) | (t.data[1] << 8) | t.data[2]))
  }
  assert.equal(read(buildMidi({ melody: m, notes, shaped, instrument, beat: null, hits: [], bendRange: 12 })), 120)

  const beat = beatFrom('beat-simple.wav')
  const withBeat = buildMidi({ melody: m, notes, shaped, instrument, beat, hits: gridded(beat, 0), bendRange: 12 })
  assert.equal(read(withBeat), beat.bpm)
})

/* ── MPE ───────────────────────────────────────────────── */
test('MPE: untere Zone wird angemeldet, Master trägt das Programm', () => {
  const { m, shaped, notes } = melodyFrom('whistle-clean.wav', MPE_BEND_RANGE)
  const instrument = findInstrument('bansuri')
  const { header, tracks } = parseSmf(
    buildMpe({ melody: m, notes, shaped, instrument, beat: null, hits: [] }),
  )
  assert.equal(header.format, 1)
  assert.equal(header.ntracks, 2)
  const mel = tracks[1]

  // MCM: RPN 6 auf dem Master, Wert = Anzahl der Member-Kanäle. Ohne Data
  // Entry LSB — die MPE-Spezifikation kennt dort keins.
  assert.deepEqual(ccOf(mel, 0), [[101, 0], [100, 6], [6, MPE_MEMBERS]])
  assert.ok(
    mel.some((e) => e.kind === 0xc0 && e.ch === 0 && e.data[0] === instrument.gm - 1),
    'Program Change gehört auf den Master-Kanal',
  )
  // Auf dem Master liegen keine Noten.
  assert.ok(!mel.some((e) => (e.kind === 0x90 || e.kind === 0x80) && e.ch === 0))
})

test('MPE: der Bend-Umfang steht auf jedem Member-Kanal', () => {
  const { m, shaped, notes } = melodyFrom('whistle-glide.wav', MPE_BEND_RANGE)
  const { tracks } = parseSmf(
    buildMpe({ melody: m, notes, shaped, instrument: findInstrument('bone'), beat: null, hits: [] }),
  )
  const mel = tracks[1]
  for (let ch = 1; ch <= MPE_MEMBERS; ch++) {
    assert.deepEqual(
      ccOf(mel, ch).slice(0, 4),
      [[101, 0], [100, 0], [6, MPE_BEND_RANGE], [38, 0]],
      `Kanal ${ch + 1} bekommt keinen Bend-Umfang`,
    )
  }
})

test('MPE: jede Note bekommt einen eigenen Kanal, reihum', () => {
  const { m, shaped, notes } = melodyFrom('whistle-clean.wav', MPE_BEND_RANGE)
  const { tracks } = parseSmf(
    buildMpe({ melody: m, notes, shaped, instrument: findInstrument('sax'), beat: null, hits: [] }),
  )
  const mel = tracks[1]
  const on = mel.filter((e) => e.kind === 0x90)
  assert.equal(on.length, notes.length)
  assert.ok(on.length > 1, 'zum Prüfen der Rotation braucht es mehr als eine Note')
  assert.deepEqual(on.map((e) => e.ch), notes.map((_, i) => 1 + (i % MPE_MEMBERS)))

  // Note-Off auf demselben Kanal wie das zugehörige Note-On.
  const off = mel.filter((e) => e.kind === 0x80)
  assert.deepEqual(off.map((e) => [e.ch, e.data[0]]), on.map((e) => [e.ch, e.data[0]]))
})

test('MPE: Ausdruck steht vor dem Note-On desselben Kanals', () => {
  const { m, shaped, notes } = melodyFrom('whistle-vibrato.wav', MPE_BEND_RANGE)
  const { tracks } = parseSmf(
    buildMpe({ melody: m, notes, shaped, instrument: findInstrument('bone'), beat: null, hits: [] }),
  )
  const mel = tracks[1]

  // Nur die erste Runde: danach wiederholen sich die Kanäle.
  notes.slice(0, MPE_MEMBERS).forEach((nt, i) => {
    const ch = 1 + i
    const onAt = mel.findIndex((e) => e.kind === 0x90 && e.ch === ch)
    assert.ok(onAt > 0, `kein Note-On auf Kanal ${ch + 1}`)
    // Direkt davor: Bend, CC74 und Druck für genau diesen Kanal — nach dem
    // RPN-Block, also mit demselben Tick wie das Note-On.
    const before = mel.slice(0, onAt).filter((e) => e.ch === ch && e.t === mel[onAt].t)
    assert.ok(before.some((e) => e.kind === 0xe0), 'Bend fehlt vor dem Note-On')
    assert.ok(before.some((e) => e.kind === 0xb0 && e.data[0] === 74), 'CC74 fehlt vor dem Note-On')
    assert.ok(before.some((e) => e.kind === 0xd0), 'Druck fehlt vor dem Note-On')
  })
})

test('MPE: Bend, Druck und Timbre laufen pro Stimme mit', () => {
  const { m, shaped, notes } = melodyFrom('whistle-glide.wav', MPE_BEND_RANGE)
  const { tracks } = parseSmf(
    buildMpe({ melody: m, notes, shaped, instrument: findInstrument('lead'), beat: null, hits: [] }),
  )
  const mel = tracks[1]
  const ch = 1 // ein Glissando ist bei ±48 genau eine Note

  const bends = mel.filter((e) => e.kind === 0xe0 && e.ch === ch).map((e) => e.data[0] | (e.data[1] << 7))
  assert.ok(bends.length > 10, 'zu wenige Bend-Werte für eine ganze Phrase')
  assert.ok(bends.every((v) => v >= 0 && v <= 16383))
  assert.ok(Math.max(...bends) - Math.min(...bends) > 400, 'der Bend bewegt sich kaum')

  const timbre = ccOf(mel, ch).filter(([n]) => n === 74).map(([, v]) => v)
  assert.ok(timbre.length > 3, 'CC74 läuft nicht mit')
  assert.ok(timbre.every((v) => v >= 0 && v <= 127))
  assert.ok(Math.max(...timbre) - Math.min(...timbre) > 60, 'die Y-Achse folgt der Lage nicht')

  const press = mel.filter((e) => e.kind === 0xd0 && e.ch === ch).map((e) => e.data[0])
  assert.ok(press.length > 3, 'Channel Pressure läuft nicht mit')

  // Zum Schluss steht jeder benutzte Kanal wieder neutral.
  const last = mel.filter((e) => e.kind === 0xe0 && e.ch === ch).pop()
  assert.deepEqual([...last.data], [0, 64])
  assert.equal(mel.filter((e) => e.kind === 0xd0 && e.ch === ch).pop().data[0], 0)
})

test('MPE mit Drums: die Zone lässt Kanal 10 frei', () => {
  const { m, shaped, notes } = melodyFrom('whistle-clean.wav', MPE_BEND_RANGE)
  const beat = beatFrom('beat-simple.wav')
  const hits = gridded(beat, 0)
  const { header, tracks } = parseSmf(
    buildMpe({ melody: m, notes, shaped, instrument: findInstrument('sax'), beat, hits }),
  )
  assert.equal(header.ntracks, 3)
  const mel = tracks[1]
  const drums = tracks[2]

  assert.deepEqual(ccOf(mel, 0), [[101, 0], [100, 6], [6, MPE_MEMBERS_WITH_DRUMS]])
  assert.ok(
    mel.filter((e) => e.kind).every((e) => e.ch <= MPE_MEMBERS_WITH_DRUMS),
    'die Melodie greift über die Zone hinaus und würde die Drums treffen',
  )
  assert.ok(!mel.some((e) => e.ch === 9), 'auf Kanal 10 darf keine Melodie liegen')
  assert.ok(drums.filter((e) => e.kind).every((e) => e.ch === 9))
  assert.equal(drums.filter((e) => e.kind === 0x90).length, hits.length)
})

test('MPE: ±48 machen aus einem Glissando eine einzige Note', () => {
  const { m, shaped, notes } = melodyFrom('whistle-glide.wav', MPE_BEND_RANGE)
  assert.equal(notes.length, 1, 'bei ±48 Halbtönen passt die ganze Phrase in eine Note')
  const { tracks } = parseSmf(
    buildMpe({ melody: m, notes, shaped, instrument: findInstrument('bone'), beat: null, hits: [] }),
  )
  assert.equal(tracks[1].filter((e) => e.kind === 0x90).length, 1)
})
