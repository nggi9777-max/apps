/* ============================================================================
   TChart — лёгкий движок инженерных графиков на Canvas.
   Временные ряды больших объёмов (min/max-децимация), зум колесом, панорама,
   синхронизация группы графиков, перекрестие с подсказкой, полосы режимов,
   маркеры событий, горизонтальные уровни, экспорт PNG, рендер для отчётов.
   ========================================================================== */
const TChart = (function () {
  'use strict';
  const groups = {};
  const THEMES = {
    dark: { bg: 'transparent', grid: 'rgba(160,190,220,0.08)', axis: 'rgba(170,195,220,0.55)', text: '#9FB2C6', tipBg: 'rgba(16,26,37,0.96)', tipBorder: 'rgba(120,160,200,0.35)', tipText: '#E3ECF5', cross: 'rgba(200,220,240,0.35)', font: '11px Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif' },
    light: { bg: '#FFFFFF', grid: 'rgba(30,50,70,0.10)', axis: 'rgba(30,50,70,0.6)', text: '#33465A', tipBg: '#fff', tipBorder: '#999', tipText: '#111', cross: 'rgba(0,0,0,0.3)', font: '13px Calibri, Arial, sans-serif' }
  };
  const pad2 = (x) => String(x).padStart(2, '0');
  function niceStep(range, n) { const raw = range / Math.max(1, n); const p = Math.pow(10, Math.floor(Math.log10(raw))); const f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }
  const TIME_STEPS = [60e3, 300e3, 900e3, 1800e3, 3600e3, 7200e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 2 * 86400e3, 7 * 86400e3, 30 * 86400e3];
  function fmtTime(ms, step) { const d = new Date(ms); if (step >= 86400e3) return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1); if (d.getHours() === 0 && d.getMinutes() === 0) return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function fmtFull(ms) { const d = new Date(ms); return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function fmtNum(v, d) { if (!Number.isFinite(v)) return '—'; if (Math.abs(v) < 1e-9) v = 0; const a = Math.abs(v); if (d == null) d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 1 : 2; return v.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }); }

  function TChart(el, opt) {
    this.el = el; this.o = Object.assign({ xType: 'time', height: 220, theme: 'dark', pad: { l: 52, r: 16, t: 14, b: 26 }, legend: true, animate: true, tooltip: true }, opt);
    this.series = opt.series || []; this.bands = opt.bands || []; this.markers = opt.markers || []; this.hlines = opt.hlines || []; this.vlines = opt.vlines || [];
    this.hidden = {};
    if (el) this._mount();
    this._computeExtent(); this.view = this.o.view ? this.o.view.slice() : this.full.slice();
    if (this.o.group && el) { (groups[this.o.group] = groups[this.o.group] || []).push(this); const g = groups[this.o.group]; if (g.length > 1 && g[0] !== this && g[0].view) this.view = g[0].view.slice(); }
    if (el) { this._resize(); this._intro(); }
  }
  TChart.prototype._mount = function () {
    const el = this.el; el.classList.add('tc');
    el.innerHTML = '';
    if (this.o.legend) { this.leg = document.createElement('div'); this.leg.className = 'tc-leg'; el.appendChild(this.leg); this._legend(); }
    this.wrap = document.createElement('div'); this.wrap.className = 'tc-wrap'; this.wrap.style.height = this.o.height + 'px'; el.appendChild(this.wrap);
    this.cv = document.createElement('canvas'); this.wrap.appendChild(this.cv);
    this.tip = document.createElement('div'); this.tip.className = 'tc-tip'; this.wrap.appendChild(this.tip);
    const tb = document.createElement('div'); tb.className = 'tc-tools';
    tb.innerHTML = '<button title="Сбросить масштаб (двойной щелчок)" data-a="reset">⤢</button><button title="Сохранить PNG" data-a="png">⇩</button>';
    tb.addEventListener('click', (e) => { const a = e.target.closest('button'); if (!a) return; if (a.dataset.a === 'reset') this.reset(); else this.download(); });
    this.wrap.appendChild(tb);
    this.ctx = this.cv.getContext('2d');
    this.ro = new ResizeObserver(() => this._resize()); this.ro.observe(this.wrap);
    this._bind();
  };
  TChart.prototype._legend = function () {
    if (!this.leg) return;
    this.leg.innerHTML = '';
    this.series.forEach((s, i) => {
      if (s.legend === false) return;
      const b = document.createElement('button'); b.className = 'tc-li' + (this.hidden[i] ? ' off' : '');
      b.innerHTML = '<i style="background:' + s.color + (s.dash ? ';background:repeating-linear-gradient(90deg,' + s.color + ' 0 4px,transparent 4px 7px)' : '') + '"></i>' + s.name;
      b.onclick = () => { this.hidden[i] = !this.hidden[i]; b.classList.toggle('off'); this._computeExtent(true); this.draw(); };
      this.leg.appendChild(b);
    });
    this.bands.filter(b => b.legend).reduce((acc, b) => { if (!acc.includes(b.legend)) { acc.push(b.legend); const s = document.createElement('span'); s.className = 'tc-li band'; s.innerHTML = '<i style="background:' + b.color + '"></i>' + b.legend; this.leg.appendChild(s); } return acc; }, []);
  };
  TChart.prototype._computeExtent = function (keepX) {
    let x0 = Infinity, x1 = -Infinity;
    this.series.forEach((s) => { const x = s.x; if (!x || !x.length) return; x0 = Math.min(x0, x[0]); x1 = Math.max(x1, x[x.length - 1]); });
    this.bands.forEach(b => { x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1); });
    if (!isFinite(x0)) { x0 = 0; x1 = 1; } if (x1 === x0) x1 = x0 + 1;
    if (this.o.xMin != null) x0 = this.o.xMin; if (this.o.xMax != null) x1 = this.o.xMax;
    this.full = [x0, x1]; if (!keepX) this.view = [x0, x1];
  };
  TChart.prototype._yRange = function (axis) {
    let y0 = Infinity, y1 = -Infinity; const [vx0, vx1] = this.view;
    this.series.forEach((s, i) => {
      if (this.hidden[i] || (s.axis || 'y') !== axis) return;
      const x = s.x, y = s.y; for (let k = 0; k < x.length; k++) { if (x[k] < vx0 || x[k] > vx1) continue; const v = y[k]; if (Number.isFinite(v)) { if (v < y0) y0 = v; if (v > y1) y1 = v; } if (s.yLo) { const a = s.yLo[k], b = s.yHi[k]; if (Number.isFinite(a)) y0 = Math.min(y0, a); if (Number.isFinite(b)) y1 = Math.max(y1, b); } }
    });
    if (axis === 'y') this.hlines.forEach(h => { if (h.fit !== false) { y0 = Math.min(y0, h.y); y1 = Math.max(y1, h.y); } });
    const fix = axis === 'y' ? this.o.y : this.o.y2;
    if (!isFinite(y0)) { y0 = 0; y1 = 1; }
    if (fix && fix.min != null) y0 = fix.min; if (fix && fix.max != null) y1 = fix.max;
    if (fix && fix.zero) y0 = Math.min(0, y0);
    if (y1 === y0) { y1 += 1; y0 -= 1; }
    const pad = (y1 - y0) * 0.06; if (!(fix && fix.min != null)) y0 -= (fix && fix.zero && y0 === 0) ? 0 : pad; if (!(fix && fix.max != null)) y1 += pad;
    return [y0, y1];
  };
  TChart.prototype._resize = function () {
    if (!this.wrap) return; const r = this.wrap.getBoundingClientRect(); if (r.width < 10) return;
    const dpr = window.devicePixelRatio || 1; this.W = r.width; this.Hh = r.height;
    this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr); this.cv.style.width = r.width + 'px'; this.cv.style.height = r.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.draw();
  };
  TChart.prototype._intro = function () {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!this.o.animate || reduce) { this.reveal = 1; return; }
    this.reveal = 0; const t0 = performance.now(); const dur = 700;
    const step = (t) => { this.reveal = Math.min(1, (t - t0) / dur); this.reveal = 1 - Math.pow(1 - this.reveal, 3); this.draw(); if (this.reveal < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  TChart.prototype.setData = function (o) { Object.assign(this, { series: o.series || this.series, bands: o.bands || this.bands, markers: o.markers || this.markers, hlines: o.hlines || this.hlines }); this._computeExtent(); this._legend(); this.draw(); };
  TChart.prototype.reset = function () { this._setView(this.full.slice()); };
  TChart.prototype._setView = function (v, fromGroup) {
    this.view = v; this.draw();
    if (this.o.group && !fromGroup) (groups[this.o.group] || []).forEach(c => { if (c !== this && c.el && document.body.contains(c.el)) c._setView(v.slice(), true); });
  };
  TChart.prototype._bind = function () {
    const cv = this.cv; let drag = null;
    cv.addEventListener('wheel', (e) => {
      e.preventDefault(); const p = this._plot(); const fx = Math.max(0, Math.min(1, (e.offsetX - p.x) / p.w));
      const [a, b] = this.view; const span = b - a; const k = e.deltaY > 0 ? 1.18 : 1 / 1.18; let ns = span * k;
      const minSpan = this.o.xType === 'time' ? 1800e3 : (this.full[1] - this.full[0]) / 500; ns = Math.max(minSpan, Math.min(ns, (this.full[1] - this.full[0]) * 1.02));
      const c = a + fx * span; let na = c - fx * ns, nb = na + ns; if (na < this.full[0]) { na = this.full[0]; nb = na + ns; } if (nb > this.full[1]) { nb = this.full[1]; na = nb - ns; }
      this._setView([na, nb]);
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, v: this.view.slice() }; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; });
    cv.addEventListener('pointermove', (e) => {
      if (drag) { const p = this._plot(); const dx = (e.clientX - drag.x) / p.w * (drag.v[1] - drag.v[0]); let na = drag.v[0] - dx, nb = drag.v[1] - dx; const sp = nb - na; if (na < this.full[0]) { na = this.full[0]; nb = na + sp; } if (nb > this.full[1]) { nb = this.full[1]; na = nb - sp; } this._setView([na, nb]); }
      this._hover(e.offsetX, e.offsetY, true);
    });
    const end = (e) => { drag = null; cv.style.cursor = ''; try { cv.releasePointerCapture(e.pointerId); } catch (x) { void x; } };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => this._hover(null, null, true));
    cv.addEventListener('dblclick', () => this.reset());
    cv.addEventListener('click', (e) => { if (this.o.onClick) { const p = this._plot(); const x = this.view[0] + (e.offsetX - p.x) / p.w * (this.view[1] - this.view[0]); this.o.onClick(x); } });
  };
  TChart.prototype._plot = function () { const pd = this.o.pad; const hasY2 = this.series.some(s => s.axis === 'y2'); return { x: pd.l, y: pd.t, w: this.W - pd.l - (hasY2 ? 52 : pd.r), h: this.Hh - pd.t - pd.b, hasY2 }; };
  TChart.prototype._hover = function (mx, my, propagate) {
    this.hx = mx == null ? null : this.view[0] + (mx - this._plot().x) / this._plot().w * (this.view[1] - this.view[0]);
    this.draw();
    if (propagate && this.o.group) (groups[this.o.group] || []).forEach(c => { if (c !== this && c.el && document.body.contains(c.el)) { c.hx = this.hx; c.draw(); } });
  };
  TChart.prototype.download = function () { const name = (this.o.title || 'график') + '.png', url = this.toImage(1600, Math.round(1600 * this.Hh / this.W), 'light'); if (typeof GSRC !== 'undefined' && GSRC.native()) { fetch(url).then(r => r.blob()).then(b => App.ctx().download(name, b)); return; } const a = document.createElement('a'); a.download = name; a.href = url; a.click(); };
  TChart.prototype.toImage = function (w, h, theme) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d');
    const clone = Object.create(TChart.prototype); Object.assign(clone, this, { ctx, W: w, Hh: h, hx: null, reveal: 1, o: Object.assign({}, this.o, { theme: theme || 'light', pad: { l: 64, r: 22, t: 18, b: 34 } }) });
    clone.draw(true); return c.toDataURL('image/png');
  };
  TChart.static = function (opt, w, h) { const c = new TChart(null, Object.assign({ animate: false }, opt)); c.W = w; c.Hh = h; const cv = document.createElement('canvas'); cv.width = w; cv.height = h; c.ctx = cv.getContext('2d'); c.reveal = 1; c.o.theme = opt.theme || 'light'; c.o.pad = opt.pad || { l: 64, r: 22, t: 18, b: 34 }; c.draw(true); return cv.toDataURL('image/png'); };

  TChart.prototype.draw = function (printMode) {
    const ctx = this.ctx; if (!ctx || !this.W) return;
    const T = THEMES[this.o.theme] || THEMES.dark; const p = this._plot(); const [vx0, vx1] = this.view;
    const scale = printMode ? Math.max(1, this.W / 900) : 1;
    ctx.save(); ctx.clearRect(0, 0, this.W, this.Hh);
    if (T.bg !== 'transparent') { ctx.fillStyle = T.bg; ctx.fillRect(0, 0, this.W, this.Hh); }
    ctx.font = printMode ? (Math.round(13 * scale) + 'px Calibri, Arial, sans-serif') : T.font;
    const X = (x) => p.x + (x - vx0) / (vx1 - vx0) * p.w;
    const yr = this._yRange('y'); const Y = (y) => p.y + p.h - (y - yr[0]) / (yr[1] - yr[0]) * p.h;
    const yr2 = p.hasY2 ? this._yRange('y2') : null; const Y2 = yr2 ? (y) => p.y + p.h - (y - yr2[0]) / (yr2[1] - yr2[0]) * p.h : null;
    // полосы
    ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    this.bands.forEach(b => { if (b.x1 < vx0 || b.x0 > vx1) return; ctx.fillStyle = b.color; const a = X(b.x0), c = X(b.x1); ctx.fillRect(a, p.y, Math.max(1, c - a), p.h); if (b.label && c - a > 40) { ctx.fillStyle = T.text; ctx.globalAlpha = 0.8; ctx.fillText(b.label, a + 4, p.y + 12 * scale); ctx.globalAlpha = 1; } });
    ctx.restore();
    // сетка и оси
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.fillStyle = T.text; ctx.textBaseline = 'middle';
    const ys = niceStep(yr[1] - yr[0], Math.max(3, Math.round(p.h / 45))); ctx.textAlign = 'right';
    for (let v = Math.ceil(yr[0] / ys) * ys; v <= yr[1] + 1e-9; v += ys) { const y = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke(); ctx.fillText(fmtNum(v, ys < 1 ? (ys < 0.1 ? 2 : 1) : 0), p.x - 6, y); }
    if (yr2) { const s2 = niceStep(yr2[1] - yr2[0], Math.max(3, Math.round(p.h / 45))); ctx.textAlign = 'left'; for (let v = Math.ceil(yr2[0] / s2) * s2; v <= yr2[1] + 1e-9; v += s2) ctx.fillText(fmtNum(v, s2 < 1 ? 1 : 0), p.x + p.w + 6, Y2(v)); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    if (this.o.xType === 'time') {
      const span = vx1 - vx0; const target = span / Math.max(2, p.w / 90); let st = TIME_STEPS.find(s => s >= target) || TIME_STEPS[TIME_STEPS.length - 1];
      const tz = new Date().getTimezoneOffset() * 60000; let v = Math.ceil((vx0 - tz) / st) * st + tz;
      if (st >= 86400e3) { const d = new Date(vx0); d.setHours(0, 0, 0, 0); v = d.getTime() + 86400e3; }
      for (; v <= vx1; v += st) { const x = Math.round(X(v)) + 0.5; ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke(); ctx.fillText(fmtTime(v, st), x, p.y + p.h + 6); }
    } else {
      const xs = niceStep(vx1 - vx0, Math.max(3, Math.round(p.w / 80)));
      for (let v = Math.ceil(vx0 / xs) * xs; v <= vx1 + 1e-9; v += xs) { const x = Math.round(X(v)) + 0.5; ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke(); ctx.fillText((this.o.xFmt ? this.o.xFmt(v) : fmtNum(v, xs < 1 ? 1 : 0)), x, p.y + p.h + 6); }
    }
    if (this.o.yLabel) { ctx.save(); ctx.translate(12 * scale, p.y + p.h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(this.o.yLabel, 0, 0); ctx.restore(); }
    if (this.o.y2Label && yr2) { ctx.save(); ctx.translate(this.W - 10 * scale, p.y + p.h / 2); ctx.rotate(Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(this.o.y2Label, 0, 0); ctx.restore(); }
    if (printMode && this.o.title) { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = 'bold ' + Math.round(14 * scale) + 'px Calibri, Arial'; ctx.fillStyle = this.o.theme === 'dark' ? '#DDE8F3' : '#1B2A3A'; ctx.fillText(this.o.title, p.x, 2); ctx.font = Math.round(13 * scale) + 'px Calibri, Arial'; }
    // клип для данных + анимация появления
    ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y - 2, p.w * (this.reveal == null ? 1 : this.reveal), p.h + 4); ctx.clip();
    this.hlines.forEach(h => { const y = Math.round(Y(h.y)) + 0.5; ctx.strokeStyle = h.color; ctx.setLineDash(h.dash || [6, 4]); ctx.lineWidth = 1.2 * scale; ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke(); ctx.setLineDash([]); if (h.label) { ctx.fillStyle = h.color; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(h.label, p.x + p.w - 4, y - 2); } });
    this.series.forEach((s, si) => {
      if (this.hidden[si]) return; const YY = s.axis === 'y2' ? Y2 : Y; const x = s.x, y = s.y; const n = x.length; if (!n) return;
      let i0 = 0, i1 = n - 1; { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (x[m] < vx0) lo = m + 1; else hi = m; } i0 = Math.max(0, lo - 1); lo = 0; hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (x[m] > vx1) hi = m - 1; else lo = m; } i1 = Math.min(n - 1, lo + 1); }
      // доверительная полоса
      if (s.yLo && s.yHi) { ctx.fillStyle = s.bandColor || s.color; ctx.globalAlpha = 0.16; ctx.beginPath(); let st = false; for (let i = i0; i <= i1; i++) { const v = s.yHi[i]; if (!Number.isFinite(v)) continue; if (!st) { ctx.moveTo(X(x[i]), YY(v)); st = true; } else ctx.lineTo(X(x[i]), YY(v)); } for (let i = i1; i >= i0; i--) { const v = s.yLo[i]; if (Number.isFinite(v)) ctx.lineTo(X(x[i]), YY(v)); } ctx.fill(); ctx.globalAlpha = 1; }
      if (s.type === 'bar') { const bw = Math.min(64 * scale, Math.max(2, (s.barW || 0.7) * p.w / Math.max(1, (vx1 - vx0)))); for (let i = i0; i <= i1; i++) { if (!Number.isFinite(y[i])) continue; ctx.fillStyle = s.colors ? s.colors[i] : s.color; const y0 = YY(Math.max(0, yr[0])); ctx.fillRect(X(x[i]) - bw / 2, Math.min(YY(y[i]), y0), bw, Math.abs(y0 - YY(y[i]))); } return; }
      if (s.type === 'scatter') { ctx.fillStyle = s.color; for (let i = i0; i <= i1; i++) { if (!Number.isFinite(y[i])) continue; ctx.beginPath(); ctx.arc(X(x[i]), YY(y[i]), (s.r || 3) * scale, 0, 7); ctx.fill(); } return; }
      ctx.strokeStyle = s.color; ctx.lineWidth = (s.width || 1.6) * scale; ctx.lineJoin = 'round'; if (s.dash) ctx.setLineDash(s.dash.map(d => d * scale));
      // децимация min/max по пикселям
      const pts = []; const perPx = (i1 - i0) / p.w;
      if (perPx > 2) { let col = -1, mn = null, mx = null, first = null, last = null; const flush = () => { if (first) { pts.push(first); if (mn && mn !== first && mn !== last) pts.push(mn); if (mx && mx !== first && mx !== last && mx !== mn) pts.push(mx); if (last !== first) pts.push(last); } };
        for (let i = i0; i <= i1; i++) { const v = y[i]; const c = Math.floor(X(x[i])); if (!Number.isFinite(v)) { flush(); pts.push(null); col = -1; first = mn = mx = last = null; continue; } const pt = [X(x[i]), YY(v)]; if (c !== col) { flush(); col = c; first = mn = mx = last = pt; } else { if (pt[1] < mn[1]) mn = pt; if (pt[1] > mx[1]) mx = pt; last = pt; } } flush(); }
      else for (let i = i0; i <= i1; i++) pts.push(Number.isFinite(y[i]) ? [X(x[i]), YY(y[i])] : null);
      const path = new Path2D(); let pen = false, prev = null;
      pts.forEach(pt => { if (!pt) { pen = false; return; } if (!pen) { path.moveTo(pt[0], pt[1]); pen = true; } else if (s.type === 'step' && prev) { path.lineTo(pt[0], prev[1]); path.lineTo(pt[0], pt[1]); } else path.lineTo(pt[0], pt[1]); prev = pt; });
      if (s.fill) { const g = ctx.createLinearGradient(0, p.y, 0, p.y + p.h); g.addColorStop(0, s.fill); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.save(); ctx.fillStyle = g; const fp = new Path2D(); let st = false, lx = 0, fx = 0; pts.forEach(pt => { if (!pt) return; if (!st) { fp.moveTo(pt[0], p.y + p.h); fp.lineTo(pt[0], pt[1]); fx = pt[0]; st = true; } else fp.lineTo(pt[0], pt[1]); lx = pt[0]; }); fp.lineTo(lx, p.y + p.h); fp.lineTo(fx, p.y + p.h); ctx.fill(fp); ctx.restore(); }
      ctx.stroke(path); ctx.setLineDash([]);
      if (s.points) { ctx.fillStyle = s.color; pts.forEach(pt => { if (pt) { ctx.beginPath(); ctx.arc(pt[0], pt[1], 2.2 * scale, 0, 7); ctx.fill(); } }); }
    });
    ctx.restore();
    // вертикальные линии и маркеры
    this.vlines.forEach(v => { if (v.x < vx0 || v.x > vx1) return; const x = Math.round(X(v.x)) + 0.5; ctx.strokeStyle = v.color; ctx.lineWidth = 1.4 * scale; ctx.setLineDash(v.dash || [4, 3]); ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke(); ctx.setLineDash([]); if (v.label) { ctx.fillStyle = v.color; const al = v.align || (x > p.x + p.w - ctx.measureText(v.label).width - 10 ? 'right' : 'left'); ctx.textAlign = al; ctx.textBaseline = 'top'; ctx.fillText(v.label, x + (al === 'right' ? -4 : 4), p.y + 2 + (v.row || 0) * 14 * scale); } });
    this.markers.forEach(m => {
      if (m.x < vx0 || m.x > vx1) return; const x = X(m.x); const yv = m.y != null ? (m.axis === 'y2' ? Y2(m.y) : Y(m.y)) : p.y + 8;
      ctx.fillStyle = m.color; ctx.strokeStyle = m.ring || 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); if (m.shape === 'tri') { ctx.moveTo(x, yv - 7 * scale); ctx.lineTo(x + 6 * scale, yv + 4 * scale); ctx.lineTo(x - 6 * scale, yv + 4 * scale); ctx.closePath(); } else if (m.shape === 'diamond') { ctx.moveTo(x, yv - 6 * scale); ctx.lineTo(x + 6 * scale, yv); ctx.lineTo(x, yv + 6 * scale); ctx.lineTo(x - 6 * scale, yv); ctx.closePath(); } else ctx.arc(x, yv, 4.5 * scale, 0, 7);
      ctx.fill(); ctx.stroke();
      if (m.dim) { ctx.fillStyle = 'rgba(20,30,40,0.6)'; ctx.fill(); }
    });
    // перекрестие и подсказка
    if (this.hx != null && this.hx >= vx0 && this.hx <= vx1 && !printMode) {
      const x = Math.round(X(this.hx)) + 0.5; ctx.strokeStyle = T.cross; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke(); ctx.setLineDash([]);
      const rows = []; let near = null;
      this.series.forEach((s, si) => {
        if (this.hidden[si] || s.tooltip === false || !s.x.length) return; const xs = s.x; let lo = 0, hi = xs.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < this.hx) lo = m + 1; else hi = m; } let k = lo; if (k > 0 && Math.abs(xs[k - 1] - this.hx) < Math.abs(xs[k] - this.hx)) k--;
        if (Math.abs(xs[k] - this.hx) > (vx1 - vx0) / 15) return; const v = s.y[k]; if (!near) near = xs[k];
        const YY = s.axis === 'y2' ? Y2 : Y; if (Number.isFinite(v)) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(xs[k]), YY(v), 3.5, 0, 7); ctx.fill(); }
        rows.push('<div><i style="background:' + s.color + '"></i>' + s.name + '<b>' + (s.fmt ? s.fmt(v) : fmtNum(v)) + (s.unit ? ' ' + s.unit : '') + '</b></div>');
      });
      const mk = this.markers.filter(m => Math.abs(X(m.x) - x) < 8 && m.tip); mk.forEach(m => rows.push('<div class="tm">' + m.tip + '</div>'));
      const bd = this.bands.find(b => this.hx >= b.x0 && this.hx <= b.x1 && b.tip); if (bd) rows.push('<div class="tm">' + bd.tip + '</div>');
      if (rows.length && this.tip && this.o.tooltip) {
        const head = this.o.xType === 'time' ? fmtFull(near != null ? near : this.hx) : (this.o.xTip ? this.o.xTip(this.hx) : fmtNum(this.hx));
        this.tip.innerHTML = '<div class="th">' + head + '</div>' + rows.join(''); this.tip.style.display = 'block';
        const tw = this.tip.offsetWidth; let left = x + 14; if (left + tw > this.W - 4) left = x - tw - 14; this.tip.style.left = left + 'px'; this.tip.style.top = (p.y + 6) + 'px';
      }
    } else if (this.tip) this.tip.style.display = 'none';
    ctx.restore();
  };
  TChart.destroyGroup = function (g) { delete groups[g]; };
  TChart.fmtNum = fmtNum; TChart.fmtFull = fmtFull;
  return TChart;
})();
