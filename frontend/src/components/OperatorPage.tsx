import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../api'
import type { ProtocolEntry } from '../types'
import { OperatorRecovery } from './OperatorRecovery'
import './operator.css'

type Stock = { id: string; name: string; category: string; count: number; initial: number }
type Entry = ProtocolEntry & { seq: number }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export function OperatorPage() {
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [tab, setTab] = useState<'stock' | 'protocol'>('stock')
  const [stock, setStock] = useState<Stock[]>([])
  const [entries, setEntries] = useState<Entry[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState(today)
  const [task, setTask] = useState('')
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const revision = useRef(0)
  const headers = (key = token) => ({ 'X-Operator-Token': key })
  const read = async (response: Response) => {
    const result = await response.json()
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : result.message || '操作未完成，请重试。')
    return result
  }
  const filters = () => {
    const since = new Date(`${start}T00:00:00`)
    const until = new Date(`${end}T00:00:00`); until.setDate(until.getDate() + 1)
    if (!Number.isFinite(+since) || !Number.isFinite(+until) || +until <= +since) throw new Error('请选择有效的日期范围。')
    return new URLSearchParams({ since: String(+since / 1000), until: String(+until / 1000 - 0.001), task_id: task.trim() }).toString()
  }
  const login = async () => {
    setBusy(true); setMessage('')
    try {
      const items = await read(await apiFetch('/api/operator/inventory', { headers: headers(password) }))
      setStock(items); setToken(password); setPassword(''); setQuery(filters())
    } catch (e) { setMessage((e as Error).message) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    if (!token) return
    const abort = new AbortController()
    const refresh = async () => {
      try {
        const response = await apiFetch('/api/operator/inventory', { headers: { 'X-Operator-Token': token }, signal: abort.signal })
        const items = await read(response)
        if (!abort.signal.aborted) setStock(items)
      } catch (e) { if (!abort.signal.aborted) setMessage((e as Error).message) }
    }
    const timer = setInterval(() => void refresh(), 5000)
    return () => { clearInterval(timer); abort.abort() }
  }, [token])
  useEffect(() => {
    if (!token || !query) return
    const abort = new AbortController(); const version = ++revision.current
    void apiFetch(`/api/operator/protocol?${query}`, { headers: { 'X-Operator-Token': token }, signal: abort.signal })
      .then(read).then(result => { if (version === revision.current && !abort.signal.aborted) { setEntries(result.entries); setNext(result.next) } })
      .catch(e => { if (!abort.signal.aborted) setMessage(e.message) })
    return () => abort.abort()
  }, [token, query])
  const restore = async (item?: Stock) => {
    const selected = item ? [item] : stock
    if (!window.confirm(`确认实物已补满，将恢复以下可用库存：\n${selected.map(s => `${s.name}：${s.count} → ${s.initial}`).join('\n')}`)) return
    setBusy(true); setMessage('')
    try {
      await read(await apiFetch(`/api/inventory/reset${item ? `?item_id=${encodeURIComponent(item.id)}` : ''}`, { method: 'POST', headers: headers() }))
      setStock(await read(await apiFetch('/api/operator/inventory', { headers: headers() })))
      setMessage('库存已恢复。当前机器人任务保持原状。')
    } catch (e) { setMessage((e as Error).message) }
    finally { setBusy(false) }
  }
  const loadMore = async () => {
    const version = revision.current
    setBusy(true)
    try {
      const result = await read(await apiFetch(`/api/operator/protocol?${query}&before=${next}`, { headers: headers() }))
      if (version === revision.current) { setEntries(old => [...old, ...result.entries]); setNext(result.next) }
    } catch (e) { setMessage((e as Error).message) }
    finally { setBusy(false) }
  }
  const download = async () => {
    setBusy(true); setMessage('')
    try {
      const response = await apiFetch(`/api/operator/protocol/download?${filters()}`, { headers: headers() })
      if (!response.ok) { await read(response); return }
      const url = URL.createObjectURL(await response.blob())
      const a = document.createElement('a'); a.href = url; a.download = `机器人通信-${start}-${end}.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setMessage((e as Error).message) }
    finally { setBusy(false) }
  }
  return <main className="operator-page">
    <header><div><p>BlueSword · 工作人员</p><h1>现场工作台</h1></div>{token && <button onClick={() => { revision.current++; setToken(''); setEntries([]); setStock([]); setMessage('') }}>退出</button>}</header>
    {!token ? <form className="operator-login" onSubmit={e => { e.preventDefault(); void login() }}>
      <label>工作人员口令<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} autoFocus /></label>
      <button disabled={!password || busy}>进入工作台</button>
    </form> : <>
      <OperatorRecovery token={token} />
      <nav><button aria-pressed={tab === 'stock'} onClick={() => setTab('stock')}>物品库存</button><button aria-pressed={tab === 'protocol'} onClick={() => setTab('protocol')}>机器人通信</button></nav>
      {tab === 'stock' ? <section>
        <div className="operator-section"><p>显示当前可用数量。补满实物后恢复库存，任务执行期间也可操作。</p><button disabled={busy} onClick={() => void restore()}>恢复全部库存</button></div>
        <table><thead><tr><th>物品</th><th>类别</th><th>剩余</th><th>补满后</th><th>操作</th></tr></thead><tbody>{stock.map(item => <tr key={item.id}><td>{item.name}</td><td>{item.category}</td><td>{item.count}</td><td>{item.initial}</td><td><button disabled={busy} onClick={() => void restore(item)}>恢复库存</button></td></tr>)}</tbody></table>
      </section> : <section>
        <form className="operator-filters" onSubmit={e => { e.preventDefault(); try { setQuery(`${filters()}&_refresh=${Date.now()}`); setMessage('') } catch (error) { setMessage((error as Error).message) } }}>
          <label>开始日期<input type="date" value={start} onChange={e => setStart(e.target.value)} required /></label>
          <label>结束日期<input type="date" value={end} onChange={e => setEnd(e.target.value)} required /></label>
          <label>任务编号<input value={task} onChange={e => setTask(e.target.value)} placeholder="全部任务" /></label>
          <button disabled={busy}>查询</button><button type="button" disabled={busy} onClick={() => void download()}>下载记录</button>
        </form>
        <p>下载所选范围的全部记录，包含表格和报文文本。照片只保留尺寸等信息。</p>
        {entries.length === 0 && <p>这个范围内还没有通信记录。</p>}
        <div className="operator-records">{entries.map(entry => <details key={entry.seq}>
          <summary><time>{new Date(entry.at * 1000).toLocaleString()}</time><span>{entry.direction === 'out' ? '网关 → 机器人' : '机器人 → 网关'}</span><span>{entry.path}</span><span>{String(entry.body.taskId ?? '')}</span></summary>
          <div><h3>发送内容</h3><pre>{JSON.stringify(entry.body, null, 2)}</pre><h3>响应</h3><pre>{JSON.stringify(entry.reply, null, 2)}</pre></div>
        </details>)}</div>
        {next !== null && <button disabled={busy} onClick={() => void loadMore()}>加载更多</button>}
      </section>}
    </>}
    {message && <p role="status">{message}</p>}
  </main>
}
