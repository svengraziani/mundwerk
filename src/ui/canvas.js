/**
 * Zeichnen der Spur. Nur Darstellung — hier wird nichts berechnet, was die
 * Analyse nicht schon geliefert hat. Fliegt beim Port raus.
 */

/** Canvas auf die CSS-Größe und das Device-Pixel-Ratio bringen. */
export function fit(cv) {
  const r = cv.getBoundingClientRect()
  const dp = Math.min(2, devicePixelRatio || 1)
  cv.width = r.width * dp
  cv.height = r.height * dp
  const g = cv.getContext('2d')
  g.setTransform(dp, 0, 0, dp, 0, 0)
  return { g, W: r.width, H: r.height }
}

export function clear(cv) {
  const { g, W, H } = fit(cv)
  g.clearRect(0, 0, W, H)
}

/** Live-Vorschau während der Aufnahme: Tonhöhenlinie bzw. Pegelbalken. */
export function drawLive(cv, live, mode) {
  const { g, W, H } = fit(cv)
  g.clearRect(0, 0, W, H)
  if (!live.length) return

  if (mode === 'melody') {
    g.strokeStyle = '#B4523C'
    g.lineWidth = 2.5
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.beginPath()
    let down = true
    live.forEach((hz, i) => {
      const x = (i / Math.max(1, live.length - 1)) * W
      if (!hz) {
        down = true
        return
      }
      const y = H - ((Math.log2(hz / 400) / Math.log2(10)) * H * 0.84 + H * 0.08)
      if (down) {
        g.moveTo(x, y)
        down = false
      } else g.lineTo(x, y)
    })
    g.stroke()
  } else {
    g.fillStyle = '#B4523C'
    live.forEach((v, i) => {
      const x = (i / Math.max(1, live.length - 1)) * W
      const h = Math.min(H * 0.9, v * H * 3.2)
      g.fillRect(x, (H - h) / 2, 2, h)
    })
  }
}

/**
 * Melodie: Halbtonraster, Notenblöcke (das, was als MIDI rausgeht),
 * Amplitude als Schleier und darüber die gepfiffene Kontur.
 */
export function drawMelody(cv, melody, shaped) {
  const { g, W, H } = fit(cv)
  g.clearRect(0, 0, W, H)
  const n = shaped.length
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < n; i++)
    if (melody.pitch[i] > 0) {
      if (shaped[i] < lo) lo = shaped[i]
      if (shaped[i] > hi) hi = shaped[i]
    }
  if (!isFinite(lo)) return
  lo /= 1.4
  hi *= 1.4
  const Y = (hz) => H - (Math.log2(hz / lo) / Math.log2(hi / lo)) * (H * 0.84) - H * 0.08

  g.strokeStyle = '#2C231C'
  g.lineWidth = 1
  const m0 = Math.ceil(69 + 12 * Math.log2(lo / 440))
  const m1 = Math.floor(69 + 12 * Math.log2(hi / 440))
  for (let m = m0; m <= m1; m++) {
    const y = Y(440 * Math.pow(2, (m - 69) / 12))
    g.beginPath()
    g.moveTo(0, y)
    g.lineTo(W, y)
    g.stroke()
  }

  g.fillStyle = '#D3943422'
  ;(melody.notes || []).forEach((nt) => {
    const x0 = (nt.start / (n - 1)) * W
    const x1 = (nt.end / (n - 1)) * W
    const y = Y(440 * Math.pow(2, (nt.midi - 69) / 12))
    g.fillRect(x0, y - 5, Math.max(2, x1 - x0), 10)
  })

  g.fillStyle = '#63C0AC14'
  for (let i = 0; i < n; i++) {
    if (!melody.pitch[i]) continue
    const x = (i / (n - 1)) * W
    const y = Y(shaped[i])
    const h = melody.amp[i] * 26
    g.fillRect(x - 1, y - h / 2, 2.4, h)
  }

  g.strokeStyle = '#63C0AC'
  g.lineWidth = 2.6
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.shadowColor = '#63C0AC55'
  g.shadowBlur = 9
  g.beginPath()
  let down = true
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W
    if (!melody.pitch[i]) {
      down = true
      continue
    }
    const y = Y(shaped[i])
    if (down) {
      g.moveTo(x, y)
      down = false
    } else g.lineTo(x, y)
  }
  g.stroke()
  g.shadowBlur = 0
}

const LANE_COLOR = { kick: '#B4523C', snare: '#D39434', hat: '#8E7BC4', openhat: '#8E7BC4' }

/** Beat: Hüllkurve als Hintergrund, drei Spuren, Schläge als Punkte. */
export function drawBeat(cv, beat, hits, showGrid) {
  const { g, W, H } = fit(cv)
  g.clearRect(0, 0, W, H)
  const dur = beat.buf.length / beat.sr
  const X = (t) => (t / dur) * W
  const lanes = { kick: H * 0.78, snare: H * 0.5, hat: H * 0.24, openhat: H * 0.24 }

  g.fillStyle = '#3A2E2650'
  for (let i = 0; i < beat.tot.length; i++) {
    const x = (i / beat.tot.length) * W
    const h = beat.tot[i] * H * 0.85
    g.fillRect(x, (H - h) / 2, Math.max(1, W / beat.tot.length), h)
  }

  if (beat.bpm && showGrid) {
    g.strokeStyle = '#2C231C'
    g.lineWidth = 1
    const step = 60 / beat.bpm / 4
    for (let t = 0; t < dur; t += step) {
      const x = X(t)
      g.beginPath()
      g.moveTo(x, 0)
      g.lineTo(x, H)
      g.stroke()
    }
  }

  g.strokeStyle = '#2C231C'
  ;[lanes.kick, lanes.snare, lanes.hat].forEach((y) => {
    g.beginPath()
    g.moveTo(0, y)
    g.lineTo(W, y)
    g.stroke()
  })
  g.font = '500 10px "JetBrains Mono",monospace'
  g.fillStyle = '#6A5D4E'
  g.fillText('HAT', 6, lanes.hat - 7)
  g.fillText('SNARE', 6, lanes.snare - 7)
  g.fillText('KICK', 6, lanes.kick - 7)

  hits.forEach((h) => {
    const x = X(h.t)
    const y = lanes[h.type]
    const s = 4 + (h.vel / 127) * 7
    g.fillStyle = LANE_COLOR[h.type]
    g.beginPath()
    g.arc(x, y, s, 0, Math.PI * 2)
    g.fill()
    if (h.type === 'openhat') {
      g.strokeStyle = LANE_COLOR.hat
      g.lineWidth = 1.5
      g.beginPath()
      g.arc(x, y, s + 4, 0, Math.PI * 2)
      g.stroke()
    }
  })
}
