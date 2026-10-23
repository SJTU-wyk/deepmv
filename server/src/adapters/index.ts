import * as maccms from './maccms.js';
import * as xpath from './xpath.js';
import * as archive from './archive.js';
import * as ddys from './ddys.js';
import { type Rule, type SearchItem, type DetailResult } from '../types.js';

export interface Adapter {
  search(rule: Rule, keyword: string, page?: number): Promise<SearchItem[]>;
  detail(rule: Rule, id: string): Promise<DetailResult | null>;
}

const adapters: Record<string, Adapter> = { maccms, xpath, archive, ddys };

export function getAdapter(rule: Rule): Adapter {
  return adapters[rule.adapter] ?? maccms;
}