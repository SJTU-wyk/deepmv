import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/**
 * 海报图缓存。
 *
 * 首页 36 张海报分别来自 6 个采集站的图床，实测单张 0.8~2 秒，
 * 这是「滚动不顺」的最后一块。做法：首次取到后落盘，之后走本地磁盘（<5ms），
 * 并加上长缓存头让浏览器也不再重复请求。
 *
 * 不做缩放（不引 sharp 这类重依赖），只做缓存 + CORS 补头。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.DEEPMV_IMG_CACHE || path.resolve(here, '../data/imgcache');
const MAX_BYTES = Num(process.env.DEEPMV_IMG_CACHE_MB, 300) * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function Num(v: string | undefined, d: number): number { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

function ensure(): string {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

function keyOf(url: string): string {
  return createHash('sha1').update(url).digest('hex');
}

export interface CachedImage { bytes: Buffer; contentType: string; hit: boolean }

export async function getImage(url: string): Promise<CachedImage | null> {
  const file = path.join(ensure(), keyOf(url));
  if (existsSync(file)) {
    try {
      const bytes = readFileSync(file);
      const meta = readFileSync(file + '.meta', 'utf8').trim();
      return { bytes, contentType: meta || 'image/jpeg', hit: true };
    } catch { /* 落盘损坏，重新拉 */ }
  }
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'image/*,*/*', referer: new URL(url).origin + '/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > 8 * 1024 * 1024) return { bytes: buf, contentType: ct, hit: false };
    writeFileSync(file, buf);
    writeFileSync(file + '.meta', ct);
    prune();
    return { bytes: buf, contentType: ct, hit: false };
  } catch {
    return null;
  }
}

/** 超过上限就按修改时间删最旧的，避免磁盘无限增长 */
let lastPrune = 0;
function prune(): void {
  if (Date.now() - lastPrune < 60_000) return;
  lastPrune = Date.now();
  try {
    const dir = ensure();
    const files = readdirSync(dir).filter((f) => !f.endsWith('.meta'));
    let total = 0;
    const entries = files.map((f) => {
      const st = statSync(path.join(dir, f));
      total += st.size;
      return { f, size: st.size, at: st.mtimeMs };
    });
    if (total <= MAX_BYTES) return;
    entries.sort((a, b) => a.at - b.at);
    let freed = 0;
    for (const e of entries) {
      if (total - freed <= MAX_BYTES * 0.8) break;
      try { unlinkSync(path.join(dir, e.f)); unlinkSync(path.join(dir, e.f + '.meta')); freed += e.size; } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export function imgPath(url: string): string {
  return '/api/img?u=' + encodeURIComponent(url);
}
