/** 对外工单数据模型：由业办技能执行产出，需外部处理/跟进 */
export interface Ticket {
  id: string
  ticketNo: string               // 对外工单号 WB-YYYYMMDD-序号
  title: string                  // 工单标题
  skillName: string              // 产生该工单的业办技能（smart-api-chain 模板名 / 自定义）
  triggerSource: string          // 触发来源：AI 对话 / 技能调试 / 手动创建
  inputParams: Record<string, string>  // 技能执行入参
  execResult?: string            // 技能执行结果摘要（查询结果 / 失败原因）
  execStatus: 'success' | 'failed' | 'partial' | 'none'
  reason: string                 // 产单原因（为什么需要外部处理）
  target: string                 // 处理对象（人工客服 / 风控 / 商户 / 外部平台）
  suggestion: string             // 处理建议
  priority: TicketPriority
  status: TicketStatus
  handledBy?: string
  handledAt?: number
  handleNote?: string            // 处理结论
  createdAt: number
  updatedAt: number
}

export type TicketPriority = 'urgent' | 'high' | 'normal' | 'low'

export type TicketStatus =
  | 'generated'     // 已产生（技能执行完自动/手动产单）
  | 'dispatched'    // 已派发（已通知处理对象）
  | 'processing'    // 外部处理中
  | 'done'          // 已办结
  | 'cancelled'     // 已取消

export const TICKET_STATUS_MAP: Record<TicketStatus, { label: string; color: string }> = {
  generated:  { label: '已产生', color: '#faad14' },
  dispatched: { label: '已派发', color: '#1677ff' },
  processing: { label: '处理中', color: '#722ed1' },
  done:       { label: '已办结', color: '#52c41a' },
  cancelled:  { label: '已取消', color: '#8c8c8c' },
}

export const PRIORITY_MAP: Record<TicketPriority, { label: string; color: string }> = {
  urgent: { label: '紧急', color: '#ff4d4f' },
  high:   { label: '高',   color: '#fa8c16' },
  normal: { label: '普通', color: '#1677ff' },
  low:    { label: '低',   color: '#8c8c8c' },
}

export const EXEC_STATUS_MAP: Record<Ticket['execStatus'], { label: string; color: string }> = {
  success: { label: '执行成功', color: '#52c41a' },
  failed:  { label: '执行失败', color: '#ff4d4f' },
  partial: { label: '部分成功', color: '#faad14' },
  none:    { label: '未执行',   color: '#8c8c8c' },
}

/** 产单入参（技能执行上下文） */
export interface TicketDraft {
  title: string
  skillName: string
  triggerSource: string
  inputParams?: Record<string, string>
  execResult?: string
  execStatus?: Ticket['execStatus']
  reason?: string
  target?: string
  suggestion?: string
  priority?: TicketPriority
}
