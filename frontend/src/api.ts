import { config } from './config'

export function apiFetch(path: string, init: RequestInit = {}) {
  const url = new URL(config.agentWsUrl ?? window.location.href, window.location.href)
  const token = url.searchParams.get('token')
  url.protocol = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:'
  const requested = new URL(path, url.origin)
  url.pathname = requested.pathname; url.search = requested.search; url.hash = ''
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(url, { ...init, headers })
}
