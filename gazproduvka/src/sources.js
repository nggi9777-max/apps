/* ============================================================================
   SOURCES: источники данных OFFLINE (Excel/CSV/7z) и ONLINE (PostgreSQL),
   объединение с проверкой дубликатов и конфликтов.
   ONLINE в настольной программе ГазПродувка.exe — прямое подключение:
   интерфейс → команда Tauri → драйвер PostgreSQL (Rust, tokio-postgres) → сервер.
   Пароль в интерфейс не передаётся. Локальный шлюз Node.js оставлен только как
   резервный путь совместимости для запуска HTML в обычном браузере.
   Все данные приводятся к единому формату {pwh:{t,v}, pline:{t,v}} и считаются
   одним расчётным ядром (GCORE) независимо от источника.
   ========================================================================== */
const GSRC = (function () {
  'use strict';
  const MODES = { offline: 'OFFLINE — Excel', online: 'ONLINE — PostgreSQL', merged: 'Объединённые данные' };
  const st = {
    id: 'sources', mode: 'offline', gwUrl: 'http://127.0.0.1:8765', token: '', connId: null, connName: '',
    intervalMin: 5, onOpen: true, onCard: true, historyDays: 30, pageSize: 5000, maxRowsPerSync: 200000,
    priority: 'online', tolerance: 0.05, cache: true, unit: 'кгс/см²',
    cursor: null, lastOk: null, lastTry: null, lastErr: null, lastCount: 0, totalRows: 0, status: 'off', modeLog: [],
    datasets: [], legacy: false
  };
  /** Настольная программа (Tauri): прямое подключение к PostgreSQL через Rust. */
  const native = () => !!(typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  async function nat(cmd, args) {
    try { return await window.__TAURI__.core.invoke(cmd, args || {}); }
    catch (e) { throw new Error(typeof e === 'string' ? e : (e && (e.message || e.error)) || String(e)); }
  }
  /** Есть ли активный ONLINE-источник (наборы данных PostgreSQL или подключение шлюза). */
  const active = () => native() && !st.legacy ? st.datasets.some(d => d.enabled !== false) : !!st.connId;
  let timer = null, retryTimer = null, retryDelay = 30000, hooks = {}, syncing = false;

  async function load() {
    const m = await GDB.get('meta', 'sources'); if (m) Object.assign(st, m);
    st.datasets = st.datasets || [];
    // совместимость: в настольной программе шлюз не нужен; старые настройки шлюза сохраняются
    if (native() && st.legacy == null) st.legacy = false;
    syncConnFlags(); st.status = active() ? 'idle' : 'off';
  }
  function syncConnFlags() {
    if (native() && !st.legacy) {
      const on = st.datasets.filter(d => d.enabled !== false);
      st.connId = on.length ? on[0].connId : null;
      const names = Array.from(new Set(on.map(d => d.connName)));
      st.connName = names.join(', ');
    }
  }
  async function save() { const o = Object.assign({}, st); await GDB.put('meta', o); }
  function on(h) { hooks = h || {}; }

  /* --------------------------- клиент шлюза ------------------------------- */
  async function api(path, opt) {
    opt = opt || {};
    let r;
    try { r = await fetch(st.gwUrl.replace(/\/$/, '') + path, { method: opt.method || 'GET', headers: { 'X-GP-Token': st.token, 'Content-Type': 'application/json' }, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
    catch (e) { throw new Error('Шлюз недоступен по адресу ' + st.gwUrl + '. Запустите: node gazproduvka-gateway.js'); }
    let js = {}; try { js = await r.json(); } catch (e) { /* пусто */ }
    if (!r.ok) throw new Error(js.error || ('Ошибка шлюза ' + r.status));
    return js;
  }

  /* ---------------------------- выбор данных ------------------------------ */
  const empty = () => ({ pwh: { t: [], v: [] }, pline: { t: [], v: [] } });
  function rawFor(ser, mode) {
    mode = mode || st.mode;
    const off = { pwh: ser.pwh || { t: [], v: [] }, pline: ser.pline || { t: [], v: [] } };
    const onl = ser.online ? { pwh: ser.online.pwh, pline: ser.online.pline } : empty();
    if (mode === 'offline') return { raw: off, conflicts: [], origin: 'offline' };
    if (mode === 'online') return { raw: onl, conflicts: [], origin: 'online', cachedAt: ser.online ? ser.online.lastSync : null };
    return merge(off, onl, ser.priority || st.priority);
  }
  /** Объединение: совпадение по времени (±30 с), конфликт при расхождении больше допуска. */
  function merge(off, onl, priority) {
    const out = { pwh: { t: [], v: [] }, pline: { t: [], v: [] } }; const conflicts = []; const tol = st.tolerance;
    ['pwh', 'pline'].forEach(k => {
      const a = off[k], b = onl[k]; let i = 0, j = 0; const T = [], V = [], src = [];
      while (i < a.t.length || j < b.t.length) {
        const ta = i < a.t.length ? a.t[i] : Infinity, tb = j < b.t.length ? b.t[j] : Infinity;
        if (Math.abs(ta - tb) <= 30000) {
          const va = a.v[i], vb = b.v[j];
          if (Math.abs(va - vb) > Math.max(tol, 0.005 * Math.abs(va))) conflicts.push({ key: k, t: ta, offline: va, online: vb, used: priority });
          T.push(priority === 'online' ? tb : ta); V.push(priority === 'online' ? vb : va); src.push('both'); i++; j++;
        } else if (ta < tb) { T.push(ta); V.push(a.v[i]); src.push('offline'); i++; }
        else { T.push(tb); V.push(b.v[j]); src.push('online'); j++; }
      }
      out[k] = { t: T, v: V, src };
    });
    return { raw: out, conflicts, origin: 'merged' };
  }

  /* ------------------------------ синхронизация ------------------------------ */
  function fmtIso(ms) { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  async function sync(reason, onlyIds) {
    if (!active() || syncing) return { skipped: true };
    if (native() && !st.legacy) return syncNative(reason, onlyIds);
    return syncGateway(reason);
  }
  const dsSpec = (d) => ({ database: d.database, schema: d.schema, table: d.table, joins: d.joins || [], fields: d.fields, filters: d.filters || [], from: d.from || null, to: d.to || null });
  async function syncNative(reason, onlyIds) {
    syncing = true; st.lastTry = Date.now(); st.status = 'connecting'; hooks.status && hooks.status();
    let total = 0; const touched = new Set(); const errs = [];
    try {
      for (const d of st.datasets) {
        if (d.enabled === false || (onlyIds && !onlyIds.includes(d.id))) continue;
        let n = 0;
        try {
          let cur = d.cursor; const base = dsSpec(d);
          if (!cur && !base.from) base.from = fmtIso(Date.now() - st.historyDays * 86400000);
          for (let page = 0; n < st.maxRowsPerSync; page++) {
            const r = await nat('pg_fetch', { id: d.connId, dataset: base, since: cur && cur.since || null, sinceId: cur && cur.sinceId || null, limit: st.pageSize });
            if (r.rows.length) { const ws = await ingest(r.rows, d); ws.forEach(w => touched.add(w)); n += r.rows.length; }
            if (r.cursor && r.cursor.since) cur = r.cursor;
            d.cursor = cur; await save();
            hooks.progress && hooks.progress(d, n);
            if (!r.next) break;
          }
          d.lastOk = Date.now(); d.lastCount = n; d.rows = (d.rows || 0) + n; d.lastErr = null;
        } catch (e) { d.lastErr = e.message; errs.push(d.title + ': ' + e.message); }
        total += n;
      }
      st.lastCount = total; st.totalRows += total;
      if (errs.length) throw new Error(errs.join('; '));
      st.lastOk = Date.now(); st.status = 'ok'; st.lastErr = null; retryDelay = 30000;
      await save(); hooks.updated && hooks.updated(Array.from(touched), total, reason);
      return { ok: true, count: total, wells: touched.size };
    } catch (e) {
      st.status = 'error'; st.lastErr = e.message; await save();
      if (touched.size) hooks.updated && hooks.updated(Array.from(touched), total, reason);
      hooks.error && hooks.error(e);
      clearTimeout(retryTimer); retryTimer = setTimeout(() => { syncing = false; sync('восстановление соединения'); }, retryDelay); retryDelay = Math.min(retryDelay * 2, 600000);
      return { ok: false, error: e.message, count: total };
    } finally { syncing = false; hooks.status && hooks.status(); }
  }
  /** Совместимость: получение через локальный шлюз (только HTML в браузере). */
  async function syncGateway(reason) {
    syncing = true; st.lastTry = Date.now(); st.status = 'connecting'; hooks.status && hooks.status();
    let total = 0; const touched = new Set();
    try {
      let cur = st.cursor; const from = cur ? null : fmtIso(Date.now() - st.historyDays * 86400000);
      for (let page = 0; total < st.maxRowsPerSync; page++) {
        const q = new URLSearchParams({ limit: String(st.pageSize) });
        if (cur && cur.since) { q.set('since', cur.since); if (cur.sinceId) q.set('sinceId', cur.sinceId); }
        else if (from) q.set('from', from);
        const r = await api('/api/connections/' + st.connId + '/measurements?' + q.toString());
        if (r.rows.length) { const ws = await ingest(r.rows); ws.forEach(w => touched.add(w)); total += r.rows.length; }
        if (r.cursor) cur = r.cursor;
        st.cursor = cur; await save();
        if (!r.next) break;
      }
      st.lastOk = Date.now(); st.lastCount = total; st.totalRows += total; st.status = 'ok'; st.lastErr = null; retryDelay = 30000;
      await save(); hooks.updated && hooks.updated(Array.from(touched), total, reason);
      return { ok: true, count: total, wells: touched.size };
    } catch (e) {
      st.status = 'error'; st.lastErr = e.message; await save();
      hooks.error && hooks.error(e);
      clearTimeout(retryTimer); retryTimer = setTimeout(() => sync('восстановление соединения'), retryDelay); retryDelay = Math.min(retryDelay * 2, 600000);
      return { ok: false, error: e.message };
    } finally { syncing = false; hooks.status && hooks.status(); }
  }
  /** Приём строк: создание месторождений/скважин по внешним ID, объединение без дублей. */
  async function ingest(rows, ds) {
    const pref = ds ? ds.connId + '/' + ds.database : st.connId; const unit = ds ? ds.unit || 'кгс/см²' : st.unit; const cname = ds ? ds.connName + ' · ' + ds.title : st.connName;
    const fields = await GDB.all('fields'), wells = await GDB.all('wells');
    const byWell = new Map(); rows.forEach(r => { const k = String(r.w); if (!byWell.has(k)) byWell.set(k, []); byWell.get(k).push(r); });
    const touched = [];
    for (const [wid, rs] of byWell) {
      const r0 = rs[0]; const fKey = pref + ':' + (r0.f != null ? r0.f : r0.fn || '—');
      let f = fields.find(x => x.ext === fKey) || fields.find(x => !x.ext && r0.fn && x.name === r0.fn);
      if (!f) { f = { id: GDB.uid(), name: r0.fn || ('Месторождение ' + (r0.f != null ? r0.f : '')), created: Date.now(), ext: fKey }; fields.push(f); await GDB.put('fields', f); }
      else if (!f.ext) { f.ext = fKey; await GDB.put('fields', f); }
      const wKey = pref + ':' + wid;
      let w = wells.find(x => x.ext === wKey) || wells.find(x => !x.ext && x.fieldId === f.id && r0.wn && x.name === r0.wn);
      if (!w) { w = { id: GDB.uid(), fieldId: f.id, name: r0.wn || ('Скважина ' + wid), params: {}, created: Date.now(), ext: wKey }; wells.push(w); await GDB.put('wells', w); }
      else if (!w.ext) { w.ext = wKey; await GDB.put('wells', w); }
      // параметры из базы (если заданы в БД и не заданы пользователем)
      const last = rs[rs.length - 1]; let pch = false; w.params = w.params || {};
      if (last.choke != null && w.params.d_mm == null) { w.params.d_mm = +last.choke; pch = true; }
      if (last.gamma != null && w.params.gamma == null) { w.params.gamma = +last.gamma; pch = true; }
      if (last.temp != null && w.params.T_C == null) { w.params.T_C = +last.temp; pch = true; }
      if (pch) { w.paramsFromDb = true; await GDB.put('wells', w); }
      const ser = (await GDB.get('series', w.id)) || { wellId: w.id, pwh: { t: [], v: [] }, pline: { t: [], v: [] }, imports: [], excl: {}, overrides: {}, edits: {} };
      ser.online = ser.online || { pwh: { t: [], v: [] }, pline: { t: [], v: [] }, rows: 0 };
      ['pwh', 'pline'].forEach(k => {
        const m = new Map(); ser.online[k].t.forEach((t, i) => m.set(t, ser.online[k].v[i]));
        const uk = GIO.UNITS[unit] || 1; rs.forEach(r => { if (r[k] == null || r[k] === '' || !isFinite(r[k])) return; const t = GIO.parseDate(r.ts); if (!isFinite(t)) return; m.set(t, +r[k] * uk); });
        const ts = Array.from(m.keys()).sort((a, b) => a - b); ser.online[k] = { t: ts, v: ts.map(t => m.get(t)) };
      });
      ser.online.rows += rs.length; ser.online.lastSync = Date.now(); ser.online.conn = cname;
      await GDB.put('series', ser); touched.push(w.id);
    }
    return touched;
  }
  function schedule() {
    clearInterval(timer); timer = null;
    if (active() && st.intervalMin > 0) timer = setInterval(() => sync('по расписанию'), st.intervalMin * 60000);
  }
  async function setMode(mode, why) {
    if (!MODES[mode]) return; const prev = st.mode; st.mode = mode;
    st.modeLog = (st.modeLog || []).concat([{ t: Date.now(), from: prev, to: mode, why: why || '' }]).slice(-50);
    await save();
  }
  async function connect(c) { st.connId = c.id; st.connName = c.name; st.cursor = null; st.status = 'idle'; await save(); schedule(); return sync('подключение'); }
  /* ---------------------- наборы данных (прямое подключение) ---------------------- */
  async function saveDataset(d) {
    d.id = d.id || ('ds' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const i = st.datasets.findIndex(x => x.id === d.id); if (i >= 0) st.datasets[i] = d; else st.datasets.push(d);
    syncConnFlags(); await save(); schedule(); return d;
  }
  async function removeDataset(id) { st.datasets = st.datasets.filter(x => x.id !== id); syncConnFlags(); if (!active()) { st.status = 'off'; clearInterval(timer); } await save(); }
  async function useLegacy(on) { st.legacy = !!on; syncConnFlags(); await save(); schedule(); }
  async function disconnect() {
    if (native() && !st.legacy) { const ids = Array.from(new Set(st.datasets.map(d => d.connId))); for (const id of ids) { try { await nat('pg_disconnect', { id }); } catch (e) { /* нет соединения */ } } st.datasets.forEach(d => { d.enabled = false; }); syncConnFlags(); clearInterval(timer); clearTimeout(retryTimer); st.status = 'off'; await save(); return; } if (st.connId) { try { await api('/api/connections/' + st.connId + '/disconnect', { method: 'POST' }); } catch (e) { /* шлюз может быть недоступен */ } } clearInterval(timer); clearTimeout(retryTimer); st.connId = null; st.status = 'off'; await save(); }
  return { st, MODES, hooks: () => hooks, native, nat, active, load, save, on, api, rawFor, merge, sync, schedule, setMode, connect, disconnect, saveDataset, removeDataset, useLegacy, dsSpec, ingest };
})();
