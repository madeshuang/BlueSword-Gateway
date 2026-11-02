// 演示模式：在没有后端时模拟 Agent 的完整事件流，用于调 UI 和现场兜底。
import { config } from './config'
import type { ClientEvent, Detection, ServerEvent, Task, Thought } from './types'

/** 模拟画面里的物品（归一化坐标），SimulatedFeed 也用它来画货架 */
export const SCENE: (Detection & { color: string })[] = [
  { id: 'poker', label: '扑克牌', score: 0.94, box: [0.16, 0.2, 0.09, 0.13], color: '#c2423a' },
  { id: 'tissue', label: '纸巾', score: 0.89, box: [0.52, 0.19, 0.2, 0.14], color: '#d9dde3' },
  { id: 'oreo', label: '奥利奥', score: 0.96, box: [0.12, 0.47, 0.22, 0.15], color: '#2a4ea8' },
  { id: 'yogurt1', label: '安慕希', score: 0.93, box: [0.44, 0.42, 0.09, 0.2], color: '#e8eef7' },
  { id: 'yogurt2', label: '安慕希', score: 0.91, box: [0.65, 0.42, 0.09, 0.2], color: '#e8eef7' },
  { id: 'water', label: '矿泉水', score: 0.9, box: [0.16, 0.73, 0.07, 0.18], color: '#9fd3e6' },
  { id: 'chips', label: '薯片', score: 0.88, box: [0.46, 0.75, 0.2, 0.16], color: '#e7b53c' },
]

const detections = (targetId?: string): Detection[] =>
  SCENE.map(({ color: _c, ...d }) => ({ ...d, target: d.id === targetId }))

const SCENE_CAPTION =
  '面前是一个三层货架：上层有一盒扑克牌和一包纸巾；中层左侧是奥利奥饼干，右侧并排放着两瓶安慕希酸奶；下层是矿泉水和薯片。'

type Emit = (ev: ServerEvent) => void

export function createMockAgent(emit: Emit) {
  let timers: number[] = []
  let t = 0
  let n = 0

  const at = (delay: number, fn: () => void) => {
    t += delay
    timers.push(window.setTimeout(fn, t))
  }
  const cancel = () => {
    timers.forEach(clearTimeout)
    timers = []
    t = 0
  }

  const say = (text: string, thoughts: Thought[] = [], gap = 650) => {
    const id = `a${++n}`
    at(0, () => emit({ type: 'assistant_start', id }))
    for (const th of thoughts) at(gap, () => emit({ type: 'thought', id, thought: th }))
    at(thoughts.length ? 500 : 300, () => emit({ type: 'phase', phase: 'speaking' }))
    for (let i = 0; i < text.length; i += 2) {
      const chunk = text.slice(i, i + 2)
      at(55, () => emit({ type: 'assistant_delta', id, text: chunk }))
    }
    at(200, () => emit({ type: 'assistant_end', id }))
  }

  const step = (delay: number, id: string, status: 'active' | 'done', detail?: string) =>
    at(delay, () => emit({ type: 'task_step', id, status, detail }))

  const look = () => {
    at(0, () => emit({ type: 'vision', scanning: true, detections: [], caption: '' }))
    at(1100, () => emit({ type: 'vision', scanning: false, detections: detections() }))
    at(400, () => emit({ type: 'vision', caption: SCENE_CAPTION }))
  }

  const scripts: { match: RegExp; run: (q: string) => void }[] = [
    {
      match: /甜|饼干|奥利奥|饿|零食/,
      run: () => {
        at(0, () => emit({ type: 'phase', phase: 'thinking' }))
        look()
        say('我看到货架中层有一盒奥利奥，甜甜的很适合你～我这就去帮你拿，稍等一下哦。', [
          { kind: 'see', text: '货架上有扑克牌、纸巾、奥利奥、安慕希、矿泉水和薯片' },
          { kind: 'understand', text: '想吃甜的 → 奥利奥饼干最符合' },
          { kind: 'decide', text: '前往货架，拿取中层左侧的奥利奥' },
        ])
        fetchTask('奥利奥', 'oreo')
      },
    },
    {
      match: /喝|酸奶|安慕希|渴/,
      run: () => {
        at(0, () => emit({ type: 'phase', phase: 'thinking' }))
        look()
        say('货架中层有安慕希酸奶，我帮你拿一瓶过来吧，马上就好！', [
          { kind: 'see', text: '中层右侧有两瓶安慕希酸奶，下层有矿泉水' },
          { kind: 'understand', text: '想喝点东西 → 酸奶更有趣，优先安慕希' },
          { kind: 'decide', text: '拿取离我最近的那瓶安慕希' },
        ])
        fetchTask('安慕希', 'yogurt1')
      },
    },
    {
      match: /扑克|牌/,
      run: () => {
        at(0, () => emit({ type: 'phase', phase: 'thinking' }))
        look()
        say('找到了，扑克牌在货架最上层，我去拿给你。', [
          { kind: 'see', text: '上层左侧有一盒扑克牌' },
          { kind: 'decide', text: '升高腰部，拿取上层的扑克牌' },
        ])
        fetchTask('扑克牌', 'poker')
      },
    },
    {
      match: /看到|看见|有什么|画面|眼前/,
      run: () => {
        at(0, () => emit({ type: 'phase', phase: 'thinking' }))
        look()
        say(SCENE_CAPTION + '想要哪一样，告诉我就行～', [
          { kind: 'see', text: '识别到 7 个物品，分布在货架三层' },
          { kind: 'understand', text: '用户想了解我看到的场景' },
        ])
        at(800, () => idle())
      },
    },
    {
      match: /能做什么|会什么|功能|你是谁/,
      run: () => {
        at(0, () => emit({ type: 'phase', phase: 'thinking' }))
        say(
          `我是${config.assistantName}，兰剑智能的具身智能助手。我能听懂你说的话，用眼睛看懂周围的环境，还能自己走到货架前，帮你把想要的东西拿过来。试试对我说「我想吃点甜的」吧！`,
          [{ kind: 'understand', text: '介绍自己的能力' }],
        )
        at(800, () => idle())
      },
    },
    {
      match: /兰剑|公司|介绍/,
      run: () => {
        at(0, () => emit({ type: 'phase', phase: 'thinking' }))
        // 演示文案，正式内容由后端系统提示词提供
        say('兰剑智能专注于智能物流与具身智能，把机器人带进真实的仓储和生产场景。今天我就在这里，用一次取物演示，让你看看具身智能是怎么工作的。', [
          { kind: 'understand', text: '介绍兰剑智能' },
        ])
        at(800, () => idle())
      },
    },
  ]

  // —— 机器人动作前的确认（与真实后端同一协议）
  let pendingConfirm: { id: string; approve: () => void; decline: (reason: 'declined' | 'timeout') => void } | null = null
  let confirmTimer = 0

  function fetchTask(name: string, targetId: string) {
    at(400, () => {
      const id = `c${++n}`
      emit({
        type: 'confirm_request',
        id,
        title: '机器人即将执行',
        skill: '取货 → 卸货',
        target: name,
        message: `布鲁将前往货架拿取${name}，再送到交付处交给你。`,
        steps: ['前往货架', `识别并抓取${name}`, '返回交付处，递到你手上'],
        note: '执行期间请与机器人保持一米以上距离，随时可以点击“停止任务”。',
        timeout_s: 60,
      })
      emit({ type: 'phase', phase: 'listening' })
      const close = (reason: 'approved' | 'declined' | 'timeout') => {
        window.clearTimeout(confirmTimer)
        pendingConfirm = null
        emit({ type: 'confirm_closed', id, reason })
        t = 0
      }
      pendingConfirm = {
        id,
        approve: () => {
          close('approved')
          runFetch(name, targetId)
        },
        decline: (reason) => {
          close(reason)
          at(0, () => emit({ type: 'phase', phase: 'thinking' }))
          say('好的，那先不拿了，想要的时候再叫我。')
          at(800, () => idle())
        },
      }
      confirmTimer = window.setTimeout(() => pendingConfirm?.decline('timeout'), 60_000)
    })
  }

  function runFetch(name: string, targetId: string) {
    const task: Task = {
      title: `拿取${name}`,
      steps: [
        { id: 'plan', label: '理解意图', status: 'done', detail: `目标：${name}` },
        { id: 'nav', label: '导航至货架', status: 'pending' },
        { id: 'locate', label: '视觉定位', status: 'pending' },
        { id: 'grasp', label: '抓取', status: 'pending' },
        { id: 'deliver', label: '返回递送', status: 'pending' },
      ],
    }
    at(600, () => {
      emit({ type: 'phase', phase: 'acting' })
      emit({ type: 'task', task })
    })
    step(300, 'nav', 'active', '规划路径 · 1.8 m')
    step(2600, 'nav', 'done', '已到达 · 定位误差 2 cm')
    step(200, 'locate', 'active', '头部 RGB-D 扫描中')
    at(0, () => emit({ type: 'vision', scanning: true }))
    at(1500, () => emit({ type: 'vision', scanning: false, detections: detections(targetId) }))
    step(200, 'locate', 'done', '置信度 0.96 · 距离 0.62 m')
    step(100, 'grasp', 'active', '右臂规划轨迹')
    step(2400, 'grasp', 'done', '夹爪闭合 · 力反馈正常')
    step(100, 'deliver', 'active', '返回递物点')
    step(2600, 'deliver', 'done', '已递出')
    say(`${name}来啦！请从我手里拿走就好～还需要别的吗？`)
    at(800, () => idle())
  }

  function idle() {
    emit({ type: 'phase', phase: 'listening' })
  }

  function respond(q: string) {
    const script = scripts.find((s) => s.match.test(q))
    if (script) return script.run(q)
    at(0, () => emit({ type: 'phase', phase: 'thinking' }))
    say(`你说的是「${q}」对吧？现在是演示模式，接入大模型之后我能聊的会更多～`)
    at(800, () => idle())
  }

  /** 模拟一次语音：唤醒 → 逐字识别 → 回复 */
  function simulateVoice(q: string) {
    at(0, () => emit({ type: 'wake' }))
    at(900, () => {})
    for (let i = 1; i <= q.length; i++) {
      const partial = q.slice(0, i)
      at(130, () => emit({ type: 'asr', text: partial, final: false }))
    }
    at(450, () => emit({ type: 'asr', text: q, final: true }))
    respond(q)
  }

  const voiceDemos = ['我想吃点甜的', '你看到了什么？', '帮我拿一瓶酸奶', '你能做什么？']
  let demoIdx = 0

  timers.push(window.setTimeout(() => emit({ type: 'device', online: true, name: '前端演示 · 无机器人' }), 600))

  return {
    send(ev: ClientEvent) {
      if (ev.type === 'confirm_response') {
        if (pendingConfirm?.id === ev.id) (ev.approved ? pendingConfirm.approve() : pendingConfirm.decline('declined'))
        return
      }
      if (ev.type === 'text_input' && pendingConfirm) {
        if (/取消|不要|不用|算了|别|不行/.test(ev.text)) pendingConfirm.decline('declined')
        else if (/可以|确认|允许|好的|行|没问题|去吧|是的/.test(ev.text)) pendingConfirm.approve()
        return
      }
      if (ev.type === 'reset') {
        window.clearTimeout(confirmTimer)
        pendingConfirm = null
        return cancel()
      }
      cancel()
      if (ev.type === 'text_input') {
        // 文本输入时前端已自行插入用户消息
        respond(ev.text)
      } else if (ev.type === 'wake_manual') {
        simulateVoice(voiceDemos[demoIdx++ % voiceDemos.length])
      }
    },
    close: cancel,
  }
}
