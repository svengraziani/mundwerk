/**
 * Tonhöhenerkennung für Pfeifen und Gesang.
 *
 * NSDF / McLeod Pitch Method pro Frame, danach fünf Aufräumstufen
 * (Median, Oktave, Ausreißer, Lücken, Kurzläufer) und daraus die
 * Notensegmentierung.
 *
 * Welcher Frequenzbereich gesucht wird, steht im Profil (PROFILES) und nicht
 * mehr fest im Code — gepfiffen wird oberhalb von 380 Hz, gesungen zwei
 * Oktaven darunter, und mit einem einzigen Bereich für beides wäre keiner der
 * beiden gut bedient.
 *
 * Keine DOM- und keine WebAudio-Abhängigkeit: rein Float32Array + Samplerate
 * rein, Zahlen raus. Diese Datei ist der erste Kandidat für den Swift-Port.
 */

export const HOP = 256

/**
 * Analyseprofile.
 *
 * `win` zählt Samples *der Analyserate*, nicht der Quelle: wo `rate` gesetzt
 * ist, wird vor der Erkennung dezimiert (siehe `decimate`). Ohne das kostet
 * der tiefe Suchbereich des Gesangsprofils rund das Neunfache eines
 * Pfeifframes — bei einer Minute Aufnahme ist das der Unterschied zwischen
 * „kurz warten“ und „Tab eingefroren“.
 *
 * - `fmin`/`fmax`  Suchbereich in Hz
 * - `win`          Framelänge in Samples der Analyserate
 * - `rate`         Zielrate der Analyse in Hz, 0 = mit der Quellrate rechnen
 * - `clarityMin`   darunter gilt der Frame als tonlos
 * - `clarityKeep`  darunter wird der Frame nachträglich verworfen
 * - `peakRatio`    wie nah ein NSDF-Peak am Maximum liegen muss
 */
export const PROFILES = {
  // Pfeifen liegt hoch und ist fast ein Sinus: schmales Fenster, harte Schwellen.
  whistle: { id: 'whistle', fmin: 380, fmax: 4200, win: 1024, rate: 0, clarityMin: 0.55, clarityKeep: 0.75, peakRatio: 0.88 },
  // Gesang: von der tiefen Männerstimme (E2) bis in die Sopranlage. Ein Vokal
  // bringt zwanzig Teiltöne mit, die NSDF wird dadurch zackiger — deshalb
  // weichere Klarheitsschwellen, aber ein *härteres* peakRatio: bei 0.88
  // rutscht die Erkennung auf einem gesungenen „a“ regelmäßig auf den dritten
  // Teilton, weil der erste Formant genau dort liegt (siehe sing-lala.wav).
  voice: { id: 'voice', fmin: 75, fmax: 1200, win: 512, rate: 12000, clarityMin: 0.5, clarityKeep: 0.68, peakRatio: 0.94 },
}

export const DEFAULT_PROFILE = 'whistle'

/** Profil nachschlagen. Unbekannte Namen fallen aufs Pfeifprofil zurück. */
export function profileOf(p) {
  if (p && typeof p === 'object') return p
  return PROFILES[p] || PROFILES[DEFAULT_PROFILE]
}

export const WIN = PROFILES.whistle.win
export const FMIN = PROFILES.whistle.fmin
export const FMAX = PROFILES.whistle.fmax

const RMS_GATE = 0.006

/**
 * NSDF für einen Frame.
 *
 * @param {Float32Array} buf   gesamtes Signal
 * @param {number} off         Startindex des Frames
 * @param {number} size        Framelänge
 * @param {number} sr          Samplerate
 * @param {string|object} prof Profilname oder Profil; Vorgabe: Pfeifen
 * @returns {{hz:number, clarity:number, rms:number}} hz === 0 heißt: keine Tonhöhe
 */
export function detect(buf, off, size, sr, prof = DEFAULT_PROFILE) {
  const p = profileOf(prof)
  if (off < 0 || off + size > buf.length) return { hz: 0, clarity: 0, rms: 0 }
  let rms = 0
  for (let i = 0; i < size; i++) {
    const v = buf[off + i]
    rms += v * v
  }
  rms = Math.sqrt(rms / size)
  if (rms < RMS_GATE) return { hz: 0, clarity: 0, rms }

  const tMin = Math.max(2, Math.floor(sr / p.fmax))
  const tMax = Math.min(size - 2, Math.floor(sr / p.fmin))
  if (tMax <= tMin) return { hz: 0, clarity: 0, rms }
  const nsdf = new Float32Array(tMax + 1)
  for (let t = tMin; t <= tMax; t++) {
    let ac = 0
    let m = 0
    const lim = size - t
    for (let i = 0; i < lim; i++) {
      const a = buf[off + i]
      const b = buf[off + i + t]
      ac += a * b
      m += a * a + b * b
    }
    nsdf[t] = m > 0 ? (2 * ac) / m : 0
  }

  let best = 0
  for (let t = tMin; t <= tMax; t++) if (nsdf[t] > best) best = nsdf[t]
  if (best < p.clarityMin) return { hz: 0, clarity: best, rms }

  // Erster Peak oberhalb der Schwelle, nicht der höchste: sonst landet man
  // regelmäßig eine Oktave zu tief.
  const thr = best * p.peakRatio
  let pick = -1
  for (let t = tMin + 1; t < tMax; t++) {
    if (nsdf[t] > nsdf[t - 1] && nsdf[t] >= nsdf[t + 1] && nsdf[t] > thr) {
      pick = t
      break
    }
  }
  if (pick < 0) return { hz: 0, clarity: best, rms }

  const y0 = nsdf[pick - 1]
  const y1 = nsdf[pick]
  const y2 = nsdf[pick + 1]
  const den = 2 * (2 * y1 - y0 - y2)
  const hz = sr / (pick + (den !== 0 ? (y2 - y0) / den : 0))
  if (hz < p.fmin || hz > p.fmax) return { hz: 0, clarity: y1, rms }
  return { hz, clarity: y1, rms }
}

/* ── Dezimierung ────────────────────────────────────────── */

/** Ein RBJ-Tiefpass, Direct Form I. Nicht in-place. */
function lowpass(x, sr, freq, q = 0.7071) {
  const w0 = (2 * Math.PI * freq) / sr
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  const b0 = (1 - cos) / 2 / a0
  const b1 = (1 - cos) / a0
  const b2 = b0
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  const out = new Float32Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    out[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return out
}

/**
 * Um `factor` unterabtasten, mit Antialiasing davor.
 *
 * Zwei Tiefpässe hintereinander (24 dB/Oktave) bei 40 % der neuen Rate: ein
 * einzelner Biquad lässt oberhalb der neuen Nyquistfrequenz genug stehen, dass
 * Zischlaute als Brummen zurückfalten und die Erkennung durcheinanderbringen.
 *
 * @returns {{buf:Float32Array, sr:number}}
 */
export function decimate(buf, sr, factor) {
  if (factor <= 1) return { buf, sr }
  const newSr = sr / factor
  const filtered = lowpass(lowpass(buf, sr, newSr * 0.4), sr, newSr * 0.4)
  const n = Math.floor(buf.length / factor)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = filtered[i * factor]
  return { buf: out, sr: newSr }
}

/** Dezimierungsfaktor für ein Profil bei gegebener Quellrate. */
export function decimFactor(prof, sr) {
  const p = profileOf(prof)
  if (!p.rate) return 1
  return Math.max(1, Math.round(sr / p.rate))
}

/** Medianfilter über die stimmhaften Nachbarn. Arbeitet in-place. */
export function medianFix(a, k) {
  const h = k >> 1
  const out = new Float32Array(a.length)
  const t = []
  for (let i = 0; i < a.length; i++) {
    t.length = 0
    for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < a.length && a[j] > 0) t.push(a[j])
    if (!t.length) {
      out[i] = 0
      continue
    }
    t.sort((x, y) => x - y)
    out[i] = a[i] > 0 ? t[t.length >> 1] : 0
  }
  a.set(out)
}

/**
 * Teiltonfehler gegen den lokalen Median korrigieren.
 *
 * Neben der Oktave (Faktor 2) auch die Quinte darüber (Faktor 3): beim Pfeifen
 * kommt die praktisch nicht vor, bei einer Stimme schon — wenn ein gesungener
 * Ton ausklingt, bleibt oft nur noch ein Teilton stehen, und die Erkennung
 * springt für zwei, drei Frames auf dessen Frequenz.
 *
 * Zwei Durchgänge, weil ein einzelner Ausreißer den Median des Nachbarn
 * mitverschiebt. In-place.
 */
export function octaveFix(a) {
  for (let p = 0; p < 2; p++)
    for (let i = 0; i < a.length; i++) {
      if (!a[i]) continue
      const t = []
      // ±6 Frames, nicht ±4: eine ausklingende Stimme hält sich gern ein
      // halbes Dutzend Frames lang auf einem Teilton. Bei ±4 besteht der
      // Median am Anfang so einer Strecke schon zur Hälfte aus den falschen
      // Werten, und dann korrigiert sie niemand mehr.
      for (let j = i - 6; j <= i + 6; j++) if (j >= 0 && j < a.length && j !== i && a[j] > 0) t.push(a[j])
      if (t.length < 3) continue
      t.sort((x, y) => x - y)
      const r = a[i] / t[t.length >> 1]
      if (r > 1.7 && r < 2.3) a[i] /= 2
      else if (r > 0.42 && r < 0.58) a[i] *= 2
      // Nur nach unten: ein Teilton zieht die Messung hoch, nie herunter. Mit
      // einem Zweig für den Fall „ein Drittel des Medians“ würde ein *guter*
      // Frame neben einer Handvoll schlechter auf deren Teilton hochgezogen —
      // der Fehler frisst sich dann rückwärts durch die Phrase.
      else if (r > 2.7 && r < 3.3) a[i] /= 3
    }
}

/**
 * Frames, die weit neben dem lokalen Median liegen, verwerfen. In-place.
 *
 * Der Rest hinter `octaveFix`: An Ein- und Ausschwingern einer Stimme hängt
 * die Erkennung nicht nur an der Oktave oder der Quinte, sondern an
 * irgendeinem Teilton — beim tiefen „o“ am fünften, am siebten. Für jedes
 * Verhältnis einen eigenen Zweig zu schreiben wäre sinnlos; hier wird deshalb
 * nicht geraten, sondern weggeworfen. Vier Frames weniger am Notenanfang sind
 * ein besserer Handel als vier Frames zweieinhalb Oktaven daneben.
 *
 * Zwei Durchgänge wie bei `octaveFix`, und aus demselben Grund: am Anfang
 * einer solchen Strecke steht die Hälfte der Nachbarschaft selbst noch auf dem
 * Teilton. Erst wenn die hinteren weg sind, fällt der erste auf.
 */
export function dropOutliers(a, maxCents) {
  for (let p = 0; p < 2; p++)
    for (let i = 0; i < a.length; i++) {
      if (!a[i]) continue
      const t = []
      for (let j = i - 6; j <= i + 6; j++) if (j >= 0 && j < a.length && j !== i && a[j] > 0) t.push(a[j])
      if (t.length < 3) continue
      t.sort((x, y) => x - y)
      if (Math.abs(1200 * Math.log2(a[i] / t[t.length >> 1])) > maxCents) a[i] = 0
    }
}

/** Kurze Aussetzer innerhalb einer Phrase linear überbrücken. In-place. */
export function bridgeGaps(a, max) {
  let i = 0
  while (i < a.length) {
    if (!a[i]) {
      let j = i
      while (j < a.length && !a[j]) j++
      const L = j - i
      if (L <= max && i > 0 && j < a.length) {
        const f = a[i - 1]
        const t = a[j]
        for (let k = 0; k < L; k++) a[i + k] = f + ((t - f) * (k + 1)) / (L + 1)
      }
      i = j
    } else i++
  }
}

/** Stimmhafte Schnipsel unter `min` Frames verwerfen — meist Atem oder Klick. */
export function dropRuns(a, min) {
  let i = 0
  while (i < a.length) {
    if (a[i] > 0) {
      let j = i
      while (j < a.length && a[j] > 0) j++
      if (j - i < min) for (let k = i; k < j; k++) a[k] = 0
      i = j
    } else i++
  }
}

/** Gleitender Mittelwert. In-place. Auch von onset.js benutzt. */
export function smooth(a, k) {
  const h = k >> 1
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) {
    let s = 0
    let c = 0
    for (let j = i - h; j <= i + h; j++)
      if (j >= 0 && j < a.length) {
        s += a[j]
        c++
      }
    out[i] = s / c
  }
  a.set(out)
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'H']

export function noteName(hz) {
  if (!hz) return '—'
  const m = Math.round(69 + 12 * Math.log2(hz / 440))
  return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1)
}

/** Cent gegen A440. NaN-frei nur für hz > 0 gedacht. */
export const toCents = (hz) => 1200 * Math.log2(hz / 440)

/**
 * Tiefster und höchster stimmhafter Wert einer Frequenzkurve, in Cent.
 *
 * Grundlage für alles, was „wie hoch im eigenen Umfang“ ausdrücken soll: die
 * Y-Achse im MPE-Export und die Spalte `norm` im Kurven-Export. Bezugsgröße ist
 * bewusst die Aufnahme selbst und nicht FMIN..FMAX — über den festen
 * Pfeifbereich normiert würde eine Terz auf ein Zwanzigstel des Wegs
 * zusammenschrumpfen und wäre als Modulationsquelle wertlos.
 *
 * @param {Float32Array} freq
 * @returns {{lo:number, hi:number}}  lo === hi === 0, wenn nichts stimmhaft war
 */
export function centsSpan(freq) {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < freq.length; i++) {
    if (!(freq[i] > 0)) continue
    const c = toCents(freq[i])
    if (c < lo) lo = c
    if (c > hi) hi = c
  }
  return lo <= hi ? { lo, hi } : { lo: 0, hi: 0 }
}

/**
 * Lage im eigenen Umfang, 0..1.
 * @param {number} hz                 0 → 0
 * @param {{lo:number,hi:number}} span Ergebnis von centsSpan
 * @returns {number}  0.5, wenn die Aufnahme praktisch nur einen Ton enthält
 */
export function normPos(hz, span) {
  if (!(hz > 0)) return 0
  if (span.hi - span.lo < 1) return 0.5
  return Math.max(0, Math.min(1, (toCents(hz) - span.lo) / (span.hi - span.lo)))
}

/**
 * Kompletter Melodie-Durchlauf.
 *
 * Die Frames liegen immer HOP Samples der *Quelle* auseinander, auch wenn für
 * die Erkennung dezimiert wird. Damit bleibt `frameRate` sr/HOP, und alles
 * dahinter — Zeichnung, Kurven-Export, Notenzeiten — rechnet unverändert
 * weiter, egal mit welchem Profil analysiert wurde.
 *
 * @param {Float32Array} buf
 * @param {number} sr
 * @param {string|object} prof  Profilname aus PROFILES; Vorgabe: Pfeifen
 * @returns {{buf, sr, frameRate, profile, pitch: Float32Array, amp: Float32Array, notes: Array}|null}
 *          null, wenn zu wenige stimmhafte Frames zusammenkamen.
 */
export function analyseMelody(buf, sr, prof = DEFAULT_PROFILE) {
  const p = profileOf(prof)
  const frameRate = sr / HOP
  const ana = decimate(buf, sr, decimFactor(p, sr))
  const step = HOP / (sr / ana.sr) // Frameabstand in Samples der Analyserate
  const n = Math.max(0, Math.floor((ana.buf.length - p.win) / step))
  const hz = new Float32Array(n)
  const cl = new Float32Array(n)
  const rm = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const r = detect(ana.buf, Math.round(i * step), p.win, ana.sr, p)
    hz[i] = r.hz
    cl[i] = r.clarity
    rm[i] = r.rms
  }
  for (let i = 0; i < n; i++) if (cl[i] < p.clarityKeep) hz[i] = 0

  medianFix(hz, 5)
  octaveFix(hz)
  // 700 Cent: eine Quinte. Darüber ist es keine Melodie mehr, sondern ein
  // Teilton — kein gepfiffener und kein gesungener Ton bewegt sich innerhalb
  // von fünf Millisekunden so weit.
  dropOutliers(hz, 700)
  bridgeGaps(hz, 4)
  dropRuns(hz, 6)
  medianFix(hz, 3)

  let peak = 0
  for (let i = 0; i < n; i++) if (rm[i] > peak) peak = rm[i]
  const amp = new Float32Array(n)
  if (peak > 0) for (let i = 0; i < n; i++) amp[i] = Math.min(1, rm[i] / peak)
  smooth(amp, 3)
  for (let i = 0; i < n; i++) if (hz[i] === 0) amp[i] = 0

  let voiced = 0
  for (let i = 0; i < n; i++) if (hz[i] > 0) voiced++
  if (voiced < 8) return null

  return { buf, sr, frameRate, profile: p.id, pitch: hz, amp, notes: [], shaped: null }
}

/**
 * Die aufgenommene Kontur in die Zielkontur umrechnen.
 *
 * Trennt langsame Bewegung (die Melodie) von schneller (das Vibrato) über ein
 * 85-ms-Mittel und skaliert nur letztere. `quant` zieht die *Basis* auf
 * Halbtöne, nie die Abweichung darüber — deshalb bleiben Glissandi bei 0 %
 * vollständig erhalten.
 *
 * @param {object} melody   Ergebnis von analyseMelody
 * @param {{semis:number, vib:number, quant:number}} shape  vib/quant als 0..1+
 * @returns {Float32Array}  Frequenz je Frame, 0 wo unstimmhaft
 */
export function shapedCurve(melody, { semis = 0, vib = 1, quant = 0 } = {}) {
  const n = melody.pitch.length
  const cents = new Float32Array(n)
  for (let i = 0; i < n; i++) cents[i] = melody.pitch[i] > 0 ? 1200 * Math.log2(melody.pitch[i] / 440) : NaN

  const base = new Float32Array(n)
  const W = Math.max(3, Math.round(melody.frameRate * 0.085))
  for (let i = 0; i < n; i++) {
    let s = 0
    let c = 0
    for (let j = i - W; j <= i + W; j++)
      if (j >= 0 && j < n && !isNaN(cents[j])) {
        s += cents[j]
        c++
      }
    base[i] = c ? s / c : NaN
  }

  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (isNaN(cents[i])) {
      out[i] = 0
      continue
    }
    let b = base[i]
    if (quant > 0) b = b + (Math.round(b / 100) * 100 - b) * quant
    out[i] = 440 * Math.pow(2, (b + (cents[i] - base[i]) * vib + semis * 100) / 1200)
  }
  return out
}

/**
 * Notensegmentierung: eine Note pro Phrase, der Pitch Bend trägt die Kontur.
 * Erst wenn die Tonhöhe zu weit vom Grundton wegläuft (mehr als der Bend
 * abbilden kann), fängt eine neue Note an.
 *
 * @param {object} melody
 * @param {Float32Array} freq       Ergebnis von shapedCurve
 * @param {number} bendRange        Bend-Umfang in Halbtönen
 * @returns {Array<{start,end,midi,rootCents,vel}>}  start/end in Frames
 */
export function segmentNotes(melody, freq, bendRange = 12) {
  const n = freq.length
  const fr = melody.frameRate
  const maxDev = bendRange * 100 * 0.92
  const minFrames = Math.max(3, Math.round(fr * 0.06))
  const notes = []
  let i = 0

  while (i < n) {
    if (!melody.pitch[i] || !freq[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && melody.pitch[j] > 0) j++

    // eine stimmhafte Phrase von i bis j
    let s = i
    while (s < j) {
      const look = Math.min(j, s + Math.round(fr * 0.05))
      let sum = 0
      let c = 0
      for (let k = s; k < look; k++) {
        sum += 1200 * Math.log2(freq[k] / 440)
        c++
      }
      const rootC = Math.round(sum / Math.max(1, c) / 100) * 100
      let e = s
      while (e < j && Math.abs(1200 * Math.log2(freq[e] / 440) - rootC) < maxDev) e++
      if (e - s >= minFrames) {
        let vAmp = 0
        const aw = Math.min(e, s + Math.round(fr * 0.03))
        for (let k = s; k < aw; k++) vAmp = Math.max(vAmp, melody.amp[k])
        notes.push({
          start: s,
          end: e,
          midi: Math.round(69 + rootC / 100),
          rootCents: rootC,
          vel: Math.max(18, Math.min(127, Math.round(20 + vAmp * 107))),
        })
      }
      s = e > s ? e : s + 1
    }
    i = j
  }
  return notes
}
