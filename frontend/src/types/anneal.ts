/**
 * 退火（Anneal）
 * 窑位分配与曲线段编排；窑位时间窗冲突时禁用提交，出炉即回写作品状态。
 */

/** 退火曲线段：升温 / 保温 / 缓冷 */
export type CurveSeg = '升温' | '保温' | '缓冷'

/** 退火状态：待入窑 / 退火中 / 已出炉（物理退火阶段） */
export type AnnealState = '待入窑' | '退火中' | '已出炉'

/**
 * 排位状态（排产台账侧），与物理退火状态分开记账：
 * 已排位 = 已排入窑位时段；待排 = 被设备侧检修/停窑窗口撞回，等按新时段重排；
 * 挂起 = 两边按窑炉和时段对不上，等人确认。
 */
export type SchedStatus = '已排位' | '待排' | '挂起'

export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉']
export const SCHED_STATUS_OPTIONS: SchedStatus[] = ['已排位', '待排', '挂起']

/** 状态推进顺序 */
export const ANNEAL_STATE_FLOW: AnnealState[] = ['待入窑', '退火中', '已出炉']

export interface Anneal {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 退火窑号 + 窑位，如 AN-01-A1 */
  kilnSlot: string
  /** 曲线段 */
  curveSeg: CurveSeg
  /** 入窑时间 ISO 字符串（YYYY-MM-DDTHH:mm） */
  inAt: string
  /** 出炉时间 ISO 字符串；未出炉为空串 */
  outAt: string
  /** 退火状态 */
  state: AnnealState
  /** 排位状态（排产台账）：已排位 / 待排 / 挂起 */
  schedStatus: SchedStatus
  /** 排位备注：撞窗退回原因 / 对账挂起原因 / 重排记录 */
  schedNote: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑退火的表单草稿 */
export interface AnnealDraft {
  pieceId: string
  kilnSlot: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
  schedStatus: SchedStatus
  schedNote: string
}
