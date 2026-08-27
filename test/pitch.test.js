import test from 'node:test'
import assert from 'node:assert/strict'
import { readWav, manifest } from './wav.js'
import {
  analyseMelody, shapedCurve, segmentNotes, detect, decimate, decimFactor,
  medianFix, octaveFix, bridgeGaps, dropRuns, dropOutliers, noiseFloor,
  HOP, PROFILES, RMS_GATE,
} from '../src/audio/pitch.js'

const SHAPE_NEUTRAL = { semis: 0, vib: 1, quant: 0 }
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12)

function analyse(file, source = 'whistle') {
  const { samples, sampleRate } = readWav(file)
  const m = analyseMelody(samples, sampleRate, source)
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

test('der oberste Ton eines Profils landet nicht eine Oktave tiefer', () => {
  // Die Peaksuche fängt einen Lag über tMin an. Steht tMin genau auf der
  // Periode von fmax, ist der Grundton dort unerreichbar und der erste Peak
  // oberhalb der Schwelle liegt bei 2T — das Ergebnis ist dann exakt eine
  // Oktave zu tief und wird auch noch angenommen, weil es im Bereich liegt.
  for (const id of ['whistle', 'voice']) {
    const p = PROFILES[id]
    const sr = p.rate || 44100
    const buf = new Float32Array(4 * p.win)
    for (const hz of [p.fmax * 0.96, p.fmax * 0.98]) {
      for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * hz * i) / sr)
      const cents = 1200 * Math.log2(detect(buf, 0, p.win, sr, id).hz / hz)
      assert.ok(Math.abs(cents) < 25, `${id} bei ${hz.toFixed(0)} Hz: ${cents.toFixed(0)} Cent daneben`)
    }
    // Was wirklich darüber liegt, gehört verworfen und nicht halbiert.
    const over = p.fmax * 1.2
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * over * i) / sr)
    assert.equal(detect(buf, 0, p.win, sr, id).hz, 0, `${id}: ${over.toFixed(0)} Hz liegt über fmax`)
  }
})

/* ── Profile ────────────────────────────────────────────── */
test('das Gesangsprofil findet, was dem Pfeifprofil zu tief ist', () => {
  const sr = 12000 // Analyserate des Gesangsprofils
  const buf = new Float32Array(8192)
  for (const hz of [90, 130, 220, 440, 880]) {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * hz * i) / sr)
    const v = detect(buf, 0, PROFILES.voice.win, sr, 'voice')
    const cents = Math.abs(1200 * Math.log2(v.hz / hz))
    assert.ok(cents < 12, `${hz} Hz → ${v.hz.toFixed(1)} Hz (${cents.toFixed(1)} Cent daneben)`)
    if (hz < PROFILES.whistle.fmin)
      assert.equal(detect(buf, 0, PROFILES.voice.win, sr, 'whistle').hz, 0, `${hz} Hz gehört nicht ins Pfeifprofil`)
  }
})

test('ein unbekannter Profilname fällt aufs Pfeifen zurück', () => {
  const sr = 44100
  const buf = new Float32Array(4096)
  for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * 880 * i) / sr)
  assert.ok(Math.abs(detect(buf, 0, 1024, sr, 'gibtsnicht').hz - 880) < 10)
  assert.equal(analyseMelody(new Float32Array(44100), sr, 'gibtsnicht'), null)
})

test('decimate rechnet die Rate herunter und hält die Spiegelfrequenzen draußen', () => {
  const sr = 44100
  const n = 44100
  const f = decimFactor('voice', sr)
  assert.equal(f, 4, 'bei 44,1 kHz sind das vier Schritte auf gut 11 kHz')

  const low = new Float32Array(n)
  const high = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    low[i] = Math.sin((2 * Math.PI * 200 * i) / sr)
    // 9 kHz liegt über der neuen Nyquistfrequenz und würde ohne Filter als
    // 2 kHz zurückfalten — genau in den Suchbereich.
    high[i] = Math.sin((2 * Math.PI * 9000 * i) / sr)
  }
  const a = decimate(low, sr, f)
  const b = decimate(high, sr, f)
  assert.equal(a.sr, sr / f)
  assert.equal(a.buf.length, Math.floor(n / f))

  const rms = (x) => {
    let s = 0
    for (let i = 2000; i < x.length - 2000; i++) s += x[i] * x[i]
    return Math.sqrt(s / (x.length - 4000))
  }
  assert.ok(rms(a.buf) > 0.5, 'der Nutzton muss die Dezimierung überleben')
  // Rund 30 dB Dämpfung. Kein Ziegelstein, aber weit unter dem, was eine
  // Stimme im Suchbereich mitbringt.
  assert.ok(rms(b.buf) < 0.05, `9 kHz müssen weg sein, sind aber noch ${rms(b.buf).toFixed(3)}`)

  assert.equal(decimFactor('whistle', sr), 1, 'das Pfeifprofil rechnet mit der Quellrate')
  assert.equal(decimate(low, sr, 1).buf, low, 'Faktor 1 reicht den Puffer unverändert durch')
})

/* ── Rauschsperre ───────────────────────────────────────── */
/** Gleichverteiltes Rauschen mit bekanntem Effektivwert (Amplitude / √3). */
function hiss(n, amp) {
  let seed = 5
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * amp
  }
  return out
}

test('detect schweigt unter der übergebenen Sperre', () => {
  const sr = 44100
  const buf = new Float32Array(4096)
  for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * 880 * i) / sr) * 0.02
  const rms = 0.02 / Math.SQRT2 // Effektivwert eines Sinus
  assert.ok(detect(buf, 0, 1024, sr, 'whistle', rms * 0.5).hz > 0, 'über der Sperre gehört erkannt')
  assert.equal(detect(buf, 0, 1024, sr, 'whistle', rms * 2).hz, 0, 'darunter nicht')
  assert.equal(analyseMelody(buf, sr, 'whistle', rms * 2), null, 'und dann bleibt nichts übrig')
})

test('noiseFloor misst den Median und nicht den Krach dazwischen', () => {
  const sr = 44100
  const buf = hiss(sr, 0.02)
  const floor = noiseFloor(buf, sr, 'whistle')
  const want = 0.02 / Math.sqrt(3)
  assert.ok(Math.abs(floor - want) < want * 0.1, `${floor.toFixed(4)} statt ${want.toFixed(4)}`)

  // Eine zugeschlagene Tür in der Mitte der Messung: der Median hält.
  const slam = Float32Array.from(buf)
  for (let i = sr * 0.4; i < sr * 0.55; i++) slam[i] = buf[i] * 30
  assert.ok(Math.abs(noiseFloor(slam, sr, 'whistle') - floor) < want * 0.1, 'ein Ausreißer darf den Boden nicht heben')

  // Durch dieselbe Kette gemessen wie analysiert: Breitbandrauschen fällt im
  // Gesangsprofil hinter dem Tiefpass leiser aus. Ein Boden, der das nicht
  // mitmacht, würde hinterher leisen Gesang wegsperren.
  assert.ok(noiseFloor(buf, sr, 'voice') < floor * 0.8, 'das Gesangsprofil misst hinter dem Tiefpass')

  assert.equal(noiseFloor(new Float32Array(64), sr, 'whistle'), 0, 'zu kurz für einen einzigen Frame')
})

/**
 * Ein Raum, wie er klingt: überwiegend tieffrequentes Brummen (Lüftung,
 * Straße), das Netzbrummen darüber und etwas Zischen. Weißes Rauschen wäre
 * der leichtere Fall — die eingebaute Sperre kommt damit noch zurecht.
 */
function roomNoise(n, sr, amp) {
  let seed = 11
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 2 - 1
  }
  const out = new Float32Array(n)
  let lp = 0
  let ph = 0
  for (let i = 0; i < n; i++) {
    lp = lp * 0.995 + rnd() * 0.005
    ph += (2 * Math.PI * 50) / sr
    out[i] = (lp * 14 + Math.sin(ph) * 0.25 + rnd() * 0.1) * amp
  }
  return out
}

test('eine gemessene Sperre räumt auf, wo die eingebaute zu tief steht', () => {
  const { samples, sampleRate } = readWav('whistle-clean.wav')
  const noise = roomNoise(samples.length, sampleRate, 0.03)
  const mixed = Float32Array.from(samples, (v, i) => v * 0.8 + noise[i])
  // Die Messung: derselbe Raum, nur ohne dass jemand pfeift.
  const floor = noiseFloor(roomNoise(Math.round(1.5 * sampleRate), sampleRate, 0.03), sampleRate, 'whistle')
  const want = manifest().find((x) => x.file === 'whistle-clean.wav').expect.notes.map((n) => n.midi)

  const notes = (gate) => {
    const m = analyseMelody(mixed, sampleRate, 'whistle', gate)
    const shaped = shapedCurve(m, SHAPE_NEUTRAL)
    return segmentNotes(m, shaped, 12).map((n) => n.midi)
  }
  assert.notDeepEqual(notes(RMS_GATE), want, 'ohne Messung zieht das Rauschen den Grundton weg')
  assert.deepEqual(notes(floor * 2), want, 'mit Boden + 6 dB stimmen die Noten wieder')
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

test('octaveFix holt auch den dritten Teilton herunter, aber nichts hinauf', () => {
  const a = Float32Array.from([220, 220, 220, 660, 660, 220, 220, 220, 220])
  octaveFix(a)
  assert.equal(a[3], 220, 'ein Ausreißer auf der Quinte darüber gehört zurückgeholt')
  assert.equal(a[4], 220)

  // Der Fall aus den Gesangsfixtures: am Ende einer Note bleibt der Grundton
  // weg, und die Erkennung hängt ein halbes Dutzend Frames lang am dritten
  // Teilton. Genau diese Strecke muss zurückgeholt werden.
  const tail = Float32Array.from([...Array(9).fill(220), ...Array(6).fill(660)])
  octaveFix(tail)
  assert.deepEqual(Array.from(tail).slice(9), Array(6).fill(220), 'Ausklingfahne auf dem Teilton')

  // Der umgekehrte Fall darf nicht passieren: liegt der Median selbst auf dem
  // Teilton, muss der gute Frame gut bleiben — sonst frisst sich der Fehler
  // rückwärts durch die Phrase.
  const b = Float32Array.from([660, 660, 660, 660, 220, 660, 660, 660, 660])
  octaveFix(b)
  assert.equal(b[4], 220, 'kein Frame wird auf einen Teilton hochgezogen')
})

test('dropOutliers wirft Teiltonfahnen weg, vorne wie hinten', () => {
  // Ausklingfahne: am Ende einer gesungenen Note bleibt der Grundton weg, und
  // die Erkennung hängt ein paar Frames lang am fünften Teilton.
  const a = Float32Array.from([...Array(12).fill(110), ...Array(4).fill(550)])
  dropOutliers(a, 700)
  assert.deepEqual(Array.from(a).slice(12), [0, 0, 0, 0], 'die Fahne muss weg')
  assert.ok(Array.from(a).slice(0, 12).every((v) => v === 110), 'der Ton selbst bleibt vollständig')

  // Derselbe Fehler am Notenanfang, wo der Ausreißer *vor* dem Ton steht.
  const b = Float32Array.from([...Array(4).fill(550), ...Array(12).fill(110)])
  dropOutliers(b, 700)
  assert.deepEqual(Array.from(b).slice(0, 4), [0, 0, 0, 0], 'auch der Einschwinger')

  // Vibrato ist kein Ausreißer: ein Halbton hin und her bleibt unangetastet.
  const c = new Float32Array(24)
  for (let i = 0; i < c.length; i++) c[i] = 440 * Math.pow(2, Math.sin(i / 2) / 24)
  const before = Array.from(c)
  dropOutliers(c, 700)
  assert.deepEqual(Array.from(c), before)
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
    const r = analyse(f.file, f.source)
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
      const { notes } = analyse(f.file, f.source)
      assert.equal(notes.length, f.expect.notes.length)
      notes.forEach((n, i) => {
        const want = f.expect.notes[i]
        assert.equal(n.midi, want.midi, `Note ${i}`)
        const startSec = n.start / (44100 / HOP)
        assert.ok(Math.abs(startSec - want.start) < 0.06, `Note ${i} beginnt bei ${startSec.toFixed(2)} statt ${want.start}`)
      })
    })
}

// Der Fehler, den `dropOutliers` abfängt: an Ein- und Ausschwingern hängt die
// Erkennung an einem Teilton, und `bridgeGaps` zieht daraus eine Rampe quer
// durch die halbe Oktave. Im Notenergebnis sieht man das erst, wenn es den
// Grundton verschiebt — in der Kurve sofort.
for (const f of withNotes)
  test(`${f.file}: keine Teiltonsprünge innerhalb einer Phrase`, () => {
    const { m } = analyse(f.file, f.source)
    for (let i = 1; i < m.pitch.length; i++) {
      if (!m.pitch[i] || !m.pitch[i - 1]) continue
      const c = Math.abs(1200 * Math.log2(m.pitch[i] / m.pitch[i - 1]))
      assert.ok(c < 400, `Frame ${i}: ${c.toFixed(0)} Cent Sprung von einem Frame zum nächsten`)
    }
  })

test(
  'whistle-reverb.wav: Hallfahne trennt die Phrasen nicht',
  { todo: 'Die Fahne bleibt stimmhaft, drei Phrasen verschmelzen zu einer Note. Bekannte Schwäche der Segmentierung.' },
  () => {
    const { notes } = analyse('whistle-reverb.wav')
    assert.equal(notes.length, 3)
  },
)

for (const f of fixtures.filter((x) => x.expect.notes === 1))
  test(`${f.file}: ein Glissando bleibt eine Note`, () => {
    const { notes, shaped } = analyse(f.file, f.source)
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
    assert.equal(analyseMelody(samples, sampleRate, f.source), null)
    assert.equal(analyseMelody(samples, sampleRate, 'voice'), null, 'auch im Gesangsprofil')
  })
