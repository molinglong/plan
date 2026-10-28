import type { PlanItem } from '../src/types'
import { loadEnv } from './env'

loadEnv()

/**
 * 调 aichatt 的 /api/plan/schedule。
 *
 * 职责边界：aichatt 只算「任务放进哪个时间块」，不碰 plan 的库；
 * 这里拿回 blocks 自己写库。AI 挂了不能影响用户排计划，调用方负责回退本地。
 */

export interface RemoteBlock {
  itemId: string
  startMin: number
  endMin: number
  reason: string
}

export interface RemoteDeferred {
  itemId: string
  reason: string
}

export interface RemoteResult {
  blocks: RemoteBlock[]
  deferred: RemoteDeferred[]
  model?: string
}

export interface ScheduleConstraints {
  windows: { startMin: number; endMin: number }[]
  fixed: { id: string; title: string; startMin: number; endMin: number }[]
  bufferRatio: number
  nowMin: number
}

const TIMEOUT_MS = 45_000

export function remoteEnabled() {
  return Boolean(process.env.AICHATT_URL && process.env.AICHATT_TOKEN)
}

/** 只保留结构合法的块，脏数据宁可丢也不写进用户的计划表 */
function sanitize(raw: unknown): RemoteResult {
  const data = (raw ?? {}) as Record<string, unknown>
  const blocks: RemoteBlock[] = []
  const deferred: RemoteDeferred[] = []

  if (Array.isArray(data.blocks)) {
    for (const b of data.blocks) {
      if (!b || typeof b !== 'object') continue
      const block = b as Record<string, unknown>
      const { itemId, startMin, endMin, reason } = block
      if (typeof itemId !== 'string') continue
      if (typeof startMin !== 'number' || typeof endMin !== 'number') continue
      if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) continue
      if (endMin <= startMin) continue
      blocks.push({
        itemId,
        startMin,
        endMin,
        reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 60) : '按空档排入',
      })
    }
  }

  if (Array.isArray(data.deferred)) {
    for (const d of data.deferred) {
      if (!d || typeof d !== 'object') continue
      const item = d as Record<string, unknown>
      if (typeof item.itemId !== 'string') continue
      deferred.push({
        itemId: item.itemId,
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 60) : '今天放不下',
      })
    }
  }

  return {
    blocks,
    deferred,
    model: typeof data.model === 'string' ? data.model : undefined,
  }
}

export async function requestSchedule(input: {
  date: string
  items: PlanItem[]
  constraints: ScheduleConstraints
}): Promise<RemoteResult> {
  const base = (process.env.AICHATT_URL || '').replace(/\/+$/, '')
  const token = process.env.AICHATT_TOKEN || ''
  if (!base || !token) throw new Error('未配置 AICHATT_URL / AICHATT_TOKEN')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(`${base}/api/plan/schedule`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        date: input.date,
        items: input.items.map((i) => ({
          id: i.id,
          title: i.title,
          kind: i.kind,
          priority: i.priority,
          estimateMin: i.estimateMin,
          energy: i.energy,
        })),
        constraints: input.constraints,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`aichatt ${res.status}: ${detail.slice(0, 160)}`)
    }

    return sanitize(await res.json())
  } finally {
    clearTimeout(timer)
  }
}
