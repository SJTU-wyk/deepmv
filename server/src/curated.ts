import { loadRules } from './rules.js';
import * as maccms from './adapters/maccms.js';
import { mergeItems, type MergedItem, withTimeout } from './aggregate.js';
import { peekPicks } from './picks.js';
import { type SearchItem } from './types.js';

export interface Section {
  key: string;
  title: string;
  subtitle: string;
  items: MergedItem[];
}

type CategoryKey = 'westernMovie' | 'westernTv' | 'cnMovie' | 'cnTv' | 'fourK' | 'doc' | 'shaw' | 'anime';

interface SectionSpec {
  key: string;
  title: string;
  subtitle: string;
  categoryKey: CategoryKey;
  limit: number;
  maxYear?: number;
  minYear?: number;
  minScore?: number;
  keepArea?: RegExp;
}

const WEST = /美国|英国|法国|德国|意大利|西班牙|加拿大|澳大利亚|欧美|爱尔兰|瑞典|丹麦|挪威|荷兰|俄罗斯|波兰|比利时|新西兰|墨西哥|巴西|阿根廷|芬兰|奥地利|瑞士|冰岛|葡萄牙|希腊|捷克|匈牙利|以色列|南非/i;
const CN = /中国|大陆|香港|台湾|澳门|内地|华语/i;

interface PickSpec { key: string; title: string; subtitle: string; pickId: string; limit: number }

/** 片单型分区：来自人工整理的片单，多源解析，不依赖站点的年份/地区分类 */
const PICK_SPECS: PickSpec[] = [
  { key: 'cn-classic', title: '国产经典 · 修复级', subtitle: '华语影史名片，全源实时择优', pickId: 'cn-classic', limit: 24 },
  { key: 'cn-tv-classic', title: '国产剧 · 高分经典', subtitle: '四大名著 / 年代剧 / 封神国剧', pickId: 'cn-tv-classic', limit: 24 },
  { key: 'western-classic', title: '欧美影史名片', subtitle: '好莱坞黄金时代到当代作者电影', pickId: 'western-classic', limit: 24 },
  { key: 'western-tv-classic', title: '欧美剧 · 口碑长剧', subtitle: 'HBO / AMC / Netflix 高分剧集', pickId: 'western-tv-classic', limit: 24 },
];

const SPECS: SectionSpec[] = [
  { key: 'western-movie', title: '欧美电影', subtitle: '好莱坞 · 欧洲院线 · 高分优先', categoryKey: 'westernMovie', limit: 30, keepArea: WEST },
  { key: 'western-tv', title: '欧美剧集', subtitle: '美剧 · 英剧 · 口碑长剧', categoryKey: 'westernTv', limit: 30, keepArea: WEST },
  { key: 'cn-movie', title: '国产电影', subtitle: '大陆 · 港台 · 华语高分佳作', categoryKey: 'cnMovie', limit: 30, keepArea: CN },
  { key: 'cn-tv', title: '国产剧集', subtitle: '经典年代剧 · 现象级国剧', categoryKey: 'cnTv', limit: 30, keepArea: CN },
  { key: 'high-score', title: '高分精选', subtitle: '豆瓣 8.0 以上，跨分区精选', categoryKey: 'westernMovie', limit: 24, minScore: 8 },
  { key: 'shaw', title: '邵氏 & 港片', subtitle: '邵氏武侠 · 港片黄金年代', categoryKey: 'shaw', limit: 24 },
  { key: 'documentary', title: '纪录片', subtitle: '自然 · 历史 · 社会纪实', categoryKey: 'doc', limit: 18 },
];

const CACHE_TTL = 15 * 60 * 1000;
let cache: { at: number; data: Section[] } | null = null;

function scoreOf(item: SearchItem): number {
  const n = Number(item.score ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 排序：口碑优先（豆瓣分差 ≥0.3 才换位），其次画质，最后是多源覆盖度 */
function rank(items: SearchItem[]): MergedItem[] {
  return mergeItems(items).sort((a, b) => {
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    if (Math.abs(sb - sa) >= 0.3) return sb - sa;
    const dq = b.quality.height - a.quality.height;
    if (dq !== 0) return dq;
    return (b.alsoOn?.length ?? 0) - (a.alsoOn?.length ?? 0);
  });
}

/** 同一部剧的多个季只保留一条（优先评分高、季数新的），避免整行都是同一部剧 */
function dedupeSeries(items: SearchItem[]): SearchItem[] {
  const seen = new Map<string, SearchItem>();
  const order: string[] = [];
  for (const item of items) {
    const base = item.title
      .replace(/第[一二三四五六七八九十\d]+季/g, '')
      .replace(/season\s*\d+/gi, '')
      .replace(/[\s·:：\-—_]/g, '')
      .toLowerCase();
    const prev = seen.get(base);
    if (!prev) { seen.set(base, item); order.push(base); continue; }
    const betterScore = Number(item.score ?? 0) > Number(prev.score ?? 0);
    if (betterScore) seen.set(base, item);
  }
  return order.map((k) => seen.get(k)!).filter(Boolean);
}

let refreshing: Promise<Section[]> | null = null;

/** 后台刷新（stale-while-revalidate），同一时刻只跑一次 */
function refreshInBackground() {
  if (refreshing) return refreshing;
  refreshing = build()
    .catch(() => cache?.data ?? [])
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function getHomeSections(force = false): Promise<Section[]> {
  if (!force && cache) {
    const stale = Date.now() - cache.at >= CACHE_TTL;
    if (stale) void refreshInBackground();
    return cache.data;   // 有缓存立刻返回，过期也在后台换新
  }
  return build();
}

export async function warmHome(): Promise<void> {
  if (!cache) await refreshInBackground();
}

async function build(): Promise<Section[]> {
  const rules = loadRules();
  const sections: Section[] = [];
  for (const spec of SPECS) {
    const jobs: Promise<SearchItem[]>[] = [];
    for (const rule of rules) {
      const ids = rule.categoryMap?.[spec.categoryKey];
      if (!ids || !ids.length || rule.adapter !== 'maccms') continue;
      for (const pg of spec.key === 'high-score' ? [1, 2, 3, 4] : [1, 2]) {
        jobs.push(withTimeout(maccms.categoryList(rule, ids, pg), 15000, rule.name + ' 超时').catch(() => [] as SearchItem[]));
      }
    }
    const groups = await Promise.all(jobs);
    let items = groups.flat().filter((i) => !/解说|预告|花絮|短剧|片段|动态漫|资讯|综艺|脱口秀|专访/i.test(i.title))
      .filter((i) => !/综艺|真人秀/.test(i.genre ?? ''));
    if (spec.keepArea) items = items.filter((i) => !i.area || spec.keepArea!.test(i.area.replace(/[,\/、]/g, ' ')));
    if (spec.maxYear) items = items.filter((i) => i.year && Number(i.year) <= spec.maxYear!);
    if (spec.minYear) items = items.filter((i) => i.year && Number(i.year) >= spec.minYear!);
    if (spec.minScore) items = items.filter((i) => scoreOf(i) >= spec.minScore!);
    sections.push({ key: spec.key, title: spec.title, subtitle: spec.subtitle, items: dedupeSeries(rank(items)).slice(0, spec.limit) });
  }
  cache = { at: Date.now(), data: sections };
  return sections;
}

/** 片单分区在每次响应时动态拼装，预热完成即出现，不影响首页缓存 */
function pickSections(): Section[] {
  const out: Section[] = [];
  for (const spec of PICK_SPECS) {
    const picked = peekPicks(spec.pickId);
    const items: SearchItem[] = picked
      .filter((p) => p.item)
      .map((p) => ({
        source: p.item!.source,
        sourceName: p.item!.sourceName,
        id: p.item!.id,
        title: p.title,
        year: p.year ?? p.item!.year,
        area: p.item!.area,
        genre: p.item!.genre,
        remarks: p.item!.remarks,
        pic: p.item!.pic,
        score: p.item!.score,
        quality: p.item!.quality,
        alsoOn: p.item!.alsoOn,
      }));
    if (items.length) out.push({ key: spec.key, title: spec.title, subtitle: spec.subtitle, items: items.slice(0, spec.limit) });
  }
  return out;
}

/** 对外统一出口：基础分区 + 已预热好的片单分区 */
export async function getHomePublic(force = false): Promise<Section[]> {
  const base = await getHomeSections(force);
  const picks = pickSections();
  if (!picks.length) return base;
  // 片单分区排在基础分区之后，避免打乱「欧美电影」等首屏顺序
  const map = new Map(base.map((s) => [s.key, s]));
  for (const p of picks) map.set(p.key, p);
  const order = ['western-movie', 'western-tv', 'cn-movie', 'cn-tv', 'high-score', 'cn-classic', 'cn-tv-classic', 'western-classic', 'western-tv-classic', 'shaw', 'documentary'];
  return order.filter((k) => map.has(k)).map((k) => map.get(k)!);
}

export function invalidateHome() { cache = null; }