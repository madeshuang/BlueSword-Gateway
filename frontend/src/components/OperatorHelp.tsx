import { apiFetch } from '../api'
import { useState } from 'react'

export function OperatorHelp({ taskId }: { taskId: string | undefined }) {
  const [token, setToken] = useState('')
  const [checked, setChecked] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
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
    <label><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />已核对机器人和物品</label>
    <input type="password" value={token} autoComplete="off" placeholder="工作人员口令" aria-label="工作人员口令" onChange={e => setToken(e.target.value)} />
    <button disabled={!checked || !token || busy} onClick={() => void resolve()}>恢复接单</button>
    {message && <span role="status">{message}</span>}
  </details>
}
