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

/** 搜索成功结果的缓存时长 */
const SEARCH_TTL = Number(process.env.DEEPMV_SEARCH_TTL || 3 * 60_000);

/**
 * 搜索失败结果的缓存时长（负缓存）。
 *
 * 不加这个的话，那 4 个海外不可达的源每次搜索都要重新等它们各自超时；
 * 熔断要连续失败 3 次才开，前两次全靠用户等。
 * 负缓存让「刚刚失败的源」在短时间内直接跳过，不再白等。
 * 时长比正缓存短，给对方恢复的机会。
 */
const SEARCH_FAIL_TTL = Number(process.env.DEEPMV_SEARCH_FAIL_TTL || 90_000);

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

/** 缓存的失败标记，用独立前缀避免和成功的条目混淆 */
interface FailureMark { error: string; at: number }

function failKey(ruleId: string, keyword: string) {
  return 'fail:' + ruleId + ':' + keyword;
}

function recentFailure(ruleId: string, keyword: string): string | null {
  const mark = caches.upstream.get<FailureMark>(failKey(ruleId, keyword));
  return mark ? mark.error : null;
}

function rememberFailure(ruleId: string, keyword: string, error: string, ttlMs = SEARCH_FAIL_TTL) {
  caches.upstream.set(failKey(ruleId, keyword), { error, at: Date.now() } as FailureMark, ttlMs);
}

/** 超时用的负缓存更短：45 秒后允许重试，对方可能只是这一下慢 */
const SEARCH_TIMEOUT_TTL = Number(process.env.DEEPMV_SEARCH_TIMEOUT_TTL || 45_000);

/**
 * 逐源搜索。
 *
 * 流程：
 *   1. 熔断中的源直接跳过（0 成本）
 *   2. 刚失败过的源走负缓存，也不打上游
 *   3. 其余并发打出去，按主机限流
 *   4. 到总时限就返回已有的
 *
 * 单个源失败只影响它自己，其它源照常返回。
 */
async function searchSources(keyword: string, rules: Rule[]): Promise<SearchOutcome[]> {
  const key = keyword.trim().toLowerCase();
  const collected = new Map<string, SearchOutcome>();
  const tasks: Promise<void>[] = [];

  for (const rule of rules) {
    // 1. 熔断中
    if (!available(rule.id)) {
      collected.set(rule.id, {
        id: rule.id, name: rule.name, count: 0, ms: 0, items: [],
        error: '该来源暂时不可用',
      });
      continue;
    }

    // 2. 刚失败过：负缓存命中就不打上游
    const recent = recentFailure(rule.id, key);
    if (recent) {
      collected.set(rule.id, {
        id: rule.id, name: rule.name, count: 0, ms: 0, items: [],
        error: '该来源暂时不可用',
      });
      continue;
    }

    // 3. 正常请求
    tasks.push((async () => {
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
        rememberFailure(rule.id, key, detail);
        log.upstream(rule.id, false, ms, detail);
        collected.set(rule.id, { id: rule.id, name: rule.name, count: 0, ms, items: [], error: detail });
      }
    })());
  }

  // 排序：能用的、上次快的排前面，让有限的并发槽位优先给靠谱的源
  void sortByHealth;

  const deadline = new Promise<void>((resolve) => setTimeout(resolve, SEARCH_DEADLINE_MS));
  await Promise.race([Promise.all(tasks), deadline]);

  // 到点还没回来的（发了请求但没等到）
  for (const rule of rules) {
    if (collected.has(rule.id)) continue;
    collected.set(rule.id, {
      id: rule.id, name: rule.name, count: 0, ms: SEARCH_DEADLINE_MS, items: [],
      error: '响应超时',
    });
    // 超时也记负缓存：同一个词短时间内再搜，它还是赶不上，别让用户再等一次。
    // 时长比失败短（默认 45 秒），给对方恢复机会。
    rememberFailure(rule.id, key, '响应超时', SEARCH_TIMEOUT_TTL);
  }

  const outcomes = rules.map((r) => collected.get(r.id)!);
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