import React, { useEffect, useState } from 'react'
import { Card, Table, Tag, Button, Space, Popconfirm, message, Typography } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ApartmentOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { getLoginServiceConfig } from '@/services/loginService'

const { Text, Paragraph } = Typography

export interface WorkflowItem {
  id: string
  name: string
  intent?: string
  sop: string
  skills: string[]
  max_steps: number
  trigger_keywords?: string[]
  do_not_use_when?: string
  updated_at?: number
}

const WorkflowList: React.FC = () => {
  const navigate = useNavigate()
  const [items, setItems] = useState<WorkflowItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const { baseUrl } = getLoginServiceConfig()
      const resp = await fetch(`${baseUrl}/api/workflows`)
      const d = await resp.json()
      if (d.success) setItems(d.workflows || [])
    } catch {
      message.error('加载工作流失败，请确认本地服务已启动')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const handleDelete = async (id: string) => {
    const { baseUrl } = getLoginServiceConfig()
    const resp = await fetch(`${baseUrl}/api/workflows/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const d = await resp.json()
    if (d.success) {
      message.success('已删除')
      load()
    } else {
      message.error(d.message || '删除失败')
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>业办工作流 Skill</h2>
          <Text type="secondary" style={{ fontSize: 12 }}>
            自然语言 SOP 串联多个原子能力 Skill，运行时 AI 按查询结果动态决定下一步
          </Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/workflows/editor')}>
          新建工作流
        </Button>
      </div>

      <Card size="small">
        <Table
          rowKey="id"
          loading={loading}
          dataSource={items}
          pagination={false}
          columns={[
            {
              title: '工作流',
              dataIndex: 'name',
              width: 200,
              render: (v: string) => (
                <Space>
                  <ApartmentOutlined style={{ color: '#722ed1' }} />
                  <Text strong>{v}</Text>
                </Space>
              ),
            },
            {
              title: '意图',
              dataIndex: 'intent',
              render: (v: string) => (
                <Paragraph type="secondary" style={{ margin: 0, maxWidth: 360 }} ellipsis={{ rows: 2 }}>
                  {v || '-'}
                </Paragraph>
              ),
            },
            {
              title: '串联原子能力',
              dataIndex: 'skills',
              render: (skills: string[]) => (
                <Space size={4} wrap>
                  {(skills || []).map((s) => (
                    <Tag key={s} color="geekblue" style={{ fontSize: 11 }}>{s}</Tag>
                  ))}
                </Space>
              ),
            },
            { title: '步数上限', dataIndex: 'max_steps', width: 80 },
            {
              title: '更新时间',
              dataIndex: 'updated_at',
              width: 160,
              render: (v: number) => (v ? new Date(v * 1000).toLocaleString('zh-CN') : '-'),
            },
            {
              title: '操作',
              width: 140,
              render: (_: unknown, r: WorkflowItem) => (
                <Space>
                  <Button size="small" icon={<EditOutlined />}
                    onClick={() => navigate(`/workflows/editor?id=${r.id}`)}>
                    编辑
                  </Button>
                  <Popconfirm title="删除该工作流？" onConfirm={() => handleDelete(r.id)}>
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </div>
  )
}

export default WorkflowList
