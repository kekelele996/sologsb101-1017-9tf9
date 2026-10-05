/**
 * 退火（Anneal）
 * 窑位分配与曲线段编排；窑位时间窗冲突时禁用提交，出炉即回写作品状态。
 */

/** 退火曲线段：升温 / 保温 / 缓冷 */
export type CurveSeg = '升温' | '保温' | '缓冷'

/** 退火状态：待入窑 / 退火中 / 已出炉 */
export type AnnealState = '待入窑' | '退火中' | '已出炉'

/**
 * 排位记账状态（排产侧，与退火工艺状态 state 分开）：
 * - 待排：尚未排上，或被设备侧检修窗口变更顶回，等待按新时段重排；
 * - 已排：排位有效，入窑/出炉时段当前不撞任何检修窗口；
 * - 挂起：按窑炉和时段与设备侧对账对不上，先挂起等人确认。
 */
export type ScheduleState = '待排' | '已排' | '挂起'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '挂起']

/** 排位被退回 / 挂起的原因说明（排产侧记账） */
export const SCHEDULE_STATE_LABEL: Record<ScheduleState, string> = {
  待排: '待排',
  已排: '已排',
  挂起: '挂起',
}

export const CURVE_SEG_OPTIONS: CurveSeg[] = ['升温', '保温', '缓冷']
export const ANNEAL_STATE_OPTIONS: AnnealState[] = ['待入窑', '退火中', '已出炉']

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
  /** 排位记账状态（排产侧）：待排 / 已排 / 挂起 */
  scheduleState: ScheduleState
  /** 排位所属退火窑号（窑号前缀，如 AN-01），旧数据升级时由窑位号回填 */
  furnaceCode: string
  /** 被设备侧检修/停窑窗口顶回，或对账挂起时的原因 */
  scheduleNote: string
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
}
