/* Тестовый двойник backend ГазПродувка.exe (src-tauri/src/lib.rs).
   Тот же контракт команд Tauri и ТЕ ЖЕ SQL-тексты, что строит Rust, — выполняются
   на реальном PostgreSQL. Нужен только для проверки в среде без компилятора Rust.
   Запуск: node shim.js [порт]  → POST http://127.0.0.1:<порт>/<команда>  тело = аргументы. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { PgClient } = require('../../gateway/gazproduvka-gateway.js');
const HOME = process.env.GP_SHIM_HOME || '/tmp/gpshim'; fs.mkdirSync(HOME, { recursive: true });
const F = { conns: path.join(HOME, 'connections.json'), keyring: path.join(HOME, 'keyring.json') };
const PREVIEW_MAX = 200, FETCH_MAX = 50000;
const clients = new Map(), catalogs = new Map(), sessionPw = new Map();
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const loadProfiles = () => rd(F.conns, []);
const saveProfiles = (v) => fs.writeFileSync(F.conns, JSON.stringify(v.map(p => Object.assign({}, p, { hasPassword: false })), null, 2));
const secretGet = (id) => rd(F.keyring, {})[id] || null;
const secretSet = (id, pw) => { const k = rd(F.keyring, {}); k[id] = pw; fs.writeFileSync(F.keyring, JSON.stringify(k)); };
const secretDel = (id) => { const k = rd(F.keyring, {}); delete k[id]; fs.writeFileSync(F.keyring, JSON.stringify(k)); };
const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const validTz = (t) => !!t && t.length < 64 && /^[A-Za-z0-9/_+-]+$/.test(t);
const validType = (t) => !!t && t.length < 128 && /^[\p{L}\p{N} _(),[\]".]+$/u.test(t);
const KIND = { r: 'table', v: 'view', m: 'matview', p: 'partitioned', f: 'foreign' };
const HINT = { '28P01': 'Неверный пароль или имя пользователя.', '28000': 'Сервер запретил подключение для этого пользователя или адреса (pg_hba.conf).', '3D000': 'База данных с таким именем не найдена.', '42501': 'Недостаточно прав: нужен доступ SELECT.', '42P01': 'Таблица или представление не найдены.', '57014': 'Превышено время выполнения запроса.', '53300': 'На сервере исчерпан лимит подключений.', '25006': 'Сессия работает только на чтение — изменения базы запрещены.' };
function pgErr(e) {
  if (e.code && /^[0-9A-Z]{5}$/.test(e.code)) return (e.message + ' [' + e.code + '] ' + (HINT[e.code] || '')).trim();
  const l = String(e.message).toLowerCase();
  if (/refused|econnrefused/.test(l)) return 'Подключение отклонено: по этому адресу и порту PostgreSQL не принимает соединения. (' + e.message + ')';
  if (/timeout|таймаут/.test(l)) return 'Тайм-аут подключения: сервер не ответил. Проверьте адрес, порт, сетевой экран и параметр listen_addresses. (' + e.message + ')';
  if (/enotfound|eai_again/.test(l)) return 'Сервер не найден: проверьте имя или IP-адрес. (' + e.message + ')';
  return e.message;
}
const E = (m) => { const x = new Error(m); x.user = true; return x; };
// PgClient возвращает строки-объекты; приводим к массивам текстовых значений (как ::text в Rust)
const arr = (res) => ({ fields: res.fields, rows: res.rows.map(o => res.fields.map(f => o[f] == null ? null : (typeof o[f] === 'boolean' ? String(o[f]) : String(o[f])))) });
async function q(c, sql, params) { return arr(await c.query(sql, params || [])).rows; }

async function open(p, db, pw) {
  if (p.auth !== 'none' && !pw) throw E('Пароль не задан. Введите пароль в окне подключения.');
  const c = new PgClient({ host: p.host, port: p.port || 5432, database: db, user: p.user, password: pw, ssl: p.ssl || 'prefer' });
  try { await c.connect(); } catch (e) { throw E(pgErr(e)); }
  const tz = (p.tz && p.tz.trim()) || 'Asia/Tashkent';
  if (!validTz(tz)) throw E('Недопустимое имя часового пояса: ' + tz);
  for (const s of ['SET default_transaction_read_only = on', "SET statement_timeout = '120s'", "SET TIME ZONE '" + tz + "'"]) await c.query(s);
  const r = await q(c, 'SELECT COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false)::text');
  c.closedFlag = () => c.closed;
  return { c, tls: r[0][0] === 'true' };
}
const passwordFor = (id) => sessionPw.get(id) || secretGet(id);
const profileById = (id) => { const p = loadProfiles().find(x => x.id === id); if (!p) throw E('Подключение не найдено'); return p; };
async function clientFor(id, db) {
  const p = profileById(id); const dbn = db || p.database; const key = id + '|' + dbn;
  const ex = clients.get(key); if (ex && !ex.closed) return ex;
  const { c } = await open(p, dbn, passwordFor(id)); clients.set(key, c); return c;
}
async function run(id, db, c, sql, params) {
  try { return arr(await c.query(sql, params)); }
  catch (e) { if (c.closed) clients.delete(id + '|' + db); throw E(pgErr(e)); }
}
async function loadCatalog(c) {
  const rels = await q(c, "SELECT n.nspname::text, c.relname::text, c.relkind::text, GREATEST(c.reltuples, 0)::bigint::text, has_table_privilege(c.oid, 'SELECT')::text, obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','m','p','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND has_schema_privilege(n.oid, 'USAGE') ORDER BY 1, 2");
  const cols = await q(c, "SELECT n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','m','p','f') AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND has_schema_privilege(n.oid, 'USAGE') ORDER BY 1, 2, a.attnum");
  const out = rels.map(r => ({ schema: r[0], name: r[1], kind: KIND[r[2]] || 'other', rows: parseInt(r[3], 10), select: r[4] === 'true', comment: r[5], columns: [] }));
  const idx = new Map(out.map((r, i) => [r.schema + '\u0000' + r.name, i]));
  cols.forEach(r => { const i = idx.get(r[0] + '\u0000' + r[1]); if (i != null) out[i].columns.push({ name: r[2], type: r[3] }); });
  return { rels: out, find(s, n) { return this.rels.find(r => r.schema === s && r.name === n); } };
}
async function catalogFor(id, db, refresh) {
  const c = await clientFor(id, db); const key = id + '|' + db;
  if (!refresh && catalogs.has(key)) return { c, cat: catalogs.get(key) };
  let cat; try { cat = await loadCatalog(c); } catch (e) { if (c.closed) clients.delete(key); throw E(pgErr(e)); }
  catalogs.set(key, cat); return { c, cat };
}
/* ---- построение запросов: дословный перенос из lib.rs ---- */
function mkQ(alias) {
  return { alias, col(s) {
    let a = 'm', cn = s; const i = s.indexOf('.');
    if (i > 0 && this.alias.some(([x]) => x === s.slice(0, i))) { a = s.slice(0, i); cn = s.slice(i + 1); }
    const rel = (this.alias.find(([x]) => x === a) || [])[1]; if (!rel) throw E('Неизвестный псевдоним таблицы: ' + a);
    const col = rel.columns.find(x => x.name === cn); if (!col) throw E('Столбец не найден: ' + rel.name + '.' + cn);
    return [a + '.' + qi(col.name), col.type];
  } };
}
function buildFrom(cat, schema, table, joins) {
  const main = cat.find(schema, table); if (!main) throw E('Таблица или представление не найдены: ' + schema + '.' + table);
  if (!main.select) throw E('Нет права SELECT на ' + schema + '.' + table);
  const Q = mkQ([['m', main]]); let from = qi(schema) + '.' + qi(table) + ' m';
  (joins || []).forEach((j, k) => {
    const js = j.schema || schema; const rel = cat.find(js, j.table); if (!rel) throw E('Связанная таблица не найдена: ' + js + '.' + j.table);
    const al = 'j' + (k + 1); Q.alias.push([al, rel]); if (!j.on || !j.on.length) throw E('Не задано условие связи для ' + j.table);
    const conds = j.on.map(([l, r]) => Q.col(l)[0] + ' = ' + Q.col(r.includes('.') ? r : al + '.' + r)[0]);
    from += ' ' + (j.type === 'inner' ? 'INNER' : 'LEFT') + ' JOIN ' + qi(js) + '.' + qi(j.table) + ' ' + al + ' ON ' + conds.join(' AND ');
  });
  return { from, Q };
}
function buildFilters(Q, filters, params, wh) {
  for (const f of filters || []) {
    const [e, t] = Q.col(f.column); const v = f.value == null ? '' : String(f.value);
    const push = (x) => { params.push(x); return params.length; };
    switch (f.op) {
      case 'null': wh.push(e + ' IS NULL'); break;
      case 'notnull': wh.push(e + ' IS NOT NULL'); break;
      case 'contains': wh.push(e + "::text ILIKE '%' || $" + push(v) + "::text || '%'"); break;
      case 'in': { const list = v.split(',').map(x => x.trim()).filter(Boolean); wh.push(e + '::text = ANY($' + push('{' + list.map(x => '"' + x.replace(/["\\]/g, '\\$&') + '"').join(',') + '}') + '::text[])'); break; }
      case '=': case '<>': case '>': case '>=': case '<': case '<=':
        if (!validType(t)) throw E('Неподдерживаемый тип столбца для сравнения: ' + t);
        wh.push(e + ' ' + f.op + ' CAST($' + push(v) + '::text AS ' + t + ')'); break;
      default: throw E('Неизвестная операция фильтра: ' + f.op);
    }
  }
}
const KNOWN = ['fieldId', 'fieldName', 'wellId', 'wellName', 'ts', 'date', 'time', 'pwh', 'pline', 'recId', 'updatedAt', 'choke', 'rate', 'temp', 'gamma', 'status'];
const toObj = (res) => res.rows.map(r => { const o = {}; res.fields.forEach((n, i) => { o[n] = r[i] == null ? null : String(r[i]); }); return o; });

const CMD = {
  app_info: () => ({ native: true, version: 'shim', os: process.platform }),
  conn_list: () => loadProfiles().map(p => Object.assign(p, { hasPassword: p.auth === 'none' || !!secretGet(p.id) })),
  async conn_save({ profile, password }) {
    const p = Object.assign({ port: 5432, auth: 'password', ssl: 'prefer', timeout: 15, savePassword: false }, profile);
    if (!String(p.name || '').trim() || !String(p.host || '').trim() || !String(p.database || '').trim()) throw E('Заполните имя подключения, сервер и базу данных');
    if (!p.id) p.id = 'pg' + process.hrtime.bigint().toString(16);
    const all = loadProfiles(); if (all.some(x => x.name === p.name && x.id !== p.id)) throw E('Подключение с таким именем уже существует');
    if (password) { if (p.savePassword) { secretSet(p.id, password); sessionPw.delete(p.id); } else { secretDel(p.id); sessionPw.set(p.id, password); } }
    else if (!p.savePassword) secretDel(p.id);
    const rest = all.filter(x => x.id !== p.id); rest.push(p); saveProfiles(rest);
    for (const k of [...clients.keys()]) if (k.startsWith(p.id + '|')) clients.delete(k);
    for (const k of [...catalogs.keys()]) if (k.startsWith(p.id + '|')) catalogs.delete(k);
    return Object.assign({}, p, { hasPassword: p.auth === 'none' || !!secretGet(p.id) || sessionPw.has(p.id) });
  },
  conn_delete({ id }) { saveProfiles(loadProfiles().filter(x => x.id !== id)); secretDel(id); sessionPw.delete(id); for (const k of [...clients.keys()]) if (k.startsWith(id + '|')) clients.delete(k); return null; },
  async pg_test({ profile, password }) {
    const pw = password || (profile.id ? passwordFor(profile.id) : null); const t0 = Date.now();
    const { c, tls } = await open(profile, profile.database, pw);
    const r = await q(c, "SELECT version(), current_user::text, current_database()::text, current_setting('default_transaction_read_only')"); c.end();
    return { version: r[0][0], user: r[0][1], database: r[0][2], readOnly: r[0][3] === 'on', tls, ms: Date.now() - t0 };
  },
  async pg_connect({ id, database }) { const p = profileById(id); const db = database || p.database; clients.delete(id + '|' + db); const t0 = Date.now(); const c = await clientFor(id, db); const r = await q(c, 'SELECT version(), current_user::text, current_database()::text'); return { version: r[0][0], user: r[0][1], database: r[0][2], ms: Date.now() - t0 }; },
  pg_disconnect({ id }) { for (const k of [...clients.keys()]) if (k.startsWith(id + '|')) { clients.get(k).end(); clients.delete(k); } return null; },
  async pg_databases({ id }) { const p = profileById(id); const c = await clientFor(id, null); return (await run(id, p.database, c, "SELECT datname::text FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY 1")).rows.map(r => r[0]); },
  async pg_navigator({ id, database }) { const { cat } = await catalogFor(id, database, true); const schemas = [...new Set(cat.rels.map(r => r.schema))]; return { database, schemas, relations: cat.rels }; },
  async pg_preview({ id, database, schema, table, columns, filters, limit }) {
    const { c, cat } = await catalogFor(id, database, false); const { from, Q } = buildFrom(cat, schema, table, []); const rel = Q.alias[0][1];
    const cols = columns && columns.length ? columns : rel.columns.map(x => x.name); const sel = [], types = [];
    cols.forEach(n => { const [e, t] = Q.col(n); sel.push(e + '::text'); types.push(t); });
    const params = [], wh = []; buildFilters(Q, filters || [], params, wh);
    const lim = Math.min(Math.max(limit || PREVIEW_MAX, 1), PREVIEW_MAX);
    const sql = 'SELECT ' + (sel.length ? sel.join(', ') : 'NULL') + ' FROM ' + from + (wh.length ? ' WHERE ' + wh.join(' AND ') : '') + ' LIMIT ' + lim;
    const t0 = Date.now(); const res = await run(id, database, c, sql, params);
    return { columns: cols, types, rows: res.rows.map(r => r.map(v => v == null ? null : String(v))), estimatedRows: rel.rows, ms: Date.now() - t0 };
  },
  async pg_fetch({ id, dataset, since, sinceId, limit }) {
    const { c, cat } = await catalogFor(id, dataset.database, false); const { from, Q } = buildFrom(cat, dataset.schema, dataset.table, dataset.joins || []); const f = dataset.fields || {};
    Object.keys(f).forEach(k => { if (!KNOWN.includes(k)) throw E('Неизвестное поле сопоставления: ' + k); });
    ['wellId', 'pwh', 'pline'].forEach(k => { if (!f[k]) throw E('Не сопоставлено обязательное поле: ' + k); });
    const r = (k) => f[k] ? Q.col(f[k])[0] : null;
    let ts; if (r('ts')) ts = r('ts'); else if (r('date')) ts = r('time') ? '(' + r('date') + ' + ' + r('time') + ')' : r('date') + '::timestamp'; else throw E('Сопоставьте timestamp или дату (и время) измерения');
    const cur = r('updatedAt') || ts; const ie = r('recId'); const sel = [];
    [['f', 'fieldId'], ['fn', 'fieldName'], ['w', 'wellId'], ['wn', 'wellName'], ['pwh', 'pwh'], ['pline', 'pline'], ['rid', 'recId'], ['upd', 'updatedAt'], ['choke', 'choke'], ['rate', 'rate'], ['temp', 'temp'], ['gamma', 'gamma'], ['st', 'status']].forEach(([a, k]) => { const e = r(k); if (e) sel.push(e + '::text AS ' + a); });
    const params = [], wh = [];
    if (since) { params.push(since); const n = params.length; if (ie && sinceId) { params.push(sinceId); const m = params.length; wh.push('(' + cur + ' > CAST($' + n + '::text AS timestamp) OR (' + cur + ' = CAST($' + n + '::text AS timestamp) AND ' + ie + '::text > $' + m + '::text))'); } else wh.push(cur + ' > CAST($' + n + '::text AS timestamp)'); }
    if (dataset.from) { params.push(dataset.from); wh.push(ts + ' >= CAST($' + params.length + '::text AS timestamp)'); }
    if (dataset.to) { params.push(dataset.to); wh.push(ts + ' <= CAST($' + params.length + '::text AS timestamp)'); }
    buildFilters(Q, dataset.filters || [], params, wh);
    const lim = Math.min(Math.max(limit || 5000, 1), FETCH_MAX);
    const sql = 'SELECT ' + sel.join(', ') + ", to_char(" + ts + ", 'YYYY-MM-DD\"T\"HH24:MI:SS') AS ts, to_char(" + cur + ", 'YYYY-MM-DD\"T\"HH24:MI:SS.US') AS cur" + (ie ? ', ' + ie + '::text AS cid' : '') + ' FROM ' + from + (wh.length ? ' WHERE ' + wh.join(' AND ') : '') + ' ORDER BY ' + cur + (ie ? ', ' + ie + '::text' : '') + ' LIMIT ' + (lim + 1);
    if (process.env.GP_SHIM_SQL) console.log('[sql]', sql, JSON.stringify(params));
    const res = await run(id, dataset.database, c, sql, params); const rows = toObj(res); const more = rows.length > lim; const out = rows.slice(0, lim);
    const l = out[out.length - 1]; const cursor = l ? { since: l.cur, sinceId: l.cid == null ? undefined : l.cid } : null;
    return { count: out.length, rows: out, next: more ? cursor : null, cursor };
  },
  async pg_wells({ id, dataset }) {
    const { c, cat } = await catalogFor(id, dataset.database, false); const { from, Q } = buildFrom(cat, dataset.schema, dataset.table, dataset.joins || []); const f = dataset.fields || {};
    const cols = []; [['f', 'fieldId'], ['fn', 'fieldName'], ['w', 'wellId'], ['wn', 'wellName']].forEach(([a, k]) => { if (f[k]) cols.push(Q.col(f[k])[0] + '::text AS ' + a); });
    if (!cols.length) throw E('Сопоставьте хотя бы ID скважины');
    const ts = f.ts ? Q.col(f.ts)[0] : f.date ? Q.col(f.date)[0] + '::timestamp' : 'NULL::timestamp';
    const params = [], wh = []; buildFilters(Q, dataset.filters || [], params, wh); const grp = cols.map((_, i) => String(i + 1));
    const sql = 'SELECT ' + cols.join(', ') + ", count(*)::text AS n, to_char(min(" + ts + "), 'YYYY-MM-DD HH24:MI') AS t0, to_char(max(" + ts + "), 'YYYY-MM-DD HH24:MI') AS t1 FROM " + from + (wh.length ? ' WHERE ' + wh.join(' AND ') : '') + ' GROUP BY ' + grp.join(', ') + ' ORDER BY ' + grp.join(', ') + ' LIMIT 5000';
    return toObj(await run(id, dataset.database, c, sql, params));
  },
  save_file({ name, b64 }) { const dir = path.join(HOME, 'Downloads'); fs.mkdirSync(dir, { recursive: true }); const pth = path.join(dir, name.replace(/[\\/:*?"<>|]/g, '_')); fs.writeFileSync(pth, Buffer.from(b64, 'base64')); return pth; },
  reveal_file: () => null
};
/* write-guard: проверка, что сессия действительно только для чтения */
CMD._write_probe = async ({ id }) => { const c = await clientFor(id, null); try { await c.query('CREATE TABLE scada.gp_probe(x int)'); return 'WRITE_OK'; } catch (e) { return pgErr(e); } };

const port = +process.argv[2] || 8799;
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let d = ''; req.on('data', x => d += x); req.on('end', async () => {
    const cmd = req.url.slice(1); const fn = CMD[cmd];
    try { if (!fn) throw E('unknown command ' + cmd); const out = await fn(d ? JSON.parse(d) : {}); res.writeHead(200, cors); res.end(JSON.stringify({ ok: out === undefined ? null : out })); }
    catch (e) { res.writeHead(200, cors); res.end(JSON.stringify({ err: e.user ? e.message : pgErr(e) })); }
  });
}).listen(port, '127.0.0.1', () => console.log('shim on', port));
