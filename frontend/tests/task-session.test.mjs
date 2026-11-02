import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSource } from './load-source.mjs'

const task = { id: 'old-task', title: '旧任务', status: 'running', steps: [] }
const load = (localStorage = { getItem: () => null }) => loadSource('../src/store.ts', ['initialState', 'reducer', 'persist'], {
  localStorage, config: { agentWsUrl: 'ws://test' },
})

test('new conversation closes old execution and photos, while retaining robot recovery state', () => {
  for (const status of ['running', 'completed', 'failed']) {
    const { reducer, initialState } = load()
    let state = reducer(initialState, { type: 'task', task: { ...task, status, recovery_required: status === 'failed' } })
    state = reducer(state, { type: 'camera', task_id: task.id, src: 'old-photo' })
    state = reducer(state, { type: 'go_home' })
    assert.equal(state.visionDismissed, true)
    assert.equal(state.cameraSrc, null)
    for (const event of [
      { type: 'task', task: { ...task, status: 'failed', recovery_required: true } },
      { type: 'camera', task_id: task.id, src: 'late-photo' },
      { type: 'vision', task_id: task.id, caption: '旧的识别回报' },
      { type: 'phase', task_id: task.id, phase: 'acting' },
    ]) state = reducer(state, event)
    assert.equal(state.visionDismissed, true)
    assert.equal(state.recoveryRequired, true)
    assert.equal(state.cameraSrc, null)
    assert.equal(state.caption, '')
    assert.equal(state.view, 'home')
    state = reducer(state, { type: 'task', task: { ...task, id: 'new-task' } })
    assert.equal(state.visionDismissed, false)
  }
})

test('reset acknowledgement and reload keep the old task hidden; a fresh inspection can show its view', () => {
  const saved = new Map(), storage = { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) }
  const first = load(storage)
  let state = first.reducer(first.initialState, { type: 'go_home' })
  // The robot task may start just before the server processes reset.
  state = first.reducer(state, { type: 'session_end', task_id: task.id })
  first.persist(state)
  const reloaded = load(storage)
  state = reloaded.reducer(reloaded.initialState, { type: 'task', task })
  assert.equal(state.visionDismissed, true)
  state = reloaded.reducer(state, { type: 'camera', task_id: task.id, src: 'restored-old-photo' })
  assert.equal(state.cameraSrc, null)
  state = reloaded.reducer(state, { type: 'vision', caption: '', detections: [], scanning: false })
  assert.equal(state.visionDismissed, true)
  state = reloaded.reducer(state, { type: 'vision', caption: '新对话主动环视的结果' })
  assert.equal(state.visionDismissed, false)
})
