/**
 * 运行模式与访问控制。
 *
 * local  —— 只在自己电脑上跑：全开，不做任何限制。
 * public —— 部署到公网服务器给别人用：默认关掉开放代理，加限流，可选 token。
 *
 * 为什么必须区分：/api/proxy 是一个「替任何人去取任意 URL」的接口，
 * 放在公网上就是开放代理（别人可以拿它刷流量、当跳板、穿透内网）。
 * 而视频代理的流量极大，一台免费额度的小机器撑不过一天。
 */
export type Mode = 'local' | 'public';

export const MODE: Mode = (process.env.DEEPMV_MODE as Mode) === 'public' ? 'public' : 'local';

/** 公网模式下默认禁止开放代理；要开必须显式 ALLOW_PROXY=1 */
export const ALLOW_PROXY = process.env.ALLOW_PROXY === '1' || MODE === 'local';

/** 可选共享口令：设置后所有 /api/* 需要带 ?key= 或 X-DeepMV-Key 头 */
const ACCESS_KEY = (process.env.DEEPMV_KEY || '').trim();

/** 允许的跨域来源，逗号分隔；* 表示全放开 */
const CORS_ORIGINS = (process.env.DEEPMV_CORS || '').trim();

export const corsConfig = (): any => {
  if (MODE === 'local') return { origin: true };
  const list = CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.includes('*')) return { origin: true };
  return { origin: list };
};

export function checkAccess(headers: Record<string, any>, query: Record<string, any>): { ok: boolean; reason?: string } {
  if (!ACCESS_KEY) return { ok: true };
  const provided = String(query?.key ?? headers['x-deepmv-key'] ?? '');
  if (provided && provided === ACCESS_KEY) return { ok: true };
  return { ok: false, reason: '需要访问口令' };
}

/** 极简令牌桶：每个 IP 每分钟 N 次。免费小机器扛不住并发探测，这是第一道闸。 */
const buckets = new Map<string, { tokens: number; at: number }>();
const RATE = Number(process.env.DEEPMV_RATE || (MODE === 'public' ? 90 : 100000));
const WINDOW = 60_000;

export function rateLimit(ip: string): { ok: boolean; retryAfter?: number } {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.at > WINDOW) {
    buckets.set(ip, { tokens: RATE - 1, at: now });
    return { ok: true };
  }
  if (bucket.tokens <= 0) return { ok: false, retryAfter: Math.ceil((WINDOW - (now - bucket.at)) / 1000) };
  bucket.tokens -= 1;
  return { ok: true };
}

/** 公网模式下这些接口不开放：它们会替用户去访问任意源，成本与安全都顶不住 */
export const PUBLIC_BLOCKED = new Set(['/api/proxy']);

export interface LimitReport { allowed: boolean; reason?: string; retryAfter?: number }

const OPEN_PATHS = new Set(['/api/health']);

export function evaluate(path: string, ip: string, headers: Record<string, any>, query: Record<string, any>): LimitReport {
  if (MODE === 'local') return { allowed: true };
  if (OPEN_PATHS.has(path)) return { allowed: true };
  if (PUBLIC_BLOCKED.has(path) && !ALLOW_PROXY) {
    return { allowed: false, reason: '该接口在公网模式下关闭：视频代理请在本地运行' };
  }
  const access = checkAccess(headers, query);
  if (!access.ok) return { allowed: false, reason: access.reason };
  const rate = rateLimit(ip);
  if (!rate.ok) return { allowed: false, reason: '请求过于频繁', retryAfter: rate.retryAfter };
  return { allowed: true };
}

export function clientIp(headers: Record<string, any>, socketIp: string): string {
  const fwd = String(headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || String(headers['x-real-ip'] ?? '') || socketIp || 'unknown';
}