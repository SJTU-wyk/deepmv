import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Hls from 'hls.js';
import { api, pushHistory, type DetailResult } from '../api';
import { Upscaler } from '../upscale';
import { useAsyncData } from '../hooks/useAsyncData';

/**
 * 播放器。
 *
 * 两条线并行：
 *   详情用 useAsyncData 拿，换片自动作废旧请求；
 *   播放地址解析单独一条，key 里带集数地址，切集就是换请求。
 *
 * 进度条走 rAF 直写 DOM，不触发 React 重渲染——这是之前卡顿的主因。
 */
export default function Player() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const source = params.get('s') || '';
  const id = params.get('i') || '';
  const titleHint = params.get('t') || '';

  const [roadIndex, setRoadIndex] = useState(Number(params.get('r') || 0));
  const [epIndex, setEpIndex] = useState(Number(params.get('e') || 0));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [sr, setSr] = useState<0 | 1 | 2>(0);
  const [srError, setSrError] = useState('');
  const [playError, setPlayError] = useState('');
  const [adNotice, setAdNotice] = useState('');
  const [probeInfo, setProbeInfo] = useState('');
  const [barVisible, setBarVisible] = useState(true);
  const [autoSwitching, setAutoSwitching] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const upscalerRef = useRef<Upscaler | null>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<number>();
  const rafRef = useRef<number>();
  const durationRef = useRef(0);
  const switchedRef = useRef(false);

  const detail = useAsyncData(
    'player-detail:' + source + ':' + id,
    useCallback((signal) => api.detail(source, id, { signal }), [source, id]),
    { enabled: !!source && !!id },
  );

  const data: DetailResult | null = detail.data;
  const road = data?.roads[roadIndex];
  const episode = road?.episodes[epIndex];

  // 解析播放地址。key 里带地址，切集自动换请求，旧请求作废。
  const resolved = useAsyncData(
    'resolve:' + (episode?.url ?? ''),
    useCallback((signal) => api.resolve(episode!.url, { signal }), [episode?.url]),
    { enabled: !!episode?.url, keepPrevious: false },
  );

  // 换了条目就允许重新自动切换一次
  useEffect(() => { switchedRef.current = false; setPlayError(''); }, [source, id]);

  // 解析结果里的提示
  useEffect(() => {
    const mode = resolved.data?.mode;
    if (mode === 'manifest' || mode === 'proxy') setAdNotice('已过滤清单广告');
    else setAdNotice('');
  }, [resolved.data?.mode]);

  // 探一下真实分辨率，纯展示用，失败不影响播放
  useEffect(() => {
    const probeUrl = resolved.data?.source;
    if (!probeUrl) { setProbeInfo(''); return; }
    let alive = true;
    api.probe(probeUrl, { dedupeMs: 0 })
      .then((probe) => { if (alive && probe.ok) setProbeInfo(probe.label + ' · ' + probe.width + 'x' + probe.height); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [resolved.data?.source]);

  const tryNextSource = useCallback(async () => {
    if (switchedRef.current || !data) return;
    switchedRef.current = true;
    setAutoSwitching(true);
    setPlayError('');
    try {
      const res = await api.best(data.title, [data.source + ':' + data.id]);
      if (res.best) {
        navigate('/play?' + new URLSearchParams({
          s: res.best.source, i: res.best.id, r: '0', e: '0', t: res.best.title, sn: res.best.sourceName,
        }).toString());
        return;
      }
      setPlayError('这条线路播不了，其它来源也没找到可用的');
    } catch {
      setPlayError('这条线路播不了');
    } finally {
      switchedRef.current = false;
      setAutoSwitching(false);
    }
  }, [data, navigate]);

  // 装载播放器
  useEffect(() => {
    const video = videoRef.current;
    const url = resolved.data?.url;
    if (!video || !url) return;
    let hls: Hls | null = null;
    video.pause();
    video.removeAttribute('src');
    video.load();

    const isHls = /\.m3u8/i.test(url) || url.includes('/api/proxy');
    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, maxBufferLength: 30, maxMaxBufferLength: 90, backBufferLength: 30 });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, info) => {
        if (info.fatal) void tryNextSource();
      });
    } else {
      video.src = url;
    }

    const onReady = () => {
      setPlayError('');
      void video.play().catch(() => setPlayError('点一下画面开始播放'));
    };
    const onError = () => void tryNextSource();
    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('error', onError);
    return () => {
      hls?.destroy();
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('error', onError);
    }
  }, [resolved.data?.url, tryNextSource]);

  // 进度条：rAF 直写 DOM
  useEffect(() => {
    const tick = () => {
      const v = videoRef.current;
      if (v && fillRef.current && timeRef.current) {
        const d = durationRef.current || v.duration || 0;
        if (v.currentTime && d) fillRef.current.style.width = ((v.currentTime / d) * 100).toFixed(2) + '%';
        timeRef.current.textContent = fmt(v.currentTime) + ' / ' + fmt(d);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  // 超分
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    if (sr === 0) {
      upscalerRef.current?.stop();
      upscalerRef.current = null;
      canvas.style.display = 'none';
      video.style.opacity = '1';
      return;
    }
    try {
      if (!upscalerRef.current) upscalerRef.current = new Upscaler(canvas, video);
      upscalerRef.current.start(sr);
      canvas.style.display = 'block';
      video.style.opacity = '0';
      setSrError('');
    } catch (err) {
      setSrError('超分不可用：' + String((err as Error).message || err));
      setSr(0);
    }
  }, [sr]);

  useEffect(() => () => { upscalerRef.current?.stop(); }, []);

  // 记历史 + 改标题
  useEffect(() => {
    if (!data || !episode) return;
    pushHistory({
      source: data.source, sourceName: data.sourceName, id: data.id, title: data.title,
      pic: data.pic, episode: episode.name, url: episode.url, road: road?.name || '',
      quality: probeInfo || (road?.bestQuality.label ?? ''), at: Date.now(),
    });
    document.title = data.title + ' · ' + episode.name + ' · DeepMV';
  }, [data?.id, episode?.url, probeInfo, road?.name, episode?.name, data?.title, data?.source, data?.sourceName, data?.pic]);

  const next = useCallback(() => {
    if (!road || !data) return;
    if (epIndex + 1 < road.episodes.length) { setEpIndex(epIndex + 1); return; }
    if (roadIndex + 1 < data.roads.length) { setRoadIndex(roadIndex + 1); setEpIndex(0); }
  }, [road, epIndex, roadIndex, data]);

  const showBar = useCallback(() => {
    setBarVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setBarVisible(false), 3400);
  }, []);

  const changeSpeed = (v: number) => {
    setSpeed(v);
    if (videoRef.current) videoRef.current.playbackRate = v;
  };

  const toggleFullscreen = () => {
    const el = document.querySelector('.player-video-wrap');
    if (!document.fullscreenElement) void el?.requestFullscreen();
    else void document.exitFullscreen();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;
      if (e.code === 'Space') { e.preventDefault(); v.paused ? void v.play() : v.pause(); }
      if (e.code === 'ArrowRight') v.currentTime += 10;
      if (e.code === 'ArrowLeft') v.currentTime -= 10;
      if (e.key === 'n' || e.key === 'N') next();
      showBar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, showBar]);

  const status = useMemo(() => {
    if (detail.loading) return '正在加载详情…';
    if (detail.error) return detail.error;
    if (resolved.loading) return '正在解析播放地址…';
    if (resolved.error) return resolved.error;
    if (autoSwitching) return '这条线路播不了，正在找其它来源…';
    if (playError) return playError;
    return '';
  }, [detail.loading, detail.error, resolved.loading, resolved.error, autoSwitching, playError]);

  return (
    <div className="player-page">
      <div className="player-stage" onMouseMove={showBar}>
        <button className="player-close" onClick={() => navigate(-1)} title="关闭">✕</button>
        <div className="player-title-strip">
          <span style={{ fontWeight: 700 }}>{data?.title || titleHint}</span>
          {episode && <span className="muted">{road?.name} · {episode.name}</span>}
          {probeInfo && <span style={{ color: 'var(--gold)' }}>{probeInfo}</span>}
          {adNotice && <span className="ad-chip">{adNotice}</span>}
        </div>
        <div className="player-video-wrap">
          <canvas ref={canvasRef} className="sr-canvas" style={{ display: 'none' }} />
          <video
            ref={videoRef}
            playsInline
            onClick={() => { const v = videoRef.current; if (!v) return; v.paused ? void v.play() : v.pause(); }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onLoadedMetadata={(e) => { durationRef.current = (e.target as HTMLVideoElement).duration; }}
            onEnded={next}
          />
          {status && <div className="toast" style={{ position: 'absolute', top: '44%' }}>{status}</div>}
        </div>
        <div className={'player-bar' + (barVisible ? '' : ' hide')}>
          <button className="pb-btn" onClick={() => navigate(-1)} title="返回">←</button>
          <button className="pb-btn" onClick={() => { const v = videoRef.current; if (v) v.currentTime -= 10; }} title="后退 10 秒">⇤</button>
          <button className="pb-btn" onClick={() => { const v = videoRef.current; if (!v) return; v.paused ? void v.play() : v.pause(); }}>
            {playing ? '⏸' : '▶'}
          </button>
          <button className="pb-btn" onClick={() => { const v = videoRef.current; if (v) v.currentTime += 10; }} title="前进 10 秒">⇥</button>
          <span className="pb-time" ref={timeRef}>00:00 / 00:00</span>
          <div className="pb-progress" onClick={(e) => {
            const v = videoRef.current;
            const rect = e.currentTarget.getBoundingClientRect();
            if (v && v.duration) v.currentTime = ((e.clientX - rect.left) / rect.width) * v.duration;
          }}>
            <div className="pb-fill" ref={fillRef} style={{ width: '0%' }} />
          </div>
          <button className="pb-select" onClick={() => setSr((v) => ((v + 1) % 3) as 0 | 1 | 2)} title="本地超分">
            {'SR ' + (sr === 0 ? 'OFF' : sr === 1 ? '1.5x' : '2x')}
          </button>
          <select className="pb-select" value={speed} onChange={(e) => changeSpeed(Number(e.target.value))}>
            {[0.75, 1, 1.25, 1.5, 2].map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
          <button className="pb-btn" onClick={next} title="下一集">⏭</button>
          <button className="pb-btn" onClick={toggleFullscreen} title="全屏">⛶</button>
        </div>
      </div>
      <aside className="player-side">
        <div className="player-side-head">
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{data?.title || titleHint}</div>
          <div className="muted">{road?.name} · {episode?.name}{probeInfo ? ' · ' + probeInfo : ''}</div>
          <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[0, 1, 2].map((v) => (
              <button key={v} className={'chip' + (sr === v ? ' active' : '')} onClick={() => setSr(v as 0 | 1 | 2)} style={{ fontSize: 11.5, padding: '5px 10px' }}>
                {v === 0 ? '超分关' : v === 1 ? '超分 1.5x' : '超分 2x'}
              </button>
            ))}
          </div>
          {srError && <div className="muted" style={{ marginTop: 8, color: 'var(--danger)' }}>{srError}</div>}
        </div>
        {data && data.roads.length > 1 && (
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {data.roads.map((r, i) => (
              <button key={r.name + i} className={'chip' + (i === roadIndex ? ' active' : '')}
                onClick={() => { setRoadIndex(i); setEpIndex(0); }} style={{ fontSize: 11.5, padding: '5px 10px' }}>
                {r.name.slice(0, 12)}
              </button>
            ))}
          </div>
        )}
        <div className="player-side-body">
          {road?.episodes.map((ep, i) => (
            <button key={ep.url + i} className={'ep' + (i === epIndex ? ' playing' : '')}
              onClick={() => setEpIndex(i)} style={{ padding: '9px 6px', fontSize: 12 }}>
              {ep.name.replace(/第0*/, '').replace(/集$/, '').replace(/^0+(?=\d)/, '')}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
}
