/**
 * 设备台账状态管理（Pinia）—— 窑炉设备员记账
 * 维护每台窑炉的检修窗口、停窑时段与可用时段，与排产台账（annealStore）分开记账。
 * 改了检修 / 停窑窗口后，撞进窗口的排位退回待排（只动排产侧），设备这份窗口记录不动。
 * 设备侧写入失败后只在设备侧重试，排产那份不受影响。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { KilnWindow, KilnWindowDraft, WindowKind } from '../types/window'
import { BLOCKING_WINDOW_KINDS, WINDOW_KIND_OPTIONS } from '../types/window'
import {
  ROW_REVISION,
  bumpCollidingAnneals,
  db,
  initDatabase,
  putKilnWindowWithRetry,
  removeKilnWindow,
} from '../utils/db'
import { nowIso, uuid } from '../utils/id'

/** 设备窗口筛选条件 */
export interface WindowFilters {
  keyword: string
  furnaceId: string | 'all'
  kind: WindowKind | 'all'
}

const EMPTY_FILTERS: WindowFilters = { keyword: '', furnaceId: 'all', kind: 'all' }

let subscribed = false

export const useEquipmentStore = defineStore('equipment', () => {
  const windows = ref<KilnWindow[]>([])
  const furnaces = ref<Furnace[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  /** 最近一次设备侧写入的重试轨迹（演示「设备侧重试、排产侧不受影响」） */
  const lastRetryLog = ref<string[]>([])
  /** 故障注入开关：开启后下一次设备写入前两次强制失败、第三次成功 */
  const faultInjection = ref(false)
  const filters = reactive<WindowFilters>({ ...EMPTY_FILTERS })

  const furnaceCodeById = computed<Map<string, string>>(
    () => new Map(furnaces.value.map((row) => [row.id, row.code])),
  )

  const blockingWindows = computed<KilnWindow[]>(() =>
    windows.value.filter((row) => BLOCKING_WINDOW_KINDS.includes(row.kind))
  )

  const visibleWindows = computed<KilnWindow[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return windows.value.filter((row) => {
      if (filters.furnaceId !== 'all' && row.furnaceId !== filters.furnaceId) return false
      if (filters.kind !== 'all' && row.kind !== filters.kind) return false
      if (keyword === '') return true
      const code = furnaceCodeById.value.get(row.furnaceId) ?? ''
      return code.toLowerCase().includes(keyword) || row.note.toLowerCase().includes(keyword)
    })
  })

  function windowsOf(furnaceId: string): KilnWindow[] {
    return windows.value
      .filter((row) => row.furnaceId === furnaceId)
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
  }

  function codeOf(furnaceId: string): string {
    return furnaceCodeById.value.get(furnaceId) ?? '（窑炉已删除）'
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [windowRows, furnaceRows] = await Promise.all([db.kilnWindows.toArray(), db.furnaces.toArray()])
          return { windowRows, furnaceRows }
        }).subscribe({
          next: ({ windowRows, furnaceRows }) => {
            windows.value = [...windowRows].sort(
              (a, b) => a.startAt.localeCompare(b.startAt) || a.endAt.localeCompare(b.endAt),
            )
            furnaces.value = [...furnaceRows].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取设备台账失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<WindowFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  function toggleFaultInjection(value: boolean): void {
    faultInjection.value = value
  }

  /**
   * 保存设备窗口（设备侧重试通道）。
   * 写入成功后，若是检修 / 停窑窗口，再把撞进窗口的排位退回待排；
   * 排位退回与设备写入分离——设备写入失败只在设备侧重试，绝不改排产台账。
   */
  async function saveWindow(draft: KilnWindowDraft, editingId: string | null): Promise<{ saved: boolean; bumped: string[] }> {
    const stamp = nowIso()
    const row: KilnWindow = {
      id: editingId ?? uuid('window'),
      furnaceId: draft.furnaceId,
      kind: draft.kind,
      startAt: draft.startAt,
      endAt: draft.endAt,
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }

    const log: string[] = []
    // 故障注入：仅前两次强制失败，第三次放行，演示重试收敛
    const inject = faultInjection.value ? (attempt: number): boolean => attempt < 3 : undefined
    try {
      const { tries } = await putKilnWindowWithRetry(
        row,
        3,
        inject,
      )
      for (let attempt = 1; attempt <= tries; attempt += 1) {
        log.push(attempt < tries ? `第 ${attempt} 次设备侧写入失败，按设备侧重试……` : `第 ${attempt} 次设备侧写入成功`)
      }
      if (tries === 1) log.push('设备侧一次写入成功')
      lastRetryLog.value = log
      faultInjection.value = false
    } catch (err) {
      log.push('设备侧三次写入均失败：仅设备台账报错，排产台账未受影响。')
      lastRetryLog.value = log
      lastMessage.value = err instanceof Error ? err.message : '设备台账写入失败'
      return { saved: false, bumped: [] }
    }

    revision.value += 1

    // 设备窗口落定后，撞进检修/停窑窗口的已排位退回待排（只动排产侧）
    const bumped = await bumpCollidingAnneals(row)
    if (bumped.length > 0) {
      lastMessage.value = `设备「${codeOf(row.furnaceId)}」的${row.kind}窗口已保存，${bumped.length} 条排位撞窗退回待排，设备窗口记录不变。`
    } else {
      lastMessage.value = `设备「${codeOf(row.furnaceId)}」的${row.kind}窗口已保存，当前无排位撞入。`
    }
    return { saved: true, bumped }
  }

  async function deleteWindow(windowId: string): Promise<void> {
    await removeKilnWindow(windowId)
    revision.value += 1
    lastMessage.value = '设备时段窗口已删除（删除窗口不会自动改动排位，可在退火编排页重新对账）。'
    lastRetryLog.value = []
  }

  return {
    windows,
    furnaces,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    lastRetryLog,
    faultInjection,
    revision,
    WINDOW_KIND_OPTIONS,
    blockingWindows,
    visibleWindows,
    furnaceCodeById,
    windowsOf,
    codeOf,
    loadAll,
    setFilters,
    resetFilters,
    toggleFaultInjection,
    saveWindow,
    deleteWindow,
  }
})
