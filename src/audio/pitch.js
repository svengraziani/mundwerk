/**
 * Tonhöhenerkennung für Pfeifen.
 *
 * NSDF / McLeod Pitch Method pro Frame, danach vier Aufräumstufen
 * (Median, Oktave, Lücken, Kurzläufer) und daraus die Notensegmentierung.
 *
 * Keine DOM- und keine WebAudio-Abhängigkeit: rein Float32Array + Samplerate
 * rein, Zahlen raus. Diese Datei ist der erste Kandidat für den Swift-Port.
 */

export const WIN = 1024
export const HOP = 256
export const FMIN = 380 // Pfeifen liegt hoch; alles darunter ist Raumbrummen
export const FMAX = 4200

const RMS_GATE = 0.006
const CLARITY_MIN = 0.55 // Frame ohne Tonhöhe
const CLARITY_KEEP = 0.75 // Frame, dem wir wirklich trauen
const PEAK_RATIO = 0.88 // wie nah ein NSDF-Peak am Maximum liegen muss

/**
 * NSDF für einen Frame.
 *
 * @param {Float32Array} buf   gesamtes Signal
 * @param {number} off         Startindex des Frames
 * @param {number} size        Framelänge
 * @param {number} sr          Samplerate
 * @returns {{hz:number, clarity:number, rms:number}} hz === 0 heißt: keine Tonhöhe
 */
export function detect(buf, off, size, sr) {
  if (off < 0 || off + size > buf.length) return { hz: 0, clarity: 0, rms: 0 }
  let rms = 0
  for (let i = 0; i < size; i++) {
    const v = buf[off + i]
    rms += v * v
  }
  rms = Math.sqrt(rms / size)
  if (rms < RMS_GATE) return { hz: 0, clarity: 0, rms }

  const tMin = Math.max(2, Math.floor(sr / FMAX))
  const tMax = Math.min(size - 2, Math.floor(sr / FMIN))
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
  if (best < CLARITY_MIN) return { hz: 0, clarity: best, rms }

  // Erster Peak oberhalb der Schwelle, nicht der höchste: sonst landet man
  // regelmäßig eine Oktave zu tief.
  const thr = best * PEAK_RATIO
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
  if (hz < FMIN || hz > FMAX) return { hz: 0, clarity: y1, rms }
  return { hz, clarity: y1, rms }
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
 * Halbierungs- und Verdopplungsfehler gegen den lokalen Median korrigieren.
 * Zwei Durchgänge, weil ein einzelner Ausreißer den Median des Nachbarn
 * mitverschiebt. In-place.
 */
export function octaveFix(a) {
  for (let p = 0; p < 2; p++)
    for (let i = 0; i < a.length; i++) {
      if (!a[i]) continue
      const t = []
      for (let j = i - 4; j <= i + 4; j++) if (j >= 0 && j < a.length && j !== i && a[j] > 0) t.push(a[j])
      if (t.length < 3) continue
      t.sort((x, y) => x - y)
      const r = a[i] / t[t.length >> 1]
      if (r > 1.7 && r < 2.3) a[i] /= 2
      else if (r > 0.42 && r < 0.58) a[i] *= 2
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

/**
 * Kompletter Melodie-Durchlauf.
 *
 * @returns {{buf, sr, frameRate, pitch: Float32Array, amp: Float32Array, notes: Array}|null}
 *          null, wenn zu wenige stimmhafte Frames zusammenkamen.
 */
export function analyseMelody(buf, sr) {
  const frameRate = sr / HOP
  const n = Math.max(0, Math.floor((buf.length - WIN) / HOP))
  const hz = new Float32Array(n)
  const cl = new Float32Array(n)
  const rm = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const r = detect(buf, i * HOP, WIN, sr)
    hz[i] = r.hz
    cl[i] = r.clarity
    rm[i] = r.rms
  }
  for (let i = 0; i < n; i++) if (cl[i] < CLARITY_KEEP) hz[i] = 0

  medianFix(hz, 5)
  octaveFix(hz)
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

  return { buf, sr, frameRate, pitch: hz, amp, notes: [], shaped: null }
}

/**
 * Die gepfeifte Kontur in die Zielkontur umrechnen.
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
