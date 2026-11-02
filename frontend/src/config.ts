// 展示层配置。换名字、唤醒词、建议问题都只改这里。
export const config = {
  assistantName: '布鲁',
  wakePhrase: '你好，布鲁',
  tagline: '兰剑智能 · 具身智能助手',
  suggestions: ['查询库存', '你能做什么？', '介绍一下兰剑智能'],
  /** 无交互多久后回到首页（毫秒） */
  idleTimeoutMs: 60_000,
  /** 默认连接同源后端；VITE_AGENT_MODE=demo 保留纯前端展示模式。 */
  agentWsUrl: import.meta.env.VITE_AGENT_MODE === 'demo'
    ? undefined
    : (import.meta.env.VITE_AGENT_WS as string | undefined)
      ?? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
}
