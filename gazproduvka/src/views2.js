/* ============================================================================
   VIEWS 2: сводка фонда, анимация рабочего цикла, источники данных,
   проверка прогноза на истории, точность сохранённых прогнозов, итоги месторождения.
   Все значения берутся из единого ядра (GCORE) через App.getAnalysis.
   ========================================================================== */
(function () {
  'use strict';
  const V = App.views;
  const H = 3600000, isF = Number.isFinite;

  /* ================================ СВОДКА ФОНДА ================================ */
  V.fund = async function (el, c) {
    const { S, esc, F, fH, fDT, C, toast } = c;
    el.innerHTML = '<div class="card"><h3>Сводка по фонду скважин</h3><p class="muted" id="fProg">Расчёт…</p></div>';
    const rows = []; let k = 0;
    for (const w of S.wells) {
      k++; if (k % 5 === 0) { const p = document.getElementById('fProg'); if (p) p.textContent = 'Расчёт скважин: ' + k + ' из ' + S.wells.length; await new Promise(r => setTimeout(r, 0)); }
      const R = await c.getAnalysis(w.id); rows.push(fundRow(R, c));
    }
    S.fund = S.fund || { q: '', field: '', status: '', prio: '', sort: 'prio', dir: -1, h: 3 };
    const f = S.fund;
    const draw = () => {
      const list = rows.filter(r => (!f.q || (r.well + ' ' + r.field).toLowerCase().includes(f.q)) && (!f.field || r.fieldId === f.field) && (!f.status || r.statusCode === f.status) && (f.prio === '' || r.prio === +f.prio));
      list.sort((a, b) => { const x = a[f.sort], y = b[f.sort]; if (typeof x === 'string' || typeof y === 'string') return f.dir * String(x || '').localeCompare(String(y || ''), 'ru', { numeric: true }); return f.dir * ((isF(x) ? x : -Infinity) - (isF(y) ? y : -Infinity)); });
      const ok = rows.filter(r => !r.empty);
      const sum = (key) => ok.reduce((a, r) => a + (isF(r[key]) ? r[key] : 0), 0);
      const cnt = (fn) => ok.filter(fn).length;
      const kp = [
        ['Всего скважин', rows.length, ''], ['Работают', cnt(r => r.working), ''], ['Предупредительная зона', cnt(r => r.inWarn), 'Pwh ≤ давления продувки'],
        ['Скоро продувка', cnt(r => r.prio === 3 || r.prio === 4), 'приоритет 4–5'], ['Критическое состояние', cnt(r => r.prio >= 5), ''], ['Прогноз остановок за 24 ч', cnt(r => r.stop24), ''],
        ['Текущий дебит', F(sum('qNow'), 1), 'тыс. м³/сут'], ['Прогноз добычи за 24 ч', F(sum('gas24'), 1), 'тыс. м³'], ['Доп. добыча за ' + (ok[0] ? ok[0].hd : 30) + ' сут', F(sum('extra'), 0), 'тыс. м³'], ['Изменение простоев за ' + (ok[0] ? ok[0].hd : 30) + ' сут', (sum('downCut') <= 0 ? '+' : '−') + F(Math.abs(sum('downCut')), 0) + ' ч', sum('downCut') <= 0 ? 'рост: продувки чаще' : 'сокращение']];
      const COLS = [['field', 'Месторождение'], ['well', 'Скважина'], ['statusText', 'Статус'], ['pwh', 'Pwh тек.'], ['pline', 'Pline тек.'], ['dp', 'ΔP тек.'], ['pwhF', 'Pwh прогн.'], ['plineF', 'Pline прогн.'], ['pwhCrit', 'Pwh крит.'], ['pwhBlow', 'Давл. продувки'], ['toRec', 'До продувки, ч'], ['tStop', 'Прогноз остановки'], ['toStop', 'До остановки, ч'], ['qNow', 'Дебит тек.'], ['qF', 'Дебит прогн.'], ['nOld', 'Продувок (стар.)'], ['nNew', 'Продувок (нов.)'], ['extra', 'Доп. добыча'], ['eff', 'Эффект, %'], ['conf', 'Достоверность'], ['prio', 'Приоритет']];
      const fields = Array.from(new Set(rows.map(r => r.fieldId))).map(id => [id, (rows.find(r => r.fieldId === id) || {}).field]);
      el.innerHTML = '<div class="kpis fund-k stagger">' + kp.map(x => '<div class="kpi"><span>' + x[0] + '</span><b>' + x[1] + '</b><em>' + x[2] + '</em></div>').join('') + '</div>' +
        '<div class="card"><h3>Скважины <span class="sub">' + list.length + ' из ' + rows.length + ' · прогноз на +' + f.h + ' ч от текущего времени</span></h3><div class="toolbar">' +
        '<input id="fq" class="mini" placeholder="Поиск" value="' + esc(f.q) + '" style="width:150px">' +
        '<select id="ff" class="mini"><option value="">Все месторождения</option>' + fields.map(x => '<option value="' + x[0] + '"' + (f.field === x[0] ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select>' +
        '<select id="fs" class="mini"><option value="">Все статусы</option>' + [['normal', 'Нормальная работа'], ['watch', 'Наблюдение'], ['soon', 'Скоро продувка'], ['critical', 'Критическое'], ['stopped', 'Остановка'], ['after', 'После продувки']].map(x => '<option value="' + x[0] + '"' + (f.status === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select>' +
        '<select id="fp" class="mini"><option value="">Все приоритеты</option>' + C.PRIORITIES.map((p, i) => '<option value="' + i + '"' + (f.prio === String(i) ? ' selected' : '') + '>' + p + '</option>').join('') + '</select>' +
        '<label class="small muted">Прогноз на <select id="fh" class="mini">' + [1, 3, 6, 12, 24].map(h => '<option value="' + h + '"' + (f.h === h ? ' selected' : '') + '>+' + h + ' ч</option>').join('') + '</select></label></div>' +
        '<div class="tblwrap fundtbl"><table class="tbl"><thead><tr>' + COLS.map((x, i) => '<th class="' + (i > 2 ? 'num ' : '') + 'sortable" data-k="' + x[0] + '">' + x[1] + (f.sort === x[0] ? (f.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>').join('') + '</tr></thead><tbody>' +
        list.map(r => r.empty ? '<tr data-w="' + r.id + '" class="clk"><td>' + esc(r.field) + '</td><td><b>' + esc(r.well) + '</b></td><td colspan="19" class="muted">нет данных в текущем источнике</td></tr>' :
          '<tr data-w="' + r.id + '" class="clk"><td>' + esc(r.field) + '</td><td><b>' + esc(r.well) + '</b></td><td><span class="sd ' + r.statusCode + '" style="display:inline-block;margin-right:6px"></span>' + esc(r.statusText) + '</td>' +
          '<td class="num">' + F(r.pwh, 2) + '</td><td class="num">' + F(r.pline, 2) + '</td><td class="num">' + F(r.dp, 2) + '</td>' +
          '<td class="num ' + r.fSrc + '">' + F(r.pwhF, 2) + '</td><td class="num ' + r.fSrc + '">' + F(r.plineF, 2) + '</td>' +
          '<td class="num">' + F(r.pwhCrit, 2) + '</td><td class="num">' + F(r.pwhBlow, 2) + '</td><td class="num">' + (r.toRec <= 0 ? '<span class="pill no">сейчас</span>' : F(r.toRec, 1)) + '</td>' +
          '<td>' + (r.working ? fDT(r.tStop).slice(0, 16) : 'остановлена') + '</td><td class="num">' + (r.working ? F(r.toStop, 1) : '—') + '</td>' +
          '<td class="num">' + F(r.qNow, 2) + '</td><td class="num ' + r.fSrc + '">' + F(r.qF, 2) + '</td><td class="num">' + F(r.nOld, 0) + '</td><td class="num">' + F(r.nNew, 0) + '</td>' +
          '<td class="num gain">' + F(r.extra, 0) + '</td><td class="num">' + (isF(r.eff) ? (r.eff >= 0 ? '+' : '') + F(r.eff, 1) : '—') + '</td><td>' + esc(r.confText) + '</td><td><span class="prio p' + r.prio + '">' + esc(r.prioText) + '</span></td></tr>').join('') +
        '</tbody></table></div><p class="note">Прогнозные значения (курсив) — ПРОГНОЗ ядра на момент «сейчас + ' + f.h + ' ч»; «—» — НЕТ ДАННЫХ (вне горизонта обоснованного прогноза). «До продувки» и «до остановки» — от последнего замера скважины. Щелчок по строке открывает карточку скважины.</p></div>';
      const bind = (id, key, num) => { const e = document.getElementById(id); e.oninput = e.onchange = () => { f[key] = num ? +e.value : (key === 'q' ? e.value.trim().toLowerCase() : e.value); if (key === 'h') rows.forEach(r => recalcF(r, c, f.h)); draw(); }; };
      bind('fq', 'q'); bind('ff', 'field'); bind('fs', 'status'); bind('fp', 'prio'); bind('fh', 'h', true);
      el.querySelectorAll('th.sortable').forEach(th => th.onclick = () => { const k2 = th.dataset.k; if (f.sort === k2) f.dir = -f.dir; else { f.sort = k2; f.dir = -1; } draw(); });
      el.querySelectorAll('tr[data-w]').forEach(tr => tr.onclick = () => c.select({ type: 'well', id: tr.dataset.w }, 'dash'));
      const qEl = document.getElementById('fq'); if (f.q && qEl) { qEl.focus(); qEl.setSelectionRange(qEl.value.length, qEl.value.length); }
    };
    rows.forEach(r => recalcF(r, c, f.h)); draw(); void toast;
  };
  function fundRow(R, c) {
    const w = R.w; const fld = c.fieldById(w.fieldId) || {};
    const r = { id: w.id, well: w.name, field: fld.name || '—', fieldId: w.fieldId };
    if (R.empty) return Object.assign(r, { empty: true, prio: -1, statusCode: 'none' });
    const A = R.A, fc = A.forecast, b = A.blow, o = A.opt; r.R = R;
    Object.assign(r, { statusCode: A.status.code, statusText: A.status.text, pwh: fc.pwhNow, pline: fc.plineNow, dp: fc.dpNow, working: fc.mode === 'work',
      pwhCrit: b.ok ? b.pwhCrit : NaN, pwhBlow: b.ok ? b.pwhBlow : NaN, toRec: b.ok ? (b.tRec - fc.tNow) / H : NaN, tStop: fc.tCrit, toStop: fc.remainH,
      qNow: A.flowOK ? fc.qNow / 1000 : NaN, nOld: o.ok ? o.scen.old.nBlow : NaN, nNew: b.ok && isF(b.best.nBlow) ? b.best.nBlow : NaN, extra: b.ok && isF(b.best.extra) ? b.best.extra : NaN, eff: b.ok ? b.best.extraPct : NaN,
      downCut: o.ok && b.ok && isF(b.best.down) ? o.scen.old.down - b.best.down : NaN, conf: A.conf.score, confText: A.conf.level, prio: A.priority.level, prioText: A.priority.text, hd: A.p.horizonDays,
      inWarn: b.ok && fc.mode === 'work' && fc.pwhNow <= b.pwhBlow, stop24: fc.mode !== 'work' || (isF(fc.remainH) && fc.remainH <= 24) });
    // прогноз добычи 24 ч (интеграл дебита по траектории)
    let g = 0; const tr = A.traj; for (let i = 1; i < tr.t.length && tr.t[i] <= fc.tNow + 24 * H; i++) g += (tr.q[i] + tr.q[i - 1]) / 2 * 0.25 / 24 / 1000; r.gas24 = A.flowOK ? g : NaN;
    return r;
  }
  function recalcF(r, c, h) { if (r.empty) return; const v = c.C.valueAt(r.R.A, Date.now() + h * H); r.pwhF = v.pwh; r.plineF = v.pline; r.qF = v.q / 1000; r.fSrc = v.src === 'forecast' ? 'fcv' : v.src === 'fact' ? '' : 'nodata'; }

  /* =========================== АНИМАЦИЯ РАБОЧЕГО ЦИКЛА =========================== */
  const STAGES = ['Скважина после продувки', 'Восстановление рабочего режима', 'Стабильная работа', 'Постепенное снижение Pwh', 'Изменение Pline', 'Сближение давлений', 'Предупредительная зона', 'Достижение критического перепада', 'Прогнозируемая остановка', 'Проведение продувки', 'Восстановление рабочего режима'];
  V.anim = async function (el, R, c) {
    const { S, esc, F, fH, fDT, COL } = c; const A = R.A, s = A.s, b = A.blow, st = A.stats;
    if (!b.ok || !A.cycles.length) { el.innerHTML = '<div class="warnbox">Недостаточно данных для анимации: нужен хотя бы один выявленный цикл и рассчитанное давление продувки.</div>'; return; }
    const opts = A.cycles.filter(x => x.complete).map(x => ['c' + x.k, 'Цикл №' + x.k + ' · ' + fDT(x.tEvent).slice(0, 16) + ' · работа ' + fH(x.workH)]);
    if (A.forecast.mode === 'work') opts.push(['cur', 'Текущий цикл + прогноз ядра']);
    const sel = S.animSel && opts.some(o => o[0] === S.animSel) ? S.animSel : opts[opts.length - 1][0]; S.animSel = sel;
    el.innerHTML = '<div class="card anim"><h3>Анимация рабочего цикла <span class="sub">реальные данные скважины и прогноз расчётного ядра</span><span class="sp"></span>' +
      '<select id="anSel" class="mini">' + opts.map(o => '<option value="' + o[0] + '"' + (o[0] === sel ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></h3>' +
      '<div class="anim-grid"><div><div id="anP"></div><div id="anD" style="margin-top:6px"></div>' +
      '<div class="anim-ctl"><button class="icon-btn" id="anPlay" title="Запуск / пауза"></button><button class="icon-btn" id="anRe" title="Повтор с начала">' + ICO.cycles + '</button>' +
      '<input type="range" id="anPos" min="0" max="1000" value="0" aria-label="Положение"><select id="anSp" class="mini" title="Скорость">' + [0.5, 1, 2, 4, 8].map(x => '<option value="' + x + '"' + (x === (S.animSpeed || 1) ? ' selected' : '') + '>' + x + '×</option>').join('') + '</select></div>' +
      '<div class="anim-read" id="anRead"></div></div>' +
      '<ol class="stages" id="anSt">' + STAGES.map((x, i) => '<li data-i="' + i + '"><span>' + (i + 1) + '</span><b>' + x + '</b><em></em></li>').join('') + '</ol></div>' +
      '<p class="note">Точки: ◆ рекомендуемая продувка (ΔP = ' + F(b.dpTrigger, 2) + '), ● критическая точка (ΔP = ΔPкрит ' + F(st.dpCrit, 2) + '), ■ остановка. Прогнозная часть (для текущего цикла) показана пунктиром.</p></div>';
    const D = buildAnim(A, sel);
    const view = [D.t0, D.t1];
    const mkP = new TChart(document.getElementById('anP'), { animate: false, height: 250, xMin: D.t0, xMax: D.t1, view, y: { zero: true }, yLabel: 'кгс/см²', tooltip: true,
      series: [{ name: 'Pwh', color: COL.pwh, x: D.fx, y: D.fpwh, width: 2, unit: 'кгс/см²' }, { name: 'Pline', color: COL.pline, x: D.fx, y: D.fpl, unit: 'кгс/см²' },
        { name: 'Pwh прогноз', color: COL.pwh, x: D.px, y: D.ppwh, dash: [5, 4], unit: 'кгс/см²', legend: D.px.length > 0 }, { name: 'Pline прогноз', color: COL.pline, x: D.px, y: D.ppl, dash: [5, 4], unit: 'кгс/см²', legend: D.px.length > 0 },
        { name: 'Pwh критическое', color: COL.crit, x: D.cx, y: D.ccrit, dash: [2, 3], width: 1.1, unit: 'кгс/см²' }, { name: 'Давление продувки', color: '#FFD27A', x: D.cx, y: D.cblow, dash: [2, 3], width: 1.1, unit: 'кгс/см²' }] });
    const mkD = new TChart(document.getElementById('anD'), { animate: false, height: 170, xMin: D.t0, xMax: D.t1, view, y: { min: -2 }, legend: true,
      series: [{ name: 'ΔP', color: COL.dp, x: D.fx, y: D.fdp, width: 2, unit: 'кгс/см²', fill: 'rgba(192,140,255,.12)' }, { name: 'ΔP прогноз', color: COL.dp, x: D.px, y: D.pdp, dash: [5, 4], unit: 'кгс/см²', legend: D.px.length > 0 }],
      hlines: [{ y: st.dpCrit, color: COL.crit, label: 'ΔP крит.' }, { y: b.dpTrigger, color: '#FFD27A', label: 'ΔP продувки' }, { y: st.dpCrit + b.dpSafetyMin, color: '#F2B33D', label: 'предупр. зона', dash: [1, 4] }] });
    const pts = [{ x: D.tStop, y: D.at(D.tStop).pwh, color: '#B7C4D1', shape: 'tri', tip: (D.stopFc ? 'Прогнозируемая' : 'Фактическая') + ' остановка: ' + fDT(D.tStop) }, { x: D.tRec, y: D.at(D.tRec).pwh, color: '#FFD27A', shape: 'diamond', tip: 'Рекомендуемая продувка: ' + fDT(D.tRec) }, { x: D.tCritPt, y: D.at(D.tCritPt).pwh, color: COL.crit, tip: 'Критическая точка: ' + fDT(D.tCritPt) }].filter(p => isF(p.x));
    let pos = 0, playing = false, last = 0, raf = 0; const speed = () => S.animSpeed || 1; const dur = 30000;
    const stageAt = (t) => { let k = -1; D.stages.forEach((sg, i) => { if (t >= sg[0] && t <= sg[1]) k = i; }); return k; };
    const frame = () => {
      const t = D.t0 + pos * (D.t1 - D.t0); const fr = pos;
      [mkP, mkD].forEach(ch => { ch.reveal = Math.max(0.001, fr); ch.vlines = [{ x: t, color: '#DDE8F3', dash: [1, 0] }]; });
      mkP.markers = pts.filter(p => p.x <= t); mkD.markers = pts.filter(p => p.x <= t).map(p => Object.assign({}, p, { y: D.at(p.x).dp }));
      mkP.draw(); mkD.draw();
      const k = stageAt(t); const v = D.at(t); const plChange = isF(v.pline) && Math.abs(v.pline - D.pl0) > Math.max(2 * (A.plineM.sigma || 0.05), 0.1) && t > D.tPk && t < D.tStop;
      document.querySelectorAll('#anSt li').forEach((li, i) => { li.classList.toggle('on', i === k); li.classList.toggle('done', k > i && i !== 4); if (i === 4) { li.classList.toggle('on', plChange); li.querySelector('em').textContent = isF(v.pline) && t > D.tPk ? (v.pline - D.pl0 >= 0 ? '+' : '') + F(v.pline - D.pl0, 2) + ' кгс/см² от медианы цикла' : ''; } });
      document.getElementById('anRead').innerHTML = '<span>' + fDT(t) + '</span>' + c.srcBadge(t > D.factEnd ? 'forecast' : 'fact') + '<span>Pwh <b style="color:' + COL.pwh + '">' + F(v.pwh, 2) + '</b></span><span>Pline <b style="color:' + COL.pline + '">' + F(v.pline, 2) + '</b></span><span>ΔP <b style="color:' + COL.dp + '">' + F(v.dp, 2) + '</b></span><span>Этап: <b>' + (k >= 0 ? STAGES[k] : 'Предшествующий простой') + '</b></span>';
      document.getElementById('anPos').value = Math.round(pos * 1000);
    };
    const btn = document.getElementById('anPlay'); const setBtn = () => { btn.innerHTML = playing ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z"/></svg>'; };
    const loop = (ts) => { if (!playing) return; if (last) pos = Math.min(1, pos + (ts - last) / dur * speed()); last = ts; frame(); if (pos >= 1) { playing = false; setBtn(); return; } raf = requestAnimationFrame(loop); };
    const play = () => { if (pos >= 1) pos = 0; playing = true; last = 0; setBtn(); raf = requestAnimationFrame(loop); };
    const pause = () => { playing = false; cancelAnimationFrame(raf); setBtn(); };
    btn.onclick = () => playing ? pause() : play();
    document.getElementById('anRe').onclick = () => { pos = 0; play(); };
    document.getElementById('anPos').oninput = (e) => { pause(); pos = +e.target.value / 1000; frame(); };
    document.getElementById('anSp').onchange = (e) => { S.animSpeed = +e.target.value; };
    document.getElementById('anSel').onchange = (e) => { S.animSel = e.target.value; c.renderView(); };
    S.anim = { stop: () => { playing = false; cancelAnimationFrame(raf); } };
    setBtn(); frame(); const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; if (!reduce) play(); else { pos = 1; frame(); }
  };
  function buildAnim(A, sel) {
    const s = A.s, b = A.blow, st = A.stats, tr = A.traj;
    const D = { fx: [], fpwh: [], fpl: [], fdp: [], px: [], ppwh: [], ppl: [], pdp: [], cx: [], ccrit: [], cblow: [], stages: [] };
    let cyc, tStop, tNextEv, tEnd, stopFc = false, factEnd;
    if (sel === 'cur') {
      cyc = A.forecast.cycle; tStop = A.forecast.tCrit; stopFc = true; factEnd = A.forecast.tNow;
      const rIdx = tr.events.findIndex(e => e.type === 'restart'); tNextEv = rIdx >= 0 ? tr.events[rIdx].t : tStop + st.downMed * H; tEnd = tNextEv + 2 * H;
    } else {
      const k = +sel.slice(1); cyc = A.cycles.find(x => x.k === k); const nx = A.cycles.find(x => x.k === k + 1);
      tStop = cyc.tEnd; tNextEv = nx ? nx.tEvent : NaN; tEnd = nx ? Math.min(nx.tStart + 2 * H, s.t[s.t.length - 1]) : Math.min(cyc.tEnd + 3 * H, s.t[s.t.length - 1]); factEnd = Infinity;
    }
    D.t0 = cyc.tEvent - 0.75 * H; D.t1 = tEnd; D.stopFc = stopFc; D.factEnd = factEnd;
    for (let i = 0; i < s.t.length; i++) { const t = s.t[i]; if (t < D.t0 || t > Math.min(D.t1, factEnd)) continue; D.fx.push(t); D.fpwh.push(s.pwh[i]); D.fpl.push(s.pline[i]); D.fdp.push(s.dp[i]); }
    if (sel === 'cur') for (let i = 0; i < tr.t.length && tr.t[i] <= D.t1; i++) { D.px.push(tr.t[i]); D.ppwh.push(tr.pwh[i]); D.ppl.push(tr.pline[i]); D.pdp.push(tr.phase[i] === 'work' ? tr.dp[i] : NaN); }
    const all = D.fx.map((t, i) => [t, D.fpwh[i], D.fpl[i], D.fdp[i]]).concat(D.px.map((t, i) => [t, D.ppwh[i], D.ppl[i], D.pdp[i]]));
    all.forEach(([t, , pl]) => { const inWork = t >= cyc.tStart && t <= tStop; D.cx.push(t); D.ccrit.push(inWork ? pl + st.dpCrit : NaN); D.cblow.push(inWork ? pl + b.dpTrigger : NaN); });
    D.at = (t) => { let best = null, bd = Infinity; all.forEach(r => { const d = Math.abs(r[0] - t); if (d < bd) { bd = d; best = r; } }); return best ? { pwh: best[1], pline: best[2], dp: best[3] } : {}; };
    const firstBelow = (lvl) => { for (const r of all) if (r[0] >= cyc.tStart && r[0] <= tStop && isF(r[3]) && r[3] <= lvl) return r[0]; return NaN; };
    D.tPk = cyc.tStart + Math.max(0, (A.s.t[cyc.iPeak] - cyc.tStart)); if (!(D.tPk > cyc.tEvent)) D.tPk = cyc.tEvent + 0.25 * H;
    D.tRec = firstBelow(b.dpTrigger); D.tCritPt = firstBelow(st.dpCrit * 1.05 + 0.02); if (!isF(D.tCritPt)) D.tCritPt = tStop; const tWarn = isF(firstBelow(st.dpCrit + b.dpSafetyMin)) ? firstBelow(st.dpCrit + b.dpSafetyMin) : D.tCritPt;
    D.tStop = tStop; { const pls = all.filter(r => r[0] >= cyc.tStart && r[0] <= tStop && isF(r[2])).map(r => r[2]).sort((a, b) => a - b); D.pl0 = pls.length ? pls[Math.floor(pls.length / 2)] : D.at(D.tPk).pline; }
    const e = cyc.tEvent, pk = D.tPk, s3 = pk + 0.25 * (tWarn - pk), s4 = pk + 0.6 * (tWarn - pk);
    const stopLen = Math.min(0.5 * H, isF(tNextEv) ? (tNextEv - tStop) / 3 : 0.5 * H);
    D.stages = [[e, e + Math.min(0.25 * H, (pk - e) / 2)], [e + Math.min(0.25 * H, (pk - e) / 2), pk], [pk, s3], [s3, s4], [NaN, NaN], [s4, tWarn], [tWarn, D.tCritPt], [D.tCritPt, tStop], [tStop, tStop + stopLen], [tStop + stopLen, isF(tNextEv) ? tNextEv : D.t1], [isF(tNextEv) ? tNextEv : D.t1, D.t1]];
    return D;
  }

  /* ============================= ПРОГНОЗ: доп. разделы ============================= */
  V.forecastX = async function (el, R, c, base) {
    await base(el, R);
    const { F, fH, fDT, C, esc } = c;
    const box = document.createElement('div'); box.className = 'card'; box.innerHTML = '<h3>Проверка прогноза на истории <span class="sub">прогноз, сделанный за 1, 2 и 3 ч до фактической остановки, по данным, известным на тот момент</span></h3><p class="muted" id="btWait">Расчёт…</p>';
    el.appendChild(box);
    await new Promise(r => setTimeout(r, 20));
    if (!R.bt) { const sel = GSRC.rawFor(R.ser); R.bt = C.backtest(sel.raw, R.w.params, { excl: R.ser.excl, overrides: R.ser.overrides }); }
    const bt = R.bt;
    if (!bt.rows.length) { box.innerHTML = '<h3>Проверка прогноза на истории</h3><p class="muted">Недостаточно циклов: нужна история не менее 4 завершённых циклов.</p>'; return; }
    box.innerHTML = '<h3>Проверка прогноза на истории <span class="sub">' + bt.rows.length + ' ретроспективных прогнозов</span></h3>' +
      '<div class="grid g3">' + [1, 2, 3].map(L => { const x = bt.by[L]; return '<div class="scen"><h4>За ' + L + ' ч до остановки</h4><div class="big">' + fH(x.mae) + '</div><span class="muted small">средняя абсолютная ошибка · смещение ' + (x.bias >= 0 ? '+' : '') + F(x.bias, 2) + ' ч</span><dl><dt>Факт внутри интервала 10–90%</dt><dd>' + F(x.hit * 100, 0) + '%</dd><dt>Рекомендация раньше остановки</dt><dd>' + F(x.recOK * 100, 0) + '%</dd><dt>Прогнозов</dt><dd>' + x.n + '</dd></dl></div>'; }).join('') + '</div>' +
      '<div class="tblwrap" style="max-height:300px;margin-top:12px"><table class="tbl"><thead><tr><th>Цикл</th><th class="num">Упреждение</th><th>Фактическая остановка</th><th>Прогноз</th><th class="num">Ошибка, ч</th><th>В интервале</th><th>Рекомендация вовремя</th></tr></thead><tbody>' +
      bt.rows.map(r => '<tr><td>№' + r.cycle + '</td><td class="num">' + r.lead + ' ч</td><td>' + fDT(r.actual) + '</td><td>' + fDT(r.pred) + '</td><td class="num">' + (r.errH >= 0 ? '+' : '') + F(r.errH, 2) + '</td><td>' + (r.inBand ? '<span class="pill ok">да</span>' : '<span class="pill no">нет</span>') + '</td><td>' + (r.recBeforeStop ? '<span class="pill ok">да</span>' : '<span class="pill no">нет</span>') + '</td></tr>').join('') + '</tbody></table></div>' +
      '<p class="note">Для каждого завершённого цикла (начиная с 4-го) история обрезается за L часов до фактической остановки, ядро пересчитывает критический перепад, модель шлейфа и прогноз — так проверяется точность без «подглядывания» в будущее.</p>';
    void esc;
  };

  /* ============================ ЖУРНАЛ: точность прогнозов ============================ */
  V.journalX = async function (el, R, c, base) {
    await base(el, R);
    const { F, fDT } = c; const recs = (await GDB.byWell('recs', R.w.id)).filter(r => isF(r.predStop)).sort((a, b) => a.created - b.created);
    const A = R.A; const done = A.done;
    const rows = recs.map(r => { const act = done.find(x => x.tEnd > r.dataTo); return { r, act: act ? act.tEnd : NaN }; }).filter(x => isF(x.act));
    const box = document.createElement('div'); box.className = 'card';
    box.innerHTML = '<h3>Точность сохранённых прогнозов <span class="sub">сравнение прогноза остановки с фактической остановкой, наступившей позже</span></h3>' +
      (rows.length ? '<table class="tbl"><tr><th>Прогноз сделан по данным на</th><th>Прогноз остановки</th><th>Фактическая остановка</th><th class="num">Ошибка, ч</th><th class="num">Давление продувки</th></tr>' + rows.map(x => '<tr><td>' + fDT(x.r.dataTo) + '</td><td>' + fDT(x.r.predStop) + '</td><td>' + fDT(x.act) + '</td><td class="num">' + F((x.r.predStop - x.act) / H, 2) + '</td><td class="num">' + F(x.r.pRec, 2) + '</td></tr>').join('') + '</table>' :
        '<p class="muted">Сравнение появится, когда после сохранённого прогноза поступят данные с фактической остановкой (новый импорт или обновление из PostgreSQL). Ретроспективная проверка на истории — на вкладке «Прогноз».</p>');
    el.appendChild(box);
  };

  /* ======================== МЕСТОРОЖДЕНИЕ: итоги старый/новый ======================== */
  V.fieldTotals = async function (el, c, fieldId) {
    const { F, fH, esc } = c; const ws = c.S.wells.filter(w => w.fieldId === fieldId); const rows = [];
    for (const w of ws) { const R = await c.getAnalysis(w.id); if (R.empty || !R.A.opt.ok || !R.A.blow.ok) continue; rows.push({ w, o: R.A.opt.scen.old, n: R.A.blow.best, hd: R.A.p.horizonDays }); }
    if (!rows.length) return;
    const sum = (f) => rows.reduce((a, x) => a + (isF(f(x)) ? f(x) : 0), 0);
    const tot = { nO: sum(x => x.o.nBlow), nN: sum(x => x.n.nBlow), dO: sum(x => x.o.down), dN: sum(x => x.n.down), lO: sum(x => x.o.losses), lN: sum(x => x.n.losses), wO: sum(x => x.o.work), wN: sum(x => x.n.work), gO: sum(x => x.o.gas), gN: sum(x => x.n.gas) };
    const box = document.createElement('div'); box.className = 'card';
    box.innerHTML = '<h3>Старый и новый режим по месторождению <span class="sub">горизонт ' + rows[0].hd + ' сут, новый режим — рекомендованный сценарий каждой скважины</span></h3><div class="tscroll"><table class="tbl"><tr><th>Скважина</th><th class="num">Продувок стар./нов.</th><th class="num">Цикл стар./нов.</th><th class="num">Простой стар./нов., ч</th><th class="num">Потери газа стар./нов.</th><th class="num">Работа стар./нов., ч</th><th class="num">Добыча стар./нов.</th><th class="num">Доп. добыча</th><th class="num">Изменение</th></tr>' +
      rows.map(x => '<tr><td>' + esc(x.w.name) + '</td><td class="num">' + F(x.o.nBlow, 0) + ' / ' + F(x.n.nBlow, 0) + '</td><td class="num">' + fH(x.o.cycleH) + ' / ' + fH(x.n.cycleH) + '</td><td class="num">' + F(x.o.down, 0) + ' / ' + F(x.n.down, 0) + '</td><td class="num">' + F(x.o.losses, 1) + ' / ' + F(x.n.losses, 1) + '</td><td class="num">' + F(x.o.work, 0) + ' / ' + F(x.n.work, 0) + '</td><td class="num">' + F(x.o.gas, 0) + ' / ' + F(x.n.gas, 0) + '</td><td class="num gain">' + F(x.n.extra, 0) + '</td><td class="num">' + (x.n.extraPct >= 0 ? '+' : '') + F(x.n.extraPct, 1) + '%</td></tr>').join('') +
      '<tr class="total"><td><b>Итого по месторождению</b></td><td class="num">' + F(tot.nO, 0) + ' / ' + F(tot.nN, 0) + '</td><td class="num">—</td><td class="num">' + F(tot.dO, 0) + ' / ' + F(tot.dN, 0) + '</td><td class="num">' + F(tot.lO, 1) + ' / ' + F(tot.lN, 1) + '</td><td class="num">' + F(tot.wO, 0) + ' / ' + F(tot.wN, 0) + '</td><td class="num">' + F(tot.gO, 0) + ' / ' + F(tot.gN, 0) + '</td><td class="num gain"><b>' + F(tot.gN - tot.gO, 0) + '</b></td><td class="num"><b>' + (tot.gN >= tot.gO ? '+' : '') + F((tot.gN / tot.gO - 1) * 100, 1) + '%</b></td></tr></table></div>';
    el.querySelector('.pane').appendChild(box);
  };

  /* ================================ ИСТОЧНИКИ ДАННЫХ ================================ */
  V.sources = async function (el, c) {
    const { esc, F, fDT, toast, modal } = c; const g = GSRC.st;
    let conns = [], gwOk = null, gwErr = '';
    const NAT = GSRC.native() && !g.legacy; let natHtml = '';
    if (NAT) natHtml = await App.GPN.onlineHtml(c);
    if (g.token && !NAT) { try { conns = await GSRC.api('/api/connections'); gwOk = true; } catch (e) { gwOk = false; gwErr = e.message; } }
    const wells = c.S.wells; const sers = await GDB.all('series');
    const offN = sers.reduce((a, x) => a + (x.pwh ? x.pwh.t.length + x.pline.t.length : 0), 0), onN = sers.reduce((a, x) => a + (x.online ? x.online.pwh.t.length + x.online.pline.t.length : 0), 0);
    const offW = sers.filter(x => x.pwh && x.pwh.t.length).length, onW = sers.filter(x => x.online && x.online.pwh.t.length).length;
    const files = []; sers.forEach(x => (x.imports || []).forEach(i => { const w = wells.find(w2 => w2.id === x.wellId); files.push(Object.assign({ well: w ? w.name : '?' }, i)); }));
    const cur = conns.find(x => x.id === g.connId) || null; const edit = c.S.srcEdit ? conns.find(x => x.id === c.S.srcEdit) || null : cur;
    const confl = []; if (g.mode === 'merged') for (const w of wells) { const R = await c.getAnalysis(w.id); if (R.conflicts) R.conflicts.slice(0, 50).forEach(x => confl.push(Object.assign({ well: w.name }, x))); }
    const ST = { ok: ['ok', 'подключено'], error: ['err', 'нет соединения'], connecting: ['busy', 'обновление…'], idle: ['idle', 'ожидание'], off: ['idle', 'не подключено'] };
    el.innerHTML = '<div class="card"><h3>Текущий источник данных</h3><div class="srcmodes">' +
      ['offline', 'online', 'merged'].map(m => '<button class="srcmode' + (g.mode === m ? ' on' : '') + '" data-m="' + m + '"><b>' + GSRC.MODES[m] + '</b><span>' + ({ offline: 'Excel/CSV/7z, загруженные в программу. Работает без сети и PostgreSQL.', online: 'Измерения из PostgreSQL (прямое подключение), автоматическое обновление.', merged: 'Сопоставление Excel и PostgreSQL с проверкой дублей и конфликтов.' })[m] + '</span></button>').join('') + '</div>' +
      '<div class="kpis" style="grid-template-columns:repeat(6,minmax(0,1fr));margin:12px 0 0">' +
      '<div class="kpi"><span>Источник</span><b>' + (g.mode === 'offline' ? 'OFFLINE' : g.mode === 'online' ? 'ONLINE' : 'ОБЪЕДИН.') + '</b><em>' + GSRC.MODES[g.mode] + '</em></div>' +
      '<div class="kpi"><span>Подключение</span><b>' + esc(g.connName || '—') + '</b><em>' + (g.connId ? 'PostgreSQL' : 'не выбрано') + '</em></div>' +
      '<div class="kpi"><span>Статус</span><b><span class="sdot ' + ST[g.status][0] + '"></span> ' + ST[g.status][1] + '</b><em>' + esc(g.lastErr || '') + '</em></div>' +
      '<div class="kpi"><span>Последнее обновление</span><b>' + (g.lastOk ? fDT(g.lastOk).slice(11) : '—') + '</b><em>' + (g.lastOk ? fDT(g.lastOk).slice(0, 10) + ' · +' + g.lastCount + ' записей' : '') + '</em></div>' +
      '<div class="kpi"><span>Скважин (Excel / Online)</span><b>' + offW + ' / ' + onW + '</b><em>всего в базе ' + wells.length + '</em></div>' +
      '<div class="kpi"><span>Измерений (Excel / Online)</span><b>' + F(offN, 0) + ' / ' + F(onN, 0) + '</b><em>получено за сеанс ' + F(g.totalRows, 0) + '</em></div></div>' +
      '<p class="note">Переключение источника выполняется только вручную с подтверждением и фиксируется в журнале. Расчёты для всех источников выполняет одно ядро — методика не зависит от происхождения данных.</p></div>' +
      // OFFLINE
      '<div class="grid g2"><div class="card' + (NAT ? ' span2' : '') + '"><h3>OFFLINE — Excel</h3><p class="muted small">.xlsx, .xls (Excel 97-2003), .csv, архивы .7z из SCADA. Можно выбрать несколько файлов; в табличном режиме поддерживаются столбцы «Месторождение» и «Скважина» — данные по многим скважинам загружаются за один раз.</p>' +
      '<div class="actions"><button class="tbtn primary" id="sImp">' + ICO.upload + 'Загрузить файлы</button></div>' +
      '<div class="tblwrap" style="max-height:220px;margin-top:10px"><table class="tbl"><thead><tr><th>Файл</th><th>Скважина</th><th>Загружен</th><th class="num">Новых замеров</th></tr></thead><tbody>' + (files.length ? files.slice(-40).reverse().map(x => '<tr><td>' + esc(x.file) + '</td><td>' + esc(x.well) + '</td><td>' + fDT(x.date) + '</td><td class="num">' + x.added + '</td></tr>').join('') : '<tr><td colspan=4 class="muted">Файлы ещё не загружались</td></tr>') + '</tbody></table></div></div>' +
      // ONLINE
      (NAT ? natHtml : (GSRC.native() ? '' : '<div class="card"><h3>ONLINE — PostgreSQL</h3><div class="warnbox info">' + ICO.info + '<div><b>Прямое подключение к PostgreSQL</b> выполняет настольная программа ГазПродувка.exe — без шлюзов, Node.js и дополнительных служб. В обычном браузере прямое подключение запрещено требованиями безопасности.</div></div><details class="adv"><summary>Режим совместимости: локальный шлюз Node.js (устаревший)</summary>') +
      '<div class="card"><h3>ONLINE — PostgreSQL через локальный шлюз <span class="sp"></span><span class="badge ' + (gwOk ? 'high' : gwOk === false ? 'low' : '') + '">шлюз: ' + (gwOk ? 'доступен' : gwOk === false ? 'недоступен' : 'не настроен') + '</span></h3>' +
      '<div class="form"><div class="fg"><label>Адрес локального шлюза</label><input id="gwUrl" value="' + esc(g.gwUrl) + '"></div><div class="fg"><label>Токен шлюза <span class="tip" title="Выводится при запуске шлюза; команда: node gazproduvka-gateway.js token">?</span></label><input id="gwTok" type="password" value="' + esc(g.token) + '" autocomplete="off"></div></div>' +
      '<div class="actions" style="margin-top:8px"><button class="tbtn" id="gwSave">Проверить шлюз</button><button class="tbtn" id="gwHelp">' + ICO.info + 'Как запустить шлюз</button></div>' + (gwErr ? '<div class="warnbox err" style="margin-top:10px">' + ICO.warn + '<div>' + esc(gwErr) + '</div></div>' : '') +
      (gwOk ? '<div class="tblwrap" style="max-height:200px;margin-top:10px"><table class="tbl"><thead><tr><th>Подключение</th><th>Сервер</th><th>База / схема</th><th>Пароль</th><th></th></tr></thead><tbody>' + (conns.length ? conns.map(x => '<tr><td><b>' + esc(x.name) + '</b>' + (x.id === g.connId ? ' <span class="pill ok">активно</span>' : '') + '</td><td>' + esc(x.host + ':' + x.port) + '</td><td>' + esc(x.database + ' / ' + x.schema) + '</td><td>' + (x.hasPassword ? '<span class="pill ok">задан в шлюзе</span>' : '<span class="pill no">не задан</span>') + '</td><td><button class="mini" data-ed="' + x.id + '">Открыть</button></td></tr>').join('') : '<tr><td colspan=5 class="muted">Подключений нет</td></tr>') + '</tbody></table></div><div class="actions" style="margin-top:8px"><button class="tbtn primary" id="cNew">' + ICO.plus + 'Новое подключение</button></div>' : '') + '</div>' +
      (gwOk ? connWindow(edit, g, esc) : '') + (GSRC.native() ? '' : '</details></div>')) + '</div>' +
      (g.mode === 'merged' ? '<div class="card"><h3>Конфликты значений при объединении <span class="sub">' + confl.length + ' (показаны до 50 на скважину)</span><span class="sp"></span><label class="small muted">Приоритетный источник <select id="prio" class="mini"><option value="online"' + (g.priority === 'online' ? ' selected' : '') + '>PostgreSQL</option><option value="offline"' + (g.priority === 'offline' ? ' selected' : '') + '>Excel</option></select></label></h3>' +
        (confl.length ? '<div class="tblwrap" style="max-height:300px"><table class="tbl"><thead><tr><th>Скважина</th><th>Параметр</th><th>Время</th><th class="num">Excel</th><th class="num">PostgreSQL</th><th>Использовано</th></tr></thead><tbody>' + confl.map(x => '<tr><td>' + esc(x.well) + '</td><td>' + (x.key === 'pwh' ? 'Pwh' : 'Pline') + '</td><td>' + fDT(x.t) + '</td><td class="num">' + F(x.offline, 3) + '</td><td class="num">' + F(x.online, 3) + '</td><td>' + (x.used === 'online' ? 'PostgreSQL' : 'Excel') + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">Конфликтов нет: совпадающие по времени (±30 с) записи совпадают по значению в пределах допуска ' + g.tolerance + ' кгс/см².</p>') + '</div>' : '') +
      '<div class="card"><h3>Журнал переключений источника</h3>' + ((g.modeLog || []).length ? '<table class="tbl">' + g.modeLog.slice().reverse().map(x => '<tr><td>' + fDT(x.t) + '</td><td>' + GSRC.MODES[x.from] + ' → <b>' + GSRC.MODES[x.to] + '</b></td><td class="muted">' + esc(x.why) + '</td></tr>').join('') + '</table>' : '<p class="muted">Переключений не было.</p>') + '</div>';
    // привязки (если за время ожидания вид перерисован — эта копия уже не на экране)
    if (!el.isConnected) return;
    el.querySelectorAll('.srcmode').forEach(bn => bn.onclick = async () => {
      const m = bn.dataset.m; if (m === g.mode) return;
      if (m !== 'offline' && !GSRC.active()) { toast('Сначала получите данные из PostgreSQL: «Получить данные» → PostgreSQL', true); return; }
      const okk = await modal('Смена источника данных', '<p>Переключить источник с <b>' + GSRC.MODES[g.mode] + '</b> на <b>' + GSRC.MODES[m] + '</b>?</p><p class="muted small">Все расчёты, прогнозы и отчёты будут пересчитаны по данным выбранного источника. Данные другого источника сохраняются и не изменяются.</p><div class="fg"><label>Причина (для журнала)</label><input id="why"></div>', [{ t: 'Отмена', v: 0 }, { t: 'Переключить', v: 1, primary: true, check: (ov) => { c.S._why = ov.querySelector('#why').value; return true; } }], 'sm');
      if (!okk) return; await GSRC.setMode(m, c.S._why); c.S.cache = {}; await c.loadAll(); c.renderTree(); toast('Источник данных: ' + GSRC.MODES[m]); c.renderView();
      if (m !== 'offline') GSRC.sync('переключение источника');
    });
    document.getElementById('sImp').onclick = () => c.importWizard();
    if (NAT) App.GPN.bindOnline(el, c);
    if (document.getElementById('gwSave')) document.getElementById('gwSave').onclick = async () => { g.gwUrl = document.getElementById('gwUrl').value.trim(); g.token = document.getElementById('gwTok').value.trim(); await GSRC.save(); try { const h = await fetch(g.gwUrl.replace(/\/$/, '') + '/api/health', { headers: { 'X-GP-Token': g.token } }).then(r => r.json()); toast(h.auth ? 'Шлюз доступен, токен принят (версия ' + h.version + ')' : 'Шлюз доступен, но токен неверный', !h.auth); } catch (e) { toast('Шлюз недоступен: ' + g.gwUrl, true); } c.renderView(); };
    if (document.getElementById('gwHelp')) document.getElementById('gwHelp').onclick = () => modal('Локальный шлюз PostgreSQL', gwHelp(), null);
    el.querySelectorAll('[data-ed]').forEach(bn => bn.onclick = () => { c.S.srcEdit = bn.dataset.ed; c.renderView(); });
    const cn = document.getElementById('cNew'); if (cn) cn.onclick = () => { c.S.srcEdit = 'new'; c.renderView(); };
    const pr = document.getElementById('prio'); if (pr) pr.onchange = async () => { g.priority = pr.value; await GSRC.save(); c.S.cache = {}; c.renderView(); };
    if (gwOk) bindConn(el, c, edit, conns);
  };
  function gwHelp() {
    return '<div class="small" style="line-height:1.6"><p>Браузер не подключается к PostgreSQL напрямую и не получает пароль. Подключение выполняет локальный шлюз <b>gazproduvka-gateway.js</b> (Node.js 18+, без дополнительных пакетов), работающий только на адресе 127.0.0.1.</p><ol>' +
      '<li>Запустите шлюз: <code>node gazproduvka-gateway.js</code> — в консоли появится токен.</li><li>Вставьте адрес и токен в этом окне и нажмите «Проверить шлюз».</li><li>Создайте подключение (host, port, database, username, schema, таблица).</li>' +
      '<li>Задайте пароль <b>в консоли шлюза</b>: <code>node gazproduvka-gateway.js set-password "Название подключения"</code>. Пароль шифруется AES-256-GCM; поддерживается и стандартный файл .pgpass.</li><li>Нажмите «Проверить соединение», затем «Определить структуру» и сопоставьте поля.</li><li>«Подключиться» — загрузка истории за выбранный период и автообновление.</li></ol>' +
      '<p>Шлюз выполняет только параметризованные SELECT-запросы в режиме read-only, проверяет имена таблиц и столбцов по схеме базы, ограничивает объём выборки и поддерживает TLS. Рекомендуется отдельная учётная запись PostgreSQL только с правом SELECT.</p></div>';
  }
  const FIELDS = App.MAP_FIELDS = [['fieldId', 'ID месторождения', 1], ['fieldName', 'Название месторождения', 1], ['wellId', 'ID скважины', 1], ['wellName', 'Название скважины', 1], ['ts', 'Timestamp измерения', 0], ['date', 'Дата измерения (если нет timestamp)', 0], ['time', 'Время измерения', 0], ['pwh', 'Pwh — давление на голове', 1], ['pline', 'Pline — давление на шлейфе', 1], ['recId', 'Уникальный ID записи', 0], ['updatedAt', 'Время изменения записи', 0], ['choke', 'Диаметр штуцера', 0], ['rate', 'Дебит газа', 0], ['temp', 'Температура газа', 0], ['gamma', 'Отн. плотность газа', 0], ['status', 'Статус работы скважины', 0]];
  const GUESS = App.MAP_GUESS = { fieldId: /^(field|mest|месторожд).*id|^field_?id$/i, fieldName: /field.*name|месторожд|^field$/i, wellId: /^(well|скв).*id$|^well_?id$|^well_?(no|num|code)$/i, wellName: /well.*name|скважин|^well$/i, ts: /time.?stamp|meas.*time|^ts$|datetime|дата.?время/i, date: /^date$|meas.*date|^дата$/i, time: /^time$|^время$/i, pwh: /pwh|p_?wh|устье|head|буфер/i, pline: /pline|p_?line|шлейф|flowline/i, recId: /^id$|^rid$|rec.*id|row.*id/i, updatedAt: /updated|modified|изменен/i, choke: /choke|штуцер/i, rate: /^rate$|^q$|дебит|flow_?rate/i, temp: /temp|температ/i, gamma: /gamma|density|плотност/i, status: /status|state|статус/i };
  App.MAP = { FIELDS, GUESS };
  V.optsDialog = async function (c) {
    const { toast, modal } = c; const g = GSRC.st;
      const box = document.createElement('div');
      box.innerHTML = '<div class="form"><div class="fg"><label>Интервал автообновления</label><select id="oInt">' + [[0, 'Только вручную'], [1, '1 минута'], [5, '5 минут'], [15, '15 минут'], [30, '30 минут'], [60, '1 час'], [-1, 'Пользовательский']].map(o => '<option value="' + o[0] + '"' + ((g.intervalMin === o[0]) || (o[0] === -1 && ![0, 1, 5, 15, 30, 60].includes(g.intervalMin)) ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
        '<div class="fg"><label>Пользовательский интервал, мин</label><input id="oCust" value="' + g.intervalMin + '"></div>' +
        '<div class="fg"><label>Обновлять при открытии программы</label><select id="oOpen"><option value="1"' + (g.onOpen ? ' selected' : '') + '>Да</option><option value="0"' + (!g.onOpen ? ' selected' : '') + '>Нет</option></select></div>' +
        '<div class="fg"><label>Обновлять при открытии карточки скважины</label><select id="oCard"><option value="1"' + (g.onCard ? ' selected' : '') + '>Да</option><option value="0"' + (!g.onCard ? ' selected' : '') + '>Нет</option></select></div>' +
        '<div class="fg"><label>Глубина первичной загрузки истории, сут</label><input id="oHist" value="' + g.historyDays + '"></div><div class="fg"><label>Размер страницы выборки, строк</label><input id="oPage" value="' + g.pageSize + '"></div>' +
        '<div class="fg"><label>Допуск совпадения при объединении, кгс/см²</label><input id="oTol" value="' + g.tolerance + '"></div><div class="fg"><label>Загрузить историю заново</label><select id="oReset"><option value="0">Нет — только новые и изменённые записи</option><option value="1">Да — при следующем обновлении</option></select></div></div>';
      await modal('Параметры получения данных', box, [{ t: 'Отмена', v: 0 }, { t: 'Сохранить', v: 1, primary: true, check: async () => {
        const q = (id) => box.querySelector('#' + id).value; let iv = +q('oInt'); if (iv === -1) iv = Math.max(0.5, +q('oCust') || 5);
        g.intervalMin = iv; g.onOpen = q('oOpen') === '1'; g.onCard = q('oCard') === '1'; g.historyDays = Math.max(1, +q('oHist') || 30); g.pageSize = Math.min(50000, Math.max(100, +q('oPage') || 5000)); g.tolerance = Math.max(0, +String(q('oTol')).replace(',', '.') || 0.05);
        if (q('oReset') === '1') { g.cursor = null; (g.datasets || []).forEach(d => { d.cursor = null; }); } await GSRC.save(); GSRC.schedule(); toast('Параметры получения данных сохранены'); return true; } }]);
  };

  function connWindow(cn, g, esc) {
    if (!cn && GSRC.st.connId == null && !App.S.srcEdit) return '';
    const isNew = App.S.srcEdit === 'new' || !cn; const x = isNew ? { name: '', host: '', port: 5432, database: '', user: '', schema: 'public', ssl: 'prefer', tz: 'Asia/Tashkent' } : cn;
    const mp = (x.mapping) || {};
    return '<div class="card conn"><h3>Подключение к PostgreSQL' + (isNew ? ' — новое' : ': ' + esc(x.name)) + '</h3><div class="form">' +
      [['name', 'Название подключения'], ['host', 'Host / IP-адрес сервера'], ['port', 'Port'], ['database', 'Database'], ['user', 'Username']].map(([k, l]) => '<div class="fg"><label>' + l + '</label><input data-c="' + k + '" value="' + esc(x[k] == null ? '' : x[k]) + '"></div>').join('') +
      '<div class="fg"><label>Password</label><input disabled value="' + (x.hasPassword ? '••••••••  (хранится в шлюзе)' : 'задаётся в шлюзе') + '"><em>Пароль не вводится в браузере: <code>node gazproduvka-gateway.js set-password "' + esc(x.name || 'Название') + '"</code></em></div>' +
      '<div class="fg"><label>Schema</label><input data-c="schema" value="' + esc(x.schema || 'public') + '"></div><div class="fg"><label>Таблица или представление с измерениями</label><input data-c="table" value="' + esc(mp.table || x.table || '') + '" placeholder="определится по структуре"></div>' +
      '<div class="fg"><label>Шифрование TLS</label><select data-c="ssl">' + [['prefer', 'Если поддерживается (prefer)'], ['require', 'Обязательно (require)'], ['verify-full', 'Обязательно с проверкой сертификата'], ['disable', 'Отключено']].map(o => '<option value="' + o[0] + '"' + (x.ssl === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
      '<div class="fg"><label>Часовой пояс данных</label><input data-c="tz" value="' + esc(x.tz || 'Asia/Tashkent') + '"></div></div>' +
      '<div class="actions" style="margin-top:12px"><button class="tbtn primary" id="cConnect"' + (isNew ? ' disabled' : '') + '>Подключиться</button><button class="tbtn" id="cTest"' + (isNew ? ' disabled' : '') + '>Проверить соединение</button><button class="tbtn" id="cSave">Сохранить подключение</button><button class="tbtn" id="cDisc"' + (x.id !== g.connId ? ' disabled' : '') + '>Отключиться</button><button class="tbtn" id="cSync"' + (x.id !== g.connId ? ' disabled' : '') + '>Обновить данные</button><button class="tbtn" id="cOpts">' + ICO.gear + 'Параметры получения данных</button>' + (isNew ? '' : '<button class="tbtn" id="cIntro">Определить структуру и сопоставить поля</button><button class="tbtn" id="cDel">' + ICO.trash + 'Удалить</button>') + '</div>' +
      '<div id="cRes"></div><div id="cMap"></div></div>';
  }
  function bindConn(el, c, cn, conns) {
    const { toast, modal, esc, fDT } = c; const g = GSRC.st; const res = document.getElementById('cRes'); if (!document.getElementById('cSave')) return;
    const read = () => { const o = {}; el.querySelectorAll('[data-c]').forEach(i => { o[i.dataset.c] = i.value.trim(); }); o.port = +o.port || 5432; return o; };
    const show = (ok, html) => { res.innerHTML = '<div class="warnbox ' + (ok ? 'info' : 'err') + '" style="margin-top:12px">' + (ok ? ICO.info : ICO.warn) + '<div>' + html + '</div></div>'; };
    document.getElementById('cSave').onclick = async () => { const o = read(); try { const r = cn && c.S.srcEdit !== 'new' ? await GSRC.api('/api/connections/' + cn.id, { method: 'PUT', body: o }) : await GSRC.api('/api/connections', { method: 'POST', body: o }); c.S.srcEdit = r.id; toast('Подключение сохранено'); c.renderView(); } catch (e) { show(false, esc(e.message)); } };
    if (!cn || c.S.srcEdit === 'new') return;
    document.getElementById('cTest').onclick = async () => { show(true, 'Проверка соединения…'); try { const r = await GSRC.api('/api/connections/' + cn.id + '/test', { method: 'POST' }); show(true, '<b>Соединение установлено</b> за ' + r.ms + ' мс. ' + esc(String(r.v).split(' on ')[0]) + ', пользователь <b>' + esc(r.u) + '</b>, база ' + esc(r.d) + ', TLS: ' + (r.tls ? 'да' : 'нет') + (r.priv === false ? '. <b>Нет права SELECT на таблицу измерений.</b>' : r.priv ? ', право SELECT подтверждено.' : '.')); } catch (e) { show(false, '<b>Ошибка подключения:</b> ' + esc(e.message) + (/Пароль не задан/.test(e.message) ? '<br>Задайте пароль в консоли: <code>node gazproduvka-gateway.js set-password "' + esc(cn.name) + '"</code>' : '')); } };
    document.getElementById('cConnect').onclick = async () => { if (!cn.mapping) { show(false, 'Сначала сопоставьте поля (кнопка «Определить структуру и сопоставить поля»).'); return; } show(true, 'Загрузка измерений за ' + g.historyDays + ' сут…'); GSRC.st.unit = (cn.mapping && cn.mapping.unit) || 'кгс/см²'; const r = await GSRC.connect(cn); if (r.ok) { show(true, 'Подключено. Получено записей: <b>' + r.count + '</b>, скважин: ' + r.wells + '. Автообновление каждые ' + g.intervalMin + ' мин.'); if (g.mode === 'offline') toast('Данные получены. Для анализа по ним переключите источник на ONLINE или «Объединённые».'); await c.loadAll(); c.renderTree(); } else show(false, esc(r.error)); c.renderSrcPill(); };
    document.getElementById('cDisc').onclick = async () => { await GSRC.disconnect(); toast('Отключено от PostgreSQL. Полученные ранее данные сохранены локально.'); c.renderView(); };
    document.getElementById('cSync').onclick = async () => { const r = await GSRC.sync('вручную'); toast(r.ok ? 'Получено новых записей: ' + r.count : 'Ошибка: ' + r.error, !r.ok); c.renderView(); };
    document.getElementById('cDel').onclick = async () => { if (!await c.confirmBox('Удалить подключение «' + esc(cn.name) + '» из шлюза? Полученные данные в программе сохранятся.')) return; await GSRC.api('/api/connections/' + cn.id, { method: 'DELETE' }); if (g.connId === cn.id) await GSRC.disconnect(); c.S.srcEdit = null; c.renderView(); };
    document.getElementById('cOpts').onclick = () => V.optsDialog(c);
    document.getElementById('cIntro').onclick = async () => {
      const box = document.getElementById('cMap'); box.innerHTML = '<p class="muted">Определение структуры…</p>';
      let tabs; try { tabs = await GSRC.api('/api/connections/' + cn.id + '/introspect'); } catch (e) { box.innerHTML = '<div class="warnbox err">' + esc(e.message) + '</div>'; return; }
      const mp = cn.mapping || {}; const mainT = mp.table || (tabs.find(t => /meas|измер|data|scada/i.test(t.name)) || tabs[0] || {}).name;
      const joins = (mp.joins || []).slice();
      const render = () => {
        const tMain = tabs.find(t => t.name === mainTSel()) || tabs[0]; const aliases = [['m', tMain]].concat(joins.map((j, k) => ['j' + (k + 1), tabs.find(t => t.name === j.table)]));
        const colOpts = (sel) => '<option value="">— нет —</option>' + aliases.map(([a, t]) => t ? t.columns.map(cl => { const v = a + '.' + cl.name; return '<option value="' + esc(v) + '"' + (sel === v ? ' selected' : '') + '>' + esc(a + '.' + cl.name + ' (' + cl.type + ')') + '</option>'; }).join('') : '').join('');
        const guess = (k) => { if (mp.fields && mp.fields[k]) return mp.fields[k].includes('.') ? mp.fields[k] : 'm.' + mp.fields[k]; for (const [a, t] of aliases) { if (!t) continue; const cl = t.columns.find(x => GUESS[k].test(x.name)); if (cl) return a + '.' + cl.name; } return ''; };
        box.innerHTML = '<div class="fs" style="margin-top:14px">Структура базы: ' + tabs.length + ' таблиц и представлений</div><div class="form"><div class="fg"><label>Основная таблица / VIEW (m)</label><select id="mT">' + tabs.map(t => '<option value="' + esc(t.name) + '"' + (t.name === tMain.name ? ' selected' : '') + '>' + esc(t.name) + ' — ' + t.type + ' (' + t.columns.length + ' столбцов)</option>').join('') + '</select></div><div class="fg"><label>Связи с другими таблицами</label><button class="mini" id="jAdd">+ добавить связь</button></div></div>' +
          '<div id="jList">' + joins.map((j, k) => '<div class="jrow"><b>j' + (k + 1) + '</b><select data-j="' + k + '" data-f="table">' + tabs.map(t => '<option' + (t.name === j.table ? ' selected' : '') + '>' + esc(t.name) + '</option>').join('') + '</select><select data-j="' + k + '" data-f="type"><option value="left"' + (j.type !== 'inner' ? ' selected' : '') + '>LEFT JOIN</option><option value="inner"' + (j.type === 'inner' ? ' selected' : '') + '>INNER JOIN</option></select><span>ON</span><select data-j="' + k + '" data-f="l">' + colOpts((j.on && j.on[0] && j.on[0][0]) || '') + '</select><span>=</span><select data-j="' + k + '" data-f="r">' + ((tabs.find(t => t.name === j.table) || { columns: [] }).columns.map(cl => '<option value="' + esc(cl.name) + '"' + (j.on && j.on[0] && j.on[0][1] === cl.name ? ' selected' : '') + '>j' + (k + 1) + '.' + esc(cl.name) + '</option>').join('')) + '</select><button class="mini" data-jdel="' + k + '">✕</button></div>').join('') + '</div>' +
          '<div class="form" style="margin-top:10px">' + FIELDS.map(([k, l, req]) => '<div class="fg"><label>' + l + (req ? ' <span class="req">*</span>' : '') + '</label><select data-mf="' + k + '">' + colOpts(guess(k)) + '</select></div>').join('') +
          '<div class="fg"><label>Единицы давления в базе</label><select id="mU">' + Object.keys(GIO.UNITS).map(u => '<option' + ((mp.unit || 'кгс/см²') === u ? ' selected' : '') + '>' + u + '</option>').join('') + '</select></div></div>' +
          '<div class="actions" style="margin-top:10px"><button class="tbtn primary" id="mSave">Сохранить сопоставление</button><button class="tbtn" id="mWells">Проверить: список скважин</button></div><div id="mRes"></div>';
        box.querySelector('#mT').onchange = render; box.querySelector('#jAdd').onclick = () => { joins.push({ table: tabs[0].name, type: 'left', on: [['m.' + tMain.columns[0].name, tabs[0].columns[0].name]] }); render(); };
        box.querySelectorAll('[data-j]').forEach(s2 => s2.onchange = () => { const j = joins[+s2.dataset.j]; const f = s2.dataset.f; j.on = j.on || [['', '']]; if (f === 'table') { j.table = s2.value; j.on = [[j.on[0][0], (tabs.find(t => t.name === s2.value).columns[0] || {}).name]]; } else if (f === 'type') j.type = s2.value; else if (f === 'l') j.on[0][0] = s2.value; else j.on[0][1] = s2.value; render(); });
        box.querySelectorAll('[data-jdel]').forEach(bn => bn.onclick = () => { joins.splice(+bn.dataset.jdel, 1); render(); });
        box.querySelector('#mSave').onclick = async () => {
          const fields = {}; box.querySelectorAll('[data-mf]').forEach(s2 => { if (s2.value) fields[s2.dataset.mf] = s2.value; });
          const body = { table: box.querySelector('#mT').value, joins: joins.map(j => ({ table: j.table, type: j.type || 'left', on: j.on })), fields, unit: box.querySelector('#mU').value };
          try { await GSRC.api('/api/connections/' + cn.id + '/mapping', { method: 'PUT', body }); cn.mapping = body; box.querySelector('#mRes').innerHTML = '<div class="warnbox info" style="margin-top:10px">' + ICO.info + '<div>Сопоставление сохранено и проверено по структуре базы. Теперь можно нажать «Подключиться».</div></div>'; document.getElementById('cConnect').disabled = false; }
          catch (e) { box.querySelector('#mRes').innerHTML = '<div class="warnbox err" style="margin-top:10px">' + esc(e.message) + '</div>'; }
        };
        box.querySelector('#mWells').onclick = async () => { try { const ws = await GSRC.api('/api/connections/' + cn.id + '/wells'); box.querySelector('#mRes').innerHTML = '<div class="tblwrap" style="max-height:240px;margin-top:10px"><table class="tbl"><thead><tr><th>Месторождение</th><th>Скважина</th><th class="num">Записей</th><th>Период</th></tr></thead><tbody>' + ws.map(w => '<tr><td>' + esc(w.fn != null ? w.fn : w.f) + '</td><td>' + esc(w.wn != null ? w.wn : w.w) + '</td><td class="num">' + w.n + '</td><td>' + esc(String(w.t0).replace('T', ' ')) + ' – ' + esc(String(w.t1).replace('T', ' ')) + '</td></tr>').join('') + '</tbody></table></div>'; } catch (e) { box.querySelector('#mRes').innerHTML = '<div class="warnbox err" style="margin-top:10px">' + esc(e.message) + ' — сначала сохраните сопоставление.</div>'; } };
      };
      let mainSel = mainT; const mainTSel = () => { const e = document.getElementById('mT'); if (e) mainSel = e.value; return mainSel; };
      render();
    };
    void conns; void fDT;
  }
})();
