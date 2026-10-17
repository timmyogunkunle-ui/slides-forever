// Shared slide rendering for the operator window and the output window.
(function () {
  const S = (window.Shine = window.Shine || {});

  S.src = (path) => (!path ? '' : path.startsWith('app:') ? path.slice(4) : window.__TAURI__.core.convertFileSrc(path));

  S.esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const DEFAULT_STYLE = {
    font: 'Segoe UI', weight: 800, color: '#ffffff', size: 9, shadow: true,
    uppercase: false, align: 'center', position: 'middle',
  };
  S.DEFAULT_STYLE = DEFAULT_STYLE;

  /** Background layer element for a {type, path, color} background. */
  S.bgElement = function (bg, { muted = true, play = true, thumb = false } = {}) {
    bg = bg || { type: 'gradient' };
    let el;
    if (bg.type === 'video') {
      el = document.createElement('video');
      el.src = S.src(bg.path) + (thumb ? '#t=1' : '');
      el.muted = true; // background videos are always silent
      el.loop = true;
      el.playsInline = true;
      el.preload = thumb ? 'metadata' : 'auto';
      if (play && !thumb) el.autoplay = true;
    } else if (bg.type === 'image' || bg.type === 'gif') {
      el = document.createElement('img');
      el.src = S.src(bg.path);
      el.draggable = false;
      el.decoding = 'async';
    } else if (bg.type === 'color') {
      el = document.createElement('div');
      el.style.background = bg.color || '#000';
    } else {
      el = document.createElement('div');
      el.className = 'grad';
    }
    return el;
  };
  S.bgKey = (bg) => (bg ? `${bg.type}|${bg.path || ''}|${bg.color || ''}` : 'gradient');

  /** Foreground media (an image/video/gif shown as the item itself). */
  S.mediaElement = function (media, { muted = true, play = true, thumb = false } = {}) {
    let el;
    if (media.type === 'video') {
      el = document.createElement('video');
      el.src = S.src(media.path) + (thumb ? '#t=1' : '');
      el.muted = muted;
      el.loop = !!media.loop;
      el.playsInline = true;
      el.preload = thumb ? 'metadata' : 'auto';
      if (play && !thumb) el.autoplay = true;
    } else {
      el = document.createElement('img');
      el.src = S.src(media.path);
      el.draggable = false;
    }
    return el;
  };

  /** Build the text layer for a slide. */
  S.textElement = function (slide, style) {
    style = Object.assign({}, DEFAULT_STYLE, style || {});
    const wrap = document.createElement('div');
    wrap.className = 'sl-text' + (style.position === 'top' ? ' pos-top' : style.position === 'bottom' ? ' pos-bottom' : '') +
      (style.align === 'left' ? ' al-left' : '');
    const body = document.createElement('div');
    body.className = 'sl-body' + (style.shadow ? ' shadow' : '');
    body.style.fontFamily = `"${style.font}", "Segoe UI", system-ui, sans-serif`;
    body.style.fontWeight = style.weight;
    body.style.color = style.color;
    if (style.uppercase) body.style.textTransform = 'uppercase';
    if (slide.html) body.innerHTML = slide.html;
    else body.textContent = slide.text || '';
    const cap = document.createElement('div');
    cap.className = 'sl-cap' + (style.shadow ? ' shadow' : '');
    cap.style.color = style.color;
    cap.style.fontFamily = body.style.fontFamily;
    cap.textContent = slide.caption || '';
    wrap.append(body, cap);
    wrap._fit = () => S.fit(body, style.size * (slide.scale || 1));
    return wrap;
  };

  /** Shrink text until it fits its box. Size is in cqh. */
  S.fit = function (body, size) {
    const wrap = body.parentElement;
    let s = size;
    body.style.fontSize = s + 'cqh';
    for (let i = 0; i < 24; i++) {
      // measure against the space the slide actually has, not the text's own (auto) height
      const cap = body.nextElementSibling;
      const gap = parseFloat(getComputedStyle(wrap).rowGap) || 0;
      const avail = wrap.clientHeight - (cap && cap.textContent ? cap.offsetHeight + gap : 0);
      if (body.scrollHeight <= avail + 2 && body.scrollWidth <= body.clientWidth + 2) break;
      s *= 0.92;
      body.style.fontSize = s + 'cqh';
    }
  };

  /**
   * Render a complete slide into `host` (replaces contents).
   * slide = {kind:'text'|'media'|'blank', text|html, caption, label, bg, media}
   */
  S.renderSlide = function (host, slide, opts = {}) {
    host.innerHTML = '';
    host.classList.add('sl');
    if (!slide) return;
    const bgLayer = document.createElement('div');
    bgLayer.className = 'sl-bg';
    if (opts.hideBg && slide.kind !== 'brand') { /* background layer cleared */ }
    else if (slide.kind === 'brand') bgLayer.append(S.brandElement());
    else if (slide.kind !== 'media') bgLayer.append(S.bgElement(slide.bg, opts));
    host.append(bgLayer);
    if (slide.kind === 'media' && slide.media && !opts.hideMedia) {
      const m = document.createElement('div');
      m.className = 'sl-media';
      m.append(S.mediaElement(slide.media, opts));
      host.append(m);
      if (opts.thumb && slide.media.type !== 'image') {
        const b = document.createElement('div');
        b.className = 'sl-badge';
        b.innerHTML = slide.media.type === 'video' ? S.icon('film') : '<b style="font:900 4.5cqh Segoe UI">GIF</b>';
        host.append(b);
      }
    }
    if ((slide.kind === 'text' || (slide.kind === 'brand' && slide.text)) && !opts.hideText) {
      const t = S.textElement(slide, slide.kind === 'brand' ? { ...opts.style, position: 'bottom', shadow: false, color: '#3a2718' } : opts.style);
      host.append(t);
      requestAnimationFrame(t._fit);
    }
    if (opts.label && slide.label) {
      const l = document.createElement('div');
      l.className = 'sl-label';
      l.textContent = slide.label;
      host.append(l);
    }
  };

  // ======================= Filters =======================
  // Filters sit on top of whatever is live and stay until turned off. Three kinds:
  //   colour  – change the look of the background picture/video (never the words)
  //   effect  – animated or textured layers over everything
  //   screen  – on-screen items: lower third, banner, logo, clock, countdown
  S.FILTERS = [
    { id: 'warm', group: 'Colour', name: 'Warm glow', css: 'sepia(.25) saturate(1.25) hue-rotate(-8deg) brightness(1.03)', tint: 'rgba(255, 140, 40, .45)' },
    { id: 'cool', group: 'Colour', name: 'Cool blue', css: 'saturate(.75) brightness(.95)', tint: 'rgba(40, 110, 255, .6)' },
    { id: 'mono', group: 'Colour', name: 'Black and white', css: 'grayscale(1) contrast(1.1)' },
    { id: 'vintage', group: 'Colour', name: 'Vintage', css: 'sepia(.55) contrast(.92) brightness(1.04) saturate(.9)', tint: 'rgba(150, 100, 40, .35)' },
    { id: 'dim', group: 'Colour', name: 'Dim background', css: 'brightness(.5)', hint: 'Makes lyrics easier to read on busy backgrounds' },
    { id: 'soft', group: 'Colour', name: 'Soft focus', css: 'blur(.7cqh) brightness(.9)' },
    { id: 'snow', group: 'Effects', name: 'Falling snow' },
    { id: 'rain', group: 'Effects', name: 'Gentle rain' },
    { id: 'bokeh', group: 'Effects', name: 'Golden bokeh' },
    { id: 'rays', group: 'Effects', name: 'Light rays' },
    { id: 'vignette', group: 'Effects', name: 'Vignette' },
    { id: 'grain', group: 'Effects', name: 'Film grain' },
    { id: 'lowerThird', group: 'On screen', name: 'Lower third', options: [['name', 'Name', 'Pastor John Smith'], ['role', 'Title or role', 'Senior Pastor']] },
    { id: 'banner', group: 'On screen', name: 'Banner', options: [['text', 'Text', 'Welcome to our service']] },
    { id: 'logo', group: 'On screen', name: 'Logo', options: [['corner', 'Corner (top-left, top-right, bottom-left, bottom-right)', 'top-right']] },
    { id: 'clock', group: 'On screen', name: 'Clock' },
    { id: 'countdown', group: 'On screen', name: 'Countdown', options: [['minutes', 'Minutes', '5'], ['label', 'Label', 'Service starts in']] },
  ];
  S.filterById = (id) => S.FILTERS.find((f) => f.id === id);

  /** CSS filter string for the background/media layers from the active colour filters. */
  S.filterCss = (active) => (active || []).map((id) => S.filterById(id)?.css).filter(Boolean).join(' ') || '';

  const opt = (options, id, key) => {
    const f = S.filterById(id);
    const v = options?.[id]?.[key];
    return v != null && v !== '' ? v : (f?.options?.find((o) => o[0] === key)?.[2] ?? '');
  };

  /**
   * Draw the active filters into `host` (a .sl stage). `f` = { active: [ids], options, endsAt }.
   * Re-renders only when the filter set changes, so animations keep running between slides.
   */
  S.renderFilters = function (host, f, { still = false } = {}) {
    const key = f && f.active && f.active.length ? JSON.stringify([f.active, f.options, f.endsAt]) : '';
    if (host._fx === key) return;
    host._fx = key;
    host.querySelectorAll(':scope > .sl-fx, :scope > .sl-fx-under').forEach((x) => { x._stop?.(); x.remove(); });
    // colour filters tint the background and media, not the text
    const css = key ? S.filterCss(f.active) : '';
    host.querySelectorAll(':scope > .sl-bg, :scope > .sl-media, :scope > #bgWrap, :scope > #mediaWrap').forEach((el) => { el.style.filter = css; });
    if (!key) return;
    // Colour tints sit between the picture and the words, so the text keeps its own colour.
    const tints = f.active.map((id) => S.filterById(id)?.tint).filter(Boolean);
    if (tints.length) {
      const under = document.createElement('div');
      under.className = 'sl-fx-under';
      for (const t of tints) under.append(el('div', 'fx-tint', { background: t }));
      host.insertBefore(under, host.querySelector(':scope > .sl-text, :scope > #textWrap'));
    }
    const fx = document.createElement('div');
    fx.className = 'sl-fx';
    for (const id of f.active) {
      const def = S.filterById(id);
      if (!def) continue;
      switch (id) {
        case 'vignette': fx.append(el('div', 'fx-vignette')); break;
        case 'rays': fx.append(el('div', 'fx-rays')); break;
        case 'grain': fx.append(el('div', 'fx-grain')); break;
        case 'snow': case 'rain': case 'bokeh': fx.append(particles(id, still)); break;
        case 'lowerThird': {
          const b = el('div', 'fx-lower');
          b.innerHTML = `<b>${S.esc(opt(f.options, id, 'name'))}</b><span>${S.esc(opt(f.options, id, 'role'))}</span>`;
          fx.append(b);
          break;
        }
        case 'banner': { const b = el('div', 'fx-banner'); b.textContent = opt(f.options, id, 'text'); fx.append(b); break; }
        case 'logo': {
          const b = el('div', 'fx-logo fx-' + (opt(f.options, id, 'corner') || 'top-right').replace(/[^a-z-]/g, ''));
          b.innerHTML = '<img src="logo.png" alt="">';
          fx.append(b);
          break;
        }
        case 'clock': case 'countdown': fx.append(ticking(id, f, still)); break;
      }
    }
    host.append(fx);
    fx._stop = () => fx.querySelectorAll('*').forEach((x) => x._stop?.());
  };

  function el(tag, cls, style) {
    const d = document.createElement(tag);
    d.className = cls;
    if (style) Object.assign(d.style, style);
    return d;
  }

  function ticking(id, f, still) {
    const d = el('div', id === 'clock' ? 'fx-clock' : 'fx-countdown');
    const label = id === 'countdown' ? S.esc(opt(f.options, id, 'label')) : '';
    const draw = () => {
      if (id === 'clock') {
        d.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else {
        const ends = f.endsAt || Date.now() + (+opt(f.options, id, 'minutes') || 5) * 60000;
        const left = Math.max(0, Math.round((ends - Date.now()) / 1000));
        const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
        d.innerHTML = `${label ? `<small>${label}</small>` : ''}<b>${mm}:${ss}</b>`;
      }
    };
    draw();
    if (!still) {
      const t = setInterval(() => (d.isConnected ? draw() : clearInterval(t)), 500);
      d._stop = () => clearInterval(t);
    }
    return d;
  }

  /** Snow, rain and bokeh drawn on a canvas sized to the stage. */
  function particles(kind, still) {
    const c = el('canvas', 'fx-canvas');
    const ctx = c.getContext('2d');
    let parts = [], raf = 0, W = 0, H = 0;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const make = () => {
      const r = c.getBoundingClientRect();
      W = c.width = Math.max(1, Math.round(r.width * Math.min(devicePixelRatio, 1.5)));
      H = c.height = Math.max(1, Math.round(r.height * Math.min(devicePixelRatio, 1.5)));
      const n = kind === 'snow' ? 140 : kind === 'rain' ? 180 : 28;
      parts = Array.from({ length: n }, () => ({
        x: rnd(0, W), y: rnd(0, H),
        r: kind === 'snow' ? rnd(.003, .009) * H : kind === 'bokeh' ? rnd(.03, .09) * H : rnd(.012, .03) * H,
        v: kind === 'snow' ? rnd(.0006, .0018) * H : kind === 'rain' ? rnd(.012, .02) * H : rnd(.0002, .0006) * H,
        d: rnd(-.5, .5), a: rnd(.25, .8), p: rnd(0, Math.PI * 2),
      }));
    };
    const frame = (tm) => {
      if (!c.isConnected) return;
      if (!W) make();
      ctx.clearRect(0, 0, W, H);
      for (const q of parts) {
        if (kind === 'snow') {
          q.y += q.v; q.x += Math.sin(tm / 1400 + q.p) * .4 + q.d * .2;
          ctx.globalAlpha = q.a; ctx.fillStyle = '#fff';
          ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, Math.PI * 2); ctx.fill();
        } else if (kind === 'rain') {
          q.y += q.v; q.x += q.v * .12;
          ctx.globalAlpha = q.a * .5; ctx.strokeStyle = '#cfe0ff'; ctx.lineWidth = Math.max(1, H / 900);
          ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.r * .12, q.y - q.r); ctx.stroke();
        } else {
          q.y -= q.v; q.x += Math.sin(tm / 3000 + q.p) * .3;
          const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, q.r);
          const a = q.a * (.35 + .25 * Math.sin(tm / 1600 + q.p));
          g.addColorStop(0, `rgba(255, 210, 130, ${a})`); g.addColorStop(1, 'rgba(255, 190, 90, 0)');
          ctx.globalAlpha = 1; ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, Math.PI * 2); ctx.fill();
        }
        if (q.y > H + q.r) { q.y = -q.r; q.x = rnd(0, W); }
        if (q.y < -q.r) { q.y = H + q.r; q.x = rnd(0, W); }
        if (q.x > W + q.r) q.x = -q.r;
        if (q.x < -q.r) q.x = W + q.r;
      }
      if (!still) raf = requestAnimationFrame(frame);
    };
    requestAnimationFrame((t) => { make(); frame(t); if (still) frame(t + 16); });
    new ResizeObserver(() => { W = 0; }).observe(c);
    c._stop = () => cancelAnimationFrame(raf);
    return c;
  }

  /** Default standby / logo screen. */
  S.brandElement = function () {
    const d = document.createElement('div');
    d.className = 'sl-brand';
    d.innerHTML = '<img src="logo.png" alt="" draggable="false">';
    return d;
  };

  /** Scrolling message bar. Re-renders only when the message or its style changes. */
  S.renderTicker = function (host, t) {
    const key = t && t.on && t.text ? JSON.stringify(t) : '';
    if (host._tk === key) return;
    host._tk = key;
    host.querySelectorAll(':scope > .sl-ticker').forEach((x) => x.remove());
    if (!key) return;
    const bar = document.createElement('div');
    bar.className = 'sl-ticker pos-' + (t.position === 'top' ? 'top' : 'bottom');
    bar.style.background = t.bg || '#2a1d13';
    bar.style.color = t.color || '#ffffff';
    const span = document.createElement('span');
    span.textContent = t.text;
    bar.append(span);
    host.append(bar);
    {
      const W = host.clientWidth || 1;
      const H = host.clientHeight || 1;
      const w = span.offsetWidth;
      const pxPerSec = (t.speed || 110) * (H / 1080);
      span.style.setProperty('--from', W + 'px');
      span.style.setProperty('--to', -w + 'px');
      span.style.setProperty('--dur', Math.max(4, (W + w) / pxPerSec) + 's');
    }
  };

  // ---- icons (stroke icons, 24x24) ----
  const P = {
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    play: '<path d="M6 4l14 8-14 8z" fill="currentColor"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    film: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    black: '<rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"/>',
    textoff: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/><path d="M3 3l18 18"/>',
    star: '<path d="M12 2l3 7h7l-5.5 4.5 2 7.5L12 17l-6.5 4 2-7.5L2 9h7z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
    live: '<circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    layers: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    grip: '<circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8"/>',
    gif: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M8.5 10.5H7a1.5 1.5 0 0 0 0 3h1.5v-1.5M12 10v4M16 14v-4h2M16 12h1.5"/>',
    text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
    rewind: '<path d="M11 19 2 12l9-7v14z" fill="currentColor"/><path d="M22 19l-9-7 9-7v14z" fill="currentColor"/>',
    forward: '<path d="M13 19l9-7-9-7v14z" fill="currentColor"/><path d="M2 19l9-7-9-7v14z" fill="currentColor"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
    mute: '<path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor"/><path d="m22 9-6 6M16 9l6 6"/>',
    sparkle: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    ticker: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 12h8M17 10l2 2-2 2"/>',
    slides: '<rect x="3" y="6" width="14" height="10" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v9"/><path d="M8 19h8"/>',
    loop: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  };
  S.icon = (name, cls = '') =>
    `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
})();
