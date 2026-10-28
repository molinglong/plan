import { Moon, NotebookPen, RefreshCw, Sun } from 'lucide-react'
import { cn } from '../lib/utils'
import { fmtDuration, todayParts } from '../lib/time'

interface HeaderProps {
  plannedMinutes: number
  doneCount: number
  totalCount: number
  dark: boolean
  onToggleDark: () => void
  onOpenReview: () => void
  onSyncTodos: () => void
  syncing: boolean
}

export function Header({
  plannedMinutes,
  doneCount,
  totalCount,
  dark,
  onToggleDark,
  onOpenReview,
  onSyncTodos,
  syncing,
}: HeaderProps) {
  const { md, week } = todayParts()
  const pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0

  return (
    <header className="shrink-0 border-b border-line/70 bg-background/85 px-4 pb-3 pt-3 backdrop-blur-md lg:px-6 lg:pt-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[22px] font-semibold leading-tight tracking-tight lg:text-2xl">
              {md}
            </h1>
            <span className="text-xs text-content-muted">{week}</span>
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-content-muted">
            <span>今天</span>
            <span className="text-line-strong">·</span>
            <span>已排 {fmtDuration(plannedMinutes)}</span>
            <span className="text-line-strong">·</span>
            <span>
              完成 <b className="font-medium text-content-secondary">{doneCount}</b>/
              {totalCount}
            </span>
          </p>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton label="今日复盘" onClick={onOpenReview}>
            <NotebookPen size={17} />
          </IconButton>
          <IconButton label="切换主题" onClick={onToggleDark}>
            {dark ? <Sun size={17} /> : <Moon size={17} />}
          </IconButton>
          <IconButton label="同步 aichatt 待办" onClick={onSyncTodos} disabled={syncing}>
            <RefreshCw size={17} className={syncing ? 'motion-safe:animate-spin' : ''} />
          </IconButton>
        </div>
      </div>

      <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-surface-subtle">
        <div
          className="h-full rounded-full bg-content-primary transition-[width] duration-slow ease-standard"
          style={{ width: `${pct}%` }}
        />
      </div>
    </header>
  )
}

function IconButton({
  children,
  label,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-full text-content-secondary',
        'transition-colors duration-fast hover:bg-surface-subtle hover:text-content-primary',
        'active:scale-95 disabled:opacity-40'
      )}
    >
      {children}
    </button>
  )
}
