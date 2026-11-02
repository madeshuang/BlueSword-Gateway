// 前后端事件协议：后端（Agent）通过 WebSocket 推送 ServerEvent，前端发送 ClientEvent。
// 普通模拟与现场运行均连接后端，使用同一套事件协议。

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting'

export type BackendMode = 'mock' | 'gdk_mock' | 'gdk' | 'lanjian_http'

/** 网关与机器人之间的一条协议报文（lanjian_http 模式） */
export interface ProtocolEntry {
  direction: 'in' | 'out'
  path: string
  body: Record<string, unknown>
  reply?: Record<string, unknown> | null
  at: number
}

export type ThoughtKind = 'see' | 'understand' | 'decide'

export interface Thought {
  kind: ThoughtKind
  text: string
}

/** 大模型调用的技能（取货 / 卸货 / 环视…），gdk 为该技能组合的 GDK 接口 */
export interface SkillCall {
  call_id: string
  name: string
  title: string
  target?: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  detail?: string
  gdk?: string[]
  /** 查询库存的结果：每样东西剩几件 */
  stock?: { name: string; count: number }[]
}

/** 机器人动作前的确认请求：用户允许后才会执行 */
export interface ConfirmRequest {
  language?: 'zh' | 'en'
  id: string
  title: string
  skill?: string
  target?: string
  message: string
  steps?: string[]
  note?: string
  timeout_s: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  interrupted?: boolean
  streaming?: boolean
  thoughts?: Thought[]
  /** 大模型思考链（流式） */
  reasoning?: string
  /** 思考用时；有值表示思考已结束 */
  reasoningMs?: number
  skills?: SkillCall[]
}

/** box 为归一化坐标 [x, y, w, h]，范围 0~1，相对于相机画面 */
export interface Detection {
  id: string
  label: string
  score: number
  box: [number, number, number, number]
  target?: boolean
}

export type StepStatus = 'pending' | 'active' | 'done' | 'failed'

export interface TaskStep {
  id: string
  label: string
  status: StepStatus
  detail?: string
  gdk?: string[]
  /** 该步骤开始的时间（秒，Unix） */
  startedAt?: number
}

export interface Task {
  id?: string
  created_at?: number
  last_progress_at?: number | null
  status?: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'resolved'
  recovery_required?: boolean
  error?: { code: string; message: string } | null
  completion_note?: string | null
  title: string
  steps: TaskStep[]
}

export type ServerEvent =
  | { type: 'voice_status'; session_id?: string; mode: 'local'; enabled: boolean; active: boolean; tts: boolean; status: string; phase: string; error: string }
  | { type: 'wake' }
  | { type: 'phase'; phase: Phase; task_id?: string }
  | { type: 'asr'; text: string; final: boolean }
  | { type: 'assistant_start'; id: string }
  | { type: 'thought'; id: string; thought: Thought }
  | { type: 'assistant_delta'; id: string; text: string }
  | { type: 'assistant_end'; id: string }
  | { type: 'reasoning_delta'; id: string; text: string }
  | { type: 'reasoning_end'; id: string; ms: number }
  | ({ type: 'skill'; id: string } & SkillCall)
  | ({ type: 'confirm_request' } & ConfirmRequest)
  | { type: 'confirm_refresh'; id: string; timeout_s: number }
  | { type: 'confirm_closed'; id: string; reason: 'approved' | 'declined' | 'timeout' | 'cancelled' | 'updated' }
  | { type: 'vision'; detections?: Detection[]; caption?: string; scanning?: boolean; task_id?: string }
  | { type: 'camera'; src: string | null; task_id?: string }
  | { type: 'task'; task: Task | null }
  | { type: 'task_step'; id: string; status: StepStatus; detail?: string; gdk?: string[]; at?: number }
  | { type: 'device'; online: boolean; name: string }
  | { type: 'backend'; mode: BackendMode; show_camera?: boolean; boot_id?: string; recovery_required: boolean; glossary?: Record<string, string> }
  | { type: 'session_end'; task_id?: string | null }

export type ClientEvent =
  | { type: 'text_input'; text: string; request_id?: string }
  | { type: 'wake_manual' }
  | { type: 'reset' }
  | { type: 'cancel_task'; task_id?: string }
  | { type: 'mock_take' }
  | { type: 'mock_recover' }
  | { type: 'confirm_response'; id: string; approved: boolean }
