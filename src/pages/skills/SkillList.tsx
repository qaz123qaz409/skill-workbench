import React, { useEffect, useState } from 'react'
import { Card, Tag, Button, Space, Empty, Popconfirm, Table, Tooltip, Drawer, Descriptions, Typography, Spin, message } from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
  ApiOutlined,
  LinkOutlined,
  CommentOutlined,
} from '@ant-design/icons'
import { getLoginServiceConfig } from '@/services/loginService'
import ChainTemplateEditor from './ChainTemplateEditor'
import ChainDetectModal from './ChainDetectModal'
import CockpitChatTestModal from '@/components/CockpitChatTestModal'

/** smart-api-chain 业务查询模板（从本地服务 /api/smart-chain/templates 实时读取 INDEX.json） */
interface SmartChainParam {
  name: string
  description: string
}
interface SmartChainTemplate {
  name: string
  intent: string
  custom?: boolean
  input_required: SmartChainParam[]
  trigger_keywords: string[]
  sample_questions: string[]
}

const SkillList: React.FC = () => {
  const [chainTemplates, setChainTemplates] = useState<SmartChainTemplate[]>([])
  const [chainLoading, setChainLoading] = useState(true)
  // 模板预览 Drawer
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewTpl, setPreviewTpl] = useState<Record<string, unknown> | null>(null)
  const [previewPath, setPreviewPath] = useState('')

  // 点击表格行 → 拉模板全文预览
  const openPreview = (name: string) => {
    const { baseUrl } = getLoginServiceConfig()
    setPreviewOpen(true)
    setPreviewLoading(true)
    setPreviewTpl(null)
    fetch(`${baseUrl}/api/smart-chain/template?name=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((d: { success?: boolean; template?: Record<string, unknown>; path?: string; custom?: boolean }) => {
        if (d.success && d.template) {
          setPreviewTpl(d.template)
          setPreviewPath(d.path || '')
          setPreviewCustom(!!d.custom)
        }
      })
      .catch(() => { /* 静默 */ })
      .finally(() => setPreviewLoading(false))
  }
  const refreshTemplates = () => {
    const { baseUrl } = getLoginServiceConfig()
    fetch(`${baseUrl}/api/smart-chain/templates`)
      .then((r) => r.json())
      .then((d: { success?: boolean; templates?: SmartChainTemplate[] }) => {
        if (d.success && d.templates) setChainTemplates(d.templates)
      })
      .catch(() => { /* 静默 */ })
      .finally(() => setChainLoading(false))
  }
  // 编辑器状态
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorInitial, setEditorInitial] = useState<Record<string, unknown> | null>(null)
  const [editorIsCustom, setEditorIsCustom] = useState(false)
  const [previewCustom, setPreviewCustom] = useState(false)
  const [detectOpen, setDetectOpen] = useState(false)
  // Cockpit 对话测试（列表/预览均可发起，多轮可补模拟 ID）
  const [chatTarget, setChatTarget] = useState<SmartChainTemplate | null>(null)
  const openChatTest = (name: string) => {
    const tpl = chainTemplates.find((t) => t.name === name)
    if (tpl) setChatTarget(tpl)
  }
  const chatSeedOf = (tpl: SmartChainTemplate) =>
    (tpl.sample_questions || [])[0] || `用${tpl.name}查一下`

  const handleDeleteTemplate = async (name: string) => {
    const { baseUrl } = getLoginServiceConfig()
    const resp = await fetch(`${baseUrl}/api/smart-chain/template/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const d = (await resp.json()) as { success?: boolean; message?: string }
    if (d.success) {
      message.success(`已删除「${name}」`)
      setPreviewOpen(false)
      refreshTemplates()
    } else {
      message.error(d.message || '删除失败')
    }
  }
  useEffect(() => {
    refreshTemplates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>业办原子能力 Skill</h2>
      </div>

      {/* smart-api-chain 业务查询模板 */}
      <Card
        size="small"
        style={{ marginTop: 24 }}
        title={
          <Space>
            <ApiOutlined style={{ color: '#1677ff' }} />
            <span>smart-api-chain 业务查询模板（{chainTemplates.length}）</span>
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ThunderboltOutlined style={{ color: '#fa8c16' }} />}
              onClick={() => setDetectOpen(true)}
            >
              抓包生成
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditorInitial(null)
                setEditorIsCustom(false)
                setEditorOpen(true)
              }}
            >
              新建业办技能
            </Button>
          </Space>
        }
      >
        {chainTemplates.length === 0 && !chainLoading ? (
          <Empty description="本地服务未启动或未找到 INDEX.json" />
        ) : (
          <Table
            size="small"
            loading={chainLoading}
            dataSource={chainTemplates}
            rowKey="name"
            pagination={false}
            scroll={{ y: 480 }}
            onRow={(r) => ({
              onClick: () => openPreview(r.name),
              style: { cursor: 'pointer' },
            })}
            columns={[
              { title: '模板', dataIndex: 'name', width: 220, render: (v: string, r: SmartChainTemplate) => (
                <Space size={4}>
                  <b>{v}</b>
                  {r.custom ? <Tag color="purple">自建</Tag> : null}
                </Space>
              ) },
              {
                title: '意图',
                dataIndex: 'intent',
                ellipsis: { showTitle: false },
                render: (v: string) => (
                  <Tooltip title={v} placement="topLeft">
                    <span>{v}</span>
                  </Tooltip>
                ),
              },
              {
                title: '必填入参',
                dataIndex: 'input_required',
                width: 240,
                render: (params: SmartChainParam[]) =>
                  params.length === 0 ? (
                    <Tag>无需入参</Tag>
                  ) : (
                    <Space size={2} wrap>
                      {params.map((p) => (
                        <Tooltip key={p.name} title={p.name + (p.description ? `：${p.description}` : '')} placement="top">
                          {/* INDEX 里 name 常自带括号描述，Tag 只取纯参数名 */}
                          <Tag color="blue" style={{ cursor: 'help' }}>{p.name.split(/[（(]/)[0]}</Tag>
                        </Tooltip>
                      ))}
                    </Space>
                  ),
              },
              {
                title: '触发词',
                dataIndex: 'trigger_keywords',
                width: 280,
                render: (kws: string[]) => (
                  <Space size={2} wrap>
                    {(kws || []).slice(0, 5).map((k) => (
                      <Tag key={k} style={{ fontSize: 11 }}>{k}</Tag>
                    ))}
                    {(kws || []).length > 5 && <Tag>+{kws.length - 5}</Tag>}
                  </Space>
                ),
              },
              {
                title: '操作',
                width: 110,
                render: (_: unknown, r: SmartChainTemplate) => (
                  <Button size="small" icon={<CommentOutlined />}
                    onClick={(e) => { e.stopPropagation(); openChatTest(r.name) }}>
                    Cockpit 测试
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      {/* 模板详情预览 */}
      <Drawer
        title={
          <Space>
            <ApiOutlined style={{ color: '#1677ff' }} />
            <span>{(previewTpl?.name as string) || '模板预览'}</span>
            {previewTpl?.version ? <Tag color="blue">v{String(previewTpl.version)}</Tag> : null}
          </Space>
        }
        width={760}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        extra={
          previewTpl ? (
            <Space>
              <Button
                size="small"
                icon={<CommentOutlined />}
                onClick={() => openChatTest(String(previewTpl.name))}
              >
                Cockpit 测试
              </Button>
              {previewCustom ? (
                <>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditorInitial(previewTpl)
                      setEditorIsCustom(true)
                      setPreviewOpen(false)
                      setEditorOpen(true)
                    }}
                  >
                    编辑
                  </Button>
                  <Popconfirm title="确定删除这个自建技能吗？" onConfirm={() => handleDeleteTemplate(String(previewTpl.name))}>
                    <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </>
              ) : (
                <Button
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    setEditorInitial(previewTpl)
                    setEditorIsCustom(false)
                    setPreviewOpen(false)
                    setEditorOpen(true)
                  }}
                >
                  基于此创建
                </Button>
              )}
            </Space>
          ) : null
        }
      >
        {previewLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
        ) : previewTpl ? (
          <div>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              {previewPath}
            </Typography.Paragraph>
            <Descriptions
              size="small"
              column={1}
              bordered
              style={{ marginBottom: 16 }}
              items={[
                { key: 'desc', label: '描述', children: String(previewTpl.description || '-') },
                {
                  key: 'domain',
                  label: '页面域名',
                  children: previewTpl.preferred_tab_domain ? (
                    <Tag icon={<LinkOutlined />} color="cyan">{String(previewTpl.preferred_tab_domain)}</Tag>
                  ) : '-',
                },
                {
                  key: 'input',
                  label: '入参',
                  children: (() => {
                    const inp = (previewTpl.input || {}) as Record<string, { description?: string; required?: boolean }>
                    const keys = Object.keys(inp)
                    return keys.length === 0 ? '无需入参' : (
                      <Space direction="vertical" size={4}>
                        {keys.map((k) => (
                          <div key={k}>
                            <Tag color="blue">{k}</Tag>
                            {inp[k]?.required && <Tag color="red">必填</Tag>}
                            <span style={{ color: '#8c8c8c', fontSize: 12 }}>{inp[k]?.description}</span>
                          </div>
                        ))}
                      </Space>
                    )
                  })(),
                },
              ]}
            />

            <Typography.Title level={5}>执行步骤（{(previewTpl.steps as unknown[])?.length || 0}）</Typography.Title>
            {((previewTpl.steps as Array<Record<string, unknown>>) || []).map((st, i) => {
              const pi = (st.page_interact || {}) as Record<string, unknown>
              const api = (st.api_request || st.api || {}) as Record<string, unknown>
              return (
                <Card key={String(st.id || i)} size="small" style={{ marginBottom: 8 }}>
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <b>{i + 1}. {String(st.id || '')}</b>
                    <div style={{ color: '#595959' }}>{String(st.description || '')}</div>
                    {pi.navigate_url ? (
                      <Typography.Text code style={{ fontSize: 11 }}>
                        {String(pi.navigate_url)}
                      </Typography.Text>
                    ) : null}
                    {api.url ? (
                      <Typography.Text code style={{ fontSize: 11 }}>
                        {String(api.method || 'GET')} {String(api.url)}
                      </Typography.Text>
                    ) : null}
                  </Space>
                </Card>
              )
            })}

            <Typography.Title level={5}>输出字段（{Object.keys((previewTpl.final_output || {}) as object).length}）</Typography.Title>
            <Space size={4} wrap style={{ marginBottom: 16 }}>
              {Object.keys((previewTpl.final_output || {}) as object).map((k) => (
                <Tooltip key={k} title={String(((previewTpl.final_output as Record<string, unknown>) || {})[k])}>
                  <Tag style={{ cursor: 'help' }}>{k}</Tag>
                </Tooltip>
              ))}
            </Space>

            <Typography.Title level={5}>原始 JSON</Typography.Title>
            <pre
              style={{
                background: '#f6f8fa',
                padding: 12,
                borderRadius: 6,
                fontSize: 11,
                maxHeight: 320,
                overflow: 'auto',
              }}
            >
              {JSON.stringify(previewTpl, null, 2)}
            </pre>
          </div>
        ) : (
          <Empty description="加载失败或本地服务未启动" />
        )}
      </Drawer>

      {/* 业办技能编辑器（自建/编辑/克隆） */}
      <ChainTemplateEditor
        open={editorOpen}
        initial={editorInitial}
        initialIsCustom={editorIsCustom}
        onClose={() => setEditorOpen(false)}
        onSaved={refreshTemplates}
      />

      {/* 抓包侦探生成草稿 → 转编辑器 */}
      <ChainDetectModal
        open={detectOpen}
        onClose={() => setDetectOpen(false)}
        onDraft={(draft) => {
          setEditorInitial(draft)
          setEditorIsCustom(false)
          setEditorOpen(true)
        }}
      />

      {/* Cockpit 对话测试（多轮，可补模拟 ID/订单号） */}
      <CockpitChatTestModal
        open={!!chatTarget}
        title={`Cockpit 对话测试：${chatTarget?.name || ''}`}
        seedQuestion={chatTarget ? chatSeedOf(chatTarget) : undefined}
        onClose={() => setChatTarget(null)}
      />
    </div>
  )
}

export default SkillList
