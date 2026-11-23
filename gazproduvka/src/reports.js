/* ============================================================================
   REPORTS: модель отчёта → предпросмотр HTML, Word (.docx), Excel (.xlsx),
   PowerPoint (.pptx). Значения маркируются ФАКТ / ПРОГНОЗ / НЕТ ДАННЫХ.
   Все величины берутся из единого ядра (GCORE): valueAt, traj, blow, opt.
   ========================================================================== */
const GREP = (function () {
  'use strict';
  const C = GCORE, H = 3600000, isF = Number.isFinite, fH = C.fmtH, fDT = C.fmtDT, F = (v, d) => TChart.fmtNum(v, d);
  const MARK = { fact: 'ФАКТ', forecast: 'ПРОГНОЗ', none: 'НЕТ ДАННЫХ' };
  const LC = { pwh: '#D98E04', pline: '#1F7FB8', dp: '#7A4FC9', q: '#1E9E6A', old: '#D4553B', neu: '#12968A', crit: '#D7263D', cum: '#2F9E77', stop: '#8899AA', blow: '#C99A00' };
  const DC = { pwh: '#F2B33D', pline: '#4FB3E8', dp: '#C08CFF', q: '#46D69A', old: '#E8715A', neu: '#27C3AE', crit: '#FF5A6E', cum: '#8FE3C4', stop: '#7F93A8', blow: '#FFD27A' };
  const TYPES = {
    well: 'Отчёт по скважине', field: 'Сводный отчёт по месторождению', stops: 'Отчёт по прогнозируемым остановкам',
    opt: 'Отчёт по оптимизации продувок', eff: 'Отчёт по эффективности', brief: 'Краткий производственный отчёт'
  };
  const SCEN = { current: 'Существующий режим (продувка после остановки)', best: 'Рекомендуемый сценарий (лучший по добыче)', early: 'Ранняя продувка', opt: 'Оптимальная продувка', late: 'Поздняя продувка' };

  /* ------------------------------- графики ------------------------------------ */
  function fcCharts(R, theme, t0, t1, scen, W, Hh) {
    const A = R.A, s = A.s, st = A.stats, K = theme === 'dark' ? DC : LC, b = A.blow; W = W || 1600; Hh = Hh || 560;
    const tr = C.trajFor(A, scen); const tN = A.forecast.tNow;
    const fx = [], fpwh = [], fpl = [], fdp = [], fq = [], ccrit = [], cblow = [];
    tr.t.forEach((t, i) => { if (t > t1) return; fx.push(t); fpwh.push(tr.pwh[i]); fpl.push(tr.pline[i]); fdp.push(tr.phase[i] === 'work' ? tr.dp[i] : NaN); fq.push(tr.q[i] / 1000); ccrit.push(tr.phase[i] === 'work' ? tr.pline[i] + st.dpCrit : NaN); cblow.push(tr.phase[i] === 'work' && b.ok ? tr.pline[i] + b.dpTrigger : NaN); });
    const bands = []; { const t = A.det.state; let a = 0; for (let i = 1; i <= t.length; i++) if (i === t.length || t[i] !== t[a]) { if (t[a] === 'D') bands.push({ x0: s.t[a], x1: s.t[Math.min(i, t.length - 1)], color: theme === 'dark' ? 'rgba(127,147,168,.16)' : 'rgba(120,135,150,.16)' }); a = i; } }
    if (t1 > tN) bands.push({ x0: tN, x1: t1, color: theme === 'dark' ? 'rgba(192,140,255,.06)' : 'rgba(122,79,201,.06)' });
    const vl = t1 > tN ? [{ x: tN, color: theme === 'dark' ? '#DDE8F3' : '#445566', label: 'последний факт / начало прогноза' }] : [];
    const base = { theme, pad: { l: 70, r: 26, t: 40, b: 40 }, xMin: t0, xMax: t1, view: [t0, t1], bands, vlines: vl };
    const T = (o) => TChart.static(Object.assign({}, base, o), W, Hh);
    return {
      pressure: T({ title: 'Pwh и Pline: факт (сплошные) и прогноз (пунктир), кгс/см²', y: { zero: true }, series: [{ name: 'Pwh', color: K.pwh, x: s.t, y: s.pwh, width: 2 }, { name: 'Pline', color: K.pline, x: s.t, y: s.pline, width: 1.6 }, { name: 'Pwh прогноз', color: K.pwh, x: fx, y: fpwh, dash: [7, 5], width: 2 }, { name: 'Pline прогноз', color: K.pline, x: fx, y: fpl, dash: [7, 5], width: 1.6 }, { name: 'Pwh крит.', color: K.crit, x: fx, y: ccrit, dash: [2, 4], width: 1.4 }, { name: 'Давление продувки', color: K.blow, x: fx, y: cblow, dash: [2, 4], width: 1.4 }] }),
      dp: T({ title: 'Перепад ΔP: факт и прогноз, кгс/см² (линии — критический и перепад продувки)', y: { min: -1 }, series: [{ name: 'ΔP', color: K.dp, x: s.t, y: s.dp, width: 1.8 }, { name: 'ΔP прогноз', color: K.dp, x: fx, y: fdp, dash: [7, 5], width: 1.8 }], hlines: [{ y: st.dpCrit, color: K.crit, label: 'ΔP крит. ' + F(st.dpCrit, 2) }].concat(b.ok ? [{ y: b.dpTrigger, color: K.blow, label: 'ΔP продувки ' + F(b.dpTrigger, 2) }] : []) }),
      rate: A.flowOK ? T({ title: 'Расчётный дебит газа: факт и прогноз, тыс. м³/сут', y: { zero: true }, series: [{ name: 'q', color: K.q, x: s.t, y: Array.from(A.q, v => v / 1000), width: 1.8 }, { name: 'q прогноз', color: K.q, x: fx, y: fq, dash: [7, 5], width: 1.8 }] }) : null
    };
  }
  function cmpCharts(R, theme, W, Hh) {
    const A = R.A, K = theme === 'dark' ? DC : LC; const Tm = C.compareTimeline(A); if (!Tm) return {};
    const base = { theme, xType: 'num', xFmt: (v) => v + ' ч', pad: { l: 70, r: 26, t: 40, b: 40 }, y: { zero: true }, vlines: [{ x: Tm.recAt, color: K.neu, label: 'продувка (новый)' }, { x: Tm.Told, color: K.old, label: 'остановка (старый)', row: 1 }] };
    const T = (o) => TChart.static(Object.assign({}, base, o), W || 1600, Hh || 560);
    return {
      cmpP: T({ title: 'Один цикл: Pwh старый (красный) и новый (бирюзовый) режимы, кгс/см²', series: [{ name: 'стар', color: K.old, x: Tm.t, y: Tm.old.pwh, width: 3 }, { name: 'нов', color: K.neu, x: Tm.t, y: Tm.neu.pwh, width: 2 }, { name: 'Pline', color: K.pline, x: Tm.t, y: Tm.old.pline, dash: [5, 4] }] }),
      cmpC: T({ title: 'Один цикл: накопленная добыча, тыс. м³', series: [{ name: 'стар', color: K.old, x: Tm.t, y: Tm.old.cum, width: 3 }, { name: 'нов', color: K.neu, x: Tm.t, y: Tm.neu.cum, width: 2 }] })
    };
  }

  /* --------------------------- данные по скважинам ----------------------------- */
  function wellData(R, field, spec) {
    const A = R.A, b = A.blow, fc = A.forecast, o = A.opt; const tRep = spec.to;
    const v = C.valueAt(A, tRep, spec.scenario === 'current' ? 'current' : spec.scenario);
    const v0 = C.valueAt(A, spec.from, 'current');
    const sc = b.ok ? (spec.scenario === 'current' || spec.scenario === 'best' ? b.best : b.scen.find(x => x.key === spec.scenario) || b.best) : null;
    // добыча в периоде: факт + прогноз
    let gFact = 0, gFc = 0; const s = A.s;
    for (let i = 1; i < s.t.length; i++) { if (s.t[i] < spec.from || s.t[i - 1] > spec.to) continue; if (A.det.state[i] === 'W' && A.det.state[i - 1] === 'W' && isF(A.q[i]) && isF(A.q[i - 1])) gFact += (A.q[i] + A.q[i - 1]) / 2 * (s.t[i] - s.t[i - 1]) / 86400000 / 1000; }
    const tr = C.trajFor(A, spec.scenario); for (let i = 1; i < tr.t.length; i++) { if (tr.t[i] < spec.from || tr.t[i] > spec.to) continue; gFc += (tr.q[i] + tr.q[i - 1]) / 2 * 0.25 / 24 / 1000; }
    return { R, A, w: R.w, field, v, v0, b, fc, o, sc, gFact, gFc, gFcOk: tr.t.length > 0 && spec.to <= fc.tNow + A.p.fcMaxH * H };
  }
  const mk = (v, src, d) => ({ v: src === 'none' || !isF(v) ? '—' : F(v, d == null ? 2 : d), mark: isF(v) ? src : 'none', n: isF(v) && src !== 'none' ? v : null });
  const mkS = (src) => ({ v: MARK[src] || src, mark: src });

  /* ------------------------------- модель отчёта ------------------------------- */
  async function build(spec, ctx) {
    const wells = []; for (const id of spec.wells) { const R = await ctx.getAnalysis(id); if (R.empty) continue; wells.push(wellData(R, ctx.fieldById(R.w.fieldId), spec)); }
    const M = { spec, type: spec.type, typeName: TYPES[spec.type], title: TYPES[spec.type], created: Date.now(), sections: [], sheets: [], kpis: [], wells };
    const lastFact = wells.length ? Math.max.apply(null, wells.map(x => x.fc.tNow)) : NaN;
    const firstFact = wells.length ? Math.min.apply(null, wells.map(x => x.fc.tNow)) : NaN;
    M.meta = [['Тип отчёта', TYPES[spec.type]], ['Месторождение', spec.fieldName || 'все'], ['Скважин', String(wells.length)], ['Отчётный период', fDT(spec.from) + ' — ' + fDT(spec.to)], ['Дата формирования', fDT(M.created)],
      ['Источник данных', GSRC.MODES[GSRC.st.mode] + (GSRC.st.mode !== 'offline' && GSRC.st.connName ? ' · подключение «' + GSRC.st.connName + '»' + (GSRC.st.status === 'error' ? ' (последние сохранённые данные)' : '') : '')],
      ['Последнее фактическое измерение', wells.length ? (firstFact === lastFact ? fDT(lastFact) : fDT(firstFact) + ' … ' + fDT(lastFact)) : '—'], ['Прогноз сформирован', fDT(M.created) + ' по данным на ' + (wells.length ? fDT(lastFact) : '—')], ['Сценарий расчёта', SCEN[spec.scenario]],
      ['Статус значений', spec.to > lastFact ? 'на конец периода фактических данных нет — использованы ПРОГНОЗНЫЕ значения ядра' : 'фактические измерения']];
    M.assumptions = assumptions(wells);
    if (!wells.length) { M.sections.push({ h: 'Нет данных', paras: ['По выбранным скважинам нет измерений в текущем источнике данных.'] }); return M; }
    const tRep = spec.to;
    // ключевые показатели
    const sum = (f) => wells.reduce((a, x) => a + (isF(f(x)) ? f(x) : 0), 0);
    M.kpis = [['Скважин', wells.length, ''], ['Работают', wells.filter(x => x.fc.mode === 'work').length, ''], ['Приоритет ≥ «Скоро продувка»', wells.filter(x => x.A.priority.level >= 3).length, ''],
      ['Остановок за 24 ч (прогноз)', wells.filter(x => x.fc.mode !== 'work' || (isF(x.fc.remainH) && x.fc.remainH <= 24)).length, ''], ['Дебит на конец периода', F(sum(x => x.v.q / 1000), 1), 'тыс. м³/сут'], ['Доп. добыча (' + wells[0].A.p.horizonDays + ' сут)', F(sum(x => x.sc && x.sc.extra), 0), 'тыс. м³']];
    const valHead = ['Месторождение', 'Скважина', 'Статус значений', 'Pwh', 'Pline', 'ΔP', 'Дебит, тыс. м³/сут', 'Режим', 'Прогноз остановки', 'Pwh крит.', 'Давление продувки', 'Время продувки', 'Приоритет'];
    const valRow = (x) => [x.field ? x.field.name : '—', x.w.name, mkS(x.v.src), mk(x.v.pwh, x.v.src), mk(x.v.pline, x.v.src), mk(x.v.dp, x.v.src), mk(x.v.q / 1000, x.v.src), { v: x.v.phase === 'work' ? 'работа' : x.v.phase ? 'остановка' : '—', mark: x.v.src }, { v: x.fc.mode === 'work' ? fDT(x.fc.tCrit) : 'остановлена', mark: 'forecast' }, mk(x.b.ok && isF(x.v.pline) ? x.v.pline + x.b.dpCrit : NaN, x.v.src === 'none' ? 'none' : 'forecast'), mk(x.b.ok && isF(x.v.pline) ? x.v.pline + x.b.dpTrigger : NaN, x.v.src === 'none' ? 'none' : 'forecast'), { v: x.b.ok ? fDT(x.b.tRec) : '—', mark: 'forecast' }, x.A.priority.text];
    const T = spec.type;
    if (T === 'well') {
      for (const x of wells) {
        const A = x.A, st = A.stats, b = x.b, fc = x.fc;
        const tView0 = Math.max(A.s.t[0], Math.min(spec.from, fc.tNow - 48 * H)), tView1 = Math.max(spec.to, fc.tNow + 12 * H);
        const img = fcCharts(x.R, 'light', tView0, tView1, spec.scenario); const cm = cmpCharts(x.R, 'light');
        M.sections.push({ h: 'Скважина ' + x.w.name + (x.field ? ' (' + x.field.name + ')' : ''), level: 1, paras: ['Состояние: ' + A.status.text + '. ' + A.status.reason, 'Приоритет действий: ' + A.priority.text + ' — ' + A.priority.why + '.'] });
        M.sections.push({ h: 'Значения на отчётный момент ' + fDT(tRep), level: 2, table: { head: ['Параметр', 'Значение', 'Статус'], rows: [['Pwh, кгс/см²', mk(x.v.pwh, x.v.src), mkS(x.v.src)], ['Pline, кгс/см²', mk(x.v.pline, x.v.src), mkS(x.v.src)], ['ΔP, кгс/см²', mk(x.v.dp, x.v.src), mkS(x.v.src)], ['Дебит, тыс. м³/сут', mk(x.v.q / 1000, x.v.src), mkS(x.v.src)], ['Режим работы', { v: x.v.phase === 'work' ? 'работа' : x.v.phase ? 'остановка / продувка' : '—', mark: x.v.src }, mkS(x.v.src)], ['Прогноз остановки', { v: fc.mode === 'work' ? fDT(fc.tCrit) : 'остановлена', mark: 'forecast' }, mkS('forecast')], ['Рекомендуемое давление продувки', mk(b.ok ? b.pwhBlow : NaN, 'forecast'), mkS('forecast')], ['Рекомендуемое время продувки', { v: b.ok ? fDT(b.tRec) : '—', mark: 'forecast' }, mkS('forecast')]], widths: [45, 30, 25] }, note: x.v.src === 'forecast' ? 'Фактических измерений на отчётный момент нет: значения рассчитаны прогнозом ядра (достоверность: ' + x.v.confLevel + '). Последний факт: ' + fDT(fc.tNow) + '.' : x.v.src === 'none' ? 'Нет ни фактических значений, ни обоснованного прогноза: ' + (x.v.reason || '') + '.' : null });
        M.sections.push({ h: 'История и прогноз давлений', level: 2, img: { data: img.pressure, caption: 'Pwh и Pline: факт — сплошные линии, прогноз — пунктир; пунктир красный — критическое Pwh, жёлтый — давление продувки.' } });
        M.sections.push({ h: 'Перепад давления ΔP', level: 2, img: { data: img.dp, caption: 'ΔP = Pwh − Pline. Критический перепад определён по ' + st.nDone + ' подтверждённым остановкам.' } });
        M.sections.push({ h: 'Анализ рабочего цикла', level: 2, table: { head: ['Показатель', 'Значение'], rows: [['Выявлено продувок / завершённых циклов', st.nCycles + ' / ' + st.nDone], ['Медиана работы между продувками', fH(st.workMed)], ['Медиана простоя', fH(st.downMed)], ['Критический перепад ΔPкрит', F(st.dpCrit, 2) + ' кгс/см² (диапазон ' + F(st.dpCritMin, 2) + '–' + F(st.dpCritMax, 2) + ')'], ['Признаки накопления жидкости', A.loading.level + (isF(A.loading.score) ? ' (' + Math.round(A.loading.score * 100) + '/100)' : '')], ['Модель Pline', A.plineM.ok ? 'уровень ' + F(A.plineM.level, 2) + ', тренд ' + F(A.plineM.rate * 24, 3) + ' кгс/см²/сут, σ ' + F(A.plineM.sigma, 3) : '—']], widths: [55, 45] } });
        M.sections.push({ h: 'Прогноз остановки и давление продувки', level: 2, paras: [fc.mode === 'work' ? 'Прогноз потери работоспособности: ' + fDT(fc.tCrit) + ' (интервал 10–90%: ' + fDT(fc.tCritLo) + ' – ' + fDT(fc.tCritHi) + '), через ' + fH(fc.remainH) + ' от последнего замера. Достоверность: ' + A.conf.level + '.' : 'На момент последнего замера скважина остановлена.'],
          table: b.ok ? { head: ['Показатель', 'Значение'], rows: [['Текущее Pwh', F(fc.pwhNow, 2) + ' кгс/см²'], ['Критическое Pwh = Pline + ΔPкрит', F(b.pwhCrit, 2) + ' кгс/см²'], ['ΔPзапас (реакция ' + F(b.parts.react, 2) + ' + погрешность/Pline ' + F(b.dpSafetyMin - b.parts.react, 2) + ' + оптимизация ' + F(b.dpSafetyOpt, 2) + ')', F(b.dpSafety, 2) + ' кгс/см²'], ['Рекомендуемое давление продувки', F(b.pwhBlow, 2) + ' кгс/см²'], ['Время достижения давления продувки', fDT(b.tRec)], ['Сценарий', b.best.name]], widths: [60, 40] } : null });
        if (x.R.bt) M.sections.push({ h: 'Проверка прогноза на истории', level: 2, paras: [[1, 2, 3].map(L => 'за ' + L + ' ч: средняя ошибка ' + fH(x.R.bt.by[L].mae) + ', попадание в интервал ' + F(x.R.bt.by[L].hit * 100, 0) + '%').join('; ') + '.'] });
        if (A.flowOK) M.sections.push({ h: 'Дебит газа', level: 2, paras: ['Средний дебит цикла (медиана): ' + F(st.qMeanMed / 1000, 2) + ' тыс. м³/сут. Добыча в отчётном периоде: факт ' + F(x.gFact, 1) + ' тыс. м³' + (x.gFc > 0 ? ' + прогноз ' + F(x.gFc, 1) + ' тыс. м³' : '') + '. Расчёт по двум давлениям оценочный и требует калибровки по замерам.'], img: img.rate ? { data: img.rate, caption: 'Расчётный дебит: факт и прогноз.' } : null });
        if (b.ok && x.o.ok) M.sections.push({ h: 'Сравнение старого и нового режима', level: 2, table: scenTable(x), img: cm.cmpC ? { data: cm.cmpC, caption: 'Накопленная добыча за один цикл: старый и новый режим (модель на медианном цикле).' } : null });
        M.sections.push({ h: 'Инженерные рекомендации', level: 2, bullets: recsFor(x) });
        M.sections.push({ h: 'Значения за период (почасово)', level: 2, table: periodTable(x, spec, 48), note: 'В Word показано до 48 строк; полная таблица — в Excel.' });
      }
    } else if (T === 'field') {
      M.sections.push({ h: 'Скважины на ' + fDT(tRep), level: 1, table: { head: valHead, rows: wells.map(valRow), widths: [10, 8, 9, 6, 6, 6, 7, 7, 10, 7, 7, 10, 9] } });
      M.sections.push({ h: 'Суммарная эффективность нового режима', level: 1, table: effTable(wells), note: 'Новый режим — сценарий «' + SCEN[spec.scenario] + '» каждой скважины на горизонте ' + wells[0].A.p.horizonDays + ' сут.' });
      M.sections.push({ h: 'Рекомендации по продувкам', level: 1, bullets: wells.slice().sort((a, b) => b.A.priority.level - a.A.priority.level).map(x => x.w.name + ': ' + x.R.rec.title + ' (' + x.A.priority.text + ').') });
    } else if (T === 'stops') {
      const list = wells.slice().sort((a, b) => (a.fc.mode === 'work' ? a.fc.tCrit : -Infinity) - (b.fc.mode === 'work' ? b.fc.tCrit : -Infinity));
      M.sections.push({ h: 'Прогнозируемые остановки', level: 1, table: { head: ['Месторождение', 'Скважина', 'Остановка (прогноз)', 'Интервал 10–90%', 'Время до остановки', 'Pwh прогноз', 'Pline прогноз', 'ΔPкрит', 'Pwh крит.', 'Приоритет', 'Достоверность'], rows: list.map(x => { const vs = x.fc.mode === 'work' ? C.valueAt(x.A, x.fc.tCrit) : { src: 'none' }; return [x.field ? x.field.name : '—', x.w.name, { v: x.fc.mode === 'work' ? fDT(x.fc.tCrit) : 'остановлена (факт)', mark: x.fc.mode === 'work' ? 'forecast' : 'fact' }, x.fc.mode === 'work' ? fDT(x.fc.tCritLo).slice(11) + ' – ' + fDT(x.fc.tCritHi).slice(11) : '—', x.fc.mode === 'work' ? fH(x.fc.remainH) : '—', mk(vs.pwh, vs.src), mk(vs.pline, vs.src), F(x.A.stats.dpCrit, 2), mk(x.b.ok ? x.b.pwhCrit : NaN, 'forecast'), x.A.priority.text, x.A.conf.level]; }), widths: [11, 9, 13, 11, 9, 7, 7, 6, 7, 11, 9] }, note: 'Время до остановки отсчитывается от последнего замера скважины.' });
    } else if (T === 'opt') {
      M.sections.push({ h: 'Старый и новый режимы продувок', level: 1, table: { head: ['Скважина', 'Давление продувки', 'Время продувки', 'Продувок стар./нов.', 'Цикл стар./нов.', 'Простой стар./нов., ч', 'Снижение простоя, ч', 'Изменение добычи'], rows: wells.filter(x => x.sc && x.o.ok).map(x => [x.w.name, mk(x.b.pwhBlow, 'forecast'), { v: fDT(x.b.tRec), mark: 'forecast' }, F(x.o.scen.old.nBlow, 0) + ' / ' + F(x.sc.nBlow, 0), fH(x.o.scen.old.cycleH) + ' / ' + fH(x.sc.cycleH), F(x.o.scen.old.down, 0) + ' / ' + F(x.sc.down, 0), F(x.o.scen.old.down - x.sc.down, 0), (x.sc.extraPct >= 0 ? '+' : '') + F(x.sc.extraPct, 1) + '%']), widths: [12, 11, 15, 12, 16, 13, 10, 11] }, note: 'Отрицательное снижение простоя означает, что при более частых упреждающих продувках суммарный простой растёт, но добыча увеличивается.' });
      wells.forEach(x => { if (x.b.ok && x.o.ok) M.sections.push({ h: 'Сценарии продувки: ' + x.w.name, level: 2, table: scenTable(x) }); });
    } else if (T === 'eff') {
      M.sections.push({ h: 'Добыча за отчётный период', level: 1, table: { head: ['Скважина', 'Добыча факт, тыс. м³', 'Добыча прогноз, тыс. м³', 'Итого за период', 'Статус'], rows: wells.map(x => [x.w.name, mk(x.gFact, 'fact', 1), mk(x.gFc, x.gFcOk ? 'forecast' : 'none', 1), F(x.gFact + (x.gFcOk ? x.gFc : 0), 1), x.gFc > 0 ? (x.gFcOk ? 'факт + прогноз' : 'факт; прогноз вне горизонта') : 'факт']), widths: [20, 20, 20, 20, 20] } });
      M.sections.push({ h: 'Эффективность нового режима', level: 1, table: effTable(wells) });
    } else if (T === 'brief') {
      const prob = wells.filter(x => x.A.priority.level >= 2).sort((a, b) => b.A.priority.level - a.A.priority.level);
      M.sections.push({ h: 'Проблемные скважины', level: 1, table: prob.length ? { head: ['Скважина', 'Приоритет', 'Причина', 'Pwh', 'Давление продувки', 'Время продувки'], rows: prob.map(x => [x.w.name, x.A.priority.text, x.A.priority.why, mk(x.fc.pwhNow, 'fact'), mk(x.b.ok ? x.b.pwhBlow : NaN, 'forecast'), { v: x.b.ok ? fDT(x.b.tRec) : '—', mark: 'forecast' }]), widths: [12, 16, 30, 10, 14, 18] } : null, paras: prob.length ? [] : ['Проблемных скважин нет.'] });
      M.sections.push({ h: 'Срочные рекомендации', level: 1, bullets: wells.filter(x => x.A.priority.level >= 3).map(x => x.w.name + ': ' + x.R.rec.title).concat(wells.some(x => x.A.priority.level >= 3) ? [] : ['Срочных действий не требуется.']) });
      M.sections.push({ h: 'Прогнозируемые остановки (24 ч)', level: 1, bullets: wells.filter(x => x.fc.mode !== 'work' || x.fc.remainH <= 24).map(x => x.w.name + ': ' + (x.fc.mode === 'work' ? fDT(x.fc.tCrit) + ' (через ' + fH(x.fc.remainH) + ')' : 'остановлена')) });
      M.sections.push({ h: 'Ожидаемый эффект', level: 1, table: effTable(wells) });
    }
    // листы Excel
    M.sheets.push({ name: 'Значения на дату', head: valHead, rows: wells.map(valRow) });
    const per = { name: 'Значения за период', head: ['Скважина', 'Дата и время', 'Pwh', 'Pline', 'ΔP', 'Дебит, тыс. м³/сут', 'Режим', 'Статус значения', 'Достоверность'], rows: [] };
    wells.forEach(x => periodTable(x, spec, 5000).rows.forEach(r => per.rows.push([x.w.name].concat(r))));
    M.sheets.push(per);
    M.sheets.push({ name: 'Сценарии', head: ['Скважина', 'Сценарий', 'Интервал, ч', 'ΔP продувки', 'Pwh продувки', 'Продувок', 'Простой, ч', 'Потери газа, тыс. м³', 'Добыча, тыс. м³', 'Изменение, %', 'Рекомендован'], rows: [].concat.apply([], wells.filter(x => x.b.ok).map(x => [[x.w.name, 'Существующий режим', '—', '—', '—', num(x.o.ok ? x.o.scen.old.nBlow : NaN, 0), num(x.o.ok ? x.o.scen.old.down : NaN, 1), num(x.o.ok ? x.o.scen.old.losses : NaN, 2), num(x.o.ok ? x.o.scen.old.gas : NaN, 1), 0, '']].concat(x.b.scen.map(sc => [x.w.name, sc.name, num(sc.tau, 2), num(sc.dpTrigger, 2), num(sc.pwhTrigger, 2), num(sc.nBlow, 0), num(sc.down, 1), num(sc.losses, 2), num(sc.gas, 1), num(sc.extraPct, 1), sc.best ? 'да' : ''])))), totals: false });
    M.sheets.push({ name: 'Рекомендации', head: ['Скважина', 'Статус', 'Приоритет', 'Рекомендация', 'Время продувки', 'Давление продувки', 'Pwh крит.', 'Прогноз остановки', 'Достоверность'], rows: wells.map(x => [x.w.name, x.A.status.text, x.A.priority.text, x.R.rec.title + '. ' + x.R.rec.text, x.b.ok ? { v: fDT(x.b.tRec), mark: 'forecast' } : '—', mk(x.b.ok ? x.b.pwhBlow : NaN, 'forecast'), mk(x.b.ok ? x.b.pwhCrit : NaN, 'forecast'), { v: x.fc.mode === 'work' ? fDT(x.fc.tCrit) : 'остановлена', mark: 'forecast' }, x.A.conf.level]) });
    return M;
  }
  const num = (v, d) => ({ v: isF(v) ? F(v, d) : '—', n: isF(v) ? +v.toFixed(d) : null });
  function scenTable(x) {
    const o = x.o.scen.old;
    return { head: ['Сценарий', 'Интервал', 'Pwh продувки', 'Продувок', 'Простой, ч', 'Потери, тыс. м³', 'Добыча, тыс. м³', 'Изменение'], rows: [[{ v: 'Существующий режим', mark: 'old' }, 'до остановки', '—', F(o.nBlow, 0), F(o.down, 0), F(o.losses, 1), F(o.gas, 0), '—']].concat(x.b.scen.map(sc => [{ v: sc.name + (sc.best ? ' ★' : ''), mark: sc.best ? 'new' : '' }, fH(sc.tau), F(sc.pwhTrigger, 2), F(sc.nBlow, 0), F(sc.down, 0), F(sc.losses, 1), F(sc.gas, 0), (sc.extraPct >= 0 ? '+' : '') + F(sc.extraPct, 1) + '%'])), widths: [24, 11, 11, 10, 10, 11, 12, 11] };
  }
  function effTable(wells) {
    const ok = wells.filter(x => x.sc && x.o.ok); const sum = (f) => ok.reduce((a, x) => a + (isF(f(x)) ? f(x) : 0), 0);
    const rows = ok.map(x => [x.w.name, F(x.o.scen.old.gas, 0), F(x.sc.gas, 0), F(x.sc.extra, 0), (x.sc.extraPct >= 0 ? '+' : '') + F(x.sc.extraPct, 1) + '%', F(x.o.scen.old.losses, 1) + ' / ' + F(x.sc.losses, 1), F(x.o.scen.old.kexp * 100, 1) + '% / ' + F(x.sc.kexp * 100, 1) + '%']);
    const gO = sum(x => x.o.scen.old.gas), gN = sum(x => x.sc.gas);
    rows.push([{ v: 'Итого', mark: 'total' }, F(gO, 0), F(gN, 0), F(gN - gO, 0), gO ? (gN >= gO ? '+' : '') + F((gN / gO - 1) * 100, 1) + '%' : '—', F(sum(x => x.o.scen.old.losses), 1) + ' / ' + F(sum(x => x.sc.losses), 1), '—']);
    return { head: ['Скважина', 'Добыча стар., тыс. м³', 'Добыча нов., тыс. м³', 'Дополнительно', 'Изменение', 'Потери газа стар./нов.', 'Коэф. эксплуатации стар./нов.'], rows, widths: [16, 14, 14, 13, 11, 16, 16] };
  }
  function periodTable(x, spec, maxRows) {
    const rows = []; const step = Math.max(H, Math.ceil((spec.to - spec.from) / maxRows / H) * H);
    for (let t = Math.ceil(spec.from / H) * H; t <= spec.to && rows.length < maxRows; t += step) {
      const v = C.valueAt(x.A, t, spec.scenario === 'current' ? 'current' : spec.scenario);
      rows.push([fDT(t), mk(v.pwh, v.src), mk(v.pline, v.src), mk(v.dp, v.src), mk(v.q / 1000, v.src), { v: v.phase === 'work' ? 'работа' : v.phase ? 'остановка' : '—', mark: v.src }, mkS(v.src), v.src === 'forecast' ? v.confLevel : v.src === 'fact' ? 'измерение' : (v.reason || '')]);
    }
    return { head: ['Дата и время', 'Pwh', 'Pline', 'ΔP', 'Дебит', 'Режим', 'Статус', 'Достоверность'], rows, widths: [18, 10, 10, 10, 10, 12, 14, 16] };
  }
  function recsFor(x) {
    const A = x.A, b = x.b, o = x.o; const r = [x.R.rec.title + '.'];
    if (b.ok) r.push('Продувку проводить при снижении Pwh до ' + F(b.pwhBlow, 1) + ' кгс/см² (ΔP ≤ ' + F(b.dpTrigger, 2) + '); критическое Pwh — ' + F(b.pwhCrit, 1) + ' кгс/см².');
    if (b.ok && o.ok) r.push('Рекомендуемый сценарий — ' + b.best.name.toLowerCase() + ': интервал работы ' + fH(b.best.tau) + ', ожидаемое изменение добычи ' + (b.best.extraPct >= 0 ? '+' : '') + F(b.best.extraPct, 1) + '%.');
    r.push('Опытная проверка 5–10 циклов с фиксацией фактического простоя и замером дебита; калибровка коэффициента расхода.');
    if (A.loading.alt && A.loading.alt.length) r.push('Проверить альтернативные причины снижения ΔP: ' + A.loading.alt.join(', ') + '.');
    r.push('Рекомендации являются поддержкой решений и вводятся только после утверждения технологической службой.');
    return r;
  }
  function assumptions(wells) {
    const p = wells[0] ? wells[0].A.p : C.DEFAULTS;
    return ['Расчётное ядро едино для всех источников данных (Excel и PostgreSQL), дашборда, сводки фонда, анимации и отчётов.',
      'Pline прогнозируется робастным затухающим трендом (Тейл–Сен) с суточной составляющей и всплеском после перезапуска по медианному циклу; Pwh = прогноз Pline + прогноз ΔP.',
      'ΔP прогнозируется по медианному профилю циклов скважины с привязкой к последнему замеру и к ΔPкрит в момент прогнозной остановки; время остановки — взвешенное объединение аппроксимации цикла, аналога и логнормальной модели длительности.',
      'ΔPкрит — медиана перепада на последнем рабочем замере перед подтверждёнными остановками. Pwh крит = Pline + ΔPкрит; Pwh продувки = Pwh крит + ΔPзапас (реакция ' + fH(p.reactH) + ', погрешность датчика ' + p.measErr + ' кгс/см², изменчивость Pline, оптимизация добычи).',
      'Обоснованный горизонт прогноза — ' + p.fcMaxH + ' ч; при недостаточной достоверности значение помечается «НЕТ ДАННЫХ».',
      'Дебит — изоэнтропическое истечение реального газа через штуцер с проверкой критического режима; оценка требует калибровки по замерам.',
      'Сравнение режимов — модель восстановления (renewal–reward) на одинаковом горизонте ' + p.horizonDays + ' сут; дебит нового режима не завышается (тот же медианный профиль, вероятность преждевременной остановки, простои, потери газа).',
      'Маркировка: ФАКТ — измерение (±0,75 шага опроса); ПРОГНОЗ — расчёт ядра; НЕТ ДАННЫХ — нет ни измерения, ни обоснованного прогноза. Последние фактические значения не подставляются вместо прогнозных.'];
  }

  /* ------------------------------- HTML-просмотр ------------------------------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cellV = (c) => c && typeof c === 'object' ? c.v : c;
  const cellM = (c) => c && typeof c === 'object' ? c.mark || '' : '';
  function tableHTML(t) { return '<table class="rp-t"><thead><tr>' + t.head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + t.rows.map(r => '<tr>' + r.map(c => '<td class="m-' + cellM(c) + '">' + esc(cellV(c)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'; }
  function html(M) {
    let h = '<div class="rp-doc"><div class="rp-kind">' + esc(M.typeName) + '</div><h1>' + esc(M.title) + '</h1><table class="rp-meta">' + M.meta.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>').join('') + '</table>' +
      '<div class="rp-legend"><span class="m-fact">ФАКТ</span><span class="m-forecast">ПРОГНОЗ</span><span class="m-none">НЕТ ДАННЫХ</span><em>фон ячейки показывает статус значения; на графиках факт — сплошные линии, прогноз — пунктир</em></div>';
    if (M.kpis.length) h += '<div class="rp-kpis">' + M.kpis.map(k => '<div><span>' + esc(k[0]) + '</span><b>' + esc(k[1]) + '</b><em>' + esc(k[2]) + '</em></div>').join('') + '</div>';
    M.sections.forEach(s => {
      h += '<h' + (s.level === 2 ? 3 : 2) + '>' + esc(s.h) + '</h' + (s.level === 2 ? 3 : 2) + '>';
      (s.paras || []).forEach(p => h += '<p>' + esc(p) + '</p>');
      if (s.bullets) h += '<ul>' + s.bullets.map(b => '<li>' + esc(b) + '</li>').join('') + '</ul>';
      if (s.table) h += tableHTML(s.table);
      if (s.note) h += '<p class="rp-note">' + esc(s.note) + '</p>';
      if (s.img && s.img.data) h += '<figure><img src="' + s.img.data + '" alt=""><figcaption>' + esc(s.img.caption) + '</figcaption></figure>';
    });
    h += '<h2>Модель и расчётные допущения</h2><ul>' + M.assumptions.map(a => '<li>' + esc(a) + '</li>').join('') + '</ul></div>';
    return h;
  }

  /* ----------------------------------- DOCX ------------------------------------ */
  const FILL = { fact: 'E3F4EA', forecast: 'EEE6FB', none: 'EEEEEE', old: 'FBE7E2', new: 'DDF3EF', total: 'FFF4D6' };
  async function docx(M, brief) {
    const D = window.docx; const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, ShadingType, BorderStyle, Footer, PageNumber, LevelFormat, PageOrientation } = D;
    const wide = M.sections.some(s => s.table && s.table.head.length > 9);
    const CW = wide ? 14570 : 9638; const FONT = 'Calibri';
    const P = (t, o) => new Paragraph(Object.assign({ children: [new TextRun({ text: String(t), font: FONT, size: 21 })], spacing: { after: 100 } }, o || {}));
    const border = { style: BorderStyle.SINGLE, size: 4, color: 'C9D3DD' };
    const TBL = (t) => {
      const wsr = t.widths || t.head.map(() => 1); const tot = wsr.reduce((a, b) => a + b, 0); const ws = wsr.map(x => Math.round(x / tot * CW)); ws[ws.length - 1] += CW - ws.reduce((a, b) => a + b, 0);
      const cell = (c, i, hd) => new TableCell({ width: { size: ws[i], type: WidthType.DXA }, shading: hd ? { type: ShadingType.CLEAR, color: 'auto', fill: '1B2D40' } : (FILL[cellM(c)] ? { type: ShadingType.CLEAR, color: 'auto', fill: FILL[cellM(c)] } : undefined), margins: { top: 50, bottom: 50, left: 80, right: 80 }, borders: { top: border, bottom: border, left: border, right: border }, children: [new Paragraph({ children: [new TextRun({ text: String(cellV(c)), font: FONT, size: wide ? 16 : 18, bold: hd, italics: cellM(c) === 'forecast', color: hd ? 'FFFFFF' : '1B2A3A' })] })] });
      return new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: ws, rows: [new TableRow({ tableHeader: true, children: t.head.map((h, i) => cell(h, i, true)) })].concat(t.rows.map(r => new TableRow({ children: r.map((c, i) => cell(c, i, false)) }))) });
    };
    const imgW = wide ? 900 : 640, imgH = Math.round(imgW * 0.35);
    const ch = [];
    ch.push(new Paragraph({ children: [new TextRun({ text: (brief ? 'КРАТКИЙ ОТЧЁТ ДЛЯ РУКОВОДСТВА · ' : 'ИНЖЕНЕРНЫЙ ОТЧЁТ · ') + M.typeName.toUpperCase(), font: FONT, size: 18, color: 'B07A00', bold: true })] }));
    ch.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: M.title })] }));
    ch.push(TBL({ head: ['Параметр', 'Значение'], rows: M.meta, widths: [30, 70] }));
    ch.push(new Paragraph({ spacing: { before: 120, after: 160 }, children: [new TextRun({ text: 'Статус значений: ', bold: true, font: FONT, size: 18 }), new TextRun({ text: ' ФАКТ ', font: FONT, size: 18, shading: { type: ShadingType.CLEAR, color: 'auto', fill: FILL.fact } }), new TextRun({ text: '  ', size: 18 }), new TextRun({ text: ' ПРОГНОЗ ', font: FONT, size: 18, italics: true, shading: { type: ShadingType.CLEAR, color: 'auto', fill: FILL.forecast } }), new TextRun({ text: '  ', size: 18 }), new TextRun({ text: ' НЕТ ДАННЫХ ', font: FONT, size: 18, shading: { type: ShadingType.CLEAR, color: 'auto', fill: FILL.none } }), new TextRun({ text: '  — на графиках факт сплошной линией, прогноз пунктиром.', font: FONT, size: 18, color: '5A6B7C' })] }));
    if (M.kpis.length) ch.push(TBL({ head: M.kpis.map(k => k[0]), rows: [M.kpis.map(k => String(k[1]) + (k[2] ? ' ' + k[2] : ''))] }));
    let imgs = 0;
    M.sections.forEach(s => {
      if (brief && s.level === 2 && /почасово|Анализ рабочего|Проверка прогноза|Перепад давления/.test(s.h)) return;
      ch.push(new Paragraph({ heading: s.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1, children: [new TextRun({ text: s.h })] }));
      (s.paras || []).forEach(p => ch.push(P(p)));
      (s.bullets || []).forEach(b => ch.push(new Paragraph({ numbering: { reference: 'bul', level: 0 }, children: [new TextRun({ text: b, font: FONT, size: 21 })], spacing: { after: 60 } })));
      if (s.table) { const t = brief ? Object.assign({}, s.table, { rows: s.table.rows.slice(0, 15) }) : s.table; ch.push(TBL(t)); }
      if (s.note) ch.push(new Paragraph({ children: [new TextRun({ text: s.note, font: FONT, size: 17, italics: true, color: '5A6B7C' })], spacing: { before: 60, after: 140 } }));
      if (s.img && s.img.data && (!brief || imgs < 2)) { imgs++; ch.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: u8(s.img.data), transformation: { width: imgW, height: imgH } })], spacing: { before: 80, after: 40 } })); ch.push(new Paragraph({ children: [new TextRun({ text: s.img.caption, font: FONT, size: 17, italics: true, color: '5A6B7C' })], spacing: { after: 140 } })); }
    });
    ch.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Модель и расчётные допущения' })] }));
    M.assumptions.forEach(a => ch.push(new Paragraph({ numbering: { reference: 'bul', level: 0 }, children: [new TextRun({ text: a, font: FONT, size: brief ? 17 : 19 })], spacing: { after: 50 } })));
    const page = wide ? { size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE }, margin: { top: 1000, bottom: 1000, left: 1134, right: 1134 } } : { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } };
    const doc = new Document({ creator: 'ГазПродувка', title: M.title,
      styles: { default: { document: { run: { font: FONT, size: 21 } } }, paragraphStyles: [{ id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { font: FONT, size: 38, bold: true, color: '132030' }, paragraph: { spacing: { after: 160 } } }, { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 28, bold: true, color: '1B2D40' }, paragraph: { spacing: { before: 280, after: 120 }, keepNext: true, outlineLevel: 0 } }, { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 24, bold: true, color: '1B2D40' }, paragraph: { spacing: { before: 200, after: 100 }, keepNext: true, outlineLevel: 1 } }] },
      numbering: { config: [{ reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
      sections: [{ properties: { page }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'ГазПродувка · ' + M.typeName + ' · ' + fDT(M.created) + ' · стр. ', font: FONT, size: 16, color: '7A8A9A' }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: '7A8A9A' })] })] }) }, children: ch }] });
    return stripDirs(await Packer.toBlob(doc), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }

  /* ----------------------------------- XLSX ------------------------------------ */
  const xe = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  async function xlsx(M) {
    const z = new JSZip();
    // стили: 0 обычный, 1 заголовок, 2 факт, 3 прогноз, 4 нет данных, 5 число, 6 число-факт, 7 число-прогноз, 8 заголовок листа, 9 итог
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>' +
      '<fonts count="5"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF4B2A8C"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF888888"/><name val="Calibri"/></font><font><b/><sz val="13"/><name val="Calibri"/></font></fonts>' +
      '<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1B2D40"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3F4EA"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEE6FB"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEEEEE"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF4D6"/></patternFill></fill></fills>' +
      '<borders count="2"><border/><border><left style="thin"><color rgb="FFC9D3DD"/></left><right style="thin"><color rgb="FFC9D3DD"/></right><top style="thin"><color rgb="FFC9D3DD"/></top><bottom style="thin"><color rgb="FFC9D3DD"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="10"><xf/><xf fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment wrapText="1" vertical="center"/></xf><xf fillId="3" borderId="1" applyFill="1" applyBorder="1"/><xf fontId="2" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf fontId="3" fillId="5" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/>' +
      '<xf numFmtId="164" borderId="1" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="164" fillId="3" borderId="1" applyNumberFormat="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="2" fillId="4" borderId="1" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf fontId="4" applyFont="1"/><xf numFmtId="164" fillId="6" borderId="1" applyNumberFormat="1" applyFill="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    const sheets = [{ name: 'Отчёт', meta: true }].concat(M.sheets);
    const sx = [];
    sheets.forEach((sh, si) => {
      let rows = []; let r = 1; const merges = [];
      const cellXml = (ci, c, rowN) => {
        const ref = colName(ci) + rowN; const v = cellV(c), m = cellM(c); const n = c && typeof c === 'object' && c.n != null ? c.n : (typeof c === 'number' ? c : null);
        if (n != null && isF(n)) { const st = m === 'fact' ? 6 : m === 'forecast' ? 7 : 5; return '<c r="' + ref + '" s="' + st + '"><v>' + n + '</v></c>'; }
        const st = m === 'fact' ? 2 : m === 'forecast' ? 3 : m === 'none' ? 4 : 0; return '<c r="' + ref + '" s="' + st + '" t="inlineStr"><is><t xml:space="preserve">' + xe(v == null ? '' : v) + '</t></is></c>';
      };
      if (sh.meta) {
        rows.push('<row r="1"><c r="A1" s="8" t="inlineStr"><is><t>' + xe(M.title) + '</t></is></c></row>'); r = 3;
        M.meta.forEach(([k, v]) => { rows.push('<row r="' + r + '">' + cellXml(0, k, r) + cellXml(1, v, r) + '</row>'); r++; });
        r++; rows.push('<row r="' + r + '"><c r="A' + r + '" s="1" t="inlineStr"><is><t>Статус значений</t></is></c><c r="B' + r + '" s="2" t="inlineStr"><is><t>ФАКТ</t></is></c><c r="C' + r + '" s="3" t="inlineStr"><is><t>ПРОГНОЗ</t></is></c><c r="D' + r + '" s="4" t="inlineStr"><is><t>НЕТ ДАННЫХ</t></is></c></row>'); r += 2;
        if (M.kpis.length) { M.kpis.forEach(k => { rows.push('<row r="' + r + '">' + cellXml(0, k[0], r) + cellXml(1, { v: k[1], n: typeof k[1] === 'number' ? k[1] : (isF(parseFloat(String(k[1]).replace(/\s/g, '').replace(',', '.'))) ? parseFloat(String(k[1]).replace(/\s/g, '').replace(',', '.')) : null) }, r) + cellXml(2, k[2], r) + '</row>'); r++; }); r++; }
        rows.push('<row r="' + r + '"><c r="A' + r + '" s="1" t="inlineStr"><is><t>Модель и расчётные допущения</t></is></c></row>'); r++;
        M.assumptions.forEach(a => { rows.push('<row r="' + r + '">' + cellXml(0, a, r) + '</row>'); merges.push('A' + r + ':F' + r); r++; });
        sx.push({ name: 'Отчёт', xml: rows.join(''), cols: [42, 70, 16, 16, 16, 16], last: null, merges });
        return;
      }
      rows.push('<row r="1">' + sh.head.map((h, i) => '<c r="' + colName(i) + '1" s="1" t="inlineStr"><is><t>' + xe(h) + '</t></is></c>').join('') + '</row>');
      sh.rows.forEach((rw, k) => { const rn = k + 2; rows.push('<row r="' + rn + '">' + rw.map((c, i) => cellXml(i, c, rn)).join('') + '</row>'); });
      // итоговая строка с формулами по числовым столбцам (для таблицы значений)
      if (sh.totals !== false && sh.rows.length > 1 && /Значения на дату/.test(sh.name)) {
        const rn = sh.rows.length + 2; const numCols = sh.head.map((h, i) => /Дебит/.test(h) ? i : -1).filter(i => i >= 0);
        rows.push('<row r="' + rn + '"><c r="A' + rn + '" s="9" t="inlineStr"><is><t>Итого дебит</t></is></c>' + numCols.map(i => '<c r="' + colName(i) + rn + '" s="9"><f>SUM(' + colName(i) + '2:' + colName(i) + (rn - 1) + ')</f></c>').join('') + '</row>');
      }
      sx.push({ name: sh.name, xml: rows.join(''), cols: sh.head.map((h, i) => Math.min(60, Math.max(10, String(h).length + 2, ...sh.rows.slice(0, 200).map(r2 => String(cellV(r2[i]) == null ? '' : cellV(r2[i])).length + 2)))), last: colName(sh.head.length - 1) + (sh.rows.length + 1) });
    });
    sx.forEach((s, i) => z.file('xl/worksheets/sheet' + (i + 1) + '.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      (s.last ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>') +
      '<cols>' + s.cols.map((w, k) => '<col min="' + (k + 1) + '" max="' + (k + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols><sheetData>' + s.xml + '</sheetData>' + (s.last ? '<autoFilter ref="A1:' + s.last + '"/>' : '') + (s.merges && s.merges.length ? '<mergeCells count="' + s.merges.length + '">' + s.merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '') + '</worksheet>'));
    const safeName = (n, i) => xe(n.replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31) || ('Лист' + (i + 1)));
    z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sx.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
    z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
    z.file('docProps/core.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + xe(M.title) + '</dc:title><dc:creator>ГазПродувка</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + new Date(M.created).toISOString() + '</dcterms:created></cp:coreProperties>');
    z.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sx.map((s, i) => '<sheet name="' + safeName(s.name, i) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' + '<definedNames>' + sx.map((s, i) => s.last ? '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' + safeName(s.name, i) + '\'!$A$1:$' + s.last.replace(/(\d+)$/, '$$$1') + '</definedName>' : '').join('') + '</definedNames></workbook>');
    z.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sx.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '<Relationship Id="rId' + (sx.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    z.file('xl/styles.xml', styles);
    return z.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
  }

  /* ----------------------------------- PPTX ------------------------------------ */
  async function pptx(M) {
    const P = window.PptxGenJS; const pp = new P(); pp.layout = 'LAYOUT_WIDE'; pp.title = M.title;
    const BG = '132030', PAN = '1B2D40', TX = 'DDE8F3', MU = '8FA6BD', AMB = 'F2B33D', OLD = 'E8715A', NEW = '27C3AE', FONT = 'Calibri';
    pp.defineSlideMaster({ title: 'M', background: { color: BG }, objects: [{ rect: { x: 0, y: 7.2, w: 13.33, h: 0.3, fill: { color: '0F1A26' } } }, { text: { text: 'ГазПродувка · ' + M.typeName + ' · ' + fDT(M.created), options: { x: 0.5, y: 7.2, w: 9, h: 0.3, fontSize: 10, color: MU, fontFace: FONT } } }], slideNumber: { x: 12.5, y: 7.22, fontSize: 10, color: MU, fontFace: FONT } });
    const slide = (t, sub) => { const s = pp.addSlide({ masterName: 'M' }); s.addText(t, { x: 0.5, y: 0.3, w: 12.3, h: 0.6, fontSize: 26, bold: true, color: TX, fontFace: FONT }); if (sub) s.addText(sub, { x: 0.5, y: 0.88, w: 12.3, h: 0.4, fontSize: 13, color: MU, fontFace: FONT }); return s; };
    const FILLD = { fact: '1F4A3A', forecast: '3A2D5C', none: '2A3440', old: '4A2A24', new: '1E4A45', total: '4A3E1C' };
    const table = (s, t, y, maxRows, fs) => { const rows = [t.head.map(h => ({ text: String(h), options: { bold: true, color: '1A1406', fill: { color: AMB } } }))].concat(t.rows.slice(0, maxRows).map((r, k) => r.map(c => ({ text: String(cellV(c)), options: { color: TX, italic: cellM(c) === 'forecast', fill: { color: FILLD[cellM(c)] || (k % 2 ? PAN : '172738') } } })))); s.addTable(rows, { x: 0.5, y, w: 12.3, fontSize: fs || 11, fontFace: FONT, border: { type: 'solid', color: '2D4660', pt: 0.5 }, autoPage: false }); };
    { const s = pp.addSlide(); s.background = { color: BG }; s.addShape(pp.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: AMB } });
      s.addText(M.title, { x: 0.8, y: 2.0, w: 11.8, h: 1.0, fontSize: 36, bold: true, color: TX, fontFace: FONT });
      s.addText(M.meta.filter(m => /период|Месторождение|Источник|Сценарий/.test(m[0])).map(m => m[0] + ': ' + m[1]).join('\n'), { x: 0.8, y: 3.2, w: 11.8, h: 1.6, fontSize: 15, color: MU, fontFace: FONT, valign: 'top' });
      s.addText([{ text: 'ФАКТ', options: { color: '46D69A', bold: true } }, { text: '   ПРОГНОЗ', options: { color: 'C08CFF', bold: true, italic: true } }, { text: '   НЕТ ДАННЫХ', options: { color: MU, bold: true } }], { x: 0.8, y: 5.2, w: 8, h: 0.4, fontSize: 13, fontFace: FONT }); }
    if (M.kpis.length) { const s = slide('Ключевые показатели', 'на ' + fDT(M.spec.to)); M.kpis.forEach((k, i) => { const x = 0.5 + (i % 3) * 4.15, y = 1.5 + Math.floor(i / 3) * 1.6; s.addShape(pp.ShapeType.roundRect, { x, y, w: 3.95, h: 1.35, fill: { color: PAN }, line: { color: '2D4660', width: 1 }, rectRadius: 0.08 }); s.addText(String(k[1]), { x: x + 0.2, y: y + 0.1, w: 3.6, h: 0.7, fontSize: 30, bold: true, color: AMB, fontFace: FONT }); s.addText(k[0] + (k[2] ? ', ' + k[2] : ''), { x: x + 0.2, y: y + 0.8, w: 3.6, h: 0.45, fontSize: 12.5, color: MU, fontFace: FONT }); }); }
    // проблемные скважины
    const prob = M.wells.filter(x => x.A.priority.level >= 2).sort((a, b) => b.A.priority.level - a.A.priority.level);
    { const s = slide('Проблемные скважины', prob.length ? prob.length + ' скважин требуют внимания' : 'проблемных скважин нет'); if (prob.length) table(s, { head: ['Скважина', 'Приоритет', 'Pwh', 'Давл. продувки', 'Время продувки', 'Остановка (прогноз)'], rows: prob.map(x => [x.w.name, x.A.priority.text, F(x.fc.pwhNow, 2), x.b.ok ? { v: F(x.b.pwhBlow, 2), mark: 'forecast' } : '—', x.b.ok ? { v: fDT(x.b.tRec), mark: 'forecast' } : '—', { v: x.fc.mode === 'work' ? fDT(x.fc.tCrit) : 'остановлена', mark: 'forecast' }]) }, 1.45, 13, 12); }
    // основные таблицы отчёта
    M.sections.filter(s2 => s2.table && s2.level !== 2).forEach(s2 => { const t = s2.table; for (let k = 0; k < t.rows.length; k += 12) { const s = slide(s2.h, t.rows.length > 12 ? 'строки ' + (k + 1) + '–' + Math.min(t.rows.length, k + 12) : ''); table(s, { head: t.head, rows: t.rows.slice(k, k + 12) }, 1.45, 12, t.head.length > 9 ? 9 : 11); } });
    // графики по скважинам (до 4 приоритетных)
    const top = M.wells.slice().sort((a, b) => b.A.priority.level - a.A.priority.level).slice(0, 4);
    top.forEach(x => { const t0 = Math.max(x.A.s.t[0], x.fc.tNow - 48 * H), t1 = Math.max(M.spec.to, x.fc.tNow + 12 * H); const img = fcCharts(x.R, 'dark', t0, t1, M.spec.scenario, 1600, 640);
      const s = slide('Скважина ' + x.w.name + ': прогноз давлений', x.A.status.text + ' · ' + x.A.priority.text); s.addImage({ data: img.pressure, x: 0.5, y: 1.4, w: 8.6, h: 3.44 }); s.addImage({ data: img.dp, x: 0.5, y: 4.9, w: 8.6, h: 2.2 * 0.95 });
      const items = [['Pwh сейчас', F(x.fc.pwhNow, 2)], ['Pwh крит.', x.b.ok ? F(x.b.pwhCrit, 2) : '—'], ['Давл. продувки', x.b.ok ? F(x.b.pwhBlow, 2) : '—'], ['Время продувки', x.b.ok ? fDT(x.b.tRec).slice(0, 16) : '—'], ['Остановка', x.fc.mode === 'work' ? fDT(x.fc.tCrit).slice(0, 16) : 'остановлена'], ['Достоверность', x.A.conf.level]];
      items.forEach((it, i) => { s.addText(it[0], { x: 9.4, y: 1.45 + i * 0.9, w: 3.5, h: 0.3, fontSize: 11.5, color: MU, fontFace: FONT }); s.addText(it[1], { x: 9.4, y: 1.72 + i * 0.9, w: 3.5, h: 0.5, fontSize: 19, bold: true, color: i === 2 || i === 3 ? AMB : TX, fontFace: FONT }); }); });
    // предлагаемые режимы и эффективность
    const ok = M.wells.filter(x => x.sc && x.o.ok);
    if (ok.length) {
      const s = slide('Предлагаемые режимы и ожидаемая эффективность', 'горизонт ' + ok[0].A.p.horizonDays + ' сут, ' + SCEN[M.spec.scenario].toLowerCase());
      s.addChart(pp.ChartType.bar, [{ name: 'Старый режим', labels: ok.map(x => x.w.name), values: ok.map(x => Math.round(x.o.scen.old.gas)) }, { name: 'Новый режим', labels: ok.map(x => x.w.name), values: ok.map(x => Math.round(x.sc.gas)) }], { x: 0.5, y: 1.4, w: 6.4, h: 5.5, barDir: 'col', barGrouping: 'clustered', chartColors: [OLD, NEW], showValue: true, dataLabelColor: TX, dataLabelFontSize: 10, catAxisLabelColor: MU, valAxisLabelColor: MU, valGridLine: { color: '2D4660', size: 0.5 }, showLegend: true, legendPos: 'b', legendColor: TX, showTitle: true, title: 'Добыча, тыс. м³', titleColor: TX, titleFontSize: 12 });
      table({ addTable: (r, o) => s.addTable(r, Object.assign(o, { x: 7.1, w: 5.7 })) }, { head: ['Скважина', 'Интервал', 'Давл. продувки', 'Изменение'], rows: ok.map(x => [x.w.name, fH(x.sc.tau), F(x.sc.pwhTrigger, 2), { v: (x.sc.extraPct >= 0 ? '+' : '') + F(x.sc.extraPct, 1) + '%', mark: 'new' }]) }, 1.45, 12, 11);
    }
    { const s = slide('Рекомендации и допущения'); const rec = M.wells.filter(x => x.A.priority.level >= 3).map(x => x.w.name + ': ' + x.R.rec.title);
      s.addText((rec.length ? rec : ['Срочных действий не требуется.']).concat(['Опытная проверка 5–10 циклов в рекомендуемом режиме, калибровка дебита по замерам.', 'Решения утверждает технологическая служба; программа не управляет скважинами.']).map(t => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 1.4, w: 12.3, h: 2.8, fontSize: 15, color: TX, fontFace: FONT, valign: 'top' });
      s.addText(M.assumptions.slice(1, 6).map(t => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 4.3, w: 12.3, h: 2.8, fontSize: 10.5, color: MU, fontFace: FONT, valign: 'top' }); }
    return stripDirs(await pp.write({ outputType: 'blob' }), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  }

  async function stripDirs(blob, mime) {
    const z = await JSZip.loadAsync(blob); const out = new JSZip();
    for (const n of Object.keys(z.files)) { const f = z.files[n]; if (f.dir) continue; out.file(n, await f.async('uint8array'), { createFolders: false }); }
    return out.generateAsync({ type: 'blob', mimeType: mime, compression: 'DEFLATE' });
  }
  function u8(dataUrl) { const bin = atob(dataUrl.split(',')[1]); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  return { TYPES, SCEN, build, html, docx, xlsx, pptx, fcCharts };
})();
