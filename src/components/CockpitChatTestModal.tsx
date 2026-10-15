/**
 * Cockpit 对话测试对话框 - 多轮交互式端到端测试
 *
 * 与「一键测试」的区别：支持多轮交流（如第一轮发起场景、第二轮补模拟商户 ID/订单号），
 * 服务端对 sessionId 做工作流会话粘滞，补参轮次仍能续接同一工作流引擎执行。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Modal, Input, Button, Space, Tag, Typography } from 'antd'
import { SendOutlined } from '@ant-design/icons'
import { sendChatMessage } from '@/services/chatService'

const { Text } = Typography

interface Msg {
  role: 'user' | 'assistant'
  content: string
  mode?: string
}

interface Props {
  open: boolean
  title: string
  /** 开场建议问题（点击即发送） */
  seedQuestion?: string
  onClose: () => void
}

const CockpitChatTestModal: React.FC<Props> = ({ open, title, seedQuestion, onClose }) => {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const sessionIdRef = useRef(`sw-test-${Date.now()}`)
  const bottomRef = useRef<HTMLDivElement>(null)

  // 每次打开重置会话（新 sessionId = 新的工作流粘滞）
  useEffect(() => {
    if (open) {
      setMessages([])
      setInput('')
      setLoading(false)
      sessionIdRef.current = `sw-test-${Date.now()}`
    }
  }, [open])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const send = async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || loading) return
    setInput('')
    const next: Msg[] = [...messages, { role: 'user', content: msg }]
    setMessages(next)
    setLoading(true)
    const history = next.map((m) => ({ role: m.role, content: m.content }))
    const r = await sendChatMessage(msg, sessionIdRef.current, history)
    setMessages([...next, {
      role: 'assistant',
      content: r.success ? (r.reply || '(空回复)') : `❌ ${r.message || '请求失败'}`,
      mode: r.success ? (r.mode || 'direct') : undefined,
    }])
    setLoading(false)
  }

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      styles={{ body: { height: 480, display: 'flex', flexDirection: 'column' } }}
    >
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 4px 8px' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <Text type="secondary">
              直接输入问题开始测试；可在对话中补充模拟的商户 ID / 订单号等参数。
            </Text>
            {seedQuestion && (
              <div style={{ marginTop: 16 }}>
                <Button onClick={() => send(seedQuestion)}>{seedQuestion}</Button>
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            display: 'flex',
            justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
            marginBottom: 12,
          }}>
            <div style={{
              maxWidth: '82%',
              padding: '8px 12px',
              borderRadius: 10,
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: m.role === 'user' ? '#1677ff' : '#f5f5f5',
              color: m.role === 'user' ? '#fff' : 'inherit',
            }}>
              {m.role === 'assistant' && m.mode && (
                <Tag color={m.mode === 'workflow' ? 'purple' : m.mode === 'agent' ? 'geekblue' : 'default'}
                  style={{ marginBottom: 4 }}>
                  {m.mode === 'workflow' ? '工作流引擎' : m.mode === 'agent' ? 'Cockpit Agent' : '直连模型'}
                </Tag>
              )}
              {m.content}
            </div>
          </div>
        ))}
        {loading && <Text type="secondary">AI 正在执行…（工作流多步查询可能需要 1-2 分钟）</Text>}
        <div ref={bottomRef} />
      </div>
      <Space.Compact style={{ width: '100%' }}>
        <Input.TextArea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
        />
        <Button type="primary" icon={<SendOutlined />} loading={loading}
          onClick={() => send()} style={{ height: 'auto' }}>
          发送
        </Button>
      </Space.Compact>
    </Modal>
  )
}

export default CockpitChatTestModal
