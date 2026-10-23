import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「规则 + 采集源」共享机制。
 *
 * Kazumi 的规则仓库是放在 GitHub 上的 JSON 文件集合，PR 合并后自动生成 index.json。
 * DeepMV 沿用同一套思路：
 *   GET  /api/share/rules            规则目录（客户端拉取用）
 *   GET  /api/share/rules/:id        单条规则
 *   POST /api/share/rules            上传/更新（需要 DEEPMV_KEY）
 *
 * 别人不需要登录，只要有一个 rule id 就能用。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SHARE_DIR = process.env.DEEPMV_SHARE_DIR || path.resolve(here, '../share');

function dir(): string {
  const d = path.join(SHARE_DIR, 'rules');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

export interface SharedRuleSummary {
  id: string;
  name: string;
  version?: string;
  adapter?: string;
  baseUrl?: string;
  author?: string;
  note?: string;
  updatedAt?: number;
}

export function listSharedRules(): SharedRuleSummary[] {
  const d = dir();
  const out: SharedRuleSummary[] = [];
  for (const file of readdirSync(d)) {
    if (!file.endsWith('.json')) continue;
    try {
      const rule = JSON.parse(readFileSync(path.join(d, file), 'utf8'));
      out.push({
        id: rule.id ?? file.replace(/\.json$/, ''),
        name: rule.name ?? '',
        version: rule.version,
        adapter: rule.adapter,
        baseUrl: rule.baseURL ?? rule.baseUrl,
        author: rule.author,
        note: rule.note,
        updatedAt: rule.updatedAt,
      });
    } catch { /* 跳过坏文件 */ }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function readSharedRule(id: string): any | null {
  const safe = id.replace(/[^a-z0-9_-]/gi, '');
  const file = path.join(dir(), safe + '.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeSharedRule(rule: any): { ok: boolean; id?: string; error?: string } {
  if (!rule || typeof rule !== 'object') return { ok: false, error: '规则必须是对象' };
  const id = String(rule.id || rule.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!id) return { ok: false, error: '缺少 id 或 name' };
  const payload = { ...rule, id, updatedAt: Date.now() };
  writeFileSync(path.join(dir(), id + '.json'), JSON.stringify(payload, null, 2), 'utf8');
  return { ok: true, id };
}
