import { useEffect, useRef } from 'react'
import shell from '../assets/blue-shell.webp'
import type { Phase } from '../types'

/*
 * 布鲁：外壳为渲染好的透明素材（blue-shell.webp），
 * 眼睛、跳跃、转身、光环由 rAF 循环实时驱动。
 * 外壳与眼睛的坐标标定沿用 GPT 交付包 character.js 的布局（viewBox 400×400）；
 * 不依赖 aora-bot 引擎与表情数据。
 */

const CAPSULE = 'M-8-12 C-8-22 8-22 8-12 L8 12 C8 22-8 22-8 12Z'
const SMILE = 'M-12 6 C-10-3-7-11-1-12 C5-13 10-7 12 2 C14 9 9 12 5 8 C1 3-1 2-5 7 C-9 12-14 11-12 6Z'
const VISOR = 'M86 137 C115 100 188 105 253 135 C310 152 318 191 297 231 C275 272 206 270 137 249 C78 232 65 181 86 137Z'
const EYE_BASE = [
  [124, 194],
  [221, 212],
] as const
/** 身体缩放/旋转的支点：底部中心 */
const PX = 203
const PY = 318

type PetPhase = Phase | 'sleep'

const BUBBLE: Partial<Record<PetPhase, string>> = {
  sleep: 'Zzz · 休眠中',
  listening: '我在听…',
  thinking: '让我想想…',
  speaking: '正在回答',
  acting: '执行任务中',
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** 一次跳跃的形变曲线：蓄力压扁 → 腾空拉伸 → 落地回弹 */
function hopCurve(t: number, height: number) {
  const PREP = 0.16
  const AIR = 0.62
  if (t < PREP) {
    const k = Math.sin((t / PREP) * Math.PI * 0.5)
    return { y: 0, sx: 1 + 0.07 * k, sy: 1 - 0.1 * k }
  }
  if (t < PREP + AIR) {
    const k = (t - PREP) / AIR
    const y = -height * Math.sin(k * Math.PI)
    const stretch = Math.abs(Math.cos(k * Math.PI)) // 起跳和下落时拉长，最高点恢复
    return { y, sx: 1 - 0.035 * stretch, sy: 1 + 0.06 * stretch }
  }
  const k = (t - PREP - AIR) / (1 - PREP - AIR)
  const s = Math.sin(k * Math.PI) * (1 - k * 0.3)
  return { y: 0, sx: 1 + 0.08 * s, sy: 1 - 0.11 * s }
}

export function BluePet({ phase, onActivate }: { phase: PetPhase; onActivate: () => void }) {
  const root = useRef<HTMLButtonElement>(null)
  const body = useRef<SVGGElement>(null)
  const eyes = useRef<(SVGGElement | null)[]>([])
  const shapes = useRef<(SVGPathElement | null)[]>([])
  const halo = useRef<SVGGElement>(null)
  const sweep = useRef<SVGEllipseElement>(null)
  const shadow = useRef<SVGEllipseElement>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const pointer = { x: 0, y: 0, at: -1e9 }
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX
      pointer.y = e.clientY
      pointer.at = performance.now()
    }
    addEventListener('pointermove', onMove)

    let raf = 0
    let last = performance.now()
    const gaze = { x: 0, y: 0 }
    let wander = { x: 0, y: 0 }
    let nextWander = 0
    let nextBlink = last + 2000
    let blinkStart = -1
    // 朝向：1 = 素材原始朝向（面朝左），-1 = 镜像（面朝右，看向内容区）
    let facingTarget = -1
    let facing = -1
    let facingVel = 0
    let hop: { start: number; dur: number; h: number; then: number } | null = null
    let nextHop = last + 1500
    let lean = 0
    let lastPhase: PetPhase = phaseRef.current

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const p = phaseRef.current
      const ease = 1 - Math.exp(-dt * 10)

      // —— 鼠标位置（相对于自身中心）
      const rect = root.current?.getBoundingClientRect()
      const cx = rect ? rect.left + rect.width / 2 : 0
      const cy = rect ? rect.top + rect.height * 0.55 : 0
      const tracking = p !== 'sleep' && now - pointer.at < 4000
      const dx = pointer.x - cx
      const dy = pointer.y - cy

      // —— 朝向（带回差，避免抖动）；弹簧穿过 0 的那一刻就像在转身
      if (tracking) {
        if (dx > 60) facingTarget = -1
        else if (dx < -60) facingTarget = 1
      } else facingTarget = -1
      facingVel += ((facingTarget - facing) * 180 - facingVel * 18) * dt
      facing = clamp(facing + facingVel * dt, -1.05, 1.05)

      // —— 视线（世界坐标 → 身体局部坐标需要按朝向翻转）
      let gx: number
      let gy: number
      if (p === 'sleep') {
        gx = 0
        gy = 4
      } else if (p === 'thinking') {
        gx = 7
        gy = -7
      } else if (tracking) {
        gx = clamp(dx / 350, -1, 1) * 11
        gy = clamp(dy / 300, -1, 1) * 8
      } else {
        if (now > nextWander) {
          wander = Math.random() < 0.45 ? { x: 0, y: 0 } : { x: (Math.random() - 0.5) * 18, y: (Math.random() - 0.5) * 10 }
          nextWander = now + 1500 + Math.random() * 2500
        }
        gx = wander.x
        gy = wander.y
      }
      const localGx = facing >= 0 ? gx : -gx
      gaze.x += (localGx - gaze.x) * ease
      gaze.y += (gy - gaze.y) * ease

      // —— 跳跃节奏
      if (p !== lastPhase) {
        if (p === 'sleep') hop = null
        if (p === 'listening' || p === 'speaking') nextHop = now // 被叫到时先蹦一下
        lastPhase = p
      }
      if (!reduced && !hop && now > nextHop) {
        if (p === 'idle') {
          const double = Math.random() < 0.3
          hop = { start: now, dur: 620, h: 24 + Math.random() * 10, then: double ? 1 : 0 }
          nextHop = now + 2600 + Math.random() * 3200
        } else if (p === 'speaking') {
          hop = { start: now, dur: 420, h: 9, then: 0 }
          nextHop = now + 460 + Math.random() * 180
        } else if (p === 'listening') {
          hop = { start: now, dur: 560, h: 14, then: 0 }
          nextHop = now + 3200
        } else if (p === 'acting') {
          hop = { start: now, dur: 480, h: 12, then: 1 }
          nextHop = now + 2400
        } else {
          nextHop = now + 1000
        }
      }
      let hy = 0
      let sx = 1
      let sy = 1
      if (hop) {
        const t = (now - hop.start) / hop.dur
        if (t >= 1) {
          hop = hop.then > 0 ? { start: now + 40, dur: hop.dur * 0.85, h: hop.h * 0.6, then: hop.then - 1 } : null
        } else if (t >= 0) {
          const c = hopCurve(t, hop.h)
          hy = c.y
          sx = c.sx
          sy = c.sy
        }
      }

      // —— 摇摆与倾斜
      const sway = reduced ? 0 : p === 'thinking' ? Math.sin(now / 520) * 4 : Math.sin(now / 1700) * 1.2
      const leanTarget = tracking ? clamp(dx / 500, -1, 1) * 4 : 0
      lean = lerp(lean, leanTarget, ease * 0.5)
      const airTilt = hy < 0 ? (facing >= 0 ? -1 : 1) * clamp(-hy / 30, 0, 1) * 4 : 0
      const breathe = reduced ? 0 : Math.sin(now / 1150) * 1.5
      const rot = sway + lean + airTilt

      // 转身时横向收窄：facing 穿过 0 时最窄
      const turnScale = (facing < 0 ? -1 : 1) * Math.max(0.08, Math.abs(facing))
      body.current?.setAttribute(
        'transform',
        `translate(0 ${(hy + breathe).toFixed(2)}) translate(${PX} ${PY}) rotate(${rot.toFixed(2)}) scale(${(sx * turnScale).toFixed(3)} ${sy.toFixed(3)}) translate(${-PX} ${-PY})`,
      )

      // —— 影子随高度缩小变淡
      const lift = clamp(-hy / 34, 0, 1)
      shadow.current?.setAttribute('transform', `translate(${PX} 326) scale(${(1 - lift * 0.35).toFixed(3)}) translate(${-PX} -326)`)
      shadow.current?.setAttribute('opacity', (1 - lift * 0.5).toFixed(2))

      // —— 眼睛
      if (now > nextBlink && p !== 'speaking') {
        blinkStart = now
        nextBlink = now + (Math.random() < 0.2 ? 250 : 2400 + Math.random() * 3000) // 偶尔连眨
      }
      const bt = blinkStart < 0 ? 1 : (now - blinkStart) / 150
      const blink = bt >= 1 ? 1 : Math.max(0.06, Math.abs(1 - 2 * bt))
      for (let i = 0; i < 2; i++) {
        const [bx, by] = EYE_BASE[i]
        let ey = blink * (hy < -4 ? 1.08 : 1)
        if (p === 'listening') ey *= 1.1
        if (p === 'thinking') ey *= i ? 0.7 : 0.9
        if (p === 'acting') ey *= 0.82
        if (p === 'sleep') ey = 0.08
        const ex = p === 'listening' ? 1.08 : 1
        eyes.current[i]?.setAttribute(
          'transform',
          `translate(${(bx + gaze.x).toFixed(2)} ${(by + gaze.y).toFixed(2)}) rotate(17) scale(${ex} ${ey.toFixed(3)})`,
        )
      }
      const d = p === 'speaking' ? SMILE : CAPSULE
      for (const s of shapes.current) if (s && s.getAttribute('d') !== d) s.setAttribute('d', d)

      // —— 光环：平时很淡，被唤醒后亮起
      const active = p !== 'idle' && p !== 'sleep'
      const pulse = p === 'listening' || p === 'speaking' ? (Math.sin(now / 200) + 1) / 2 : 0
      halo.current?.setAttribute('opacity', ((active ? 0.85 : 0.3) + pulse * 0.15 - lift * 0.2).toFixed(2))
      sweep.current?.setAttribute('stroke-dashoffset', reduced ? '0' : ((-now * (active ? 0.3 : 0.06)) / 95).toFixed(1))

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener('pointermove', onMove)
    }
  }, [])

  const bubble = BUBBLE[phase]
  const label = phase === 'sleep' ? '唤醒布鲁 / Wake Blue' : '关闭语音，让布鲁休眠 / End voice'

  return (
    <button ref={root} className="pet" data-phase={phase} onClick={onActivate} title={label} aria-label={label} aria-pressed={phase !== 'sleep'}>
      <span className={`pet-bubble ${bubble ? 'show' : ''}`}>{bubble ?? ''}</span>
      <svg viewBox="20 40 366 320" className="pet-svg" aria-label="布鲁">
        <defs>
          <radialGradient id="pet-shadow">
            <stop offset="0%" stopColor="#3a4048" stopOpacity="0.28" />
            <stop offset="60%" stopColor="#3a4048" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#3a4048" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="pet-eye" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d8ffff" />
            <stop offset="100%" stopColor="#7cffff" />
          </linearGradient>
          <filter id="pet-blur" x="-50%" y="-200%" width="200%" height="500%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
          <filter id="pet-eyeglow" x="-180%" y="-100%" width="460%" height="300%">
            <feGaussianBlur stdDeviation="1.1" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="pet-bloom" x="-180%" y="-100%" width="460%" height="300%">
            <feGaussianBlur stdDeviation="3.8" />
          </filter>
          <clipPath id="pet-visor">
            <path d={VISOR} />
          </clipPath>
        </defs>

        <ellipse ref={shadow} cx={PX} cy="326" rx="118" ry="16" fill="url(#pet-shadow)" />
        <g ref={halo} fill="none">
          <ellipse cx={PX} cy="324" rx="122" ry="15" stroke="#3fd8e6" strokeWidth="4" opacity="0.35" filter="url(#pet-blur)" />
          <ellipse cx={PX} cy="324" rx="122" ry="15" stroke="#3fd8e6" strokeWidth="1.2" opacity="0.8" />
          <ellipse ref={sweep} cx={PX} cy="324" rx="122" ry="15" pathLength={100} stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="14 86" opacity="0.8" />
        </g>

        <g ref={body}>
          <image href={shell} x="46" y="33" width="314" height="314" />
          <g clipPath="url(#pet-visor)">
            {[0, 1].map((i) => (
              <g key={i} ref={(n) => void (eyes.current[i] = n)}>
                <path ref={(n) => void (shapes.current[i * 2] = n)} d={CAPSULE} fill="#00dcf2" opacity="0.6" filter="url(#pet-bloom)" />
                <path ref={(n) => void (shapes.current[i * 2 + 1] = n)} d={CAPSULE} fill="url(#pet-eye)" filter="url(#pet-eyeglow)" />
              </g>
            ))}
          </g>
        </g>
      </svg>
    </button>
  )
}
