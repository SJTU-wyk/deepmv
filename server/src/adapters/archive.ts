import { fetchJson } from '../http.js';
import { type Rule, type SearchItem, type DetailResult, type Road, parseQuality } from '../types.js';

/**
 * Internet Archive 适配器：公有领域 / 授权开放的欧美经典电影，画质以原片母版分辨率呈现，
 * 可做 4K 上采样的源极少，但这里是「合法可用、分辨率真实」的兜底来源。
 */
interface IASearchHit { identifier: string; title?: string; year?: string | number; description?: string; subject?: string | string[]; }

export async function search(rule: Rule, keyword: string, page = 1): Promise<SearchItem[]> {
  const rows = 24;
  const params = new URLSearchParams({
    q: [rule.archiveQuery || 'mediatype:(movies) AND collection:(feature_films)', keyword ? '"' + keyword + '"' : ''].filter(Boolean).join(' AND '),
    'fl[]': 'identifier',
    rows: String(rows),
    page: String(page),
    output: 'json',
  });
  const url = 'https://archive.org/advancedsearch.php?' + params.toString() + '&fl[]=title&fl[]=year&fl[]=description&fl[]=subject';
  const json = await fetchJson<any>(url, { timeoutMs: 20000 });
  const docs: IASearchHit[] = json?.response?.docs ?? [];
  return docs.map((d) => ({
    source: rule.id,
    sourceName: rule.name,
    id: d.identifier,
    title: String(d.title ?? d.identifier),
    year: d.year ? String(d.year).slice(0, 4) : undefined,
    genre: Array.isArray(d.subject) ? d.subject.slice(0, 3).join(' · ') : (d.subject ? String(d.subject) : undefined),
    remarks: 'Archive 原片',
    quality: parseQuality(String(d.title ?? '')),
  }));
}

export async function detail(rule: Rule, id: string): Promise<DetailResult | null> {
  const meta = await fetchJson<any>('https://archive.org/metadata/' + encodeURIComponent(id), { timeoutMs: 20000 });
  if (!meta || !meta.files) return null;
  const meta0 = meta.metadata || {};
  const videos = (meta.files as any[]).filter((file) => /^(h\.264|mpeg4|ogg|matroska|512kb mpeg4)$/i.test(String(file.format)) ||
    /\.(mp4|m4v|webm|ogv|mkv)$/i.test(String(file.name)));
  const base = ('https://' + (meta.d1 || 'archive.org') + '/download/' + encodeURIComponent(id) + '/');
  const episodes = videos.slice(0, 60).map((file, i) => {
    const name = String(file.name);
    const height = Number(file.height) || (/1080/.test(name) ? 1080 : /720/.test(name) ? 720 : 0);
    return {
      name: videos.length > 1 ? 'Part ' + (i + 1) : 'Full',
      url: base + encodeURIComponent(name),
      quality: { height, label: height >= 1080 ? '1080P' : height >= 720 ? '720P' : 'SD' },
    };
  });
  if (!episodes.length) return null;
  const best = Math.max(...episodes.map((e) => e.quality.height));
  const roads: Road[] = [{ name: 'Archive 原始画质', episodes, bestQuality: { height: best, label: best >= 1080 ? '1080P' : best >= 720 ? '720P' : 'SD' } }];
  return {
    source: rule.id,
    sourceName: rule.name,
    id,
    title: String(meta0.title ?? id),
    year: meta0.year ? String(meta0.year) : undefined,
    genre: Array.isArray(meta0.subject) ? meta0.subject.join(' · ') : String(meta0.subject ?? ''),
    intro: String(meta0.description ?? '').replace(/<[^>]+>/g, '').slice(0, 1200),
    director: String(meta0.director ?? ''),
    roads,
  };
}
