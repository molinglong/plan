import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Plus, X } from 'lucide-react'
import type { CreateItemInput } from '../lib/api'
import type { Kind } from '../types'
import { cn } from '../lib/utils'
import { DAY_END, defaultEventRange, fmtTime, parseTimeInput } from '../lib/time'
import { parseQuickAdd, type QuickSegment } from '../lib/quick-parse'

interface ComposerProps {
  onAdd: (inputs: CreateItemInput[]) => void
  placeholder?: string
  /** 悬浮态：输入条自己就是漂浮元素，白底 + 细边 + 投影，浮窗向上弹 */
  floating?: boolean
}

/** 悬浮输入条的投影：轻到不抢眼，但能和时间轴拉开层次 */
const FLOAT_SHADOW =
  'shadow-[0_10px_28px_-12px_rgb(0_0_0/0.28),0_2px_6px_-3px_rgb(0_0_0/0.12)]'

/** 单点时刻补多长：任务半小时、固定一小时；时段按时段本身 */
const POINT_TASK_MIN = 30
const POINT_EVENT_MIN = 60

const KINDS: { value: Kind; label: string }[] = [
  { value: 'task', label: '任务' },
  { value: 'event', label: '固定' },
  { value: 'memo', label: '备忘' },
]

const PLACEHOLDER: Record<Kind, string> = {
  task: '9点写周报，10点开会…',
  event: '记一个固定安排…',
  memo: '记一条备忘…',
}

/** 把一句话拆出来的片段补成接口要的形状 */
function toCreateInput(
  segment: QuickSegment,
  manualStart: number | null,
  manualEnd: number | null
): CreateItemInput {
  if (segment.kind === 'memo') {
    return { title: segment.title, kind: 'memo', priority: 0, estimateMin: 0, energy: 'any' }
  }

  let startMin = segment.startMin
  let endMin = segment.endMin
  // 句子里没写时间、又选成了固定：退回手动填的那段时间
  if (startMin == null && segment.kind === 'event') {
    startMin = manualStart ?? undefined
    endMin = manualEnd ?? undefined
  }
  if (startMin == null) {
    return { title: segment.title, kind: segment.kind, priority: 1, estimateMin: POINT_TASK_MIN, energy: 'any' }
  }
  if (endMin == null) {
    endMin = startMin + (segment.kind === 'event' ? POINT_EVENT_MIN : POINT_TASK_MIN)
  }
  endMin = Math.min(endMin, DAY_END)
  if (endMin <= startMin) endMin = Math.min(startMin + POINT_TASK_MIN, DAY_END)

  return {
    title: segment.title,
    kind: segment.kind,
    priority: 1,
    // 服务端估时上限 480，超了会被悄悄改成 30
    estimateMin: Math.min(480, endMin - startMin),
    energy: 'any',
    startMin,
    endMin,
  }
}

/** 预览胶囊：一眼看到会被拆成几条、各自排到几点，点 × 直接删这一段 */
function DraftChip({ segment, onRemove }: { segment: QuickSegment; onRemove: () => void }) {
  const time = segment.startMin == null
    ? null
    : segment.endMin == null
      ? fmtTime(segment.startMin)
      : `${fmtTime(segment.startMin)}–${fmtTime(segment.endMin)}`

  return (
    <span className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-line bg-surface-subtle pl-2 pr-0.5 text-[11px]">
      {time && <span className="shrink-0 tabular-nums text-content-muted">{time}</span>}
      <span className="max-w-[112px] truncate text-content-secondary">{segment.title}</span>
      <button
        type="button"
        aria-label={`去掉 ${segment.title}`}
        onClick={onRemove}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-content-muted transition-colors duration-fast hover:bg-surface-muted hover:text-content-secondary"
      >
        <X size={11} />
      </button>
    </span>
  )
}

/** 快速收集：一句话可记多件；写了时间就排进今天，没写就落待安排 */
export function Composer({ onAdd, placeholder, floating = false }: ComposerProps) {
  const [value, setValue] = useState('')
  const [kind, setKind] = useState<Kind>('task')
  /** 手动挑过种类就整句按它来，不再按句子猜 */
  const [kindLocked, setKindLocked] = useState(false)
  const [kindOpen, setKindOpen] = useState(false)
  /** 中文输入法拼写中不弹胶囊，避免拼音阶段闪 */
  const [composing, setComposing] = useState(false)
  const kindRef = useRef<HTMLDivElement>(null)
  const range = defaultEventRange()
  const [start, setStart] = useState(fmtTime(range.startMin))
  const [end, setEnd] = useState(fmtTime(range.endMin))

  // 点浮窗外面或按 Esc 收起种类选择
  useEffect(() => {
    if (!kindOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (!kindRef.current?.contains(e.target as Node)) setKindOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setKindOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [kindOpen])

  const drafts = useMemo(() => {
    const parsed = parseQuickAdd(value)
    if (!kindLocked) return parsed
    return parsed.map((segment) =>
      kind === 'memo'
        ? { ...segment, kind, startMin: undefined, endMin: undefined }
        : { ...segment, kind }
    )
  }, [value, kind, kindLocked])

  const currentKind = KINDS.find((option) => option.value === kind) ?? KINDS[0]
  const manualStart = parseTimeInput(start)
  const manualEnd = parseTimeInput(end)
  const manualValid = manualStart != null && manualEnd != null && manualEnd > manualStart
  // 只有「固定 + 句子里没写时间」才依赖下面那两个时间框
  const needsManualTime = drafts.some((d) => d.kind === 'event' && d.startMin == null)
  const canSubmit = drafts.length > 0 && (!needsManualTime || manualValid)

  const showDrafts = !composing && (drafts.length > 1 || drafts.some((d) => d.startMin != null))

  const draftRow = showDrafts ? (
    <div
      className={cn(
        'flex flex-wrap gap-1 px-1',
        floating ? 'mb-1.5' : 'mt-1.5'
      )}
    >
      {drafts.map((segment) => (
        <DraftChip
          key={`${segment.start}-${segment.end}`}
          segment={segment}
          onRemove={() => removeDraft(segment)}
        />
      ))}
    </div>
  ) : null

  /** 删胶囊 = 从原文里剪掉这段，输入框跟着变短，不做隐藏状态 */
  function removeDraft(target: QuickSegment) {
    const next = (value.slice(0, target.start) + value.slice(target.end))
      .replace(/[，,、；;]{2,}/g, '，')
      .replace(/^[\s，,、；;。]+|[\s，,、；;。]+$/g, '')
    setValue(next)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return

    onAdd(drafts.map((segment) => toCreateInput(segment, manualStart, manualEnd)))
    setValue('')
    setKindOpen(false)
  }

  return (
    <form onSubmit={submit}>
      {floating && draftRow}

      {/* 一体式输入条：种类浮窗 + 发送按钮都收进输入框右端 */}
      <div
        className={cn(
          'flex items-center rounded-full border bg-surface pr-1 transition-colors duration-fast focus-within:border-line-strong',
          floating ? cn('h-11', FLOAT_SHADOW) : 'h-10'
        )}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(e) => {
            // 输入法组词时回车是选词，不是提交（Safari 收尾帧 keyCode 229）
            const native = e.nativeEvent
            if (e.key === 'Enter' && (native.isComposing || native.keyCode === 229)) {
              e.preventDefault()
            }
          }}
          placeholder={placeholder ?? PLACEHOLDER[kind]}
          enterKeyHint="done"
          autoComplete="off"
          className="h-full min-w-0 flex-1 rounded-full bg-transparent py-0 pl-4 pr-2 text-[13px] text-content-primary outline-none placeholder:text-content-muted"
        />

        <div ref={kindRef} className="relative shrink-0">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={kindOpen}
            aria-label={`记录类型：${currentKind.label}`}
            onClick={() => setKindOpen((v) => !v)}
            className={cn(
              'flex h-7 items-center gap-0.5 rounded-full pl-2 pr-1.5 text-[11px] transition-colors duration-fast',
              kindOpen
                ? 'bg-surface-subtle text-content-secondary'
                : 'text-content-muted hover:bg-surface-subtle hover:text-content-secondary'
            )}
          >
            {currentKind.label}
            <ChevronDown
              size={12}
              className={cn('transition-transform duration-fast', kindOpen && 'rotate-180')}
            />
          </button>

          {kindOpen && (
            <div
              role="listbox"
              aria-label="选择记录类型"
              className={cn(
                'absolute right-0 z-40 w-32 animate-fade-up overflow-hidden rounded-card border border-line bg-surface p-1',
                FLOAT_SHADOW,
                // 悬浮条贴底，向上弹；桌面左栏在上方，向下弹
                floating ? 'bottom-full mb-2' : 'top-full mt-1.5'
              )}
            >
              {KINDS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={kind === option.value}
                  onClick={() => {
                    setKind(option.value)
                    setKindLocked(true)
                    setKindOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-control px-2.5 py-1.5 text-[12px] transition-colors duration-fast',
                    kind === option.value
                      ? 'text-content-primary'
                      : 'text-content-secondary hover:bg-surface-muted'
                  )}
                >
                  {option.label}
                  {kind === option.value && <Check size={12} />}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="submit"
          aria-label="添加"
          disabled={!canSubmit}
          className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition-[transform,opacity] duration-fast active:scale-95 disabled:opacity-35"
        >
          <Plus size={16} />
        </button>
      </div>

      {!floating && draftRow}

      {kind === 'event' && (
        <div
          className={cn(
            'flex items-center gap-1.5',
            floating
              ? cn('mt-2 rounded-full border border-line bg-surface px-2 py-1.5', FLOAT_SHADOW)
              : 'mt-1.5'
          )}
        >
          <input
            type="time"
            step={300}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            aria-label="事件开始时间"
            className="h-7 min-w-0 flex-1 rounded-control border border-line bg-surface px-2 text-[11px] tabular-nums text-content-primary outline-none focus:border-line-strong"
          />
          <span className="text-[10px] text-content-muted">–</span>
          <input
            type="time"
            step={300}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            aria-label="事件结束时间"
            className="h-7 min-w-0 flex-1 rounded-control border border-line bg-surface px-2 text-[11px] tabular-nums text-content-primary outline-none focus:border-line-strong"
          />
          <span className="shrink-0 text-[10px] text-content-muted">
            {needsManualTime ? (manualValid ? '固定' : '时间不对') : '按句子里的时间'}
          </span>
        </div>
      )}
    </form>
  )
}
