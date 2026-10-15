/**
 * Cockpit AI 对话服务 - 经本地服务中转调用 Cockpit 内置 chat RPC
 *
 * 链路：前端 → iboss_login_service.py（/api/chat/*）→ Cockpit /rpc（Bearer token）
 * 连接（port + token）由本地服务的 handshake watcher 在 Cockpit 启动时自动捕获。
 */

import { getLoginServiceConfig } from '@/services/loginService'

export interface BridgeStatus {
  connected: boolean
  captured: boolean
  port?: number
  cockpit_running: boolean
  direct_api_available: boolean
  direct_model?: string
}

export interface ChatSource {
  title?: string
  topic?: string
  slice_id?: string | null
}

export interface ChatSendResult {
  success: boolean
  reply?: string
  sessionId?: string
  engine?: string
  /** agent = Cockpit 完整 Agent（带 Skills）；direct = 直连模型 API */
  mode?: 'agent' | 'direct'
  model?: string
  durationMs?: number
  /** 本次回答引用的编译知识库召回来源 */
  sources?: ChatSource[]
  message?: string
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T | null> {
  const { baseUrl } = getLoginServiceConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!resp.ok) return null
    return (await resp.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 查询 Cockpit AI 连接状态 */
export async function getBridgeStatus(): Promise<BridgeStatus | null> {
  const { baseUrl } = getLoginServiceConfig()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(`${baseUrl}/api/chat/bridge`, { signal: controller.signal })
    clearTimeout(timer)
    if (!resp.ok) return null
    return (await resp.json()) as BridgeStatus
  } catch {
    return null
  }
}

/** 发送消息给 Cockpit AI（bridge 可用走 Agent，否则直连模型 API） */
export async function sendChatMessage(
  message: string,
  sessionId?: string,
  history?: Array<{ role: string; content: string }>
): Promise<ChatSendResult> {
  const result = await post<ChatSendResult>(
    '/api/chat/send',
    { message, sessionId, history },
    300000
  )
  if (!result) {
    return { success: false, message: '本地服务未启动或请求超时' }
  }
  return result
}

/** 重连：重启 Cockpit 以重新捕获 handshake（token 无法从运行中进程获取） */
export async function resetBridge(): Promise<{ success: boolean; message: string }> {
  const result = await post<{ success: boolean; message?: string }>(
    '/api/chat/bridge/reset',
    {},
    60000
  )
  if (!result) return { success: false, message: '本地服务未启动或超时' }
  return { success: result.success, message: result.message || '' }
}
