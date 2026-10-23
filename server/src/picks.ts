import { COLLECTIONS, getCollection } from './collections.js';
import { searchAll, type MergedItem, withTimeout } from './aggregate.js';

const PICK_TTL = 6 * 60 * 60 * 1000;
const PICK_SOURCES = ['modu', 'bdzy', 'lzi', 'rycz', 'ffzy'];
const cache = new Map<string, { at: number; data: any }>();

export interface PickItem {
  title: string;
  year?: string;
  note?: string;
  item: MergedItem | null;
}

function normalize(s: string) {
  return s.replace(/[\s·:：\-—_.,，、!！?？'"“”()（）\[\]【】]/g, '').toLowerCase();
}

async function resolveTitle(title: string, year?: string): Promise<PickItem> {
  try {
    const { items } = await withTimeout(searchAll(title, PICK_SOURCES), 16000, 'pick timeout');
    const key = normalize(title);
    // 片名必须高度一致：完全相等，或片名 + 少量后缀（如「粤语」「国语」）
    const exact = items.filter((i) => {
      const t = normalize(i.title);
      if (t === key) return true;
      if (!t.startsWith(key)) return false;
      return t.length - key.length <= 4;
    });
    if (!exact.length) return { title, year, item: null };
    // 片单标注了年份时严格按年份对齐，避免 1961 版《西游记》被 2015 动画电影顶替
    const withYear = year
      ? exact.filter((i) => i.year && Math.abs(Number(i.year) - Number(year)) <= 1)
      : exact;
    const pool = (withYear.length ? withYear : year ? [] : exact)
      .sort((a, b) => b.quality.height - a.quality.height || Number(b.score ?? 0) - Number(a.score ?? 0));
    return { title, year, item: pool[0] ?? null };
  } catch {
    return { title, year, item: null };
  }
}

async function inBatches<T>(list: T[], size: number, fn: (item: T) => Promise<PickItem>): Promise<PickItem[]> {
  const out: PickItem[] = [];
  for (let i = 0; i < list.length; i += size) {
    const batch = list.slice(i, i + size);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

export async function getPicks(id: string, limit = 24, force = false): Promise<any | null> {
  const entry = getCollection(id);
  if (!entry) return null;
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.at < PICK_TTL) {
    return { ...entry, resolved: hit.data.slice(0, limit), cached: true };
  }
  const targets = entry.titles.slice(0, Math.max(limit, 12));
  const resolved = await inBatches(targets, 6, (t) => resolveTitle(t.title, t.year));
  cache.set(id, { at: Date.now(), data: resolved });
  return { ...entry, resolved: resolved.filter((r) => r.item), cached: false };
}

/** 只读缓存，不触发网络请求：用于首页，未预热时该行自动隐藏 */
export function peekPicks(id: string): PickItem[] {
  const hit = cache.get(id);
  return hit ? hit.data : [];
}

export interface WarmStatus { id: string; done: boolean; ready: number }
const warm: Record<string, WarmStatus> = {};
let warmerStarted = false;

/** 服务启动时后台预热片单，避免首页首次访问等待 */
export function startWarmup() {
  if (warmerStarted) return;
  warmerStarted = true;
  const jobs = COLLECTIONS.map((c) => c.id);
  (async () => {
    for (const id of jobs) {
      try {
        const entry = getCollection(id);
        if (!entry) continue;
        const resolved = await inBatches(entry.titles.slice(0, 24), 6, (t) => resolveTitle(t.title, t.year));
        cache.set(id, { at: Date.now(), data: resolved });
        warm[id] = { id, done: true, ready: resolved.filter((r) => r.item).length };
      } catch { /* ignore */ }
    }
  })();
}

export async function getPickOverview(): Promise<any[]> {
  return COLLECTIONS.map((c) => {
    const hit = cache.get(c.id);
    const resolved = hit?.data ?? [];
    return {
      id: c.id, title: c.title, subtitle: c.subtitle, cover: c.cover,
      count: c.titles.length,
      ready: resolved.filter((r: PickItem) => r.item).length,
      preview: resolved.filter((r: PickItem) => r.item).slice(0, 8).map((r: PickItem) => ({
        title: r.title, year: r.year, pic: r.item?.pic, quality: r.item?.quality, source: r.item?.source, id: r.item?.id,
      })),
    };
  });
}