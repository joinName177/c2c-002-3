import type { Emotion, EmotionEntry, GardenSnapshot, Plant } from './models';
import { EMOTIONS } from './models';
import { syncPlants } from './garden-engine';

/**
 * 备份文件（v1）。
 * meta 记录文件自身的信息，data 才参与校验和，恢复时植物状态一律以重算结果为准。
 */
export const BACKUP_APP = 'c2c-002-emotion-garden';
export const BACKUP_VERSION = 1;

export interface BackupMeta {
  app: string;
  version: number;
  exportedAt: string;
  /** 对 data 部分规范化 JSON 做的 FNV-1a 校验和，用于识别损坏/被截断/被篡改的文件 */
  checksum: string;
}

export interface BackupFile {
  meta: BackupMeta;
  data: GardenSnapshot;
}

/** 去重策略：同一天同一情绪已存在时，保留哪一条 */
export type DuplicateStrategy = 'keep-existing' | 'overwrite';

export type IssueKind = 'fatal' | 'warning';

export interface ImportIssue {
  kind: IssueKind;
  /** 问题定位：文件级问题或具体记录（日期 / 情绪 / 下标） */
  where: string;
  message: string;
}

export interface ImportPlan {
  version: number;
  exportedAt: string;
  strategy: DuplicateStrategy;
  /** 现有记录 + 文件记录合并去重后的最终结果（植物已按最终记录重算） */
  snapshot: GardenSnapshot;
  importedCount: number;
  updatedCount: number;
  duplicateCount: number;
  issues: ImportIssue[];
}

/* ---------------------------------- 导出 ---------------------------------- */

/** FNV-1a 32 位，纯字符串校验和，足以发现截断与字符级损坏 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 对象键排序后序列化，保证不同环境/时间导出的同一份数据校验和稳定 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const body = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',');
  return `{${body}}`;
}

export function createBackup(snapshot: GardenSnapshot, exportedAt = new Date().toISOString()): BackupFile {
  const data: GardenSnapshot = {
    entries: snapshot.entries.map((entry) => ({ ...entry })),
    plants: snapshot.plants.map((plant) => ({ ...plant, entryIds: [...plant.entryIds] })),
  };
  return {
    meta: { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt, checksum: fnv1a(stableStringify(data)) },
    data,
  };
}

export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

/* ---------------------------------- 导入 ---------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDate(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function isEmotion(value: unknown): value is Emotion {
  return typeof value === 'string' && (EMOTIONS as string[]).includes(value);
}

function newEntryId(): string {
  return `emotion-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 校验并解析备份文件。任何文件级（fatal）问题都直接返回错误，绝不接触现有记录；
 * 记录级问题则以 warning 形式收集，坏记录被跳过，好记录照常恢复。
 */
export function parseBackup(raw: string): { plan?: never; error: ImportIssue } | { plan: Omit<ImportPlan, 'strategy' | 'snapshot' | 'importedCount' | 'updatedCount' | 'duplicateCount'>; data: GardenSnapshot } | { error: ImportIssue } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: { kind: 'fatal', where: '文件', message: '不是合法的 JSON 文件，可能已损坏或不是情绪植物园的备份。' } };
  }
  if (!isRecord(parsed) || !isRecord(parsed.meta) || !isRecord(parsed.data)) {
    return { error: { kind: 'fatal', where: '文件', message: '缺少 meta / data 结构，不是本应用导出的备份文件。' } };
  }
  const meta = parsed.meta as Record<string, unknown>;
  if (meta.app !== BACKUP_APP) {
    return { error: { kind: 'fatal', where: '文件', message: `应用标识不匹配（读到 "${String(meta.app)}"），不是情绪植物园的备份。` } };
  }
  if (typeof meta.version !== 'number') {
    return { error: { kind: 'fatal', where: '版本', message: '备份缺少版本号，无法判断兼容性。' } };
  }
  if (meta.version > BACKUP_VERSION) {
    return { error: { kind: 'fatal', where: '版本', message: `备份来自更新的版本（v${meta.version}），当前应用只支持到 v${BACKUP_VERSION}，请升级后再导入。` } };
  }
  if (meta.version < BACKUP_VERSION) {
    return { error: { kind: 'fatal', where: '版本', message: `备份来自旧版本（v${meta.version}）。为避免旧数据覆盖新结构，请先使用对应旧版应用完成迁移后再导入。` } };
  }
  if (typeof meta.checksum !== 'string') {
    return { error: { kind: 'fatal', where: '校验', message: '备份缺少校验和，无法确认文件是否完整。' } };
  }
  const data = parsed.data as Record<string, unknown>;
  const actualChecksum = fnv1a(stableStringify(data));
  if (actualChecksum !== meta.checksum) {
    return { error: { kind: 'fatal', where: '校验', message: '校验和不一致，文件可能已损坏、被截断或被修改过。为安全起见已停止导入，现有记录未受影响。' } };
  }
  if (!Array.isArray(data.entries)) {
    return { error: { kind: 'fatal', where: '记录', message: '备份中没有情绪记录数组（entries），文件结构不完整。' } };
  }

  const issues: ImportIssue[] = [];
  const validEntries: EmotionEntry[] = [];
  const seenInFile = new Set<string>();

  data.entries.forEach((rawEntry, index) => {
    const where = `第 ${index + 1} 条记录`;
    if (!isRecord(rawEntry)) {
      issues.push({ kind: 'warning', where, message: '不是有效的记录对象，已跳过。' });
      return;
    }
    if (!isValidDate(rawEntry.date)) {
      issues.push({ kind: 'warning', where, message: `日期 "${String(rawEntry.date)}" 无法识别（应为 YYYY-MM-DD），已跳过。` });
      return;
    }
    if (!isEmotion(rawEntry.emotion)) {
      issues.push({ kind: 'warning', where, message: `情绪类型 "${String(rawEntry.emotion)}" 不在支持范围内，已跳过。` });
      return;
    }
    const date = rawEntry.date;
    const emotion = rawEntry.emotion;
    const key = `${date}#${emotion}`;
    if (seenInFile.has(key)) {
      issues.push({ kind: 'warning', where: `${where}（${date} ${emotion}）`, message: '与备份文件内另一条记录同日同情绪，已跳过。' });
      return;
    }

    let intensity = Number(rawEntry.intensity);
    if (!Number.isFinite(intensity)) {
      issues.push({ kind: 'warning', where: `${where}（${date} ${emotion}）`, message: '强度缺失或不是数字，已按默认值 3 恢复。' });
      intensity = 3;
    } else if (intensity < 1 || intensity > 5) {
      issues.push({ kind: 'warning', where: `${where}（${date} ${emotion}）`, message: `强度 ${intensity} 超出 1–5 范围，已就近修正为 ${Math.min(5, Math.max(1, intensity))}。` });
    }
    intensity = Math.min(5, Math.max(1, intensity));

    let id = typeof rawEntry.id === 'string' && rawEntry.id.trim() ? rawEntry.id : '';
    if (!id) {
      id = newEntryId();
      issues.push({ kind: 'warning', where: `${where}（${date} ${emotion}）`, message: '记录缺少 id，已自动补全新 id。' });
    }
    const note = typeof rawEntry.note === 'string' && rawEntry.note.trim() ? rawEntry.note : '';

    seenInFile.add(key);
    validEntries.push({ id, date, emotion, note, intensity });
  });

  if (!Array.isArray(data.plants)) {
    issues.push({ kind: 'warning', where: '植物', message: '备份缺少植物状态（plants），将依据恢复后的情绪记录统一重算。' });
  } else {
    const plants = data.plants as unknown[];
    plants.forEach((rawPlant, index) => {
      if (!isRecord(rawPlant) || !isEmotion(rawPlant.emotion)) {
        issues.push({ kind: 'warning', where: `第 ${index + 1} 株植物`, message: '植物数据结构不完整，该株将在恢复后重算。' });
      }
    });
  }

  if (!validEntries.length && data.entries.length) {
    return { error: { kind: 'fatal', where: '记录', message: '备份中的情绪记录全部无法通过校验，没有任何内容可以恢复。现有记录未受影响。' } };
  }

  return {
    plan: {
      version: meta.version,
      exportedAt: typeof meta.exportedAt === 'string' ? meta.exportedAt : '',
      issues,
    },
    data: { entries: validEntries, plants: [] },
  };
}

/**
 * 在预检通过的基础上，按策略与现有记录合并去重，并统一重算植物状态。
 * 此函数不产生副作用，调用方确认后再落库。
 */
export function buildImportPlan(current: GardenSnapshot, backup: GardenSnapshot, base: { version: number; exportedAt: string; issues: ImportIssue[] }, strategy: DuplicateStrategy): ImportPlan {
  const issues = [...base.issues];
  const byKey = new Map<string, EmotionEntry>();
  const idUsed = new Set<string>();

  current.entries.forEach((entry) => {
    byKey.set(`${entry.date}#${entry.emotion}`, entry);
    idUsed.add(entry.id);
  });

  let importedCount = 0;
  let updatedCount = 0;
  let duplicateCount = 0;

  backup.entries.forEach((incoming) => {
    const key = `${incoming.date}#${incoming.emotion}`;
    const existing = byKey.get(key);
    if (!existing) {
      let entry = incoming;
      if (idUsed.has(entry.id)) {
        entry = { ...entry, id: newEntryId() };
        issues.push({ kind: 'warning', where: `${incoming.date} ${incoming.emotion}`, message: '与现有记录 id 冲突，已分配新 id 后恢复。' });
      }
      idUsed.add(entry.id);
      byKey.set(key, entry);
      importedCount += 1;
      return;
    }
    duplicateCount += 1;
    if (strategy === 'overwrite') {
      byKey.set(key, { ...incoming, id: existing.id });
      updatedCount += 1;
      issues.push({ kind: 'warning', where: `${incoming.date} ${incoming.emotion}`, message: '与现有记录同日同情绪，已按「以备份为准」覆盖备注与强度（不重复累计）。' });
    } else {
      issues.push({ kind: 'warning', where: `${incoming.date} ${incoming.emotion}`, message: '与现有记录同日同情绪，已保留现有记录，备份中的这一条被跳过（不重复累计）。' });
    }
  });

  const entries = [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date));
  // 恢复后统一重算：连续天数、生长阶段、繁茂/枯萎全部以合并后的记录为准，备份里的植物状态仅作存档不直接采信
  const plants = syncPlants(entries, current.plants);

  return {
    version: base.version,
    exportedAt: base.exportedAt,
    strategy,
    snapshot: { entries, plants },
    importedCount,
    updatedCount,
    duplicateCount,
    issues,
  };
}

/** 完整导入流程：解析校验 → 合并去重 → 重算。fatal 时返回错误，现有数据保持不变。 */
export function planImport(raw: string, current: GardenSnapshot, strategy: DuplicateStrategy): { plan: ImportPlan } | { error: ImportIssue } {
  const parsed = parseBackup(raw);
  if ('error' in parsed) return { error: parsed.error };
  return { plan: buildImportPlan(current, parsed.data, parsed.plan, strategy) };
}

export function backupFileTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export type { Plant };
