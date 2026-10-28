import { randomUUID } from 'node:crypto'
import { db } from './db'
import type { Energy, Kind, PlanItem, Priority, Status } from '../src/types'

type Row = Record<string, any>

const now = () => new Date().toISOString()

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

export function todayKey(): string {
  return dateKey(new Date())
}

function toItem(row: Row): PlanItem {
  return {
    id: row.id,
    title: row.title,
    note: row.note || undefined,
    kind: row.kind as Kind,
    status: row.status as Status,
    priority: row.priority as Priority,
    estimateMin: row.estimate_min,
    energy: row.energy as Energy,
    startMin: row.start_min ?? undefined,
    endMin: row.end_min ?? undefined,
    plannedDate: row.planned_date ?? undefined,
    reason: row.reason ?? undefined,
    done: row.done === 1,
    postponeCount: row.postpone_count,
    external: row.external_id ? { source: 'aichatt', missing: row.external_missing === 1 } : undefined,
  }
}

export function listForDay(date: string, userId = 'me'): PlanItem[] {
  const rows = db
    .prepare(
      `SELECT items.*, r.external_id, r.missing AS external_missing
       FROM items LEFT JOIN external_refs r ON r.item_id = items.id
       WHERE user_id = ? AND status != 'dropped'
         AND (status = 'inbox' OR planned_date = ?)
       ORDER BY
         CASE status WHEN 'inbox' THEN 1 ELSE 0 END,
         start_min IS NULL, start_min, created_at`
    )
    .all(userId, date) as Row[]
  return rows.map(toItem)
}

export function get(id: string, userId = 'me'): PlanItem | null {
  const row = db.prepare(`SELECT items.*, r.external_id, r.missing AS external_missing
    FROM items LEFT JOIN external_refs r ON r.item_id = items.id
    WHERE items.id = ? AND user_id = ?`).get(id, userId) as
    | Row
    | undefined
  return row ? toItem(row) : null
}

export interface CreateInput {
  title: string
  note?: string
  kind?: Kind
  priority?: Priority
  estimateMin?: number
  energy?: Energy
  /** 带时间创建时直接落成计划块（固定事件用） */
  plannedDate?: string | null
  startMin?: number | null
  endMin?: number | null
}

export function create(input: CreateInput, userId = 'me'): PlanItem {
  const id = randomUUID()
  const ts = now()
  const scheduled = input.startMin != null && input.endMin != null
  db.prepare(
    `INSERT INTO items
       (id, user_id, title, note, kind, status, priority, estimate_min, energy,
        planned_date, start_min, end_min, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    input.title,
    input.note ?? '',
    input.kind ?? 'task',
    scheduled ? 'planned' : 'inbox',
    input.priority ?? 1,
    input.estimateMin ?? 30,
    input.energy ?? 'any',
    scheduled ? (input.plannedDate ?? todayKey()) : null,
    scheduled ? input.startMin! : null,
    scheduled ? input.endMin! : null,
    scheduled ? '手动安排' : null,
    ts,
    ts
  )
  return get(id, userId)!
}

const COLUMN_MAP: Record<string, string> = {
  title: 'title',
  note: 'note',
  kind: 'kind',
  status: 'status',
  priority: 'priority',
  estimateMin: 'estimate_min',
  energy: 'energy',
  plannedDate: 'planned_date',
  startMin: 'start_min',
  endMin: 'end_min',
  reason: 'reason',
  done: 'done',
  postponeCount: 'postpone_count',
}

export function update(id: string, patch: Record<string, unknown>, userId = 'me'): PlanItem | null {
  const sets: string[] = []
  const values: Array<string | number | null> = []

  for (const [key, value] of Object.entries(patch)) {
    const col = COLUMN_MAP[key]
    if (!col) continue
    sets.push(`${col} = ?`)
    if (typeof value === 'boolean') values.push(value ? 1 : 0)
    else if (value === undefined || value === null) values.push(null)
    else values.push(value as string | number)
  }

  if (!sets.length) return get(id, userId)

  sets.push('updated_at = ?')
  values.push(now(), id, userId)
  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(
    ...values
  )
  return get(id, userId)
}

/**
 * 软删除：条目留在库里，撤销时能原样放回。
 *
 * 外链记录只标记 dismissed、不解除 item_id，这样撤销后仍能继续双向同步；
 * 同时下一次拉取不会把用户刚删掉的 aichatt 待办又导入回来。
 */
export function remove(id: string, userId = 'me') {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE external_refs SET dismissed = 1 WHERE item_id = ?`).run(id)
    db.prepare(
      `UPDATE items SET status = 'dropped', updated_at = ? WHERE id = ? AND user_id = ?`
    ).run(now(), id, userId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** 撤销删除：恢复外链并写回删除前的状态与时间 */
export function restore(id: string, patch: Record<string, unknown>, userId = 'me'): PlanItem | null {
  if (!get(id, userId)) return null
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE external_refs SET dismissed = 0 WHERE item_id = ?`).run(id)
    const item = update(id, patch, userId)
    db.exec('COMMIT')
    return item
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** 第一次打开时给一份可玩的初始数据，之后不再写入；生产默认空库 */
export function seedIfEmpty(date: string, userId = 'me') {
  if (process.env.NODE_ENV === 'production' && process.env.PLAN_SEED_DEMO !== '1') return
  const row = db.prepare(`SELECT COUNT(*) AS n FROM items WHERE user_id = ?`).get(userId) as Row
  if (row.n > 0) return

  const seed: Array<Omit<CreateInput, 'title'> & { title: string; planned?: number[] }> = [
    {
      title: '晨跑 3 公里',
      priority: 1,
      estimateMin: 30,
      planned: [7 * 60, 7 * 60 + 30],
    },
    {
      title: '写周报',
      note: '本周迭代进展 + 下周排期，重点写清风险和依赖。',
      priority: 2,
      estimateMin: 60,
      energy: 'deep',
      planned: [9 * 60 + 30, 10 * 60 + 30],
    },
    {
      title: '回复积压邮件',
      priority: 1,
      estimateMin: 30,
      energy: 'light',
      planned: [11 * 60, 11 * 60 + 30],
    },
    {
      title: '读《深度工作》第 3 章',
      priority: 1,
      estimateMin: 45,
      energy: 'deep',
      planned: [15 * 60, 15 * 60 + 45],
    },
    { title: '健身', priority: 1, estimateMin: 60, planned: [19 * 60, 20 * 60], kind: 'event' },
    { title: '买菜：西红柿、鸡蛋、面条', priority: 1, estimateMin: 30, energy: 'light' },
    { title: '给妈妈打个电话', priority: 2, estimateMin: 15 },
    { title: '整理桌面和下载文件夹', priority: 0, estimateMin: 20, energy: 'light' },
    { title: '看一集纪录片', priority: 0, estimateMin: 45, energy: 'light' },
    {
      title: '周末短途旅行清单',
      note: '充电宝、身份证、雨伞、晕车药、提前查天气。',
      kind: 'memo',
      priority: 0,
      estimateMin: 0,
    },
  ]

  for (const item of seed) {
    const created = create(item, userId)
    if (item.planned) {
      update(created.id, {
        status: 'planned',
        plannedDate: date,
        startMin: item.planned[0],
        endMin: item.planned[1],
        reason:
          item.kind === 'event'
            ? '固定安排，不可移动'
            : item.energy === 'deep'
              ? '上午精力最好，先啃需要思考的'
              : item.energy === 'light'
                ? '事务性的，插在空档里顺手做完'
                : '状态不错，按这个节奏走',
      }, userId)
    }
  }
}
