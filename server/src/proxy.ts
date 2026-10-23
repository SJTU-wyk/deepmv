import { Readable } from 'node:stream';
import { fetchText } from './http.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function proxyPath(target: string): string {
  return '/api/proxy?u=' + encodeURIComponent(target);
}

function originOf(url: string): string {
  try { const u = new URL(url); return u.origin + '/'; } catch { return ''; }
}

function rewriteManifest(manifest: string, baseUrl: string): string {
  const lines = manifest.split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // 处理 #EXT-X-KEY:URI="..." / #EXT-X-MAP:URI="..." / #EXT-X-MEDIA:URI="..."
        return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => 'URI="' + proxyPath(absolute(baseUrl, uri)) + '"');
      }
      return proxyPath(absolute(baseUrl, trimmed));
    })
    .join('\n');
}

export function absolute(base: string, ref: string): string {
  try { return new URL(ref, base).toString(); } catch { return ref; }
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | string;
  isManifest: boolean;
}

export async function proxyFetch(target: string, range?: string): Promise<ProxyResult> {
  const headers: Record<string, string> = {
    'user-agent': UA,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: originOf(target),
    origin: originOf(target).replace(/\/$/, ''),
  };
  if (range) headers.range = range;
  const res = await fetch(target, { headers, redirect: 'follow' });
  const contentType = res.headers.get('content-type') ?? '';
  const isManifest = /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(target);
  if (isManifest) {
    const text = await res.text();
    const finalUrl = res.url || target;
    return {
      status: 200,
      headers: { 'content-type': 'application/vnd.apple.mpegurl; charset=utf-8', 'access-control-allow-origin': '*' },
      body: rewriteManifest(text, finalUrl),
      isManifest: true,
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
  return {
    status: res.status,
    headers: out,
    body: res.body as ReadableStream<Uint8Array>,
    isManifest: false,
  };
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
