import React, { useRef } from 'react';
import { Link } from 'react-router-dom';
import { SearchItem } from '../api';

export function PosterCard({ item, showSource = true }: { item: SearchItem; showSource?: boolean }) {
  const to = '/detail/' + item.source + '/' + encodeURIComponent(item.id);
  return (
    <Link className="card" to={to}>
      <div className="card-poster">
        {item.pic
          ? <img src={item.pic} alt={item.title} loading="lazy" referrerPolicy="no-referrer"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
          : <div className="card-fallback">{item.title.slice(0, 6)}</div>}
        {item.quality.height > 0 && item.quality.label !== '未知' && <span className="badge">{item.quality.label}</span>}

        {item.remarks && <span className="badge hot">{item.remarks.slice(0, 8)}</span>}
      </div>
      <div className="card-title">{item.title}</div>
      <div className="card-meta">
        {item.score && <span className="score">{item.score}</span>}
        {item.year && <span>{item.year}</span>}
        {item.area && <span>{item.area.split(/[,\/]/)[0]}</span>}
        {showSource && <span>· {item.sourceName}</span>}
        {item.alsoOn && item.alsoOn.length > 0 && <span style={{ color: 'var(--gold)' }}>+{item.alsoOn.length} 源</span>}
      </div>
    </Link>
  );
}

export function PosterRow({ items }: { items: SearchItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  if (!items.length) return <div className="muted">暂无数据</div>;
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * 640, behavior: 'smooth' });
  return (
    <div className="row-wrap">
      <button className="row-arrow left" onClick={() => scroll(-1)} aria-label="向左">{'\u2039'}</button>
      <div className="row" ref={ref}>
        {items.map((item, i) => <PosterCard key={item.source + item.id + i} item={item} />)}
      </div>
      <button className="row-arrow right" onClick={() => scroll(1)} aria-label="向右">{'\u203A'}</button>
    </div>
  );
}