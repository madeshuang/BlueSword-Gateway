import { config } from './config'
import type { BackendMode, ConfirmRequest, Detection, Message, Phase, ServerEvent, Task } from './types'

export interface HistoryItem {
  id: string
  title: string
  at: number
  messages: Message[]
}

export interface State {
  sessionId: string
  sessionBootId: string | null
  backendBootId: string | null
  backendReady: boolean
  homeAfterRestart: boolean
  restored: boolean
  showCamera: boolean
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
  /** 新对话收起旧任务展示；后台任务和故障锁定仍独立保留。 */
  visionDismissed: boolean
  dismissedTaskId: string | null
  /** 等待用户允许的机器人动作；null 表示没有弹窗 */
  confirm: (ConfirmRequest & { receivedAt: number }) | null
  backendMode: BackendMode | 'demo' | 'unknown'
  /** 内部代号 → 中文，用于思考链显示 */
  glossary: Record<string, string>
  recoveryRequired: boolean
  device: { online: boolean; name: string }
  history: HistoryItem[]
  lastActivity: number
}

const HISTORY_KEY = 'bluesword.history.v2'

const CURRENT_KEY = 'bluesword.current.v1'

function safeMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return []
  return value.filter((m): m is Message => !!m && typeof m.id === 'string' && typeof m.text === 'string' && ['user', 'assistant'].includes(m.role))
    .map(m => ({ ...m, streaming: false, interrupted: m.interrupted || !!m.streaming,
      reasoningMs: m.reasoningMs ?? 0,
      skills: (Array.isArray(m.skills) ? m.skills : [])?.filter(k => k && typeof k.call_id === 'string').map(k => ({ ...k,
        status: k.status === 'pending' || k.status === 'running' ? 'interrupted' as const : k.status })) }))
}

function loadHistory(): HistoryItem[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    if (!Array.isArray(saved)) return []
    return saved.filter(h => h && typeof h.id === 'string' && typeof h.title === 'string' && typeof h.at === 'number')
      .slice(0, 19).map(h => ({ ...h, messages: safeMessages(h.messages) }))
  } catch { return [] }
}

function loadCurrent(): Partial<State> {
  try {
    const saved = JSON.parse(localStorage.getItem(CURRENT_KEY) ?? 'null')
    if (!saved || typeof saved.id !== 'string') return {}
    const messages = safeMessages(saved.messages)
    const sessionBootId = typeof saved.bootId === 'string' ? saved.bootId : null
    return { sessionBootId, visionDismissed: saved.visionDismissed === true,
      dismissedTaskId: typeof saved.dismissedTaskId === 'string' ? saved.dismissedTaskId : null,
      ...(messages.length ? { sessionId: saved.id, messages, view: 'session', restored: true } : {}) }
  } catch { return {} }
}

export function persist(state: State): boolean {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, 19)))
    // Do not save image data, credentials or live confirmation capabilities.
    localStorage.setItem(CURRENT_KEY, JSON.stringify({ id: state.sessionId, bootId: state.sessionBootId, messages: state.messages,
      visionDismissed: state.visionDismissed, dismissedTaskId: state.dismissedTaskId }))
    return true
  } catch { return false }
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
  sessionId: crypto.randomUUID(),
  sessionBootId: null,
  backendBootId: null,
  backendReady: false,
  homeAfterRestart: false,
  restored: false,
  showCamera: true,
  visionDismissed: false,
  dismissedTaskId: null,
  ...loadCurrent(),
  cameraSrc: null,
  device: { online: false, name: config.agentWsUrl ? '机器人后端' : '前端演示' },
  backendMode: config.agentWsUrl ? 'unknown' : 'demo',
  recoveryRequired: false,
  glossary: {},
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
  const first = state.messages.find((m) => m.role === 'user')
  if (!first) return state.history
  const item = { id: state.sessionId, title: first.text, at: Date.now(), messages: safeMessages(state.messages) }
  const history = [item, ...state.history.filter(h => h.id !== item.id)].slice(0, 19)
  return history
}

const reset = (state: State, extra: Partial<State> = {}): State => ({
  ...state,
  ...freshSession,
  sessionId: crypto.randomUUID(),
  sessionBootId: state.backendBootId,
  homeAfterRestart: false,
  restored: false,
  cameraSrc: null,
  task: state.task?.status === 'running' || state.recoveryRequired ? state.task : null,
  history: archive(state),
  lastActivity: Date.now(),
  ...extra,
})

export function reducer(state: State, action: Action): State {
  if (action.type === 'voice_status') return state
  const s: State = { ...state, lastActivity: Date.now() }
  switch (action.type) {
    case 'wake':
      return { ...s, homeAfterRestart: false, view: 'session', phase: 'listening', partial: '' }
    case 'phase':
      if (action.task_id && action.task_id === s.dismissedTaskId) return s
      return { ...s, phase: action.phase, view: action.phase === 'idle' || s.homeAfterRestart ? s.view : 'session' }
    case 'asr':
      if (!action.final) return { ...s, ...(action.text ? { view: 'session' as const } : {}), partial: action.text }
      return { ...s, viewing: null, restored: false, homeAfterRestart: false, sessionBootId: s.backendBootId ?? s.sessionBootId, view: 'session', partial: '', messages: [...s.messages, { id: uid(), role: 'user', text: action.text }] }
    case 'local_user':
      return { ...s, viewing: null, restored: false, homeAfterRestart: false, sessionBootId: s.backendBootId ?? s.sessionBootId, view: 'session', messages: [...s.messages, { id: uid(), role: 'user', text: action.text }] }
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
    case 'confirm_refresh':
      return s.confirm?.id === action.id ? { ...s, confirm: { ...s.confirm, timeout_s: action.timeout_s, receivedAt: Date.now() } } : s
    case 'confirm_request': {
      const { type: _t, ...request } = action
      return { ...s, view: 'session', confirm: { ...request, receivedAt: Date.now() } }
    }
    case 'confirm_closed':
    case 'confirm_answered':
      return s.confirm?.id === action.id ? { ...s, confirm: null } : s
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
    case 'task_commentary':
      if (action.task_id === s.dismissedTaskId || action.task_id !== s.task?.id) return s
      return { ...s, messages: updateMsg(s.messages, action.id, m => ({ ...m,
        skills: m.skills?.map(k => k.call_id === action.call_id && k.status === 'running'
          ? { ...k, commentary: action.text, task_id: action.task_id } : k),
      })) }
    case 'vision':
      if (action.task_id && action.task_id === s.dismissedTaskId) return s
      return {
        ...s,
        // 单独环视没有任务编号，可在新对话中再次打开视野；清空画面的事件不展开。
        visionDismissed: !action.task_id && (action.caption || action.scanning || action.detections?.length) ? false : s.visionDismissed,
        detections: action.detections ?? s.detections,
        caption: action.caption ?? s.caption,
        scanning: action.scanning ?? s.scanning,
      }
    case 'camera':
      if (action.task_id && action.task_id === s.dismissedTaskId) return s
      return { ...s, cameraSrc: action.src }
    case 'task':
      return { ...s, task: action.task, recoveryRequired: action.task?.recovery_required ?? false,
        visionDismissed: action.task?.id ? action.task.id === s.dismissedTaskId : s.visionDismissed }
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
        ...(!action.online ? { restored: state.messages.length > 0, confirm: null, partial: '', messages: safeMessages(state.messages) } : {}),
      }
    case 'backend': {
      let next = state
      if (action.boot_id && !state.backendReady) {
        const reloading = typeof performance !== 'undefined'
          && (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload'
        if (state.sessionBootId && state.sessionBootId !== action.boot_id && !reloading) {
          next = reset(state, { homeAfterRestart: true })
        }
        // Legacy history has no boot marker: adopt it without discarding any text.
        next = { ...next, sessionBootId: action.boot_id, backendReady: true }
      }
      // Reconnection in an already open tab never navigates or rebinds its saved conversation.
      return { ...next, backendBootId: action.boot_id ?? next.backendBootId,
        backendMode: action.mode, recoveryRequired: action.recovery_required,
        glossary: action.glossary ?? next.glossary, showCamera: action.show_camera ?? next.showCamera }
    }
    case 'open_history': {
      if (action.id === state.sessionId) return { ...state, homeAfterRestart: false, view: 'session', viewing: null }
      const item = state.history.find((h) => h.id === action.id)
      if (!item) return state
      return { ...state, homeAfterRestart: false, view: 'session', viewing: item.id }
    }
    case 'session_end':
      return action.task_id ? { ...state, visionDismissed: true, dismissedTaskId: action.task_id } : state
    case 'go_home':
      return reset(state, { visionDismissed: true, dismissedTaskId: state.task?.id ?? state.dismissedTaskId,
        homeAfterRestart: true })
  }
}
