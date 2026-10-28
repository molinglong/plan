import { useEffect } from 'react'
import { cn } from '../lib/utils'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 轻量确认框：删除这类不可逆动作先停一下，不把确认做成第二套弹窗系统 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-6" role="presentation">
      <div className="absolute inset-0 bg-content-primary/30" onClick={busy ? undefined : onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-[340px] animate-fade-up rounded-panel border border-line bg-surface p-5 shadow-xl"
      >
        <h3 className="text-[15px] font-medium leading-snug">{title}</h3>
        {description && (
          <p className="mt-1.5 text-[12px] leading-relaxed text-content-secondary">{description}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-9 rounded-control px-3 text-[12px] text-content-secondary transition-colors duration-fast hover:bg-surface-muted disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              'h-9 rounded-control px-4 text-[12px] font-medium transition-[transform,opacity] duration-fast active:scale-[0.99] disabled:opacity-45',
              danger
                ? 'bg-danger text-white'
                : 'bg-accent text-accent-foreground'
            )}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
