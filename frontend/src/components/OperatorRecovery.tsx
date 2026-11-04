import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../api'
import type { BackendMode, Task } from '../types'

type Status = { mode: BackendMode; busy: boolean; recovery_required: boolean; task: Task | null }

async function read(response: Response) {
  const result = await response.json()
  if (!response.ok) throw new Error(result.detail ?? result.message ?? '读取状态失败，请重试。')
  return result
}

export function OperatorRecovery({ token }: { token: string }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    let revision = 0
    const load = async () => {
      const request = ++revision
      try {
        const next: Status = await read(await apiFetch('/api/operator/status', {
          headers: { 'X-Operator-Token': token }, signal: abort.signal,
        }))
        if (!abort.signal.aborted && request === revision) { setStatus(next); setError('') }
      } catch (e) {
        if (!abort.signal.aborted && request === revision) {
          setStatus(null); setConfirmed(null); setError((e as Error).message)
        }
      }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => { abort.abort(); clearInterval(timer) }
  }, [token, refresh])

  const remote = status?.mode === 'lanjian_http'
  const mock = status?.mode === 'mock' || status?.mode === 'gdk_mock'
  const canRecover = !!status && (remote ? status.recovery_required || status.busy
    : mock && status.recovery_required && !status.busy)
  // A confirmation belongs to the displayed task and state, never to a later order.
  const context = JSON.stringify([status?.task?.id, status?.task?.status, status?.recovery_required, status?.busy])
  const resolve = async () => {
    if (!status || !canRecover || busy || confirmed !== context) return
    const signal = controller.current?.signal
    setBusy(true); setMessage('')
    try {
      await read(await apiFetch(remote ? '/api/operator/resolve' : '/api/mock/recover', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'X-Operator-Token': token },
        body: JSON.stringify({ task_id: status.task?.id ?? null, confirmation: '已核对机器人和物品' }),
      }))
      if (!signal?.aborted) setMessage(remote ? '已恢复接单，可以重新发起取货。' : '模拟器已复位，可以继续测试。')
    } catch (e) {
      if (!signal?.aborted) setMessage((e as Error).message)
    } finally {
      if (!signal?.aborted) {
        setBusy(false); setConfirmed(null); setStatus(null); setRefresh(value => value + 1)
      }
    }
  }

  return <section className="operator-recovery" aria-label="机器人复位">
    <div className="operator-section">
      <h2>机器人复位</h2>
      <strong>{!status ? '正在读取状态' : status.recovery_required ? '需要现场处理'
        : status.busy ? '任务执行中' : '无需复位'}</strong>
    </div>
    {status?.task && <p>当前任务：{status.task.title}<br /><small>编号：{status.task.id}</small></p>}
    {status?.recovery_required && <p>{status.task?.error?.message ?? status.task?.completion_note ?? '请核对机器人和物品后恢复接单。'}</p>}
    {remote && <p>请先在机器人端处理故障、停止动作并核对物品。此按钮解除接单限制，不执行机械臂复位，也不退回库存。</p>}
    {mock && <p>复位会清除模拟器的故障状态；正在执行的模拟任务需先停止。</p>}
    {status && !remote && !mock && <p>当前模式请在机器人控制端处理复位。</p>}
    {canRecover && <label className="operator-recovery-confirm">
      <input type="checkbox" disabled={busy} checked={confirmed === context}
        onChange={e => setConfirmed(e.target.checked ? context : null)} />
      {remote ? '已确认机器人停止动作，并核对机器人和物品' : '确认复位模拟器'}
    </label>}
    <div className="operator-recovery-actions">
      <button disabled={!canRecover || busy || confirmed !== context} onClick={() => void resolve()}>
        {busy ? '正在处理…' : mock ? '复位模拟器' : '复位 / 恢复接单'}
      </button>
      <button disabled={busy} onClick={() => { setStatus(null); setConfirmed(null); setRefresh(value => value + 1) }}>刷新状态</button>
    </div>
    {error && <p role="alert">无法读取状态：{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>
}
