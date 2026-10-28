import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'

// 必须在加载仓储前隔离数据库，测试不会访问日常计划或真实 aichatt。
process.env.PLAN_DB_PATH = ':memory:'
process.env.AICHATT_URL = 'https://aichatt.test'
process.env.AICHATT_TOKEN = 'test-only'
const { db } = await import('./db')
const { create, get, listForDay, remove, restore, todayKey, update } = await import('./repo')
const { syncTodos, updateLinkedItem, withItemLock, isDueToday } = await import('./todos')
const { scheduleDay, autoScheduleImported } = await import('./schedule')
const { reviewDay } = await import('./review')
const realFetch = globalThis.fetch
const date = todayKey()
type Todo = { id: string; content: string; done: boolean; dueAt: string | null }
let remote: Todo[] = []
let failStatus = 0
let requests = 0
let patches = 0
let ownerId = 'owner-a'
let pauseRead: (() => Promise<void>) | null = null

beforeEach(() => {
  db.exec('DELETE FROM external_refs; DELETE FROM items;')
  process.env.AICHATT_URL = 'https://aichatt.test'
  process.env.AICHATT_TOKEN = 'test-only'
  remote = [{ id: 'todo-001', content: '周五交物理作业', done: false, dueAt: null }]
  failStatus = 0
  requests = 0
  patches = 0
  ownerId = 'owner-a'
  pauseRead = null
  globalThis.fetch = (async (input, init) => {
    requests++
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://aichatt.test')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-only')
    if (failStatus) return Response.json({ error: '测试失败' }, { status: failStatus })
    if (init?.method === 'PATCH') {
      patches++
      const body = JSON.parse(String(init.body))
      if (body.expectedOwnerId !== ownerId) return Response.json({}, { status: 409 })
      const todo = remote.find((i) => i.id === body.id)
      if (!todo) return Response.json({}, { status: 404 })
      todo.done = body.done
      return Response.json(todo)
    }
    assert.equal(url.searchParams.get('sync'), 'true')
    const after = url.searchParams.get('after') ?? ''
    const rows = remote.filter((i) => i.id > after).sort((a, b) => a.id.localeCompare(b.id))
    const page = structuredClone(rows.slice(0, 100))
    if (pauseRead) await pauseRead()
    return Response.json({ todos: page, ownerId, nextCursor: rows.length > 100 ? page.at(-1)!.id : null })
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
  db.close()
})

async function imported() {
  const result = await syncTodos()
  assert.equal(result.error, undefined)
  return listForDay(date)[0]
}

test('拉取未完成条目，重复同步不重复；标题相同也按 id 区分', async () => {
  remote.push({ ...remote[0], id: 'todo-002' }, { ...remote[0], id: 'todo-003', done: true })
  assert.equal((await syncTodos()).added, 2)
  assert.equal((await syncTodos()).added, 0)
  const items = listForDay(date)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0].external, { source: 'aichatt', missing: false })
})

test('分页覆盖超过 100 条的未完成和已关联完成项', async () => {
  remote = Array.from({ length: 205 }, (_, i) => ({ id: `todo-${String(i).padStart(4, '0')}`, content: `任务 ${i}`, done: false, dueAt: null }))
  assert.equal((await syncTodos()).added, 205)
  assert.equal(requests, 3)
  remote[204].done = true
  assert.equal((await syncTodos()).updated, 1)
  assert.equal(listForDay(date).filter((i) => i.done).length, 1)
})

test('标题和完成状态从 aichatt 更新，但保留 plan 排程、备注和优先级', async () => {
  const item = await imported()
  update(item.id, { status: 'planned', plannedDate: date, startMin: 600, endMin: 630, note: '先做选择题', priority: 2 })
  remote[0].content = '交物理和数学作业'
  remote[0].done = true
  assert.equal((await syncTodos()).updated, 1)
  const saved = get(item.id)!
  assert.equal(saved.title, remote[0].content)
  assert.equal(saved.done, true)
  assert.equal(saved.startMin, 600)
  assert.equal(saved.note, '先做选择题')
  assert.equal(saved.priority, 2)
  remote[0].done = false
  await syncTodos()
  assert.equal(get(item.id)!.done, false)
  assert.equal(get(item.id)!.status, 'planned')
})

test('plan 完成与取消完成都写回，重试同一状态仍确认远端', async () => {
  const item = await imported()
  await updateLinkedItem(item.id, { done: true })
  assert.equal(remote[0].done, true)
  assert.equal(get(item.id)!.done, true)
  await updateLinkedItem(item.id, { done: true })
  await updateLinkedItem(item.id, { done: false })
  assert.equal(remote[0].done, false)
  assert.equal(get(item.id)!.done, false)
  assert.equal(patches, 3)
})

test('令牌失败和离线不会误勾完成，也不丢本地列表', async () => {
  const item = await imported()
  failStatus = 401
  await assert.rejects(updateLinkedItem(item.id, { done: true }), /令牌/)
  assert.equal(get(item.id)!.done, false)
  assert.match((await syncTodos()).error!, /令牌/)
  assert.equal(listForDay(date).length, 1)
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(updateLinkedItem(item.id, { done: true }), /连不上/)
  assert.equal(get(item.id)!.done, false)
})

test('完整拉取之前发生分页故障或数据损坏，整批不落地', async () => {
  await imported()
  const before = listForDay(date)
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return calls === 1
      ? Response.json({ ownerId, todos: [{ ...remote[0], content: '不应更新' }], nextCursor: 'next' })
      : Response.json({}, { status: 500 })
  }
  assert.ok((await syncTodos()).error)
  assert.deepEqual(listForDay(date), before)
  globalThis.fetch = async () => Response.json({ ownerId, todos: [{ id: 'bad' }], nextCursor: null })
  assert.ok((await syncTodos()).error)
  assert.deepEqual(listForDay(date), before)
})

test('dueAt 按本地日期判断今天', () => {
  const now = new Date(2026, 9, 27, 10, 0)
  assert.equal(isDueToday(new Date(2026, 9, 27, 23, 0).toISOString(), now), true)
  assert.equal(isDueToday(new Date(2026, 9, 28, 0, 30).toISOString(), now), false)
  assert.equal(isDueToday(null, now), false)
  assert.equal(isDueToday('not-a-date', now), false)
})

test('自动排程只占七成空档，排不下的留在待安排', () => {
  const items = [0, 1, 2].map((i) =>
    create({ title: `自动任务 ${i}`, estimateMin: 30 })
  )
  // 从 09:00 开始，空档很多，三条都应排入
  assert.equal(autoScheduleImported(date, items, 'me', 9 * 60), 3)
  for (const item of items) {
    const saved = get(item.id)!
    assert.equal(saved.status, 'planned')
    assert.ok((saved.startMin ?? 0) >= 9 * 60)
    assert.equal((saved.endMin ?? 0) - (saved.startMin ?? 0), 30)
    assert.match(saved.reason ?? '', /aichatt 今天到期/)
  }

  const late = create({ title: '太晚的事', estimateMin: 30 })
  assert.equal(autoScheduleImported(date, [late], 'me', 23 * 60), 0)
  assert.equal(get(late.id)!.status, 'inbox')
})

test('同步时只自动排 dueAt 今天的新待办，明天/积压仍待安排', async () => {
  remote[0].dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  let result = await syncTodos()
  assert.equal(result.added, 1)
  assert.equal(result.scheduled, 0)
  assert.equal(listForDay(date)[0].status, 'inbox')

  db.exec('DELETE FROM external_refs; DELETE FROM items;')
  remote = [{ id: 'todo-today', content: '今天到期的事', done: false, dueAt: new Date().toISOString() }]
  result = await syncTodos()
  assert.equal(result.added, 1)
  // 深夜跑测试可能已经没有空档；有日间空档时必须自动排入
  if (new Date().getHours() < 23) {
    assert.equal(result.scheduled, 1)
    assert.equal(listForDay(date)[0].status, 'planned')
  }
})

test('删除 plan 条目不删远端，忽略记录阻止重新导入', async () => {
  const item = await imported()
  await withItemLock(() => remove(item.id))
  assert.equal(remote.length, 1)
  assert.equal(patches, 0)
  assert.equal((await syncTodos()).added, 0)
  assert.equal(listForDay(date).length, 0)
  assert.equal((db.prepare('SELECT dismissed FROM external_refs').get() as any).dismissed, 1)
})

test('删除可撤销：恢复原时间、外链继续同步', async () => {
  const item = await imported()
  update(item.id, { status: 'planned', plannedDate: date, startMin: 600, endMin: 660 })
  await withItemLock(() => remove(item.id))
  assert.equal(get(item.id)!.status, 'dropped')
  assert.equal(listForDay(date).length, 0)

  const restored = restore(item.id, {
    status: 'planned', plannedDate: date, startMin: 600, endMin: 660,
  })!
  assert.equal(restored.status, 'planned')
  assert.equal(restored.startMin, 600)
  assert.equal(listForDay(date).length, 1)
  assert.equal((db.prepare('SELECT dismissed FROM external_refs').get() as any).dismissed, 0)

  remote[0].done = true
  await syncTodos()
  assert.equal(get(item.id)!.done, true)
  assert.equal(get(item.id)!.startMin, 600)
})

test('新建固定事件直接进入时间轴，备忘估时归零', () => {
  const event = create({
    title: '周三晚课', kind: 'event', estimateMin: 90,
    plannedDate: date, startMin: 19 * 60, endMin: 20 * 60 + 30,
  })
  assert.equal(event.status, 'planned')
  assert.equal(event.startMin, 19 * 60)
  assert.equal(listForDay(date).some((i) => i.id === event.id), true)

  const memo = create({ title: '随手记', kind: 'memo', estimateMin: 0 })
  assert.equal(memo.status, 'inbox')
  assert.equal(memo.estimateMin, 0)
})

test('aichatt 原待办删除后保留 plan，转为本地完成操作', async () => {
  const item = await imported()
  remote = []
  await assert.rejects(updateLinkedItem(item.id, { done: true }), /不存在/)
  await syncTodos()
  assert.equal(get(item.id)!.external?.missing, true)
  const calls = requests
  await updateLinkedItem(item.id, { done: true })
  assert.equal(requests, calls)
  assert.equal(get(item.id)!.done, true)
})

test('不覆盖本地条目，且已完成的待安排不再排程或计入剩余', async () => {
  const local = create({ title: '本地备忘' })
  const linked = (await syncTodos(), listForDay(date).find((i) => i.external)!)
  remote[0].done = true
  await syncTodos()
  assert.equal(get(local.id)!.title, '本地备忘')
  assert.equal(reviewDay(date).remaining, 1)
  assert.equal((await scheduleDay(date, 'one', linked.id)).added, 0)
  failStatus = 500
  await updateLinkedItem(local.id, { done: true })
  assert.equal(get(local.id)!.done, true)
})

test('并发同步合并一次；拉取与完成写回串行，旧快照不覆盖勾选', async () => {
  const item = await imported()
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const wait = new Promise<void>((resolve) => { release = resolve })
  pauseRead = async () => { entered(); await wait }
  const sync1 = syncTodos()
  const sync2 = syncTodos()
  assert.equal(sync1, sync2)
  await ready
  const writing = updateLinkedItem(item.id, { done: true })
  release()
  await Promise.all([sync1, sync2, writing])
  assert.equal(get(item.id)!.done, true)
  assert.equal(remote[0].done, true)
})

test('账号或服务地址改变时不向错误账号回写，来源标题不可从 plan 修改', async () => {
  const item = await imported()
  await assert.rejects(updateLinkedItem(item.id, { title: '试图改标题' }), /标题/)
  ownerId = 'owner-b'
  await assert.rejects(updateLinkedItem(item.id, { done: true }), /账号已改变/)
  assert.equal(get(item.id)!.done, false)
  process.env.AICHATT_URL = 'https://other.test'
  await assert.rejects(updateLinkedItem(item.id, { done: true }), /服务地址已改变/)
  assert.equal(get(item.id)!.done, false)
})

test('不同账户的条目互不可见、互不可改', () => {
  const a = create({ title: 'A 的计划' }, 'user-a')
  const b = create({ title: 'B 的计划' }, 'user-b')
  assert.deepEqual(listForDay(date, 'user-a').map((i) => i.id), [a.id])
  assert.deepEqual(listForDay(date, 'user-b').map((i) => i.id), [b.id])
  assert.equal(get(b.id, 'user-a'), null)
  assert.equal(update(b.id, { title: '越权修改' }, 'user-a'), null)
  remove(b.id, 'user-a')
  assert.equal(get(b.id, 'user-b')!.title, 'B 的计划')
})

test('未配置连接时仍可使用本地计划', async () => {
  delete process.env.AICHATT_TOKEN
  const local = create({ title: '本地可用' })
  assert.equal((await syncTodos()).enabled, false)
  await updateLinkedItem(local.id, { done: true })
  assert.equal(get(local.id)!.done, true)
  assert.equal(requests, 0)
})
