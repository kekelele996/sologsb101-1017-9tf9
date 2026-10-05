<script setup lang="ts">
/**
 * /equipment 设备台账：窑炉检修窗口 / 停窑时段 / 可用时段（设备员记账）
 * 与排产台账分开记账；保存检修/停窑窗口后撞窗排位退回待排（设备这份不动）。
 * 设备侧写入失败后只在设备侧重试，排产那份不受影响。
 * 消费模型：KilnWindow、Furnace；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useEquipmentStore } from '@/stores/equipmentStore'
import { useAnnealStore } from '@/stores/annealStore'
import {
  WINDOW_KIND_OPTIONS,
  type KilnWindow,
  type KilnWindowDraft,
  type WindowKind,
} from '@/types/window'
import { nowLocalInput } from '@/utils/id'

const store = useEquipmentStore()
const annealStore = useAnnealStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<KilnWindowDraft>({
  furnaceId: '',
  kind: '检修',
  startAt: nowLocalInput(),
  endAt: nowLocalInput(),
  note: '',
})

const rules: FormRules<KilnWindowDraft> = {
  furnaceId: [{ required: true, message: '请选择窑炉', trigger: 'change' }],
  kind: [{ required: true, message: '请选择窗口性质', trigger: 'change' }],
  startAt: [{ required: true, message: '请选择开始时间', trigger: 'change' }],
  endAt: [{ required: true, message: '请选择结束时间', trigger: 'change' }],
}

const stats = computed(() => ({
  total: store.windows.length,
  maint: store.windows.filter((row) => row.kind === '检修').length,
  down: store.windows.filter((row) => row.kind === '停窑').length,
  available: store.windows.filter((row) => row.kind === '可用').length,
  pending: annealStore.pendingCount,
  suspended: annealStore.suspendedCount,
}))

const formTimeInvalid = computed<boolean>(() => form.endAt <= form.startAt)

onMounted(() => {
  void store.loadAll()
  void annealStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    furnaceId: store.furnaces[0]?.id ?? '',
    kind: '检修' as WindowKind,
    startAt: nowLocalInput(),
    endAt: nowLocalInput(),
    note: '',
  })
  dialogVisible.value = true
}

function openEdit(row: KilnWindow): void {
  editingId.value = row.id
  Object.assign(form, {
    furnaceId: row.furnaceId,
    kind: row.kind,
    startAt: row.startAt,
    endAt: row.endAt,
    note: row.note,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (formTimeInvalid.value) {
    ElMessage.error('结束时间必须晚于开始时间')
    return
  }
  submitting.value = true
  try {
    const { saved, bumped } = await store.saveWindow({ ...form }, editingId.value)
    store.lastRetryLog.forEach((line) => {
      if (line.includes('成功')) ElMessage.success(line)
      else ElMessage.warning(line)
    })
    if (!saved) {
      ElMessage.error(store.lastMessage)
      return
    }
    ElMessage.success(store.lastMessage)
    if (bumped.length > 0) {
      ElMessage.warning(`已把 ${bumped.length} 条撞窗排位退回待排，可到退火编排页重排`)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: KilnWindow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除 ${store.codeOf(row.furnaceId)} 的「${row.kind}」窗口？删除窗口不会自动改动已排位。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await store.deleteWindow(row.id)
  ElMessage.success('设备时段窗口已删除')
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'kind') store.setFilters({ kind: value as WindowKind | 'all' })
  if (key === 'furnaceId') store.setFilters({ furnaceId: value })
}

function kindTagType(kind: WindowKind): 'danger' | 'warning' | 'success' {
  if (kind === '检修') return 'danger'
  if (kind === '停窑') return 'warning'
  return 'success'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="设备窗口" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="检修窗口" :value="stats.maint" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="停窑时段" :value="stats.down" suffix="条" tone="warning" icon="DataLine" />
      <StatBadge label="可用时段" :value="stats.available" suffix="条" tone="success" icon="TrendCharts" />
      <StatBadge label="排位待排" :value="stats.pending" suffix="条" :tone="stats.pending > 0 ? 'warning' : 'info'" icon="PieChart" />
      <StatBadge label="对账挂起" :value="stats.suspended" suffix="条" :tone="stats.suspended > 0 ? 'danger' : 'info'" icon="Warning" />
    </div>

    <el-alert
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      title="设备员只记设备这份账：检修窗口与停窑时段会阻断排位；保存后撞进窗口的已排位退回待排，设备窗口本身不改动。"
    />

    <el-alert
      v-for="(line, index) in store.lastRetryLog"
      :key="index"
      :type="line.includes('失败') ? 'warning' : 'success'"
      show-icon
      :closable="false"
      class="mb-14"
      :title="line"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">窑炉检修 / 停窑 / 可用时段</span>
          <el-space>
            <el-tooltip content="开启后下一次保存前两次写入强制失败、第三次成功，用于演示设备侧独立重试（排产台账不受影响）" placement="top">
              <el-switch
                :model-value="store.faultInjection"
                active-text="模拟设备写入故障"
                inline-prompt
                @update:model-value="store.toggleFaultInjection"
              />
            </el-tooltip>
            <el-button type="primary" :disabled="store.furnaces.length === 0" @click="openCreate">
              <el-icon><Plus /></el-icon>
              <span>登记时段窗口</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <FilterBar
        :keyword="store.filters.keyword"
        :fields="[
          {
            key: 'furnaceId',
            label: '窑炉',
            options: store.furnaces.map((row) => row.id),
            optionLabels: Object.fromEntries(store.furnaces.map((row) => [row.id, row.code])),
          },
          { key: 'kind', label: '性质', options: WINDOW_KIND_OPTIONS as unknown as string[] },
        ]"
        :values="{ furnaceId: store.filters.furnaceId, kind: store.filters.kind }"
        :result-text="`命中 ${store.visibleWindows.length} / ${store.windows.length} 条`"
        @update:keyword="(value: string) => store.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="store.resetFilters()"
      />

      <EmptyPanel
        v-if="store.ready && store.windows.length === 0"
        title="还没有设备时段窗口"
        description="设备员在此登记每台窑炉的检修窗口、停窑时段与可用时段；排位前会对着这份可用时段核对，落在检修/停窑窗口里不许排。"
        action-text="登记第一个窗口"
        @action="openCreate"
      />

      <el-table v-else v-loading="!store.ready" :data="store.visibleWindows" row-key="id" stripe>
        <el-table-column label="窑炉" min-width="150">
          <template #default="{ row }">
            <span class="cell-strong">{{ store.codeOf(row.furnaceId) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="性质" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="kindTagType(row.kind)" effect="dark">{{ row.kind }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="开始" width="160">
          <template #default="{ row }">{{ row.startAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="结束" width="160">
          <template #default="{ row }">{{ row.endAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="说明" min-width="240" prop="note" show-overflow-tooltip />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记时段窗口' : '编辑时段窗口'" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="窑炉" prop="furnaceId">
          <el-select v-model="form.furnaceId" filterable style="width: 100%">
            <el-option
              v-for="item in store.furnaces"
              :key="item.id"
              :value="item.id"
              :label="`${item.code} · ${item.type}`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="窗口性质" prop="kind">
          <el-radio-group v-model="form.kind">
            <el-radio-button v-for="item in WINDOW_KIND_OPTIONS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="开始时间" prop="startAt">
              <el-date-picker
                v-model="form.startAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="结束时间" prop="endAt">
              <el-date-picker
                v-model="form.endAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="说明">
          <el-input
            v-model="form.note"
            type="textarea"
            :rows="2"
            :placeholder="form.kind === '可用' ? '如：季度常规可用时段' : `如：${form.kind}原因与影响范围`"
          />
        </el-form-item>
        <el-alert
          :type="form.kind === '可用' ? 'success' : 'warning'"
          show-icon
          :closable="false"
          :title="
            form.kind === '可用'
              ? '可用窗口仅作声明，不阻断排位。'
              : `保存后，时间窗与该${form.kind}窗口重叠的已排位会退回待排（设备这份窗口记录保持不变）。`
          "
        />
        <el-alert
          v-if="formTimeInvalid"
          type="error"
          show-icon
          :closable="false"
          class="mt-14"
          title="结束时间必须晚于开始时间"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="formTimeInvalid" @click="handleSubmit">
          保存
        </el-button>
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

.cell-strong {
  font-weight: 600;
  color: #1d2b3a;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
