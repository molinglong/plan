import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { existsSync, readFileSync } from 'node:fs'
import { create, listForDay, remove, restore, seedIfEmpty, todayKey } from './repo'
import { loadEnv } from './env'
import { remoteEnabled } from './remote'
import { reviewDay } from './review'
import { scheduleDay } from './schedule'
import { syncTodos, TodoSyncError, updateLinkedItem, withItemLock } from './todos'
import {
  beginOAuth,
  chatBase,
  chatUserId,
  clearOAuth,
  issueCode,
  planAuth,
  planBase,
  readOAuth,
  requestOrigin,
  safeNext,
  setChatReturn,
  setSession,
  verifyCode,
  type PlanEnv,
} from './auth'

loadEnv()

const app = new Hono<PlanEnv>()

// Plan 壳的 HOME 常量末尾带斜杠，拼接出 //auth/native 这类双斜杠路径；
// nginx proxy_pass 不带 URI 时原样转发，Hono 路由与 PUBLIC_PATHS 精确匹配都接不住，
// 会被未登录中间件弹回登录页（2026-10-28 真机授权失败根因）。
// 最前置统一 302 到单斜杠规范路径；code 是纯签名 JWT，60 秒内重放无害。
app.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  if (c.req.method === 'GET' && url.pathname.length > 1 && url.pathname.includes('//')) {
    return c.redirect(url.pathname.replace(/\/{2,}/g, '/') + url.search, 302)
  }
  await next()
})

// 待办回写会使用服务端令牌，不能让任意第三方网页借本地服务操作 aichatt。
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin')
  if (origin) {
    try {
      const source = new URL(origin)
      const target = new URL(c.req.url)
      // 生产走宝塔 Nginx 终止 TLS，容器内看到的可能是 http + 内网 Host；
      // 用 Nginx 透传的真实协议与域名还原用户侧 origin，否则所有写操作都会 403。
      const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim()
        || target.protocol.replace(':', '')
      const host = c.req.header('x-forwarded-host')?.split(',')[0].trim()
        || c.req.header('host')
        || target.host
      const sameOrigin = source.origin === `${proto}://${host}`
      const devFrontend = source.protocol === 'http:' && source.hostname === target.hostname && source.port === '5180'
      if (!sameOrigin && !devFrontend) return c.json({ error: '不允许跨站操作 plan' }, 403)
    } catch {
      return c.json({ error: '来源地址无效' }, 403)
    }
  }
  await next()
})
app.use('/api/*', cors())

// 除公开端点外，所有页面/API 都要求 plan 会话（线上由 aichatt SSO 建立）
app.use('*', planAuth)

/** 统一的中转错误页：不引前端资源，登录失败也能看清下一步 */
function authError(c: any, message: string) {
  return c.html(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Plan · 登录失败</title></head>
<body style="margin:0;background:#f5f5f7;color:#1d1d1f;font:14px/1.6 -apple-system,'PingFang SC','Microsoft YaHei UI',sans-serif">
<div style="max-width:360px;margin:18vh auto;padding:24px;background:#fff;border:1px solid #e3e3e6;border-radius:16px">
<h1 style="margin:0 0 8px;font-size:17px">登录没有完成</h1>
<p style="margin:0 0 18px;color:#6e6e73">${message}</p>
<a href="/auth/login" style="display:block;height:40px;border-radius:8px;background:#3f3f46;color:#fff;text-align:center;line-height:40px;text-decoration:none">重试</a>
</div></body></html>`, 403)
}

app.get('/auth/login', (c) => {
  const state = beginOAuth(c, c.req.query('next') || '/')
  const redirectUri = `${planBase(c)}/auth/callback`
  const url = `${chatBase()}/api/plan/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`
  return c.redirect(url)
})

app.get('/auth/callback', (c) => {
  const { state, next } = readOAuth(c)
  clearOAuth(c)
  const queryState = c.req.query('state') || ''
  if (!state || !queryState || state !== queryState) {
    return authError(c, '登录状态校验失败，请从 plan 首页重新进入。')
  }

  const error = c.req.query('error')
  if (error) {
    return authError(c, error === 'ephemeral'
      ? '访客模式不能使用 plan，请用主账号登录 chat 后再试。'
      : 'aichatt 登录服务暂时不可用，请稍后再试。')
  }

  const uid = verifyCode(c.req.query('code'))
  if (!uid) return authError(c, '授权码已过期，请重新进入 plan。')
  setSession(c, uid)
  return c.redirect(safeNext(next))
})

/**
 * 由 chat.yuban.icu 的 Nginx 转发进来，带着用户的 NextAuth cookie。
 * 这里只把它转给 aichatt /api/auth/session 校验，不接触 AUTH_SECRET。
 */
app.get('/api/plan/authorize', async (c) => {
  const redirectUri = c.req.query('redirect_uri') || ''
  const state = c.req.query('state') || ''
  const allowed = new Set([
    `${planBase(c)}/auth/callback`,
    'https://plan.yuban.icu/auth/callback',
    'http://localhost:5180/auth/callback',
  ])
  if (!allowed.has(redirectUri) || !state || state.length > 200) {
    return c.text('授权参数不合法', 400)
  }

  const session = await chatUserId(c)
  const fail = (code: string) => {
    const url = new URL(redirectUri)
    url.searchParams.set('error', code)
    url.searchParams.set('state', state)
    return c.redirect(url.toString())
  }

  if ('error' in session) return fail('sso_unavailable')
  if (!session.uid) {
    const url = new URL(c.req.url)
    setChatReturn(c, `${requestOrigin(c)}${url.pathname}${url.search}`)
    return c.redirect(`${chatBase()}/login`)
  }
  if (session.ephemeral) return fail('ephemeral')

  const url = new URL(redirectUri)
  url.searchParams.set('code', issueCode(session.uid))
  url.searchParams.set('state', state)
  return c.redirect(url.toString())
})

/**
 * 原生 App 授权：aichatt APK 带着自己的 WebView Cookie 调这里，
 * 换取 60 秒一次性 code；code 由 Plan APK 交给 /auth/native 落会话。
 * 不返回 cookie 本身，也不在 App 里放签名密钥。
 */
app.get('/api/plan/native-authorize', async (c) => {
  const session = await chatUserId(c)
  if ('error' in session) return c.json({ error: 'sso_unavailable' }, 502)
  if (!session.uid) return c.json({ error: 'unauthorized' }, 401)
  if (session.ephemeral) return c.json({ error: 'ephemeral' }, 403)
  return c.json({ code: issueCode(session.uid) })
})

app.get('/auth/native', (c) => {
  const uid = verifyCode(c.req.query('code'))
  if (!uid) return authError(c, '授权码已过期，请重新打开 Plan。')
  setSession(c, uid)
  return c.redirect('/')
})

const KINDS = new Set(['task', 'event', 'memo'])
const STATUSES = new Set(['inbox', 'planned', 'done', 'dropped'])
const ENERGIES = new Set(['deep', 'light', 'any'])

type PatchRead =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string }

/** 只收已知字段并做类型校验；写库前挡住字符串时间、越界优先级这类脏数据 */
function readPatch(raw: unknown): PatchRead {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '条目更新参数不合法' }
  }

  const body = raw as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  const fail = (error: string): PatchRead => ({ ok: false, error })

  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case 'title': {
        const title = typeof value === 'string' ? value.trim() : ''
        if (!title || title.length > 200) return fail('标题需要 1–200 个字')
        patch.title = title
        break
      }
      case 'note':
        if (typeof value !== 'string' || value.length > 2000) return fail('备注最多 2000 个字')
        patch.note = value
        break
      case 'kind':
        if (typeof value !== 'string' || !KINDS.has(value)) return fail('条目类型不合法')
        patch.kind = value
        break
      case 'status':
        if (typeof value !== 'string' || !STATUSES.has(value)) return fail('条目状态不合法')
        patch.status = value
        break
      case 'priority':
        if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2) {
          return fail('优先级不合法')
        }
        patch.priority = value
        break
      case 'estimateMin':
        if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 480) {
          return fail('时长需要在 0–480 分钟之间')
        }
        patch.estimateMin = value
        break
      case 'energy':
        if (typeof value !== 'string' || !ENERGIES.has(value)) return fail('精力档位不合法')
        patch.energy = value
        break
      case 'plannedDate':
        if (value === null) patch.plannedDate = null
        else if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return fail('计划日期不合法')
        } else patch.plannedDate = value
        break
      case 'startMin':
        if (value === null) patch.startMin = null
        else if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1439) {
          return fail('开始时间不合法')
        } else patch.startMin = value
        break
      case 'endMin':
        if (value === null) patch.endMin = null
        else if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1440) {
          return fail('结束时间不合法')
        } else patch.endMin = value
        break
      case 'reason':
        if (value === null) patch.reason = null
        else if (typeof value !== 'string' || value.length > 120) return fail('理由最多 120 个字')
        else patch.reason = value
        break
      case 'done':
        if (typeof value !== 'boolean') return fail('完成状态不合法')
        patch.done = value
        break
      case 'postponeCount':
        if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 999) {
          return fail('顺延次数不合法')
        }
        patch.postponeCount = value
        break
      default:
        // 未知字段直接忽略，避免客户端多传辅助信息就把整次保存打回
        break
    }
  }

  if (
    patch.startMin != null &&
    patch.endMin != null &&
    (patch.endMin as number) <= (patch.startMin as number)
  ) {
    return fail('结束时间必须晚于开始时间')
  }
  if (
    patch.status === 'planned' &&
    (patch.startMin == null || patch.endMin == null)
  ) {
    return fail('安排到今天需要开始和结束时间')
  }

  return { ok: true, patch }
}

app.get('/api/health', (c) =>
  c.json({ ok: true, ts: Date.now(), ai: remoteEnabled() })
)

app.get('/api/me', (c) => c.json({ id: c.get('userId') }))

// 公开下载页与 APK：不要求登录，方便把安装包发给别人
app.get('/download', (c) => {
  try {
    return c.html(readFileSync('./dist/download.html', 'utf8'))
  } catch {
    return c.text('下载页暂未发布', 404)
  }
})

app.get('/app/plan.apk', (c) => {
  try {
    const apk = readFileSync('./dist/app/plan.apk')
    return c.body(apk, 200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="plan.apk"',
      'Content-Length': String(apk.length),
      'Cache-Control': 'no-cache',
    })
  } catch {
    return c.text('安装包暂未发布', 404)
  }
})

app.get('/api/items', (c) => {
  const userId = c.get('userId') as string
  const date = c.req.query('date') || todayKey()
  seedIfEmpty(date, userId)
  return c.json({ items: listForDay(date, userId) })
})

app.post('/api/items', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: '新建参数不合法' }, 400)
  }

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title || title.length > 200) return c.json({ error: '标题需要 1–200 个字' }, 400)

  const kind = typeof body.kind === 'string' && KINDS.has(body.kind) ? body.kind : 'task'
  const priority = Number.isInteger(body.priority) && body.priority >= 0 && body.priority <= 2
    ? body.priority
    : 1
  const estimateMin = Number.isInteger(body.estimateMin) && body.estimateMin >= 0 && body.estimateMin <= 480
    ? body.estimateMin
    : 30
  const energy = typeof body.energy === 'string' && ENERGIES.has(body.energy)
    ? body.energy
    : 'any'
  const startMin = Number.isInteger(body.startMin) ? body.startMin : null
  const endMin = Number.isInteger(body.endMin) ? body.endMin : null

  if ((startMin === null) !== (endMin === null)) {
    return c.json({ error: '开始和结束时间需要一起填写' }, 400)
  }
  if (startMin !== null && endMin !== null && (startMin < 0 || endMin > 1440 || endMin <= startMin)) {
    return c.json({ error: '时间范围不合法' }, 400)
  }

  return c.json(
    create({
      title,
      note: typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined,
      kind: kind as 'task' | 'event' | 'memo',
      priority: priority as 0 | 1 | 2,
      // 备忘不占时间，估时归零；任务默认 30 分钟
      estimateMin: kind === 'memo' ? 0 : estimateMin,
      energy: energy as 'deep' | 'light' | 'any',
      plannedDate: typeof body.plannedDate === 'string' ? body.plannedDate : todayKey(),
      startMin,
      endMin,
    }, userId),
    201
  )
})

app.patch('/api/items/:id', async (c) => {
  const userId = c.get('userId') as string
  const parsed = readPatch(await c.req.json().catch(() => null))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  try {
    const item = await updateLinkedItem(c.req.param('id'), parsed.patch, userId)
    if (!item) return c.json({ error: '条目不存在' }, 404)
    return c.json(item)
  } catch (err) {
    if (err instanceof TodoSyncError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

app.post('/api/items/:id/restore', async (c) => {
  const userId = c.get('userId') as string
  const parsed = readPatch(await c.req.json().catch(() => ({})))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  const patch = { ...parsed.patch }
  if (patch.status === undefined) patch.status = 'inbox'

  const item = await withItemLock(() => restore(c.req.param('id'), patch, userId))
  if (!item) return c.json({ error: '条目不存在' }, 404)
  return c.json(item)
})

app.delete('/api/items/:id', async (c) => {
  const userId = c.get('userId') as string
  await withItemLock(() => remove(c.req.param('id'), userId))
  return c.json({ ok: true })
})

app.post('/api/sync/todos', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => ({}))
  const date = typeof body?.date === 'string' ? body.date : todayKey()
  const sync = await syncTodos(userId)
  return c.json({ sync, items: listForDay(date, userId) })
})

app.post('/api/schedule', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => ({}))
  const date = typeof body.date === 'string' ? body.date : todayKey()
  const mode = body.mode === 'one' ? 'one' : 'all'
  return c.json(await withItemLock(() => scheduleDay(date, mode, body.id, userId)))
})

app.get('/api/review', (c) => {
  const userId = c.get('userId') as string
  const date = c.req.query('date') || todayKey()
  return c.json(reviewDay(date, userId))
})

// 生产构建后由同一个进程托管前端静态文件
if (existsSync('./dist')) {
  app.use('/*', serveStatic({ root: './dist' }))
  app.get('*', serveStatic({ path: './dist/index.html' }))
}

const port = Number(process.env.PORT || 8788)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[plan] api ready on http://localhost:${info.port}`)
})
