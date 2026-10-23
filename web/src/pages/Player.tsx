import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Hls from 'hls.js';
import { api, DetailResult, pushHistory } from '../api';
import { Upscaler } from '../upscale';

/**
 * 播放器。
 *
 * 卡顿的根因是每帧都 setState：timeupdate 每秒触发 4 次，每次都重渲染整个组件树
 * （包括几百个选集按钮）。这里改成 ref + 直接写 DOM，只在「播放状态、切集、错误」
 * 这类真正需要重绘的时刻才 setState。
 */
export default function Player() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const source = params.get('s') || '';
  const id = params.get('i') || '';
  const titleHint = params.get('t') || '';

  const [detail, setDetail] = useState<DetailResult | null>(null);
  const [roadIndex, setRoadIndex] = useState(Number(params.get('r') || 0));
  const [epIndex, setEpIndex] = useState(Number(params.get('e') || 0));
  const [resolved, setResolved] = useState('');
  const [status, setStatus] = useState('正在解析视频地址…');
  const [probeInfo, setProbeInfo] = useState('');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [sr, setSr] = useState(0);
  const [srError, setSrError] = useState('');
  const [adNotice, setAdNotice] = useState('');
  const [barVisible, setBarVisible] = useState(true);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const upscalerRef = useRef<Upscaler | null>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<number>();
  const rafRef = useRef<number>();
  const durationRef = useRef(0);
  const failedRef = useRef(false);
  const triedRef = useRef<string[]>([]);

  /* ---------- 详情 ---------- */
  useEffect(() => {
    if (!source || !id) return;
    api.detail(source, id).then(setDetail).catch(() => setStatus('无法加载详情'));
  }, [source, id]);

  const road = detail?.roads[roadIndex];
  const episode = road?.episodes[epIndex];

  useEffect(() => { failedRef.current = false; }, [episode?.url]);

  /* ---------- 解析地址 ---------- */
  useEffect(() => {
    if (!episode) return;
    let alive = true;
    setStatus('正在解析视频地址…');
    setResolved('');
    setProbeInfo('');
    setAdNotice('');
    api.resolve(episode.url)
      .then((res) => {
        if (!alive) return;
        setResolved(res.url);
        setStatus('');
        if (res.mode === 'manifest' || res.mode === 'proxy') setAdNotice('已开启广告过滤');
        api.probe(res.source || episode.url)
          .then((probe) => { if (alive && probe.ok) setProbeInfo(probe.label + ' · ' + probe.width + 'x' + probe.height); })
          .catch(() => undefined);
      })
      .catch((err) => { if (alive) setStatus('解析失败：' + String(err.message || err)); });
    return () => { alive = false; };
  }, [episode?.url]);

  /* ---------- HLS 装载 ---------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resolved) return;
    let hls: Hls | null = null;
    video.pause();
    video.removeAttribute('src');
    video.load();

    const isHls = /\.m3u8/i.test(resolved) || resolved.includes('/api/proxy');
    if (isHls && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 90,
        backBufferLength: 30,
        // 广告已被服务端清掉，播放器不需要再等 discontinuity
        maxBufferHole: 0.5,
      });
      hls.loadSource(resolved);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal && !failedRef.current) {
          setStatus('线路异常，正在尝试其它来源…');
          void tryNextSource();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl') && isHls) {
      video.src = resolved;
    } else {
      video.src = resolved;
    }

    const onReady = () => {
      setStatus('');
      failedRef.current = false;
      void video.play().catch(() => setStatus('点击画面开始播放'));
    };
    const onErr = () => { if (!failedRef.current) { setStatus('线路不可用，尝试其它来源…'); void tryNextSource(); } };
    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('error', onErr);
    return () => {
      hls?.destroy();
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('error', onErr);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  /* ---------- 进度条：用 rAF 直写 DOM，不再走 React ---------- */
  useEffect(() => {
    const tick = () => {
      const v = videoRef.current;
      if (v && fillRef.current && timeRef.current) {
        const d = durationRef.current || v.duration || 0;
        if (v.currentTime && d) {
          fillRef.current.style.width = ((v.currentTime / d) * 100).toFixed(2) + '%';
        }
        timeRef.current.textContent = fmt(v.currentTime) + ' / ' + fmt(d);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  /* ---------- 自动隐藏控制栏 ---------- */
  const showBar = useCallback(() => {
    setBarVisible((prev) => (prev ? prev : true));
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setBarVisible(false), 3400);
  }, []);

  const tryNextSource = useCallback(async () => {
    if (failedRef.current || !detail) return;
    failedRef.current = true;
    const key = detail.source + ':' + detail.id;
    try {
      const res = await api.best(detail.title, [...triedRef.current, key]);
      if (res.best) {
        triedRef.current = [...triedRef.current, key];
        navigate('/play?' + new URLSearchParams({
          s: res.best.source, i: res.best.id, r: '0', e: '0', t: res.best.title, sn: res.best.sourceName,
        }).toString());
      } else {
        setStatus('所有来源均不可用');
        failedRef.current = false;
      }
    } catch { setStatus('线路不可用'); failedRef.current = false; }
  }, [detail, navigate]);

  /* ---------- 超分 ---------- */
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
  }, [sr]);

  useEffect(() => () => { upscalerRef.current?.stop(); }, []);

  /* ---------- 记录历史 ---------- */
  useEffect(() => {
    if (episode && detail) {
      pushHistory({
        source: detail.source, sourceName: detail.sourceName, id: detail.id, title: detail.title,
        pic: detail.pic, episode: episode.name, url: episode.url, road: road?.name || '',
        quality: probeInfo || road?.bestQuality.label || '', at: Date.now(),
      });
      document.title = detail.title + ' · ' + episode.name + ' · DeepMV';
    }
  }, [episode?.url, probeInfo, detail, road?.name, episode?.name]);

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

  return (
    <div className="player-page">
      <div className="player-stage" onMouseMove={showBar}>
        <button className="player-close" onClick={() => navigate(-1)} title="关闭">✕</button>
        <div className="player-title-strip">
          <span style={{ fontWeight: 700 }}>{detail?.title || titleHint}</span>
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
          <button className="pb-select" onClick={() => setSr((v) => (v + 1) % 3)} title="本地超分">
            {'SR ' + (sr === 0 ? 'OFF' : sr === 1 ? 'STD' : 'MAX')}
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
