import React, { useEffect, useRef, useState } from 'react'
import {
  Card, Form, Input, InputNumber, Select, Button, Space, Tag, message,
  Timeline, Typography, Alert, Modal,
} from 'antd'
import {
  SaveOutlined, RobotOutlined, PlayCircleOutlined, FileAddOutlined,
  ThunderboltOutlined, CommentOutlined,
} from '@ant-design/icons'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { getLoginServiceConfig } from '@/services/loginService'
import { useTicketStore } from '@/store/ticketStore'
import CockpitChatTestModal from '@/components/CockpitChatTestModal'
import { SOP_TEMPLATES } from './sopTemplates'

const { Text } = Typography
const { TextArea } = Input

interface TraceStep {
  thought?: string
  skill?: string
  params?: Record<string, string>
  result?: unknown
  result_text?: string
  error?: string
}

interface RunState {
  status: 'idle' | 'running' | 'done' | 'error'
  trace: TraceStep[]
  conclusion: string
  error: string
}

const WorkflowEditor: React.FC = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const wfId = searchParams.get('id')
  const generateFromSkill = useTicketStore((s) => s.generateFromSkill)

  const [form] = Form.useForm()
  const [templates, setTemplates] = useState<{ name: string; intent: string }[]>([])
  const [saving, setSaving] = useState(false)
  const [sopModalOpen, setSopModalOpen] = useState(false)
  const [sopDesc, setSopDesc] = useState('')
  const [sopLoading, setSopLoading] = useState(false)
  const [metaLoading, setMetaLoading] = useState(false)
  const [inputJson, setInputJson] = useState('{}')
  const [run, setRun] = useState<RunState>({ status: 'idle', trace: [], conclusion: '', error: '' })
  const [chatTestOpen, setChatTestOpen] = useState(false)
  const pollRef = useRef<number | null>(null)

  const api = (p: string) => `${getLoginServiceConfig().baseUrl}${p}`

  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(api('/api/smart-chain/templates'))
        const d = await resp.json()
        if (d.success) setTemplates(d.templates || [])
      } catch { /* 服务未启动 */ }
    })()
    return () => { if (pollRef.current) window.clearInterval(pollRef.current) }
  }, [])

  useEffect(() => {
    if (!wfId) return
    ;(async () => {
      const resp = await fetch(api('/api/workflows'))
      const d = await resp.json()
      const wf = (d.workflows || []).find((w: { id: string }) => w.id === wfId)
      if (wf) {
        form.setFieldsValue({
          name: wf.name, intent: wf.intent, sop: wf.sop, skills: wf.skills,
          max_steps: wf.max_steps, trigger_keywords: wf.trigger_keywords || [],
          do_not_use_when: wf.do_not_use_when || '',
        })
      }
    })()
  }, [wfId, form])

  const collect = async () => {
    const v = await form.validateFields()
    return {
      id: wfId || undefined,
      name: v.name, intent: v.intent || '', sop: v.sop,
      skills: v.skills || [], max_steps: v.max_steps || 6,
      trigger_keywords: v.trigger_keywords || [],
      do_not_use_when: v.do_not_use_when || '',
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const wf = await collect()
      const resp = await fetch(api('/api/workflows/save'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: wf }),
      })
      const d = await resp.json()
      if (d.success) {
        message.success('工作流已保存')
        if (!wfId) navigate(`/workflows/editor?id=${d.id}`, { replace: true })
      } else message.error(d.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** AI 起草 SOP */
  const handleSuggestSop = async () => {
    if (!sopDesc.trim()) { message.warning('请填写场景描述'); return }
    setSopLoading(true)
    try {
      const skills = form.getFieldValue('skills') || []
      const resp = await fetch(api('/api/workflows/suggest-sop'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: sopDesc, skills }),
      })
      const d = await resp.json()
      if (d.success) {
        form.setFieldValue('sop', d.sop)
        setSopModalOpen(false)
        message.success('SOP 草稿已生成，可继续修改')
      } else message.error(d.message || '生成失败')
    } finally {
      setSopLoading(false)
    }
  }

  /** AI 生成触发元信息 */
  const handleSuggestMeta = async () => {
    setMetaLoading(true)
    try {
      const wf = await collect()
      const resp = await fetch(api('/api/workflows/suggest-meta'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: wf }),
      })
      const d = await resp.json()
      if (d.success && d.meta) {
        form.setFieldsValue({
          intent: d.meta.intent_summary,
          trigger_keywords: d.meta.trigger_keywords || [],
          do_not_use_when: (d.meta.do_not_use_when || []).join
            ? (d.meta.do_not_use_when as string[]).join('\n')
            : String(d.meta.do_not_use_when),
        })
        message.success('触发信息已生成')
      } else message.error(d.message || '生成失败')
    } catch {
      message.error('生成失败')
    } finally {
      setMetaLoading(false)
    }
  }

  /** 执行工作流 + 轮询 trace */
  const handleRun = async () => {
    if (!wfId) { message.warning('请先保存工作流'); return }
    let input: Record<string, string> = {}
    try { input = JSON.parse(inputJson || '{}') } catch { message.error('输入 JSON 格式错误'); return }
    setRun({ status: 'running', trace: [], conclusion: '', error: '' })
    const resp = await fetch(api('/api/workflow/run'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: wfId, input }),
    })
    const d = await resp.json()
    if (!d.success) {
      setRun({ status: 'error', trace: [], conclusion: '', error: d.message || '启动失败' })
      return
    }
    if (pollRef.current) window.clearInterval(pollRef.current)
    pollRef.current = window.setInterval(async () => {
      const r = await fetch(api(`/api/workflow/run?run_id=${d.run_id}`))
      const st = await r.json()
      if (!st.success) return
      setRun({ status: st.status === 'running' ? 'running' : st.status, trace: st.trace || [],
        conclusion: st.conclusion || '', error: st.error || '' })
      if (st.status !== 'running' && pollRef.current) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
    }, 900)
  }

  /** Cockpit 对话测试开场建议问题：意图，没有则用名称+触发词 */
  const chatSeed = () => {
    const intent = String(form.getFieldValue('intent') || '').trim()
    const name = String(form.getFieldValue('name') || '').trim()
    const keywords = (form.getFieldValue('trigger_keywords') || []) as string[]
    return intent || [name, ...keywords].filter(Boolean).join(' ')
  }

  /** trace → 对外工单 */
  const handleTicket = () => {
    const name = form.getFieldValue('name') || '工作流'
    const traceText = run.trace.map((t, i) =>
      `#${i + 1} [${t.skill || '-'}] ${t.error ? '❌ ' + t.error : (t.result_text || '').slice(0, 300)}`).join('\n')
    const ticket = generateFromSkill({
      title: `${name} 执行结论需外部处理`,
      skillName: `工作流·${name}`,
      triggerSource: '工作流执行',
      inputParams: (() => { try { return JSON.parse(inputJson || '{}') } catch { return {} } })(),
      execResult: `结论：${run.conclusion}\n---trace---\n${traceText}`.slice(0, 2000),
      execStatus: run.status === 'done' ? 'success' : 'failed',
      reason: '工作流执行结论需外部跟进处理',
      suggestion: '请核对结论与执行轨迹后转交处理对象',
    })
    message.success(`对外工单 ${ticket.ticketNo} 已产生`)
    navigate('/tickets')
  }

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {/* 左：定义 */}
      <Card size="small" title="工作流定义（自然语言 SOP 编排）" style={{ flex: 1 }}
        extra={<Space>
          <Button icon={<RobotOutlined />} onClick={() => setSopModalOpen(true)}>AI 起草 SOP</Button>
          <Button icon={<ThunderboltOutlined />} loading={metaLoading} onClick={handleSuggestMeta}>
            AI 生成触发信息
          </Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
            保存
          </Button>
        </Space>}>
        <Form form={form} layout="vertical" initialValues={{ max_steps: 6 }}>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '必填' }]}
              style={{ width: 280 }}>
              <Input placeholder="如：商户入驻全检" />
            </Form.Item>
            <Form.Item name="max_steps" label="最大步数">
              <InputNumber min={1} max={12} />
            </Form.Item>
          </Space>
          <Form.Item name="intent" label="意图（一句话场景）">
            <Input placeholder="串联处理什么端到端业务场景" />
          </Form.Item>
          <Form.Item label="内置模板（AI 可执行 SOP 规范，参考 strands-agents/agent-sop）">
            <Select
              allowClear
              placeholder="选择内置模板一键填充 SOP 与推荐白名单"
              options={SOP_TEMPLATES.map((t) => ({ value: t.key, label: `${t.name} — ${t.scenario}` }))}
              onChange={(k) => {
                const t = SOP_TEMPLATES.find((x) => x.key === k)
                if (!t) return
                form.setFieldsValue({
                  sop: t.sop,
                  skills: t.skills.length ? t.skills : form.getFieldValue('skills') || [],
                  name: form.getFieldValue('name') || t.name,
                })
                message.success('模板已填入，请按业务修改 {{}} 占位与能力名称')
              }}
            />
          </Form.Item>
          <Form.Item name="skills" label="白名单原子能力（运行时只能调这些）"
            rules={[{ required: true, message: '至少选择一个原子能力' }]}>
            <Select mode="multiple" showSearch placeholder="选择可串联的原子能力 Skill"
              options={templates.map((t) => ({ value: t.name, label: t.name }))} />
          </Form.Item>
          <Form.Item name="sop" label="SOP（自然语言编排逻辑：目标/起始/每步判定规则/结论要素）"
            rules={[{ required: true, message: 'SOP 必填' }]}>
            <TextArea rows={10} placeholder={'目标：产出商户全检结论。\n1. 先用「入驻管理查询」确认入驻状态；\n2. 若 frozen/rejected，用「MA查询」核实邮箱关联；\n3. 若 active，用「VA查询」拉 VA 列表，异常继续追查；\n4. 结论必须包含：入驻状态/异常项/建议动作。'} />
          </Form.Item>
          <Space style={{ width: '100%' }} size="middle" align="start">
            <Form.Item name="trigger_keywords" label="触发关键词" style={{ flex: 1 }}>
              <Select mode="tags" placeholder="回车添加" style={{ minWidth: 320 }} />
            </Form.Item>
          </Space>
          <Form.Item name="do_not_use_when" label="不应使用场景">
            <TextArea rows={2} placeholder="每行一个" />
          </Form.Item>
        </Form>
      </Card>

      {/* 右：调试 */}
      <Card size="small" title="调试（受约束 ReAct 执行）" style={{ width: 460 }}
        extra={<Space>
          <Button size="small" icon={<CommentOutlined />} onClick={() => setChatTestOpen(true)}>
            Cockpit 对话测试
          </Button>
          <Button size="small" icon={<FileAddOutlined />} disabled={run.status === 'running' || !run.trace.length}
            onClick={handleTicket}>
            产对外工单
          </Button>
          <Button size="small" type="primary" icon={<PlayCircleOutlined />}
            loading={run.status === 'running'} onClick={handleRun}>
            执行
          </Button>
        </Space>}>
        <Text type="secondary" style={{ fontSize: 12 }}>输入 JSON（用户入参）</Text>
        <TextArea rows={3} value={inputJson} onChange={(e) => setInputJson(e.target.value)}
          style={{ marginBottom: 12, fontFamily: 'monospace' }} />
        {run.status === 'error' && <Alert type="error" message={run.error} style={{ marginBottom: 12 }} />}
        {run.status === 'done' && run.conclusion && (
          <Alert type="success" message="结论" description={
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{run.conclusion}</pre>
          } style={{ marginBottom: 12 }} />
        )}
        <Timeline
          items={run.trace.map((t, i) => ({
            color: t.error ? 'red' : 'blue',
            children: (
              <div key={i} style={{ fontSize: 12 }}>
                <Space size={4} wrap>
                  <Tag color="purple">步{i + 1}</Tag>
                  {t.skill ? <Tag color="geekblue">{t.skill}</Tag> : null}
                  {t.params && Object.keys(t.params).length > 0 ? (
                    <Text type="secondary">{JSON.stringify(t.params)}</Text>
                  ) : null}
                </Space>
                {t.thought ? <div style={{ color: '#666', marginTop: 2 }}>思考：{t.thought}</div> : null}
                {t.error ? <div style={{ color: '#cf1322' }}>{t.error}</div> : null}
                {t.result_text ? (
                  <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', fontSize: 11,
                    maxHeight: 140, overflow: 'auto', background: '#fafafa', padding: 6 }}>
                    {t.result_text}
                  </pre>
                ) : null}
              </div>
            ),
          }))}
        />
        {run.status === 'running' && !run.trace.length && (
          <Text type="secondary">AI 正在按 SOP 决策第一步…</Text>
        )}
      </Card>

      {/* AI 起草 SOP */}
      <Modal open={sopModalOpen} onCancel={() => setSopModalOpen(false)}
        onOk={handleSuggestSop} confirmLoading={sopLoading} title="AI 起草 SOP" okText="生成">
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          描述业务场景，AI 结合已选白名单能力生成自然语言 SOP（先选能力再生成效果更好）
        </Text>
        <TextArea rows={4} value={sopDesc} onChange={(e) => setSopDesc(e.target.value)}
          placeholder="如：商户来咨询入驻进度，需要先查入驻状态，冻结的要追原因，active 的要确认 VA 是否开好，最后给全检结论" />
      </Modal>

      <CockpitChatTestModal
        open={chatTestOpen}
        title={`Cockpit 对话测试：${String(form.getFieldValue('name') || '工作流')}`}
        seedQuestion={chatSeed()}
        onClose={() => setChatTestOpen(false)}
      />
    </div>
  )
}

export default WorkflowEditor
