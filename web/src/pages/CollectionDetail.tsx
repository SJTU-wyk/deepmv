import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { PosterCard } from '../components/Poster';

export default function CollectionDetail() {
  const { id = '' } = useParams();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    api.collection(id, 24)
      .then(setData)
      .catch((err) => setError(String(err.message || err)))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <main className="page">
      <section className="section" style={{ marginTop: 26 }}>
        <div className="section-head">
          <h2 className="section-title">{data?.title || '片单'}</h2>
          <span className="section-sub">{data?.subtitle}</span>
          <Link className="section-more" to="/collections">返回片单</Link>
        </div>
        {loading && <div className="loading">正在多源解析片单条目，约需 20-40 秒…</div>}
        {error && <div className="empty">加载失败：{error}</div>}
        {data && (
          <div className="grid-cards">
            {data.resolved.map((row: any, i: number) => (
              row.item
                ? <div key={row.title + i}>
                    <PosterCard item={{ ...row.item, title: row.title, year: row.item.year || row.year }} />
                  </div>
                : <div className="card" key={row.title + i}>
                    <div className="card-poster"><div className="card-fallback">{row.title.slice(0, 6)}</div></div>
                    <div className="card-title">{row.title}</div>
                    <div className="card-meta">暂无可播源</div>
                  </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
