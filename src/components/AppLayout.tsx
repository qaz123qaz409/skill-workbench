import React, { useState } from 'react'
import { Layout, Menu, theme } from 'antd'
import {
  BookOutlined,
  CodeOutlined,
  UnorderedListOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  RobotOutlined,
  ToolOutlined,
  ApartmentOutlined,
} from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'

const { Sider, Content } = Layout

const menuItems = [
  {
    key: 'skills',
    icon: <CodeOutlined />,
    label: 'Skill 管理',
    children: [
      { key: '/skills', icon: <UnorderedListOutlined />, label: '业办原子能力 Skill' },
      { key: '/workflows', icon: <ApartmentOutlined />, label: '业办工作流 Skill' },
    ],
  },
  {
    key: '/chat',
    icon: <RobotOutlined />,
    label: 'AI 对话',
  },
  {
    key: 'tickets',
    icon: <UnorderedListOutlined />,
    label: '对外工单',
    children: [
      { key: '/tickets', icon: <UnorderedListOutlined />, label: '对外工单看板' },
    ],
  },
  {
    key: 'kb',
    icon: <BookOutlined />,
    label: '知识库',
    children: [
      { key: '/kb', icon: <BookOutlined />, label: '编译知识' },
      { key: '/kb/maintenance', icon: <ToolOutlined />, label: '知识维护' },
    ],
  },
  {
    key: 'settings',
    icon: <SettingOutlined />,
    label: '设置',
    children: [
      { key: '/settings', icon: <SettingOutlined />, label: '连接配置' },
    ],
  },
]

const AppLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [collapsed, setCollapsed] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="light"
        style={{
          borderRight: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <ThunderboltOutlined
            style={{ fontSize: 24, color: token.colorPrimary, marginRight: collapsed ? 0 : 8 }}
          />
          {!collapsed && (
            <span style={{ fontWeight: 600, fontSize: 16 }}>Skill Workbench</span>
          )}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          defaultOpenKeys={['skills', 'debug', 'tickets', 'kb', 'settings']}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0 }}
        />
      </Sider>
      <Layout>
        <Content
          style={{
            padding: 24,
            background: token.colorBgLayout,
            overflow: 'auto',
          }}
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  )
}

export default AppLayout
