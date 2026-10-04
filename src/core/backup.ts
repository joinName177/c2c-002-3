import type { Emotion, EmotionEntry, GardenSnapshot, Plant } from './models';
import { EMOTION_META, EMOTIONS } from './models';
import { createEntryId, syncPlants } from './garden-engine';

export const BACKUP_APP = 'c2c-002-emotion-garden';
export const BACKUP_VERSION = 1;

/** 导出文件：全部情绪记录 + 植物状态 */
export interface BackupFile {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  entries: EmotionEntry[];
  plants: Plant[];
}

export type ImportMode = 'merge-keep' | 'merge-replace' | 'overwrite';

export interface RepairNote { entryId: string; field: string; detail: string; }
export interface InvalidEntry { index: number; reason: string; raw: unknown; }
export interface InvalidPlant { index: number; reason: string; raw: unknown; }
export interface ConflictItem { date: string; emotion: Emotion; kept: 'existing' | 'imported'; }
export interface SkippedItem { kind: '冲突' | '损坏'; date?: string; emotion?: string; reason: string; }

export interface AnalyzeOptions { existing: EmotionEntry[]; }

export interface ImportAnalysis {
  /** 致命问题：文件结构不对 / 版本无法识别 / 完全没有可用记录，此时绝不允许写入 */
  fatal: string[];
  warnings: string[];
  legacy: boolean;
  exportedAt?: string;
  sourceVersion?: number;
  validEntries: EmotionEntry[];
  validPlants: Plant[];
  repairs: RepairNote[];
  invalidEntries: InvalidEntry[];
  invalidPlants: InvalidPlant[];
  fileHasPlants: boolean;
}

export interface ModePreview {
  mode: ImportMode;
  toWrite: EmotionEntry[];
  added: number;
  replaced: number;
  removedLocal: number;
  conflicts: ConflictItem[];
  skips: SkippedItem[];
}

export interface ImportResult {
  snapshot: GardenSnapshot;
  imported: number;
  skipped: number;
  skippedItems: SkippedItem[];
  conflicts: ConflictItem[];
  repairs: RepairNote[];
  warnings: string[];
  mode: ImportMode;
}

// ---------- 导出 ----------

export function buildBackup(snapshot: GardenSnapshot, now = new Date()): BackupFile {
  // 导出前先按记录重算一次植物，保证导出的连续天数/阶段与记录一致
  const plants = syncPlants(snapshot.entries, snapshot.plants);
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    entries: snapshot.entries,
    plants,
  };
}

export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `emotion-garden-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

// ---------- 校验工具 ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(value + 'T00:00:00');
  return date.getFullYear() === y && date.getMonth() + 1 === m && date.getDate() === d;
}
const isEmotion = (value: unknown): value is Emotion => typeof value === 'string' && (EMOTIONS as string[]).includes(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function normalizeEntry(raw: unknown, index: number, usedIds: Set<string>):
  { entry?: EmotionEntry; invalid?: InvalidEntry; repairs: RepairNote[] } {
  const repairs: RepairNote[] = [];
  if (!isObject(raw)) return { invalid: { index, reason: '不是有效的记录对象', raw }, repairs };
  if (!isValidDate(raw.date)) return { invalid: { index, reason: '缺少或无法识别的日期字段（应为 YYYY-MM-DD）', raw }, repairs };
  if (!isEmotion(raw.emotion)) return { invalid: { index, reason: `情绪类型不被识别（${String(raw.emotion)}）`, raw }, repairs };

  let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : createEntryId();
  if (typeof raw.id !== 'string' || !raw.id.trim()) repairs.push({ entryId: id, field: 'id', detail: '缺少有效 id，已重新生成' });
  if (usedIds.has(id)) { id = createEntryId(); repairs.push({ entryId: id, field: 'id', detail: 'id 与其他记录重复，已重新生成' }); }
  usedIds.add(id);

  let note: string;
  if (typeof raw.note !== 'string') { note = EMOTION_META[raw.emotion].hint; repairs.push({ entryId: id, field: 'note', detail: '备注不是文本，已用默认寄语补齐' }); }
  else { note = raw.note.trim() || EMOTION_META[raw.emotion].hint; if (!raw.note.trim()) repairs.push({ entryId: id, field: 'note', detail: '备注为空，已用默认寄语补齐' }); }

  let intensity = Number(raw.intensity);
  if (raw.intensity === undefined || raw.intensity === null || Number.isNaN(intensity)) { intensity = 3; repairs.push({ entryId: id, field: 'intensity', detail: '强度缺失或不是数字，已按 3 补齐' }); }
  else if (intensity < 1) { intensity = 1; repairs.push({ entryId: id, field: 'intensity', detail: '强度低于 1，已修正为 1' }); }
  else if (intensity > 5) { intensity = 5; repairs.push({ entryId: id, field: 'intensity', detail: '强度高于 5，已修正为 5' }); }

  return { entry: { id, date: raw.date, emotion: raw.emotion, note, intensity }, repairs };
}

function normalizePlant(raw: unknown, index: number):
  { plant?: Plant; invalid?: InvalidPlant } {
  if (!isObject(raw)) return { invalid: { index, reason: '不是有效的植物对象', raw } };
  if (!isEmotion(raw.emotion)) return { invalid: { index, reason: `植物对应的情绪类型不被识别（${String(raw.emotion)}）`, raw } };
  // 植物状态导入后会按记录统一重算，历史字段仅作参考，结构残缺的直接忽略
  const plant: Plant = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `plant-${raw.emotion}`,
    emotion: raw.emotion,
    plantedAt: isValidDate(raw.plantedAt) ? raw.plantedAt : '',
    lastWatered: isValidDate(raw.lastWatered) ? raw.lastWatered : '',
    streak: typeof raw.streak === 'number' && raw.streak >= 0 ? raw.streak : 0,
    stage: '种子',
    status: '枯萎',
    entryIds: Array.isArray(raw.entryIds) ? raw.entryIds.filter((v): v is string => typeof v === 'string') : [],
  };
  return { plant };
}

// ---------- 解析 & 校验文件 ----------

/**
 * 解析并校验导出文件。
 * 结构损坏 / 来源不符 / 版本过新 / 一条可用记录都没有 → fatal，调用方不得覆盖现有数据。
 * 旧版本（无版本号的早期裸快照）走兼容读取并标记 legacy，能救回多少算多少。
 */
export function analyzeImport(text: string, options: AnalyzeOptions): ImportAnalysis {
  const result: ImportAnalysis = {
    fatal: [], warnings: [], legacy: false,
    validEntries: [], validPlants: [], repairs: [], invalidEntries: [], invalidPlants: [],
    fileHasPlants: false,
  };

  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) {
    result.fatal.push(`文件不是合法的 JSON（${(e as Error).message}），无法读取任何内容`);
    return result;
  }
  if (!isObject(parsed)) { result.fatal.push('文件内容结构不正确：根节点应为备份对象'); return result; }

  const app = parsed.app;
  const hasVersion = typeof parsed.version === 'number';
  if (app !== undefined && app !== BACKUP_APP) { result.fatal.push(`这不是情绪植物园的备份文件（来源标识：${String(app)}）`); return result; }

  const version = hasVersion ? (parsed.version as number) : 0;
  result.sourceVersion = version;
  if (version > BACKUP_VERSION) { result.fatal.push(`备份来自更新的版本（v${version}），当前程序只支持到 v${BACKUP_VERSION}，请先升级再恢复`); return result; }

  if (version === 0) {
    result.legacy = true;
    result.warnings.push('这是旧版本（无版本号）导出的数据，将按兼容方式尽量恢复，恢复后连续天数与植物阶段会统一重算');
  }
  if (typeof parsed.exportedAt === 'string') result.exportedAt = parsed.exportedAt;

  const rawEntries = (parsed as Record<string, unknown>).entries;
  const rawPlants = (parsed as Record<string, unknown>).plants;
  if (!Array.isArray(rawEntries)) { result.fatal.push('文件缺少 entries 记录列表或其格式已损坏'); return result; }
  result.fileHasPlants = Array.isArray(rawPlants);
  if (version >= 1 && !Array.isArray(rawPlants)) result.warnings.push('文件缺少 plants 植物状态，植物将在恢复后按记录重新生成');

  const usedIds = new Set(options.existing.map((e) => e.id));
  const seenKeys = new Set<string>();
  rawEntries.forEach((raw, index) => {
    const { entry, invalid, repairs } = normalizeEntry(raw, index, usedIds);
    result.repairs.push(...repairs);
    if (!entry) { if (invalid) result.invalidEntries.push(invalid); return; }
    const key = `${entry.date}__${entry.emotion}`;
    if (seenKeys.has(key)) { result.invalidEntries.push({ index, reason: `文件内部存在 ${entry.date} 的重复「${entry.emotion}」记录，已跳过多余的一条`, raw }); return; }
    seenKeys.add(key);
    result.validEntries.push(entry);
  });

  if (Array.isArray(rawPlants)) rawPlants.forEach((raw, index) => {
    const { plant, invalid } = normalizePlant(raw, index);
    if (plant) result.validPlants.push(plant);
    if (invalid) result.invalidPlants.push(invalid);
  });
  else if (rawPlants !== undefined) result.warnings.push('plants 字段格式不正确，已忽略，植物状态将按记录重新生成');

  if (!result.validEntries.length) { result.fatal.push('文件中没有任何一条完整可用的情绪记录，已放弃恢复（现有记录未改动）'); return result; }
  if (result.invalidEntries.length) result.warnings.push(`有 ${result.invalidEntries.length} 条记录字段对不上，已跳过，详见清单`);
  if (result.invalidPlants.length) result.warnings.push(`有 ${result.invalidPlants.length} 株植物状态无法识别，已忽略并将按记录重算`);
  if (result.repairs.length) result.warnings.push(`有 ${result.repairs.length} 个字段被自动修正后恢复`);
  return result;
}

// ---------- 按策略合并（预览与实际写入共用同一套纯函数，保证所见即所得） ----------

function entryKey(e: EmotionEntry) { return `${e.date}__${e.emotion}`; }

export function previewMerge(analysis: ImportAnalysis, existing: EmotionEntry[], mode: ImportMode): ModePreview {
  const incoming = analysis.validEntries;
  const conflicts: ConflictItem[] = [];
  const skips: SkippedItem[] = [...analysis.invalidEntries.map((item) => ({ kind: '损坏' as const, reason: item.reason }))];
  const existingMap = new Map(existing.map((e) => [entryKey(e), e]));
  const chosen: EmotionEntry[] = [];
  const usedIds = new Set<string>();
  let added = 0;
  let replaced = 0;

  if (mode === 'overwrite') {
    incoming.forEach((entry) => {
      let next = entry;
      if (usedIds.has(next.id)) { next = { ...next, id: createEntryId() }; }
      usedIds.add(next.id);
      chosen.push(next);
    });
    return { mode, toWrite: chosen, added: incoming.length, replaced: 0, removedLocal: existing.length, conflicts, skips };
  }

  const keepExisting = mode === 'merge-keep';
  existing.forEach((entry) => {
    let next = entry;
    if (usedIds.has(next.id)) { next = { ...next, id: createEntryId() }; }
    usedIds.add(next.id);
    chosen.push(next);
  });

  incoming.forEach((entry) => {
    const key = entryKey(entry);
    const hit = existingMap.get(key);
    if (hit) {
      conflicts.push({ date: entry.date, emotion: entry.emotion, kept: keepExisting ? 'existing' : 'imported' });
      skips.push({ kind: '冲突', date: entry.date, emotion: entry.emotion, reason: keepExisting ? '同日同情绪已存在，按策略保留现有记录，跳过导入' : '同日同情绪已存在，按策略以导入记录覆盖' });
      if (keepExisting) return;
      let next = entry;
      if (usedIds.has(next.id)) { next = { ...next, id: createEntryId() }; }
      usedIds.add(next.id);
      const idx = chosen.findIndex((e) => entryKey(e) === key);
      chosen.splice(idx, 1, next);
      replaced += 1;
      return;
    }
    let next = entry;
    if (usedIds.has(next.id)) { next = { ...next, id: createEntryId() }; }
    usedIds.add(next.id);
    chosen.push(next);
    added += 1;
  });

  chosen.sort((a, b) => b.date.localeCompare(a.date));
  return { mode, toWrite: chosen, added, replaced, removedLocal: 0, conflicts, skips };
}

/** 执行恢复：合并后统一重算植物（连续天数 / 生长阶段 / 枯萎 / 年报数据均由记录派生） */
export function applyImport(analysis: ImportAnalysis, existing: EmotionEntry[], previousPlants: Plant[], mode: ImportMode): ImportResult {
  const preview = previewMerge(analysis, existing, mode);
  // 优先沿用本地植物 id，其次沿用备份文件里同情绪植物的 id，保持株棵身份稳定；其余字段全部按合并后的记录重算
  const plantHints = [...previousPlants, ...analysis.validPlants];
  const plants = syncPlants(preview.toWrite, plantHints);
  const keptExisting = preview.conflicts.filter((c) => c.kept === 'existing').length;

  return {
    snapshot: { entries: preview.toWrite, plants },
    imported: preview.added + preview.replaced,
    skipped: analysis.invalidEntries.length + keptExisting,
    skippedItems: preview.skips,
    conflicts: preview.conflicts,
    repairs: analysis.repairs,
    warnings: analysis.warnings,
    mode,
  };
}
