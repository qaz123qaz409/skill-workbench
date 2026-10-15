/**
 * iboss 登录服务 - 对接本地 iboss_login_service.py
 *
 * 登录能力复刻自 smart-api-chain/auto_relogin.py：
 *   checkSession 检测登录态 → 过期自动导航 SSO → 填凭据重登录
 * 密码只存系统钥匙串（macOS Keychain），前端经本地服务中转，不落 localStorage。
 *
 * 启动本地服务：
 *   python3 server/iboss_login_service.py --port 18890 --cdp-port 9222
 */

import { getPortByTenant, DEFAULT_TENANT, PORT_BASE } from '@/constants/tenants'

const DEFAULT_BASE = 'http://127.0.0.1:18890'
const STORAGE_KEY = 'iboss-login-service-config'

export interface LoginServiceConfig {
  baseUrl: string
  cdpPort: number
  tenant: string
}

/** CDP 实例状态（每租户一个，端口唯一绑定） */
export interface CdpInstance {
  tenant: string
  label: string
  port: number
  running: boolean
}

export interface LoginStatus {
  logged_in: boolean
  user?: string
  tenant?: string
  detail?: string
  port?: number
  credential_saved?: boolean
  credential_user?: string
  reachable: boolean
}

export interface ReloginResult {
  success: boolean
  user?: string
  tenant?: string
  message?: string
}

export function getLoginServiceConfig(): LoginServiceConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // ignore
  }
  return { baseUrl: DEFAULT_BASE, cdpPort: getPortByTenant(DEFAULT_TENANT) ?? PORT_BASE, tenant: DEFAULT_TENANT }
}

export function saveLoginServiceConfig(config: LoginServiceConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

async function request<T>(
  path: string,
  options?: RequestInit,
  timeoutMs = 120000
): Promise<T | null> {
  const config = getLoginServiceConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`${config.baseUrl}${path}`, {
      ...options,
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

/** 检测本地登录服务是否可达 */
export async function checkServiceHealth(): Promise<boolean> {
  const result = await request<{ ok: boolean }>('/api/health', undefined, 3000)
  return !!result?.ok
}

/** 检测 iboss 登录态（顺带返回凭据保存状态） */
export async function getLoginStatus(): Promise<LoginStatus> {
  const config = getLoginServiceConfig()
  const result = await request<LoginStatus>(
    `/api/login/status?port=${config.cdpPort}`,
    undefined,
    15000
  )
  if (!result) {
    return { logged_in: false, reachable: false, detail: '本地登录服务未启动' }
  }
  return { ...result, reachable: true }
}

/** 保存凭据（工号+密码 → 本地服务 → macOS Keychain 加密存储） */
export async function saveCredentials(
  username: string,
  password: string
): Promise<{ success: boolean; message: string }> {
  const result = await request<{ success?: boolean; error?: string }>(
    '/api/login/credentials',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    },
    10000
  )
  if (!result) {
    return { success: false, message: '本地登录服务未启动，请先运行 server/iboss_login_service.py' }
  }
  if (result.error) return { success: false, message: result.error }
  return result.success
    ? { success: true, message: '凭据已加密保存到系统钥匙串' }
    : { success: false, message: '凭据保存失败' }
}

/** 查询凭据是否已保存（不返回密码） */
export async function getCredentialStatus(): Promise<{ saved: boolean; username: string }> {
  const result = await request<{ saved: boolean; username: string }>(
    '/api/login/credentials',
    undefined,
    5000
  )
  return result ?? { saved: false, username: '' }
}

/** 触发自动重登录（SSO 导航 + 自动填凭据，可能耗时 30s+） */
export async function triggerRelogin(): Promise<ReloginResult> {
  const config = getLoginServiceConfig()
  const result = await request<ReloginResult>(
    '/api/login/relogin',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: config.cdpPort, tenant: config.tenant }),
    },
    120000
  )
  if (!result) {
    return { success: false, message: '本地登录服务未启动或超时' }
  }
  return result
}

/** 在 Debug Chrome 里打开 iboss 首页（手动登录入口；URL 由服务端 local_settings 决定） */
export async function openIbossTab(): Promise<boolean> {
  const config = getLoginServiceConfig()
  const result = await request<{ id?: string; error?: string }>(
    '/api/login/tab',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: config.cdpPort }),
    },
    10000
  )
  return !!result?.id
}

// ============================================================
// CDP 实例管理（42 租户 × 专属端口 9301-9342）
// ============================================================

/** 获取全部租户实例的运行状态（并发探测各端口） */
export async function getInstances(): Promise<CdpInstance[]> {
  const result = await request<{ instances: CdpInstance[] }>(
    '/api/instances',
    undefined,
    30000
  )
  return result?.instances ?? []
}

/** 启动指定租户的独立 Chrome 实例（专属 profile + 专属端口） */
export async function startInstance(
  tenant: string
): Promise<{ success: boolean; message: string }> {
  const result = await request<{ success: boolean; message?: string; error?: string }>(
    '/api/instances/start',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant }),
    },
    30000
  )
  if (!result) return { success: false, message: '本地登录服务未启动' }
  return { success: result.success, message: result.message ?? result.error ?? '' }
}

/** 停止指定端口的 CDP 实例 */
export async function stopInstance(
  port: number
): Promise<{ success: boolean; message: string }> {
  const result = await request<{ success: boolean; message?: string; error?: string }>(
    '/api/instances/stop',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    },
    20000
  )
  if (!result) return { success: false, message: '本地登录服务未启动' }
  return { success: result.success, message: result.message ?? result.error ?? '' }
}

/** 对指定租户触发自动重登录（端口按租户映射自动解析） */
export async function triggerReloginForTenant(tenant: string): Promise<ReloginResult> {
  const result = await request<ReloginResult>(
    '/api/login/relogin',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant }),
    },
    120000
  )
  if (!result) {
    return { success: false, message: '本地登录服务未启动或超时' }
  }
  return result
}
