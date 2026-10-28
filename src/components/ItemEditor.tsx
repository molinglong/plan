import { useEffect, useState } from 'react'
import { Clock3, Trash2, X } from 'lucide-react'
import type { Energy, Kind, PlanItem } from '../types'
import { cn } from '../lib/utils'
import { defaultEventRange, fmtDuration, fmtTime, parseTimeInput } from '../lib/time'

interface ItemEditorProps {
  item: PlanItem
  date: string
  onClose: () => void
  onSave: (id: string, patch: Record<string, unknown>) => Promise<void>
  onDelete: (item: PlanItem) => void
}

const KINDS: { value: Kind; label: string }[] = [
  { value: 'task', label: '任务' },
  { value: 'event', label: '固定' },
  { value: 'memo', label: '备忘' },
]

const PRIORITIES = [
  { value: 0, label: '普通' },
  { value: 1, label: '重要' },
  { value: 2, label: '紧急' },
] as const

const ENERGIES: { value: Energy; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'light', label: '轻量' },
  { value: 'deep', label: '深度' },
]

/**
 * 条目编辑器：桌面与手机共用。
 *
 * 时间既是展示字段也是排程字段：填了时间就落到今天的时间轴，清掉就回到
 * 待安排。固定事件和备忘的时长规则不同，保存时统一在这里算好再交给接口。
 */
export function ItemEditor({ item, date, onClose, onSave, onDelete }: ItemEditorProps) {
  const fallback = defaultEventRange()
  const [title, setTitle] = useState(item.title)
  const [kind, setKind] = useState<Kind>(item.kind)
  const [priority, setPriority] = useState(item.priority)
  const [energy, setEnergy] = useState<Energy>(item.energy)
  const [estimate, setEstimate] = useState(String(item.estimateMin || 30))
  const [note, setNote] = useState(item.note ?? '')
  const [scheduled, setScheduled] = useState(item.startMin != null && item.endMin != null)
  const [start, setStart] = useState(
    item.startMin != null ? fmtTime(item.startMin) : fmtTime(fallback.startMin)
  )
  const [end, setEnd] = useState(
    item.endMin != null ? fmtTime(item.endMin) : fmtTime(fallback.endMin)
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const titleLocked = Boolean(item.external && !item.external.missing)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  function changeKind(next: Kind) {
    setKind(next)
    setError(null)
    if (next === 'memo') {
      setScheduled(false)
      setEstimate('0')
      return
    }
    if (next === 'event') {
      setScheduled(true)
      if (!scheduled) {
        const range = defaultEventRange()
        setStart(fmtTime(range.startMin))
        setEnd(fmtTime(range.endMin))
      }
      return
    }
    if (kind === 'memo' && Number(estimate) <= 0) setEstimate('30')
  }

  function toggleScheduled() {
    setError(null)
    if (scheduled) {
      setScheduled(false)
      return
    }
    if (!start || !end) {
      const range = defaultEventRange()
      setStart(fmtTime(range.startMin))
      setEnd(fmtTime(range.endMin))
    }
    setScheduled(true)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return

    const cleanTitle = title.trim()
    if (!cleanTitle) {
      setError('标题不能为空')
      return
    }

    let startMin: number | null = null
    let endMin: number | null = null
    if (kind !== 'memo' && scheduled) {
      startMin = parseTimeInput(start)
      endMin = parseTimeInput(end)
      if (startMin == null || endMin == null) {
        setError('时间格式应为 HH:MM')
        return
      }
      if (endMin <= startMin) {
        setError('结束时间必须晚于开始时间')
        return
      }
      if (kind === 'event' && endMin - startMin < 5) {
        setError('固定事件至少 5 分钟')
        return
      }
    }

    let estimateMin = 0
    if (kind === 'event') {
      estimateMin = startMin != null && endMin != null ? endMin - startMin : Number(estimate) || 30
    } else if (kind === 'task') {
      const parsed = Number(estimate)
      if (!Number.isFinite(parsed) || parsed < 5 || parsed > 480) {
        setError('预估时长需要在 5–480 分钟之间')
        return
      }
      estimateMin = Math.round(parsed)
    }

    setSaving(true)
    try {
      await onSave(item.id, {
        title: cleanTitle,
        kind,
        priority,
        energy: kind === 'memo' ? 'any' : energy,
        estimateMin,
        note,
        status: startMin != null && endMin != null ? 'planned' : 'inbox',
        plannedDate: startMin != null && endMin != null ? date : null,
        startMin,
        endMin,
        reason: startMin != null && endMin != null ? item.reason || '手动安排' : null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，稍后再试')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <div className="absolute inset-0 bg-content-primary/25" onClick={saving ? undefined : onClose} />

      <form
        role="dialog"
        aria-modal="true"
        aria-label="编辑计划"
        onSubmit={submit}
        className={cn(
          'absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col overflow-y-auto scroll-thin',
          'rounded-t-sheet border-t border-line bg-surface px-5 pb-[max(16px,env(safe-area-inset-bottom))] pt-3',
          'sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:w-[460px] sm:-translate-x-1/2 sm:-translate-y-1/2',
          'sm:rounded-panel sm:border sm:max-h-[85vh]',
          'animate-fade-up sm:animate-none'
        )}
      >
        <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-line-strong sm:hidden" />

        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-content-muted">
              {item.status === 'planned' ? '调整这条安排' : '补全这件事'}
            </p>
            <h2 className="mt-0.5 text-[17px] font-semibold leading-snug">编辑计划</h2>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            disabled={saving}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-content-muted transition-colors duration-fast hover:bg-surface-subtle hover:text-content-primary disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <label className="mt-4 block">
          <span className="text-[11px] text-content-muted">标题</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={titleLocked}
            maxLength={200}
            className={cn(
              'mt-1 h-10 w-full rounded-control border border-line bg-surface px-3 text-[13px]',
              'text-content-primary outline-none transition-colors duration-fast',
              'placeholder:text-content-muted focus:border-line-strong disabled:opacity-55'
            )}
          />
          {titleLocked && (
            <span className="mt-1 block text-[10px] text-content-muted">
              来自 aichatt 的标题请在 aichatt 修改
            </span>
          )}
        </label>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="类型">
            <div className="flex gap-1">
              {KINDS.map((option) => (
                <Choice
                  key={option.value}
                  active={kind === option.value}
                  onClick={() => changeKind(option.value)}
                >
                  {option.label}
                </Choice>
              ))}
            </div>
          </Field>

          <Field label="优先级">
            <div className="flex gap-1">
              {PRIORITIES.map((option) => (
                <Choice
                  key={option.value}
                  active={priority === option.value}
                  onClick={() => setPriority(option.value)}
                >
                  {option.label}
                </Choice>
              ))}
            </div>
          </Field>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          {kind === 'task' ? (
            <Field label="预估时长">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={5}
                  max={480}
                  step={5}
                  aria-label="预估时长"
                  value={estimate}
                  onChange={(e) => setEstimate(e.target.value)}
                  className="h-9 w-full min-w-0 rounded-control border border-line bg-surface px-2.5 text-[13px] tabular-nums text-content-primary outline-none transition-colors duration-fast focus:border-line-strong"
                />
                <span className="shrink-0 text-[11px] text-content-muted">分钟</span>
              </div>
            </Field>
          ) : (
            <Field label="预估时长">
              <p className="flex h-9 items-center text-[12px] text-content-muted">
                {kind === 'event'
                  ? scheduled
                    ? '跟随固定时段'
                    : '填时间后自动计算'
                  : '备忘不占时间'}
              </p>
            </Field>
          )}

          <Field label="精力">
            <div className="flex gap-1">
              {ENERGIES.map((option) => (
                <Choice
                  key={option.value}
                  active={energy === option.value}
                  onClick={() => setEnergy(option.value)}
                  disabled={kind === 'memo'}
                >
                  {option.label}
                </Choice>
              ))}
            </div>
          </Field>
        </div>

        {kind !== 'memo' && (
          <div className="mt-4 rounded-control border border-line/70 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Clock3 size={14} className="shrink-0 text-content-muted" />
              <span className="text-[12px] font-medium">安排到今天</span>
              <button
                type="button"
                role="switch"
                aria-label="安排到今天"
                aria-checked={scheduled}
                onClick={toggleScheduled}
                className={cn(
                  'ml-auto relative h-5 w-9 shrink-0 rounded-full transition-colors duration-fast',
                  scheduled ? 'bg-accent' : 'bg-surface-subtle'
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow-sm transition-[left] duration-fast',
                    scheduled ? 'left-[18px]' : 'left-0.5'
                  )}
                />
              </button>
            </div>

            {scheduled && (
              <div className="mt-2.5 flex items-center gap-2">
                <input
                  type="time"
                  step={300}
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  aria-label="开始时间"
                  className="h-9 min-w-0 flex-1 rounded-control border border-line bg-surface px-2.5 text-[13px] tabular-nums text-content-primary outline-none transition-colors duration-fast focus:border-line-strong"
                />
                <span className="text-[11px] text-content-muted">–</span>
                <input
                  type="time"
                  step={300}
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  aria-label="结束时间"
                  className="h-9 min-w-0 flex-1 rounded-control border border-line bg-surface px-2.5 text-[13px] tabular-nums text-content-primary outline-none transition-colors duration-fast focus:border-line-strong"
                />
                {parseTimeInput(start) != null && parseTimeInput(end) != null
                  && (parseTimeInput(end) as number) > (parseTimeInput(start) as number) && (
                    <span className="shrink-0 text-[10px] tabular-nums text-content-muted">
                      {fmtDuration((parseTimeInput(end) as number) - (parseTimeInput(start) as number))}
                    </span>
                  )}
              </div>
            )}
            {!scheduled && (
              <p className="mt-1.5 text-[10px] text-content-muted">
                关掉后回到待安排，可以重新排时间
              </p>
            )}
          </div>
        )}

        <label className="mt-4 block">
          <span className="text-[11px] text-content-muted">备注</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="补充上下文、验收标准或需要带的东西…"
            className="mt-1 w-full resize-none rounded-control border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-content-primary outline-none transition-colors duration-fast placeholder:text-content-muted focus:border-line-strong"
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-[11px] text-danger">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2 pb-1">
          <button
            type="button"
            onClick={() => onDelete(item)}
            disabled={saving}
            className="flex h-10 items-center gap-1.5 rounded-control px-2.5 text-[12px] text-content-muted transition-colors duration-fast hover:bg-surface-muted hover:text-danger disabled:opacity-40"
          >
            <Trash2 size={14} />
            删除
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-10 rounded-control px-3 text-[12px] text-content-secondary transition-colors duration-fast hover:bg-surface-muted disabled:opacity-40"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="h-10 rounded-control bg-accent px-5 text-[13px] font-medium text-accent-foreground transition-[transform,opacity] duration-fast active:scale-[0.99] disabled:opacity-45"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1 block text-[11px] text-content-muted">{label}</span>
      {children}
    </div>
  )
}

function Choice({
  active,
  onClick,
  children,
  disabled = false,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-8 flex-1 rounded-control px-1 text-[11px] transition-colors duration-fast',
        active
          ? 'bg-accent text-accent-foreground'
          : 'bg-surface-muted text-content-secondary hover:bg-surface-subtle',
        disabled && 'opacity-40'
      )}
    >
      {children}
    </button>
  )
}
