import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// Test the controller without a browser: native mode must never create browser audio.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/speech/controller.ts')) {
      if (specifier === '../api') return { shortCircuit: true, url: 'data:text/javascript,export const apiFetch = (...args) => globalThis.voiceTestFetch(...args)' }
      if (specifier.includes('capture-worklet')) return { shortCircuit: true, url: 'data:text/javascript,export default "unused-worklet"' }
      if (specifier === './audio') return next('./audio.ts', context)
    }
    return next(specifier, context)
  },
})
const { SpeechController } = await import('../src/speech/controller.ts')
hooks.deregister()

test('native mode initializes without a click, controls backend, and survives page disposal', async () => {
  const calls = [], states = []
  let state = { mode: 'local', enabled: true, active: false, tts: false, status: '布鲁休眠中' }
  globalThis.AudioContext = class { constructor() { throw new Error('Browser audio must not be opened') } }
  globalThis.voiceTestFetch = async (url, options) => {
    calls.push([url, options])
    if (url === '/api/speech') return Response.json({ configured: true, mode: 'local', local: state })
    const { action } = JSON.parse(options.body)
    state = { ...state, enabled: action === 'pause' ? false : action === 'toggle' ? true : state.enabled,
      active: action === 'pause' ? false : action === 'toggle' ? !state.active : state.active }
    return Response.json(state)
  }
  const controller = new SpeechController(() => assert.fail('Native transcripts must not be submitted twice'),
    assert.fail, s => states.push(s), () => {}, () => {})
  await controller.initialize()
  await controller.unlock()
  assert.equal(states.at(-1).enabled, true)
  assert.equal(states.at(-1).mode, 'local')
  assert.equal(states.at(-1).tts, false)
  controller.onEvent({ type: 'asr', text: '拿水', final: true })
  controller.onEvent({ type: 'assistant_start', id: '1' })
  controller.onEvent({ type: 'assistant_delta', id: '1', text: '你好' })
  controller.onEvent({ type: 'assistant_end', id: '1' })
  controller.stopListening()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(states.at(-1).enabled, false)
  await controller.mic()
  assert.equal(states.at(-1).enabled, true)
  assert.equal(states.at(-1).active, true)
  const count = calls.length
  controller.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, count) // Closing/reloading the page must not pause the native station.
  assert.deepEqual(calls.filter(([url]) => url === '/api/speech/control').map(([, init]) => JSON.parse(init.body).action), ['pause', 'toggle'])
  assert.ok(calls.every(([url]) => !url.endsWith('/recognize') && !url.endsWith('/synthesize')))
})
