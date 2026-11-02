import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSource } from './load-source.mjs'
import { pcm16, wakeCommand } from '../src/speech/audio.ts'
const tick = () => new Promise(resolve => setImmediate(resolve))

test('automatic microphone startup listens only for wake, without activating a conversation', async () => {
  const states = [], submissions = []
  const node = () => ({ connect() { return this }, disconnect() {}, gain: {} })
  class Context {
    state = 'running'; sampleRate = 16000; destination = {}
    audioWorklet = { addModule: async () => {} }
    createMediaStreamSource = node
    createGain = node
  }
  const { SpeechController } = loadSource('../src/speech/controller.ts', ['SpeechController'], {
    apiFetch: async () => ({ ok: true, json: async () => ({ configured: true, text: '今天天气不错' }) }),
    pcm16, wakeCommand, AudioContext: Context, workletUrl: 'capture.js',
    AudioWorkletNode: class { port = {}; connect() { return this }; disconnect() {} },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  })
  const c = new SpeechController(t => submissions.push(t), () => {}, s => states.push(s), () => {}, () => {})
  await c.autoStart()
  assert.equal(states.at(-1).enabled, true)
  assert.equal(states.at(-1).listening, false)
  c.frame(new Float32Array(4000).fill(.1)); c.finish(); await tick()
  assert.equal(submissions.length, 0)
  assert.equal(c.isActive(), false)
})

test('expired conversation does not revive itself during recognition', async () => {
  const { c, submissions } = speechHarness(async () => ({ ok: true, json: async () => ({ text: '今天吃点什么' }) }))
  c.activeUntil = Date.now() - 1
  // Speech can start immediately after expiry, before a silent frame updates the UI.
  c.frame(new Float32Array(4000).fill(.1)); c.finish(); await tick()
  assert.equal(submissions.length, 0)
  assert.equal(c.isActive(), false)
})

test('speech queued immediately after a slow wake recognition keeps the following request', async () => {
  let resolve
  const { c, submissions } = speechHarness(() => new Promise(r => resolve = r))
  c.engaged = false; c.activeUntil = 0
  c.frame(new Float32Array(4000).fill(.1)); c.finish()
  c.frame(new Float32Array(4000).fill(.1)); c.finish()
  resolve({ ok: true, json: async () => ({ text: '布噜' }) }); await tick()
  resolve({ ok: true, json: async () => ({ text: '拿一包奥利奥' }) }); await tick()
  assert.deepEqual(submissions, ['拿一包奥利奥'])
})

function speechHarness(fetch) {
  const submissions = [], notices = [], states = []
  const { SpeechController } = loadSource('../src/speech/controller.ts', ['SpeechController'], { apiFetch: fetch, pcm16, wakeCommand })
  const c = new SpeechController(t => submissions.push(t), t => notices.push(t), s => states.push(s), () => {}, () => {})
  c.context = { sampleRate: 16000 }
  c.stream = { getTracks: () => [{ stop() {} }] }
  c.state.enabled = true; c.engaged = true; c.activeUntil = Date.now() + 20000
  return { c, submissions, notices, states }
}

test('home microphone click keeps the composer on home until speech is recognized, including after new conversation', async () => {
  const { initialState, reducer } = loadSource('../src/store.ts', ['initialState', 'reducer'], {
    localStorage: { getItem: () => null }, config: {},
  })
  let state = initialState, text = '查询库存'
  const { c } = speechHarness(async () => ({ ok: true, json: async () => ({ text }) }))
  // Wire the same controller callbacks as App, so a click cannot silently navigate.
  c.wake = () => { state = reducer(state, { type: 'wake' }) }
  c.submit = text => { state = reducer(state, { type: 'local_user', text }) }
  c.reset()
  for (const recognized of ['查询库存', '布鲁']) {
    text = recognized
    await c.toggle()
    assert.equal(c.state.listening, true)
    assert.equal(state.view, 'home', 'Clicking the microphone must not move the input to the conversation footer')
    c.frame(new Float32Array(4000).fill(.1)); c.finish(); await tick()
    assert.equal(state.view, 'session')
    c.reset(); state = reducer(state, { type: 'go_home' })
  }
})

test('stop flushes last utterance, keeps pending recognition and does not stop TTS', async () => {
  let resolve, calls = 0, stoppedOutput = 0
  const { c, submissions } = speechHarness(() => { calls++; return new Promise(r => resolve = r) })
  c.speechSource = { stop: () => stoppedOutput++ }; c.playing = true
  c.frame(new Float32Array(1600).fill(.1))
  c.frame(new Float32Array(1600).fill(.1))
  // User barge-in may stop the current output, but clicking stop must not do it again.
  const beforeStop = stoppedOutput
  c.stopListening(); c.stopListening()
  assert.equal(calls, 1); assert.equal(stoppedOutput, beforeStop)
  assert.equal(c.state.enabled, false)
  resolve({ ok: true, json: async () => ({ text: '再来一包薯片' }) }); await tick()
  assert.deepEqual(submissions, ['再来一包薯片'])
})

test('speech is captured during playback and thinking; playback cancellation preserves ASR', async () => {
  const { c, submissions } = speechHarness(async () => ({ ok: true, json: async () => ({ text: '可以' }) }))
  c.onEvent({ type: 'phase', phase: 'thinking' }); c.playing = true
  c.frame(new Float32Array(4000).fill(.1))
  assert.equal(c.samples, 4000); assert.equal(c.playing, false)
  c.finish(); c.interrupt(); await tick()
  assert.deepEqual(submissions, ['可以'])
})

test('own playback transcript is suppressed, and old recognition cannot enter a new conversation', async () => {
  const { c, submissions } = speechHarness(async () => ({ ok: true, json: async () => ({ text: '确认后我再出发' }) }))
  c.lastPlayback = '确认后我再出发。'; c.echoUntil = Date.now() + 5000
  c.frame(new Float32Array(4000).fill(.1)); c.finish(); await tick()
  assert.equal(submissions.length, 0)
  let resolve
  const next = speechHarness(() => new Promise(r => resolve = r))
  next.c.frame(new Float32Array(4000).fill(.1)); next.c.finish(); next.c.reset()
  resolve({ ok: true, json: async () => ({ text: '拿薯片' }) }); await tick()
  assert.equal(next.submissions.length, 0)
})

test('stopping input preserves explicitly enabled playback', () => {
  const { c } = speechHarness(() => { throw Error('no recording expected') })
  c.setTts(true)
  let stops = 0
  c.speechSource = { stop: () => stops++ }; c.playing = true
  c.stopListening()
  assert.equal(stops, 0); assert.equal(c.playing, true); assert.equal(c.state.tts, true)
})

test('history restores partial text gently, never confirmation, and browsing preserves current stream', () => {
  const saved = new Map()
  const storage = { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) }
  const load = () => loadSource('../src/store.ts', ['initialState', 'reducer', 'persist'], { localStorage: storage, config: { agentWsUrl: 'ws://test' } })
  const first = load(); let s = first.reducer(first.initialState, { type: 'local_user', text: '拿薯片' })
  s = first.reducer(s, { type: 'assistant_start', id: 'one' })
  s = first.reducer(s, { type: 'assistant_delta', id: 'one', text: '好的' })
  s = first.reducer(s, { type: 'confirm_request', id: 'old', timeout_s: 180 })
  first.persist(s)
  const recovered = load().initialState
  assert.equal(recovered.messages[1].text, '好的'); assert.equal(recovered.messages[1].interrupted, true)
  assert.equal(recovered.confirm, null)
  s = first.reducer(s, { type: 'go_home' })
  s = first.reducer(s, { type: 'local_user', text: '新的对话' })
  s = first.reducer(s, { type: 'assistant_start', id: 'two' })
  const current = s.sessionId, old = s.history[0].id
  s = first.reducer(s, { type: 'open_history', id: old })
  s = first.reducer(s, { type: 'assistant_delta', id: 'two', text: '当前任务继续' })
  assert.equal(s.viewing, old); assert.equal(s.messages[1].text, '当前任务继续')
  s = first.reducer(s, { type: 'open_history', id: current })
  assert.equal(s.viewing, null); assert.equal(s.messages[1].text, '当前任务继续')
})

test('unavailable browser storage never breaks a conversation', () => {
  const { initialState, reducer, persist } = loadSource('../src/store.ts', ['initialState', 'reducer', 'persist'], {
    config: {}, localStorage: { getItem() { throw Error('blocked') }, setItem() { throw Error('full') } },
  })
  assert.equal(persist(reducer(initialState, { type: 'local_user', text: '你好' })), false)
})

test('waiting mode ignores chat, accepts a spoken alias and preserves the following request', async () => {
  let text = '今天吃点什么'
  const { c, submissions, states } = speechHarness(async () => ({ ok: true, json: async () => ({ text }) }))
  c.engaged = false; c.activeUntil = 0
  const say = async value => { text = value; c.frame(new Float32Array(4000).fill(.1)); c.finish(); await tick() }
  await say('今天吃点什么'); assert.equal(submissions.length, 0)
  await say('布卢？'); assert.equal(c.state.listening, true)
  assert.equal(states.at(-1).status, '我在，接着说吧')
  await say('拿一包薯片'); assert.deepEqual(submissions, ['拿一包薯片'])
  c.activeUntil = Date.now() - 1
  c.frame(new Float32Array(1600)); assert.equal(c.state.listening, false)
  await say('今天吃点什么'); assert.equal(submissions.length, 1)
  await say('你好布路，拿饼干'); assert.deepEqual(submissions, ['拿一包薯片', '拿饼干'])
})

test('waiting microphone click activates without closing; next click stops and permits restart', async () => {
  const { c } = speechHarness(async () => ({ ok: true, json: async () => ({ text: '' }) }))
  c.engaged = false; c.activeUntil = 0
  await c.toggle(); assert.equal(c.state.enabled, true); assert.equal(c.state.listening, true)
  assert.ok(c.activeUntil - Date.now() > 59000)
  await c.toggle(); assert.equal(c.state.enabled, false)
  assert.equal(c.state.status, '想说话时，点一下麦克风就好')
})

test('confirmation, thinking and playback prevent idle standby; completed work gets sixty seconds', () => {
  const { c } = speechHarness(() => {})
  c.engaged = true; c.activeUntil = 0
  c.onEvent({ type: 'phase', phase: 'thinking' }); c.frame(new Float32Array(100))
  assert.equal(c.isActive(), true)
  c.onEvent({ type: 'confirm_request', id: 'draft', timeout_s: 180 }); c.activeUntil = 0
  c.onEvent({ type: 'phase', phase: 'listening' }); c.frame(new Float32Array(100))
  assert.equal(c.isActive(), true)
  c.onEvent({ type: 'confirm_closed', id: 'draft', reason: 'declined' })
  assert.ok(c.activeUntil - Date.now() > 59000)
  c.activeUntil = 0; c.playing = true; c.frame(new Float32Array(100))
  assert.equal(c.isActive(), true)
})

test('backend restart archives on reopen, while refresh and reconnect keep the conversation', () => {
  const saved = new Map(), storage = { getItem: k => saved.get(k) ?? null, setItem: (k,v) => saved.set(k,v) }
  const load = (type='navigate') => loadSource('../src/store.ts', ['initialState','reducer','persist'], {
    localStorage: storage, config: { agentWsUrl: 'ws://test' }, performance: { getEntriesByType: () => [{ type }] },
  })
  const backend = boot_id => ({type:'backend',mode:'mock',recovery_required:false,boot_id})
  const first=load();let s=first.reducer(first.initialState,backend('one'))
  s=first.reducer(s,{type:'local_user',text:'旧的对话'});first.persist(s)
  const refresh=load('reload');const refreshed=refresh.reducer(refresh.initialState,backend('two'))
  assert.equal(refreshed.view,'session');assert.equal(refreshed.messages[0].text,'旧的对话')
  const reconnect=first.reducer(s,backend('two'))
  assert.equal(reconnect.view,'session');assert.equal(reconnect.sessionBootId,'one')
  first.persist(reconnect)
  const reopened=load();let next=reopened.reducer(reopened.initialState,backend('two'))
  assert.equal(next.view,'home');assert.equal(next.messages.length,0)
  assert.equal(next.history[0].messages[0].text,'旧的对话')
  next=reopened.reducer(next,{...backend('two'),recovery_required:true})
  next=reopened.reducer(next,{type:'task',task:{id:'old-task',status:'interrupted',recovery_required:true,steps:[]}})
  next=reopened.reducer(next,{type:'phase',phase:'listening'})
  assert.equal(next.view,'home');assert.equal(next.recoveryRequired,true);assert.equal(next.task.id,'old-task')
  reopened.persist(next)
  const again=load();next=again.reducer(again.initialState,backend('two'))
  assert.equal(next.history.length,1)
  next=again.reducer(next,{type:'open_history',id:next.history[0].id})
  assert.equal(next.view,'session');assert.equal(next.viewing,next.history[0].id)
})

test('unmarked history from the previous version is retained when first receiving a boot marker', () => {
  const storage={getItem:k=>k==='bluesword.current.v1'?JSON.stringify({id:'legacy',messages:[{id:'m',role:'user',text:'旧版记录'}]}):null,setItem:()=>{}}
  const {initialState,reducer}=loadSource('../src/store.ts',['initialState','reducer'],{localStorage:storage,config:{}})
  const s=reducer(initialState,{type:'backend',mode:'mock',recovery_required:false,boot_id:'first'})
  assert.equal(s.view,'session');assert.equal(s.messages[0].text,'旧版记录')
})
