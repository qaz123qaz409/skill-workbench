/**
 * 钉钉 Bot 通知服务
 * 用于工单审批提醒推送
 */

export interface DingTalkConfig {
  webhookUrl: string       // 钉钉机器人 Webhook 地址
  secret?: string          // 加签密钥（可选）
  enabled: boolean
}

interface DingTalkMessage {
  msgtype: string
  markdown?: {
    title: string
    text: string
  }
  actionCard?: {
    title: string
    text: string
    btnOrientation: string
    btns: Array<{
      title: string
      actionURL: string
    }>
  }
}

const WEBAPP_BASE_URL = 'http://localhost:5173'

/** 发送钉钉 Markdown 消息 */
export async function sendDingTalkMarkdown(
  config: DingTalkConfig,
  title: string,
  text: string
): Promise<{ success: boolean; message: string }> {
  if (!config.enabled || !config.webhookUrl) {
    return { success: false, message: '钉钉通知未启用或未配置 Webhook' }
  }

  const message: DingTalkMessage = {
    msgtype: 'markdown',
    markdown: { title, text },
  }

  return sendDingTalkRequest(config, message)
}

/** 发送工单审批提醒（带操作按钮的 ActionCard） */
export async function sendApprovalNotification(
  config: DingTalkConfig,
  ticket: {
    id: string
    externalId: string
    title: string
    priority: string
    aiSummary: string
    aiConfidence: number
    aiSuggestion: string
  }
): Promise<{ success: boolean; message: string }> {
  if (!config.enabled || !config.webhookUrl) {
    return { success: false, message: '钉钉通知未启用' }
  }

  const priorityEmoji: Record<string, string> = {
    urgent: '🔴',
    high: '🟠',
    normal: '🔵',
    low: '⚪',
  }

  const confidencePercent = Math.round(ticket.aiConfidence * 100)

  const message: DingTalkMessage = {
    msgtype: 'actionCard',
    actionCard: {
      title: `工单审批提醒 - ${ticket.externalId}`,
      text: [
        `### ${priorityEmoji[ticket.priority] || '🔵'} 工单待审批`,
        '',
        `**工单号**: ${ticket.externalId}`,
        '',
        `**标题**: ${ticket.title}`,
        '',
        `**AI 置信度**: ${confidencePercent}%`,
        '',
        `---`,
        '',
        `**AI 处理摘要**:`,
        '',
        ticket.aiSummary,
        '',
        `**AI 建议**:`,
        '',
        ticket.aiSuggestion,
      ].join('\n'),
      btnOrientation: '1',  // 竖排按钮
      btns: [
        {
          title: '✅ 通过审批',
          actionURL: `${WEBAPP_BASE_URL}/tickets?id=${ticket.id}&action=approve`,
        },
        {
          title: '❌ 驳回',
          actionURL: `${WEBAPP_BASE_URL}/tickets?id=${ticket.id}&action=reject`,
        },
        {
          title: '👁 查看详情',
          actionURL: `${WEBAPP_BASE_URL}/tickets?id=${ticket.id}`,
        },
      ],
    },
  }

  return sendDingTalkRequest(config, message)
}

/** 发送工单状态变更通知 */
export async function sendStatusChangeNotification(
  config: DingTalkConfig,
  ticket: {
    externalId: string
    title: string
    oldStatus: string
    newStatus: string
    operator?: string
  }
): Promise<{ success: boolean; message: string }> {
  const text = [
    `### 📋 工单状态变更`,
    '',
    `**工单号**: ${ticket.externalId}`,
    '',
    `**标题**: ${ticket.title}`,
    '',
    `**变更**: ${ticket.oldStatus} → ${ticket.newStatus}`,
    '',
    ticket.operator ? `**操作人**: ${ticket.operator}` : '',
  ].join('\n')

  return sendDingTalkMarkdown(config, `工单状态变更 - ${ticket.externalId}`, text)
}

/** 底层 HTTP 请求 */
async function sendDingTalkRequest(
  config: DingTalkConfig,
  message: DingTalkMessage
): Promise<{ success: boolean; message: string }> {
  try {
    let url = config.webhookUrl

    // 如果启用了加签，生成签名
    if (config.secret) {
      const timestamp = Date.now()
      const sign = await generateSign(timestamp, config.secret)
      url += `&timestamp=${timestamp}&sign=${sign}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    })

    const data = await response.json()

    if (data.errcode === 0) {
      return { success: true, message: '发送成功' }
    } else {
      return { success: false, message: `钉钉返回错误: ${data.errmsg}` }
    }
  } catch (err) {
    return {
      success: false,
      message: `发送失败: ${err instanceof Error ? err.message : '网络错误'}`,
    }
  }
}

/** 钉钉加签算法 */
async function generateSign(timestamp: number, secret: string): Promise<string> {
  const stringToSign = `${timestamp}\n${secret}`
  const encoder = new TextEncoder()
  const data = encoder.encode(stringToSign)
  const keyData = encoder.encode(secret)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data)
  const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
  return encodeURIComponent(base64)
}

/** 获取钉钉配置（从 localStorage） */
export function getDingTalkConfig(): DingTalkConfig {
  const stored = localStorage.getItem('skill-workbench-dingtalk')
  if (stored) {
    return JSON.parse(stored)
  }
  return { webhookUrl: '', secret: '', enabled: false }
}

/** 保存钉钉配置 */
export function saveDingTalkConfig(config: DingTalkConfig): void {
  localStorage.setItem('skill-workbench-dingtalk', JSON.stringify(config))
}
