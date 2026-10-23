import { fetchText } from './http.js';
import { absolute } from './proxy.js';

export interface ProbeResult {
  url: string;
  ok: boolean;
  height: number;
  width: number;
  label: string;
  bandwidth?: number;
  variants: { url: string; width: number; height: number; bandwidth?: number }[];
  error?: string;
}

/** 读取 HLS master playlist，返回真实分辨率（这是「最高画质」判断的唯一可靠依据） */
export async function probeHls(url: string): Promise<ProbeResult> {
  try {
    const text = await fetchText(url, { timeoutMs: 12000, retry: 0 });
    if (!/#EXTM3U/.test(text)) {
      return { url, ok: false, height: 0, width: 0, label: '未知', variants: [], error: '非 HLS 清单' };
    }
    const lines = text.split(/\r?\n/);
    const variants: { url: string; width: number; height: number; bandwidth?: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
      const res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
      const bw = /BANDWIDTH=(\d+)/i.exec(line);
      let next = '';
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim();
        if (candidate && !candidate.startsWith('#')) { next = candidate; break; }
      }
      variants.push({
        url: next ? absolute(url, next) : url,
        width: res ? Number(res[1]) : 0,
        height: res ? Number(res[2]) : 0,
        bandwidth: bw ? Number(bw[1]) : undefined,
      });
    }
    if (!variants.length) {
      // 单码率清单：没有 RESOLUTION，按 1080p 估
      return { url, ok: true, height: 1080, width: 1920, label: '1080P', variants: [] };
    }
    const best = variants.reduce((a, b) => (b.height > a.height ? b : a));
    return {
      url,
      ok: true,
      height: best.height,
      width: best.width,
      label: heightLabel(best.height),
      bandwidth: best.bandwidth,
      variants: variants.sort((a, b) => b.height - a.height),
    };
  } catch (err) {
    return { url, ok: false, height: 0, width: 0, label: '未知', variants: [], error: String(err).slice(0, 120) };
  }
}

export function heightLabel(height: number): string {
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return '1080P';
  if (height >= 720) return '720P';
  if (height >= 540) return '540P';
  return height ? height + 'P' : '未知';
}
