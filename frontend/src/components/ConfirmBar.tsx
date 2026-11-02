import { useEffect, useState } from 'react'
import type { ConfirmRequest } from '../types'
import { IconRobot } from './Icons'

/**
 * 机器人动作前的确认条：停靠在输入框位置，一行问题 + 右侧两个选项（类似 Codex 的执行确认）。
 * 观众允许后才执行；超时由后端按“取消”处理。
 */
export function ConfirmBar({
  request,
  onAnswer,
}: {
  request: ConfirmRequest & { receivedAt: number }
  onAnswer: (approved: boolean) => void
}) {
  // 倒计时从请求到达时算起，与后端超时一致（确认条会晚几秒出现）
  const remaining = () => Math.max(0, Math.round(request.timeout_s - (Date.now() - request.receivedAt) / 1000))
  const [left, setLeft] = useState(remaining)
  useEffect(() => {
    setLeft(remaining())
    const t = setInterval(() => setLeft(remaining()), 250)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id])

  // Enter = 允许，Esc = 取消；捕获阶段拦截，避免触发全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.stopImmediatePropagation()
        e.preventDefault()
        onAnswer(e.key === 'Enter')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onAnswer])

  const target = request.target ?? ''
  const question = !target
    ? `${request.message.replace(/。$/, '')}，允许吗？`
    : request.skill === '卸货'
      ? `允许布鲁把${target}送到交付处吗？`
      : `允许布鲁去货架拿${target}，再送到交付处吗？`

  return (
    <div className="confirm-bar" role="alertdialog" aria-labelledby="confirm-q" title={request.note}>
      <span className="confirm-bar-icon">
        <IconRobot size={20} />
      </span>
      <div className="confirm-bar-text">
        <div id="confirm-q" className="confirm-bar-q">
          {question}
        </div>
        <div className="confirm-bar-sub">
          {request.steps?.join(' → ')}
          <span className="confirm-bar-time"> · 说“可以”也行 · {left}s</span>
        </div>
      </div>
      <div className="confirm-bar-actions">
        <button className="confirm-bar-no" onClick={() => onAnswer(false)}>
          取消<kbd>Esc</kbd>
        </button>
        <button className="confirm-bar-yes" onClick={() => onAnswer(true)} autoFocus>
          允许<kbd>↵</kbd>
        </button>
      </div>
    </div>
  )
}
