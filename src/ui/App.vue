<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { LocalGardenRepository } from '../adapters/local-garden.repository';
import { EMOTION_META, EMOTIONS, type Emotion } from '../core/models';
import { annualReport, createEntry, sampleSnapshot, syncPlants } from '../core/garden-engine';
import { analyzeImport, applyImport, backupFileName, buildBackup, previewMerge, type ImportAnalysis, type ImportMode, type ImportResult } from '../core/backup';

const repo = new LocalGardenRepository();
const state = reactive(repo.load());
const tab = ref<'花园' | '种植' | '时间轴' | '标本馆' | '年报'>('花园');
const selectedEmotion = ref<Emotion>('喜悦');
const notice = ref('');
const draft = reactive({ note: '', intensity: 3 });
const report = computed(() => annualReport(state.entries));
const living = computed(() => state.plants.filter((plant) => plant.status === '繁茂'));
const specimens = computed(() => state.plants.filter((plant) => plant.status === '枯萎'));
const timeline = computed(() => [...state.entries].sort((a, b) => b.date.localeCompare(a.date)));
function save() { state.plants = syncPlants(state.entries, state.plants); repo.save({ entries: state.entries, plants: state.plants }); }
function plant() { state.entries.unshift(createEntry(selectedEmotion.value, draft.note, draft.intensity)); draft.note = ''; save(); notice.value = `${EMOTION_META[selectedEmotion.value].plant} 已经种下`; tab.value = '花园'; }
function reset() { const fresh = sampleSnapshot(); state.entries = fresh.entries; state.plants = fresh.plants; save(); notice.value = '已恢复初始示例花园'; }

// ---------- 备份导出 / 导入 ----------
const fileInput = ref<HTMLInputElement | null>(null);
const importFatal = ref<string[]>([]);
const pendingAnalysis = ref<ImportAnalysis | null>(null);
const importMode = ref<ImportMode>('merge-keep');
const importResult = ref<ImportResult | null>(null);

const modeMeta: Record<ImportMode, { name: string; desc: string }> = {
  'merge-keep': { name: '合并 · 保留现有', desc: '文件中的新记录追加进来；同一天同一情绪已存在时，保留现有记录，跳过文件中的重复条。' },
  'merge-replace': { name: '合并 · 文件为准', desc: '文件中的新记录追加进来；同一天同一情绪已存在时，用文件中的记录替换现有记录，不会重复累计。' },
  overwrite: { name: '整体覆盖', desc: '清空当前设备上的全部记录，完全按备份文件重建花园。此操作不可撤销。' },
};
const preview = computed(() => pendingAnalysis.value ? previewMerge(pendingAnalysis.value, state.entries, importMode.value) : null);

function exportBackup() {
  save();
  const payload = buildBackup({ entries: state.entries, plants: state.plants });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = backupFileName();
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  URL.revokeObjectURL(url);
  notice.value = '已导出完整花园备份文件，请妥善保存';
}
function pickImportFile() { fileInput.value?.click(); }
async function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let text: string;
  try { text = await file.text(); } catch { importFatal.value = ['无法读取该文件，请确认文件未被移动或损坏']; return; }
  const analysis = analyzeImport(text, { existing: state.entries });
  if (analysis.fatal.length) { importFatal.value = analysis.fatal; return; }
  importMode.value = 'merge-keep';
  pendingAnalysis.value = analysis;
}
function closeFatal() { importFatal.value = []; }
function cancelImport() { pendingAnalysis.value = null; }
function confirmImport() {
  if (!pendingAnalysis.value) return;
  const result = applyImport(pendingAnalysis.value, state.entries, state.plants, importMode.value);
  state.entries = result.snapshot.entries;
  state.plants = result.snapshot.plants;
  repo.save(result.snapshot); // 植物阶段 / 连续天数已在 applyImport 中按合并后的记录统一重算，年报为派生数据随之刷新
  pendingAnalysis.value = null;
  importResult.value = result;
  notice.value = '花园已从备份恢复';
}
function closeResult() { importResult.value = null; }
function formatExportTime(iso?: string) {
  if (!iso) return '未知';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="garden-app">
    <header class="garden-topbar"><div class="garden-brand"><span class="garden-mark">✿</span><div><span class="eyebrow">THE INNER GARDEN / 02</span><h1>情绪植物园</h1></div></div><div class="garden-top-actions"><span class="weather">今日花园 · {{ living.length }} 株在生长</span><button class="quiet-button" type="button" @click="exportBackup">导出备份</button><button class="quiet-button" type="button" @click="pickImportFile">导入恢复</button><button class="quiet-button" type="button" @click="reset">重置演示</button></div></header>
    <main class="garden-wrap"><section class="garden-hero"><div><span class="eyebrow green-text">DAILY EMOTION CULTIVATION</span><h2>给情绪一块<br /><i>可以生长的土壤。</i></h2><p>你不需要每天都阳光明媚，只需要为此刻诚实地浇一次水。</p></div><div class="garden-stats"><div><strong>{{ report.active }}</strong><span>活跃日</span></div><div><strong>{{ report.lushness }}<small>%</small></strong><span>花园繁茂度</span></div><div><strong>{{ state.entries.length }}</strong><span>情绪标本</span></div></div></section>
      <nav class="garden-tabs"><button v-for="item in ['花园', '种植', '时间轴', '标本馆', '年报']" :key="item" type="button" :class="{ active: tab === item }" @click="tab = item as typeof tab">{{ item }}</button></nav>
      <section v-if="tab === '花园'" class="garden-board"><div class="board-heading"><div><span class="eyebrow">YOUR EMOTIONAL BIOME</span><h3>正在生长的情绪</h3></div><span class="season-label">秋季 · 第 40 周</span></div><div class="plant-grid"><article v-for="plant in living" :key="plant.id" class="plant-card" :style="{ '--plant-color': EMOTION_META[plant.emotion].color }"><div class="plant-card-top"><span class="plant-status">正在生长</span><span>{{ plant.streak }} 天连续</span></div><div class="plant-illustration"><span class="plant-glow"></span><strong>{{ EMOTION_META[plant.emotion].symbol }}</strong><i v-for="n in Math.min(plant.streak + 1, 5)" :key="n" :style="{ '--n': n }">●</i></div><div class="plant-info"><span class="plant-emotion">{{ plant.emotion }}</span><h4>{{ EMOTION_META[plant.emotion].plant }}</h4><p>{{ EMOTION_META[plant.emotion].hint }}</p><div class="growth-track"><span :style="{ width: `${Math.min(100, Math.max(12, plant.streak / 14 * 100))}%` }"></span></div><small>{{ plant.stage }} · 下一阶段还需 {{ Math.max(0, 3 - plant.streak) }} 天</small></div></article><button class="add-plant-card" type="button" @click="tab = '种植'"><span>＋</span><strong>种下一颗新情绪</strong><small>每天记录，植物就会长大</small></button></div></section>
      <section v-else-if="tab === '种植'" class="planting-layout"><article class="plant-form"><div class="board-heading"><div><span class="eyebrow">PLANT A FEELING</span><h3>今天的你，是什么天气？</h3></div></div><div class="emotion-picker"><button v-for="emotion in EMOTIONS" :key="emotion" type="button" :class="{ selected: selectedEmotion === emotion }" :style="{ '--emotion-color': EMOTION_META[emotion].color }" @click="selectedEmotion = emotion"><span>{{ EMOTION_META[emotion].symbol }}</span><b>{{ emotion }}</b><small>{{ EMOTION_META[emotion].plant }}</small></button></div><label>给这颗情绪留一句话<textarea v-model="draft.note" rows="5" placeholder="它今天为什么来到这里？"></textarea></label><label>情绪强度 <output>{{ draft.intensity }} / 5</output><input v-model.number="draft.intensity" type="range" min="1" max="5" /></label><button class="plant-button" type="button" @click="plant">种下这颗情绪 ✦</button><p class="notice">{{ notice }}</p></article><aside class="plant-preview" :style="{ '--preview-color': EMOTION_META[selectedEmotion].color }"><span class="eyebrow">PREVIEW / {{ selectedEmotion }}</span><div class="preview-plant">{{ EMOTION_META[selectedEmotion].symbol }}</div><h3>{{ EMOTION_META[selectedEmotion].plant }}</h3><p>今天种下，连续记录 3 天后发芽，7 天后开花，14 天后结果。</p></aside></section>
      <section v-else-if="tab === '时间轴'" class="timeline-section"><div class="board-heading"><div><span class="eyebrow">GROWTH TIMELINE</span><h3>每一天，都留下了一片叶子</h3></div></div><div class="timeline"><div v-for="(entry, index) in timeline" :key="entry.id" class="timeline-item"><div class="timeline-date"><strong>{{ new Date(`${entry.date}T00:00:00`).getDate() }}</strong><span>{{ new Date(`${entry.date}T00:00:00`).toLocaleDateString('zh-CN', { month: 'short' }) }}</span></div><div class="timeline-dot" :style="{ background: EMOTION_META[entry.emotion].color }"></div><div class="timeline-content"><div><span class="timeline-emotion" :style="{ color: EMOTION_META[entry.emotion].color }">{{ EMOTION_META[entry.emotion].symbol }} {{ entry.emotion }}</span><span class="intensity">强度 {{ entry.intensity }}/5</span></div><p>{{ entry.note }}</p><small>{{ EMOTION_META[entry.emotion].plant }} · 第 {{ index + 1 }} 片叶子</small></div></div></div></section>
      <section v-else-if="tab === '标本馆'" class="specimen-section"><div class="board-heading"><div><span class="eyebrow">SPECIMEN ARCHIVE</span><h3>枯萎不是消失，是被好好保存</h3></div></div><div v-if="specimens.length" class="specimen-grid"><div v-for="plant in specimens" :key="plant.id" class="specimen-card"><div class="pressed-flower">{{ EMOTION_META[plant.emotion].symbol }}</div><div><span>{{ plant.emotion }} · {{ EMOTION_META[plant.emotion].plant }}</span><strong>生长了 {{ plant.entryIds.length }} 天</strong><small>最后浇水：{{ plant.lastWatered }}</small></div></div></div><div v-else class="empty-state">你的标本馆还是空的。持续记录，等一朵花完成它的季节。</div></section>
      <section v-else class="report-section"><div class="report-heading"><span class="eyebrow">EMOTIONAL ECOLOGY REPORT · 2026</span><h3>你的情绪生态年报</h3><p>这一年，你和自己的内在天气相处得怎么样？</p></div><div class="report-grid"><div class="report-score"><span>花园繁茂度</span><strong>{{ report.lushness }}<small>/ 100</small></strong><div class="report-progress"><i :style="{ width: `${report.lushness}%` }"></i></div><p>每一次诚实的记录，都会让生态系统更完整。</p></div><div class="top-emotion"><span>最常出现的物种</span><div><strong :style="{ color: EMOTION_META[report.top.emotion].color }">{{ EMOTION_META[report.top.emotion].symbol }}</strong><h4>{{ report.top.emotion }}</h4></div><p>{{ report.top.count }} 次记录 · 是你今年最熟悉的一种天气</p></div><div class="count-chart"><span>情绪物种分布</span><div v-for="item in report.counts" :key="item.emotion" class="count-row"><b>{{ item.emotion }}</b><div><i :style="{ width: `${Math.max(5, item.count / Math.max(report.top.count, 1) * 100)}%`, background: EMOTION_META[item.emotion].color }"></i></div><small>{{ item.count }}</small></div></div></div></section>
    </main>
    <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFileChosen" />

    <div v-if="importFatal.length" class="backup-modal-mask" @click.self="closeFatal">
      <div class="backup-modal">
        <span class="eyebrow green-text">BACKUP RESTORE</span>
        <h3>无法从该文件恢复</h3>
        <p class="backup-modal-lead">文件校验未通过，<strong>现有记录没有任何改动</strong>：</p>
        <ul class="backup-fatal-list">
          <li v-for="(item, i) in importFatal" :key="i">{{ item }}</li>
        </ul>
        <div class="backup-modal-actions"><button class="plant-button backup-primary" type="button" @click="closeFatal">我知道了</button></div>
      </div>
    </div>

    <div v-if="pendingAnalysis && preview" class="backup-modal-mask" @click.self="cancelImport">
      <div class="backup-modal backup-modal-wide">
        <span class="eyebrow green-text">BACKUP PREVIEW · 导入前校验</span>
        <h3>这份备份可以恢复吗？</h3>
        <p class="backup-modal-lead">
          导出时间：{{ formatExportTime(pendingAnalysis.exportedAt) }}<template v-if="pendingAnalysis.legacy"> · 旧版本文件（兼容读取）</template>
        </p>
        <div class="backup-summary">
          <div><strong>{{ pendingAnalysis.validEntries.length }}</strong><span>可恢复记录</span></div>
          <div><strong>{{ pendingAnalysis.invalidEntries.length }}</strong><span>将被跳过</span></div>
          <div><strong>{{ pendingAnalysis.repairs.length }}</strong><span>自动修正</span></div>
          <div><strong>{{ preview.conflicts.length }}</strong><span>同日同情绪冲突</span></div>
        </div>
        <ul v-if="pendingAnalysis.warnings.length" class="backup-warn-list">
          <li v-for="(item, i) in pendingAnalysis.warnings" :key="i">{{ item }}</li>
        </ul>

        <div class="backup-mode-list">
          <label v-for="mode in (['merge-keep', 'merge-replace', 'overwrite'] as ImportMode[])" :key="mode" class="backup-mode-option" :class="{ selected: importMode === mode }">
            <input v-model="importMode" type="radio" name="import-mode" :value="mode" />
            <div><b>{{ modeMeta[mode].name }}</b><small>{{ modeMeta[mode].desc }}</small></div>
          </label>
        </div>

        <div class="backup-impact">
          <template v-if="importMode === 'overwrite'">
            将清空现有 {{ state.entries.length }} 条记录，重建为文件中的 {{ preview.toWrite.length }} 条。
          </template>
          <template v-else>
            新增 <strong>{{ preview.added }}</strong> 条 · 替换 <strong>{{ preview.replaced }}</strong> 条 ·
            跳过冲突 <strong>{{ preview.conflicts.filter((c) => c.kept === 'existing').length }}</strong> 条 ·
            合并后共 <strong>{{ preview.toWrite.length }}</strong> 条
          </template>
        </div>

        <ul v-if="preview.skips.length" class="backup-skip-list">
          <li v-for="(item, i) in preview.skips" :key="i">
            <span :class="`skip-tag skip-tag-${item.kind}`">{{ item.kind }}</span>
            <template v-if="item.date">{{ item.date }} · {{ item.emotion }} — </template>{{ item.reason }}
          </li>
        </ul>

        <div class="backup-modal-actions">
          <button class="quiet-button backup-cancel" type="button" @click="cancelImport">取消</button>
          <button class="plant-button backup-primary" type="button" @click="confirmImport">按此策略恢复</button>
        </div>
        <p class="backup-recompute-hint">恢复完成后将自动重算：连续天数、植物生长阶段与年度报告。</p>
      </div>
    </div>

    <div v-if="importResult" class="backup-modal-mask" @click.self="closeResult">
      <div class="backup-modal backup-modal-wide">
        <span class="eyebrow green-text">RESTORE COMPLETE</span>
        <h3>花园已恢复</h3>
        <div class="backup-summary">
          <div><strong>{{ importResult.imported }}</strong><span>成功恢复</span></div>
          <div><strong>{{ importResult.skipped }}</strong><span>跳过</span></div>
          <div><strong>{{ importResult.repairs.length }}</strong><span>自动修正</span></div>
          <div><strong>{{ importResult.snapshot.entries.length }}</strong><span>当前总记录</span></div>
        </div>
        <ul v-if="importResult.warnings.length" class="backup-warn-list">
          <li v-for="(item, i) in importResult.warnings" :key="i">{{ item }}</li>
        </ul>
        <ul v-if="importResult.skippedItems.length" class="backup-skip-list">
          <li v-for="(item, i) in importResult.skippedItems" :key="i">
            <span :class="`skip-tag skip-tag-${item.kind}`">{{ item.kind }}</span>
            <template v-if="item.date">{{ item.date }} · {{ item.emotion }} — </template>{{ item.reason }}
          </li>
        </ul>
        <p class="backup-recompute-hint">连续天数、植物阶段与年报已按恢复后的全部记录统一重算。</p>
        <div class="backup-modal-actions"><button class="plant-button backup-primary" type="button" @click="closeResult">完成</button></div>
      </div>
    </div>
  </div>
</template>
