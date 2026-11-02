import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Phase } from '../types'
import { BlueModel, type BlueState } from './blueModel'

/*
 * 布鲁 3D 版：网格与表情来自 blueModel.js（程序化生成），
 * 场景、灯光、跳跃、转身、视线跟随在这里实现。透明背景，直接融进侧边栏。
 */

const STATE: Record<Phase, BlueState> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  acting: 'executing',
}

const BUBBLE: Partial<Record<Phase, string>> = {
  listening: '我在听…',
  thinking: '让我想想…',
  speaking: '正在回答',
  acting: '执行任务中',
}

/** 模型底部（局部坐标），缩放支点放在这里，压扁时脚底不离地 */
const FOOT = -1.08
const GROUND = -1.2
const BASE_YAW = 0.32 // 默认微微侧向右边的内容区

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const smooth = (t: number) => t * t * (3 - 2 * t)

/** 一次跳跃：蓄力压扁 → 腾空拉伸 → 落地回弹 */
function hopCurve(t: number, height: number) {
  const PREP = 0.16
  const AIR = 0.62
  if (t < PREP) {
    const k = Math.sin((t / PREP) * Math.PI * 0.5)
    return { y: 0, sx: 1 + 0.07 * k, sy: 1 - 0.1 * k }
  }
  if (t < PREP + AIR) {
    const k = (t - PREP) / AIR
    const stretch = Math.abs(Math.cos(k * Math.PI))
    return { y: height * Math.sin(k * Math.PI), sx: 1 - 0.035 * stretch, sy: 1 + 0.06 * stretch }
  }
  const k = (t - PREP - AIR) / (1 - PREP - AIR)
  const s = Math.sin(k * Math.PI) * (1 - k * 0.3)
  return { y: 0, sx: 1 + 0.08 * s, sy: 1 - 0.11 * s }
}

/** 柔和的工作室环境光（移植自 blue-3d/app.js），保证面罩是暗的、外壳有金属感 */
function studioEnvironment(renderer: THREE.WebGLRenderer) {
  const width = 128
  const height = 64
  const data = new Float32Array(width * height * 4)
  const key = new THREE.Vector3(-0.45, 0.83, 0.32).normalize()
  for (let y = 0; y < height; y++) {
    const lat = ((y + 0.5) / height - 0.5) * Math.PI
    const dy = Math.sin(lat)
    const ring = Math.cos(lat)
    for (let x = 0; x < width; x++) {
      const phi = ((x + 0.5) / width - 0.5) * Math.PI * 2
      const dx = ring * Math.cos(phi)
      const dz = ring * Math.sin(phi)
      const dome = 0.08 + 0.32 * Math.pow((dy + 1) * 0.5, 1.5)
      const soft = 0.7 * Math.pow(Math.max(0, dx * key.x + dy * key.y + dz * key.z), 8)
      const at = (y * width + x) * 4
      data[at] = dome * 0.95 + soft
      data[at + 1] = dome + soft
      data[at + 2] = dome * 1.05 + soft
      data[at + 3] = 1
    }
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.needsUpdate = true
  const pmrem = new THREE.PMREMGenerator(renderer)
  const env = pmrem.fromEquirectangular(tex)
  tex.dispose()
  pmrem.dispose()
  return env
}

function radialTexture(stops: [number, string][]) {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  for (const [o, col] of stops) g.addColorStop(o, col)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export default function BluePet3D(props: { phase: Phase; onActivate: () => void; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLButtonElement>(null)
  const phaseRef = useRef(props.phase)
  phaseRef.current = props.phase
  const onFail = useRef(props.onFail)
  onFail.current = props.onFail

  useEffect(() => {
    const el = host.current
    if (!el) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch {
      onFail.current()
      return
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.3
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const env = studioEnvironment(renderer)
    scene.environment = env.texture
    scene.environmentIntensity = 0.95

    scene.add(new THREE.HemisphereLight(0xf0f7fa, 0x3a4a52, 1.1))
    const keyLight = new THREE.DirectionalLight(0xf4f9ff, 2.3)
    keyLight.position.set(-3.5, 5.5, 4)
    scene.add(keyLight)
    const fill = new THREE.DirectionalLight(0xdcecf5, 0.8)
    fill.position.set(5, 2, 3)
    scene.add(fill)
    const chin = new THREE.DirectionalLight(0xc8dce5, 0.45)
    chin.position.set(-0.3, -0.8, 4)
    scene.add(chin)
    const rim = new THREE.DirectionalLight(0x3cdde3, 1.5)
    rim.position.set(-3, 2, -4)
    scene.add(rim)
    const back = new THREE.DirectionalLight(0xd8e5f3, 0.8)
    back.position.set(3, 4, -6)
    scene.add(back)

    const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 50)
    camera.position.set(0, 1.0, 7.3)
    camera.lookAt(0, -0.2, 0)

    // 地面：一块柔和的接触阴影 + 一圈细光环（平时很淡，唤醒后亮起）
    const shadowTex = radialTexture([
      [0, 'rgba(40,48,56,0.42)'],
      [0.55, 'rgba(40,48,56,0.16)'],
      [1, 'rgba(40,48,56,0)'],
    ])
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 3.2),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
    )
    shadow.rotation.x = -Math.PI / 2
    shadow.position.y = GROUND
    scene.add(shadow)
    const haloMat = new THREE.MeshBasicMaterial({ color: 0x2fd3df, transparent: true, opacity: 0.3, toneMapped: false })
    const halo = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.012, 8, 160), haloMat)
    halo.rotation.x = Math.PI / 2
    halo.position.y = GROUND + 0.01
    scene.add(halo)
    const glowTex = radialTexture([
      [0, 'rgba(0,200,215,0)'],
      [0.6, 'rgba(0,210,225,0.22)'],
      [0.72, 'rgba(0,206,220,0.05)'],
      [1, 'rgba(0,160,190,0)'],
    ])
    const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, opacity: 0.4, toneMapped: false })
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), glowMat)
    glow.rotation.x = -Math.PI / 2
    glow.position.y = GROUND + 0.005
    scene.add(glow)

    // 层级：yaw（转身）→ hop（跳跃 + 倾斜）→ pivot（脚底为支点的形变）→ 模型
    const yawGroup = new THREE.Group()
    const hopGroup = new THREE.Group()
    const pivot = new THREE.Group()
    pivot.position.y = FOOT
    yawGroup.add(hopGroup)
    hopGroup.add(pivot)
    scene.add(yawGroup)
    yawGroup.position.y = GROUND - FOOT + 0.02

    const model = BlueModel.create(THREE)
    model.group.position.y = -FOOT
    pivot.add(model.group)

    const resize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    // —— 动画状态
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
    let yaw = BASE_YAW
    let pitch = 0
    const gaze = { x: 0, y: 0 }
    let wander = { yaw: 0, gx: 0, gy: 0 }
    let nextWander = last + 2000
    let hop: { start: number; dur: number; h: number; then: number } | null = null
    let nextHop = last + 1200
    let spin: { start: number; dur: number } | null = null
    let nextSpin = last + 12000 + Math.random() * 8000
    let lastPhase: Phase = phaseRef.current

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (document.hidden) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const t = now / 1000
      const p = phaseRef.current
      const ease = 1 - Math.exp(-dt * 6)

      const rect = root.current?.getBoundingClientRect()
      const cx = rect ? rect.left + rect.width / 2 : 0
      const cy = rect ? rect.top + rect.height * 0.6 : 0
      const tracking = now - pointer.at < 4000
      const dx = pointer.x - cx
      const dy = pointer.y - cy

      // —— 状态切换时的小动作
      if (p !== lastPhase) {
        if (p === 'listening' || p === 'speaking') nextHop = now
        lastPhase = p
      }

      // —— 转身 / 俯仰：跟随鼠标；没人动鼠标时自己张望，偶尔原地转一圈
      let yawTarget = BASE_YAW
      let pitchTarget = 0
      let gx = 0
      let gy = 0
      if (p === 'thinking') {
        yawTarget = BASE_YAW + Math.sin(t * 0.9) * 0.25
        pitchTarget = -0.12
        gx = 0.4
        gy = 1
      } else if (tracking) {
        yawTarget = clamp(dx / 600, -1, 1) * 0.75
        pitchTarget = clamp(dy / 500, -1, 1) * 0.28
        gx = clamp(dx / 350, -1, 1)
        gy = -clamp(dy / 300, -1, 1)
      } else {
        if (now > nextWander) {
          wander = Math.random() < 0.4 ? { yaw: 0, gx: 0, gy: 0 } : { yaw: (Math.random() - 0.5) * 0.7, gx: (Math.random() - 0.5) * 1.6, gy: (Math.random() - 0.5) * 1 }
          nextWander = now + 1800 + Math.random() * 2600
        }
        yawTarget = BASE_YAW + wander.yaw
        gx = wander.gx
        gy = wander.gy
      }
      yaw += (yawTarget - yaw) * ease
      pitch += (pitchTarget - pitch) * ease
      gaze.x += (gx - gaze.x) * (1 - Math.exp(-dt * 10))
      gaze.y += (gy - gaze.y) * (1 - Math.exp(-dt * 10))

      if (!reduced && !spin && !tracking && p === 'idle' && now > nextSpin) {
        spin = { start: now, dur: 1500 }
        nextSpin = now + 18000 + Math.random() * 12000
        nextHop = Math.max(nextHop, now + 1700)
      }
      let spinAngle = 0
      if (spin) {
        const k = (now - spin.start) / spin.dur
        if (k >= 1) spin = null
        else spinAngle = smooth(k) * Math.PI * 2
      }
      yawGroup.rotation.y = yaw + spinAngle

      // —— 跳跃节奏
      if (!reduced && !hop && now > nextHop) {
        if (p === 'idle') {
          hop = { start: now, dur: 640, h: 0.3 + Math.random() * 0.12, then: Math.random() < 0.3 ? 1 : 0 }
          nextHop = now + 2800 + Math.random() * 3200
        } else if (p === 'speaking') {
          hop = { start: now, dur: 420, h: 0.1, then: 0 }
          nextHop = now + 470 + Math.random() * 180
        } else if (p === 'listening') {
          hop = { start: now, dur: 560, h: 0.18, then: 0 }
          nextHop = now + 3200
        } else if (p === 'acting') {
          hop = { start: now, dur: 480, h: 0.14, then: 1 }
          nextHop = now + 2400
        } else nextHop = now + 1000
      }
      let hy = 0
      let sx = 1
      let sy = 1
      if (hop) {
        const k = (now - hop.start) / hop.dur
        if (k >= 1) hop = hop.then > 0 ? { start: now + 40, dur: hop.dur * 0.85, h: hop.h * 0.6, then: hop.then - 1 } : null
        else if (k >= 0) ({ y: hy, sx, sy } = hopCurve(k, hop.h))
      }
      const breathe = reduced ? 0 : Math.sin(t * 1.4) * 0.02
      hopGroup.position.y = hy + breathe
      pivot.scale.set(sx, sy, sx)
      const sway = reduced ? 0 : p === 'thinking' ? Math.sin(t * 1.9) * 0.07 : Math.sin(t * 0.65) * 0.02
      hopGroup.rotation.z = -0.08 + sway + (hy > 0 ? -0.05 * clamp(hy / 0.3, 0, 1) : 0)
      hopGroup.rotation.x = pitch

      // —— 影子与光环随高度变化
      const lift = clamp(hy / 0.4, 0, 1)
      shadow.scale.setScalar(1 - lift * 0.35)
      ;(shadow.material as THREE.MeshBasicMaterial).opacity = 1 - lift * 0.5
      const active = p !== 'idle'
      const level =
        p === 'speaking' ? ((Math.sin(t * 9) + 1) / 2) * 0.6 : p === 'listening' ? 0.25 + Math.sin(t * 4) * 0.15 : 0
      haloMat.opacity = (active ? 0.85 : 0.3) - lift * 0.2
      glowMat.opacity = (active ? 0.75 : 0.35) + level * 0.2
      halo.scale.setScalar(1 + level * 0.06)

      model.setGaze(gaze.x, gaze.y)
      model.updateExpression(STATE[p], t, level)
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      removeEventListener('pointermove', onMove)
      ro.disconnect()
      model.dispose()
      shadowTex.dispose()
      glowTex.dispose()
      env.dispose()
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh && o.parent && !model.group.getObjectById(o.id)) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  const bubble = BUBBLE[props.phase]

  return (
    <button ref={root} className="pet pet3d" data-phase={props.phase} onClick={props.onActivate} title="点我说话">
      <span className={`pet-bubble ${bubble ? 'show' : ''}`}>{bubble ?? ''}</span>
      <div ref={host} className="pet3d-canvas" aria-label="布鲁" />
    </button>
  )
}
