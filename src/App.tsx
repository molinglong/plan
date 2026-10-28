import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import { Header } from './components/Header'
import { Timeline } from './components/Timeline'
import { Inbox } from './components/Inbox'
import { Composer } from './components/Composer'
import { InboxItem } from './components/InboxItem'
import { MobileSelection, Summary } from './components/Summary'
import { ReviewSheet } from './components/ReviewSheet'
import { ItemEditor } from './components/ItemEditor'
import { ConfirmDialog } from './components/ConfirmDialog'
import { api, type CreateItemInput, type ScheduleResponse } from './lib/api'
import { cn } from './lib/utils'
import { fmtDuration, fmtTime, nextFreeGap, nowMinutes, todayKey } from './lib/time'
import type { PlanItem, TodoSyncResult } from './types'

const DATE = todayKey()
/** 一天的精力上限，不随当前时间变化（早上和晚上看到同一个分母） */
const AVAILABLE_MIN = 8 * 60
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Toast {
  text: string
  action?: { label: string; onClick: () => void }
}

/** 排程结果说人话：AI 排的报 AI，兜底的把原因带出来 */
function scheduleMessage(res: ScheduleResponse) {
  if (!res.added) return res.note ?? '今天放不下了，先留到明天'
  const left = res.deferred?.length ?? 0
  if (res.source === 'ai') {
    return left
      ? `AI 排入 ${res.added} 项，${left} 项今天放不下`
      : `AI 排入 ${res.added} 项 · 留了缓冲`
  }
  return `${res.note ?? '已按空档顺排'} · ${res.added} 项`
}

/** 记完的回报：一条就说清结果，多条给个汇总，别刷一串 toast */
function addMessage(created: PlanItem[]) {
  if (created.length === 1) {
    const item = created[0]
    if (item.status === 'planned') {
      return item.kind === 'event' ? '已加入今天的固定安排' : '已排进今天'
    }
    return item.kind === 'memo' ? '已记下这条备忘' : '已记下，晚点一起排'
  }
  const planned = created.filter((i) => i.status === 'planned').length
  const rest = created.length - planned
  if (!planned) return `已记下 ${created.length} 项，都在待安排里`
  if (!rest) return `已排进今天 ${planned} 项`
  return `已记下 ${created.length} 项，其中 ${planned} 项排进今天`
}

export default function App() {
  const [items, setItems] = useState<PlanItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dark, setDark] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [mobileInboxOpen, setMobileInboxOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [todoSync, setTodoSync] = useState<TodoSyncResult | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<PlanItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const syncBusy = useRef(false)
  const pendingWrites = useRef(0)
  const changeVersion = useRef(0)
  const busyItems = useRef(new Set<string>())
  const mounted = useRef(false)

  const refreshTodos = useCallback(async (manual = false) => {
    if (syncBusy.current || pendingWrites.current > 0) {
      if (manual) setToast({ text: '正在保存或同步，稍等一下再试' })
      return
    }
    syncBusy.current = true
    setSyncing(true)
    const version = changeVersion.current
    try {
      const res = await api.syncTodos(DATE)
      if (!mounted.current) return
      // 拉取途中发生了写操作时，不能用旧列表覆盖用户刚才的操作。
      if (version === changeVersion.current && pendingWrites.current === 0) setItems(res.items)
      setTodoSync(res.sync)
      const scheduled = res.sync.scheduled ?? 0
      if (manual) {
        if (res.sync.error) {
          setToast({ text: res.sync.error })
        } else {
          const base = !res.sync.enabled
            ? '未配置 aichatt 连接'
            : res.sync.added
              ? `从 aichatt 同步了 ${res.sync.added} 条待办`
              : 'aichatt 待办已同步'
          setToast({ text: scheduled ? `${base}，自动排入 ${scheduled} 项` : base })
        }
      } else if (scheduled) {
        setToast({ text: `aichatt 今天到期的 ${scheduled} 项已自动排入` })
      }
    } catch {
      if (mounted.current) {
        setTodoSync({ enabled: true, added: 0, updated: 0, error: '待办同步失败，本地计划仍可使用' })
        if (manual) setToast({ text: '待办同步失败，稍后重试' })
      }
    } finally {
      syncBusy.current = false
      if (mounted.current) setSyncing(false)
    }
  }, [])

  function beginWrite() {
    pendingWrites.current++
    changeVersion.current++
  }

  function endWrite() {
    pendingWrites.current--
    changeVersion.current++
  }

  useEffect(() => {
    let alive = true
    mounted.current = true
    api
      .list(DATE)
      .then((res) => {
        if (alive) {
          setItems(res.items)
          void refreshTodos()
        }
      })
      .catch(() => {
        if (alive) setError('连不上本地服务，先确认 npm run dev 两个进程都在跑')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshTodos() }
    const timer = window.setInterval(onVisible, 30_000)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      alive = false
      mounted.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refreshTodos])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    // PWA 状态栏跟着主题走，否则装到桌面后顶部一条白边
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? '#111113' : '#F5F5F7')
  }, [dark])

  useEffect(() => {
    if (!toast) return
    // 带撤销的提示多留一会儿，给用户反应时间
    const t = window.setTimeout(() => setToast(null), toast.action ? 8000 : 3200)
    return () => window.clearTimeout(t)
  }, [toast])

  const inbox = items.filter((i) => i.status === 'inbox' && !i.done)
  const planned = items.filter((i) => i.status === 'planned' && i.startMin != null)
  const doneCount = planned.filter((i) => i.done).length
  const plannedMinutes = planned.reduce(
    (sum, i) => sum + ((i.endMin ?? 0) - (i.startMin ?? 0)),
    0
  )
  const selected = items.find((i) => i.id === selectedId) ?? null
  const editing = items.find((i) => i.id === editingId) ?? null
  const schedulableCount = inbox.filter((i) => i.kind !== 'memo').length
  const nextGap = useMemo(() => nextFreeGap(planned), [items])
  const nextGapText = nextGap
    ? `${nextGap.startMin <= nowMinutes() + 1 ? '现在到' : '下一段空档'} ${fmtTime(
        nextGap.startMin
      )}–${fmtTime(nextGap.endMin)} 空着，约 ${fmtDuration(
        nextGap.endMin - nextGap.startMin
      )}`
    : '今天剩下的时间没有成段空档了'

  async function handleAdd(inputs: CreateItemInput[]) {
    if (!inputs.length) return
    beginWrite()
    const created: PlanItem[] = []
    try {
      // 串行创建：顺序与句子里说的一致，失败时也能知道存到第几条
      for (const input of inputs) created.push(await api.create(input))
      setItems((prev) => [...created, ...prev])
      setToast({ text: addMessage(created) })
    } catch (err) {
      if (created.length) setItems((prev) => [...created, ...prev])
      const reason = err instanceof Error ? err.message : '保存失败，检查后端是否在跑'
      setToast({
        text: created.length
          ? `${created.length} 项已记下，剩下的没存上：${reason}`
          : reason,
      })
    } finally {
      endWrite()
    }
  }

  async function handleSave(id: string, patch: Record<string, unknown>) {
    beginWrite()
    try {
      const saved = await api.update(id, patch)
      setItems((prev) => prev.map((i) => (i.id === id ? saved : i)))
      setEditingId(null)
      if (saved.status !== 'planned') setSelectedId(null)
      setToast({ text: '已保存' })
    } finally {
      endWrite()
    }
  }

  function requestDelete(item: PlanItem) {
    setConfirmingDelete(item)
    setEditingId(null)
  }

  function requestDeleteById(id: string) {
    const item = items.find((i) => i.id === id)
    if (item) requestDelete(item)
  }

  async function confirmDelete() {
    const target = confirmingDelete
    if (!target || deleting) return
    setDeleting(true)
    beginWrite()
    try {
      await api.remove(target.id)
      setItems((prev) => prev.filter((i) => i.id !== target.id))
      setSelectedId(null)
      setConfirmingDelete(null)
      setToast({
        text: target.external && !target.external.missing
          ? '已从 plan 移除，aichatt 原待办保留'
          : '已删除',
        action: { label: '撤销', onClick: () => void undoDelete(target) },
      })
    } catch (err) {
      setToast({
        text: err instanceof Error ? err.message : '删除失败，稍后再试',
      })
    } finally {
      setDeleting(false)
      endWrite()
    }
  }

  async function undoDelete(item: PlanItem) {
    const scheduled = item.startMin != null && item.endMin != null
    beginWrite()
    try {
      await api.restore(item.id, {
        status: scheduled ? 'planned' : 'inbox',
        plannedDate: scheduled ? item.plannedDate ?? DATE : null,
        startMin: item.startMin ?? null,
        endMin: item.endMin ?? null,
        reason: item.reason ?? null,
        done: Boolean(item.done),
        postponeCount: item.postponeCount ?? 0,
      })
      const res = await api.list(DATE)
      setItems(res.items)
      setToast({ text: '已恢复' })
    } catch (err) {
      setToast({
        text: err instanceof Error ? err.message : '恢复失败，请重试',
      })
    } finally {
      endWrite()
    }
  }

  async function handleScheduleAll() {
    if (scheduling || pendingWrites.current > 0) return
    beginWrite()
    setScheduling(true)
    try {
      const [res] = await Promise.all([
        api.schedule(DATE, 'all'),
        delay(520),
      ])
      setItems(res.items)
      setMobileInboxOpen(false)
      setToast({ text: scheduleMessage(res) })
    } catch {
      setToast({ text: '排程失败，稍后再试' })
    } finally {
      setScheduling(false)
      endWrite()
    }
  }

  async function handleScheduleOne(id: string) {
    if (scheduling || pendingWrites.current > 0) return
    beginWrite()
    setScheduling(true)
    try {
      const res = await api.schedule(DATE, 'one', id)
      setItems(res.items)
      setToast({ text: res.added ? scheduleMessage(res) : '今天没有合适的空档了' })
    } catch {
      setToast({ text: '排程失败，稍后再试' })
    } finally {
      setScheduling(false)
      endWrite()
    }
  }

  async function toggleDone(id: string) {
    const target = items.find((i) => i.id === id)
    if (!target || busyItems.current.has(id) || scheduling) return
    busyItems.current.add(id)
    beginWrite()
    const next = !target.done
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, done: next } : i)))
    try {
      const saved = await api.update(id, { done: next })
      setItems((prev) => prev.map((i) => (i.id === id ? saved : i)))
      if (saved.external) setToast({
        text: saved.external.missing ? '原待办已删除，仅更新 plan'
          : next ? '已完成' : '已取消完成',
      })
    } catch (err) {
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, done: !next } : i)))
      setToast({ text: err instanceof Error ? err.message : '更新失败，稍后再试' })
    } finally {
      busyItems.current.delete(id)
      endWrite()
    }
  }

  async function postpone(id: string) {
    if (busyItems.current.has(id) || scheduling) return
    busyItems.current.add(id)
    beginWrite()
    const target = items.find((i) => i.id === id)
    try {
      await api.update(id, {
        status: 'inbox',
        startMin: null,
        endMin: null,
        reason: null,
        done: false,
        postponeCount: (target?.postponeCount ?? 0) + 1,
      })
      setItems((prev) =>
        prev.map((i) =>
          i.id === id
            ? {
                ...i,
                status: 'inbox',
                startMin: undefined,
                endMin: undefined,
                reason: undefined,
                done: false,
                postponeCount: (i.postponeCount ?? 0) + 1,
              }
            : i
        )
      )
      setSelectedId(null)
      setToast({ text: '已放回待安排，明天再排' })
    } catch (err) {
      setToast({ text: err instanceof Error ? err.message : '操作失败，稍后再试' })
    } finally {
      busyItems.current.delete(id)
      endWrite()
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* 桌面：待安排 */}
      <div className="hidden lg:flex">
        <Inbox
          items={inbox}
          onAdd={handleAdd}
          onEdit={setEditingId}
          onScheduleOne={handleScheduleOne}
          onScheduleAll={handleScheduleAll}
          scheduling={scheduling}
        />
      </div>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <Header
          plannedMinutes={plannedMinutes}
          doneCount={doneCount}
          totalCount={planned.length}
          dark={dark}
          onToggleDark={() => setDark((v) => !v)}
          onOpenReview={() => setReviewOpen(true)}
          onSyncTodos={() => void refreshTodos(true)}
          syncing={syncing}
        />

        {todoSync?.error && (
          <div role="status" className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-muted px-4 py-2 text-[11px] text-content-secondary">
            <span className="min-w-0 flex-1">{todoSync.error}</span>
            <button type="button" disabled={syncing} onClick={() => void refreshTodos(true)} className="shrink-0 px-2 py-1 underline disabled:opacity-40">重试</button>
          </div>
        )}

        {error && (
          <div className="shrink-0 border-b border-danger/25 bg-danger-soft px-4 py-2 text-[11px] text-danger">
            {error}
          </div>
        )}

        {/* 时间轴区：手机端「待安排」浮条浮在它上方，不占布局 */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Timeline
            items={items}
            loading={loading}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onToggleDone={toggleDone}
          />

          {/* 手机：待安排悬浮条（收起是胶囊，点开成为浮层卡片） */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-3 pt-2 lg:hidden">
            <div
              className={cn(
                'pointer-events-auto w-full max-w-[340px] overflow-hidden border border-line bg-surface shadow-[0_10px_28px_-12px_rgb(0_0_0/0.28),0_2px_6px_-3px_rgb(0_0_0/0.12)]',
                // 圆角只在两态间直接切换：9999px 向小圆角插值会被浏览器压成半高椭圆
                mobileInboxOpen ? 'rounded-[20px]' : 'rounded-full'
              )}
            >
              <button
                type="button"
                onClick={() => setMobileInboxOpen((v) => !v)}
                className="flex w-full items-center gap-2 px-4 py-2.5"
              >
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-subtle px-1.5 text-[10px] font-medium tabular-nums text-content-secondary">
                  {inbox.length}
                </span>
                <span className="text-[13px] font-medium">待安排</span>
                <span className="ml-auto text-[11px] text-content-muted">
                  {mobileInboxOpen ? '收起' : '点开处理'}
                </span>
                <ChevronDown
                  size={15}
                  className={cn(
                    'text-content-muted transition-transform duration-fast',
                    mobileInboxOpen && 'rotate-180'
                  )}
                />
              </button>

              {mobileInboxOpen && (
                <div className="animate-fade-up border-t border-line/60">
                  <div className="px-3 pt-3">
                    <Composer onAdd={handleAdd} />
                  </div>
                  <div className="max-h-[36vh] overflow-y-auto scroll-thin px-2 py-2">
                    {inbox.map((item) => (
                      <InboxItem
                        key={item.id}
                        item={item}
                        compact
                        onEdit={() => setEditingId(item.id)}
                        onSchedule={() => handleScheduleOne(item.id)}
                      />
                    ))}
                    {inbox.length === 0 && (
                      <p className="px-3 py-4 text-center text-[11px] text-content-muted">
                        都排完了
                      </p>
                    )}
                  </div>
                  <div className="px-3 pb-3">
                    <button
                      type="button"
                      onClick={handleScheduleAll}
                      disabled={scheduling || schedulableCount === 0}
                      className="flex h-10 w-full items-center justify-center gap-1.5 rounded-control bg-accent text-[13px] font-medium text-accent-foreground transition-[transform,opacity] duration-fast active:scale-[0.99] disabled:opacity-35"
                    >
                      <Sparkles size={14} className={scheduling ? 'animate-pulse' : ''} />
                      {scheduling ? '正在排…' : '排今天'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 手机：悬浮在时间轴上方，输入或选中详情 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-[max(10px,env(safe-area-inset-bottom))] lg:hidden">
          <div className="pointer-events-auto w-full max-w-[340px]">
            {selected ? (
              <MobileSelection
                item={selected}
                onToggleDone={() => toggleDone(selected.id)}
                onEdit={() => setEditingId(selected.id)}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              // 待安排抽屉展开时自带输入框，悬浮条让位，避免压住「排今天」
              !mobileInboxOpen && <Composer onAdd={handleAdd} floating />
            )}
          </div>
        </div>
      </main>

      {/* 桌面大屏：概览与详情 */}
      <div className="hidden xl:flex">
        <Summary
          selected={selected}
          plannedMinutes={plannedMinutes}
          availableMinutes={AVAILABLE_MIN}
          doneCount={doneCount}
          totalCount={planned.length}
          nextGapText={nextGapText}
          inboxCount={inbox.length}
          onEdit={setEditingId}
          onToggleDone={toggleDone}
          onPostpone={postpone}
          onDelete={requestDeleteById}
        />
      </div>

      {editing && (
        <ItemEditor
          key={editing.id}
          item={editing}
          date={DATE}
          onClose={() => setEditingId(null)}
          onSave={handleSave}
          onDelete={requestDelete}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmingDelete)}
        title={confirmingDelete ? `删除「${confirmingDelete.title}」？` : '删除这条计划？'}
        description={
          confirmingDelete?.external && !confirmingDelete.external.missing
            ? '这是来自 aichatt 的待办，删除后原待办会保留；也可以在提示里撤销。'
            : '删除后可以在提示里撤销，不会影响其他日期。'
        }
        confirmLabel="删除"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmingDelete(null)}
      />

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex justify-center px-4 lg:bottom-8">
          <div className="flex animate-fade-up items-center gap-3 rounded-full bg-content-primary px-4 py-2 text-[12px] text-background">
            <span>{toast.text}</span>
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  const action = toast.action
                  setToast(null)
                  action?.onClick()
                }}
                className="pointer-events-auto shrink-0 font-medium text-background underline underline-offset-2"
              >
                {toast.action.label}
              </button>
            )}
          </div>
        </div>
      )}

      <ReviewSheet open={reviewOpen} date={DATE} onClose={() => setReviewOpen(false)} />
    </div>
  )
}
