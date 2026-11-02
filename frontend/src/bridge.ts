import type { ClientEvent, ServerEvent } from './types'

export interface Bridge {
  send: (ev: ClientEvent) => void
  close: () => void
  mode: 'live' | 'demo'
}

/** 连接后端 Agent；模拟与现场使用同一通信路径。 */
export function createBridge(url: string | undefined, onEvent: (ev: ServerEvent) => void): Bridge {
  if (!url) throw new Error("请配置机器人后端地址；本地体验使用 mock 后端。")

  let ws: WebSocket | null = null
  let closed = false
  let retry = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let deviceName = '机器人后端'

  const report = (text: string) => {
    const id = crypto.randomUUID()
    onEvent({ type: 'assistant_start', id })
    onEvent({ type: 'assistant_delta', id, text })
    onEvent({ type: 'assistant_end', id })
  }

  const connect = () => {
    if (closed) return
    ws = new WebSocket(url)
    ws.onopen = () => {
      retry = 0
    }
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as ServerEvent
        if (event.type === 'device') deviceName = event.name
        if (!closed) onEvent(event)
      } catch (err) {
        console.warn('bad event', err)
      }
    }
    ws.onclose = () => {
      if (closed) return
      onEvent({ type: 'device', online: false, name: deviceName })
      reconnectTimer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry++))
    }
  }
  connect()

  return {
    mode: 'live',
    send: (ev) => {
      if (closed) return
      if (ws?.readyState === WebSocket.OPEN) {
        const message = ev.type === 'text_input' ? { ...ev, request_id: ev.request_id ?? crypto.randomUUID() } : ev
        ws.send(JSON.stringify(message))
      } else if (ev.type !== 'reset') {
        // A reconnect must never execute stale physical commands queued while offline.
        report('后端尚未连接，本次请求没有发送。连接恢复后请重新操作。')
      }
    },
    close: () => {
      closed = true
      clearTimeout(reconnectTimer)
      ws?.close()
    },
  }
}
