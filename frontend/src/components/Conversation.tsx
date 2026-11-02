import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { config } from '../config'
import type { Message, Phase, SkillCall, Thought } from '../types'
import { IconCheck } from './Icons'
import { gdkLabels } from '../gdkNames'
import { markRevealed } from '../reveal'
import { cleanReasoning, stableLength } from '../reasoningText'
import { Composer } from './Composer'

const STATUS: Record<Phase, string> = {
  idle: '在线',
  listening: '正在聆听',
  thinking: '正在思考',
  speaking: '正在回答',
  acting: '正在执行任务',
}

const KIND: Record<Thought['kind'], string> = { see: '看到', understand: '理解', decide: '决定' }

function ThoughtCard({ thoughts, live }: { thoughts: Thought[]; live: boolean }) {
  return (
    <div className={`thoughts ${live ? 'thinking' : ''}`}>
      <div className="thoughts-head">{live ? '思考中' : '思考过程'}</div>
      <ol>
        {thoughts.map((t, i) => (
          <li key={i}>
            <span className="t-tag">{KIND[t.kind]}</span>
            <span className="t-text">{t.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * 按可读速度逐字呈现思考链：模型往往一次吐出整段，直接显示观众来不及看。
 * 基础速度约 30 字/秒；积压过多时加速，避免越落越远。
 */
const READ_CPS = 30

function usePacedLength(full: number, animate: boolean) {
  const [shown, setShown] = useState(animate ? 0 : full)
  const target = useRef(full)
  target.current = full
  useEffect(() => {
    if (!animate) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setShown((cur) => {
        const backlog = target.current - cur
        if (backlog <= 0) return cur
        acc += dt * Math.max(READ_CPS, backlog * 0.6)
        const step = Math.floor(acc)
        acc -= step
        return Math.min(target.current, cur + step)
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [animate])
  return animate ? shown : full
}

/** 思考链：思考中展开并跟随滚动；结束后显示用时，最新一条默认展开、旧的折叠 */
function Reasoning({ text, ms, live, latest }: { text: string; ms?: number; live: boolean; latest: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? (live || latest)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (live && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [text, live])
  return (
    <div className={`reasoning ${live ? 'live' : ''} ${expanded ? 'open' : ''}`}>
      <button className="reasoning-head" onClick={() => setOpen(!expanded)}>
        <span className="reasoning-dot" />
        {live ? '深度思考中' : `已深度思考${ms ? `（用时 ${(ms / 1000).toFixed(1)} 秒）` : ''}`}
        <span className="reasoning-chevron" />
      </button>
      {expanded && (
        <div className="reasoning-body" ref={body}>
          {text}
          {live && <span className="caret" />}
        </div>
      )}
    </div>
  )
}

/** 一条助手消息：思考链逐字呈现完之后，再显示回复和技能调用，保证“先想后说” */
/**
 * 一轮回复：两次用户发言之间的所有助手消息合为一轮。
 * 模型在一轮里可能思考多次（决定取货 → 取货后复盘 → 卸货后收尾），这里合并成一个“深度思考”，
 * 内容按顺序接着写、用时累加；回复与技能标记仍按先后顺序显示。
 * 节奏：思考链逐字呈现，某条消息的那段思考打完后，才显示这条消息的回复和技能（先想后说）。
 */
function AssistantTurn({
  msgs,
  latest,
  glossary,
  onGrow,
}: {
  msgs: Message[]
  latest: boolean
  glossary: Record<string, string>
  onGrow: () => void
}) {
  // 只对实时到达的一轮做节奏控制；历史消息直接完整显示
  const animate = useRef(msgs.some((m) => m.streaming)).current
  // 显示层清理：代号翻译成中文、去掉引用说明的话（原文保留在消息数据里）
  const parts = useMemo(() => msgs.map((m) => cleanReasoning(m.reasoning ?? '', glossary)), [msgs, glossary])
  let combined = ''
  const ends: number[] = []
  for (const part of parts) {
    if (part) combined += (combined ? '\n\n' : '') + part
    ends.push(combined.length)
  }
  const hasReasoning = msgs.some((m) => m.reasoning)
  const thinking = msgs.some((m) => m.reasoning && m.reasoningMs === undefined)
  const shown = usePacedLength(stableLength(combined, thinking), animate && hasReasoning)

  // 每条消息是否已“说出口”：前面的都已呈现、它那段思考已打完
  const revealed: boolean[] = []
  let previous = true
  msgs.forEach((m, i) => {
    const r = previous && shown >= ends[i] && (!m.reasoning || m.reasoningMs !== undefined)
    revealed.push(r)
    previous = r
  })
  const live = thinking || shown < combined.length
  const totalMs = msgs.reduce((sum, m) => sum + (m.reasoningMs ?? 0), 0)

  useEffect(onGrow, [shown, revealed.filter(Boolean).length, msgs.length, onGrow])
  useEffect(() => {
    msgs.forEach((m, i) => {
      // 只有真正有内容显示出来后才算“说完”：消息刚开始时思考链还没到，不能误判
      const hasVisible = !!m.text || !!m.skills?.length || !m.streaming
      if (revealed[i] && hasVisible) markRevealed(m.id)
    })
  })

  return (
    <div className="msg assistant">
      {combined && <Reasoning text={combined.slice(0, shown)} ms={totalMs} live={live} latest={latest} />}
      {msgs.map((m, i) => (
        <Fragment key={m.id}>
          {m.thoughts && m.thoughts.length > 0 && <ThoughtCard thoughts={m.thoughts} live={!!m.streaming && !m.text} />}
          {revealed[i] && (m.text || (m.streaming && !m.thoughts?.length && !m.reasoning && !m.skills?.length)) && (
            <div className="answer">
              {m.text}
              {m.streaming && !m.skills?.length && <span className="caret" />}
            </div>
          )}
          {revealed[i] && m.skills?.map((k) => <SkillCard key={k.call_id} skill={k} />)}
        </Fragment>
      ))}
    </div>
  )
}

/** 技能调用：一行简短标记，失败时附上原因 */
function SkillCard({ skill }: { skill: SkillCall }) {
  const pill = (
    <div className={`skill ${skill.status}`} title={gdkLabels(skill.gdk).join(' · ')}>
      <span className="skill-icon">
        {skill.status === 'done' ? <IconCheck size={11} /> : skill.status === 'failed' ? '!' : skill.status === 'cancelled' ? '–' : <i />}
      </span>
      <span className="skill-text">
        调用技能 · <b>{skill.title}</b>
        {skill.target && ` · ${skill.target}`}
      </span>
      {skill.status === 'pending' && <span className="skill-note">等待观众允许…</span>}
      {skill.status === 'running' && <span className="skill-note">执行中…</span>}
      {skill.status === 'cancelled' && <span className="skill-note">观众未允许，已取消</span>}
      {skill.status === 'done' && skill.detail && skill.detail !== '完成' && <span className="skill-note">{skill.detail}</span>}
      {skill.status === 'failed' && skill.detail && <span className="skill-note">{skill.detail}</span>}
    </div>
  )
  if (!skill.stock || skill.status !== 'done') return pill
  // 查询库存：技能标记下面一排卡片，每样东西剩几件，没货的标红
  return (
    <>
      {pill}
      <div className="stock">
        {skill.stock.map((s) => (
          <span key={s.name} className={s.count === 0 ? 'zero' : ''}>
            {s.name} <b>{s.count}</b>
          </span>
        ))}
      </div>
    </>
  )
}

const NO_GLOSSARY: Record<string, string> = {}

/** 把消息分成：单条用户消息 / 连续的助手消息（一轮回复） */
function groupTurns(messages: Message[]) {
  const groups: { role: Message['role']; msgs: Message[] }[] = []
  for (const m of messages) {
    const last = groups[groups.length - 1]
    if (m.role === 'assistant' && last?.role === 'assistant') last.msgs.push(m)
    else groups.push({ role: m.role, msgs: [m] })
  }
  return groups
}

export function Conversation(props: {
  phase: Phase
  partial: string
  messages: Message[]
  readOnly: boolean
  placeholder?: string
  /** 机器人动作确认条；有值时替代输入框显示 */
  confirm?: ReactNode
  /** 内部代号 → 中文（后端下发） */
  glossary?: Record<string, string>
  onSubmit: (t: string) => void
  onMic: () => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const scrollToEnd = useCallback(() => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])
  useEffect(scrollToEnd, [props.messages, props.partial, scrollToEnd])

  return (
    <section className="conversation">
      <header className="conv-head">
        <span className="conv-name">{config.assistantName}</span>
        <span className={`conv-status ${props.phase}`}>
          <i />
          {props.readOnly ? '历史对话' : STATUS[props.phase]}
        </span>
      </header>

      <div className="messages" ref={scroller}>
        <div className="messages-inner">
          {groupTurns(props.messages).map((g, idx, all) =>
            g.role === 'user' ? (
              <div key={g.msgs[0].id} className="msg user">
                <div className="bubble">{g.msgs[0].text}</div>
              </div>
            ) : (
              <AssistantTurn
                key={g.msgs[0].id}
                msgs={g.msgs}
                latest={!all.slice(idx + 1).some((n) => n.role === 'assistant' && n.msgs.some((m) => m.reasoning))}
                glossary={props.glossary ?? NO_GLOSSARY}
                onGrow={scrollToEnd}
              />
            ),
          )}
        </div>
      </div>

      <div className="conv-composer">
        {props.confirm || (
          <Composer phase={props.phase} partial={props.partial} placeholder={props.placeholder} onSubmit={props.onSubmit} onMic={props.onMic} />
        )}
      </div>
    </section>
  )
}
