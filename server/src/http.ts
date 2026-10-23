import { parseHTML } from 'linkedom';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface CacheEntry { at: number; value: any }
const cache = new Map<string, CacheEntry>();

export function cacheGet<T>(key: string, ttlMs: number): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) { cache.delete(key); return null; }
  return hit.value as T;
}

export function cacheSet(key: string, value: any) { cache.set(key, { at: Date.now(), value }); }
export function cacheClear() { cache.clear(); }

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: number;
  referer?: string;
  userAgent?: string;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const timeout = opts.timeoutMs ?? 15000;
  const retry = opts.retry ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retry; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers: Record<string, string> = {
        'user-agent': opts.userAgent || UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(opts.referer ? { referer: opts.referer } : {}),
        ...(opts.headers || {}),
      };
      const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retry) await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T = any>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, { ...opts, headers: { accept: 'application/json,*/*', ...(opts.headers || {}) } });
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
