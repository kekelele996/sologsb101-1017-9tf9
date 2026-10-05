/**
 * 设备侧状态管理（Pinia）—— 窑炉设备员那本账
 * 维护每台窑炉的检修窗口 / 停窑时段 / 可用时段，以及设备侧写入失败的重试队列。
 * 与排产侧（annealStore）分开记账：
 * - 排位前只读取设备窗口做校验；
 * - 设备窗口变更后，把已排又撞进去的排位退回待排（设备那份窗口不动）；
 * - 设备侧写入失败只进设备侧重试队列，排产侧数据完全不受影响。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { DeviceWindow, DeviceWindowDraft, DeviceWriteOp } from '../types/deviceWindow'
import { isBlockingKind } from '../types/deviceWindow'
import type { Anneal } from '../types/anneal'
import type { Piece } from '../types/piece'
import {
  db,
  discardDeviceOp,
  enqueueDeviceOp,
  initDatabase,
  listDeviceWindows,
  listDeviceOutbox,
  processDeviceOp,
  repairAnnealScheduleState,
  resetAnnealSchedule,
  resolveAnnealSchedule,
  retreatAnnealsForWindow,
  ROW_REVISION,
} from '../utils/db'
import { buildReconciliation, findAnnealsToRetreat, type ReconcileItem } from '../utils/reconcile'
import { nowIso, uuid } from '../utils/id'

/** 设备窗口筛选条件 */
export interface DeviceFilters {
  keyword: string
  furnaceCode: string | 'all'
  kind: DeviceWindow['kind'] | 'all'
  onlyBlocking: boolean
}

const EMPTY_FILTERS: DeviceFilters = { keyword: '', furnaceCode: 'all', kind: 'all', onlyBlocking: false }

let subscribed = false

export const useDeviceStore = defineStore('device', () => {
  const windows = ref<DeviceWindow[]>([])
  const outbox = ref<DeviceWriteOp[]>([])
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const furnaceCodes = ref<string[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<DeviceFilters>({ ...EMPTY_FILTERS })

  const wallThicknessOf = (pieceId: string): number =>
    pieces.value.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4

  /** 已成功写入设备台账的窗口（参与校验） */
  const committedWindows = computed<DeviceWindow[]>(() => windows.value.filter((row) => row.writeState === 'written'))

  const blockingWindows = computed<DeviceWindow[]>(() =>
    committedWindows.value.filter((row) => isBlockingKind(row.kind)),
  )

  const failedCount = computed<number>(() => outbox.value.length)

  /** 已排又撞期被退回待排的排位 */
  const pendingAnneals = computed<Anneal[]>(() => anneals.value.filter((row) => row.scheduleState === '待排'))
  /** 两边对账对不上、挂起等人工确认的排位 */
  const heldAnneals = computed<Anneal[]>(() => anneals.value.filter((row) => row.scheduleState === '挂起'))

  const stats = computed(() => ({
    total: windows.value.length,
    maintenance: windows.value.filter((row) => row.kind === '检修').length,
    shutdown: windows.value.filter((row) => row.kind === '停窑').length,
    available: windows.value.filter((row) => row.kind === '可用').length,
    pendingSchedule: anneals.value.filter((row) => row.scheduleState === '待排').length,
    held: anneals.value.filter((row) => row.scheduleState === '挂起').length,
  }))

  const visibleWindows = computed<DeviceWindow[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return committedWindows.value.filter((row) => {
      if (filters.furnaceCode !== 'all' && row.furnaceCode !== filters.furnaceCode) return false
      if (filters.kind !== 'all' && row.kind !== filters.kind) return false
      if (filters.onlyBlocking && !isBlockingKind(row.kind)) return false
      if (keyword === '') return true
      return (
        row.furnaceCode.toLowerCase().includes(keyword) ||
        row.note.toLowerCase().includes(keyword) ||
        row.localDate.includes(keyword) ||
        row.startAt.includes(keyword)
      )
    })
  })

  function windowsOf(furnaceCode: string): DeviceWindow[] {
    return committedWindows.value.filter((row) => row.furnaceCode === furnaceCode)
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [windowRows, outboxRows, annealRows, pieceRows, furnaceRows] = await Promise.all([
            db.deviceWindows.toArray(),
            db.deviceOutbox.toArray(),
            db.anneals.toArray(),
            db.pieces.toArray(),
            db.furnaces.toArray(),
          ])
          return { windowRows, outboxRows, annealRows, pieceRows, furnaceRows }
        }).subscribe({
          next: ({ windowRows, outboxRows, annealRows, pieceRows, furnaceRows }) => {
            windows.value = [...windowRows].sort(
              (a, b) =>
                a.furnaceCode.localeCompare(b.furnaceCode) ||
                (a.allDay ? a.localDate : a.startAt).localeCompare(b.allDay ? b.localDate : b.startAt),
            )
            outbox.value = [...outboxRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            furnaceCodes.value = [...new Set(furnaceRows.map((row) => row.code))].sort()
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取设备侧台账失败'
            loading.value = false
          },
        })
      }
      // 非响应式兜底读取（首屏 store 订阅建立前）
      windows.value = await listDeviceWindows()
      outbox.value = await listDeviceOutbox()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化设备侧台账失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<DeviceFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  function toWindow(draft: DeviceWindowDraft, id: string, stamp: string): DeviceWindow {
    return {
      id,
      furnaceCode: draft.furnaceCode.trim(),
      kind: draft.kind,
      localDate: draft.localDate,
      startAt: draft.allDay ? '' : draft.startAt,
      endAt: draft.allDay ? '' : draft.endAt,
      allDay: draft.allDay,
      note: draft.note.trim(),
      writeState: 'failed',
      lastError: '',
      attempts: 0,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
  }

  /**
   * 设备员保存一个检修/停窑/可用窗口。
   * 走设备侧写入通道：模拟失败则只进设备侧重试队列，设备台账与排产侧都不变；
   * 成功写入后，若是检修/停窑窗口，把已排又撞进去的排位退回待排。
   */
  async function saveWindow(draft: DeviceWindowDraft, editingId: string | null, failOnce: boolean): Promise<boolean> {
    const stamp = nowIso()
    const id = editingId ?? uuid('devicewin')
    const window = toWindow(draft, id, stamp)
    const result = await enqueueDeviceOp({
      opKind: 'put',
      window,
      windowId: id,
      failOnce,
    })
    revision.value += 1
    if (!result.ok) {
      lastMessage.value = '设备侧写入失败，已进入设备侧重试队列；排产侧排位不受影响。'
      return false
    }
    // 写入成功后才处理撞期退回（设备那份窗口已落账，之后不再变动）
    if (isBlockingKind(window.kind)) {
      const retreated = await retreatAnnealsForWindow(id)
      lastMessage.value =
        retreated.length > 0
          ? `设备侧「${window.kind}」窗口已写入；${retreated.length} 条撞期排位已退回待排，请按新时段重排。`
          : `设备侧「${window.kind}」窗口已写入，当前没有排位撞入该时段。`
    } else {
      lastMessage.value = '设备侧可用窗口已写入。'
    }
    return true
  }

  /** 删除设备窗口：同样走设备侧写入通道（删除也可能失败并进重试队列） */
  async function deleteWindow(row: DeviceWindow, failOnce: boolean): Promise<boolean> {
    const result = await enqueueDeviceOp({
      opKind: 'remove',
      window: null,
      windowId: row.id,
      failOnce,
    })
    revision.value += 1
    if (!result.ok) {
      lastMessage.value = '设备侧删除失败，已进入设备侧重试队列；排产侧排位不受影响。'
      return false
    }
    lastMessage.value = `设备侧「${row.kind}」窗口（${row.allDay ? row.localDate : row.startAt}）已删除。`
    return true
  }

  /**
   * 设备侧重试：逐条重试失败操作。
   * 重试过闸的若是检修/停窑窗口，同样把撞期排位退回待排。
   * ids 为空时重试队列里全部操作。
   */
  async function retryOps(ids?: string[]): Promise<{ succeeded: number; failed: number; retreated: number }> {
    const targets = ids && ids.length > 0 ? ids : outbox.value.map((row) => row.id)
    let succeeded = 0
    let failed = 0
    let retreated = 0
    for (const id of targets) {
      const result = await processDeviceOp(id)
      if (result.ok) {
        succeeded += 1
        const win = windows.value.find((row) => row.id === result.windowId)
        if (win && isBlockingKind(win.kind)) retreated += (await retreatAnnealsForWindow(result.windowId)).length
      } else {
        failed += 1
      }
    }
    revision.value += 1
    lastMessage.value = `设备侧重试完成：成功 ${succeeded} 条，仍失败 ${failed} 条。`
    return { succeeded, failed, retreated }
  }

  async function discardOp(opId: string): Promise<void> {
    await discardDeviceOp(opId)
    revision.value += 1
    lastMessage.value = '已从设备侧重试队列移除该操作（设备台账未变更）。'
  }

  /**
   * 两边按窑炉和时段对账：把对不上的已排排位挂起等人确认。
   * 返回被新挂起的对账项。
   */
  async function reconcile(): Promise<ReconcileItem[]> {
    const items = buildReconciliation(anneals.value, committedWindows.value, furnaceCodes.value, wallThicknessOf)
    const toHold = items.filter((item) => item.needsHold)
    if (toHold.length > 0) {
      await db.transaction('rw', db.anneals, async () => {
        for (const item of toHold) {
          await db.anneals.update(item.anneal.id, {
            scheduleState: '挂起',
            scheduleNote: item.reason,
            updatedAt: nowIso(),
          })
        }
      })
    }
    revision.value += 1
    lastMessage.value =
      toHold.length > 0 ? `对账完成：${toHold.length} 条排位对不上，已挂起等待人工确认。` : '对账完成：两边窑炉与时段一致，没有需要挂起的排位。'
    return toHold
  }

  /** 只做只读对账（不落库），供页面展示待确认项 */
  function previewReconcile(): ReconcileItem[] {
    return buildReconciliation(anneals.value, committedWindows.value, furnaceCodes.value, wallThicknessOf)
  }

  /** 设备窗口变更后只读预览将被退回的排位（不落库） */
  function previewRetreat(): Array<{ anneal: Anneal; window: DeviceWindow }> {
    return findAnnealsToRetreat(anneals.value, committedWindows.value, wallThicknessOf).map((item) => ({
      anneal: item.anneal,
      window: item.hit.window,
    }))
  }

  /** 人工确认挂起排位：改期重排（→ 待排）或维持原排位（→ 已排，备注保留） */
  async function resolveHold(annealId: string, action: 'reschedule' | 'keep', note = ''): Promise<void> {
    const row = anneals.value.find((item) => item.id === annealId)
    if (row === undefined) return
    if (action === 'reschedule') {
      await resetAnnealSchedule([annealId], note || '人工确认后退回待排，按新时段重排。')
      lastMessage.value = '该排位已改为待排，可在退火编排页重新排位。'
    } else {
      await resolveAnnealSchedule([annealId], note || '人工确认维持原排位，设备侧时段差异已知悉。')
      lastMessage.value = '该排位已恢复为已排。'
    }
    revision.value += 1
  }

  /** 一键重排：把待排排位重新置为已排（由排产员在退火编排页改好时段后调用） */
  async function markScheduled(annealIds: string[], note = ''): Promise<void> {
    await repairAnnealScheduleState(annealIds, note)
    revision.value += 1
  }

  return {
    windows,
    outbox,
    anneals,
    pieces,
    furnaceCodes,
    pendingAnneals,
    heldAnneals,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    stats,
    failedCount,
    committedWindows,
    blockingWindows,
    visibleWindows,
    windowsOf,
    loadAll,
    setFilters,
    resetFilters,
    saveWindow,
    deleteWindow,
    retryOps,
    discardOp,
    reconcile,
    previewReconcile,
    previewRetreat,
    resolveHold,
    markScheduled,
  }
})
