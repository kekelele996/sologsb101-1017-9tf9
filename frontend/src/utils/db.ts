/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 含数据结构版本号与升级迁移逻辑；v1 → v2 为 Piece 增加 craft 索引并回填默认值
 * - 提供各表增删改查、作品状态联动、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal, ScheduleState } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import type { DeviceWindow, DeviceWriteOp } from '../types/deviceWindow'
import { nowIso } from './id'
import { seedDatabase } from './seed'
import { DAY_MS, annealSpan, deviceWindowSpan, kilnCodeOfSlot } from './reconcile'
import { windowsOverlap } from './thermal'

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
  /** 设备侧台账：检修窗口 / 停窑时段 / 可用时段 */
  deviceWindows!: Table<DeviceWindow, string>
  /** 设备侧重试队列：写入失败的设备侧写操作，与排产侧互不影响 */
  deviceOutbox!: Table<DeviceWriteOp, string>

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
    this.version(2)
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

    // ---------- v3：设备侧台账（检修/停窑/可用）与排产侧排位状态分账 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        // scheduleState / furnaceCode 为 v3 新增索引
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg, scheduleState, furnaceCode',
        inspects: 'id, pieceId, date, result, inspector',
        deviceWindows: 'id, furnaceCode, kind, allDay, localDate, writeState',
        deviceOutbox: 'id, windowId, opKind, state, createdAt',
      })
      .upgrade(async (tx) => {
        // 迁移 1：退火排位补齐排产侧字段。
        // 旧排位没记窑炉归属：按它用的窑炉（窑位号前缀）补窑号；排位状态默认「已排」维持原样。
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.furnaceCode !== 'string' || row.furnaceCode === '') {
            const slot = typeof row.kilnSlot === 'string' ? row.kilnSlot : ''
            row.furnaceCode = kilnCodeOfSlot(slot)
          }
          if (row.scheduleState !== '待排' && row.scheduleState !== '已排' && row.scheduleState !== '挂起') {
            row.scheduleState = '已排'
          }
          if (typeof row.scheduleNote !== 'string') row.scheduleNote = ''
        })

        // 迁移 2：按旧排位用的窑炉，在设备侧补「全天可用」窗口（覆盖排位占用的每一天）。
        // 补不上窑炉归属的老排位维持原样，不造窗口。
        const annealRows = await tx.table('anneals').toArray()
        const windowRows = await tx.table('deviceWindows').toArray()
        const furnaceRows = await tx.table('furnaces').toArray()
        const knownCodes = new Set(
          furnaceRows
            .map((row: Record<string, unknown>) => (typeof row.code === 'string' ? row.code : ''))
            .filter((code: string) => code !== ''),
        )
        const existingKeys = new Set(
          windowRows.map(
            (row: Record<string, unknown>) =>
              `${String(row.furnaceCode)}|${String(row.kind)}|${String(row.localDate)}`,
          ),
        )
        const stamp = nowIso()
        let seq = 0
        for (const row of annealRows as Array<Record<string, unknown>>) {
          const code = typeof row.furnaceCode === 'string' ? row.furnaceCode : ''
          if (code === '' || !knownCodes.has(code)) continue // 补不上的老排位维持原样
          const inAt = typeof row.inAt === 'string' ? row.inAt : ''
          const startMs = inAt === '' ? Number.NaN : new Date(inAt).getTime()
          if (Number.isNaN(startMs)) continue
          const outAt = typeof row.outAt === 'string' ? row.outAt : ''
          const endMs = outAt === '' ? Number.NaN : new Date(outAt).getTime()
          const end = !Number.isNaN(endMs) && endMs > startMs ? endMs : startMs + DAY_MS
          // 枚举排位占用到的每一天，各补一条全天可用窗口（同一天同窑只补一条）
          for (let dayStart = startOfLocalDay(startMs); dayStart < end; dayStart += DAY_MS) {
            const dateStr = toLocalDate(dayStart)
            const key = `${code}|可用|${dateStr}`
            if (existingKeys.has(key)) continue
            existingKeys.add(key)
            seq += 1
            const id = `devicewin-legacy-${seq}`
            await tx.table('deviceWindows').add({
              id,
              furnaceCode: code,
              kind: '可用',
              localDate: dateStr,
              startAt: '',
              endAt: '',
              allDay: true,
              note: '升级迁移：按历史排位补登的全天可用窗口',
              writeState: 'written',
              lastError: '',
              attempts: 0,
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            })
          }
        }
      })
  }
}

/** 毫秒时间戳 → 当地零点 */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 毫秒时间戳 → YYYY-MM-DD（当地时区） */
function toLocalDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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

/** 删除窑炉：级联清理该窑下的料液批次 */
export async function removeFurnace(id: string): Promise<void> {
  await db.transaction('rw', db.furnaces, db.batches, async () => {
    await db.batches.where('furnaceId').equals(id).delete()
    await db.furnaces.delete(id)
  })
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

/** 排位侧记账：更新某条排位的记账状态（待排/已排/挂起）与原因，不动退火工艺字段 */
export async function setAnnealSchedule(
  annealIds: string[],
  scheduleState: ScheduleState,
  scheduleNote: string,
): Promise<void> {
  if (annealIds.length === 0) return
  await db.transaction('rw', db.anneals, async () => {
    for (const id of annealIds) {
      await db.anneals.update(id, { scheduleState, scheduleNote, updatedAt: nowIso() })
    }
  })
}

/**
 * 设备侧检修/停窑窗口变更后：把「已排」又撞进该窗口的排位退回待排。
 * 返回被退回的排位 id。设备侧窗口本身不在此修改（设备那份不动）。
 */
export async function retreatAnnealsForWindow(windowId: string): Promise<string[]> {
  const win = await db.deviceWindows.get(windowId)
  if (!win || win.writeState !== 'written' || (win.kind !== '检修' && win.kind !== '停窑')) return []

  const [anneals, pieces] = await Promise.all([
    db.anneals.where('scheduleState').equals('已排').toArray(),
    db.pieces.toArray(),
  ])
  const thicknessOf = (pieceId: string): number =>
    pieces.find((p) => p.id === pieceId)?.wallThicknessMm ?? 4

  const winSpan = deviceWindowSpan(win)
  if (winSpan === null) return []

  const retreated: string[] = []
  await db.transaction('rw', db.anneals, async () => {
    for (const row of anneals) {
      if (row.furnaceCode !== win.furnaceCode) continue
      if (row.state === '已出炉') continue
      const span = annealSpan(row, thicknessOf(row.pieceId))
      if (span === null || !windowsOverlap(span, winSpan)) continue
      retreated.push(row.id)
      const where = win.allDay ? `${win.localDate} 全天` : win.startAt.replace('T', ' ')
      await db.anneals.update(row.id, {
        scheduleState: '待排',
        scheduleNote: `设备侧${win.kind}窗口（${where}）变更，排位撞入检修/停窑时段，已退回待排，请按新时段重排。`,
        updatedAt: nowIso(),
      })
    }
  })
  return retreated
}

/** 人工确认后退回待排（改期重排） */
export async function resetAnnealSchedule(annealIds: string[], note: string): Promise<void> {
  await setAnnealSchedule(annealIds, '待排', note)
}

/** 人工确认后恢复为已排（维持原排位，记录知悉原因） */
export async function resolveAnnealSchedule(annealIds: string[], note: string): Promise<void> {
  await setAnnealSchedule(annealIds, '已排', note)
}

/** 排产员改好时段后把待排排位重新置为已排 */
export async function repairAnnealScheduleState(annealIds: string[], note: string): Promise<void> {
  await setAnnealSchedule(annealIds, '已排', note || '已按设备侧新时段重新排位。')
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

/* ------------------------ 设备侧台账与重试队列 ------------------------ */

export async function listDeviceWindows(): Promise<DeviceWindow[]> {
  const rows = await db.deviceWindows.toArray()
  return rows.sort(
    (a, b) => a.furnaceCode.localeCompare(b.furnaceCode) || (a.allDay ? a.localDate : a.startAt).localeCompare(b.allDay ? b.localDate : b.startAt),
  )
}

export async function listDeviceOutbox(): Promise<DeviceWriteOp[]> {
  const rows = await db.deviceOutbox.toArray()
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** 设备侧写入是否真的落到设备台账（真实项目此处对接设备系统；演示用 failOnce 模拟一次失败） */
async function deviceWriteShouldFail(op: DeviceWriteOp): Promise<boolean> {
  if (op.failOnce) return true
  return false
}

/** 设备侧写入失败原因（演示文案） */
const DEVICE_WRITE_ERROR = '设备侧台账写入失败（模拟）：设备系统暂不可用，已进入设备侧重试队列，排产侧不受影响。'

/**
 * 入队一条设备侧写操作并立即尝试一次。
 * - 成功（put）：写入 deviceWindows 并出队，返回 committed 窗口；
 * - 成功（remove）：从 deviceWindows 删除并出队；
 * - 失败：操作留在 deviceOutbox（state=failed），deviceWindows 不产生任何变化。
 */
export async function enqueueDeviceOp(op: Omit<DeviceWriteOp, 'id' | 'state' | 'attempts' | 'lastError' | 'createdAt' | 'updatedAt'>): Promise<{
  ok: boolean
  windowId: string
  error: string
}> {
  const stamp = nowIso()
  const full: DeviceWriteOp = {
    ...op,
    id: `devop-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    state: 'pending',
    attempts: 0,
    lastError: '',
    createdAt: stamp,
    updatedAt: stamp,
  }
  await db.deviceOutbox.put(full)
  return processDeviceOp(full.id)
}

/** 按设备侧重试队列处理一次写操作（只动设备侧两张表，排产侧完全不受影响） */
export async function processDeviceOp(opId: string): Promise<{ ok: boolean; windowId: string; error: string }> {
  const op = await db.deviceOutbox.get(opId)
  if (!op) return { ok: false, windowId: '', error: '重试操作不存在' }

  const fail = await deviceWriteShouldFail(op)
  if (fail) {
    const attempts = op.attempts + 1
    // failOnce 只生效一次：失败后清零，下次重试即成功
    await db.deviceOutbox.put({
      ...op,
      state: 'failed',
      attempts,
      lastError: DEVICE_WRITE_ERROR,
      failOnce: false,
      updatedAt: nowIso(),
    })
    return { ok: false, windowId: op.windowId, error: DEVICE_WRITE_ERROR }
  }

  await db.transaction('rw', db.deviceWindows, db.deviceOutbox, async () => {
    if (op.opKind === 'put' && op.window) {
      const committed: DeviceWindow = {
        ...op.window,
        writeState: 'written',
        lastError: '',
        updatedAt: nowIso(),
        revision: ROW_REVISION,
      }
      await db.deviceWindows.put(committed)
    } else if (op.opKind === 'remove') {
      await db.deviceWindows.delete(op.windowId)
    }
    await db.deviceOutbox.delete(op.id)
  })
  return { ok: true, windowId: op.windowId, error: '' }
}

/** 重试队列里全部失败/待处理操作，返回成功数与仍失败数 */
export async function retryAllDeviceOps(): Promise<{ succeeded: number; failed: number }> {
  const ops = await db.deviceOutbox.toArray()
  let succeeded = 0
  let failed = 0
  for (const op of ops) {
    const result = await processDeviceOp(op.id)
    if (result.ok) succeeded += 1
    else failed += 1
  }
  return { succeeded, failed }
}

/** 直接放弃一条重试操作（从设备侧队列移除；设备台账不产生变化） */
export async function discardDeviceOp(opId: string): Promise<void> {
  await db.deviceOutbox.delete(opId)
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
  deviceWindows: DeviceWindow[]
  deviceOutbox: DeviceWriteOp[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, inspects, deviceWindows, deviceOutbox] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.anneals.toArray(),
    db.inspects.toArray(),
    db.deviceWindows.toArray(),
    db.deviceOutbox.toArray(),
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
    deviceWindows,
    deviceOutbox,
  }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.deviceWindows, db.deviceOutbox],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
        db.deviceWindows.clear(),
        db.deviceOutbox.clear(),
      ])
      await db.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.anneals.bulkPut(snapshot.anneals.map(normalizeImportedAnneal))
      await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.deviceWindows.bulkPut(
        (snapshot.deviceWindows ?? []).map((row) => ({ ...row, revision: ROW_REVISION })),
      )
      await db.deviceOutbox.bulkPut(snapshot.deviceOutbox ?? [])
    },
  )
}

/** 导入旧版本存档时补齐 v3 排位字段 */
function normalizeImportedAnneal(row: Anneal): Anneal {
  return {
    ...row,
    furnaceCode:
      typeof row.furnaceCode === 'string' && row.furnaceCode !== ''
        ? row.furnaceCode
        : kilnCodeOfSlot(row.kilnSlot),
    scheduleState:
      row.scheduleState === '待排' || row.scheduleState === '已排' || row.scheduleState === '挂起'
        ? row.scheduleState
        : '已排',
    scheduleNote: typeof row.scheduleNote === 'string' ? row.scheduleNote : '',
    revision: ROW_REVISION,
  }
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.anneals, db.inspects, db.deviceWindows, db.deviceOutbox],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
        db.deviceWindows.clear(),
        db.deviceOutbox.clear(),
      ])
    },
  )
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, inspects, deviceWindows, deviceOutbox] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.anneals.count(),
    db.inspects.count(),
    db.deviceWindows.count(),
    db.deviceOutbox.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, inspects, deviceWindows, deviceOutbox }
}
