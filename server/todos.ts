import type { PlanItem, TodoSyncResult } from '../src/types'
import { db } from './db'
import { create, dateKey, get, todayKey, update } from './repo'
import { remoteEnabled } from './remote'
import { autoScheduleImported } from './schedule'

interface RemoteTodo {
  id: string
  content: string
  done: boolean
  dueAt: string | null
}

interface ExternalRef {
  base_url: string
  owner_id: string
  external_id: string
  item_id: string | null
  dismissed: number
  missing: number
}

export class TodoSyncError extends Error {
  constructor(message: string, public status: 400 | 409 | 502 = 502) {
    super(message)
  }
}

/** aichatt 的 dueAt 是 ISO 时间；按 plan 服务本地时区判断是不是今天 */
export function isDueToday(dueAt: string | null, now = new Date()): boolean {
  if (!dueAt) return false
  const d = new Date(dueAt)
  if (Number.isNaN(d.getTime())) return false
  return dateKey(d) === dateKey(now)
}

// 拉取、勾选、删除和排程串行：旧的拉取结果不能覆盖刚刚写回的完成状态。
let queue: Promise<unknown> = Promise.resolve()
export function withItemLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const result = queue.then(operation)
  queue = result.catch(() => undefined)
  return result
}

function connection() {
  if (!remoteEnabled()) throw new TodoSyncError('未配置 aichatt 待办连接')
  return {
    base: (process.env.AICHATT_URL || '').replace(/\/+$/, ''),
    token: process.env.AICHATT_TOKEN!,
  }
}

async function remoteJson(
  config: ReturnType<typeof connection>,
  path: string,
  signal: AbortSignal,
  body?: Record<string, unknown>
): Promise<any> {
  let res: Response
  try {
    res = await fetch(`${config.base}${path}`, {
      method: body ? 'PATCH' : 'GET',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
      cache: 'no-store',
      redirect: 'error',
    })
  } catch {
    throw new TodoSyncError('暂时连不上 aichatt，未同步的操作请稍后重试')
  }
  if (!res.ok) {
    const message = res.status === 401 || res.status === 403
      ? 'aichatt 令牌已失效或无权限，请检查连接配置'
      : res.status === 404
        ? 'aichatt 原待办已不存在，请先同步再操作'
        : res.status === 409
          ? 'aichatt 账号已改变，不能回写原账号的待办'
          : 'aichatt 暂时不可用，请稍后重试'
    throw new TodoSyncError(message)
  }
  return res.json().catch(() => { throw new TodoSyncError('aichatt 返回格式不正确，未修改本地数据') })
}

async function fetchSnapshot() {
  const config = connection()
  const signal = AbortSignal.timeout(15_000)
  const todos = new Map<string, RemoteTodo>()
  const cursors = new Set<string>()
  let after: string | null = null
  let ownerId = ''
  do {
    const page = await remoteJson(config,
      `/api/todos?sync=true${after ? `&after=${encodeURIComponent(after)}` : ''}`, signal)
    if (!page || typeof page.ownerId !== 'string' || !page.ownerId || !Array.isArray(page.todos)
      || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor))) {
      throw new TodoSyncError('aichatt 待办接口不支持完整同步，请更新服务端')
    }
    if (ownerId && ownerId !== page.ownerId) throw new TodoSyncError('同步期间 aichatt 账号改变，请重试')
    ownerId = page.ownerId
    for (const row of page.todos) {
      if (!row || typeof row.id !== 'string' || !row.id || typeof row.content !== 'string'
        || !row.content.trim() || typeof row.done !== 'boolean'
        || !(row.dueAt === null || (typeof row.dueAt === 'string' && !Number.isNaN(Date.parse(row.dueAt))))) {
        throw new TodoSyncError('aichatt 待办数据不完整，保留本地数据')
      }
      todos.set(row.id, row)
    }
    after = page.nextCursor
    if (after) {
      if (cursors.has(after) || cursors.size >= 1000) throw new TodoSyncError('aichatt 待办分页异常，请稍后重试')
      cursors.add(after)
    }
  } while (after)
  return { base: config.base, ownerId, todos }
}

function applySnapshot(
  snapshot: Awaited<ReturnType<typeof fetchSnapshot>>,
  userId: string
) {
  const { base, ownerId, todos } = snapshot
  // plan 登录账户必须与 AICHATT_TOKEN 所属账户一致，否则会把别人的待办灌进来
  if (process.env.NODE_ENV === 'production' && ownerId !== userId) {
    throw new TodoSyncError('aichatt 令牌账户与 plan 登录账户不一致', 409)
  }
  let added = 0
  let updated = 0
  const autoTargets: PlanItem[] = []
  db.exec('BEGIN IMMEDIATE')
  try {
    const refs = db.prepare('SELECT * FROM external_refs WHERE base_url = ? AND owner_id = ?')
      .all(base, ownerId) as unknown as ExternalRef[]
    const byId = new Map(refs.map((ref) => [ref.external_id, ref]))
    for (const todo of todos.values()) {
      const ref = byId.get(todo.id)
      if (ref?.dismissed) continue
      if (!ref) {
        // 历史上已经完成的条目不灌进 plan，已关联条目则继续接收取消完成。
        if (todo.done) continue
        const item = create(
          { title: todo.content, kind: 'task', estimateMin: 30, energy: 'any' },
          userId
        )
        db.prepare(`INSERT INTO external_refs (base_url, owner_id, external_id, item_id)
          VALUES (?, ?, ?, ?)`).run(base, ownerId, todo.id, item.id)
        // 只有今天到期的「新」待办自动排；用户手动顺延过的不再反复塞回时间轴
        if (isDueToday(todo.dueAt)) autoTargets.push(item)
        added++
      } else if (ref.item_id) {
        const item = get(ref.item_id, userId)
        if (!item) continue
        if (item.title !== todo.content || !!item.done !== todo.done || ref.missing) {
          // 只拉取源标题和完成状态，不碰用户在 plan 定的时间、备注和优先级。
          update(item.id, { title: todo.content, done: todo.done }, userId)
          db.prepare('UPDATE external_refs SET missing = 0 WHERE item_id = ?').run(item.id)
          updated++
        }
      }
    }
    for (const ref of refs) {
      if (ref.item_id && !ref.dismissed && !ref.missing && !todos.has(ref.external_id)) {
        // 原待办删除时保留 plan 的历史和时间安排，后续仅作为本地条目使用。
        db.prepare('UPDATE external_refs SET missing = 1 WHERE item_id = ?').run(ref.item_id)
        updated++
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { added, updated, autoTargets }
}

let runningSync: Promise<TodoSyncResult> | null = null
export function syncTodos(userId = 'me'): Promise<TodoSyncResult> {
  if (runningSync) return runningSync
  runningSync = withItemLock(async () => {
    if (!remoteEnabled()) return { enabled: false, added: 0, updated: 0, scheduled: 0 }
    try {
      const { autoTargets, ...counts } = applySnapshot(await fetchSnapshot(), userId)
      let scheduled = 0
      if (autoTargets.length) {
        try {
          scheduled = autoScheduleImported(todayKey(), autoTargets, userId)
        } catch (err) {
          // 自动排程失败不能影响同步本身，条目留在待安排即可
          console.warn('[plan] auto schedule failed:', err)
        }
      }
      return {
        enabled: true,
        ...counts,
        scheduled,
        syncedAt: new Date().toISOString(),
      }
    } catch (err) {
      return {
        enabled: true, added: 0, updated: 0, scheduled: 0,
        error: err instanceof TodoSyncError ? err.message : '待办同步失败，保留本地数据，请稍后重试',
      }
    }
  }).finally(() => { runningSync = null })
  return runningSync
}

export function updateLinkedItem(id: string, patch: Record<string, unknown>, userId = 'me') {
  return withItemLock(async () => {
    const item = get(id, userId)
    if (!item) return null
    const ref = db.prepare('SELECT * FROM external_refs WHERE item_id = ?').get(id) as unknown as ExternalRef | undefined
    if (ref && !ref.missing) {
      if (patch.title !== undefined && patch.title !== item.title) {
        throw new TodoSyncError('来自 aichatt 的标题请在 aichatt 修改', 409)
      }
      if (typeof patch.done === 'boolean') {
        const config = connection()
        if (config.base !== ref.base_url) throw new TodoSyncError('aichatt 服务地址已改变，不能回写原服务的待办', 409)
        // 远端确认后才落地；失败时客户端回滚勾选，不制造虚假的同步成功。
        const result = await remoteJson(config, '/api/todos', AbortSignal.timeout(10_000), {
          id: ref.external_id, done: patch.done, expectedOwnerId: ref.owner_id,
        })
        if (result?.id !== ref.external_id || result?.done !== patch.done) {
          throw new TodoSyncError('aichatt 未确认完成状态，请同步后重试')
        }
      }
    }
    return update(id, patch, userId)
  })
}
