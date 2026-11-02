import test from 'node:test'
import assert from 'node:assert/strict'
import { taskFeedback } from '../src/taskFeedback.ts'

const task = {
  id: 'onsite-task', title: '取物', status: 'running', created_at: 100, last_progress_at: 120,
  steps: [{ id: 'target_located', label: '识别目标', status: 'done', startedAt: 110 }],
}

test('a robot fault is visible even when every reported milestone is already done', () => {
  const failed = { ...task, status: 'failed', recovery_required: true,
    error: { code: 'robot_error', message: '抓取时机械臂故障' } }
  const feedback = taskFeedback(failed, 121, 60)
  assert.equal(feedback.tone, 'error')
  assert.match(feedback.message, /机械臂故障/)
  assert.equal(failed.steps[0].status, 'done')
  const resolved = taskFeedback({ ...failed, status: 'resolved', recovery_required: false }, 500, 60)
  assert.equal(resolved.tone, 'resolved')
  assert.match(resolved.message, /机械臂故障/)
  assert.doesNotMatch(resolved.title, /任务.*完成|成功/)
})

test('stale progress warns without ending the task; a new recognition attempt clears it', () => {
  assert.equal(taskFeedback(task, 179, 60), null)
  assert.equal(taskFeedback(task, 180, 60).tone, 'warning')
  assert.equal(task.status, 'running')
  assert.equal(taskFeedback({ ...task, last_progress_at: 181 }, 182, 60), null)
  assert.equal(taskFeedback({ ...task, status: 'completed' }, 500, 60), null)
  assert.equal(taskFeedback(task, 500, Infinity), null)
})

test('missing reports and stopping tracking never claim a confirmed robot failure', () => {
  for (const [status, code] of [['failed', 'result_timeout'], ['failed', 'dispatch_uncertain'], ['cancelled', 'cancelled'], ['interrupted', 'restart']]) {
    const feedback = taskFeedback({ ...task, status, error: { code, message: '请现场核对' } }, 500, 60)
    assert.equal(feedback.tone, 'warning')
    assert.match(feedback.title, /状态待确认/)
  }
})
