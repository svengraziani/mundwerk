/**
 * Klangerzeugung. Additive Synthese für die Melodie, Rausch- und
 * Sinusbausteine für die Drums, beides über WebAudio.
 *
 * Einzige Datei im audio/-Ordner, die WebAudio wirklich braucht — beim
 * Swift-Port wird sie durch AVAudioEngine ersetzt, nicht übersetzt.
 *
 * Automationsregel: pro AudioParam entweder *eine* setValueCurveAtTime über
 * die gesamte Dauer oder ausschließlich setValueAtTime/ramp — niemals beides
 * und niemals zwei sich überlappende Kurven. Safari wirft dabei, Chrome
 * verschluckt es still.
 */

export const OfflineCtor = typeof window !== 'undefined' ? window.OfflineAudioContext || window.webkitOfflineAudioContext : null

/** Exponentiell abklingendes Rauschen als Faltungshall. */
export function reverbImpulse(oc, sr, len, decay) {
  const L = Math.floor(sr * len)
  const b = oc.createBuffer(1, L, sr)
  const d = b.getChannelData(0)
  for (let i = 0; i < L; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / L, decay)
  return b
}

function noiseBuffer(oc, sr, seconds) {
  const nb = oc.createBuffer(1, Math.ceil(sr * seconds), sr)
  const nd = nb.getChannelData(0)
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1
  return nb
}

/**
 * Melodie rendern.
 *
 * @param {AudioNode} dest
 * @param {object} melody       Ergebnis von analyseMelody
 * @param {object} opts.instrument   Eintrag aus INSTRUMENTS
 * @param {Float32Array} opts.shaped Frequenzkurve aus shapedCurve
 * @param {number} opts.breath       0..2, Rauschanteil
 * @returns {number} Dauer inklusive Ausklang
 */
export function renderMelody(oc, dest, melody, { instrument, shaped, breath = 1 }) {
  const n = melody.pitch.length
  const fr = melody.frameRate
  const curveDur = n / fr
  const ins = instrument

  // Kopie: die Lücken werden gehalten statt auf 0 zu springen, sonst knackt es.
  const freq = Float32Array.from(shaped)
  let last = 220
  for (let i = 0; i < n; i++) {
    if (freq[i] > 0) last = freq[i]
    else freq[i] = last
  }

  const nyq = oc.sampleRate * 0.47
  let norm = 0
  ins.part.forEach((p) => (norm += p[1]))

  const bus = oc.createGain()
  bus.gain.value = 0.6
  bus.connect(dest)
  const conv = oc.createConvolver()
  conv.buffer = reverbImpulse(oc, oc.sampleRate, 1.1, 2.6)
  const wet = oc.createGain()
  wet.gain.value = 0.19
  bus.connect(conv)
  conv.connect(wet)
  wet.connect(dest)

  ins.part.forEach(([ratio, level], k) => {
    const osc = oc.createOscillator()
    osc.type = 'sine'
    const g = oc.createGain()
    g.gain.value = 0
    const fc = new Float32Array(n)
    const gc = new Float32Array(n)
    const det = 1 + (k ? (Math.random() * 2 - 1) * 0.0016 * ins.drift * k : 0)
    for (let i = 0; i < n; i++) {
      const f = Math.min(nyq, freq[i] * ratio * det)
      fc[i] = f
      const roll = f > 3000 ? Math.max(0, 1 - (f - 3000) / 6000) : 1
      gc[i] = ((melody.amp[i] * level) / norm) * roll
    }
    osc.frequency.setValueCurveAtTime(fc, 0, curveDur)
    g.gain.setValueCurveAtTime(gc, 0, curveDur)
    osc.connect(g)
    g.connect(bus)
    osc.start(0)
    osc.stop(curveDur + 0.3)
  })

  if (ins.noise > 0 && breath > 0) {
    const ns = oc.createBufferSource()
    ns.buffer = noiseBuffer(oc, oc.sampleRate, Math.max(0.5, curveDur))
    ns.loop = true
    const bp = oc.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = ins.nq
    const ng = oc.createGain()
    ng.gain.value = 0
    const bf = new Float32Array(n)
    const bg = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      bf[i] = Math.min(nyq, freq[i] * 2.1)
      bg[i] = melody.amp[i] * ins.noise * breath * 0.32
    }
    bp.frequency.setValueCurveAtTime(bf, 0, curveDur)
    ng.gain.setValueCurveAtTime(bg, 0, curveDur)
    ns.connect(bp)
    bp.connect(ng)
    ng.connect(bus)
    ns.start(0)
    ns.stop(curveDur + 0.3)
  }

  return curveDur + 0.4
}

/**
 * Drums rendern.
 *
 * @param {object} opts.kit    Eintrag aus KITS
 * @param {Array} opts.hits    bereits gerasterte Schläge (siehe onset.gridded)
 * @param {number} opts.tune   Kick-Stimmung in Halbtönen
 * @returns {number} Endzeit
 */
export function renderBeat(oc, dest, beat, { kit, hits, tune = 0 }) {
  const sr = oc.sampleRate
  const tuneRatio = Math.pow(2, tune / 12)

  const bus = oc.createGain()
  bus.gain.value = 0.85
  bus.connect(dest)
  const conv = oc.createConvolver()
  conv.buffer = reverbImpulse(oc, sr, 0.7, 3.2)
  const wet = oc.createGain()
  wet.gain.value = kit.verb
  bus.connect(conv)
  conv.connect(wet)
  wet.connect(dest)

  const nb = noiseBuffer(oc, sr, 0.6)
  let end = 0

  hits.forEach((h) => {
    const t = h.t
    const v = h.vel / 127

    if (h.type === 'kick') {
      const o = oc.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(kit.kick.f0 * tuneRatio, t)
      o.frequency.exponentialRampToValueAtTime(kit.kick.f1 * tuneRatio, t + kit.kick.p)
      const g = oc.createGain()
      g.gain.setValueAtTime(v * 0.95, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + kit.kick.d)
      o.connect(g)
      g.connect(bus)
      o.start(t)
      o.stop(t + kit.kick.d + 0.05)

      const c = oc.createBufferSource()
      c.buffer = nb
      const cf = oc.createBiquadFilter()
      cf.type = 'bandpass'
      cf.frequency.value = 1800
      cf.Q.value = 1
      const cg = oc.createGain()
      cg.gain.setValueAtTime(v * kit.kick.click * 0.4, t)
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012)
      c.connect(cf)
      cf.connect(cg)
      cg.connect(bus)
      c.start(t)
      c.stop(t + 0.05)
      end = Math.max(end, t + kit.kick.d + 0.1)
    } else if (h.type === 'snare') {
      const s = oc.createBufferSource()
      s.buffer = nb
      const f = oc.createBiquadFilter()
      f.type = 'highpass'
      f.frequency.value = kit.snare.hp
      const g = oc.createGain()
      g.gain.setValueAtTime(v * 0.55, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + kit.snare.dec)
      s.connect(f)
      f.connect(g)
      g.connect(bus)
      s.start(t)
      s.stop(t + kit.snare.dec + 0.05)
      ;[185, 332].forEach((fr, i) => {
        const o = oc.createOscillator()
        o.type = 'triangle'
        o.frequency.value = fr
        const og = oc.createGain()
        og.gain.setValueAtTime(v * kit.snare.tone * (i ? 0.35 : 0.55), t)
        og.gain.exponentialRampToValueAtTime(0.0001, t + kit.snare.dec * 0.65)
        o.connect(og)
        og.connect(bus)
        o.start(t)
        o.stop(t + kit.snare.dec + 0.05)
      })
      end = Math.max(end, t + kit.snare.dec + 0.1)
    } else {
      const dec = h.type === 'openhat' ? kit.hat.od : kit.hat.d
      const s = oc.createBufferSource()
      s.buffer = nb
      const f = oc.createBiquadFilter()
      f.type = 'highpass'
      f.frequency.value = kit.hat.hp
      const f2 = oc.createBiquadFilter()
      f2.type = 'highpass'
      f2.frequency.value = kit.hat.hp
      const g = oc.createGain()
      g.gain.setValueAtTime(v * 0.34, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dec)
      s.connect(f)
      f.connect(f2)
      f2.connect(g)
      g.connect(bus)
      s.start(t)
      s.stop(t + dec + 0.05)
      end = Math.max(end, t + dec + 0.1)
    }
  })

  return end
}

/**
 * Rendern anstoßen und auf den Puffer warten.
 *
 * Safari kennt bis heute nur die Callback-Form: `startRendering()` liefert dort
 * `undefined`, der Puffer kommt über `oncomplete`. Wer nur das Promise nimmt,
 * bekommt still `undefined` zurück — kein Fehler, kein Ton, kein Hinweis
 * worauf. Beide Formen bedienen, wie `decode()` in app.js.
 */
export function startRendering(oc) {
  return new Promise((res, rej) => {
    oc.oncomplete = (e) => res(e.renderedBuffer)
    let p
    try {
      p = oc.startRendering()
    } catch (e) {
      rej(e)
      return
    }
    if (p && typeof p.then === 'function') p.then(res, rej)
  })
}

/**
 * Offline rendern.
 *
 * @param {'melody'|'beat'|'both'} which
 * @param {number} o.sr          Samplerate der Aufnahme — nur für die Dauer
 * @param {number} o.renderRate  Samplerate des Ausgabekontexts
 * @returns {Promise<AudioBuffer|null>}
 */
export async function renderMix(which, { melody, beat, sr, renderRate, melodyOpts, beatOpts }) {
  let sec = 0
  if (which !== 'beat' && melody) sec = Math.max(sec, melody.buf.length / sr + 0.6)
  if (which !== 'melody' && beat) sec = Math.max(sec, beat.buf.length / sr + 1.2)
  if (sec <= 0) return null

  // Gerendert wird mit der Rate des Ausgabekontexts, nicht mit der der Quelle.
  // iOS-Safari lehnt einen OfflineAudioContext ab, dessen Rate nicht zur
  // Hardware passt — und eine geladene Datei bringt ihre eigene mit. Die
  // Klangerzeugung rechnet ohnehin in Sekunden, ihr ist die Rate egal.
  const rate = renderRate || sr
  const oc = new OfflineCtor(1, Math.ceil(sec * rate), rate)
  const master = oc.createGain()
  master.gain.value = 0.9
  master.connect(oc.destination)
  if (which !== 'beat' && melody) renderMelody(oc, master, melody, melodyOpts)
  if (which !== 'melody' && beat) renderBeat(oc, master, beat, beatOpts)
  return startRendering(oc)
}

/** Mono-16-Bit-WAV aus einem AudioBuffer. */
export function toWav(buf) {
  const d = buf.getChannelData(0)
  const sr = buf.sampleRate
  const len = d.length
  const ab = new ArrayBuffer(44 + len * 2)
  const v = new DataView(ab)
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  w(0, 'RIFF')
  v.setUint32(4, 36 + len * 2, true)
  w(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, len * 2, true)
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, d[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([ab], { type: 'audio/wav' })
}
