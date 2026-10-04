<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DuplicateStrategy, ImportIssue, ImportPlan } from '../core/backup';
import { buildImportPlan, parseBackup } from '../core/backup';
import type { GardenSnapshot } from '../core/models';

const props = defineProps<{ current: GardenSnapshot }>();
const emit = defineEmits<{ close: []; confirm: [plan: ImportPlan] }>();

const fileInput = ref<HTMLInputElement | null>(null);
const fileName = ref('');
const reading = ref(false);
const fatal = ref<ImportIssue | null>(null);
const plan = ref<ImportPlan | null>(null);
const strategy = ref<DuplicateStrategy>('keep-existing');
/** 已通过校验的解析结果，切换去重策略时据此重新合并，不必重读文件 */
const parsedData = ref<{ data: GardenSnapshot; base: { version: number; exportedAt: string; issues: ImportIssue[] } } | null>(null);

const warnings = computed(() => plan.value?.issues.filter((issue) => issue.kind === 'warning') ?? []);
const finalCount = computed(() => plan.value?.snapshot.entries.length ?? 0);

watch(strategy, () => {
  if (!parsedData.value) return;
  plan.value = buildImportPlan(props.current, parsedData.value.data, parsedData.value.base, strategy.value);
});

function pickFile() {
  fileInput.value?.click();
}

function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  fileName.value = file.name;
  fatal.value = null;
  plan.value = null;
  reading.value = true;
  const reader = new FileReader();
  reader.onload = () => {
    reading.value = false;
    const result = parseBackup(String(reader.result ?? ''));
    if ('error' in result) {
      parsedData.value = null;
      fatal.value = result.error;
    } else {
      parsedData.value = { data: result.data, base: result.plan };
      plan.value = buildImportPlan(props.current, result.data, result.plan, strategy.value);
      fatal.value = null;
    }
  };
  reader.onerror = () => {
    reading.value = false;
    fatal.value = { kind: 'fatal', where: '文件', message: '读取文件失败，请重试。' };
  };
  reader.readAsText(file);
}

function confirmImport() {
  if (plan.value) emit('confirm', plan.value);
}
</script>

<template>
  <div class="backup-mask" @click.self="emit('close')">
    <div class="backup-dialog" role="dialog" aria-modal="true" aria-label="导入花园备份">
      <header class="backup-head">
        <div><span class="eyebrow">GARDEN BACKUP / RESTORE</span><h3>从备份文件恢复</h3></div>
        <button type="button" class="backup-close" @click="emit('close')">×</button>
      </header>

      <div class="backup-body">
        <!-- 第一步：选择文件 -->
        <div v-if="!plan && !fatal" class="backup-step">
          <p class="backup-hint">选择本应用导出的 <b>.json</b> 备份文件。系统会先完整校验，<b>确认前不会改动当前任何记录</b>。</p>
          <button type="button" class="backup-pick" :disabled="reading" @click="pickFile">
            <span>{{ reading ? '正在读取与校验…' : '选择备份文件' }}</span>
            <small v-if="fileName">已选择：{{ fileName }}</small>
          </button>
          <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFileChosen" />
          <ul class="backup-rules">
            <li>校验文件完整性（校验和）与应用、版本标识</li>
            <li>逐条核对日期、情绪、强度字段，坏记录跳过并列出原因</li>
            <li>同一天同一情绪按下方策略去重，不会重复累计</li>
          </ul>
        </div>

        <!-- 文件级错误：直接阻断 -->
        <div v-else-if="fatal" class="backup-step">
          <div class="backup-fatal">
            <strong>⚠ 无法导入：{{ fatal.where }}</strong>
            <p>{{ fatal.message }}</p>
          </div>
          <button type="button" class="backup-pick" @click="pickFile">重新选择文件</button>
          <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFileChosen" />
        </div>

        <!-- 第二步：预检报告 + 去重策略 -->
        <div v-else-if="plan" class="backup-step">
          <p class="backup-filemeta">
            文件：{{ fileName }} · v{{ plan.version }}<template v-if="plan.exportedAt"> · 导出于 {{ new Date(plan.exportedAt).toLocaleString('zh-CN') }}</template>
          </p>
          <div class="backup-summary">
            <div><strong>{{ plan.importedCount }}</strong><span>条新增恢复</span></div>
            <div><strong>{{ plan.duplicateCount }}</strong><span>条同日同情绪</span></div>
            <div><strong>{{ finalCount }}</strong><span>恢复后总记录</span></div>
          </div>

          <fieldset class="strategy-box" :disabled="plan.duplicateCount === 0">
            <legend>同一天、同一情绪已有记录时</legend>
            <label :class="{ chosen: strategy === 'keep-existing' }">
              <input v-model="strategy" type="radio" value="keep-existing" />
              <span><b>保留现有记录</b><small>跳过备份中的重复条（推荐，绝不丢失当前内容）</small></span>
            </label>
            <label :class="{ chosen: strategy === 'overwrite' }">
              <input v-model="strategy" type="radio" value="overwrite" />
              <span><b>以备份为准</b><small>用备份内容覆盖当天该情绪的备注与强度，仍只算一条</small></span>
            </label>
            <p v-if="plan.duplicateCount === 0" class="strategy-empty">本文件与现有记录没有同日同情绪的冲突。</p>
            <p v-else-if="strategy === 'overwrite'" class="strategy-note">将覆盖 {{ plan.updatedCount }} 条现有记录的备注与强度，连续天数不会重复累计。</p>
          </fieldset>

          <div v-if="warnings.length" class="backup-issues">
            <h4>以下内容被修正或跳过（{{ warnings.length }}）</h4>
            <ul>
              <li v-for="(issue, index) in warnings" :key="index">
                <b>{{ issue.where }}</b><span>{{ issue.message }}</span>
              </li>
            </ul>
          </div>

          <footer class="backup-actions">
            <button type="button" class="quiet-button" @click="emit('close')">取消</button>
            <button type="button" class="plant-button backup-confirm" @click="confirmImport">
              确认恢复并重算花园
            </button>
          </footer>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backup-mask {
  position: fixed;
  inset: 0;
  background: rgba(47, 61, 50, 0.45);
  display: grid;
  place-items: center;
  z-index: 50;
  padding: 20px;
}
.backup-dialog {
  width: min(620px, 100%);
  max-height: 86vh;
  overflow-y: auto;
  background: var(--paper, #f4f7ee);
  border: 1px solid #aabfae;
  box-shadow: 0 24px 60px rgba(47, 61, 50, 0.28);
}
.backup-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 22px 26px 16px;
  border-bottom: 1px solid #d1ded0;
}
.backup-head h3 {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 400;
}
.backup-close {
  border: 0;
  background: none;
  font-size: 24px;
  line-height: 1;
  color: #809083;
  cursor: pointer;
}
.backup-body { padding: 22px 26px 26px; }
.backup-hint {
  font-size: 12px;
  color: #6f8174;
  line-height: 1.8;
  margin: 0 0 18px;
}
.backup-pick {
  width: 100%;
  border: 1px dashed #7fa985;
  background: #edf4eb;
  color: #4f795b;
  padding: 22px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.backup-pick:disabled { opacity: 0.6; cursor: wait; }
.backup-pick small { font-size: 10px; color: #8a9a8d; word-break: break-all; }
.backup-rules {
  margin: 18px 0 0;
  padding-left: 18px;
  color: #849487;
  font-size: 11px;
  line-height: 2;
}
.backup-fatal {
  border: 1px solid #d9a08f;
  background: #f8ece7;
  padding: 18px;
  margin-bottom: 18px;
}
.backup-fatal strong { color: #b45f45; font-size: 13px; }
.backup-fatal p { margin: 8px 0 0; font-size: 12px; color: #8a6f66; line-height: 1.7; }
.backup-filemeta { font-size: 10px; color: #8a9a8d; margin: 0 0 16px; word-break: break-all; }
.backup-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 20px;
}
.backup-summary div {
  border: 1px solid #ceddce;
  background: #edf4eb;
  padding: 14px;
  text-align: center;
}
.backup-summary strong {
  display: block;
  font-family: Georgia, serif;
  font-size: 28px;
  font-weight: 400;
  color: #54765e;
}
.backup-summary span { font-size: 10px; color: #8a9a8d; }
.strategy-box {
  border: 1px solid #d1ded0;
  padding: 14px 16px 16px;
  margin: 0 0 18px;
}
.strategy-box:disabled { opacity: 0.65; }
.strategy-box legend { font-size: 11px; color: #6f8174; padding: 0 6px; }
.strategy-box label {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 9px 4px;
  cursor: pointer;
  border: 1px solid transparent;
}
.strategy-box label.chosen { background: #f6faf1; border-color: #c6dcc8; }
.strategy-box label span { display: flex; flex-direction: column; gap: 3px; }
.strategy-box label b { font-size: 12px; font-weight: 500; color: #4f6b56; }
.strategy-box label small { font-size: 10px; color: #8a9a8d; }
.strategy-note, .strategy-empty { font-size: 10px; color: #b45f45; margin: 8px 0 0; }
.strategy-empty { color: #8a9a8d; }
.backup-issues {
  border: 1px solid #d1ded0;
  background: #eef4e9;
  padding: 14px 16px;
  margin-bottom: 20px;
  max-height: 170px;
  overflow-y: auto;
}
.backup-issues h4 { font-size: 11px; font-weight: 500; color: #6f8174; margin: 0 0 10px; }
.backup-issues ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.backup-issues li { font-size: 11px; line-height: 1.6; }
.backup-issues li b { color: #6b846f; font-weight: 500; margin-right: 8px; }
.backup-issues li span { color: #849487; }
.backup-actions { display: flex; justify-content: flex-end; align-items: center; gap: 18px; }
.backup-confirm { width: auto; margin: 0; padding: 11px 22px; }
</style>
