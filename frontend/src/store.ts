import { config } from './config'
import type { BackendMode, ConfirmRequest, Detection, Message, Phase, ProtocolEntry, ServerEvent, Task } from './types'

export interface HistoryItem {
  id: string
  title: string
  at: number
  messages: Message[]
}

export interface State {
  view: 'home' | 'session'
  phase: Phase
  partial: string
  messages: Message[]
  /** 正在回看的历史对话 id；null 表示当前实时会话 */
  viewing: string | null
  detections: Detection[]
  caption: string
  scanning: boolean
  cameraSrc: string | null
  task: Task | null
  /** 等待用户允许的机器人动作；null 表示没有弹窗 */
  confirm: (ConfirmRequest & { receivedAt: number }) | null
  backendMode: BackendMode | 'demo' | 'unknown'
  /** 最近的机器人协议报文 */
  protocol: ProtocolEntry[]
  /** 内部代号 → 中文，用于思考链显示 */
  glossary: Record<string, string>
  recoveryRequired: boolean
  device: { online: boolean; name: string }
  history: HistoryItem[]
  lastActivity: number
}

const HISTORY_KEY = 'bluesword.history.v2'

function demoHistory(): HistoryItem[] {
  const now = Date.now()
  const mk = (q: string, a: string, minsAgo: number): HistoryItem => ({
    id: `seed-${minsAgo}`,
    title: q,
    at: now - minsAgo * 60_000,
    messages: [
      { id: `seed-${minsAgo}-u`, role: 'user', text: q },
      { id: `seed-${minsAgo}-a`, role: 'assistant', text: a },
    ],
  })
  return [
    mk('帮我拿一瓶安慕希', '好的，安慕希已经递到你手上啦～', 6),
    mk('货架上都有什么？', '货架上有扑克牌、纸巾、奥利奥、安慕希、矿泉水和薯片。', 18),
    mk('你能做什么？', '我能听懂你说的话、看懂周围的环境，还能帮你拿东西。', 42),
  ]
}

function loadHistory(): HistoryItem[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as HistoryItem[]
    if (saved.length === 0 && !config.agentWsUrl) return demoHistory()
    return saved
  } catch {
    return []
  }
}

const freshSession = {
  view: 'home' as const,
  phase: 'idle' as Phase,
  partial: '',
  messages: [] as Message[],
  viewing: null,
  detections: [] as Detection[],
  caption: '',
  scanning: false,
  task: null,
  confirm: null as (ConfirmRequest & { receivedAt: number }) | null,
}

export const initialState: State = {
  ...freshSession,
  cameraSrc: null,
  device: { online: false, name: config.agentWsUrl ? '机器人后端' : '前端演示' },
  backendMode: config.agentWsUrl ? 'unknown' : 'demo',
  recoveryRequired: false,
  glossary: {},
  protocol: [],
  history: loadHistory(),
  lastActivity: Date.now(),
}

export type Action =
  | ServerEvent
  | { type: 'local_user'; text: string }
  | { type: 'local_notice'; text: string }
  | { type: 'go_home' }
  | { type: 'confirm_answered'; id: string }
  | { type: 'open_history'; id: string }

let seq = 0
const uid = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`

function updateMsg(messages: Message[], id: string, fn: (m: Message) => Message): Message[] {
  return messages.map((m) => (m.id === id ? fn(m) : m))
}

/** 把当前实时会话存进历史（回看历史时不重复存） */
function archive(state: State): HistoryItem[] {
  if (state.viewing) return state.history
  const first = state.messages.find((m) => m.role === 'user')
  if (!first) return state.history
  const item = { id: uid(), title: first.text, at: Date.now(), messages: state.messages.map((m) => ({ ...m, streaming: false })) }
  const history = [item, ...state.history].slice(0, 20)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  return history
}

const reset = (state: State, extra: Partial<State> = {}): State => ({
  ...state,
  ...freshSession,
  task: state.task?.status === 'running' || state.recoveryRequired ? state.task : null,
  history: archive(state),
  lastActivity: Date.now(),
  ...extra,
})

export function reducer(state: State, action: Action): State {
  if (action.type === 'voice_status') return state
  // 任何来自 Agent 的实时事件都会把界面从「回看历史」拉回当前会话
  let s: State = { ...state, lastActivity: Date.now() }
  if (state.viewing && action.type !== 'open_history' && action.type !== 'go_home' && action.type !== 'device' && action.type !== 'camera') {
    s = { ...s, viewing: null, messages: [] }
  }
  switch (action.type) {
    case 'wake':
      return { ...s, view: 'session', phase: 'listening', partial: '' }
    case 'phase':
      return { ...s, phase: action.phase, view: action.phase === 'idle' ? s.view : 'session' }
    case 'asr':
      if (!action.final) return { ...s, ...(action.text ? { view: 'session' as const } : {}), partial: action.text }
      return { ...s, view: 'session', partial: '', messages: [...s.messages, { id: uid(), role: 'user', text: action.text }] }
    case 'local_user':
      return { ...s, view: 'session', messages: [...s.messages, { id: uid(), role: 'user', text: action.text }] }
    case 'local_notice':
      return { ...s, view: 'session', messages: [...s.messages, { id: uid(), role: 'assistant', text: action.text }] }
    case 'assistant_start':
      return { ...s, messages: [...s.messages, { id: action.id, role: 'assistant', text: '', streaming: true, thoughts: [] }] }
    case 'thought':
      return { ...s, messages: updateMsg(s.messages, action.id, (m) => ({ ...m, thoughts: [...(m.thoughts ?? []), action.thought] })) }
    case 'assistant_delta':
      return { ...s, messages: updateMsg(s.messages, action.id, (m) => ({ ...m, text: m.text + action.text })) }
    case 'assistant_end':
      return {
        ...s,
        messages: updateMsg(s.messages, action.id, (m) => ({
          ...m,
          streaming: false,
          reasoningMs: m.reasoning && m.reasoningMs === undefined ? 0 : m.reasoningMs,
        })),
      }
    case 'confirm_request': {
      const { type: _t, ...request } = action
      return { ...s, view: 'session', confirm: { ...request, receivedAt: Date.now() } }
    }
    case 'confirm_closed':
    case 'confirm_answered':
      return s.confirm?.id === action.id ? { ...s, confirm: null } : s
    case 'protocol': {
      const { type: _t, ...entry } = action
      return { ...state, protocol: [...state.protocol, entry].slice(-40) }
    }
    case 'reasoning_delta':
      return { ...s, messages: updateMsg(s.messages, action.id, (m) => ({ ...m, reasoning: (m.reasoning ?? '') + action.text })) }
    case 'reasoning_end':
      return { ...s, messages: updateMsg(s.messages, action.id, (m) => ({ ...m, reasoningMs: action.ms })) }
    case 'skill': {
      const { type: _t, id, ...call } = action
      return {
        ...s,
        messages: updateMsg(s.messages, id, (m) => {
          const skills = m.skills ?? []
          const found = skills.some((k) => k.call_id === call.call_id)
          return { ...m, skills: found ? skills.map((k) => (k.call_id === call.call_id ? { ...k, ...call } : k)) : [...skills, call] }
        }),
      }
    }
    case 'vision':
      return {
        ...s,
        detections: action.detections ?? s.detections,
        caption: action.caption ?? s.caption,
        scanning: action.scanning ?? s.scanning,
      }
    case 'camera':
      return { ...s, cameraSrc: action.src }
    case 'task':
      return { ...s, task: action.task, recoveryRequired: action.task?.recovery_required ?? false }
    case 'task_step':
      if (!s.task) return s
      return {
        ...s,
        task: {
          ...s.task,
          steps: s.task.steps.map((st) =>
            st.id === action.id
              ? {
                  ...st,
                  status: action.status,
                  detail: action.detail ?? st.detail,
                  gdk: action.gdk ?? st.gdk,
                  startedAt: st.startedAt ?? action.at ?? Date.now() / 1000,
                }
              : st,
          ),
        },
      }
    case 'device':
      return { ...state, device: { online: action.online, name: action.name },
        ...(!action.online ? { confirm: null, partial: '', messages: state.messages.map(m => ({ ...m, streaming: false })) } : {}),
      }
    case 'backend':
      return { ...state, backendMode: action.mode, recoveryRequired: action.recovery_required, glossary: action.glossary ?? state.glossary }
    case 'open_history': {
      const item = state.history.find((h) => h.id === action.id)
      if (!item) return state
      return reset(state, { view: 'session', viewing: item.id, messages: item.messages })
    }
    case 'session_end':
    case 'go_home':
      return reset(state)
  }
}
