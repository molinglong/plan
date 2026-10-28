export type Kind = 'task' | 'event' | 'memo'
export type Status = 'inbox' | 'planned' | 'done' | 'dropped'
export type Energy = 'deep' | 'light' | 'any'
/** 0 普通 / 1 重要 / 2 重要且紧急 */
export type Priority = 0 | 1 | 2

export interface PlanItem {
  id: string
  title: string
  note?: string
  kind: Kind
  status: Status
  /** 0 普通 / 1 重要 / 2 重要且紧急 */
  priority: Priority
  estimateMin: number
  energy: Energy
  /** 当日分钟数，如 9:30 = 570 */
  startMin?: number
  endMin?: number
  /** 计划所属日期；撤销删除时用它把条目放回原日期 */
  plannedDate?: string
  /** AI 排程理由，一句话 */
  reason?: string
  done?: boolean
  /** 连续顺延次数，>=3 触发降级提示 */
  postponeCount?: number
  /** 关联信息不包含服务端地址或凭证；原待办删除后保留本地安排。 */
  external?: { source: 'aichatt'; missing: boolean }
}

export interface TodoSyncResult {
  enabled: boolean
  added: number
  updated: number
  /** 今天到期的新待办里，自动排进时间轴的数量 */
  scheduled?: number
  syncedAt?: string
  error?: string
}
