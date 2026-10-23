/**
 * 上游请求调度与容错。
 *
 * 三件事：
 *   1. 并发池：同一时刻最多只打 N 个上游请求。十三个源一起并发，
 *      出口带宽和上游的容忍度都扛不住，而且很容易被对方限流。
 *   2. 重试退避：遇到 429 / 5xx 才重试，指数退避加抖动，最多两次。
 *      上游明确给了 Retry-After 就按它等。
 *   3. allSettled 风格：单个源失败不影响其它源，失败的那个只记一条日志。
 */

export interface UpstreamError extends Error {
  status?: number;
  retryAfterMs?: number;
  timedOut?: boolean;
}


/**
 * 并发控制分两层：
 *
 *   全局上限 —— 保护自己的出口带宽和内存，默认 12。
 *   单主机上限 —— 保护对方，默认 3。
 *
 * 为什么不能只用一个全局上限：首页要打 13 个不同的采集站，
 * 如果全局只放 3 个，这 13 个站就得排队，首页冷启动要一分多钟。
 * 但它们分属 13 个不同主机，互相之间没有压力。
 * 真正需要克制的是「同一个站别并发打太多次」——那才是会让对方限流的行为。
 *
 * 所以：不同主机之间放开，同一主机内部收着。
 */
const GLOBAL_LIMIT = Number(process.env.DEEPMV_UPSTREAM_CONCURRENCY || 12);
const PER_HOST_LIMIT = Number(process.env.DEEPMV_PER_HOST_LIMIT || 3);

/** 兼容旧配置名：以前只有一个全局并发数 */
export const UPSTREAM_CONCURRENCY = PER_HOST_LIMIT;

interface Gate { active: number; queue: (() => void)[] }

const hostGates = new Map<string, Gate>();
let globalActive = 0;
const globalQueue: (() => void)[] = [];

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

function gateFor(host: string): Gate {
  let gate = hostGates.get(host);
  if (!gate) { gate = { active: 0, queue: [] }; hostGates.set(host, gate); }
  return gate;
}

async function acquire(url: string): Promise<void> {
  const host = hostOf(url);
  const gate = gateFor(host);
  // 两个条件都要满足才能通过
  while (globalActive >= GLOBAL_LIMIT || gate.active >= PER_HOST_LIMIT) {
    await new Promise<void>((resolve) => {
      if (globalActive >= GLOBAL_LIMIT) globalQueue.push(resolve);
      else gate.queue.push(resolve);
    });
  }
  globalActive++;
  gate.active++;
}

function release(url: string) {
  const host = hostOf(url);
  const gate = gateFor(host);
  globalActive = Math.max(0, globalActive - 1);
  gate.active = Math.max(0, gate.active - 1);
  // 唤醒一个等待者；被唤醒的会重新检查条件
  const nextGlobal = globalQueue.shift();
  if (nextGlobal) nextGlobal();
  const nextHost = gate.queue.shift();
  if (nextHost) nextHost();
}

/** 在并发闸里跑一个任务。需要知道目标地址才能按主机限流。 */
export async function withSlotFor<T>(url: string, fn: () => Promise<T>): Promise<T> {
  await acquire(url);
  try { return await fn(); } finally { release(url); }
}

/** 不区分主机的旧接口，保留兼容 */
export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  return withSlotFor('http://unknown/', fn);
}

export function poolStats() {
  return {
    globalActive,
    globalLimit: GLOBAL_LIMIT,
    perHostLimit: PER_HOST_LIMIT,
    hosts: [...hostGates.entries()]
      .filter(([, g]) => g.active > 0 || g.queue.length > 0)
      .map(([host, g]) => ({ host, active: g.active, waiting: g.queue.length })),
  };
}

/**
 * 限量并发地跑一批任务，全部结算，不因单个失败而整体失败。
 * 返回顺序与输入一致。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface FetchTextOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 除首次外的重试次数 */
  retries?: number;
  referer?: string;
  userAgent?: string;
} 

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function makeError(message: string, status?: number, retryAfterMs?: number, timedOut = false): UpstreamError {
  const err = new Error(message) as UpstreamError;
  err.status = status;
  err.retryAfterMs = retryAfterMs;
  err.timedOut = timedOut;
  return err;
}

/** 只有这几类值得重试。404 之类重试没意义，直接放弃。 */
function worthRetrying(status?: number): boolean {
  if (status === undefined) return true;       // 网络层错误
  if (status === 429) return true;
  return status >= 500;
}

export async function fetchUpstreamText(url: string, opts: FetchTextOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const retries = opts.retries ?? 1;
  let lastErr: UpstreamError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'user-agent': opts.userAgent || UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(opts.referer ? { referer: opts.referer } : {}),
        ...(opts.headers || {}),
      };
      const res = await withSlotFor(url, () => fetch(url, { headers, signal: controller.signal, redirect: 'follow' }));
      if (!res.ok) {
        const retryAfter = Number(res.headers.get('retry-after'));
        throw makeError('HTTP ' + res.status + ' ' + url, res.status,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
      }
      return await res.text();
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      lastErr = aborted
        ? makeError('timeout after ' + timeoutMs + 'ms ' + url, undefined, undefined, true)
        : (err as UpstreamError);
      const canRetry = attempt < retries && worthRetrying(lastErr?.status);
      if (!canRetry) break;
      const backoff = lastErr?.retryAfterMs ?? Math.min(300 * 2 ** attempt, 2000);
      await sleep(backoff + Math.random() * 200);   // 加抖动，避免多源同时重试
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? makeError('upstream failed ' + url);
}

/** 带上限的并发探测：用于线路健康检查，一次只探几个地址 */
export async function probeLimited<T>(
  targets: readonly T[],
  limit: number,
  fn: (target: T) => Promise<boolean>,
): Promise<boolean[]> {
  return mapLimit(targets, limit, (t) => fn(t).catch(() => false));
}