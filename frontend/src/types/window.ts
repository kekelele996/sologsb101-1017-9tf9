/**
 * 窑炉时段窗口（KilnWindow）—— 设备台账（设备员记账）
 * 每台窑炉的检修窗口、停窑时段与可用时段均落在这张表，与排产台账分开记账。
 * 排位前对着可用时段看：落在检修 / 停窑窗口里的排位一律不许排。
 */

/** 窗口性质：检修窗口 / 停窑时段（两者均阻断排位）/ 可用时段（声明该时段可排） */
export type WindowKind = '检修' | '停窑' | '可用'

export const WINDOW_KIND_OPTIONS: WindowKind[] = ['检修', '停窑', '可用']

/** 阻断排位的窗口性质：检修窗口与停窑时段 */
export const BLOCKING_WINDOW_KINDS: WindowKind[] = ['检修', '停窑']

/** 全天窗口的起止时刻（迁移补窗口、播种时复用） */
export const ALL_DAY_START = 'T00:00'
export const ALL_DAY_END = 'T23:59'

export interface KilnWindow {
  id: string
  /** 窑炉归属（设备台账按窑炉记账） */
  furnaceId: string
  /** 窗口性质 */
  kind: WindowKind
  /** 开始时刻 ISO 字符串（YYYY-MM-DDTHH:mm） */
  startAt: string
  /** 结束时刻 ISO 字符串（YYYY-MM-DDTHH:mm） */
  endAt: string
  /** 检修内容 / 停窑原因 / 可用说明 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑窗口的表单草稿 */
export interface KilnWindowDraft {
  furnaceId: string
  kind: WindowKind
  startAt: string
  endAt: string
  note: string
}
