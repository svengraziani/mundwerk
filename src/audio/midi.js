/**
 * MIDI-Export, Format 1, 480 PPQ — klassisch und als MPE.
 *
 * Der Kern ist nicht die Notenliste, sondern das, was zwischen den Noten
 * passiert: Pitch Bend alle 16 ms trägt Glissandi und Vibrato, Druck alle
 * 40 ms den Lautstärkeverlauf. Ohne beides wäre der Export eine Karikatur des
 * Gepfiffenen.
 *
 * `buildMidi` schreibt das klassische Format: alles auf Kanal 1, ein Bend, ein
 * Druckverlauf. `buildMpe` schreibt dieselbe Musik als MPE — jede Note bekommt
 * einen eigenen Kanal und damit ihre eigenen Ausdrucksdimensionen. Beide teilen
 * sich denselben Rechenweg, siehe `build`.
 *
 * Reine Bytes, kein DOM: liefert ein Uint8Array, das Verpacken in einen Blob
 * macht die UI.
 */

import { GM_DRUMS } from '../data/instruments.js'
import { centsSpan, normPos, toCents } from './pitch.js'

export const PPQ = 480

/** MPE-Vorgabe für Member-Kanäle. Deshalb der abweichende Vorgabewert. */
export const MPE_BEND_RANGE = 48

/** Untere Zone ohne Drums: Master Kanal 1, Member 2–16. */
export const MPE_MEMBERS = 15

/**
 * Untere Zone mit Drums: Master Kanal 1, Member 2–9.
 *
 * Eine volle Zone würde Kanal 10 mitverschlucken, und dort liegt die
 * GM-Percussion. Acht Stimmen reichen dafür mit weitem Abstand — die
 * Melodiespur ist einstimmig, die Kanäle rotieren nur, damit der Bend der
 * ausklingenden Note nicht in die nächste hineinregiert.
 */
export const MPE_MEMBERS_WITH_DRUMS = 8

/** Wie viele Member-Kanäle die Zone bekommt. */
export const mpeMembers = (hasDrums) => (hasDrums ? MPE_MEMBERS_WITH_DRUMS : MPE_MEMBERS)

/**
 * Priorität bei gleicher Zeit. Note-Off vor der Vorbereitung der nächsten Note,
 * die wiederum vor deren Note-On — MPE verlangt, dass Bend, Druck und Timbre
 * eines Kanals stehen, *bevor* die Note auf ihm anfängt.
 */
const P = { meta: 0, off: 1, init: 2, on: 3, ctrl: 4, end: 5 }

/** Variable-Length Quantity, wie im SMF-Format. */
export function vlq(n) {
  const b = [n & 0x7f]
  n >>= 7
  while (n > 0) {
    b.unshift((n & 0x7f) | 0x80)
    n >>= 7
  }
  return b
}

export const str = (s) => [...s].map((c) => c.charCodeAt(0))
export const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
export const u16 = (n) => [(n >> 8) & 255, n & 255]

/**
 * Events nach Zeit sortieren, Delta-Zeiten bilden, als MTrk verpacken.
 * @param {Array<{t:number, d:number[], p?:number}>} events
 *        p ist die Priorität bei gleicher Zeit, siehe P. Gleiche Zeit *und*
 *        gleiche Priorität behalten ihre Reihenfolge — Array.sort ist stabil,
 *        und darauf verlassen sich die RPN-Folgen weiter unten.
 */
export function trackChunk(events) {
  events.sort((a, b) => a.t - b.t || (a.p ?? 1) - (b.p ?? 1))
  const out = []
  let last = 0
  events.forEach((e) => {
    out.push(...vlq(Math.max(0, Math.round(e.t) - last)), ...e.d)
    last = Math.round(e.t)
  })
  out.push(...vlq(0), 0xff, 0x2f, 0x00)
  return [...str('MTrk'), ...u32(out.length), ...out]
}

/**
 * Registered Parameter Number setzen, alles auf Tick 0.
 * @param {number} ch     Kanal, 0-basiert
 * @param {number} param  Parameternummer (0 = Bend-Umfang, 6 = MPE-Zone)
 * @param {number} value  Data Entry MSB
 * @param {boolean} lsb   Data Entry LSB mitschicken. Bei RPN 6 nicht: die
 *                        MPE-Spezifikation kennt dort kein LSB.
 */
function rpn(ch, param, value, lsb = true) {
  const cc = 0xb0 | ch
  const ev = [
    { t: 0, d: [cc, 101, (param >> 7) & 0x7f], p: P.meta },
    { t: 0, d: [cc, 100, param & 0x7f], p: P.meta },
    { t: 0, d: [cc, 6, Math.max(0, Math.min(127, value)) & 0x7f], p: P.meta },
  ]
  if (lsb) ev.push({ t: 0, d: [cc, 38, 0], p: P.meta })
  return ev
}

/** 14-Bit-Bendwert für eine Frequenz relativ zum Grundton der Note. */
function bendValue(hz, rootCents, range) {
  if (!(hz > 0)) return 8192
  const c = toCents(hz) - rootCents
  return Math.max(0, Math.min(16383, Math.round(8192 + (c / (range * 100)) * 8192)))
}

const bend = (ch, val) => [0xe0 | ch, val & 0x7f, (val >> 7) & 0x7f]
const cc7 = (v) => Math.max(0, Math.min(127, Math.round(v * 127)))

/**
 * Die Melodiespur als Eventliste.
 *
 * Im klassischen Fall liegt alles auf Kanal 1. Im MPE-Fall wandert jede Note
 * reihum auf einen eigenen Member-Kanal: dann ist Channel Pressure kein
 * Notbehelf mehr für „irgendwas mit Lautstärke“, sondern buchstäblich der
 * Druck dieser einen Stimme, und der Bend biegt nur sie.
 */
function melodyEvents({ melody, notes, shaped, instrument, bendRange, tps, mpe, members }) {
  const fr = melody.frameRate
  const ev = []
  const name = mpe ? instrument.name + ' (MPE)' : instrument.name
  ev.push({ t: 0, d: [0xff, 0x03, ...vlq(name.length), ...str(name)], p: P.meta })

  if (mpe) {
    // MPE Configuration Message: untere Zone, Kanal 1 als Master.
    ev.push(...rpn(0, 6, members, false))
    // Bend-Umfang auf *jedem* Member-Kanal. Laut Spezifikation genügt einer,
    // weil er für die ganze Zone gilt — aber genau dieses „genügt eigentlich“
    // ist der Stolperstein, an dem Importe still auf ±2 stehenbleiben.
    for (let c = 1; c <= members; c++) ev.push(...rpn(c, 0, bendRange))
  } else {
    // Bend-Umfang per RPN 0 setzen — sonst interpretiert jedes Instrument anders
    ev.push(...rpn(0, 0, bendRange))
  }
  // Program Change auf dem Master; in MPE gilt er für die ganze Zone.
  ev.push({ t: 0, d: [0xc0, instrument.gm - 1], p: P.meta })

  const bendStep = Math.max(1, Math.round(fr * 0.016)) // ~16 ms
  const presStep = Math.max(1, Math.round(fr * 0.04)) // ~40 ms
  const span = centsSpan(shaped)
  let used = 0

  notes.forEach((nt, idx) => {
    const ch = mpe ? 1 + (idx % members) : 0
    used = Math.max(used, mpe ? ch : 0)
    const t0 = (nt.start / fr) * tps
    const t1 = (nt.end / fr) * tps
    const timbre = (i) => cc7(normPos(shaped[i], span))
    const press = (i) => cc7(melody.amp[i])

    if (mpe) {
      // Ausdruck vor dem Note-On, sonst springt die Stimme im Zielinstrument
      // vom letzten Wert des Kanals auf den neuen.
      ev.push({ t: t0, d: bend(ch, bendValue(shaped[nt.start], nt.rootCents, bendRange)), p: P.init })
      ev.push({ t: t0, d: [0xb0 | ch, 74, timbre(nt.start)], p: P.init })
      ev.push({ t: t0, d: [0xd0 | ch, press(nt.start)], p: P.init })
    }

    ev.push({ t: t0, d: [0x90 | ch, nt.midi, nt.vel], p: P.on })
    for (let i = nt.start; i < nt.end; i++) {
      const t = (i / fr) * tps
      if ((i - nt.start) % bendStep === 0) {
        ev.push({ t, d: bend(ch, bendValue(shaped[i], nt.rootCents, bendRange)), p: P.ctrl })
      }
      if ((i - nt.start) % presStep === 0) {
        const p = press(i)
        ev.push({ t, d: [0xd0 | ch, p], p: P.ctrl })
        // CC11 zusätzlich, weil viele DAWs Channel Pressure ignorieren
        ev.push({ t, d: [0xb0 | ch, 11, p], p: P.ctrl })
        // Y-Achse: wie hoch im Umfang dieser Aufnahme gepfiffen wurde. Die
        // dritte MPE-Dimension wird nicht erfunden, sie ist gemessen.
        if (mpe) ev.push({ t, d: [0xb0 | ch, 74, timbre(i)], p: P.ctrl })
      }
    }
    ev.push({ t: t1, d: [0x80 | ch, nt.midi, 0], p: P.off })
  })

  // Zum Schluss jeden benutzten Kanal neutral hinterlassen.
  const endT = (melody.pitch.length / fr) * tps + 1
  for (let ch = mpe ? 1 : 0; ch <= used; ch++) {
    ev.push({ t: endT, d: bend(ch, 8192), p: P.end })
    if (mpe) ev.push({ t: endT, d: [0xd0 | ch, 0], p: P.end })
  }
  return ev
}

/** Drumspur, Kanal 10. In beiden Formaten identisch. */
function drumEvents(hits, tps) {
  const ev = [{ t: 0, d: [0xff, 0x03, ...vlq(5), ...str('Drums')], p: P.meta }]
  hits.forEach((h) => {
    const t = h.t * tps
    const n = GM_DRUMS[h.type] || GM_DRUMS.snare
    ev.push({ t, d: [0x99, n, h.vel], p: P.on })
    ev.push({ t: t + PPQ / 8, d: [0x89, n, 0], p: P.off })
  })
  return ev
}

/**
 * @param {object}  o.melody      Ergebnis von analyseMelody (oder null)
 * @param {Array}   o.notes       Ergebnis von segmentNotes
 * @param {Float32Array} o.shaped Frequenzkurve aus shapedCurve
 * @param {object}  o.instrument  Eintrag aus INSTRUMENTS
 * @param {object}  o.beat        Ergebnis von analyseBeat (oder null)
 * @param {Array}   o.hits        gerasterte Schläge
 * @param {number}  o.bendRange   Halbtöne, wird als RPN 0 mitgeschickt
 * @param {boolean} o.mpe         MPE statt klassischem MIDI
 * @returns {Uint8Array}
 */
function build({ melody, notes, shaped, instrument, beat, hits = [], bendRange, mpe }) {
  const bpm = beat && beat.bpm ? beat.bpm : 120
  const tps = (PPQ * bpm) / 60 // Ticks pro Sekunde
  const drums = !!(beat && hits.length)
  const tracks = []

  // Tempo-Track
  const uspq = Math.round(60000000 / bpm)
  tracks.push(
    trackChunk([
      { t: 0, d: [0xff, 0x51, 0x03, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255], p: P.meta },
      { t: 0, d: [0xff, 0x03, ...vlq(8), ...str('Mundwerk')], p: P.meta },
    ]),
  )

  if (melody && notes && notes.length) {
    tracks.push(
      trackChunk(
        melodyEvents({
          melody, notes, shaped, instrument, bendRange, tps, mpe,
          members: mpeMembers(drums),
        }),
      ),
    )
  }
  if (drums) tracks.push(trackChunk(drumEvents(hits, tps)))

  const head = [...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ)]
  const all = [...head]
  tracks.forEach((t) => all.push(...t))
  return new Uint8Array(all)
}

/** Klassisches MIDI: alles auf Kanal 1, Drums auf Kanal 10. */
export function buildMidi(o) {
  return build({ ...o, mpe: false, bendRange: o.bendRange ?? 12 })
}

/**
 * MPE: untere Zone, jede Note auf ihrem eigenen Member-Kanal.
 *
 * `notes` sollte mit demselben `bendRange` segmentiert worden sein — bei den
 * ±48 Halbtönen der MPE-Vorgabe passt jede gepfiffene Phrase in eine einzige
 * Note, und genau dafür ist das Format da.
 */
export function buildMpe(o) {
  return build({ ...o, mpe: true, bendRange: o.bendRange ?? MPE_BEND_RANGE })
}
