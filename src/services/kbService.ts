import { getLoginServiceConfig } from './loginService'

/** 编译知识库对接层（经本地服务读取 kb-compiler 产物） */

export interface KbTopic {
  name: string
  overview: string
  slice_count: number
}

export interface KbTopicsResp {
  success: boolean
  built_at?: string
  engine?: 'builtin' | 'llmwiki'
  conflict_total?: number
  slice_total?: number
  topics?: KbTopic[]
  message?: string
}

export interface KbTopicDoc {
  success: boolean
  name?: string
  doc?: string
  slice_ids?: string[]
  message?: string
}

export interface KbHit {
  slice_id: string | null
  title: string
  content: string
  topic: string | null
  topic_overview: string
}

export interface KbSearchResp {
  success: boolean
  hits?: KbHit[]
  message?: string
}

async function getJson<T>(path: string): Promise<T> {
  const { baseUrl } = getLoginServiceConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const resp = await fetch(`${baseUrl}${path}`, { signal: controller.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return (await resp.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export async function getKbTopics(): Promise<KbTopicsResp> {
  return getJson<KbTopicsResp>('/api/kb/topics')
}

export async function getKbTopic(name: string): Promise<KbTopicDoc> {
  return getJson<KbTopicDoc>(`/api/kb/topic?name=${encodeURIComponent(name)}`)
}

export async function searchKb(q: string, topk = 3): Promise<KbSearchResp> {
  return getJson<KbSearchResp>(
    `/api/kb/search?q=${encodeURIComponent(q)}&topk=${topk}`
  )
}

export interface KbPublishResult {
  topic: string
  ok: boolean
  doc_id?: number
  action?: 'create' | 'update'
  url?: string
  error?: string
}

export interface KbPublishResp {
  success: boolean
  published?: number
  total?: number
  results?: KbPublishResult[]
  message?: string
}

export interface KbSyncResp {
  success: boolean
  yuque?: Record<string, number>
  namespace?: string
  config?: { token?: string; api_base?: string; namespace?: string }
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const { baseUrl } = getLoginServiceConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return (await resp.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export async function publishKb(
  token: string,
  namespace: string,
  topic?: string,
  apiBase = 'https://www.yuque.com'
): Promise<KbPublishResp> {
  return postJson<KbPublishResp>('/api/kb/publish', {
    target: 'yuque',
    token,
    namespace,
    topic,
    api_base: apiBase,
  })
}

export async function getKbSync(): Promise<KbSyncResp> {
  return getJson<KbSyncResp>('/api/kb/sync')
}

/* ---------- 知识更新流水线 ---------- */

export interface KbSourceFile {
  name: string
  size: number
  mtime: string
}

export interface KbSourcesResp {
  success: boolean
  files?: KbSourceFile[]
  dir?: string
  message?: string
}

export interface KbBuildDiff {
  old_built_at?: string
  new_built_at?: string
  old_slice_total: number
  new_slice_total: number
  slice_added: string[]
  slice_removed: string[]
  slice_changed: string[]
  topic_added: string[]
  topic_removed: string[]
}

export interface KbBuildResp {
  success: boolean
  status: 'idle' | 'running' | 'done' | 'error' | 'unknown'
  detail?: string
  updated_at?: string
  log_tail?: string
  diff?: KbBuildDiff | null
  message?: string
}

export async function getKbSources(): Promise<KbSourcesResp> {
  return getJson<KbSourcesResp>('/api/kb/sources')
}

export async function uploadKbSource(
  file: File
): Promise<{ success: boolean; name?: string; size?: number; message?: string }> {
  const { baseUrl } = getLoginServiceConfig()
  const buf = await file.arrayBuffer()
  const resp = await fetch(`${baseUrl}/api/kb/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
    },
    body: buf,
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

export async function startKbCompile(
  engine: 'builtin' | 'llmwiki' = 'builtin'
): Promise<{ success: boolean; message?: string }> {
  return postJson('/api/kb/compile', { engine })
}

export async function getKbBuildStatus(): Promise<KbBuildResp> {
  return getJson<KbBuildResp>('/api/kb/build')
}

/* ---------- 语雀拉回与冲突检查 ---------- */

export interface KbConflictResp {
  success: boolean
  stale?: { topic: string; doc_id: number; remote_updated_at: string }[]
  message?: string
}

export interface KbPullResp {
  success: boolean
  pulled?: number
  results?: { topic: string; ok: boolean; chars?: number; error?: string }[]
  message?: string
}

export async function checkKbConflict(
  token: string,
  namespace: string,
  apiBase = 'https://www.yuque.com'
): Promise<KbConflictResp> {
  return getJson<KbConflictResp>(
    `/api/kb/conflict?token=${encodeURIComponent(token)}` +
      `&namespace=${encodeURIComponent(namespace)}` +
      `&api_base=${encodeURIComponent(apiBase)}`
  )
}

export async function pullKbFromYuque(
  token: string,
  namespace: string,
  apiBase = 'https://www.yuque.com'
): Promise<KbPullResp> {
  return postJson<KbPullResp>('/api/kb/pull', {
    token,
    namespace,
    api_base: apiBase,
  })
}
