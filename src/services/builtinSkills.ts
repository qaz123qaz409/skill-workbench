/**
 * 内置 Skill 种子 - 应用首次启动时注入，保证 AI 工单平台开箱即用的核心能力
 *
 * builtin:true 的种子只注入一次（用 localStorage 标记），
 * 用户后续删除/修改不会被强制恢复。
 */
import type { Skill } from '@/types/skill'

const SEED_FLAG_KEY = 'skill-workbench-builtin-seeded-v1'
/** 已注入过的内置 Skill ID 清单（用户删除后不再强制复活） */
export const SEEDED_IDS_KEY = 'skill-workbench-builtin-seeded-ids'

export const LOGIN_SERVICE_URL = 'http://127.0.0.1:18890'




export const BUILTIN_SKILLS: Skill[] = []

/** 已下架的内置 Skill：不再注入，启动时从列表清理（能力已内建到工作台页面，无需以 Skill 形式存在） */
export const RETIRED_BUILTIN_IDS = ['builtin-iboss-login', 'builtin-kb-compile', 'builtin-kb-publish']

/** 启动时清理已下架的内置 Skill（幂等，列表里没有的自动跳过） */
export function purgeRetiredSkills(
  deleteSkill: (id: string) => void,
  existingSkills: Skill[] = []
): void {
  try {
    const retired = new Set(RETIRED_BUILTIN_IDS)
    existingSkills.filter((s) => retired.has(s.id)).forEach((s) => deleteSkill(s.id))
  } catch {
    // 存储不可用时跳过清理
  }
}

/** 启动时注入内置 Skill：新增内置会补注入；内置版本升级会同步新代码；用户已删除的不会强制复活 */
export function seedBuiltinSkills(
  addSkill: (skill: Skill) => void,
  updateSkill: (id: string, updates: Partial<Skill>) => void,
  existingSkills: Skill[] = [],
  seededIds: string[] = []
): void {
  try {
    const existingMap = new Map(existingSkills.map((s) => [s.id, s]))
    const known = new Set([...existingMap.keys(), ...seededIds])
    BUILTIN_SKILLS.forEach((builtin) => {
      const cur = existingMap.get(builtin.id)
      if (!cur && !known.has(builtin.id)) {
        addSkill(builtin) // 首次注入
      } else if (cur && (cur.version || 1) < builtin.version) {
        // 内置版本升级：同步代码/描述/Schema（用户可在编辑器继续改）
        updateSkill(builtin.id, {
          code: builtin.code,
          description: builtin.description,
          inputSchema: builtin.inputSchema,
          outputSchema: builtin.outputSchema,
          version: builtin.version,
          updatedAt: Date.now(),
        })
      }
    })
    // 记录已注入 ID（含本次新增）
    const merged = Array.from(new Set([...seededIds, ...BUILTIN_SKILLS.map((s) => s.id)]))
    localStorage.setItem(SEEDED_IDS_KEY, JSON.stringify(merged))
    localStorage.setItem(SEED_FLAG_KEY, 'true')
  } catch {
    // 存储不可用时跳过种子注入
  }
}

/** 读取已注入过的内置 Skill ID 清单 */
export function loadSeededIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SEEDED_IDS_KEY) || '[]')
  } catch {
    return []
  }
}
