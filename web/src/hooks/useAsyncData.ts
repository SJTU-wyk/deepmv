import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbort } from '../api';

/**
 * 异步数据的统一取法。
 *
 * 每个使用它的页面都不再需要自己管「这次的响应还是不是最新的」。
 * hook 内部维护一个自增序号：每次发起请求序号加一，回调时比对，
 * 对不上就直接丢弃——这就是防串台的最终保证。
 *
 * AbortController 是顺手做的事：能真正取消就取消，省一次无用请求；
 * 但即使取消不生效，序号比对仍然会拦住旧响应。
 *
 * keepPrevious 控制刷新时要不要保留旧数据。默认保留，
 * 这样切换分类不会先白屏再出内容。
 */

export interface AsyncState<T> {
  data: T | null;
  /** 首次加载（还没有任何数据） */
  loading: boolean;
  /** 已有数据、正在后台刷新 */
  refreshing: boolean;
  error: string | null;
  retry: () => void;
}

export interface AsyncOptions {
  /** false 时不发请求，用于「还没输入关键词就不要搜」这种场景 */
  enabled?: boolean;
  /** 刷新时保留旧数据，默认 true */
  keepPrevious?: boolean;
  /** 去抖，毫秒。输入框搜索用得上 */
  debounceMs?: number;
} 

export function useAsyncData<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  options: AsyncOptions = {},
): AsyncState<T> {
  const { enabled = true, keepPrevious = true, debounceMs = 0 } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // 序号：只有最新的那次请求才允许写状态
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // loader 每次渲染都是新函数，用 ref 存着，避免把它写进依赖导致无限循环
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const hasDataRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      // 关掉请求时不保留旧数据，否则会显示上一个关键词的结果
      seqRef.current++;
      hasDataRef.current = false;
      setData(null);
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }

    const mySeq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (hasDataRef.current && keepPrevious) setRefreshing(true);
    else setLoading(true);
    setError(null);

    const run = async () => {
      try {
        const result = await loaderRef.current(controller.signal);
        // 序号对不上说明期间又发了新请求，这次的结果作废
        if (mySeq !== seqRef.current || !mountedRef.current) return;
        hasDataRef.current = true;
        setData(result);
        setError(null);
      } catch (err) {
        if (mySeq !== seqRef.current || !mountedRef.current) return;
        // 主动取消不算错误，界面上不该出现任何提示
        if (isAbort(err) || controller.signal.aborted) return;
        const message = (err as Error)?.message || '加载失败';
        setError(message);
        // 详细错误只进 console，不给用户看
        console.warn('[deepmv] 请求失败', key, (err as any)?.detail || err);
      } finally {
        if (mySeq === seqRef.current && mountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    if (debounceMs > 0) {
      const timer = setTimeout(run, debounceMs);
      return () => clearTimeout(timer);
    }
    void run();
    return () => { controller.abort(); };
  }, [key, enabled, keepPrevious, debounceMs, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, refreshing, error, retry };
}
