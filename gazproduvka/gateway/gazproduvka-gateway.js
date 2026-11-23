#!/usr/bin/env node
/* ============================================================================
   ГазПродувка — локальный шлюз PostgreSQL (без внешних зависимостей, Node.js ≥ 18)

   Назначение: браузерная программа не подключается к PostgreSQL напрямую и не
   получает пароль. Шлюз работает на этом компьютере (127.0.0.1), хранит пароли
   в зашифрованном виде и выполняет только параметризованные SELECT-запросы.

   Запуск:            node gazproduvka-gateway.js
   Задать пароль:     node gazproduvka-gateway.js set-password "<название подключения>"
   Удалить пароль:    node gazproduvka-gateway.js clear-password "<название подключения>"
   Показать токен:    node gazproduvka-gateway.js token
   Параметры среды:   GP_PORT (по умолчанию 8765), GP_HOME (папка настроек),
                      GP_MASTER_KEY (ключ шифрования паролей; иначе — файл master.key)
   Также поддерживается стандартный файл паролей PostgreSQL (.pgpass / PGPASSFILE).
   ========================================================================== */
'use strict';
const net = require('net'), tls = require('tls'), crypto = require('crypto'), http = require('http');
const fs = require('fs'), path = require('path'), os = require('os'), readline = require('readline');

const VERSION = '1.0.0';
const HOME = process.env.GP_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'GazProduvkaGateway');
const PORT = +(process.env.GP_PORT || 8765);
const MAX_ROWS = 50000, DEF_ROWS = 5000;
fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
const F = { cfg: path.join(HOME, 'connections.json'), sec: path.join(HOME, 'secrets.enc'), key: path.join(HOME, 'master.key'), tok: path.join(HOME, 'token.txt'), log: path.join(HOME, 'gateway.log') };

/* ------------------------------ журнал (без секретов) ---------------------- */
function log(...a) {
  const line = new Date().toISOString() + ' ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  const safe = line.replace(/("?password"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1"***"');
  console.log(safe); try { fs.appendFileSync(F.log, safe + '\n', { mode: 0o600 }); } catch (e) { /* ignore */ }
}

/* ------------------------------- хранилище --------------------------------- */
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJSON = (f, o) => { fs.writeFileSync(f, JSON.stringify(o, null, 2), { mode: 0o600 }); };
function masterKey() {
  if (process.env.GP_MASTER_KEY) return crypto.scryptSync(process.env.GP_MASTER_KEY, 'GazProduvka-salt-v1', 32);
  if (!fs.existsSync(F.key)) fs.writeFileSync(F.key, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(F.key, 'utf8').trim(), 'base64');
}
function loadSecrets() {
  if (!fs.existsSync(F.sec)) return {};
  const raw = fs.readFileSync(F.sec); const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}
function saveSecrets(o) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(o), 'utf8'), c.final()]);
  fs.writeFileSync(F.sec, Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
}
function token() { if (!fs.existsSync(F.tok)) fs.writeFileSync(F.tok, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 }); return fs.readFileSync(F.tok, 'utf8').trim(); }
const conns = () => readJSON(F.cfg, []);
const saveConns = (a) => writeJSON(F.cfg, a);
function pgpassLookup(c) {
  const file = process.env.PGPASSFILE || (process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'postgresql', 'pgpass.conf') : path.join(os.homedir(), '.pgpass'));
  if (!fs.existsSync(file)) return null;
  for (const ln of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!ln || ln[0] === '#') continue; const p = ln.split(/(?<!\\):/).map(x => x.replace(/\\:/g, ':').replace(/\\\\/g, '\\'));
    if (p.length < 5) continue; const m = (a, b) => a === '*' || a === String(b);
    if (m(p[0], c.host) && m(p[1], c.port) && m(p[2], c.database) && m(p[3], c.user)) return p.slice(4).join(':');
  }
  return null;
}
function passwordFor(c) { const s = loadSecrets(); return s[c.id] || pgpassLookup(c) || process.env['GP_PASSWORD_' + c.id] || null; }

/* ------------------------- клиент протокола PostgreSQL --------------------- */
class PgError extends Error { constructor(f) { super(f.M || 'Ошибка PostgreSQL'); this.code = f.C; this.detail = f.D; this.severity = f.S; } }
class PgClient {
  constructor(o) { this.o = o; this.buf = Buffer.alloc(0); this.waiters = []; this.params = {}; }
  async connect() {
    const o = this.o;
    let sock = await new Promise((res, rej) => { const s = net.connect({ host: o.host, port: o.port || 5432 }); s.setTimeout(15000, () => { s.destroy(new Error('Таймаут соединения с ' + o.host + ':' + (o.port || 5432))); }); s.once('connect', () => res(s)); s.once('error', rej); });
    const sslMode = o.ssl || 'prefer';
    if (sslMode !== 'disable') {
      sock.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])); // SSLRequest 80877103
      const ans = await new Promise((res, rej) => { sock.once('data', d => res(d)); sock.once('error', rej); });
      if (ans[0] === 0x53) {
        sock = await new Promise((res, rej) => { const t = tls.connect({ socket: sock, servername: net.isIP(o.host) ? undefined : o.host, rejectUnauthorized: sslMode === 'verify-full' }, () => res(t)); t.once('error', rej); });
        this.tls = true;
      } else if (sslMode === 'require' || sslMode === 'verify-full') { sock.destroy(); throw new Error('Сервер не поддерживает TLS, а режим SSL = ' + sslMode); }
    }
    sock.setTimeout(0); this.sock = sock;
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this._pump(); });
    sock.on('error', e => { this.err = e; this._fail(e); });
    sock.on('close', () => { this.closed = true; this._fail(new Error('Соединение закрыто сервером')); });
    // StartupMessage
    const kv = ['user', o.user, 'database', o.database, 'application_name', 'GazProduvka gateway', 'client_encoding', 'UTF8'];
    const body = Buffer.concat([int32(196608), ...kv.map(cstr), Buffer.from([0])]);
    sock.write(Buffer.concat([int32(body.length + 4), body]));
    await this._auth();
  }
  _fail(e) { const w = this.waiters; this.waiters = []; w.forEach(x => x.rej(e)); }
  _pump() {
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1); if (this.buf.length < len + 1) break;
      const msg = { type: String.fromCharCode(this.buf[0]), data: this.buf.subarray(5, len + 1) };
      this.buf = this.buf.subarray(len + 1);
      if (msg.type === 'S') { const [k, v] = splitC(msg.data); this.params[k] = v; continue; }
      if (msg.type === 'N' || msg.type === 'K' || msg.type === 'A') continue;
      const w = this.waiters.shift(); if (w) w.res(msg); else (this.queue = this.queue || []).push(msg);
    }
  }
  _next() { if (this.queue && this.queue.length) return Promise.resolve(this.queue.shift()); if (this.closed) return Promise.reject(this.err || new Error('Соединение закрыто')); return new Promise((res, rej) => this.waiters.push({ res, rej })); }
  async _auth() {
    for (;;) {
      const m = await this._next();
      if (m.type === 'E') throw new PgError(parseErr(m.data));
      if (m.type === 'Z') return;
      if (m.type !== 'R') continue;
      const code = m.data.readInt32BE(0);
      if (code === 0) continue;
      const pw = this.o.password;
      if (code === 3) { if (pw == null) throw new Error('Пароль не задан (set-password или .pgpass)'); this._send('p', cstr(pw)); }
      else if (code === 5) { if (pw == null) throw new Error('Пароль не задан'); const salt = m.data.subarray(4, 8); const h1 = md5(pw + this.o.user); const h2 = md5(Buffer.concat([Buffer.from(h1), salt])); this._send('p', cstr('md5' + h2)); }
      else if (code === 10) {
        if (pw == null) throw new Error('Пароль не задан (set-password или .pgpass)');
        const mechs = m.data.subarray(4).toString('utf8').split('\0'); if (!mechs.includes('SCRAM-SHA-256')) throw new Error('Неподдерживаемый механизм SASL: ' + mechs.join(','));
        this.nonce = crypto.randomBytes(18).toString('base64'); this.cfb = 'n=*,r=' + this.nonce;
        const first = Buffer.from('n,,' + this.cfb); this._send('p', Buffer.concat([cstr('SCRAM-SHA-256'), int32(first.length), first]));
      } else if (code === 11) {
        const sf = m.data.subarray(4).toString('utf8'); const a = Object.fromEntries(sf.split(',').map(x => [x[0], x.slice(2)]));
        if (!a.r.startsWith(this.nonce)) throw new Error('SCRAM: неверный nonce сервера');
        const salted = crypto.pbkdf2Sync(pw.normalize('NFKC'), Buffer.from(a.s, 'base64'), +a.i, 32, 'sha256');
        const ck = hmac(salted, 'Client Key'), sk = crypto.createHash('sha256').update(ck).digest();
        const cfwp = 'c=biws,r=' + a.r; const authMsg = this.cfb + ',' + sf + ',' + cfwp;
        const sig = hmac(sk, authMsg); const proof = Buffer.from(ck.map((b, i) => b ^ sig[i]));
        this.serverSig = hmac(hmac(salted, 'Server Key'), authMsg).toString('base64');
        this._send('p', Buffer.from(cfwp + ',p=' + proof.toString('base64')));
      } else if (code === 12) {
        const v = m.data.subarray(4).toString('utf8'); if (v.replace(/^v=/, '') !== this.serverSig) throw new Error('SCRAM: подпись сервера не совпала');
      } else throw new Error('Неподдерживаемый метод аутентификации: ' + code);
    }
  }
  _send(type, body) { this.sock.write(Buffer.concat([Buffer.from(type), int32(body.length + 4), body])); }
  async simple(sql) { this._send('Q', cstr(sql)); return this._collect(); }
  /** Параметризованный запрос (extended protocol): параметры передаются отдельно от текста SQL. */
  async query(sql, params) {
    params = params || [];
    this._send('P', Buffer.concat([cstr(''), cstr(sql), int16(0)]));
    const pb = [cstr(''), cstr(''), int16(0), int16(params.length)];
    params.forEach(v => { if (v === null || v === undefined) pb.push(int32(-1)); else { const b = Buffer.from(String(v), 'utf8'); pb.push(int32(b.length), b); } });
    pb.push(int16(0));
    this._send('B', Buffer.concat(pb)); this._send('D', Buffer.concat([Buffer.from('P'), cstr('')])); this._send('E', Buffer.concat([cstr(''), int32(0)])); this._send('S', Buffer.alloc(0));
    return this._collect();
  }
  async _collect() {
    let fields = [], rows = [], err = null;
    for (;;) {
      const m = await this._next();
      if (m.type === 'T') fields = parseRowDesc(m.data);
      else if (m.type === 'D') rows.push(parseRow(m.data, fields));
      else if (m.type === 'E') err = new PgError(parseErr(m.data));
      else if (m.type === 'Z') { if (err) throw err; return { fields: fields.map(f => f.name), rows }; }
    }
  }
  end() { try { this._send('X', Buffer.alloc(0)); this.sock.end(); } catch (e) { /* ignore */ } }
}
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s) => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
function splitC(b) { return b.toString('utf8').split('\0'); }
function parseErr(b) { const o = {}; let i = 0; while (i < b.length && b[i] !== 0) { const t = String.fromCharCode(b[i]); const e = b.indexOf(0, i + 1); o[t] = b.subarray(i + 1, e).toString('utf8'); i = e + 1; } return o; }
function parseRowDesc(b) { const n = b.readInt16BE(0); let i = 2; const f = []; for (let k = 0; k < n; k++) { const e = b.indexOf(0, i); const name = b.subarray(i, e).toString('utf8'); i = e + 1; const oid = b.readInt32BE(i + 6); f.push({ name, oid }); i += 18; } return f; }
function parseRow(b, fields) {
  const n = b.readInt16BE(0); let i = 2; const r = {};
  for (let k = 0; k < n; k++) { const len = b.readInt32BE(i); i += 4; let v = null; if (len >= 0) { v = b.subarray(i, i + len).toString('utf8'); i += len; } const f = fields[k]; r[f.name] = conv(v, f.oid); }
  return r;
}
function conv(v, oid) { if (v === null) return null; if ([20, 21, 23, 700, 701, 1700].includes(oid)) return Number(v); if (oid === 16) return v === 't'; return v; }

/* ------------------------------ пул и запросы ------------------------------- */
const pool = {};
async function getClient(c) {
  const ent = pool[c.id] || (pool[c.id] = {}); if (ent.cli && !ent.cli.closed) return ent.cli;
  const cli = new PgClient({ host: c.host, port: c.port, database: c.database, user: c.user, ssl: c.ssl, password: passwordFor(c) });
  await cli.connect();
  await cli.simple("SET default_transaction_read_only = on; SET statement_timeout = '60s'; SET TIME ZONE " + quoteLit(c.tz || 'Asia/Tashkent'));
  ent.cli = cli; ent.at = Date.now(); return cli;
}
async function withClient(c, fn) {
  // один запрос за раз на подключение (протокол последовательный)
  const ent = pool[c.id] || (pool[c.id] = {}); const prev = ent.lock || Promise.resolve(); let release;
  ent.lock = new Promise(r => { release = r; });
  await prev.catch(() => {});
  try { const cli = await getClient(c); return await fn(cli); }
  catch (e) { if (pool[c.id] && pool[c.id].cli) { try { pool[c.id].cli.end(); } catch (x) { /* ignore */ } pool[c.id].cli = null; } throw e; }
  finally { release(); }
}
function disconnect(id) { const e = pool[id]; if (e && e.cli) { e.cli.end(); e.cli = null; } }
const quoteIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const quoteLit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const IDENT_RX = /^[\p{L}_][\p{L}\p{N}_$ ]{0,62}$/u;

async function introspect(c) {
  return withClient(c, async (cli) => {
    const t = await cli.query('SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name', [c.schema]);
    const cols = await cli.query('SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position', [c.schema]);
    const mv = await cli.query("SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'm' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum", [c.schema]);
    const tables = {};
    t.rows.forEach(r => tables[r.table_name] = { name: r.table_name, type: r.table_type === 'VIEW' ? 'VIEW' : 'TABLE', columns: [] });
    mv.rows.forEach(r => { (tables[r.table_name] = tables[r.table_name] || { name: r.table_name, type: 'MATERIALIZED VIEW', columns: [] }); });
    cols.rows.concat(mv.rows).forEach(r => { if (tables[r.table_name]) tables[r.table_name].columns.push({ name: r.column_name, type: r.data_type }); });
    return Object.values(tables);
  });
}
/** Проверка сопоставления: все таблицы/столбцы должны существовать (защита от SQL-инъекций в идентификаторах). */
async function validateMapping(c, mp) {
  const tabs = await introspect(c); const byName = Object.fromEntries(tabs.map(t => [t.name, t]));
  if (!mp || !mp.table || !byName[mp.table]) throw new Error('Таблица/представление не найдено в схеме ' + c.schema + ': ' + (mp && mp.table));
  const alias = { m: byName[mp.table] };
  (mp.joins || []).forEach((j, k) => { if (!byName[j.table]) throw new Error('Связанная таблица не найдена: ' + j.table); alias['j' + (k + 1)] = byName[j.table]; if (!['inner', 'left'].includes(j.type || 'left')) throw new Error('Тип связи: inner или left'); });
  const ref = (s) => { if (!s) return null; const [a, col] = s.includes('.') ? s.split('.', 2) : ['m', s]; const t = alias[a]; if (!t || !t.columns.some(x => x.name === col)) throw new Error('Столбец не найден: ' + s); return a + '.' + quoteIdent(col); };
  (mp.joins || []).forEach((j, k) => { (j.on || []).forEach(([l, r]) => { ref(l); const [a2, c2] = r.includes('.') ? r.split('.', 2) : ['j' + (k + 1), r]; ref(a2 + '.' + c2); }); });
  const need = ['wellId', 'pwh', 'pline']; need.forEach(k => { if (!mp.fields || !mp.fields[k]) throw new Error('Не сопоставлено обязательное поле: ' + k); });
  if (!mp.fields.ts && !mp.fields.date) throw new Error('Сопоставьте timestamp или дату (и время) измерения');
  const KNOWN = ['fieldId', 'fieldName', 'wellId', 'wellName', 'ts', 'date', 'time', 'pwh', 'pline', 'recId', 'updatedAt', 'choke', 'rate', 'temp', 'gamma', 'status'];
  Object.keys(mp.fields).forEach(k => { if (!KNOWN.includes(k)) throw new Error('Неизвестное поле сопоставления: ' + k); if (mp.fields[k]) ref(mp.fields[k]); });
  return { alias, ref };
}
function buildSelect(c, mp, v) {
  const f = mp.fields; const R = (k) => f[k] ? v.ref(f[k]) : null;
  const tsExpr = f.ts ? R('ts') : (f.time ? '(' + R('date') + ' + ' + R('time') + ')' : R('date') + '::timestamp');
  const sel = [['f', R('fieldId')], ['fn', R('fieldName')], ['w', R('wellId')], ['wn', R('wellName')], ['pwh', R('pwh')], ['pline', R('pline')], ['rid', R('recId')], ['upd', R('updatedAt')], ['choke', R('choke')], ['rate', R('rate')], ['temp', R('temp')], ['gamma', R('gamma')], ['st', R('status')]].filter(x => x[1]);
  let from = quoteIdent(c.schema) + '.' + quoteIdent(mp.table) + ' m';
  (mp.joins || []).forEach((j, k) => { const al = 'j' + (k + 1); from += ' ' + ((j.type || 'left') === 'inner' ? 'INNER' : 'LEFT') + ' JOIN ' + quoteIdent(c.schema) + '.' + quoteIdent(j.table) + ' ' + al + ' ON ' + j.on.map(([l, r]) => v.ref(l) + ' = ' + v.ref(r.includes('.') ? r : al + '.' + r)).join(' AND '); });
  return { tsExpr, cols: sel.map(([a, e]) => e + ' AS ' + a).join(', '), from, cursorExpr: f.updatedAt ? R('updatedAt') : tsExpr, idExpr: f.recId ? R('recId') : null };
}
async function fetchMeasurements(c, q) {
  const mp = c.mapping; const v = await validateMapping(c, mp); const b = buildSelect(c, mp, v);
  const limit = Math.min(MAX_ROWS, Math.max(1, +(q.limit || DEF_ROWS)));
  const params = []; const where = [];
  const P = (x) => { params.push(x); return '$' + params.length; };
  if (q.since) {
    if (b.idExpr && q.sinceId) where.push('(' + b.cursorExpr + ' > ' + P(q.since) + '::timestamp OR (' + b.cursorExpr + ' = ' + P(q.since) + '::timestamp AND ' + b.idExpr + '::text > ' + P(q.sinceId) + '))');
    else where.push(b.cursorExpr + ' > ' + P(q.since) + '::timestamp');
  }
  if (q.from) where.push(b.tsExpr + ' >= ' + P(q.from) + '::timestamp');
  if (q.until) where.push(b.tsExpr + ' <= ' + P(q.until) + '::timestamp');
  if (q.wells) { const ws = String(q.wells).split(',').filter(Boolean).slice(0, 2000); if (ws.length) where.push(v.ref(mp.fields.wellId) + '::text IN (' + ws.map(w => P(w)).join(', ') + ')'); }
  const sql = 'SELECT ' + b.cols + ', to_char(' + b.tsExpr + ", 'YYYY-MM-DD\"T\"HH24:MI:SS') AS ts, to_char(" + b.cursorExpr + ", 'YYYY-MM-DD\"T\"HH24:MI:SS.US') AS cur" + (b.idExpr ? ', ' + b.idExpr + '::text AS cid' : '') +
    ' FROM ' + b.from + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY ' + b.cursorExpr + (b.idExpr ? ', ' + b.idExpr + '::text' : '') + ' LIMIT ' + P(limit + 1);
  const r = await withClient(c, cli => cli.query(sql, params));
  const more = r.rows.length > limit; const rows = more ? r.rows.slice(0, limit) : r.rows;
  const last = rows[rows.length - 1];
  return { rows, count: rows.length, next: more && last ? { since: last.cur, sinceId: last.cid || null } : null, cursor: last ? { since: last.cur, sinceId: last.cid || null } : null };
}
async function listWells(c) {
  const mp = c.mapping; const v = await validateMapping(c, mp); const b = buildSelect(c, mp, v); const f = mp.fields;
  const cols = [['f', f.fieldId], ['fn', f.fieldName], ['w', f.wellId], ['wn', f.wellName]].filter(x => x[1]).map(([a, s]) => v.ref(s) + ' AS ' + a);
  const sql = 'SELECT ' + cols.join(', ') + ', count(*) AS n, to_char(min(' + b.tsExpr + "), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS t0, to_char(max(" + b.tsExpr + "), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS t1 FROM " + b.from + ' GROUP BY ' + cols.map((_, i) => i + 1).join(', ') + ' ORDER BY ' + cols.map((_, i) => i + 1).join(', ');
  return (await withClient(c, cli => cli.query(sql, []))).rows;
}
async function testConn(c) {
  const t0 = Date.now();
  const r = await withClient(c, async cli => {
    const a = await cli.query('SELECT version() AS v, current_user AS u, current_database() AS d, inet_server_addr()::text AS ip', []);
    let priv = null; if (c.mapping && c.mapping.table) { const p = await cli.query('SELECT has_table_privilege(current_user, $1, \'SELECT\') AS ok', [quoteIdent(c.schema) + '.' + quoteIdent(c.mapping.table)]); priv = p.rows[0].ok; }
    return Object.assign(a.rows[0], { priv, tls: !!cli.tls });
  });
  return Object.assign(r, { ms: Date.now() - t0 });
}

/* ------------------------------- HTTP API ---------------------------------- */
function send(res, code, obj, origin) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Headers': 'Content-Type, X-GP-Token', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Private-Network': 'true', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const pub = (c) => ({ id: c.id, name: c.name, host: c.host, port: c.port, database: c.database, user: c.user, schema: c.schema, table: c.table, ssl: c.ssl, tz: c.tz, mapping: c.mapping || null, hasPassword: !!passwordFor(c) });
function body(req) { return new Promise((res, rej) => { let d = ''; req.on('data', x => { d += x; if (d.length > 1e6) { rej(new Error('Слишком большой запрос')); req.destroy(); } }); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(new Error('Неверный JSON')); } }); }); }
const ALLOWED = ['name', 'host', 'port', 'database', 'user', 'schema', 'table', 'ssl', 'tz'];
async function handle(req, res) {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') return send(res, 204, {}, origin);
  const u = new URL(req.url, 'http://x'); const parts = u.pathname.split('/').filter(Boolean);
  if (u.pathname === '/api/health') return send(res, 200, { ok: true, app: 'GazProduvka gateway', version: VERSION, auth: req.headers['x-gp-token'] === token() }, origin);
  if (req.headers['x-gp-token'] !== token()) return send(res, 401, { error: 'Неверный токен шлюза. Токен: node gazproduvka-gateway.js token' }, origin);
  try {
    if (parts[0] !== 'api' || parts[1] !== 'connections') return send(res, 404, { error: 'Не найдено' }, origin);
    const list = conns(); const id = parts[2]; const c = id ? list.find(x => x.id === id) : null;
    if (!id && req.method === 'GET') return send(res, 200, list.map(pub), origin);
    if (!id && req.method === 'POST') {
      const b = await body(req); if ('password' in b) return send(res, 400, { error: 'Пароль не принимается через браузер. Задайте его в шлюзе: node gazproduvka-gateway.js set-password "' + (b.name || '') + '"' }, origin);
      const o = { id: crypto.randomBytes(6).toString('hex') }; ALLOWED.forEach(k => { if (b[k] != null) o[k] = b[k]; });
      if (!o.name || !o.host || !o.database || !o.user) return send(res, 400, { error: 'Заполните название, host, database и username' }, origin);
      o.port = +(o.port || 5432); o.schema = o.schema || 'public'; o.ssl = o.ssl || 'prefer';
      if (list.some(x => x.name === o.name)) return send(res, 400, { error: 'Подключение с таким названием уже есть' }, origin);
      list.push(o); saveConns(list); log('connection added', o.name, o.host); return send(res, 200, pub(o), origin);
    }
    if (!c) return send(res, 404, { error: 'Подключение не найдено' }, origin);
    const act = parts[3];
    if (!act && req.method === 'PUT') { const b = await body(req); if ('password' in b) return send(res, 400, { error: 'Пароль задаётся только в шлюзе' }, origin); ALLOWED.forEach(k => { if (b[k] != null) c[k] = b[k]; }); c.port = +c.port; disconnect(c.id); saveConns(list); return send(res, 200, pub(c), origin); }
    if (!act && req.method === 'DELETE') { disconnect(c.id); saveConns(list.filter(x => x.id !== c.id)); const s = loadSecrets(); delete s[c.id]; saveSecrets(s); return send(res, 200, { ok: true }, origin); }
    if (act === 'test') { const r = await testConn(c); log('test ok', c.name); return send(res, 200, r, origin); }
    if (act === 'disconnect') { disconnect(c.id); return send(res, 200, { ok: true }, origin); }
    if (act === 'introspect') return send(res, 200, await introspect(c), origin);
    if (act === 'mapping' && req.method === 'PUT') { const b = await body(req); await validateMapping(c, b); c.mapping = b; c.table = b.table; saveConns(list); log('mapping saved', c.name); return send(res, 200, pub(c), origin); }
    if (act === 'wells') return send(res, 200, await listWells(c), origin);
    if (act === 'measurements') { const q = Object.fromEntries(u.searchParams); const r = await fetchMeasurements(c, q); log('measurements', c.name, r.count); return send(res, 200, r, origin); }
    return send(res, 404, { error: 'Неизвестная операция' }, origin);
  } catch (e) {
    log('error', e.message);
    return send(res, e instanceof PgError ? 502 : 500, { error: e.message, code: e.code || null }, origin);
  }
}

/* --------------------------------- CLI ------------------------------------- */
function askHidden(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); res(a); });
  });
}
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'token') { console.log(token()); return; }
  if (cmd === 'set-password' || cmd === 'clear-password') {
    const c = conns().find(x => x.name === arg || x.id === arg); if (!c) { console.error('Подключение не найдено: ' + arg + '. Сначала создайте его в программе (окно «Подключение к PostgreSQL»).'); process.exit(1); }
    const s = loadSecrets();
    if (cmd === 'clear-password') { delete s[c.id]; saveSecrets(s); console.log('Пароль удалён для «' + c.name + '».'); return; }
    const pw = process.env.GP_SET_PASSWORD != null ? process.env.GP_SET_PASSWORD : await askHidden('Пароль PostgreSQL для «' + c.name + '» (' + c.user + '@' + c.host + '): ');
    s[c.id] = pw; saveSecrets(s); console.log('Пароль сохранён в зашифрованном виде (AES-256-GCM): ' + F.sec); return;
  }
  const srv = http.createServer((req, res) => { handle(req, res).catch(e => send(res, 500, { error: e.message })); });
  srv.listen(PORT, '127.0.0.1', () => {
    log('ГазПродувка gateway ' + VERSION + ' слушает http://127.0.0.1:' + PORT + ' (только локальные подключения)');
    console.log('Папка настроек: ' + HOME);
    console.log('Токен для программы: ' + token());
  });
}
if (require.main === module) main();
module.exports = { PgClient, quoteIdent, buildSelect };
