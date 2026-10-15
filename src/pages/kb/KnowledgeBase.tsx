import React, { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  Col,
  Empty,
  Input,
  List,
  message,
  Modal,
  Radio,
  Row,
  Space,
  Spin,
  Statistic,
  Steps,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import {
  BookOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  PlayCircleOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import {
  getKbTopics,
  getKbTopic,
  getKbSync,
  getKbSources,
  getKbBuildStatus,
  uploadKbSource,
  startKbCompile,
  publishKb,
  checkKbConflict,
  pullKbFromYuque,
  searchKb,
  type KbBuildDiff,
  type KbHit,
  type KbSourceFile,
  type KbTopic,
} from '@/services/kbService'

const { Text, Paragraph } = Typography

const YUQUE_CFG_KEY = 'kb-yuque-cfg'

/* ---------- 轻量 Markdown 渲染（无第三方依赖） ---------- */

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) {
      nodes.push(<strong key={`${keyBase}-b${i}`}>{tok.slice(2, -2)}</strong>)
    } else {
      nodes.push(
        <code
          key={`${keyBase}-c${i}`}
          style={{
            background: 'rgba(150,150,150,0.15)',
            padding: '0 4px',
            borderRadius: 4,
            fontSize: '0.9em',
          }}
        >
          {tok.slice(1, -1)}
        </code>
      )
    }
    last = m.index + tok.length
    i += 1
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const MarkdownView: React.FC<{ source: string }> = ({ source }) => {
  const blocks = useMemo(() => {
    const lines = source.split('\n')
    const out: React.ReactNode[] = []
    let para: string[] = []
    let list: string[] = []
    const flushPara = () => {
      if (para.length) {
        out.push(
          <Paragraph key={`p${out.length}`} style={{ marginBottom: 8 }}>
            {renderInline(para.join(' '), `p${out.length}`)}
          </Paragraph>
        )
        para = []
      }
    }
    const flushList = () => {
      if (list.length) {
        out.push(
          <ul key={`l${out.length}`} style={{ marginTop: 0 }}>
            {list.map((it, idx) => (
              <li key={idx}>{renderInline(it, `l${out.length}-${idx}`)}</li>
            ))}
          </ul>
        )
        list = []
      }
    }
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (/^###\s/.test(line)) {
        flushPara(); flushList()
        out.push(<h4 key={`h${out.length}`}>{renderInline(line.slice(4), `h${out.length}`)}</h4>)
      } else if (/^##\s/.test(line)) {
        flushPara(); flushList()
        out.push(
          <h3 key={`h${out.length}`} style={{ borderBottom: '1px solid rgba(150,150,150,0.25)', paddingBottom: 4 }}>
            {renderInline(line.slice(3), `h${out.length}`)}
          </h3>
        )
      } else if (/^#\s/.test(line)) {
        flushPara(); flushList()
        out.push(<h2 key={`h${out.length}`}>{renderInline(line.slice(2), `h${out.length}`)}</h2>)
      } else if (/^>\s?/.test(line)) {
        flushPara(); flushList()
        out.push(
          <blockquote
            key={`q${out.length}`}
            style={{
              borderLeft: '3px solid rgba(150,150,150,0.4)',
              margin: '8px 0',
              padding: '2px 12px',
              color: 'rgba(0,0,0,0.55)',
            }}
          >
            {renderInline(line.replace(/^>\s?/, ''), `q${out.length}`)}
          </blockquote>
        )
      } else if (/^[-*]\s/.test(line)) {
        flushPara()
        list.push(line.replace(/^[-*]\s/, ''))
      } else if (line.trim() === '') {
        flushPara(); flushList()
      } else {
        flushList()
        para.push(line)
      }
    }
    flushPara(); flushList()
    return out
  }, [source])
  return <div>{blocks}</div>
}

/* ---------- 主页面 ---------- */

const KnowledgeBase: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [builtAt, setBuiltAt] = useState('')
  const [sliceTotal, setSliceTotal] = useState(0)
  const [kbEngine, setKbEngine] = useState<'builtin' | 'llmwiki'>('builtin')
  const [conflictTotal, setConflictTotal] = useState(0)
  const [engine, setEngine] = useState<'builtin' | 'llmwiki'>('builtin')
  const [topics, setTopics] = useState<KbTopic[]>([])
  const [kbError, setKbError] = useState('')
  const [selected, setSelected] = useState('')
  const [doc, setDoc] = useState('')
  const [docLoading, setDocLoading] = useState(false)
  const [syncedTopics, setSyncedTopics] = useState<Record<string, number>>({})

  // 召回测试
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KbHit[]>([])
  const [searching, setSearching] = useState(false)

  // 语雀发布
  const [pubModal, setPubModal] = useState(false)
  const [yqToken, setYqToken] = useState('')
  const [yqNamespace, setYqNamespace] = useState('')
  const [yqBase, setYqBase] = useState('')
  const [publishing, setPublishing] = useState(false)

  // 更新流水线
  const [sources, setSources] = useState<KbSourceFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [buildStatus, setBuildStatus] = useState<'idle' | 'running' | 'done' | 'error' | 'unknown'>('idle')
  const [buildDetail, setBuildDetail] = useState('')
  const [buildLog, setBuildLog] = useState('')
  const [buildDiff, setBuildDiff] = useState<KbBuildDiff | null>(null)
  const [compiling, setCompiling] = useState(false)
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const loadSources = async () => {
    try {
      const resp = await getKbSources()
      if (resp.success) setSources(resp.files || [])
    } catch {
      /* 本地服务未启动时静默 */
    }
  }

  const pollBuild = React.useCallback(async () => {
    try {
      const st = await getKbBuildStatus()
      setBuildStatus(st.status)
      setBuildDetail(st.detail || '')
      setBuildLog(st.log_tail || '')
      setBuildDiff(st.diff || null)
      if (st.status !== 'running' && pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
        setCompiling(false)
        if (st.status === 'done') {
          message.success('编译完成')
          loadTopics()
        }
      }
    } catch {
      /* ignore */
    }
  }, [])

  const onUpload = async (file: File) => {
    setUploading(true)
    try {
      const resp = await uploadKbSource(file)
      if (resp.success) {
        message.success(`已上传 ${resp.name}`)
        loadSources()
      } else {
        message.error(resp.message || '上传失败')
      }
    } catch {
      message.error('上传失败（本地服务未启动？）')
    } finally {
      setUploading(false)
    }
    return false // 阻止 antd 默认上传
  }

  const onCompile = async () => {
    setCompiling(true)
    try {
      const resp = await startKbCompile(engine)
      if (!resp.success) {
        message.error(resp.message || '启动失败')
        setCompiling(false)
        return
      }
      message.info(
        engine === 'llmwiki'
          ? 'llm-wiki 协议编译已启动（raw 不可变源 + frontmatter + 冲突台账，需数分钟）'
          : '编译已启动（LLM 聚类 + 逐主题编译，需数分钟）'
      )
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(pollBuild, 3000)
      pollBuild()
    } catch {
      message.error('本地服务未启动')
      setCompiling(false)
    }
  }

  useEffect(() => {
    loadSources()
    pollBuild() // 页面打开时恢复编译状态
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadTopics = async () => {
    setLoading(true)
    setKbError('')
    try {
      const resp = await getKbTopics()
      if (resp.success && resp.topics) {
        setTopics(resp.topics)
        setBuiltAt(resp.built_at || '')
        setSliceTotal(resp.slice_total || 0)
        setKbEngine(resp.engine || 'builtin')
        setConflictTotal(resp.conflict_total || 0)
        if (!selected && resp.topics.length) setSelected(resp.topics[0].name)
      } else {
        setKbError(resp.message || '加载失败')
      }
      const sync = await getKbSync()
      if (sync.success) {
        setSyncedTopics(sync.yuque || {})
        // 服务端存储的发布配置自动回填，免重复填写
        const cfg = sync.config || {}
        if (cfg.token) setYqToken((prev) => prev || cfg.token!)
        if (cfg.namespace) setYqNamespace((prev) => prev || cfg.namespace!)
        if (cfg.api_base) setYqBase(cfg.api_base)
      }
    } catch {
      setKbError('本地服务未启动（请先启动 iboss_login_service.py）')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTopics()
    const cfg = localStorage.getItem(YUQUE_CFG_KEY)
    if (cfg) {
      try {
        const { token, namespace, base } = JSON.parse(cfg)
        setYqToken(token || '')
        setYqNamespace(namespace || '')
        if (base) setYqBase(base)
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selected) return
    setDocLoading(true)
    getKbTopic(selected)
      .then((resp) => setDoc(resp.success ? resp.doc || '' : ''))
      .catch(() => setDoc(''))
      .finally(() => setDocLoading(false))
  }, [selected])

  const onSearch = async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    try {
      const resp = await searchKb(q, 3)
      setHits(resp.success ? resp.hits || [] : [])
      if (!resp.success) message.error(resp.message || '召回失败')
    } catch {
      message.error('本地服务未启动')
    } finally {
      setSearching(false)
    }
  }

  const doPublishInner = async (topic?: string) => {
    setPublishing(true)
    try {
      const resp = await publishKb(yqToken, yqNamespace, topic, yqBase)
      if (resp.success) {
        message.success(`发布成功 ${resp.published}/${resp.total} 篇`)
        setPubModal(false)
        const sync = await getKbSync()
        if (sync.success) setSyncedTopics(sync.yuque || {})
      } else {
        message.error(resp.message || resp.results?.[0]?.error || '发布失败')
      }
    } catch {
      message.error('发布请求失败（本地服务未启动？）')
    } finally {
      setPublishing(false)
    }
  }

  const doPull = async () => {
    try {
      const resp = await pullKbFromYuque(yqToken, yqNamespace, yqBase)
      if (resp.success && resp.pulled) {
        message.success(`已拉回 ${resp.pulled} 篇人工编辑，召回索引已热更新`)
        loadTopics()
      } else {
        message.info(resp.message || '没有需要拉回的文档')
      }
    } catch {
      message.error('拉回失败（本地服务未启动？）')
    }
  }

  const doPublish = async (topic?: string) => {
    if (!yqToken || !yqNamespace) {
      message.warning('请填写语雀 Token 和知识库 namespace')
      return
    }
    localStorage.setItem(
      YUQUE_CFG_KEY,
      JSON.stringify({ token: yqToken, namespace: yqNamespace, base: yqBase })
    )
    // 发布前冲突检查：语雀端有未拉回的人工编辑时先确认
    if (Object.keys(syncedTopics).length) {
      try {
        const chk = await checkKbConflict(yqToken, yqNamespace, yqBase)
        if (chk.success && chk.stale && chk.stale.length) {
          Modal.confirm({
            title: '语雀端有未拉回的人工编辑',
            content: `《${chk.stale.map((s) => s.topic).join('》《')}》在发布后被编辑过，直接发布会覆盖这些修改。`,
            okText: '先拉回再发布',
            cancelText: '直接发布（覆盖）',
            onOk: async () => {
              await doPull()
              await doPublishInner(topic)
            },
            onCancel: () => doPublishInner(topic),
          })
          return
        }
      } catch {
        /* 检查失败不阻塞发布 */
      }
    }
    await doPublishInner(topic)
  }

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={18}>
          <Card size="small">
            <Row gutter={16}>
              <Col span={6}>
                <Statistic title="主题数" value={topics.length} prefix={<BookOutlined />} />
              </Col>
              <Col span={6}>
                <Statistic title="知识切片" value={sliceTotal} />
              </Col>
              <Col span={6}>
                <Statistic
                  title="已同步语雀"
                  value={Object.keys(syncedTopics).length}
                  suffix={`/ ${topics.length}`}
                />
              </Col>
              <Col span={6}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  编译时间 · 引擎
                  <br />
                  {builtAt ? new Date(builtAt).toLocaleString() : '-'}
                  <Tag
                    color={kbEngine === 'llmwiki' ? 'purple' : 'blue'}
                    style={{ marginLeft: 6 }}
                  >
                    {kbEngine === 'llmwiki' ? 'llm-wiki' : '内置'}
                  </Tag>
                  {conflictTotal > 0 && (
                    <Tag color="orange">冲突 {conflictTotal}</Tag>
                  )}
                </Text>
              </Col>
            </Row>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={{ height: '100%' }}>
            <Space style={{ width: '100%', justifyContent: 'center' }}>
              <Button
                icon={<CloudDownloadOutlined />}
                onClick={() => setPubModal(true)}
              >
                从语雀拉回
              </Button>
              <Button
                type="primary"
                icon={<CloudUploadOutlined />}
                onClick={() => setPubModal(true)}
              >
                发布到语雀
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Tabs
          defaultActiveKey="docs"
          items={[
            {
              key: 'docs',
              label: '主题文档',
              children: (
                <Row gutter={16}>
                  <Col span={8}>
                    {kbError ? (
                      <Empty description={kbError} />
                    ) : (
                      <List
                        loading={loading}
                        size="small"
                        dataSource={topics}
                        renderItem={(t) => (
                          <List.Item
                            onClick={() => setSelected(t.name)}
                            style={{
                              cursor: 'pointer',
                              background:
                                selected === t.name
                                  ? 'rgba(22,119,255,0.08)'
                                  : undefined,
                              borderRadius: 6,
                            }}
                          >
                            <List.Item.Meta
                              title={
                                <Space>
                                  <Text strong>{t.name}</Text>
                                  <Tag>{t.slice_count} 条</Tag>
                                  {syncedTopics[t.name] && (
                                    <Tooltip title="已同步语雀">
                                      <CheckCircleOutlined
                                        style={{ color: '#52c41a' }}
                                      />
                                    </Tooltip>
                                  )}
                                </Space>
                              }
                              description={
                                <Text type="secondary" ellipsis>
                                  {t.overview}
                                </Text>
                              }
                            />
                          </List.Item>
                        )}
                      />
                    )}
                  </Col>
                  <Col span={16}>
                    {docLoading ? (
                      <Spin />
                    ) : doc ? (
                      <MarkdownView source={doc} />
                    ) : (
                      <Empty description="选择左侧主题查看编译文档" />
                    )}
                  </Col>
                </Row>
              ),
            },
            {
              key: 'pipeline',
              label: '更新流程',
              children: (
                <div>
                  <Steps
                    size="small"
                    style={{ marginBottom: 20 }}
                    current={buildStatus === 'done' ? 3 : buildStatus === 'running' ? 1 : 0}
                    items={[
                      { title: '上传源文件', description: `${sources.length} 个 xlsx` },
                      { title: '编译', description: buildStatus === 'running' ? '进行中' : undefined },
                      { title: '查看变更', description: buildDiff ? '有 diff' : undefined },
                      { title: '发布语雀', description: `${Object.keys(syncedTopics).length} 篇已同步` },
                    ]}
                  />
                  <Row gutter={16}>
                    <Col span={10}>
                      <Card
                        size="small"
                        title="① 知识源文件（sources/）"
                        extra={
                          <Upload
                            accept=".xlsx"
                            showUploadList={false}
                            beforeUpload={onUpload}
                          >
                            <Button size="small" icon={<CloudUploadOutlined />} loading={uploading}>
                              上传 xlsx
                            </Button>
                          </Upload>
                        }
                        style={{ marginBottom: 16 }}
                      >
                        {sources.length ? (
                          <List
                            size="small"
                            dataSource={sources}
                            renderItem={(f) => (
                              <List.Item>
                                <Text ellipsis style={{ maxWidth: 220 }}>{f.name}</Text>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {(f.size / 1024).toFixed(0)} KB · {f.mtime}
                                </Text>
                              </List.Item>
                            )}
                          />
                        ) : (
                          <Empty description="上传知识切片导出的 xlsx" />
                        )}
                      </Card>
                      <Card size="small" title="② 一键重编译">
                        <Radio.Group
                          value={engine}
                          onChange={(e) => setEngine(e.target.value)}
                          disabled={buildStatus === 'running'}
                          size="small"
                          style={{ marginBottom: 10 }}
                        >
                          <Tooltip title="自研引擎：主题聚合文档 + 双层召回索引，速度快">
                            <Radio.Button value="builtin">内置引擎</Radio.Button>
                          </Tooltip>
                          <Tooltip title="llm-wiki 协议：raw 不可变源 + frontmatter + See Also 双向链接 + 冲突台账，合成质量优先">
                            <Radio.Button value="llmwiki">llm-wiki 协议</Radio.Button>
                          </Tooltip>
                        </Radio.Group>
                        <Space>
                          <Button
                            type="primary"
                            icon={compiling ? <SyncOutlined spin /> : <PlayCircleOutlined />}
                            onClick={onCompile}
                            loading={compiling && buildStatus !== 'running'}
                            disabled={buildStatus === 'running' || !sources.length}
                          >
                            {buildStatus === 'running' ? '编译中…' : '重新编译'}
                          </Button>
                          <Tag
                            color={
                              buildStatus === 'done' ? 'green'
                                : buildStatus === 'error' ? 'red'
                                : buildStatus === 'running' ? 'blue' : 'default'
                            }
                          >
                            {buildDetail || buildStatus}
                          </Tag>
                        </Space>
                        <pre
                          style={{
                            marginTop: 12,
                            marginBottom: 0,
                            background: 'rgba(150,150,150,0.1)',
                            borderRadius: 6,
                            padding: 8,
                            fontSize: 12,
                            maxHeight: 180,
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {buildLog || '（暂无编译日志）'}
                        </pre>
                      </Card>
                    </Col>
                    <Col span={14}>
                      <Card size="small" title="③ 变更 diff（上次编译 vs 当前）">
                        {buildDiff ? (
                          <div>
                            <Row gutter={12} style={{ marginBottom: 12 }}>
                              <Col span={6}>
                                <Statistic title="切片总数" value={buildDiff.new_slice_total}
                                  suffix={`(原 ${buildDiff.old_slice_total})`} />
                              </Col>
                              <Col span={6}>
                                <Statistic title="新增切片" value={buildDiff.slice_added.length}
                                  valueStyle={{ color: '#52c41a' }} />
                              </Col>
                              <Col span={6}>
                                <Statistic title="修改切片" value={buildDiff.slice_changed.length}
                                  valueStyle={{ color: '#faad14' }} />
                              </Col>
                              <Col span={6}>
                                <Statistic title="删除切片" value={buildDiff.slice_removed.length}
                                  valueStyle={{ color: '#ff4d4f' }} />
                              </Col>
                            </Row>
                            {buildDiff.topic_added.length > 0 && (
                              <Paragraph>
                                新增主题：{buildDiff.topic_added.map((t) => (
                                  <Tag color="green" key={t}>{t}</Tag>
                                ))}
                              </Paragraph>
                            )}
                            {buildDiff.topic_removed.length > 0 && (
                              <Paragraph>
                                移除主题：{buildDiff.topic_removed.map((t) => (
                                  <Tag color="red" key={t}>{t}</Tag>
                                ))}
                              </Paragraph>
                            )}
                            <Table
                              size="small"
                              pagination={false}
                              dataSource={[
                                ...buildDiff.slice_added.map((id) => ({ id, change: '新增' })),
                                ...buildDiff.slice_changed.map((id) => ({ id, change: '修改' })),
                                ...buildDiff.slice_removed.map((id) => ({ id, change: '删除' })),
                              ]}
                              rowKey="id"
                              scroll={{ y: 260 }}
                              columns={[
                                { title: '切片 ID', dataIndex: 'id' },
                                {
                                  title: '变更',
                                  dataIndex: 'change',
                                  width: 80,
                                  render: (v: string) => (
                                    <Tag color={v === '新增' ? 'green' : v === '修改' ? 'orange' : 'red'}>
                                      {v}
                                    </Tag>
                                  ),
                                },
                              ]}
                            />
                          </div>
                        ) : (
                          <Empty description="重编译后这里会展示变更对比" />
                        )}
                      </Card>
                    </Col>
                  </Row>
                </div>
              ),
            },
            {
              key: 'recall',
              label: '召回测试',
              children: (
                <div>
                  <Input.Search
                    placeholder="输入用户口语化提问，测试编译知识库召回效果"
                    enterButton={<><SearchOutlined /> 召回</>}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onSearch={onSearch}
                    loading={searching}
                    style={{ marginBottom: 16, maxWidth: 640 }}
                  />
                  {hits.map((h, i) => (
                    <Card
                      key={i}
                      size="small"
                      style={{ marginBottom: 8 }}
                      title={
                        <Space>
                          <Tag color={i === 0 ? 'blue' : undefined}>#{i + 1}</Tag>
                          <Text strong>{h.title}</Text>
                          {h.topic && <Tag>{h.topic}</Tag>}
                        </Space>
                      }
                    >
                      <Paragraph style={{ marginBottom: 4 }}>{h.content}</Paragraph>
                      {h.topic_overview && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          主题上下文：{h.topic_overview}
                        </Text>
                      )}
                    </Card>
                  ))}
                  {!hits.length && !searching && (
                    <Empty description="输入问题测试召回（别名层 BM25 + 主题上下文扩展）" />
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="发布到语雀"
        open={pubModal}
        onCancel={() => setPubModal(false)}
        confirmLoading={publishing}
        okText="发布全部主题"
        onOk={() => doPublish()}
      >
        <Paragraph type="secondary">
          编译好的主题文档将以 Markdown 形式推送到语雀知识库；重复发布会更新已有文档（映射记录在
          kb_out/sync.json）。
        </Paragraph>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.Password
            placeholder="语雀个人 Token（个人设置 → Token）"
            value={yqToken}
            onChange={(e) => setYqToken(e.target.value)}
          />
          <Input
            placeholder="知识库 namespace，如 group/book"
            value={yqNamespace}
            onChange={(e) => setYqNamespace(e.target.value)}
          />
          <Input
            placeholder="API 域名（公网 https://www.yuque.com；内网部署填企业内网 API 域名）"
            value={yqBase}
            onChange={(e) => setYqBase(e.target.value)}
          />
          {selected && (
            <Button size="small" onClick={() => doPublish(selected)}>
              仅发布当前主题：{selected}
            </Button>
          )}
        </Space>
      </Modal>
    </div>
  )
}

export default KnowledgeBase
