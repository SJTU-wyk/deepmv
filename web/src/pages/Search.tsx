import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, SearchItem, SourceStat } from '../api';
import { PosterCard } from '../components/Poster';

type SortKey = 'quality' | 'score' | 'year' | 'title';

export default function Search() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') || '';
  const [items, setItems] = useState<SearchItem[]>([]);
  const [stats, setStats] = useState<SourceStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<SortKey>('quality');
  const [minHeight, setMinHeight] = useState(0);
  const [input, setInput] = useState(q);

  useEffect(() => { setInput(q); }, [q]);

  useEffect(() => {
    if (!q) { setItems([]); setStats([]); return; }
    setLoading(true); setError('');
    api.search(q)
      .then((res) => { setItems(res.items); setStats(res.sources); })
      .catch((err) => setError(String(err.message || err)))
      .finally(() => setLoading(false));
  }, [q]);

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
    if (input.trim()) navigate('/search?q=' + encodeURIComponent(input.trim()));
  };

  return (
    <main className="page">
      <section className="section" style={{ marginTop: 26 }}>
        <form onSubmit={submit} style={{ display: 'flex', gap: 10 }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="输入片名，多源同时检索"
            style={{ flex: '0 1 520px', height: 44, padding: '0 16px', borderRadius: 12, border: '1px solid var(--line)', background: 'rgba(255,255,255,0.05)', color: 'var(--text)', outline: 'none' }} />
          <button className="btn primary" type="submit" style={{ height: 44 }}>搜索</button>
        </form>
      </section>

      {stats.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 18 }}>
          {stats.map((s) => (
            <span className="pill" key={s.id}>
              <i className={'dot' + (s.error ? ' err' : '')} />
              {s.name} · {s.error ? '超时' : s.count + ' 条'} · {s.ms}ms
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

      {loading && <div className="loading">正在并行检索 {stats.length || 6} 个片源…</div>}
      {error && <div className="empty">检索失败：{error}</div>}
      {!loading && !error && q && filtered.length === 0 && <div className="empty">没有找到「{q}」，换个片名试试</div>}
      {!loading && filtered.length > 0 && (
        <div className="grid-cards">
          {filtered.map((item, i) => <PosterCard key={item.source + item.id + i} item={item} />)}
        </div>
      )}
    </main>
  );
}
