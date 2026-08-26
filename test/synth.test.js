import test from 'node:test'
import assert from 'node:assert/strict'
import { startRendering, toWav } from '../src/audio/synth.js'

/**
 * synth.js braucht WebAudio und läuft deshalb nicht als Ganzes in Node. Was
 * hier geprüft wird, ist die Nahtstelle zum Browser — genau die Stelle, an der
 * Safari sich anders verhält als alle anderen und ein Fehler nicht auffällt,
 * weil er still ist.
 */

/** Ein OfflineAudioContext, der wie im Standard ein Promise liefert. */
const promiseCtx = (buf) => ({ startRendering: () => Promise.resolve(buf) })

/** Und einer wie in Safari: gibt undefined zurück, meldet sich über oncomplete. */
const safariCtx = (buf) => {
  const oc = {
    oncomplete: null,
    startRendering() {
      queueMicrotask(() => oc.oncomplete({ renderedBuffer: buf }))
      return undefined
    },
  }
  return oc
}

test('startRendering nimmt das Promise, wo es eins gibt', async () => {
  const buf = { marker: 'promise' }
  assert.equal(await startRendering(promiseCtx(buf)), buf)
})

test('startRendering nimmt oncomplete, wo startRendering nichts zurückgibt', async () => {
  // Ohne diesen Zweig liefert Safari still `undefined`: kein Fehler, kein Ton,
  // kein Hinweis worauf. Das ist der Grund für den Test.
  const buf = { marker: 'oncomplete' }
  assert.equal(await startRendering(safariCtx(buf)), buf)
})

test('startRendering reicht einen Wurf als abgelehntes Promise weiter', async () => {
  const boom = new Error('NotSupportedError')
  await assert.rejects(
    startRendering({ startRendering() { throw boom } }),
    (e) => e === boom,
  )
})

test('toWav schreibt einen gültigen Mono-16-Bit-Kopf', () => {
  const data = Float32Array.from([0, 0.5, -0.5, 1, -1])
  const blob = toWav({ getChannelData: () => data, sampleRate: 48000 })
  assert.equal(blob.type, 'audio/wav')
  assert.equal(blob.size, 44 + data.length * 2)
})
