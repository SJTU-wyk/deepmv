import { fetchJson } from '../http.js';
import { type Rule, type SearchItem, type DetailResult, type Road, type Episode, parseQuality, maxQuality } from '../types.js';

/**
 * 低端影视（ddys.io）适配器。
 *
 * 这个站有正经的 JSON API，不用解析 HTML：
 *   GET /api/v1/movies?per_page=&page=        列表
 *   GET /api/v1/search?q=                     搜索
 *   GET /api/v1/movies/{slug}                 详情
 *   GET /api/v1/movies/{slug}/sources         播放源 + 网盘资源
 *
 * sources.online[].url 有两种格式：
 *   剧集  第01集$https://...#第02集$https://...
 *   单片  https://...        （没有前缀，直接就是地址）
 * 第二种一度被漏掉，导致所有电影都显示 0 条线路。
 *
 * sources.download[] 是网盘分享链接（baidu / quark / xunlei / pikpak），
 * 带画质标注和提取码。网盘链接只能展示，不能直接播——
 * 要播得观众自己有对应网盘的账号。
 */
const BASE = 'https://ddys.io';

interface DdysMovie {
  id: number;
  title: string;
  slug: string;
  year?: number;
  poster?: string;
  rating?: number;
  intro?: string;
  type?: string;
  region?: string;
  genres?: { name: string }[];
  is_completed?: boolean;
  director?: string;
  actors?: string;
}

function toItem(rule: Rule, m: DdysMovie): SearchItem {
  return {
    source: rule.id,
    sourceName: rule.name,
    id: m.slug,
    title: m.title,
    year: m.year ? String(m.year) : undefined,
    area: m.region,
    genre: [m.type, ...(m.genres || []).map((g) => g.name)].filter(Boolean).join(' · '),
    remarks: m.is_completed ? '已完结' : '连载中',
    pic: m.poster,
    score: m.rating ? String(m.rating) : undefined,
    quality: parseQuality('1080P'),
  };
}

export async function search(rule: Rule, keyword: string, page = 1): Promise<SearchItem[]> {
  const json = await fetchJson<any>(
    BASE + '/api/v1/search?q=' + encodeURIComponent(keyword) + '&page=' + page,
    { timeoutMs: 15000, referer: BASE + '/' },
  );
  return (json?.data ?? []).map((m: DdysMovie) => toItem(rule, m));
}

export async function categoryList(rule: Rule, _typeIds: string[], page = 1): Promise<SearchItem[]> {
  const json = await fetchJson<any>(BASE + '/api/v1/movies?per_page=24&page=' + page, {
    timeoutMs: 15000,
    referer: BASE + '/',
  });
  return (json?.data ?? []).map((m: DdysMovie) => toItem(rule, m));
}

function parseEpisodes(url: string): Episode[] {
  const raw = url.trim();
  if (!raw) return [];
  const DOLLAR = String.fromCharCode(36);
  if (!raw.includes(DOLLAR) && !raw.includes('#')) {
    return [{ name: '正片', url: raw, quality: parseQuality(raw) }];
  }
  return raw
    .split('#')
    .map((seg) => {
      const i = seg.indexOf(DOLLAR);
      if (i < 0) return { name: '正片', url: seg.trim() };
      const name = seg.slice(0, i).trim() || '正片';
      const link = seg.slice(i + 1).trim();
      return { name, url: link };
    })
    .filter((e) => /^https?:/.test(e.url))
    .map((e) => ({ ...e, quality: parseQuality(e.name, e.url) }));
}

export interface PanLink {
  type: string;
  url: string;
  quality?: string;
  code?: string;
}

export async function detail(rule: Rule, id: string): Promise<DetailResult | null> {
  const slug = encodeURIComponent(id);
  const [info, sources] = await Promise.all([
    fetchJson<any>(BASE + '/api/v1/movies/' + slug, { timeoutMs: 15000, referer: BASE + '/' }),
    fetchJson<any>(BASE + '/api/v1/movies/' + slug + '/sources', { timeoutMs: 15000, referer: BASE + '/' }).catch(() => null),
  ]);

  const movie: DdysMovie | undefined = info?.data;
  if (!movie) return null;

  const roads: Road[] = [];
  for (const src of sources?.data?.online ?? []) {
    const episodes = parseEpisodes(String(src.url ?? ''));
    if (!episodes.length) continue;
    roads.push({
      name: String(src.name || '线路'),
      episodes,
      bestQuality: maxQuality(episodes.map((e) => e.quality)),
    });
  }

  const pans: PanLink[] = (sources?.data?.download ?? []).map((x: any) => ({
    type: String(x.download_type || 'pan'),
    url: String(x.url || ''),
    quality: x.quality ? String(x.quality) : undefined,
    code: x.extract_code ? String(x.extract_code) : undefined,
  }));

  return {
    source: rule.id,
    sourceName: rule.name,
    id,
    title: movie.title,
    year: movie.year ? String(movie.year) : undefined,
    area: movie.region,
    genre: [movie.type, ...(movie.genres || []).map((g) => g.name)].filter(Boolean).join(' · '),
    remarks: movie.is_completed ? '已完结' : undefined,
    pic: movie.poster,
    intro: String(movie.intro ?? '').replace(/<[^>]+>/g, '').trim(),
    director: movie.director,
    actors: movie.actors,
    roads: roads.sort((a, b) => b.bestQuality.height - a.bestQuality.height),
    panLinks: pans,
  };
}
