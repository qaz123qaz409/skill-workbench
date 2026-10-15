import type { Skill, MCPConfig } from '@/types/skill'
import { getLoginServiceConfig } from '@/services/loginService'

/**
 * 桌面端 API 对接层
 * GenAI Cockpit 通过本地文件 + MCP 协议通信
 * 进程检测与唤起经本地服务（iboss_login_service.py）中转：浏览器无权限直接跑 shell
 */

const COCKPIT_CONFIG_DIR = '~/.config/genai-cockpit/mcp'

/** 生成 MCP Server 配置（stdio 模式） */
export function generateMCPConfig(skill: Skill): MCPConfig {
  const scriptName = `skill_${skill.id}.${skill.language === 'python' ? 'py' : 'js'}`
  const command = skill.language === 'python' ? 'python3' : 'node'
  const args = [`${COCKPIT_CONFIG_DIR}/scripts/${scriptName}`]

  const env: Record<string, string> = {}
  skill.inputSchema.forEach((param) => {
    if (param.defaultValue) {
      env[`SKILL_DEFAULT_${param.name.toUpperCase()}`] = param.defaultValue
    }
  })

  return {
    name: `skill-${skill.id}`,
    command,
    args,
    env: Object.keys(env).length > 0 ? env : undefined,
  }
}

/** 生成 MCP JSON 配置文件内容（用于 Cockpit 安装） */
export function generateMCPJson(skills: Skill[]): string {
  const mcpServers: Record<string, MCPConfig> = {}

  skills
    .filter((s) => s.status === 'active')
    .forEach((skill) => {
      const config = generateMCPConfig(skill)
      mcpServers[config.name] = config
    })

  return JSON.stringify({ mcpServers }, null, 2)
}

/** 生成 MCP Tool Schema（供 Cockpit AI Agent 识别） */
export function generateToolSchema(skill: Skill) {
  const properties: Record<string, { type: string; description: string }> = {}
  const required: string[] = []

  skill.inputSchema.forEach((param) => {
    properties[param.name] = {
      type: param.type,
      description: param.description,
    }
    if (param.required) required.push(param.name)
  })

  return {
    name: skill.name,
    description: skill.description,
    inputSchema: {
      type: 'object',
      properties,
      required,
    },
  }
}

/** 本地执行 Skill（调试用，通过 Worker 沙箱） */
export async function executeSkillLocal(
  skill: Skill,
  input: Record<string, unknown>
): Promise<{ output: Record<string, unknown>; logs: string[]; duration: number }> {
  const startTime = Date.now()
  const logs: string[] = []

  logs.push(`[${new Date().toLocaleTimeString()}] 开始执行 ${skill.name}`)

  // 参数校验
  for (const param of skill.inputSchema) {
    if (param.required && !(param.name in input)) {
      throw new Error(`缺少必填参数: ${param.name}`)
    }
    logs.push(
      `[${new Date().toLocaleTimeString()}] 参数 ${param.name} = ${JSON.stringify(input[param.name])}`
    )
  }

  // 模拟执行（实际环境由 Cockpit 执行，这里做 mock）
  await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000))

  logs.push(`[${new Date().toLocaleTimeString()}] 执行完成`)

  const duration = Date.now() - startTime
  logs.push(`[${new Date().toLocaleTimeString()}] 耗时 ${duration}ms`)

  // Mock 输出
  const output: Record<string, unknown> = {}
  if (skill.outputSchema) {
    skill.outputSchema.forEach((field) => {
      output[field.name] = `[mock] ${field.description || field.name}`
    })
  } else {
    output.result = '[mock] 执行成功'
  }

  return { output, logs, duration }
}

/** 获取桌面端连接状态（经本地服务 pgrep 检测 Cockpit 进程） */
export async function checkCockpitConnection(): Promise<{
  connected: boolean
  version?: string
  message: string
}> {
  const { baseUrl } = getLoginServiceConfig()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(`${baseUrl}/api/apps/status?app=cockpit`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as { running: boolean; installed: boolean }
    if (data.running) {
      return { connected: true, message: 'Cockpit 桌面版运行中' }
    }
    if (!data.installed) {
      return { connected: false, message: '未检测到 Cockpit 桌面版（/Applications/Cockpit.app）' }
    }
    return { connected: false, message: 'Cockpit 桌面版未启动，点击下方按钮唤起' }
  } catch {
    return {
      connected: false,
      message: '本地服务未启动，无法检测（python3 server/iboss_login_service.py）',
    }
  }
}

/** 通过命令行唤起 Cockpit 桌面版（macOS: open -a，经本地服务中转） */
export async function launchCockpit(): Promise<{
  success: boolean
  message: string
  already_running?: boolean
}> {
  const { baseUrl } = getLoginServiceConfig()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25000)
    const resp = await fetch(`${baseUrl}/api/apps/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'cockpit' }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as {
      success: boolean
      message?: string
      already_running?: boolean
    }
    return {
      success: data.success,
      message: data.message || '已发送启动命令',
      already_running: data.already_running,
    }
  } catch {
    return { success: false, message: '本地服务未启动或请求超时' }
  }
}
