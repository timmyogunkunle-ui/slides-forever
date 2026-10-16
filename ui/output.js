// Live output window: transitions between slides, keeps background videos running between slides,
// shows the standby screen and the scrolling message.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const S = window.Shine;
  const stage = document.getElementById('stage');
  const bgWrap = document.getElementById('bgWrap');
  const mediaWrap = document.getElementById('mediaWrap');
  const textWrap = document.getElementById('textWrap');
  const tickerHost = document.getElementById('tickerHost');
  let fade = 0.35;
  let mediaVideo = null;
  // With several live screens, only the first plays video sound and reports progress.
  let primary = window.__OUT ? !!window.__OUT.primary : true;

  function swap(wrap, key, make) {
    if (wrap._key === key) return null;
    wrap._key = key;
    const ms = stage.dataset.tr === 'cut' ? 0 : fade * 1000 + 80;
    for (const old of [...wrap.children]) {
      if (old.classList.contains('leaving')) continue;
      old.classList.remove('enter');
      old.classList.add('leaving');
      setTimeout(() => {
        old.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
        old.remove();
      }, ms);
    }
    const el = make && make();
    if (!el) return null;
    const layer = document.createElement('div');
    layer.className = 'sl-layer enter hide';
    layer.append(el);
    wrap.append(layer);
    void layer.offsetWidth; // commit the start state so the transition always runs
    layer.classList.remove('hide');
    return layer;
  }

  function apply(p) {
    if (!p) p = {};
    fade = typeof p.fade === 'number' ? p.fade : 0.35;
    document.documentElement.style.setProperty('--fade', fade + 's');
    stage.dataset.tr = p.transition || 'fade';
    let slide = p.slide || null;
    if (p.standby) slide = p.standby;
    stage.classList.toggle('black', !!p.black || !slide);
    textWrap.classList.toggle('cleared', !!p.clear && !p.standby);
    S.renderTicker(tickerHost, p.black ? null : p.ticker);
    if (!slide) return; // keep layers so un-blacking resumes instantly

    const isText = slide.kind === 'text';
    const isBrand = slide.kind === 'brand';
    const isMedia = slide.kind === 'media' && slide.media;

    // background (behind text slides, or the logo standby)
    const bgKey = isBrand ? 'brand' : isText ? S.bgKey(slide.bg) : 'none';
    swap(bgWrap, bgKey, isBrand ? () => S.brandElement() : isText ? () => S.bgElement(slide.bg, { play: true }) : null);

    // foreground media (image / gif / video / slide-group page)
    const mKey = isMedia ? slide.media.path + '|' + slide.media.loop : 'none';
    if (mediaWrap._key !== mKey) {
      mediaVideo = null;
      swap(mediaWrap, mKey, isMedia ? () => {
        const el = S.mediaElement(slide.media, { muted: true, play: true });
        if (el.tagName === 'VIDEO') {
          mediaVideo = el;
          const start = +slide.media.start || 0;
          if (start > 0) el.addEventListener('loadedmetadata', () => { el.currentTime = Math.min(start, (el.duration || start) - 0.1); }, { once: true });
          el.addEventListener('ended', () => sendStatus(true));
          el.addEventListener('error', () => primary && invoke('media_status', { status: { error: true } }));
        }
        return el;
      } : null);
    }
    videoPrefs = p.video || videoPrefs;
    applyVideoPrefs();

    // text
    const hasText = isText || (isBrand && slide.text);
    const style = isBrand ? { ...p.style, position: 'bottom', shadow: false, color: '#3a2718' } : p.style;
    const tKey = hasText ? JSON.stringify([slide.kind, slide.text, slide.html, slide.caption, slide.scale, style]) : 'none';
    const layer = swap(textWrap, tKey, hasText ? () => S.textElement(slide, style) : null);
    if (layer) layer.firstChild._fit();
  }

  listen('live', ({ payload }) => apply(payload));
  // Volume / mute come from the operator. Only the first screen ever makes sound.
  let videoPrefs = { volume: 1, muted: false };
  function applyVideoPrefs() {
    const v = mediaVideo;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, +videoPrefs.volume));
    v.muted = !primary || !!videoPrefs.muted;
  }

  listen('role', ({ payload }) => {
    primary = !!payload.primary;
    applyVideoPrefs();
  });

  listen('control', ({ payload: c }) => {
    const v = mediaVideo;
    if (!v) return;
    const clamp = (t) => Math.max(0, Math.min(t, (v.duration || t) - 0.05));
    switch (c.action) {
      case 'toggle': v.paused ? v.play() : v.pause(); break;
      case 'play': v.play(); break;
      case 'pause': v.pause(); break;
      case 'seek': v.currentTime = clamp(c.t || 0); if (c.play) v.play(); break;
      case 'seekBy': v.currentTime = clamp(v.currentTime + (c.d || 0)); break;
      case 'seekFrac': if (v.duration) v.currentTime = clamp(c.f * v.duration); break;
      case 'loop': v.loop = !!c.on; break;
      case 'volume': videoPrefs = { ...videoPrefs, volume: c.v }; applyVideoPrefs(); break;
      case 'mute': videoPrefs = { ...videoPrefs, muted: !!c.on }; applyVideoPrefs(); break;
      // Keeps extra screens in step with the first one.
      case 'sync':
        if (!primary) {
          if (Math.abs(v.currentTime - c.t) > 0.25) v.currentTime = c.t;
          if (c.paused && !v.paused) v.pause();
          if (!c.paused && v.paused && !v.ended) v.play();
        }
        break;
    }
    sendStatus();
  });

  function sendStatus(ended = false) {
    const v = mediaVideo;
    if (!primary || !v || !v.isConnected) return;
    invoke('media_status', {
      status: { time: v.currentTime, duration: v.duration || 0, paused: v.paused, loop: v.loop, ended: ended || v.ended, volume: v.volume, muted: !!videoPrefs.muted },
    });
  }
  setInterval(() => sendStatus(), 250);

  window.addEventListener('resize', () => {
    textWrap.lastChild?.firstChild?._fit?.();
    tickerHost._tk = null;
    invoke('get_live').then(apply);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') invoke('close_this_output'); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  invoke('get_live').then(apply);
})();
