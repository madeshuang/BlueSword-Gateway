import brainHead from '../assets/blue-brain-head.webp'
import logo from '../assets/bluesword-logo.png'
import type { HistoryItem } from '../store'
import type { Phase } from '../types'
import { Pet } from './Pet'
import { IconPlus } from './Icons'

function groupOf(at: number) {
  const d = new Date(at)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (d >= today) return '今天'
  if (d.getTime() >= today.getTime() - 86_400_000) return '昨天'
  return '更早'
}

export function Sidebar(props: {
  history: HistoryItem[]
  activeId: string | null
  device: { online: boolean; name: string }
  onNew: () => void
  onOpen: (id: string) => void
  phase: Phase | 'sleep'
  onPet: () => void
}) {
  const groups = new Map<string, HistoryItem[]>()
  for (const h of props.history) {
    const g = groupOf(h.at)
    groups.set(g, [...(groups.get(g) ?? []), h])
  }

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <img src={logo} alt="BlueSword" className="sb-logo" />
        <span className="sb-brand-sep" />
        <span className="sb-bb" aria-label="Blue Brain">
          <img src={brainHead} alt="" className="sb-bb-icon" />
          <span className="sb-bb-text">
            <b>Blue</b>
            <b>Brain</b>
          </span>
        </span>
      </div>

      <button className="sb-new" onClick={props.onNew}>
        <IconPlus size={18} />
        新对话
      </button>

      <nav className="sb-history">
        {props.history.length === 0 && <div className="sb-empty">还没有对话</div>}
        {[...groups].map(([g, items]) => (
          <div key={g} className="sb-group">
            <div className="sb-section">{g}</div>
            {items.map((h) => (
              <button key={h.id} className={`sb-item ${props.activeId === h.id ? 'on' : ''}`} onClick={() => props.onOpen(h.id)}>
                {h.title}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sb-pet">
        <Pet phase={props.phase} onActivate={props.onPet} />
      </div>

      <div className="sb-device">
        <span className={`sb-status ${props.device.online ? 'ok' : ''}`} />
        <span className="sb-device-name">{props.device.name}</span>
        <span className="sb-device-sub">{props.device.online ? '已连接' : '未连接'}</span>
      </div>
    </aside>
  )
}
