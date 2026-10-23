/**
 * 前端请求层。
 *
 * 解决三件事：
 *
 * 1. 请求串台
 *    用户点分类 A 还没回来又点分类 B，A 晚一步返回会把 B 的数据盖掉。
 *    所以每个请求都带一个递增序号，回调前先比对序号，不是最新的就丢弃。
 *    同时每个请求配一个 AbortController，发新请求时取消旧的。
 *    取消是尽力而为（有些浏览器不真正中断），序号比对才是最终保证。
 *
 * 2. 重复请求
 *    连点同一个按钮、输入框每敲一个字都发一次——这些会打穿上游。
 *    同一个 URL 在短时间内的重复请求共享同一个 Promise，另有一份极短的有效期缓存。
 *
 * 3. 错误文案
 *    不能把 {"error":"请求过于频繁"} 原样丢给用户。
 *    按状态码给一句人话，原始信息留在 error.detail 里，只进 console。
 */

export interface Quality { height: number; label: string; }
export interface AltSource { source: string; sourceName: string; id: string; quality: Quality; }
export interface SearchItem {
  source: string; sourceName: string; id: string; title: string;
  year?: string; area?: string; genre?: string; remarks?: string; pic?: string;
  score?: string; quality: Quality; alsoOn?: AltSource[];
}
export interface Episode { name: string; url: string; quality: Quality; }
export type HealthStatus = 'ok' | 'unverified' | 'unavailable';
export interface Road {
  name: string; episodes: Episode[]; bestQuality: Quality;
  health?: HealthStatus;
}
export interface PanLink { type: string; url: string; quality?: string; code?: string; }
export interface DetailResult {
  source: string; sourceName: string; id: string; title: string;
  year?: string; area?: string; genre?: string; remarks?: string; pic?: string;
  intro?: string; actors?: string; director?: string; roads: Road[];
  panLinks?: PanLink[];
}
export interface Section { key: string; title: string; subtitle: string; items: SearchItem[]; }
export interface SourceStat { id: string; name: string; count: number; ms: number; error?: string; }
export interface PlayCandidate {
  source: string; sourceName: string; id: string; title: string;
  road: string; episode: string; url: string;
  height: number; width: number; label: string; ok: boolean; cors?: boolean;
}
export interface RoadHealth {
  name: string; episodes: number; bestQuality: Quality;
  health: { status: HealthStatus; httpStatus?: number; ms: number; checkedAt: number };
}

/** 海报统一走服务端缓存：首次回源，之后本地磁盘（<5ms） */
export function imgUrl(src?: string): string {
  if (!src) return '';
  return '/api/img?u=' + encodeURIComponent(src);
}

/**
 * 带用户可读文案的接口错误。
 * message 给用户看，detail 只进 console。
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail: string = '',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 把状态码翻译成人话。原始 JSON 不往界面上放。 */
function friendlyMessage(status: number, payload: unknown): string {
  const raw = typeof payload === 'object' && payload !== null && 'error' in (payload as Record<string, unknown>)
    ? String((payload as Record<string, unknown>).error ?? '')
    : '';
  if (status === 429) return '当前访问的人有点多，请稍后再试';
  if (status === 403) return raw.includes('口令') ? '需要访问口令' : '当前没有访问权限';
  if (status === 404) return '没有找到相关内容';
  if (status === 400) return '请求参数有误';
  if (status === 502 || status === 504) return '数据源暂时不可用，换一个来源试试';
  if (status >= 500) return '服务器开小差了，请稍后再试';
  return '加载失败，请稍后再试';
}

interface RecentEntry { at: number; data: unknown }

/** 极短有效期的响应缓存，用来吸收连点与快速重入 */
const recent = new Map<string, RecentEntry>();
const inflight = new Map<string, Promise<unknown>>();

/** 默认去重窗口：800ms 内相同 URL 直接复用 */
const DEFAULT_DEDUPE_MS = 800;

export interface RequestOptions {
  signal?: AbortSignal;
  /** 去重窗口，0 表示不去重 */
  dedupeMs?: number;
} 

function isAbort(err: unknown): boolean {
  return (err as Error)?.name === 'AbortError';
}

async function parseError(res: Response): Promise<ApiError> {
  let payload: unknown = null;
  let text = '';
  try {
    text = await res.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return new ApiError(res.status, friendlyMessage(res.status, payload), text.slice(0, 200));
}

/**
 * GET 一个接口。
 *
 * signal 被取消时抛出的仍是 AbortError，调用方据此判断是「主动取消」还是「真失败」。
 * 去重发生在网络层之前：同一个 URL 的并发请求只发一次。
 */
export async function get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { signal, dedupeMs = DEFAULT_DEDUPE_MS } = opts;

  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  if (dedupeMs > 0) {
    const hit = recent.get(path);
    if (hit && Date.now() - hit.at < dedupeMs) return hit.data as T;
    const running = inflight.get(path);
    if (running) return running as Promise<T>;
  }

  const task = (async () => {
    const res = await fetch(path, { signal });
    if (!res.ok) throw await parseError(res);
    const data = (await res.json()) as T;
    if (dedupeMs > 0) {
      recent.set(path, { at: Date.now(), data });
      // 别让这张表无限涨：超过 200 条就清最早的一半
      if (recent.size > 200) {
        const keys = [...recent.keys()].slice(0, 100);
        for (const k of keys) recent.delete(k);
      }
    }
    return data;
  })();

  if (dedupeMs > 0) {
    inflight.set(path, task as Promise<unknown>);
    const clear = () => inflight.delete(path);
    task.then(clear, clear);
  }

  return task;
}

/** 主动作废某个接口的短缓存。搜索这类结果变化快的地方用得上。 */
export function invalidate(prefix: string) {
  for (const key of [...recent.keys()]) if (key.startsWith(prefix)) recent.delete(key);
}

export { isAbort };

/* ---------------- 具体接口 ---------------- */

export const api = {
  home: (refresh = false, opts?: RequestOptions) =>
    get<{ sections: Section[]; generatedAt: number }>('/api/home' + (refresh ? '?refresh=1' : ''), opts),

  search: (q: string, opts?: RequestOptions) =>
    get<{ query: string; items: SearchItem[]; sources: SourceStat[] }>('/api/search?q=' + encodeURIComponent(q), opts),

  detail: (source: string, id: string, opts?: RequestOptions) =>
    get<DetailResult>('/api/detail/' + encodeURIComponent(source) + '/' + encodeURIComponent(id), opts),

  /** 触发一次线路健康检查，返回按状态排序后的线路 */
  healthCheck: (source: string, id: string, opts?: RequestOptions) =>
    get<{ title: string; roads: RoadHealth[] }>('/api/health-check/' + encodeURIComponent(source) + '/' + encodeURIComponent(id), opts),

  bestRoad: (source: string, id: string, opts?: RequestOptions) =>
    get<{ best: PlayCandidate | null; roads: PlayCandidate[] }>('/api/best-road/' + encodeURIComponent(source) + '/' + encodeURIComponent(id), opts),

  best: (q: string, skip: string[] = [], opts?: RequestOptions) =>
    get<{ query: string; best: PlayCandidate | null; alternatives: PlayCandidate[]; checked: number }>(
      '/api/best?q=' + encodeURIComponent(q) + (skip.length ? '&skip=' + skip.join(',') : ''),
      { dedupeMs: 0, ...opts },
    ),

  sources: (opts?: RequestOptions) => get<{ sources: any[] }>('/api/sources', opts),

  collections: (opts?: RequestOptions) => get<{ collections: any[] }>('/api/collections', opts),

  collection: (id: string, limit = 24, opts?: RequestOptions) =>
    get<any>('/api/collections/' + id + '?limit=' + limit, { dedupeMs: 0, ...opts }),

  resolve: (url: string, opts: RequestOptions & { adblock?: boolean; proxy?: boolean } = {}) =>
    get<{ type: string; url: string; source?: string; mode?: 'direct' | 'manifest' | 'proxy' | 'none'; sniffed?: any[] }>(
      '/api/resolve?url=' + encodeURIComponent(url)
      + (opts.adblock === false ? '&adblock=0' : '')
      + (opts.proxy ? '&proxy=1' : ''),
      { dedupeMs: 0, signal: opts.signal },
    ),

  probe: (url: string, opts?: RequestOptions) =>
    get<any>('/api/probe?url=' + encodeURIComponent(url), opts),
};

/* ---------------- 本地存储 ---------------- */

export interface WatchRecord {
  source: string; sourceName: string; id: string; title: string; pic?: string;
  episode: string; url: string; road: string; quality: string; at: number;
}

const HISTORY_KEY = 'deepmv.history.v1';
const FAV_KEY = 'deepmv.favorites.v1';

export function readHistory(): WatchRecord[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

export function pushHistory(record: WatchRecord) {
  const list = readHistory().filter((r) => !(r.source === record.source && r.id === record.id && r.episode === record.episode));
  list.unshift(record);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 120)));
}

export function readFavorites(): WatchRecord[] {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch { return []; }
}

export function toggleFavorite(record: WatchRecord): boolean {
  const list = readFavorites();
  const idx = list.findIndex((r) => r.source === record.source && r.id === record.id);
  if (idx >= 0) { list.splice(idx, 1); localStorage.setItem(FAV_KEY, JSON.stringify(list)); return false; }
  list.unshift(record);
  localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 200)));
  return true;
}

export function isFavorite(source: string, id: string): boolean {
  return readFavorites().some((r) => r.source === source && r.id === id);
}
