/**
 * 退火窑位与曲线状态管理（Pinia）
 * 维护窑位占用表与退火曲线段；窑位冲突时禁止提交，出炉即回写作品状态。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg, SchedStatus } from '../types/anneal'
import { ANNEAL_STATE_FLOW, SCHED_STATUS_OPTIONS } from '../types/anneal'
import type { Piece } from '../types/piece'
import type { Furnace } from '../types/furnace'
import type { KilnWindow } from '../types/window'
import {
  ROW_REVISION,
  advanceAnnealState,
  db,
  initDatabase,
  putAnneal,
  removeAnneal,
  setSchedStatus,
} from '../utils/db'
import {
  checkSlotConflict,
  checkWindowBlockById,
  formatHours,
  kilnCodeOfSlot,
  kilnSlots,
  pendingBlockReason,
  reconcilePlacements,
  segmentHours,
  totalAnnealHours,
  type ReconcileMismatch,
  type SlotConflict,
  type WindowBlock,
} from '../utils/thermal'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
  schedStatus: SchedStatus | 'all'
}

/** 窑位占用行 */
export interface SlotOccupancy {
  kilnSlot: string
  annealId: string
  pieceId: string
  pieceName: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
  /** 该窑位当前是否被未出炉记录占用 */
  occupied: boolean
}

const EMPTY_FILTERS: AnnealFilters = {
  keyword: '',
  state: 'all',
  curveSeg: 'all',
  kilnCode: 'all',
  schedStatus: 'all',
}

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const windows = ref<KilnWindow[]>([])
  const furnaces = ref<Furnace[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  /** 窑号 → 窑炉 id（排位窑位 AN-01-A1 → AN-01 对应窑炉） */
  const furnaceIdByCode = computed<Map<string, string>>(
    () => new Map(furnaces.value.map((row) => [row.code, row.id])),
  )
  const furnaceCodeById = computed<Map<string, string>>(
    () => new Map(furnaces.value.map((row) => [row.id, row.code])),
  )

  /** 由窑位解析窑炉 id；设备台账里查不到返回空串 */
  function furnaceIdOfSlot(kilnSlot: string): string {
    return furnaceIdByCode.value.get(kilnCodeOfSlot(kilnSlot)) ?? ''
  }

  const kilnCodes = computed<string[]>(() => {
    const set = new Set<string>()
    anneals.value.forEach((row) => {
      const code = row.kilnSlot.split('-').slice(0, -1).join('-')
      if (code !== '') set.add(code)
    })
    return Array.from(set).sort()
  })

  const wallThicknessOf = (pieceId: string): number =>
    pieces.value.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 窑位占用表 */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .map((row) => {
        const piece = pieces.value.find((item) => item.id === row.pieceId)
        return {
          kilnSlot: row.kilnSlot,
          annealId: row.id,
          pieceId: row.pieceId,
          pieceName: piece?.name ?? '（作品已删除）',
          curveSeg: row.curveSeg,
          inAt: row.inAt,
          outAt: row.outAt,
          state: row.state,
          occupied: row.state !== '已出炉',
        }
      })
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt))
  )

  const occupiedSlotCount = computed<number>(() => new Set(occupancy.value.filter((row) => row.occupied).map((row) => row.kilnSlot)).size)
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return anneals.value.filter((row) => {
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.curveSeg !== 'all' && row.curveSeg !== filters.curveSeg) return false
      if (filters.schedStatus !== 'all' && row.schedStatus !== filters.schedStatus) return false
      if (filters.kilnCode !== 'all' && !row.kilnSlot.startsWith(filters.kilnCode)) return false
      if (keyword === '') return true
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      return (
        row.kilnSlot.toLowerCase().includes(keyword) ||
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword)
      )
    })
  })

  /* -------------------- 排产台账状态汇总 -------------------- */
  const pendingCount = computed<number>(() => anneals.value.filter((row) => row.schedStatus === '待排').length)
  const suspendedCount = computed<number>(() => anneals.value.filter((row) => row.schedStatus === '挂起').length)
  const scheduledCount = computed<number>(() => anneals.value.filter((row) => row.schedStatus === '已排位').length)

  /** 某件作品的窑位冲突检测（编辑时排除自身） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  ): SlotConflict {
    return checkSlotConflict(anneals.value, candidate, wallThicknessOf, candidate.id)
  }

  /**
   * 设备台账校验：排位是否落进该窑炉的检修 / 停窑窗口，或窑炉归属在设备侧不存在。
   * 排位前对着设备那份可用时段看，落在检修窗口里的不许排。
   */
  function windowBlockOf(
    candidate: Pick<Anneal, 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  ): WindowBlock & { unknownFurnace: boolean } {
    const furnaceId = furnaceIdOfSlot(candidate.kilnSlot)
    const kilnCode = kilnCodeOfSlot(candidate.kilnSlot)
    if (furnaceId === '') {
      return {
        blocked: true,
        unknownFurnace: true,
        windowId: '',
        kind: '',
        message: `窑位「${candidate.kilnSlot}」对应的窑炉（${kilnCode || '未知'}）在设备台账里不存在，无法核对可用时段。`,
      }
    }
    const block = checkWindowBlockById(
      windows.value,
      furnaceId,
      candidate,
      wallThicknessOf,
      kilnCode,
    )
    return { ...block, unknownFurnace: false }
  }

  /** 一条待排排位在当前设备窗口下是否仍不能重排；返回空串表示可重排 */
  function pendingReasonOf(anneal: Anneal): string {
    return pendingBlockReason(anneal, windows.value, furnaceCodeById.value, wallThicknessOf)
  }

  /** 某件作品的退火时长汇总 */
  function durationOf(pieceId: string): { hours: number; text: string } {
    const thickness = wallThicknessOf(pieceId)
    const hours = totalAnnealHours(thickness)
    return { hours, text: formatHours(hours) }
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, pieceRows, windowRows, furnaceRows] = await Promise.all([
            db.anneals.toArray(),
            db.pieces.toArray(),
            db.kilnWindows.toArray(),
            db.furnaces.toArray(),
          ])
          return { annealRows, pieceRows, windowRows, furnaceRows }
        }).subscribe({
          next: ({ annealRows, pieceRows, windowRows, furnaceRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            windows.value = windowRows
            furnaces.value = furnaceRows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取退火数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<AnnealFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    const conflict = conflictOf({
      id: '',
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return null
    }
    const block = windowBlockOf({
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (block.blocked) {
      lastMessage.value = block.message
      return null
    }
    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      // 新排位通过窑位 + 设备窗口双重校验，直接计入已排位
      schedStatus: '已排位',
      schedNote: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = `已分配窑位 ${row.kilnSlot}，理论时长 ${formatHours(segmentHours(row.curveSeg, wallThicknessOf(row.pieceId)))}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const conflict = conflictOf({
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return false
    }
    const block = windowBlockOf({
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (block.blocked) {
      lastMessage.value = block.message
      return false
    }
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      // 手工重新提交即按新时段重排成功，回到已排位
      schedStatus: '已排位',
      schedNote:
        existing.schedStatus === '待排'
          ? `已按新时段重排到 ${draft.kilnSlot}（${draft.inAt.replace('T', ' ')} 起）。`
          : existing.schedNote,
    })
    revision.value += 1
    lastMessage.value = '退火编排已更新'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除'
  }

  /** 推进退火状态；「已出炉」写回出炉时间并同步作品状态 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
    const next = ANNEAL_STATE_FLOW[index + 1]
    await advanceAnnealState(annealId, next, nowLocalInput())
    revision.value += 1
    lastMessage.value =
      next === '已出炉' ? '已登记出炉，作品状态已回写为「已退火」' : `退火状态已推进为「${next}」`
    return next
  }

  /**
   * 按新时段重排待排排位（保留窑位/时刻，依据当前设备窗口重新放行）。
   * 仍撞窗口或窑炉归属缺失时不改状态，返回失败原因；成功则回到「已排位」。
   */
  async function reschedule(annealId: string): Promise<{ ok: boolean; message: string }> {
    const row = anneals.value.find((item) => item.id === annealId)
    if (row === undefined) return { ok: false, message: '排位不存在' }
    if (row.schedStatus !== '待排') return { ok: false, message: '只有待排排位需要重排' }
    const reason = pendingReasonOf(row)
    if (reason !== '') {
      return { ok: false, message: `仍不能重排：${reason}` }
    }
    await setSchedStatus(annealId, '已排位', `已按设备侧新时段重新放行（${nowLocalInput().replace('T', ' ')}）。`)
    revision.value += 1
    lastMessage.value = `排位 ${row.kilnSlot} 已按新时段重排为已排位`
    return { ok: true, message: lastMessage.value }
  }

  /** 人确认后处理挂起排位：确认无冲突 → 已排位；确认仍需调整 → 退回待排 */
  async function resolveSuspended(annealId: string, decision: '已排位' | '待排'): Promise<void> {
    const row = anneals.value.find((item) => item.id === annealId)
    if (row === undefined || row.schedStatus !== '挂起') return
    const note =
      decision === '已排位'
        ? `人工对账确认窑炉归属与时段无误，恢复为已排位（${nowLocalInput().replace('T', ' ')}）。`
        : `人工对账后退回待排，请改约窑位/时段（${nowLocalInput().replace('T', ' ')}）。`
    await setSchedStatus(annealId, decision, note)
    revision.value += 1
    lastMessage.value = decision === '已排位' ? '挂起排位已确认恢复' : '挂起排位已退回待排'
  }

  /**
   * 两边按窑炉和时段对账：对不上的排位先挂起等人确认。
   * 仅把当前「已排位」且核对失败的记录改为「挂起」，其余不动；返回对不上的明细。
   */
  async function reconcile(): Promise<{ mismatches: ReconcileMismatch[]; suspended: string[] }> {
    const mismatches = reconcilePlacements(
      anneals.value,
      windows.value,
      furnaceCodeById.value,
      wallThicknessOf,
    )
    const stamp = nowLocalInput().replace('T', ' ')
    const suspended: string[] = []
    for (const mismatch of mismatches) {
      // 二次确认当前状态，避免并发重复挂起
      const row = anneals.value.find((item) => item.id === mismatch.annealId)
      if (row === undefined || row.schedStatus !== '已排位') continue
      await setSchedStatus(mismatch.annealId, '挂起', `对账挂起（${stamp}）：${mismatch.reason}`)
      suspended.push(mismatch.annealId)
    }
    revision.value += 1
    lastMessage.value =
      suspended.length > 0
        ? `对账完成：${suspended.length} 条排位对不上，已挂起等人确认。`
        : '对账完成：全部已排位与设备台账一致。'
    return { mismatches, suspended }
  }

  /** 当前按窑炉和时段对账的差异明细（不落库，供页面预览） */
  const reconcileMismatches = computed<ReconcileMismatch[]>(() =>
    reconcilePlacements(anneals.value, windows.value, furnaceCodeById.value, wallThicknessOf),
  )

  return {
    anneals,
    pieces,
    windows,
    furnaces,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    SCHED_STATUS_OPTIONS,
    kilnCodes,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    visibleAnneals,
    pendingCount,
    suspendedCount,
    scheduledCount,
    reconcileMismatches,
    wallThicknessOf,
    conflictOf,
    windowBlockOf,
    pendingReasonOf,
    durationOf,
    furnaceIdOfSlot,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
    reschedule,
    resolveSuspended,
    reconcile,
  }
})
