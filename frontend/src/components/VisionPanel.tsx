import { useEffect, useRef, useState } from 'react'
import { config } from '../config'
import type { BackendMode, Detection, Task } from '../types'
import { gdkLabels } from '../gdkNames'
import { IconCheck } from './Icons'
import { OperatorHelp } from './OperatorHelp'
import { lastProgressAt, taskFeedback } from '../taskFeedback'

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
      {detections.map(d => ({ ...d, color: '#9fd3e6' })).map((d) => {
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
function Timeline({ task, remote }: { task: Task; remote: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const follow = useRef(true)
  const previousTop = useRef(0)
  useEffect(() => { follow.current = true; previousTop.current = 0 }, [task.id])
  useEffect(() => {
    const el = container.current
    if (!el) return
    const scroll = () => { if (follow.current) el.scrollTop = el.scrollHeight }
    scroll()
    const observer = new ResizeObserver(scroll)
    observer.observe(el)
    if (list.current) observer.observe(list.current)
    return () => observer.disconnect()
  }, [task.steps, task.status])
  const started = task.steps.filter((s) => s.status !== 'pending')
  const t0 = task.created_at ?? started[0]?.startedAt
  const running = task.status === 'running' || task.status === undefined
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!running || !remote) return
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(timer)
  }, [running, remote, task.id])
  const feedback = taskFeedback(task, now, remote ? config.progressWarningSeconds : Infinity)
  const lastProgress = started.at(-1)
  const reportedAt = lastProgressAt(task)
  const waiting = running && !started.some((s) => s.status === 'active')
  return (
    <div className="task" ref={container} onScroll={e => {
      const el = e.currentTarget
      if (el.scrollHeight - el.clientHeight - el.scrollTop < 32) follow.current = true
      else if (el.scrollTop < previousTop.current - 1) follow.current = false
      previousTop.current = el.scrollTop
    }}>
      <div className="panel-title">
        执行过程<span className="task-name">{task.title}</span>
      </div>
      <ol className="steps" ref={list}>
        {started.map((s) => (
          <li key={s.id} className={s.status}>
            <span className="step-icon">{s.status === 'done' ? <IconCheck size={14} /> : s.status === 'failed' ? '×' : <i />}</span>
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
        {feedback && (
          <li className={`task-feedback ${feedback.tone}`}>
            <span className="step-icon" aria-hidden="true">{feedback.tone === 'error' ? '×' : feedback.tone === 'resolved' ? <IconCheck size={14} /> : '!'}</span>
            <div className="feedback-copy">
              <strong role={feedback.tone === 'error' ? 'alert' : 'status'}>{feedback.title}</strong>
              <p>{feedback.message}</p>
              {task.recovery_required && <p>等待现场工作人员处理后恢复接单。</p>}
              {lastProgress && <small>最后进度：{lastProgress.label}{reportedAt !== undefined && ` · ${new Date(reportedAt * 1000).toLocaleTimeString('zh-CN', { hour12: false })}`}</small>}
              {task.id && <small className="feedback-task-id">任务编号：{task.id}</small>}
            </div>
          </li>
        )}
        {waiting && !feedback && (
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

export function VisionPanel(props: {
  showCamera: boolean
  cameraSrc: string | null
  detections: Detection[]
  caption: string
  scanning: boolean
  task: Task | null
  backendMode: BackendMode | 'demo' | 'unknown'
  recoveryRequired: boolean
  glossary?: Record<string, string>
  onCancel: () => void
  onTake: () => void
  onRecover: () => void
}) {
  const hasVision = props.detections.length > 0 || props.scanning
  return (
    <section className={`vision${props.showCamera ? '' : ' without-camera'}`}>
      <div className="panel-title">
        <span>{!props.showCamera || props.backendMode === 'lanjian_http' && !props.cameraSrc ? '机器人执行' : `${config.assistantName}的视野`}</span>
        {(props.showCamera && (props.backendMode !== 'lanjian_http' || !!props.cameraSrc)) && <span className="live-badge">
          <i />
          {props.scanning ? '识别中' : props.detections.length > 0 ? `识别到 ${props.detections.length} 个物品` : '相机快照'}
        </span>}
      </div>

      {(props.showCamera && (props.backendMode !== 'lanjian_http' || !!props.cameraSrc)) && (
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

      {props.showCamera && props.caption && (
        <div className="caption">
          <div className="panel-sub">场景理解</div>
          <p>{props.caption}</p>
        </div>
      )}

      {props.task && <Timeline task={props.task} remote={props.backendMode === 'lanjian_http'} />}
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
