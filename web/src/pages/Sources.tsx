import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Sources() {
  const [sources, setSources] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([api.sources(), fetch('/api/health').then((r) => r.json())])
      .then(([s, h]) => { setSources(s.sources); setHealth(h); })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const reload = async () => {
    await fetch('/api/sources/reload', { method: 'POST' });
    load();
  };

  return (
    <main className="page">
      <section className="section" style={{ marginTop: 26 }}>
        <div className="section-head">
          <h2 className="section-title">播放源 / 规则</h2>
          <span className="section-sub">DeepMV 采用 Kazumi 式「规则驱动」，可在 server/rules 下增删自定义规则</span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={reload}>重载规则</button>
        </div>
        {loading && <div className="loading">加载中…</div>}
        {health && (
          <div className="panel" style={{ marginTop: 18 }}>
            <div className="kv"><b>版本</b><span>{health.version}</span></div>
            <div className="kv"><b>源数量</b><span>{health.sources}</span></div>
            <div className="kv"><b>运行时长</b><span>{health.uptime}s</span></div>
          </div>
        )}
        <div style={{ display: 'grid', gap: 14, marginTop: 18 }}>
          {sources.map((s) => (
            <div className="panel" key={s.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
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
