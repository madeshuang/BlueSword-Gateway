// 展示层配置。换名字、唤醒词、建议问题都只改这里。
export const config = {
  assistantName: '布鲁',
  wakePhrase: '你好，布鲁',
  tagline: '兰剑智能 · 具身智能助手',
  suggestions: ['查询库存', '你能做什么？', '介绍一下兰剑智能'],
  /** 连续多久没有新的机器人进度时提醒（秒）；仅提示，不终止或重发任务。 */
  progressWarningSeconds: 60,
  /** 模拟和现场均连接后端，共用物品目录与确认流程。 */
  agentWsUrl: (import.meta.env.VITE_AGENT_WS as string | undefined)
      ?? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
}
