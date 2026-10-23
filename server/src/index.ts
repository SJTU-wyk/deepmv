import Fastify from 'fastify';
import cors from '@fastify/cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules, reloadRules, getRule } from './rules.js';
import { getAdapter } from './adapters/index.js';
import { searchAll, withTimeout } from './aggregate.js';
import { getHomePublic, invalidateHome, warmHome } from './curated.js';
import { getPicks, getPickOverview, startWarmup } from './picks.js';
import { bestPlay, bestRoadOf } from './resolve.js';
import { proxyFetch, toNodeStream, sniffFromPage, proxyPath, canPlayDirect } from './proxy.js';
import { probeHls, heightLabel } from './probe.js';
import { MODE, ALLOW_PROXY, corsConfig, evaluate, clientIp, limiterStats } from './guard.js';
import { listSharedRules, readSharedRule, writeSharedRule } from './share.js';
import { getImage } from './imgcache.js';
import { allCacheStats, startCacheSweeper } from './cache.js';
import { statusOf, checkMany, type HealthResult } from './health.js';
import { log } from './log.js';
import { snapshot as breakerSnapshot } from './breaker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7821);
// 监听地址。本地模式默认只绑回环，别人的机器连不上。
// 托管平台（Render / Fly）必须监听全网卡，漏设 DEEPMV_MODE 也能起来，不让人卡在健康检查上。
const ON_PLATFORM = !!(process.env.RENDER || process.env.FLY_APP_NAME || process.env.KOYEB_APP_NAME);
const HOST = process.env.HOST || (MODE === 'public' || ON_PLATFORM ? '0.0.0.0' : '127.0.0.1');
const VERSION = '0.2.0';

const app = Fastify({
  logger: false,
  bodyLimit: 2 * 1024 * 1024,
  trustProxy: MODE === 'public',
  requestTimeout: 60_000,
});

await app.register(cors, corsConfig());
const startedAt = Date.now();

/* ---------- 请求日志与限流 ---------- */

app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api')) return;
  const path = req.url.split('?')[0];
  const ip = clientIp(req.headers as any, req.ip);
  const verdict = evaluate(path, ip, req.headers as any, req.query as any);
  if (!verdict.allowed) {
    if (verdict.retryAfter) reply.header('retry-after', String(verdict.retryAfter));
    log.warn('blocked', { path, ip: ip.slice(0, 20), reason: verdict.reason, status: verdict.status });
    return reply.code(verdict.status ?? 403).send({ error: verdict.reason });
  }
});

app.addHook('onResponse', async (req, reply) => {
  if (!req.url.startsWith('/api')) return;
  const path = req.url.split('?')[0];
  log.request(req.method, path, reply.statusCode, Math.round(reply.elapsedTime));
});

/* ---------- 基础 ---------- */

app.get('/api/health', async () => ({
  ok: true,
  name: 'deepmv',
  version: VERSION,
  mode: MODE,
  proxy: ALLOW_PROXY,
  sources: loadRules().length,
  uptime: Math.round((Date.now() - startedAt) / 1000),
}));

/** 运维用的诊断接口。不暴露口令、不暴露上游地址细节。 */
app.get('/api/status', async () => ({
  version: VERSION,
  uptime: Math.round((Date.now() - startedAt) / 1000),
  memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  limit: limiterStats(),
  cache: allCacheStats(),
  breakers: breakerSnapshot(),
}));

app.get('/api/sources', async () => ({
  sources: loadRules().map((r) => ({
    id: r.id, name: r.name, version: r.version, adapter: r.adapter,
    baseUrl: r.baseUrl, bestQuality: r.bestQuality, note: r.note, enabled: r.enabled !== false,
  })),
}));

app.post('/api/sources/reload', async (_req, reply) => {
  if (MODE === 'public' && !process.env.DEEPMV_KEY) {
    return reply.code(403).send({ error: '公网模式未设置 DEEPMV_KEY，禁止重载规则' });
  }
  const rules = reloadRules();
  invalidateHome();
  log.info('rules-reloaded', { count: rules.length });
  return { ok: true, count: rules.length };
});

/* ---------- 首页与片单 ---------- */

app.get('/api/home', async (req) => {
  const force = (req.query as any)?.refresh === '1';
  const sections = await getHomePublic(force);
  return { sections, generatedAt: Date.now() };
});

app.get('/api/collections', async () => ({ collections: await getPickOverview() }));

app.get('/api/collections/:id', async (req, reply) => {
  const params = req.params as any;
  const limit = Number((req.query as any)?.limit ?? 24);
  const force = (req.query as any)?.refresh === '1';
  const data = await getPicks(params.id, limit, force);
  if (!data) return reply.code(404).send({ error: '片单不存在' });
  return data;
});

/* ---------- 搜索与详情 ---------- */

app.get('/api/search', async (req, reply) => {
  const q = String((req.query as any)?.q ?? '').trim();
  if (!q) return reply.code(400).send({ error: '缺少 q 参数' });
  const sources = String((req.query as any)?.sources ?? '').split(',').filter(Boolean);
  const result = await searchAll(q, sources.length ? sources : undefined);
  const filtered = result.items.filter((i) => !/解说|预告|花絮|片段/.test(i.title));
  return { query: q, items: filtered.length ? filtered : result.items, sources: result.sources };
});

app.get('/api/detail/:source/:id', async (req, reply) => {
  const { source, id } = req.params as { source: string; id: string };
  const rule = getRule(source);
  if (!rule) return reply.code(404).send({ error: '未知来源' });
  try {
    const adapter = getAdapter(rule);
    const detail = await withTimeout(adapter.detail(rule, decodeURIComponent(id)), 18000, '详情超时');
    if (!detail) return reply.code(404).send({ error: '未找到该条目' });
    // 带上已知的健康状态；没探过的就是 unverified，这里不触发探测
    const roads = detail.roads.map((road) => ({
      ...road,
      health: statusOf(road.episodes[0]?.url ?? ''),
    }));
    return { ...detail, roads };
  } catch (err) {
    log.warn('detail-failed', { source, id, detail: String((err as Error)?.message || err).slice(0, 80) });
    return reply.code(502).send({ error: '这个来源暂时取不到数据，换一个来源试试' });
  }
});

/**
 * 线路健康检查。
 * 一次最多探 MAX_PROBES_PER_REQUEST 条，且只探没缓存过的。
 * 探测失败不影响返回：线路照列，只是标成暂不可用。
 */
app.get('/api/health-check/:source/:id', async (req, reply) => {
  const { source, id } = req.params as { source: string; id: string };
  const rule = getRule(source);
  if (!rule) return reply.code(404).send({ error: '未知来源' });
  try {
    const adapter = getAdapter(rule);
    const detail = await withTimeout(adapter.detail(rule, decodeURIComponent(id)), 18000, '详情超时');
    if (!detail) return reply.code(404).send({ error: '未找到该条目' });
    const firstUrls = detail.roads.map((r) => r.episodes[0]?.url).filter((u): u is string => !!u);
    const results = await checkMany(firstUrls);
    const roads = detail.roads.map((road) => {
      const url = road.episodes[0]?.url ?? '';
      const health: HealthResult = results.get(url) ?? { status: 'unverified', ms: 0, checkedAt: Date.now() };
      return { name: road.name, episodes: road.episodes.length, health, bestQuality: road.bestQuality };
    });
    const order: Record<string, number> = { ok: 0, unverified: 1, unavailable: 2 };
    roads.sort((a, b) => (order[a.health.status] - order[b.health.status]) || (b.bestQuality.height - a.bestQuality.height));
    return { title: detail.title, roads };
  } catch {
    log.warn('health-check-failed', { source, id });
    return reply.code(502).send({ error: '检查线路时出错，请稍后再试' });
  }
});

app.get('/api/quality/:source/:id', async (req, reply) => {
  const { source, id } = req.params as { source: string; id: string };
  const rule = getRule(source);
  if (!rule) return reply.code(404).send({ error: '未知来源' });
  const adapter = getAdapter(rule);
  const detail = await adapter.detail(rule, decodeURIComponent(id));
  if (!detail) return reply.code(404).send({ error: '未找到该条目' });
  const roads = await Promise.all(detail.roads.map(async (road) => {
    const first = road.episodes[0];
    if (!first) return { name: road.name, real: null, episodes: 0, first: null };
    if (!/\.m3u8/i.test(first.url)) {
      return { name: road.name, real: { height: 0, label: '直链', width: 0, ok: true, variants: [] }, episodes: road.episodes.length, first: first.name };
    }
    const probed = await probeHls(first.url);
    return { name: road.name, real: probed, episodes: road.episodes.length, first: first.name };
  }));
  const best = roads.reduce((a, b) => ((b.real?.height ?? 0) > (a.real?.height ?? 0) ? b : a), roads[0]);
  return { title: detail.title, best, roads };
});

app.get('/api/probe', async (req, reply) => {
  const url = String((req.query as any)?.url ?? '');
  if (!/^https?:\/\//.test(url)) return reply.code(400).send({ error: '非法地址' });
  const result = await probeHls(url);
  return { ...result, label: result.label || heightLabel(result.height) };
});

/* ---------- 播放地址解析 ---------- */

app.get('/api/resolve', async (req, reply) => {
  const target = String((req.query as any)?.url ?? '');
  if (!/^https?:\/\//.test(target)) return reply.code(400).send({ error: '非法地址' });
  const forceProxy = (req.query as any)?.proxy === '1';
  const adblock = (req.query as any)?.adblock !== '0';
  try {
    let mediaUrl = target;
    let type: 'hls' | 'mp4' | 'page' = /\.m3u8/i.test(target) ? 'hls' : /\.(mp4|flv|webm)(\?|$)/i.test(target) ? 'mp4' : 'page';
    let sniffed: { url: string; type: 'hls' | 'mp4' }[] = [];

    if (type === 'page') {
      sniffed = await sniffFromPage(target);
      const hls = sniffed.find((s) => s.type === 'hls') ?? sniffed[0];
      if (!hls) return { type: 'page', url: target, sniffed: [], mode: 'none' };
      mediaUrl = hls.url;
      type = hls.type;
    }

    const directOk = !forceProxy && await canPlayDirect(mediaUrl);
    if (directOk && !adblock) return { type, url: mediaUrl, source: mediaUrl, mode: 'direct', sniffed: sniffed.slice(0, 6) };
    if (directOk && adblock) return { type, url: proxyPath(mediaUrl), source: mediaUrl, mode: 'manifest', sniffed: sniffed.slice(0, 6) };
    return { type, url: proxyPath(mediaUrl), source: mediaUrl, mode: 'proxy', sniffed: sniffed.slice(0, 6) };
  } catch (err) {
    log.warn('resolve-failed', { detail: String((err as Error)?.message || err).slice(0, 80) });
    return reply.code(502).send({ error: '解析播放地址失败，换个线路试试' });
  }
});

app.get('/api/best', async (req, reply) => {
  const q = String((req.query as any)?.q ?? '').trim();
  if (!q) return reply.code(400).send({ error: '缺少 q 参数' });
  const exclude = (req.query as any)?.exclude as string | undefined;
  const excludeList = String((req.query as any)?.skip ?? '').split(',').filter(Boolean);
  try {
    return await withTimeout(bestPlay(q, { excludeSource: exclude, exclude: excludeList }), 45000, 'best timeout');
  } catch {
    return { query: q, best: null, alternatives: [], checked: 0, probed: 0 };
  }
});

app.get('/api/best-road/:source/:id', async (req, reply) => {
  const { source, id } = req.params as { source: string; id: string };
  try {
    return await withTimeout(bestRoadOf(source, decodeURIComponent(id)), 30000, 'probe timeout');
  } catch {
    return { best: null, roads: [] };
  }
});

/* ---------- 代理与图片 ---------- */

app.get('/api/proxy', async (req, reply) => {
  const target = String((req.query as any)?.u ?? '');
  if (!/^https?:\/\//.test(target)) return reply.code(400).send({ error: '非法地址' });
  try {
    const adblock = (req.query as any)?.adblock !== '0';
    const result = await proxyFetch(target, req.headers.range as string | undefined, { adblock });
    if (result.adReport && result.adReport.removedSegments > 0) {
      reply.header('x-deepmv-ads-removed', String(result.adReport.removedSegments));
      reply.header('x-deepmv-ads-seconds', String(Math.round(result.adReport.removedSeconds)));
    }
    for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
    if (result.isManifest) return reply.code(200).send(result.body);
    return reply.code(result.status).send(toNodeStream(result.body as ReadableStream<Uint8Array>));
  } catch {
    return reply.code(502).send({ error: '拉取片段失败' });
  }
});

app.get('/api/img', async (req, reply) => {
  const target = String((req.query as any)?.u ?? '');
  if (!/^https?:\/\//.test(target)) return reply.code(400).send({ error: '非法地址' });
  const img = await getImage(target);
  if (!img) return reply.code(404).send({ error: '取图失败' });
  return reply
    .header('content-type', img.contentType)
    .header('access-control-allow-origin', '*')
    .header('cache-control', 'public, max-age=604800, immutable')
    .header('x-deepmv-cache', img.hit ? 'HIT' : 'MISS')
    .send(img.bytes);
});

/* ---------- 规则共享 ---------- */

app.get('/api/share/rules', async () => ({ rules: listSharedRules() }));

app.get('/api/share/rules/:id', async (req, reply) => {
  const rule = readSharedRule((req.params as any).id);
  if (!rule) return reply.code(404).send({ error: '规则不存在' });
  return rule;
});

app.post('/api/share/rules', async (req, reply) => {
  if (MODE === 'public' && !process.env.DEEPMV_KEY) {
    return reply.code(403).send({ error: '公网模式未设置 DEEPMV_KEY，禁止写入' });
  }
  const result = writeSharedRule(req.body);
  if (!result.ok) return reply.code(400).send({ error: result.error });
  reloadRules();
  return result;
});

/* ---------- 兜底错误 ---------- */

app.setErrorHandler((err, req, reply) => {
  log.error('unhandled', { path: req.url.split('?')[0], detail: String((err as Error)?.message || err).slice(0, 120) });
  reply.code(500).send({ error: '服务器出了点问题，请稍后再试' });
});

/* ---------- 静态资源 ---------- */

const webDist = path.resolve(here, '../../web/dist');
if (fs.existsSync(webDist)) {
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

/* ---------- 启动 ---------- */

startCacheSweeper();

// 预热默认关闭：Render 免费实例冷启动时不该同步抓十几个上游。
// 需要就设 DEEPMV_WARMUP=1。
startWarmup();
void warmHome();

const close = async (signal: string) => {
  log.info('shutdown', { signal });
  try { await app.close(); } catch { /* 忽略 */ }
  process.exit(0);
};
process.on('SIGTERM', () => void close('SIGTERM'));
process.on('SIGINT', () => void close('SIGINT'));

app.listen({ port: PORT, host: HOST }).then(() => {
  log.info('ready', {
    port: PORT,
    host: HOST,
    mode: MODE,
    proxy: ALLOW_PROXY,
    sources: loadRules().length,
    node: process.version,
  });
}).catch((err) => {
  log.error('listen-failed', { detail: String((err as Error)?.message || err) });
  process.exit(1);
});