import { fetchText, parseMaccmsXml, stripHtml, cacheGet, cacheSet } from '../http.js';
import { type Rule, type SearchItem, type DetailResult, type Road, type Episode, parseQuality, maxQuality } from '../types.js';

const CLASS_TTL = 6 * 60 * 60 * 1000;

export function apiBase(rule: Rule): string {
  const base = rule.baseUrl.replace(/\/+$/, '');
  if (base.includes('/api.php')) return base;
  return base + '/api.php/provide/vod/';
}

async function request(rule: Rule, params: Record<string, string>): Promise<{ list: any[]; classes: { id: string; name: string }[] }> {
  const api = apiBase(rule);
  const search = new URLSearchParams({ at: 'json', ...params });
  const url = api + (api.includes('?') ? '&' : '?') + search.toString();
  const text = await fetchText(url, {
    referer: rule.referer || rule.baseUrl,
    userAgent: rule.userAgent,
    headers: rule.headers,
    timeoutMs: 14000,
    retry: 1,
  });
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) return parseMaccmsXml(trimmed);
  const json = JSON.parse(trimmed);
  return { list: Array.isArray(json.list) ? json.list : [], classes: Array.isArray(json.class) ? json.class.map((c: any) => ({ id: String(c.type_id), name: String(c.type_name) })) : [] };
}

export async function getClasses(rule: Rule): Promise<{ id: string; name: string }[]> {
  const key = 'classes:' + rule.id;
  const cached = cacheGet<{ id: string; name: string }[]>(key, CLASS_TTL);
  if (cached) return cached;
  try {
    const { classes } = await request(rule, { ac: 'list' });
    if (classes.length) { cacheSet(key, classes); return classes; }
  } catch { /* ignore */ }
  return cached ?? [];
}

function toItem(rule: Rule, raw: any): SearchItem {
  const quality = parseQuality(raw.vod_name, raw.vod_remarks, raw.vod_play_note, raw.vod_state);
  return {
    source: rule.id,
    sourceName: rule.name,
    id: String(raw.vod_id ?? ''),
    title: String(raw.vod_name ?? '').trim(),
    year: raw.vod_year ? String(raw.vod_year) : raw.vod_pubdate ? String(raw.vod_pubdate).slice(0, 4) : undefined,
    area: raw.vod_area ? String(raw.vod_area) : undefined,
    genre: (raw.type_name ? String(raw.type_name) : '') + (raw.vod_class ? ' · ' + String(raw.vod_class) : ''),
    remarks: raw.vod_remarks ? String(raw.vod_remarks) : undefined,
    pic: raw.vod_pic ? String(raw.vod_pic) : undefined,
    score: raw.vod_douban_score && Number(raw.vod_douban_score) > 0
      ? String(raw.vod_douban_score)
      : raw.vod_score && Number(raw.vod_score) > 0 ? String(raw.vod_score) : undefined,
    quality,
  };
}

const ADULT_RE = /伦理|里番|三级|写真|两性|成人|激情|艳照|色情|18禁|限制级|情色|福利|av片|无码|有码|h漫/i;

/** 过滤成人分区条目（伦理片 / 里番 / 三级 等分区），保持片库干净 */
export function isAdult(raw: any): boolean {
  const blob = [raw.type_name, raw.vod_class, raw.vod_name].filter(Boolean).join(' ');
  return ADULT_RE.test(blob);
}

const normTitle = (s: string) => s.replace(/[\s·:：\-—_.,，、!！?？'"“”()（）\[\]【】]/g, '').replace(/(19|20)\d{2}$/, '').toLowerCase();

/** 相关性打分：100 完全一致，80 前缀，60 包含，40 副标题命中，0 不相关 */
export function relevanceScore(title: string, keyword: string, sub?: string): number {
  const t = normTitle(title);
  const k = normTitle(keyword);
  if (!k) return 100;
  if (t === k) return 100;
  if (t.startsWith(k)) return 80;
  if (t.includes(k)) return t.length - k.length <= 6 ? 60 : 30;
  const s = normTitle(sub ?? '');
  if (s.includes(k)) return 40;
  // 关键词被拆开写（如「绝命毒师 第五季」）时允许高比例字符命中
  let hit = 0;
  for (const ch of k) if (t.includes(ch)) hit++;
  return hit / k.length >= 0.85 && k.length >= 3 ? 20 : 0;
}

export async function search(rule: Rule, keyword: string, page = 1): Promise<SearchItem[]> {
  const { list } = await request(rule, { ac: 'detail', wd: keyword, pg: String(page) });
  return list
    .filter((x) => x && x.vod_id && !isAdult(x))
    .map((x) => ({ raw: x, score: relevanceScore(String(x.vod_name ?? ''), keyword, x.vod_sub) }))
    .filter((e) => e.score >= 60)
    .sort((a, b) => b.score - a.score)
    .map((e) => toItem(rule, e.raw));
}

export async function categoryList(rule: Rule, typeIds: string[], page = 1): Promise<SearchItem[]> {
  if (!typeIds.length) return [];
  const { list } = await request(rule, { ac: 'detail', t: typeIds.join(','), pg: String(page) });
  return list.filter((x) => x && x.vod_id && !isAdult(x)).map((x) => toItem(rule, x));
}

function splitEpisodes(roadName: string, chunk: string): Episode[] {
  return chunk
    .split('#')
    .map((seg) => {
      const idx = seg.indexOf('$');
      const name = idx >= 0 ? seg.slice(0, idx) : seg;
      const url = idx >= 0 ? seg.slice(idx + 1) : '';
      return { name: name.trim() || '正片', url: url.trim() };
    })
    .filter((e) => e.url.length > 0 && !/^\s*(no|空)$/i.test(e.name))
    .map((e) => ({ ...e, quality: parseQuality(e.name, roadName, e.url) }));
}

export function buildRoads(raw: any): Road[] {
  const froms = String(raw.vod_play_from ?? '').split('$$$');
  const urls = String(raw.vod_play_url ?? '').split('$$$');
  const notes = String(raw.vod_play_note ?? '').split('$$$');
  const roads: Road[] = [];
  for (let i = 0; i < urls.length; i++) {
    const name = (froms[i] || '线路' + (i + 1) + ':无标签').replace(/_/g, ' · ');
    const episodes = splitEpisodes(notes[i] || '', urls[i]);
    if (!episodes.length) continue;
    const usable = episodes.filter((e) => !/\/share\//.test(e.url));
    if (!usable.length) continue;
    roads.push({
      name,
      episodes,
      bestQuality: maxQuality(episodes.map((e) => e.quality)),
    });
  }
  return roads.sort((a, b) => b.bestQuality.height - a.bestQuality.height || b.episodes.length - a.episodes.length);
}

export async function detail(rule: Rule, id: string): Promise<DetailResult | null> {
  const key = 'detail:' + rule.id + ':' + id;
  const cached = cacheGet<DetailResult>(key, 10 * 60 * 1000);
  if (cached) return cached;
  const { list } = await request(rule, { ac: 'detail', ids: id });
  const raw = list[0];
  if (!raw) return null;
  // 直接以 id 打开详情时也要过一遍成人分区过滤（搜索结果那条路径已经过滤过）
  if (isAdult(raw)) return null;
  const item = toItem(rule, raw);
  const result: DetailResult = {
    source: rule.id,
    sourceName: rule.name,
    id,
    title: item.title,
    year: item.year,
    area: item.area,
    genre: item.genre,
    remarks: item.remarks,
    pic: item.pic,
    intro: stripHtml(raw.vod_content || raw.vod_blurb),
    actors: String(raw.vod_actor ?? ''),
    director: String(raw.vod_director ?? ''),
    roads: buildRoads(raw),
  };
  cacheSet(key, result);
  return result;
}

export async function latest(rule: Rule, page = 1): Promise<SearchItem[]> {
  const { list } = await request(rule, { ac: 'detail', pg: String(page) });
  return list.filter((x) => x && x.vod_id).map((x) => toItem(rule, x));
}