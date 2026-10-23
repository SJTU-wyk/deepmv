import Fastify from 'fastify';
import cors from '@fastify/cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules, reloadRules, getRule } from './rules.js';
import { getAdapter } from './adapters/index.js';
import { searchAll, mergeItems, withTimeout } from './aggregate.js';
import { getHomePublic, invalidateHome, warmHome } from './curated.js';
import { COLLECTIONS, getCollection } from './collections.js';
import { getPicks, getPickOverview, startWarmup } from './picks.js';
import { bestPlay, bestRoadOf } from './resolve.js';
import { proxyFetch, toNodeStream, sniffFromPage, proxyPath, canPlayDirect } from './proxy.js';
import { probeHls, heightLabel } from './probe.js';
import { type SearchItem } from './types.js';
import { MODE, ALLOW_PROXY, corsConfig, evaluate, clientIp } from './guard.js';
import { listSharedRules, readSharedRule, writeSharedRule } from './share.js';
import { getImage, imgPath } from './imgcache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7821);
// 本地模式只监听回环地址，别人的机器连不上；公网模式才监听全网卡
const HOST = process.env.HOST || (MODE === 'public' ? '0.0.0.0' : '127.0.0.1');

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: MODE === 'public' });
await app.register(cors, corsConfig());

// 统一入口闸：公网模式下限流 + 可选口令 + 关闭开放代理
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api')) return;
  const path = req.url.split('?')[0];
  const verdict = evaluate(path, clientIp(req.headers as any, req.ip), req.headers as any, req.query as any);
  if (!verdict.allowed) {
    if (verdict.retryAfter) reply.header('retry-after', String(verdict.retryAfter));
    return reply.code(verdict.retryAfter ? 429 : 403).send({ error: verdict.reason });
  }
});

const startedAt = Date.now();

app.get('/api/health', async () => ({
  ok: true, name: 'deepmv', version: '0.1.0', mode: MODE, proxy: ALLOW_PROXY,
  sources: loadRules().length, uptime: Math.round((Date.now() - startedAt) / 1000),
}));

app.get('/api/sources', async () => ({
  sources: loadRules().map((r) => ({
    id: r.id, name: r.name, version: r.version, adapter: r.adapter,
    baseUrl: r.baseUrl, bestQuality: r.bestQuality, note: r.note, enabled: r.enabled !== false,
  })),
}));

app.post('/api/sources/reload', async (_req, reply) => {
  // 重载会读盘，公网模式下必须带口令（上面 onRequest 已校验），这里再挡一次无口令环境
  if (MODE === 'public' && !(process.env.DEEPMV_KEY || '').trim()) {
    return reply.code(403).send({ error: '公网模式未设置 DEEPMV_KEY，禁止重载规则' });
  }
  const rules = reloadRules();
  invalidateHome();
  return { ok: true, count: rules.length };
});

app.get('/api/home', async (req) => {
  const force = (req.query as any)?.refresh === '1';
  const sections = await getHomePublic(force);
  return { sections, generatedAt: Date.now() };
});

app.get('/api/collections', async () => ({ collections: await getPickOverview() }));

/** 精选片单解析：按片名并行跑多源搜索，只保留最佳一条 + 备选来源 */
app.get('/api/collections/:id', async (req, reply) => {
  const params = req.params as any;
  const limit = Number((req.query as any)?.limit ?? 24);
  const force = (req.query as any)?.refresh === '1';
  const data = await getPicks(params.id, limit, force);
  if (!data) return reply.code(404).send({ error: '片单不存在' });
  return data;
});

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
  if (!rule) return reply.code(404).send({ error: '未知来源: ' + source });
  try {
    const adapter = getAdapter(rule);
    const detail = await withTimeout(adapter.detail(rule, decodeURIComponent(id)), 18000, '详情超时');
    if (!detail) return reply.code(404).send({ error: '未找到条目（或该条目属于已被过滤的分区）' });
    return detail;
  } catch (err) {
    return reply.code(502).send({ error: String(err).slice(0, 200) });
  }
});

/** 真实画质探测：并发探测每条线路首集的 HLS 清单分辨率 */
app.get('/api/quality/:source/:id', async (req, reply) => {
  const { source, id } = req.params as { source: string; id: string };
  const rule = getRule(source);
  if (!rule) return reply.code(404).send({ error: '未知来源' });
  const adapter = getAdapter(rule);
  const detail = await adapter.detail(rule, decodeURIComponent(id));
  if (!detail) return reply.code(404).send({ error: '未找到条目' });
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

/** 单条流的真实分辨率 */
app.get('/api/probe', async (req, reply) => {
  const url = String((req.query as any)?.url ?? '');
  if (!/^https?:\/\//.test(url)) return reply.code(400).send({ error: '非法地址' });
  const result = await probeHls(url);
  return { ...result, label: result.label || heightLabel(result.height) };
});

/**
 * 解析播放地址。
 *
 * 关键策略：**能直连就直连**。
 * 浏览器直连 CDN 少一跳，实测同一分片 806ms vs 走代理 1859ms。
 * 只有当 CDN 不给 CORS 头（浏览器会被拦）时才退回代理。
 */
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

    // 广告清除必须走代理（清单要重写）；直连时把清理逻辑放到客户端做不到，
    // 所以只在「必须代理」或「用户显式要求清广告」时套代理。
    const directOk = !forceProxy && await canPlayDirect(mediaUrl);
    if (directOk && !adblock) {
      return { type, url: mediaUrl, source: mediaUrl, mode: 'direct', sniffed: sniffed.slice(0, 6) };
    }
    if (directOk && adblock) {
      // 直连画质更好，但清单要清广告 → 只代理清单，分片仍直连
      return { type, url: proxyPath(mediaUrl), source: mediaUrl, mode: 'manifest', sniffed: sniffed.slice(0, 6) };
    }
    return { type, url: proxyPath(mediaUrl), source: mediaUrl, mode: 'proxy', sniffed: sniffed.slice(0, 6) };
  } catch (err) {
    return reply.code(502).send({ error: String(err).slice(0, 200) });
  }
});

/** 全源挑选「能播 + 分辨率最高」的线路 */
app.get('/api/best', async (req, reply) => {
  const q = String((req.query as any)?.q ?? '').trim();
  if (!q) return reply.code(400).send({ error: '缺少 q 参数' });
  const exclude = (req.query as any)?.exclude as string | undefined;
  const excludeList = String((req.query as any)?.skip ?? '').split(',').filter(Boolean);
  const result = await withTimeout(bestPlay(q, { excludeSource: exclude, exclude: excludeList }), 45000, 'best timeout');
  return result;
});

app.get('/api/best-road/:source/:id', async (req, reply) => {
  const { source, id } = req.params as { source: string; id: string };
  const result = await withTimeout(bestRoadOf(source, decodeURIComponent(id)), 30000, 'probe timeout');
  return result;
});

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
  } catch (err) {
    return reply.code(502).send({ error: String(err).slice(0, 200) });
  }
});

/* ---------- 规则共享 ---------- */

app.get('/api/share/rules', async () => ({ rules: listSharedRules() }));

app.get('/api/share/rules/:id', async (req, reply) => {
  const rule = readSharedRule((req.params as any).id);
  if (!rule) return reply.code(404).send({ error: '规则不存在' });
  return rule;
});

app.post('/api/share/rules', async (req, reply) => {
  // 写操作只允许本地模式，或公网模式下带了口令
  if (MODE === 'public' && !(process.env.DEEPMV_KEY || '').trim()) {
    return reply.code(403).send({ error: '公网模式未设置 DEEPMV_KEY，禁止写入' });
  }
  const result = writeSharedRule(req.body);
  if (!result.ok) return reply.code(400).send({ error: result.error });
  reloadRules();
  return result;
});

/** 海报缓存：首访回源，之后走本地磁盘 */
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

const webDist = path.resolve(here, '../../web/dist');
if (fs.existsSync(webDist)) {
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

startWarmup();
void warmHome();

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log('[deepmv] ready http://127.0.0.1:' + PORT + '  sources=' + loadRules().length);
}).catch((err) => {
  console.error('[deepmv] 启动失败', err);
  process.exit(1);
});