import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSource } from './load-source.mjs'

test('aborting a generation removes partial text and reasoning, preserving completed tools', () => {
  const { initialState, reducer } = loadSource('../src/store.ts', ['initialState', 'reducer'], {
    localStorage: { getItem: () => null }, config: {},
  })
  let state = reducer(initialState, { type: 'assistant_start', id: 'complete' })
  state = reducer(state, { type: 'skill', id: 'complete', call_id: 'stock', name: 'check_inventory', title: '库存', status: 'done' })
  state = reducer(state, { type: 'assistant_end', id: 'complete' })
  state = reducer(state, { type: 'assistant_start', id: 'broken', display_budget_ms: 20 })
  state = reducer(state, { type: 'reasoning_delta', id: 'broken', text: '半段思考' })
  state = reducer(state, { type: 'assistant_delta', id: 'broken', text: '半句回复' })
  state = reducer(state, { type: 'assistant_abort', id: 'broken' })
  state = reducer(state, { type: 'assistant_delta', id: 'broken', text: '迟到的输出' })
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].skills[0].status, 'done')
  assert.equal(state.messages[0].streaming, false)
})

test('aborted attempt and late end cannot enter browser TTS queue', () => {
  const { SpeechController } = loadSource('../src/speech/controller.ts', ['SpeechController'])
  const c = new SpeechController(() => {}, () => {}, () => {}, () => {}, () => {})
  c.state.tts = true; c.context = {}; c.playNext = async () => {}
  c.onEvent({ type: 'assistant_start', id: 'broken' })
  c.onEvent({ type: 'assistant_delta', id: 'broken', text: '不完整' })
  c.onEvent({ type: 'assistant_abort', id: 'broken' })
  c.onEvent({ type: 'assistant_delta', id: 'broken', text: '迟到' })
  c.onEvent({ type: 'assistant_end', id: 'broken' })
  c.onEvent({ type: 'assistant_start', id: 'backup' })
  c.onEvent({ type: 'assistant_delta', id: 'backup', text: '完整回复' })
  c.onEvent({ type: 'assistant_end', id: 'backup' })
  assert.deepEqual([...c.speechQueue], ['完整回复'])
})
