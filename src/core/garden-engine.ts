import type { Emotion, EmotionEntry, GardenSnapshot, GrowthStage, Plant } from './models';
import { EMOTION_META, EMOTIONS } from './models';

const day = 86400000;
export function stageFor(streak: number): GrowthStage { if (streak >= 14) return '结果'; if (streak >= 7) return '开花'; if (streak >= 3) return '发芽'; return '种子'; }
export function createEntryId(): string { return `emotion-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
const entryKey = (item: EmotionEntry) => `${item.date}__${item.emotion}`;
/** 同一天同一情绪只保留一条，避免重复记录累计连续天数与年报 */
export function dedupeEntries(entries: EmotionEntry[]): EmotionEntry[] {
  const byKey = new Map<string, EmotionEntry>();
  for (const item of entries) { if (!byKey.has(entryKey(item))) byKey.set(entryKey(item), item); }
  return [...byKey.values()];
}
export function streakFor(entries: EmotionEntry[], emotion: Emotion): number {
  const dates = new Set(dedupeEntries(entries).filter((item) => item.emotion === emotion).map((item) => item.date));
  let streak = 0; const cursor = new Date(); cursor.setHours(0, 0, 0, 0);
  while (dates.has(cursor.toISOString().slice(0, 10))) { streak += 1; cursor.setTime(cursor.getTime() - day); }
  if (!streak) {
    const sortedDates = [...dates].sort(); const latest = sortedDates[sortedDates.length - 1]; if (!latest) return 0;
    const distance = Math.floor((Date.now() - new Date(`${latest}T00:00:00`).getTime()) / day);
    if (distance > 1) return 0;
    streak = 1;
  }
  return streak;
}
export function syncPlants(entries: EmotionEntry[], previous: Plant[] = []): Plant[] {
  const unique = dedupeEntries(entries);
  return EMOTIONS.filter((emotion) => unique.some((item) => item.emotion === emotion)).map((emotion) => {
    const own = unique.filter((item) => item.emotion === emotion).sort((a, b) => a.date.localeCompare(b.date));
    const existing = previous.find((item) => item.emotion === emotion);
    const streak = streakFor(unique, emotion);
    return { id: existing?.id ?? `plant-${emotion}`, emotion, plantedAt: own[0].date, lastWatered: own[own.length - 1].date, streak, stage: stageFor(streak), status: streak ? '繁茂' : '枯萎', entryIds: own.map((item) => item.id) };
  });
}
export function createEntry(emotion: Emotion, note: string, intensity: number, date = new Date().toISOString().slice(0, 10)): EmotionEntry { return { id: createEntryId(), date, emotion, note: note.trim() || EMOTION_META[emotion].hint, intensity: Math.min(5, Math.max(1, Number(intensity) || 3)) }; }
export function annualReport(entries: EmotionEntry[]) {
  const unique = dedupeEntries(entries);
  const counts = EMOTIONS.map((emotion) => ({ emotion, count: unique.filter((item) => item.emotion === emotion).length })).sort((a, b) => b.count - a.count);
  const active = new Set(unique.map((item) => item.date)).size;
  const intensity = unique.length ? unique.reduce((sum, item) => sum + item.intensity, 0) / unique.length : 0;
  return { top: counts[0], counts, active, lushness: Math.min(100, Math.round((active / 90) * 70 + (intensity / 5) * 30)), intensity: Math.round(intensity * 10) / 10 };
}
export function sampleSnapshot(): GardenSnapshot {
  const today = new Date(); const entries: EmotionEntry[] = [];
  const seed: Emotion[] = ['喜悦', '喜悦', '平静', '平静', '平静', '平静', '喜悦', '忧伤', '焦虑', '平静', '喜悦'];
  seed.forEach((emotion, index) => { const date = new Date(today.getTime() - (seed.length - index - 1) * day).toISOString().slice(0, 10); entries.push(createEntry(emotion, index % 2 ? '今天注意到了自己的节奏。' : '给这一天留下一颗种子。', (index % 5) + 1, date)); });
  return { entries, plants: syncPlants(entries) };
}
