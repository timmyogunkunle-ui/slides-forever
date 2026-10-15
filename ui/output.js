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
        const el = S.mediaElement(slide.media, { muted: !primary, play: true });
        if (el.tagName === 'VIDEO') { mediaVideo = el; el.muted = !primary; } // only one screen plays sound
        return el;
      } : null);
    }

    // text
    const hasText = isText || (isBrand && slide.text);
    const style = isBrand ? { ...p.style, position: 'bottom', shadow: false, color: '#3a2718' } : p.style;
    const tKey = hasText ? JSON.stringify([slide.kind, slide.text, slide.html, slide.caption, slide.scale, style]) : 'none';
    const layer = swap(textWrap, tKey, hasText ? () => S.textElement(slide, style) : null);
    if (layer) layer.firstChild._fit();
  }

  listen('live', ({ payload }) => apply(payload));
  listen('role', ({ payload }) => {
    primary = !!payload.primary;
    if (mediaVideo) mediaVideo.muted = !primary;
  });
  listen('control', ({ payload }) => {
    const v = mediaVideo;
    if (!v) return;
    if (payload.action === 'toggle') v.paused ? v.play() : v.pause();
    if (payload.action === 'seek') { v.currentTime = payload.t || 0; v.play(); }
    if (payload.action === 'seekFrac' && v.duration) v.currentTime = payload.f * v.duration;
  });

  setInterval(() => {
    const v = mediaVideo;
    if (primary && v && v.isConnected) invoke('media_status', { status: { time: v.currentTime, duration: v.duration || 0, paused: v.paused } });
  }, 300);

  window.addEventListener('resize', () => {
    textWrap.lastChild?.firstChild?._fit?.();
    tickerHost._tk = null;
    invoke('get_live').then(apply);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') invoke('close_this_output'); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  invoke('get_live').then(apply);
})();
