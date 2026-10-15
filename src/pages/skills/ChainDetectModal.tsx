/**
 * 抓包生成业办技能 - 调用 smart-api-chain wizard（浏览器侦听 → 分析 → 草稿）
 *
 * 流程：填参数 → 启动侦探（异步 job）→ 用户在调试 Chrome(9222) 操作目标页面
 * → 轮询日志 → 完成后草稿一键转入编辑器微调保存。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Modal, Form, Input, Button, Space, Alert, Typography, Tag, Select, message } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { getLoginServiceConfig } from '@/services/loginService'

interface Props {
  open: boolean
  onClose: () => void
  /** 侦探完成 → 草稿转编辑器 */
  onDraft: (draft: Record<string, unknown>) => void
}

type DetectState = 'idle' | 'running' | 'done' | 'error'

const ChainDetectModal: React.FC<Props> = ({ open, onClose, onDraft }) => {
  const [form] = Form.useForm()
  const [state, setState] = useState<DetectState>('idle')
  const [job, setJob] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [errMsg, setErrMsg] = useState('')
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (open) {
      setState('idle'); setLogs([]); setDraft(null); setErrMsg(''); setJob('')
    }
    return () => { if (timerRef.current) window.clearInterval(timerRef.current) }
  }, [open])

  const poll = (jobId: string) => {
    const { baseUrl } = getLoginServiceConfig()
    timerRef.current = window.setInterval(async () => {
      try {
        const resp = await fetch(`${baseUrl}/api/smart-chain/detect?job=${jobId}`)
        const d = (await resp.json()) as {
          success?: boolean; status?: string; logs?: string[];
          draft?: Record<string, unknown>; error?: string
        }
        if (!d.success) return
        setLogs(d.logs || [])
        if (d.status === 'done') {
          setState('done'); setDraft(d.draft || null)
          if (timerRef.current) window.clearInterval(timerRef.current)
        } else if (d.status === 'error') {
          setState('error'); setErrMsg(d.error || '侦探失败')
          if (timerRef.current) window.clearInterval(timerRef.current)
        }
      } catch { /* 服务抖动，继续轮询 */ }
    }, 2000)
  }

  const handleStart = async () => {
    const values = await form.validateFields()
    const { baseUrl } = getLoginServiceConfig()
    try {
      const resp = await fetch(`${baseUrl}/api/smart-chain/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      const d = (await resp.json()) as { success?: boolean; job?: string; message?: string }
      if (!d.success) { message.error(d.message || '启动失败'); return }
      setJob(d.job || ''); setState('running'); setLogs([])
      poll(d.job || '')
    } catch {
      message.error('本地服务未启动')
    }
  }

  return (
    <Modal
      title={<Space><ThunderboltOutlined style={{ color: '#fa8c16' }} />抓包生成业办技能</Space>}
      width={720}
      open={open}
      onCancel={() => { if (timerRef.current) window.clearInterval(timerRef.current); onClose() }}
      footer={
        <Space>
          {state === 'done' && draft ? (
            <Button type="primary" onClick={() => { onDraft(draft); onClose() }}>
              在编辑器中打开草稿
            </Button>
          ) : (
            <Button type="primary" loading={state === 'running'} onClick={handleStart} disabled={state === 'running'}>
              {state === 'running' ? '侦探中…' : '开始侦探'}
            </Button>
          )}
          <Button onClick={() => { if (timerRef.current) window.clearInterval(timerRef.current); onClose() }}>
            关闭
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="侦探启动后，请在调试 Chrome（端口 9222）中打开目标页面并完整触发一次查询流程，wizard 会自动抓包、分析并生成模板草稿。"
      />
      <Form form={form} layout="vertical" disabled={state === 'running'}>
        <Space style={{ display: 'flex' }} size={12} wrap>
          <Form.Item name="want" label="期望字段（逗号分隔）" rules={[{ required: true, message: '必填' }]} style={{ width: 420 }}>
            <Input placeholder="商户ID,合约号,结算金额" />
          </Form.Item>
          <Form.Item name="wait" label="侦探时长（秒）" initialValue={30} style={{ width: 110 }}>
            <Input type="number" />
          </Form.Item>
        </Space>
        <Form.Item name="url" label="目标页面 URL（留空 = 接管浏览器当前页面）">
          <Input placeholder="https://example.com/page" />
        </Form.Item>
        <Space style={{ display: 'flex' }} size={12} wrap>
          <Form.Item name="known" label="已知输入（key=val,key=val）" style={{ width: 320 }}>
            <Input placeholder="sellerId=123456" />
          </Form.Item>
          <Form.Item name="domain" label="域名过滤（慎填，留空抓全量）" style={{ width: 320 }}>
            <Input placeholder="api.example.com" />
          </Form.Item>
          <Form.Item name="method" label="方法过滤" initialValue="" style={{ width: 110 }}>
            <Select>
              <Select.Option value="">全部</Select.Option>
              <Select.Option value="GET">GET</Select.Option>
              <Select.Option value="POST">POST</Select.Option>
            </Select>
          </Form.Item>
        </Space>
        <Space style={{ display: 'flex' }} size={12} wrap>
          <Form.Item name="name" label="链路名称" style={{ width: 320 }}>
            <Input placeholder="如：商户结算信息查询" />
          </Form.Item>
          <Form.Item name="description" label="描述" style={{ width: 320 }}>
            <Input placeholder="这个技能查什么" />
          </Form.Item>
        </Space>
      </Form>

      {state !== 'idle' && (
        <div style={{ marginTop: 4 }}>
          <Space style={{ marginBottom: 6 }}>
            <Tag color={state === 'done' ? 'green' : state === 'error' ? 'red' : 'processing'}>
              {state === 'running' ? `侦探中 job=${job}` : state === 'done' ? '草稿已生成' : '侦探失败'}
            </Tag>
            {state === 'error' && <Typography.Text type="danger">{errMsg}</Typography.Text>}
          </Space>
          <pre
            style={{
              background: '#1f1f1f', color: '#d9d9d9', padding: 10, borderRadius: 6,
              fontSize: 11, height: 180, overflow: 'auto', whiteSpace: 'pre-wrap',
            }}
          >
            {logs.slice(-80).join('\n') || '等待 wizard 输出…'}
          </pre>
        </div>
      )}
    </Modal>
  )
}

export default ChainDetectModal
