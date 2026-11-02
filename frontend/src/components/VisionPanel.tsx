import { useEffect, useRef, useState } from 'react'
import { config } from '../config'
import { SCENE } from '../mock'
import type { BackendMode, Detection, ProtocolEntry, Task } from '../types'
import { gdkLabels } from '../gdkNames'
import { IconCheck } from './Icons'
import { OperatorHelp } from './OperatorHelp'

/** 无真实相机时的示意画面：简化的货架线稿，坐标与 mock 检测框一致 */
function SimulatedFeed({ detections }: { detections: Detection[] }) {
  const W = 1000
  const H = 625
  const boards = [0.33, 0.62, 0.91]
  return (
    <svg className="sim-feed" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1b2433" />
          <stop offset="1" stopColor="#0e141e" />
        </linearGradient>
        <radialGradient id="vignette" cx="50%" cy="45%" r="75%">
          <stop offset="60%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill="url(#wall)" />
      <rect x={0.06 * W} y={0.1 * H} width={0.8 * W} height={0.84 * H} fill="#141c28" />
      {boards.map((b) => (
        <rect key={b} x={0.05 * W} y={b * H} width={0.82 * W} height={0.022 * H} fill="#3a4658" />
      ))}
      <rect x={0.05 * W} y={0.1 * H} width={0.014 * W} height={0.84 * H} fill="#2c3646" />
      <rect x={0.856 * W} y={0.1 * H} width={0.014 * W} height={0.84 * H} fill="#2c3646" />
      {(detections.length ? detections.map((d) => ({ ...d, color: SCENE.find((s) => s.id === d.id)?.color ?? '#9fd3e6' })) : SCENE).map((d) => {
        const [x, y, w, h] = d.box
        const bottle = d.id.startsWith('yogurt') || d.id === 'water'
        return bottle ? (
          <g key={d.id} opacity="0.85">
            <rect x={(x + w * 0.3) * W} y={y * H} width={w * 0.4 * W} height={h * 0.18 * H} rx="4" fill="#5b6b80" />
            <rect x={x * W} y={(y + h * 0.15) * H} width={w * W} height={h * 0.85 * H} rx="10" fill={d.color} opacity="0.75" />
            <rect x={x * W} y={(y + h * 0.45) * H} width={w * W} height={h * 0.22 * H} fill="#1f5fae" opacity="0.6" />
          </g>
        ) : (
          <g key={d.id} opacity="0.85">
            <rect x={x * W} y={y * H} width={w * W} height={h * H} rx="6" fill={d.color} opacity="0.8" />
            <rect x={(x + w * 0.1) * W} y={(y + h * 0.35) * H} width={w * 0.8 * W} height={h * 0.25 * H} rx="3" fill="#fff" opacity="0.18" />
          </g>
        )
      })}
      <rect width={W} height={H} fill="url(#vignette)" />
    </svg>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return <>{now.toLocaleTimeString('zh-CN', { hour12: false })}</>
}

function Box({ d, i }: { d: Detection; i: number }) {
  const [x, y, w, h] = d.box
  return (
    <div
      className={`det ${d.target ? 'target' : ''}`}
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, animationDelay: `${i * 90}ms` }}
    >
      <span className="det-label">
        {d.target && <b>目标 ·</b>}
        {d.label}
        <em>{d.score.toFixed(2)}</em>
      </span>
    </div>
  )
}

/** 执行过程：步骤随机器人实际进展逐条出现（不预先列出整张清单），并标注距任务开始的时间 */
function Timeline({ task }: { task: Task }) {
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }) }, [task.steps])
  const started = task.steps.filter((s) => s.status !== 'pending')
  const t0 = task.created_at ?? started[0]?.startedAt
  const running = task.status === 'running' || task.status === undefined
  const waiting = running && !started.some((s) => s.status === 'active')
  return (
    <div className="task">
      <div className="panel-title">
        执行过程<span className="task-name">{task.title}</span>
      </div>
      <ol className="steps" ref={list}>
        {started.map((s) => (
          <li key={s.id} className={s.status}>
            <span className="step-icon">{s.status === 'done' ? <IconCheck size={14} /> : <i />}</span>
            <span className="step-label">
              {s.label}
              {t0 && s.startedAt && <em className="step-time">+{Math.max(0, s.startedAt - t0).toFixed(1)}s</em>}
            </span>
            {s.detail && <span className="step-detail">{s.detail}</span>}
            {s.status === 'active' && s.gdk && s.gdk.length > 0 && (
              <span className="step-gdk">{gdkLabels(s.gdk).join(' · ')}</span>
            )}
          </li>
        ))}
        {waiting && (
          <li className="pending waiting">
            <span className="step-icon">
              <i />
            </span>
            <span className="step-label">{started.length ? '等待机器人下一步回报…' : '等待机器人接单…'}</span>
          </li>
        )}
      </ol>
    </div>
  )
}

const STATUS_TEXT: Record<string, string> = { started: '开始', done: '完成', failed: '失败' }

function summarize(e: ProtocolEntry, glossary: Record<string, string>): { kind: string; text: string; ok?: boolean } {
  const b = e.body as Record<string, any>
  const name = e.path.split('/').pop()
  if (name === 'dispatch') {
    const action = { pick: '取货', place: '卸货' }[b.action as string] ?? '取物'
    const item = (b.items ?? []).map((line: { item: string; count: number }) => `${glossary[line.item] ?? line.item} × ${line.count}`).join('、')
    const r = e.reply as Record<string, any> | null | undefined
    return { kind: '下发', text: `${action} · ${item}`, ok: r ? !!r.success : false }
  }
  if (name === 'progress')
    return { kind: '回报', text: b.message ? [b.pickIndex ? `第${b.pickIndex}件` : '', b.message].filter(Boolean).join(' · ') : [b.label ?? b.stage, STATUS_TEXT[b.status] ?? b.status, b.detail].filter(Boolean).join(' · ') }
  if (name === 'finished') return { kind: '完成', text: '完成通知', ok: true }
  return { kind: '故障', text: String(b.message ?? ''), ok: false }
}

/** 网关 ⇄ 机器人的协议报文：一行一条，悬停看原始 JSON */
function ProtocolLog({ entries, glossary }: { entries: ProtocolEntry[]; glossary: Record<string, string> }) {
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })
  }, [entries.length])
  return (
    <div className="protocol">
      <div className="panel-title">
        机器人通信<span className="task-name">兰剑协议</span>
      </div>
      {entries.length === 0 ? (
        <p className="protocol-empty">还没有报文。下发任务后，这里会显示机器人回报的每一条消息。</p>
      ) : (
        <ol ref={list}>
          {entries.map((e, i) => {
            const s = summarize(e, glossary)
            return (
              <li key={i} className={e.direction} title={JSON.stringify(e.body, null, 1) + (e.reply ? '\n← ' + JSON.stringify(e.reply) : '')}>
                <span className="protocol-dir">{e.direction === 'out' ? '→' : '←'}</span>
                <span className="protocol-kind">{s.kind}</span>
                <span className="protocol-text">{s.text}</span>
                {s.ok !== undefined && <span className={`protocol-ok ${s.ok ? 'yes' : 'no'}`}>{s.ok ? (s.kind === '下发' ? '已接单' : '✓') : s.kind === '下发' ? '未接单' : '!'}</span>}
                <span className="protocol-time">{new Date(e.at * 1000).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

export function VisionPanel(props: {
  cameraSrc: string | null
  detections: Detection[]
  caption: string
  scanning: boolean
  task: Task | null
  backendMode: BackendMode | 'demo' | 'unknown'
  recoveryRequired: boolean
  protocol?: ProtocolEntry[]
  glossary?: Record<string, string>
  onCancel: () => void
  onTake: () => void
  onRecover: () => void
}) {
  const hasVision = props.detections.length > 0 || props.scanning
  return (
    <section className="vision">
      <div className="panel-title">
        <span>{props.backendMode === 'lanjian_http' && !props.cameraSrc ? '机器人执行' : `${config.assistantName}的视野`}</span>
        {(props.backendMode !== 'lanjian_http' || !!props.cameraSrc) && <span className="live-badge">
          <i />
          {props.scanning ? '识别中' : props.detections.length > 0 ? `识别到 ${props.detections.length} 个物品` : '相机快照'}
        </span>}
      </div>

      {(props.backendMode !== 'lanjian_http' || !!props.cameraSrc) && (
      <div className={`feed ${props.scanning ? 'scanning' : ''} ${hasVision ? 'active' : ''}`}>
        {props.cameraSrc ? <img src={props.cameraSrc} alt="机器人相机画面" />
          : props.backendMode === 'gdk' ? <div className="camera-empty">等待相机画面</div>
          : <SimulatedFeed detections={props.detections} />}
        <span className="hud hud-tl">头部相机</span>
        <span className="hud hud-tr">
          {props.backendMode === 'lanjian_http' ? '识别照片' : <Clock />}
        </span>
        {!props.cameraSrc && props.backendMode !== 'gdk' && <span className="hud hud-br">模拟画面</span>}
        {props.detections.map((d, i) => (
          <Box key={`${d.id}-${d.target ? 't' : 'n'}`} d={d} i={i} />
        ))}
        <div className="scanline" />
      </div>
      )}

      {props.caption && (
        <div className="caption">
          <div className="panel-sub">场景理解</div>
          <p>{props.caption}</p>
        </div>
      )}

      {props.task && <Timeline task={props.task} />}
      {props.backendMode === 'lanjian_http' && <ProtocolLog entries={props.protocol ?? []} glossary={props.glossary ?? {}} />}
      <div className="task-controls">
        {props.task?.status === 'running' && <button onClick={props.onCancel}>{props.backendMode === 'lanjian_http' ? '需要停下' : '停止任务'}</button>}
        {(props.backendMode === 'mock' || props.backendMode === 'gdk_mock') && props.task?.status === 'running'
          && props.task.steps.some((step) => (step.id === 'handover' || step.id.endsWith(':handover')) && step.status === 'active')
          && <button onClick={props.onTake}>模拟接稳物品</button>}
        {props.recoveryRequired && <span role="status">{props.task?.completion_note ?? "这次需要现场同事帮忙看一下。"}</span>}
        {(props.backendMode === 'mock' || props.backendMode === 'gdk_mock') && props.recoveryRequired && <button onClick={props.onRecover}>复位模拟器</button>}
        {props.backendMode === 'lanjian_http' && (props.recoveryRequired || props.task?.status === 'running') && <OperatorHelp key={props.task?.id} taskId={props.task?.id} />}
      </div>
    </section>
  )
}
