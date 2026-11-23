/* ============================================================================
   CORE: инженерные расчёты.
   - подготовка рядов, контроль качества, выравнивание Pline на сетку Pwh
   - расход газа через штуцер (критическое / докритическое течение)
   - выявление продувок/перезапусков, рабочих циклов, остановок
   - признаки накопления жидкости, критический перепад, прогноз
   - оптимизация интервала продувок (модель восстановления — renewal reward)
   - сравнение режимов на одинаковом горизонте
   Все давления — избыточные, кгс/см²; время — мс (Unix), длительности — часы.
   ========================================================================== */
const GCORE = (function () {
  'use strict';
  const H = 3600000;
  const KGF = 98066.5;           // Па в 1 кгс/см²
  const R = 8314.462618;         // Дж/(кмоль·К)

  /* ------------------------------ helpers -------------------------------- */
  const isF = Number.isFinite;
  function median(a) { const b = a.filter(isF).slice().sort((x, y) => x - y); if (!b.length) return NaN; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
  function quantile(a, q) { const b = a.filter(isF).slice().sort((x, y) => x - y); if (!b.length) return NaN; const pos = (b.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return b[lo] + (b[hi] - b[lo]) * (pos - lo); }
  function mean(a) { const b = a.filter(isF); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : NaN; }
  function std(a) { const b = a.filter(isF); if (b.length < 2) return NaN; const m = mean(b); return Math.sqrt(b.reduce((s, x) => s + (x - m) * (x - m), 0) / (b.length - 1)); }
  function corr(x, y) { const p = []; x.forEach((v, i) => { if (isF(v) && isF(y[i])) p.push([v, y[i]]); }); if (p.length < 3) return NaN; const mx = mean(p.map(a => a[0])), my = mean(p.map(a => a[1])); let sxy = 0, sxx = 0, syy = 0; p.forEach(([a, b]) => { sxy += (a - mx) * (b - my); sxx += (a - mx) ** 2; syy += (b - my) ** 2; }); return sxy / Math.sqrt(sxx * syy); }
  function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
  const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  function interp(xs, ys, x) { // xs sorted
    if (!xs.length) return NaN; if (x <= xs[0]) return ys[0]; if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0, hi = xs.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    const f = (x - xs[lo]) / (xs[hi] - xs[lo]); return ys[lo] + f * (ys[hi] - ys[lo]);
  }
  function lowerIdx(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }

  /* ---------------------------- default params --------------------------- */
  const DEFAULTS = {
    // Газ и штуцер
    d_mm: null,            // диаметр штуцера, мм (обязательный ввод)
    gamma: null,           // относительная плотность газа по воздуху (обязательный ввод)
    T_C: 20,               // температура газа перед штуцером, °C (допущение)
    Z: null,               // null → расчёт по корреляции (Саттон + Папай)
    Cd: 0.85,              // коэффициент расхода штуцера (допущение)
    k: 1.30,               // показатель адиабаты (допущение)
    Patm: 1.0332,          // атмосферное давление, кгс/см² абс
    Tst_C: 20,             // стандартные условия ГОСТ 2939: 20 °C, 101325 Па
    calib: 1.0,            // калибровочный множитель по фактическим замерам
    tubing_mm: null,       // внутр. диаметр НКТ, мм (для критерия Тернера/Коулмана)
    liqDensity: 1000,      // плотность жидкости, кг/м³
    sigma: 0.06,           // поверхностное натяжение, Н/м
    turnerCoef: 'coleman', // 'coleman' | 'turner'
    // Детектор событий
    jumpMin: 10,           // минимальный скачок Pwh при продувке, кгс/см²
    rateMin: 8,            // минимальная скорость роста, кгс/см² в час
    dpOn: 1.0,             // перепад начала работы, кгс/см²
    dpOff: 0.0,            // перепад потери работоспособности (Pwh ≤ Pline + dpOff)
    minWorkH: 0.75,        // минимальная длительность рабочего цикла, ч
    mergeH: 2.0,           // объединение близких скачков, ч
    maxGapMin: 46,         // макс. разрыв для интерполяции Pline, мин
    spikeAbs: 3.0,         // порог одиночного выброса, кгс/см²
    pMax: 400,             // верхняя граница правдоподобия, кгс/см²
    // Оптимизация
    dpCritManual: null,    // ручное значение критического перепада
    D_unpl: null,          // простой при вынужденной продувке, ч (null → по истории)
    D_pl: null,            // простой при упреждающей продувке, ч (null → по истории, P10)
    lossUnpl: 0,           // потери газа на одну вынужденную продувку, тыс. м³
    lossPl: 0,             // потери газа на одну упреждающую продувку, тыс. м³
    horizonDays: 30,       // горизонт сравнения, сут
    reliability: 0.9,      // надёжность прогнозного режима (сценарий 2)
    gasPrice: null,        // цена газа, за тыс. м³ (для экономической оценки)
    // Прогноз давлений и давление продувки
    reactH: 0.5,           // время реакции персонала на сигнал, ч
    measErr: 0.05,         // погрешность датчика давления, кгс/см² (СКО)
    fcMaxH: 72,            // максимальный горизонт обоснованного прогноза, ч
    plineWinH: 72,         // окно оценки тренда Pline, ч
    earlyFactor: 0.6       // ранняя продувка: доля оптимального интервала
  };

  /* ---------------------------- gas properties --------------------------- */
  function pseudoCrit(g) { // Саттон (1985): °R, psia → К, МПа
    const Tpc = (169.2 + 349.5 * g - 74.0 * g * g) / 1.8;
    const Ppc = (756.8 - 131.0 * g - 3.6 * g * g) * 0.00689476;
    return { Tpc, Ppc };
  }
  function zFactor(Pabs_Pa, T_K, g) { // Папай (1968), применим при Ppr < 15
    const { Tpc, Ppc } = pseudoCrit(g);
    const Ppr = Pabs_Pa / 1e6 / Ppc, Tpr = T_K / Tpc;
    const z = 1 - 3.52 * Ppr / Math.pow(10, 0.9813 * Tpr) + 0.274 * Ppr * Ppr / Math.pow(10, 0.8157 * Tpr);
    return Math.max(0.3, Math.min(1.2, z));
  }

  /** Расход газа через штуцер. P1,P2 — избыточные, кгс/см². Возвращает м³/сут (ст. усл.). */
  function chokeFlow(P1g, P2g, p) {
    if (!p || !p.d_mm || !p.gamma || !isF(P1g) || !isF(P2g)) return { q: NaN };
    const P1 = (P1g + p.Patm) * KGF, P2 = (P2g + p.Patm) * KGF;
    if (P1 <= P2) return { q: 0, regime: 'нет потока', r: P2 / P1 };
    const k = p.k, M = 28.9647 * p.gamma, T1 = p.T_C + 273.15;
    const Z1 = p.Z ? p.Z : zFactor(P1, T1, p.gamma);
    const rc = Math.pow(2 / (k + 1), k / (k - 1));
    const r = P2 / P1, re = Math.max(r, rc);
    const rho1 = P1 * M / (Z1 * R * T1);
    const A = Math.PI * Math.pow(p.d_mm / 1000, 2) / 4;
    const psi = (k / (k - 1)) * (Math.pow(re, 2 / k) - Math.pow(re, (k + 1) / k));
    const mdot = p.Cd * A * Math.sqrt(2 * rho1 * P1 * psi);
    const rhoSt = 101325 * M / (R * (p.Tst_C + 273.15));
    const q = mdot / rhoSt * 86400 * (p.calib || 1);
    return { q, regime: r <= rc ? 'критическое' : 'докритическое', r, rc, Z: Z1, rho1, mdot };
  }

  /** Критический дебит выноса жидкости (Тернер / Коулман) на устье, м³/сут. */
  function criticalRate(Pg, p) {
    if (!p.tubing_mm || !p.gamma) return NaN;
    const P = (Pg + p.Patm) * KGF, T = p.T_C + 273.15, M = 28.9647 * p.gamma;
    const Z = p.Z ? p.Z : zFactor(P, T, p.gamma);
    const rhoG = P * M / (Z * R * T);
    const C = p.turnerCoef === 'turner' ? 3.09 * 1.2 : 3.09; // SI-эквивалент 1.593 (Коулман) / ×1.2 (Тернер)
    const v = C * Math.pow(p.sigma * 9.81 * (p.liqDensity - rhoG) / (rhoG * rhoG), 0.25);
    const A = Math.PI * Math.pow(p.tubing_mm / 1000, 2) / 4;
    return v * A * (P / 101325) * ((p.Tst_C + 273.15) / T) / Z * 86400;
  }

  /* ------------------------- prepare & quality ---------------------------- */
  /**
   * raw = {pwh:{t,v}, pline:{t,v}}, excl = Set(times ms) ручные исключения.
   * Возвращает выровненный ряд по меткам Pwh.
   */
  function prepare(raw, prm, excl) {
    const p = Object.assign({}, DEFAULTS, prm || {});
    excl = excl || {};
    const qa = { pwh: [], pline: [], gaps: [], dups: 0, notes: [] };
    function clean(s, key) {
      const t = [], v = [], f = [];
      for (let i = 0; i < s.t.length; i++) {
        if (i > 0 && s.t[i] === s.t[i - 1]) { qa.dups++; continue; }
        t.push(s.t[i]); v.push(s.v[i]); f.push('');
      }
      for (let i = 0; i < v.length; i++) {
        if (excl[key] && excl[key][t[i]]) f[i] = 'manual';
        else if (v[i] < -0.5) f[i] = 'neg';
        else if (v[i] > p.pMax) f[i] = 'range';
      }
      // одиночные выбросы: точка резко отличается от обоих соседей, соседи близки
      for (let i = 1; i < v.length - 1; i++) {
        if (f[i]) continue;
        const a = v[i - 1], b = v[i], c = v[i + 1];
        const thr = Math.max(p.spikeAbs, 0.3 * Math.max(Math.abs(a), Math.abs(c)));
        if (Math.abs(b - a) > thr && Math.abs(b - c) > thr && Math.sign(b - a) === Math.sign(b - c) && Math.abs(a - c) < thr * 0.5) {
          // для Pwh не помечаем пики, если сосед справа тоже высокий (перезапуск)
          f[i] = 'spike';
        }
      }
      f.forEach((x, i) => { if (x) qa[key].push({ t: t[i], v: v[i], flag: x }); });
      return { t, v, f };
    }
    const W = clean(raw.pwh, 'pwh'), L = clean(raw.pline || { t: [], v: [] }, 'pline');
    // интерполяция Pline на метки Pwh (только валидные точки)
    const Lt = [], Lv = []; L.t.forEach((x, i) => { if (!L.f[i]) { Lt.push(x); Lv.push(L.v[i]); } });
    const maxGap = p.maxGapMin * 60000;
    const n = W.t.length;
    const out = { t: new Float64Array(n), pwh: new Float64Array(n), pline: new Float64Array(n), dp: new Float64Array(n), flag: W.f, plineFlag: new Array(n).fill('') };
    for (let i = 0; i < n; i++) {
      const x = W.t[i];
      out.t[i] = x; out.pwh[i] = W.f[i] ? NaN : W.v[i];
      let pl = NaN;
      if (Lt.length) {
        const j = lowerIdx(Lt, x);
        if (j < Lt.length && Lt[j] === x) pl = Lv[j];
        else if (j > 0 && j < Lt.length && (Lt[j] - Lt[j - 1]) <= maxGap) pl = Lv[j - 1] + (Lv[j] - Lv[j - 1]) * (x - Lt[j - 1]) / (Lt[j] - Lt[j - 1]);
        else if (j > 0 && x - Lt[j - 1] <= (j === Lt.length ? maxGap : maxGap / 2)) pl = Lv[j - 1];
        else if (j < Lt.length && Lt[j] - x <= (j === 0 ? maxGap : maxGap / 2)) pl = Lv[j];
      }
      if (!isF(pl)) out.plineFlag[i] = 'gap';
      out.pline[i] = pl; out.dp[i] = out.pwh[i] - pl;
    }
    // пропуски по времени
    const dts = []; for (let i = 1; i < n; i++) dts.push(out.t[i] - out.t[i - 1]);
    const step = median(dts);
    for (let i = 1; i < n; i++) if (out.t[i] - out.t[i - 1] > 2.5 * step) qa.gaps.push({ from: out.t[i - 1], to: out.t[i], h: (out.t[i] - out.t[i - 1]) / H });
    qa.stepMin = step / 60000; qa.n = n; qa.nPline = L.t.length;
    qa.plineMissing = out.plineFlag.filter(Boolean).length;
    qa.span = n ? (out.t[n - 1] - out.t[0]) / H : 0;
    if (qa.gaps.length) qa.notes.push('Пропусков в данных: ' + qa.gaps.length + ' (макс. ' + Math.max.apply(null, qa.gaps.map(g => g.h)).toFixed(1) + ' ч).');
    if (qa.plineMissing) qa.notes.push('Точек без давления шлейфа после выравнивания: ' + qa.plineMissing + '.');
    if (qa.dups) qa.notes.push('Удалено дублей по времени: ' + qa.dups + '.');
    const fl = qa.pwh.length + qa.pline.length; if (fl) qa.notes.push('Помечено подозрительных значений: ' + fl + ' (исключены из анализа, можно восстановить вручную).');
    // проверка единиц
    const medL = median(Array.from(out.pline)); if (isF(medL) && medL < 2 && medL > 0) qa.notes.push('Давление шлейфа в среднем ' + medL.toFixed(2) + ' — проверьте единицы (возможно МПа).');
    return { s: out, qa, p };
  }

  /* -------------------------- event detection ----------------------------- */
  function detect(s, p, overrides) {
    overrides = overrides || {};
    const n = s.t.length; const state = new Array(n).fill('?');
    // 1) состояние W/D с гистерезисом
    let cur = 'D';
    for (let i = 0; i < n; i++) {
      const dp = s.dp[i], pw = s.pwh[i];
      if (!isF(pw)) { state[i] = cur; continue; }
      if (isF(dp)) {
        if (cur === 'D' && dp > p.dpOn) cur = 'W';
        else if (cur === 'W' && dp <= p.dpOff) cur = 'D';
      } else if (cur === 'W' && pw < 0.5) cur = 'D';
      state[i] = cur;
    }
    // 2) интервалы работы
    const works = []; let st = -1;
    for (let i = 0; i < n; i++) {
      if (state[i] === 'W' && st < 0) st = i;
      if ((state[i] !== 'W' || i === n - 1) && st >= 0) { const en = state[i] === 'W' ? i : i - 1; works.push([st, en, state[i] === 'W' && i === n - 1]); st = -1; }
    }
    // 3) кандидаты на продувку/перезапуск: резкий рост Pwh перед входом в работу
    const cand = [];
    works.forEach(([a, b, open], wi) => {
      // ищем крупнейший шаг роста в окне [-3ч, +1.5ч] от начала работы
      const t0 = s.t[a];
      let best = -1, bestRate = 0, bestRise = 0;
      for (let i = Math.max(1, lowerIdx(s.t, t0 - 3 * H)); i < n && s.t[i] <= t0 + 1.5 * H; i++) {
        const dv = s.pwh[i] - s.pwh[i - 1]; const dt = (s.t[i] - s.t[i - 1]) / H;
        if (!isF(dv) || dt <= 0) continue;
        if (dv > bestRise) { bestRise = dv; best = i; bestRate = dv / dt; }
      }
      if (best < 0) return;
      // давление до скачка (минимум за 1 ч до) и пик (максимум за 2 ч после)
      let pre = Infinity, peak = -Infinity, iPeak = best;
      for (let i = best - 1; i >= 0 && s.t[i] >= s.t[best] - 1.0 * H; i--) if (isF(s.pwh[i])) pre = Math.min(pre, s.pwh[i]);
      if (!isF(pre)) pre = s.pwh[best - 1];
      for (let i = best; i < n && s.t[i] <= s.t[best] + 2 * H; i++) if (s.pwh[i] > peak) { peak = s.pwh[i]; iPeak = i; }
      const jump = peak - pre;
      const workH = (s.t[b] - s.t[a]) / H;
      const nAfter = b - a + 1;
      const reasons = [];
      if (jump < p.jumpMin) reasons.push('скачок ' + jump.toFixed(1) + ' < ' + p.jumpMin);
      if (bestRate < p.rateMin) reasons.push('скорость роста ' + bestRate.toFixed(1) + ' < ' + p.rateMin + ' кгс/см²/ч');
      if (!open && workH < p.minWorkH) reasons.push('работа после скачка ' + (workH * 60).toFixed(0) + ' мин — похоже на шум/кратковременное открытие');
      if (nAfter < 3 && !open) reasons.push('менее 3 замеров после скачка');
      cand.push({ iEvent: best, tEvent: s.t[best], iStart: a, iEnd: b, open, pre, peak, iPeak, jump, rate: bestRate, reasons, valid: reasons.length === 0, wi });
    });
    // объединение близких: если работа короткая и следом снова скачок — оставляем первое событие как старт, рабочий интервал склеиваем
    const ev = [];
    cand.forEach(c => {
      const last = ev[ev.length - 1];
      if (last && !last.valid && c.valid && (c.tEvent - s.t[last.iEnd]) / H < p.mergeH && (s.t[last.iEnd] - s.t[last.iStart]) / H < p.minWorkH) {
        last.mergedInto = true;
      }
      ev.push(c);
    });
    // ручные решения пользователя (подтверждено / отклонено)
    ev.forEach(e => {
      const o = overrides[Math.round(e.tEvent)];
      e.auto = e.valid;
      if (o === 'confirm') { e.valid = true; e.manual = 'confirm'; }
      if (o === 'reject') { e.valid = false; e.manual = 'reject'; }
    });
    // 4) рабочие циклы = подтверждённый перезапуск + рабочий интервал (+склейка коротких отклонённых работ до следующего события)
    const cycles = [];
    const valid = ev.filter(e => e.valid);
    valid.forEach((e, k) => {
      const nextE = valid[k + 1];
      // конец работы: последний W-интервал, начавшийся до следующего валидного события
      let iEnd = e.iEnd, open = e.open;
      works.forEach(([a, b, op]) => { if (a > e.iStart && (!nextE || s.t[a] < nextE.tEvent - 0.01) && s.t[a] - s.t[iEnd] < p.mergeH * H) { iEnd = b; open = op; } });
      cycles.push({ ev: e, iStart: e.iStart, iEnd, open, tEvent: e.tEvent, tStart: s.t[e.iStart], tEnd: s.t[iEnd] });
    });
    cycles.forEach((c, k) => { const prev = cycles[k - 1]; c.downBeforeH = prev ? (c.tStart - prev.tEnd) / H : NaN; c.prevEnd = prev ? prev.tEnd : NaN; });
    // остановки (потеря работоспособности): конец каждого завершённого цикла
    return { state, works, events: ev, cycles };
  }

  /* --------------------------- exp-fit of ΔP ------------------------------ */
  function fitExp(tt, yy) { // y = c + A·exp(-t/τ), перебор τ + МНК для (c,A)
    const n = tt.length; if (n < 4) return null;
    let best = null;
    for (let lt = Math.log(0.2); lt <= Math.log(80); lt += 0.04) {
      const tau = Math.exp(lt);
      let s1 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < n; i++) { const x = Math.exp(-tt[i] / tau); s1++; sx += x; sy += yy[i]; sxx += x * x; sxy += x * yy[i]; }
      const den = s1 * sxx - sx * sx; if (Math.abs(den) < 1e-12) continue;
      const A = (s1 * sxy - sx * sy) / den, c = (sy - A * sx) / s1;
      let sse = 0; for (let i = 0; i < n; i++) { const e = yy[i] - (c + A * Math.exp(-tt[i] / tau)); sse += e * e; }
      if (!best || sse < best.sse) best = { A, c, tau, sse };
    }
    if (!best) return null;
    const my = mean(yy); let sst = 0; yy.forEach(y => sst += (y - my) ** 2);
    best.r2 = sst > 0 ? 1 - best.sse / sst : 0; best.sigma = Math.sqrt(best.sse / Math.max(1, n - 3)); best.n = n;
    best.f = (t) => best.c + best.A * Math.exp(-t / best.tau);
    best.solve = (y) => { const v = (y - best.c) / best.A; return (v > 0 && v < 1 && best.A > 0) ? -best.tau * Math.log(v) : NaN; };
    return best;
  }

  /* -------------------------- main analysis ------------------------------- */
  function analyze(raw, prm, opts) {
    opts = opts || {};
    const prep = prepare(raw, prm, opts.excl);
    const s = prep.s, p = prep.p, qa = prep.qa, n = s.t.length;
    const det = detect(s, p, opts.overrides);
    // дебит по точкам
    const q = new Float64Array(n), regime = new Array(n);
    const flowOK = !!(p.d_mm && p.gamma);
    for (let i = 0; i < n; i++) {
      if (det.state[i] !== 'W' || !flowOK) { q[i] = det.state[i] === 'W' ? NaN : 0; regime[i] = det.state[i] === 'W' ? '' : 'остановка'; continue; }
      const r = chokeFlow(s.pwh[i], s.pline[i], p); q[i] = r.q; regime[i] = r.regime || '';
    }
    // накопленная добыча (трапеции, только по рабочим интервалам), тыс. м³
    const cum = new Float64Array(n); let acc = 0;
    for (let i = 1; i < n; i++) {
      if (det.state[i] === 'W' && det.state[i - 1] === 'W' && isF(q[i]) && isF(q[i - 1])) acc += (q[i] + q[i - 1]) / 2 * ((s.t[i] - s.t[i - 1]) / 86400000) / 1000;
      cum[i] = acc;
    }
    // параметры циклов
    const cyc = det.cycles.map((c, k) => {
      const a = c.iStart, b = c.iEnd;
      const workH = (c.tEnd - c.tStart) / H;
      let iPk = a, pk = -Infinity; for (let i = a; i <= b; i++) if (s.pwh[i] > pk) { pk = s.pwh[i]; iPk = i; }
      const tt = [], yy = [];
      for (let i = iPk; i <= b; i++) if (isF(s.dp[i])) { tt.push((s.t[i] - s.t[iPk]) / H); yy.push(s.dp[i]); }
      const fit = fitExp(tt, yy);
      const gas = cum[b] - cum[a];
      const qs = []; for (let i = a; i <= b; i++) if (isF(q[i])) qs.push(q[i]);
      const plS = mean(Array.from(s.pline.slice(a, Math.min(b + 1, a + 3)))), plE = mean(Array.from(s.pline.slice(Math.max(a, b - 2), b + 1)));
      const dpS = s.dp[iPk]; let dpE = s.dp[b]; for (let i = b; i >= Math.max(a, b - 3) && !isF(dpE); i--) dpE = s.dp[i];
      const plineShare = (isF(plE) && isF(plS) && (dpS - dpE) > 0) ? (plE - plS) / (dpS - dpE) : NaN;
      // характер остановки: сколько замеров от ΔP≈мал до Pwh≈0
      let abrupt = null; if (!c.open && b + 1 < n) { const nx = s.pwh[b + 1]; abrupt = isF(nx) && nx < 0.5 * (s.pline[b] || 10); }
      // перезапуск после остановки: восстановление дебита
      const q1 = []; for (let i = a; i <= b && s.t[i] <= c.tStart + 1 * H; i++) if (isF(q[i])) q1.push(q[i]);
      const qEndArr = []; for (let i = b; i >= a && s.t[i] >= c.tEnd - 1 * H; i--) if (isF(q[i])) qEndArr.push(q[i]);
      return Object.assign(c, {
        k: k + 1, workH, peak: pk, iPeak: iPk, dpStart: dpS, dpEnd: dpE, pwhEnd: s.pwh[b], plineEnd: s.pline[b],
        plineStart: plS, plineShare, fit, gas, qMean: workH > 0 && flowOK ? gas * 1000 / (workH / 24) : NaN,
        q1h: mean(q1), qEnd: mean(qEndArr), abrupt, recovery: c.ev.jump, complete: !c.open,
        declineRate: workH > 0 ? (dpS - dpE) / workH : NaN
      });
    });
    const done = cyc.filter(c => c.complete);
    // критический перепад
    const dpEnds = done.map(c => c.dpEnd).filter(isF);
    const dpCritHist = median(dpEnds);
    const dpCrit = isF(p.dpCritManual) && p.dpCritManual !== null ? p.dpCritManual : dpCritHist;
    // статистика длительностей
    const durs = done.map(c => c.workH);
    const downs = cyc.map(c => c.downBeforeH).filter(isF);
    const stats = {
      nCycles: cyc.length, nDone: done.length,
      workMed: median(durs), workMean: mean(durs), workCV: std(durs) / mean(durs), workMin: Math.min.apply(null, durs), workMax: Math.max.apply(null, durs),
      downMed: median(downs), downMean: mean(downs), downP10: quantile(downs, 0.1), downMin: downs.length ? Math.min.apply(null, downs) : NaN, downMax: downs.length ? Math.max.apply(null, downs) : NaN,
      dpCritHist, dpCrit, dpCritMin: Math.min.apply(null, dpEnds), dpCritMax: Math.max.apply(null, dpEnds), dpCritCV: std(dpEnds) / mean(dpEnds),
      peakMed: median(cyc.map(c => c.peak)), jumpMed: median(cyc.map(c => c.ev.jump)),
      gasMed: median(done.map(c => c.gas)), qMeanMed: median(done.map(c => c.qMean)),
      corrDownNextWork: corr(done.map(c => c.downBeforeH), done.map(c => c.workH)),
      corrDownPeak: corr(cyc.map(c => c.downBeforeH), cyc.map(c => c.peak)),
      tauMed: median(done.map(c => c.fit ? c.fit.tau : NaN))
    };
    // регрессия пикового давления после перезапуска от длительности предшествующего простоя
    (function () {
      const xs = [], ys = []; cyc.forEach(c => { if (isF(c.downBeforeH) && isF(c.peak)) { xs.push(c.downBeforeH); ys.push(c.peak); } });
      if (xs.length < 4) { stats.peakReg = null; return; }
      const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
      const b = sxx > 0 ? sxy / sxx : 0; stats.peakReg = { a: my - b * mx, b, r: corr(xs, ys), n: xs.length };
    })();
    // эмпирическое время работы/простоя за период
    let tW = 0, tD = 0; for (let i = 1; i < n; i++) { const dt = (s.t[i] - s.t[i - 1]) / H; if (dt > 3) continue; if (det.state[i - 1] === 'W') tW += dt; else tD += dt; }
    stats.factWorkH = tW; stats.factDownH = tD; stats.factKexp = tW / (tW + tD);
    stats.factGas = cum[n - 1]; stats.factSpanH = (s.t[n - 1] - s.t[0]) / H;
    // шаблон цикла (медианные профили «живых» циклов от начала работы)
    const tpl = buildTemplate(s, q, done, p);
    // распределение времени работы (логнормальное)
    const life = fitLife(durs);
    // признаки накопления жидкости
    const loading = assessLoading(cyc, done, stats, p, s);
    // прогноз текущего цикла
    const forecast = makeForecast(s, det, cyc, tpl, life, stats, p, q);
    // оптимизация
    const opt = optimize(tpl, life, stats, opts.light ? Object.assign({}, p, { _light: true }) : p);
    // уровень достоверности
    const conf = confidence(stats, life, forecast, qa, flowOK);
    const A = { s, q, regime, cum, qa, p, det, cycles: cyc, done, stats, tpl, life, loading, forecast, opt, conf, flowOK };
    // прогноз давлений и давление продувки (единое ядро для всех окон и отчётов)
    A.plineM = plineModel(s, p);
    A.blow = { ok: false };
    A.traj = trajectory(A, p.fcMaxH, 'current');
    A.blow = blowdownPlan(A);
    A.traj = trajectory(A, p.fcMaxH, 'current'); // с учётом порога продувки
    blowdownTimes(A);
    A.priority = priority(A);
    A.status = classify(s, det, forecast, opt, stats, cyc, A);
    return A;
  }

  function buildTemplate(s, q, done, p) {
    const step = 0.25; const maxT = done.length ? Math.max.apply(null, done.map(c => c.workH)) : 0;
    const grid = []; for (let t = 0; t <= maxT + 1e-9; t += step) grid.push(t);
    const keys = ['pwh', 'pline', 'dp', 'q'];
    const prof = { t: grid, n: [] }; keys.forEach(k => { prof[k] = []; prof[k + 'Lo'] = []; prof[k + 'Hi'] = []; });
    grid.forEach(t => {
      const vals = { pwh: [], pline: [], dp: [], q: [] };
      done.forEach(c => {
        if (t > c.workH) return;
        const x = c.tStart + t * H;
        const xs = [], ys = { pwh: [], pline: [], dp: [], q: [] };
        // локальная интерполяция внутри цикла
        let j = c.iStart; while (j < c.iEnd && s.t[j + 1] <= x) j++;
        const j2 = Math.min(j + 1, c.iEnd); const f = s.t[j2] > s.t[j] ? (x - s.t[j]) / (s.t[j2] - s.t[j]) : 0;
        vals.pwh.push(s.pwh[j] + f * (s.pwh[j2] - s.pwh[j]));
        vals.pline.push(s.pline[j] + f * (s.pline[j2] - s.pline[j]));
        vals.dp.push(s.dp[j] + f * (s.dp[j2] - s.dp[j]));
        vals.q.push(q[j] + f * (q[j2] - q[j]));
        void xs; void ys;
      });
      prof.n.push(vals.dp.length);
      keys.forEach(k => { prof[k].push(median(vals[k])); prof[k + 'Lo'].push(quantile(vals[k], 0.2)); prof[k + 'Hi'].push(quantile(vals[k], 0.8)); });
    });
    // сглаживание q и dp (скользящее среднее 3)
    ['q', 'dp', 'pwh'].forEach(k => { const a = prof[k], b = a.slice(); for (let i = 1; i < a.length - 1; i++) if (isF(a[i - 1]) && isF(a[i + 1])) b[i] = (a[i - 1] + a[i] + a[i + 1]) / 3; prof[k] = b; });
    prof.at = (k, t) => { if (!grid.length) return NaN; if (t > grid[grid.length - 1]) { // экстраполяция последним значением
        const a = prof[k]; for (let i = a.length - 1; i >= 0; i--) if (isF(a[i])) return a[i]; return NaN; }
      return interp(grid, prof[k], t); };
    return prof;
  }

  function fitLife(durs) {
    const d = durs.filter(x => isF(x) && x > 0);
    if (d.length < 3) return { ok: false, n: d.length };
    const l = d.map(Math.log); const mu = mean(l); let sg = std(l); sg = Math.max(sg, 0.05);
    const S = (t) => t <= 0 ? 1 : 1 - Phi((Math.log(t) - mu) / sg);
    const Q = (pr) => { // квантиль времени отказа
      let lo = -10, hi = 10; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (Phi(m) < pr) lo = m; else hi = m; }
      return Math.exp(mu + sg * (lo + hi) / 2);
    };
    // Каплан-Мейер (без цензурирования) для проверки
    const sorted = d.slice().sort((a, b) => a - b);
    const km = sorted.map((t, i) => ({ t, S: 1 - (i + 1) / sorted.length }));
    // критерий согласия (KS)
    let ks = 0; sorted.forEach((t, i) => { const F = 1 - S(t); ks = Math.max(ks, Math.abs(F - (i + 1) / sorted.length), Math.abs(F - i / sorted.length)); });
    return { ok: true, n: d.length, mu, sigma: sg, S, Q, median: Math.exp(mu), mean: Math.exp(mu + sg * sg / 2), km, ks };
  }

  function assessLoading(cyc, done, st, p, s) {
    const f = [];
    if (done.length < 2) return { score: NaN, level: 'недостаточно данных', factors: [{ name: 'Количество завершённых циклов', val: done.length, ok: null, text: 'Нужно не менее 2–3 завершённых циклов.' }] };
    // 1 повторяемость
    const cv = st.workCV; const s1 = isF(cv) ? Math.max(0, Math.min(1, (0.6 - cv) / 0.45)) : 0.5;
    f.push({ name: 'Повторяемость рабочих циклов', val: 'CV = ' + (cv * 100).toFixed(0) + '%', ok: s1 > 0.5, w: 0.25, s: s1, text: s1 > 0.5 ? 'Длительности циклов близки — процесс систематический.' : 'Длительности сильно различаются — возможны внешние причины.' });
    // 2 влияние шлейфа
    const sh = median(done.map(c => c.plineShare));
    const s2 = isF(sh) ? Math.max(0, Math.min(1, 1 - Math.abs(sh) / 0.4)) : 0.5;
    f.push({ name: 'Давление в шлейфе в течение цикла', val: isF(sh) ? (sh * 100).toFixed(0) + '% снижения ΔP за счёт шлейфа' : '—', ok: s2 > 0.5, w: 0.25, s: s2, text: s2 > 0.5 ? 'Pline стабильно, снижение ΔP обусловлено скважиной.' : 'Значимая часть падения ΔP вызвана ростом Pline — проверьте систему сбора.' });
    // 3 устойчивость конечного перепада
    const s3 = isF(st.dpCritCV) ? Math.max(0, Math.min(1, (1.0 - st.dpCritCV) / 0.7)) : 0.5;
    f.push({ name: 'Стабильность перепада на момент остановки', val: 'ΔP = ' + st.dpCritMin.toFixed(2) + '…' + st.dpCritMax.toFixed(2) + ' кгс/см²', ok: s3 > 0.5, w: 0.2, s: s3, text: 'Остановки происходят при близком малом перепаде — характерно для «задавливания» жидкостью.' });
    // 4 характер снижения: затухающая кривая к Pline
    const fitsOK = done.filter(c => c.fit && c.fit.r2 > 0.85).length / done.length;
    f.push({ name: 'Характер кривой снижения ΔP', val: (fitsOK * 100).toFixed(0) + '% циклов описываются затухающей экспонентой', ok: fitsOK > 0.6, w: 0.15, s: fitsOK, text: 'Плавное затухание перепада до остановки — признак постепенного роста столба жидкости.' });
    // 5 резкая остановка
    const ab = done.filter(c => c.abrupt === true).length / Math.max(1, done.filter(c => c.abrupt !== null).length);
    f.push({ name: 'Резкий переход в остановку', val: (ab * 100).toFixed(0) + '% циклов', ok: ab > 0.6, w: 0.15, s: ab, text: 'После выхода ΔP на минимум Pwh падает до нуля — скважина прекращает подачу газа в шлейф.' });
    // 6 критерий Тернера/Коулмана (при наличии НКТ)
    if (p.tubing_mm && p.d_mm && p.gamma) {
      const below = done.filter(c => { const qc = criticalRate(c.pwhEnd, p); return isF(qc) && isF(c.qEnd) && c.qEnd < qc; }).length / done.length;
      f.push({ name: 'Критерий выноса жидкости (' + (p.turnerCoef === 'turner' ? 'Тернер' : 'Коулман') + ')', val: (below * 100).toFixed(0) + '% циклов в конце ниже критического дебита', ok: below > 0.5, w: 0.25, s: below, text: 'Дебит ниже критического — капли жидкости не выносятся потоком.' });
    }
    const wsum = f.reduce((a, x) => a + (x.w || 0), 0); const score = f.reduce((a, x) => a + (x.w || 0) * (x.s || 0), 0) / wsum;
    const level = score >= 0.7 ? 'выражены' : score >= 0.45 ? 'умеренные' : 'не подтверждены';
    const alt = [];
    if (s2 <= 0.5) alt.push('рост давления в шлейфе / ограничение системы сбора');
    if (s1 <= 0.5) alt.push('нерегулярные технологические операции');
    return { score, level, factors: f, alt };
  }

  function makeForecast(s, det, cyc, tpl, life, st, p, q) {
    const n = s.t.length; const last = n - 1; const tNow = s.t[last];
    // последние достоверные значения (Pwh и Pline могут писаться в разные моменты)
    const lastOk = (arr) => { for (let i = last; i >= 0 && s.t[i] >= tNow - 2 * H; i--) if (isF(arr[i])) return i; return -1; };
    const iw = lastOk(s.pwh), ip = lastOk(s.pline), id = lastOk(s.dp);
    const fc = { tNow, state: det.state[last], pwhNow: iw >= 0 ? s.pwh[iw] : NaN, plineNow: ip >= 0 ? s.pline[ip] : NaN, qNow: id >= 0 ? q[id] : q[last] };
    fc.dpNow = id === last ? s.dp[last] : fc.pwhNow - fc.plineNow;
    // скорость изменения ΔP за последний час
    const ie = id >= 0 ? id : last; let j = ie; while (j > 0 && s.t[j] > s.t[ie] - 1 * H) j--; while (j < ie && !isF(s.dp[j])) j++;
    fc.dpRate = (s.dp[ie] - s.dp[j]) / Math.max(1e-6, (s.t[ie] - s.t[j]) / H);
    const cur = cyc.length ? cyc[cyc.length - 1] : null;
    if (!cur || !cur.open || fc.state !== 'W') {
      fc.mode = 'down';
      const lastEnd = cyc.filter(c => c.complete).slice(-1)[0];
      fc.downSinceH = lastEnd ? (tNow - lastEnd.tEnd) / H : NaN;
      return fc;
    }
    fc.mode = 'work'; fc.cycle = cur;
    const age = (tNow - cur.tStart) / H; fc.age = age;
    const crit = st.dpCrit;
    // 1) аппроксимация текущего цикла
    const tt = [], yy = []; for (let i = cur.iPeak; i <= last; i++) if (isF(s.dp[i])) { tt.push((s.t[i] - s.t[cur.iStart]) / H); yy.push(s.dp[i]); }
    const fit = fitExp(tt.map(t => t - tt[0]), yy);
    let tFit = NaN, tFitLo = NaN, tFitHi = NaN;
    if (fit && fit.r2 > 0.85 && fit.n >= 5 && isF(crit)) {
      const off = tt[0]; const t1 = fit.solve(crit);
      if (isF(t1)) { tFit = off + t1; tFitLo = off + (fit.solve(crit + 2 * fit.sigma) || t1); tFitHi = off + (fit.solve(Math.max(1e-3, crit - 2 * fit.sigma)) || t1 * 1.5); }
    }
    fc.fit = fit; fc.fitOffset = tt[0];
    // 2) аналог по шаблону: где текущий ΔP находится на медианной кривой
    let tAn = NaN;
    if (tpl.t.length > 2 && isF(fc.dpNow)) {
      let ageEq = NaN; for (let i = 1; i < tpl.t.length; i++) { const a = tpl.dp[i - 1], b = tpl.dp[i]; if (isF(a) && isF(b) && a >= fc.dpNow && b <= fc.dpNow) { ageEq = tpl.t[i - 1] + (a - fc.dpNow) / (a - b || 1) * (tpl.t[i] - tpl.t[i - 1]); break; } }
      fc.ageEquivalent = ageEq;
      if (isF(ageEq) && life.ok) tAn = age + Math.max(0, life.median - ageEq);
    }
    // 3) условное распределение по истории
    let tLife = NaN, tLo = NaN, tHi = NaN;
    if (life.ok) {
      const Sa = life.S(age);
      const condQ = (pr) => { // время T: 1 - S(T)/S(a) = pr
        let lo = age, hi = age + 10 * life.median + 50; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (1 - life.S(m) / Math.max(Sa, 1e-9) < pr) lo = m; else hi = m; } return (lo + hi) / 2;
      };
      tLife = condQ(0.5); tLo = condQ(0.1); tHi = condQ(0.9);
      fc.pStop = (h) => 1 - life.S(age + h) / Math.max(Sa, 1e-9);
    }
    // скважина работает сейчас → остановка не может быть в прошлом
    const minAge = age + 0.25; const cl = (x) => isF(x) ? Math.max(x, minAge) : x;
    tFit = cl(tFit); tAn = cl(tAn); tLife = cl(tLife); tFitLo = isF(tFitLo) ? Math.max(tFitLo, age) : tFitLo; tLo = isF(tLo) ? Math.max(tLo, age) : tLo;
    const parts = []; if (isF(tFit)) parts.push([tFit, 0.4]); if (isF(tAn)) parts.push([tAn, 0.3]); if (isF(tLife)) parts.push([tLife, 0.3]);
    const ws = parts.reduce((a, x) => a + x[1], 0);
    fc.tCritAge = ws ? parts.reduce((a, x) => a + x[0] * x[1], 0) / ws : NaN;
    fc.tCritLoAge = Math.min.apply(null, [tLo, tFitLo].filter(isF).concat(isF(fc.tCritAge) ? [fc.tCritAge] : []));
    fc.tCritHiAge = Math.max.apply(null, [tHi, tFitHi].filter(isF).concat(isF(fc.tCritAge) ? [fc.tCritAge] : []));
    fc.methods = { fit: tFit, analog: tAn, history: tLife };
    fc.tCrit = cur.tStart + fc.tCritAge * H; fc.remainH = fc.tCritAge - age;
    fc.tCritLo = cur.tStart + fc.tCritLoAge * H; fc.tCritHi = cur.tStart + fc.tCritHiAge * H;
    fc.avgDpRate = (cur.dpStart - fc.dpNow) / Math.max(0.1, age);
    return fc;
  }

  /* ------------------------------ optimization ----------------------------- */
  function optimize(tpl, life, st, p) {
    const o = { ok: false, reasons: [] };
    if (!life.ok) { o.reasons.push('Менее 3 завершённых циклов — оптимизация невозможна.'); return o; }
    if (!tpl.t.length || !isF(tpl.at('q', 0))) { o.reasons.push('Не рассчитан дебит: укажите диаметр штуцера и относительную плотность газа.'); return o; }
    const Du = isF(p.D_unpl) && p.D_unpl !== null ? p.D_unpl : st.downMed;
    const Dp = isF(p.D_pl) && p.D_pl !== null ? p.D_pl : st.downP10;
    o.Du = Du; o.Dp = Dp; o.DuSrc = (p.D_unpl == null) ? 'медиана фактических простоев' : 'задано пользователем'; o.DpSrc = (p.D_pl == null) ? '10-й процентиль фактических простоев (самые короткие перезапуски)' : 'задано пользователем';
    const Lu = p.lossUnpl || 0, Lp = p.lossPl || 0;
    // поправка на неполное восстановление давления при более коротком простое (консервативно)
    let fD = 1; const pr = st.peakReg;
    if (pr && pr.b > 0 && pr.r > 0.15 && Dp < Du) { const pkU = pr.a + pr.b * Du, pkP = pr.a + pr.b * Dp; if (pkU > 0) fD = Math.max(0.6, Math.min(1, pkP / pkU)); }
    o.fD = fD;
    const dt = 0.05; const tMax = Math.max(life.Q(0.995), tpl.t[tpl.t.length - 1]) * 1.05;
    // накопительные интегралы W(τ)=∫S, G(τ)=∫S·q̄
    const T = [], Wc = [], Gc = []; let w = 0, g = 0;
    for (let t = 0; t <= tMax + 1e-9; t += dt) {
      const S0 = life.S(t), S1 = life.S(t + dt), q0 = tpl.at('q', t), q1 = tpl.at('q', t + dt);
      T.push(t); Wc.push(w); Gc.push(g);
      w += (S0 + S1) / 2 * dt; g += (S0 * q0 + S1 * q1) / 2 * dt / 24 / 1000; // тыс. м³
    }
    const rateAt = (i) => { const tau = T[i]; const Sf = life.S(tau); const down = (1 - Sf) * Du + Sf * Dp; const loss = (1 - Sf) * Lu + Sf * Lp; const cyc = Wc[i] + down; const G = Gc[i] * ((1 - Sf) + Sf * fD); return { tau, W: Wc[i], G, down, loss, cyc, Sf, rate: (G - loss) / cyc * 24 }; }; // тыс. м³/сут
    const curve = []; for (let i = 1; i < T.length; i++) curve.push(rateAt(i));
    // режим «до остановки» (τ → ∞)
    const Wf = Wc[Wc.length - 1], Gf = Gc[Gc.length - 1];
    const old = { tau: Infinity, W: Wf, G: Gf, down: Du, loss: Lu, cyc: Wf + Du, Sf: 0, rate: (Gf - Lu) / (Wf + Du) * 24 };
    let best = curve[0]; curve.forEach(c => { if (c.rate > best.rate) best = c; });
    // ограничим τ* разумной областью: не меньше 0.25·медианы
    const tauP = life.Q(1 - p.reliability); // сценарий 2: вероятность работы до продувки = reliability
    const pred = rateAt(Math.max(1, Math.min(T.length - 1, Math.round(tauP / dt))));
    o.ok = true; o.curve = curve; o.old = old; o.opt = best; o.pred = pred; o.Lu = Lu; o.Lp = Lp;
    o.rateAtTau = (tau) => tau === Infinity ? old : rateAt(Math.max(1, Math.min(T.length - 1, Math.round(tau / dt))));
    o.gainPct = (best.rate / old.rate - 1) * 100; o.predGainPct = (pred.rate / old.rate - 1) * 100;
    // плоскость оптимума: диапазон τ, где ≥ 99% максимума
    const band = curve.filter(c => c.rate >= best.rate * 0.99); o.tauRange = [band[0].tau, band[band.length - 1].tau];
    o.noGain = best.rate <= old.rate * 1.002 || best.tau >= life.Q(0.99);
    if (o.noGain) o.reasons.push('При заданных допущениях упреждающая продувка не увеличивает среднюю добычу: простой плановой продувки (' + Dp.toFixed(2) + ' ч) недостаточно меньше вынужденного (' + Du.toFixed(2) + ' ч).');
    // сценарии на горизонте
    const Hh = p.horizonDays * 24;
    const scen = (x, name) => {
      const nC = Hh / x.cyc; return { name, tau: x.tau, cycleH: x.cyc, workH: x.W, downH: x.down, nBlow: nC, nBlowMonth: 720 / x.cyc, nBlowYear: 8760 / x.cyc, work: nC * x.W, down: nC * x.down, losses: nC * x.loss, gas: x.rate * p.horizonDays, rate: x.rate, kexp: x.W / x.cyc, pPremature: 1 - x.Sf };
    };
    o.scen = { old: scen(old, 'Существующий режим'), pred: scen(pred, 'Прогнозируемый режим'), opt: scen(best, 'Оптимизированный режим') };
    ['pred', 'opt'].forEach(k => { o.scen[k].extra = o.scen[k].gas - o.scen.old.gas; o.scen[k].extraPct = (o.scen[k].gas / o.scen.old.gas - 1) * 100; o.scen[k].downCut = o.scen.old.down - o.scen[k].down; });
    if (p.gasPrice) ['old', 'pred', 'opt'].forEach(k => { o.scen[k].revenue = o.scen[k].gas * p.gasPrice; });
    // сравнение интервалов (таблица)
    o.grid = [];
    const steps = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25].map(f => f * life.median);
    steps.forEach(tau => { const i = Math.max(1, Math.min(T.length - 1, Math.round(tau / dt))); const r = rateAt(i); o.grid.push(Object.assign({ gainPct: (r.rate / old.rate - 1) * 100 }, r)); });
    o.grid.push(Object.assign({ gainPct: 0 }, old));
    // чувствительность к длительности упреждающей продувки
    if (!p._noSens && !p._light) {
      o.sens = [];
      [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5].filter(x => x < Du).concat([Du]).forEach(x => {
        const r = optimize(tpl, life, st, Object.assign({}, p, { D_pl: x, D_unpl: Du, _noSens: true }));
        if (r.ok) o.sens.push({ Dp: x, tau: r.noGain ? NaN : r.opt.tau, gainPct: r.noGain ? 0 : r.gainPct });
      });
    }
    return o;
  }

  /* ===================== ПРОГНОЗ ДАВЛЕНИЙ (Pline, Pwh, ΔP) ===================== */
  /** Модель давления в шлейфе: робастный затухающий тренд (Тейл–Сен) + суточная составляющая. */
  function plineModel(s, p) {
    const T = [], V = []; for (let i = 0; i < s.t.length; i++) if (isF(s.pline[i])) { T.push(s.t[i]); V.push(s.pline[i]); }
    const m = { ok: false, n: T.length };
    if (T.length < 8) { m.reason = 'Недостаточно замеров давления в шлейфе'; return m; }
    const tEnd = T[T.length - 1]; const spanH = (tEnd - T[0]) / H; const win = Math.min(p.plineWinH, spanH);
    const i0 = lowerIdx(T, tEnd - win * H); const tw = [], vw = [];
    for (let i = i0; i < T.length; i++) { tw.push((T[i] - tEnd) / H); vw.push(V[i]); }
    // Тейл–Сен по прореженным парам
    const slopes = []; const nw = tw.length; const stride = Math.max(1, Math.floor(nw * nw / 2 / 4000));
    let c = 0; for (let i = 0; i < nw; i++) for (let j = i + 1; j < nw; j++) { if ((c++ % stride) !== 0) continue; const dt = tw[j] - tw[i]; if (dt > 0.5) slopes.push((vw[j] - vw[i]) / dt); }
    const b = slopes.length ? median(slopes) : 0;
    const a = median(vw.map((v, i) => v - b * tw[i]));
    const bLo = quantile(slopes, 0.25), bHi = quantile(slopes, 0.75);
    // суточная составляющая по остаткам (если ≥ 2 суток и уменьшает разброс ≥ 10%)
    const res = vw.map((v, i) => v - (a + b * tw[i]));
    const hours = new Array(24).fill(0).map(() => []);
    for (let i = i0; i < T.length; i++) hours[new Date(T[i]).getHours()].push(res[i - i0]);
    let diurnal = null;
    if (win >= 48) { const prof = hours.map(h => h.length >= 2 ? median(h) : 0); const mp = mean(prof); const pr2 = prof.map(x => x - mp); const r2 = res.map((r, k) => r - pr2[new Date(T[i0 + k]).getHours()]); const sd0 = 1.4826 * median(res.map(Math.abs)), sd1 = 1.4826 * median(r2.map(Math.abs)); if (sd1 < 0.9 * sd0) diurnal = pr2; }
    const resid = diurnal ? res.map((r, k) => r - diurnal[new Date(T[i0 + k]).getHours()]) : res;
    const sigma = Math.max(0.01, 1.4826 * median(resid.map(Math.abs)));
    // шум датчика: вторые разности
    const d2 = []; for (let i = 1; i < V.length - 1; i++) d2.push(V[i + 1] - 2 * V[i] + V[i - 1]);
    const noise = 1.4826 * median(d2.map(Math.abs)) / Math.sqrt(6);
    const damp = Math.max(6, win / 2); // затухание тренда: не экстраполируем линейно бесконечно
    const heff = (h) => damp * (1 - Math.exp(-Math.max(0, h) / damp));
    Object.assign(m, { ok: true, tEnd, a, b, bLo, bHi, diurnal: !!diurnal, sigma, noise, win, damp,
      level: a, rate: b,
      f: (t) => { const h = (t - tEnd) / H; const base = h <= 0 ? a + b * h : a + b * heff(h); return base + (diurnal ? diurnal[new Date(t).getHours()] : 0); },
      sd: (t) => { const h = Math.max(0, (t - tEnd) / H); const sb = isF(bHi - bLo) ? (bHi - bLo) / 1.35 : 0; return Math.sqrt(sigma * sigma + Math.pow(sb * heff(h), 2)); } });
    m.constant = Math.abs(b) * win < Math.max(2 * sigma, 0.05) && !diurnal;
    return m;
  }

  /** Отклонение Pline от среднего уровня в зависимости от возраста цикла (всплеск при перезапуске). */
  function plineDev(tpl) { const base = median(tpl.pline); return (te) => { const v = tpl.at('pline', te) - base; return isF(v) ? v : 0; }; }

  /**
   * Совместная траектория Pwh/Pline/ΔP/q от последнего замера.
   * scenario: 'current' — продувка после остановки (существующий режим);
   *           'plan' — продувка при достижении рекомендуемого перепада (план продувок).
   */
  function trajectory(A, hours, scenario, sc) {
    const s = A.s, p = A.p, st = A.stats, fc = A.forecast, tpl = A.tpl, life = A.life, pm = A.plineM, bp = A.blow;
    const out = { t: [], pwh: [], pline: [], dp: [], q: [], phase: [], pwhLo: [], pwhHi: [], plineLo: [], plineHi: [], dpLo: [], dpHi: [], conf: [], events: [], scenario: scenario || 'current' };
    if (!pm || !pm.ok || !tpl.t.length || !life.ok) { out.reason = !pm || !pm.ok ? (pm && pm.reason) || 'Нет модели Pline' : 'Недостаточно завершённых циклов для прогноза'; return out; }
    const t0 = fc.tNow, step = 0.25 * H, tEnd = t0 + hours * H;
    const dev = plineDev(tpl); const Du = A.opt && A.opt.ok ? A.opt.Du : st.downMed; const Dp = A.opt && A.opt.ok ? A.opt.Dp : st.downP10;
    const downPwh = median(s.pwh.filter((v, i) => A.det.state[i] === 'D'));
    const crit = st.dpCrit;
    let tRecS = bp ? bp.tRec : NaN, trigS = bp ? bp.dpTrigger : NaN, tauS = bp ? bp.tauRec : NaN;
    if (sc && scenario === 'plan') { tauS = sc.tau; trigS = sc.dpTrigger; tRecS = NaN; const base = A.traj; if (fc.mode === 'work') { if (fc.dpNow <= trigS) tRecS = fc.tNow; else if (base) for (let i = 0; i < base.t.length && base.phase[i] === 'work'; i++) if (base.dp[i] <= trigS) { tRecS = base.t[i]; break; } } }
    const cycleLen = scenario === 'plan' && isF(tauS) ? tauS : life.median;
    // сегменты: [тип, начало, конец, te0, dpStartCorr, tStop]
    const segs = [];
    let cur = t0;
    if (fc.mode === 'work') {
      let stopAt = fc.tCrit; let kind = 'stop';
      if (scenario === 'plan' && isF(tRecS) && tRecS < stopAt) { stopAt = Math.max(t0, tRecS); kind = 'blow'; }
      segs.push({ k: 'work', a: t0, b: stopAt, te0: isF(fc.ageEquivalent) ? fc.ageEquivalent : fc.age, first: true, endKind: kind });
      cur = stopAt; segs.push({ k: kind === 'blow' ? 'blow' : 'down', a: cur, b: cur + (kind === 'blow' ? Dp : Du) * H }); cur += (kind === 'blow' ? Dp : Du) * H;
    } else {
      const rem = Math.max(0.25, (scenario === 'plan' ? Dp : Du) - (isF(fc.downSinceH) ? fc.downSinceH : 0));
      segs.push({ k: 'down', a: t0, b: t0 + rem * H }); cur = t0 + rem * H;
    }
    while (cur < tEnd) {
      segs.push({ k: 'work', a: cur, b: cur + cycleLen * H, te0: 0, endKind: scenario === 'plan' ? 'blow' : 'stop' }); cur += cycleLen * H;
      const D = scenario === 'plan' ? Dp : Du; segs.push({ k: scenario === 'plan' ? 'blow' : 'down', a: cur, b: cur + D * H }); cur += D * H;
    }
    segs.forEach(sg => { if (sg.k === 'work') { out.events.push({ t: sg.a, type: sg.first ? 'now' : 'restart' }); out.events.push({ t: sg.b, type: sg.endKind === 'blow' ? 'blowdown' : 'stop' }); } });
    const baseConf = A.conf.score; const cyc = (st.workMed || 6) + (st.downMed || 2);
    const sg0 = segs[0]; const plC0 = isF(fc.plineNow) ? fc.plineNow - (pm.f(t0) + (sg0.k === 'work' ? dev(sg0.te0) : 0)) : NaN;
    for (let t = t0; t <= tEnd + 1; t += step) {
      const sg = segs.find(x => t >= x.a && t < x.b) || segs[segs.length - 1];
      const plC = isF(plC0) ? plC0 * Math.exp(-(t - t0) / H / 1.0) : 0; // плавный переход от фактического Pline к модели
      const plM = pm.f(t) + plC, plS = pm.sd(t);
      let pl = plM, dp, dpl, dph, ph = sg.k;
      if (sg.k === 'work') {
        const te = sg.te0 + (t - sg.a) / H; pl = plM + dev(te);
        let corr = 0;
        if (sg.first) { // непрерывность с последним замером и выход на ΔPкрит в момент остановки
          const te0 = sg.te0, teS = sg.te0 + (sg.b - sg.a) / H; const u = sg.b > sg.a ? (t - sg.a) / (sg.b - sg.a) : 1;
          const c0 = fc.dpNow - tpl.at('dp', te0); const target = sg.endKind === 'stop' ? crit : trigS; const cS = isF(target) ? target - tpl.at('dp', teS) : 0;
          corr = c0 * (1 - u) + cS * u;
        }
        dp = tpl.at('dp', te) + corr; dpl = tpl.at('dpLo', te) + corr; dph = tpl.at('dpHi', te) + corr;
      } else { dp = (isF(downPwh) ? downPwh : 0) - pl; dpl = dph = dp; }
      const pwh = pl + dp;
      out.t.push(t); out.pline.push(pl); out.dp.push(dp); out.pwh.push(pwh); out.phase.push(ph);
      out.plineLo.push(pl - 1.28 * plS); out.plineHi.push(pl + 1.28 * plS);
      out.dpLo.push(dpl); out.dpHi.push(dph);
      const spreadW = Math.sqrt(Math.pow((dph - dpl) / 2, 2) + Math.pow(1.28 * plS, 2));
      out.pwhLo.push(pwh - spreadW); out.pwhHi.push(pwh + spreadW);
      out.q.push(ph === 'work' && A.flowOK ? chokeFlow(pwh, pl, p).q : 0);
      out.conf.push(baseConf * Math.exp(-((t - t0) / H) / (2 * cyc)));
    }
    return out;
  }
  /** Траектория по сценарию: 'current' — существующий режим; 'best' | 'early' | 'opt' | 'late' — плановые продувки. */
  function trajFor(A, scenario) {
    if (!scenario || scenario === 'current') return A.traj;
    const b = A.blow; if (!b || !b.ok) return A.traj;
    const sc = scenario === 'best' || scenario === 'plan' ? b.best : b.scen.find(x => x.key === scenario) || b.best;
    A._tr = A._tr || {}; const k = sc.key; if (!A._tr[k]) A._tr[k] = trajectory(A, A.p.fcMaxH, 'plan', sc); return A._tr[k];
  }
  const confLevel = (c) => c >= 0.7 ? 'высокая' : c >= 0.45 ? 'средняя' : c > 0.15 ? 'низкая' : 'недостаточная';

  /** Значения на заданный момент: ФАКТ / ПРОГНОЗ / НЕТ ДАННЫХ. */
  function valueAt(A, t, scenario) {
    const s = A.s, n = s.t.length, step = (A.qa.stepMin || 15) * 60000;
    const r = { t, src: 'none', pwh: NaN, pline: NaN, dp: NaN, q: NaN, phase: '', conf: NaN, confLevel: '', lastFact: s.t[n - 1], forecastMade: A.forecast.tNow };
    if (t <= s.t[n - 1] + step * 0.75) {
      const i = Math.min(n - 1, lowerIdx(s.t, t)); let k = i; if (i > 0 && Math.abs(s.t[i - 1] - t) < Math.abs(s.t[i] - t)) k = i - 1;
      if (Math.abs(s.t[k] - t) <= step * 0.75 && isF(s.pwh[k])) {
        Object.assign(r, { src: 'fact', tFact: s.t[k], pwh: s.pwh[k], pline: s.pline[k], dp: s.dp[k], q: A.q[k], phase: A.det.state[k] === 'W' ? 'work' : 'down', conf: 1, confLevel: 'измерение' });
        if (!isF(r.pline)) r.plineSrc = 'none';
        return r;
      }
      if (t < s.t[0]) return r; // до начала истории
      r.reason = 'Пропуск измерений'; return r;
    }
    const h = (t - s.t[n - 1]) / H;
    if (h > A.p.fcMaxH) { r.reason = 'Вне горизонта обоснованного прогноза (' + A.p.fcMaxH + ' ч)'; return r; }
    const tr = trajFor(A, scenario);
    if (!tr || !tr.t.length) { r.reason = (tr && tr.reason) || 'Прогноз не построен'; return r; }
    const j = Math.min(tr.t.length - 1, Math.max(0, Math.round((t - tr.t[0]) / (0.25 * H))));
    const c = tr.conf[j]; if (!(c > 0.15)) { r.reason = 'Достоверность прогноза недостаточна'; return r; }
    Object.assign(r, { src: 'forecast', pwh: tr.pwh[j], pline: tr.pline[j], dp: tr.dp[j], q: tr.q[j], phase: tr.phase[j], conf: c, confLevel: confLevel(c), pwhLo: tr.pwhLo[j], pwhHi: tr.pwhHi[j], plineLo: tr.plineLo[j], plineHi: tr.plineHi[j] });
    return r;
  }

  /* ============ Критическое и рекомендуемое устьевое давление продувки ============ */
  function blowdownPlan(A) {
    const s = A.s, st = A.stats, p = A.p, tpl = A.tpl, o = A.opt, pm = A.plineM, fc = A.forecast;
    const b = { ok: false };
    if (!isF(st.dpCrit) || !pm || !pm.ok || !tpl.t.length) { b.reason = 'Недостаточно данных для расчёта давления продувки'; return b; }
    // скорость снижения ΔP за последний час перед остановкой
    const rates = A.done.map(c => { const tt = c.tEnd - 1 * H; let i = c.iEnd; while (i > c.iStart && s.t[i] > tt) i--; const dh = (c.tEnd - s.t[i]) / H; return dh > 0.2 ? (s.dp[i] - c.dpEnd) / dh : NaN; }).filter(isF);
    const rEnd = Math.max(0, median(rates));
    const sMeas = Math.max(p.measErr, pm.noise || 0);
    const compReact = rEnd * p.reactH, compMeas = 2 * Math.sqrt(2) * sMeas, compPline = 1.28 * pm.sigma;
    const dpSafetyMin = Math.max(0.1, compReact + Math.sqrt(compMeas * compMeas + compPline * compPline));
    const plNow = pm.f(fc.tNow);
    // сценарии
    const dpWarn = st.dpCrit + dpSafetyMin;
    let tauLate = NaN; for (let i = 0; i < tpl.t.length; i++) if (isF(tpl.dp[i]) && tpl.dp[i] <= dpWarn) { tauLate = tpl.t[i]; break; }
    if (!isF(tauLate)) tauLate = A.life.ok ? A.life.Q(0.5) : st.workMed;
    const tauOpt = o.ok && !o.noGain ? o.opt.tau : tauLate;
    const tauEarly = Math.max(0.5, p.earlyFactor * tauOpt);
    const mk = (name, key, tau, why) => {
      const dpT = Math.max(tpl.at('dp', tau), dpWarn);
      const sc = { name, key, tau, why, dpTrigger: dpT, pwhTrigger: plNow + dpT };
      if (o.ok && o.rateAtTau) { const r = o.rateAtTau(tau); const Hd = p.horizonDays * 24, nC = Hd / r.cyc;
        Object.assign(sc, { rate: r.rate, cycleH: r.cyc, nBlow: nC, nBlowMonth: 720 / r.cyc, down: nC * r.down, work: nC * r.W, losses: nC * r.loss, gas: r.rate * p.horizonDays, kexp: r.W / r.cyc, pPremature: 1 - r.Sf, extra: r.rate * p.horizonDays - o.scen.old.gas, extraPct: (r.rate / o.old.rate - 1) * 100 }); }
      return sc;
    };
    b.scen = [mk('Ранняя продувка', 'early', tauEarly, Math.round(p.earlyFactor * 100) + '% оптимального интервала'), mk('Оптимальная продувка', 'opt', tauOpt, o.ok && !o.noGain ? 'максимум средней добычи (модель восстановления)' : 'упреждающий режим не даёт выигрыша — по предупредительному порогу'), mk('Поздняя продувка', 'late', tauLate, 'при достижении предупредительного перепада ΔPкрит + запас')];
    const withRate = b.scen.filter(x => isF(x.rate));
    b.best = withRate.length ? withRate.reduce((a, x) => x.rate > a.rate ? x : a) : b.scen[1];
    b.scen.forEach(x => x.best = x === b.best);
    b.dpCrit = st.dpCrit; b.dpSafetyMin = dpSafetyMin; b.dpTrigger = b.best.dpTrigger; b.dpSafety = b.dpTrigger - st.dpCrit;
    b.dpSafetyOpt = b.dpSafety - dpSafetyMin; b.tauRec = b.best.tau;
    b.parts = { react: compReact, meas: compMeas, pline: compPline, rEnd, sMeas, reactH: p.reactH, sigmaPline: pm.sigma };
    b.plNow = plNow; b.pwhCrit = plNow + st.dpCrit; b.pwhWarn = plNow + dpWarn; b.pwhBlow = plNow + b.dpTrigger;
    b.ok = true; return b;
  }
  /** Моменты: достижение давления продувки, критического перепада, остановки (по траектории). */
  function blowdownTimes(A) {
    const b = A.blow, fc = A.forecast, tr = A.traj; if (!b.ok) return;
    if (fc.mode !== 'work') { b.tRec = fc.tNow; b.tCritPoint = NaN; b.tStop = fc.tNow; return; }
    b.tStop = fc.tCrit;
    let tRec = NaN, tCp = NaN;
    if (fc.dpNow <= b.dpTrigger) tRec = fc.tNow;
    if (tr && tr.t.length) for (let i = 0; i < tr.t.length && tr.phase[i] === 'work'; i++) { if (!isF(tRec) && tr.dp[i] <= b.dpTrigger) tRec = tr.t[i]; if (!isF(tCp) && tr.dp[i] <= b.dpCrit) tCp = tr.t[i]; }
    if (!isF(tCp)) tCp = fc.tCrit;
    if (!isF(tRec)) tRec = Math.max(fc.tNow, fc.tCrit - Math.max(0.5, b.parts.reactH) * H);
    b.tRec = Math.min(tRec, fc.tCrit); b.tCritPoint = Math.min(tCp, fc.tCrit);
    const iNow = A.s.t.length - 1; b.pwhNow = A.s.pwh[iNow]; b.plineNow = A.s.pline[iNow];
    // динамические давления на момент рекомендуемой продувки
    const at = (t) => { const j = Math.max(0, Math.min(tr.t.length - 1, Math.round((t - tr.t[0]) / (0.25 * H)))); return tr.t.length ? { pwh: tr.pwh[j], pline: tr.pline[j], dp: tr.dp[j] } : null; };
    const vr = at(b.tRec); if (vr) { b.pwhBlowAtRec = vr.pline + b.dpTrigger; b.plineAtRec = vr.pline; }
    const vs = at(b.tCritPoint); if (vs) b.pwhCritAtStop = vs.pline + b.dpCrit;
  }
  /** Приоритет действий (единая шкала для дашборда, фонда и отчётов). */
  const PRIORITIES = ['Нормальный режим', 'Требуется наблюдение', 'Планировать продувку', 'Скоро требуется продувка', 'Срочная продувка', 'Критическое состояние', 'Возможная остановка'];
  function priority(A) {
    const fc = A.forecast, b = A.blow, st = A.stats; let k = 0, why = '';
    if (fc.mode !== 'work') { k = 6; why = 'Pwh ≤ Pline — подача газа в шлейф прекращена'; }
    else if ((isF(fc.remainH) && fc.remainH <= 0.5) || (isF(st.dpCrit) && fc.dpNow <= st.dpCrit * 1.15)) { k = 5; why = 'ΔP ' + fc.dpNow.toFixed(2) + ' у критического значения ' + st.dpCrit.toFixed(2); }
    else if (b.ok && b.tRec <= fc.tNow) { k = 4; why = 'достигнуто рекомендуемое давление продувки'; }
    else if (b.ok && (b.tRec - fc.tNow) / H <= 1) { k = 3; why = 'до рекомендуемой продувки ' + fmtH((b.tRec - fc.tNow) / H); }
    else if (b.ok && (b.tRec - fc.tNow) / H <= 4) { k = 2; why = 'продувка в ближайшие 4 ч'; }
    else if ((b.ok && fc.age >= 0.5 * b.tauRec) || (b.ok && fc.dpNow <= 2 * b.dpTrigger)) { k = 1; why = 'вторая половина цикла'; }
    else why = 'запас до продувки достаточный';
    return { level: k, text: PRIORITIES[k], why };
  }

  /** Проверка прогноза на истории: прогноз, сделанный за L часов до фактической остановки. */
  function backtest(raw, prm, opts, leads) {
    leads = leads || [1, 2, 3];
    const full = analyze(raw, prm, Object.assign({}, opts, { light: true }));
    const rows = [];
    full.done.forEach((c, k) => {
      if (k < 3) return; // нужна история не менее 3 циклов
      leads.forEach(L => {
        const tc = c.tEnd - L * H; if (tc <= c.tStart + 0.5 * H) return;
        const cut = (sr) => { const i = lowerIdx(sr.t, tc + 1); return { t: sr.t.slice(0, i), v: sr.v.slice(0, i) }; };
        const A2 = analyze({ pwh: cut(raw.pwh), pline: cut(raw.pline) }, prm, Object.assign({}, opts, { light: true }));
        if (A2.forecast.mode !== 'work' || !isF(A2.forecast.tCrit)) return;
        const err = (A2.forecast.tCrit - c.tEnd) / H;
        const tRec = A2.blow.ok ? A2.blow.tRec : NaN;
        rows.push({ cycle: c.k, lead: L, tCut: tc, actual: c.tEnd, pred: A2.forecast.tCrit, errH: err, inBand: c.tEnd >= A2.forecast.tCritLo && c.tEnd <= A2.forecast.tCritHi, recBeforeStop: isF(tRec) ? tRec < c.tEnd : null, pwhCritPred: A2.blow.ok ? A2.blow.pwhCrit : NaN, dpCrit: A2.stats.dpCrit });
      });
    });
    const by = {}; leads.forEach(L => { const r = rows.filter(x => x.lead === L); by[L] = { n: r.length, mae: mean(r.map(x => Math.abs(x.errH))), bias: mean(r.map(x => x.errH)), hit: r.length ? r.filter(x => x.inBand).length / r.length : NaN, recOK: r.length ? r.filter(x => x.recBeforeStop).length / r.length : NaN }; });
    return { rows, by };
  }

  function confidence(st, life, fc, qa, flowOK) {
    const notes = []; let score = 1;
    const n = st.nDone;
    if (n < 3) { score = 0; notes.push('Менее 3 завершённых циклов: прогноз и оптимизация недостоверны.'); }
    else if (n < 6) { score *= 0.55; notes.push('Мало циклов (' + n + ') — достоверность низкая, накопите историю.'); }
    else if (n < 12) { score *= 0.8; notes.push('Циклов: ' + n + ' — достоверность средняя.'); }
    if (isF(st.workCV) && st.workCV > 0.4) { score *= 0.75; notes.push('Высокая изменчивость длительности циклов (CV ' + (st.workCV * 100).toFixed(0) + '%).'); }
    if (life.ok && life.ks > 0.3) { score *= 0.85; notes.push('Распределение времени работы описывается логнормальным законом с заметной погрешностью (KS=' + life.ks.toFixed(2) + ').'); }
    if (qa.stepMin > 20) { score *= 0.9; notes.push('Периодичность измерений ' + qa.stepMin.toFixed(0) + ' мин ограничивает точность моментов событий (±' + (qa.stepMin / 2).toFixed(0) + ' мин).'); }
    if (!flowOK) notes.push('Дебит не рассчитан — оптимизация по добыче недоступна.');
    const level = score >= 0.75 ? 'высокая' : score >= 0.5 ? 'средняя' : score > 0 ? 'низкая' : 'недостаточно данных';
    return { score, level, notes };
  }

  function classify(s, det, fc, opt, st, cyc, A) {
    const n = s.t.length; const last = n - 1;
    if (A && A.priority && fc.mode === 'work') {
      const pr = A.priority, b = A.blow; const sinceEvent = (s.t[last] - fc.cycle.tEvent) / H;
      const r2 = { code: 'normal', text: 'Нормальная работа', reason: '' };
      if (sinceEvent < 1.5 && pr.level < 4) { r2.code = 'after'; r2.text = 'После продувки'; r2.reason = 'Перезапуск ' + fmtH(sinceEvent) + ' назад, восстановление режима.'; return r2; }
      if (pr.level >= 5) { r2.code = 'critical'; r2.text = 'Критическое состояние'; }
      else if (pr.level >= 3) { r2.code = 'soon'; r2.text = 'Скоро потребуется продувка'; }
      else if (pr.level >= 1) { r2.code = 'watch'; r2.text = 'Наблюдение'; }
      r2.reason = pr.text + ': ' + pr.why + '.' + (b.ok ? ' Pwh ' + fc.pwhNow.toFixed(2) + ' кгс/см², рекомендуемое давление продувки ' + b.pwhBlow.toFixed(2) + ', критическое ' + b.pwhCrit.toFixed(2) + '.' : '');
      return r2;
    }
    const r = { code: 'normal', text: 'Нормальная работа', reason: '' };
    if (fc.mode === 'down') {
      r.code = 'stopped'; r.text = 'Остановка скважины';
      r.reason = 'Pwh ≤ Pline: подача газа в шлейф прекращена' + (isF(fc.downSinceH) ? ' ' + fc.downSinceH.toFixed(1) + ' ч назад' : '') + '. Требуется продувка/перезапуск.';
      return r;
    }
    const cur = fc.cycle; const sinceEvent = (s.t[last] - cur.tEvent) / H;
    const tauOpt = opt.ok && !opt.noGain ? opt.opt.tau : NaN;
    if (sinceEvent < 1.5) { r.code = 'after'; r.text = 'После продувки'; r.reason = 'Перезапуск ' + sinceEvent.toFixed(1) + ' ч назад, восстановление режима.'; }
    else if ((isF(fc.remainH) && fc.remainH <= 0.75) || (isF(st.dpCrit) && fc.dpNow <= st.dpCrit * 1.3)) { r.code = 'critical'; r.text = 'Критическое состояние'; r.reason = 'Перепад ' + fc.dpNow.toFixed(2) + ' кгс/см² близок к критическому ' + st.dpCrit.toFixed(2) + '.'; }
    else if ((isF(tauOpt) && fc.age >= tauOpt - 1) || (isF(fc.remainH) && fc.remainH <= 2)) { r.code = 'soon'; r.text = 'Скоро потребуется продувка'; r.reason = (isF(tauOpt) && fc.age >= tauOpt ? 'Оптимальный момент продувки наступил (цикл ' + fmtH(fc.age) + ' ≥ ' + fmtH(tauOpt) + '). ' : '') + 'До прогнозной потери работоспособности ' + fmtH(fc.remainH) + '.'; }
    else if ((isF(tauOpt) && fc.age >= 0.6 * tauOpt) || (isF(fc.remainH) && fc.remainH <= 0.4 * st.workMed)) { r.code = 'watch'; r.text = 'Наблюдение'; r.reason = 'Цикл во второй половине, перепад снижается со скоростью ' + Math.abs(fc.dpRate).toFixed(2) + ' кгс/см²/ч.'; }
    else r.reason = 'Перепад ' + fc.dpNow.toFixed(1) + ' кгс/см², запас до критического значения достаточный.';
    void cyc;
    return r;
  }

  /** Рекомендация: текст + время. */
  function recommend(A) {
    const fc = A.forecast, o = A.opt, st = A.stats, b = A.blow; const rec = { created: Date.now(), dataTo: fc.tNow, items: [] };
    if (fc.mode === 'down') {
      rec.when = fc.tNow; rec.inH = 0;
      rec.title = 'Провести продувку и перезапуск';
      rec.text = 'Скважина не подаёт газ в шлейф (Pwh ≤ Pline). Типичный простой по истории — ' + fmtH(st.downMed) + '.';
    } else if (b.ok) {
      rec.when = b.tRec; rec.inH = (b.tRec - fc.tNow) / H;
      rec.title = rec.inH > 0.05 ? 'Продувка через ' + fmtH(rec.inH) + ' при Pwh ≈ ' + b.pwhBlowAtRec.toFixed(1) + ' кгс/см²' : 'Продувку провести незамедлительно';
      rec.text = 'Сценарий: ' + b.best.name.toLowerCase() + ' (интервал работы ' + fmtH(b.best.tau) + '). Рекомендуемое давление продувки Pwh = Pline + ' + b.dpTrigger.toFixed(2) + ' кгс/см² (критическое Pwh = Pline + ' + b.dpCrit.toFixed(2) + ').' +
        (isF(b.best.extraPct) ? ' Ожидаемый эффект: ' + (b.best.extraPct >= 0 ? '+' : '') + b.best.extraPct.toFixed(1) + '% к средней добыче.' : '') +
        (isF(fc.tCrit) ? ' Прогноз остановки: ' + fmtDT(fc.tCrit) + ' (интервал ' + fmtDT(fc.tCritLo) + ' – ' + fmtDT(fc.tCritHi) + ').' : '');
    } else if (isF(fc.tCrit)) {
      const tRec = fc.tCrit - 0.5 * H; rec.when = tRec; rec.inH = (tRec - fc.tNow) / H;
      rec.title = 'Продувка до прогнозной остановки: через ' + fmtH(Math.max(0, rec.inH));
      rec.text = 'Рекомендуется готовность к продувке к ' + fmtDT(fc.tCrit) + '.';
    } else { rec.title = 'Недостаточно данных для рекомендации'; rec.text = A.conf.notes.join(' '); }
    rec.confidence = A.conf.level; rec.status = A.status.text; rec.priority = A.priority ? A.priority.text : '';
    if (b && b.ok) Object.assign(rec, { predStop: fc.tCrit, pRec: b.pwhBlowAtRec, pCrit: b.pwhCrit, dpCrit: b.dpCrit, dpTrigger: b.dpTrigger, scenario: b.best.key });
    void o;
    return rec;
  }
  function fmtH(h) { if (!isF(h)) return '—'; const s = h < 0 ? '−' : ''; h = Math.abs(h); if (h >= 48) return s + (h / 24).toFixed(1).replace('.', ',') + ' сут'; const tot = Math.round(h * 60), hh = Math.floor(tot / 60), mm = tot % 60; return s + (hh ? (mm ? hh + ' ч ' + mm + ' мин' : hh + ' ч') : mm + ' мин'); }
  function fmtDT(ms) { if (!isF(ms)) return '—'; const d = new Date(ms); const p2 = (x) => String(x).padStart(2, '0'); return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }

  /** Синтетический «один цикл» старого и нового режимов для наглядного сравнения. */
  function compareTimeline(A) {
    const o = A.opt, tpl = A.tpl; if (!o.ok) return null;
    const Told = A.life.median, Du = o.Du, Dp = o.Dp, tau = o.noGain ? Told : o.opt.tau;
    const span = Told + Du + 0.5 * Told; const dt = 0.05; const out = { t: [], old: { pwh: [], pline: [], dp: [], q: [], cum: [], phase: [] }, neu: { pwh: [], pline: [], dp: [], q: [], cum: [], phase: [] }, Told, Du, Dp, tau, span };
    const plineBase = median(Array.from(A.s.pline));
    const downPwh = median(A.cycles.map(c => c.ev.pre));
    function sample(mode, t) {
      // mode: 'old' — работа до Told, простой Du, снова работа; 'neu' — работа до τ, продувка Dp, работа ...
      const W = mode === 'old' ? Told : tau, D = mode === 'old' ? Du : Dp;
      let tc = t, ph;
      while (true) { if (tc < W) { ph = 'work'; break; } tc -= W; if (tc < D) { ph = mode === 'old' ? 'stop' : 'blow'; break; } tc -= D; }
      if (ph === 'work') return { ph, pwh: tpl.at('pwh', tc), pline: tpl.at('pline', tc), dp: tpl.at('dp', tc), q: tpl.at('q', tc) };
      return { ph, pwh: isF(downPwh) ? downPwh : 0, pline: plineBase, dp: NaN, q: 0 };
    }
    let co = 0, cn = 0;
    for (let t = 0; t <= span + 1e-9; t += dt) {
      out.t.push(t);
      [['old', out.old], ['neu', out.neu]].forEach(([m, o2]) => { const x = sample(m, t); o2.pwh.push(x.pwh); o2.pline.push(x.pline); o2.dp.push(x.dp); o2.q.push(x.q); o2.phase.push(x.ph); });
      const n = out.t.length; if (n > 1) { co += (out.old.q[n - 1] + out.old.q[n - 2]) / 2 * dt / 24 / 1000; cn += (out.neu.q[n - 1] + out.neu.q[n - 2]) / 2 * dt / 24 / 1000; }
      out.old.cum.push(co); out.neu.cum.push(cn);
    }
    // предупреждение — за 1 ч до прогнозного критического состояния в новом режиме
    out.warnAt = Math.max(0, tau - 1); out.recAt = tau;
    return out;
  }

  return { DEFAULTS, PRIORITIES, optimize, analyze, trajectory, trajFor, valueAt, backtest, confLevel, plineModel, chokeFlow, criticalRate, zFactor, recommend, compareTimeline, fmtH, fmtDT, median, mean, quantile, H, isF };
})();
if (typeof module !== 'undefined') module.exports = GCORE;
