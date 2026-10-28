import { Check, Clock3, Pencil, RotateCcw, Trash2, X } from 'lucide-react'
import type { PlanItem } from '../types'
import { cn } from '../lib/utils'
import { fmtDuration, fmtTime } from '../lib/time'

interface SummaryProps {
  selected: PlanItem | null
  plannedMinutes: number
  availableMinutes: number
  doneCount: number
  totalCount: number
  nextGapText: string
  inboxCount: number
  onEdit: (id: string) => void
  onToggleDone: (id: string) => void
  onPostpone: (id: string) => void
  onDelete: (id: string) => void
}

export function Summary({
  selected,
  plannedMinutes,
  availableMinutes,
  doneCount,
  totalCount,
  nextGapText,
  inboxCount,
  onEdit,
  onToggleDone,
  onPostpone,
  onDelete,
}: SummaryProps) {
  const remaining = Math.max(0, availableMinutes - plannedMinutes)
  const ratio = Math.min(1, plannedMinutes / availableMinutes)

  const pace =
    ratio > 0.78
      ? '排得有点满，建议挪走一件'
      : ratio > 0.55
        ? '节奏健康，留了缓冲'
        : '节奏宽松，还能加一件事'

  return (
    <aside className="flex w-[304px] shrink-0 flex-col border-l border-line/70">
      <div className="px-4 pb-3 pt-5">
        <h2 className="text-sm font-medium">今日概览</h2>
      </div>

      <div className="space-y-2.5 px-4">
        <Stat label="可用" value={fmtDuration(availableMinutes)} />
        <Stat label="已排" value={fmtDuration(plannedMinutes)} strong />
        <Stat label="留白" value={fmtDuration(remaining)} />
        <div className="!mt-3 h-[3px] overflow-hidden rounded-full bg-surface-subtle">
          <div
            className="h-full rounded-full bg-content-secondary transition-[width] duration-slow ease-standard"
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
        <p className="text-[10px] text-content-muted">
          已排 {Math.round(ratio * 100)}% · {pace}
        </p>
      </div>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto scroll-thin border-t border-line/70 px-4 py-4">
        {selected ? (
          <div key={selected.id} className="animate-fade-up">
            <div className="flex items-start gap-2">
              <h3 className="min-w-0 flex-1 text-[15px] font-medium leading-snug">
                {selected.title}
              </h3>
              <span className="mt-0.5 shrink-0 rounded-full bg-surface-subtle px-2 py-0.5 text-[10px] text-content-secondary">
                {selected.kind === 'event'
                  ? '固定'
                  : selected.kind === 'memo'
                    ? '备忘'
                    : '任务'}
              </span>
            </div>

            <p className="mt-1 flex items-center gap-1.5 text-[11px] tabular-nums text-content-muted">
              {selected.startMin != null && (
                <>
                  <Clock3 size={12} />
                  {fmtTime(selected.startMin)}–{fmtTime(selected.endMin ?? 0)}
                  <span className="text-line-strong">·</span>
                  {fmtDuration((selected.endMin ?? 0) - selected.startMin)}
                </>
              )}
              {selected.done && (
                <>
                  <span className="text-line-strong">·</span>
                  <span>已完成</span>
                </>
              )}
            </p>

            {selected.external && (
              <p className="mt-2 text-[11px] text-content-muted">
                {selected.external.missing ? 'aichatt 原待办已删除，保留本地安排' : '来自 aichatt · 完成状态双向同步'}
              </p>
            )}

            {selected.reason && (
              <div className="mt-3 rounded-control bg-surface-muted px-3 py-2">
                <p className="text-[10px] text-content-muted">为什么排这</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-content-secondary">
                  {selected.reason}
                </p>
              </div>
            )}

            {selected.note && (
              <div className="mt-2 rounded-control bg-surface-muted px-3 py-2">
                <p className="text-[10px] text-content-muted">备注</p>
                <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-content-secondary">
                  {selected.note}
                </p>
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => onToggleDone(selected.id)}
                className={cn(
                  'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-control text-[12px] font-medium transition-[transform,opacity] duration-fast active:scale-[0.99]',
                  selected.done
                    ? 'border border-line text-content-secondary'
                    : 'bg-accent text-accent-foreground'
                )}
              >
                {selected.done ? <RotateCcw size={13} /> : <Check size={13} />}
                {selected.done ? '取消完成' : '完成'}
              </button>
              <button
                type="button"
                onClick={() => onPostpone(selected.id)}
                className="h-9 rounded-control border border-line px-3 text-[12px] text-content-secondary transition-colors duration-fast hover:bg-surface-muted"
              >
                顺延
              </button>
              <button
                type="button"
                aria-label="编辑"
                onClick={() => onEdit(selected.id)}
                className="flex h-9 w-9 items-center justify-center rounded-control border border-line text-content-muted transition-colors duration-fast hover:bg-surface-muted hover:text-content-primary"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                aria-label="删除"
                onClick={() => onDelete(selected.id)}
                className="flex h-9 w-9 items-center justify-center rounded-control border border-line text-content-muted transition-colors duration-fast hover:bg-surface-muted hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-2 pb-8 text-center">
            <p className="text-xs text-content-secondary">点一个时间块</p>
            <p className="text-[11px] leading-relaxed text-content-muted">
              看看它为什么排在这个位置，也可以顺手完成、顺延或删掉。
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-line/70 px-4 py-3">
        <p className="text-[11px] leading-relaxed text-content-muted">{nextGapText}</p>
        {inboxCount > 0 && (
          <p className="mt-0.5 text-[10px] text-content-muted">
            待安排还有 {inboxCount} 项
          </p>
        )}
      </div>
    </aside>
  )
}

function Stat({
  label,
  value,
  strong,
}: {
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[11px] text-content-muted">{label}</span>
      <span
        className={cn(
          'text-[13px] tabular-nums',
          strong ? 'font-medium text-content-primary' : 'text-content-secondary'
        )}
      >
        {value}
      </span>
    </div>
  )
}

/** 手机端选中条：悬浮在时间轴上方，替代输入框，展示理由 + 完成 */
export function MobileSelection({
  item,
  onToggleDone,
  onEdit,
  onClose,
}: {
  item: PlanItem
  onToggleDone: () => void
  onEdit: () => void
  onClose: () => void
}) {
  const meta = [
    item.external && (item.external.missing ? 'aichatt 原待办已删除' : '来自 aichatt'),
    item.reason,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="animate-fade-up rounded-panel border border-line bg-surface px-3.5 pb-3 pt-3 shadow-[0_10px_28px_-12px_rgb(0_0_0/0.28),0_2px_6px_-3px_rgb(0_0_0/0.12)]">
      {/* 信息区：时间在上、标题放开成两行，右上角只有关闭 */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {item.startMin != null && (
            <p className="text-[11px] tabular-nums text-content-muted">
              {fmtTime(item.startMin)}–{fmtTime(item.endMin ?? 0)} ·{' '}
              {fmtDuration((item.endMin ?? 0) - item.startMin)}
            </p>
          )}
          <p
            className={cn(
              'mt-1 line-clamp-2 text-[14px] font-medium leading-snug',
              item.done && 'text-content-muted line-through'
            )}
          >
            {item.title}
          </p>
          {meta && (
            <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-content-secondary">
              {meta}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="-mr-1.5 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-content-muted transition-colors duration-fast hover:bg-surface-subtle"
        >
          <X size={15} />
        </button>
      </div>

      {/* 操作区：完成是主操作占满，编辑退成方形次按钮 */}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleDone}
          className={cn(
            'flex h-9 flex-1 items-center justify-center rounded-control text-[12px] font-medium transition-colors duration-fast',
            item.done
              ? 'bg-surface-subtle text-content-secondary'
              : 'bg-accent text-accent-foreground'
          )}
        >
          {item.done ? '标记未完成' : '完成'}
        </button>
        <button
          type="button"
          aria-label="编辑"
          onClick={onEdit}
          className="flex h-9 w-11 shrink-0 items-center justify-center rounded-control border border-line text-content-secondary transition-colors duration-fast hover:bg-surface-subtle"
        >
          <Pencil size={14} />
        </button>
      </div>
    </div>
  )
}
