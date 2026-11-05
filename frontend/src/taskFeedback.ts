import type { Task } from './types'

export function lastProgressAt(task: Task): number | undefined {
  return task.last_progress_at ?? (Math.max(task.created_at ?? 0,
    ...task.steps.map(step => step.startedAt ?? 0)) || undefined)
}

export function taskFeedback(task: Task, now: number, warnAfterSeconds: number) {
  if (task.status === 'resolved') return {
    tone: 'resolved', title: '现场已处理 · 已恢复接单',
    message: task.error ? `此前记录：${task.error.message}` : '工作人员已核对机器人和物品。',
  }
  if (task.status === 'completed') return null
  const code = task.error?.code
  if (code === 'robot_error' || task.status === 'failed' && code !== 'result_timeout' && code !== 'dispatch_uncertain') {
    return { tone: 'error', title: '任务失败', message: task.error?.message || '任务执行失败，请现场工作人员核对。' }
  }
  if (task.status === 'cancelled' || task.status === 'interrupted' || code === 'result_timeout' || code === 'dispatch_uncertain') {
    return { tone: 'warning', title: task.status === 'cancelled' ? '已停止跟踪 · 机器人状态待确认' : '机器人状态待确认',
      message: task.error?.message || '请现场工作人员确认机器人和物品状态。' }
  }
  const last = lastProgressAt(task)
  if ((task.status === 'running' || task.status === undefined) && last !== undefined && now - last >= warnAfterSeconds) {
    return { tone: 'warning', title: '进度暂未更新',
      message: `距离上次更新已过 ${Math.floor(now - last)} 秒。你可以继续等待，或请现场工作人员帮忙查看。` }
  }
  return null
}
