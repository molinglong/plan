import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

/**
 * plan 跟随 aichatt 账户：
 * 1. 浏览器访问 plan，没有 plan 会话就跳到 chat 的 /api/plan/authorize；
 * 2. 该端点由 plan 容器承接（Nginx 把 chat 域名的这个路径转过来），
 *    带着 chat 的 session cookie 去问 aichatt /api/auth/session；
 * 3. 有效会话 → 签发 60 秒授权码 → 回 plan /auth/callback；
 * 4. plan 用同一个 PLAN_SSO_SECRET 验签，落自己的 HttpOnly 会话。
 *
 * 不用共享 chat 的 cookie 域：plan 只拿一次性授权码，不接触 NextAuth 会话。
 */

const SESSION_COOKIE = 'plan_session'
const STATE_COOKIE = 'plan_oauth_state'
const NEXT_COOKIE = 'plan_oauth_next'
const SESSION_TTL_S = 12 * 60 * 60
const CODE_TTL_S = 60
const OAUTH_TTL_S = 10 * 60

type TokenType = 'session' | 'code'

interface Payload {
  uid: string
  exp: number
  typ: TokenType
}

function secret(): string {
  const value = process.env.PLAN_SSO_SECRET
  if (!value || value.length < 16) throw new Error('PLAN_SSO_SECRET 未配置')
  return value
}

function sign(payload: Payload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret()).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verify(token: string | undefined, type: TokenType): Payload | null {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = createHmac('sha256', secret()).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload
    if (payload.typ !== type) return null
    if (typeof payload.uid !== 'string' || !payload.uid) return null
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

function isSecure(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim()
  return proto === 'https' || new URL(c.req.url).protocol === 'https:'
}

function requestHost(c: Context): string {
  return c.req.header('x-forwarded-host')?.split(',')[0].trim()
    || c.req.header('host')
    || new URL(c.req.url).host
}

function requestProto(c: Context): string {
  return c.req.header('x-forwarded-proto')?.split(',')[0].trim()
    || new URL(c.req.url).protocol.replace(':', '')
}

export function planBase(c: Context): string {
  const configured = (process.env.PLAN_PUBLIC_URL || '').replace(/\/+$/, '')
  return configured || `${requestProto(c)}://${requestHost(c)}`
}

export function requestOrigin(c: Context): string {
  return `${requestProto(c)}://${requestHost(c)}`
}

/**
 * 未登录时在 chat 域名下留一个 10 分钟回跳标记，登录页跳 /chat 时由 Nginx 接走。
 *
 * 这里必须手写 Set-Cookie：Hono 的 setCookie 会 URL 编码值，Nginx 的
 * $cookie_plan_next 拿到的是编码后的串，302 会变成 https://chat/https%3A...
 * target 是我们自己拼的 URL（已校验 redirect_uri/state），不含分号/逗号/空格，
 * 可以直接作为 cookie 值。
 */
export function setChatReturn(c: Context, target: string): void {
  const attrs = [
    `plan_next=${target}`,
    `Max-Age=${OAUTH_TTL_S}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (isSecure(c)) attrs.push('Secure')
  c.header('Set-Cookie', attrs.join('; '), { append: true })
}

export function chatBase(): string {
  return (process.env.AICHATT_PUBLIC_URL || 'https://chat.yuban.icu').replace(/\/+$/, '')
}

export function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/'
  }
  return value
}

export function issueCode(uid: string): string {
  return sign({ uid, exp: Math.floor(Date.now() / 1000) + CODE_TTL_S, typ: 'code' })
}

export function verifyCode(code: string | undefined): string | null {
  return verify(code, 'code')?.uid ?? null
}

export function setSession(c: Context, uid: string): void {
  setCookie(c, SESSION_COOKIE, sign({
    uid,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
    typ: 'session',
  }), {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_S,
  })
}

export function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

export function beginOAuth(c: Context, next: string): string {
  const state = randomBytes(18).toString('base64url')
  const opts = {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: OAUTH_TTL_S,
  }
  setCookie(c, STATE_COOKIE, state, opts)
  setCookie(c, NEXT_COOKIE, safeNext(next), opts)
  return state
}

export function readOAuth(c: Context): { state: string | undefined; next: string } {
  return {
    state: getCookie(c, STATE_COOKIE),
    next: safeNext(getCookie(c, NEXT_COOKIE)),
  }
}

export function clearOAuth(c: Context): void {
  deleteCookie(c, STATE_COOKIE, { path: '/' })
  deleteCookie(c, NEXT_COOKIE, { path: '/' })
}

/** 校验 chat 域转来的 NextAuth cookie */
export async function chatUserId(c: Context): Promise<
  | { uid: string; ephemeral: boolean }
  | { uid: null; ephemeral: false }
  | { error: 'unavailable' }
> {
  const cookie = c.req.header('cookie') || ''
  const base = (process.env.AICHATT_URL || 'http://aichatt-app:3000').replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/api/auth/session`, {
      headers: { cookie, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
      redirect: 'error',
    })
    if (!res.ok) return { error: 'unavailable' }
    const data = await res.json().catch(() => null) as
      | { user?: { id?: string }; ephemeral?: boolean }
      | null
    if (!data?.user?.id) return { uid: null, ephemeral: false }
    return { uid: data.user.id, ephemeral: data.ephemeral === true }
  } catch {
    return { error: 'unavailable' }
  }
}

export type PlanEnv = { Variables: { userId: string } }

const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/plan/authorize',
  '/api/plan/native-authorize',
  '/auth/login',
  '/auth/callback',
  '/auth/native',
  '/download',
  '/download.html',
  '/app/plan.apk',
])

/**
 * 本地开发默认不启用 SSO（NODE_ENV 不是 production 且没配 secret），
 * 沿用原来的单用户 'me'；线上必须配置 secret 才放行。
 */
export const planAuth: MiddlewareHandler<PlanEnv> = async (c, next) => {
  if (process.env.NODE_ENV !== 'production' && !process.env.PLAN_SSO_SECRET) {
    c.set('userId', 'me')
    return next()
  }

  const url = new URL(c.req.url)
  if (PUBLIC_PATHS.has(url.pathname)) return next()

  const token = getCookie(c, SESSION_COOKIE)
  const session = verify(token, 'session')
  if (!session) {
    if (url.pathname.startsWith('/api/')) {
      return c.json({ error: '登录已失效，请重新通过 aichatt 登录' }, 401)
    }
    if (c.req.method === 'GET' && (c.req.header('accept') || '').includes('text/html')) {
      return c.redirect(`/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`)
    }
    return c.text('未登录', 401)
  }

  c.set('userId', session.uid)
  await next()
}
