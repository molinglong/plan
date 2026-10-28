import { Check } from 'lucide-react'
import type { PlanItem } from '../types'
import type { BlockLayout } from './Timeline'
import { cn } from '../lib/utils'
import { DAY_START, fmtTime } from '../lib/time'

/** 块底留 1px，避免与下一块贴死；不扣多，否刍短任务会显得比实际时长短 */
const BOTTOM_PX = 1
/** 万一数据里同列两块挨得太近，给它们留 4px 缝隙 */
const LANE_GAP_RESERVE_PX = 4
/** 块再矮也给一点可点面积 */
const MIN_HEIGHT_PX = 6
/**
 * 自身高度和到下一块的间隔都小于这个分钟数时换紧凑单行排法。
 * 50 分钟在手机端约 46px，放不下「标题 + 时间/理由」两行（约 47px），会顶破块，
 * 所以只有整小时的块才展示第二行。
 */
const DENSE_MIN = 50
const LANE_GAP_PX = 4

interface PlanBlockProps {
  item: PlanItem
  selected: boolean
  index: number
  /** Timeline 算好的列与间隔 */
  layout: BlockLayout
  onSelect: () => void
  onToggleDone: () => void
}

/**
 * 优先级不单独画标记：直接反映在勾选圈的描边深浅上（与 Inbox 列表的圆点同口径）。
 * 之前块左侧贴边画一条 2px 竖线，在圆角卡片里像边裂了道缝，已去掉。
 */
function checkTone(item: PlanItem): string {
  if (item.priority === 2) return 'border-content-primary'
  if (item.priority === 1) return 'border-content-secondary'
  return 'border-line-strong'
}

export function PlanBlock({
  item,
  selected,
  index,
  layout,
  onSelect,
  onToggleDone,
}: PlanBlockProps) {
  const start = item.startMin ?? 0
  const end = item.endMin ?? start + item.estimateMin
  const dur = Math.max(1, end - start)
  // 高度封顶到下一块开始的位置：短任务不能靠最小高度往下顶，那会压住后一件事
  const gapMin = Number.isFinite(layout.gapMin) && layout.gapMin > 0 ? layout.gapMin : null
  const natural = `calc(var(--hour) * ${dur / 60} - ${BOTTOM_PX}px)`
  // 同列的块本来就不会相交，gap 限制只是防御脏数据，正常不会生效
  const height = `max(${MIN_HEIGHT_PX}px, ${
    gapMin
      ? `min(${natural}, calc(var(--hour) * ${gapMin / 60} - ${LANE_GAP_RESERVE_PX}px))`
      : natural
  })`
  const dense = (gapMin ? Math.min(dur, gapMin) : dur) <= DENSE_MIN
  const isMemo = item.kind === 'memo'
  const isEvent = item.kind === 'event'
  const done = !!item.done
  const { lane, lanes } = layout

  return (
    <div
      data-block-id={item.id}
      className="absolute left-12 right-2 z-10 animate-block-in lg:left-14"
      style={{
        top: `calc(var(--hour) * ${(start - DAY_START) / 60})`,
        height,
        animationDelay: `${Math.min(index, 10) * 45}ms`,
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        style={
          lanes > 1
            ? {
                width: `calc((100% - ${(lanes - 1) * LANE_GAP_PX}px) / ${lanes})`,
                marginLeft: `calc(${lane} * ((100% - ${(lanes - 1) * LANE_GAP_PX}px) / ${lanes} + ${LANE_GAP_PX}px))`,
              }
            : undefined
        }
        className={cn(
          // w-full 兜底单列时铺满；并排时下面用 inline style 覆盖成半宽
          'group relative flex h-full w-full items-start overflow-hidden border text-left',
          'transition-[border-color,background-color,opacity] duration-fast',
          'outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-content-primary/35',
          isMemo
            ? 'border-note-edge bg-note-paper text-note-ink'
            : 'border-line bg-surface text-content-primary',
          isEvent && 'border-dashed bg-surface-muted',
          // 选中只靠一层边框加深 + 极淡底，不再叠外圈：两层描边在浅灰底上像输入框聚焦，太抢眼
          selected
            ? cn(
                isMemo ? 'border-note-sub/70' : 'border-content-secondary/55',
                !isMemo && 'bg-accent-soft/50'
              )
            : !isEvent && (isMemo ? 'hover:border-note-sub/60' : 'hover:border-line-strong'),
          done && 'opacity-55',
          // 矮块用小圆角，免得 12px 圆角在二十几像素高时把块描成一枚胶囊
          dur <= 30 ? 'rounded-control' : 'rounded-card'
        )}
      >
        <span
          className={cn(
            'flex h-full w-full gap-2',
            // 矮块用左内边距对齐上方正常块（勾选圈中心 20px vs 19.5px），不要整块缩边
            dense ? 'items-center pl-3.5 pr-2.5' : 'items-start py-1.5 pl-3 pr-2'
          )}
        >
          <span
            role="checkbox"
            aria-checked={done}
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onToggleDone()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onToggleDone()
              }
            }}
            className={cn(
              'flex shrink-0 items-center justify-center rounded-full border transition-colors duration-fast',
              dense ? 'h-3 w-3' : 'mt-[2px] h-[15px] w-[15px]',
              done
                ? 'border-content-primary bg-content-primary text-accent-foreground'
                : cn(checkTone(item), 'bg-transparent hover:border-content-primary/70')
            )}
          >
            {done && <Check size={dense ? 7 : 9} strokeWidth={3.5} />}
          </span>

          <span className="min-w-0 flex-1">
            <span
              className={cn('flex gap-1.5', dense ? 'items-center' : 'items-baseline')}
            >
              <span
                className={cn(
                  'truncate font-medium',
                  dense ? 'text-[11px] leading-[13px]' : 'text-[13px] leading-tight',
                  done && 'line-through decoration-content-muted'
                )}
              >
                {item.title}
              </span>
              {isMemo && (
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-note-sub">
                  备忘
                </span>
              )}
            </span>

            {!dense && (
              <span className="mt-1 flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-[10px] tabular-nums text-content-muted">
                  {fmtTime(start)}–{fmtTime(end)}
                </span>
                {item.reason && (
                  <>
                    <span className="h-2 w-px shrink-0 bg-line" />
                    <span className="truncate text-[10px] text-content-muted">
                      {item.reason}
                    </span>
                  </>
                )}
              </span>
            )}
          </span>
        </span>
      </button>
    </div>
  )
}
