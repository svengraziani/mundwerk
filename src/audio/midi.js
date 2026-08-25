/**
 * MIDI-Export, Format 1, 480 PPQ.
 *
 * Der Kern ist nicht die Notenliste, sondern das, was zwischen den Noten
 * passiert: Pitch Bend alle 16 ms trägt Glissandi und Vibrato, Channel
 * Pressure alle 40 ms den Lautstärkeverlauf. Ohne beides wäre der Export eine
 * Karikatur des Gepfiffenen.
 *
 * Reine Bytes, kein DOM: liefert ein Uint8Array, das Verpacken in einen Blob
 * macht die UI.
 */

import { GM_DRUMS } from '../data/instruments.js'

export const PPQ = 480

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
 *        p ist die Priorität bei gleicher Zeit: Note-Off (1) vor Note-On (2)
 *        vor Controllern (3), damit sich anliegende Noten nicht abwürgen.
 */
export function trackChunk(events) {
  events.sort((a, b) => a.t - b.t || (a.p || 1) - (b.p || 1))
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
 * @param {object}  o.melody      Ergebnis von analyseMelody (oder null)
 * @param {Array}   o.notes       Ergebnis von segmentNotes
 * @param {Float32Array} o.shaped Frequenzkurve aus shapedCurve
 * @param {object}  o.instrument  Eintrag aus INSTRUMENTS
 * @param {object}  o.beat        Ergebnis von analyseBeat (oder null)
 * @param {Array}   o.hits        gerasterte Schläge
 * @param {number}  o.bendRange   Halbtöne, wird als RPN 0 mitgeschickt
 * @returns {Uint8Array}
 */
export function buildMidi({ melody, notes, shaped, instrument, beat, hits = [], bendRange = 12 }) {
  const bpm = beat && beat.bpm ? beat.bpm : 120
  const tps = (PPQ * bpm) / 60 // Ticks pro Sekunde
  const tracks = []

  // Tempo-Track
  const uspq = Math.round(60000000 / bpm)
  tracks.push(
    trackChunk([
      { t: 0, d: [0xff, 0x51, 0x03, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255], p: 0 },
      { t: 0, d: [0xff, 0x03, ...vlq(8), ...str('Mundwerk')], p: 0 },
    ]),
  )

  // Melodie-Track, Kanal 1
  if (melody && notes && notes.length) {
    const fr = melody.frameRate
    const ev = []
    ev.push({ t: 0, d: [0xff, 0x03, ...vlq(instrument.name.length), ...str(instrument.name)], p: 0 })
    // Bend-Umfang per RPN 0 setzen — sonst interpretiert jedes Instrument anders
    ev.push(
      { t: 0, d: [0xb0, 101, 0], p: 0 },
      { t: 0, d: [0xb0, 100, 0], p: 0 },
      { t: 0, d: [0xb0, 6, bendRange], p: 0 },
      { t: 0, d: [0xb0, 38, 0], p: 0 },
    )
    ev.push({ t: 0, d: [0xc0, instrument.gm - 1], p: 0 })

    const bendStep = Math.max(1, Math.round(fr * 0.016)) // ~16 ms
    const presStep = Math.max(1, Math.round(fr * 0.04)) // ~40 ms

    notes.forEach((nt) => {
      const t0 = (nt.start / fr) * tps
      const t1 = (nt.end / fr) * tps
      ev.push({ t: t0, d: [0x90, nt.midi, nt.vel], p: 2 })
      for (let i = nt.start; i < nt.end; i++) {
        const t = (i / fr) * tps
        if ((i - nt.start) % bendStep === 0) {
          const c = 1200 * Math.log2(shaped[i] / 440) - nt.rootCents
          let val = Math.round(8192 + (c / (bendRange * 100)) * 8192)
          val = Math.max(0, Math.min(16383, val))
          ev.push({ t, d: [0xe0, val & 0x7f, (val >> 7) & 0x7f], p: 3 })
        }
        if ((i - nt.start) % presStep === 0) {
          const p = Math.max(0, Math.min(127, Math.round(melody.amp[i] * 127)))
          ev.push({ t, d: [0xd0, p], p: 3 })
          // CC11 zusätzlich, weil viele DAWs Channel Pressure ignorieren
          ev.push({ t, d: [0xb0, 11, p], p: 3 })
        }
      }
      ev.push({ t: t1, d: [0x80, nt.midi, 0], p: 1 })
    })

    // Bend am Schluss zurück auf die Mitte
    const endT = (melody.pitch.length / fr) * tps + 1
    ev.push({ t: endT, d: [0xe0, 0, 64], p: 4 })
    tracks.push(trackChunk(ev))
  }

  // Drum-Track, Kanal 10
  if (beat && hits.length) {
    const ev = [{ t: 0, d: [0xff, 0x03, ...vlq(5), ...str('Drums')], p: 0 }]
    hits.forEach((h) => {
      const t = h.t * tps
      const n = GM_DRUMS[h.type] || GM_DRUMS.snare
      ev.push({ t, d: [0x99, n, h.vel], p: 2 })
      ev.push({ t: t + PPQ / 8, d: [0x89, n, 0], p: 1 })
    })
    tracks.push(trackChunk(ev))
  }

  const head = [...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ)]
  const all = [...head]
  tracks.forEach((t) => all.push(...t))
  return new Uint8Array(all)
}
