import { parseHTML } from 'linkedom';
import { caches } from './cache.js';
import { fetchUpstreamText } from './upstream.js';

/**
 * 上游抓取的统一入口。
 *
 * 原来这里的缓存是无上限的 Map，跑久了内存一直涨；
 * 现在改成 cache.ts 里那套有上限、带请求合并的实现。
 * 外部调用方用的还是 cacheGet / cacheSet 这两个名字，不用改。
 */

interface CacheEntry { at: number; value: unknown }
const adapterCache = new Map<string, CacheEntry>();
const ADAPTER_CACHE_MAX = 800;

export function cacheGet<T>(key: string, ttlMs: number): T | null {
  const hit = adapterCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) { adapterCache.delete(key); return null; }
  return hit.value as T;
}

export function cacheSet(key: string, value: unknown) {
  adapterCache.set(key, { at: Date.now(), value });
  if (adapterCache.size > ADAPTER_CACHE_MAX) {
    const oldest = adapterCache.keys().next();
    if (!oldest.done) adapterCache.delete(oldest.value);
  }
}

export function cacheClear() { adapterCache.clear(); caches.upstream.clear(); }

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: number;
  referer?: string;
  userAgent?: string;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  return fetchUpstreamText(url, {
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
    retries: opts.retry,
    referer: opts.referer,
    userAgent: opts.userAgent,
  });
}

export async function fetchJson<T = any>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, {
    ...opts,
    headers: { accept: 'application/json,*/*', ...(opts.headers || {}) },
  });
  return JSON.parse(text) as T;
}

export function loadHtml(html: string) {
  return parseHTML(html).document;
}

/** 解析苹果CMS 返回的 XML 列表（部分站点只提供 XML） */
export function parseMaccmsXml(xml: string): { list: any[]; classes: { id: string; name: string }[] } {
  const list: any[] = [];
  const videoRe = /<video>([\s\S]*?)<\/video>/g;
  let m: RegExpExecArray | null;
  while ((m = videoRe.exec(xml))) {
    const body = m[1];
    const pick = (tag: string) => {
      const c = new RegExp('<' + tag + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>').exec(body);
      return c ? c[1].trim() : '';
    };
    list.push({
      vod_id: pick('id'),
      vod_name: pick('name'),
      type_id: pick('tid'),
      type_name: pick('type'),
      vod_pic: pick('pic'),
      vod_remarks: pick('note'),
      vod_year: pick('year'),
      vod_area: pick('area'),
      vod_score: pick('score'),
      vod_play_from: pick('dt'),
      vod_play_url: pick('dd'),
      vod_blurb: pick('des'),
      vod_actor: pick('actor'),
      vod_director: pick('director'),
    });
  }
  const classes: { id: string; name: string }[] = [];
  const classRe = /<ty id="(\d+)">(?:<!\[CDATA\[)?([^<\]]+)(?:\]\]>)?<\/ty>/g;
  while ((m = classRe.exec(xml))) classes.push({ id: m[1], name: m[2].trim() });
  return { list, classes };
}

export function stripHtml(input?: string | null): string {
  if (!input) return '';
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n')
    .trim();
}
