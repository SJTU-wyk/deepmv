import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, imgUrl, Section, SearchItem } from '../api';
import { PosterRow, PosterCard } from '../components/Poster';

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
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('all');
  const [heroIndex, setHeroIndex] = useState(0);

  const load = (refresh = false) => {
    setLoading(true);
    api.home(refresh)
      .then((res) => { setSections(res.sections); setError(''); })
      .catch((err) => setError(String(err.message || err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const heroPool = useMemo<SearchItem[]>(() => {
    const flat: SearchItem[] = [];
    for (const sec of sections) for (const item of sec.items) if (item.pic) flat.push(item);
    const seen = new Set<string>();
    return flat.filter((i) => { const k = i.title; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
  }, [sections]);

  useEffect(() => {
    if (heroPool.length < 2) return;
    const timer = setInterval(() => setHeroIndex((i) => (i + 1) % heroPool.length), 9000);
    return () => clearInterval(timer);
  }, [heroPool.length]);

  const hero = heroPool[heroIndex];
  const visible = tab === 'all' ? sections : sections.filter((s) => s.key === tab);

  return (
    <main className="page">
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
              <Link className="btn primary" to={'/detail/' + hero.source + '/' + encodeURIComponent(hero.id)}>立即播放</Link>
              <button className="btn" onClick={() => load(true)}>刷新推荐</button>
            </div>
          </div>
        </section>
      )}

      <div className="chips">
        {TABS.map((t) => (
          <button key={t.key} className={'chip' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {loading && <div className="loading">正在聚合多源片库…（首次加载约 10 秒）</div>}
      {error && <div className="empty">加载失败：{error}</div>}

      {!loading && visible.map((sec) => (
        <section className="section" key={sec.key}>
          <div className="section-head">
            <h2 className="section-title">{sec.title}</h2>
            <span className="section-sub">{sec.subtitle}</span>
            <button className="section-more btn ghost" onClick={() => load(true)}>换一批</button>
          </div>
          <PosterRow items={sec.items} />
        </section>
      ))}

      {!loading && !error && visible.length === 0 && <div className="empty">该分类暂无数据</div>}
    </main>
  );
}