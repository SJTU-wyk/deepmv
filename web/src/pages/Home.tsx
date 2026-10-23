import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, imgUrl, type Section, type SearchItem } from '../api';
import { PosterRow } from '../components/Poster';
import { SkeletonRow, ErrorNotice } from '../components/Feedback';
import { useAsyncData } from '../hooks/useAsyncData';

const TABS: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'western-movie', label: '欧美电影' },
  { key: 'western-tv', label: '欧美剧集' },
  { key: 'cn-movie', label: '国产电影' },
  { key: 'cn-tv', label: '国产剧集' },
  { key: 'cn-classic', label: '国产经典' },
  { key: 'cn-tv-classic', label: '口碑国剧' },
  { key: 'western-classic', label: '欧美经典' },
  { key: 'western-tv-classic', label: '口碑美剧' },
  { key: 'high-score', label: '高分 8.0+' },
  { key: 'shaw', label: '邵氏港片' },
  { key: 'documentary', label: '纪录片' },
];

export default function Home() {
  const [tab, setTab] = useState('all');
  const [heroIndex, setHeroIndex] = useState(0);
  // 换一批：改 key 触发重新拉取，旧请求由 hook 自动取消并作废
  const [refreshToken, setRefreshToken] = useState(0);

  const home = useAsyncData(
    'home:' + refreshToken,
    useCallback((signal) => api.home(refreshToken > 0, { signal }), [refreshToken]),
    { keepPrevious: true, debounceMs: 0 },
  );

  const sections: Section[] = home.data?.sections ?? [];

  const heroPool = useMemo<SearchItem[]>(() => {
    const flat: SearchItem[] = [];
    for (const sec of sections) for (const item of sec.items) if (item.pic) flat.push(item);
    const seen = new Set<string>();
    return flat
      .filter((i) => { const k = i.title; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 8);
  }, [sections]);

  // 数据换了以后把轮播重置，否则可能指到不存在的下标
  useEffect(() => { setHeroIndex(0); }, [heroPool.length]);

  useEffect(() => {
    if (heroPool.length < 2) return;
    const timer = setInterval(() => setHeroIndex((i) => (i + 1) % heroPool.length), 9000);
    return () => clearInterval(timer);
  }, [heroPool.length]);

  const hero = heroPool[heroIndex % Math.max(1, heroPool.length)];
  const visible = tab === 'all' ? sections : sections.filter((s) => s.key === tab);
  const firstLoad = home.loading && sections.length === 0;
  const hasContent = sections.length > 0;

  return (
    <main className="page">
      {home.refreshing && <div className="refresh-bar" />}

      {hero && (
        <section className="hero">
          <div className="hero-bg" style={{ backgroundImage: 'url(' + imgUrl(hero.pic) + ')' }} />
          <div className="hero-mask" />
          <div className="hero-body">
            <div className="hero-kicker">DeepMV 今日精选</div>
            <h1 className="hero-title">{hero.title}</h1>
            <div className="hero-meta">
              {hero.quality.height > 0 && <span className="tag">{hero.quality.label}</span>}
              {hero.year && <span>{hero.year}</span>}
              {hero.area && <span>{hero.area}</span>}
              {hero.score && <span className="score">豆瓣 {hero.score}</span>}
              {hero.genre && <span>{hero.genre}</span>}
            </div>
            <p className="hero-intro">{hero.remarks || '多线路聚合 · 自动挑选最高画质线路播放'}</p>
            <div className="hero-actions">
              <Link className="btn primary" to={'/detail/' + hero.source + '/' + encodeURIComponent(hero.id)}>
                立即播放
              </Link>
              <button className="btn" onClick={() => setRefreshToken((t) => t + 1)} disabled={home.refreshing}>
                {home.refreshing ? '刷新中…' : '刷新推荐'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* 错误提示留在页面上方，已经拿到的内容继续显示，不清空 */}
      {home.error && (
        <ErrorNotice
          message={hasContent ? home.error + '（下面显示的是上一次的内容）' : home.error}
          onRetry={home.retry}
        />
      )}

      <div className="chips">
        {TABS.map((t) => (
          <button key={t.key} className={'chip' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {firstLoad && (
        <>
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">正在聚合多源片库</h2>
              <span className="section-sub">首次加载大约需要十几秒</span>
            </div>
            <SkeletonRow count={7} />
          </section>
          <section className="section">
            <div className="section-head"><div className="skeleton skeleton-line" style={{ width: 160, height: 18 }} /></div>
            <SkeletonRow count={7} />
          </section>
        </>
      )}

      {!firstLoad && visible.map((sec) => (
        <section className="section" key={sec.key}>
          <div className="section-head">
            <h2 className="section-title">{sec.title}</h2>
            <span className="section-sub">{sec.subtitle}</span>
            <button className="section-more btn ghost" onClick={() => setRefreshToken((t) => t + 1)}>
              换一批
            </button>
          </div>
          <PosterRow items={sec.items} />
        </section>
      ))}

      {!firstLoad && !home.error && visible.length === 0 && (
        <div className="empty">这个分类暂时没有数据</div>
      )}
    </main>
  );
}
