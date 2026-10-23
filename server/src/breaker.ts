/**
 * 上游熔断器。
 *
 * 问题：有 3 个源在国内能用、在海外必然超时。每次搜索都要等它们各自超时，
 * 而并发池只有 3 个槽位，这些必然失败的请求会把槽位占满，把能用的源挤到后面。
 * 实测冷搜索要 24 秒，其中大半时间花在等这几个源失败。
 *
 * 做法：连续失败到一定次数就暂时把它摘出去，过一段时间再放回来试。
 * 半开状态只放一个请求试探，成功了才算恢复。
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

interface Record {
  failures: number;
  openedAt: number;
  state: BreakerState;
  lastError?: string;
  lastMs: number;
}

const FAIL_THRESHOLD = Number(process.env.DEEPMV_BREAKER_THRESHOLD || 3);
const COOLDOWN_MS = Number(process.env.DEEPMV_BREAKER_COOLDOWN || 5 * 60_000);

const records = new Map<string, Record>();

function get(id: string): Record {
  let rec = records.get(id);
  if (!rec) { rec = { failures: 0, openedAt: 0, state: 'closed', lastMs: 0 }; records.set(id, rec); }
  return rec;
}

/** 这个源现在能不能用 */
export function available(id: string): boolean {
  const rec = get(id);
  if (rec.state === 'closed') return true;
  if (rec.state === 'half-open') return true;
  // open 状态等冷却期过去
  if (Date.now() - rec.openedAt >= COOLDOWN_MS) {
    rec.state = 'half-open';
    return true;
  }
  return false;
}

export function recordSuccess(id: string, ms: number) {
  const rec = get(id);
  rec.state = 'closed';
  rec.failures = 0;
  rec.lastError = undefined;
  rec.lastMs = ms;
}

export function recordFailure(id: string, error: string, ms: number) {
  const rec = get(id);
  rec.failures += 1;
  rec.lastError = error;
  rec.lastMs = ms;
  if (rec.failures >= FAIL_THRESHOLD) {
    rec.state = 'open';
    rec.openedAt = Date.now();
  }
}

export interface BreakerView {
  id: string;
  state: BreakerState;
  failures: number;
  lastMs: number;
  lastError?: string;
}

export function snapshot(): BreakerView[] {
  return [...records.entries()].map(([id, rec]) => ({
    id,
    state: rec.state,
    failures: rec.failures,
    lastMs: rec.lastMs,
    lastError: rec.lastError,
  }));
}

/**
 * 按当前状态给源排序：能用的、快的排前面。
 * 这样并发池的槽位优先给了靠谱的源，慢的排到后面自然不会拖住整体。
 */
export function sortByHealth<T extends { id: string }>(rules: T[]): T[] {
  return [...rules].sort((a, b) => {
    const ra = get(a.id);
    const rb = get(b.id);
    const bad = (r: Record) => (r.state === 'closed' ? 0 : 1);
    const byState = bad(ra) - bad(rb);
    if (byState !== 0) return byState;
    const fa = ra.state === 'closed' ? 0 : 1;
    const fb = rb.state === 'closed' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    // 都没出过错就按上一次的耗时排，快的优先
    return (ra.lastMs || 9999) - (rb.lastMs || 9999);
  });
}
