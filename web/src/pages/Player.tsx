import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Hls from 'hls.js';
import { api, DetailResult, PlayCandidate, pushHistory } from '../api';
import { Upscaler } from '../upscale';

export default function Player() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const source = params.get('s') || '';
  const id = params.get('i') || '';
  const titleHint = params.get('t') || '';
  const [roadIndex, setRoadIndex] = useState(Number(params.get('r') || 0));
  const [epIndex, setEpIndex] = useState(Number(params.get('e') || 0));
  const [detail, setDetail] = useState<DetailResult | null>(null);
  const [status, setStatus] = useState('正在解析视频地址…');
  const [resolved, setResolved] = useState('');
  const [probeInfo, setProbeInfo] = useState('');
  const [barVisible, setBarVisible] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [tried, setTried] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const upscalerRef = useRef<Upscaler | null>(null);
  const hideTimer = useRef<number>();
  const [sr, setSr] = useState(0);           // 0=关 1=标准 2=强
  const [srError, setSrError] = useState('');

  useEffect(() => {
    if (!source || !id) return;
    api.detail(source, id).then(setDetail).catch(() => setStatus('无法加载详情'));
  }, [source, id]);

  const road = detail?.roads[roadIndex];
  const episode = road?.episodes[epIndex];

  useEffect(() => { setTried([]); setFailed(false); }, [episode?.url]);

  useEffect(() => {
    if (!episode) return;
    let alive = true;
    setStatus('正在解析视频地址…');
    setResolved('');
    setProbeInfo('');
    api.resolve(episode.url)
      .then((res) => {
        if (!alive) return;
        setResolved(res.url);
        setStatus('');
        api.probe(res.source || episode.url)
          .then((probe) => { if (alive && probe.ok) setProbeInfo(probe.label + ' · ' + probe.width + 'x' + probe.height); })
          .catch(() => undefined);
      })
      .catch((err) => { if (alive) setStatus('解析失败：' + String(err.message || err)); });
    return () => { alive = false; };
  }, [episode?.url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resolved) return;
    let hls: Hls | null = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    const isHls = /\.m3u8/i.test(resolved) || resolved.includes('/api/proxy');
    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, maxBufferLength: 40, backBufferLength: 90 });
      hls.loadSource(resolved);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) { setStatus('线路异常，正在尝试其它来源…'); tryNextSource(); }
      });
    } else {
      video.src = resolved;
    }
    const onReady = () => { setStatus(''); setFailed(false); void video.play().catch(() => setStatus('点击画面开始播放')); };
    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('error', () => { setStatus('线路不可用，尝试其它来源…'); tryNextSource(); });
    return () => { hls?.destroy(); video.removeEventListener('loadedmetadata', onReady); };
  }, [resolved]);

  // 超分渲染：开启时把 video 隐藏、由 WebGL 画布输出
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
      upscalerRef.current.start(sr === 2 ? 1.65 : 1.1);
      canvas.style.display = 'block';
      video.style.opacity = '0';
      setSrError('');
    } catch (err) {
      setSrError('超分不可用：' + String((err as Error).message || err));
      setSr(0);
    }
    return () => { /* 保持实例，切换集不重建 */ };
  }, [sr]);

  useEffect(() => () => { upscalerRef.current?.stop(); }, []);

  const tryNextSource = useCallback(async () => {
    if (failed || !detail) return;
    setFailed(true);
    const key = (detail.source + ':' + detail.id);
    try {
      const res = await api.best(detail.title, [...tried, key]);
      if (res.best) {
        setTried((t) => [...t, key]);
        navigate('/play?' + new URLSearchParams({
          s: res.best.source, i: res.best.id, r: '0', e: '0', t: res.best.title, sn: res.best.sourceName,
        }).toString() + '&auto=1');
        setFailed(false);
      } else {
        setStatus('所有来源均不可用');
      }
    } catch { setStatus('线路不可用'); }
  }, [detail, failed, tried, navigate]);

  useEffect(() => {
    if (episode && detail) {
      pushHistory({
        source: detail.source, sourceName: detail.sourceName, id: detail.id, title: detail.title,
        pic: detail.pic, episode: episode.name, url: episode.url, road: road?.name || '',
        quality: probeInfo || road?.bestQuality.label || '', at: Date.now(),
      });
      document.title = detail.title + ' · ' + episode.name + ' · DeepMV';
    }
  }, [episode?.url, probeInfo]);

  const next = useCallback(() => {
    if (!road) return;
    if (epIndex + 1 < road.episodes.length) setEpIndex(epIndex + 1);
    else if (detail && roadIndex + 1 < detail.roads.length) { setRoadIndex(roadIndex + 1); setEpIndex(0); }
  }, [road, epIndex, roadIndex, detail]);

  const changeSpeed = (s: number) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  };

  const toggleFullscreen = () => {
    const el = document.querySelector('.player-video-wrap');
    if (!document.fullscreenElement) void el?.requestFullscreen();
    else void document.exitFullscreen();
  };

  const showBar = () => {
    setBarVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setBarVisible(false), 3400);
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
  }, [next]);

  const pct = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div className="player-page">
      <div className="player-stage" onMouseMove={showBar}>
        <button className="player-close" onClick={() => navigate(-1)} title="关闭">✕</button>
        <div className="player-title-strip">
          <span style={{ fontWeight: 700 }}>{detail?.title || titleHint}</span>
          {episode && <span className="muted">{road?.name} · {episode.name}</span>}
          {probeInfo && <span style={{ color: 'var(--gold)' }}>{probeInfo}</span>}
        </div>
        <div className="player-video-wrap">
          <canvas ref={canvasRef} className="sr-canvas" style={{ display: 'none' }} />
          <video
            ref={videoRef}
            playsInline
            onClick={() => { const v = videoRef.current; if (!v) return; v.paused ? void v.play() : v.pause(); }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => { setCurrent((e.target as HTMLVideoElement).currentTime); showBar(); }}
            onLoadedMetadata={(e) => setDuration((e.target as HTMLVideoElement).duration)}
            onEnded={next}
          />
          {status && <div className="toast" style={{ position: 'absolute', top: '44%' }}>{status}</div>}
        </div>
        <div className={'player-bar' + (barVisible ? '' : ' hide')}>
          <button className="pb-btn" onClick={() => navigate(-1)} title="返回">{'\u2190'}</button>
          <button className="pb-btn" onClick={() => { const v = videoRef.current; if (v) v.currentTime -= 10; }} title="后退 10 秒">{'\u21E4'}</button>
          <button className="pb-btn" onClick={() => { const v = videoRef.current; if (!v) return; v.paused ? void v.play() : v.pause(); }}>
            {playing ? '\u23F8' : '\u25B6'}
          </button>
          <button className="pb-btn" onClick={() => { const v = videoRef.current; if (v) v.currentTime += 10; }} title="前进 10 秒">{'\u21E5'}</button>
          <span className="pb-time">{fmt(current)} / {fmt(duration)}</span>
          <div className="pb-progress" onClick={(e) => {
            const v = videoRef.current;
            const rect = e.currentTarget.getBoundingClientRect();
            if (v && v.duration) v.currentTime = ((e.clientX - rect.left) / rect.width) * v.duration;
          }}>
            <div className="pb-fill" style={{ width: pct + '%' }} />
          </div>
          <button className="pb-select" onClick={() => setSr((v) => (v + 1) % 3)} title="本地超分">
            {'SR ' + (sr === 0 ? 'OFF' : sr === 1 ? 'STD' : 'MAX')}
          </button>
          <select className="pb-select" value={speed} onChange={(e) => changeSpeed(Number(e.target.value))}>
            {[0.75, 1, 1.25, 1.5, 2].map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
          <button className="pb-btn" onClick={next} title="下一集">{'\u23ED'}</button>
          <button className="pb-btn" onClick={toggleFullscreen} title="全屏">{'\u26F6'}</button>
        </div>
      </div>
      <aside className="player-side">
        <div className="player-side-head">
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{detail?.title || titleHint}</div>
          <div className="muted">{road?.name} · {episode?.name}{probeInfo ? ' · ' + probeInfo : ''}</div>
          <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[0, 1, 2].map((v) => (
              <button key={v} className={'chip' + (sr === v ? ' active' : '')} onClick={() => setSr(v)} style={{ fontSize: 11.5, padding: '5px 10px' }}>
                {v === 0 ? '超分关' : v === 1 ? '超分标准' : '超分强力'}
              </button>
            ))}
          </div>
          {srError && <div className="muted" style={{ marginTop: 8, color: 'var(--danger)' }}>{srError}</div>}
        </div>
        {detail && detail.roads.length > 1 && (
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {detail.roads.map((r, i) => (
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