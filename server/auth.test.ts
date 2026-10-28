import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.PLAN_SSO_SECRET = 'test-secret-for-plan-sso-0123456789'
const { issueCode, safeNext, verifyCode } = await import('./auth')

test('授权码可验证，且拒绝篡改和错误签名', () => {
  const code = issueCode('user-001')
  assert.equal(verifyCode(code), 'user-001')

  const [body, sig] = code.split('.')
  assert.equal(verifyCode(`${body}.${sig.slice(0, -1)}A`), null)
  assert.equal(verifyCode(`${body}x.${sig}`), null)
  assert.equal(verifyCode('garbage'), null)
})

test('回跳地址只接受站内绝对路径', () => {
  assert.equal(safeNext('/chat?x=1'), '/chat?x=1')
  assert.equal(safeNext('//evil.example'), '/')
  assert.equal(safeNext('/\\evil.example'), '/')
  assert.equal(safeNext('https://evil.example'), '/')
  assert.equal(safeNext(undefined), '/')
})
