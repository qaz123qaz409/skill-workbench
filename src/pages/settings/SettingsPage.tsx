import React, { useState, useEffect } from 'react'
import {
  Card, Form, Input, Button, Switch, Descriptions, Tag, Divider,
  Alert, Space, message, Typography, Modal, Select,
  Table, Popconfirm,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  LinkOutlined, DisconnectOutlined, SendOutlined, SaveOutlined,
  SafetyOutlined, LoginOutlined, ReloadOutlined, KeyOutlined,
  ClusterOutlined,
  RocketOutlined,
  UserOutlined,
} from '@ant-design/icons'
import {
  getDingTalkConfig,
  saveDingTalkConfig,
  sendDingTalkMarkdown,
  type DingTalkConfig,
} from '@/services/dingtalk'
import { checkCockpitConnection, launchCockpit } from '@/services/desktopClient'
import {
  getPersonaConfig,
  savePersonaConfig,
  syncPersonaToCockpit,
  getSyncedPersona,
  DEFAULT_PERSONA,
  type PersonaConfig,
} from '@/services/personaService'
import {
  getLoginStatus,
  saveCredentials,
  triggerRelogin,
  openIbossTab,
  getLoginServiceConfig,
  saveLoginServiceConfig,
  getInstances,
  startInstance,
  stopInstance,
  triggerReloginForTenant,
  type LoginStatus,
  type LoginServiceConfig,
  type CdpInstance,
} from '@/services/loginService'
import { IBOSS_TENANTS, getPortByTenant } from '@/constants/tenants'

const { Text } = Typography

const SettingsPage: React.FC = () => {
  const [dingForm] = Form.useForm()
  const [credForm] = Form.useForm()
  const [loginCfgForm] = Form.useForm()
  const [dingConfig, setDingConfig] = useState<DingTalkConfig>(getDingTalkConfig())
  const [cockpitStatus, setCockpitStatus] = useState<{
    connected: boolean
    message: string
  }>({ connected: false, message: '检测中...' })
  const [testingDing, setTestingDing] = useState(false)
  const [launchingCockpit, setLaunchingCockpit] = useState(false)
  const [personaCfg, setPersonaCfg] = useState<PersonaConfig>(getPersonaConfig())
  const [personaDraft, setPersonaDraft] = useState(getPersonaConfig().content)
  const [personaSyncedContent, setPersonaSyncedContent] = useState<string | null>(null)
  const [syncingPersona, setSyncingPersona] = useState(false)
  const [loginStatus, setLoginStatus] = useState<LoginStatus>({
    logged_in: false,
    reachable: false,
    detail: '检测中...',
  })
  const [savingCred, setSavingCred] = useState(false)
  const [relogging, setRelogging] = useState(false)
  const [cfgModalOpen, setCfgModalOpen] = useState(false)
  const [loginCfg, setLoginCfg] = useState<LoginServiceConfig>(getLoginServiceConfig())
  const [instances, setInstances] = useState<CdpInstance[]>([])
  const [loadingInstances, setLoadingInstances] = useState(false)
  /** 正在执行操作的租户（启动/登录/停止） */
  const [busyTenant, setBusyTenant] = useState<string | null>(null)

  const refreshLoginStatus = () => getLoginStatus().then(setLoginStatus)

  const refreshInstances = async () => {
    setLoadingInstances(true)
    const list = await getInstances()
    setInstances(list)
    setLoadingInstances(false)
  }

  useEffect(() => {
    dingForm.setFieldsValue(dingConfig)
    checkCockpitConnection().then(setCockpitStatus)
    refreshLoginStatus()
    // 拉取 Cockpit 工作区已同步的人设（用于展示一致性状态）
    getSyncedPersona().then((r) => setPersonaSyncedContent(r.synced ? r.content : null))
  }, [dingForm, dingConfig])

  // 服务可达时拉取实例列表（不可达时展示静态端口映射表）
  useEffect(() => {
    if (loginStatus.reachable) refreshInstances()
  }, [loginStatus.reachable])

  const handleSaveDing = async () => {
    const values = await dingForm.validateFields()
    const newConfig: DingTalkConfig = { ...values }
    saveDingTalkConfig(newConfig)
    setDingConfig(newConfig)
    message.success('钉钉配置已保存')
  }

  const handleTestDing = async () => {
    setTestingDing(true)
    const result = await sendDingTalkMarkdown(
      dingConfig,
      'Skill Workbench 测试',
      '### 🔧 连接测试\n\n如果你收到这条消息，说明钉钉 Bot 配置正确。\n\n— Skill Workbench'
    )
    setTestingDing(false)
    if (result.success) {
      message.success('测试消息已发送，请检查钉钉')
    } else {
      message.error(result.message)
    }
  }

  const handleLaunchCockpit = async () => {
    setLaunchingCockpit(true)
    // 唤起前自动同步人设到 Cockpit 上下文（每次唤起都带最新人设）
    if (personaCfg.enabled && personaCfg.content.trim()) {
      const sync = await syncPersonaToCockpit(personaCfg.content)
      if (sync.success) {
        setPersonaSyncedContent(personaCfg.content)
      } else {
        message.warning(`人设同步失败：${sync.message}（不影响唤起）`)
      }
    }
    message.loading({ content: '正在通过命令行唤起 Cockpit 桌面版...', key: 'cockpit', duration: 0 })
    const result = await launchCockpit()
    message.destroy('cockpit')
    setLaunchingCockpit(false)
    if (result.success) {
      message.success(result.message)
      checkCockpitConnection().then(setCockpitStatus)
    } else {
      message.error(result.message)
    }
  }

  const personaDirty = personaDraft !== personaCfg.content
  const personaOutOfSync =
    personaSyncedContent === null || personaSyncedContent !== personaCfg.content

  const handleSavePersona = () => {
    const newCfg: PersonaConfig = { ...personaCfg, content: personaDraft }
    savePersonaConfig(newCfg)
    setPersonaCfg({ ...newCfg, updatedAt: new Date().toISOString() })
    message.success('人设已保存（下次唤起 Cockpit 时自动生效）')
  }

  const handleSyncPersona = async () => {
    setSyncingPersona(true)
    const result = await syncPersonaToCockpit(personaDraft)
    setSyncingPersona(false)
    if (result.success) {
      // 保存草稿为正式配置并更新同步状态
      const newCfg: PersonaConfig = { ...personaCfg, content: personaDraft }
      savePersonaConfig(newCfg)
      setPersonaCfg({ ...newCfg, updatedAt: new Date().toISOString() })
      setPersonaSyncedContent(personaDraft)
      message.success(result.message)
    } else {
      message.error(result.message)
    }
  }

  const handleSaveCred = async () => {
    const values = await credForm.validateFields()
    setSavingCred(true)
    const result = await saveCredentials(values.username, values.password)
    setSavingCred(false)
    if (result.success) {
      message.success(result.message)
      credForm.resetFields()
      refreshLoginStatus()
    } else {
      message.error(result.message)
    }
  }

  const handleRelogin = async () => {
    setRelogging(true)
    message.loading({ content: '正在自动登录（SSO 导航 + 填凭据，约 30s）...', key: 'relogin', duration: 0 })
    const result = await triggerRelogin()
    setRelogging(false)
    message.destroy('relogin')
    if (result.success) {
      message.success(`登录成功：${result.user || ''} @ ${result.tenant || ''}`)
      refreshLoginStatus()
    } else {
      message.error(result.message || '自动登录失败')
      refreshLoginStatus()
    }
  }

  const handleOpenIboss = async () => {
    const ok = await openIbossTab()
    if (ok) {
      message.success('已在 Debug Chrome 打开 iboss，请在弹出的浏览器里手动登录')
    } else {
      message.error('打开失败：请确认本地登录服务已启动且 Debug Chrome 在运行')
    }
  }

  const handleSaveLoginCfg = async () => {
    const values = await loginCfgForm.validateFields()
    // 端口由租户唯一绑定，不让用户手选
    const newCfg: LoginServiceConfig = {
      baseUrl: values.baseUrl,
      tenant: values.tenant,
      cdpPort: getPortByTenant(values.tenant) ?? 9307,
    }
    saveLoginServiceConfig(newCfg)
    setLoginCfg(newCfg)
    setCfgModalOpen(false)
    message.success('登录服务配置已保存')
    setTimeout(refreshLoginStatus, 300)
  }

  /** 启动指定租户实例 + 自动登录 */
  const handleStartAndLogin = async (tenant: string) => {
    setBusyTenant(tenant)
    message.loading({ content: `正在启动 ${tenant} 实例...`, key: tenant, duration: 0 })
    const started = await startInstance(tenant)
    if (!started.success) {
      message.destroy(tenant)
      setBusyTenant(null)
      message.error(`启动失败：${started.message}`)
      return
    }
    message.loading({ content: `实例已启动，正在自动登录 ${tenant}（约 30s）...`, key: tenant, duration: 0 })
    const result = await triggerReloginForTenant(tenant)
    message.destroy(tenant)
    setBusyTenant(null)
    if (result.success) {
      message.success(`${tenant} 登录成功：${result.user || ''}`)
    } else {
      message.warning(`实例已启动，但自动登录未完成：${result.message || '请在弹出的浏览器里手动登录'}`)
    }
    refreshInstances()
  }

  /** 停止指定租户实例 */
  const handleStopInstance = async (port: number) => {
    message.loading({ content: `正在停止端口 ${port} 的实例...`, key: `stop-${port}`, duration: 0 })
    const result = await stopInstance(port)
    message.destroy(`stop-${port}`)
    result.success
      ? message.success(`端口 ${port}：${result.message}`)
      : message.error(`停止失败：${result.message}`)
    refreshInstances()
  }

  // 实例表格数据：服务不可达时降级为静态端口映射表
  const instanceRows = loginStatus.reachable && instances.length > 0
    ? instances
    : IBOSS_TENANTS.map((t) => ({ tenant: t.value, label: t.label, port: t.port, running: false }))

  const instanceColumns: ColumnsType<CdpInstance> = [
    {
      title: '端口', dataIndex: 'port', width: 80,
      render: (port: number) => <Text code>{port}</Text>,
    },
    { title: '租户', dataIndex: 'tenant', width: 110 },
    { title: '备注', dataIndex: 'label', ellipsis: true },
    {
      title: '状态', dataIndex: 'running', width: 100,
      render: (running: boolean) =>
        loginStatus.reachable ? (
          running ? <Tag color="success">运行中</Tag> : <Tag>未启动</Tag>
        ) : (
          <Tag>服务未启动</Tag>
        ),
    },
    {
      title: '操作', key: 'actions', width: 180,
      render: (_, record) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            loading={busyTenant === record.tenant}
            disabled={!loginStatus.reachable || (busyTenant !== null && busyTenant !== record.tenant)}
            onClick={() => handleStartAndLogin(record.tenant)}
          >
            启动+登录
          </Button>
          {record.running && (
            <Popconfirm
              title={`停止 ${record.tenant} 实例？`}
              onConfirm={() => handleStopInstance(record.port)}
              okText="停止"
              cancelText="取消"
            >
              <Button size="small" type="link" danger disabled={!loginStatus.reachable}>
                停止
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <h2>设置</h2>

      {/* Cockpit 连接状态 */}
      <Card title="GenAI Cockpit 连接" style={{ marginBottom: 16 }}>
        <Descriptions column={1}>
          <Descriptions.Item label="连接状态">
            {cockpitStatus.connected ? (
              <Tag icon={<LinkOutlined />} color="success">已连接</Tag>
            ) : (
              <Tag icon={<DisconnectOutlined />} color="default">未连接</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="说明">
            <Text type="secondary">
              {cockpitStatus.message}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label="MCP 配置目录">
            <Text code>~/.config/genai-cockpit/mcp/</Text>
          </Descriptions.Item>
        </Descriptions>
        <Space>
          <Button
            type="primary"
            icon={<RocketOutlined />}
            onClick={handleLaunchCockpit}
            loading={launchingCockpit}
          >
            {cockpitStatus.connected ? '打开 Cockpit 桌面版' : '唤起 Cockpit 桌面版'}
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => checkCockpitConnection().then(setCockpitStatus)}
          >
            重新检测
          </Button>
        </Space>
        <Alert
          type="info"
          showIcon
          message="Skill 以 MCP 协议集成到 Cockpit"
          description="在 Skill 编辑器中点击「MCP 配置」按钮，将生成的 JSON 配置添加到 Cockpit 的 MCP 设置中即可。"
          style={{ marginTop: 12 }}
        />
      </Card>

      {/* AI 人设 */}
      <Card
        title={<span><UserOutlined /> AI 人设（唤起 Cockpit 时自动注入上下文）</span>}
        style={{ marginBottom: 16 }}
        extra={
          <Switch
            checked={personaCfg.enabled}
            checkedChildren="已启用"
            unCheckedChildren="已禁用"
            onChange={(checked) => {
              const newCfg = { ...personaCfg, enabled: checked }
              savePersonaConfig(newCfg)
              setPersonaCfg(newCfg)
            }}
          />
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="每次点「唤起 Cockpit 桌面版」前，人设会自动写入 Cockpit 工作区的 CLAUDE.md（标记块幂等更新），AI 每次会话都会带着这份人设。"
          description={
            <span>
              同步状态：
              {personaSyncedContent === null ? (
                <Tag style={{ marginLeft: 4 }}>未同步</Tag>
              ) : personaOutOfSync ? (
                <Tag color="warning" style={{ marginLeft: 4 }}>本地有更新，待同步</Tag>
              ) : (
                <Tag color="success" style={{ marginLeft: 4 }}>已同步</Tag>
              )}
            </span>
          }
        />
        <Input.TextArea
          value={personaDraft}
          onChange={(e) => setPersonaDraft(e.target.value)}
          rows={10}
          placeholder={DEFAULT_PERSONA}
          style={{ fontFamily: 'monospace', marginBottom: 12 }}
        />
        <Space wrap>
          <Button
            icon={<SaveOutlined />}
            onClick={handleSavePersona}
            disabled={!personaDirty}
          >
            保存人设
          </Button>
          <Button
            type="primary"
            icon={<RocketOutlined />}
            onClick={handleSyncPersona}
            loading={syncingPersona}
            disabled={!personaDraft.trim()}
          >
            立即同步到 Cockpit
          </Button>
          <Button onClick={() => setPersonaDraft(DEFAULT_PERSONA)}>
            恢复默认人设
          </Button>
        </Space>
      </Card>

      {/* iboss 登录能力 */}
      <Card
        title={<span><SafetyOutlined /> iboss 登录（自动重登）</span>}
        style={{ marginBottom: 16 }}
        extra={
          <Button size="small" icon={<KeyOutlined />} onClick={() => {
            loginCfgForm.setFieldsValue(loginCfg)
            setCfgModalOpen(true)
          }}>
            服务配置
          </Button>
        }
      >
        <Descriptions column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="登录态">
            {loginStatus.logged_in ? (
              <Tag icon={<LinkOutlined />} color="success">
                已登录{loginStatus.user ? `：${loginStatus.user}` : ''}
                {loginStatus.tenant ? ` @ ${loginStatus.tenant}` : ''}
              </Tag>
            ) : loginStatus.reachable ? (
              <Tag icon={<DisconnectOutlined />} color="error">未登录</Tag>
            ) : (
              <Tag icon={<DisconnectOutlined />} color="default">本地登录服务未启动</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="凭据">
            {loginStatus.credential_saved ? (
              <Tag color="success">已保存（Keychain 加密）{loginStatus.credential_user ? `：${loginStatus.credential_user}` : ''}</Tag>
            ) : (
              <Tag color="warning">未保存</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="服务地址">
            <Text code>{loginCfg.baseUrl}</Text>
            <Text type="secondary" style={{ marginLeft: 8 }}>
              CDP 端口 {loginCfg.cdpPort} / 租户 {loginCfg.tenant}
              {(() => {
                const t = IBOSS_TENANTS.find((x) => x.value === loginCfg.tenant)
                return t && t.label !== loginCfg.tenant ? `（${t.label}）` : ''
              })()}
            </Text>
          </Descriptions.Item>
        </Descriptions>

        <Space wrap>
          <Button
            type="primary"
            icon={<LoginOutlined />}
            onClick={handleRelogin}
            loading={relogging}
            disabled={!loginStatus.reachable}
          >
            自动登录
          </Button>
          <Button icon={<ReloadOutlined />} onClick={refreshLoginStatus}>
            刷新状态
          </Button>
          <Button onClick={handleOpenIboss} disabled={!loginStatus.reachable}>
            打开 iboss（手动登录）
          </Button>
        </Space>

        <Divider style={{ margin: '16px 0' }} />

        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="凭据安全说明"
          description="密码仅通过本地服务写入系统钥匙串（macOS Keychain）加密存储，不存 localStorage、不进日志。与 smart-api-chain 技能中台共用同一份凭据。启动服务：python3 server/iboss_login_service.py"
        />

        {!loginStatus.credential_saved && (
          <Form form={credForm} layout="inline" style={{ marginTop: 4 }}>
            <Form.Item
              name="username"
              rules={[{ required: true, message: '请输入工号' }]}
            >
              <Input placeholder="工号" style={{ width: 160 }} autoComplete="off" />
            </Form.Item>
            <Form.Item
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password placeholder="密码" style={{ width: 200 }} autoComplete="new-password" />
            </Form.Item>
            <Form.Item>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                onClick={handleSaveCred}
                loading={savingCred}
                disabled={!loginStatus.reachable}
              >
                保存凭据
              </Button>
            </Form.Item>
          </Form>
        )}
      </Card>

      {/* CDP 实例管理：42 租户 × 专属端口 */}
      <Card
        title={<span><ClusterOutlined /> CDP 实例管理（每租户独立浏览器实例）</span>}
        style={{ marginBottom: 16 }}
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={refreshInstances}
            loading={loadingInstances}
            disabled={!loginStatus.reachable}
          >
            刷新状态
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="端口-租户唯一绑定：9301-9342（避开 smart-api-chain 的 9222-9232）"
          description="每个租户一个独立 Chrome 实例（专属调试端口 + 专属 profile），登录态互不覆盖，可多租户并行处理工单。「启动+登录」会自动拉起实例并走 SSO 自动登录。"
        />
        <Table<CdpInstance>
          rowKey="tenant"
          size="small"
          columns={instanceColumns}
          dataSource={instanceRows}
          pagination={{ pageSize: 10, showTotal: (total) => `共 ${total} 个租户` }}
          scroll={{ y: 420 }}
        />
      </Card>

      {/* 登录服务配置弹窗 */}
      <Modal
        title="登录服务配置"
        open={cfgModalOpen}
        onOk={handleSaveLoginCfg}
        onCancel={() => setCfgModalOpen(false)}
        okText="保存"
        cancelText="取消"
      >
        <Form form={loginCfgForm} layout="vertical">
          <Form.Item
            name="baseUrl"
            label="本地登录服务地址"
            rules={[{ required: true, message: '请输入服务地址' }]}
          >
            <Input placeholder="http://127.0.0.1:18890" />
          </Form.Item>
          <Form.Item
            name="tenant"
            label="默认租户（登录时选择，CDP 端口自动按租户绑定）"
            rules={[{ required: true, message: '请选择租户' }]}
          >
            <Select
              showSearch
              placeholder="搜索或选择租户"
              optionFilterProp="label"
              options={IBOSS_TENANTS.map((t) => ({
                value: t.value,
                label: `${t.label}（端口 :${t.port}）`,
              }))}
              filterOption={(input, option) =>
                (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 钉钉 Bot 配置 */}
      <Card
        title="钉钉 Bot 通知"
        extra={
          <Switch
            checked={dingConfig.enabled}
            checkedChildren="已启用"
            unCheckedChildren="已禁用"
            onChange={(checked) => {
              const newConfig = { ...dingConfig, enabled: checked }
              saveDingTalkConfig(newConfig)
              setDingConfig(newConfig)
              dingForm.setFieldsValue(newConfig)
            }}
          />
        }
      >
        <Alert
          type="info"
          showIcon
          message="工单 AI 处理完成后，通过钉钉 Bot 推送审批提醒"
          description="需要在钉钉群中添加自定义机器人，获取 Webhook 地址。"
          style={{ marginBottom: 16 }}
        />
        <Form form={dingForm} layout="vertical" style={{ maxWidth: 600 }}>
          <Form.Item
            name="webhookUrl"
            label="Webhook 地址"
            rules={[{ required: dingConfig.enabled, message: '请输入 Webhook 地址' }]}
          >
            <Input placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxx" />
          </Form.Item>
          <Form.Item
            name="secret"
            label="加签密钥（可选）"
          >
            <Input.Password placeholder="SECxxxx" />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveDing}>
                保存配置
              </Button>
              <Button
                icon={<SendOutlined />}
                onClick={handleTestDing}
                loading={testingDing}
                disabled={!dingConfig.webhookUrl}
              >
                发送测试消息
              </Button>
            </Space>
          </Form.Item>
        </Form>

        <Divider />

        <Descriptions column={1} size="small">
          <Descriptions.Item label="通知触发时机">
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              <li>工单 AI 处理完成，进入"待审批"状态时</li>
              <li>工单状态变更时（可选）</li>
            </ul>
          </Descriptions.Item>
          <Descriptions.Item label="消息格式">
            ActionCard（带"通过"/"驳回"/"查看详情"按钮）
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  )
}

export default SettingsPage
