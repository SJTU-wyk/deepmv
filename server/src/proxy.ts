import { Readable } from 'node:stream';
import { fetchText } from './http.js';
import { stripHlsAds, type AdBlockReport } from './adblock.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function proxyPath(target: string): string {
  return '/api/proxy?u=' + encodeURIComponent(target);
}

export function originOf(url: string): string {
  try { const u = new URL(url); return u.origin + '/'; } catch { return ''; }
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | string;
  isManifest: boolean;
  adReport?: AdBlockReport;
}

/**
 * 重写清单。分两层处理，这是「不卡 + 无广告」的关键：
 *
 *   子清单 (.m3u8) → 仍然走本地代理，因为广告段就藏在子清单里，必须重写才能清掉
 *   分片   (.ts/.m4s/.key) → 直连 CDN 绝对地址，省掉 Node 中转（实测省 1 秒/片）
 *
 * 一部电影通常 5000+ 个分片，只有 1 个子清单要过代理，代价可以忽略。
 */
function rewriteManifest(manifest: string, baseUrl: string, adblock: boolean): { text: string; report?: AdBlockReport } {
  let source = manifest;
  let report: AdBlockReport | undefined;
  if (adblock) {
    const stripped = stripHlsAds(source, { aggressive: false });
    source = stripped.output;
    report = stripped.report;
  }
  const lines = source.split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      // #EXT-X-KEY / #EXT-X-MAP 的 URI 通常是分片资源，直连即可
      return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
        const abs = absolute(baseUrl, uri);
        return 'URI="' + (/.m3u8/i.test(abs) ? proxyPath(abs) : abs) + '"';
      });
    }
    const abs = absolute(baseUrl, trimmed);
    // 只有「下一层清单」需要继续被代理清洗；分片一律直连
    return /\.m3u8(\?|$)/i.test(abs) ? proxyPath(abs) : abs;
  }).join('\n');
  return { text: out, report };
}

export function absolute(base: string, ref: string): string {
  try { return new URL(ref, base).toString(); } catch { return ref; }
}

/**
 * 探测某个 CDN 是否允许浏览器直连（CORS）。
 * 这是「不卡」的关键：能直连就直连，省掉 Node 中转那一跳。
 * 实测同一分片：直连 806ms / 走代理 1859ms。
 */
const corsCache = new Map<string, { at: number; ok: boolean }>();
const CORS_TTL = 30 * 60 * 1000;

export async function canPlayDirect(url: string): Promise<boolean> {
  let origin = '';
  try { origin = new URL(url).origin; } catch { return false; }
  const hit = corsCache.get(origin);
  if (hit && Date.now() - hit.at < CORS_TTL) return hit.ok;
  let ok = false;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*', range: 'bytes=0-1' },
      signal: AbortSignal.timeout(8000),
    });
    const acao = res.headers.get('access-control-allow-origin');
    ok = res.ok && (acao === '*' || acao === origin);
    try { await res.body?.cancel(); } catch { /* ignore */ }
  } catch { ok = false; }
  corsCache.set(origin, { at: Date.now(), ok });
  return ok;
}

export async function proxyFetch(
  target: string,
  range?: string,
  opts: { adblock?: boolean } = {},
): Promise<ProxyResult> {
  const headers: Record<string, string> = {
    'user-agent': UA,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: originOf(target),
  };
  if (range) headers.range = range;
  const res = await fetch(target, { headers, redirect: 'follow' });
  const contentType = res.headers.get('content-type') ?? '';
  const isManifest = /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(target);

  if (isManifest) {
    const text = await res.text();
    const finalUrl = res.url || target;
    const rewritten = rewriteManifest(text, finalUrl, opts.adblock !== false);
    return {
      status: 200,
      headers: {
        'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'access-control-allow-origin': '*',
      },
      body: rewritten.text,
      isManifest: true,
      adReport: rewritten.report,
    };
  }

  const out: Record<string, string> = {
    'content-type': contentType || 'application/octet-stream',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=3600',
  };
  for (const key of ['content-length', 'content-range', 'accept-ranges']) {
    const value = res.headers.get(key);
    if (value) out[key] = value;
  }
  return { status: res.status, headers: out, body: res.body as ReadableStream<Uint8Array>, isManifest: false };
}

export function toNodeStream(stream: ReadableStream<Uint8Array>) {
  return Readable.fromWeb(stream as any);
}

/** 从网页里嗅探 m3u8 / mp4 直链（对应 Kazumi 的视频嗅探） */
export async function sniffFromPage(pageUrl: string): Promise<{ url: string; type: 'hls' | 'mp4' }[]> {
  const html = await fetchText(pageUrl, { referer: originOf(pageUrl), timeoutMs: 15000 });
  const found = new Map<string, 'hls' | 'mp4'>();
  const patterns: [RegExp, 'hls' | 'mp4'][] = [
    [/https?:\\?\/\\?\/[^"'\s<>\\]+?\.m3u8[^"'\s<>\\]*/gi, 'hls'],
    [/"url"\s*:\s*"([^"]+\.m3u8[^"]*)"/gi, 'hls'],
    [/'url'\s*:\s*'([^']+\.m3u8[^']*)'/gi, 'hls'],
    [/https?:\\?\/\\?\/[^"'\s<>\\]+?\.mp4[^"'\s<>\\]*/gi, 'mp4'],
  ];
  for (const [re, type] of patterns) {
    for (const match of html.matchAll(re)) {
      const raw = (match[1] ?? match[0]).replace(/\\\//g, '/');
      const url = absolute(pageUrl, raw);
      if (/^https?:/.test(url)) found.set(url, type);
    }
  }
  return Array.from(found.entries()).map(([url, type]) => ({ url, type }));
}