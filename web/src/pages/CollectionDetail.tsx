import { useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { PosterCard } from '../components/Poster';
import { ErrorNotice } from '../components/Feedback';
import { useAsyncData } from '../hooks/useAsyncData';

export default function CollectionDetail() {
  const { id = '' } = useParams();

  // 片单解析要跑几十秒，key 带 id：换片单就作废旧请求
  const data = useAsyncData(
    'collection:' + id,
    useCallback((signal) => api.collection(id, 24, { signal }), [id]),
    { enabled: !!id, keepPrevious: false },
  );

  const collection = data.data;

  return (
    <main className="page">
      <section className="section" style={{ marginTop: 26 }}>
        <div className="section-head">
          <h2 className="section-title">{collection?.title || '片单'}</h2>
          <span className="section-sub">{collection?.subtitle}</span>
          <Link className="section-more" to="/collections">返回片单</Link>
        </div>

        {data.loading && (
          <div className="notice notice-soft">
            正在逐个片名解析播放源。一个片单二十多部片子，第一次打开需要半分钟左右，
            解析结果会缓存，之后打开就快了。
          </div>
        )}

        {data.error && <ErrorNotice message={data.error} onRetry={data.retry} />}

        {collection && (
          <div className="grid-cards">
            {collection.resolved.map((row: any, i: number) => (
              row.item
                ? (
                  <div key={row.title + i}>
                    <PosterCard item={{
                      ...row.item,
                      title: row.title,
                      year: row.item.year || row.year,
                      quality: row.item.quality.height > 0 ? row.item.quality : { height: 0, label: '' },
                    }} />
                  </div>
                )
                : (
                  <div className="card" key={row.title + i}>
                    <div className="card-poster"><div className="card-fallback">{row.title.slice(0, 6)}</div></div>
                    <div className="card-title">{row.title}</div>
                    <div className="card-meta">暂无可播源</div>
                  </div>
                )
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
