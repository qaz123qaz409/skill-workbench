import React, { useEffect, useMemo, useState } from 'react'
import {
  Card, Tag, Button, Space, Input, Statistic, Row, Col, Form, Select,
  Modal, Descriptions, Typography, message, Empty, Popconfirm,
} from 'antd'
import { PlusOutlined, SendOutlined, CheckOutlined, CloseOutlined, RocketOutlined } from '@ant-design/icons'
import { useTicketStore } from '@/store/ticketStore'
import { getDingTalkConfig, sendDingTalkMarkdown } from '@/services/dingtalk'
import { getLoginServiceConfig } from '@/services/loginService'
import type { Ticket, TicketStatus, TicketDraft } from '@/types/ticket'
import { TICKET_STATUS_MAP, PRIORITY_MAP, EXEC_STATUS_MAP } from '@/types/ticket'

const { Text, Paragraph } = Typography

/** 看板列定义（对外工单生命周期） */
const BOARD_COLUMNS: { key: string; label: string; statuses: TicketStatus[] }[] = [
  { key: 'generated', label: '已产生', statuses: ['generated'] },
  { key: 'dispatched', label: '已派发', statuses: ['dispatched'] },
  { key: 'processing', label: '处理中', statuses: ['processing'] },
  { key: 'closed', label: '已办结', statuses: ['done', 'cancelled'] },
]

type ChainTpl = { name: string; intent: string; input_required: { name: string; description: string }[] }

const TicketBoard: React.FC = () => {
  const {
    tickets, filter, setFilter, clearAll, generateFromSkill,
    dispatchTicket, markProcessing, completeTicket, cancelTicket, getStats,
  } = useTicketStore()
  const stats = getStats()
  const [selected, setSelected] = useState<Ticket | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [templates, setTemplates] = useState<ChainTpl[]>([])
  const [dispatchTarget, setDispatchTarget] = useState('')
  const [completeNote, setCompleteNote] = useState('')
  const [form] = Form.useForm()

  const loadTemplates = async () => {
    try {
      const { baseUrl } = getLoginServiceConfig()
      const resp = await fetch(`${baseUrl}/api/smart-chain/templates`)
      const d = await resp.json()
      if (d.success) setTemplates(d.templates || [])
    } catch { /* 服务未启动时手动产单仍可用 */ }
  }
  useEffect(() => { loadTemplates() }, [])

  const shown = useMemo(() => tickets.filter((t) => {
    if (filter.status !== 'all' && t.status !== filter.status) return false
    const kw = filter.keyword.trim().toLowerCase()
    if (!kw) return true
    return [t.ticketNo, t.title, t.skillName, t.reason].join(' ').toLowerCase().includes(kw)
  }), [tickets, filter])

  const columns = useMemo(() => BOARD_COLUMNS.map((col) => ({
    ...col, tickets: shown.filter((t) => col.statuses.includes(t.status)),
  })), [shown])

  /** 手动产单（也可选技能模板预填） */
  const handleCreate = async () => {
    const v = await form.validateFields()
    const tpl = templates.find((t) => t.name === v.skillName)
    const inputParams: Record<string, string> = {}
    ;(v.params || []).forEach((p: { k: string; v: string }) => {
      if (p?.k) inputParams[p.k] = p.v || ''
    })
    const ticket = generateFromSkill({
      title: v.title,
      skillName: v.skillName || '手动创建',
      triggerSource: '手动创建',
      inputParams,
      execResult: v.execResult,
      execStatus: v.execResult ? 'success' : 'none',
      reason: v.reason,
      target: v.target,
      suggestion: tpl?.intent || '',
      priority: v.priority || 'normal',
    } as TicketDraft)
    message.success(`对外工单 ${ticket.ticketNo} 已产生`)
    setCreateOpen(false)
    form.resetFields()
  }

  /** 派发：通知处理对象（钉钉已配置则推送） */
  const handleDispatch = async (t: Ticket) => {
    dispatchTicket(t.id, dispatchTarget || t.target)
    const cfg = getDingTalkConfig()
    if (cfg.enabled) {
      const r = await sendDingTalkMarkdown(cfg, `对外工单 ${t.ticketNo}`, [
        `### 对外工单派发 ${t.ticketNo}`,
        `- 标题：${t.title}`,
        `- 产生技能：${t.skillName}`,
        `- 处理对象：${dispatchTarget || t.target || '未指定'}`,
        `- 处理建议：${t.suggestion || '-'}`,
      ].join('\n'))
      if (r.success) message.success('已派发，钉钉通知已发送')
      else message.warning('已派发，但钉钉通知失败：' + r.message)
    } else {
      message.success('已派发')
    }
    setSelected({ ...t, status: 'dispatched', target: dispatchTarget || t.target })
    setDispatchTarget('')
  }

  const handleComplete = (t: Ticket) => {
    if (!completeNote.trim()) {
      message.warning('请填写处理结论')
      return
    }
    completeTicket(t.id, completeNote.trim())
    message.success('已办结')
    setSelected(null)
    setCompleteNote('')
  }

  const openDetail = (t: Ticket) => {
    setSelected(t)
    setDispatchTarget(t.target)
    setCompleteNote('')
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>对外工单看板</h2>
          <Text type="secondary" style={{ fontSize: 12 }}>
            工单由业办技能执行产出（AI 对话 / 技能调试 / 手动创建），跟踪外部处理至办结
          </Text>
        </div>
        <Space>
          <Input.Search placeholder="搜索工单号/标题/技能" allowClear style={{ width: 240 }}
            onSearch={(v) => setFilter({ keyword: v })} />
          <Select value={filter.status} style={{ width: 120 }}
            onChange={(v) => setFilter({ status: v })}
            options={[{ value: 'all', label: '全部状态' },
              ...Object.entries(TICKET_STATUS_MAP).map(([k, m]) => ({ value: k, label: m.label }))]} />
          <Button icon={<PlusOutlined />} type="primary" onClick={() => setCreateOpen(true)}>
            手动产单
          </Button>
          {tickets.length > 0 ? (
            <Popconfirm title="清空全部工单？" onConfirm={clearAll}>
              <Button danger>清空</Button>
            </Popconfirm>
          ) : null}
        </Space>
      </div>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={4}><Card size="small"><Statistic title="已产生" value={stats.generated} valueStyle={{ color: '#faad14' }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="已派发" value={stats.dispatched} valueStyle={{ color: '#1677ff' }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="处理中" value={stats.processing} valueStyle={{ color: '#722ed1' }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="已办结" value={stats.done} valueStyle={{ color: '#52c41a' }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="今日产单" value={stats.todayCreated} valueStyle={{ color: '#1677ff' }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="今日办结" value={stats.todayDone} valueStyle={{ color: '#52c41a' }} /></Card></Col>
      </Row>

      <Row gutter={12}>
        {columns.map((col) => (
          <Col span={6} key={col.key}>
            <Card size="small" title={<Space>{col.label}<Tag>{col.tickets.length}</Tag></Space>}
              style={{ minHeight: 420 }} styles={{ body: { padding: 8 } }}>
              {col.tickets.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无工单" />
              ) : col.tickets.map((t) => (
                <Card key={t.id} size="small" hoverable style={{ marginBottom: 8 }}
                  onClick={() => openDetail(t)}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t.ticketNo}</Text>
                    <Tag color={PRIORITY_MAP[t.priority].color} style={{ fontSize: 11 }}>
                      {PRIORITY_MAP[t.priority].label}
                    </Tag>
                  </Space>
                  <Text strong ellipsis style={{ display: 'block', margin: '4px 0' }}>{t.title}</Text>
                  <Space size={4} wrap>
                    <Tag color="geekblue" style={{ fontSize: 11 }}>{t.skillName}</Tag>
                    <Tag style={{ fontSize: 11 }}>{t.triggerSource}</Tag>
                    <Tag color={EXEC_STATUS_MAP[t.execStatus].color} style={{ fontSize: 11 }}>
                      {EXEC_STATUS_MAP[t.execStatus].label}
                    </Tag>
                  </Space>
                </Card>
              ))}
            </Card>
          </Col>
        ))}
      </Row>

      {/* 工单详情 */}
      <Modal open={!!selected} onCancel={() => setSelected(null)} width={680}
        title={selected ? <Space>
          <RocketOutlined />{selected.ticketNo}
          <Tag color={TICKET_STATUS_MAP[selected.status].color}>{TICKET_STATUS_MAP[selected.status].label}</Tag>
        </Space> : ''}
        footer={selected ? (
          <Space>
            {selected.status === 'generated' ? (
              <>
                <Input placeholder="处理对象（人工客服/风控/商户…）" value={dispatchTarget}
                  onChange={(e) => setDispatchTarget(e.target.value)} style={{ width: 220 }} />
                <Button type="primary" icon={<SendOutlined />} onClick={() => handleDispatch(selected)}>
                  派发
                </Button>
                <Button icon={<CloseOutlined />} onClick={() => { cancelTicket(selected.id); setSelected(null) }}>
                  取消工单
                </Button>
              </>
            ) : null}
            {selected.status === 'dispatched' ? (
              <>
                <Button onClick={() => { markProcessing(selected.id); setSelected({ ...selected, status: 'processing' }) }}>
                  标记处理中
                </Button>
                <Button type="primary" icon={<CheckOutlined />} onClick={() => handleComplete(selected)}>办结</Button>
              </>
            ) : null}
            {selected.status === 'processing' ? (
              <Button type="primary" icon={<CheckOutlined />} onClick={() => handleComplete(selected)}>办结</Button>
            ) : null}
          </Space>
        ) : null}>
        {selected ? (
          <>
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 12 }}
              items={[
                { key: '1', label: '标题', children: selected.title, span: 2 },
                { key: '2', label: '产生技能', children: <Tag color="geekblue">{selected.skillName}</Tag> },
                { key: '3', label: '触发来源', children: selected.triggerSource },
                { key: '4', label: '执行状态', children: <Tag color={EXEC_STATUS_MAP[selected.execStatus].color}>{EXEC_STATUS_MAP[selected.execStatus].label}</Tag> },
                { key: '5', label: '处理对象', children: selected.target || '-' },
                { key: '6', label: '产单时间', children: new Date(selected.createdAt).toLocaleString('zh-CN') },
                { key: '7', label: '办结时间', children: selected.handledAt ? new Date(selected.handledAt).toLocaleString('zh-CN') : '-' },
              ]} />
            {Object.keys(selected.inputParams).length > 0 ? (
              <Card size="small" title="技能执行入参" style={{ marginBottom: 12 }}>
                {Object.entries(selected.inputParams).map(([k, v]) => (
                  <div key={k}><Text type="secondary">{k}：</Text>{v}</div>
                ))}
              </Card>
            ) : null}
            {selected.execResult ? (
              <Card size="small" title="技能执行结果" style={{ marginBottom: 12 }}>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 160, overflow: 'auto' }}>
                  {selected.execResult}
                </pre>
              </Card>
            ) : null}
            {selected.reason ? (
              <Paragraph style={{ marginBottom: 8 }}><Text strong>产单原因：</Text>{selected.reason}</Paragraph>
            ) : null}
            {selected.suggestion ? (
              <Paragraph style={{ marginBottom: 8 }}><Text strong>处理建议：</Text>{selected.suggestion}</Paragraph>
            ) : null}
            {selected.status === 'done' && selected.handleNote ? (
              <Paragraph><Text strong type="success">处理结论：</Text>{selected.handleNote}</Paragraph>
            ) : null}
            {selected.status === 'dispatched' || selected.status === 'processing' ? (
              <Input.TextArea rows={2} placeholder="处理结论（办结时填写）"
                value={completeNote} onChange={(e) => setCompleteNote(e.target.value)} />
            ) : null}
          </>
        ) : null}
      </Modal>

      {/* 手动产单 */}
      <Modal open={createOpen} onCancel={() => setCreateOpen(false)} onOk={handleCreate}
        title="手动产生对外工单" okText="产单" width={600}>
        <Form form={form} layout="vertical">
          <Form.Item name="skillName" label="关联业办技能">
            <Select allowClear showSearch placeholder="选择技能模板（可选）"
              options={templates.map((t) => ({ value: t.name, label: t.name }))} />
          </Form.Item>
          <Form.Item name="title" label="工单标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="如：AE 卖家保证金冻结需人工核实" />
          </Form.Item>
          <Form.List name="params">
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => (
                  <Space key={f.key} align="baseline">
                    <Form.Item name={[f.name, 'k']}><Input placeholder="参数名" style={{ width: 160 }} /></Form.Item>
                    <Form.Item name={[f.name, 'v']}><Input placeholder="参数值" style={{ width: 280 }} /></Form.Item>
                    <Button size="small" onClick={() => remove(f.name)}>删除</Button>
                  </Space>
                ))}
                <Button size="small" onClick={() => add()}>+ 入参</Button>
              </>
            )}
          </Form.List>
          <Form.Item name="execResult" label="技能执行结果（可选）" style={{ marginTop: 12 }}>
            <Input.TextArea rows={3} placeholder="粘贴技能查询结果 / 执行日志摘要" />
          </Form.Item>
          <Form.Item name="reason" label="产单原因" rules={[{ required: true, message: '请说明为什么需要外部处理' }]}>
            <Input.TextArea rows={2} placeholder="如：查询到保证金被冻结，需风控人工核实解冻条件" />
          </Form.Item>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="target" label="处理对象">
              <Input placeholder="人工客服 / 风控 / 商户" style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="priority" label="优先级" initialValue="normal">
              <Select style={{ width: 110 }}
                options={Object.entries(PRIORITY_MAP).map(([k, m]) => ({ value: k, label: m.label }))} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}

export default TicketBoard
