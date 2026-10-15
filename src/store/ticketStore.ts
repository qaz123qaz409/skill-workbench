import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Ticket, TicketStatus, TicketDraft } from '@/types/ticket'

interface TicketState {
  tickets: Ticket[]
  filter: {
    status: TicketStatus | 'all'
    keyword: string
  }

  addTicket: (ticket: Ticket) => void
  updateTicket: (id: string, updates: Partial<Ticket>) => void
  setFilter: (filter: Partial<TicketState['filter']>) => void
  clearAll: () => void

  /** 技能执行产出对外工单（产单核心入口） */
  generateFromSkill: (draft: TicketDraft) => Ticket
  /** 生命周期：派发 → 处理中 → 办结 / 取消 */
  dispatchTicket: (id: string, target: string, note?: string) => void
  markProcessing: (id: string) => void
  completeTicket: (id: string, handleNote: string, handledBy?: string) => void
  cancelTicket: (id: string, note?: string) => void

  getStats: () => {
    generated: number
    dispatched: number
    processing: number
    done: number
    todayCreated: number
    todayDone: number
  }
}

/** 生成对外工单号 WB-YYYYMMDD-序号 */
function makeTicketNo(seq: number): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `WB-${ymd}-${String(seq).padStart(3, '0')}`
}

export const useTicketStore = create<TicketState>()(
  persist(
    (set, get) => ({
      tickets: [],
      filter: { status: 'all', keyword: '' },

      addTicket: (ticket) =>
        set((state) => ({ tickets: [ticket, ...state.tickets] })),

      updateTicket: (id, updates) =>
        set((state) => ({
          tickets: state.tickets.map((t) =>
            t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t
          ),
        })),

      setFilter: (filter) =>
        set((state) => ({ filter: { ...state.filter, ...filter } })),

      clearAll: () => set({ tickets: [] }),

      generateFromSkill: (draft) => {
        const now = Date.now()
        const seq = get().tickets.length + 1
        const ticket: Ticket = {
          id: `ticket-${now}-${Math.random().toString(36).slice(2, 7)}`,
          ticketNo: makeTicketNo(seq),
          title: draft.title,
          skillName: draft.skillName,
          triggerSource: draft.triggerSource,
          inputParams: draft.inputParams || {},
          execResult: draft.execResult,
          execStatus: draft.execStatus || 'none',
          reason: draft.reason || '',
          target: draft.target || '',
          suggestion: draft.suggestion || '',
          priority: draft.priority || 'normal',
          status: 'generated',
          createdAt: now,
          updatedAt: now,
        }
        set((state) => ({ tickets: [ticket, ...state.tickets] }))
        return ticket
      },

      dispatchTicket: (id, target, note) =>
        set((state) => ({
          tickets: state.tickets.map((t) =>
            t.id === id
              ? { ...t, status: 'dispatched' as TicketStatus, target: target || t.target,
                  handleNote: note || t.handleNote, updatedAt: Date.now() }
              : t
          ),
        })),

      markProcessing: (id) =>
        set((state) => ({
          tickets: state.tickets.map((t) =>
            t.id === id ? { ...t, status: 'processing' as TicketStatus, updatedAt: Date.now() } : t
          ),
        })),

      completeTicket: (id, handleNote, handledBy = 'current_user') =>
        set((state) => ({
          tickets: state.tickets.map((t) =>
            t.id === id
              ? { ...t, status: 'done' as TicketStatus, handleNote, handledBy,
                  handledAt: Date.now(), updatedAt: Date.now() }
              : t
          ),
        })),

      cancelTicket: (id, note) =>
        set((state) => ({
          tickets: state.tickets.map((t) =>
            t.id === id
              ? { ...t, status: 'cancelled' as TicketStatus,
                  handleNote: note || t.handleNote, updatedAt: Date.now() }
              : t
          ),
        })),

      getStats: () => {
        const { tickets } = get()
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const todayTs = today.getTime()
        return {
          generated: tickets.filter((t) => t.status === 'generated').length,
          dispatched: tickets.filter((t) => t.status === 'dispatched').length,
          processing: tickets.filter((t) => t.status === 'processing').length,
          done: tickets.filter((t) => t.status === 'done').length,
          todayCreated: tickets.filter((t) => t.createdAt >= todayTs).length,
          todayDone: tickets.filter((t) => t.status === 'done' && (t.handledAt || 0) >= todayTs).length,
        }
      },
    }),
    {
      name: 'skill-workbench-out-tickets-v2',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
