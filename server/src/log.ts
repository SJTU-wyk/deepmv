/**
 * 结构化日志。
 *
 * 目标是「能看出问题」，不是「记录一切」。
 * Render 免费实例的控制台是按行收费的（额度有限），刷屏会影响排查。
 *
 * 规则：
 *   - 请求日志只记耗时超过阈值的，或者出错的
 *   - 上游调用只记失败和慢的
 *   - 缓存命中率每 5 分钟汇总一行，不是每个请求一行
 *   - 永远不记 DEEPMV_KEY、Authorization、Cookie
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const configured = (process.env.DEEPMV_LOG_LEVEL || 'info').toLowerCase() as Level;
const threshold = LEVELS[configured] ?? LEVELS.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), msg];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === '') continue;
      parts.push(key + '=' + String(value));
    }
  }
  const line = parts.join(' ');
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/** 慢请求阈值：超过才打一行。正常请求不打。 */
export const SLOW_REQUEST_MS = Number(process.env.DEEPMV_SLOW_MS || 1500);

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),

  request(method: string, path: string, status: number, ms: number, extra?: Record<string, unknown>) {
    if (status >= 500) return emit('error', 'request', { method, path, status, ms, ...extra });
    if (status >= 400) return emit('warn', 'request', { method, path, status, ms, ...extra });
    if (ms >= SLOW_REQUEST_MS) return emit('warn', 'slow-request', { method, path, status, ms, ...extra });
    emit('debug', 'request', { method, path, status, ms, ...extra });
  },

  upstream(source: string, ok: boolean, ms: number, detail?: string) {
    if (ok) {
      if (ms >= 4000) emit('warn', 'slow-upstream', { source, ms });
      else emit('debug', 'upstream', { source, ms });
      return;
    }
    emit('warn', 'upstream-failed', { source, ms, detail });
  },

  cache(kind: string, hits: number, misses: number, coalesced: number, entries: number) {
    const total = hits + misses;
    const rate = total > 0 ? Math.round((hits / total) * 100) : 0;
    emit('info', 'cache', { kind, hitRate: rate + '%', hits, misses, coalesced, entries });
  },
};
