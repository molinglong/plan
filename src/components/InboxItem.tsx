import { ArrowRight, StickyNote } from 'lucide-react'
import type { PlanItem } from '../types'
import { cn } from '../lib/utils'
import { fmtDuration } from '../lib/time'

export function InboxItem({
  item,
  onEdit,
  onSchedule,
  compact = false,
}: {
  item: PlanItem
  onEdit: () => void
  onSchedule: () => void
  compact?: boolean
}) {
  const isMemo = item.kind === 'memo'

  return (
    <div
      role="button"
      tabIndex={0}
      title="编辑"
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onEdit()
        }
      }}
      className={cn(
        'group flex cursor-pointer items-start gap-2 rounded-control px-2 py-2 transition-colors duration-fast',
        'hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-none',
        compact && 'py-1.5'
      )}
    >
      <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
        {isMemo ? (
          <StickyNote size={13} className="text-note-sub" />
        ) : (
          <span
            className={cn(
              'h-[7px] w-[7px] rounded-full border',
              item.priority === 2
                ? 'border-content-primary bg-content-primary'
                : item.priority === 1
                  ? 'border-content-secondary'
                  : 'border-line-strong'
            )}
          />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug text-content-primary">{item.title}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-content-muted">
          {item.external && <span>{item.external.missing ? 'aichatt 原待办已删除' : '来自 aichatt'}</span>}
          {item.estimateMin > 0 && <span>{fmtDuration(item.estimateMin)}</span>}
          {item.priority === 2 && (
            <>
              <span className="text-line-strong">·</span>
              <span>重要</span>
            </>
          )}
          {isMemo && (
            <>
              <span className="text-line-strong">·</span>
              <span>备忘</span>
            </>
          )}
        </p>
      </div>

      {!isMemo && (
        <button
          type="button"
          aria-label="排到今天"
          onClick={(e) => {
            e.stopPropagation()
            onSchedule()
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            'text-content-muted opacity-0 transition-all duration-fast',
            'hover:bg-surface-subtle hover:text-content-primary',
            'group-hover:opacity-100 focus-visible:opacity-100 active:scale-95',
            'max-lg:opacity-100'
          )}
        >
          <ArrowRight size={14} />
        </button>
      )}
    </div>
  )
}
