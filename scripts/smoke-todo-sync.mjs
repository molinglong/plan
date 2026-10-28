import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
const base = process.env.AICHATT_URL?.replace(/\/+$/, '')
const token = process.env.AICHATT_TOKEN
assert.ok(base && token, '需要本地 aichatt 连接配置')
const plan = process.env.PLAN_URL || 'http://localhost:5180'
const title = `同步冒烟-${randomUUID().slice(0, 8)}`
let remoteId
let localId

async function request(url, method = 'GET', body, remote = false) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(remote ? { authorization: `Bearer ${token}` } : { origin: new URL(plan).origin }) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const data = await res.json()
  assert.ok(res.ok, `${method} ${new URL(url).pathname}: HTTP ${res.status}`)
  return data
}

async function sync() {
  const result = await request(`${plan}/api/sync/todos`, 'POST', {})
  assert.equal(result.sync.error, undefined, result.sync.error)
  assert.ok(result.sync.syncedAt)
  return result.items
}

async function findRemote() {
  let after = ''
  do {
    const page = await request(`${base}/api/todos?sync=true${after ? `&after=${encodeURIComponent(after)}` : ''}`, 'GET', undefined, true)
    const found = page.todos.find((i) => i.id === remoteId)
    if (found) return found
    after = page.nextCursor
  } while (after)
  return null
}

try {
  const todo = await request(`${base}/api/todos`, 'POST', { content: title }, true)
  remoteId = todo.id
  let items = await sync()
  const item = items.find((i) => i.title === title)
  assert.ok(item?.external && !item.external.missing, '未导入 aichatt 来源标记')
  localId = item.id
  items = await sync()
  assert.equal(items.filter((i) => i.title === title).length, 1, '重复导入')
  console.log('PASS aichatt -> plan 拉取、来源标记、去重')

  const saved = await request(`${plan}/api/items/${localId}`, 'PATCH', { done: true })
  assert.equal(saved.done, true)
  assert.equal((await findRemote()).done, true)
  await request(`${plan}/api/items/${localId}`, 'PATCH', { done: false })
  assert.equal((await findRemote()).done, false)
  console.log('PASS plan -> aichatt 完成及取消完成回写')

  await request(`${base}/api/todos`, 'PATCH', { id: remoteId, done: true, content: `${title}-改名` }, true)
  items = await sync()
  assert.equal(items.find((i) => i.id === localId).done, true)
  assert.equal(items.find((i) => i.id === localId).title, `${title}-改名`)
  console.log('PASS aichatt 修改标题/完成 -> plan')

  const wrongOwner = await fetch(`${base}/api/todos`, {
    method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: remoteId, done: false, expectedOwnerId: 'smoke-wrong-owner' }),
  })
  assert.equal(wrongOwner.status, 409)
  assert.equal((await findRemote()).done, true)
  const unauthenticated = await fetch(`${base}/api/todos?sync=true`)
  assert.equal(unauthenticated.status, 401)
  const crossSite = await fetch(`${plan}/api/items/${localId}`, {
    method: 'PATCH', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' },
    body: JSON.stringify({ done: false }),
  })
  assert.equal(crossSite.status, 403)
  assert.equal((await findRemote()).done, true)
  console.log('PASS 未鉴权、错账号及跨站写入拦截')

  await request(`${base}/api/todos`, 'PATCH', { id: remoteId, done: false }, true)
  await sync()
  await request(`${plan}/api/items/${localId}`, 'DELETE')
  assert.ok(await findRemote(), '不应删除 aichatt 原待办')
  assert.ok(!(await sync()).some((i) => i.id === localId || i.title === `${title}-改名`))
  console.log('PASS plan 删除保留原待办，后续同步不复活')
} finally {
  // 只清理本脚本创建的两个条目，绝不清空用户的待办或计划。
  if (!localId && remoteId) {
    const list = await request(`${plan}/api/items`)
    localId = list.items.find((i) => i.title === title || i.title === `${title}-改名`)?.id
  }
  if (localId) await request(`${plan}/api/items/${localId}`, 'DELETE')
  if (remoteId) await request(`${base}/api/todos?id=${encodeURIComponent(remoteId)}`, 'DELETE', undefined, true)
  console.log('测试条目已清理')
}
