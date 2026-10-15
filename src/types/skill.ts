/** Skill 数据模型 */
export interface Skill {
  id: string
  name: string
  description: string
  category: string
  code: string
  language: 'python' | 'javascript'
  inputSchema: InputParam[]
  outputSchema?: OutputField[]
  version: number
  status: 'draft' | 'active' | 'disabled'
  mcpConfig?: MCPConfig
  createdAt: number
  updatedAt: number
}

export interface InputParam {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object'
  required: boolean
  description: string
  defaultValue?: string
}

export interface OutputField {
  name: string
  jsonPath: string
  description?: string
}

export interface MCPConfig {
  name: string
  command?: string       // stdio transport
  args?: string[]
  url?: string           // SSE transport
  env?: Record<string, string>
}

/** Skill 分类 */
export const SKILL_CATEGORIES = [
  '业务查询',
  '操作执行',
  '知识检索',
  '数据处理',
  '通知推送',
  '其他',
] as const

/** 测试用例 */
export interface TestCase {
  id: string
  skillId: string
  name: string
  input: Record<string, unknown>
  expectedOutput?: Record<string, unknown>
  lastResult?: 'pass' | 'fail' | null
}

/** 执行记录 */
export interface SkillExecution {
  id: string
  skillId: string
  skillName: string
  ticketId?: string
  input: Record<string, unknown>
  output?: Record<string, unknown>
  logs: LogEntry[]
  duration?: number
  status: 'running' | 'success' | 'error'
  createdAt: number
}

export interface LogEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
}
