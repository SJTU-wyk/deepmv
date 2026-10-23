import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Rule } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = process.env.DEEPMV_RULES_DIR || path.resolve(here, '../rules');

let cached: Rule[] | null = null;

function template(raw: any, defaults: any = {}): Rule {
  const base: Rule = {
    id: raw.id ?? raw.name,
    name: raw.name,
    version: raw.version ?? '1.0',
    author: raw.author ?? 'deepmv',
    type: raw.type ?? 'movie',
    baseUrl: raw.baseURL ?? raw.baseUrl ?? '',
    referer: raw.referer ?? raw.baseUrl ?? raw.baseURL ?? '',
    userAgent: raw.userAgent ?? '',
    adapter: raw.adapter ?? 'maccms',
    searchURL: raw.searchURL ?? '',
    searchList: raw.searchList ?? '',
    searchName: raw.searchName ?? '',
    searchResult: raw.searchResult ?? '',
    chapterRoads: raw.chapterRoads ?? '',
    chapterResult: raw.chapterResult ?? '',
    archiveQuery: raw.archiveQuery ?? 'mediatype:(movies) AND collection:(feature_films)',
    headers: raw.headers ?? {},
    enabled: raw.enabled !== false,
    bestQuality: raw.bestQuality ?? '1080P',
    note: raw.note ?? '',
    categoryMap: raw.categoryMap ?? {},
  };
  return { ...defaults, ...return_only_defined(base) } as Rule;
}

function return_only_defined<T extends object>(obj: T): T {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === '' || v === null || v === undefined) {
      if (k === 'userAgent' || k === 'referer' || k === 'categoryMap' || k === 'headers') out[k] = v;
      continue;
    }
    out[k] = v;
  }
  return out as T;
}

export function loadRules(): Rule[] {
  if (cached) return cached;
  const rules: Rule[] = [];
  try {
    const presets = JSON.parse(fs.readFileSync(path.join(RULES_DIR, 'presets.json'), 'utf8'));
    for (const item of presets) rules.push(template(item));
  } catch (err) {
    console.error('[rules] presets.json 读取失败', err);
  }
  // 用户自定义规则（Kazumi 兼容格式）
  try {
    const dir = path.join(RULES_DIR, 'custom');
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        for (const item of Array.isArray(data) ? data : [data]) {
          rules.push(template(item, { adapter: item.adapter ?? (item.chapterRoads ? 'xpath' : 'maccms') }));
        }
      }
    }
  } catch (err) {
    console.error('[rules] custom 规则读取失败', err);
  }
  cached = rules.filter((r) => r.enabled !== false);
  return cached;
}

export function reloadRules(): Rule[] { cached = null; return loadRules(); }

export function getRule(id: string): Rule | undefined {
  return loadRules().find((r) => r.id === id);
}
