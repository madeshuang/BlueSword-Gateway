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
import { initialState, persist, reducer, type State } from './store'
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
  }, [confirm?.id])

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
  const [voice, setVoice] = useState<SpeechState>({ enabled: false, listening: false, tts: false, status: '' })

  useEffect(() => {
    const controller = new SpeechController(
      text => { dispatch({ type: 'local_user', text }); bridge.current?.send({ type: 'text_input', text }) },
      text => dispatch({ type: 'local_notice', text }),
      setVoice, text => dispatch({ type: 'asr', text, final: false }),
      () => dispatch({ type: 'wake' }),
    )
    speech.current = controller
    void controller.initialize()
    const unlock = (event: PointerEvent) => {
      void controller.unlock().then(() => {
        if (!(event.target as HTMLElement).closest('.mic')) void controller.autoStart()
      }).catch(() => {})
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => { window.removeEventListener('pointerdown', unlock); controller.close(); speech.current = null }
  }, [])

  useEffect(() => {
    const b = createBridge(config.agentWsUrl, event => { dispatch(event); speech.current?.onEvent(event) })
    bridge.current = b
    return () => b.close()
  }, [])

  const latestState = useRef(state)
  latestState.current = state
  useEffect(() => {
    let saved: State | null = null
    const timer = setInterval(() => {
      const current = latestState.current
      if (current.messages !== saved?.messages || current.history !== saved?.history || current.sessionId !== saved?.sessionId || current.sessionBootId !== saved?.sessionBootId || current.visionDismissed !== saved?.visionDismissed || current.dismissedTaskId !== saved?.dismissedTaskId) {
        if (persist(current)) saved = current
      }
    }, 250)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const save = () => { persist(latestState.current) }
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', save)
    return () => { save(); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', save) }
  }, [])

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
        void speech.current?.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const actions = useMemo(
    () => ({
      submit: (text: string) => {
        speech.current?.activate()
        speech.current?.interrupt()
        dispatch({ type: 'local_user', text })
        bridge.current?.send({ type: 'text_input', text })
      },
      mic: () => void speech.current?.toggle(),
      home: () => {
        speech.current?.reset()
        bridge.current?.send({ type: 'reset' })
        dispatch({ type: 'go_home' })
      },
    }),
    [],
  )

  const showVision = !state.viewing && !state.visionDismissed && (!!state.task || state.recoveryRequired || state.showCamera && (state.detections.length > 0 || state.scanning || !!state.caption || !!state.cameraSrc))
  const displayedMessages = state.viewing ? state.history.find(h => h.id === state.viewing)?.messages ?? [] : state.messages
  const firstUser = state.messages.find(m => m.role === 'user')
  const sidebarHistory = firstUser ? [{ id: state.sessionId, title: firstUser.text, at: state.lastActivity, messages: state.messages }, ...state.history] : state.history

  const confirmId = state.confirm?.id
  const answerConfirm = useCallback(
    (approved: boolean) => {
      if (!confirmId) return
      bridge.current?.send({ type: 'confirm_response', id: confirmId, approved })

    },
    [confirmId],
  )
  const confirmVisible = useConfirmVisible(state)
  const confirmBar = state.confirm && confirmVisible ? <ConfirmBar request={state.confirm} onAnswer={answerConfirm} /> : undefined

  const voiceActive = voice.mode === 'local' ? !!voice.active : voice.listening

  const visionPanel = (
    <VisionPanel
      showCamera={state.showCamera}
      cameraSrc={state.cameraSrc}
      detections={state.detections}
      caption={state.caption}
      scanning={state.scanning}
      task={state.task?.id === state.dismissedTaskId ? null : state.task}
      backendMode={state.backendMode}
      glossary={state.glossary}
      recoveryRequired={state.recoveryRequired}
      onCancel={() => bridge.current?.send({ type: 'cancel_task', task_id: state.task?.id })}
      onTake={() => bridge.current?.send({ type: 'mock_take' })}
      onRecover={() => bridge.current?.send({ type: 'mock_recover' })}
    />
  )

  if (state.backendMode === 'gdk_mock') return (
    <>
      <DemoConsole state={state} voiceActive={voiceActive} voiceListening={voice.listening} voiceStatus={voice.status} onSubmit={actions.submit} onMic={actions.mic}
    onCancel={() => bridge.current?.send({ type: 'cancel_task', task_id: state.task?.id })}
    onTake={() => bridge.current?.send({ type: 'mock_take' })}
    onRecover={() => bridge.current?.send({ type: 'mock_recover' })} confirm={confirmBar} />
    </>
  )

  return (
    <div className={`app view-${state.view}`}>
      <Sidebar
        history={sidebarHistory}
        activeId={state.viewing ?? state.sessionId}
        device={state.device}
        onNew={actions.home}
        phase={!voiceActive ? 'sleep' : state.viewing ? 'idle' : state.phase}
        onPet={actions.mic}
        onOpen={(id) => {
          dispatch({ type: 'open_history', id })
        }}
      />
      <main className="main">
        {state.view === 'home' ? (
          <div className={`session ${showVision ? 'with-vision' : ''}`}>
            <Home voiceActive={voiceActive} phase={state.phase} voiceEnabled={voice.enabled} voiceListening={voice.listening} voiceStatus={voice.status} onSubmit={actions.submit} onMic={actions.mic} />
            {showVision && visionPanel}
          </div>
        ) : (
          <div className={`session ${showVision ? 'with-vision' : ''}`}>
            <Conversation
              voiceActive={voiceActive} localVoice={voice.mode === 'local'}
              readOnly={!!state.viewing}
              phase={state.viewing ? 'idle' : state.phase}
              partial={state.partial}
              messages={displayedMessages}
              voiceEnabled={voice.enabled} voiceListening={voice.listening}
              voiceStatus={voice.status}
              restored={state.restored && !state.viewing}
              confirm={state.viewing ? undefined : confirmBar}
              glossary={state.glossary}
              onSubmit={actions.submit}
              onMic={actions.mic}
            />
            {showVision && visionPanel}
          </div>
        )}
      </main>
    </div>
  )
}
