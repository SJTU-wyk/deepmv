/**
 * HLS 广告清除。
 *
 * 采集站的广告不是插在播放器里的，而是**直接拼进了 m3u8 清单**：
 * 主片流之外插入一段来自完全不同路径簇的分片，并在插入点打 #EXT-X-DISCONTINUITY。
 *
 * 实测样本（魔都 奥本海默）：
 *   主片  /20240924/5pBdFnaw/2000kb/hls   → 10821 秒，5485 个唯一分片
 *   广告  /20261009/KqUe4B8N/10152kb/hls  → 176 秒，9 个唯一分片，各重复 10 次
 *   共 19 个 DISCONTINUITY 插入点
 *
 * 所以判据不是「时长」也不是「关键词」，而是三条可量化的特征：
 *   1. 分片 URI 重复出现（正常片源绝不会重复同一个 .ts）
 *   2. 某个路径簇的分片种类极少、却占了大量槽位
 *   3. 该簇总时长远小于主片，且被拆散插在中间
 */

interface Seg { dur: number; uri: string; tags: string[] }

function parse(text: string): { head: string[]; segs: Seg[]; tail: string[] } {
  const lines = text.split(/\r?\n/);
  const head: string[] = [];
  const tail: string[] = [];
  const segs: Seg[] = [];
  let pending: string[] = [];
  let pendingDur = 0;
  let started = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXTINF')) {
        pendingDur = parseFloat(line.slice(8)) || 0;
        pending.push(line);
        continue;
      }
      if (line.startsWith('#EXT-X-ENDLIST')) { tail.push(line); continue; }
      if (!started) { head.push(line); continue; }
      pending.push(line);
      continue;
    }
    // 分片 URI
    segs.push({ dur: pendingDur, uri: line, tags: pending });
    pending = [];
    pendingDur = 0;
    started = true;
  }
  if (pending.length) tail.push(...pending);
  return { head, segs, tail };
}

function dirOf(uri: string): string {
  const q = uri.split('?')[0];
  const i = q.lastIndexOf('/');
  return i < 0 ? q : q.slice(0, i);
}

export interface AdBlockReport {
  removedSegments: number;
  removedSeconds: number;
  clusters: { dir: string; segments: number; unique: number; seconds: number }[];
  keptSeconds: number;
}

export function stripHlsAds(manifest: string, opts: { aggressive?: boolean } = {}): { output: string; report: AdBlockReport } {
  const { head, segs, tail } = parse(manifest);
  const report: AdBlockReport = { removedSegments: 0, removedSeconds: 0, clusters: [], keptSeconds: 0 };
  if (!segs.length) return { output: manifest, report };

  const totalDur = segs.reduce((a, s) => a + s.dur, 0);

  // --- 1. 重复 URI：只保留第一次出现 ---
  const seen = new Set<string>();
  const deduped: Seg[] = [];
  for (const s of segs) {
    if (seen.has(s.uri)) { report.removedSegments++; report.removedSeconds += s.dur; continue; }
    seen.add(s.uri);
    deduped.push(s);
  }

  // --- 2. 路径簇分析 ---
  const clusters = new Map<string, { count: number; unique: Set<string>; dur: number; first: number }>();
  deduped.forEach((s, i) => {
    const d = dirOf(s.uri);
    const c = clusters.get(d) ?? { count: 0, unique: new Set<string>(), dur: 0, first: i };
    c.count++; c.unique.add(s.uri); c.dur += s.dur;
    clusters.set(d, c);
  });

  const ranked = Array.from(clusters.entries()).sort((a, b) => b[1].dur - a[1].dur);
  const main = ranked[0];

  // 主簇之外、时长占比很小、且分片数很少的簇 = 广告
  const adDirs = new Set<string>();
  for (const [dir, c] of ranked.slice(1)) {
    const share = totalDur > 0 ? c.dur / totalDur : 0;
    const looksLikeAd = c.count <= 200 && share < 0.25 && c.unique.size <= Math.max(20, c.count * 0.5);
    if (looksLikeAd || opts.aggressive && share < 0.05) {
      adDirs.add(dir);
      report.clusters.push({ dir, segments: c.count, unique: c.unique.size, seconds: Math.round(c.dur) });
    }
  }

  let kept = deduped;
  if (adDirs.size) {
    const before = kept.length;
    kept = kept.filter((s) => !adDirs.has(dirOf(s.uri)));
    report.removedSegments += before - kept.length;
    report.removedSeconds += deduped.filter((s) => adDirs.has(dirOf(s.uri))).reduce((a, s) => a + s.dur, 0);
  }

  // --- 3. 清理孤立标签 ---
  // 去掉开头第一个分片之前的 DISCONTINUITY / KEY（广告被删后常见）
  const rebuilt: Seg[] = kept.map((s) => {
    const tags = s.tags.filter((t) => !t.startsWith('#EXT-X-DISCONTINUITY'));
    // 紧随 DISCONTINUITY 的 #EXT-X-KEY:METHOD=NONE 是广告切换留下的，一并去掉
    return { ...s, tags };
  });
  // 重新插入真实的不连续点：跨越了大间隔（>30s 或 URI 前缀变化）才保留
  const withDisc: Seg[] = [];
  rebuilt.forEach((s, i) => {
    if (i > 0) {
      const prev = rebuilt[i - 1];
      const gap = Math.abs(s.dur - prev.dur) > 25;
      if (gap && dirOf(s.uri) !== dirOf(prev.uri)) withDisc.push({ ...s, tags: ['#EXT-X-DISCONTINUITY', ...s.tags] });
      else withDisc.push(s);
    } else withDisc.push(s);
  });

  report.keptSeconds = Math.round(withDisc.reduce((a, s) => a + s.dur, 0));

  const out: string[] = [...head];
  for (const s of withDisc) { out.push(...s.tags); out.push(s.uri); }
  out.push(...tail);
  return { output: out.join('\n') + '\n', report };
}

export function isAdHeavy(report: AdBlockReport): boolean {
  return report.removedSeconds > 5;
}
