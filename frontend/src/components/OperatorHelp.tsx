import { apiFetch } from '../api'
import { useState } from 'react'

export function OperatorHelp({ taskId, canRefund = false }: { taskId: string | undefined; canRefund?: boolean }) {
  const [token, setToken] = useState('')
  const [checked, setChecked] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [returned, setReturned] = useState(false)
  const [allOnShelf, setAllOnShelf] = useState(false)
  const refund = async () => {
    if (!allOnShelf || !token || busy || returned) return
    setBusy(true)
    try {
      const response = await apiFetch('/api/operator/refund', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operator-Token': token },
        body: JSON.stringify({ task_id: taskId, confirmation: '确认本单全部物品仍在货架' }),
      })
      const result = await response.json()
      setMessage(response.ok ? `${result.message} 核对完毕后可恢复接单。` : result.detail ?? result.message ?? '退回失败，请重新核对。')
      if (response.ok) setReturned(true)
    } catch { setMessage('没有收到退回结果，可重试；同一笔预留不会重复退回。') }
    finally { setBusy(false) }
  }
  const resolve = async () => {
    setBusy(true)
    try {
      const response = await apiFetch('/api/operator/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operator-Token': token },
        body: JSON.stringify({ task_id: taskId, confirmation: '已核对机器人和物品' }),
      })
      const result = await response.json()
      setMessage(response.ok ? '可以继续接待啦。' : result.detail ?? result.message ?? '再核对一下口令和任务吧。')
      if (response.ok) { setToken(''); setChecked(false) }
    } catch { setMessage('刚才没连上，稍后再试试。') }
    finally { setBusy(false) }
  }
  return <details className="operator-help">
    <summary>现场协助</summary>
    <p>请在机器人端处理故障或停止动作，核对物品后再恢复接单。此操作不会停止机器人，也不会重发任务。</p>
    <label><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />已核对机器人和物品</label>
    <input type="password" value={token} autoComplete="off" placeholder="工作人员口令" aria-label="工作人员口令" onChange={e => setToken(e.target.value)} />
    {canRefund && <>
      <label><input type="checkbox" checked={allOnShelf} disabled={busy || returned} onChange={e => setAllOnShelf(e.target.checked)} />确认本单全部物品仍在货架，机器人已停止动作</label>
      <button disabled={!allOnShelf || !token || busy || returned} onClick={() => void refund()}>{returned ? '已处理库存退回' : '退回预留库存'}</button>
      <p>仅退回本单预留数量；部分取走或状态不明时不要勾选。需要退回时，请先退回库存再恢复接单。</p>
    </>}
    <button disabled={!checked || !token || busy} onClick={() => void resolve()}>恢复接单</button>
    {message && <span role="status">{message}</span>}
  </details>
}
