import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { config } from '../config'
import type { State } from '../store'
import { Conversation } from './Conversation'
import type { Task } from '../types'

interface TraceEntry {
  id: number
  layer: 'agent' | 'perception' | 'gdk' | 'sensor'
  name: string
  title: string
  arguments: unknown
  result: unknown
  feedback: unknown
  status: 'calling' | 'accepted' | 'completed' | 'failed' | 'cancelled'
  at: number
  ended_at?: number
}

interface Simulation {
  trace: { task_id: string | null; summary: string; phase: string; entries: TraceEntry[] }
  task: Task | null
  awaiting_take: boolean
  recovery_required: boolean
  base: number[]
  held: boolean
  delivered: boolean
}

const labels = { agent: 'Agent 编排', perception: '感知 SDK · 占位', gdk: 'GDK · Mock', sensor: '接物反馈 · 模拟' }
const statuses = { calling: '调用中', accepted: '已接受 · 执行中', completed: '已返回', failed: '失败', cancelled: '已取消' }

function useSimulation() {
  const [scene, setScene] = useState<Simulation | null>(null)
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const url = new URL(config.agentWsUrl!)
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    url.pathname = '/api/simulation'
    const token = url.searchParams.get('token')
    url.search = ''
    const poll = async () => {
      try {
        const response = await fetch(url, { signal: controller.signal,
          headers: token ? { Authorization: `Bearer ${token}` } : {} })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const value = await response.json() as Simulation
        if (!controller.signal.aborted) { setScene(value); setConnected(true) }
      } catch { if (!controller.signal.aborted) setConnected(false) }
      if (!controller.signal.aborted) timer = setTimeout(poll, 250)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [])
  return { scene, connected }
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, (_key, val) => typeof val === 'number' && !Number.isInteger(val)
    ? Number(val.toFixed(4)) : val, 2)}</pre>
}

function TracePanel({ scene }: { scene: Simulation | null }) {
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<number | null>(null)
  const [follow, setFollow] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const entries = scene?.trace.entries ?? []
  const filtered = entries.filter(e => filter === 'all' || e.layer === filter)
  const active = (follow ? filtered.at(-1) : filtered.find(e => e.id === selected)) ?? filtered.at(-1)
  useEffect(() => { setFollow(true); setSelected(null) }, [scene?.trace.task_id])
  useEffect(() => {
    if (follow) scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [follow, active?.id])
  return <section className="demo-trace">
    <header className="demo-section-head"><div><span className="demo-eyebrow">LIVE INTERACTION</span>
      <h2>Agent ↔ 机器人交互</h2></div><span className="demo-count">{entries.length} 条调用</span></header>
    <div className="trace-filters">
      {[['all', '全部'], ['agent', 'Agent'], ['perception', '感知 SDK'], ['gdk', 'GDK'], ['sensor', '接物']].map(([id, text]) =>
        <button key={id} className={filter === id ? 'on' : ''} onClick={() => { setFilter(id); setFollow(true) }}>{text}</button>)}
      <button className={`trace-follow ${follow ? 'on' : ''}`} onClick={() => setFollow(!follow)}>{follow ? '● 跟随最新' : '跟随最新'}</button>
    </div>
    {entries.length ? <div className="trace-workspace">
      <div className="trace-list" ref={scroller}>
        {filtered.map(e => <button key={e.id} onClick={() => { setSelected(e.id); setFollow(false) }}
          className={`trace-row ${e.layer} ${active?.id === e.id ? 'selected' : ''}`}>
          <div className="trace-meta"><span>{labels[e.layer]}</span><time>+{e.at.toFixed(1)}s</time></div>
          <strong>{e.title}</strong><code>{e.name}()</code>
          <span className={`trace-status ${e.status}`}>{statuses[e.status]}{e.feedback ? ' · 动作反馈已确认' : ''}</span>
        </button>)}
        {!filtered.length && <p className="trace-empty">此阶段尚未调用该类接口</p>}
      </div>
      <div className="trace-detail">
        {active && <>
          <span className={`trace-layer ${active.layer}`}>{labels[active.layer]}</span>
          <h3>{active.title}</h3><code className="trace-function">{active.name}()</code>
          <div className="trace-block"><h4>01 <span>调用参数 →</span></h4><JsonBlock value={active.arguments} /></div>
          <div className="trace-block"><h4>02 <span>← 接口返回</span></h4>
            {active.result !== null ? <JsonBlock value={active.result} /> : <p className="trace-pending">等待返回…</p>}</div>
          {active.feedback && <div className="trace-block"><h4>03 <span>动作完成反馈</span></h4><JsonBlock value={active.feedback} /></div>}
          {active.status === 'accepted' && <p className="trace-pending">请求已接受，正在等待机器人动作完成。Blender 同步展示这一动作。</p>}
          <p className="trace-disclosure">{active.layer === 'perception' ? '这里展示拟定的 SDK 接口与示例输出，识别和抓取算法待接入。'
            : active.layer === 'agent' ? '当前使用规则编排展示 Agent 的执行计划，大模型待接入。'
            : '调用经 GDK 适配器执行，返回来自 FakeSdk / 模拟传感器。'}</p>
        </>}
      </div>
    </div> : <div className="trace-welcome">
      <div className="trace-preview"><span>Agent</span><b>→</b><code>PerceptionSDK.detect_objects()</code></div>
      <div className="trace-preview"><span>感知</span><b>→</b><code>estimate_grasp_pose()</code></div>
      <div className="trace-preview"><span>GDK</span><b>→</b><code>end_effector_pose_control()</code></div>
      <h3>从一句话，到一个机器人动作</h3><p>发起取物请求后，这里会同步显示调用参数、接口返回和动作反馈。</p>
    </div>}
    <footer>蓝色：GDK 模拟调用　·　橙色：待接入的感知 SDK　·　绿色：Agent 编排</footer>
  </section>
}

export function DemoConsole(props: { state: State; voiceActive?: boolean; onSubmit: (text: string) => void; onMic: () => void; confirm?: ReactNode;
  onCancel: () => void; onTake: () => void; onRecover: () => void }) {
  const { scene, connected } = useSimulation()
  const running = scene?.task?.status === 'running'
  const online = connected && props.state.device.online
  const completed = scene?.task?.steps.filter(s => s.status === 'done').length ?? 0
  const latest = scene?.trace.entries.at(-1)
  return <div className="demo-console">
    <header className="demo-header"><div className="demo-brand"><b>BLUE<span>SWORD</span></b><span>兰剑智能</span></div>
      <div className="demo-heading"><h1>取物 Agent · 方案演示</h1><p>让任务编排、接口调用与机器人动作同时可见</p></div>
      <span className={`demo-connection ${online ? 'online' : ''}`}><i />{online ? '已连接模拟机器人' : '正在连接后端'}</span>
    </header>
    <div className="demo-pipeline">
      {['用户请求', 'Agent 任务编排', '感知 SDK', 'GDK 适配器', 'Blender 机器人'].map((title, i) =>
        <div key={title} className={(latest?.layer === 'agent' && i === 1) || (latest?.layer === 'perception' && i === 2)
          || (latest?.layer === 'gdk' && i === 3) ? 'active' : ''}><span>0{i + 1}</span>{title}{i < 4 && <b>→</b>}</div>)}
      <small>方案演示 / 无实机</small>
    </div>
    <div className="demo-body">
      <section className="demo-agent">
        <div className="demo-plan"><span className="demo-eyebrow">AGENT · 当前计划</span>
          <h2>{scene?.trace.summary ?? '等待你的取物请求'}</h2>
          <div className="demo-progress"><span style={{ width: `${completed / 11 * 100}%` }} /></div>
          <div className="demo-plan-meta"><span>{completed} / 11 步</span><span>{scene?.held ? '正在持物' : scene?.delivered ? '物品已交接' : '空夹爪'} · BASE {scene?.base.map(n => n.toFixed(2)).join(', ') ?? '0, 0, 0'}</span></div>
        </div>
        {!props.state.messages.length && <div className="demo-greeting"><span>你好，我是布鲁。</span><h2>你说要什么，<br />我来完成取物。</h2><p>试试“帮我拿奥利奥”。<br />网页展示 Agent 的交互过程，Blender 同步展示机器人动作。</p></div>}
        <Conversation messages={props.state.messages} partial={props.state.partial} phase={props.state.phase}
          voiceActive={props.voiceActive}
          placeholder="输入，例如：帮我拿奥利奥"
          readOnly={false} confirm={props.confirm} glossary={props.state.glossary} onSubmit={props.onSubmit} onMic={props.onMic} />
        <div className="demo-controls">
          <button className="primary" disabled={!online || running || scene?.recovery_required} onClick={() => props.onSubmit('帮我拿奥利奥')}>开始取物演示</button>
          <button className={scene?.awaiting_take ? 'take-ready' : ''} disabled={!online || !scene?.awaiting_take} onClick={props.onTake}>我已接稳物品</button>
          <button disabled={!online || !running} onClick={props.onCancel}>停止</button>
          <button disabled={!online || running} onClick={props.onRecover}>复位</button>
        </div>
        <p className="demo-hint">{scene?.awaiting_take ? '机器人正在等你接物。点击「我已接稳物品」后才会松爪。'
          : scene?.recovery_required ? '任务已中止。点击「复位」后可重新演示。' : '可输入物品名称；动作可在 Blender 窗口中同步查看。'}</p>
      </section>
      <TracePanel scene={scene} />
    </div>
    <div className="demo-footnote">可行性演示：Agent 使用规则编排；感知与抓取位姿为示例；GDK 返回为模拟数据。</div>
  </div>
}
