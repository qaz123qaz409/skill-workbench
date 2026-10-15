/**
 * 本地租户清单模板 —— 复制为 tenants.local.ts（已被 .gitignore 排除）后填写真实租户
 * value = 租户 ID（接口传参用），label = 展示名
 */
export const TENANT_DEFS_LOCAL: Array<[string, string]> = [
  ['TENANT0001', 'Tenant 01 | 说明'],
  ['TENANT0002', 'Tenant 02 | 说明'],
]

export const DEFAULT_TENANT_LOCAL = 'TENANT0001'
