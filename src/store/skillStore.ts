import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Skill, TestCase, SkillExecution } from '@/types/skill'

interface SkillState {
  skills: Skill[]
  testCases: TestCase[]
  executions: SkillExecution[]
  currentSkillId: string | null

  // Skill CRUD
  addSkill: (skill: Skill) => void
  updateSkill: (id: string, updates: Partial<Skill>) => void
  deleteSkill: (id: string) => void
  setCurrentSkillId: (id: string | null) => void

  // TestCase CRUD
  addTestCase: (tc: TestCase) => void
  updateTestCase: (id: string, updates: Partial<TestCase>) => void
  deleteTestCase: (id: string) => void

  // Execution
  addExecution: (exec: SkillExecution) => void
}

export const useSkillStore = create<SkillState>()(
  persist(
    (set) => ({
      skills: [],
      testCases: [],
      executions: [],
      currentSkillId: null,

      addSkill: (skill) =>
        set((state) => ({ skills: [...state.skills, skill] })),

      updateSkill: (id, updates) =>
        set((state) => ({
          skills: state.skills.map((s) =>
            s.id === id ? { ...s, ...updates, updatedAt: Date.now() } : s
          ),
        })),

      deleteSkill: (id) =>
        set((state) => ({
          skills: state.skills.filter((s) => s.id !== id),
          testCases: state.testCases.filter((tc) => tc.skillId !== id),
        })),

      setCurrentSkillId: (id) => set({ currentSkillId: id }),

      addTestCase: (tc) =>
        set((state) => ({ testCases: [...state.testCases, tc] })),

      updateTestCase: (id, updates) =>
        set((state) => ({
          testCases: state.testCases.map((tc) =>
            tc.id === id ? { ...tc, ...updates } : tc
          ),
        })),

      deleteTestCase: (id) =>
        set((state) => ({
          testCases: state.testCases.filter((tc) => tc.id !== id),
        })),

      addExecution: (exec) =>
        set((state) => ({
          executions: [exec, ...state.executions].slice(0, 200),
        })),
    }),
    {
      name: 'skill-workbench-skills',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
