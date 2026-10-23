import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { SkeletonGrid, ErrorNotice } from '../components/Feedback';
import { useAsyncData } from '../hooks/useAsyncData';

export default function Collections() {
  const list = useAsyncData(
    'collections',
    useCallback((signal) => api.collections({ signal }), []),
  );

  const collections = list.data?.collections ?? [];

  return (
    <main className="page">
      <section className="section" style={{ marginTop: 26 }}>
        <div className="section-head">
          <h2 className="section-title">片单精选</h2>
          <span className="section-sub">人工整理的片单，播放源由多源实时解析</span>
        </div>

        {list.loading && <SkeletonGrid count={4} />}
        {list.error && <ErrorNotice message={list.error} onRetry={list.retry} />}

        <div style={{ display: 'grid', gap: 20, marginTop: 22 }}>
          {collections.map((c: any) => {
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
                  </div>
                  {covers.length > 0 && (
                    <div className="collection-tags">
                      {covers.map((p: any, i: number) => <span key={i}>{p.title}</span>)}
                    </div>
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
