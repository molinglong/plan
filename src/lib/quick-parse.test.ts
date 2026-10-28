import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseQuickAdd } from './quick-parse'

test('一句话一件事：写了时刻就排进今天', () => {
  const [seg] = parseQuickAdd('9点写周报')
  assert.equal(seg.title, '写周报')
  assert.equal(seg.kind, 'task')
  assert.equal(seg.startMin, 9 * 60)
  assert.equal(seg.endMin, undefined)
})

test('一句话多件事：按句读拆开，没写时间的留在待安排', () => {
  const segs = parseQuickAdd('9点写周报，10点到11点开会，买菜')
  assert.equal(segs.length, 3)

  assert.equal(segs[0].title, '写周报')
  assert.equal(segs[0].startMin, 9 * 60)
  assert.equal(segs[1].title, '开会')
  assert.equal(segs[1].kind, 'event')
  assert.equal(segs[1].startMin, 10 * 60)
  assert.equal(segs[1].endMin, 11 * 60)
  assert.equal(segs[2].title, '买菜')
  assert.equal(segs[2].startMin, undefined)
})

test('时段写在中间也能认出来，标题只剩事情本身', () => {
  const [seg] = parseQuickAdd('9:30-10:30 写代码')
  assert.equal(seg.title, '写代码')
  assert.equal(seg.startMin, 570)
  assert.equal(seg.endMin, 630)
})

test('跨过中午的时段补 12 小时', () => {
  const [seg] = parseQuickAdd('11点到1点午休')
  assert.equal(seg.startMin, 11 * 60)
  assert.equal(seg.endMin, 13 * 60)
})

test('上午下午与「半」', () => {
  assert.equal(parseQuickAdd('下午3点喝咖啡')[0].startMin, 15 * 60)
  assert.equal(parseQuickAdd('9点半出门')[0].startMin, 9 * 60 + 30)
  assert.equal(parseQuickAdd('晚上8点健身')[0].startMin, 20 * 60)
  assert.equal(parseQuickAdd('晚上8点健身')[0].kind, 'event')
})

test('中文数字时刻：句首与时段词后都认', () => {
  assert.equal(parseQuickAdd('九点写周报')[0].startMin, 9 * 60)
  assert.equal(parseQuickAdd('下午三点开会')[0].startMin, 15 * 60)
  assert.equal(parseQuickAdd('十一点吃饭')[0].startMin, 11 * 60)
})

test('「早一点」是副词不是时间', () => {
  const [seg] = parseQuickAdd('早一点睡')
  assert.equal(seg.title, '早一点睡')
  assert.equal(seg.startMin, undefined)
})

test('口语并列词也能断句', () => {
  const segs = parseQuickAdd('9点写周报然后10点开会')
  assert.equal(segs.length, 2)
  assert.equal(segs[1].title, '开会')
})

test('备忘标记不占时间轴', () => {
  const [seg] = parseQuickAdd('记一下 牛奶')
  assert.equal(seg.kind, 'memo')
  assert.equal(seg.title, '牛奶')
  assert.equal(seg.startMin, undefined)
})

test('「第2点」是罗列，不当成时间', () => {
  const [seg] = parseQuickAdd('检查第2点')
  assert.equal(seg.title, '检查第2点')
  assert.equal(seg.startMin, undefined)
})

test('只写时间也留一条让人改', () => {
  const [seg] = parseQuickAdd('9点')
  assert.equal(seg.title, '新安排')
  assert.equal(seg.startMin, 9 * 60)
})

test('空输入不产生条目', () => {
  assert.deepEqual(parseQuickAdd(''), [])
  assert.deepEqual(parseQuickAdd('，。；'), [])
})

test('原始下标可用于删胶囊：剪掉这一段不伤到邻句', () => {
  const text = '9点写周报，10点开会'
  const segs = parseQuickAdd(text)
  assert.equal(segs[0].start, 0)
  assert.equal(segs[0].end, 5)
  assert.equal(text.slice(segs[0].start, segs[0].end), '9点写周报')

  const removed = text.slice(0, segs[0].start) + text.slice(segs[0].end)
  assert.equal(removed.replace(/^[，,、；;]+/, ''), '10点开会')
})
