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

export function Home(props: { phase: Phase; voiceActive?: boolean; voiceEnabled: boolean; localVoice?: boolean; onSubmit: (t: string) => void; onMic: () => void }) {
  return (
    <section className="home">
      <h1 className="home-title">
        <svg className="home-mark" viewBox="0 0 34 22" aria-hidden>
          <path d="M0 0 L 9 0 L 21 20 L 12 20 Z" />
          <path d="M11 0 L 20 0 L 32 20 L 23 20 Z" opacity="0.7" />
        </svg>
        {greeting()}，我是<span className="accent">{config.assistantName}</span>
      </h1>

      <Composer big phase={props.phase} voiceActive={props.voiceActive} partial="" onSubmit={props.onSubmit} onMic={props.onMic} />
      <div className="home-voice-hint">
        {props.localVoice
          ? (props.voiceActive ? '点击布鲁或麦克风关闭语音 / Click Blue or the mic to end voice'
            : props.voiceEnabled ? '说“你好，布鲁”或 “Hello Blue”唤醒，也可以点击布鲁 / Say Hello Blue or click Blue'
            : '点击布鲁或麦克风开启语音 / Click Blue or the mic to start')
          : (props.voiceEnabled ? '麦克风已开启，说完稍等一下就好' : '先点麦克风开启语音，就能叫我啦')}
      </div>

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
