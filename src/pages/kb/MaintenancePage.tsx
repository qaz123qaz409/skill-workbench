import React, { useEffect, useRef, useState } from 'react'
import {
  Card, List, Tag, Drawer, Button, Input, Space, Typography, Alert,
  message, Empty, Row, Col, Segmented, Badge,
} from 'antd'
import { CheckOutlined, RobotOutlined, SendOutlined, SyncOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { getLoginServiceConfig } from '@/services/loginService'

const { Title, Paragraph, Text } = Typography
const api = async (path: string, opts?: RequestInit) => {
  const { baseUrl } = getLoginServiceConfig()
  const resp = await fetch(`${baseUrl}${path}`, opts)
  return resp.json()
}

type Task = {
  id: string
  type: 'conflict' | 'uncovered' | 'stale' | 'yuque_drift' | 'upload_review'
  title: string
  status: 'pending' | 'done'
  resolution: string
  resolved_at: number
  detail: Record<string, unknown>
}
type Msg = { role: 'user' | 'assistant'; content: string }

const CONFLICT_ACTIONS = ['采纳说法A', '采纳说法B', '双说均有效，并列呈现', '按 AI 建议处理']
const UNCOVERED_ACTIONS = ['答案已确认（待补录知识库）', '已拉回语雀文档同步', '无需处理']
const STALE_ACTIONS = ['已复核，内容仍有效', '确认陈旧，待更新后重新发布', '无需处理']
const DRIFT_ACTIONS = ['拉回语雀编辑合并到本地', '用本地版重新发布覆盖语雀', '无需处理']
const UPLOAD_ACTIONS = ['已核对，继续编译发布', '已剔除重复条目', '无需处理']
const fmtTime = (ms?: number) => ms ? new Date(ms).toLocaleString('zh-CN') : '尚未扫描'

const TYPE_TAG: Record<string, { color: string; label: string }> = {
  conflict: { color: 'red', label: '知识冲突' },
  uncovered: { color: 'blue', label: '未覆盖问题' },
  stale: { color: 'gold', label: '疑似陈旧' },
  yuque_drift: { color: 'purple', label: '语雀端漂移' },
  upload_review: { color: 'cyan', label: '上传比对' },
}
const ACTIONS: Record<string, string[]> = {
  conflict: CONFLICT_ACTIONS, uncovered: UNCOVERED_ACTIONS, stale: STALE_ACTIONS,
  yuque_drift: DRIFT_ACTIONS, upload_review: UPLOAD_ACTIONS,
}

const MaintenancePage: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([])
  const [counts, setCounts] = useState({ pending: 0, done: 0 })
  const [scanMeta, setScanMeta] = useState({ last_scan: 0, next_scan: 0, interval_h: 6 })
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<'pending' | 'done' | 'all'>('pending')
  const [active, setActive] = useState<Task | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [resolving, setResolving] = useState(false)
  const chatBox = useRef<HTMLDivElement>(null)

  const load = async () => {
    setLoading(true)
    try {
      const d = await api('/api/kb/maintenance')
      if (d.success) {
        setTasks(d.tasks || [])
        setCounts({ pending: d.pending, done: d.done })
        setScanMeta({ last_scan: d.last_scan || 0, next_scan: d.next_scan || 0, interval_h: d.interval_h || 6 })
      } else message.error(d.message || '加载失败')
    } catch {
      message.error('本地服务未启动')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    chatBox.current?.scrollTo({ top: chatBox.current.scrollHeight })
  }, [msgs])

  const ask = async (text: string, opener = false) => {
    if (!active || !text.trim()) return
    const history = msgs
    // 开场白由 AI 主动发出，不显示为 user 消息
    setMsgs((prev) => opener
      ? [...prev, { role: 'assistant', content: '正在分析待办…' }]
      : [...prev, { role: 'user', content: text }])
    setInput('')
    setSending(true)
    try {
      const d = await api('/api/kb/maintenance/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: active.id, message: text, history }),
      })
      if (d.success) {
        setMsgs((prev) => opener
          ? [...prev.slice(0, -1), { role: 'assistant', content: d.reply }]
          : [...prev, { role: 'assistant', content: d.reply }])
      } else {
        message.error(d.message || 'AI 请求失败')
        if (opener) setMsgs((prev) => prev.slice(0, -1))
      }
    } catch {
      message.error('本地服务未启动')
    } finally {
      setSending(false)
    }
  }

  const doScan = async () => {
    setScanning(true)
    try {
      const d = await api('/api/kb/maintenance/scan', { method: 'POST', body: '{}' })
      if (d.success) {
        message.success(`扫描完成：新增 ${d.added} 条陈旧待办` +
          ((d.auto_refreshed_topics || []).length ? `，自动刷新 ${d.auto_refreshed_topics.length} 个主题摘要` : ''))
        load()
      } else message.error(d.message || '扫描失败')
    } catch {
      message.error('本地服务未启动')
    } finally {
      setScanning(false)
    }
  }

  const doRefresh = async () => {
    setRefreshing(true)
    try {
      const d = await api('/api/kb/maintenance/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (d.success) {
        message.success(`已刷新 ${d.refreshed.length}/${d.total_topics} 个主题的摘要与标签`)
      } else message.error(d.message || '刷新失败')
    } catch {
      message.error('本地服务未启动')
    } finally {
      setRefreshing(false)
    }
  }

  const openDrawer = (t: Task) => {
    setActive(t)
    setMsgs([])
    setInput('')
    if (t.status === 'pending') {
      // AI 主动开场：把待办呈给用户裁判
      setTimeout(() => ask(t.type === 'conflict'
        ? '请对比两个切片的完整原文，逐点列出差异（材料/步骤/参数/路径等关键信息），分析哪个更可信，给出裁决建议。'
        : t.type === 'yuque_drift'
          ? '语雀端文档被人工编辑过，与本地版本分歧。请分析应拉回语雀编辑还是用本地版覆盖，给出建议。'
          : t.type === 'upload_review'
            ? '请帮我核对这次上传与语雀的比对结果：疑似重复的条目是否真的重复，能否继续编译发布？'
            : t.type === 'stale'
              ? '请帮我评估这篇长期未更新的知识文档：哪些内容可能过时，需要重点核实什么？'
              : '请根据召回到的相关知识，帮我草拟这个问题的答案要点，或说明知识库缺口在哪里。', true), 100)
    }
  }

  const resolve = async (action: string) => {
    if (!active) return
    setResolving(true)
    try {
      const d = await api('/api/kb/maintenance/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: active.id, action, note: '' }),
      })
      if (d.success) {
        message.success('已标记完成')
        setActive(null)
        load()
      } else message.error(d.message || '操作失败')
    } catch {
      message.error('本地服务未启动')
    } finally {
      setResolving(false)
    }
  }

  const shown = tasks.filter((t) => filter === 'all' || t.status === filter)
  const d = active?.detail || {}
  const actions = ACTIONS[active?.type || ''] || UNCOVERED_ACTIONS

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <Space align="baseline" style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
        <Title level={4} style={{ margin: 0 }}>知识维护待办</Title>
        <Space>
          <Button icon={<SyncOutlined spin={scanning} />} loading={scanning} onClick={doScan}>立即扫描</Button>
          <Button icon={<ThunderboltOutlined />} loading={refreshing} onClick={doRefresh}>
            刷新全部主题摘要/标签
          </Button>
        </Space>
      </Space>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
        定时扫描：每 {scanMeta.interval_h} 小时自动检出陈旧/冲突条目（启动后自动运行） ·
        上次扫描：{fmtTime(scanMeta.last_scan)} · 下次：{fmtTime(scanMeta.next_scan)}
      </Text>
      <Space align="baseline" style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Space>
          <Badge count={counts.pending} overflowCount={99}>
            <Tag color="orange" style={{ marginRight: 16, padding: '4px 10px' }}>待处理</Tag>
          </Badge>
          <Tag color="green" style={{ padding: '4px 10px' }}>已完成 {counts.done}</Tag>
          <Segmented
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            options={[
              { label: `待处理 (${counts.pending})`, value: 'pending' },
              { label: `已完成 (${counts.done})`, value: 'done' },
              { label: '全部', value: 'all' },
            ]}
          />
        </Space>
      </Space>

      <Card>
        {shown.length === 0 ? (
          <Empty description={filter === 'pending' ? '没有待处理的维护问题' : '暂无记录'} />
        ) : (
          <List
            loading={loading}
            dataSource={shown}
            renderItem={(t) => (
              <List.Item
                style={{ cursor: 'pointer' }}
                onClick={() => openDrawer(t)}
                actions={[t.status === 'done'
                  ? <Tag color="green" icon={<CheckOutlined />} key="s">已完成</Tag>
                  : <Tag color="orange" key="s">待处理</Tag>]}
              >
                <List.Item.Meta
                  title={<Space>
                    <Tag color={TYPE_TAG[t.type]?.color}>{TYPE_TAG[t.type]?.label}</Tag>
                    <Text strong>{t.title}</Text>
                    {(t.type === 'stale' || t.type === 'yuque_drift') && t.detail.topic
                      ? <Tag>《{String(t.detail.topic)}》</Tag> : null}
                  </Space>}
                  description={t.status === 'done'
                    ? <Text type="success">裁决：{t.resolution}</Text>
                    : String(t.detail.desc || (t.type === 'uncovered'
                      ? '用户提问后知识库未召回，需补充知识' : ''))}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      <Drawer
        title={active ? (
          <Space>
            <Tag color={TYPE_TAG[active.type]?.color}>{TYPE_TAG[active.type]?.label}</Tag>
            {active.title}
          </Space>
        ) : ''}
        width={760}
        open={!!active}
        onClose={() => setActive(null)}
        footer={active?.status === 'pending' ? (
          <Space wrap>
            <Text type="secondary">裁决：</Text>
            {actions.map((a) => (
              <Button key={a} loading={resolving} onClick={() => resolve(a)}>{a}</Button>
            ))}
          </Space>
        ) : null}
      >
        {active && (
          <>
            {active.type === 'conflict' ? (
              <>
                <Alert type="info" showIcon message={String(d.desc || active.title)} style={{ marginBottom: 12 }} />
                <Row gutter={12}>
                  <Col span={12}>
                    <Card size="small" title="说法 A（旧）" style={{ height: '100%' }}>
                      <Paragraph><Text strong>{String(d.say_a || '-')}</Text></Paragraph>
                      <Text type="secondary" style={{ fontSize: 12 }}>来源：{String(d.src_a || '-')}</Text>
                      {d.full_a ? (
                        <pre style={{
                          marginTop: 8, padding: 8, maxHeight: 300, overflow: 'auto',
                          background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6,
                          fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                        }}>{String(d.full_a)}</pre>
                      ) : <div><Text type="secondary" style={{ fontSize: 12 }}>原文未找到（raw/notes 缺失）</Text></div>}
                    </Card>
                  </Col>
                  <Col span={12}>
                    <Card size="small" title="说法 B（新）" style={{ height: '100%' }}>
                      <Paragraph><Text strong>{String(d.say_b || '-')}</Text></Paragraph>
                      <Text type="secondary" style={{ fontSize: 12 }}>来源：{String(d.src_b || '-')}</Text>
                      {d.full_b ? (
                        <pre style={{
                          marginTop: 8, padding: 8, maxHeight: 300, overflow: 'auto',
                          background: '#f6ffed', border: '1px solid #d9f7be', borderRadius: 6,
                          fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                        }}>{String(d.full_b)}</pre>
                      ) : <div><Text type="secondary" style={{ fontSize: 12 }}>原文未找到（raw/notes 缺失）</Text></div>}
                    </Card>
                  </Col>
                </Row>
                {d.suggestion ? (
                  <Alert type="warning" showIcon style={{ marginTop: 12 }}
                    message={<span>编译时 AI 建议：{String(d.suggestion)}</span>} />
                ) : null}
              </>
            ) : active.type === 'upload_review' ? (
              <>
                <Alert type="info" showIcon style={{ marginBottom: 12 }}
                  message={<span>{String(d.desc || '')}</span>}
                  description="上传的新知识已与语雀知识库（基准）对比，请核对疑似重复条目后决定是否继续编译发布。" />
                {((d.duplicates as Array<Record<string, unknown>>) || []).length > 0 ? (
                  <Card size="small" title={`疑似与语雀重复（${((d.duplicates as unknown[]) || []).length} 条）`}>
                    {((d.duplicates as Array<Record<string, unknown>>) || []).map((x, i) => (
                      <div key={i} style={{ marginBottom: 4 }}>
                        • 上传《{String(x.upload)}》 ↔ 语雀《{String(x.yuque)}》
                        （重叠 {Math.round(Number(x.overlap || 0) * 100)}%）
                      </div>
                    ))}
                  </Card>
                ) : null}
              </>
            ) : active.type === 'stale' || active.type === 'yuque_drift' ? (
              <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                message={<span>{String(d.desc || active.title)}</span>}
                description={active.type === 'yuque_drift'
                  ? <span>语雀端编辑时间：{String(d.remote_updated_at || '-')}<br />
                      建议「拉回」把语雀编辑同步到本地，或重新发布用本地版覆盖语雀。</span>
                  : <span>建议定期复核该文档内容时效性，如已过时请修订后重新发布。</span>} />
            ) : (
              <Alert type="info" showIcon style={{ marginBottom: 12 }}
                message={<span>用户问题：{String(d.question || active.title)}</span>}
                description={<span>
                  {String(d.desc || 'AI 对话未召回到对应知识，已自动记入待办。')}<br />
                  {d.cue === 'yuque_has'
                    ? '语雀知识库已有相关文档，可拉回同步；也可与裁决助手草拟答案后补录。'
                    : '可与裁决助手草拟答案，确认后补录知识库。'}
                </span>} />
            )}

            <div style={{ marginTop: 16, border: '1px solid #f0f0f0', borderRadius: 8 }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontWeight: 600 }}>
                <RobotOutlined /> AI 裁决助手
              </div>
              <div ref={chatBox} style={{ height: 280, overflowY: 'auto', padding: 12, background: '#fafafa' }}>
                {msgs.map((m, i) => (
                  <div key={i} style={{
                    marginBottom: 8, display: 'flex',
                    justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
                  }}>
                    <div style={{
                      maxWidth: '80%', padding: '6px 10px', borderRadius: 8, whiteSpace: 'pre-wrap',
                      background: m.role === 'user' ? '#1677ff' : '#fff',
                      color: m.role === 'user' ? '#fff' : '#333',
                      border: m.role === 'user' ? 'none' : '1px solid #e8e8e8',
                    }}>{m.content}</div>
                  </div>
                ))}
                {sending && <Text type="secondary">AI 思考中…</Text>}
              </div>
              {active.status === 'pending' && (
                <div style={{ padding: 8, borderTop: '1px solid #f0f0f0' }}>
                  <Space.Compact style={{ width: '100%' }}>
                    <Input value={input} placeholder="向裁决助手提问…"
                      onChange={(e) => setInput(e.target.value)}
                      onPressEnter={() => ask(input)} />
                    <Button type="primary" icon={<SendOutlined />} loading={sending}
                      onClick={() => ask(input)}>发送</Button>
                  </Space.Compact>
                </div>
              )}
            </div>
          </>
        )}
      </Drawer>
    </div>
  )
}

export default MaintenancePage
