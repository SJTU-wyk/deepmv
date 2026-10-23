import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function Collections() {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.collections().then((res) => setList(res.collections)).finally(() => setLoading(false));
  }, []);

  return (
    <main className="page">
      <section className="section" style={{ marginTop: 26 }}>
        <div className="section-head">
          <h2 className="section-title">片单精选</h2>
          <span className="section-sub">人工整理的影史片单，播放源由多源实时解析，不绑定单一站点</span>
        </div>
        {loading && <div className="loading">加载片单…</div>}
        <div style={{ display: 'grid', gap: 20, marginTop: 22 }}>
          {list.map((c) => {
            const covers = (c.preview || []).filter((p: any) => p.pic).slice(0, 4);
            return (
              <Link key={c.id} className="collection-card" to={'/collections/' + c.id}>
                <div className="collection-covers">
                  {covers.length
                    ? covers.map((p: any, i: number) => (
                        <img key={i} src={p.pic} alt={p.title} referrerPolicy="no-referrer" loading="lazy" />
                      ))
                    : <div className="collection-empty">片单预热中</div>}
                </div>
                <div className="collection-body">
                  <div className="collection-title">{c.title}</div>
                  <div className="collection-sub">{c.subtitle}</div>
                  <div className="collection-meta">
                    <span className="pill">{c.count} 部</span>
                    {c.ready > 0 && <span className="pill" style={{ color: 'var(--gold)' }}>{c.ready} 部已解析</span>}
                  </div>
                  {covers.length > 0 && (
                    <div className="collection-tags">{covers.map((p: any, i: number) => <span key={i}>{p.title}</span>)}</div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}