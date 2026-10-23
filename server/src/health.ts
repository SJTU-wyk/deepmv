import { caches } from './cache.js';
import { probeLimited } from './upstream.js';
import { log } from './log.js';

/**
 * 线路健康状态。
 *
 * 只做最基本的可用性判断：能不能连上、HTTP 状态码是不是明显错误、
 * 返回内容是不是媒体清单。不做任何绕过访问控制的事——
 * 拿不到就是拿不到，标成「暂不可用」，让用户自己换一条。
 *
 * 三条约束：
 *   1. 不在用户每次访问时重探所有线路。结果进缓存，正例 30 分钟，反例 5 分钟。
 *   2. 一次请求最多探有限条，且走并发池，不暴力扫地址。
 *   3. 探测失败不影响页面 —— 线路照样列出来，只是标个「暂不可用」。
 */

export type HealthStatus = 'ok' | 'unverified' | 'unavailable';

export interface HealthResult {
  status: HealthStatus;
  /** HTTP 状态码，连不上就是 undefined */
  httpStatus?: number;
  /** 探测耗时 */
  ms: number;
  /** 失败原因，给日志和调试用，不直接给终端用户看 */
  detail?: string;
  /** 结果来自缓存的时间戳 */
  checkedAt: number;
}

const OK_TTL = Number(process.env.DEEPMV_HEALTH_TTL || 30 * 60_000);
const BAD_TTL = 5 * 60_000;

/** 单次请求里最多探几条线路，防止有人构造一个带几十条线路的详情页把上游打完 */
export const MAX_PROBES_PER_REQUEST = Number(process.env.DEEPMV_MAX_PROBES || 4);

const PROBE_TIMEOUT = Number(process.env.DEEPMV_PROBE_TIMEOUT || 6000);

function keyOf(url: string) {
  return 'health:' + url;
}

/** 同步读缓存，不发请求。用来给列表快速标注状态。 */
export function peekHealth(url: string): HealthResult | undefined {
  return caches.health.get<HealthResult>(keyOf(url));
}

/**
 * 探一条地址。
 * 只发 HEAD 不下载内容；对方不支持 HEAD 就退回带 Range 的 GET，取前几百字节。
 */
/**
 * 探一条地址。
 *
 * 两次尝试：
 *   第一次带 Range 只取前 512 字节，省流量；
 *   如果对方不支持 Range（400/416）或者干脆拒绝，第二次退回普通 GET 只看状态和头部。
 *
 * 超时单独判定：超时只说明这次没连上，不足以断定线路失效，
 * 所以记成 unverified 而不是 unavailable —— 免得把好线路标死。
 */
async function probeOne(url: string): Promise<HealthResult> {
  const started = Date.now();
  if (!/^https?:\/\//i.test(url)) {
    return { status: 'unavailable', ms: 0, detail: '非 http(s) 地址', checkedAt: Date.now() };
  }

  let origin = '';
  try { origin = new URL(url).origin + '/'; } catch { /* 上面已校验 */ }

  const attempt = async (useRange: boolean) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
    try {
      const headers: Record<string, string> = { accept: '*/*' };
      if (useRange) headers.range = 'bytes=0-512';
      if (origin) headers.referer = origin;

      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal, redirect: 'follow' });
      const status = res.status;
      const type = res.headers.get('content-type') || '';
      try { await res.body?.cancel(); } catch { /* 不需要内容 */ }
      return { status, type, aborted: false as const };
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      return { status: 0, type: '', aborted, error: String((err as Error).message || err) };
    } finally {
      clearTimeout(timer);
    }
  };

  let outcome = await attempt(true);
  // Range 被拒或连接失败，退回完整请求再试一次
  if (outcome.status === 0 || outcome.status === 400 || outcome.status === 416) {
    outcome = await attempt(false);
  }

  const ms = Date.now() - started;

  if (outcome.status === 0) {
    // 连不上：超时记未验证，其它错误记不可用
    return {
      status: outcome.aborted ? 'unverified' : 'unavailable',
      ms,
      detail: outcome.aborted ? '探测超时 ' + PROBE_TIMEOUT + 'ms（不足以判定失效）' : String(outcome.error || '连接失败').slice(0, 80),
      checkedAt: Date.now(),
    };
  }

  const { status } = outcome;
  if (status === 403 || status === 404 || status === 410) {
    return { status: 'unavailable', httpStatus: status, ms, detail: 'HTTP ' + status, checkedAt: Date.now() };
  }
  if (status === 429) {
    // 被限流说明地址是活的
    return { status: 'ok', httpStatus: status, ms, detail: 'HTTP 429（限流，地址有效）', checkedAt: Date.now() };
  }
  if (status >= 500) {
    // 5xx 是对方临时故障，不判定线路失效
    return { status: 'unverified', httpStatus: status, ms, detail: 'HTTP ' + status, checkedAt: Date.now() };
  }
  if (status >= 400) {
    return { status: 'unavailable', httpStatus: status, ms, detail: 'HTTP ' + status, checkedAt: Date.now() };
  }
  if (/\.m3u8(\?|$)/i.test(url) && /text\/html/i.test(outcome.type)) {
    return { status: 'unavailable', httpStatus: status, ms, detail: '返回 HTML 而非清单', checkedAt: Date.now() };
  }
  return { status: 'ok', httpStatus: status, ms, checkedAt: Date.now() };
}

/** 读缓存，没有就探一次并写缓存。 */
export async function checkHealth(url: string): Promise<HealthResult> {
  const cached = peekHealth(url);
  if (cached) return cached;

  // memo 保证同一个地址并发只探一次（详情页和 best-road 可能同时要）
  const result = await caches.health.memo(keyOf(url), BAD_TTL, () => probeOne(url));
  // memo 只能给一个 TTL，正反例要区分就再写一次
  caches.health.set(keyOf(url), result, result.status === 'ok' ? OK_TTL : BAD_TTL);
  log.debug('health', { url: url.slice(0, 60), status: result.status, ms: result.ms });
  return result;
}

/**
 * 批量探线路，限量并发，全部结算。
 * 返回 Map<url, HealthResult>，没探到的（超过上限的）不在里面。
 */
export async function checkMany(urls: readonly string[], limit = MAX_PROBES_PER_REQUEST): Promise<Map<string, HealthResult>> {
  const unique = [...new Set(urls)].filter(Boolean);
  const pending = unique.filter((u) => !peekHealth(u)).slice(0, limit);
  const cached = unique.filter((u) => peekHealth(u));

  // 已缓存的直接收进来
  const out = new Map<string, HealthResult>();
  for (const url of cached) {
    const hit = peekHealth(url);
    if (hit) out.set(url, hit);
  }
  if (!pending.length) return out;

  const results = await probeLimited(pending, Math.min(3, limit), async (url) => {
    const result = await checkHealth(url);
    out.set(url, result);
    return result.status === 'ok';
  });
  void results;
  return out;
}

/** 给一条地址的状态：没探过就是 unverified，不主动触发探测 */
export function statusOf(url: string): HealthStatus {
  return peekHealth(url)?.status ?? 'unverified';
}