// Slides Forever operator window.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const S = window.Shine;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = S.esc;

  const DEFAULT_SETTINGS = {
    style: { ...S.DEFAULT_STYLE },
    fade: 0.4,
    songBg: null,
    scriptureBg: null,
    versesPerSlide: 1,
    bible: 0,
    outputDisplay: null,
    seeded: false,
    theme: 'sand',
    transition: 'fade',
    standby: { mediaId: null, slide: null, text: '' },
    standbyIdle: true,
    ticker: { text: '', on: false, speed: 110, position: 'bottom', bg: '#2a1d13', color: '#ffffff' },
  };

  const st = {
    songs: [], media: [], groups: [], settings: structuredClone(DEFAULT_SETTINGS), schedule: [],
    missing: new Set(),
    bibles: [], books: [], book: null, chapter: null,
    verses: [], verseSel: new Set(), verseAnchor: null, verseMode: 'chapter',
    preview: null, live: null,
    black: false, clear: false, standby: false,
    auto: { on: false, timer: null, next: 0 },
    outputOn: false, displays: [], pendingDisplay: null,
    selSong: null, selMedia: null, schedSel: null, mediaKind: 'all',
    ver: 0,
  };

  // ---------- helpers ----------
  function paintIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.painted !== el.dataset.icon) {
        el.innerHTML = S.icon(el.dataset.icon);
        el.dataset.painted = el.dataset.icon;
      }
    });
  }
  function setIcon(el, name) { el.dataset.icon = name; paintIcons(el.parentElement); }

  const saveTimers = {};
  function save(name) {
    if (st.unconfigured) return; // first run: nothing is written until a library folder is chosen
    clearTimeout(saveTimers[name]);
    saveTimers[name] = setTimeout(() => {
      invoke('save_doc', { name, value: st[name] }).catch((e) => toast('Could not save ' + name + ': ' + e, true));
    }, 250);
  }

  function toast(msg, err = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.innerHTML = S.icon(err ? 'x' : 'check') + `<span>${esc(msg)}</span>`;
    $('#toasts').append(t);
    setTimeout(() => t.remove(), err ? 5000 : 2600);
  }

  function ask(message, okLabel = 'Delete') {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'modal';
      d.style.width = '440px';
      d.innerHTML = `<div class="modal-inner"><div class="modal-head"><span class="badge">${S.icon('trash')}</span><h2>Are you sure?</h2></div>
        <p style="margin:16px 18px">${esc(message)}</p>
        <div class="modal-foot"><div class="grow"></div><button class="btn" data-v="0">Cancel</button><button class="btn primary" data-v="1">${esc(okLabel)}</button></div></div>`;
      document.body.append(d);
      d.addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]');
        if (b) { d.close(); resolve(b.dataset.v === '1'); }
      });
      d.addEventListener('close', () => { d.remove(); resolve(false); });
      d.showModal();
    });
  }

  function showMenu(x, y, items) {
    const m = $('#ctxMenu');
    m.innerHTML = '';
    for (const it of items) {
      if (it === '-') { m.append(document.createElement('hr')); continue; }
      const b = document.createElement('button');
      if (it.danger) b.className = 'danger';
      b.innerHTML = S.icon(it.icon || 'right') + `<span>${esc(it.label)}</span>`;
      b.onclick = () => { m.hidden = true; it.action(); };
      m.append(b);
    }
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  }
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxMenu')) $('#ctxMenu').hidden = true; });
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault(); });

  const fmtTime = (t) => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------- slide building ----------
  const LABEL_RE = /^\s*[\[(]?\s*(verse|chorus|pre[- ]?chorus|bridge|tag|intro|outro|ending|refrain|interlude|vamp|coda|hook|instrumental)\s*\d*\s*[\])]?\s*:?\s*$/i;
  const SHORT_LABEL_RE = /^\s*[\[(]?(v|c|b|pc)\s?\d{0,2}[\])]?\s*:?\s*$/i;

  function songSections(lyrics) {
    const blocks = (lyrics || '').replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    const out = [];
    for (const b of blocks) {
      const lines = b.split('\n').map((l) => l.trim());
      let label = '';
      if (LABEL_RE.test(lines[0]) || SHORT_LABEL_RE.test(lines[0])) {
        label = lines.shift().replace(/[\[\]():]/g, '').trim();
        label = label.charAt(0).toUpperCase() + label.slice(1);
      }
      let chunk = [];
      const flush = () => { if (chunk.length) out.push({ label, text: chunk.join('\n') }); chunk = []; };
      for (const l of lines) { if (/^-{3,}$/.test(l)) flush(); else chunk.push(l); }
      flush();
    }
    return out;
  }

  const mediaById = (id) => st.media.find((m) => m.id === id);
  function bgFrom(id) {
    const m = id && mediaById(id);
    return m ? { type: m.kind, path: m.path } : null;
  }
  const songById = (id) => st.songs.find((s) => s.id === id);

  function verseRef(v) { return `${v.bookName} ${v.chapter}:${v.verse}`; }
  function rangeTitle(vs) {
    if (!vs.length) return '';
    const a = vs[0], b = vs[vs.length - 1];
    if (vs.length === 1) return verseRef(a);
    if (a.book === b.book && a.chapter === b.chapter) return `${a.bookName} ${a.chapter}:${a.verse}-${b.verse}`;
    return `${verseRef(a)} – ${verseRef(b)}`;
  }

  function slidesFor(item) {
    if (!item) return [];
    if (item.type === 'song') {
      const song = songById(item.id);
      if (!song) return [];
      const bg = bgFrom(song.bg) || bgFrom(st.settings.songBg);
      return songSections(song.lyrics).map((s) => ({ kind: 'text', text: s.text, label: s.label, bg }));
    }
    if (item.type === 'scripture') {
      const bg = bgFrom(st.settings.scriptureBg);
      const n = Math.max(1, +st.settings.versesPerSlide || 1);
      const out = [];
      for (let i = 0; i < item.verses.length; i += n) {
        const g = item.verses.slice(i, i + n);
        const html = g.length > 1 ? g.map((v) => `<sup>${v.verse}</sup>${esc(v.text)}`).join(' ') : null;
        out.push({
          kind: 'text', text: g[0].text, html, bg,
          caption: `${rangeTitle(g)} (${item.bibleName})`,
          label: rangeTitle(g),
          scale: 0.8,
        });
      }
      return out;
    }
    if (item.type === 'media') {
      const m = mediaById(item.id);
      if (!m) return [];
      return [{ kind: 'media', media: { type: m.kind, path: m.path, loop: m.loop !== false }, label: m.name }];
    }
    if (item.type === 'group') {
      const g = groupById(item.id);
      if (!g) return [];
      return g.pages.map((p, i) => ({ kind: 'media', media: { type: /\.gif$/i.test(p) ? 'gif' : 'image', path: p }, label: `Slide ${i + 1}` }));
    }
    return [];
  }
  const groupById = (id) => st.groups.find((g) => g.id === id);

  function itemTitle(item) {
    if (item.type === 'song') return songById(item.id)?.title || '(deleted song)';
    if (item.type === 'scripture') return `${item.title} (${item.bibleName})`;
    if (item.type === 'media') return mediaById(item.id)?.name || '(missing media)';
    if (item.type === 'group') return groupById(item.id)?.name || '(deleted slide group)';
    return '';
  }
  function itemSub(item) {
    if (item.type === 'song') { const s = songById(item.id); return s ? `${songSections(s.lyrics).length} slides` : ''; }
    if (item.type === 'scripture') return `${item.verses.length} verse${item.verses.length > 1 ? 's' : ''}`;
    if (item.type === 'media') { const m = mediaById(item.id); return m ? { image: 'Image', video: 'Video', gif: 'GIF' }[m.kind] : ''; }
    if (item.type === 'group') { const g = groupById(item.id); return g ? `${g.pages.length} slides${g.interval ? ` · auto ${g.interval}s` : ''}` : ''; }
    return '';
  }
  const kindIcon = (item) => ({ song: 'music', scripture: 'book', media: 'image', group: 'slides' })[item.type];
  const kindClass = (item) => (item.type === 'group' ? 'slides' : item.type);

  /** What the Standby button (and an idle output) shows. */
  function standbySlide() {
    const sb = st.settings.standby || {};
    if (sb.slide) return sb.slide;
    const m = sb.mediaId && mediaById(sb.mediaId);
    if (m) {
      if (m.kind === 'video' || !sb.text) return sb.text ? { kind: 'text', text: sb.text, bg: { type: m.kind, path: m.path } } : { kind: 'media', media: { type: m.kind, path: m.path, loop: true } };
      return { kind: 'text', text: sb.text, bg: { type: m.kind, path: m.path } };
    }
    return { kind: 'brand', text: sb.text || '' };
  }
  function setStandbySlide(slide) {
    st.settings.standby = { ...(st.settings.standby || {}), slide: structuredClone(slide), mediaId: null };
    save('settings');
    renderSettings();
    pushLive();
    toast('Standby screen updated — press S or Standby to show it');
  }

  // ---------- preview ----------
  function setPreview(item, index = 0) {
    st.preview = item ? { item, slides: slidesFor(item), index } : null;
    renderPreview();
  }

  function renderStage(host, slide, opts = {}) {
    const key = JSON.stringify([slide, opts.hideText || false, st.ver]);
    if (host._key === key) return;
    host._key = key;
    S.renderSlide(host, slide, { style: st.settings.style, muted: true, ...opts });
    host._tk = null;
  }

  function renderThumbs(host, p, which) {
    if (!p) {
      host.innerHTML = `<div class="slides-empty">${which === 'live' ? 'Nothing live yet — pick something and press <b>GO LIVE</b>.' : 'Click a song, verse or media item to preview it here.'}</div>`;
      host._key = null;
      return;
    }
    if (host._key !== p.item || host._ver !== st.ver || host._n !== p.slides.length) {
      host.innerHTML = '';
      p.slides.forEach((s, i) => {
        const b = document.createElement('button');
        b.className = 'thumb';
        b.dataset.i = i;
        const sl = document.createElement('div');
        b.append(sl);
        b.insertAdjacentHTML('beforeend', `<span class="num">${i + 1}</span><span class="tlabel">${esc(s.label || (s.text || '').split('\n')[0] || '')}</span>`);
        host.append(b);
        S.renderSlide(sl, s, { thumb: true, style: st.settings.style });
      });
      if (!p.slides.length) host.innerHTML = '<div class="slides-empty">This item has no slides yet.</div>';
      host._key = p.item; host._ver = st.ver; host._n = p.slides.length;
    }
    host.querySelectorAll('.thumb').forEach((t) => t.classList.toggle('sel', +t.dataset.i === p.index));
    host.querySelector('.thumb.sel')?.scrollIntoView({ block: 'nearest' });
  }

  function renderPreview() {
    const p = st.preview;
    $('#previewTitle').textContent = p ? itemTitle(p.item) : 'Nothing selected';
    $('#btnEditPreview').hidden = !(p && p.item.type === 'song');
    $('#btnGoLive').disabled = !p || !p.slides.length;
    renderStage($('#previewStage'), p ? p.slides[p.index] : null);
    renderThumbs($('#previewSlides'), p, 'preview');
    $$('#schedule li').forEach((li) => li.classList.toggle('sel', !!p && li.dataset.uid === p.item.uid));
  }

  // ---------- live ----------
  /** True when the output should show the standby screen. */
  const showingStandby = () => st.standby || (!st.live && st.settings.standbyIdle);

  function livePayload() {
    const L = st.live;
    return {
      slide: L ? L.slides[L.index] || null : null,
      black: st.black,
      clear: st.clear,
      standby: showingStandby() ? standbySlide() : null,
      style: st.settings.style,
      fade: st.settings.fade,
      transition: st.settings.transition,
      ticker: st.settings.ticker,
    };
  }

  function pushLive() {
    invoke('set_live', { payload: livePayload() });
    renderLive();
  }

  function renderLive() {
    const L = st.live;
    $('#liveTitle').textContent = st.standby ? 'Standby screen' : L ? itemTitle(L.item) : st.settings.standbyIdle ? 'Standby (nothing live)' : 'Nothing live';
    $('#livePanel').classList.toggle('is-live', st.outputOn && !st.black);
    let slide = L ? L.slides[L.index] : null;
    if (showingStandby()) slide = standbySlide();
    if (st.black) slide = null;
    const stage = $('#liveStage');
    renderStage(stage, slide, { hideText: st.clear && !showingStandby() });
    S.renderTicker(stage, st.black ? null : st.settings.ticker);
    renderThumbs($('#liveSlides'), L, 'live');
    $('#btnBlack').classList.toggle('on', st.black);
    $('#btnClearText').classList.toggle('on', st.clear);
    $('#btnStandby').classList.toggle('on', st.standby);
    const cur = L && L.slides[L.index];
    const isVideo = !!cur && cur.kind === 'media' && cur.media.type === 'video' && !st.black && !st.standby;
    $('#videoBar').hidden = !isVideo;
    const g = L && L.item.type === 'group' && groupById(L.item.id);
    $('#autoBar').hidden = !g;
    if (g) {
      $('#autoInterval').value = String(g.interval || 5);
      $('#autoLoop').checked = g.loop !== false;
      $('#btnAutoPlay').classList.toggle('on', st.auto.on);
      setIcon($('#btnAutoPlay [data-icon]'), st.auto.on ? 'pause' : 'play');
      $('#btnAutoPlay span:last-child').textContent = st.auto.on ? 'Playing' : 'Auto-play';
    }
    $('#btnTicker').classList.toggle('on', !!st.settings.ticker.on);
    $('#liveTransition').value = st.settings.transition;
    $$('#schedule li').forEach((li) => li.classList.toggle('is-live', !!L && li.dataset.uid === L.item.uid));
  }

  // ---- slide group auto-play ----
  function stopAuto() {
    clearInterval(st.auto.timer);
    st.auto.on = false;
    st.auto.timer = null;
    $('#autoStatus').textContent = '';
  }
  function startAuto() {
    const L = st.live;
    const g = L && L.item.type === 'group' && groupById(L.item.id);
    if (!g) return;
    clearInterval(st.auto.timer);
    st.auto.on = true;
    const secs = g.interval || 5;
    st.auto.next = Date.now() + secs * 1000;
    st.auto.timer = setInterval(() => {
      if (!st.live || st.live.item.type !== 'group') return stopAuto(), renderLive();
      const left = Math.ceil((st.auto.next - Date.now()) / 1000);
      $('#autoStatus').textContent = `next in ${Math.max(0, left)}s`;
      if (Date.now() < st.auto.next) return;
      const last = st.live.index >= st.live.slides.length - 1;
      if (last && g.loop === false) { stopAuto(); renderLive(); return; }
      st.live.index = last ? 0 : st.live.index + 1;
      st.auto.next = Date.now() + (g.interval || 5) * 1000;
      st.black = st.standby = false;
      pushLive();
    }, 250);
    renderLive();
  }

  async function goLive(index) {
    const p = st.preview;
    if (!p || !p.slides.length) return;
    stopAuto();
    st.live = { item: p.item, slides: p.slides, index: index ?? p.index };
    st.black = st.clear = st.standby = false;
    await ensureOutput(false);
    const g = p.item.type === 'group' && groupById(p.item.id);
    if (g && g.interval) startAuto();
    pushLive();
  }

  function setLiveIndex(i) {
    const L = st.live;
    if (!L) return;
    L.index = Math.max(0, Math.min(L.slides.length - 1, i));
    st.standby = false; st.black = false;
    if (st.auto.on) st.auto.next = Date.now() + ((groupById(L.item.id)?.interval || 5) * 1000);
    pushLive();
  }

  function step(dir) {
    if (st.live) return setLiveIndex(st.live.index + dir);
    if (st.preview) {
      st.preview.index = Math.max(0, Math.min(st.preview.slides.length - 1, st.preview.index + dir));
      renderPreview();
    }
  }

  function toggleMode(mode) {
    st[mode] = !st[mode];
    if (mode === 'black' && st.black) st.standby = false;
    if (mode === 'standby' && st.standby) st.black = false;
    pushLive();
  }

  function clearAll() {
    stopAuto();
    st.live = null; st.black = st.clear = st.standby = false;
    pushLive();
  }

  function toggleTicker(force) {
    const t = st.settings.ticker;
    t.text = $('#tickerText').value.trim();
    t.on = force ?? !t.on;
    if (t.on && !t.text) { t.on = false; toast('Type a scrolling message first'); $('#tickerText').focus(); }
    save('settings');
    pushLive();
  }

  /** Re-derive slides after songs/media/settings change. */
  function refreshItems() {
    st.ver++;
    for (const k of ['preview', 'live']) {
      const p = st[k];
      if (!p) continue;
      p.slides = slidesFor(p.item);
      p.index = Math.min(p.index, Math.max(0, p.slides.length - 1));
    }
    renderPreview();
    pushLive();
    renderSchedule();
  }

  // ---------- output / displays ----------
  async function refreshDisplays() {
    try { st.displays = await invoke('list_displays'); } catch (e) { st.displays = []; toast('Could not read displays: ' + e, true); }
    renderDisplayLabel();
  }

  function renderDisplayLabel() {
    const d = st.displays.find((x) => x.id === st.settings.outputDisplay);
    $('#displayLabel').textContent = d ? `${d.number} · ${d.name}` : st.settings.outputDisplay ? 'Screen not connected' : 'Choose display';
  }

  function updateOutputUi() {
    $('#btnOutput').classList.toggle('on', st.outputOn);
    $('#outputLabel').textContent = st.outputOn ? 'Output on' : 'Output off';
    renderLive();
  }

  async function openOutput(id) {
    try {
      const used = await invoke('open_output', { id });
      st.outputOn = true;
      st.settings.outputDisplay = used;
      save('settings');
      renderDisplayLabel();
      updateOutputUi();
      setTimeout(pushLive, 300);
      return true;
    } catch (e) {
      toast('Could not open output: ' + e, true);
      return false;
    }
  }

  /** Make sure the live output window is showing. `ask` = open the picker if we can't decide. */
  async function ensureOutput(askUser) {
    if (st.outputOn) return true;
    await refreshDisplays();
    const saved = st.displays.find((d) => d.id === st.settings.outputDisplay && !d.hasControl);
    const other = st.displays.find((d) => !d.hasControl);
    const target = saved || other;
    if (target) return openOutput(target.id);
    if (askUser) openDisplays();
    else toast('Only one screen found — click “Live screen” to choose where the output goes.');
    return false;
  }

  async function openDisplays() {
    await refreshDisplays();
    const cur = st.displays.find((d) => d.id === st.settings.outputDisplay);
    st.pendingDisplay = (cur || st.displays.find((d) => !d.hasControl) || st.displays[0])?.id || null;
    renderDisplayMap();
    const dlg = $('#displayDialog');
    if (!dlg.open) dlg.showModal();
  }

  function renderDisplayMap() {
    const map = $('#displayMap');
    map.innerHTML = '';
    const ds = st.displays;
    if (!ds.length) { map.innerHTML = '<div class="empty-state">No displays found.</div>'; $('#displayDetail').innerHTML = ''; return; }
    const minX = Math.min(...ds.map((d) => d.x)), minY = Math.min(...ds.map((d) => d.y));
    const maxX = Math.max(...ds.map((d) => d.x + d.width)), maxY = Math.max(...ds.map((d) => d.y + d.height));
    const W = map.clientWidth || 800, H = map.clientHeight || 300, pad = 28;
    const sc = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY));
    const offX = (W - (maxX - minX) * sc) / 2, offY = (H - (maxY - minY) * sc) / 2;
    for (const d of ds) {
      const b = document.createElement('button');
      b.className = 'screen' + (d.id === st.pendingDisplay ? ' sel' : '');
      Object.assign(b.style, {
        left: offX + (d.x - minX) * sc + 4 + 'px', top: offY + (d.y - minY) * sc + 4 + 'px',
        width: d.width * sc - 8 + 'px', height: d.height * sc - 8 + 'px',
      });
      const tags = [];
      if (st.outputOn && d.id === st.settings.outputDisplay) tags.push('<i class="live">LIVE</i>');
      if (d.hasControl) tags.push('<i>Controls are here</i>');
      if (d.primary) tags.push('<i>Main</i>');
      b.innerHTML = `<span class="n">${d.number}</span><span class="nm">${esc(d.name)}</span><span class="tags">${tags.join('')}</span>`;
      b.onclick = () => { st.pendingDisplay = d.id; renderDisplayMap(); };
      b.ondblclick = () => useDisplay();
      map.append(b);
    }
    const d = ds.find((x) => x.id === st.pendingDisplay);
    $('#displayDetail').innerHTML = d
      ? `<div class="big">${d.number}. ${esc(d.name)}</div><div class="facts"><span>${d.width} × ${d.height}</span>${d.connection ? `<span>${esc(d.connection)}</span>` : ''}<span>Scale ${Math.round(d.scale * 100)}%</span>${d.primary ? '<span>Main display</span>' : ''}</div>
         ${d.hasControl ? '<div class="warn">The Slides Forever control window is on this screen — the output will cover it. Press Esc on the output to close it.</div>' : ''}`
      : '';
  }

  async function useDisplay() {
    if (!st.pendingDisplay) return;
    if (await openOutput(st.pendingDisplay)) {
      $('#displayDialog').close();
      const d = st.displays.find((x) => x.id === st.pendingDisplay);
      toast(`Live output is on screen ${d ? d.number + ' · ' + d.name : ''}`);
    }
  }

  // ---------- schedule ----------
  function addToSchedule(item, at) {
    const entry = { ...structuredClone(item), uid: uid() };
    if (at == null || at > st.schedule.length) st.schedule.push(entry); else st.schedule.splice(at, 0, entry);
    save('schedule');
    renderSchedule();
    toast(`Added “${itemTitle(entry)}” to the service`);
  }

  function renderSchedule() {
    const ol = $('#schedule');
    ol.innerHTML = '';
    st.schedule.forEach((item, i) => {
      const li = document.createElement('li');
      li.dataset.uid = item.uid;
      li.dataset.i = i;
      li.draggable = true;
      li.innerHTML = `<span class="grip">${S.icon('grip')}</span><span class="kind ${kindClass(item)}">${S.icon(kindIcon(item))}</span>
        <span class="txt"><b>${esc(itemTitle(item))}</b><small>${esc(itemSub(item))}</small></span>
        <button class="icon-btn rm" title="Remove">${S.icon('x')}</button>`;
      if (st.preview && st.preview.item.uid === item.uid) li.classList.add('sel');
      if (st.live && st.live.item.uid === item.uid) li.classList.add('is-live');
      ol.append(li);
    });
    $('#scheduleEmpty').hidden = st.schedule.length > 0;
  }

  $('#schedule').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const i = +li.dataset.i;
    if (e.target.closest('.rm')) {
      st.schedule.splice(i, 1);
      save('schedule');
      renderSchedule();
      return;
    }
    setPreview(st.schedule[i]);
  });
  $('#schedule').addEventListener('dblclick', (e) => {
    const li = e.target.closest('li');
    if (!li || e.target.closest('.rm')) return;
    setPreview(st.schedule[+li.dataset.i]);
    goLive(0);
  });
  $('#schedule').addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const i = +li.dataset.i;
    const item = st.schedule[i];
    const menu = [
      { icon: 'eye', label: 'Preview', action: () => setPreview(item) },
      { icon: 'arrow', label: 'Go live', action: () => { setPreview(item); goLive(0); } },
      { icon: 'up', label: 'Move up', action: () => moveSched(i, i - 1) },
      { icon: 'down', label: 'Move down', action: () => moveSched(i, i + 1) },
    ];
    if (item.type === 'song') menu.push({ icon: 'edit', label: 'Edit song', action: () => openSongEditor(songById(item.id)) });
    menu.push('-', { icon: 'x', label: 'Remove from service', danger: true, action: () => { st.schedule.splice(i, 1); save('schedule'); renderSchedule(); } });
    showMenu(e.clientX, e.clientY, menu);
  });
  function moveSched(from, to) {
    if (to < 0 || to >= st.schedule.length) return;
    const [it] = st.schedule.splice(from, 1);
    st.schedule.splice(to, 0, it);
    save('schedule');
    renderSchedule();
  }

  // drag & drop into / within the schedule
  const DND = 'application/x-shine';
  function dragItem(e, item) { e.dataTransfer.setData(DND, JSON.stringify(item)); e.dataTransfer.effectAllowed = 'copy'; }
  $('#schedule').addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    if (li) { e.dataTransfer.setData('application/x-shine-move', li.dataset.i); e.dataTransfer.effectAllowed = 'move'; }
  });
  const schedPanel = $('.schedule-panel');
  function dropIndex(e) {
    const lis = $$('#schedule li');
    for (const li of lis) {
      const r = li.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return +li.dataset.i;
    }
    return st.schedule.length;
  }
  schedPanel.addEventListener('dragover', (e) => {
    const types = e.dataTransfer.types;
    if (!types.includes(DND) && !types.includes('application/x-shine-move')) return;
    e.preventDefault();
    schedPanel.classList.add('drag-over');
    const idx = dropIndex(e);
    $$('#schedule li').forEach((li) => li.classList.toggle('drop-before', +li.dataset.i === idx));
  });
  schedPanel.addEventListener('dragleave', (e) => {
    if (!schedPanel.contains(e.relatedTarget)) {
      schedPanel.classList.remove('drag-over');
      $$('#schedule li').forEach((li) => li.classList.remove('drop-before'));
    }
  });
  schedPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    schedPanel.classList.remove('drag-over');
    const idx = dropIndex(e);
    const move = e.dataTransfer.getData('application/x-shine-move');
    if (move !== '') {
      const from = +move;
      const [it] = st.schedule.splice(from, 1);
      st.schedule.splice(from < idx ? idx - 1 : idx, 0, it);
      save('schedule');
      renderSchedule();
      return;
    }
    const data = e.dataTransfer.getData(DND);
    if (data) addToSchedule(JSON.parse(data), idx);
  });

  $('#btnClearSchedule').onclick = async () => {
    if (!st.schedule.length) return;
    if (await ask('Remove every item from this service? Your songs and media stay in the library.', 'Clear service')) {
      st.schedule = [];
      save('schedule');
      renderSchedule();
    }
  };

  // ---------- library tabs ----------
  $$('.lib-tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
  function showTab(name) {
    $$('.lib-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    $$('.lib-page').forEach((x) => x.classList.toggle('active', x.dataset.page === name));
    const input = { songs: '#songSearch', bible: '#bibleSearch', media: '#mediaSearch', slides: '#groupSearch' }[name];
    setTimeout(() => $(input)?.focus(), 0);
  }

  // ---------- songs ----------
  function firstLine(song) {
    const s = songSections(song.lyrics)[0];
    return s ? s.text.split('\n')[0] : '';
  }
  function highlight(text, q) {
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }
  function filteredSongs() {
    const q = $('#songSearch').value.trim().toLowerCase();
    let list = st.songs;
    if (q) {
      const t = list.filter((s) => s.title.toLowerCase().includes(q));
      const l = list.filter((s) => !s.title.toLowerCase().includes(q) && ((s.lyrics || '').toLowerCase().includes(q) || (s.author || '').toLowerCase().includes(q)));
      list = [...t, ...l];
    } else {
      list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    }
    return { list, q };
  }
  function renderSongs() {
    const { list, q } = filteredSongs();
    const host = $('#songList');
    $('#songCount').textContent = `${st.songs.length} song${st.songs.length === 1 ? '' : 's'}`;
    if (!list.length) {
      host.innerHTML = st.songs.length
        ? `<div class="empty-state">${S.icon('search')}<b>No songs match “${esc(q)}”</b></div>`
        : `<div class="empty-state">${S.icon('music')}<b>Your song library is empty</b><br />Click <b>New song</b> to type one in, or <b>Import .txt</b> to bring songs in.</div>`;
      return;
    }
    const shown = list.slice(0, 600);
    host.innerHTML = shown.map((s) => {
      let sub = firstLine(s);
      if (q && !s.title.toLowerCase().includes(q)) {
        const line = (s.lyrics || '').split('\n').find((l) => l.toLowerCase().includes(q));
        if (line) sub = line;
      }
      return `<div class="song${st.selSong === s.id ? ' sel' : ''}" draggable="true" data-id="${s.id}">
        <span class="note">${S.icon('music')}</span>
        <span class="txt"><b>${highlight(s.title, q)}</b><small>${highlight(sub, q)}</small></span>
        <span class="acts">
          <button class="icon-btn" data-act="add" title="Add to service">${S.icon('plus')}</button>
          <button class="icon-btn" data-act="edit" title="Edit">${S.icon('edit')}</button>
        </span></div>`;
    }).join('') + (list.length > shown.length ? `<div class="empty-state">…and ${list.length - shown.length} more. Type to search.</div>` : '');
  }
  const songEl = (e) => e.target.closest('.song');
  $('#songList').addEventListener('click', (e) => {
    const el = songEl(e);
    if (!el) return;
    const id = el.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') return addToSchedule({ type: 'song', id });
    if (act === 'edit') return openSongEditor(songById(id));
    selectSong(id);
  });
  function selectSong(id) {
    st.selSong = id;
    $$('#songList .song').forEach((x) => x.classList.toggle('sel', x.dataset.id === id));
    setPreview({ type: 'song', id });
  }
  $('#songList').addEventListener('dblclick', (e) => {
    const el = songEl(e);
    if (!el || e.target.closest('[data-act]')) return;
    selectSong(el.dataset.id);
    goLive(0);
  });
  $('#songList').addEventListener('dragstart', (e) => { const el = songEl(e); if (el) dragItem(e, { type: 'song', id: el.dataset.id }); });
  $('#songList').addEventListener('contextmenu', (e) => {
    const el = songEl(e);
    if (!el) return;
    const song = songById(el.dataset.id);
    selectSong(song.id);
    showMenu(e.clientX, e.clientY, [
      { icon: 'arrow', label: 'Go live', action: () => goLive(0) },
      { icon: 'plus', label: 'Add to service', action: () => addToSchedule({ type: 'song', id: song.id }) },
      { icon: 'edit', label: 'Edit song', action: () => openSongEditor(song) },
      { icon: 'layers', label: 'Change background…', action: () => openChooser('Background for “' + song.title + '”', song.bg, (id) => { song.bg = id; save('songs'); refreshItems(); }) },
      '-',
      { icon: 'trash', label: 'Delete song', danger: true, action: () => deleteSong(song) },
    ]);
  });
  $('#songSearch').addEventListener('input', debounce(renderSongs, 120));
  $('#songSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = filteredSongs().list[0];
      if (first) { selectSong(first.id); if (e.ctrlKey) goLive(0); }
    }
  });

  async function deleteSong(song) {
    if (!(await ask(`Delete “${song.title}” from your library? This can’t be undone.`))) return;
    st.songs = st.songs.filter((s) => s.id !== song.id);
    st.schedule = st.schedule.filter((i) => !(i.type === 'song' && i.id === song.id));
    save('songs'); save('schedule');
    if (st.preview?.item.type === 'song' && st.preview.item.id === song.id) st.preview = null;
    renderSongs(); renderSchedule(); refreshItems();
    toast('Song deleted');
  }

  $('#btnImportSongs').onclick = async () => {
    try {
      const imported = await invoke('import_songs');
      if (!imported.length) return;
      let added = 0, updated = 0;
      for (const s of imported) {
        const existing = st.songs.find((x) => x.title.toLowerCase() === s.title.toLowerCase());
        if (existing) { Object.assign(existing, { lyrics: s.lyrics, author: s.author || existing.author, copyright: s.copyright || existing.copyright }); updated++; }
        else { st.songs.push({ id: uid(), title: s.title, author: s.author, copyright: s.copyright, lyrics: s.lyrics, bg: null }); added++; }
      }
      save('songs');
      renderSongs();
      refreshItems();
      toast(`Imported ${added} new song${added === 1 ? '' : 's'}${updated ? `, updated ${updated}` : ''}`);
    } catch (e) { toast('Import failed: ' + e, true); }
  };

  // ---------- song editor ----------
  let editing = null;
  const editor = $('#songEditor');
  function openSongEditor(song) {
    editing = song ? { ...song } : { id: null, title: '', author: '', copyright: '', lyrics: '', bg: null };
    $('#songEditorTitle').textContent = song ? 'Edit song' : 'New song';
    $('#edTitle').value = editing.title;
    $('#edAuthor').value = editing.author || '';
    $('#edCopyright').value = editing.copyright || '';
    $('#edLyrics').value = editing.lyrics || '';
    const pick = (id) => {
      editing.bg = id;
      renderEditorPreview();
      renderBgPicker($('#edBgPicker'), id, 'Uses the default song background', pick);
    };
    renderBgPicker($('#edBgPicker'), editing.bg, 'Uses the default song background', pick);
    renderEditorPreview();
    editor.showModal();
    setTimeout(() => $(song ? '#edLyrics' : '#edTitle').focus(), 30);
  }
  function renderEditorPreview() {
    const secs = songSections($('#edLyrics').value);
    const bg = bgFrom(editing.bg) || bgFrom(st.settings.songBg);
    $('#edSlideCount').textContent = `${secs.length} slide${secs.length === 1 ? '' : 's'} — this is how they will look`;
    const host = $('#edSlides');
    host.innerHTML = '';
    secs.forEach((s, i) => {
      const b = document.createElement('div');
      b.className = 'thumb';
      const sl = document.createElement('div');
      b.append(sl);
      b.insertAdjacentHTML('beforeend', `<span class="num">${i + 1}</span><span class="tlabel">${esc(s.label || '')}</span>`);
      host.append(b);
      S.renderSlide(sl, { kind: 'text', text: s.text, bg }, { thumb: true, style: st.settings.style });
    });
  }
  $('#edLyrics').addEventListener('input', debounce(renderEditorPreview, 150));
  $$('#songEditor [value=cancel]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); editor.close(); }));
  $('#songEditor form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.submitter?.value;
    editor.close();
    if (v !== 'save' && v !== 'save-service') return;
    const data = {
      title: $('#edTitle').value.trim() || 'Untitled song',
      author: $('#edAuthor').value.trim(),
      copyright: $('#edCopyright').value.trim(),
      lyrics: $('#edLyrics').value.trim(),
      bg: editing.bg || null,
    };
    let song = editing.id && songById(editing.id);
    if (song) Object.assign(song, data);
    else { song = { id: uid(), ...data }; st.songs.push(song); }
    save('songs');
    renderSongs();
    refreshItems();
    if (v === 'save-service') addToSchedule({ type: 'song', id: song.id });
    selectSong(song.id);
    toast(`Saved “${song.title}”`);
  });
  $('#btnNewSong').onclick = () => openSongEditor(null);
  $('#btnEditPreview').onclick = () => st.preview?.item.type === 'song' && openSongEditor(songById(st.preview.item.id));

  // ---------- background pickers ----------
  function renderBgPicker(host, id, emptyText, onPick, title = 'Choose background') {
    const m = id && mediaById(id);
    host.innerHTML = '';
    const sl = document.createElement('div');
    host.append(sl);
    S.renderSlide(sl, m ? (m.kind === 'video' || m.kind === 'gif' || m.kind === 'image' ? { kind: 'text', text: '', bg: { type: m.kind, path: m.path } } : null) : { kind: 'text', text: '', bg: null }, { thumb: true });
    host.insertAdjacentHTML('beforeend', `<span class="bgname">${m ? esc(m.name) : esc(emptyText)}</span>
      <button type="button" class="btn">${S.icon('layers')}Choose…</button>`);
    host.querySelector('button').onclick = () => openChooser(title, id, onPick);
  }

  let chooserCb = null;
  function openChooser(title, current, cb) {
    chooserCb = cb;
    $('#chooserTitle').textContent = title;
    const grid = $('#chooserGrid');
    grid.innerHTML = '';
    if (!st.media.length) grid.innerHTML = `<div class="empty-state">${S.icon('image')}<b>No media yet</b><br />Add images, videos or GIFs to use as backgrounds.</div>`;
    for (const m of st.media) {
      const t = document.createElement('button');
      t.className = 'tile' + (m.id === current ? ' sel' : '');
      const sl = document.createElement('div');
      t.append(sl);
      t.insertAdjacentHTML('beforeend', `<span class="tname">${S.icon(m.kind === 'video' ? 'film' : m.kind === 'gif' ? 'gif' : 'image')}<span>${esc(m.name)}</span></span>`);
      S.renderSlide(sl, { kind: 'media', media: { type: m.kind, path: m.path } }, { thumb: true });
      t.onclick = () => { $('#mediaChooser').close(); chooserCb?.(m.id); };
      grid.append(t);
    }
    $('#mediaChooser').showModal();
  }
  $('#chooserNone').onclick = () => { $('#mediaChooser').close(); chooserCb?.(null); };
  $('#chooserAdd').onclick = async () => {
    const added = await addMedia();
    if (added.length) { $('#mediaChooser').close(); chooserCb?.(added[0].id); }
  };

  // ---------- bible ----------
  async function loadBibles() {
    try {
      st.bibles = await invoke('bible_list');
    } catch (e) { toast('Could not load Bibles: ' + e, true); return; }
    const sel = $('#bibleSelect');
    sel.innerHTML = st.bibles.map((b, i) => `<option value="${i}">${esc(b.name)}</option>`).join('');
    if (st.settings.bible >= st.bibles.length) st.settings.bible = 0;
    sel.value = st.settings.bible;
    await loadBooks();
  }
  const bibleShort = () => (st.bibles[st.settings.bible]?.name || '').split(/[\s—-]/)[0];

  async function loadBooks() {
    st.books = await invoke('bible_books', { bible: +st.settings.bible });
    const host = $('#bookList');
    let html = '';
    st.books.forEach((b, i) => {
      if (st.books.length === 66 && i === 0) html += '<div class="testament">Old Testament</div>';
      if (st.books.length === 66 && i === 39) html += '<div class="testament">New Testament</div>';
      html += `<button data-b="${i}">${esc(b.name)}</button>`;
    });
    host.innerHTML = html;
    if (st.book != null) await selectBook(st.book, st.chapter || 1, true);
  }

  async function selectBook(b, chapter = 1, keepSel = false) {
    st.book = b;
    $$('#bookList button').forEach((x) => x.classList.toggle('sel', +x.dataset.b === b));
    $('#bookList button.sel')?.scrollIntoView({ block: 'nearest' });
    const n = st.books[b]?.chapters || 0;
    $('#chapterList').innerHTML = Array.from({ length: n }, (_, i) => `<button data-c="${i + 1}">${i + 1}</button>`).join('');
    await selectChapter(chapter, keepSel);
  }

  async function selectChapter(c, keepSel = false) {
    st.chapter = c;
    $$('#chapterList button').forEach((x) => x.classList.toggle('sel', +x.dataset.c === c));
    $('#chapterList button.sel')?.scrollIntoView({ block: 'nearest' });
    const verses = await invoke('bible_chapter', { bible: +st.settings.bible, book: st.book, chapter: c });
    const prevSel = keepSel ? [...st.verseSel].map((k) => st.verses[k]?.verse) : [];
    st.verseMode = 'chapter';
    st.verses = verses;
    st.verseSel = new Set(prevSel.map((v) => verses.findIndex((x) => x.verse === v)).filter((i) => i >= 0));
    $('#versesTitle').textContent = `${st.books[st.book].name} ${c}`;
    renderVerses();
    if (keepSel && st.verseSel.size) previewVerses();
  }

  function renderVerses(words = []) {
    const host = $('#verseList');
    if (!st.verses.length) {
      host.innerHTML = `<div class="empty-state">${S.icon('book')}<b>No verses found</b><br />Try a reference like <b>John 3:16</b> or a few words.</div>`;
      return;
    }
    const mark = (t) => {
      let h = esc(t);
      for (const w of words) if (w.length > 1) h = h.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
      return h;
    };
    host.innerHTML = st.verses.map((v, i) => `<div class="verse${st.verseSel.has(i) ? ' sel' : ''}" data-i="${i}" draggable="true">
        ${st.verseMode === 'chapter' ? `<span class="vn">${v.verse}</span>` : `<span class="vref">${esc(verseRef(v))}</span>`}
        <span>${mark(v.text)}</span></div>`).join('');
  }

  function selectedVerses() { return [...st.verseSel].sort((a, b) => a - b).map((i) => st.verses[i]); }
  function scriptureItem() {
    const vs = selectedVerses();
    if (!vs.length) return null;
    return { type: 'scripture', bible: +st.settings.bible, bibleName: bibleShort(), title: rangeTitle(vs), verses: vs };
  }
  function previewVerses() {
    const item = scriptureItem();
    if (item) setPreview(item);
    $$('#verseList .verse').forEach((x) => x.classList.toggle('sel', st.verseSel.has(+x.dataset.i)));
  }

  $('#bookList').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { st.verseSel.clear(); selectBook(+b.dataset.b); } });
  $('#chapterList').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { st.verseSel.clear(); selectChapter(+b.dataset.c); } });
  $('#verseList').addEventListener('click', (e) => {
    const el = e.target.closest('.verse');
    if (!el) return;
    const i = +el.dataset.i;
    if (e.shiftKey && st.verseAnchor != null) {
      st.verseSel = new Set();
      const [a, b] = [Math.min(st.verseAnchor, i), Math.max(st.verseAnchor, i)];
      for (let k = a; k <= b; k++) st.verseSel.add(k);
    } else if (e.ctrlKey) {
      st.verseSel.has(i) ? st.verseSel.delete(i) : st.verseSel.add(i);
      st.verseAnchor = i;
    } else {
      st.verseSel = new Set([i]);
      st.verseAnchor = i;
    }
    previewVerses();
  });
  $('#verseList').addEventListener('dblclick', (e) => {
    const el = e.target.closest('.verse');
    if (!el) return;
    if (!st.verseSel.has(+el.dataset.i)) { st.verseSel = new Set([+el.dataset.i]); previewVerses(); }
    goLive(0);
  });
  $('#verseList').addEventListener('dragstart', (e) => {
    const el = e.target.closest('.verse');
    if (!el) return;
    if (!st.verseSel.has(+el.dataset.i)) { st.verseSel = new Set([+el.dataset.i]); previewVerses(); }
    dragItem(e, scriptureItem());
  });
  $('#btnBibleAdd').onclick = () => {
    const item = scriptureItem();
    if (item) addToSchedule(item); else toast('Select one or more verses first');
  };
  $('#bibleSelect').onchange = async (e) => {
    st.settings.bible = +e.target.value;
    save('settings');
    await loadBooks();
    if ($('#bibleSearch').value.trim()) runBibleSearch();
  };

  let searchSeq = 0;
  async function runBibleSearch() {
    const q = $('#bibleSearch').value.trim();
    if (!q) return;
    const seq = ++searchSeq;
    const res = await invoke('bible_search', { bible: +st.settings.bible, query: q });
    if (seq !== searchSeq) return;
    if (res.kind === 'reference') {
      const v0 = res.verses[0];
      if (!v0) return;
      if (st.book !== v0.book) {
        st.book = v0.book;
        $$('#bookList button').forEach((x) => x.classList.toggle('sel', +x.dataset.b === v0.book));
        $('#bookList button.sel')?.scrollIntoView({ block: 'nearest' });
        const n = st.books[v0.book]?.chapters || 0;
        $('#chapterList').innerHTML = Array.from({ length: n }, (_, i) => `<button data-c="${i + 1}">${i + 1}</button>`).join('');
      }
      st.chapter = v0.chapter;
      $$('#chapterList button').forEach((x) => x.classList.toggle('sel', +x.dataset.c === v0.chapter));
      $('#chapterList button.sel')?.scrollIntoView({ block: 'nearest' });
      st.verseMode = 'chapter';
      st.verses = res.verses;
      st.verseSel = new Set(res.selected.map((n) => res.verses.findIndex((v) => v.verse === n)).filter((i) => i >= 0));
      st.verseAnchor = [...st.verseSel][0] ?? null;
      $('#versesTitle').textContent = res.title;
      renderVerses();
      if (st.verseSel.size) {
        previewVerses();
        $('#verseList .verse.sel')?.scrollIntoView({ block: 'center' });
      } else $('#verseList').scrollTop = 0;
    } else {
      st.verseMode = 'text';
      st.verses = res.verses;
      st.verseSel = new Set();
      $('#versesTitle').textContent = res.verses.length >= 400 ? '400+ matches' : res.title;
      renderVerses(q.toLowerCase().split(/\s+/));
      $('#verseList').scrollTop = 0;
    }
  }
  $('#bibleSearch').addEventListener('input', debounce(runBibleSearch, 180));
  $('#bibleSearch').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      await runBibleSearch();
      if (!st.verseSel.size && st.verses.length) { st.verseSel = new Set([0]); previewVerses(); }
      goLive(0);
    }
  });

  // ---------- media ----------
  async function addMedia() {
    try {
      const files = await invoke('pick_media');
      const added = [];
      for (const f of files) {
        if (st.media.some((m) => m.path === f.path)) continue;
        const m = { id: uid(), name: f.name, path: f.path, kind: f.kind, loop: true };
        st.media.push(m);
        added.push(m);
        st.missing.delete(f.path);
      }
      if (added.length) {
        save('media');
        renderMedia();
        toast(`Added ${added.length} item${added.length === 1 ? '' : 's'} to media`);
      }
      return added;
    } catch (e) { toast('Could not add media: ' + e, true); return []; }
  }
  $('#btnAddMedia').onclick = addMedia;

  function renderMedia() {
    const q = $('#mediaSearch').value.trim().toLowerCase();
    const list = st.media.filter((m) => (st.mediaKind === 'all' || m.kind === st.mediaKind) && (!q || m.name.toLowerCase().includes(q)));
    const grid = $('#mediaGrid');
    grid.innerHTML = '';
    for (const m of list) {
      const t = document.createElement('div');
      t.className = 'tile' + (st.selMedia === m.id ? ' sel' : '') + (st.missing.has(m.path) ? ' missing' : '');
      t.dataset.id = m.id;
      t.draggable = true;
      const sl = document.createElement('div');
      t.append(sl);
      const tags = [];
      if (st.settings.songBg === m.id) tags.push('<i>Song BG</i>');
      if (st.settings.scriptureBg === m.id) tags.push('<i>Bible BG</i>');
      if (st.settings.standby?.mediaId === m.id) tags.push('<i>Standby</i>');
      if (st.missing.has(m.path)) tags.push('<i style="background:#d0213c">File missing</i>');
      t.insertAdjacentHTML('beforeend', `<span class="tags">${tags.join('')}</span>
        <button class="icon-btn more" title="More">${S.icon('sliders')}</button>
        <span class="tname">${S.icon(m.kind === 'video' ? 'film' : m.kind === 'gif' ? 'gif' : 'image')}<span>${esc(m.name)}</span></span>`);
      S.renderSlide(sl, { kind: 'media', media: { type: m.kind, path: m.path } }, { thumb: true });
      grid.append(t);
    }
    const add = document.createElement('button');
    add.className = 'add-tile';
    add.innerHTML = `${S.icon('plus')}Add images, videos &amp; GIFs`;
    add.onclick = addMedia;
    grid.append(add);
  }
  function selectMedia(id) {
    st.selMedia = id;
    $$('#mediaGrid .tile').forEach((x) => x.classList.toggle('sel', x.dataset.id === id));
    setPreview({ type: 'media', id });
  }
  function mediaMenu(x, y, m) {
    const items = [
      { icon: 'arrow', label: 'Go live', action: () => { selectMedia(m.id); goLive(0); } },
      { icon: 'plus', label: 'Add to service', action: () => addToSchedule({ type: 'media', id: m.id }) },
      '-',
      { icon: 'music', label: st.settings.songBg === m.id ? '✓ Default song background' : 'Use as default song background', action: () => setSetting('songBg', st.settings.songBg === m.id ? null : m.id) },
      { icon: 'book', label: st.settings.scriptureBg === m.id ? '✓ Default scripture background' : 'Use as default scripture background', action: () => setSetting('scriptureBg', st.settings.scriptureBg === m.id ? null : m.id) },
      { icon: 'pause', label: st.settings.standby?.mediaId === m.id ? '✓ Standby screen' : 'Use as standby screen', action: () => setStandbyMedia(st.settings.standby?.mediaId === m.id ? null : m.id) },
    ];
    const ps = st.preview?.item.type === 'song' && songById(st.preview.item.id);
    if (ps) items.push({ icon: 'layers', label: `Background for “${ps.title}”`, action: () => { ps.bg = m.id; save('songs'); refreshItems(); toast('Background set'); } });
    if (m.kind === 'video') items.push({ icon: 'loop', label: m.loop !== false ? 'Loop when live: on' : 'Loop when live: off', action: () => { m.loop = m.loop === false; save('media'); refreshItems(); } });
    items.push('-', { icon: 'trash', label: 'Remove from library', danger: true, action: () => removeMedia(m) });
    showMenu(x, y, items);
  }
  async function removeMedia(m) {
    if (!(await ask(`Remove “${m.name}” from the media library? The file on your computer is not deleted.`, 'Remove'))) return;
    st.media = st.media.filter((x) => x.id !== m.id);
    for (const k of ['songBg', 'scriptureBg']) if (st.settings[k] === m.id) st.settings[k] = null;
    if (st.settings.standby?.mediaId === m.id) st.settings.standby.mediaId = null;
    st.songs.forEach((s) => { if (s.bg === m.id) s.bg = null; });
    st.schedule = st.schedule.filter((i) => !(i.type === 'media' && i.id === m.id));
    save('media'); save('settings'); save('songs'); save('schedule');
    renderMedia(); renderSchedule(); refreshItems();
  }
  function setSetting(k, v) {
    st.settings[k] = v;
    save('settings');
    renderMedia();
    refreshItems();
    renderSettings();
  }
  $('#mediaGrid').addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const m = mediaById(t.dataset.id);
    if (e.target.closest('.more')) { const r = e.target.closest('.more').getBoundingClientRect(); mediaMenu(r.left, r.bottom + 4, m); return; }
    selectMedia(m.id);
  });
  $('#mediaGrid').addEventListener('dblclick', (e) => {
    const t = e.target.closest('.tile');
    if (!t || e.target.closest('.more')) return;
    selectMedia(t.dataset.id);
    goLive(0);
  });
  $('#mediaGrid').addEventListener('contextmenu', (e) => {
    const t = e.target.closest('.tile');
    if (t) mediaMenu(e.clientX, e.clientY, mediaById(t.dataset.id));
  });
  $('#mediaGrid').addEventListener('dragstart', (e) => { const t = e.target.closest('.tile'); if (t) dragItem(e, { type: 'media', id: t.dataset.id }); });
  $('#mediaSearch').addEventListener('input', debounce(renderMedia, 120));
  $('#mediaFilter').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    st.mediaKind = c.dataset.kind;
    $$('#mediaFilter .chip').forEach((x) => x.classList.toggle('active', x === c));
    renderMedia();
  });

  // ---------- settings ----------
  function renderSettings() {
    const s = st.settings.style;
    $('#stFont').value = s.font;
    $('#stWeight').value = String(s.weight);
    $('#stSize').value = s.size;
    $('#stSizeVal').textContent = s.size;
    $('#stColor').value = s.color;
    $('#stPosition').value = s.position;
    $('#stShadow').checked = !!s.shadow;
    $('#stUpper').checked = !!s.uppercase;
    $('#stFade').value = st.settings.fade;
    $('#stFadeVal').textContent = st.settings.fade + 's';
    $('#setVersesPerSlide').value = String(st.settings.versesPerSlide);
    $('#stTransition').value = st.settings.transition;
    const sb = st.settings.standby;
    $('#setStandbyText').value = sb.text || '';
    $('#setStandbyIdle').checked = !!st.settings.standbyIdle;
    const tk = st.settings.ticker;
    $('#tkSpeed').value = String(tk.speed);
    $('#tkPosition').value = tk.position;
    $('#tkBg').value = tk.bg;
    $('#tkColor').value = tk.color;
    renderBgPicker($('#setSongBg'), st.settings.songBg, 'Built-in gradient', (id) => setSetting('songBg', id), 'Default song background');
    renderBgPicker($('#setScriptureBg'), st.settings.scriptureBg, 'Built-in gradient', (id) => setSetting('scriptureBg', id), 'Default scripture background');
    // standby preview shows the actual standby screen
    const host = $('#setStandby');
    renderBgPicker(host, null, sb.slide ? 'A slide you picked' : sb.mediaId ? mediaById(sb.mediaId)?.name || '' : 'Your logo', setStandbyMedia, 'Choose standby picture or video');
    S.renderSlide(host.querySelector('.sl'), standbySlide(), { thumb: true, style: st.settings.style });
    $('#themePicker').innerHTML = THEMES.map((t) => `<button class="theme-sw${st.settings.theme === t.id ? ' sel' : ''}" data-theme-id="${t.id}"><i style="background:linear-gradient(135deg, ${t.a} 50%, ${t.b} 50%)"></i>${t.name}</button>`).join('');
    $('#stylePreview')._key = null;
    renderStage($('#stylePreview'), { kind: 'text', text: 'Amazing grace how sweet the sound\nThat saved a wretch like me', bg: bgFrom(st.settings.songBg) });
  }
  function setStandbyMedia(id) {
    st.settings.standby = { ...st.settings.standby, mediaId: id, slide: null };
    save('settings');
    renderSettings();
    renderMedia();
    pushLive();
  }

  const THEMES = [
    { id: 'sand', name: 'Warm Sand', a: '#f4eee6', b: '#d2601a' },
    { id: 'blue', name: 'Royal Blue', a: '#e9f0fd', b: '#1652f0' },
    { id: 'forest', name: 'Forest', a: '#eef1ea', b: '#2f7d4a' },
    { id: 'plum', name: 'Plum', a: '#f3eef4', b: '#8a3fb0' },
    { id: 'midnight', name: 'Midnight', a: '#1c1b1a', b: '#f0a42a' },
  ];
  function applyTheme() { document.documentElement.dataset.theme = st.settings.theme || 'sand'; }
  $('#themePicker').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-id]');
    if (!b) return;
    st.settings.theme = b.dataset.themeId;
    applyTheme();
    save('settings');
    renderSettings();
  });
  $('#setStandbyText').addEventListener('input', debounce(() => {
    st.settings.standby = { ...st.settings.standby, text: $('#setStandbyText').value.trim() };
    if (st.settings.standby.slide) st.settings.standby.slide = null;
    save('settings'); renderSettings(); pushLive();
  }, 300));
  $('#setStandbyIdle').addEventListener('change', (e) => { st.settings.standbyIdle = e.target.checked; save('settings'); pushLive(); });
  ['#tkSpeed', '#tkPosition', '#tkBg', '#tkColor'].forEach((sel) => $(sel).addEventListener('input', () => {
    Object.assign(st.settings.ticker, { speed: +$('#tkSpeed').value, position: $('#tkPosition').value, bg: $('#tkBg').value, color: $('#tkColor').value });
    save('settings'); pushLive();
  }));
  $('#stTransition').addEventListener('input', (e) => { st.settings.transition = e.target.value; save('settings'); pushLive(); });
  $('#liveTransition').addEventListener('input', (e) => { st.settings.transition = e.target.value; save('settings'); pushLive(); });
  const onStyle = () => {
    const s = st.settings.style;
    s.font = $('#stFont').value;
    s.weight = +$('#stWeight').value;
    s.size = +$('#stSize').value;
    s.color = $('#stColor').value;
    s.position = $('#stPosition').value;
    s.shadow = $('#stShadow').checked;
    s.uppercase = $('#stUpper').checked;
    st.settings.fade = +$('#stFade').value;
    st.settings.versesPerSlide = +$('#setVersesPerSlide').value;
    save('settings');
    renderSettings();
    refreshItems();
  };
  ['#stFont', '#stWeight', '#stSize', '#stColor', '#stPosition', '#stShadow', '#stUpper', '#stFade', '#setVersesPerSlide'].forEach((sel) => $(sel).addEventListener('input', onStyle));
  $('#btnSettings').onclick = async () => {
    renderSettings();
    $('#settingsDialog').showModal();
    const info = await invoke('library_info');
    $('#libPath').textContent = info.dir;
    $('#btnChangeLib').disabled = info.portable;
    $('#libNote').textContent = info.portable
      ? 'Portable mode: everything is kept in the SlidesForeverData folder next to the app.'
      : 'Copy this folder to back up your songs, or point another computer at a shared copy of it.';
  };
  $('#btnOpenLib').onclick = () => invoke('open_folder', { path: $('#libPath').textContent });
  $('#btnChangeLib').onclick = () => { $('#settingsDialog').close(); openLibraryDialog(false); };
  $('#btnImportBible').onclick = async () => {
    try {
      const name = await invoke('import_bible');
      if (name) { await loadBibles(); toast(`Imported Bible “${name}”`); }
    } catch (e) { toast('Bible import failed: ' + e, true); }
  };
  $$('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));

  // ---------- top bar & live tools ----------
  $('#btnDisplays').onclick = openDisplays;
  $('#btnIdentify').onclick = () => invoke('identify_displays').catch((e) => toast(String(e), true));
  $('#btnRefreshDisplays').onclick = async () => { await refreshDisplays(); renderDisplayMap(); };
  $('#btnUseDisplay').onclick = useDisplay;
  $('#btnOutputOff').onclick = () => { invoke('close_output'); $('#displayDialog').close(); };
  $('#btnOutput').onclick = () => (st.outputOn ? invoke('close_output') : ensureOutput(true));
  $('#btnGoLive').onclick = () => goLive();
  $('#btnBlack').onclick = () => toggleMode('black');
  $('#btnClearText').onclick = () => toggleMode('clear');
  $('#btnStandby').onclick = () => toggleMode('standby');
  $('#btnTicker').onclick = () => toggleTicker();
  $('#tickerText').addEventListener('keydown', (e) => { if (e.key === 'Enter') toggleTicker(true); });
  $('#tickerText').addEventListener('input', debounce(() => {
    if (st.settings.ticker.on) { st.settings.ticker.text = $('#tickerText').value.trim(); save('settings'); pushLive(); }
  }, 600));
  $('#btnAutoPlay').onclick = () => (st.auto.on ? (stopAuto(), renderLive()) : startAuto());
  $('#autoInterval').addEventListener('input', (e) => {
    const g = st.live && groupById(st.live.item.id);
    if (!g) return;
    g.interval = +e.target.value;
    save('groups');
    if (st.auto.on) startAuto();
  });
  $('#autoLoop').addEventListener('change', (e) => {
    const g = st.live && groupById(st.live.item.id);
    if (g) { g.loop = e.target.checked; save('groups'); }
  });
  function slideMenu(e, p) {
    const t = e.target.closest('.thumb');
    if (!t || !p) return;
    const slide = p.slides[+t.dataset.i];
    showMenu(e.clientX, e.clientY, [
      { icon: 'pause', label: 'Use this slide as the standby screen', action: () => setStandbySlide(slide) },
    ]);
  }
  $('#previewSlides').addEventListener('contextmenu', (e) => slideMenu(e, st.preview));
  $('#liveSlides').addEventListener('contextmenu', (e) => slideMenu(e, st.live));
  $('#previewSlides').addEventListener('click', (e) => {
    const t = e.target.closest('.thumb');
    if (t && st.preview) { st.preview.index = +t.dataset.i; renderPreview(); }
  });
  $('#previewSlides').addEventListener('dblclick', (e) => { const t = e.target.closest('.thumb'); if (t) goLive(+t.dataset.i); });
  $('#liveSlides').addEventListener('click', (e) => { const t = e.target.closest('.thumb'); if (t) setLiveIndex(+t.dataset.i); });
  $('#previewStage').addEventListener('dblclick', () => goLive());

  // video controls
  let vidPaused = false;
  $('#btnVidPlay').onclick = () => invoke('live_control', { command: { action: 'toggle' } });
  $('#btnVidRestart').onclick = () => invoke('live_control', { command: { action: 'seek', t: 0 } });
  $('#vidSeek').addEventListener('input', (e) => invoke('live_control', { command: { action: 'seekFrac', f: +e.target.value / 1000 } }));
  listen('media-status', ({ payload }) => {
    if (payload.paused !== vidPaused) { vidPaused = payload.paused; setIcon($('#btnVidPlay span'), vidPaused ? 'play' : 'pause'); }
    if (document.activeElement !== $('#vidSeek')) $('#vidSeek').value = payload.duration ? Math.round((payload.time / payload.duration) * 1000) : 0;
    $('#vidTime').textContent = `${fmtTime(payload.time)} / ${fmtTime(payload.duration)}`;
  });
  listen('output-closed', () => { st.outputOn = false; updateOutputUi(); });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (e.target.closest?.('input, textarea, select')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const k = e.key;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(k)) step(1);
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) step(-1);
    else if (k === 'Enter') goLive();
    else if (k === 'b' || k === 'B' || k === '.') toggleMode('black');
    else if (k === 'c' || k === 'C') toggleMode('clear');
    else if (k === 's' || k === 'S') toggleMode('standby');
    else if (k === 't' || k === 'T') toggleTicker();
    else if (k === 'Escape') clearAll();
    else if (k === 'Home') st.live && setLiveIndex(0);
    else if (k === 'End') st.live && setLiveIndex(st.live.slides.length - 1);
    else if (/^[1-9]$/.test(k) && st.live) setLiveIndex(+k - 1);
    else if (e.ctrlKey && (k === 'f' || k === 'F')) { const id = $('.lib-tab.active').dataset.tab; showTab(id); }
    else if (e.ctrlKey && (k === 'n' || k === 'N')) openSongEditor(null);
    else return;
    e.preventDefault();
  });

  // ---------- busy overlay ----------
  async function busy(text, fn) {
    $('#busyText').textContent = text;
    $('#busy').hidden = false;
    try { return await fn(); } finally { $('#busy').hidden = true; }
  }

  // ---------- slide groups ----------
  const stemOf = (p) => p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  async function createGroup(paths, name) {
    if (!paths.length) return null;
    const id = uid().replace(/[^a-z0-9]/gi, '');
    const isPpt = paths.some((p) => /\.(pptx?|ppsx?|pptm|odp)$/i.test(p));
    const label = isPpt ? 'Converting PowerPoint slides… (PowerPoint may open briefly)' : paths.some((p) => /\.pdf$/i.test(p)) ? 'Turning PDF pages into slides…' : 'Building slide group…';
    try {
      const pages = await busy(label, () => invoke('make_slide_group', { id, paths }));
      const g = { id, name: name || stemOf(paths[0]), pages, interval: 0, loop: true, created: Date.now() };
      await invoke('register_media', { paths: pages });
      st.groups.push(g);
      save('groups');
      renderGroups();
      showTab('slides');
      selectGroup(g.id);
      toast(`Made “${g.name}” with ${pages.length} slide${pages.length === 1 ? '' : 's'}`);
      return g;
    } catch (e) {
      toast(String(e), true);
      return null;
    }
  }
  $('#btnNewGroup').onclick = async () => {
    const paths = await invoke('pick_slide_files');
    if (paths.length) createGroup(paths, paths.length > 1 && !paths.some((p) => /\.(pdf|pptx?|ppsx?|odp)$/i.test(p)) ? 'Picture slides' : undefined);
  };

  function renderGroups() {
    const q = $('#groupSearch').value.trim().toLowerCase();
    const grid = $('#groupGrid');
    grid.innerHTML = '';
    for (const g of st.groups.filter((g) => !q || g.name.toLowerCase().includes(q))) {
      const t = document.createElement('div');
      t.className = 'tile' + (st.selGroup === g.id ? ' sel' : '');
      t.dataset.id = g.id;
      t.draggable = true;
      const sl = document.createElement('div');
      t.append(sl);
      t.insertAdjacentHTML('beforeend', `<span class="tags"><i>${g.pages.length} slides</i>${g.interval ? `<i>Auto ${g.interval}s</i>` : ''}</span>
        <button class="icon-btn more" title="More">${S.icon('sliders')}</button>
        <span class="tname">${S.icon('slides')}<span>${esc(g.name)}</span></span>`);
      S.renderSlide(sl, { kind: 'media', media: { type: 'image', path: g.pages[0] } }, { thumb: true });
      grid.append(t);
    }
    const add = document.createElement('button');
    add.className = 'add-tile';
    add.innerHTML = `${S.icon('plus')}New slide group<small>PDF, PowerPoint or pictures</small>`;
    add.onclick = () => $('#btnNewGroup').click();
    grid.append(add);
  }
  function selectGroup(id) {
    st.selGroup = id;
    $$('#groupGrid .tile').forEach((x) => x.classList.toggle('sel', x.dataset.id === id));
    setPreview({ type: 'group', id });
  }
  function groupMenu(x, y, g) {
    const iv = (s) => ({ icon: 'play', label: (g.interval === s ? '✓ ' : '') + (s ? `Auto-play every ${s} seconds` : 'No auto-play (advance by hand)'), action: () => { g.interval = s; save('groups'); renderGroups(); refreshItems(); } });
    showMenu(x, y, [
      { icon: 'arrow', label: 'Go live', action: () => { selectGroup(g.id); goLive(0); } },
      { icon: 'plus', label: 'Add to service', action: () => addToSchedule({ type: 'group', id: g.id }) },
      { icon: 'edit', label: 'Rename…', action: () => renameGroup(g) },
      '-', iv(0), iv(5), iv(8), iv(15),
      { icon: 'loop', label: g.loop !== false ? '✓ Loop back to the start' : 'Loop back to the start', action: () => { g.loop = g.loop === false; save('groups'); } },
      '-',
      { icon: 'trash', label: 'Delete slide group', danger: true, action: () => deleteGroup(g) },
    ]);
  }
  function renameGroup(g) {
    const t = $(`#groupGrid .tile[data-id="${g.id}"] .tname span`);
    if (!t) return;
    t.contentEditable = 'true';
    t.style.userSelect = 'text';
    t.focus();
    document.getSelection().selectAllChildren(t);
    const done = () => {
      t.contentEditable = 'false';
      const v = t.textContent.trim();
      if (v && v !== g.name) { g.name = v; save('groups'); renderSchedule(); renderPreview(); }
      renderGroups();
    };
    t.addEventListener('blur', done, { once: true });
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } e.stopPropagation(); });
  }
  async function deleteGroup(g) {
    if (!(await ask(`Delete the slide group “${g.name}”? Its slide pictures are removed from your library folder (your original PDF / PowerPoint is not touched).`))) return;
    st.groups = st.groups.filter((x) => x.id !== g.id);
    st.schedule = st.schedule.filter((i) => !(i.type === 'group' && i.id === g.id));
    invoke('delete_slide_group', { id: g.id });
    save('groups'); save('schedule');
    if (st.preview?.item.id === g.id) st.preview = null;
    renderGroups(); renderSchedule(); refreshItems();
  }
  $('#groupGrid').addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const g = groupById(t.dataset.id);
    if (e.target.closest('.more')) { const r = e.target.closest('.more').getBoundingClientRect(); groupMenu(r.left, r.bottom + 4, g); return; }
    if (e.target.isContentEditable) return;
    selectGroup(g.id);
  });
  $('#groupGrid').addEventListener('dblclick', (e) => { const t = e.target.closest('.tile'); if (t && !e.target.closest('.more') && !e.target.isContentEditable) { selectGroup(t.dataset.id); goLive(0); } });
  $('#groupGrid').addEventListener('contextmenu', (e) => { const t = e.target.closest('.tile'); if (t) groupMenu(e.clientX, e.clientY, groupById(t.dataset.id)); });
  $('#groupGrid').addEventListener('dragstart', (e) => { const t = e.target.closest('.tile'); if (t) dragItem(e, { type: 'group', id: t.dataset.id }); });
  $('#groupSearch').addEventListener('input', debounce(renderGroups, 120));

  // ---------- drag files in from Explorer ----------
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#dropOverlay').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropOverlay').hidden = true;
    const files = [...e.dataTransfer.files];
    if (files.length) await handleDroppedFiles(files);
  });

  async function saveDropped(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return invoke('save_dropped', bytes, { headers: { 'x-name': encodeURIComponent(file.name) } });
  }

  async function handleDroppedFiles(files) {
    const ext = (f) => (f.name.split('.').pop() || '').toLowerCase();
    const txt = files.filter((f) => ext(f) === 'txt');
    const docs = files.filter((f) => ['pdf', 'ppt', 'pptx', 'pps', 'ppsx', 'pptm', 'odp'].includes(ext(f)));
    const pics = files.filter((f) => ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'avif'].includes(ext(f)));
    const movs = files.filter((f) => ['mp4', 'm4v', 'webm', 'mov', 'ogv', 'gif'].includes(ext(f)));
    const skipped = files.length - txt.length - docs.length - pics.length - movs.length;
    try {
      if (txt.length) {
        let n = 0;
        for (const f of txt) {
          const s = await invoke('parse_song', { name: f.name.replace(/\.txt$/i, ''), text: await f.text() });
          if (s.lyrics) { mergeSongs([s], false); n++; }
        }
        toast(`Imported ${n} song${n === 1 ? '' : 's'}`);
      }
      for (const f of docs) {
        const path = await busy(`Copying ${f.name}…`, () => saveDropped(f));
        await createGroup([path], f.name.replace(/\.[^.]+$/, ''));
      }
      if (pics.length === 1 && !docs.length) {
        const path = await saveDropped(pics[0]);
        addMediaPaths([{ path, name: stemOf(path), kind: 'image' }]);
      } else if (pics.length) {
        const paths = await busy('Copying pictures…', () => Promise.all(pics.map(saveDropped)));
        await createGroup(paths, pics.length === 1 ? stemOf(paths[0]) : 'Picture slides');
      }
      if (movs.length) {
        const saved = await busy(`Copying ${movs.length} file${movs.length === 1 ? '' : 's'}…`, () => Promise.all(movs.map(saveDropped)));
        addMediaPaths(saved.map((p) => ({ path: p, name: stemOf(p), kind: /\.gif$/i.test(p) ? 'gif' : 'video' })));
      }
      if (skipped) toast(`${skipped} file${skipped === 1 ? ' was' : 's were'} skipped (unsupported type)`, true);
    } catch (err) {
      toast(String(err), true);
    }
  }

  function addMediaPaths(items) {
    let n = 0;
    for (const f of items) {
      if (st.media.some((m) => m.path === f.path)) continue;
      st.media.push({ id: uid(), name: f.name, path: f.path, kind: f.kind, loop: true });
      n++;
    }
    if (n) { save('media'); renderMedia(); showTab('media'); toast(`Added ${n} item${n === 1 ? '' : 's'} to media`); }
  }

  // ---------- song merge (txt + EasyWorship) ----------
  function mergeSongs(list, replace) {
    let added = 0, updated = 0, skipped = 0;
    for (const s of list) {
      const existing = st.songs.find((x) => x.title.toLowerCase() === s.title.toLowerCase());
      if (existing) {
        if (replace) { Object.assign(existing, { lyrics: s.lyrics, author: s.author || existing.author, copyright: s.copyright || existing.copyright }); updated++; }
        else skipped++;
      } else {
        st.songs.push({ id: uid(), title: s.title, author: s.author || '', copyright: s.copyright || '', lyrics: s.lyrics || '', bg: null });
        added++;
      }
    }
    save('songs');
    renderSongs();
    refreshItems();
    return { added, updated, skipped };
  }

  // ---------- EasyWorship import ----------
  $('#btnImportEW').onclick = async () => {
    const host = $('#ewFound');
    host.innerHTML = '<div class="muted">Looking for EasyWorship on this computer…</div>';
    $('#ewDialog').showModal();
    const libs = await invoke('ew_find').catch(() => []);
    host.innerHTML = libs.length
      ? libs.map((l, i) => `<div class="ew-row"><span class="badge">${S.icon('music')}</span><span class="txt"><b>${l.songs} song${l.songs === 1 ? '' : 's'} found on this PC</b><code>${esc(l.path)}</code></span>
          <button class="btn primary" data-ew="${i}" ${l.songs ? '' : 'disabled'}>${S.icon('download')}Import</button></div>`).join('')
      : `<div class="help"><b>EasyWorship isn’t on this computer</b> (or has no songs yet). Use <b>Browse for Songs.db</b> below.</div>`;
    host.querySelectorAll('[data-ew]').forEach((b) => (b.onclick = () => runEwImport(libs[+b.dataset.ew].path)));
  };
  $('#ewBrowse').onclick = () => runEwImport(null);
  async function runEwImport(path) {
    try {
      const songs = await busy('Reading EasyWorship songs…', () => invoke('ew_import', { path }));
      if (!songs.length) return;
      const r = mergeSongs(songs, $('#ewReplace').checked);
      $('#ewDialog').close();
      showTab('songs');
      toast(`EasyWorship: ${r.added} added${r.updated ? `, ${r.updated} updated` : ''}${r.skipped ? `, ${r.skipped} already here` : ''}`);
    } catch (e) { toast(String(e), true); }
  }

  // ---------- library folder ----------
  async function openLibraryDialog(firstRun) {
    const info = await invoke('library_info');
    $('#libDlgTitle').textContent = firstRun ? 'Welcome! Where should we keep your songs?' : 'Move or switch your library folder';
    $('#libDefaultPath').textContent = info.defaultDir;
    $('#libraryDialog').showModal();
  }
  const ALL_DOCS = ['songs', 'media', 'groups', 'settings', 'schedule'];
  async function useLibrary(dir) {
    const wasUnconfigured = st.unconfigured;
    // flush pending saves to the current folder first
    if (!wasUnconfigured) await Promise.all(ALL_DOCS.map((name) => invoke('save_doc', { name, value: st[name] })));
    try {
      const r = await invoke('set_library', { dir });
      // first run into an empty folder: write the starter library there
      if (wasUnconfigured && !r.existing) await Promise.all(ALL_DOCS.map((name) => invoke('save_doc', { name, value: st[name] })));
      st.unconfigured = false;
      $('#libraryDialog').close();
      toast(r.existing ? 'Opened the library in that folder' : 'Your library is now saved in that folder');
      setTimeout(() => location.reload(), 600);
    } catch (e) { toast(String(e), true); }
  }
  $('#libUseDefault').onclick = async () => useLibrary((await invoke('library_info')).defaultDir);
  $('#libChoose').onclick = async () => {
    const dir = await invoke('pick_folder', { title: 'Choose a folder for your Slides Forever library' });
    if (dir) useLibrary(dir);
  };
  $('#libraryDialog').addEventListener('cancel', (e) => e.preventDefault());

  function renderGreeting() {
    const h = new Date().getHours();
    $('#greeting').textContent = h < 12 ? 'Good morning 👋' : h < 18 ? 'Good afternoon 👋' : 'Good evening 👋';
    $('#greetingSub').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + ' · Click to preview, double-click to go live';
  }

  // ---------- first run ----------
  const SAMPLE_SONGS = [
    {
      title: 'Amazing Grace', author: 'John Newton', copyright: 'Public domain',
      lyrics: 'Verse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me\nI once was lost but now am found\nWas blind but now I see\n\nVerse 2\n’Twas grace that taught my heart to fear\nAnd grace my fears relieved\nHow precious did that grace appear\nThe hour I first believed\n\nVerse 3\nThrough many dangers toils and snares\nI have already come\n’Tis grace hath brought me safe thus far\nAnd grace will lead me home\n\nVerse 4\nWhen we’ve been there ten thousand years\nBright shining as the sun\nWe’ve no less days to sing God’s praise\nThan when we’d first begun',
    },
    {
      title: 'Holy, Holy, Holy', author: 'Reginald Heber', copyright: 'Public domain',
      lyrics: 'Verse 1\nHoly, holy, holy! Lord God Almighty!\nEarly in the morning our song shall rise to Thee\nHoly, holy, holy! Merciful and mighty!\nGod in three Persons, blessed Trinity!\n\nVerse 2\nHoly, holy, holy! All the saints adore Thee\nCasting down their golden crowns around the glassy sea\nCherubim and seraphim falling down before Thee\nWhich wert and art and evermore shalt be\n\nVerse 3\nHoly, holy, holy! Lord God Almighty!\nAll Thy works shall praise Thy name in earth and sky and sea\nHoly, holy, holy! Merciful and mighty!\nGod in three Persons, blessed Trinity!',
    },
    {
      title: 'Come Thou Fount', author: 'Robert Robinson', copyright: 'Public domain',
      lyrics: 'Verse 1\nCome Thou fount of every blessing\nTune my heart to sing Thy grace\nStreams of mercy never ceasing\nCall for songs of loudest praise\n\nVerse 2\nHere I raise my Ebenezer\nHither by Thy help I’m come\nAnd I hope by Thy good pleasure\nSafely to arrive at home\n\nVerse 3\nO to grace how great a debtor\nDaily I’m constrained to be\nLet Thy goodness like a fetter\nBind my wandering heart to Thee',
    },
  ];

  // ---------- init ----------
  async function init() {
    paintIcons();
    renderGreeting();
    const info = await invoke('library_info');
    st.unconfigured = !info.configured;
    const [songs, media, groups, settings, schedule] = await Promise.all(
      ['songs', 'media', 'groups', 'settings', 'schedule'].map((name) => invoke('load_doc', { name }).catch(() => null)),
    );
    st.songs = Array.isArray(songs) ? songs : [];
    st.media = Array.isArray(media) ? media : [];
    st.groups = Array.isArray(groups) ? groups : [];
    st.schedule = Array.isArray(schedule) ? schedule : [];
    if (settings && typeof settings === 'object') {
      const d = structuredClone(DEFAULT_SETTINGS);
      st.settings = {
        ...d, ...settings,
        style: { ...S.DEFAULT_STYLE, ...(settings.style || {}) },
        standby: { ...d.standby, ...(settings.standby || {}) },
        ticker: { ...d.ticker, ...(settings.ticker || {}) },
      };
    }
    applyTheme();
    $('#tickerText').value = st.settings.ticker.text || '';
    if (st.unconfigured) openLibraryDialog(true);
    const groupPages = st.groups.flatMap((g) => g.pages);
    if (groupPages.length) invoke('register_media', { paths: groupPages });
    if (!st.settings.seeded) {
      if (!st.songs.length) st.songs = SAMPLE_SONGS.map((s) => ({ id: uid(), bg: null, ...s }));
      st.settings.seeded = true;
      save('songs'); save('settings');
    }
    if (st.media.length) {
      const missing = await invoke('register_media', { paths: st.media.map((m) => m.path) });
      st.missing = new Set(missing);
    }
    renderSongs();
    renderMedia();
    renderGroups();
    renderSchedule();
    renderPreview();
    renderLive();
    st.outputOn = await invoke('output_open');
    updateOutputUi();
    refreshDisplays();
    loadBibles().then(() => { if (st.book == null) selectBook(42, 3); });
    $('#songSearch').focus();
  }
  init().catch((e) => toast('Startup error: ' + e, true));
})();
