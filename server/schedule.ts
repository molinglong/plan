import type { PlanItem } from '../src/types'
import { listForDay, update } from './repo'
import { remoteEnabled, requestSchedule, type ScheduleConstraints } from './remote'

const DAY_START = 6 * 60
const DAY_END = 24 * 60
const LATEST_END = DAY_END - 30
/** 可用时长里至少留三成缓冲：计划排满等于注定失败 */
const BUFFER_RATIO = 0.3

function nowMinutes() {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && aEnd > bStart
}

function reasonFor(item: PlanItem, start: number): string {
  if (item.kind === 'event') return '固定安排，不可移动'
  if (item.energy === 'deep') {
    return start < 12 * 60 ? '上午精力好，安排需要专注的' : '下午整块时间，适合沉下去做'
  }
  if (start >= 19 * 60) return '晚上安排轻量任务，不硬塞深度工作'
  if (item.energy === 'light') return '事务性工作，插在空档里顺手做完'
  if (item.priority === 2) return '优先级高，尽量往前放'
  return '按空档顺排，留了缓冲'
}

export interface ScheduleResult {
  items: PlanItem[]
  added: number
  source: 'ai' | 'local'
  model?: string
  /** 降级到本地排程时的原因，前端只用来提示一次 */
  note?: string
  deferred?: { itemId: string; reason: string }[]
}

interface LocalScheduleOptions {
  /** 从几点开始找空档；默认沿用原来的「现在或 13:30 之后」 */
  startMin?: number
  /** 只占用可用空档的这个比例；不传则沿用旧的填满策略 */
  budgetRatio?: number
  reasonPrefix?: string
}

/** 本地启发式：不看语义，只找空档顺排。AI 不可用时的兜底 */
function scheduleLocal(
  date: string,
  targets: PlanItem[],
  userId = 'me',
  opts: LocalScheduleOptions = {}
): { added: number } {
  const items = listForDay(date, userId)
  const busy = items
    .filter((i) => i.startMin != null && i.endMin != null)
    .map((i) => ({ start: i.startMin!, end: i.endMin! }))

  let cursor = Math.max(opts.startMin ?? Math.max(nowMinutes(), 13 * 60 + 30), DAY_START)
  const budget = opts.budgetRatio == null
    ? Infinity
    : freeWindows(cursor, LATEST_END, busy.map((b) => ({ startMin: b.start, endMin: b.end })))
        .reduce((sum, w) => sum + (w.endMin - w.startMin), 0) * opts.budgetRatio
  let used = 0
  let added = 0

  for (const item of targets) {
    if (item.kind === 'memo' || item.estimateMin <= 0) continue
    if (used + item.estimateMin > budget) continue

    let start = Math.max(cursor, DAY_START)
    let guard = 0
    while (guard++ < 400) {
      const conflict = busy.find((b) =>
        overlap(start, start + item.estimateMin, b.start, b.end)
      )
      if (!conflict) break
      start = conflict.end + 5
    }

    if (start + item.estimateMin > LATEST_END) continue

    const baseReason = reasonFor(item, start)
    update(item.id, {
      status: 'planned',
      plannedDate: date,
      startMin: start,
      endMin: start + item.estimateMin,
      reason: opts.reasonPrefix ? `${opts.reasonPrefix} · ${baseReason}` : baseReason,
    }, userId)

    busy.push({ start, end: start + item.estimateMin })
    cursor = start + item.estimateMin + 5
    used += item.estimateMin
    added++
  }

  return { added }
}

/**
 * aichatt 今天到期的新待办，同步后自动排进今天的空档。
 * 只占七成可用时间；排不下的仍回待安排，不重复尝试。
 */
export function autoScheduleImported(
  date: string,
  targets: PlanItem[],
  userId: string,
  nowMin = nowMinutes()
): number {
  if (!targets.length) return 0
  return scheduleLocal(date, targets, userId, {
    startMin: Math.max(nowMin, DAY_START),
    budgetRatio: 0.7,
    reasonPrefix: 'aichatt 今天到期，自动排入',
  }).added
}

/** 把已占用的时间（固定事件 + 已排块）交给 AI，让它自己避开 */
function buildConstraints(items: PlanItem[], targets: PlanItem[]): ScheduleConstraints {
  const targetIds = new Set(targets.map((t) => t.id))
  const fixed = items
    .filter(
      (i) =>
        !targetIds.has(i.id) &&
        i.startMin != null &&
        i.endMin != null &&
        (i.kind === 'event' || i.status === 'planned')
    )
    .map((i) => ({
      id: i.id,
      title: i.title,
      startMin: i.startMin!,
      endMin: i.endMin!,
    }))

  const now = nowMinutes()
  const start = Math.max(DAY_START, Math.min(now, LATEST_END - 30))

  return {
    // 空档由程序算好再给模型：让它自己从 fixed 里推空档，它会直接放弃
    windows: freeWindows(start, LATEST_END, fixed),
    fixed,
    bufferRatio: BUFFER_RATIO,
    nowMin: now,
  }
}

/** 从 [start, end) 里扣掉所有占用，得到可用空档；小于 15 分钟的不算空档 */
function freeWindows(
  start: number,
  end: number,
  busy: { startMin: number; endMin: number }[]
): { startMin: number; endMin: number }[] {
  const sorted = [...busy].sort((a, b) => a.startMin - b.startMin)
  const windows: { startMin: number; endMin: number }[] = []
  let cursor = start

  for (const b of sorted) {
    if (b.endMin <= cursor) continue
    if (b.startMin >= end) break
    if (b.startMin > cursor) {
      windows.push({ startMin: cursor, endMin: Math.min(b.startMin, end) })
    }
    cursor = Math.max(cursor, Math.min(b.endMin, end))
    if (cursor >= end) break
  }

  if (cursor < end) windows.push({ startMin: cursor, endMin: end })
  return windows.filter((w) => w.endMin - w.startMin >= 15)
}

/**
 * 排今天：
 * 1. AI 优先（aichatt /api/plan/schedule），它懂优先级和精力曲线；
 * 2. 未配置令牌、超时、报错、或一个块都没有 ── 回退本地顺排。
 * 用户要的是「今天有个可行的表」，不是「一定要用 AI」。
 */
export async function scheduleDay(
  date: string,
  mode: 'all' | 'one',
  id: string | undefined,
  userId = 'me'
): Promise<ScheduleResult> {
  const all = listForDay(date, userId)
  const targets =
    mode === 'one'
      ? all.filter((i) => i.id === id && !i.done && i.status === 'inbox')
      : all.filter((i) => i.status === 'inbox' && i.kind !== 'memo' && !i.done)

  // 没有可排任务（可能都排好了），不打扰 AI
  if (targets.length === 0) {
    return { items: all, added: 0, source: 'local', note: '没有待排任务' }
  }

  let note: string | undefined

  // 只排一条时没必要问模型：空档是硬信息，本地算完直接给，快五倍
  if (remoteEnabled() && targets.length > 1) {
    try {
      const constraints = buildConstraints(all, targets)
      if (constraints.windows.length === 0) {
        return { items: all, added: 0, source: 'local', note: '今天没有空档了，先留到明天' }
      }
      const result = await requestSchedule({ date, items: targets, constraints })

      const byId = new Map(targets.map((t) => [t.id, t]))
      let added = 0
      for (const block of result.blocks) {
        const item = byId.get(block.itemId)
        // AI 返回了不存在的 id 或不合法时长，直接跳过（remote 已过滤结构，这里挡语义）
        if (!item) continue
        if (block.endMin - block.startMin > item.estimateMin * 2) continue

        update(item.id, {
          status: 'planned',
          plannedDate: date,
          startMin: block.startMin,
          endMin: block.endMin,
          reason: block.reason,
        }, userId)
        added++
      }

      const deferred = result.deferred.filter((d) => byId.has(d.itemId))
      if (added > 0) {
        return {
          items: listForDay(date, userId),
          added,
          source: 'ai',
          model: result.model,
          deferred,
        }
      }
      // 200 但一个块都没落地：把原始返回记下来，方便判断是模型没排还是守卫丢的
      console.warn('[plan] ai returned no usable block:', JSON.stringify(result).slice(0, 400))
      note = 'AI 没排出合适的块，已按空档顺排'
    } catch (err) {
      console.warn('[plan] remote schedule failed, fallback to local:', err)
      note = 'AI 排程暂不可用，已按空档顺排'
    }
  } else if (!remoteEnabled()) {
    note = '未配置 AI 排程，按空档顺排'
  }

  const local = scheduleLocal(date, targets, userId)
  return {
    items: listForDay(date, userId),
    added: local.added,
    source: 'local',
    note,
  }
}
