/**
 * Beat-Erkennung für Mundgeräusche.
 *
 * Statt FFT drei Biquad-Bänder (tief / mittel / hoch), daraus Hüllkurven im
 * 5-ms-Raster, Spektralfluss-Peaks als Einsätze und eine Klassifikation nach
 * Bandverhältnis plus Abklingzeit.
 *
 * Die Filter sind hier direkt implementiert statt über OfflineAudioContext.
 * Zwei Gründe: die Analyse läuft ohne WebAudio (Tests in Node, Fixtures ohne
 * Browser) und der Swift-Port braucht die Koeffizienten sowieso. Die Formeln
 * sind die der WebAudio-Spezifikation, inklusive der Eigenheit, dass Q bei
 * lowpass/highpass in Dezibel gerechnet wird, bei bandpass dagegen linear.
 */

import { smooth } from './pitch.js'

/** Ein Biquad im Direct-Form-1, Koeffizienten wie BiquadFilterNode. */
function biquad(input, sr, type, freq, q) {
  const w0 = (2 * Math.PI * freq) / sr
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  let b0, b1, b2, a0, a1, a2

  if (type === 'bandpass') {
    const alpha = sin / (2 * q)
    b0 = alpha
    b1 = 0
    b2 = -alpha
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  } else {
    const alpha = sin / (2 * Math.pow(10, q / 20)) // Q in dB
    if (type === 'lowpass') {
      b0 = (1 - cos) / 2
      b1 = 1 - cos
      b2 = (1 - cos) / 2
    } else {
      b0 = (1 + cos) / 2
      b1 = -(1 + cos)
      b2 = (1 + cos) / 2
    }
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  }

  const out = new Float32Array(input.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2
    out[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return out
}

/** Zwei identische Biquads in Serie — wie im ursprünglichen Filtergraphen. */
function filterBand(buf, sr, type, freq, q) {
  return biquad(biquad(buf, sr, type, freq, q), sr, type, freq, q)
}

export const BANDS = [
  { type: 'lowpass', freq: 180, q: 0.9 },
  { type: 'bandpass', freq: 900, q: 0.7 },
  { type: 'highpass', freq: 5200, q: 0.7 },
]

/**
 * Bänder filtern und Hüllkurven bilden.
 * @returns {{buf, sr, env: Float32Array[], tot: Float32Array, frameH: number,
 *            hits: Array, bpm: number}|null}  null, wenn nichts zu hören war.
 */
export function analyseBeat(buf, sr) {
  const bands = BANDS.map((b) => filterBand(buf, sr, b.type, b.freq, b.q))
  const H = Math.round(sr * 0.005)
  const n = Math.floor(buf.length / H)
  const env = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]

  for (let b = 0; b < 3; b++) {
    const d = bands[b]
    for (let i = 0; i < n; i++) {
      let s = 0
      const o = i * H
      const lim = Math.min(d.length, o + H)
      for (let k = o; k < lim; k++) s += d[k] * d[k]
      env[b][i] = Math.sqrt(s / Math.max(1, lim - o))
    }
  }

  const tot = new Float32Array(n)
  for (let i = 0; i < n; i++) tot[i] = env[0][i] + env[1][i] + env[2][i]
  let pk = 0
  for (let i = 0; i < n; i++) if (tot[i] > pk) pk = tot[i]
  if (pk <= 0) return null
  for (let b = 0; b < 3; b++) for (let i = 0; i < n; i++) env[b][i] /= pk
  for (let i = 0; i < n; i++) tot[i] /= pk

  return { buf, sr, env, tot, frameH: H, hits: [], bpm: 0 }
}

/**
 * Einsätze finden und klassifizieren.
 *
 * @param {object} beat   Ergebnis von analyseBeat
 * @param {number} sens   0..1, höher findet leisere Schläge
 * @returns {{hits: Array<{t,type,vel}>, bpm: number}}
 */
export function detectHits(beat, sens = 0.5) {
  const { tot, env, frameH, sr } = beat
  const n = tot.length
  const thr = 0.3 - sens * 0.26 // 0.30 … 0.04
  const refract = Math.round(0.055 / (frameH / sr))

  const flux = new Float32Array(n)
  for (let i = 1; i < n; i++) flux[i] = Math.max(0, tot[i] - tot[i - 1])
  smooth(flux, 3)

  const hits = []
  let lastI = -999
  for (let i = 2; i < n - 2; i++) {
    if (flux[i] < thr * 0.5) continue
    if (!(flux[i] >= flux[i - 1] && flux[i] > flux[i + 1])) continue
    if (tot[i] < thr * 0.55) continue
    if (i - lastI < refract) continue

    // 30 ms nach dem Einsatz mitteln → Charakter des Schlags
    const w = Math.round(0.03 / (frameH / sr))
    let lo = 0, mid = 0, hi = 0, peak = 0
    for (let k = i; k < Math.min(n, i + w); k++) {
      lo += env[0][k]
      mid += env[1][k]
      hi += env[2][k]
      peak = Math.max(peak, tot[k])
    }
    const sum = lo + mid + hi || 1
    const L = lo / sum
    const M = mid / sum
    const H = hi / sum

    // Abklingdauer trennt offene von geschlossener Hi-Hat
    let dec = 0
    for (let k = i; k < Math.min(n, i + Math.round(0.35 / (frameH / sr))); k++) if (tot[k] > peak * 0.3) dec = k - i
    const decSec = dec * (frameH / sr)

    let type
    if (L > 0.52) type = 'kick'
    else if (H > 0.42 && L < 0.3) type = decSec > 0.13 ? 'openhat' : 'hat'
    else if (M > 0.34 || (H > 0.25 && L > 0.22)) type = 'snare'
    else type = L > M ? 'kick' : 'hat'

    hits.push({
      t: (i * frameH) / sr,
      type,
      vel: Math.max(24, Math.min(127, Math.round(28 + peak * 99))),
    })
    lastI = i
  }

  return { hits, bpm: estimateBPM(hits) }
}

/** Tempo aus dem Median-Abstand, unter der Annahme, der sei ein Achtel. */
export function estimateBPM(hits) {
  if (hits.length < 4) return 0
  const iois = []
  for (let i = 1; i < hits.length; i++) iois.push(hits[i].t - hits[i - 1].t)
  iois.sort((a, b) => a - b)
  const m = iois[iois.length >> 1]
  if (!m || m <= 0) return 0
  let bpm = 60 / m
  while (bpm < 70) bpm *= 2
  while (bpm > 180) bpm /= 2
  return Math.round(bpm)
}

/**
 * Schläge Richtung Sechzehntelraster ziehen.
 * @param {number} amount  0..1 — bei 0 bleibt das Timing unangetastet.
 */
export function gridded(beat, amount = 0) {
  if (!beat) return []
  if (!amount || !beat.bpm) return beat.hits.map((h) => ({ ...h }))
  const step = 60 / beat.bpm / 4
  return beat.hits.map((h) => {
    const q = Math.round(h.t / step) * step
    return { ...h, t: h.t + (q - h.t) * amount }
  })
}
