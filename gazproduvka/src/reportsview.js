/* ============================================================================
   Окно «Отчётность»: выбор месторождения, скважин, периода, типа отчёта и
   сценария; предварительный просмотр; экспорт Word / Excel / PowerPoint.
   ========================================================================== */
(function () {
  'use strict';
  const H = 3600000;
  App.views.reports = async function (el, c) {
    const { S, esc, fDT, toast, busy, download, toLocalInput } = c;
    const R = S.rep = S.rep || {};
    const fields = S.fields, wells = S.wells;
    if (R.field === undefined) R.field = '';
    if (!R.type) R.type = 'field';
    if (!R.scenario) R.scenario = 'current';
    if (!R.wells) R.wells = wells.map(w => w.id);
    // период по умолчанию: последние сутки фактических данных → текущее время (использует прогноз при отсутствии факта)
    if (!R.from) { let last = 0; for (const w of wells) { const a = await c.getAnalysis(w.id); if (!a.empty) last = Math.max(last, a.A.forecast.tNow); } R.to = Math.max(Date.now(), last); R.from = (last || Date.now()) - 24 * H; }
    const visWells = wells.filter(w => !R.field || w.fieldId === R.field);
    el.innerHTML = '<div class="rep-grid"><div class="card rep-form"><h3>Параметры отчёта</h3>' +
      '<div class="fg"><label>Месторождение</label><select id="rF"><option value="">Все месторождения</option>' + fields.map(f => '<option value="' + f.id + '"' + (R.field === f.id ? ' selected' : '') + '>' + esc(f.name) + '</option>').join('') + '</select></div>' +
      '<div class="fg"><label>Скважины <span class="small muted">(' + visWells.filter(w => R.wells.includes(w.id)).length + ' из ' + visWells.length + ')</span></label><div class="wlist">' +
      '<label class="chk"><input type="checkbox" id="rAll"' + (visWells.every(w => R.wells.includes(w.id)) ? ' checked' : '') + '> <b>Выбрать все</b></label>' +
      visWells.map(w => '<label class="chk"><input type="checkbox" data-w="' + w.id + '"' + (R.wells.includes(w.id) ? ' checked' : '') + '> <span class="sd ' + (w.statusCode || 'none') + '"></span> ' + esc(w.name) + '</label>').join('') + '</div></div>' +
      '<div class="fg"><label>Отчётный период: начало</label><input type="datetime-local" id="rFrom" value="' + toLocalInput(R.from) + '"></div>' +
      '<div class="fg"><label>Конец периода (отчётный момент)</label><input type="datetime-local" id="rTo" value="' + toLocalInput(R.to) + '"></div>' +
      '<div class="rep-quick"><button class="mini" data-q="-24">Сутки до последнего факта</button><button class="mini" data-q="now">По текущее время</button><button class="mini" data-q="+24">+24 ч прогноз</button></div>' +
      '<div class="fg"><label>Тип отчёта</label><select id="rT">' + Object.entries(GREP.TYPES).map(([k, v]) => '<option value="' + k + '"' + (R.type === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></div>' +
      '<div class="fg"><label>Сценарий расчёта</label><select id="rS">' + Object.entries(GREP.SCEN).map(([k, v]) => '<option value="' + k + '"' + (R.scenario === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></div>' +
      '<button class="tbtn primary" id="rPrev" style="width:100%;justify-content:center;margin-top:6px">Предварительный просмотр</button>' +
      '<div class="rep-exp"><div class="fs">Экспорт</div><button class="tbtn" data-x="docx">' + ICO.doc + 'Word — подробный инженерный</button><button class="tbtn" data-x="brief">' + ICO.doc + 'Word — краткий для руководства</button><button class="tbtn" data-x="xlsx">' + ICO.data + 'Excel — таблицы и расчёты</button><button class="tbtn" data-x="pptx">' + ICO.ppt + 'PowerPoint — презентация</button></div>' +
      '<p class="note">Если на отчётный момент нет фактических измерений, значения Pwh, Pline, ΔP, дебита и статуса рассчитываются прогнозом ядра и помечаются «ПРОГНОЗ»; вне горизонта обоснованного прогноза — «НЕТ ДАННЫХ».</p></div>' +
      '<div class="rep-prev"><div id="rOut" class="rp-paper"><div class="rp-empty">Выберите параметры и нажмите «Предварительный просмотр».</div></div></div></div>';
    const q = (id) => document.getElementById(id);
    const sync = () => { R.field = q('rF').value; R.from = new Date(q('rFrom').value).getTime(); R.to = new Date(q('rTo').value).getTime(); R.type = q('rT').value; R.scenario = q('rS').value; R.wells = Array.from(el.querySelectorAll('[data-w]')).filter(x => x.checked).map(x => x.dataset.w).concat(R.wells.filter(id => !visWells.some(w => w.id === id) && false)); };
    q('rF').onchange = () => { sync(); R.wells = wells.filter(w => !R.field || w.fieldId === R.field).map(w => w.id); c.renderView(); };
    q('rAll').onchange = (e) => { el.querySelectorAll('[data-w]').forEach(x => x.checked = e.target.checked); sync(); };
    el.querySelectorAll('[data-w]').forEach(x => x.onchange = sync);
    ['rFrom', 'rTo', 'rT', 'rS'].forEach(id => q(id).onchange = sync);
    el.querySelectorAll('[data-q]').forEach(b => b.onclick = async () => {
      let last = 0; for (const id of R.wells) { const a = await c.getAnalysis(id); if (!a.empty) last = Math.max(last, a.A.forecast.tNow); }
      if (b.dataset.q === '-24') { R.to = last; R.from = last - 24 * H; } else if (b.dataset.q === 'now') { R.to = Date.now(); R.from = Math.min(R.from, last - 24 * H); } else { R.to = last + 24 * H; R.from = last - 24 * H; }
      q('rFrom').value = toLocalInput(R.from); q('rTo').value = toLocalInput(R.to);
    });
    const spec = () => { sync(); const f = fields.find(x => x.id === R.field); return { type: R.type, scenario: R.scenario, from: R.from, to: R.to, wells: R.wells.filter(id => visWells.some(w => w.id === id)), fieldName: f ? f.name : '' }; };
    const make = async () => { const sp = spec(); if (!sp.wells.length) { toast('Выберите хотя бы одну скважину', true); return null; } if (!(sp.to > sp.from)) { toast('Конец периода должен быть позже начала', true); return null; }
      // для отчёта по скважине — проверка прогноза на истории
      if (sp.type === 'well') for (const id of sp.wells) { const a = await c.getAnalysis(id); if (!a.empty && !a.bt) { const sel = GSRC.rawFor(a.ser); a.bt = GCORE.backtest(sel.raw, a.w.params, { excl: a.ser.excl, overrides: a.ser.overrides }); } }
      return GREP.build(sp, c); };
    q('rPrev').onclick = async () => { busy(true, 'Формирование отчёта…'); try { const M = await make(); if (M) { q('rOut').innerHTML = GREP.html(M); S.repModel = M; } } catch (e) { console.error(e); toast('Ошибка: ' + e.message, true); } busy(false); };
    el.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => {
      busy(true, 'Экспорт…');
      try {
        const M = await make(); if (!M) { busy(false); return; } q('rOut').innerHTML = GREP.html(M);
        const base = 'ГазПродувка_' + GREP.TYPES[M.type].replace(/\s+/g, '_') + '_' + fDT(M.spec.to).slice(0, 10).split('.').reverse().join('-');
        const k = b.dataset.x; let blob, ext;
        if (k === 'docx') { blob = await GREP.docx(M, false); ext = '_подробный.docx'; } else if (k === 'brief') { blob = await GREP.docx(M, true); ext = '_краткий.docx'; } else if (k === 'xlsx') { blob = await GREP.xlsx(M); ext = '.xlsx'; } else { blob = await GREP.pptx(M); ext = '.pptx'; }
        download(base + ext, blob); toast('Файл сформирован: ' + base + ext);
      } catch (e) { console.error(e); toast('Ошибка экспорта: ' + e.message, true); }
      busy(false);
    });
    if (S.repModel && S.repModel.type === R.type) q('rOut').innerHTML = GREP.html(S.repModel);
  };
})();
