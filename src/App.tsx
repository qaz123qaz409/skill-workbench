import React, { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AppLayout from '@/components/AppLayout'
import SkillList from '@/pages/skills/SkillList'
import WorkflowList from '@/pages/workflows/WorkflowList'
import WorkflowEditor from '@/pages/workflows/WorkflowEditor'
import TicketBoard from '@/pages/tickets/TicketBoard'
import ChatPage from '@/pages/chat/ChatPage'
import KnowledgeBase from '@/pages/kb/KnowledgeBase'
import MaintenancePage from '@/pages/kb/MaintenancePage'
import SettingsPage from '@/pages/settings/SettingsPage'
import { seedBuiltinSkills, loadSeededIds, purgeRetiredSkills } from '@/services/builtinSkills'
import { useSkillStore } from '@/store/skillStore'

const App: React.FC = () => {
  const addSkill = useSkillStore((s) => s.addSkill)
  const updateSkill = useSkillStore((s) => s.updateSkill)
  const deleteSkill = useSkillStore((s) => s.deleteSkill)

  useEffect(() => {
    // 启动时清理已下架的内置 Skill（iboss 登录、知识编译/发布），再注入现有内置
    const existingSkills = useSkillStore.getState().skills
    purgeRetiredSkills(deleteSkill, existingSkills)
    seedBuiltinSkills(addSkill, updateSkill, useSkillStore.getState().skills, loadSeededIds())
  }, [addSkill, updateSkill, deleteSkill])

  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <AppLayout>
          <Routes>
            <Route path="/" element={<Navigate to="/skills" replace />} />
            <Route path="/skills" element={<SkillList />} />
            <Route path="/workflows" element={<WorkflowList />} />
            <Route path="/workflows/editor" element={<WorkflowEditor />} />
            <Route path="/tickets" element={<TicketBoard />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/kb" element={<KnowledgeBase />} />
            <Route path="/kb/maintenance" element={<MaintenancePage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </ConfigProvider>
  )
}

export default App
