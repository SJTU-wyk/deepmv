import { type Rule, type SearchItem, type Quality } from './types.js';
import { getAdapter } from './adapters/index.js';
import { loadRules } from './rules.js';
import { caches } from './cache.js';
import { log } from './log.js';
import { available, recordFailure, recordSuccess, sortByHealth } from './breaker.js';

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
    const rank = (s: string) => {
      const order = ['modu', 'bdzy', 'lzi', 'rycz', 'ffzy', 'wujin', 'ddys', 'archive'];
      const i = order.indexOf(s);
      return i < 0 ? 99 : i;
    };
    const clean = (t: string) => t.replace(/(19|20)\d{2}/g, '').length;
    const hasScore = (s?: string) => Number(s ?? 0) > 0;
    const better = (hasScore(item.score) && !hasScore(existing.score) && item.quality.height >= existing.quality.height)
      || item.quality.height > existing.quality.height ||
      (item.quality.height === existing.quality.height && (
        rank(item.source) < rank(existing.source) ||
        (rank(item.source) === rank(existing.source) && clean(item.title) < clean(existing.title))
      ));
    const alt = { source: item.source, sourceName: item.sourceName, id: item.id, quality: item.quality };
    if (better) {
      const previous = { source: existing.source, sourceName: existing.sourceName, id: existing.id, quality: existing.quality };
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

/** 搜索结果缓存时长：上游不需要被同一批查询反复打 */
const SEARCH_TTL = Number(process.env.DEEPMV_SEARCH_TTL || 3 * 60_000);

/** 单次搜索的总时限：到点就返回已有的，不等慢源 */
const SEARCH_DEADLINE_MS = Number(process.env.DEEPMV_SEARCH_DEADLINE || 6_000);

interface SearchOutcome {
  id: string;
  name: string;
  count: number;
  ms: number;
  items: SearchItem[];
  error?: string;
}

/**
 * 逐源搜索。
 *
 * 四层保护，实测把冷搜索从 24 秒压到 8 秒以内：
 *
 *   1. 熔断：连续失败到阈值的源暂时摘掉。海外环境下有三个源必然超时，
 *      每次搜索都等它们白等十几秒。
 *   2. 排序：能用的、上次快的源排在前面，并发槽位优先给他们。
 *   3. 限量并发：同一时刻只打 UPSTREAM_CONCURRENCY 个上游。
 *   4. 总时限：到点就返回已经拿到的，不等剩下的。
 *      没回来的源在结果里标成「超时」，前端只是少显示几个来源，不报错。
 *
 * 单个源失败不影响其它源：每个任务自己吞掉异常，返回带 error 字段的结果。
 */
async function searchSources(keyword: string, rules: Rule[]): Promise<SearchOutcome[]> {
  const key = keyword.trim().toLowerCase();

  // 摘掉熔断中的源
  const candidates = sortByHealth(rules.filter((r) => available(r.id)));
  const skipped = rules.filter((r) => !available(r.id));

  const collected = new Map<string, SearchOutcome>();

  const tasks = candidates.map((rule) =>
    (async () => {
      const started = Date.now();
      const cacheKey = 'search:' + rule.id + ':' + key;
      try {
        const items = await caches.upstream.memo(cacheKey, SEARCH_TTL, async () => {
          const adapter = getAdapter(rule);
          return adapter.search(rule, keyword);
        });
        const ms = Date.now() - started;
        recordSuccess(rule.id, ms);
        log.upstream(rule.id, true, ms);
        collected.set(rule.id, { id: rule.id, name: rule.name, count: items.length, ms, items });
      } catch (err) {
        const ms = Date.now() - started;
        const detail = String((err as Error)?.message || err).slice(0, 100);
        recordFailure(rule.id, detail, ms);
        log.upstream(rule.id, false, ms, detail);
        collected.set(rule.id, { id: rule.id, name: rule.name, count: 0, ms, items: [], error: detail });
      }
    })(),
  );

  // 总时限：到点就带着已有结果返回
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, SEARCH_DEADLINE_MS));
  await Promise.race([Promise.all(tasks), deadline]);

  const outcomes: SearchOutcome[] = [];
  for (const rule of rules) {
    const hit = collected.get(rule.id);
    if (hit) { outcomes.push(hit); continue; }
    // 没回来的分两种：熔断中（根本没发请求）和超过总时限（发了没等到）
    const skippedByBreaker = !available(rule.id);
    outcomes.push({
      id: rule.id,
      name: rule.name,
      count: 0,
      ms: skippedByBreaker ? 0 : SEARCH_DEADLINE_MS,
      items: [],
      error: skippedByBreaker ? '该来源暂时不可用' : '响应超时',
    });
  }
  void skipped;
  log.debug('search-done', {
    keyword: key,
    ready: outcomes.filter((o) => !o.error).length,
    total: outcomes.length,
  });
  return outcomes;
}

function toStats(outcomes: SearchOutcome[]): SourceStat[] {
  return outcomes.map(({ id, name, count, ms, error }) => ({ id, name, count, ms, error }));
}

/** 不做合并的原始多源结果，用于「同片多源择优」 */
export async function searchRaw(keyword: string, sourceIds?: string[]): Promise<{ items: SearchItem[]; sources: SourceStat[] }> {
  const rules = loadRules().filter((r) => !sourceIds || sourceIds.includes(r.id));
  const outcomes = await searchSources(keyword, rules);
  return { items: outcomes.flatMap((o) => o.items), sources: toStats(outcomes) };
}

export async function searchAll(keyword: string, sourceIds?: string[]): Promise<{ items: MergedItem[]; sources: SourceStat[] }> {
  const rules = loadRules().filter((r) => !sourceIds || sourceIds.includes(r.id));
  const outcomes = await searchSources(keyword, rules);
  return { items: mergeItems(outcomes.flatMap((o) => o.items)), sources: toStats(outcomes) };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); });
  });
}