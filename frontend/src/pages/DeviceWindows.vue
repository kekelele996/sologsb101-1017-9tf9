<script setup lang="ts">
/**
 * /devices 设备侧台账（窑炉设备员那本账）
 * 维护每台窑炉的检修窗口 / 停窑时段 / 可用时段；设备侧写入失败进设备侧重试队列（排产侧不受影响）；
 * 提供两边按窑炉和时段对账（对不上的排位挂起等人确认）与被退回待排排位的处理入口。
 * 复用组件：<StatBadge>、<FilterBar>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useDeviceStore } from '@/stores/deviceStore'
import { DEVICE_WINDOW_KIND_OPTIONS, type DeviceWindow, type DeviceWindowDraft, type DeviceWindowKind } from '@/types/deviceWindow'
import { isBlockingKind } from '@/types/deviceWindow'
import { today } from '@/utils/id'

const router = useRouter()
const store = useDeviceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
/** 演示用：保存时让设备侧写入失败一次（落到设备侧重试队列） */
const failOnce = ref(false)

const form = reactive<DeviceWindowDraft>({
  furnaceCode: '',
  kind: '检修',
  localDate: today(),
  startAt: `${today()}T09:00`,
  endAt: `${today()}T18:00`,
  allDay: true,
  note: '',
})

const pieceName = computed<Record<string, string>>(() =>
  Object.fromEntries(store.anneals.map((row) => {
    const piece = store.pieces.find((item) => item.id === row.pieceId)
    return [row.id, piece?.name ?? '（作品已删除）']
  })),
)

const blockingOptionLabels = computed(() => ({
  检修: '检修窗口',
  停窑: '停窑时段',
  可用: '可用时段',
}))

onMounted(() => {
  void store.loadAll()
})

function openCreate(): void {
  editingId.value = null
  failOnce.value = false
  Object.assign(form, {
    furnaceCode: store.furnaceCodes[0] ?? 'AN-01',
    kind: '检修' as DeviceWindowKind,
    localDate: today(),
    startAt: `${today()}T09:00`,
    endAt: `${today()}T18:00`,
    allDay: true,
    note: '',
  })
  dialogVisible.value = true
}

function openEdit(row: DeviceWindow): void {
  editingId.value = row.id
  failOnce.value = false
  Object.assign(form, {
    furnaceCode: row.furnaceCode,
    kind: row.kind,
    localDate: row.localDate,
    startAt: row.startAt || `${row.localDate}T09:00`,
    endAt: row.endAt || `${row.localDate}T18:00`,
    allDay: row.allDay,
    note: row.note,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (form.furnaceCode.trim() === '') {
    ElMessage.error('请填写窑号')
    return
  }
  if (!form.allDay && form.endAt <= form.startAt) {
    ElMessage.error('结束时刻必须晚于开始时刻')
    return
  }
  submitting.value = true
  try {
    const ok = await store.saveWindow({ ...form, furnaceCode: form.furnaceCode.trim() }, editingId.value, failOnce.value)
    if (ok) {
      ElMessage.success(store.lastMessage)
      dialogVisible.value = false
    } else {
      ElMessage.warning(store.lastMessage)
      dialogVisible.value = false
    }
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: DeviceWindow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将从设备侧台账删除「${row.furnaceCode}」的${row.kind}窗口（${row.allDay ? row.localDate : row.startAt.replace('T', ' ')}）。`,
      '确认删除设备窗口？',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const ok = await store.deleteWindow(row, false)
  if (ok) ElMessage.success(store.lastMessage)
  else ElMessage.warning(store.lastMessage)
}

async function handleRetryAll(): Promise<void> {
  const result = await store.retryOps()
  if (result.failed === 0) {
    ElMessage.success(`设备侧重试全部成功（${result.succeeded} 条）${result.retreated > 0 ? `，${result.retreated} 条撞期排位已退回待排` : ''}`)
  } else {
    ElMessage.warning(`仍有 ${result.failed} 条设备侧写入失败，请稍后再试`)
  }
}

async function handleRetryOne(opId: string): Promise<void> {
  const result = await store.retryOps([opId])
  if (result.failed === 0) ElMessage.success('设备侧重试成功')
  else ElMessage.warning('设备侧仍写入失败')
}

async function handleDiscard(opId: string): Promise<void> {
  await store.discardOp(opId)
  ElMessage.success(store.lastMessage)
}

async function handleReconcile(): Promise<void> {
  const items = await store.reconcile()
  if (items.length === 0) ElMessage.success('两边窑炉与时段一致，没有挂起排位')
  else ElMessage.warning(`已挂起 ${items.length} 条对不上的排位，等待人工确认`)
}

async function handleHoldReschedule(annealId: string): Promise<void> {
  await store.resolveHold(annealId, 'reschedule')
  ElMessage.success(store.lastMessage)
}

async function handleHoldKeep(annealId: string): Promise<void> {
  await store.resolveHold(annealId, 'keep')
  ElMessage.success(store.lastMessage)
}

function goReschedule(): void {
  void router.push('/annealing')
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'furnaceCode') store.setFilters({ furnaceCode: value })
  if (key === 'kind') store.setFilters({ kind: value as DeviceWindowKind | 'all' })
}

function kindTagType(kind: DeviceWindowKind): 'danger' | 'warning' | 'success' {
  return kind === '检修' ? 'danger' : kind === '停窑' ? 'warning' : 'success'
}

function windowRange(row: DeviceWindow): string {
  if (row.allDay) return `${row.localDate} 全天`
  return `${row.startAt.replace('T', ' ')} ~ ${row.endAt.replace('T', ' ')}`
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="设备窗口" :value="store.stats.total" suffix="个" tone="primary" icon="Histogram" />
      <StatBadge label="检修窗口" :value="store.stats.maintenance" suffix="个" tone="danger" icon="Warning" />
      <StatBadge label="停窑时段" :value="store.stats.shutdown" suffix="个" tone="warning" icon="Warning" />
      <StatBadge label="可用时段" :value="store.stats.available" suffix="个" tone="success" icon="DataLine" />
      <StatBadge label="退回待排" :value="store.stats.pendingSchedule" suffix="条" :tone="store.stats.pendingSchedule > 0 ? 'danger' : 'info'" icon="TrendCharts" />
      <StatBadge label="挂起待确认" :value="store.stats.held" suffix="条" :tone="store.stats.held > 0 ? 'danger' : 'success'" icon="PieChart" />
      <StatBadge
        label="设备侧写入失败"
        :value="store.failedCount"
        suffix="条"
        :tone="store.failedCount > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="设备侧写入失败只进设备侧重试队列，排产侧排位不受影响"
      />
    </div>

    <!-- 设备侧重试队列：写入失败的操作在此重试，与排产侧完全隔离 -->
    <el-alert
      v-if="store.outbox.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`设备侧有 ${store.outbox.length} 条写入失败的操作待重试（排产侧排位未受影响）`"
    >
      <template #default>
        <div class="outbox-list">
          <div v-for="op in store.outbox" :key="op.id" class="outbox-item">
            <div class="outbox-main">
              <el-tag size="small" :type="op.opKind === 'remove' ? 'warning' : 'danger'">
                {{ op.opKind === 'remove' ? '删除' : '写入' }}
              </el-tag>
              <b>{{ op.window?.furnaceCode ?? '—' }}</b>
              <span>{{ op.window ? `${op.window.kind} · ${op.window.allDay ? op.window.localDate + ' 全天' : op.window.startAt.replace('T', ' ')}` : `窗口 ${op.windowId}` }}</span>
              <span class="cell-sub">已重试 {{ op.attempts }} 次 · {{ op.lastError }}</span>
            </div>
            <div class="outbox-actions">
              <el-button size="small" type="primary" @click="handleRetryOne(op.id)">重试</el-button>
              <el-button size="small" @click="handleDiscard(op.id)">放弃</el-button>
            </div>
          </div>
          <el-button size="small" type="primary" plain class="mt-8" @click="handleRetryAll">全部重试</el-button>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">设备侧检修窗口与停窑时段</span>
          <el-space>
            <el-button @click="handleReconcile">
              <el-icon><Connection /></el-icon>
              <span>按窑炉和时段对账</span>
            </el-button>
            <el-button type="primary" @click="openCreate">
              <el-icon><Plus /></el-icon>
              <span>登记设备窗口</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <FilterBar
        :keyword="store.filters.keyword"
        :fields="[
          { key: 'furnaceCode', label: '窑炉', options: store.furnaceCodes },
          { key: 'kind', label: '类型', options: DEVICE_WINDOW_KIND_OPTIONS as unknown as string[], optionLabels: blockingOptionLabels },
        ]"
        :values="{ furnaceCode: store.filters.furnaceCode, kind: store.filters.kind }"
        :result-text="`命中 ${store.visibleWindows.length} / ${store.windows.length} 个窗口`"
        @update:keyword="(value: string) => store.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="store.resetFilters()"
      />

      <EmptyPanel
        v-if="store.ready && store.windows.length === 0"
        title="设备侧还没有窗口台账"
        description="由窑炉设备员登记每台窑炉的检修窗口、停窑时段与可用时段。排位前排产员会对照这份时段，落在检修/停窑窗口里的排位不许提交。"
        action-text="登记第一个设备窗口"
        @action="openCreate"
      />

      <el-table v-else v-loading="!store.ready" :data="store.visibleWindows" row-key="id" stripe>
        <el-table-column prop="furnaceCode" label="窑号" width="120" />
        <el-table-column label="类型" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="kindTagType(row.kind)" effect="dark">{{ row.kind }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时段" min-width="220">
          <template #default="{ row }">{{ windowRange(row) }}</template>
        </el-table-column>
        <el-table-column prop="note" label="说明" min-width="240">
          <template #default="{ row }">
            <span v-if="row.note === ''" class="cell-sub">—</span>
            <span v-else>{{ row.note }}</span>
          </template>
        </el-table-column>
        <el-table-column label="排位影响" width="160">
          <template #default="{ row }">
            <el-tag v-if="isBlockingKind(row.kind)" size="small" type="danger" plain>落入此时段禁排</el-tag>
            <el-tag v-else size="small" type="success" plain>可排产</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 对账结果：挂起等确认 + 已退回待排 -->
    <el-card shadow="never" class="mt-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">两边对账：退回待排 / 挂起待确认的排位</span>
          <el-button link type="primary" @click="goReschedule">前往退火编排重排 →</el-button>
        </div>
      </template>

      <el-table :data="[...store.heldAnneals, ...store.pendingAnneals]" row-key="id" stripe>
        <el-table-column label="作品 / 窑位" min-width="220">
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="cell-strong">{{ pieceName[row.id] }}</span>
              <span class="cell-sub">{{ row.kilnSlot }} · {{ row.curveSeg }} · {{ row.inAt.replace('T', ' ') }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="记账状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="row.scheduleState === '挂起' ? 'danger' : 'warning'" effect="dark">
              {{ row.scheduleState }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="原因" min-width="300">
          <template #default="{ row }">
            <span :class="{ 'cell-warn': row.scheduleState === '挂起' }">{{ row.scheduleNote || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="人工处理" width="260" fixed="right">
          <template #default="{ row }">
            <template v-if="row.scheduleState === '挂起'">
              <el-button link type="primary" size="small" @click="handleHoldReschedule(row.id)">退回改期重排</el-button>
              <el-button link type="success" size="small" @click="handleHoldKeep(row.id)">确认维持</el-button>
            </template>
            <el-button v-else link type="primary" size="small" @click="goReschedule">去重排</el-button>
          </template>
        </el-table-column>
      </el-table>

      <EmptyPanel
        v-if="store.heldAnneals.length === 0 && store.pendingAnneals.length === 0"
        title="没有待处理的排位"
        description="设备窗口变更后撞期的排位会自动退回待排；两边窑炉或时段对不上的排位可点上方「按窑炉和时段对账」挂起，在此人工确认。"
      />
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记设备窗口' : '编辑设备窗口'" width="600px">
      <el-form label-width="110px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="窑号" required>
              <el-select
                v-model="form.furnaceCode"
                filterable
                allow-create
                default-first-option
                style="width: 100%"
                placeholder="如 AN-01 / KILN-01"
              >
                <el-option v-for="code in store.furnaceCodes" :key="code" :value="code" :label="code" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="窗口类型">
              <el-select v-model="form.kind" style="width: 100%">
                <el-option
                  v-for="item in DEVICE_WINDOW_KIND_OPTIONS"
                  :key="item"
                  :value="item"
                  :label="blockingOptionLabels[item]"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="时间粒度">
          <el-radio-group v-model="form.allDay">
            <el-radio :value="true">全天</el-radio>
            <el-radio :value="false">精确时段</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-if="form.allDay" label="日期">
          <el-date-picker v-model="form.localDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <template v-else>
          <el-form-item label="开始时刻">
            <el-date-picker v-model="form.startAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" format="YYYY-MM-DD HH:mm" style="width: 100%" />
          </el-form-item>
          <el-form-item label="结束时刻">
            <el-date-picker v-model="form.endAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" format="YYYY-MM-DD HH:mm" style="width: 100%" />
          </el-form-item>
        </template>

        <el-form-item label="说明">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="检修内容 / 停窑原因 / 可用说明" />
        </el-form-item>

        <el-alert
          v-if="isBlockingKind(form.kind)"
          type="warning"
          show-icon
          :closable="false"
          title="检修 / 停窑窗口写入后，排产侧落在该时段的排位会禁止提交；已排又撞进来的排位会自动退回待排（设备这份窗口不再改动）。"
          class="mb-14"
        />
        <el-form-item>
          <el-checkbox v-model="failOnce">模拟设备侧写入失败一次（用于验证设备侧重试队列，排产侧不受影响）</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">写入设备台账</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-strong {
  font-weight: 600;
  color: #1d2b3a;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  color: #c0392b;
}

.outbox-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.outbox-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 6px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.25);
}

.outbox-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.mt-8 {
  margin-top: 8px;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
