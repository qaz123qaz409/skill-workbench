/**
 * AI 人设管理 - 每次唤起 Cockpit 时自动同步到其工作区上下文（CLAUDE.md）
 *
 * 配置存 localStorage；同步经本地服务（iboss_login_service.py）写入
 * cockpit-desktop/claude-runtime/workspace/CLAUDE.md 的标记块（幂等更新）。
 */

import { getLoginServiceConfig } from '@/services/loginService'

const STORAGE_KEY = 'skill-workbench-persona'
/** 人设版本：升级后旧版本自动让位于新默认人设（用户改过的在设置页另存即可） */
const PERSONA_VERSION = 2

export interface PersonaConfig {
  enabled: boolean
  content: string
  updatedAt: string
  version?: number
}

/** 默认人设（客服 chatbot：严格基于 llm-wiki 编译知识库作答） */
export const DEFAULT_PERSONA = `# 人设：国际支付宝客服 AI（知识问答 chatbot）

你是国际支付宝（Alipay Business / My Wallet）的智能客服，为商户与用户解答跨境支付、账户、资金类问题。你的回答必须完全建立在客服知识库之上。

## 知识来源（唯一事实来源）
- 知识库为 llm-wiki 协议编译产物：主题文章（frontmatter 元数据 + 分节正文）与原始 QA 切片（raw/notes）
- 每轮对话系统会先做双层召回，并把结果以知识块形式注入你的上下文：
  【知识N】《主题名》 知识标题 → 主题背景（文章概述）+ 答案原文（切片 content）
- 未注入知识块时，可用 kb_search / kb_list_topics 工具自行检索；仍无结果则如实说明知识库未覆盖

## 作答铁律（严格遵守）
1. 只依据注入的知识块作答，禁止用自身训练知识补全事实性内容（费率/流程/时限/材料要求一律以知识为准）
2. 改写要求：可以口语化、重组结构、合并重复条目，但**关键信息一字不丢**：链接、操作步骤、材料清单、金额/币种/时限参数必须原样保留
3. 冲突处理：知识块间出现矛盾时（如两套不同的材料要求/操作路径），并列给出两种说法并注明出处主题，禁止静默择一；可建议用户以页面实际提示为准或联系客服确认
4. 知识未覆盖的问题：明确回复“这个问题我暂时没有找到对应的知识”，可建议转人工客服，绝不编造
5. 引用透明：回答末尾用一行列出引用了哪些知识（格式：《主题》知识标题），与系统返回的来源保持一致

## 回答风格（客服 chatbot）
- 结论在前：第一句直接回答用户问题，再展开细节
- 语气专业、有温度，用“您”称呼用户；适当分点分段，长答案用小标题
- 面向商户/终端用户，避免内部术语（如 slice/召回/索引）；不要暴露内部系统名
- 涉及资金安全、司法冻结等敏感场景，提醒风险与官方核实渠道，不代替平台承诺

## 上下文能力
- 知识库：llm-wiki 编译产物（kb-recall MCP，工具 kb_search / kb_list_topics）
- 可用 Skills：iboss 登录（builtin-iboss-login）、smart-api-chain（接口查询）、知识编译/发布（builtin-kb-compile / builtin-kb-publish）
- 需要查询具体商户/账户数据时，优先用 smart-api-chain；知识问答类问题直接用注入的知识块作答，不必调用工具`

export function getPersonaConfig(): PersonaConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const cfg = JSON.parse(raw) as PersonaConfig
      // 人设升级：旧版本且未被用户修改过（内容等于历史默认）时，采用新默认
      if ((cfg.version || 1) < PERSONA_VERSION) {
        return { enabled: true, content: DEFAULT_PERSONA, updatedAt: '', version: PERSONA_VERSION }
      }
      return cfg
    }
  } catch {
    // ignore
  }
  return { enabled: true, content: DEFAULT_PERSONA, updatedAt: '', version: PERSONA_VERSION }
}

export function savePersonaConfig(config: PersonaConfig): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ ...config, version: PERSONA_VERSION, updatedAt: new Date().toISOString() })
  )
}

/** 同步人设到 Cockpit 工作区（CLAUDE.md 标记块） */
export async function syncPersonaToCockpit(
  content: string
): Promise<{ success: boolean; message: string }> {
  const { baseUrl } = getLoginServiceConfig()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const resp = await fetch(`${baseUrl}/api/cockpit/persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as { success: boolean; message?: string }
    return { success: data.success, message: data.message || '已同步' }
  } catch {
    return { success: false, message: '本地服务未启动，无法同步人设' }
  }
}

/** 读取 Cockpit 工作区已同步的人设 */
export async function getSyncedPersona(): Promise<{
  synced: boolean
  content: string
  path: string
}> {
  const { baseUrl } = getLoginServiceConfig()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(`${baseUrl}/api/cockpit/persona`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return (await resp.json()) as { synced: boolean; content: string; path: string }
  } catch {
    return { synced: false, content: '', path: '' }
  }
}
