import { type Rule, type SearchItem, type Quality } from './types.js';
import { getAdapter } from './adapters/index.js';
import { loadRules } from './rules.js';

const TITLE_NOISE = [
  /\[电影解说\]/g, /\[解说\]/g, /国语版?/g, /粤语版?/g, /中字版?/g, /双语/g,
  /清晰版/g, /完整版/g, /加长版/g, /未删减版?/g, /\(\d{4}\)/g, /（\d{4}）/g,
  /第[一二三四五六七八九十\d]+季/g, /season\s*\d+/gi, /全\d+集/g, /更新至?\d+集?/g,
  /\[电影\]/g, /\[电视剧\]/g,
];

export function normalizeTitle(title: string): string {
  let out = title;
  for (const re of TITLE_NOISE) out = out.replace(re, '');
  out = out.replace(/[\s·:：\-—_.,，、!！?？'"“”()（）\[\]【】]/g, '');
  // 采集站常把年份直接拼在片名后面：霸王别姬1993 / 奥本海默2023
  out = out.replace(/(19|20)\d{2}$/, '');
  return out.toLowerCase();
}

export interface MergedItem extends SearchItem {
  alsoOn?: { source: string; sourceName: string; id: string; quality: Quality }[];
}

export function mergeItems(items: SearchItem[]): MergedItem[] {
  const buckets = new Map<string, MergedItem>();
  for (const item of items) {
    const key = normalizeTitle(item.title) + '|' + (item.year ?? '');
    const existing = buckets.get(key);
    if (!existing) { buckets.set(key, { ...item, alsoOn: [] }); continue; }
    // 同画质时按来源可靠度排序，再按标题干净度
    const rank = (s: string) => {
      const order = ['modu', 'bdzy', 'lzi', 'rycz', 'ffzy', 'wujin', 'archive'];
      const i = order.indexOf(s);
      return i < 0 ? 99 : i;
    };
    const clean = (t: string) => t.replace(/(19|20)\d{2}/g, '').length;
    const hasScore = (s?: string) => Number(s ?? 0) > 0;
    // 有评分优先（合并后要能显示豆瓣分），其次画质，其次源可靠度
    const better = (hasScore(item.score) && !hasScore(existing.score) && item.quality.height >= existing.quality.height)
      || item.quality.height > existing.quality.height ||
      (item.quality.height === existing.quality.height && (
        rank(item.source) < rank(existing.source) ||
        (rank(item.source) === rank(existing.source) && clean(item.title) < clean(existing.title))
      ));
    const alt = { source: item.source, sourceName: item.sourceName, id: item.id, quality: item.quality };
    if (better) {
      const previous = { source: existing.source, sourceName: existing.sourceName, id: existing.id, quality: existing.quality };
      // 保留更干净的标题展示
      const title = item.title.replace(/(19|20)\d{2}$/g, '') || item.title;
      buckets.set(key, { ...item, title, alsoOn: [...(existing.alsoOn ?? []), previous] });
    } else {
      existing.alsoOn = [...(existing.alsoOn ?? []), alt];
    }
  }
  return Array.from(buckets.values()).sort(
    (a, b) => b.quality.height - a.quality.height || (b.alsoOn?.length ?? 0) - (a.alsoOn?.length ?? 0) || a.title.localeCompare(b.title, 'zh'),
  );
}

export interface SourceStat { id: string; name: string; count: number; ms: number; error?: string; }

/** 不做合并的原始多源结果，用于「同片多源择优」 */
export async function searchRaw(keyword: string, sourceIds?: string[]): Promise<{ items: SearchItem[]; sources: SourceStat[] }> {
  const rules = loadRules().filter((r) => !sourceIds || sourceIds.includes(r.id));
  const tasks = rules.map(async (rule) => {
    const t0 = Date.now();
    try {
      const adapter = getAdapter(rule);
      const items = await withTimeout(adapter.search(rule, keyword), 12000, rule.name + ' 搜索超时');
      return { id: rule.id, name: rule.name, count: items.length, ms: Date.now() - t0, items };
    } catch (err) {
      return { id: rule.id, name: rule.name, count: 0, ms: Date.now() - t0, items: [] as SearchItem[], error: String(err).slice(0, 120) };
    }
  });
  const settled = await Promise.all(tasks);
  return {
    items: settled.flatMap((s) => s.items),
    sources: settled.map(({ id, name, count, ms, error }) => ({ id, name, count, ms, error })),
  };
}

export async function searchAll(keyword: string, sourceIds?: string[]): Promise<{ items: MergedItem[]; sources: SourceStat[] }> {
  const rules = loadRules().filter((r) => !sourceIds || sourceIds.includes(r.id));
  const tasks = rules.map(async (rule) => {
    const t0 = Date.now();
    try {
      const adapter = getAdapter(rule);
      const items = await withTimeout(adapter.search(rule, keyword), 12000, rule.name + ' 搜索超时');
      return { id: rule.id, name: rule.name, count: items.length, ms: Date.now() - t0, items };
    } catch (err) {
      return { id: rule.id, name: rule.name, count: 0, ms: Date.now() - t0, items: [] as SearchItem[], error: String(err).slice(0, 120) };
    }
  });
  const settled = await Promise.all(tasks);
  const all = settled.flatMap((s) => s.items);
  return {
    items: mergeItems(all),
    sources: settled.map(({ id, name, count, ms, error }) => ({ id, name, count, ms, error })),
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); });
  });
}