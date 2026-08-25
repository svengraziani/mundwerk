/**
 * Klangdefinitionen. Reine Daten, keine WebAudio-Objekte.
 *
 * part   Teiltöne als [Verhältnis zur Grundfrequenz, Pegel]
 * noise  Anteil Anblasgeräusch, nq dessen Bandpass-Güte
 * drift  Verstimmung der oberen Teiltöne gegeneinander (lebendiger Klang)
 * gm     General-MIDI-Programm, 1-basiert wie in der GM-Tabelle
 */
export const INSTRUMENTS = [
  { id: 'bone', name: 'Knochenflöte', desc: 'roh, luftig, wenig Obertöne', part: [[1, 1], [2, .10], [3, .05], [4, .02]], noise: .55, nq: 2.4, drift: .4, gm: 75 },
  { id: 'pan', name: 'Panflöte', desc: 'hohl, weiches Anblasgeräusch', part: [[1, 1], [2, .18], [3, .07], [4, .03], [5, .015]], noise: .42, nq: 3.5, drift: .25, gm: 75 },
  { id: 'bansuri', name: 'Bansuri', desc: 'warm, singend, Bambus', part: [[1, 1], [2, .34], [3, .14], [4, .06], [5, .03], [6, .015]], noise: .24, nq: 5, drift: .2, gm: 73 },
  { id: 'ocarina', name: 'Okarina', desc: 'fast reiner Ton, tönern', part: [[1, 1], [2, .06], [3, .02]], noise: .18, nq: 3, drift: .15, gm: 79 },
  { id: 'clarinet', name: 'Klarinette', desc: 'ungerade Teiltöne, hohl', part: [[1, 1], [2, .03], [3, .52], [4, .02], [5, .30], [6, .02], [7, .16], [9, .07]], noise: .06, nq: 6, drift: .1, gm: 71 },
  { id: 'sax', name: 'Saxofon', desc: 'voll, blechig, rauchig', part: [[1, 1], [2, .62], [3, .46], [4, .30], [5, .22], [6, .15], [7, .10], [8, .07], [9, .05]], noise: .12, nq: 4, drift: .12, gm: 65 },
  { id: 'trumpet', name: 'Trompete', desc: 'hell, strahlend', part: [[1, .65], [2, 1], [3, .82], [4, .60], [5, .44], [6, .30], [7, .19], [8, .12], [9, .07]], noise: .05, nq: 5, drift: .08, gm: 56 },
  { id: 'cello', name: 'Cello', desc: 'gestrichen, dunkel, dicht', part: [[1, 1], [2, .72], [3, .52], [4, .40], [5, .30], [6, .24], [7, .17], [8, .12], [9, .09], [10, .06]], noise: .07, nq: 3, drift: .18, gm: 42 },
  { id: 'organ', name: 'Orgel', desc: 'Quinten und Oktaven', part: [[1, 1], [2, .55], [3, .70], [4, .34], [6, .40], [8, .20]], noise: .02, nq: 4, drift: .05, gm: 19 },
  { id: 'voice', name: 'Chorstimme', desc: 'Formanten, gehaucht', part: [[1, 1], [2, .55], [3, .38], [4, .52], [5, .22], [6, .12], [7, .06]], noise: .16, nq: 2, drift: .3, gm: 52 },
  { id: 'bell', name: 'Glocke', desc: 'unharmonisch, metallisch', part: [[1, 1], [2.76, .52], [5.40, .30], [8.93, .16], [13.3, .08]], noise: .03, nq: 8, drift: .05, gm: 14 },
  { id: 'lead', name: 'Synth-Lead', desc: 'Sägezahn, schneidend', part: [[1, 1], [2, .50], [3, .33], [4, .25], [5, .20], [6, .16], [7, .14], [8, .12], [9, .11]], noise: 0, nq: 4, drift: .02, gm: 81 },
]

/**
 * Drumkits.
 * kick.f0/f1  Start- und Zielfrequenz des Pitch-Drops, p dessen Dauer
 * verb        Anteil des Faltungshalls
 */
export const KITS = [
  {
    id: 'dry', name: 'Trocken', desc: 'kurz, direkt, kein Nachhall',
    kick: { f0: 120, f1: 46, p: .055, d: .34, click: .5 },
    snare: { tone: .5, dec: .13, hp: 1400 }, hat: { hp: 8000, d: .035, od: .22 }, verb: .06,
  },
  {
    id: 'room', name: 'Raum', desc: 'natürlich, etwas Luft',
    kick: { f0: 135, f1: 48, p: .06, d: .42, click: .4 },
    snare: { tone: .55, dec: .17, hp: 1200 }, hat: { hp: 7200, d: .045, od: .28 }, verb: .22,
  },
  {
    id: '808', name: '808', desc: 'lange Kick, elektronisch',
    kick: { f0: 100, f1: 38, p: .09, d: .95, click: .25 },
    snare: { tone: .35, dec: .12, hp: 1800 }, hat: { hp: 9000, d: .03, od: .18 }, verb: .08,
  },
  {
    id: 'frame', name: 'Rahmentrommel', desc: 'holzig, archaisch',
    kick: { f0: 165, f1: 72, p: .05, d: .30, click: .65 },
    snare: { tone: .72, dec: .10, hp: 900 }, hat: { hp: 6000, d: .05, od: .30 }, verb: .30,
  },
]

/** General-MIDI-Percussion, Kanal 10. */
export const GM_DRUMS = { kick: 36, snare: 38, hat: 42, openhat: 46 }

export const findInstrument = (id) => INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0]
export const findKit = (id) => KITS.find((k) => k.id === id) ?? KITS[0]
