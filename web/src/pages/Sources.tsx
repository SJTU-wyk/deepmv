import { useCallback } from 'react';
import { api } from '../api';
import { SkeletonGrid, ErrorNotice } from '../components/Feedback';
import { useAsyncData } from '../hooks/useAsyncData';

export default function Sources() {
  const list = useAsyncData(
    'sources',
    useCallback((signal) => api.sources({ signal }), []),
  );

  const sources = list.data?.sources ?? [];

  return (
    <main className="page">
      <section className="section" style={{ marginTop: 26 }}>
        <div className="section-head">
          <h2 className="section-title">播放源</h2>
          <span className="section-sub">
            每个源都是公开的影视数据接口，可用性由对方决定，失效了换一条就行
          </span>
        </div>

        {list.loading && <SkeletonGrid count={6} />}
        {list.error && <ErrorNotice message={list.error} onRetry={list.retry} />}

        <div style={{ display: 'grid', gap: 14, marginTop: 18 }}>
          {sources.map((s: any) => (
            <div className="panel" key={s.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 15 }}>{s.name}</strong>
                <span className="tag">{s.adapter}</span>
                <span className="pill">{s.bestQuality}</span>
                <span className="muted" style={{ marginLeft: 'auto' }}>v{s.version}</span>
              </div>
              <div className="muted">{s.baseUrl}</div>
              {s.note && <div className="muted" style={{ marginTop: 6 }}>{s.note}</div>}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
