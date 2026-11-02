import { config } from '../config'
import type { Phase } from '../types'
import { Composer } from './Composer'

function greeting() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

export function Home(props: { voiceActive?: boolean; phase: Phase; voiceEnabled: boolean; voiceListening: boolean; voiceStatus: string; onSubmit: (t: string) => void; onMic: () => void }) {
  return (
    <section className="home">
      <h1 className="home-title">
        <svg className="home-mark" viewBox="0 0 34 22" aria-hidden>
          <path d="M0 0 L 9 0 L 21 20 L 12 20 Z" />
          <path d="M11 0 L 20 0 L 32 20 L 23 20 Z" opacity="0.7" />
        </svg>
        {greeting()}，我是<span className="accent">{config.assistantName}</span>
      </h1>

      <Composer voiceActive={props.voiceActive} big phase={props.phase} partial="" onSubmit={props.onSubmit} onMic={props.onMic} voiceEnabled={props.voiceEnabled} voiceListening={props.voiceListening} voiceStatus={props.voiceStatus} />


      <div className="chips">
        {config.suggestions.map((s) => (
          <button key={s} className="chip" onClick={() => props.onSubmit(s)}>
            {s}
          </button>
        ))}
      </div>
    </section>
  )
}
