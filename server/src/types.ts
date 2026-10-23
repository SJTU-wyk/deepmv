export type RuleMode = 'xpath' | 'api' | 'archive';

export interface CategoryMap {
  westernMovie?: string[];
  westernTv?: string[];
  cnMovie?: string[];
  cnTv?: string[];
  anime?: string[];
  fourK?: string[];
  doc?: string[];
  shaw?: string[];
  [key: string]: string[] | undefined;
}

export interface Rule {
  id: string;
  name: string;
  version: string;
  author?: string;
  type: 'movie' | 'tv' | 'anime' | 'variety';
  baseUrl: string;
  referer?: string;
  userAgent?: string;
  adapter: 'maccms' | 'xpath' | 'archive';
  searchURL?: string;
  searchList?: string;
  searchName?: string;
  searchResult?: string;
  chapterRoads?: string;
  chapterResult?: string;
  archiveQuery?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  bestQuality?: string;
  note?: string;
  /** 该源 CDN 是否给 CORS 头（浏览器可直连播放，跳过服务端中转） */
  cors?: boolean;
  categoryMap?: CategoryMap;
}

export interface Quality { height: number; label: string; }

export interface SearchItem {
  source: string;
  sourceName: string;
  id: string;
  title: string;
  year?: string;
  area?: string;
  genre?: string;
  remarks?: string;
  pic?: string;
  score?: string;
  quality: Quality;
  url?: string;
}

export interface Episode { name: string; url: string; quality: Quality; }

export interface Road { name: string; episodes: Episode[]; bestQuality: Quality; }

export interface DetailResult {
  source: string;
  sourceName: string;
  id: string;
  title: string;
  year?: string;
  area?: string;
  genre?: string;
  remarks?: string;
  pic?: string;
  intro?: string;
  actors?: string;
  director?: string;
  roads: Road[];
}

export const QUALITY_RANK = ['SD', '360P', '480P', '540P', '720P', '1080P', '2K', '4K', '8K'];

export function parseQuality(...texts: (string | undefined | null)[]): Quality {
  const blob = texts.filter(Boolean).join(' ').toLowerCase();
  const rules: [RegExp, number, string][] = [
    [/8k|4320p/, 4320, '8K'],
    [/4k|2160p|uhd/, 2160, '4K'],
    [/2k|1440p/, 1440, '2K'],
    [/1080p|fhd|全高清|hd1080/, 1080, '1080P'],
    [/720p/, 720, '720P'],
    [/540p/, 540, '540P'],
    [/480p/, 480, '480P'],
    [/360p/, 360, '360P'],
  ];
  for (const [re, height, label] of rules) if (re.test(blob)) return { height, label };
  // "HD/高清/超清/蓝光" 在采集站普遍等价于 1080P 线路
  if (/蓝光|bluray|blu-ray|bdrip|remux|hdr|超清|高清|\bhd\b/.test(blob)) return { height: 1080, label: '1080P' };
  return { height: 0, label: '未知' };
}

export function maxQuality(list: Quality[]): Quality {
  return list.reduce((a, b) => (b.height > a.height ? b : a), { height: 0, label: '未知' });
}

export function qualityScore(q: Quality, episodeCount = 0): number {
  return q.height * 1000 + Math.min(episodeCount, 200);
}