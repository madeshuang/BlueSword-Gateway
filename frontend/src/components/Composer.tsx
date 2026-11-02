import { useState } from 'react'
import { config } from '../config'
import type { Phase } from '../types'
import { IconMic, IconSend } from './Icons'

const PHASE_HINT: Record<Phase, string> = {
  idle: `说「${config.wakePhrase}」唤醒我，或在这里输入…`,
  listening: '我在听，请说…',
  thinking: '思考中…',
  speaking: '正在回答…',
  acting: '正在执行任务…',
}

export function Composer(props: {
  phase: Phase
  partial: string
  big?: boolean
  placeholder?: string
  onSubmit: (text: string) => void
  onMic: () => void
}) {
  const [text, setText] = useState('')
  const listening = props.phase === 'listening'
  const busy = props.phase === 'thinking' || props.phase === 'acting'

  const submit = () => {
    const t = text.trim()
    if (!t || busy) return
    props.onSubmit(t)
    setText('')
  }

  return (
    <div className={`composer ${props.big ? 'big' : ''} ${listening ? 'listening' : ''}`}>
      <button className="mic" onClick={props.onMic} disabled={busy} aria-label="语音" title={`点击说话；待机时也可以说“${config.wakePhrase}”`}>
        <IconMic size={props.big ? 24 : 22} />
        <span className="mic-ring" />
      </button>

      <div className="composer-field">
        {props.partial ? (
          <div className="composer-partial">
            {props.partial}
            <span className="caret" />
          </div>
        ) : (
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
            placeholder={props.placeholder ?? PHASE_HINT[props.phase]}
          />
        )}
      </div>

      {listening && !text ? (
        <div className="wave" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
          ))}
        </div>
      ) : (
        <button className={`send ${text.trim() ? 'ready' : ''}`} onClick={submit} disabled={busy} aria-label="发送">
          <IconSend size={20} />
        </button>
      )}
    </div>
  )
}
