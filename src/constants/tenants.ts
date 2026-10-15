/**
 * iboss 租户列表
 *
 * 端口分配规则（参考 smart-api-chain CDP 实例管理模式）：
 * - 每个租户唯一绑定一个 CDP 端口：9301 起按列表顺序递增
 * - 与 smart-api-chain 的 9222-9232 端口段隔离，避免两个系统抢端口
 * - value = 租户 ID（接口传参用），label = 展示名，port = 专属 CDP 端口
 *
 * 真实租户清单在 tenants.local.ts（已被 .gitignore 排除，不进 git）。
 * 仓库内只有占位：没有 local 文件时列表为空，按 tenants.example.ts 建一份即可。
 */
export interface IbossTenant {
  value: string
  label: string
  port: number
}

/** 端口段起点 */
export const PORT_BASE = 9301

// import.meta.glob 在文件缺失时返回空表，保证 clone 后可直接构建
const localMods = import.meta.glob<{ TENANT_DEFS_LOCAL?: Array<[string, string]>
  DEFAULT_TENANT_LOCAL?: string }>('./tenants.local.ts', { eager: true })
const local = localMods['./tenants.local.ts']

const TENANT_DEFS: Array<[string, string]> = local?.TENANT_DEFS_LOCAL ?? []

export const IBOSS_TENANTS: IbossTenant[] = TENANT_DEFS.map(
  ([value, label], index) => ({ value, label, port: PORT_BASE + index })
)

if (!TENANT_DEFS.length) {
  // eslint-disable-next-line no-console
  console.warn('[tenants] 未找到 tenants.local.ts，租户列表为空；请按 tenants.example.ts 创建本地配置')
}

/** 默认租户 */
export const DEFAULT_TENANT = local?.DEFAULT_TENANT_LOCAL ?? ''

/** 租户 → 端口 */
export function getPortByTenant(tenant: string): number | undefined {
  return IBOSS_TENANTS.find((t) => t.value === tenant)?.port
}

/** 端口 → 租户 */
export function getTenantByPort(port: number): IbossTenant | undefined {
  return IBOSS_TENANTS.find((t) => t.port === port)
}
