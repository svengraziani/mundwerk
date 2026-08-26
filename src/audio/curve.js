/**
 * Rohkurven-Export: die Analyse als Zahlenreihe statt als Noten.
 *
 * MIDI ist eine Interpretation — Phrasen werden zu Noten, die Kontur zu Bend,
 * die Lautstärke zu Druck. Wer die Kurve selbst will, um irgendwas damit zu
 * modulieren, bekommt sie hier: gleichmäßig abgetastet, ohne Notenraster, ohne
 * Rundung auf 7 Bit.
 *
 * Alles läuft über dieselbe kleine Tabellenform:
 *
 *   { name, rate, seconds, columns: [{key, dec}], rows: [[…], …] }
 *
 * `dec` ist die Nachkommastellenzahl fürs CSV; `dec: null` heißt Text. `toCsv`
 * und `toJson` machen daraus die Datei, die UI nur noch den Blob.
 *
 * Reine Zahlenverarbeitung, kein DOM: Kandidat für den Swift-Port.
 */

import { centsSpan, normPos } from './pitch.js'

/**
 * Unstimmhafte Frames stehen auf 0 — in allen Spalten, nicht als Lücke.
 *
 * Eine Modulationsquelle darf keine Löcher haben; wer sie doch braucht, filtert
 * über `voiced`. Das ist die einzige Spalte, die zwischen „gemessen“ und „nur
 * Füllung“ unterscheidet.
 */
export const MELODY_COLUMNS = [
  { key: 't_s', dec: 4 }, // Sekunden ab Aufnahmebeginn
  { key: 'hz', dec: 3 }, // nach den Reglern (Lage, Vibrato, Halbtöne)
  { key: 'hz_raw', dec: 3 }, // wie erkannt, vor den Reglern
  { key: 'midi', dec: 4 }, // gebrochene MIDI-Nummer zu hz
  { key: 'amp', dec: 5 }, // 0..1, aufs Maximum der Aufnahme bezogen
  { key: 'norm', dec: 5 }, // Lage im Umfang dieser Aufnahme, 0..1
  { key: 'voiced', dec: 0 },
]

/** Die drei Bänder aus analyseBeat, schon aufs Gesamtmaximum normiert. */
export const BEAT_COLUMNS = [
  { key: 't_s', dec: 4 },
  { key: 'low', dec: 5 },
  { key: 'mid', dec: 5 },
  { key: 'high', dec: 5 },
  { key: 'total', dec: 5 },
]

export const HIT_COLUMNS = [
  { key: 't_s', dec: 4 },
  { key: 'type', dec: null },
  { key: 'vel', dec: 0 },
]

/**
 * Wert an einer gebrochenen Frameposition.
 *
 * Zwischen zwei stimmhaften Nachbarn wird linear interpoliert, an der Kante
 * einer Phrase dagegen nicht: eine Null gehört nicht halb in den Ton
 * hineingemittelt. Dort gilt der nähere Nachbar.
 */
function sampleAt(a, pos) {
  const i = Math.floor(pos)
  if (i < 0) return a[0] ?? 0
  if (i >= a.length - 1) return a[a.length - 1] ?? 0
  const f = pos - i
  const v0 = a[i]
  const v1 = a[i + 1]
  if (v0 > 0 && v1 > 0) return v0 + (v1 - v0) * f
  return f < 0.5 ? v0 : v1
}

/**
 * Zeitraster festlegen.
 * @param {number} srcRate  Rate der Analyse
 * @param {number} n        Anzahl Analyseframes
 * @param {number} rate     gewünschte Zeilen pro Sekunde; 0 = Analyse-Raster
 * @returns {{rate:number, count:number, seconds:number, at:(k:number)=>number}}
 *          `at` liefert die Frameposition zur Zeile k.
 */
function gridFor(srcRate, n, rate) {
  const seconds = n > 0 ? (n - 1) / srcRate : 0
  if (!rate || rate === srcRate) {
    return { rate: srcRate, count: n, seconds, at: (k) => k }
  }
  return {
    rate,
    count: Math.max(0, Math.floor(seconds * rate) + 1),
    seconds,
    at: (k) => (k / rate) * srcRate,
  }
}

/**
 * Tonhöhe und Lautstärke als Tabelle.
 *
 * @param {object} melody         Ergebnis von analyseMelody
 * @param {Float32Array} shaped   Ergebnis von shapedCurve
 * @param {number} o.rate         Zeilen pro Sekunde, 0 = Analyse-Raster
 * @returns {{name, rate, seconds, columns, rows}}
 */
export function melodyCurve(melody, shaped, { rate = 0 } = {}) {
  const n = melody.pitch.length
  const g = gridFor(melody.frameRate, n, rate)
  const span = centsSpan(shaped)
  const rows = []
  for (let k = 0; k < g.count; k++) {
    const pos = g.at(k)
    const hz = sampleAt(shaped, pos)
    const raw = sampleAt(melody.pitch, pos)
    const on = hz > 0 && raw > 0
    rows.push([
      k / g.rate,
      on ? hz : 0,
      on ? raw : 0,
      on ? 69 + 12 * Math.log2(hz / 440) : 0,
      on ? sampleAt(melody.amp, pos) : 0,
      on ? normPos(hz, span) : 0,
      on ? 1 : 0,
    ])
  }
  return { name: 'melodie', rate: g.rate, seconds: g.seconds, columns: MELODY_COLUMNS, rows }
}

/**
 * Die drei Bandhüllkurven des Beats als Tabelle.
 * @param {object} beat   Ergebnis von analyseBeat
 */
export function beatCurve(beat, { rate = 0 } = {}) {
  const srcRate = beat.sr / beat.frameH
  const g = gridFor(srcRate, beat.tot.length, rate)
  const rows = []
  for (let k = 0; k < g.count; k++) {
    const pos = g.at(k)
    rows.push([
      k / g.rate,
      sampleAt(beat.env[0], pos),
      sampleAt(beat.env[1], pos),
      sampleAt(beat.env[2], pos),
      sampleAt(beat.tot, pos),
    ])
  }
  return { name: 'beat', rate: g.rate, seconds: g.seconds, columns: BEAT_COLUMNS, rows }
}

/** Die Schläge als Tabelle — kein Raster, eine Zeile pro Einsatz. */
export function hitTable(hits) {
  const rows = hits.map((h) => [h.t, h.type, h.vel])
  const seconds = hits.length ? hits[hits.length - 1].t : 0
  return { name: 'schlaege', rate: 0, seconds, columns: HIT_COLUMNS, rows }
}

const csvCell = (v, dec) => {
  if (dec === null) return /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)
  return Number.isFinite(v) ? v.toFixed(dec) : '0'
}

/**
 * Tabelle als CSV, Kopfzeile mit den Spaltennamen.
 * Zeilenende CRLF nach RFC 4180 — Tabellenkalkulationen sind da wählerischer
 * als Skripte.
 */
export function toCsv(table) {
  const head = table.columns.map((c) => c.key).join(',')
  const body = table.rows.map((r) => r.map((v, i) => csvCell(v, table.columns[i].dec)).join(','))
  return [head, ...body].join('\r\n') + '\r\n'
}

/**
 * Eine oder mehrere Tabellen als JSON.
 *
 * Die Werte stehen spaltenweise (`lanes`), nicht zeilenweise: eine
 * Automationskurve ist genau das — ein Array plus die Rate, mit der es
 * abgetastet wurde. Die Zeitachse steckt in `rate` und muss nicht mitgelesen
 * werden. Tabellen ohne Raster (die Schläge) tragen `rate: 0`; dort ist `t_s`
 * die einzige Zeitangabe.
 *
 * @param {Array} tables  Ergebnisse von melodyCurve / beatCurve / hitTable
 * @param {object} meta   frei, landet unter `source`
 */
export function toJson(tables, meta = {}) {
  const out = { format: 'mundwerk-curve', version: 1, source: meta, curves: {} }
  tables.forEach((t) => {
    const lanes = {}
    t.columns.forEach((c, i) => {
      lanes[c.key] = t.rows.map((r) => (c.dec === null ? r[i] : round(r[i], c.dec)))
    })
    out.curves[t.name] = { rate: t.rate, seconds: round(t.seconds, 4), count: t.rows.length, lanes }
  })
  return JSON.stringify(out, null, 2)
}

/** Kürzen statt auf voller Float-Breite — sonst wird die Datei doppelt so groß. */
function round(v, dec) {
  if (!Number.isFinite(v)) return 0
  const f = Math.pow(10, dec)
  return Math.round(v * f) / f
}
