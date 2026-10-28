import type { PlanItem } from '../types'
import { DAY_END, DAY_START, nowMinutes, overlap } from './time'

/** 排程只接受"今天还不算太晚"的位置，23:30 之后不再塞任务 */
const LATEST_END = DAY_END - 30

export function reasonFor(item: PlanItem, start: number): string {
  if (item.energy === 'deep' && start < 12 * 60) return '上午精力最好，先啃需要思考的'
  if (start >= 19 * 60) return '晚上安排轻量任务，不硬塞深度工作'
  if (item.energy === 'light') return '事务性工作，插在空档里顺手做完'
  if (item.priority === 2) return '优先级高，尽量往前放'
  return '按空档顺排，留了缓冲'
}

function planInto(
  items: PlanItem[],
  targetIds: Set<string>,
  startCursor: number
): { items: PlanItem[]; added: string[] } {
  const busy = items
    .filter((i) => i.status === 'planned' && i.startMin != null)
    .map((i) => ({ start: i.startMin!, end: i.endMin! }))

  let cursor = Math.max(startCursor, DAY_START)
  const added: string[] = []

  const next = items.map((item) => {
    if (!targetIds.has(item.id)) return item
    if (item.kind === 'memo' || item.estimateMin <= 0) return item

    let start = cursor
    let guard = 0
    while (guard++ < 400) {
      const conflict = busy.find((b) =>
        overlap(start, start + item.estimateMin, b.start, b.end)
      )
      if (!conflict) break
      start = conflict.end + 5
    }

    if (start + item.estimateMin > LATEST_END) return item

    busy.push({ start, end: start + item.estimateMin })
    cursor = start + item.estimateMin + 5
    added.push(item.id)

    return {
      ...item,
      status: 'planned' as const,
      startMin: start,
      endMin: start + item.estimateMin,
      reason: reasonFor(item, start),
    }
  })

  return { items: next, added }
}

/** 把所有待安排任务顺次放进今天剩下的空档 */
export function scheduleAll(items: PlanItem[]) {
  const ids = new Set(
    items.filter((i) => i.status === 'inbox' && i.kind !== 'memo').map((i) => i.id)
  )
  return planInto(items, ids, Math.max(nowMinutes(), 13 * 60 + 30))
}

/** 单条排入今天：从当前时间往后找第一个装得下的空档 */
export function scheduleOne(items: PlanItem[], id: string) {
  return planInto(items, new Set([id]), Math.max(nowMinutes(), DAY_START))
}
