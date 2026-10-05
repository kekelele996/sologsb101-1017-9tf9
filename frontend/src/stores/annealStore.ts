/**
 * 退火窑位与曲线状态管理（Pinia）
 * 维护窑位占用表与退火曲线段；窑位冲突时禁止提交，出炉即回写作品状态。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW } from '../types/anneal'
import type { Piece } from '../types/piece'
import type { DeviceWindow } from '../types/deviceWindow'
import {
  ROW_REVISION,
  advanceAnnealState,
  db,
  initDatabase,
  putAnneal,
  removeAnneal,
  repairAnnealScheduleState,
  resetAnnealSchedule,
  resolveAnnealSchedule,
} from '../utils/db'
import {
  checkSlotConflict,
  formatHours,
  kilnSlots,
  segmentHours,
  totalAnnealHours,
  type SlotConflict,
} from '../utils/thermal'
import { checkDeviceWindowConflict, kilnCodeOfSlot, type DeviceConflict } from '../utils/reconcile'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
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

const EMPTY_FILTERS: AnnealFilters = { keyword: '', state: 'all', curveSeg: 'all', kilnCode: 'all' }

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const deviceWindows = ref<DeviceWindow[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  /** 已写入设备台账、参与排位校验的设备窗口 */
  const committedDeviceWindows = computed<DeviceWindow[]>(() =>
    deviceWindows.value.filter((row) => row.writeState === 'written'),
  )

  /** 待重排（被设备窗口顶回）的排位 */
  const pendingAnneals = computed<Anneal[]>(() => anneals.value.filter((row) => row.scheduleState === '待排'))
  /** 挂起等人工确认的排位 */
  const heldAnneals = computed<Anneal[]>(() => anneals.value.filter((row) => row.scheduleState === '挂起'))

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

  /** 某件作品的窑位冲突检测（编辑时排除自身） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  ): SlotConflict {
    return checkSlotConflict(anneals.value, candidate, wallThicknessOf, candidate.id)
  }

  /** 某条候选排位与设备侧检修/停窑窗口的冲突检测（排位前看设备那份可用时段） */
  function deviceConflictOf(
    candidate: Pick<Anneal, 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId' | 'furnaceCode'>,
  ): DeviceConflict {
    const code = candidate.furnaceCode || kilnCodeOfSlot(candidate.kilnSlot)
    return checkDeviceWindowConflict(
      { ...candidate, furnaceCode: code },
      wallThicknessOf(candidate.pieceId),
      committedDeviceWindows.value,
    )
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
          const [annealRows, pieceRows, windowRows] = await Promise.all([
            db.anneals.toArray(),
            db.pieces.toArray(),
            db.deviceWindows.toArray(),
          ])
          return { annealRows, pieceRows, windowRows }
        }).subscribe({
          next: ({ annealRows, pieceRows, windowRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            deviceWindows.value = windowRows
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
    const furnaceCode = kilnCodeOfSlot(draft.kilnSlot)
    const slotConflict = conflictOf({
      id: '',
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (slotConflict.conflict) {
      lastMessage.value = slotConflict.message
      return null
    }
    const deviceConflict = deviceConflictOf({
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
      furnaceCode,
    })
    if (deviceConflict.conflict) {
      lastMessage.value = deviceConflict.message
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
      scheduleState: '已排',
      furnaceCode,
      scheduleNote: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = `已分配窑位 ${row.kilnSlot}，理论时长 ${formatHours(segmentHours(row.curveSeg, wallThicknessOf(row.pieceId)))}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<Anneal | null> {
    const furnaceCode = kilnCodeOfSlot(draft.kilnSlot)
    const slotConflict = conflictOf({
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (slotConflict.conflict) {
      lastMessage.value = slotConflict.message
      return null
    }
    const deviceConflict = deviceConflictOf({
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
      furnaceCode,
    })
    if (deviceConflict.conflict) {
      lastMessage.value = deviceConflict.message
      return null
    }
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const updated: Anneal = {
      ...existing,
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      furnaceCode,
      // 改好时段重新提交即恢复为已排（待排/挂起排位经此重排）
      scheduleState: '已排',
      scheduleNote: existing.scheduleState === '已排' ? existing.scheduleNote : '已按设备侧新时段重新排位。',
    }
    await putAnneal(updated)
    revision.value += 1
    lastMessage.value = '退火编排已更新'
    return updated
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

  /** 把挂起排位退回待排（人工选择改期重排） */
  async function sendBackToPending(annealId: string, note = '人工确认后退回待排，按新时段重排。'): Promise<void> {
    await resetAnnealSchedule([annealId], note)
    revision.value += 1
    lastMessage.value = '已退回待排，请改时段后重新排位。'
  }

  /** 人工确认维持挂起排位原时段，恢复为已排 */
  async function keepScheduled(annealId: string, note = '人工确认维持原排位。'): Promise<void> {
    await resolveAnnealSchedule([annealId], note)
    revision.value += 1
    lastMessage.value = '该排位已恢复为已排。'
  }

  /** 待排排位改好时段后一键确认重新入排 */
  async function confirmReschedule(annealId: string): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    const furnaceCode = existing.furnaceCode || kilnCodeOfSlot(existing.kilnSlot)
    const deviceConflict = deviceConflictOf({
      kilnSlot: existing.kilnSlot,
      inAt: existing.inAt,
      outAt: existing.outAt,
      curveSeg: existing.curveSeg,
      pieceId: existing.pieceId,
      furnaceCode,
    })
    if (deviceConflict.conflict) {
      lastMessage.value = deviceConflict.message
      return false
    }
    await repairAnnealScheduleState([annealId], '已按设备侧新时段重新排位。')
    revision.value += 1
    lastMessage.value = '排位已恢复为已排。'
    return true
  }

  return {
    anneals,
    pieces,
    deviceWindows,
    committedDeviceWindows,
    pendingAnneals,
    heldAnneals,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    kilnCodes,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    visibleAnneals,
    wallThicknessOf,
    conflictOf,
    deviceConflictOf,
    durationOf,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
    sendBackToPending,
    keepScheduled,
    confirmReschedule,
  }
})
