// 记录哪些助手消息已经“完整呈现”（思考链逐字打完、回复已显示），
// 让确认弹窗等布鲁把话说完再出现。
import { useEffect, useState } from 'react'

const revealed = new Set<string>()
const listeners = new Set<() => void>()

export function markRevealed(id: string) {
  if (revealed.has(id)) return
  revealed.add(id)
  listeners.forEach((fn) => fn())
}

export function isRevealed(id: string) {
  return revealed.has(id)
}

/** 有消息完成呈现时触发重新渲染 */
export function useRevealTick() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const fn = () => setTick((x) => x + 1)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])
}
