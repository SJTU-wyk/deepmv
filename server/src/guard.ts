/**
 * 运行模式、访问口令与限流。
 *
 * 运行模式：
 *   local  —— 只在自己电脑上跑。全开，不限流。
 *   public —— 部署到公网。关掉开放代理，加限流，可选口令。
 *
 * 限流的设计原则：
 *
 *   普通浏览不能随便撞到 429。一个人打开首页、翻两下分类、搜几个片名，
 *   这是最正常的使用方式，不应该被判成异常。
 *
 *   首页一次加载会打出十几个请求（11 个分区的数据 + 一批海报图）。
 *   如果按「每 IP 每分钟 N 次请求」这种朴素计数来限，正常用户第一次打开就被限死了。
 *   所以按「成本」算：海报图走本地缓存，成本 0；首页数据成本 1；
 *   搜索要打十几个上游，成本 4。
 *
 *   两道闸：
 *     总预算   —— 保护本机 CPU 和出口带宽
 *     昂贵接口 —— 保护上游，搜索这类接口单独一个更小的额度
 *
 *   真的有人高频刷，两道闸都会拦住，并且日志里能看到。
 */

export type Mode = 'local' | 'public';

export const MODE: Mode = (process.env.DEEPMV_MODE as Mode) === 'public' ? 'public' : 'local';

/** 公网模式下默认禁止开放代理；要开必须显式 ALLOW_PROXY=1 */
export const ALLOW_PROXY = process.env.ALLOW_PROXY === '1' || MODE === 'local';

/** 可选共享口令：设置后所有 /api/* 需要带 ?key= 或 X-DeepMV-Key 头。不设就是公开访问。 */
const ACCESS_KEY = (process.env.DEEPMV_KEY || '').trim();

export const accessKeyEnabled = () => ACCESS_KEY.length > 0;

/** 允许的跨域来源，逗号分隔；* 或留空表示全放开 */
const CORS_ORIGINS = (process.env.DEEPMV_CORS || '').trim();

export const corsConfig = (): any => {
  if (MODE === 'local') return { origin: true };
  const list = CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.includes('*')) return { origin: true };
  return { origin: list };
};

export function checkAccess(headers: Record<string, unknown>, query: Record<string, unknown>): { ok: boolean; reason?: string } {
  if (!ACCESS_KEY) return { ok: true };
  const provided = String(query?.key ?? headers['x-deepmv-key'] ?? '');
  if (provided && provided === ACCESS_KEY) return { ok: true };
  return { ok: false, reason: '需要访问口令' };
}

/**
 * 各接口的成本权重。
 * 0 = 不计数（本地缓存或极轻量）；数字越大，越消耗服务器和上游。
 */
const PATH_COST: [RegExp, number][] = [
  [/^\/api\/health$/, 0],
  [/^\/api\/img$/, 0],          // 海报：走磁盘缓存，不该计入
  [/^\/api\/sources$/, 1],
  [/^\/api\/home$/, 1],
  [/^\/api\/collections$/, 1],
  [/^\/api\/share\/rules/, 1],
  [/^\/api\/detail\//, 2],
  [/^\/api\/best-road\//, 2],
  [/^\/api\/quality\//, 2],
  [/^\/api\/probe$/, 2],
  [/^\/api\/resolve$/, 2],
  [/^\/api\/search$/, 4],       // 搜索要打十几个上游，最贵
  [/^\/api\/best$/, 4],
  [/^\/api\/proxy$/, 2],
];

function costOf(path: string): number {
  for (const [re, cost] of PATH_COST) if (re.test(path)) return cost;
  return 1;
}

/** 总预算：每分钟每 IP 多少个成本点 */
const BUDGET = Number(process.env.DEEPMV_RATE || 240);
/** 昂贵接口单独额度：每分钟每 IP 多少个成本点 */
const EXPENSIVE_BUDGET = Number(process.env.DEEPMV_EXPENSIVE_RATE || 60);
const WINDOW = 60_000;

interface Bucket { used: number; at: number }

function makeBucketStore() {
  const map = new Map<string, Bucket>();
  let lastSweep = Date.now();
  return {
    /** 扣额度。额度不够返回 false，并给出还要等几秒 */
    charge(ip: string, cost: number, limit: number): { ok: boolean; retryAfter?: number } {
      if (cost <= 0) return { ok: true };
      const now = Date.now();
      // 顺手清掉过期桶，避免长期运行后 Map 里堆满老 IP
      if (now - lastSweep > WINDOW * 5) {
        for (const [key, value] of map) if (now - value.at > WINDOW) map.delete(key);
        lastSweep = now;
      }
      const bucket = map.get(ip);
      if (!bucket || now - bucket.at > WINDOW) {
        map.set(ip, { used: cost, at: now });
        return { ok: true };
      }
      if (bucket.used + cost > limit) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((WINDOW - (now - bucket.at)) / 1000)) };
      }
      bucket.used += cost;
      return { ok: true };
    },
    size: () => map.size,
  };
}

const totalStore = makeBucketStore();
const expensiveStore = makeBucketStore();

/** 公网模式下这些接口关闭：它们会替用户去访问任意源，成本和安全都顶不住 */
export const PUBLIC_BLOCKED = new Set(['/api/proxy']);

export interface LimitReport {
  allowed: boolean;
  reason?: string;
  retryAfter?: number;
  status?: 403 | 429;
  cost?: number;
}

const OPEN_PATHS = new Set(['/api/health']);

export function evaluate(
  path: string,
  ip: string,
  headers: Record<string, unknown>,
  query: Record<string, unknown>,
): LimitReport {
  if (MODE === 'local') return { allowed: true };
  if (OPEN_PATHS.has(path)) return { allowed: true };

  if (PUBLIC_BLOCKED.has(path) && !ALLOW_PROXY) {
    return { allowed: false, reason: '该接口在公网模式下关闭', status: 403 };
  }

  // 口令是「开关」不是「限流」：设了才校验，没设就是公开站点
  const access = checkAccess(headers, query);
  if (!access.ok) return { allowed: false, reason: access.reason, status: 403 };

  const cost = costOf(path);
  if (cost <= 0) return { allowed: true, cost };

  const total = totalStore.charge(ip, cost, BUDGET);
  if (!total.ok) {
    return { allowed: false, reason: '访问过于频繁，请稍后再试', retryAfter: total.retryAfter, status: 429, cost };
  }

  // 搜索这类接口再走一道更小的额度，防止有人刷爆上游
  if (cost >= 4) {
    const expensive = expensiveStore.charge(ip, cost, EXPENSIVE_BUDGET);
    if (!expensive.ok) {
      return { allowed: false, reason: '搜索请求过于频繁，请稍后再试', retryAfter: expensive.retryAfter, status: 429, cost };
    }
  }

  return { allowed: true, cost };
}

export function clientIp(headers: Record<string, unknown>, socketIp: string): string {
  const fwd = String(headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || String(headers['x-real-ip'] ?? '') || socketIp || 'unknown';
}

export function limiterStats() {
  return {
    mode: MODE,
    budget: BUDGET,
    expensiveBudget: EXPENSIVE_BUDGET,
    trackedIps: totalStore.size(),
    accessKey: accessKeyEnabled(),
  };
}