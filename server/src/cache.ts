/**
 * 带 TTL 的 LRU 缓存 + 请求合并（request coalescing）。
 *
 * 两件事：
 *   1. 有上限的缓存。条目数超了就按最近最少使用淘汰，内存不会无限涨。
 *   2. 同一个 key 同时有多个请求时，只打一次上游，其余等同一个 Promise。
 *      首页一次加载会并发打出十几个请求，其中不少 key 是重复的，
 *      没有合并的话上游会被同一批请求打穿，然后就 429。
 *
 * 只用内存，不引 Redis。Render 免费实例只有一个进程，进程内缓存够用。
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  coalesced: number;
  evictions: number;
}

export class TtlCache {
  private map = new Map<string, Entry>();
  private inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private evictions = 0;

  constructor(private maxEntries = 500) {}

  /** 取值。命中就顺带把它挪到队尾（Map 的插入序天然是 LRU 顺序） */
  get<T>(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) { this.misses++; return undefined; }
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits++;
    return hit.value as T;
  }

  set(key: string, value: unknown, ttlMs: number) {
    if (ttlMs <= 0) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    this.trim();
  }

  delete(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); this.inflight.clear(); }

  stats(): CacheStats {
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      evictions: this.evictions,
    };
  }

  /** 超出上限时从最旧的开始删 */
  private trim() {
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.evictions++;
    }
  }

  /**
   * 取缓存，没有就调 loader，同时把并发请求合并到同一个 Promise 上。
   * loader 抛错时不写缓存——错误结果不能被缓存住，否则上游恢复了这个 key 还是坏的。
   */
  async memo<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) {
      this.coalesced++;
      return running;
    }

    const task = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, task as Promise<unknown>);
    return task;
  }

  /** 定期清理过期条目，防止没人访问的 key 一直占着内存 */
  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(key);
    }
  }
}

/** 全局缓存实例。分开放是为了能按用途设置不同的条目上限。 */
export const caches = {
  /** 上游抓取结果（搜索、详情、分类） */
  upstream: new TtlCache(400),
  /** 线路健康状态 */
  health: new TtlCache(2000),
  /** 首页与片单 */
  home: new TtlCache(40),
};

export function allCacheStats() {
  return {
    upstream: caches.upstream.stats(),
    health: caches.health.stats(),
    home: caches.home.stats(),
  };
}

/** 每分钟清一次过期条目。unref 让定时器不阻止进程退出。 */
export function startCacheSweeper(intervalMs = 60_000) {
  const timer = setInterval(() => {
    caches.upstream.sweep();
    caches.health.sweep();
    caches.home.sweep();
  }, intervalMs);
  timer.unref?.();
  return timer;
}
