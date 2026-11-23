/* ============================================================================
   APP: интерфейс программы
   ========================================================================== */
const App = (function () {
  'use strict';
  const C = GCORE, H = 3600000, F = (v, d) => TChart.fmtNum(v, d), fH = C.fmtH, fDT = C.fmtDT, isF = Number.isFinite;
  const S = { fields: [], wells: [], sel: null, tab: 'dash', open: {}, cache: {}, q: '', dataView: { key: 'pwh', page: 0, filter: 'all' } };
  const $ = (q, r) => (r || document).querySelector(q);
  const $$ = (q, r) => Array.from((r || document).querySelectorAll(q));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const COL = { pwh: '#F2B33D', pline: '#4FB3E8', dp: '#C08CFF', q: '#46D69A', cum: '#8FE3C4', old: '#E8715A', neu: '#27C3AE', crit: '#FF5A6E', warn: '#F2B33D', stop: '#7F93A8', info: '#6FB8FF' };
  const STATUS_COLORS = { normal: 'rgba(70,214,154,.20)', watch: 'rgba(111,184,255,.20)', soon: 'rgba(242,179,61,.22)', critical: 'rgba(255,90,110,.24)', stopped: 'rgba(127,147,168,.20)', after: 'rgba(79,179,232,.2)', none: 'rgba(97,122,147,.15)' };

  /* ------------------------------ утилиты UI ------------------------------ */
  function toast(msg, err) { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; $('.toasts').appendChild(t); setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = 0; setTimeout(() => t.remove(), 400); }, err ? 7000 : 3500); }
  function busy(on, text) { let b = $('.busy'); if (on) { if (!b) { b = document.createElement('div'); b.className = 'busy'; document.body.appendChild(b); } b.innerHTML = '<div><span class="spin"></span>' + esc(text || 'Расчёт…') + '</div>'; } else if (b) b.remove(); }
  function modal(title, body, buttons, cls) {
    return new Promise((res) => {
      const ov = document.createElement('div'); ov.className = 'ov';
      ov.innerHTML = '<div class="modal ' + (cls || '') + '" role="dialog" aria-modal="true"><div class="mh"><h3>' + esc(title) + '</h3><button class="icon-btn" data-x title="Закрыть">' + ICO.x + '</button></div><div class="mb"></div><div class="mf"></div></div>';
      const mb = $('.mb', ov); if (typeof body === 'string') mb.innerHTML = body; else mb.appendChild(body);
      const mf = $('.mf', ov);
      const close = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); res(v); };
      (buttons || [{ t: 'Закрыть', v: null }]).forEach(b => { const e = document.createElement('button'); e.className = 'tbtn' + (b.primary ? ' primary' : ''); e.textContent = b.t; e.onclick = async () => { if (b.check) { const ok = await b.check(ov); if (!ok) return; } close(b.v); }; mf.appendChild(e); });
      $('[data-x]', ov).onclick = () => close(null);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(null); });
      const onKey = (e) => { if (e.key === 'Escape') close(null); }; document.addEventListener('keydown', onKey);
      document.body.appendChild(ov); setTimeout(() => { const f = $('input,select', ov); if (f) f.focus(); }, 50);
      ov._close = close;
    });
  }
  async function confirmBox(text, okText) { return await modal('Подтверждение', '<p>' + text + '</p>', [{ t: 'Отмена', v: false }, { t: okText || 'Удалить', v: true, primary: true }], 'sm'); }

  /* --------------------------------- данные -------------------------------- */
  async function loadAll() { S.fields = (await GDB.all('fields')).sort((a, b) => a.created - b.created); S.wells = (await GDB.all('wells')).sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true })); }
  const wellById = (id) => S.wells.find(w => w.id === id);
  const fieldById = (id) => S.fields.find(f => f.id === id);
  function applyEdits(ser) {
    const raw = { pwh: { t: ser.pwh.t, v: ser.pwh.v.slice() }, pline: { t: ser.pline.t, v: ser.pline.v.slice() } };
    ['pwh', 'pline'].forEach(k => { const e = (ser.edits || {})[k] || {}; if (Object.keys(e).length) raw[k].t.forEach((t, i) => { if (e[t] != null) raw[k].v[i] = e[t]; }); });
    return raw;
  }
  async function getAnalysis(wellId, force) {
    const key = wellId + '|' + GSRC.st.mode;
    if (!force && S.cache[key]) return S.cache[key];
    const w = wellById(wellId); const ser = await GDB.get('series', wellId);
    const sel = ser ? GSRC.rawFor(ser) : null;
    if (!ser || !sel.raw.pwh.t.length) { S.cache[key] = { empty: true, w, ser, mode: GSRC.st.mode }; return S.cache[key]; }
    const A = C.analyze(applyEdits(Object.assign({}, ser, { pwh: sel.raw.pwh, pline: sel.raw.pline })), w.params, { excl: ser.excl, overrides: ser.overrides });
    const rec = C.recommend(A);
    const res = { A, ser, w, rec, origin: sel.origin, conflicts: sel.conflicts, cachedAt: sel.cachedAt, mode: GSRC.st.mode };
    S.cache[key] = res;
    // статус в дереве + журнал рекомендаций
    if (w.statusCode !== A.status.code || w.statusText !== A.status.text) { w.statusCode = A.status.code; w.statusText = A.status.text; await GDB.put('wells', w); if (document.getElementById('tree')) renderTree(); }
    await logRec(w, rec, A);
    return res;
  }
  async function logRec(w, rec, A) {
    const all = await GDB.byWell('recs', w.id); all.sort((a, b) => b.created - a.created);
    const last = all[0];
    if (last && last.dataTo === rec.dataTo && last.title === rec.title) return;
    await GDB.put('recs', Object.assign({ id: GDB.uid(), wellId: w.id, mode: GSRC.st.mode, decision: 'на рассмотрении', paramsSnapshot: { d_mm: A.p.d_mm, gamma: A.p.gamma, dpCrit: A.stats.dpCrit, tau: A.opt.ok ? A.opt.opt.tau : null } }, rec));
  }
  function invalidate(wellId) { Object.keys(S.cache).forEach(k => { if (k.split('|')[0] === wellId) delete S.cache[k]; }); }

  /* ------------------------------- оболочка -------------------------------- */
  function shell() {
    document.body.innerHTML = '<div class="app">' +
      '<header class="top"><div class="brand">' + ICO.logo + '<div><b>ГазПродувка</b><small>Мониторинг и оптимизация продувок газовых скважин</small></div></div>' +
      '<div class="crumbs" id="crumbs"></div>' +
      '<button class="tbtn primary" id="bImport">' + ICO.upload + 'Получить данные</button>' +
      '<button class="tbtn" id="bParams">' + ICO.gear + 'Параметры скважины</button>' +
      '<button class="tbtn" id="bRep">' + ICO.doc + 'Отчётность</button>' +
      '<button class="srcpill" id="srcPill" title="Источник данных"></button>' +
      '<div class="menu" id="mDb"><button class="icon-btn" title="База данных">' + ICO.db + '</button><div class="dd">' +
      '<button data-d="exp">' + ICO.db + '<div>Сохранить резервную копию<small>вся база в файл JSON</small></div></button>' +
      '<button data-d="imp">' + ICO.upload + '<div>Восстановить из копии<small>добавить данные из JSON</small></div></button>' +
      '<button data-d="about">' + ICO.info + '<div>О методике расчёта<small>формулы и допущения</small></div></button></div></div>' +
      '</header>' +
      '<aside class="left"><div class="lhead"><div class="search">' + ICO.search + '<input id="q" placeholder="Поиск скважины" aria-label="Поиск скважины"></div><button class="icon-btn" id="bAddField" title="Создать месторождение">' + ICO.plus + '</button></div><nav class="tree" id="tree" aria-label="Дерево объектов"></nav>' +
      '<div class="lfoot"><span class="dbdot"></span><span id="dbinfo">Локальная база</span></div></aside>' +
      '<main class="main"><div class="tabs" id="tabs" role="tablist"></div><div class="view" id="view"></div></main>' +
      '<aside class="right" id="right"></aside></div><div class="toasts"></div>';
    $('#bImport').onclick = () => App.GPN.getData(ctx());
    $('#bParams').onclick = () => { if (S.sel && S.sel.type === 'well') paramsDialog(S.sel.id); else toast('Выберите скважину в дереве', true); };
    $('#bAddField').onclick = addField;
    $('#q').oninput = (e) => { S.q = e.target.value.trim().toLowerCase(); renderTree(); };
    $('#bRep').onclick = () => select({ type: 'reports' }, 'reports');
    $('#srcPill').onclick = () => select({ type: 'sources' }, 'sources');
    ['mDb'].forEach(id => { const m = $('#' + id); m.firstElementChild.onclick = (e) => { e.stopPropagation(); $$('.menu.open').forEach(x => { if (x !== m) x.classList.remove('open'); }); m.classList.toggle('open'); }; });
    document.addEventListener('click', () => $$('.menu.open').forEach(x => x.classList.remove('open')));
    $$('#mDb [data-d]').forEach(b => b.onclick = () => dbAction(b.dataset.d));
    $('#dbinfo').textContent = GDB.persistent() ? 'Локальная база IndexedDB' : 'База в памяти (IndexedDB недоступна)';
  }

  /* ---------------------------------- дерево ------------------------------- */
  const WELL_NODES = [['data', 'История измерений', 'data'], ['cycles', 'Продувки и циклы', 'cycles'], ['forecast', 'Анализ и прогноз', 'forecast'], ['journal', 'Рекомендации', 'journal']];
  function renderTree() {
    const tr = $('#tree'); let html = '';
    const tops = [['fund', 'Сводка по фонду', ICO.compare], ['reports', 'Отчётность', ICO.doc], ['sources', 'Источники данных', ICO.db]];
    html += '<div class="tree-top">' + tops.map(([k, l, ic]) => '<div class="tn top' + (S.sel && S.sel.type === k ? ' sel' : '') + '" data-top="' + k + '" tabindex="0"><span class="ic">' + ic + '</span><span class="lbl">' + l + '</span>' + (k === 'fund' ? '<span class="muted small">' + S.wells.length + '</span>' : '') + '</div>').join('') + '</div><div class="tree-sep">Месторождения</div>';
    if (!S.fields.length) html = '<div class="muted small" style="padding:14px 8px">База пуста. Импортируйте файл или создайте месторождение кнопкой «+».</div>';
    S.fields.forEach(f => {
      const wells = S.wells.filter(w => w.fieldId === f.id && (!S.q || w.name.toLowerCase().includes(S.q) || f.name.toLowerCase().includes(S.q)));
      if (S.q && !wells.length && !f.name.toLowerCase().includes(S.q)) return;
      const open = S.open[f.id] !== false; const sel = S.sel && S.sel.type === 'field' && S.sel.id === f.id;
      html += '<div class="tn' + (sel ? ' sel' : '') + '" data-f="' + f.id + '" tabindex="0"><span class="tw' + (open ? ' open' : '') + '" data-tog>' + ICO.chev + '</span><span class="ic" style="color:#F2B33D">' + ICO.field + '</span><span class="lbl">' + esc(f.name) + '</span><span class="muted small">' + wells.length + '</span><span class="acts"><button data-a="addw" title="Добавить скважину">' + ICO.plus + '</button><button data-a="ren" title="Переименовать">' + ICO.edit + '</button><button data-a="del" title="Удалить">' + ICO.trash + '</button></span></div>';
      if (open) {
        html += '<div class="kids">';
        wells.forEach(w => {
          const wsel = S.sel && S.sel.type === 'well' && S.sel.id === w.id; const wopen = !!S.open[w.id] || wsel;
          html += '<div class="tn l1' + (wsel && !S.sel.sub ? ' sel' : '') + '" data-w="' + w.id + '" tabindex="0" title="' + esc(w.statusText || 'нет данных') + '"><span class="tw' + (wopen ? ' open' : '') + '" data-tog>' + ICO.chev + '</span><span class="sd ' + (w.statusCode || 'none') + '"></span><span class="lbl">' + esc(w.name) + '</span><span class="acts"><button data-a="imp" title="Импорт данных для скважины">' + ICO.upload + '</button><button data-a="ren" title="Переименовать">' + ICO.edit + '</button><button data-a="del" title="Удалить">' + ICO.trash + '</button></span></div>';
          if (wopen) WELL_NODES.forEach(([tab, lbl, ic]) => { html += '<div class="tn l2' + (wsel && S.tab === tab ? ' sel' : '') + '" data-w="' + w.id + '" data-tab="' + tab + '" tabindex="0"><span class="ic">' + ICO[ic] + '</span><span class="lbl">' + lbl + '</span></div>'; });
        });
        html += '</div>';
      }
    });
    tr.innerHTML = html;
    $$('.tn', tr).forEach(n => {
      if (n.dataset.top) { n.onclick = () => select({ type: n.dataset.top }, n.dataset.top); n.onkeydown = (e) => { if (e.key === 'Enter') n.click(); }; return; }
      n.onclick = async (e) => {
        const a = e.target.closest('[data-a]'); const tog = e.target.closest('[data-tog]');
        if (n.dataset.f) {
          const f = fieldById(n.dataset.f);
          if (a) { e.stopPropagation(); if (a.dataset.a === 'addw') return addWell(f.id); if (a.dataset.a === 'ren') return renameObj('fields', f); if (a.dataset.a === 'del') return deleteField(f); }
          if (tog) { S.open[f.id] = S.open[f.id] === false; return renderTree(); }
          select({ type: 'field', id: f.id }, 'compare');
        } else {
          const w = wellById(n.dataset.w);
          if (a) { e.stopPropagation(); if (a.dataset.a === 'imp') return importWizard(w.id); if (a.dataset.a === 'ren') return renameObj('wells', w); if (a.dataset.a === 'del') return deleteWell(w); }
          if (tog && !n.dataset.tab) { S.open[w.id] = !S.open[w.id]; return renderTree(); }
          select({ type: 'well', id: w.id }, n.dataset.tab || (S.sel && S.sel.type === 'well' ? S.tab : 'dash'));
        }
      };
      n.onkeydown = (e) => { if (e.key === 'Enter') n.click(); };
    });
  }
  async function addField() {
    const name = await askName('Новое месторождение', 'Название месторождения', ''); if (!name) return;
    const f = { id: GDB.uid(), name, created: Date.now() }; await GDB.put('fields', f); await loadAll(); renderTree(); select({ type: 'field', id: f.id }, 'compare'); toast('Месторождение «' + name + '» создано');
  }
  async function addWell(fieldId) {
    const name = await askName('Новая скважина', 'Номер / название скважины', ''); if (!name) return;
    const w = { id: GDB.uid(), fieldId, name, params: {}, created: Date.now() }; await GDB.put('wells', w); await loadAll(); S.open[fieldId] = true; renderTree(); select({ type: 'well', id: w.id }, 'dash');
    toast('Скважина «' + name + '» добавлена'); await paramsDialog(w.id, true);
  }
  async function askName(title, label, val) {
    let v = null;
    await modal(title, '<div class="fg"><label>' + esc(label) + '</label><input id="nm" value="' + esc(val) + '"></div>', [{ t: 'Отмена', v: null }, { t: 'Сохранить', v: 1, primary: true, check: (ov) => { v = $('#nm', ov).value.trim(); if (!v) { toast('Введите название', true); return false; } return true; } }], 'sm');
    return v;
  }
  async function renameObj(store, obj) { const v = await askName('Переименование', 'Новое название', obj.name); if (!v) return; obj.name = v; await GDB.put(store, obj); await loadAll(); renderTree(); renderCrumbs(); toast('Переименовано: ' + v); }
  async function deleteField(f) {
    const ws = S.wells.filter(w => w.fieldId === f.id);
    if (!await confirmBox('Удалить месторождение «' + esc(f.name) + '» вместе со скважинами (' + ws.length + ') и всей историей измерений? Действие необратимо — сначала можно сохранить резервную копию базы.', 'Удалить месторождение')) return;
    for (const w of ws) await purgeWell(w.id);
    await GDB.del('fields', f.id); await loadAll(); if (S.sel && (S.sel.id === f.id || ws.some(w => w.id === S.sel.id))) S.sel = null; renderTree(); render(); toast('Месторождение удалено');
  }
  async function deleteWell(w) {
    if (!await confirmBox('Удалить скважину «' + esc(w.name) + '» и всю её историю измерений и рекомендаций?', 'Удалить скважину')) return;
    await purgeWell(w.id); await loadAll(); if (S.sel && S.sel.id === w.id) S.sel = null; renderTree(); render(); toast('Скважина удалена');
  }
  async function purgeWell(id) { await GDB.del('wells', id); await GDB.del('series', id); for (const r of await GDB.byWell('recs', id)) await GDB.del('recs', r.id); invalidate(id); }

  /* -------------------------------- выбор/табы ------------------------------ */
  const TABS_WELL = [['dash', 'Дашборд', 'chart'], ['data', 'Данные', 'data'], ['cycles', 'Продувки и циклы', 'cycles'], ['forecast', 'Прогноз', 'forecast'], ['opt', 'Оптимизация', 'opt'], ['eff', 'Эффективность оптимизации', 'eff'], ['rate', 'Дебит газа', 'rate'], ['anim', 'Анимация цикла', 'play'], ['journal', 'Журнал', 'journal']];
  const TABS_FIELD = [['compare', 'Сравнение скважин', 'compare']];
  function select(sel, tab) { S.sel = sel; S.tab = tab; if (sel.type === 'well') { const w = wellById(sel.id); if (w) S.open[w.fieldId] = true; } renderTree(); render(); }
  function renderCrumbs() {
    const c = $('#crumbs'); if (!S.sel) { c.innerHTML = 'Выберите объект в дереве'; return; }
    if (['fund', 'reports', 'sources'].includes(S.sel.type)) { c.innerHTML = '<b>' + ({ fund: 'Сводка по фонду скважин', reports: 'Отчётность', sources: 'Источники данных' })[S.sel.type] + '</b>'; return; }
    if (S.sel.type === 'field') { const f = fieldById(S.sel.id); c.innerHTML = '<b>' + esc(f ? f.name : '') + '</b> — обзор месторождения'; return; }
    const w = wellById(S.sel.id); const f = w ? fieldById(w.fieldId) : null; c.innerHTML = esc(f ? f.name : '') + ' / <b>Скважина ' + esc(w ? w.name : '') + '</b>';
  }
  function renderTabs() {
    const tabs = !S.sel || ['fund', 'reports', 'sources'].includes(S.sel.type) ? [] : S.sel.type === 'field' ? TABS_FIELD : TABS_WELL;
    const el = $('#tabs'); el.style.display = tabs.length ? '' : 'none'; el.innerHTML = tabs.map(([k, l, i]) => '<button class="tab' + (S.tab === k ? ' on' : '') + '" role="tab" aria-selected="' + (S.tab === k) + '" data-t="' + k + '">' + ICO[i] + l + '</button>').join('') + '<span class="tabbar"></span>';
    $$('.tab', el).forEach(b => b.onclick = () => { S.tab = b.dataset.t; renderTabs(); renderView(); renderTree(); });
    requestAnimationFrame(() => { const on = $('.tab.on', el), bar = $('.tabbar', el); if (on && bar) { bar.style.left = on.offsetLeft + 'px'; bar.style.width = on.offsetWidth + 'px'; } });
  }
  async function render() { renderCrumbs(); renderTabs(); await renderView(); }
  async function renderView() {
    const v = $('#view'); TChart.destroyGroup('g'); TChart.destroyGroup('cmp');
    $('#bParams').disabled = !(S.sel && S.sel.type === 'well'); renderSrcPill();
    document.querySelector('.app').classList.toggle('wide', !!(S.sel && ['fund', 'reports', 'sources', 'field'].includes(S.sel.type)));
    if (S.anim) { S.anim.stop(); S.anim = null; }
    if (!S.sel) { v.innerHTML = emptyState(); bindEmpty(); renderRight(null); return; }
    if (['fund', 'reports', 'sources'].includes(S.sel.type)) { v.innerHTML = '<div class="pane"></div>'; await App.views[S.sel.type]($('.pane', v), ctx()); renderRight(null); return; }
    if (S.sel.type === 'field') { await viewCompare(v); await App.views.fieldTotals(v, ctx(), S.sel.id); renderRight(null); return; }
    const R = await getAnalysis(S.sel.id);
    if (R.empty) { v.innerHTML = '<div class="pane"><div class="empty">' + ICO.hero + '<h2>Нет данных по скважине ' + esc(R.w.name) + '</h2><p>В режиме «' + esc(GSRC.MODES[GSRC.st.mode]) + '» измерений нет. Импортируйте выгрузку (XLSX, XLS, CSV, 7z) или переключите источник данных.</p><div class="actions"><button class="tbtn primary" id="eImp">' + ICO.upload + 'Импортировать данные</button></div></div></div>'; $('#eImp').onclick = () => importWizard(R.w.id); renderRight(R); return; }
    if (GSRC.st.onCard && GSRC.st.connId && GSRC.st.mode !== 'offline' && R.w.ext && (!S.lastCardSync || Date.now() - S.lastCardSync > 60000)) { S.lastCardSync = Date.now(); GSRC.sync('открытие карточки скважины'); }
    const fn = { dash: viewDash, data: viewData, cycles: viewCycles, forecast: (e2, R2) => App.views.forecastX(e2, R2, ctx(), viewForecast), opt: viewOpt, eff: viewEff, rate: viewRate, journal: (e2, R2) => App.views.journalX(e2, R2, ctx(), viewJournal), anim: (el2, R2) => App.views.anim(el2, R2, ctx()) }[S.tab] || viewDash;
    v.innerHTML = '<div class="pane"></div>'; await fn($('.pane', v), R); renderRight(R);
  }
  function emptyState() {
    return '<div class="pane"><div class="welcome"><div><h1>Мониторинг и оптимизация продувок газовых скважин</h1><p>Загрузите выгрузку SCADA с давлением на голове скважины и в шлейфе. Программа выявит продувки, оценит признаки накопления жидкости, спрогнозирует потерю работоспособности и подберёт интервал продувок.</p>' +
      '<div class="actions"><button class="tbtn primary" id="eImp">' + ICO.upload + 'Импортировать файл</button><button class="tbtn" id="eField">' + ICO.plus + 'Создать месторождение</button></div>' +
      '<ol class="wl-steps"><li><b>Импорт данных</b><span>архив .7z, Excel .xlsx или CSV — листы и столбцы распознаются автоматически</span></li><li><b>Параметры скважины</b><span>диаметр штуцера и относительная плотность газа для расчёта дебита</span></li><li><b>Анализ и решение</b><span>прогноз, оптимальный интервал продувок, отчёты Word и PowerPoint</span></li></ol></div>' +
      '<figure class="wl-art" style="margin:0">' + ICO.hero + '<figcaption>Типичный цикл: продувка — скачок Pwh, затухание перепада до критического уровня, остановка.</figcaption></figure></div></div>';
  }
  function bindEmpty() { $('#eImp').onclick = () => importWizard(); $('#eField').onclick = addField; }

  /* ----------------------------- общие элементы ----------------------------- */
  function warnBlock(R) {
    const A = R.A; let h = '';
    if (!A.flowOK) h += '<div class="warnbox">' + ICO.warn + '<div><b>Дебит не рассчитывается.</b> Укажите диаметр штуцера и относительную плотность газа в параметрах скважины — без них недоступны оптимизация по добыче и сравнение режимов. <button class="mini" data-go-params>Открыть параметры</button></div></div>';
    if (A.conf.score < 0.5) h += '<div class="warnbox err">' + ICO.warn + '<div><b>Достоверность прогноза: ' + A.conf.level + '.</b> ' + esc(A.conf.notes.join(' ')) + '</div></div>';
    if (R.mode === 'online' && GSRC.st.status === 'error') h += '<div class="warnbox err">' + ICO.warn + '<div><b>Нет соединения с PostgreSQL.</b> Анализ выполняется на последних сохранённых данных (получены ' + fDT(R.cachedAt) + '), это не актуальные Online-измерения. ' + esc(GSRC.st.lastErr || '') + '</div></div>';
    if (R.mode === 'merged' && R.conflicts && R.conflicts.length) h += '<div class="warnbox">' + ICO.warn + '<div>Объединённые данные: найдено конфликтов значений — <b>' + R.conflicts.length + '</b>; приоритетный источник — ' + (GSRC.st.priority === 'online' ? 'PostgreSQL' : 'Excel') + '. Подробности — в разделе «Источники данных».</div></div>';
    const age = (Date.now() - A.forecast.tNow) / H;
    if (age > 1.5) h += '<div class="warnbox info">' + ICO.info + '<div>Последний замер — <b>' + fDT(A.forecast.tNow) + '</b> (' + fH(age) + ' назад). Прогноз и рекомендации рассчитаны на момент последнего замера; для актуализации ' + (R.mode === 'offline' ? 'импортируйте новые данные' : 'обновите данные из PostgreSQL') + '.</div></div>';
    return h;
  }
  function bindParamsBtn(root) { $$('[data-go-params]', root).forEach(b => b.onclick = () => paramsDialog(S.sel.id)); }
  function phaseBands(A, opts) {
    opts = opts || {}; const s = A.s, st = A.det.state, out = []; let a = 0;
    for (let i = 1; i <= st.length; i++) { if (i === st.length || st[i] !== st[a]) { const x0 = s.t[a], x1 = s.t[Math.min(i, st.length - 1)]; if (st[a] === 'D') out.push({ x0, x1, color: 'rgba(127,147,168,0.13)', legend: opts.legend !== false ? 'Остановка / продувка' : null, tip: 'Остановка ' + fH((x1 - x0) / H) }); else if (opts.work) out.push({ x0, x1, color: 'rgba(70,214,154,0.05)' }); a = i; } }
    return out;
  }
  function eventMarkers(A, y) {
    const m = [];
    A.det.events.forEach(e => m.push({ x: e.tEvent, y: y === 'pwh' ? e.peak : null, color: e.valid ? COL.warn : '#5A6F85', shape: 'tri', dim: !e.valid, tip: (e.valid ? 'Продувка / перезапуск' : 'Скачок отклонён') + ': +' + F(e.jump, 1) + ' кгс/см², ' + F(e.rate, 0) + ' кгс/см²/ч' + (e.manual ? ' (вручную)' : '') }));
    A.cycles.filter(c => c.complete).forEach(c => m.push({ x: c.tEnd, y: y === 'pwh' ? c.pwhEnd : y === 'dp' ? c.dpEnd : null, color: COL.crit, tip: 'Потеря работоспособности: ΔP = ' + F(c.dpEnd, 2) + ' кгс/см²' }));
    return m;
  }
  function forecastSeries(A) {
    const fc = A.forecast, tpl = A.tpl; if (fc.mode !== 'work' || !isF(fc.tCritAge)) return null;
    const off = isF(fc.ageEquivalent) ? fc.ageEquivalent - fc.age : 0;
    const x = [], dp = [], lo = [], hi = [], pwh = [], q = [];
    for (let t = fc.age; t <= Math.max(fc.tCritHiAge, fc.tCritAge) + 0.01; t += 0.25) { const te = Math.max(0, t + off); x.push(fc.cycle.tStart + t * H); dp.push(tpl.at('dp', te)); lo.push(tpl.at('dpLo', te)); hi.push(tpl.at('dpHi', te)); pwh.push(tpl.at('pwh', te)); q.push(tpl.at('q', te)); }
    if (x.length) { dp[0] = fc.dpNow; pwh[0] = fc.pwhNow; }
    return { x, dp, lo, hi, pwh, q };
  }
  function chartBox(id, title, sub) { return '<div class="chart-title">' + title + (sub ? ' <span class="muted">' + sub + '</span>' : '') + '</div><div id="' + id + '"></div>'; }
  function confBadge(level) { const c = level === 'высокая' ? 'high' : level === 'средняя' ? 'mid' : 'low'; return '<span class="badge ' + c + '">достоверность: ' + level + '</span>'; }

  /* --------------------------------- ДАШБОРД -------------------------------- */
  async function viewDash(el, R) {
    const A = R.A, fc = A.forecast, st = A.stats, rec = R.rec, bp = A.blow, tr = A.traj;
    const code = A.status.code; const remain = rec.inH;
    const big = !isF(remain) ? '—' : remain <= 0.05 ? 'сейчас' : (remain < 48 ? Math.floor(remain) + '<small>ч</small> ' + String(Math.round((remain % 1) * 60)).padStart(2, '0') + '<small>мин</small>' : (remain / 24).toFixed(1) + '<small>сут</small>');
    const hz = S.dashH || 24;
    el.innerHTML = warnBlock(R) +
      '<div class="hero stagger"><div class="status-card" style="--sc:' + STATUS_COLORS[code] + '"><div class="si">' + ICO.status[code] + '</div><div><span class="muted small">Состояние на ' + fDT(fc.tNow) + ' · приоритет: <b>' + esc(A.priority.text) + '</b></span><h2>' + esc(A.status.text) + '</h2><p>' + esc(A.status.reason) + '</p></div></div>' +
      '<div class="rec-card"><div class="count">' + big + '</div><div><h4>' + esc(rec.title) + '</h4><div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">' + (isF(rec.when) ? '<span class="badge">' + fDT(rec.when) + '</span>' : '') + confBadge(A.conf.level) + '<span class="badge model">расчётный прогноз</span></div></div><p>' + esc(rec.text) + '</p></div></div>' +
      '<div class="kpis stagger">' +
      kpi('Pwh — на голове', F(fc.pwhNow, 2), 'кгс/см²', 'скорость ' + F(rateOf(A, 'pwh'), 2) + ' /ч') +
      kpi('Pline — в шлейфе', F(fc.plineNow, 2), 'кгс/см²', 'скорость ' + F(rateOf(A, 'pline'), 2) + ' /ч') +
      kpi('ΔP = Pwh − Pline', F(fc.dpNow, 2), 'кгс/см²', 'критический ' + F(st.dpCrit, 2)) +
      kpi('Критическое Pwh', bp.ok ? F(bp.pwhCrit, 2) : '—', 'кгс/см²', 'Pline + ΔPкрит') +
      kpi('Давление продувки', bp.ok ? F(bp.pwhBlow, 2) : '—', 'кгс/см²', bp.ok ? 'Pwh крит. + ' + F(bp.dpSafety, 2) : '') +
      kpi('До остановки', fc.mode === 'work' ? fH(fc.remainH) : 'остановлена', '', isF(fc.tCrit) ? fDT(fc.tCrit) : '') + '</div>' +
      blowCard(A) +
      '<div class="card"><h3>Прогноз давлений Pwh и Pline <span class="sub">факт — сплошные линии, прогноз — пунктир с интервалом 10–90%</span><span class="sp"></span>' +
      '<label class="small muted">Горизонт <select id="dH" class="mini">' + [6, 12, 24, 48, 72].map(h => '<option value="' + h + '"' + (h === hz ? ' selected' : '') + '>' + h + ' ч</option>').join('') + '</select></label></h3>' +
      (tr.reason ? '<div class="warnbox">' + ICO.warn + '<div>' + esc(tr.reason) + '</div></div>' : '') +
      chartBox('c1', '', '') + '<div style="height:10px"></div>' + chartBox('c2', 'Перепад ΔP: факт и прогноз', 'кгс/см² · красная линия — критический, жёлтая — рекомендуемый перепад продувки') +
      '<div class="grid g2" style="margin-top:12px"><div>' + ratesTable(A) + '</div><div>' + valueAtBox(A) + '</div></div></div>' +
      scenCard(A) +
      '<div class="grid g2"><div class="card">' + chartBox('c3', 'Расчётный дебит газа', 'тыс. м³/сут · факт и прогноз') + '</div><div class="card"><h3>Последние продувки</h3>' + lastEvents(A) + '</div></div>' +
      '<div class="card"><h3>Признаки накопления жидкости <span class="sub">' + esc(A.loading.level) + '</span></h3>' + loadingList(A) + '</div>';
    bindParamsBtn(el);
    $('#dH').onchange = (e) => { S.dashH = +e.target.value; renderView(); };
    bindValueAt(el, A);
    const s = A.s; const bands = phaseBands(A); const tNow = fc.tNow; const tEnd = tNow + hz * H;
    const cut = (arr) => { const n = tr.t.findIndex(t => t > tEnd); return n < 0 ? arr : arr.slice(0, n); };
    const tx = cut(tr.t);
    const vl = []; if (isF(fc.tCrit) && fc.tCrit <= tEnd) vl.push({ x: fc.tCrit, color: COL.crit, label: 'прогноз остановки', row: 0 });
    if (bp.ok && isF(bp.tRec) && bp.tRec > tNow && bp.tRec <= tEnd) vl.push({ x: bp.tRec, color: COL.warn, label: 'рекомендуемая продувка', row: 1, dash: [2, 2] });
    vl.push({ x: tNow, color: '#8FA6BD', label: 'последний замер', row: 2, dash: [1, 3] });
    const fBands = bands.concat(tr.t.length ? forecastDownBands(tr, tEnd) : []);
    const crit = tx.map((t, i) => tr.phase[i] === 'work' ? tr.pline[i] + st.dpCrit : NaN), blow = bp.ok ? tx.map((t, i) => tr.phase[i] === 'work' ? tr.pline[i] + bp.dpTrigger : NaN) : [];
    const ser1 = [{ name: 'Pwh факт', color: COL.pwh, x: s.t, y: s.pwh, unit: 'кгс/см²', width: 1.8 }, { name: 'Pline факт', color: COL.pline, x: s.t, y: s.pline, unit: 'кгс/см²' }];
    if (tx.length) ser1.push({ name: 'Pwh прогноз', color: COL.pwh, x: tx, y: cut(tr.pwh), yLo: cut(tr.pwhLo), yHi: cut(tr.pwhHi), dash: [5, 4], unit: 'кгс/см²' }, { name: 'Pline прогноз', color: COL.pline, x: tx, y: cut(tr.pline), yLo: cut(tr.plineLo), yHi: cut(tr.plineHi), dash: [5, 4], unit: 'кгс/см²' }, { name: 'Pwh критическое', color: COL.crit, x: tx, y: crit, dash: [2, 3], width: 1.2, unit: 'кгс/см²' });
    if (blow.length) ser1.push({ name: 'Давление продувки', color: '#FFD27A', x: tx, y: blow, dash: [2, 3], width: 1.2, unit: 'кгс/см²' });
    const view = [Math.max(s.t[0], tNow - 36 * H), tEnd];
    new TChart($('#c1'), { group: 'g', height: 300, series: ser1, bands: fBands, markers: eventMarkers(A, 'pwh'), vlines: vl, xMax: tEnd, view, yLabel: 'кгс/см²', y: { zero: true }, title: 'Прогноз давлений' });
    const ser2 = [{ name: 'ΔP факт', color: COL.dp, x: s.t, y: s.dp, unit: 'кгс/см²', fill: 'rgba(192,140,255,.14)' }];
    if (tx.length) ser2.push({ name: 'ΔP прогноз', color: COL.dp, x: tx, y: cut(tr.dp).map((v, i) => tr.phase[i] === 'work' ? v : NaN), yLo: cut(tr.dpLo).map((v, i) => tr.phase[i] === 'work' ? v : NaN), yHi: cut(tr.dpHi).map((v, i) => tr.phase[i] === 'work' ? v : NaN), dash: [5, 4], unit: 'кгс/см²' });
    const hl = isF(st.dpCrit) ? [{ y: st.dpCrit, color: COL.crit, label: 'ΔP крит. ' + F(st.dpCrit, 2) }] : []; if (bp.ok) hl.push({ y: bp.dpTrigger, color: '#FFD27A', label: 'ΔP продувки ' + F(bp.dpTrigger, 2) });
    new TChart($('#c2'), { group: 'g', height: 210, series: ser2, bands: fBands, hlines: hl, vlines: vl.slice(0, 2), xMax: tEnd, view, y: { min: -1 } });
    const qk = Array.from(A.q, v => v / 1000);
    const ser3 = [{ name: 'Дебит факт', color: COL.q, x: s.t, y: qk, unit: 'тыс. м³/сут', fill: 'rgba(70,214,154,.16)' }];
    if (tx.length && A.flowOK) ser3.push({ name: 'Дебит прогноз', color: COL.q, x: tx, y: cut(tr.q).map(v => v / 1000), dash: [5, 4], unit: 'тыс. м³/сут' });
    new TChart($('#c3'), { group: 'g', height: 200, series: ser3, bands: fBands, xMax: tEnd, view, y: { zero: true } });
  }
  function forecastDownBands(tr, tEnd) { const out = []; let a = -1; for (let i = 0; i <= tr.t.length; i++) { const d = i < tr.t.length && tr.t[i] <= tEnd && tr.phase[i] !== 'work'; if (d && a < 0) a = i; if (!d && a >= 0) { out.push({ x0: tr.t[a], x1: tr.t[i - 1], color: 'rgba(242,179,61,0.08)', legend: 'Прогноз: остановка / продувка' }); a = -1; } } return out; }
  function rateOf(A, k) { const s = A.s, n = s.t.length - 1; let j = n; while (j > 0 && s.t[j] > s.t[n] - H) j--; const dt = (s.t[n] - s.t[j]) / H; return dt > 0.2 ? (s[k][n] - s[k][j]) / dt : NaN; }
  function ratesTable(A) {
    const pm = A.plineM, fc = A.forecast, tr = A.traj; const j = tr.t.length ? Math.min(tr.t.length - 1, 4) : -1;
    const fr = (k) => j > 0 ? (tr[k][j] - tr[k][0]) / ((tr.t[j] - tr.t[0]) / H) : NaN;
    return '<table class="tbl"><tr><th>Скорость изменения</th><th class="num">Факт, посл. час</th><th class="num">Прогноз, ближ. час</th></tr>' +
      '<tr><td>Pwh, кгс/см²/ч</td><td class="num">' + F(rateOf(A, 'pwh'), 2) + '</td><td class="num">' + F(fr('pwh'), 2) + '</td></tr>' +
      '<tr><td>Pline, кгс/см²/ч</td><td class="num">' + F(rateOf(A, 'pline'), 3) + '</td><td class="num">' + F(fr('pline'), 3) + '</td></tr>' +
      '<tr><td>ΔP, кгс/см²/ч</td><td class="num">' + F(fc.dpRate, 2) + '</td><td class="num">' + F(fr('dp'), 2) + '</td></tr></table>' +
      (pm && pm.ok ? '<p class="note">Модель Pline: уровень ' + F(pm.level, 2) + ' кгс/см², тренд ' + F(pm.rate * 24, 3) + ' кгс/см²/сут (затухающий), суточная составляющая — ' + (pm.diurnal ? 'учтена' : 'не выявлена') + ', разброс σ = ' + F(pm.sigma, 3) + '. ' + (pm.constant ? 'Давление в шлейфе практически постоянно.' : 'Давление в шлейфе изменяется — учитывается в прогнозе.') + ' Всплеск Pline после перезапуска берётся из медианного цикла.</p>' : '<p class="note">Модель Pline не построена: ' + esc(pm ? pm.reason : '') + '</p>');
  }
  function srcBadge(src) { return src === 'fact' ? '<span class="badge fact">ФАКТ</span>' : src === 'forecast' ? '<span class="badge model">ПРОГНОЗ</span>' : '<span class="badge">НЕТ ДАННЫХ</span>'; }
  function valueAtBox(A) {
    const t0 = S.atTime || (A.forecast.tNow + 6 * H);
    return '<div class="fg"><label>Значения на дату и время</label><div style="display:flex;gap:8px"><input type="datetime-local" id="atT" value="' + toLocalInput(t0) + '" style="flex:1"><button class="mini" id="atGo">Рассчитать</button></div></div><div id="atRes" style="margin-top:8px"></div>';
  }
  function toLocalInput(ms) { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function bindValueAt(el, A) {
    const go = () => { const v = $('#atT', el).value; const t = new Date(v).getTime(); if (!isF(t)) return; S.atTime = t; const r = C.valueAt(A, t); const b = A.blow;
      $('#atRes', el).innerHTML = '<table class="tbl"><tr><th>Параметр</th><th class="num">Значение</th><th>Статус</th></tr>' +
        [['Pwh, кгс/см²', r.pwh, 2], ['Pline, кгс/см²', r.pline, 2], ['ΔP, кгс/см²', r.dp, 2], ['Дебит, тыс. м³/сут', r.q / 1000, 2]].map(([n, v, d]) => '<tr><td>' + n + '</td><td class="num">' + (r.src === 'none' ? '—' : F(v, d)) + (r.src === 'forecast' && n.startsWith('Pwh') && isF(r.pwhLo) ? ' <span class="muted small">(' + F(r.pwhLo, 1) + '…' + F(r.pwhHi, 1) + ')</span>' : '') + '</td><td>' + srcBadge(r.src) + '</td></tr>').join('') +
        '<tr><td>Режим</td><td class="num">' + (r.phase === 'work' ? 'работа' : r.phase ? 'остановка / продувка' : '—') + '</td><td>' + srcBadge(r.src) + '</td></tr>' +
        (b.ok && r.src !== 'none' ? '<tr><td>Pwh критическое / продувки</td><td class="num">' + F(r.pline + b.dpCrit, 2) + ' / ' + F(r.pline + b.dpTrigger, 2) + '</td><td>' + srcBadge(r.src === 'fact' ? 'forecast' : r.src) + '</td></tr>' : '') + '</table>' +
        '<p class="note">' + (r.src === 'forecast' ? 'Достоверность: ' + r.confLevel + '. ' : '') + (r.reason ? esc(r.reason) + '. ' : '') + 'Последний фактический замер: ' + fDT(r.lastFact) + '; прогноз сформирован по данным на ' + fDT(r.forecastMade) + '.</p>'; };
    $('#atGo', el).onclick = go; $('#atT', el).onchange = go; go();
  }
  function blowCard(A) {
    const b = A.blow, fc = A.forecast; if (!b.ok) return '<div class="warnbox">' + ICO.warn + '<div>' + esc(b.reason || 'Давление продувки не рассчитано') + '</div></div>';
    const cell = (l, v, sub, col) => '<div class="bc"><span>' + l + '</span><b' + (col ? ' style="color:' + col + '"' : '') + '>' + v + '</b><em>' + (sub || '') + '</em></div>';
    return '<div class="card"><h3>Устьевое давление продувки <span class="sub">Pwh крит = Pline + ΔPкрит · Pwh продувки = Pwh крит + ΔPзапас</span></h3><div class="bcards">' +
      cell('Текущее Pwh', F(fc.pwhNow, 2) + ' <small>кгс/см²</small>', 'замер ' + fDT(fc.tNow).slice(11)) +
      cell('Критическое Pwh', F(b.pwhCrit, 2) + ' <small>кгс/см²</small>', 'Pline ' + F(b.plNow, 2) + ' + ΔPкрит ' + F(b.dpCrit, 2), COL.crit) +
      cell('Рекомендуемое давление продувки', F(b.pwhBlow, 2) + ' <small>кгс/см²</small>', 'ΔP продувки ' + F(b.dpTrigger, 2), '#FFD27A') +
      cell('Достижение давления продувки', fc.mode === 'work' ? (b.tRec <= fc.tNow ? 'достигнуто' : fH((b.tRec - fc.tNow) / H)) : '—', fDT(b.tRec)) +
      cell('Прогноз остановки', fc.mode === 'work' ? fDT(fc.tCrit).slice(11, 16) : 'остановлена', fc.mode === 'work' ? fDT(fc.tCrit).slice(0, 10) + ', через ' + fH(fc.remainH) : '') +
      cell('Рекомендуемая продувка', fDT(b.tRec).slice(11, 16), fDT(b.tRec).slice(0, 10) + ' · ' + b.best.name.toLowerCase()) + '</div>' +
      '<table class="tbl" style="margin-top:10px"><tr><th>Составляющая запаса ΔPзапас</th><th class="num">кгс/см²</th><th>Обоснование</th></tr>' +
      '<tr><td>Реакция персонала</td><td class="num">' + F(b.parts.react, 2) + '</td><td class="wrap">скорость снижения ΔP перед остановкой ' + F(b.parts.rEnd, 2) + ' кгс/см²/ч × время реакции ' + fH(b.parts.reactH) + '</td></tr>' +
      '<tr><td>Погрешность измерений</td><td class="num">' + F(b.parts.meas, 2) + '</td><td class="wrap">2 датчика, СКО ' + F(b.parts.sMeas, 3) + ' кгс/см², 2σ (сложение квадратично)</td></tr>' +
      '<tr><td>Изменчивость Pline</td><td class="num">' + F(b.parts.pline, 2) + '</td><td class="wrap">1,28σ остатков модели шлейфа (σ = ' + F(b.parts.sigmaPline, 3) + ')</td></tr>' +
      '<tr><td>Минимальный (предупредительный) запас</td><td class="num"><b>' + F(b.dpSafetyMin, 2) + '</b></td><td class="wrap">реакция + √(погрешность² + Pline²)</td></tr>' +
      '<tr><td>Запас по оптимизации добычи</td><td class="num">' + F(b.dpSafetyOpt, 2) + '</td><td class="wrap">' + esc(b.best.why) + '</td></tr>' +
      '<tr><td><b>Итого ΔPзапас</b></td><td class="num"><b>' + F(b.dpSafety, 2) + '</b></td><td class="wrap">предупредительное Pwh = ' + F(b.pwhWarn, 2) + ' кгс/см²</td></tr></table></div>';
  }
  function scenCard(A) {
    const b = A.blow; if (!b.ok) return '';
    const o = A.opt.ok ? A.opt.scen.old : null;
    return '<div class="card"><h3>Сценарии продувки <span class="sub">горизонт ' + A.p.horizonDays + ' сут, одинаковые исходные условия</span></h3><div class="tscroll"><table class="tbl"><tr><th>Сценарий</th><th class="num">Интервал работы</th><th class="num">ΔP продувки</th><th class="num">Pwh продувки</th><th class="num">Продувок</th><th class="num">Простой, ч</th><th class="num">Потери газа, тыс. м³</th><th class="num">Добыча, тыс. м³</th><th class="num">Изменение</th><th></th></tr>' +
      (o ? '<tr><td class="cmp-old">Существующий режим</td><td class="num">до остановки</td><td class="num">—</td><td class="num">—</td><td class="num">' + F(o.nBlow, 0) + '</td><td class="num">' + F(o.down, 0) + '</td><td class="num">' + F(o.losses, 1) + '</td><td class="num">' + F(o.gas, 0) + '</td><td class="num">—</td><td></td></tr>' : '') +
      b.scen.map(x => '<tr' + (x.best ? ' style="background:rgba(39,195,174,.08)"' : '') + '><td>' + x.name + '<div class="small muted">' + esc(x.why) + '</div></td><td class="num">' + fH(x.tau) + '</td><td class="num">' + F(x.dpTrigger, 2) + '</td><td class="num">' + F(x.pwhTrigger, 2) + '</td><td class="num">' + F(x.nBlow, 0) + '</td><td class="num">' + F(x.down, 0) + '</td><td class="num">' + F(x.losses, 1) + '</td><td class="num">' + F(x.gas, 0) + '</td><td class="num ' + (x.extraPct >= 0 ? 'gain' : 'loss') + '">' + (isF(x.extraPct) ? (x.extraPct >= 0 ? '+' : '') + F(x.extraPct, 1) + '%' : '—') + '</td><td>' + (x.best ? '<span class="pill ok">рекомендуется</span>' : '') + '</td></tr>').join('') + '</table></div>' +
      '<p class="note">Выбирается сценарий с максимальной средней добычей; давление продувки не может быть ниже предупредительного (ΔPкрит + минимальный запас).</p></div>';
  }
  function kpi(l, v, u, e) { return '<div class="kpi"><span>' + l + '</span><b>' + v + (u ? '<small>' + u + '</small>' : '') + '</b><em>' + esc(e || '') + '</em></div>'; }
  function loadingList(A) {
    const L = A.loading; let h = '<table class="tbl"><tr><th>Фактор</th><th>Значение</th><th></th></tr>';
    L.factors.forEach(f => { h += '<tr title="' + esc(f.text) + '"><td class="wrap">' + esc(f.name) + '</td><td class="wrap">' + esc(f.val) + '</td><td>' + (f.ok == null ? '' : f.ok ? '<span class="pill ok">да</span>' : '<span class="pill no">нет</span>') + '</td></tr>'; });
    h += '</table>';
    if (isF(L.score)) h += '<p class="note">Интегральная оценка: ' + (L.score * 100).toFixed(0) + ' из 100. ' + (L.alt && L.alt.length ? 'Возможные альтернативные причины снижения ΔP: ' + L.alt.join(', ') + '.' : 'Альтернативные причины (рост Pline, внешние ограничения) не выявлены.') + '</p>';
    return h;
  }
  function lastEvents(A) {
    const cs = A.cycles.slice(-6).reverse(); if (!cs.length) return '<p class="muted">Продувки не выявлены.</p>';
    let h = '<table class="tbl"><tr><th>Продувка</th><th class="num">Скачок</th><th class="num">Работа</th><th class="num">Простой до</th><th class="num">ΔP в конце</th></tr>';
    cs.forEach(c => h += '<tr><td>' + fDT(c.tEvent) + '</td><td class="num">+' + F(c.ev.jump, 1) + '</td><td class="num">' + (c.complete ? fH(c.workH) : '<span class="pill man">идёт</span>') + '</td><td class="num">' + fH(c.downBeforeH) + '</td><td class="num">' + (c.complete ? F(c.dpEnd, 2) : '—') + '</td></tr>');
    return h + '</table>';
  }

  /* ------------------------------- правая панель ---------------------------- */
  function renderRight(R) {
    const el = $('#right');
    if (!R || R.empty) { el.innerHTML = '<div class="rp-h"><h3>Текущие параметры</h3></div><p class="muted small">Выберите скважину с данными, чтобы увидеть текущее состояние.</p>' + (R && R.w ? paramList(R.w.params, null) : ''); return; }
    const A = R.A, fc = A.forecast, st = A.stats;
    const crit = st.dpCrit, dp0 = C.median(A.done.map(c => c.dpStart));
    let lvl = fc.mode === 'work' ? 1 - (fc.dpNow - crit) / Math.max(0.1, dp0 - crit) : 1; lvl = Math.max(0.04, Math.min(1, lvl));
    const flowing = fc.mode === 'work';
    const pmax = Math.max(10, Math.ceil((st.peakMed || 50) * 1.15 / 10) * 10);
    el.innerHTML = '<div class="rp-h"><span class="sd ' + A.status.code + '"></span><h3>' + esc(R.w.name) + '</h3><span class="badge ' + (R.origin === 'online' ? 'model' : 'fact') + '">' + (R.origin === 'online' ? 'ONLINE' : R.origin === 'merged' ? 'ОБЪЕД.' : 'OFFLINE') + '</span><span class="badge fact">' + fDT(fc.tNow).slice(0, 16) + '</span></div>' +
      '<div class="wellviz">' + wellbore(lvl, flowing) + '<div class="gauges">' + gauge('Pwh, кгс/см²', fc.pwhNow, pmax, COL.pwh) + gauge('Pline, кгс/см²', fc.plineNow, pmax, COL.pline) + gauge('ΔP, кгс/см²', fc.dpNow, Math.max(10, st.peakMed - 8), COL.dp) +
      '<div class="small muted">Шкала накопления: 0% — сразу после продувки, 100% — перепад достиг критического значения.</div></div></div>' +
      '<div class="plist">' +
      row('Давление на голове', F(fc.pwhNow, 2) + ' кгс/см²', 'Рабочее давление перед штуцером (последний замер)') +
      row('Давление в шлейфе', F(fc.plineNow, 2) + ' кгс/см²', 'Давление после штуцера, интерполировано на время замера Pwh') +
      row('Перепад давления', F(fc.dpNow, 2) + ' кгс/см²', 'ΔP = Pwh − Pline') +
      row('Расчётный дебит', A.flowOK ? F(fc.qNow / 1000, 2) + ' тыс. м³/сут' : 'нет параметров', 'Оценочный расчёт по течению через штуцер; требует калибровки') +
      row('Диаметр штуцера', A.p.d_mm ? F(A.p.d_mm, 1) + ' мм' : '—', 'Задаётся в параметрах скважины') +
      row('Отн. плотность газа', A.p.gamma ? F(A.p.gamma, 3) : '—', 'По воздуху') +
      row('Критическое Pwh', A.blow.ok ? F(A.blow.pwhCrit, 2) + ' кгс/см²' : '—', 'Pwh крит = Pline + ΔPкрит') +
      row('Давление продувки', A.blow.ok ? F(A.blow.pwhBlow, 2) + ' кгс/см²' : '—', 'Pwh продувки = Pwh крит + ΔPзапас (' + (A.blow.ok ? F(A.blow.dpSafety, 2) : '—') + ')') +
      row('Прогноз остановки', fc.mode === 'work' ? fDT(fc.tCrit).slice(0, 16) : 'остановлена', 'Единый прогноз ядра') +
      row('Критический ΔP', F(st.dpCrit, 2) + ' кгс/см²', (A.p.dpCritManual != null ? 'Задан вручную' : 'Медиана перепада на момент остановок (история скважины)')) +
      row('До критического состояния', fc.mode === 'work' ? fH(fc.remainH) : 'скважина остановлена', 'Комбинированный прогноз: аппроксимация цикла, аналог, статистика истории') +
      row('Достоверность', A.conf.level, A.conf.notes.join(' ') || 'Достаточно циклов, разброс умеренный') + '</div>' +
      '<div class="rp-rec"><span>Рекомендуемое время продувки</span><b>' + (isF(R.rec.when) ? fDT(R.rec.when).slice(0, 16) : '—') + '</b><span>' + esc(R.rec.title) + '</span></div>' +
      '<p class="note">Рекомендации — инженерная поддержка решений. Управление скважиной выполняется только после утверждения технологическим персоналом.</p>';
    requestAnimationFrame(() => $$('.needle', el).forEach(n => n.style.transform = 'rotate(' + n.dataset.a + 'deg)'));
  }
  function row(l, v, t) { return '<div><span class="hint" title="' + esc(t) + '">' + l + '</span></div><div>' + v + '</div>'; }
  function paramList(p) { return '<div class="plist">' + row('Диаметр штуцера', p && p.d_mm ? p.d_mm + ' мм' : 'не задан', '') + row('Отн. плотность газа', p && p.gamma ? p.gamma : 'не задана', '') + '</div>'; }
  function gauge(label, v, max, color) {
    const f = isF(v) ? Math.max(0, Math.min(1, v / max)) : 0; const a = -90 + 180 * f;
    return '<div class="gauge"><svg viewBox="0 0 62 44"><path d="M7 38 A24 24 0 0 1 55 38" fill="none" stroke="#2D4660" stroke-width="6" stroke-linecap="round"/><path d="M7 38 A24 24 0 0 1 55 38" fill="none" stroke="' + color + '" stroke-width="6" stroke-linecap="round" stroke-dasharray="' + (75.4 * f).toFixed(1) + ' 80" style="transition:stroke-dasharray .9s"/><g class="needle" data-a="' + a.toFixed(1) + '" style="transform:rotate(-90deg)"><path d="M31 38 L31 18" stroke="#DDE8F3" stroke-width="2" stroke-linecap="round"/></g><circle cx="31" cy="38" r="3" fill="#DDE8F3"/></svg><div><span>' + label + '</span><b>' + F(v, 2) + '</b></div></div>';
  }
  function wellbore(lvl, flowing) {
    const top = 40, bot = 240, hg = bot - top, ly = bot - hg * lvl;
    let ticks = ''; for (let k = 0; k <= 10; k++) { const y = bot - hg * k / 10; ticks += '<path d="M14 ' + y.toFixed(1) + 'H' + (k % 5 ? 19 : 22) + '" stroke="#4A6380"/>'; }
    const flow = flowing ? '<path class="ai-flow" d="M48 ' + (bot - 4) + 'V30" stroke="#46D69A" stroke-width="2" stroke-dasharray="4 4" opacity=".9"/><path class="ai-flow" d="M60 15H90" stroke="#46D69A" stroke-width="2" stroke-dasharray="4 4"/>' : '';
    return '<svg viewBox="0 0 96 250" aria-label="Схема ствола скважины" fill="none">' +
      '<g stroke-linecap="round">' + ticks + '</g><text x="12" y="' + (bot + 9) + '" font-size="8" fill="#617A93">0</text><text x="8" y="' + (top - 3) + '" font-size="8" fill="#617A93">100</text>' +
      '<rect x="31" y="' + ly.toFixed(1) + '" width="34" height="' + (bot - ly).toFixed(1) + '" fill="#2B78AE" fill-opacity=".45" class="liq"/>' +
      '<path d="M31 ' + ly.toFixed(1) + 'H65" stroke="#4FB3E8" stroke-width="1.6"/><path d="M66 ' + ly.toFixed(1) + 'H74" stroke="#4FB3E8" stroke-width="1"/>' +
      '<text x="75" y="' + (ly + 3).toFixed(1) + '" font-size="9" fill="#9FD2F2" font-family="Bahnschrift, Segoe UI">' + Math.round(lvl * 100) + '%</text>' +
      '<path d="M30 30V' + bot + 'M66 30V' + bot + '" stroke="#5A7896" stroke-width="2"/><path d="M28 ' + bot + 'H68" stroke="#5A7896" stroke-width="2"/>' +
      '<path d="M43 26V' + (bot - 8) + 'M53 26V' + (bot - 8) + '" stroke="#8FA6BD" stroke-width="1.2"/>' + flow +
      '<g stroke="#F2B33D" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M48 4v26"/><path d="M43 4h10"/><path d="M34 15h26"/><circle cx="34" cy="15" r="3" fill="#172738"/><circle cx="62" cy="15" r="3" fill="#172738"/><path d="M38 30h20"/></g></svg>';
  }

  /* ---------------------------------- ДАННЫЕ -------------------------------- */
  async function viewData(el, R) {
    const A = R.A, ser = R.ser, qa = A.qa, dv = S.dataView;
    const raw = applyEdits(ser); const key = dv.key; const series = raw[key]; const exc = (ser.excl || {})[key] || {}; const edits = (ser.edits || {})[key] || {};
    const flagMap = {}; (qa[key] || []).forEach(f => flagMap[f.t] = f.flag);
    const FL = { neg: 'отрицательное', range: 'вне диапазона', spike: 'одиночный выброс', manual: 'исключено вручную' };
    let rows = series.t.map((t, i) => ({ i, t, v: series.v[i], f: flagMap[t] || '', ex: !!exc[t], ed: edits[t] != null }));
    if (dv.filter === 'flag') rows = rows.filter(r => r.f || r.ex); if (dv.filter === 'edit') rows = rows.filter(r => r.ed);
    const per = 200, pages = Math.max(1, Math.ceil(rows.length / per)); dv.page = Math.min(dv.page, pages - 1);
    const pr = rows.slice(dv.page * per, dv.page * per + per);
    el.innerHTML = '<div class="card"><h3>Контроль качества данных</h3><div class="grid g4">' +
      kpiS('Замеров Pwh', ser.pwh.t.length) + kpiS('Замеров Pline', ser.pline.t.length) + kpiS('Шаг измерений', F(qa.stepMin, 0) + ' мин') + kpiS('Период', fDT(A.s.t[0]).slice(0, 10) + ' – ' + fDT(A.s.t[A.s.t.length - 1]).slice(0, 10)) + '</div>' +
      (qa.notes.length ? '<div class="log">' + qa.notes.map(n => '<div>' + esc(n) + '</div>').join('') + '</div>' : '<p class="note">Аномальных значений и пропусков не выявлено.</p>') +
      '<p class="note">История импорта: ' + (ser.imports || []).map(x => esc(x.file) + ' (' + new Date(x.date).toLocaleString('ru-RU') + ', +' + x.added + ')').join('; ') + '</p></div>' +
      '<div class="card">' + chartBox('cr', 'Исходные ряды и помеченные точки', 'красным — исключённые/подозрительные') + '</div>' +
      '<div class="card"><h3>Измерения <span class="sp"></span>' +
      '<select id="dkey" class="mini"><option value="pwh"' + (key === 'pwh' ? ' selected' : '') + '>Давление на голове</option><option value="pline"' + (key === 'pline' ? ' selected' : '') + '>Давление в шлейфе</option></select>' +
      '<select id="dfil" class="mini"><option value="all">Все</option><option value="flag"' + (dv.filter === 'flag' ? ' selected' : '') + '>Подозрительные и исключённые</option><option value="edit"' + (dv.filter === 'edit' ? ' selected' : '') + '>Отредактированные</option></select>' +
      '<button class="mini" id="dclear">Очистить историю скважины</button></h3>' +
      '<p class="muted small">Двойной щелчок по значению — редактирование. Исключённые точки не участвуют в расчётах, но сохраняются в базе.</p>' +
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>№</th><th>Дата и время</th><th class="num">Значение, кгс/см²</th><th>Проверка</th><th></th></tr></thead><tbody>' +
      pr.map(r => '<tr class="' + (r.ex ? 'excl' : r.f ? 'flag' : '') + '"><td>' + (r.i + 1) + '</td><td>' + fDT(r.t) + '</td><td class="num" data-ed="' + r.t + '">' + F(r.v, 2) + (r.ed ? ' ✎' : '') + '</td><td>' + (r.ex ? 'исключено вручную' : FL[r.f] || '') + '</td><td><button class="mini" data-ex="' + r.t + '">' + (r.ex ? 'Вернуть' : 'Исключить') + '</button></td></tr>').join('') +
      '</tbody></table></div><div style="display:flex;gap:8px;align-items:center;margin-top:8px"><button class="mini" id="pp">‹</button><span class="small muted">стр. ' + (dv.page + 1) + ' из ' + pages + ' (' + rows.length + ' строк)</span><button class="mini" id="pn">›</button></div></div>';
    const fx = [], fy = []; (qa[key] || []).forEach(f => { fx.push(f.t); fy.push(f.v); });
    new TChart($('#cr'), { group: 'g', height: 230, series: [{ name: 'Pwh', color: COL.pwh, x: ser.pwh.t, y: raw.pwh.v, points: false }, { name: 'Pline', color: COL.pline, x: ser.pline.t, y: raw.pline.v }, { name: 'Исключено / выброс', color: COL.crit, x: fx, y: fy, type: 'scatter', r: 4 }], y: { zero: true } });
    $('#dkey').onchange = (e) => { dv.key = e.target.value; dv.page = 0; renderView(); };
    $('#dfil').onchange = (e) => { dv.filter = e.target.value; dv.page = 0; renderView(); };
    $('#pp').onclick = () => { dv.page = Math.max(0, dv.page - 1); renderView(); }; $('#pn').onclick = () => { dv.page++; renderView(); };
    $$('[data-ex]', el).forEach(b => b.onclick = async () => { const t = +b.dataset.ex; ser.excl = ser.excl || {}; ser.excl[key] = ser.excl[key] || {}; if (ser.excl[key][t]) delete ser.excl[key][t]; else ser.excl[key][t] = 1; await GDB.put('series', ser); invalidate(R.w.id); renderView(); });
    $$('[data-ed]', el).forEach(td => td.ondblclick = async () => {
      const t = +td.dataset.ed; let val = null;
      await modal('Редактирование замера', '<p class="muted">' + fDT(t) + '</p><div class="fg"><label>Значение, кгс/см²</label><input id="ev" value="' + td.textContent.replace(' ✎', '').replace(/\s/g, '').replace(',', '.') + '"></div><p class="note">Исходное значение сохраняется; правку можно отменить, введя пустое значение.</p>', [{ t: 'Отмена', v: 0 }, { t: 'Сохранить', v: 1, primary: true, check: (ov) => { val = $('#ev', ov).value.trim(); return true; } }], 'sm');
      if (val === null) return; ser.edits = ser.edits || {}; ser.edits[key] = ser.edits[key] || {};
      if (val === '') delete ser.edits[key][t]; else { const n = parseFloat(val.replace(',', '.')); if (!isF(n)) return toast('Некорректное число', true); ser.edits[key][t] = n; }
      await GDB.put('series', ser); invalidate(R.w.id); renderView(); toast('Замер обновлён, анализ пересчитан');
    });
    $('#dclear').onclick = async () => { if (!await confirmBox('Удалить всю историю измерений скважины «' + esc(R.w.name) + '»? Параметры скважины и журнал рекомендаций сохранятся.', 'Очистить')) return; await GDB.del('series', R.w.id); invalidate(R.w.id); R.w.statusCode = 'none'; R.w.statusText = 'нет данных'; await GDB.put('wells', R.w); renderTree(); renderView(); };
  }
  function kpiS(l, v) { return '<div><span class="muted small">' + l + '</span><div style="font-size:18px;font-weight:600">' + v + '</div></div>'; }

  /* ----------------------------- ПРОДУВКИ И ЦИКЛЫ --------------------------- */
  async function viewCycles(el, R) {
    const A = R.A, st = A.stats;
    el.innerHTML = warnBlock(R) + '<div class="card"><h3>Выявленные продувки (резкие скачки Pwh) <span class="sub">критерии: скачок ≥ ' + A.p.jumpMin + ' кгс/см², скорость ≥ ' + A.p.rateMin + ' кгс/см²/ч, устойчивость ≥ ' + fH(A.p.minWorkH) + '</span></h3>' +
      '<div class="tblwrap" style="max-height:330px"><table class="tbl"><thead><tr><th>Дата и время</th><th class="num">Давление до</th><th class="num">Пик</th><th class="num">Скачок</th><th class="num">Скорость, кгс/см²/ч</th><th>Автоматически</th><th>Решение инженера</th><th>Примечание</th></tr></thead><tbody>' +
      A.det.events.map(e => '<tr><td>' + fDT(e.tEvent) + '</td><td class="num">' + F(e.pre, 2) + '</td><td class="num">' + F(e.peak, 1) + '</td><td class="num">+' + F(e.jump, 1) + '</td><td class="num">' + F(e.rate, 0) + '</td><td>' + (e.auto ? '<span class="pill ok">продувка</span>' : '<span class="pill no">отклонено</span>') + '</td><td><button class="mini' + (e.manual === 'confirm' ? ' on' : '') + '" data-ov="confirm" data-t="' + Math.round(e.tEvent) + '">Подтвердить</button> <button class="mini' + (e.manual === 'reject' ? ' rej' : '') + '" data-ov="reject" data-t="' + Math.round(e.tEvent) + '">Отклонить</button></td><td class="small muted">' + esc(e.reasons.join('; ')) + '</td></tr>').join('') +
      '</tbody></table></div><p class="note">Скачок считается продувкой, если после него скважина устойчиво работает (Pwh > Pline). Одиночные выбросы датчиков исключаются на этапе контроля качества. Решения инженера сохраняются и учитываются в расчётах.</p></div>' +
      '<div class="card"><h3>Рабочие циклы <span class="sub">' + st.nCycles + ' циклов, завершённых ' + st.nDone + '</span></h3><div class="tblwrap" style="max-height:360px"><table class="tbl"><thead><tr><th>№</th><th>Начало работы</th><th>Потеря работоспособности</th><th class="num">Работа</th><th class="num">Простой перед циклом</th><th class="num">Пик Pwh</th><th class="num">ΔP нач.</th><th class="num">ΔP конец</th><th class="num">Скорость ΔP, /ч</th><th class="num">τ, ч</th><th class="num">R²</th><th class="num">Добыча, тыс. м³</th><th class="num">q ср., тыс. м³/сут</th></tr></thead><tbody>' +
      A.cycles.map(c => '<tr><td>' + c.k + '</td><td>' + fDT(c.tStart) + '</td><td>' + (c.complete ? fDT(c.tEnd) : '<span class="pill man">цикл продолжается</span>') + '</td><td class="num">' + fH(c.workH) + '</td><td class="num">' + fH(c.downBeforeH) + '</td><td class="num">' + F(c.peak, 1) + '</td><td class="num">' + F(c.dpStart, 1) + '</td><td class="num">' + F(c.dpEnd, 2) + '</td><td class="num">' + F(c.declineRate, 2) + '</td><td class="num">' + (c.fit ? F(c.fit.tau, 2) : '—') + '</td><td class="num">' + (c.fit ? F(c.fit.r2, 3) : '—') + '</td><td class="num">' + F(c.gas, 2) + '</td><td class="num">' + F(c.qMean / 1000, 2) + '</td></tr>').join('') +
      '</tbody></table></div></div>' +
      '<div class="grid g2"><div class="card">' + chartBox('k1', 'Длительность работы и простоя по циклам', 'ч') + '</div><div class="card">' + chartBox('k2', 'Наложение циклов: ΔP от начала работы', 'кгс/см² · медиана и 20–80%') + '</div></div>' +
      '<div class="grid g2"><div class="card">' + chartBox('k3', 'Пик давления после перезапуска от длительности простоя', 'r = ' + F(st.peakReg ? st.peakReg.r : NaN, 2)) + '<p class="note">Используется в оптимизации как поправка: при более коротком простое давление восстанавливается частично.</p></div><div class="card"><h3>Статистика истории</h3><table class="tbl">' +
      tr2('Медиана рабочего цикла', fH(st.workMed) + ' (' + fH(st.workMin) + ' – ' + fH(st.workMax) + ')') + tr2('Коэффициент вариации цикла', F(st.workCV * 100, 0) + '%') + tr2('Медиана простоя (вынужденная продувка)', fH(st.downMed)) + tr2('Минимальный простой', fH(st.downMin)) +
      tr2('Критический ΔP (медиана при остановке)', F(st.dpCritHist, 2) + ' кгс/см² (' + F(st.dpCritMin, 2) + '–' + F(st.dpCritMax, 2) + ')') + tr2('Медианный скачок при продувке', '+' + F(st.jumpMed, 1) + ' кгс/см²') + tr2('Медианная постоянная затухания ΔP, τ', fH(st.tauMed)) +
      tr2('Корреляция «простой → длительность следующего цикла»', F(st.corrDownNextWork, 2)) + tr2('Продувок в сутки (факт)', F(st.nCycles / (st.factSpanH / 24), 2)) + '</table></div></div>' +
      '<div class="card"><h3>Признаки накопления жидкости <span class="sub">' + esc(A.loading.level) + '</span></h3>' + loadingList(A) + '</div>';
    bindParamsBtn(el);
    $$('[data-ov]', el).forEach(b => b.onclick = async () => { const t = b.dataset.t, v = b.dataset.ov; R.ser.overrides = R.ser.overrides || {}; if (R.ser.overrides[t] === v) delete R.ser.overrides[t]; else R.ser.overrides[t] = v; await GDB.put('series', R.ser); invalidate(R.w.id); await renderView(); toast(v === 'confirm' ? 'Событие подтверждено инженером' : 'Событие отклонено'); });
    const ks = A.cycles.map(c => c.k);
    new TChart($('#k1'), { xType: 'num', height: 230, series: [{ name: 'Работа', color: COL.q, x: ks.map(k => k - 0.18), y: A.cycles.map(c => c.complete ? c.workH : NaN), type: 'bar', barW: 0.3, unit: 'ч' }, { name: 'Простой перед циклом', color: COL.stop, x: ks.map(k => k + 0.18), y: A.cycles.map(c => c.downBeforeH), type: 'bar', barW: 0.3, unit: 'ч' }], hlines: [{ y: st.workMed, color: COL.q, label: 'медиана ' + fH(st.workMed) }], y: { zero: true }, xFmt: (v) => Number.isInteger(v) ? '№' + v : '', xTip: (v) => 'Цикл №' + Math.round(v), xMin: 0.4, xMax: ks.length + 0.6 });
    const ov = []; const pal = ['#5F84A8', '#6E93B6', '#7EA3C4', '#8DB2D1', '#9DC1DE'];
    A.done.forEach((c, i) => { const x = [], y = []; for (let j = c.iStart; j <= c.iEnd; j++) { x.push((A.s.t[j] - c.tStart) / H); y.push(A.s.dp[j]); } ov.push({ name: 'Цикл ' + c.k, color: pal[i % pal.length], x, y, width: 1, legend: false, tooltip: false }); });
    ov.push({ name: 'Медиана циклов', color: COL.dp, x: A.tpl.t, y: A.tpl.dp, yLo: A.tpl.dpLo, yHi: A.tpl.dpHi, width: 2.6, unit: 'кгс/см²' });
    new TChart($('#k2'), { xType: 'num', height: 230, series: ov, hlines: [{ y: st.dpCrit, color: COL.crit, label: 'ΔP крит.' }], xFmt: (v) => v + ' ч', xTip: (v) => F(v, 1) + ' ч от начала', y: { zero: true } });
    const pr = st.peakReg; const xs = A.cycles.map(c => c.downBeforeH), ys = A.cycles.map(c => c.peak); const ok = xs.map((x, i) => [x, ys[i]]).filter(p => isF(p[0])).sort((a, b) => a[0] - b[0]);
    const ser = [{ name: 'Циклы', color: COL.pwh, x: ok.map(p => p[0]), y: ok.map(p => p[1]), type: 'scatter', r: 4.5, unit: 'кгс/см²' }];
    if (pr && ok.length) ser.push({ name: 'Линейная регрессия', color: '#DDE8F3', x: [ok[0][0], ok[ok.length - 1][0]], y: [pr.a + pr.b * ok[0][0], pr.a + pr.b * ok[ok.length - 1][0]], dash: [4, 4], width: 1.2, tooltip: false });
    new TChart($('#k3'), { xType: 'num', height: 210, series: ser, xFmt: (v) => F(v, 0) + ' ч', xTip: (v) => 'простой ' + F(v, 1) + ' ч' });
  }
  function tr2(a, b) { return '<tr><td class="muted">' + a + '</td><td class="num">' + b + '</td></tr>'; }

  /* --------------------------------- ПРОГНОЗ -------------------------------- */
  async function viewForecast(el, R) {
    const A = R.A, fc = A.forecast, st = A.stats, life = A.life;
    let head;
    if (fc.mode !== 'work') head = '<div class="warnbox">' + ICO.info + '<div>Скважина не работает с ' + fH(fc.downSinceH) + '. Прогноз для нового цикла будет построен после перезапуска; ниже — статистическая модель по истории.</div></div>';
    else head = '<div class="grid g4 stagger"><div class="scen"><h4>Прогноз критического ΔP</h4><div class="big">' + fDT(fc.tCrit).slice(0, 16) + '</div><span class="muted small">через ' + fH(fc.remainH) + '</span></div><div class="scen"><h4>Интервал прогноза (10–90%)</h4><div class="big" style="font-size:18px">' + fDT(fc.tCritLo).slice(11, 16) + ' – ' + fDT(fc.tCritHi).slice(11, 16) + '</div><span class="muted small">' + fDT(fc.tCritLo).slice(0, 10) + '</span></div><div class="scen"><h4>Средняя скорость снижения ΔP</h4><div class="big">' + F(fc.avgDpRate, 2) + '</div><span class="muted small">кгс/см²/ч за цикл; за последний час ' + F(fc.dpRate, 2) + '</span></div><div class="scen"><h4>Вероятность остановки</h4><div class="big">' + (fc.pStop ? F(fc.pStop(2) * 100, 0) + '%' : '—') + '</div><span class="muted small">в ближайшие 2 ч</span></div></div>';
    el.innerHTML = warnBlock(R) + head +
      '<div class="card" style="margin-top:14px"><h3>Текущий цикл: перепад давления и прогноз <span class="sp"></span>' + confBadge(A.conf.level) + '</h3>' + chartBox('f1', '', '') + '</div>' +
      '<div class="grid g2"><div class="card"><h3>Методы прогноза</h3><table class="tbl"><tr><th>Метод</th><th class="num">Время до критического, ч от начала цикла</th><th>Вес</th></tr>' +
      (fc.methods ? tr3('Аппроксимация текущего цикла ΔP = c + A·e^(−t/τ)', fc.methods.fit, '40%') + tr3('Аналог по медианной кривой циклов', fc.methods.analog, '30%') + tr3('Логнормальная модель длительности (условная медиана)', fc.methods.history, '30%') : '<tr><td colspan=3 class="muted">Нет активного цикла</td></tr>') +
      '</table><p class="note">Методы с недостаточным качеством (R² &lt; 0,85, менее 5 точек) исключаются; веса нормируются. Итог: ' + (fc.methods ? fH(fc.tCritAge) + ' от начала цикла.' : '—') + '</p>' +
      (fc.pStop ? '<table class="tbl"><tr><th>Горизонт</th>' + [0.5, 1, 2, 3, 4, 6].map(h => '<th class="num">' + fH(h) + '</th>').join('') + '</tr><tr><td>Вероятность остановки</td>' + [0.5, 1, 2, 3, 4, 6].map(h => '<td class="num">' + F(fc.pStop(h) * 100, 0) + '%</td>').join('') + '</tr></table>' : '') + '</div>' +
      '<div class="card">' + chartBox('f2', 'Функция надёжности: вероятность работы без остановки', 'логнормальная модель и эмпирика') + '<p class="note">' + (life.ok ? 'Медиана ' + fH(life.median) + ', σ(ln t) = ' + F(life.sigma, 2) + ', критерий Колмогорова D = ' + F(life.ks, 2) + ' по ' + life.n + ' циклам.' : 'Недостаточно циклов для модели.') + '</p></div></div>' +
      '<div class="card"><h3>Достоверность прогноза: ' + A.conf.level + '</h3>' + (A.conf.notes.length ? '<ul class="small">' + A.conf.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '<p class="muted small">Достаточно завершённых циклов, разброс длительностей умеренный.</p>') + '<p class="note">Критический перепад определён индивидуально для скважины как медиана ΔP на момент потери работоспособности (' + F(st.dpCritHist, 2) + ' кгс/см²); при наличии подтверждённых технологических данных его можно задать вручную в параметрах.</p></div>';
    // график текущего цикла
    const s = A.s; const ser = []; const vl = [];
    if (fc.mode === 'work') {
      const c = fc.cycle; const x0 = c.tStart - 1.5 * H; const i0 = s.t.findIndex(t => t >= x0);
      const xs = Array.from(s.t.slice(i0)), ys = Array.from(s.dp.slice(i0));
      ser.push({ name: 'ΔP факт', color: COL.dp, x: xs, y: ys, width: 2.2, points: true, unit: 'кгс/см²' });
      const tx = [], ty = [], tlo = [], thi = []; A.tpl.t.forEach((t, i) => { tx.push(c.tStart + t * H); ty.push(A.tpl.dp[i]); tlo.push(A.tpl.dpLo[i]); thi.push(A.tpl.dpHi[i]); });
      ser.push({ name: 'Медиана циклов (20–80%)', color: '#7E92A8', x: tx, y: ty, yLo: tlo, yHi: thi, dash: [3, 3], width: 1.4, unit: 'кгс/см²', bandColor: '#7E92A8' });
      if (fc.fit && fc.fit.r2 > 0.5) { const fx = [], fy = []; const tEnd = Math.max(fc.tCritHiAge, fc.age + 1); for (let t = fc.fitOffset; t <= tEnd; t += 0.1) { fx.push(c.tStart + t * H); fy.push(fc.fit.f(t - fc.fitOffset)); } ser.push({ name: 'Аппроксимация цикла (R² ' + F(fc.fit.r2, 3) + ')', color: COL.pwh, x: fx, y: fy, dash: [6, 3], unit: 'кгс/см²' }); }
      vl.push({ x: fc.tNow, color: '#DDE8F3', label: 'последний замер', row: 0 });
      if (isF(fc.tCrit)) vl.push({ x: fc.tCrit, color: COL.crit, label: 'прогноз ΔP крит.', row: 1 });
      if (isF(R.rec.when)) vl.push({ x: R.rec.when, color: COL.warn, label: 'рекомендуемая продувка', row: 2, dash: [2, 2] });
      new TChart($('#f1'), { height: 300, series: ser, hlines: [{ y: st.dpCrit, color: COL.crit, label: 'ΔP крит. ' + F(st.dpCrit, 2) }], vlines: vl, bands: isF(fc.tCritLo) ? [{ x0: fc.tCritLo, x1: fc.tCritHi, color: 'rgba(255,90,110,.08)', legend: 'Интервал прогноза 10–90%' }] : [], y: { zero: true }, xMax: Math.max(fc.tCritHi || 0, c.tStart + (A.tpl.t[A.tpl.t.length - 1] || 0) * H) + H });
    } else $('#f1').innerHTML = '<p class="muted">Нет активного рабочего цикла.</p>';
    if (life.ok) { const x = [], y = []; for (let t = 0; t <= life.Q(0.995) * 1.1; t += 0.1) { x.push(t); y.push(life.S(t) * 100); } new TChart($('#f2'), { xType: 'num', height: 220, series: [{ name: 'Логнормальная модель', color: COL.neu, x, y, unit: '%', width: 2 }, { name: 'Эмпирическая (циклы)', color: COL.old, x: life.km.map(k => k.t), y: life.km.map(k => k.S * 100), type: 'step', unit: '%', points: true }], vlines: fc.mode === 'work' ? [{ x: fc.age, color: '#DDE8F3', label: 'возраст цикла' }] : [], xFmt: (v) => v + ' ч', xTip: (v) => F(v, 1) + ' ч работы', y: { min: 0, max: 100 } }); }
  }
  function tr3(a, v, w) { return '<tr><td>' + a + '</td><td class="num">' + (isF(v) ? F(v, 2) : '<span class="muted">не применим</span>') + '</td><td>' + (isF(v) ? w : '—') + '</td></tr>'; }

  /* ------------------------------- ОПТИМИЗАЦИЯ ------------------------------ */
  async function viewOpt(el, R) {
    const A = R.A, o = A.opt, p = A.p;
    if (!o.ok) { el.innerHTML = warnBlock(R) + '<div class="warnbox err">' + ICO.warn + '<div>' + esc(o.reasons.join(' ')) + '</div></div>'; bindParamsBtn(el); return; }
    const sc = o.scen; const best = o.noGain ? 'old' : 'opt';
    const card = (k, title, sub) => { const x = sc[k]; return '<div class="scen' + (k === best ? ' best' : '') + '"><h4>' + title + '</h4><span class="muted small">' + sub + '</span><div class="big">' + F(x.rate, 2) + ' <small class="muted" style="font-size:13px">тыс. м³/сут</small></div>' + (k !== 'old' ? '<span class="' + (x.extraPct >= 0 ? 'gain' : 'loss') + '">' + (x.extraPct >= 0 ? '+' : '') + F(x.extraPct, 1) + '% к существующему</span>' : '<span class="muted">базовый вариант</span>') +
      '<dl><dt>Интервал работы до продувки</dt><dd>' + (isF(x.tau) ? fH(x.tau) : 'до остановки') + '</dd><dt>Средний цикл (работа + простой)</dt><dd>' + fH(x.cycleH) + '</dd><dt>Продувок в месяц / год</dt><dd>' + F(x.nBlowMonth, 0) + ' / ' + F(x.nBlowYear, 0) + '</dd><dt>Коэффициент эксплуатации</dt><dd>' + F(x.kexp * 100, 1) + '%</dd><dt>Вероятность преждевременной остановки</dt><dd>' + F(x.pPremature * 100, 0) + '%</dd><dt>Добыча за ' + p.horizonDays + ' сут</dt><dd>' + F(x.gas, 0) + ' тыс. м³</dd></dl></div>'; };
    el.innerHTML = warnBlock(R) + (o.noGain ? '<div class="warnbox">' + ICO.info + '<div>' + esc(o.reasons.join(' ')) + '</div></div>' : '') +
      '<div class="grid g3 stagger">' + card('old', '1. Существующий режим', 'продувка после фактической остановки') + card('pred', '2. Прогнозируемый режим', 'продувка до критического ΔP с надёжностью ' + F(p.reliability * 100, 0) + '%') + card('opt', '3. Оптимизированный режим', 'интервал, максимизирующий среднюю добычу') + '</div>' +
      '<div class="grid g2" style="margin-top:14px"><div class="card">' + chartBox('o1', 'Средняя добыча в зависимости от интервала продувок', 'тыс. м³/сут') + '<p class="note">Модель восстановления (renewal–reward): R(τ) = [∫₀^τ S(t)·q̄(t)dt − потери] / [∫₀^τ S(t)dt + (1−S(τ))·Dвын + S(τ)·Dплан]. S(t) — вероятность работы без остановки, q̄(t) — медианный дебит «живых» циклов.</p></div>' +
      '<div class="card">' + chartBox('o2', 'Чувствительность: выигрыш от длительности плановой продувки', '% к существующему режиму') + '<p class="note">Главное допущение модели — простой при упреждающей продувке. Проверьте его опытными продувками и уточните в параметрах.</p></div></div>' +
      '<div class="card"><h3>Сравнение интервалов</h3><div class="tscroll"><table class="tbl"><tr><th>Интервал работы τ</th><th class="num">Цикл, ч</th><th class="num">Простой на цикл, ч</th><th class="num">Вероятность остановки до τ</th><th class="num">Добыча за цикл, тыс. м³</th><th class="num">Средняя добыча, тыс. м³/сут</th><th class="num">Изменение</th></tr>' +
      o.grid.map(g => '<tr' + (Math.abs(g.tau - o.opt.tau) < 0.3 ? ' style="background:rgba(39,195,174,.08)"' : '') + '><td>' + (isF(g.tau) ? fH(g.tau) : 'до остановки (текущий)') + '</td><td class="num">' + F(g.cyc, 2) + '</td><td class="num">' + F(g.down, 2) + '</td><td class="num">' + F((1 - g.Sf) * 100, 0) + '%</td><td class="num">' + F(g.G, 2) + '</td><td class="num">' + F(g.rate, 2) + '</td><td class="num ' + (g.gainPct >= 0 ? 'gain' : 'loss') + '">' + (g.gainPct >= 0 ? '+' : '') + F(g.gainPct, 1) + '%</td></tr>').join('') + '</table></div></div>' +
      '<div class="card"><h3>Допущения расчёта</h3><table class="tbl">' +
      tr2('Простой при вынужденной продувке Dвын', fH(o.Du) + ' — ' + o.DuSrc) + tr2('Простой при упреждающей продувке Dплан', fH(o.Dp) + ' — ' + o.DpSrc) +
      tr2('Потери газа на продувку (вынужд. / упрежд.)', F(o.Lu, 2) + ' / ' + F(o.Lp, 2) + ' тыс. м³' + (o.Lu === 0 && o.Lp === 0 ? ' — не заданы, потери не учтены' : '')) +
      tr2('Поправка на неполное восстановление давления', F((1 - o.fD) * 100, 1) + '% снижения добычи цикла после короткого простоя') +
      tr2('Профиль дебита после продувки', 'медиана ' + A.done.length + ' фактических циклов') + tr2('Горизонт сравнения', p.horizonDays + ' сут, одинаковые исходные условия') + '</table>' +
      '<p class="note">Результат — расчётная оценка. Перед внедрением рекомендуется опытная проверка: 5–10 циклов в предлагаемом режиме с фиксацией фактических простоев и замеров дебита, затем калибровка модели.</p></div>';
    bindParamsBtn(el);
    const c = o.curve.filter((x, i) => i % 2 === 0);
    new TChart($('#o1'), { xType: 'num', height: 250, series: [{ name: 'Средняя добыча R(τ)', color: COL.neu, x: c.map(x => x.tau), y: c.map(x => x.rate), width: 2.4, unit: 'тыс. м³/сут', fill: 'rgba(39,195,174,.12)' }], hlines: [{ y: o.old.rate, color: COL.old, label: 'существующий режим ' + F(o.old.rate, 2), dash: [6, 4] }], vlines: [{ x: o.opt.tau, color: COL.neu, label: 'τ* = ' + fH(o.opt.tau) }, { x: o.pred.tau, color: COL.info, label: 'прогнозный ' + fH(o.pred.tau), row: 1 }], bands: [{ x0: o.tauRange[0], x1: o.tauRange[1], color: 'rgba(39,195,174,.10)', legend: 'область ±1% от максимума' }], xFmt: (v) => v + ' ч', xTip: (v) => 'τ = ' + F(v, 2) + ' ч', y: { zero: true } });
    if (o.sens) new TChart($('#o2'), { xType: 'num', height: 250, series: [{ name: 'Выигрыш оптимального режима', color: COL.pwh, x: o.sens.map(x => x.Dp), y: o.sens.map(x => x.gainPct), points: true, unit: '%', width: 2.2 }, { name: 'Оптимальный интервал', color: COL.info, x: o.sens.map(x => x.Dp), y: o.sens.map(x => x.tau), axis: 'y2', dash: [4, 3], points: true, unit: 'ч' }], vlines: [{ x: o.Dp, color: COL.neu, label: 'принято ' + fH(o.Dp) }], xFmt: (v) => F(v, 1) + ' ч', xTip: (v) => 'Dплан = ' + F(v, 2) + ' ч', y2Label: 'τ*, ч', y: { zero: true } });
  }

  /* --------------------------- ЭФФЕКТИВНОСТЬ (сравнение) -------------------- */
  async function viewEff(el, R) {
    const A = R.A, o = A.opt, p = A.p; const T = C.compareTimeline(A);
    if (!T) { el.innerHTML = warnBlock(R) + '<div class="warnbox err">' + ICO.warn + '<div>' + esc(o.reasons.join(' ')) + '</div></div>'; bindParamsBtn(el); return; }
    const so = o.scen.old, sn = o.noGain ? o.scen.old : o.scen.opt;
    const segs = (mode) => { const ph = T[mode].phase; const out = []; let a = 0; for (let i = 1; i <= ph.length; i++) if (i === ph.length || ph[i] !== ph[a]) { out.push({ ph: ph[a], x0: T.t[a], x1: T.t[Math.min(i, ph.length - 1)] }); a = i; } return out; };
    const PHC = { work: ['#46D69A', 'работа'], stop: ['#E8715A', 'остановка + продувка'], blow: ['#F2B33D', 'продувка'] };
    const bar = (mode) => segs(mode).map((s, i) => '<div class="tl-seg" style="left:' + (s.x0 / T.span * 100).toFixed(2) + '%;width:' + ((s.x1 - s.x0) / T.span * 100).toFixed(2) + '%;background:' + PHC[s.ph][0] + ';animation-delay:' + (i * 0.12) + 's" title="' + PHC[s.ph][1] + ': ' + fH(s.x1 - s.x0) + '">' + ((s.x1 - s.x0) / T.span > 0.08 ? PHC[s.ph][1] : '') + '</div>').join('');
    const ticks = []; for (let t = 0; t <= T.span; t += Math.max(1, Math.round(T.span / 8))) ticks.push('<span>' + t + ' ч</span>');
    const rows = [
      ['Продолжительность цикла (работа + простой)', fH(so.cycleH), fH(sn.cycleH)],
      ['Количество продувок за ' + p.horizonDays + ' сут', F(so.nBlow, 0), F(sn.nBlow, 0)],
      ['Количество продувок в год', F(so.nBlowYear, 0), F(sn.nBlowYear, 0)],
      ['Время эффективной работы за ' + p.horizonDays + ' сут', F(so.work, 0) + ' ч', F(sn.work, 0) + ' ч'],
      ['Время простоя за ' + p.horizonDays + ' сут', F(so.down, 0) + ' ч', F(sn.down, 0) + ' ч'],
      ['Потери газа при продувках', F(so.losses, 1) + ' тыс. м³', F(sn.losses, 1) + ' тыс. м³'],
      ['Накопленная добыча за ' + p.horizonDays + ' сут', F(so.gas, 0) + ' тыс. м³', F(sn.gas, 0) + ' тыс. м³'],
      ['Дополнительная добыча', '—', (sn.extra >= 0 ? '+' : '') + F(sn.extra || 0, 0) + ' тыс. м³ (' + (sn.extraPct >= 0 ? '+' : '') + F(sn.extraPct || 0, 1) + '%)'],
      ['Средняя добыча', F(so.rate, 2) + ' тыс. м³/сут', F(sn.rate, 2) + ' тыс. м³/сут'],
      ['Эффективность эксплуатации (коэф. эксплуатации)', F(so.kexp * 100, 1) + '%', F(sn.kexp * 100, 1) + '%']
    ];
    if (p.gasPrice) rows.push(['Стоимость добытого газа', F(so.revenue, 0), F(sn.revenue, 0)]);
    el.innerHTML = warnBlock(R) + '<div class="card"><h3>Один полный цикл: существующий и предлагаемый режимы <span class="sub">' + fH(T.span) + ', одинаковые исходные условия</span><span class="sp"></span><span class="badge model">модель на медианном цикле</span></h3>' +
      '<div class="tl"><div class="tl-row"><span style="color:' + COL.old + '">Существующий</span><div class="tl-bar">' + bar('old') + '</div></div><div class="tl-row"><span style="color:' + COL.neu + '">Предлагаемый</span><div class="tl-bar">' + bar('neu') + '</div></div><div class="tl-axis"><span></span><div>' + ticks.join('') + '</div></div></div>' +
      '<p class="note">Существующий: работа ' + fH(T.Told) + ' → накопление жидкости → потеря работоспособности → остановка и продувка ' + fH(T.Du) + ' → восстановление. Предлагаемый: предупреждение за 1 ч до рекомендуемого момента → продувка через ' + fH(T.tau) + ' работы → простой ' + fH(T.Dp) + ' → продолжение эффективной эксплуатации.</p></div>' +
      '<div class="grid g2"><div class="card">' + chartBox('e1', '1. Давление на голове и в шлейфе', 'кгс/см²') + '</div><div class="card">' + chartBox('e2', '2. Перепад давления ΔP', 'кгс/см²') + '</div></div>' +
      '<div class="grid g2"><div class="card">' + chartBox('e3', '3. Расчётный дебит газа', 'тыс. м³/сут') + '</div><div class="card">' + chartBox('e4', '4. Накопленная добыча газа', 'тыс. м³') + '</div></div>' +
      '<div class="card"><h3>5. Сравнительная таблица <span class="sub">горизонт ' + p.horizonDays + ' сут</span></h3><table class="tbl"><tr><th>Показатель</th><th class="num cmp-old">Старый режим</th><th class="num cmp-new">Новый режим</th></tr>' + rows.map(r => '<tr><td>' + r[0] + '</td><td class="num cmp-old">' + r[1] + '</td><td class="num cmp-new">' + r[2] + '</td></tr>').join('') + '</table>' +
      '<p class="note">Дебит и добыча нового режима не завышаются: используется тот же медианный профиль фактических циклов, что и для старого; учтены вероятность преждевременной остановки, простои, потери при продувках и неполное восстановление давления. Изменение суммарного простоя: ' + ((sn.down - so.down) >= 0 ? '+' : '') + F(sn.down - so.down, 0) + ' ч.</p></div>';
    bindParamsBtn(el);
    const bandsFor = () => { const b = []; segs('old').forEach(s => { if (s.ph !== 'work') b.push({ x0: s.x0, x1: s.x1, color: 'rgba(232,113,90,.10)', legend: 'остановка (старый)' }); }); segs('neu').forEach(s => { if (s.ph !== 'work') b.push({ x0: s.x0, x1: s.x1, color: 'rgba(242,179,61,.12)', legend: 'плановая продувка (новый)' }); }); return b; };
    const base = { xType: 'num', group: 'cmp', height: 230, bands: bandsFor(), xFmt: (v) => v + ' ч', xTip: (v) => F(v, 1) + ' ч от начала цикла', vlines: [{ x: T.warnAt, color: COL.warn, label: 'предупреждение', row: 0, dash: [2, 3] }, { x: T.recAt, color: COL.neu, label: 'рекомендуемая продувка', row: 1 }, { x: T.Told, color: COL.old, label: 'остановка (старый)', row: 2 }] };
    new TChart($('#e1'), Object.assign({}, base, { series: [{ name: 'Pwh старый', color: COL.old, x: T.t, y: T.old.pwh, unit: 'кгс/см²', width: 3.4 }, { name: 'Pwh новый', color: COL.neu, x: T.t, y: T.neu.pwh, unit: 'кгс/см²', width: 2 }, { name: 'Pline', color: COL.pline, x: T.t, y: T.old.pline, dash: [4, 3], unit: 'кгс/см²' }], y: { zero: true } }));
    new TChart($('#e2'), Object.assign({}, base, { series: [{ name: 'ΔP старый', color: COL.old, x: T.t, y: T.old.dp, unit: 'кгс/см²', width: 3.4 }, { name: 'ΔP новый', color: COL.neu, x: T.t, y: T.neu.dp, unit: 'кгс/см²', width: 2 }], hlines: [{ y: A.stats.dpCrit, color: COL.crit, label: 'ΔP крит.' }], y: { zero: true } }));
    new TChart($('#e3'), Object.assign({}, base, { series: [{ name: 'q старый', color: COL.old, x: T.t, y: T.old.q.map(v => v / 1000), unit: 'тыс. м³/сут', width: 3.4 }, { name: 'q новый', color: COL.neu, x: T.t, y: T.neu.q.map(v => v / 1000), unit: 'тыс. м³/сут', width: 2 }], y: { zero: true } }));
    new TChart($('#e4'), Object.assign({}, base, { series: [{ name: 'Накопленная старый', color: COL.old, x: T.t, y: T.old.cum, unit: 'тыс. м³', width: 3.4 }, { name: 'Накопленная новый', color: COL.neu, x: T.t, y: T.neu.cum, unit: 'тыс. м³', width: 2 }], y: { zero: true } }));
  }

  /* ---------------------------------- ДЕБИТ --------------------------------- */
  async function viewRate(el, R) {
    const A = R.A, p = A.p, s = A.s;
    if (!A.flowOK) { el.innerHTML = warnBlock(R); bindParamsBtn(el); return; }
    const n = s.t.length; const crit = [], sub = []; for (let i = 0; i < n; i++) { const q = A.q[i] / 1000; crit.push(A.regime[i] === 'критическое' ? q : NaN); sub.push(A.regime[i] === 'докритическое' ? q : NaN); }
    const ex = C.chokeFlow(C.median(A.cycles.map(c => c.peak)), C.median(Array.from(s.pline)), p), ex2 = C.chokeFlow(C.median(A.done.map(c => c.pwhEnd)), C.median(Array.from(s.pline)), p);
    const qc = []; if (p.tubing_mm) for (let i = 0; i < n; i++) qc.push(A.det.state[i] === 'W' ? C.criticalRate(s.pwh[i], p) / 1000 : NaN);
    const cyc = A.cycles; const prevEnd = cyc.map((c, k) => k ? cyc[k - 1].qEnd : NaN);
    el.innerHTML = '<div class="warnbox info">' + ICO.info + '<div>Расчёт дебита по двум давлениям является <b>оценочным</b> и требует калибровки по фактическим замерам расхода (вкладка «Параметры скважины» → «Калибровка»). Текущий калибровочный множитель: <b>' + F(p.calib, 3) + '</b>.</div></div>' +
      '<div class="kpis">' + kpi('Средний дебит цикла', F(A.stats.qMeanMed / 1000, 2), 'тыс. м³/сут', 'медиана по циклам') + kpi('Накоплено за период', F(A.stats.factGas, 1), 'тыс. м³', fH(A.stats.factSpanH)) + kpi('Дебит в начале цикла', F(C.median(cyc.map(c => c.q1h)) / 1000, 1), 'тыс. м³/сут', 'первый час') + kpi('Дебит перед остановкой', F(C.median(A.done.map(c => c.qEnd)) / 1000, 2), 'тыс. м³/сут', 'последний час') + kpi('Режим в начале цикла', ex.regime || '—', '', 'r = ' + F(ex.r, 3) + ' (rкр = ' + F(ex.rc, 3) + ')') + kpi('Режим в конце цикла', ex2.regime || '—', '', 'r = ' + F(ex2.r, 3)) + '</div>' +
      '<div class="card">' + chartBox('r1', 'Расчётный дебит во времени', 'тыс. м³/сут · цветом — режим течения через штуцер') + '</div>' +
      '<div class="grid g2"><div class="card">' + chartBox('r2', 'Накопленная добыча', 'тыс. м³') + '</div><div class="card">' + chartBox('r3', 'Изменение дебита после продувки', 'тыс. м³/сут: перед остановкой → первый час после перезапуска') + '</div></div>' +
      '<div class="card"><h3>Методика и допущения</h3><table class="tbl">' +
      tr2('Модель', 'Изоэнтропическое истечение реального газа через штуцер (сопло) с проверкой режима: при P₂/P₁ ≤ rкр = (2/(k+1))^(k/(k−1)) — критическое (запертое) течение, иначе — докритическое') +
      tr2('Массовый расход', 'ṁ = Cd·A·√(2·ρ₁·P₁·k/(k−1)·[r^(2/k) − r^((k+1)/k)]), ρ₁ = P₁·M/(Z₁·R·T₁)') +
      tr2('Давления', 'абсолютные: P = Pизб + ' + F(p.Patm, 4) + ' кгс/см²') + tr2('Диаметр штуцера d', F(p.d_mm, 2) + ' мм') + tr2('Отн. плотность газа γ', F(p.gamma, 3) + ' (M = ' + F(28.9647 * p.gamma, 2) + ' кг/кмоль)') +
      tr2('Температура газа перед штуцером', F(p.T_C, 1) + ' °C' + (p.T_C === 20 ? ' — допущение по умолчанию' : '')) +
      tr2('Коэффициент сверхсжимаемости Z', p.Z ? F(p.Z, 3) + ' (задан)' : 'по корреляции Папая с псевдокритическими параметрами Саттона (Z при пике ' + F(ex.Z, 3) + ')') +
      tr2('Коэффициент расхода Cd', F(p.Cd, 3) + (p.Cd === 0.85 ? ' — допущение по умолчанию' : '')) + tr2('Показатель адиабаты k', F(p.k, 2)) +
      tr2('Стандартные условия', F(p.Tst_C, 0) + ' °C, 101 325 Па (ГОСТ 2939)') + (p.tubing_mm ? tr2('Критический дебит выноса жидкости', (p.turnerCoef === 'turner' ? 'Тернер (+20%)' : 'Коулман') + ', НКТ ' + p.tubing_mm + ' мм, σ = ' + p.sigma + ' Н/м, ρж = ' + p.liqDensity + ' кг/м³') : '') + '</table></div>';
    const ser = [{ name: 'Критическое течение', color: COL.q, x: s.t, y: crit, unit: 'тыс. м³/сут', width: 2 }, { name: 'Докритическое течение', color: '#9BE7C4', x: s.t, y: sub, unit: 'тыс. м³/сут', width: 2 }];
    if (qc.length) ser.push({ name: 'Критический дебит выноса жидкости', color: COL.crit, x: s.t, y: qc, dash: [5, 4], unit: 'тыс. м³/сут' });
    new TChart($('#r1'), { group: 'g', height: 260, series: ser, bands: phaseBands(A), markers: eventMarkers(A).filter(m => m.shape === 'tri'), y: { zero: true } });
    new TChart($('#r2'), { group: 'g', height: 220, series: [{ name: 'Накопленная добыча', color: COL.cum, x: s.t, y: A.cum, unit: 'тыс. м³', fill: 'rgba(143,227,196,.15)' }], y: { zero: true } });
    const ks = cyc.map(c => c.k);
    new TChart($('#r3'), { xType: 'num', height: 220, series: [{ name: 'Перед остановкой (пред. цикл)', color: COL.old, x: ks.map(k => k - 0.18), y: prevEnd.map(v => v / 1000), type: 'bar', barW: 0.3, unit: 'тыс. м³/сут' }, { name: 'Первый час после продувки', color: COL.q, x: ks.map(k => k + 0.18), y: cyc.map(c => c.q1h / 1000), type: 'bar', barW: 0.3, unit: 'тыс. м³/сут' }], y: { zero: true }, xFmt: (v) => Number.isInteger(v) ? '№' + v : '', xTip: (v) => 'Цикл №' + Math.round(v), xMin: 0.4, xMax: ks.length + 0.6 });
  }

  /* --------------------------------- ЖУРНАЛ --------------------------------- */
  async function viewJournal(el, R) {
    const recs = (await GDB.byWell('recs', R.w.id)).sort((a, b) => b.created - a.created);
    el.innerHTML = '<div class="card"><h3>Журнал рекомендаций <span class="sub">' + recs.length + ' записей · фиксируется автоматически при каждом новом расчёте</span></h3>' +
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Создана</th><th>Данные на</th><th>Состояние</th><th>Рекомендация</th><th>Время продувки</th><th>Достоверность</th><th>Решение персонала</th></tr></thead><tbody>' +
      recs.map(r => '<tr><td>' + fDT(r.created) + '</td><td>' + fDT(r.dataTo) + '</td><td>' + esc(r.status) + '</td><td style="white-space:normal;min-width:300px"><b>' + esc(r.title) + '</b><div class="small muted">' + esc(r.text) + '</div></td><td>' + (isF(r.when) ? fDT(r.when) : '—') + '</td><td>' + esc(r.confidence) + '</td><td><select class="mini" data-dec="' + r.id + '">' + ['на рассмотрении', 'утверждено', 'выполнено', 'отклонено'].map(d => '<option' + (r.decision === d ? ' selected' : '') + '>' + d + '</option>').join('') + '</select>' + (r.comment ? '<div class="small muted">' + esc(r.comment) + '</div>' : '') + '</td></tr>').join('') +
      '</tbody></table></div><p class="note">Рекомендации не управляют скважиной автоматически. Решение фиксируется ответственным технологом.</p></div>';
    $$('[data-dec]', el).forEach(sel => sel.onchange = async () => { const r = recs.find(x => x.id === sel.dataset.dec); r.decision = sel.value; const cm = await askName('Комментарий к решению', 'Комментарий (необязательно), ФИО', r.comment || ''); if (cm) r.comment = cm; r.decidedAt = Date.now(); await GDB.put('recs', r); toast('Решение сохранено: ' + r.decision); renderView(); });
  }

  /* --------------------------- СРАВНЕНИЕ СКВАЖИН ---------------------------- */
  async function viewCompare(el) {
    const f = fieldById(S.sel.id); const ws = S.wells.filter(w => w.fieldId === f.id);
    const rows = []; for (const w of ws) { const R = await getAnalysis(w.id); rows.push(R); }
    el.innerHTML = '<div class="pane"><div class="card"><h3>' + esc(f.name) + ': сравнение скважин <span class="sp"></span><button class="tbtn" id="cAdd">' + ICO.plus + 'Добавить скважину</button></h3>' +
      (ws.length ? '<table class="tbl"><tr><th>Скважина</th><th>Состояние</th><th class="num">Медиана цикла</th><th class="num">Простой</th><th class="num">ΔP крит.</th><th class="num">q ср., тыс. м³/сут</th><th class="num">Оптим. интервал</th><th class="num">Прирост</th><th>Признаки жидкости</th><th>Достоверность</th></tr>' +
        rows.map(R => R.empty ? '<tr><td><a href="#" data-w="' + R.w.id + '">' + esc(R.w.name) + '</a></td><td colspan=9 class="muted">нет данных</td></tr>' : '<tr><td><a href="#" data-w="' + R.w.id + '">' + esc(R.w.name) + '</a></td><td><span class="sd ' + R.A.status.code + '" style="display:inline-block;margin-right:6px"></span>' + esc(R.A.status.text) + '</td><td class="num">' + fH(R.A.stats.workMed) + '</td><td class="num">' + fH(R.A.stats.downMed) + '</td><td class="num">' + F(R.A.stats.dpCrit, 2) + '</td><td class="num">' + F(R.A.stats.qMeanMed / 1000, 2) + '</td><td class="num">' + (R.A.opt.ok ? fH(R.A.opt.opt.tau) : '—') + '</td><td class="num gain">' + (R.A.opt.ok ? '+' + F(R.A.opt.gainPct, 1) + '%' : '—') + '</td><td>' + esc(R.A.loading.level) + '</td><td>' + esc(R.A.conf.level) + '</td></tr>').join('') + '</table>' : '<p class="muted">На месторождении пока нет скважин.</p>') + '</div>' +
      '<div class="card">' + chartBox('cmp1', 'Средняя добыча: существующий и оптимизированный режимы', 'тыс. м³/сут') + '</div></div>';
    $('#cAdd').onclick = () => addWell(f.id);
    $$('[data-w]', el).forEach(a => a.onclick = (e) => { e.preventDefault(); select({ type: 'well', id: a.dataset.w }, 'dash'); });
    const ok = rows.filter(R => !R.empty && R.A.opt.ok);
    if (ok.length) new TChart($('#cmp1'), { xType: 'num', height: 240, series: [{ name: 'Существующий', color: COL.old, x: ok.map((R, i) => i + 1 - 0.18), y: ok.map(R => R.A.opt.old.rate), type: 'bar', barW: 0.3, unit: 'тыс. м³/сут' }, { name: 'Оптимизированный', color: COL.neu, x: ok.map((R, i) => i + 1 + 0.18), y: ok.map(R => R.A.opt.opt.rate), type: 'bar', barW: 0.3, unit: 'тыс. м³/сут' }], xFmt: (v) => Number.isInteger(v) && ok[v - 1] ? ok[v - 1].w.name : '', xTip: (v) => (ok[Math.round(v) - 1] || {}).w ? ok[Math.round(v) - 1].w.name : '', xMin: 0.4, xMax: ok.length + 0.6, y: { zero: true } });
    else $('#cmp1').innerHTML = '<p class="muted">Нет скважин с рассчитанной оптимизацией.</p>';
  }

  /* ----------------------------- ПАРАМЕТРЫ СКВАЖИНЫ ------------------------- */
  const PFIELDS = [
    ['Штуцер и газ'],
    ['d_mm', 'Диаметр штуцера, мм', 'num', 'Внутренний диаметр штуцера (дросселя) на устье', true],
    ['gamma', 'Относительная плотность газа по воздуху', 'num', 'γ = M/28,96; для сухого газа обычно 0,56–0,65', true],
    ['T_C', 'Температура газа перед штуцером, °C', 'num', 'Если неизвестна — принимается 20 °C (допущение показывается в отчётах)'],
    ['Z', 'Коэффициент сверхсжимаемости Z', 'num', 'Пусто — расчёт по корреляции Папая (Саттон)'],
    ['Cd', 'Коэффициент расхода штуцера Cd', 'num', 'Типично 0,80–0,90; уточняется калибровкой'],
    ['k', 'Показатель адиабаты k', 'num', 'Для природного газа 1,27–1,31'],
    ['tubing_mm', 'Внутренний диаметр НКТ, мм', 'num', 'Необязательно: для критерия выноса жидкости Тернера/Коулмана'],
    ['turnerCoef', 'Критерий выноса жидкости', 'sel', '', false, [['coleman', 'Коулман (низкое давление)'], ['turner', 'Тернер (+20%)']]],
    ['Детектор событий'],
    ['jumpMin', 'Мин. скачок Pwh при продувке, кгс/см²', 'num', 'Скачки меньше — не считаются продувкой'],
    ['rateMin', 'Мин. скорость роста Pwh, кгс/см²/ч', 'num', 'Отсекает медленный рост давления'],
    ['dpOn', 'ΔP начала работы, кгс/см²', 'num', 'Гистерезис: работа фиксируется при ΔP выше значения'],
    ['dpOff', 'ΔP потери работоспособности, кгс/см²', 'num', 'Остановка при Pwh ≤ Pline + значение'],
    ['minWorkH', 'Мин. длительность работы после скачка, ч', 'num', 'Короче — кратковременное открытие/шум'],
    ['dpCritManual', 'Критический ΔP вручную, кгс/см²', 'num', 'Пусто — по истории скважины (медиана при остановках)'],
    ['Оптимизация и экономика'],
    ['D_unpl', 'Простой при вынужденной продувке, ч', 'num', 'Пусто — медиана фактических простоев'],
    ['D_pl', 'Простой при упреждающей продувке, ч', 'num', 'Пусто — 10-й процентиль фактических простоев'],
    ['lossUnpl', 'Потери газа на вынужденную продувку, тыс. м³', 'num', 'Стравливание в атмосферу при продувке'],
    ['lossPl', 'Потери газа на упреждающую продувку, тыс. м³', 'num', 'Обычно меньше: скважина не задавлена'],
    ['reliability', 'Надёжность прогнозного режима (0–1)', 'num', 'Вероятность дойти до продувки без остановки'],
    ['horizonDays', 'Горизонт сравнения, сут', 'num', ''],
    ['gasPrice', 'Цена газа за 1 тыс. м³ (необязательно)', 'num', 'Для экономической оценки'],
    ['Интеграция Real-Time (на будущее)'],
    ['rtUrl', 'Адрес источника данных (JSON/REST)', 'txt', 'Формат: [{"t":"2026-11-16T10:00:00","pwh":12.3,"pline":10.4}] — шлюз OPC UA/Modbus'],
    ['rtMin', 'Период опроса, мин', 'num', '0 — выключено']
  ];
  async function paramsDialog(wellId, first) {
    const w = wellById(wellId); const p = Object.assign({}, C.DEFAULTS, w.params || {});
    const form = document.createElement('div'); let h = '<div class="form">';
    PFIELDS.forEach(f => {
      if (f.length === 1) { h += '<div class="fs">' + f[0] + '</div>'; return; }
      const [k, l, t, tip, req, opts] = f; const v = p[k] == null ? '' : p[k];
      h += '<div class="fg"><label>' + l + (req ? ' <span class="req">*</span>' : '') + (tip ? ' <span class="tip" title="' + esc(tip) + '">?</span>' : '') + '</label>' +
        (t === 'sel' ? '<select data-k="' + k + '">' + opts.map(o => '<option value="' + o[0] + '"' + (o[0] === v ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' : '<input data-k="' + k + '" data-t="' + t + '" value="' + esc(v) + '"' + (t === 'num' ? ' inputmode="decimal"' : '') + '>') + (tip ? '<em>' + esc(tip) + '</em>' : '') + '</div>';
    });
    h += '<div class="fs">Калибровка по фактическим замерам дебита</div><div class="fg" style="grid-column:1/-1"><table class="tbl" id="calT"><tr><th>Дата и время замера</th><th class="num">Замер, тыс. м³/сут</th><th class="num">Расчёт</th><th class="num">Отношение</th><th></th></tr></table><div style="display:flex;gap:8px;margin-top:8px"><input id="calD" placeholder="16.11.2026 09:00" style="flex:1;height:32px;border-radius:6px;border:1px solid var(--line);background:var(--bg2);padding:0 8px"><input id="calQ" placeholder="тыс. м³/сут" style="width:130px;height:32px;border-radius:6px;border:1px solid var(--line);background:var(--bg2);padding:0 8px"><button class="mini" id="calAdd">Добавить замер</button></div><em>Калибровочный множитель = медиана отношений «замер / расчёт»; текущий: ' + F(p.calib, 3) + '</em></div></div>';
    form.innerHTML = (first ? '<div class="warnbox info">' + ICO.info + '<div>Для расчёта дебита и оптимизации укажите диаметр штуцера и относительную плотность газа. Остальные значения можно оставить по умолчанию — они будут показаны в отчётах как допущения.</div></div>' : '') + h;
    const cal = (w.params && w.params.calibPoints) ? w.params.calibPoints.slice() : [];
    const R = S.cache[wellId];
    const drawCal = () => { const tb = $('#calT', form); $$('tr.cr', tb).forEach(r => r.remove()); cal.forEach((c, i) => { let qc = NaN; if (R && R.A) { const s = R.A.s; let j = 0; let best = Infinity; for (let k = 0; k < s.t.length; k++) { const d = Math.abs(s.t[k] - c.t); if (d < best) { best = d; j = k; } } if (best < 2 * H) qc = R.A.q[j] / (R.A.p.calib || 1) / 1000; } c.qc = qc; const tr = document.createElement('tr'); tr.className = 'cr'; tr.innerHTML = '<td>' + fDT(c.t) + '</td><td class="num">' + F(c.q, 2) + '</td><td class="num">' + F(qc, 2) + '</td><td class="num">' + F(c.q / qc, 3) + '</td><td><button class="mini" data-i="' + i + '">Удалить</button></td>'; tb.appendChild(tr); }); $$('[data-i]', tb).forEach(b => b.onclick = () => { cal.splice(+b.dataset.i, 1); drawCal(); }); };
    setTimeout(() => { drawCal(); $('#calAdd', form).onclick = () => { const t = GIO.parseDate($('#calD', form).value); const q = GIO.parseNum($('#calQ', form).value); if (!isF(t) || !isF(q)) return toast('Укажите дату «дд.мм.гггг чч:мм» и дебит', true); cal.push({ t, q }); drawCal(); }; }, 30);
    let ok = false;
    await modal('Параметры скважины ' + w.name, form, [{ t: 'Отмена', v: 0 }, { t: 'Сохранить и пересчитать', v: 1, primary: true, check: () => {
      const np = Object.assign({}, w.params || {});
      for (const inp of $$('[data-k]', form)) { const k = inp.dataset.k; let v = inp.value.trim(); if (inp.dataset.t === 'num') { if (v === '') { np[k] = null; continue; } v = parseFloat(v.replace(',', '.')); if (!isF(v)) { toast('Некорректное значение: ' + inp.closest('.fg').querySelector('label').textContent, true); return false; } } np[k] = v === '' ? null : v; }
      if (np.gamma != null && (np.gamma < 0.5 || np.gamma > 1.8)) { toast('Относительная плотность газа должна быть 0,5–1,8', true); return false; }
      if (np.d_mm != null && (np.d_mm <= 0 || np.d_mm > 200)) { toast('Диаметр штуцера вне диапазона 0–200 мм', true); return false; }
      ['T_C', 'Cd', 'k', 'jumpMin', 'rateMin', 'dpOn', 'dpOff', 'minWorkH', 'reliability', 'horizonDays', 'turnerCoef'].forEach(k => { if (np[k] == null) delete np[k]; });
      np.calibPoints = cal; const ratios = cal.map(c => c.q / c.qc).filter(isF); np.calib = ratios.length ? C.median(ratios) : 1;
      w.params = np; ok = true; return true; } }]);
    if (!ok) return;
    await GDB.put('wells', w); invalidate(wellId); await render(); toast('Параметры сохранены, анализ пересчитан'); setupRealtime();
  }

  /* --------------------------------- ИМПОРТ --------------------------------- */
  async function importWizard(targetWellId, queue) {
    const body = document.createElement('div');
    body.innerHTML = '<label class="drop" id="drop">' + ICO.upload.replace('<svg', '<svg style="color:#F2B33D"') + '<div><b>Перетащите файл сюда или нажмите для выбора</b></div><div class="muted small">Архив .7z (LZMA/LZMA2), Excel .xlsx, CSV · поддерживается выгрузка SCADA «лист на параметр»</div><input type="file" id="fi" hidden multiple accept=".7z,.xlsx,.xls,.csv,.txt"></label><div id="istep"></div>';
    let state = null;
    let rest = queue ? queue.slice(1) : [];
    const handle = async (file) => {
      try {
        busy(true, 'Чтение файла…'); const buf = new Uint8Array(await file.arrayBuffer());
        const r = await GIO.readAny(file.name, buf); busy(false);
        if (!r.tables.length) throw new Error('В файле не найдено таблиц');
        state = { file, r, map: GIO.autoMap(r.tables) };
        if (state.map.mode === 'table') { const h = r.tables[state.map.pwh.table].header; state.map.wellCol = h.findIndex(x => /скважин|^well|^скв/i.test(x || '')); state.map.fieldCol = h.findIndex(x => /месторожд|^field|площад/i.test(x || '')); }
        renderMap();
      } catch (e) { busy(false); toast('Ошибка импорта: ' + e.message, true); }
    };
    const renderMap = () => {
      const { r, map } = state; const st = $('#istep', body);
      const tOpts = (sel) => r.tables.map((t, i) => '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(t.name) + ' (' + t.rows.length + ' строк)</option>').join('');
      const cOpts = (ti, sel, allowNone) => (allowNone ? '<option value="-1">— нет —</option>' : '') + r.tables[ti].header.map((h, i) => '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(h || ('Столбец ' + (i + 1))) + '</option>').join('');
      const uOpts = (u) => Object.keys(GIO.UNITS).map(k => '<option' + (k === u ? ' selected' : '') + '>' + k + '</option>').join('');
      const blk = (k, title) => { const m = map[k]; return '<div class="fs">' + title + '</div><div class="fg"><label>Лист / таблица</label><select data-m="' + k + '.table">' + tOpts(m.table) + '</select></div><div class="fg"><label>Значение</label><select data-m="' + k + '.value">' + cOpts(m.table, m.value) + '</select></div><div class="fg"><label>Дата (или дата и время)</label><select data-m="' + k + '.date">' + cOpts(m.table, m.date) + '</select></div><div class="fg"><label>Время (если отдельно)</label><select data-m="' + k + '.time">' + cOpts(m.table, m.time, true) + '</select></div><div class="fg"><label>Единицы</label><select data-m="' + k + '.unit">' + uOpts(m.unit) + '</select></div><div class="fg"><label>Предпросмотр</label><div class="small muted" id="pv-' + k + '"></div></div>'; };
      const srcName = (r.inner && r.inner[0]) || state.file.name; const base = (srcName.replace(/\.[^.]+$/, '').split(/\s+-\s+/)[0] || 'Скважина').replace(/_+/g, ' ').trim();
      const fOpts = S.fields.map(f => '<option value="' + f.id + '">' + esc(f.name) + '</option>').join('');
      const wOpts = S.wells.map(w => '<option value="' + w.id + '"' + (w.id === targetWellId ? ' selected' : '') + '>' + esc((fieldById(w.fieldId) || {}).name + ' / ' + w.name) + '</option>').join('');
      const multi = map.mode === 'table' ? '<div class="fs">Несколько скважин в одной таблице (необязательно)</div><div class="fg"><label>Столбец «Скважина»</label><select data-mw="wellCol">' + cOpts(map.pwh.table, map.wellCol, true) + '</select></div><div class="fg"><label>Столбец «Месторождение»</label><select data-mw="fieldCol">' + cOpts(map.pwh.table, map.fieldCol, true) + '</select></div>' : '';
      st.innerHTML = (rest.length ? '<div class="warnbox info">' + ICO.info + '<div>Файл ' + (queue ? queue.length - rest.length : 1) + ' из ' + ((queue ? queue.length : 1) + (queue ? 0 : rest.length)) + '. После импорта откроется следующий файл.</div></div>' : '') + '<div class="log">' + r.log.concat(map.notes).map(l => '<div>' + esc(l) + '</div>').join('') + '</div><div class="form">' + multi + blk('pwh', 'Рабочее давление на голове скважины (Pwh)') + blk('pline', 'Рабочее давление в шлейфе (Pline)') +
        '<div class="fs">Куда загрузить</div><div class="fg"><label>Скважина</label><select id="iw"><option value="new">+ новая скважина</option>' + wOpts + '</select></div><div class="fg" id="iwn"><label>Название новой скважины</label><input id="iwname" value="' + esc(base) + '"></div>' +
        '<div class="fg" id="ifl"><label>Месторождение</label><select id="if">' + fOpts + '<option value="new">+ новое месторождение</option></select></div><div class="fg" id="ifn"><label>Название месторождения</label><input id="ifname" value="Месторождение"></div>' +
        '<div class="fg"><label>Режим загрузки</label><select id="imode"><option value="merge">Добавить к истории (новые замеры, без дублей)</option><option value="replace">Заменить историю скважины</option></select></div></div>';
      if (targetWellId) $('#iw', st).value = targetWellId;
      const sync = () => { const nw = $('#iw', st).value === 'new'; $('#iwn', st).style.display = nw ? '' : 'none'; $('#ifl', st).style.display = nw ? '' : 'none'; $('#ifn', st).style.display = nw && ($('#if', st).value === 'new' || !S.fields.length) ? '' : 'none'; };
      if (!S.fields.length) $('#if', st).value = 'new';
      $('#if', st).onchange = sync; if (map.wellCol < 0 || map.wellCol == null) { $('#iw', st).onchange = sync; sync(); }
      $$('[data-mw]', st).forEach(sel => sel.onchange = () => { map[sel.dataset.mw] = +sel.value; renderMap(); });
      if (map.wellCol >= 0) { ['#iw', '#iwn', '#ifl', '#ifn'].forEach(q => { const e = $(q, st); if (e) (e.closest('.fg') || e).style.display = 'none'; }); const grp = groupsOf(); $('#imode', st).closest('.fg').insertAdjacentHTML('beforebegin', '<div class="fg" style="grid-column:1/-1"><label>Скважины в файле</label><div class="small">' + grp.length + ': ' + esc(grp.slice(0, 12).map(g => (g.field ? g.field + ' / ' : '') + g.well).join(', ')) + (grp.length > 12 ? '…' : '') + '</div><em>Месторождения и скважины будут созданы или дополнены по названиям.</em></div>'); }
      else $('#iw', st).onchange = sync;
      $$('[data-m]', st).forEach(sel => sel.onchange = () => { const [k, f] = sel.dataset.m.split('.'); map[k][f] = f === 'unit' ? sel.value : +sel.value; if (f === 'table') renderMap(); else preview(); });
      preview();
    };
    const preview = () => { ['pwh', 'pline'].forEach(k => { const x = GIO.extract(state.r.tables, state.map[k]); state[k] = x; const el = $('#pv-' + k, body); if (!x.t.length) { el.innerHTML = '<span style="color:var(--crit)">нет данных — проверьте столбцы</span>'; return; } const mn = Math.min.apply(null, x.v), mx = Math.max.apply(null, x.v); el.innerHTML = x.t.length + ' замеров · ' + fDT(x.t[0]).slice(0, 16) + ' – ' + fDT(x.t[x.t.length - 1]).slice(0, 16) + ' · ' + F(mn, 2) + '…' + F(mx, 2) + (x.badDate + x.badVal ? ' · <span style="color:var(--warn)">пропущено строк: ' + (x.badDate + x.badVal) + '</span>' : ''); }); };
    const groupsOf = () => { const map = state.map, t = state.r.tables[map.pwh.table]; const g = new Map(); t.rows.forEach(r => { if (!r) return; const w = r[map.wellCol]; if (w == null || w === '') return; const f = map.fieldCol >= 0 ? r[map.fieldCol] : ''; const k = f + '\u0001' + w; if (!g.has(k)) g.set(k, { field: f == null ? '' : String(f), well: String(w), rows: [] }); g.get(k).rows.push(r); }); return Array.from(g.values()); };
    {
      const drop = $('#drop', body), fi = $('#fi', body);
      fi.onchange = () => { const fs = Array.from(fi.files); if (!fs.length) return; rest = fs.slice(1); handle(fs[0]); };
      if (queue && queue.length) setTimeout(() => handle(queue[0]), 30);
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const fs = Array.from(e.dataTransfer.files); if (fs.length) { rest = fs.slice(1); handle(fs[0]); } };
    }
    let go = false;
    await modal('Импорт данных', body, [{ t: 'Отмена', v: 0 }, { t: 'Импортировать', v: 1, primary: true, check: () => { if (!state) { toast('Сначала выберите файл', true); return false; } if (!state.pwh || !state.pwh.t.length) { toast('Не распознано давление на голове', true); return false; } if (!state.pline || !state.pline.t.length) { toast('Не распознано давление в шлейфе', true); return false; } go = { wsel: $('#iw', body).value, wname: $('#iwname', body).value.trim(), fsel: $('#if', body).value, fname: (state.map.wellCol >= 0 ? '' : $('#ifname', body).value.trim()), mode: $('#imode', body).value }; return true; } }]);
    if (!go) return;
    busy(true, 'Сохранение в базу и расчёт…');
    if (state.map.wellCol >= 0 && state.map.mode === 'table') {
      try {
        const grp = groupsOf(); let added = 0, nW = 0; const t = state.r.tables[state.map.pwh.table];
        for (const g of grp) {
          const sub = [{ name: t.name, header: t.header, rows: g.rows }];
          const mp = (k) => Object.assign({}, state.map[k], { table: 0 });
          const xp = GIO.extract(sub, mp('pwh')), xl = GIO.extract(sub, mp('pline'));
          let f = S.fields.find(x => x.name === (g.field || go.fname || 'Месторождение'));
          if (!f) { f = { id: GDB.uid(), name: g.field || go.fname || 'Месторождение', created: Date.now() }; await GDB.put('fields', f); S.fields.push(f); }
          let w = S.wells.find(x => x.fieldId === f.id && x.name === g.well);
          if (!w) { w = { id: GDB.uid(), fieldId: f.id, name: g.well, params: {}, created: Date.now() }; await GDB.put('wells', w); S.wells.push(w); }
          let ser = await GDB.get('series', w.id); if (!ser || go.mode === 'replace') ser = Object.assign(ser || {}, { wellId: w.id, pwh: { t: [], v: [] }, pline: { t: [], v: [] }, imports: (ser && ser.imports) || [], excl: {}, overrides: {}, edits: {} });
          let a = 0; [['pwh', xp], ['pline', xl]].forEach(([k, x]) => { const m = new Map(); ser[k].t.forEach((tt, i) => m.set(tt, ser[k].v[i])); x.t.forEach((tt, i) => { if (!m.has(tt)) a++; m.set(tt, x.v[i]); }); const ts = Array.from(m.keys()).sort((p1, p2) => p1 - p2); ser[k] = { t: ts, v: ts.map(tt => m.get(tt)) }; });
          ser.imports.push({ date: Date.now(), file: state.file.name, added: a }); await GDB.put('series', ser); invalidate(w.id); added += a; nW++;
        }
        await loadAll(); busy(false); toast('Импортировано: скважин ' + nW + ', новых замеров ' + added); select({ type: 'fund' }, 'fund');
        if (rest.length) importWizard(undefined, rest);
      } catch (e) { busy(false); toast('Ошибка сохранения: ' + e.message, true); console.error(e); }
      return;
    }
    try {
      let w;
      if (go.wsel === 'new') {
        let fid = go.fsel; if (!S.fields.length || fid === 'new') { const f = { id: GDB.uid(), name: go.fname || 'Месторождение', created: Date.now() }; await GDB.put('fields', f); fid = f.id; }
        w = { id: GDB.uid(), fieldId: fid, name: go.wname || 'Скважина', params: {}, created: Date.now() }; await GDB.put('wells', w);
      } else w = wellById(go.wsel);
      let ser = await GDB.get('series', w.id);
      if (!ser || go.mode === 'replace') ser = { wellId: w.id, pwh: { t: [], v: [] }, pline: { t: [], v: [] }, imports: [], excl: {}, overrides: {}, edits: {} };
      let added = 0; ['pwh', 'pline'].forEach(k => { const m = new Map(); ser[k].t.forEach((t, i) => m.set(t, ser[k].v[i])); state[k].t.forEach((t, i) => { if (!m.has(t)) added++; m.set(t, state[k].v[i]); }); const ts = Array.from(m.keys()).sort((a, b) => a - b); ser[k] = { t: ts, v: ts.map(t => m.get(t)) }; });
      ser.imports.push({ date: Date.now(), file: state.file.name, added });
      await GDB.put('series', ser); await loadAll(); invalidate(w.id); busy(false);
      toast('Импортировано новых замеров: ' + added);
      S.sel = { type: 'well', id: w.id }; S.tab = 'dash'; S.open[w.fieldId] = true; renderTree(); await render();
      if (!w.params || !w.params.d_mm || !w.params.gamma) await paramsDialog(w.id, true);
      if (rest.length) importWizard(undefined, rest);
    } catch (e) { busy(false); toast('Ошибка сохранения: ' + e.message, true); console.error(e); }
  }

  /* ------------------------------ Real-Time опрос ---------------------------- */
  let rtTimers = [];
  function setupRealtime() {
    rtTimers.forEach(clearInterval); rtTimers = [];
    S.wells.forEach(w => { const p = w.params || {}; if (p.rtUrl && p.rtMin > 0) rtTimers.push(setInterval(() => pollRT(w), p.rtMin * 60000)); });
  }
  async function pollRT(w) {
    try {
      const r = await fetch(w.params.rtUrl); const js = await r.json(); const ser = (await GDB.get('series', w.id)) || { wellId: w.id, pwh: { t: [], v: [] }, pline: { t: [], v: [] }, imports: [] };
      let added = 0; js.forEach(o => { const t = GIO.parseDate(o.t) || Date.parse(o.t); if (!isF(t)) return; [['pwh', o.pwh], ['pline', o.pline]].forEach(([k, v]) => { if (isF(+v) && !ser[k].t.includes(t)) { ser[k].t.push(t); ser[k].v.push(+v); added++; } }); });
      ['pwh', 'pline'].forEach(k => { const idx = ser[k].t.map((_, i) => i).sort((a, b) => ser[k].t[a] - ser[k].t[b]); ser[k] = { t: idx.map(i => ser[k].t[i]), v: idx.map(i => ser[k].v[i]) }; });
      if (added) { await GDB.put('series', ser); invalidate(w.id); if (S.sel && S.sel.id === w.id) renderView(); }
    } catch (e) { console.warn('RT', e); }
  }

  /* ------------------------------ БАЗА / ОТЧЁТЫ ----------------------------- */
  async function download(name, blob) {
    if (GSRC.native()) {
      try {
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(blob); });
        const path = await GSRC.nat('save_file', { name, b64 });
        toast('Файл сохранён: ' + path); try { await GSRC.nat('reveal_file', { path }); } catch (e) { /* проводник недоступен */ }
      } catch (e) { toast('Не удалось сохранить файл: ' + e.message, true); }
      return;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
  async function dbAction(a) {
    if (a === 'exp') { const o = await GDB.exportAll(); download('ГазПродувка_база_' + new Date().toISOString().slice(0, 10) + '.json', new Blob([JSON.stringify(o)], { type: 'application/json' })); toast('Резервная копия сохранена'); }
    if (a === 'imp') { const fi = document.createElement('input'); fi.type = 'file'; fi.accept = '.json'; fi.onchange = async () => { try { const o = JSON.parse(await fi.files[0].text()); await GDB.importAll(o, false); await loadAll(); S.cache = {}; renderTree(); render(); toast('База восстановлена из копии'); } catch (e) { toast('Ошибка: ' + e.message, true); } }; fi.click(); }
    if (a === 'about') modal('О методике расчёта', methodText(), null);
  }
  function methodText() {
    return '<div class="small" style="line-height:1.6"><p><b>Выявление продувок.</b> Состояние «работа» фиксируется при ΔP = Pwh − Pline выше порога (гистерезис). Перед каждым входом в работу ищется крупнейший шаг роста Pwh; событие признаётся продувкой, если скачок, скорость роста (производная) и устойчивость последующей работы превышают пороги. Одиночные выбросы (точка отличается от обоих соседей при близких соседях) исключаются на этапе контроля качества.</p>' +
      '<p><b>Накопление жидкости</b> оценивается по совокупности признаков: повторяемость циклов, вклад шлейфа в снижение ΔP, стабильность ΔP при остановке, затухающая форма кривой, резкость остановки и (при заданном диаметре НКТ) критерий выноса жидкости Тернера/Коулмана. Снижение давления, вызванное ростом Pline, не трактуется как накопление жидкости.</p>' +
      '<p><b>Критический перепад</b> — медиана ΔP на последнем рабочем замере перед потерей работоспособности, индивидуально для скважины.</p>' +
      '<p><b>Прогноз</b> — взвешенное объединение: аппроксимация текущего цикла ΔP(t) = c + A·e^(−t/τ), аналог по медианной кривой циклов и условная медиана логнормального распределения длительности работы. Интервал 10–90% показывается вместе с уровнем достоверности.</p>' +
      '<p><b>Оптимизация</b> — модель восстановления (renewal–reward, задача «замены по возрасту»): средняя добыча R(τ) с учётом вероятности преждевременной остановки, простоев вынужденной и плановой продувок, потерь газа и поправки на неполное восстановление давления. Сценарий 2 — продувка при заданной надёжности, сценарий 3 — максимум R(τ).</p>' +
      '<p><b>Дебит</b> — изоэнтропическое истечение реального газа через штуцер с проверкой критического режима; Z по Папаю (Саттон). Расчёт оценочный и калибруется по замерам.</p>' +
      '<p class="muted">Все внешние библиотеки (DOCX, PPTX, ZIP) встроены в файл — программа работает без интернета. Данные хранятся локально в IndexedDB браузера; регулярно сохраняйте резервную копию.</p></div>';
  }
  async function report() { select({ type: 'reports' }, 'reports'); }

  /* ------------------------- источник данных (индикатор) ------------------------ */
  function renderSrcPill() {
    const el = $('#srcPill'); if (!el) return; const g = GSRC.st;
    const dot = g.mode === 'offline' ? 'ok' : g.status === 'ok' ? 'ok' : g.status === 'error' ? 'err' : g.status === 'connecting' ? 'busy' : 'idle';
    el.innerHTML = '<span class="sdot ' + dot + '"></span><span><b>' + (g.mode === 'offline' ? 'OFFLINE' : g.mode === 'online' ? 'ONLINE' : 'OFFLINE + ONLINE') + '</b><small>' + (g.mode === 'offline' ? 'Excel / файлы' : esc(g.connName || 'нет подключения') + (g.lastOk ? ' · ' + fDT(g.lastOk).slice(11) : '')) + '</small></span>';
    el.title = GSRC.MODES[g.mode] + (g.mode !== 'offline' ? '\nПодключение: ' + (g.connName || '—') + '\nСостояние: ' + ({ ok: 'подключено', error: 'ошибка: ' + (g.lastErr || ''), connecting: 'обновление…', idle: 'ожидание', off: 'не подключено' })[g.status] + '\nПоследнее обновление: ' + (g.lastOk ? fDT(g.lastOk) : '—') + '\nПолучено записей: ' + g.totalRows : '');
  }
  function ctx() { return { S, $, $$, esc, F, fH, fDT, isF, H, C, COL, modal, toast, busy, confirmBox, askName, getAnalysis, select, renderView, renderTree, render, invalidate, loadAll, wellById, fieldById, importWizard, chartBox, kpi, srcBadge, confBadge, phaseBands, eventMarkers, renderSrcPill, download, toLocalInput, STATUS_COLORS }; }

  /* ---------------------------------- старт --------------------------------- */
  async function init() {
    shell(); await GDB.open(); await GSRC.load(); await loadAll();
    GSRC.on({ status: renderSrcPill, updated: async (ids, n) => { if (S.connErrShown) toast('Соединение с PostgreSQL восстановлено, пропущенные записи загружены'); S.connErrShown = false; await loadAll(); ids.forEach(invalidate); renderTree(); if (n) toast('Получено новых записей из PostgreSQL: ' + n); if (S.sel && (ids.includes(S.sel.id) || ['fund', 'sources'].includes(S.sel.type))) renderView(); }, error: (e) => { if (!S.connErrShown) { toast('PostgreSQL: ' + e.message + '. Работа продолжается на последних сохранённых данных.', true); S.connErrShown = true; } renderSrcPill(); if (S.sel && GSRC.st.mode !== 'offline') renderView(); } });
    if (GSRC.st.connId) { GSRC.schedule(); if (GSRC.st.onOpen && GSRC.st.mode !== 'offline') setTimeout(() => GSRC.sync('открытие программы'), 500); }
    if (S.wells.length) { const w = S.wells[0]; S.sel = { type: 'well', id: w.id }; S.tab = 'dash'; S.open[w.fieldId] = true; }
    renderTree(); await render(); setupRealtime();
    // пересчёт статусов всех скважин в фоне
    setTimeout(async () => { for (const w of S.wells) { try { await getAnalysis(w.id); } catch (e) { console.warn(e); } } renderTree(); }, 300);
  }
  return { init, S, _import: importWizard, getAnalysis, select, views: {}, ctx: () => ctx() };
})();
window.addEventListener('DOMContentLoaded', () => App.init().catch(e => { console.error(e); document.body.innerHTML = '<pre style="color:#f88;padding:20px">Ошибка запуска: ' + e.message + '</pre>'; }));
