import { useCallback, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, type SearchItem, type SourceStat } from '../api';
import { PosterCard } from '../components/Poster';
import { SkeletonGrid, ErrorNotice, PartialNotice } from '../components/Feedback';
import { useAsyncData } from '../hooks/useAsyncData';

type SortKey = 'quality' | 'score' | 'year' | 'title';

export default function Search() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') || '';

  const [sort, setSort] = useState<SortKey>('quality');
  const [minHeight, setMinHeight] = useState(0);
  const [input, setInput] = useState(q);

  // key 里带关键词：换关键词就是换了一次请求，旧请求由 hook 作废
  const result = useAsyncData(
    'search:' + q,
    useCallback((signal) => api.search(q, { signal }), [q]),
    { enabled: q.length > 0, keepPrevious: false },
  );

  const items: SearchItem[] = result.data?.items ?? [];
  const stats: SourceStat[] = result.data?.sources ?? [];

  const filtered = useMemo(() => {
    let list = items.filter((i) => i.quality.height >= minHeight);
    if (sort === 'quality') list = [...list].sort((a, b) => b.quality.height - a.quality.height || (Number(b.score) || 0) - (Number(a.score) || 0));
    if (sort === 'score') list = [...list].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    if (sort === 'year') list = [...list].sort((a, b) => Number(b.year || 0) - Number(a.year || 0));
    if (sort === 'title') list = [...list].sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    return list;
  }, [items, sort, minHeight]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const keyword = input.trim();
    if (keyword) navigate('/search?q=' + encodeURIComponent(keyword));
  };

  const failedSources = stats.filter((s) => s.error).length;

  return (
    <main className="page">
      {result.refreshing && <div className="refresh-bar" />}

      <section className="section" style={{ marginTop: 26 }}>
        <form onSubmit={submit} style={{ display: 'flex', gap: 10 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入片名，多源同时检索"
            style={{
              flex: '0 1 520px', height: 44, padding: '0 16px', borderRadius: 12,
              border: '1px solid var(--line)', background: 'rgba(255,255,255,0.05)',
              color: 'var(--text)', outline: 'none',
            }}
          />
          <button className="btn primary" type="submit" style={{ height: 44 }}>搜索</button>
        </form>
      </section>

      {stats.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 18 }}>
          {stats.map((s) => (
            <span className="pill" key={s.id}>
              <i className={'dot' + (s.error ? ' err' : '')} />
              {s.name} · {s.error ? '暂不可用' : s.count + ' 条'} · {s.ms}ms
            </span>
          ))}
        </div>
      )}

      <div className="chips">
        <span className="muted" style={{ alignSelf: 'center' }}>排序</span>
        {([['quality', '画质优先'], ['score', '评分'], ['year', '年份'], ['title', '名称']] as [SortKey, string][]).map(([k, label]) => (
          <button key={k} className={'chip' + (sort === k ? ' active' : '')} onClick={() => setSort(k)}>{label}</button>
        ))}
        <span className="muted" style={{ alignSelf: 'center', marginLeft: 12 }}>画质</span>
        {[[0, '全部'], [1080, '1080P+'], [1440, '2K+'], [2160, '4K']].map(([h, label]) => (
          <button key={h} className={'chip' + (minHeight === h ? ' active' : '')} onClick={() => setMinHeight(h as number)}>{label as string}</button>
        ))}
      </div>

      {!q && <div className="empty">输入片名开始搜索</div>}

      {result.loading && q && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">正在并行检索</h2>
            <span className="section-sub">多个来源同时查，慢的会先跳过</span>
          </div>
          <SkeletonGrid count={12} />
        </section>
      )}

      {result.error && <ErrorNotice message={result.error} onRetry={result.retry} />}

      {!result.loading && q && !result.error && (
        <>
          <PartialNotice failed={failedSources} total={stats.length} />
          {filtered.length === 0 ? (
            <div className="empty">没有找到「{q}」，换个片名试试</div>
          ) : (
            <div className="grid-cards">
              {filtered.map((item, i) => <PosterCard key={item.source + item.id + i} item={item} />)}
            </div>
          )}
        </>
      )}
    </main>
  );
}
