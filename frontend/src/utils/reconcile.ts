/**
 * 设备侧 ↔ 排产侧对账纯逻辑
 * - 排位窗口与设备窗口（检修 / 停窑 / 可用）的时间窗重叠判定
 * - 排位前校验：落在检修 / 停窑窗口里的不许排
 * - 设备窗口变更后：把已排又撞进检修窗口的排位识别出来（退回待排）
 * - 两边按窑炉和时段对账：归属对不上 / 撞检修窗口的排位识别出来（挂起等人确认）
 * 本文件不触碰 Dexie，全部为可单测的纯函数。
 */
import type { Anneal } from '../types/anneal'
import type { DeviceWindow } from '../types/deviceWindow'
import { isBlockingKind } from '../types/deviceWindow'
import { annealWindow, parseAt, windowsOverlap } from './thermal'

/** 一天的毫秒数 */
export const DAY_MS = 24 * 60 * 60 * 1000

/** 由窑位号取窑号前缀：AN-01-A1 → AN-01；取不到返回空串 */
export function kilnCodeOfSlot(kilnSlot: string): string {
  const parts = kilnSlot.split('-')
  return parts.length >= 2 ? parts.slice(0, -1).join('-') : ''
}

/** 把 YYYY-MM-DD 解析为当地零点时间戳（new Date('YYYY-MM-DD') 会按 UTC 解析，导致时区错位） */
export function localDateStartMs(dateOnly: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly)
  if (match === null) return Number.NaN
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
}

/** 设备窗口的时间窗 [start, end)，毫秒时间戳；非法返回 null */
export function deviceWindowSpan(win: DeviceWindow): [number, number] | null {
  if (win.allDay) {
    const day = localDateStartMs(win.localDate)
    if (Number.isNaN(day)) return null
    return [day, day + DAY_MS]
  }
  const start = parseAt(win.startAt)
  let end = parseAt(win.endAt)
  if (Number.isNaN(start)) return null
  if (Number.isNaN(end) || end <= start) end = start + DAY_MS
  return [start, end]
}

/** 排位（退火）的时间窗，复用热工计算：未出炉时按入窑 + 该段理论时长 */
export function annealSpan(row: Pick<Anneal, 'inAt' | 'outAt' | 'curveSeg'>, wallThicknessMm: number): [number, number] | null {
  const span = annealWindow(row, wallThicknessMm)
  if (Number.isNaN(span[0])) return null
  return span
}

export interface WindowHit {
  window: DeviceWindow
  span: [number, number]
}

/** 找出与某个排位时间窗重叠的全部设备窗口（同窑号） */
export function hitDeviceWindows(
  anneal: Pick<Anneal, 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'furnaceCode'>,
  wallThicknessMm: number,
  windows: DeviceWindow[],
): WindowHit[] {
  const span = annealSpan(anneal, wallThicknessMm)
  if (span === null) return []
  const code = anneal.furnaceCode || kilnCodeOfSlot(anneal.kilnSlot)
  const hits: WindowHit[] = []
  for (const win of windows) {
    if (win.writeState !== 'written') continue
    if (win.furnaceCode !== code) continue
    const winSpan = deviceWindowSpan(win)
    if (winSpan !== null && windowsOverlap(span, winSpan)) hits.push({ window: win, span: winSpan })
  }
  return hits
}

/** 命中的检修 / 停窑窗口（禁止排位） */
export function blockingHits(hits: WindowHit[]): WindowHit[] {
  return hits.filter((hit) => isBlockingKind(hit.window.kind))
}

/** 命中的可用窗口 */
export function availabilityHits(hits: WindowHit[]): WindowHit[] {
  return hits.filter((hit) => hit.window.kind === '可用')
}

export interface DeviceConflict {
  conflict: boolean
  /** 撞上的设备窗口类型（检修 / 停窑） */
  kind: string
  windowId: string
  message: string
}

const NO_CONFLICT: DeviceConflict = { conflict: false, kind: '', windowId: '', message: '' }

/**
 * 排位前校验：时间窗落在检修 / 停窑窗口里的不许排。
 * 「可用」窗口不强制（设备侧可能只登记检修、不逐段登记可用），仅检修/停窑阻断。
 */
export function checkDeviceWindowConflict(
  anneal: Pick<Anneal, 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'furnaceCode'>,
  wallThicknessMm: number,
  windows: DeviceWindow[],
): DeviceConflict {
  const hit = blockingHits(hitDeviceWindows(anneal, wallThicknessMm, windows))[0]
  if (hit === undefined) return NO_CONFLICT
  const where = hit.window.allDay
    ? `${hit.window.localDate} 全天`
    : `${hit.window.startAt.replace('T', ' ')} ~ ${hit.window.endAt.replace('T', ' ')}`
  return {
    conflict: true,
    kind: hit.window.kind,
    windowId: hit.window.id,
    message: `该窑炉在 ${where} 安排了「${hit.window.kind}」${
      hit.window.note === '' ? '' : `（${hit.window.note}）`
    }，落在设备检修/停窑时段内的排位不允许提交，请改时段或换窑位。`,
  }
}

/**
 * 设备窗口变更后：判断哪些「已排」排位又撞进了新的检修/停窑窗口，需退回待排。
 * 只针对已排记录；待排、挂起不在此列。
 */
export function findAnnealsToRetreat(
  anneals: Anneal[],
  windows: DeviceWindow[],
  wallThicknessOf: (pieceId: string) => number,
): Array<{ anneal: Anneal; hit: WindowHit }> {
  const result: Array<{ anneal: Anneal; hit: WindowHit }> = []
  for (const row of anneals) {
    if (row.scheduleState !== '已排') continue
    if (row.state === '已出炉') continue
    const hit = blockingHits(hitDeviceWindows(row, wallThicknessOf(row.pieceId), windows))[0]
    if (hit !== undefined) result.push({ anneal: row, hit })
  }
  return result
}

/** 对账单项：某条排位与设备侧账目的核对结果 */
export interface ReconcileItem {
  anneal: Anneal
  /** 是否需要人工确认（挂起） */
  needsHold: boolean
  /** 撞检修窗口（在设备窗口变更里通常由 findAnnealsToRetreat 先退回；对账仍兜底） */
  blocked: boolean
  reason: string
}

/**
 * 两边按窑炉和时段对账：
 * - 排位没记窑炉归属（旧数据补不上窑号）→ 挂起等人确认；
 * - 排位时段撞上检修/停窑窗口 → 挂起等人确认（由人工决定改期还是维持）。
 * 已出炉、待排、已挂起的记录不重复挂起。
 */
export function buildReconciliation(
  anneals: Anneal[],
  windows: DeviceWindow[],
  knownFurnaceCodes: string[],
  wallThicknessOf: (pieceId: string) => number,
): ReconcileItem[] {
  const known = new Set(knownFurnaceCodes)
  const items: ReconcileItem[] = []
  for (const row of anneals) {
    if (row.scheduleState !== '已排') continue
    if (row.state === '已出炉') continue

    const code = (row.furnaceCode || kilnCodeOfSlot(row.kilnSlot)).trim()
    if (code === '' || !known.has(code)) {
      items.push({
        anneal: row,
        needsHold: true,
        blocked: false,
        reason: code === '' ? '排位缺少窑炉归属，设备侧无此窑炉账目。' : `设备侧台账中没有窑炉「${code}」，窑炉归属对不上。`,
      })
      continue
    }

    const hit = blockingHits(hitDeviceWindows(row, wallThicknessOf(row.pieceId), windows))[0]
    if (hit !== undefined) {
      items.push({
        anneal: row,
        needsHold: true,
        blocked: true,
        reason: `排位时段与设备侧「${hit.window.kind}」窗口重叠（${
          hit.window.allDay ? `${hit.window.localDate} 全天` : hit.window.startAt.replace('T', ' ')
        }），两边时段对不上。`,
      })
    }
  }
  return items
}

/** 生成退回 / 挂起时的原因备注 */
export function retreatNote(kind: string, allDay: boolean, when: string, startAt: string): string {
  const where = allDay ? `${when} 全天` : startAt.replace('T', ' ')
  return `设备侧${kind}窗口（${where}）变更，排位撞入检修/停窑时段，已退回待排，请按新时段重排。`
}
