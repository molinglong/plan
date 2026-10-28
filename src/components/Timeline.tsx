import { useEffect, useMemo, useRef } from 'react'
import type { PlanItem } from '../types'
import { PlanBlock } from './PlanBlock'
import { DAY_END, DAY_START, fmtTime, nowMinutes } from '../lib/time'

export interface BlockLayout {
  lane: number
  lanes: number
  /** 同列下一块之间隔多少分钟；最后一块为 Infinity */
  gapMin: number
}

/**
 * 给时间块分配列。
 *
 * 时间真正交叉的块必须并排，否则会一个压住另一个；不交叉的块留在同一列。
 * 同时算出到下一块的间隔，供 PlanBlock 限制高度——块不能长到吃掉后面的空档。
 */
function layoutBlocks(items: PlanItem[]): Map<string, BlockLayout> {
  const sorted = [...items].sort(
    (a, b) => (a.startMin ?? 0) - (b.startMin ?? 0) || (a.endMin ?? 0) - (b.endMin ?? 0)
  )
  const out = new Map<string, BlockLayout>()
  let cluster: { item: PlanItem; lane: number; end: number }[] = []
  let clusterEnd = 0

  const flush = () => {
    if (!cluster.length) return
    const lanes = Math.max(...cluster.map((c) => c.lane)) + 1
    for (const entry of cluster) {
      const sameLane = cluster
        .filter((c) => c.lane === entry.lane)
        .sort((a, b) => (a.item.startMin ?? 0) - (b.item.startMin ?? 0))
      const next = sameLane[sameLane.indexOf(entry) + 1]
      out.set(entry.item.id, {
        lane: entry.lane,
        lanes,
        gapMin: next ? (next.item.startMin ?? 0) - (entry.item.startMin ?? 0) : Infinity,
      })
    }
    cluster = []
  }

  for (const item of sorted) {
    const start = item.startMin ?? 0
    const end = item.endMin ?? start + item.estimateMin
    if (cluster.length && start >= clusterEnd) flush()
    let lane = 0
    while (cluster.some((c) => c.lane === lane && c.end > start)) lane++
    cluster.push({ item, lane, end })
    clusterEnd = cluster.length === 1 ? end : Math.max(clusterEnd, end)
  }
  flush()
  return out
}

interface TimelineProps {
  items: PlanItem[]
  loading?: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onToggleDone: (id: string) => void
}

export function Timeline({
  items,
  loading = false,
  selectedId,
  onSelect,
  onToggleDone,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const planned = items.filter((i) => i.status === 'planned' && i.startMin != null)
  // planned 是每次渲染新建的数组，依赖 items 才能真的省掉重复计算
  const layouts = useMemo(() => layoutBlocks(planned), [items])
  const now = nowMinutes()
  const showNow = now >= DAY_START && now <= DAY_END
  // 此刻是否已经落在某个已排块的时间里
  const nowInBlock = planned.some((item) => {
    const start = item.startMin ?? 0
    const end = item.endMin ?? start + item.estimateMin
    return now >= start && now < end
  })
  const hours = (DAY_END - DAY_START) / 60
  const ticks = Array.from({ length: hours + 1 }, (_, i) => DAY_START + i * 60)

  // 首次进入滚到当前时间附近，省得手动找
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const offset = Math.max(0, (now - DAY_START) / 60 - 1.5) * 56
    el.scrollTop = offset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={scrollRef} className="timeline min-h-0 flex-1 overflow-y-auto scroll-thin">
      {/* 手机顶部让出悬浮的「待安排」条，桌面维持原留白 */}
      <div className="px-0 pb-28 pt-16 lg:pb-10 lg:pt-4">
        <div className="relative" style={{ height: `calc(var(--hour) * ${hours})` }}>
          {/* 小时刻度线 */}
          {ticks.map((min, i) => (
            <div
              key={min}
              className="absolute inset-x-0 flex items-start"
              style={{ top: `calc(var(--hour) * ${i})` }}
            >
              <span className="w-12 shrink-0 -translate-y-1/2 pr-2 text-right text-[10px] tabular-nums text-content-muted lg:w-14">
                {min === DAY_END ? '24:00' : fmtTime(min)}
              </span>
              <div className="h-px flex-1 bg-line/55" />
            </div>
          ))}

          {/* 半小时虚线，弱到几乎看不见，只用来对齐 */}
          {ticks.slice(0, -1).map((min, i) => (
            <div
              key={`half-${min}`}
              className="pointer-events-none absolute inset-x-0 flex items-start"
              style={{ top: `calc(var(--hour) * ${i + 0.5})` }}
            >
              <span className="w-12 shrink-0 lg:w-14" />
              <div className="h-px flex-1 bg-line/25" />
            </div>
          ))}

          {/*
            当前时间线：只在空档里画。
            现在正落在某个已排块里时，线会被块切成一左一右两截、圆点还被块压掉一半，
            块本身已经说明「此刻在做这个」，再画线只会显脏。
          */}
          {showNow && !nowInBlock && (
            <div
              className="pointer-events-none absolute inset-x-0 z-[5]"
              style={{ top: `calc(var(--hour) * ${(now - DAY_START) / 60})` }}
            >
              <div className="flex items-center">
                <span className="w-12 pr-2 text-right text-[10px] font-medium tabular-nums text-danger lg:w-14">
                  {fmtTime(now)}
                </span>
                <div className="relative h-px flex-1 bg-danger/60">
                  <span className="absolute -left-[3px] -top-[2.5px] h-[6px] w-[6px] rounded-full bg-danger" />
                </div>
              </div>
            </div>
          )}

          {/* 时间块 */}
          {planned.map((item, i) => (
            <PlanBlock
              key={item.id}
              item={item}
              index={i}
              layout={layouts.get(item.id) ?? { lane: 0, lanes: 1, gapMin: Infinity }}
              selected={selectedId === item.id}
              onSelect={() => onSelect(item.id)}
              onToggleDone={() => onToggleDone(item.id)}
            />
          ))}

          {/* 空状态：今天还没排 */}
          {!loading && planned.length === 0 && (
            <div className="absolute inset-x-0 top-[28%] flex flex-col items-center gap-2 px-8 text-center">
              <p className="text-sm text-content-secondary">今天还是一张白纸</p>
              <p className="max-w-[240px] text-xs leading-relaxed text-content-muted">
                把想做的事先丢进「待安排」，点一下排今天。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
