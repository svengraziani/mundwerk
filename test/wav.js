/** Minimaler Leser für die 16-Bit-Mono-WAVs aus fixtures/. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

export function readWav(name) {
  const buf = readFileSync(join(FIXTURES, name))
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(name + ': kein WAV')

  let pos = 12
  let fmt = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = dv.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = { channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) }
    } else if (id === 'data') {
      if (!fmt) throw new Error(name + ': data vor fmt')
      if (fmt.bits !== 16) throw new Error(name + ': nur 16 Bit')
      const frames = Math.floor(size / 2 / fmt.channels)
      const out = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let s = 0
        for (let c = 0; c < fmt.channels; c++) s += dv.getInt16(body + (i * fmt.channels + c) * 2, true) / 32768
        out[i] = s / fmt.channels
      }
      return { samples: out, sampleRate: fmt.sampleRate }
    }
    pos = body + size + (size % 2)
  }
  throw new Error(name + ': kein data-Chunk')
}

export const manifest = () => JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'))
