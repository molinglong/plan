import { Sparkles } from 'lucide-react'
import type { CreateItemInput } from '../lib/api'
import type { PlanItem } from '../types'
import { cn } from '../lib/utils'
import { Composer } from './Composer'
import { InboxItem } from './InboxItem'

interface InboxProps {
  items: PlanItem[]
  onAdd: (inputs: CreateItemInput[]) => void
  onEdit: (id: string) => void
  onScheduleOne: (id: string) => void
  onScheduleAll: () => void
  scheduling: boolean
}

export function Inbox({
  items,
  onAdd,
  onEdit,
  onScheduleOne,
  onScheduleAll,
  scheduling,
}: InboxProps) {
  const schedulable = items.filter((i) => i.kind !== 'memo').length

  return (
    <aside className="flex w-[288px] shrink-0 flex-col border-r border-line/70">
      <div className="px-4 pb-2.5 pt-5">
        <h2 className="text-sm font-medium">待安排</h2>
        <p className="mt-0.5 text-[11px] text-content-muted">
          {items.length ? `${items.length} 条 · 先记下来，晚点排` : '想到什么先丢进来'}
        </p>
      </div>

      <div className="px-3 pb-2">
        <Composer onAdd={onAdd} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-2 pb-3">
        {items.map((item) => (
          <InboxItem
            key={item.id}
            item={item}
            onEdit={() => onEdit(item.id)}
            onSchedule={() => onScheduleOne(item.id)}
          />
        ))}

        {items.length === 0 && (
          <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
            <p className="text-xs text-content-secondary">都排完了</p>
            <p className="text-[11px] leading-relaxed text-content-muted">
              有新的想法随时记，明天再排。
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-line/70 p-3">
        <button
          type="button"
          onClick={onScheduleAll}
          disabled={scheduling || schedulable === 0}
          className={cn(
            'flex h-10 w-full items-center justify-center gap-1.5 rounded-control',
            'bg-accent text-[13px] font-medium text-accent-foreground',
            'transition-[transform,opacity] duration-fast active:scale-[0.99] disabled:opacity-35'
          )}
        >
          <Sparkles size={14} className={scheduling ? 'animate-pulse' : ''} />
          {scheduling ? '正在排…' : '排今天'}
        </button>
        <p className="mt-2 text-center text-[10px] text-content-muted">
          只排 70%，给意外留点余地
        </p>
      </div>
    </aside>
  )
}
