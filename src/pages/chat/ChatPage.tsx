import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card, Input, Button, Space, Tag, Alert, Typography, Popconfirm, Spin, message,
} from 'antd'
import {
  SendOutlined, RobotOutlined, UserOutlined, ReloadOutlined,
  LinkOutlined, DisconnectOutlined, PlusOutlined,
} from '@ant-design/icons'
import {
  getBridgeStatus,
  sendChatMessage,
  resetBridge,
  type BridgeStatus,
  type ChatSource,
} from '@/services/chatService'
import { useTicketStore } from '@/store/ticketStore'

const { Text } = Typography
const { TextArea } = Input

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  error?: boolean
  pending?: boolean
  /** 回答引用的编译知识库来源（仅 assistant） */
  sources?: ChatSource[]
}

const SESSION_KEY = 'skill-workbench-chat-session'
const HISTORY_KEY = 'skill-workbench-chat-history'

function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // ignore
  }
  return []
}

const ChatPage: React.FC = () => {
  const navigate = useNavigate()
  const generateFromSkill = useTicketStore((s) => s.generateFromSkill)
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [bridge, setBridge] = useState<BridgeStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [resetting, setResetting] = useState(false)
  const sessionIdRef = useRef<string | undefined>(
    localStorage.getItem(SESSION_KEY) || undefined
  )
  const listRef = useRef<HTMLDivElement>(null)

  const refreshBridge = async () => {
    setChecking(true)
    const status = await getBridgeStatus()
    setBridge(status)
    setChecking(false)
  }

  useEffect(() => {
    refreshBridge()
  }, [])

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-100)))
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = async () => {
    const content = input.trim()
    if (!content || sending) return
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content,
    }
    const pendingMsg: ChatMessage = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: '思考中...',
      pending: true,
    }
    setMessages((prev) => [...prev, userMsg, pendingMsg])
    setInput('')
    setSending(true)

    const result = await sendChatMessage(
      content,
      sessionIdRef.current,
      // 直连模式下服务端需要历史来维持上下文（取最近 20 条）
      messages
        .filter((m) => !m.pending && !m.error)
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }))
    )
    setSending(false)

    if (result.sessionId) {
      sessionIdRef.current = result.sessionId
      localStorage.setItem(SESSION_KEY, result.sessionId)
    }
    setMessages((prev) =>
      prev.map((m) =>
        m.id === pendingMsg.id
          ? {
              ...m,
              pending: false,
              error: !result.success,
              content: result.success
                ? result.reply || '（AI 未返回内容）'
                : `出错：${result.message || '未知错误'}`,
              sources: result.success ? result.sources || [] : undefined,
            }
          : m
      )
    )
  }

  const handleReset = async () => {
    setResetting(true)
    const result = await resetBridge()
    setResetting(false)
    if (result.success) {
      // 重启后会话失效，清掉 sessionId 开启新对话
      sessionIdRef.current = undefined
      localStorage.removeItem(SESSION_KEY)
      message.success(result.message)
    } else {
      message.error(result.message)
    }
    await refreshBridge()
  }

  const handleNewSession = () => {
    sessionIdRef.current = undefined
    localStorage.removeItem(SESSION_KEY)
    setMessages([])
    localStorage.removeItem(HISTORY_KEY)
  }

  const connected = bridge?.connected ?? false
  const directOk = bridge?.direct_api_available ?? false
  const canChat = connected || directOk
  const serviceDown = !checking && bridge === null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
      <Card
        size="small"
        style={{ marginBottom: 8 }}
        title={
          <Space>
            <RobotOutlined />
            <span>Cockpit AI 对话</span>
            {checking ? (
              <Spin size="small" />
            ) : serviceDown ? (
              <Tag icon={<DisconnectOutlined />} color="default">本地服务未启动</Tag>
            ) : connected ? (
              <Tag icon={<LinkOutlined />} color="success">
                Agent 模式{bridge?.port ? `（:${bridge.port}）` : ''}
              </Tag>
            ) : directOk ? (
              <Tag icon={<LinkOutlined />} color="processing">
                直连模式{bridge?.direct_model ? `（${bridge.direct_model}）` : ''}
              </Tag>
            ) : (
              <Tag icon={<DisconnectOutlined />} color="error">无可用连接</Tag>
            )}
          </Space>
        }
        extra={
          <Space>
            <Button size="small" icon={<PlusOutlined />} onClick={handleNewSession}>
              新对话
            </Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={refreshBridge}>
              检测连接
            </Button>
            {!connected && (
              <Popconfirm
                title="重建 AI 连接需要重启 Cockpit 桌面版"
                description="会先退出当前 Cockpit 再重新启动，未保存的 Cockpit 内对话可能丢失。"
                onConfirm={handleReset}
                okText="重启并连接"
                cancelText="取消"
              >
                <Button
                  size="small"
                  type="primary"
                  danger
                  loading={resetting}
                  disabled={serviceDown}
                >
                  重启 Cockpit 建立连接
                </Button>
              </Popconfirm>
            )}
          </Space>
        }
      >
        {!canChat && (
          <Alert
            type={serviceDown ? 'warning' : 'error'}
            showIcon
            message={
              serviceDown
                ? '本地服务未启动：先运行 python3 server/iboss_login_service.py'
                : '未检测到可用连接：请确认 Cockpit 已配置 Provider（模型凭据会自动复用）'
            }
            style={{ padding: '4px 12px' }}
          />
        )}
        {canChat && !connected && directOk && (
          <Alert
            type="info"
            showIcon
            message="当前为直连模式：复用 Cockpit 已存的模型凭据直接对话（自动注入人设）；不执行 Skills。点右侧「重启 Cockpit 建立连接」可切换到完整 Agent 模式。"
            style={{ padding: '4px 12px' }}
          />
        )}
      </Card>

      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 4px',
          background: '#fafafa',
          borderRadius: 8,
        }}
      >
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#999', marginTop: 80 }}>
            <RobotOutlined style={{ fontSize: 40 }} />
            <div style={{ marginTop: 12 }}>
              直接和 Cockpit 的 AI 对话，人设与 Skills 上下文自动生效
            </div>
          </div>
        )}
        {messages.map((m, idx) => (
          <div
            key={m.id}
            style={{
              display: 'flex',
              justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
              marginBottom: 12,
            }}
          >
            <div
              style={{
                maxWidth: '72%',
                padding: '8px 12px',
                borderRadius: 8,
                background: m.role === 'user' ? '#1677ff' : '#fff',
                color: m.role === 'user' ? '#fff' : m.error ? '#cf1322' : '#333',
                border: m.role === 'user' ? 'none' : '1px solid #eee',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 2 }}>
                {m.role === 'user' ? (
                  <><UserOutlined /> 我</>
                ) : (
                  <><RobotOutlined /> Cockpit AI</>
                )}
              </div>
              {m.pending ? <Spin size="small" /> : m.content}
              {!m.pending && m.sources && m.sources.length > 0 && (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed #eee' }}>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>
                    引用知识（编译知识库召回）
                  </div>
                  {m.sources.map((s, i) => (
                    <Tag key={i} color="purple" style={{ marginBottom: 3, whiteSpace: 'normal' }}>
                      {s.topic ? `《${s.topic}》` : ''}{s.title || s.slice_id}
                    </Tag>
                  ))}
                </div>
              )}
              {!m.pending && !m.error && m.role === 'assistant' && (
                <div style={{ marginTop: 6, paddingTop: 4, borderTop: '1px dashed #eee', textAlign: 'right' }}>
                  <Button
                    size="small"
                    type="link"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      // 找到本轮对应的用户提问作为工单标题
                      const userQ = messages.slice(0, idx).reverse().find((x) => x.role === 'user')
                      const topic = m.sources?.[0]?.topic
                      const ticket = generateFromSkill({
                        title: (userQ?.content || m.content.slice(0, 40)).slice(0, 60),
                        skillName: topic ? `知识问答《${topic}》` : 'AI 对话问答',
                        triggerSource: 'AI 对话',
                        inputParams: userQ ? { 用户提问: userQ.content } : {},
                        execResult: m.content.slice(0, 2000),
                        execStatus: 'success',
                        reason: 'AI 对话结果需外部跟进处理',
                        suggestion: '请核对 AI 回复内容后转交对应处理对象',
                      })
                      message.success(`对外工单 ${ticket.ticketNo} 已产生`)
                      navigate('/tickets')
                    }}
                  >
                    转对外工单
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 8 }}>
        <Space.Compact style={{ width: '100%' }}>
          <TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={
              canChat
                ? '输入消息，Enter 发送（Shift+Enter 换行）'
                : 'AI 连接未建立，请先处理上方连接状态'
            }
            autoSize={{ minRows: 2, maxRows: 6 }}
            disabled={!canChat || sending}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            loading={sending}
            disabled={!canChat || !input.trim()}
            style={{ height: 'auto' }}
          >
            发送
          </Button>
        </Space.Compact>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {sessionIdRef.current
            ? `会话：${sessionIdRef.current.slice(0, 16)}...（上下文持续）`
            : '尚未创建会话，发送第一条消息后自动建立'}
          {sending && ' · AI 正在处理，复杂任务可能需要几十秒'}
        </Text>
      </div>
    </div>
  )
}

export default ChatPage
