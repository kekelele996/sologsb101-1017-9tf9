/**
 * 设备窗口（DeviceWindow）—— 设备侧台账
 * 由窑炉设备员记账：每台窑炉的检修窗口、停窑时段与可用时段。
 * 与排产侧（Anneal）分开记账：排位时只读取设备侧的可用/检修时段做校验，
 * 设备侧写入失败走设备侧自己的重试队列（deviceOutbox），排产那份不受影响。
 */

/** 设备窗口类型：检修窗口 / 停窑时段 / 可用时段 */
export type DeviceWindowKind = '检修' | '停窑' | '可用'

export const DEVICE_WINDOW_KIND_OPTIONS: DeviceWindowKind[] = ['检修', '停窑', '可用']

/** 设备窗口是否为「禁止排位」的窗口 */
export function isBlockingKind(kind: DeviceWindowKind): boolean {
  return kind === '检修' || kind === '停窑'
}

/** 设备侧写入状态：已写入设备台账 / 写入失败等待设备侧重试 */
export type DeviceWriteState = 'written' | 'failed'

export const DEVICE_WRITE_STATE_LABEL: Record<DeviceWriteState, string> = {
  written: '已写入',
  failed: '写入失败·待重试',
}

/**
 * 设备窗口（设备侧记账行）。
 * 时段二选一：
 * - allDay=true：用 localDate（YYYY-MM-DD）表示全天，startAt/endAt 留空；
 * - allDay=false：用 startAt/endAt（YYYY-MM-DDTHH:mm）表示精确时段（结束时刻本身不含）。
 * furnaceCode 记窑号 code（而非窑炉内部 id），因为排产侧的窑位号也以窑号为前缀。
 */
export interface DeviceWindow {
  id: string
  /** 窑炉归属（窑号，如 AN-01） */
  furnaceCode: string
  kind: DeviceWindowKind
  /** 全天日期 YYYY-MM-DD（allDay=true 时使用） */
  localDate: string
  /** 精确起始时刻 YYYY-MM-DDTHH:mm（allDay=false 时使用） */
  startAt: string
  /** 精确结束时刻 YYYY-MM-DDTHH:mm（allDay=false 时使用） */
  endAt: string
  allDay: boolean
  /** 检修内容 / 停窑原因 / 可用说明 */
  note: string
  /** 设备侧写入状态 */
  writeState: DeviceWriteState
  /** 最近一次写入失败原因 */
  lastError: string
  /** 设备侧重试次数 */
  attempts: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑设备窗口的表单草稿 */
export interface DeviceWindowDraft {
  furnaceCode: string
  kind: DeviceWindowKind
  localDate: string
  startAt: string
  endAt: string
  allDay: boolean
  note: string
}

/** 设备侧重试队列里的一次写操作（put 新建/编辑、remove 删除） */
export type DeviceOpKind = 'put' | 'remove'

/** 重试队列操作状态：待处理 / 失败待重试；成功后即出队 */
export type DeviceOpState = 'pending' | 'failed'

export interface DeviceWriteOp {
  id: string
  opKind: DeviceOpKind
  /** put 时携带待写入的完整窗口；remove 时为 null */
  window: DeviceWindow | null
  /** 目标窗口 id（remove 时据此删除） */
  windowId: string
  state: DeviceOpState
  attempts: number
  lastError: string
  /**
   * 演示用：首次处理时让设备侧写入失败一次（落到 failed），
   * 随后人工点「重试」即可成功写入；排产侧数据全程不受影响。
   */
  failOnce: boolean
  createdAt: string
  updatedAt: string
}
