export interface Quality { height: number; label: string; }
export interface AltSource { source: string; sourceName: string; id: string; quality: Quality; }
export interface SearchItem {
  source: string; sourceName: string; id: string; title: string;
  year?: string; area?: string; genre?: string; remarks?: string; pic?: string;
  score?: string; quality: Quality; alsoOn?: AltSource[];
}
export interface Episode { name: string; url: string; quality: Quality; }
export interface Road { name: string; episodes: Episode[]; bestQuality: Quality; }
export interface DetailResult {
  source: string; sourceName: string; id: string; title: string;
  year?: string; area?: string; genre?: string; remarks?: string; pic?: string;
  intro?: string; actors?: string; director?: string; roads: Road[];
}
export interface Section { key: string; title: string; subtitle: string; items: SearchItem[]; }
export interface SourceStat { id: string; name: string; count: number; ms: number; error?: string; }
export interface PlayCandidate {
  source: string; sourceName: string; id: string; title: string;
  road: string; episode: string; url: string;
  height: number; width: number; label: string; ok: boolean;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body.slice(0, 200) || 'HTTP ' + res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  home: (refresh = false) => get<{ sections: Section[]; generatedAt: number }>('/api/home' + (refresh ? '?refresh=1' : '')),
  search: (q: string, sources?: string[]) =>
    get<{ query: string; items: SearchItem[]; sources: SourceStat[] }>(
      '/api/search?q=' + encodeURIComponent(q) + (sources?.length ? '&sources=' + sources.join(',') : ''),
    ),
  detail: (source: string, id: string) =>
    get<DetailResult>('/api/detail/' + encodeURIComponent(source) + '/' + encodeURIComponent(id)),
  bestRoad: (source: string, id: string) =>
    get<{ best: PlayCandidate | null; roads: PlayCandidate[] }>('/api/best-road/' + encodeURIComponent(source) + '/' + encodeURIComponent(id)),
  best: (q: string, skip: string[] = []) =>
    get<{ query: string; best: PlayCandidate | null; alternatives: PlayCandidate[]; checked: number }>(
      '/api/best?q=' + encodeURIComponent(q) + (skip.length ? '&skip=' + skip.join(',') : ''),
    ),
  sources: () => get<{ sources: any[] }>('/api/sources'),
  collections: () => get<{ collections: any[] }>('/api/collections'),
  collection: (id: string, limit = 24) => get<any>('/api/collections/' + id + '?limit=' + limit),
  resolve: (url: string) => get<{ type: string; url: string; source?: string; sniffed?: any[] }>('/api/resolve?url=' + encodeURIComponent(url)),
  probe: (url: string) => get<any>('/api/probe?url=' + encodeURIComponent(url)),
};

export interface WatchRecord {
  source: string; sourceName: string; id: string; title: string; pic?: string;
  episode: string; url: string; road: string; quality: string; at: number;
}

const HISTORY_KEY = 'deepmv.history.v1';
const FAV_KEY = 'deepmv.favorites.v1';

export function readHistory(): WatchRecord[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

export function pushHistory(record: WatchRecord) {
  const list = readHistory().filter((r) => !(r.source === record.source && r.id === record.id && r.episode === record.episode));
  list.unshift(record);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 120)));
}

export function readFavorites(): WatchRecord[] {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch { return []; }
}

export function toggleFavorite(record: WatchRecord): boolean {
  const list = readFavorites();
  const idx = list.findIndex((r) => r.source === record.source && r.id === record.id);
  if (idx >= 0) { list.splice(idx, 1); localStorage.setItem(FAV_KEY, JSON.stringify(list)); return false; }
  list.unshift(record);
  localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 200)));
  return true;
}

export function isFavorite(source: string, id: string): boolean {
  return readFavorites().some((r) => r.source === source && r.id === id);
}
