import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, imgUrl, DetailResult, PlayCandidate, pushHistory, toggleFavorite, isFavorite } from '../api';

export default function Detail() {
  const { source = '', id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<DetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [roadIndex, setRoadIndex] = useState(0);
  const [introOpen, setIntroOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeMap, setProbeMap] = useState<Record<string, PlayCandidate>>({});
  const [fav, setFav] = useState(false);
  const [smart, setSmart] = useState<PlayCandidate | null>(null);
  const [alts, setAlts] = useState<{ source: string; sourceName: string; id: string; title: string; quality: { label: string } }[]>([]);
  const [smartLoading, setSmartLoading] = useState(false);

  useEffect(() => {
    setLoading(true); setError(''); setRoadIndex(0); setProbeMap({}); setSmart(null);
    api.detail(source, id)
      .then((res) => {
        setDetail(res); setFav(isFavorite(res.source, res.id));
        setTimeout(() => autoProbe(res.source, res.id), 0);
        api.search(res.title).then((s) => {
          setAlts(s.items.filter((i) => !(i.source === res.source && i.id === res.id)).slice(0, 6));
        }).catch(() => undefined);
      })
      .catch((err) => setError(String(err.message || err)))
      .finally(() => setLoading(false));
  }, [source, id]);

  const [switching, setSwitching] = useState('');
  const [upgrade, setUpgrade] = useState<PlayCandidate | null>(null);
  const [hereLabel, setHereLabel] = useState('');

  const autoProbe = (s: string, i: string) => {
    setProbing(true);
    api.bestRoad(s, i)
      .then(async (res) => {
        const map: Record<string, PlayCandidate> = {};
        for (const r of res.roads) map[r.road] = r;
        setProbeMap(map);
        const anyOk = res.roads.some((r) => r.ok);
        const hereHeight = Math.max(0, ...res.roads.filter((r) => r.ok).map((r) => r.height));
        setHereLabel(hereHeight > 0 ? labelOf(hereHeight, '') : '未知画质');

        // 情况一：整条源都播不了 → 自动切到其它源
        if (!anyOk && !params.get('fixed')) {
          setSwitching('当前来源线路不可用，正在全源查找可用线路…');
          try {
            const alt = await api.best(res.roads[0]?.title || '', [s + ':' + i]);
            if (alt.best && (alt.best.source !== s || alt.best.id !== i)) {
              navigate('/detail/' + alt.best.source + '/' + encodeURIComponent(alt.best.id) + '?fixed=1');
              return;
            }
          } catch { /* ignore */ }
          setSwitching('');
          return;
        }

        // 情况二：能播但画质偏低（<1080P）→ 全源找更高画质，摆一个一键切换的提示
        if (hereHeight > 0 && hereHeight < 1080 && !params.get('fixed')) {
          try {
            const alt = await api.best(res.roads[0]?.title || '', [s + ':' + i]);
            if (alt.best && alt.best.height > hereHeight && alt.best.height >= 1080) {
              setUpgrade(alt.best);
            }
          } catch { /* ignore */ }
        }
      })
      .catch(() => undefined)
      .finally(() => setProbing(false));
  };

  const sortedRoads = useMemo(() => {
    if (!detail) return [];
    return [...detail.roads]
      .map((road) => {
        const probed = probeMap[road.name];
        const height = probed ? (probed.ok ? probed.height : -1) : road.bestQuality.height;
        return { road, height, probed };
      })
      .sort((a, b) => b.height - a.height || b.road.episodes.length - a.road.episodes.length);
  }, [detail, probeMap]);

  const current = sortedRoads[roadIndex];
  const bestLabel = useMemo(() => labelOf(sortedRoads[0]?.height ?? 0, sortedRoads[0]?.road.bestQuality.label), [sortedRoads]);

  const smartPick = async () => {
    if (!detail) return;
    setSmartLoading(true);
    try {
      const res = await api.best(detail.title);
      setSmart(res.best);
      if (res.best && (res.best.source !== detail.source || res.best.id !== detail.id)) {
        // 其它来源更高画质：直接跳转
        navigate('/detail/' + res.best.source + '/' + encodeURIComponent(res.best.id));
      }
    } catch { /* ignore */ }
    setSmartLoading(false);
  };

  const play = (epIndex: number) => {
    if (!detail || !current) return;
    const ep = current.road.episodes[epIndex];
    if (!ep) return;
    pushHistory({
      source: detail.source, sourceName: detail.sourceName, id: detail.id,
      title: detail.title, pic: detail.pic, episode: ep.name, url: ep.url,
      road: current.road.name, quality: labelOf(current.height, current.road.bestQuality.label), at: Date.now(),
    });
    const query = new URLSearchParams({
      s: detail.source, i: detail.id, r: String(roadIndex), e: String(epIndex),
      t: detail.title, sn: detail.sourceName,
    });
    navigate('/play?' + query.toString());
  };

  if (loading) return <main className="page"><div className="loading">正在解析线路…</div></main>;
  if (error) return <main className="page"><div className="empty">加载失败：{error}</div></main>;
  if (!detail) return null;

  return (
    <main className="page">
      <section className="detail-hero">
        {detail.pic && <div className="detail-bg" style={{ backgroundImage: 'url(' + imgUrl(detail.pic) + ')' }} />}
        <div className="detail-inner">
          <div className="detail-poster">
            {detail.pic ? <img src={imgUrl(detail.pic)} alt={detail.title} /> : <div className="card-fallback">{detail.title.slice(0, 6)}</div>}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="detail-title">{detail.title}</h1>
            <div className="detail-meta">
              <span className="tag" style={{ color: 'var(--gold)' }}>{probing ? '探测中…' : bestLabel}</span>
              {detail.year && <span>{detail.year}</span>}
              {detail.area && <span>{detail.area}</span>}
              {detail.remarks && <span>{detail.remarks}</span>}
              <span className="muted">来源 · {detail.sourceName}</span>
            </div>
            {detail.genre && (
              <div className="detail-meta">
                {detail.genre.split(/[·,]/).filter(Boolean).slice(0, 6).map((g) => <span className="tag" key={g}>{g.trim()}</span>)}
              </div>
            )}
            {detail.intro && (
              <p className={'detail-intro' + (introOpen ? ' open' : '')} onClick={() => setIntroOpen(!introOpen)}>{detail.intro}</p>
            )}
            <div className="hero-actions" style={{ marginTop: 20 }}>
              <button className="btn primary" onClick={() => play(0)} disabled={!current}>播放第一集</button>
              <button className="btn" onClick={smartPick} disabled={smartLoading}>
                {smartLoading ? '全源比对中…' : '全源找最高画质'}
              </button>
              <button className="btn" onClick={() => detail && autoProbe(detail.source, detail.id)} disabled={probing}>重新探测</button>
              <button className="btn" onClick={() => {
                if (!detail) return;
                const ok = toggleFavorite({
                  source: detail.source, sourceName: detail.sourceName, id: detail.id, title: detail.title,
                  pic: detail.pic, episode: '', url: '', road: '', quality: bestLabel, at: Date.now(),
                });
                setFav(ok);
              }}>{fav ? '已收藏' : '收藏'}</button>
            </div>
            {switching && <div className="muted" style={{ marginTop: 12, color: 'var(--gold)' }}>{switching}</div>}
            {upgrade && (
              <div className="upgrade-banner">
                <span>
                  这个来源只有 <b>{hereLabel}</b>，<b>{upgrade.sourceName}</b> 实测有 <b>{upgrade.label} {upgrade.width}×{upgrade.height}</b>
                </span>
                <button className="btn primary" onClick={() => navigate('/detail/' + upgrade.source + '/' + encodeURIComponent(upgrade.id) + '?fixed=1')}>
                  切到高画质
                </button>
              </div>
            )}
            {smart && <div className="muted" style={{ marginTop: 12 }}>
              全源比对结果：{smart.sourceName} · {smart.label} {smart.width}x{smart.height} · {smart.road}
            </div>}
          </div>
        </div>
      </section>

      <section className="section" style={{ marginTop: 30 }}>
        <div className="section-head">
          <h2 className="section-title">播放线路</h2>
          <span className="section-sub">分辨率取自 HLS 清单 RESOLUTION，不信任站点自报清晰度</span>
        </div>
        <div className="road-tabs">
          {sortedRoads.map((entry, i) => (
            <button key={entry.road.name + i} className={'road-tab' + (i === roadIndex ? ' active' : '')} onClick={() => setRoadIndex(i)}>
              <span className="rt-name">{entry.road.name}</span>
              <span className="rt-info">
                {entry.height < 0 ? '不可用' : entry.probed?.ok ? entry.probed.label : entry.road.bestQuality.label !== '未知' ? entry.road.bestQuality.label : '待探测'}
                {' · '}{entry.road.episodes.length} 集
              </span>
            </button>
          ))}
          {!sortedRoads.length && <div className="muted">该来源没有可用线路，试试搜索结果里的其它来源</div>}
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
              <button className="ep" key={ep.url + i} onClick={() => play(i)} title={ep.name}>{ep.name}</button>
            ))}
          </div>
        </section>
      )}

      {alts.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">其它来源</h2>
            <span className="section-sub">同一部影片在其他片源，画质与稳定性各不相同</span>
          </div>
          <div className="road-tabs">
            {alts.map((alt) => (
              <button key={alt.source + alt.id} className="road-tab"
                onClick={() => navigate('/detail/' + alt.source + '/' + encodeURIComponent(alt.id))}>
                <span className="rt-name">{alt.sourceName}</span>
                <span className="rt-info">{alt.quality.label} · {alt.title.slice(0, 14)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {detail.panLinks && detail.panLinks.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">网盘资源</h2>
            <span className="section-sub">来自站点索引的分享链接，需要你自己的网盘账号才能打开</span>
          </div>
          <div className="road-tabs">
            {detail.panLinks.map((pan, i) => (
              <a key={pan.url + i} className="road-tab" href={pan.url} target="_blank" rel="noreferrer noopener">
                <span className="rt-name">{panLabel(pan.type)}</span>
                <span className="rt-info">{pan.quality || '未标注'}{pan.code ? ' · 提取码 ' + pan.code : ''}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {(detail.actors || detail.director) && (
        <section className="section">
          <div className="panel">
            {detail.director && <div className="kv"><b>导演</b><span>{detail.director}</span></div>}
            {detail.actors && <div className="kv"><b>主演</b><span>{detail.actors}</span></div>}
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

function labelOf(height: number, fallback: string): string {
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return '1080P';
  if (height >= 720) return '720P';
  if (height >= 540) return '540P';
  if (fallback && fallback !== '未知') return fallback;
  return '待探测';
}