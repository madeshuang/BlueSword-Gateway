import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSource } from './load-source.mjs'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const insecureCrypto = { getRandomValues: array => crypto.getRandomValues(array) }

test('HTTP LAN clients can start and reset distinct sessions without randomUUID', () => {
  const { initialState, reducer, persist } = loadSource('../src/store.ts', ['initialState', 'reducer', 'persist'], {
    crypto: insecureCrypto, localStorage: { getItem: () => null, setItem() {} }, config: {},
  })
  const first = reducer(initialState, { type: 'local_user', text: '你好' })
  const second = reducer(first, { type: 'go_home' })
  assert.match(first.sessionId, uuid)
  assert.match(second.sessionId, uuid)
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(second.history[0].id, first.sessionId)
  assert.equal(persist(second), true)
})

test('HTTP requests have UUIDs, preserve caller IDs and never replay offline requests', () => {
  let socket, reconnect
  const events = [], sent = []
  class Socket {
    static OPEN = 1
    readyState = 1
    constructor() { socket = this }
    send(text) { sent.push(JSON.parse(text)) }
    close() {}
  }
  const { createBridge } = loadSource('../src/bridge.ts', ['createBridge'], {
    crypto: insecureCrypto, WebSocket: Socket, setTimeout: fn => { reconnect = fn }, clearTimeout() {},
  })
  const bridge = createBridge('ws://192.0.2.1/ws', event => events.push(event))
  bridge.send({ type: 'text_input', text: '你好' })
  bridge.send({ type: 'text_input', text: '查询库存' })
  bridge.send({ type: 'text_input', text: '已编号请求', request_id: 'caller-id' })
  assert.match(sent[0].request_id, uuid)
  assert.match(sent[1].request_id, uuid)
  assert.notEqual(sent[0].request_id, sent[1].request_id)
  assert.equal(sent[2].request_id, 'caller-id')
  socket.readyState = 3
  socket.onclose()
  bridge.send({ type: 'text_input', text: '离线请求' })
  assert.match(events.find(e => e.type === 'assistant_start').id, uuid)
  assert.match(events.find(e => e.type === 'assistant_delta').text, /没有发送/)
  reconnect()
  assert.equal(sent.length, 3)
  bridge.close()
})
