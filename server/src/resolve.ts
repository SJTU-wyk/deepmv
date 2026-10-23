import { searchRaw, withTimeout } from './aggregate.js';
import { type SearchItem } from './types.js';
import { getRule } from './rules.js';
import { getAdapter } from './adapters/index.js';
import { probeHls, heightLabel } from './probe.js';
import { type Road, type Episode } from './types.js';

export interface PlayCandidate {
  source: string;
  sourceName: string;
  id: string;
  title: string;
  road: string;
  episode: string;
  url: string;
  height: number;
  width: number;
  label: string;
  ok: boolean;
}

function normalize(s: string) {
  return s.replace(/[\s·:：\-—_.,，、!！?？'"“”()（）\[\]【】]/g, '').toLowerCase();
}

async function probeEpisode(url: string): Promise<{ ok: boolean; height: number; width: number; label: string }> {
  if (!/\.m3u8/i.test(url)) return { ok: true, height: 0, width: 0, label: '直链' };
  const res = await probeHls(url);
  return { ok: res.ok, height: res.height, width: res.width, label: res.label };
}

/** 对单个条目探测前两条线路的首集，返回可用候选 */
async function candidatesFor(item: SearchItem, maxRoads = 2): Promise<PlayCandidate[]> {
  const rule = getRule(item.source);
  if (!rule) return [];
  try {
    const adapter = getAdapter(rule);
    const detail = await withTimeout(adapter.detail(rule, item.id), 16000, 'detail timeout');
    if (!detail) return [];
    const roads = detail.roads.slice(0, maxRoads);
    const out: PlayCandidate[] = [];
    for (const road of roads) {
      const ep = road.episodes[0];
      if (!ep) continue;
      const probed = await probeEpisode(ep.url);
      out.push({
        source: item.source, sourceName: item.sourceName, id: item.id, title: detail.title,
        road: road.name, episode: ep.name, url: ep.url,
        height: probed.height, width: probed.width,
        label: probed.ok ? probed.label : '不可用',
        ok: probed.ok,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 给定片名，跨源找出「能播 + 分辨率最高」的那一条。
 * 这是 DeepMV 与普通采集壳的核心差别：不信任站点自报的清晰度，只信任 HLS 清单里的 RESOLUTION。
 */
export async function bestPlay(query: string, opts: { excludeSource?: string; limit?: number; exclude?: string[] } = {}) {
  const { items } = await searchRaw(query);
  const key = normalize(query);
  const exact = items.filter((i) => {
    const t = normalize(i.title);
    if (!t.includes(key)) return false;
    // 排除解说 / 预告 这类派生条目
    return !/解说|预告|花絮|片段/.test(i.title);
  });
  const pool = (exact.length ? exact : items)
    .filter((i) => i.source !== opts.excludeSource && !(opts.exclude || []).includes(i.source + ':' + i.id))
    .slice(0, opts.limit ?? 8);

  const groups = await Promise.all(pool.map((item) => candidatesFor(item, 2)));
  const all = groups.flat();
  const playable = all.filter((c) => c.ok).sort((a, b) => b.height - a.height);
  return {
    query,
    best: playable[0] ?? null,
    alternatives: playable.slice(1, 8),
    checked: all.length,
    probed: all.length,
  };
}

/** 单条目内挑选最佳线路（用于详情页自动探测） */
export async function bestRoadOf(source: string, id: string): Promise<{ best: PlayCandidate | null; roads: PlayCandidate[] }> {
  const rule = getRule(source);
  if (!rule) return { best: null, roads: [] };
  const adapter = getAdapter(rule);
  const detail = await adapter.detail(rule, id);
  if (!detail) return { best: null, roads: [] };
  const roads: PlayCandidate[] = [];
  for (const road of detail.roads.slice(0, 4)) {
    const ep = road.episodes[0];
    if (!ep) continue;
    const probed = await probeEpisode(ep.url);
    roads.push({
      source, sourceName: detail.sourceName, id, title: detail.title,
      road: road.name, episode: ep.name, url: ep.url,
      height: probed.height, width: probed.width,
      label: probed.ok ? probed.label : '不可用', ok: probed.ok,
    });
  }
  const best = [...roads].filter((r) => r.ok).sort((a, b) => b.height - a.height)[0] ?? null;
  return { best, roads };
}