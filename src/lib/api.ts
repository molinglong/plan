import type { PlanItem, TodoSyncResult } from '../types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(typeof data?.error === 'string' ? data.error : `请求失败（${res.status}）`)
  }
  return res.json() as Promise<T>
}

export interface CreateItemInput {
  title: string
  note?: string
  kind?: PlanItem['kind']
  priority?: PlanItem['priority']
  estimateMin?: number
  energy?: PlanItem['energy']
  plannedDate?: string
  startMin?: number
  endMin?: number
}

export interface ScheduleResponse {
  items: PlanItem[]
  added: number
  /** ai = 走了 aichatt 的排程端点；local = 空档顺排兜底 */
  source: 'ai' | 'local'
  model?: string
  note?: string
  deferred?: { itemId: string; reason: string }[]
}

export interface ReviewResult {
  date: string
  planned: number
  done: number
  skipped: number
  rate: number
  plannedMinutes: number
  doneMinutes: number
  remaining: number
  postponed: { id: string; title: string; count: number }[]
  headline: string
  tips: string[]
}

export const api = {
  list(date: string) {
    return request<{ items: PlanItem[] }>(
      `/api/items?date=${encodeURIComponent(date)}`
    )
  },

  syncTodos(date: string) {
    return request<{ items: PlanItem[]; sync: TodoSyncResult }>('/api/sync/todos', {
      method: 'POST',
      body: JSON.stringify({ date }),
    })
  },

  create(input: CreateItemInput) {
    return request<PlanItem>('/api/items', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  update(id: string, patch: Record<string, unknown>) {
    return request<PlanItem>(`/api/items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  remove(id: string) {
    return request<{ ok: true }>(`/api/items/${id}`, { method: 'DELETE' })
  },

  restore(id: string, patch: Record<string, unknown>) {
    return request<PlanItem>(`/api/items/${id}/restore`, {
      method: 'POST',
      body: JSON.stringify(patch),
    })
  },

  schedule(date: string, mode: 'all' | 'one', id?: string) {
    return request<ScheduleResponse>('/api/schedule', {
      method: 'POST',
      body: JSON.stringify({ date, mode, id }),
    })
  },

  review(date: string) {
    return request<ReviewResult>(`/api/review?date=${encodeURIComponent(date)}`)
  },
}
