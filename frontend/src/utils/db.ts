/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 含数据结构版本号与升级迁移逻辑：v1 → v2 为 Piece 增加 craft 索引并回填默认值；
 *   v2 → v3 设备台账独立成表（检修/停窑/可用窗口），排位增加排位状态，并为老排位按所用窑炉补全天可用窗口
 * - 提供各表增删改查、作品状态联动、设备窗口撞窗退回、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import type { KilnWindow } from '../types/window'
import { ALL_DAY_END, ALL_DAY_START, BLOCKING_WINDOW_KINDS } from '../types/window'
import { nowIso } from './id'
import { annealWindow, parseAt, windowsOverlap } from './thermal'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class GlassBlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>
  inspects!: Table<Inspect, string>
  /** 设备台账：检修窗口 / 停窑时段 / 可用时段 */
  kilnWindows!: Table<KilnWindow, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt',
      batches: 'id, furnaceId, colorCode, meltDate',
      pieces: 'id, batchId, state, artist',
      steps: 'id, pieceId, [pieceId+seq], seq',
      anneals: 'id, pieceId, kilnSlot, state, inAt',
      inspects: 'id, pieceId, date, result',
    })

    // ---------- v2：Piece 增加 craft 索引并回填默认值，补齐其余索引与字段 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        // craft 为 v2 新增索引
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('furnaces'),
          tx.table('batches'),
          tx.table('pieces'),
          tx.table('steps'),
          tx.table('anneals'),
          tx.table('inspects'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：Piece 补齐 craft 字段（历史作品默认按吹制归类）
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.craft !== 'string' || row.craft === '') row.craft = '吹制'
          if (typeof row.state !== 'string' || row.state === '') row.state = '设计中'
        })
        // 迁移 3：历史工序默认视为已执行完成，避免升级后被误判为待办
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string' || row.state === '') row.state = '已完成'
          if (typeof row.remark !== 'string') row.remark = ''
        })
        // 迁移 4：退火记录补齐出炉时间与曲线段
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
        })
        // 迁移 5：检验记录补齐缺陷说明
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
        })
      })

    // ---------- v3：设备台账独立成表（检修/停窑/可用窗口），排位增加排位状态 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        // schedStatus 为 v3 新增索引
        anneals: 'id, pieceId, kilnSlot, state, schedStatus, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
        // 设备台账：按窑炉 + 窗口性质 + 起止时段记账
        kilnWindows: 'id, furnaceId, kind, startAt, endAt',
      })
      .upgrade(async (tx) => {
        // 迁移 1：新表补齐行结构修订号
        await tx.table('kilnWindows').toCollection().modify((row: Record<string, unknown>) => {
          row.revision = ROW_REVISION
          if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
          if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
        })
        // 迁移 2：历史排位补齐排位状态（默认视为已排位，备注留空）
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (row.schedStatus !== '已排位' && row.schedStatus !== '待排' && row.schedStatus !== '挂起') {
            row.schedStatus = '已排位'
          }
          if (typeof row.schedNote !== 'string') row.schedNote = ''
        })

        // 迁移 3：旧排位没记窑炉归属——按它用的窑炉（窑位前缀 = 窑号）补一条
        // 「当天全天可用」窗口；补不上（找不到对应窑炉）的老排位维持原样，不做改写。
        const furnaces = await tx.table<Furnace, string>('furnaces').toArray()
        const anneals = await tx.table<Anneal, string>('anneals').toArray()
        /** 窑号 → 窑炉 id */
        const codeToFurnaceId = new Map<string, string>()
        furnaces.forEach((furnace) => {
          if (furnace.code !== '') codeToFurnaceId.set(furnace.code, furnace.id)
        })

        /** 已补过的「窑炉 + 日期」，同一窑同一天只补一条全天可用窗口 */
        const backfilled = new Set<string>()
        const stamp = nowIso()
        const windows: KilnWindow[] = []
        for (const anneal of anneals) {
          // 窑位形如 AN-01-A1：去掉最后一段槽位号得到窑号
          const kilnCode = anneal.kilnSlot.split('-').slice(0, -1).join('-')
          const furnaceId = kilnCode === '' ? undefined : codeToFurnaceId.get(kilnCode)
          if (furnaceId === undefined) continue // 补不上的老排位维持原样
          const day = (anneal.inAt ?? '').slice(0, 10) // YYYY-MM-DD
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
          const key = `${furnaceId}@${day}`
          if (backfilled.has(key)) continue
          backfilled.add(key)
          windows.push({
            id: `window-legacy-${furnaceId}-${day}`,
            furnaceId,
            kind: '可用',
            startAt: `${day}${ALL_DAY_START}`,
            endAt: `${day}${ALL_DAY_END}`,
            note: '升级迁移：为旧排位按所用窑炉补录的全天可用窗口。',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          })
        }
        if (windows.length > 0) {
          await tx.table<KilnWindow, string>('kilnWindows').bulkPut(windows)
        }
      })
  }
}

export const db = new GlassBlowDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.furnaces.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 窑炉 -------------------------------- */

export async function listFurnaces(): Promise<Furnace[]> {
  const rows = await db.furnaces.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putFurnace(row: Furnace): Promise<void> {
  await db.furnaces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除窑炉：级联清理该窑下的料液批次与设备时段窗口 */
export async function removeFurnace(id: string): Promise<void> {
  await db.transaction('rw', db.furnaces, db.batches, db.kilnWindows, async () => {
    await db.batches.where('furnaceId').equals(id).delete()
    await db.kilnWindows.where('furnaceId').equals(id).delete()
    await db.furnaces.delete(id)
  })
}

/* ------------------------ 设备台账：窑炉时段窗口 ------------------------ */

export async function listKilnWindows(): Promise<KilnWindow[]> {
  const rows = await db.kilnWindows.toArray()
  return rows.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.endAt.localeCompare(b.endAt))
}

export async function putKilnWindow(row: KilnWindow): Promise<void> {
  await db.kilnWindows.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeKilnWindow(id: string): Promise<void> {
  await db.kilnWindows.delete(id)
}

/**
 * 设备侧写入：独立的重试通道。
 * 设备台账写入失败后只在设备侧（kilnWindows 表）重试，不触碰排产台账（anneals 表）。
 * @param attempts 最大尝试次数（含首次）
 * @param shouldFail 可选的故障注入：返回 true 时本次写入按失败处理（用于演示重试）
 * @returns 实际尝试次数；全部失败时抛出最后一次错误
 */
export async function putKilnWindowWithRetry(
  row: KilnWindow,
  attempts = 3,
  shouldFail?: (attempt: number) => boolean,
): Promise<{ tries: number }> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (shouldFail?.(attempt)) {
      lastError = new Error(`设备台账写入失败（第 ${attempt} 次，模拟设备侧故障）`)
      continue
    }
    try {
      await putKilnWindow(row)
      return { tries: attempt }
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('设备台账写入失败')
}

/**
 * 设备员改了检修 / 停窑窗口后：把已经排上、又撞进该窗口的排位退回「待排」，按新时段重排。
 * 只改写排产台账（anneals.schedStatus / schedNote），设备那份窗口记录不动。
 * 仅处理「已排位」记录：待排/挂起记录保持现状，等待各自的处理流程。
 * 时间窗与排位判重一致：未出炉时按「入窑 + 该曲线段理论时长」估算临时出炉时刻。
 * @returns 被退回待排的排位 id 列表
 */
export async function bumpCollidingAnneals(
  window: Pick<KilnWindow, 'furnaceId' | 'kind' | 'startAt' | 'endAt' | 'id'>,
): Promise<string[]> {
  if (!BLOCKING_WINDOW_KINDS.includes(window.kind)) return []

  const furnace = await db.furnaces.get(window.furnaceId)
  if (!furnace) return []
  const slotPrefix = `${furnace.code}-`
  const blockingWindow: [number, number] = [parseAt(window.startAt), parseAt(window.endAt)]

  const [anneals, pieces] = await Promise.all([db.anneals.toArray(), db.pieces.toArray()])
  const thicknessOf = (pieceId: string): number =>
    pieces.find((piece) => piece.id === pieceId)?.wallThicknessMm ?? 4

  const bumped: string[] = []
  const stamp = nowIso()

  for (const anneal of anneals) {
    if (anneal.schedStatus !== '已排位') continue
    if (!anneal.kilnSlot.startsWith(slotPrefix)) continue
    const placementWindow = annealWindow(anneal, thicknessOf(anneal.pieceId))
    if (!windowsOverlap(placementWindow, blockingWindow)) continue
    bumped.push(anneal.id)
    await db.anneals.update(anneal.id, {
      schedStatus: '待排',
      schedNote: `设备侧「${window.kind}」窗口（${window.startAt.replace('T', ' ')} 起）与本排位时间窗重叠，已退回待排，请按新时段重排。`,
      updatedAt: stamp,
    })
  }
  return bumped
}

/* ------------------------------ 料液批次 ------------------------------ */

export async function listBatches(): Promise<GlassBatch[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.meltDate.localeCompare(a.meltDate))
}

export async function putBatch(row: GlassBatch): Promise<void> {
  await db.batches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeBatch(id: string): Promise<void> {
  await db.batches.delete(id)
}

/** 取料：按剩余量扣减（不足时扣到 0 并返回实际扣减量） */
export async function consumeBatch(batchId: string, kg: number): Promise<number> {
  const batch = await db.batches.get(batchId)
  if (!batch) return 0
  const actual = Math.max(0, Math.min(batch.remainKg, kg))
  await db.batches.update(batchId, { remainKg: Math.round((batch.remainKg - actual) * 10) / 10, updatedAt: nowIso() })
  return actual
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await db.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function putPiece(row: Piece): Promise<void> {
  await db.pieces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除作品：级联清理工序、退火与检验记录 */
export async function removePiece(id: string): Promise<void> {
  await db.transaction('rw', db.pieces, db.steps, db.anneals, db.inspects, async () => {
    await db.steps.where('pieceId').equals(id).delete()
    await db.anneals.where('pieceId').equals(id).delete()
    await db.inspects.where('pieceId').equals(id).delete()
    await db.pieces.delete(id)
  })
}

/**
 * 依工序与退火、检验记录推导并回写作品状态。
 * 规则：有检验记录 → 已检验；有已出炉退火 → 已退火；有工序记录 → 制作中；否则设计中。
 */
export async function syncPieceState(pieceId: string): Promise<PieceState | null> {
  const piece = await db.pieces.get(pieceId)
  if (!piece) return null
  const [steps, anneals, inspects] = await Promise.all([
    db.steps.where('pieceId').equals(pieceId).toArray(),
    db.anneals.where('pieceId').equals(pieceId).toArray(),
    db.inspects.where('pieceId').equals(pieceId).toArray(),
  ])

  let next: PieceState = '设计中'
  if (steps.length > 0) next = '制作中'
  if (anneals.some((row) => row.state === '已出炉')) next = '已退火'
  if (inspects.length > 0) next = '已检验'

  if (next !== piece.state) {
    await db.pieces.update(pieceId, { state: next, updatedAt: nowIso() })
  }
  return next
}

/* -------------------------------- 工序 -------------------------------- */

export async function listSteps(): Promise<Step[]> {
  const rows = await db.steps.toArray()
  return rows.sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

export async function listStepsByPiece(pieceId: string): Promise<Step[]> {
  const rows = await db.steps.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putStep(row: Step): Promise<void> {
  await db.steps.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeStep(id: string): Promise<void> {
  const step = await db.steps.get(id)
  if (!step) return
  await db.steps.delete(id)
  await syncPieceState(step.pieceId)
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用） */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.steps, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
    }
  })
}

/* -------------------------------- 退火 -------------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await db.anneals.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return db.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function putAnneal(row: Anneal): Promise<void> {
  await db.anneals.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeAnneal(id: string): Promise<void> {
  const row = await db.anneals.get(id)
  if (!row) return
  await db.anneals.delete(id)
  await syncPieceState(row.pieceId)
}

/** 推进退火状态；「已出炉」时写回出炉时间并同步作品状态 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<void> {
  const row = await db.anneals.get(annealId)
  if (!row) return
  await db.anneals.update(annealId, { state: next, outAt: next === '已出炉' ? outAt : row.outAt, updatedAt: nowIso() })
  await syncPieceState(row.pieceId)
}

/**
 * 只更新排产台账侧的排位状态 / 备注（待排重排、挂起确认），
 * 不改写物理退火状态与入出炉时刻。
 */
export async function setSchedStatus(
  annealId: string,
  schedStatus: Anneal['schedStatus'],
  schedNote: string,
): Promise<void> {
  await db.anneals.update(annealId, { schedStatus, schedNote, updatedAt: nowIso() })
}

/* ------------------------------ 出炉检验 ------------------------------ */

export async function listInspects(): Promise<Inspect[]> {
  const rows = await db.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await db.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putInspect(row: Inspect): Promise<void> {
  await db.inspects.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeInspect(id: string): Promise<void> {
  const row = await db.inspects.get(id)
  if (!row) return
  await db.inspects.delete(id)
  await syncPieceState(row.pieceId)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  furnaces: Furnace[]
  batches: GlassBatch[]
  pieces: Piece[]
  steps: Step[]
  anneals: Anneal[]
  inspects: Inspect[]
  /** v3 起：设备台账窗口（旧版存档缺省为空数组） */
  kilnWindows: KilnWindow[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, inspects, kilnWindows] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.anneals.toArray(),
    db.inspects.toArray(),
    db.kilnWindows.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    furnaces,
    batches,
    pieces,
    steps,
    anneals,
    inspects,
    kilnWindows,
  }
}

/** 兼容旧版（v2 及以前）存档：补齐排位状态与设备窗口表 */
function normalizeImported(snapshot: DatabaseSnapshot): {
  anneals: Anneal[]
  kilnWindows: KilnWindow[]
} {
  const anneals = snapshot.anneals.map((row) => ({
    ...row,
    schedStatus: row.schedStatus ?? '已排位',
    schedNote: typeof row.schedNote === 'string' ? row.schedNote : '',
  }))
  return { anneals, kilnWindows: Array.isArray(snapshot.kilnWindows) ? snapshot.kilnWindows : [] }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const { anneals, kilnWindows } = normalizeImported(snapshot)
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.kilnWindows],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
        db.kilnWindows.clear(),
      ])
      await db.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.anneals.bulkPut(anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.kilnWindows.bulkPut(kilnWindows.map((row) => ({ ...row, revision: ROW_REVISION })))
    },
  )
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.kilnWindows],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
        db.kilnWindows.clear(),
      ])
    },
  )
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, inspects, kilnWindows] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.anneals.count(),
    db.inspects.count(),
    db.kilnWindows.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, inspects, kilnWindows }
}
