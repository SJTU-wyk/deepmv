import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, imgUrl, pushHistory, toggleFavorite, isFavorite, type DetailResult, type HealthStatus, type PlayCandidate, type RoadHealth, type SearchItem } from '../api';
import { SkeletonGrid, ErrorNotice } from '../components/Feedback';
import { useAsyncData } from '../hooks/useAsyncData';

const HEALTH_LABEL: Record<HealthStatus, string> = {
  ok: '可用',
  unverified: '未验证',
  unavailable: '暂不可用',
};

const HEALTH_CLASS: Record<HealthStatus, string> = {
  ok: 'health-ok',
  unverified: 'health-unknown',
  unavailable: 'health-bad',
};

export default function Detail() {
  const { source = '', id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [roadIndex, setRoadIndex] = useState(0);
  const [introOpen, setIntroOpen] = useState(false);
  const [fav, setFav] = useState(false);
  const [probing, setProbing] = useState(false);
  const [health, setHealth] = useState<RoadHealth[] | null>(null);

  const key = source + ':' + decodeURIComponent(id);

  // 详情。换片就是换 key，旧请求自动作废，不会串台。
  const detail = useAsyncData(
    'detail:' + key,
    useCallback((signal) => api.detail(source, decodeURIComponent(id), { signal }), [source, id]),
    { enabled: !!source && !!id },
  );

  const data: DetailResult | null = detail.data;

  // 同片的其它来源。拿不到不影响主流程。
  const alts = useAsyncData(
    'alts:' + (data?.title ?? ''),
    useCallback(async (signal) => {
      if (!data) return [] as SearchItem[];
      const res = await api.search(data.title, { signal });
      return res.items.filter((i) => !(i.source === data.source && i.id === data.id)).slice(0, 6);
    }, [data?.title, data?.source, data?.id]),
    { enabled: !!data },
  );

  // 收藏状态跟着 detail 变
  const favKey = data ? data.source + ':' + data.id : '';
  useMemo(() => {
    if (data) setFav(isFavorite(data.source, data.id));
    return favKey;
  }, [favKey]);

  const roads = useMemo(() => {
    if (!data) return [];
    // 有健康数据就按状态排序：可用 → 未验证 → 暂不可用
    const order: Record<HealthStatus, number> = { ok: 0, unverified: 1, unavailable: 2 };
    const withHealth = health
      ? data.roads.map((road) => {
          const hit = health.find((h) => h.name === road.name);
          return { road, status: hit?.health.status ?? road.health ?? 'unverified' as HealthStatus, episodes: road.episodes.length, quality: road.bestQuality };
        })
      : data.roads.map((road) => ({
          road, status: (road.health ?? 'unverified') as HealthStatus,
          episodes: road.episodes.length, quality: road.bestQuality,
        }));
    return withHealth.sort((a, b) =>
      (order[a.status] - order[b.status]) ||
      (b.quality.height - a.quality.height) ||
      (b.episodes - a.episodes),
    );
  }, [data, health]);

  const bestLabel = useMemo(() => {
    const h = roads.find((r) => r.status !== 'unavailable')?.quality.height ?? 0;
    if (h >= 2160) return '4K';
    if (h >= 1440) return '2K';
    if (h >= 1080) return '1080P';
    if (h >= 720) return '720P';
    if (h >= 540) return '540P';
    return '待探测';
  }, [roads]);

  const runHealthCheck = async () => {
    if (!data || probing) return;
    setProbing(true);
    try {
      const res = await api.healthCheck(data.source, data.id);
      setHealth(res.roads);
    } catch (err) {
      console.warn('[deepmv] 健康检查失败', err);
    } finally {
      setProbing(false);
    }
  };

  const play = (roadIdx: number, epIndex: number) => {
    const entry = roads[roadIdx];
    if (!entry || !data) return;
    const ep = entry.road.episodes[epIndex];
    if (!ep) return;
    pushHistory({
      source: data.source, sourceName: data.sourceName, id: data.id,
      title: data.title, pic: data.pic, episode: ep.name, url: ep.url,
      road: entry.road.name, quality: entry.quality.label, at: Date.now(),
    });
    const query = new URLSearchParams({
      s: data.source, i: data.id, r: String(roadIdx), e: String(epIndex),
      t: data.title, sn: data.sourceName,
    });
    navigate('/play?' + query.toString());
  };

  if (detail.loading) {
    return (
      <main className="page">
        <section className="section" style={{ marginTop: 26 }}>
          <div className="section-head"><h2 className="section-title">正在解析线路</h2></div>
          <SkeletonGrid count={6} />
        </section>
      </main>
    );
  }

  if (detail.error) {
    return (
      <main className="page">
        <ErrorNotice message={detail.error} onRetry={detail.retry} />
      </main>
    );
  }

  if (!data) return null;

  const current = roads[roadIndex];

  return (
    <main className="page">
      {detail.refreshing && <div className="refresh-bar" />}

      <section className="detail-hero">
        {data.pic && <div className="detail-bg" style={{ backgroundImage: 'url(' + imgUrl(data.pic) + ')' }} />}
        <div className="detail-inner">
          <div className="detail-poster">
            {data.pic
              ? <img src={imgUrl(data.pic)} alt={data.title} />
              : <div className="card-fallback">{data.title.slice(0, 6)}</div>}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="detail-title">{data.title}</h1>
            <div className="detail-meta">
              <span className="tag" style={{ color: 'var(--gold)' }}>{bestLabel}</span>
              {data.year && <span>{data.year}</span>}
              {data.area && <span>{data.area}</span>}
              {data.remarks && <span>{data.remarks}</span>}
              <span className="muted">来源 · {data.sourceName}</span>
            </div>
            {data.genre && (
              <div className="detail-meta">
                {data.genre.split(/[·,]/).filter(Boolean).slice(0, 6).map((g) => <span className="tag" key={g}>{g.trim()}</span>)}
              </div>
            )}
            {data.intro && (
              <p className={'detail-intro' + (introOpen ? ' open' : '')} onClick={() => setIntroOpen(!introOpen)}>
                {data.intro}
              </p>
            )}

            <div className="hero-actions" style={{ marginTop: 20 }}>
              <button className="btn primary" onClick={() => play(0, 0)} disabled={!current}>播放第一集</button>
              <button className="btn" onClick={runHealthCheck} disabled={probing}>
                {probing ? '检查中…' : '检查线路可用性'}
              </button>
              <button className="btn" onClick={() => {
                const ok = toggleFavorite({
                  source: data.source, sourceName: data.sourceName, id: data.id, title: data.title,
                  pic: data.pic, episode: '', url: '', road: '', quality: bestLabel, at: Date.now(),
                });
                setFav(ok);
              }}>{fav ? '已收藏' : '收藏'}</button>
            </div>

            {health && (
              <div className="muted" style={{ marginTop: 12 }}>
                已检查 {health.length} 条线路：
                {health.filter((h) => h.health.status === 'ok').length} 条可用，
                {health.filter((h) => h.health.status === 'unavailable').length} 条暂不可用
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="section" style={{ marginTop: 30 }}>
        <div className="section-head">
          <h2 className="section-title">播放线路</h2>
          <span className="section-sub">画质取自 HLS 清单，可用性需要点上面的检查</span>
        </div>
        <div className="road-tabs">
          {roads.map((entry, i) => (
            <button
              key={entry.road.name + i}
              className={'road-tab' + (i === roadIndex ? ' active' : '')}
              onClick={() => setRoadIndex(i)}
            >
              <span className="rt-name">{entry.road.name}</span>
              <span className="rt-info">
                <span className={'health-dot ' + HEALTH_CLASS[entry.status]} />
                {HEALTH_LABEL[entry.status]} · {entry.quality.label} · {entry.episodes} 集
              </span>
            </button>
          ))}
          {!roads.length && <div className="muted">这个来源没有可用线路，看看下面的其它来源</div>}
        </div>
      </section>

      {current && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">选集</h2>
            <span className="section-sub">{current.road.name} · 共 {current.road.episodes.length} 集</span>
          </div>
          <div className="ep-grid">
            {current.road.episodes.map((ep, i) => (
              <button className="ep" key={ep.url + i} onClick={() => play(roadIndex, i)} title={ep.name}>
                {ep.name}
              </button>
            ))}
          </div>
        </section>
      )}

      {data.panLinks && data.panLinks.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">网盘资源</h2>
            <span className="section-sub">索引到的分享链接，需要你自己的网盘账号才能打开</span>
          </div>
          <div className="road-tabs">
            {data.panLinks.map((pan, i) => (
              <a key={pan.url + i} className="road-tab" href={pan.url} target="_blank" rel="noreferrer noopener">
                <span className="rt-name">{panLabel(pan.type)}</span>
                <span className="rt-info">{pan.quality || '未标注'}{pan.code ? ' · 提取码 ' + pan.code : ''}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* 其它来源取不到就不显示，不打扰 */}
      {alts.data && alts.data.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">其它来源</h2>
            <span className="section-sub">同一部片在别的片源，画质和稳定性各不相同</span>
          </div>
          <div className="road-tabs">
            {alts.data.map((alt) => (
              <button
                key={alt.source + alt.id}
                className="road-tab"
                onClick={() => navigate('/detail/' + alt.source + '/' + encodeURIComponent(alt.id) + (params.get('fixed') ? '?fixed=1' : ''))}
              >
                <span className="rt-name">{alt.sourceName}</span>
                <span className="rt-info">{alt.quality.label} · {alt.title.slice(0, 14)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {(data.actors || data.director) && (
        <section className="section">
          <div className="panel">
            {data.director && <div className="kv"><b>导演</b><span>{data.director}</span></div>}
            {data.actors && <div className="kv"><b>主演</b><span>{data.actors}</span></div>}
          </div>
        </section>
      )}
    </main>
  );
}

function panLabel(type: string): string {
  const map: Record<string, string> = {
    baidu: '百度网盘', quark: '夸克网盘', xunlei: '迅雷网盘',
    pikpak: 'PikPak', aliyun: '阿里云盘', '115': '115 网盘', uc: 'UC 网盘',
  };
  return map[type] || type;
}
