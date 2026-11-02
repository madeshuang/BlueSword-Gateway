import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './demo.css'
import { createBridge, type Bridge } from './bridge'
import { ConfirmBar } from './components/ConfirmBar'
import { Conversation } from './components/Conversation'
import { DemoConsole } from './components/DemoConsole'
import { Home } from './components/Home'
import { Sidebar } from './components/Sidebar'
import { VisionPanel } from './components/VisionPanel'
import { config } from './config'
import { SpeechController, type SpeechState } from './speech/controller'
import { initialState, reducer, type State } from './store'
import { isRevealed, useRevealTick } from './reveal'

/** 确认弹窗的出现时机：等布鲁把那句话说完（思考链打完、回复显示），再留一点阅读时间 */
const READ_MS_PER_CHAR = 90
const MAX_DEFER_MS = 8000

function useConfirmVisible(state: State) {
  useRevealTick()
  const [visible, setVisible] = useState(false)
  const confirm = state.confirm
  // 带有“等待确认”技能的那条助手消息
  const anchor = confirm
    ? [...state.messages].reverse().find((m) => m.role === 'assistant' && m.skills?.some((k) => k.status === 'pending'))
    : undefined
  const ready = !anchor || isRevealed(anchor.id)
  const textLen = anchor?.text.length ?? 0

  useEffect(() => {
    setVisible(false)
    if (!confirm) return
    // 兜底：无论如何，请求到达 8 秒后一定弹出
    const fallback = setTimeout(() => setVisible(true), Math.max(0, MAX_DEFER_MS - (Date.now() - confirm.receivedAt)))
    return () => clearTimeout(fallback)
  }, [confirm])

  useEffect(() => {
    if (!confirm || !ready) return
    const pause = anchor ? Math.min(2500, Math.max(900, textLen * READ_MS_PER_CHAR)) : 300
    const t = setTimeout(() => setVisible(true), pause)
    return () => clearTimeout(t)
  }, [confirm, ready, anchor, textLen])

  return !!confirm && visible
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const bridge = useRef<Bridge | null>(null)
  const speech = useRef<SpeechController | null>(null)
  const [voice, setVoice] = useState<SpeechState>({ enabled: false, tts: true, status: '' })

  useEffect(() => {
    const controller = new SpeechController(
      text => { dispatch({ type: 'local_user', text }); bridge.current?.send({ type: 'text_input', text }) },
      text => dispatch({ type: 'local_notice', text }),
      setVoice, text => dispatch({ type: 'asr', text, final: false }),
      () => dispatch({ type: 'wake' }),
    )
    speech.current = controller
    void controller.initialize()
    const unlock = () => { void controller.unlock().catch(() => {}) }
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => { window.removeEventListener('pointerdown', unlock); controller.close(); speech.current = null }
  }, [])

  useEffect(() => {
    const b = createBridge(config.agentWsUrl, event => { dispatch(event); speech.current?.onEvent(event) })
    bridge.current = b
    return () => b.close()
  }, [])

  // 长时间无交互回到首页
  useEffect(() => {
    if (state.backendMode === 'gdk_mock' || state.view !== 'session' || state.phase === 'acting' || state.task?.status === 'running' || state.confirm) return
    const t = setTimeout(() => {
      speech.current?.reset()
      bridge.current?.send({ type: 'reset' })
      dispatch({ type: 'go_home' })
    }, config.idleTimeoutMs)
    return () => clearTimeout(t)
  }, [state.view, state.phase, state.lastActivity, state.backendMode, state.task?.status, state.confirm])

  // 快捷键：T 切换明暗主题，Esc 回首页，空格切换语音
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, button, [contenteditable="true"]') || e.repeat) return
      if (e.key === 't' || e.key === 'T') {
        const root = document.documentElement
        root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light'
      } else if (e.key === 'Escape') {
        speech.current?.reset()
        bridge.current?.send({ type: 'reset' })
        dispatch({ type: 'go_home' })
      } else if (e.key === ' ') {
        e.preventDefault()
        void speech.current?.mic()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const actions = useMemo(
    () => ({
      submit: (text: string) => {
        speech.current?.interrupt()
        dispatch({ type: 'local_user', text })
        bridge.current?.send({ type: 'text_input', text })
      },
      mic: () => void speech.current?.mic(),
      home: () => {
        speech.current?.reset()
        bridge.current?.send({ type: 'reset' })
        dispatch({ type: 'go_home' })
      },
    }),
    [],
  )

  const showVision = !state.viewing && (state.detections.length > 0 || state.scanning || !!state.task || !!state.caption || state.recoveryRequired)

  const confirmId = state.confirm?.id
  const answerConfirm = useCallback(
    (approved: boolean) => {
      if (!confirmId) return
      bridge.current?.send({ type: 'confirm_response', id: confirmId, approved })
      dispatch({ type: 'confirm_answered', id: confirmId })
    },
    [confirmId],
  )
  const confirmVisible = useConfirmVisible(state)
  const confirmBar = state.confirm && confirmVisible ? <ConfirmBar request={state.confirm} onAnswer={answerConfirm} /> : undefined
  const voiceActive = voice.mode === 'local' ? !!voice.active : voice.enabled
  const speechSettings = <div className="speech-settings">
    {voice.status && <span role="status">{voice.status}</span>}
    <button aria-pressed={voiceActive} onClick={actions.mic}>
      {voiceActive ? '关闭语音' : '唤醒布鲁'}
    </button>
    <button aria-pressed={voice.tts} onClick={() => speech.current?.setTts(!voice.tts)}>播报{voice.tts ? '开' : '关'}</button>
  </div>

  if (state.backendMode === 'gdk_mock') return (
    <>
      {speechSettings}
      <DemoConsole state={state} voiceActive={voiceActive} onSubmit={actions.submit} onMic={actions.mic}
    onCancel={() => bridge.current?.send({ type: 'cancel_task', task_id: state.task?.id })}
    onTake={() => bridge.current?.send({ type: 'mock_take' })}
    onRecover={() => bridge.current?.send({ type: 'mock_recover' })} confirm={confirmBar} />
    </>
  )

  return (
    <div className={`app view-${state.view}`}>
      <Sidebar
        history={state.history}
        activeId={state.viewing}
        device={state.device}
        onNew={actions.home}
        phase={!voiceActive ? 'sleep' : state.viewing ? 'idle' : state.phase}
        onPet={actions.mic}
        onOpen={(id) => {
          speech.current?.reset()
          bridge.current?.send({ type: 'reset' })
          dispatch({ type: 'open_history', id })
        }}
      />
      <main className="main">
        {speechSettings}
        {state.view === 'home' ? (
          <Home phase={state.phase} voiceActive={voiceActive} voiceEnabled={voice.enabled} localVoice={voice.mode === 'local'} onSubmit={actions.submit} onMic={actions.mic} />
        ) : (
          <div className={`session ${showVision ? 'with-vision' : ''}`}>
            <Conversation
              voiceActive={voiceActive}
              readOnly={!!state.viewing}
              phase={state.viewing ? 'idle' : state.phase}
              partial={state.partial}
              messages={state.messages}
              confirm={confirmBar}
              glossary={state.glossary}
              onSubmit={actions.submit}
              onMic={actions.mic}
            />
            {showVision && (
              <VisionPanel
              cameraSrc={state.cameraSrc}
              detections={state.detections}
              caption={state.caption}
              scanning={state.scanning}
              task={state.task}
              backendMode={state.backendMode}
              protocol={state.protocol}
              glossary={state.glossary}
              recoveryRequired={state.recoveryRequired}
              onCancel={() => bridge.current?.send({ type: 'cancel_task', task_id: state.task?.id })}
              onTake={() => bridge.current?.send({ type: 'mock_take' })}
              onRecover={() => bridge.current?.send({ type: 'mock_recover' })}
              />
            )}
          </div>
        )}
      </main>
    </div>
  )
}
