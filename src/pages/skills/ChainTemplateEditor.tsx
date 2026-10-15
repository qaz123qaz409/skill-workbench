/**
 * 业办技能编辑器 - 让用户自建 smart-api-chain 业务查询模板
 *
 * 产出与 smart-api-chain 执行器兼容的模板 JSON（page_interact / 直接接口两种步骤模式），
 * 保存经本地服务写入 chains/业务模板/<name>.json 并 upsert INDEX.json（custom 标记）。
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  Drawer, Form, Input, Button, Space, Radio, Collapse, Typography, message, Divider, Select, Alert, Tag,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, SaveOutlined, RobotOutlined, PlayCircleOutlined, CommentOutlined, FileAddOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { getLoginServiceConfig } from '@/services/loginService'
import { useTicketStore } from '@/store/ticketStore'
import CockpitChatTestModal from '@/components/CockpitChatTestModal'

type Tpl = Record<string, unknown>

interface Props {
  open: boolean
  /** 编辑/克隆的初始模板；null = 新建 */
  initial: Tpl | null
  /** initial 是否为自建模板（true=编辑，false=克隆为新技能） */
  initialIsCustom: boolean
  onClose: () => void
  onSaved: () => void
}

// ---------- 文本 <-> 对象 小工具 ----------
/** "k = v" 多行 -> 对象（JSONPath 里可能含冒号，故用 = 分隔） */
function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
function toKV(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return ''
  return Object.entries(obj as Record<string, unknown>)
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
}
/** "Key: value" 多行 -> headers 对象 */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
function toHeaders(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return ''
  return Object.entries(obj as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`).join('\n')
}

// ---------- 模板 <-> 表单 ----------
function templateToForm(tpl: Tpl | null) {
  if (!tpl) {
    return {
      name: '', description: '', version: '1.0.0', preferred_tab_domain: '',
      inputs: [] as { name: string; description: string; required: boolean }[],
      steps: [{ mode: 'page', id: 'step0_query', description: '', navigate_url: '', input_selector: '', input_value: '', click_selector: '', intercept_url_pattern: '', wait_seconds: 3, method: 'GET', url_template: '', body_template: '', headers_text: '', input_map_text: '', output_extract_text: '' }],
      final_output_text: '', trigger_keywords: [] as string[], sample_text: '', do_not_use_text: '',
    }
  }
  const meta = (tpl.metadata || {}) as Record<string, unknown>
  const input = (tpl.input || {}) as Record<string, { description?: string; required?: boolean }>
  return {
    name: String(tpl.name || ''),
    description: String(tpl.description || ''),
    version: String(tpl.version || '1.0.0'),
    preferred_tab_domain: String(tpl.preferred_tab_domain || ''),
    inputs: Object.entries(input).map(([name, v]) => ({
      name, description: v?.description || '', required: !!v?.required,
    })),
    steps: ((tpl.steps as Array<Record<string, unknown>>) || []).map((st, i) => {
      const pi = (st.page_interact || {}) as Record<string, unknown>
      const isPage = !!st.page_interact
      return {
        mode: isPage ? 'page' : 'api',
        id: String(st.id || `step${i}_query`),
        description: String(st.description || ''),
        navigate_url: String(pi.navigate_url || ''),
        input_selector: String(pi.input_selector || ''),
        input_value: String(pi.input_value || ''),
        click_selector: String(pi.click_selector || ''),
        intercept_url_pattern: String(pi.intercept_url_pattern || ''),
        wait_seconds: Number(pi.wait_seconds || 3),
        method: String(st.method || 'GET'),
        url_template: String(st.url_template || ''),
        body_template: typeof st.body_template === 'string' ? st.body_template : JSON.stringify(st.body_template || '', null, 2),
        headers_text: toHeaders(st.headers),
        input_map_text: toKV(st.input_map),
        output_extract_text: toKV(st.output_extract),
      }
    }),
    final_output_text: toKV(tpl.final_output),
    trigger_keywords: (meta.trigger_keywords as string[]) || [],
    sample_text: ((meta.sample_questions as string[]) || []).join('\n'),
    do_not_use_text: ((meta.do_not_use_when as string[]) || []).join('\n'),
  }
}

function formToTemplate(v: ReturnType<typeof templateToForm>): Tpl {
  const steps = v.steps.map((s, i) => {
    const base: Record<string, unknown> = { id: s.id || `step${i}_query`, description: s.description }
    const oe = parseKV(s.output_extract_text)
    if (s.mode === 'page') {
      return {
        ...base,
        page_interact: {
          navigate_url: s.navigate_url,
          preferred_tab_domain: v.preferred_tab_domain,
          input_selector: s.input_selector,
          input_value: s.input_value,
          click_selector: s.click_selector,
          intercept_url_pattern: s.intercept_url_pattern,
          wait_seconds: Number(s.wait_seconds) || 3,
        },
        output_extract: oe,
      }
    }
    return {
      ...base,
      method: s.method,
      url_template: s.url_template,
      force_browser: true,
      headers: parseHeaders(s.headers_text),
      body_template: s.body_template,
      input_map: parseKV(s.input_map_text),
      output_extract: oe,
    }
  })
  return {
    name: v.name,
    description: v.description,
    version: v.version || '1.0.0',
    preferred_tab_domain: v.preferred_tab_domain,
    steps,
    final_output: parseKV(v.final_output_text),
    input: Object.fromEntries(
      v.inputs.filter((p) => p.name).map((p) => [p.name, { description: p.description, required: !!p.required }])
    ),
    metadata: {
      intent_summary: v.description,
      trigger_keywords: v.trigger_keywords || [],
      sample_questions: (v.sample_text || '').split('\n').map((s) => s.trim()).filter(Boolean),
      do_not_use_when: (v.do_not_use_text || '').split('\n').map((s) => s.trim()).filter(Boolean),
    },
  }
}

const ChainTemplateEditor: React.FC<Props> = ({ open, initial, initialIsCustom, onClose, onSaved }) => {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [jsonPreview, setJsonPreview] = useState('')
  const navigate = useNavigate()
  const generateFromSkill = useTicketStore((s) => s.generateFromSkill)

  // ---------- 调试（直连执行 + Cockpit 对话测试） ----------
  const [debugInput, setDebugInput] = useState('')
  const [debugRunning, setDebugRunning] = useState(false)
  const [debugResult, setDebugResult] = useState<{
    status?: string; result?: unknown; error?: string
  } | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [chatTestOpen, setChatTestOpen] = useState(false)
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // 打开时按入参定义重置调试输入，并清空上次结果
  const resetDebug = (tpl: Tpl | null) => {
    setDebugResult(null)
    const input = (tpl?.input || {}) as Record<string, unknown>
    setDebugInput(JSON.stringify(Object.fromEntries(Object.keys(input).map((k) => [k, ''])), null, 2))
  }

  const runDebug = async () => {
    const name = String(form.getFieldValue('name') || '').trim()
    if (!name) { message.warning('请先填写技能名称'); return }
    let params: Record<string, string>
    try {
      params = JSON.parse(debugInput || '{}')
    } catch { message.error('调试入参不是合法 JSON'); return }
    setDebugRunning(true)
    setDebugResult(null)
    try {
      const { baseUrl } = getLoginServiceConfig()
      const resp = await fetch(`${baseUrl}/api/smart-chain/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, input: params }),
      })
      const d = (await resp.json()) as { success?: boolean; message?: string; job?: string }
      if (!d.success || !d.job) {
        setDebugResult({ status: 'error', error: d.message || '启动失败' })
        setDebugRunning(false)
        return
      }
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${baseUrl}/api/smart-chain/run?job=${d.job}`)
          const s = (await r.json()) as { success?: boolean; status?: string; result?: unknown; error?: string }
          if (s.status && s.status !== 'running') {
            if (pollRef.current) clearInterval(pollRef.current)
            setDebugResult(s)
            setDebugRunning(false)
          }
        } catch { /* 轮询抖动忽略 */ }
      }, 900)
    } catch {
      setDebugResult({ status: 'error', error: '本地服务未启动' })
      setDebugRunning(false)
    }
  }

  // Cockpit 对话测试开场建议问题：第一条示例问题，没有则用技能名拼句
  const chatSeed = () => {
    const sample = String(form.getFieldValue('sample_text') || '').split('\n').map((s) => s.trim()).filter(Boolean)[0]
    return sample || `用${String(form.getFieldValue('name') || '')}查一下`
  }

  const handleCreateTicket = () => {
    const name = String(form.getFieldValue('name') || '').trim()
    if (!name || !debugResult) return
    const inputParams: Record<string, string> = {}
    try {
      Object.entries(JSON.parse(debugInput || '{}')).forEach(([k, v]) => { inputParams[k] = String(v) })
    } catch { /* 入参非法时留空 */ }
    const failed = debugResult.status === 'error'
    const execResult = failed
      ? `执行失败：${debugResult.error}`
      : JSON.stringify(debugResult.result ?? {}, null, 2).slice(0, 2000)
    const ticket = generateFromSkill({
      title: `${name} 执行结果需外部处理`,
      skillName: name,
      triggerSource: '技能调试',
      inputParams,
      execResult,
      execStatus: failed ? 'failed' : 'success',
      reason: failed ? '技能执行失败，需人工介入' : '技能执行结果需外部跟进',
    })
    message.success(`对外工单 ${ticket.ticketNo} 已产生`)
    navigate('/tickets')
  }

  // AI 生成触发元信息（什么时候用/不用这个技能）
  const runSuggest = async (silent = false) => {
    const tpl = formToTemplate(form.getFieldsValue(true))
    setSuggesting(true)
    try {
      const { baseUrl } = getLoginServiceConfig()
      const resp = await fetch(`${baseUrl}/api/smart-chain/suggest-meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: tpl }),
      })
      const d = (await resp.json()) as {
        success?: boolean; message?: string;
        meta?: { intent_summary?: string; trigger_keywords?: string[]; sample_questions?: string[]; do_not_use_when?: string[] }
      }
      if (d.success && d.meta) {
        form.setFieldsValue({
          description: d.meta.intent_summary || form.getFieldValue('description'),
          trigger_keywords: d.meta.trigger_keywords || [],
          sample_text: (d.meta.sample_questions || []).join('\n'),
          do_not_use_text: (d.meta.do_not_use_when || []).join('\n'),
        })
        if (!silent) message.success('触发信息已生成，请核对后保存')
      } else if (!silent) {
        message.error(d.message || '生成失败')
      }
    } catch {
      if (!silent) message.error('本地服务未启动')
    } finally {
      setSuggesting(false)
    }
  }

  useEffect(() => {
    if (open) {
      form.setFieldsValue(templateToForm(initial))
      setJsonPreview('')
      resetDebug(initial)
      // 抓包草稿没有触发元信息 → 自动补全一次
      const meta = (initial?.metadata || {}) as Record<string, unknown>
      if (initial && !((meta.trigger_keywords as string[]) || []).length) {
        setTimeout(() => runSuggest(true), 300)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial, form])

  const handleSave = async () => {
    const values = await form.validateFields()
    const tpl = formToTemplate(values)
    setSaving(true)
    try {
      const { baseUrl } = getLoginServiceConfig()
      const resp = await fetch(`${baseUrl}/api/smart-chain/template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: tpl }),
      })
      const d = (await resp.json()) as { success?: boolean; message?: string }
      if (d.success) {
        message.success(`业办技能「${values.name}」已保存，smart-api-chain 可立即执行`)
        onSaved()
        onClose()
      } else {
        message.error(d.message || '保存失败')
      }
    } catch {
      message.error('本地服务未启动，无法保存')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      title={initial && initialIsCustom ? `编辑业办技能：${String(initial.name)}` : '新建业办技能'}
      width={920}
      open={open}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={() => setJsonPreview(JSON.stringify(formToTemplate(form.getFieldsValue(true)), null, 2))}>
            生成 JSON 预览
          </Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
            保存
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical">
        <Divider orientation="left" plain>基本信息</Divider>
        <Space style={{ display: 'flex' }} size={12} wrap>
          <Form.Item name="name" label="技能名称" rules={[{ required: true, message: '必填' }]} style={{ width: 280 }}>
            <Input placeholder="如：商户保证金查询" disabled={!!initial && initialIsCustom} />
          </Form.Item>
          <Form.Item name="version" label="版本" style={{ width: 100 }}>
            <Input />
          </Form.Item>
          <Form.Item name="preferred_tab_domain" label="页面域名" style={{ width: 260 }}>
            <Input placeholder="如：workstation.aliexpress.com" />
          </Form.Item>
        </Space>
        <Form.Item name="description" label="描述（同时作为意图说明）" rules={[{ required: true, message: '必填' }]}>
          <Input.TextArea rows={2} placeholder="这个技能查什么、怎么查" />
        </Form.Item>

        <Divider orientation="left" plain>入参</Divider>
        <Form.List name="inputs">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...rest }) => (
                <Space key={key} align="baseline" style={{ display: 'flex' }} size={8}>
                  <Form.Item {...rest} name={[name, 'name']} rules={[{ required: true, message: '参数名' }]} style={{ width: 180, marginBottom: 8 }}>
                    <Input placeholder="参数名 如 sellerId" />
                  </Form.Item>
                  <Form.Item {...rest} name={[name, 'description']} style={{ width: 380, marginBottom: 8 }}>
                    <Input placeholder="说明（展示给 AI 与用户）" />
                  </Form.Item>
                  <Form.Item {...rest} name={[name, 'required']} valuePropName="checked" style={{ marginBottom: 8 }}>
                    <Radio.Group>
                      <Radio value={true}>必填</Radio>
                      <Radio value={false}>可选</Radio>
                    </Radio.Group>
                  </Form.Item>
                  <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(name)} />
                </Space>
              ))}
              <Button size="small" icon={<PlusOutlined />} onClick={() => add({ name: '', description: '', required: true })}>
                添加入参
              </Button>
            </>
          )}
        </Form.List>

        <Divider orientation="left" plain>执行步骤</Divider>
        <Form.List name="steps">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...rest }) => (
                <div key={key} style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                  <Space style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Form.Item {...rest} name={[name, 'mode']} style={{ marginBottom: 8 }}>
                      <Radio.Group>
                        <Radio.Button value="page">页面交互（填表+点击+拦截接口）</Radio.Button>
                        <Radio.Button value="api">直接接口（URL+请求体）</Radio.Button>
                      </Radio.Group>
                    </Form.Item>
                    <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(name)} />
                  </Space>
                  <Space style={{ display: 'flex' }} size={12} wrap>
                    <Form.Item {...rest} name={[name, 'id']} label="步骤 ID" style={{ width: 180 }}>
                      <Input />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'description']} label="步骤说明" style={{ width: 420 }}>
                      <Input />
                    </Form.Item>
                  </Space>
                  <Form.Item noStyle shouldUpdate={(a, b) => a.steps?.[name]?.mode !== b.steps?.[name]?.mode}>
                    {({ getFieldValue }) =>
                      getFieldValue(['steps', name, 'mode']) === 'page' ? (
                        <Space style={{ display: 'flex' }} size={12} wrap>
                          <Form.Item {...rest} name={[name, 'navigate_url']} label="页面 URL" style={{ width: 560 }}>
                            <Input placeholder="https://..." />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'input_selector']} label="输入框选择器" style={{ width: 260 }}>
                            <Input placeholder="input[placeholder*='Id']" />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'input_value']} label="填入值（{{参数名}}）" style={{ width: 200 }}>
                            <Input placeholder="{{sellerId}}" />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'click_selector']} label="点击按钮选择器" style={{ width: 260 }}>
                            <Input />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'intercept_url_pattern']} label="拦截接口匹配" style={{ width: 300 }}>
                            <Input placeholder="mtop.ae.admin.crm.other.search" />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'wait_seconds']} label="等待秒数" style={{ width: 100 }}>
                            <Input type="number" />
                          </Form.Item>
                        </Space>
                      ) : (
                        <Space style={{ display: 'flex' }} size={12} wrap>
                          <Form.Item {...rest} name={[name, 'method']} label="Method" style={{ width: 100 }}>
                            <Radio.Group>
                              <Radio.Button value="GET">GET</Radio.Button>
                              <Radio.Button value="POST">POST</Radio.Button>
                            </Radio.Group>
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'url_template']} label="URL 模板" style={{ width: 560 }}>
                            <Input placeholder="https://.../{{param}}" />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'headers_text']} label="Headers（Key: value 每行一个）" style={{ width: 560 }}>
                            <Input.TextArea rows={2} />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'body_template']} label="Body 模板（JSON，可用 {{参数名}}）" style={{ width: 560 }}>
                            <Input.TextArea rows={3} />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'input_map_text']} label="入参映射（key = {{参数名}}）" style={{ width: 300 }}>
                            <Input.TextArea rows={2} />
                          </Form.Item>
                        </Space>
                      )
                    }
                  </Form.Item>
                  <Form.Item {...rest} name={[name, 'output_extract_text']} label="输出提取（字段 = JSONPath，每行一个）" style={{ marginBottom: 0 }}>
                    <Input.TextArea rows={2} placeholder={'accountStatus = $.data.data.dataSource[0].status'} />
                  </Form.Item>
                </div>
              ))}
              <Button size="small" icon={<PlusOutlined />} onClick={() => add({ mode: 'page', id: '', description: '', navigate_url: '', input_selector: '', input_value: '', click_selector: '', intercept_url_pattern: '', wait_seconds: 3, method: 'GET', url_template: '', body_template: '', headers_text: '', input_map_text: '', output_extract_text: '' })}>
                添加步骤
              </Button>
            </>
          )}
        </Form.List>

        <Divider orientation="left" plain>
          <Space>
            输出与触发
            <Button size="small" icon={<RobotOutlined />} loading={suggesting} onClick={() => runSuggest(false)}>
              AI 生成触发信息
            </Button>
          </Space>
        </Divider>
        <Form.Item name="final_output_text" label="最终输出字段（字段 = JSONPath 引用步骤输出，如 $.step0_query.output.xxx）">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Space style={{ display: 'flex' }} size={12} wrap>
          <Form.Item name="trigger_keywords" label="触发词（AI 选模板的依据）" style={{ width: 460 }}>
            <SelectTags />
          </Form.Item>
          <Form.Item name="sample_text" label="示例问题（每行一个）" style={{ width: 400 }}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Space>
        <Form.Item name="do_not_use_text" label="不应使用本技能的场景（每行一个，防止 AI 误选）">
          <Input.TextArea rows={2} />
        </Form.Item>

        <Divider orientation="left" plain>调试（直连执行 + Cockpit 对话测试）</Divider>
        <Space style={{ display: 'flex', marginBottom: 8 }} size={8} wrap>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={debugRunning} onClick={runDebug}>
            直连执行
          </Button>
          <Button icon={<CommentOutlined />} onClick={() => setChatTestOpen(true)}>
            Cockpit 对话测试
          </Button>
          <Button icon={<FileAddOutlined />} disabled={!debugResult} onClick={handleCreateTicket}>
            产对外工单
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            直连执行走 run_chain.py（需 iboss 登录态在线）；Cockpit 对话测试为多轮对话，可在其中补模拟 ID/订单号
          </Typography.Text>
        </Space>
        <Input.TextArea
          rows={3}
          value={debugInput}
          onChange={(e) => setDebugInput(e.target.value)}
          placeholder='调试入参 JSON，如 {"sellerId": "123"}'
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
        {debugResult && (
          <div style={{ marginTop: 8 }}>
            {debugResult.status === 'error' ? (
              <Alert type="error" showIcon message="执行失败" description={debugResult.error} />
            ) : (
              <>
                <Tag color="success">执行成功</Tag>
                <pre style={{ background: '#f6ffed', padding: 12, borderRadius: 6, fontSize: 11, maxHeight: 260, overflow: 'auto' }}>
                  {JSON.stringify(debugResult.result ?? {}, null, 2)}
                </pre>
              </>
            )}
          </div>
        )}

        {jsonPreview && (
          <Collapse
            style={{ marginTop: 16 }}
            items={[{
              key: 'json',
              label: '模板 JSON 预览',
              children: (
                <pre style={{ background: '#f6f8fa', padding: 12, fontSize: 11, maxHeight: 360, overflow: 'auto' }}>
                  {jsonPreview}
                </pre>
              ),
            }]}
          />
        )}
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
          保存后模板写入 smart-api-chain 的 chains/业务模板/ 并更新 INDEX.json（custom 标记），
          run_chain.py 与 Cockpit Agent 可立即执行；内置模板不受影响。
        </Typography.Paragraph>
      </Form>
      <CockpitChatTestModal
        open={chatTestOpen}
        title={`Cockpit 对话测试：${String(form.getFieldValue('name') || '技能')}`}
        seedQuestion={chatSeed()}
        onClose={() => setChatTestOpen(false)}
      />
    </Drawer>
  )
}

/** 触发词标签输入（Select tags 模式的薄封装，便于 Form.Item 受控） */
const SelectTags: React.FC<{ value?: string[]; onChange?: (v: string[]) => void }> = ({ value, onChange }) => (
  <Select
    mode="tags"
    style={{ width: '100%' }}
    placeholder="输入后回车添加"
    value={value}
    onChange={onChange}
  />
)

export default ChainTemplateEditor
