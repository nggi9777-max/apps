/* ============================================================================
   VIEWS 3: «Получить данные» по принципу Power BI Desktop.
   1 Получить данные → 2 PostgreSQL Database → 3 параметры подключения →
   4 проверка → 5 соединение → 6 Navigator (базы, схемы, таблицы, представления)
   → 7 выбор → 8 просмотр → 9 преобразование (столбцы, фильтры, даты,
   сопоставление полей ГазПродувки) → 10 загрузка в единое ядро.
   Все запросы выполняет локальный backend на Rust (команды Tauri). Пароль
   уходит только в backend и хранилище Windows; обратно в интерфейс не попадает.
   ========================================================================== */
(function () {
  'use strict';
  const V = App.views;
  const KIND = { table: 'Таблица', view: 'Представление', matview: 'Материализованное представление', partitioned: 'Секционированная таблица', foreign: 'Внешняя таблица', other: 'Объект' };
  const kIco = (k) => k === 'view' || k === 'matview'
    ? '<svg class="ki v" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 6h13M5.5 6v7.5"/><circle cx="10.5" cy="10" r="1.6"/></svg>'
    : '<svg class="ki t" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 6h13M1.5 9.5h13M6 6v7.5M10.5 6v7.5"/></svg>';
  const OPS = [['=', '='], ['<>', '≠'], ['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['contains', 'содержит'], ['in', 'в списке (через запятую)'], ['notnull', 'не пусто'], ['null', 'пусто']];
  const cats = {};
  async function catalog(connId, db, refresh) {
    const k = connId + '|' + db;
    if (!cats[k] || refresh) cats[k] = await GSRC.nat('pg_navigator', { id: connId, database: db });
    return cats[k];
  }
  const fmtN = (n) => n < 0 ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' млн' : n >= 1e4 ? Math.round(n / 1e3) + ' тыс.' : String(n);

  /* ============================ 1. Получить данные ============================ */
  async function getData(c) {
    const { modal } = c;
    const body = document.createElement('div');
    body.innerHTML = '<div class="gd-tiles">' +
      '<button class="gd-tile" data-s="file">' + ICO.upload + '<b>Excel, CSV, архив 7z</b><span>Файлы .xlsx, .xls, .csv и выгрузки SCADA .7z. Работает без сети.</span></button>' +
      '<button class="gd-tile" data-s="pg">' + ICO.db + '<b>База данных PostgreSQL</b><span>' + (GSRC.native() ? 'Прямое подключение к серверу: выбор баз, схем, таблиц и представлений.' : 'Прямое подключение доступно в настольной программе ГазПродувка.exe.') + '</span></button></div>';
    let pick = null;
    body.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { pick = b.dataset.s; body.closest('.ov')._close(pick); });
    await modal('Получить данные', body, [{ t: 'Отмена', v: null }]);
    if (pick === 'file') return c.importWizard();
    if (pick === 'pg') return GSRC.native() ? connectDialog(c) : browserNote(c);
  }
  function browserNote(c) {
    return c.modal('PostgreSQL в браузере', '<div class="small" style="line-height:1.6"><p>Браузер не подключается к PostgreSQL напрямую: это запрещено требованиями безопасности (пароль не передаётся в JavaScript).</p>' +
      '<p><b>Прямое подключение</b> работает в настольной программе <b>ГазПродувка.exe</b>: она содержит встроенный драйвер PostgreSQL на Rust и не требует шлюзов, Node.js или дополнительных служб.</p>' +
      '<p class="muted">Для HTML-версии сохранён режим совместимости через локальный шлюз — раздел «Источники данных».</p></div>', null, 'sm');
  }

  /* ===================== 3–5. Параметры, проверка, соединение ===================== */
  async function connectDialog(c, editId) {
    const { modal, esc, toast } = c;
    let list = []; try { list = await GSRC.nat('conn_list'); } catch (e) { toast(e.message, true); }
    let cur = list.find(x => x.id === editId) || null;
    const box = document.createElement('div'); box.className = 'pgd';
    const blank = { id: '', name: '', host: 'localhost', port: 5432, database: '', user: '', auth: 'password', ssl: 'prefer', timeout: 15, appName: 'GazProduvka', options: '', tz: 'Asia/Tashkent', savePassword: true, hasPassword: false };
    const draw = () => {
      const x = Object.assign({}, blank, cur || {});
      box.innerHTML = '<div class="pgd-list"><div class="fs">Сохранённые подключения</div>' +
        (list.length ? list.map(p => '<button class="pgd-it' + (cur && p.id === cur.id ? ' on' : '') + '" data-id="' + p.id + '"><b>' + esc(p.name) + '</b><span>' + esc(p.host + ':' + p.port + ' / ' + p.database) + '</span></button>').join('') : '<p class="muted small">Пока нет. Заполните параметры справа.</p>') +
        '<button class="pgd-it new' + (!cur ? ' on' : '') + '" data-id="">' + ICO.plus + 'Новое подключение</button></div>' +
        '<div class="pgd-form"><div class="form">' +
        fg('name', 'Имя подключения', x.name, 'например: SCADA Кандым') + fg('host', 'Сервер (имя или IP-адрес)', x.host) +
        fg('port', 'Порт', x.port) + fg('database', 'База данных', x.database) +
        '<div class="fg"><label>Метод авторизации</label><select data-p="auth"><option value="password"' + (x.auth !== 'none' ? ' selected' : '') + '>Имя пользователя и пароль (SCRAM-SHA-256 / MD5)</option><option value="none"' + (x.auth === 'none' ? ' selected' : '') + '>Без пароля (trust)</option></select></div>' +
        fg('user', 'Пользователь', x.user) +
        '<div class="fg pw"><label>Пароль</label><input data-pw type="password" autocomplete="new-password" placeholder="' + (x.hasPassword ? 'сохранён в хранилище Windows — оставьте пустым' : 'введите пароль') + '"></div>' +
        '<div class="fg"><label>&nbsp;</label><label class="chk pgd-chk"><input type="checkbox" data-p="savePassword"' + (x.savePassword ? ' checked' : '') + '> Сохранить пароль в Диспетчере учётных данных Windows</label></div>' +
        '<div class="fg"><label>Шифрование (SSL Mode)</label><select data-p="ssl">' + [['prefer', 'prefer — если сервер поддерживает'], ['require', 'require — обязательно'], ['verify-ca', 'verify-ca — проверка центра сертификации'], ['verify-full', 'verify-full — проверка сертификата и имени'], ['disable', 'disable — без шифрования']].map(o => '<option value="' + o[0] + '"' + (x.ssl === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
        fg('timeout', 'Тайм-аут подключения, с', x.timeout) +
        '</div><details class="adv"><summary>Дополнительные параметры</summary><div class="form" style="margin-top:8px">' +
        fg('appName', 'Имя приложения (application_name)', x.appName) + fg('tz', 'Часовой пояс данных', x.tz) +
        fg('options', 'Параметры сервера (options)', x.options, '-c search_path=scada') + '</div></details>' +
        '<div class="actions" style="margin-top:12px"><button class="tbtn" id="pgTest">Проверить подключение</button>' + (cur ? '<button class="tbtn" id="pgDel">' + ICO.trash + 'Удалить</button>' : '') + '</div><div id="pgRes"></div>' +
        '<p class="note">Подключение выполняется напрямую программой ГазПродувка.exe (драйвер PostgreSQL на Rust), без шлюзов и дополнительных служб. Сессия работает только на чтение. На сервере должны быть разрешены сетевые подключения: listen_addresses, pg_hba.conf и порт в сетевом экране.</p></div>';
      box.querySelectorAll('.pgd-it').forEach(b => b.onclick = () => { cur = list.find(p => p.id === b.dataset.id) || null; draw(); });
      box.querySelector('#pgTest').onclick = test;
      const del = box.querySelector('#pgDel'); if (del) del.onclick = async () => {
        if (!await c.confirmBox('Удалить подключение «' + esc(cur.name) + '»? Сохранённый пароль будет удалён из хранилища Windows. Загруженные данные останутся в программе.')) return;
        await GSRC.nat('conn_delete', { id: cur.id }); for (const d of GSRC.st.datasets.filter(d => d.connId === cur.id)) await GSRC.removeDataset(d.id);
        list = list.filter(p => p.id !== cur.id); cur = null; draw();
      };
      const au = box.querySelector('[data-p=auth]'); const pwBox = () => { box.querySelector('.pw').style.opacity = au.value === 'none' ? .45 : 1; }; au.onchange = pwBox; pwBox();
    };
    const fg = (k, l, v, ph) => '<div class="fg"><label>' + l + '</label><input data-p="' + k + '" value="' + esc(v == null ? '' : v) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></div>';
    const read = () => {
      const o = Object.assign({}, blank, cur || {});
      box.querySelectorAll('[data-p]').forEach(i => { o[i.dataset.p] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
      o.port = Math.max(1, Math.min(65535, parseInt(o.port, 10) || 5432)); o.timeout = Math.max(3, Math.min(120, parseInt(o.timeout, 10) || 15));
      if (!o.name) o.name = (o.host || 'PostgreSQL') + ' / ' + (o.database || '');
      return { profile: o, password: box.querySelector('[data-pw]').value };
    };
    const show = (ok, html) => { box.querySelector('#pgRes').innerHTML = '<div class="warnbox ' + (ok ? 'info' : 'err') + '" style="margin:12px 0 0">' + (ok ? ICO.info : ICO.warn) + '<div>' + html + '</div></div>'; };
    async function test() {
      const { profile, password } = read();
      if (!profile.host || !profile.database) { show(false, 'Укажите сервер и базу данных.'); return; }
      show(true, '<span class="spin sm"></span> Подключение к ' + esc(profile.host + ':' + profile.port) + '…');
      try {
        const r = await GSRC.nat('pg_test', { profile, password: password || null });
        show(true, '<b>Подключение установлено</b> за ' + r.ms + ' мс. ' + esc(String(r.version).split(' on ')[0].split(',')[0]) + '; пользователь <b>' + esc(r.user) + '</b>, база <b>' + esc(r.database) + '</b>; шифрование TLS: <b>' + (r.tls ? 'включено' : 'нет') + '</b>; режим только чтения: ' + (r.readOnly ? 'да' : 'нет') + '.');
        return true;
      } catch (e) { show(false, '<b>Не удалось подключиться.</b> ' + esc(e.message)); return false; }
    }
    draw();
    let done = null;
    await modal('База данных PostgreSQL', box, [{ t: 'Отмена', v: 0 }, { t: 'Подключиться', v: 1, primary: true, check: async () => {
      const { profile, password } = read();
      if (!profile.host || !profile.database) { show(false, 'Укажите сервер и базу данных.'); return false; }
      if (profile.auth !== 'none' && !profile.user) { show(false, 'Укажите пользователя.'); return false; }
      show(true, '<span class="spin sm"></span> Подключение…');
      try {
        const p = await GSRC.nat('conn_save', { profile, password: password || null });
        await GSRC.nat('pg_connect', { id: p.id, database: null });
        done = p; return true;
      } catch (e) { show(false, '<b>Не удалось подключиться.</b> ' + esc(e.message)); return false; }
    } }], 'xl');
    if (done) return navigator(c, done);
  }

  /* ========================= 6–8. Navigator и просмотр ========================= */
  async function navigator(c, prof, preDb) {
    const { modal, esc, toast } = c;
    const box = document.createElement('div'); box.className = 'nav';
    let dbs = []; try { dbs = await GSRC.nat('pg_databases', { id: prof.id }); } catch (e) { dbs = [prof.database]; }
    if (!dbs.includes(prof.database)) dbs.unshift(prof.database);
    const S = { db: preDb || prof.database, cat: null, q: '', sel: new Set(), focus: null, closed: new Set(), cols: {}, err: '' };
    const key = (r) => r.schema + '.' + r.name;
    async function loadCat(refresh) {
      S.err = ''; S.cat = null; draw();
      try { S.cat = await catalog(prof.id, S.db, refresh); } catch (e) { S.err = e.message; }
      draw();
    }
    function tree() {
      if (S.err) return '<div class="warnbox err" style="margin:8px">' + ICO.warn + '<div>' + esc(S.err) + '</div></div>';
      if (!S.cat) return '<p class="muted small" style="padding:12px"><span class="spin sm"></span> Чтение системных каталогов…</p>';
      const q = S.q.toLowerCase(); let h = '';
      S.cat.schemas.forEach(sc => {
        const rs = S.cat.relations.filter(r => r.schema === sc && (!q || r.name.toLowerCase().includes(q) || sc.toLowerCase().includes(q) || r.columns.some(cl => cl.name.toLowerCase().includes(q))));
        if (!rs.length) return; const open = !S.closed.has(sc) || q;
        h += '<div class="nv-sc' + (open ? ' open' : '') + '" data-sc="' + esc(sc) + '">' + ICO.chev + '<b>' + esc(sc) + '</b><span>' + rs.length + '</span></div>';
        if (open) h += rs.map(r => { const k = key(r); return '<label class="nv-it' + (S.focus === k ? ' foc' : '') + (r.select ? '' : ' dis') + '" data-k="' + esc(k) + '" title="' + esc(KIND[r.kind] + (r.comment ? ' — ' + r.comment : '') + (r.select ? '' : ' · нет права SELECT')) + '"><input type="checkbox"' + (S.sel.has(k) ? ' checked' : '') + (r.select ? '' : ' disabled') + '>' + kIco(r.kind) + '<span class="nm">' + esc(r.name) + '</span><em>' + (r.select ? fmtN(r.rows) : 'нет доступа') + '</em></label>'; }).join('');
      });
      return h || '<p class="muted small" style="padding:12px">Ничего не найдено</p>';
    }
    function draw() {
      const nSel = S.sel.size;
      box.innerHTML = '<div class="nv-top"><div class="fg"><label>Сервер</label><div class="nv-srv">' + ICO.db + esc(prof.host + ':' + prof.port) + '</div></div>' +
        '<div class="fg"><label>База данных</label><select id="nvDb">' + dbs.map(d => '<option' + (d === S.db ? ' selected' : '') + '>' + esc(d) + '</option>').join('') + '</select></div>' +
        '<div class="fg grow"><label>Поиск таблиц, представлений и столбцов</label><div class="search">' + ICO.search + '<input id="nvQ" value="' + esc(S.q) + '" placeholder="например: meas, pwh, well"></div></div>' +
        '<button class="icon-btn" id="nvRef" title="Обновить список объектов">' + ICO.cycles + '</button></div>' +
        '<div class="nv-body"><div class="nv-tree" role="tree">' + tree() + '</div><div class="nv-prev" id="nvPrev"></div></div>' +
        '<div class="nv-foot muted small">Выбрано объектов: <b>' + nSel + '</b>' + (S.cat ? ' · схем ' + S.cat.schemas.length + ', объектов ' + S.cat.relations.length : '') + '</div>';
      box.querySelector('#nvDb').onchange = (e) => { S.db = e.target.value; S.sel.clear(); S.focus = null; loadCat(false); };
      const qi = box.querySelector('#nvQ'); qi.oninput = () => { S.q = qi.value; const t = box.querySelector('.nv-tree'); t.innerHTML = tree(); bindTree(); };
      box.querySelector('#nvRef').onclick = () => loadCat(true);
      bindTree(); preview();
    }
    function bindTree() {
      box.querySelectorAll('.nv-sc').forEach(e => e.onclick = () => { const s = e.dataset.sc; S.closed.has(s) ? S.closed.delete(s) : S.closed.add(s); box.querySelector('.nv-tree').innerHTML = tree(); bindTree(); });
      box.querySelectorAll('.nv-it').forEach(e => {
        const cb = e.querySelector('input');
        cb.onchange = () => { cb.checked ? S.sel.add(e.dataset.k) : S.sel.delete(e.dataset.k); box.querySelector('.nv-foot b').textContent = S.sel.size; };
        e.onclick = (ev) => { if (ev.target === cb) return; ev.preventDefault(); if (e.classList.contains('dis')) return; S.focus = e.dataset.k; box.querySelectorAll('.nv-it.foc').forEach(x => x.classList.remove('foc')); e.classList.add('foc'); preview(); };
      });
    }
    async function preview() {
      const el = box.querySelector('#nvPrev'); if (!el) return;
      const r = S.cat && S.cat.relations.find(x => key(x) === S.focus);
      if (!r) { el.innerHTML = '<div class="nv-empty">' + ICO.data + '<p>Выберите таблицу или представление слева, чтобы просмотреть данные.</p><p class="muted small">Отметьте флажками объекты для загрузки — можно несколько.</p></div>'; return; }
      const picked = S.cols[S.focus] || r.columns.map(x => x.name);
      el.innerHTML = '<div class="nv-ph"><div>' + kIco(r.kind) + '<b>' + esc(r.schema + '.' + r.name) + '</b><span class="muted small"> · ' + KIND[r.kind] + ' · столбцов ' + r.columns.length + ' · строк ≈ ' + fmtN(r.rows) + '</span></div>' + (r.comment ? '<div class="muted small">' + esc(r.comment) + '</div>' : '') + '</div>' +
        '<div class="nv-cols">' + r.columns.map(cl => '<label class="chip' + (picked.includes(cl.name) ? ' on' : '') + '" title="' + esc(cl.type) + '"><input type="checkbox" data-col="' + esc(cl.name) + '"' + (picked.includes(cl.name) ? ' checked' : '') + '>' + esc(cl.name) + '<em>' + esc(cl.type) + '</em></label>').join('') + '</div>' +
        '<div class="nv-grid"><p class="muted small" style="padding:10px"><span class="spin sm"></span> Загрузка первых 200 строк…</p></div>';
      el.querySelectorAll('[data-col]').forEach(i => i.onchange = () => { const set = Array.from(el.querySelectorAll('[data-col]:checked')).map(x => x.dataset.col); S.cols[S.focus] = set.length ? set : [i.dataset.col]; preview(); });
      const want = S.focus;
      try {
        const p = await GSRC.nat('pg_preview', { id: prof.id, database: S.db, schema: r.schema, table: r.name, columns: picked, filters: [], limit: 200 });
        if (S.focus !== want) return;
        el.querySelector('.nv-grid').innerHTML = gridHtml(p.columns, p.rows, esc) + '<div class="muted small nv-gf">Показано строк: ' + p.rows.length + ' · выполнено за ' + p.ms + ' мс</div>';
      } catch (e) { if (S.focus === want) el.querySelector('.nv-grid').innerHTML = '<div class="warnbox err" style="margin:10px">' + ICO.warn + '<div>' + esc(e.message) + '</div></div>'; }
    }
    draw(); loadCat(false);
    const act = await modal('Navigator — ' + prof.name, box, [{ t: 'Отмена', v: 0 }, { t: 'Загрузить', v: 'load', check: () => { if (!S.sel.size) { toast('Отметьте флажками хотя бы одну таблицу или представление', true); return false; } return true; } }, { t: 'Преобразовать данные', v: 'tr', primary: true, check: () => { if (!S.sel.size) { toast('Отметьте флажками хотя бы одну таблицу или представление', true); return false; } return true; } }], 'xxl');
    if (!act) return;
    const rels = Array.from(S.sel).map(k => S.cat.relations.find(r => key(r) === k)).filter(Boolean);
    const cfgs = rels.map(r => autoCfg(prof, S.db, r, S.cat, S.cols[key(r)]));
    if (act === 'load') {
      const bad = cfgs.filter(x => missing(x).length);
      if (!bad.length) return load(c, cfgs);
      toast('Не все поля определены автоматически (' + bad.map(x => x.title).join(', ') + ') — проверьте сопоставление', true);
    }
    return transform(c, prof, S.db, S.cat, cfgs);
  }
  function gridHtml(cols, rows, esc) {
    return '<div class="tblwrap nv-tw"><table class="tbl dense"><thead><tr>' + cols.map(x => '<th>' + esc(x) + '</th>').join('') + '</tr></thead><tbody>' +
      (rows.length ? rows.map(r => '<tr>' + r.map(v => v == null ? '<td class="nul">null</td>' : '<td>' + esc(String(v).length > 60 ? String(v).slice(0, 60) + '…' : v) + '</td>').join('') + '</tr>').join('') : '<tr><td colspan="' + cols.length + '" class="muted">Нет строк</td></tr>') + '</tbody></table></div>';
  }

  /* ============================ 9. Преобразование ============================ */
  function relOf(cat, schema, name) { return cat.relations.find(r => r.schema === schema && r.name === name); }
  function aliasesOf(cfg, cat) {
    const m = relOf(cat, cfg.schema, cfg.table);
    return [['m', m]].concat((cfg.joins || []).map((j, k) => ['j' + (k + 1), relOf(cat, j.schema || cfg.schema, j.table)]));
  }
  function guessField(k, als, used) {
    const G = App.MAP.GUESS;
    for (const [a, t] of als) { if (!t) continue; const cl = t.columns.find(x => G[k].test(x.name) && !used.has(a + '.' + x.name)); if (cl) return a + '.' + cl.name; }
    return '';
  }
  function autoCfg(prof, db, rel, cat, cols) {
    const cfg = { id: null, title: rel.schema + '.' + rel.name, connId: prof.id, connName: prof.name, database: db, schema: rel.schema, table: rel.name, joins: [], fields: {}, filters: [], from: '', to: '', unit: 'кгс/см²', enabled: true, cursor: null, cols: cols || null };
    const als = aliasesOf(cfg, cat); const used = new Set();
    // порядок важен: сначала однозначные поля
    ['pwh', 'pline', 'ts', 'wellId', 'wellName', 'fieldId', 'fieldName', 'updatedAt', 'recId', 'date', 'time', 'choke', 'rate', 'temp', 'gamma', 'status'].forEach(k => {
      if (k === 'date' && cfg.fields.ts) return; if (k === 'time' && !cfg.fields.date) return;
      const v = guessField(k, als, used); if (v) { cfg.fields[k] = v; used.add(v); }
    });
    if (!cfg.fields.wellId && cfg.fields.wellName) cfg.fields.wellId = cfg.fields.wellName;
    if (cols) Object.keys(cfg.fields).forEach(k => { const cn = cfg.fields[k].split('.').slice(1).join('.'); if (cfg.fields[k].startsWith('m.') && !cols.includes(cn) && !['wellId', 'pwh', 'pline', 'ts'].includes(k)) delete cfg.fields[k]; });
    return cfg;
  }
  function missing(cfg) {
    const m = []; const f = cfg.fields;
    if (!f.wellId) m.push('ID скважины'); if (!f.pwh) m.push('Pwh'); if (!f.pline) m.push('Pline'); if (!f.ts && !f.date) m.push('время измерения');
    return m;
  }
  async function transform(c, prof, db, cat, cfgs) {
    const { modal, esc, toast } = c; const FIELDS = App.MAP.FIELDS;
    const box = document.createElement('div'); box.className = 'trf'; let cur = 0;
    const draw = () => {
      const cfg = cfgs[cur]; const als = aliasesOf(cfg, cat); const main = als[0][1];
      const colOpts = (sel) => '<option value="">— нет —</option>' + als.map(([a, t]) => t ? '<optgroup label="' + a + ' · ' + esc(t.schema + '.' + t.name) + '">' + t.columns.map(cl => { const v = a + '.' + cl.name; return '<option value="' + esc(v) + '"' + (sel === v ? ' selected' : '') + '>' + esc((a === 'm' ? '' : a + '.') + cl.name) + '  (' + esc(cl.type) + ')</option>'; }).join('') + '</optgroup>' : '').join('');
      const tabsCat = cat.relations.filter(r => r.select);
      box.innerHTML = (cfgs.length > 1 ? '<div class="trf-tabs">' + cfgs.map((x, i) => '<button class="' + (i === cur ? 'on' : '') + (missing(x).length ? ' bad' : '') + '" data-i="' + i + '">' + kIco((relOf(cat, x.schema, x.table) || {}).kind) + esc(x.title) + '</button>').join('') + '</div>' : '') +
        '<div class="trf-grid"><div class="trf-l">' +
        '<div class="fs">Набор данных</div><div class="form one"><div class="fg"><label>Название набора</label><input id="tTitle" value="' + esc(cfg.title) + '"></div>' +
        '<div class="fg"><label>Источник</label><div class="nv-srv">' + kIco(main && main.kind) + esc(db + ' › ' + cfg.schema + '.' + cfg.table) + '</div></div></div>' +
        '<div class="fs">Связи с другими таблицами <button class="mini" id="jAdd">+ связь</button></div>' +
        '<div id="jList">' + (cfg.joins.length ? cfg.joins.map((j, k) => { const jt = relOf(cat, j.schema || cfg.schema, j.table) || { columns: [] }; return '<div class="jrow"><b>j' + (k + 1) + '</b><select data-j="' + k + '" data-f="table">' + tabsCat.map(t => '<option value="' + esc(t.schema + '.' + t.name) + '"' + (t.schema === (j.schema || cfg.schema) && t.name === j.table ? ' selected' : '') + '>' + esc(t.schema + '.' + t.name) + '</option>').join('') + '</select><select data-j="' + k + '" data-f="type"><option value="left"' + (j.type !== 'inner' ? ' selected' : '') + '>LEFT</option><option value="inner"' + (j.type === 'inner' ? ' selected' : '') + '>INNER</option></select><span>ON</span><select data-j="' + k + '" data-f="l">' + colOpts(j.on[0][0]) + '</select><span>=</span><select data-j="' + k + '" data-f="r">' + jt.columns.map(cl => '<option value="' + esc(cl.name) + '"' + (j.on[0][1] === cl.name ? ' selected' : '') + '>j' + (k + 1) + '.' + esc(cl.name) + '</option>').join('') + '</select><button class="mini" data-jdel="' + k + '">✕</button></div>'; }).join('') : '<p class="muted small">Нет. Добавьте связь, если названия скважин или месторождений хранятся в справочниках.</p>') + '</div>' +
        '<div class="fs">Сопоставление с полями ГазПродувки</div><div class="form">' + FIELDS.map(([k, l, req]) => '<div class="fg"><label>' + l + (['wellId', 'pwh', 'pline'].includes(k) ? ' <span class="req">*</span>' : '') + '</label><select data-mf="' + k + '">' + colOpts(cfg.fields[k] || '') + '</select></div>').join('') +
        '<div class="fg"><label>Единицы давления в базе</label><select id="tU">' + Object.keys(GIO.UNITS).map(u => '<option' + (cfg.unit === u ? ' selected' : '') + '>' + u + '</option>').join('') + '</select></div></div>' +
        '<div class="fs">Диапазон дат</div><div class="form"><div class="fg"><label>С</label><input type="datetime-local" id="tFrom" value="' + esc(cfg.from || '') + '"></div><div class="fg"><label>По</label><input type="datetime-local" id="tTo" value="' + esc(cfg.to || '') + '"></div></div>' +
        '<p class="note">Если дата начала не задана, загружается история за ' + GSRC.st.historyDays + ' сут (параметр «Глубина первичной загрузки»). Далее — только новые и изменённые записи.</p>' +
        '<div class="fs">Фильтры строк <button class="mini" id="fAdd">+ фильтр</button></div><div id="fList">' + (cfg.filters.length ? cfg.filters.map((f, i) => '<div class="jrow"><select data-fi="' + i + '" data-f="column">' + colOpts(f.column) + '</select><select data-fi="' + i + '" data-f="op">' + OPS.map(o => '<option value="' + o[0] + '"' + (f.op === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select><input data-fi="' + i + '" data-f="value" value="' + esc(f.value || '') + '"' + (['null', 'notnull'].includes(f.op) ? ' disabled' : '') + ' placeholder="значение"><button class="mini" data-fdel="' + i + '">✕</button></div>').join('') : '<p class="muted small">Без фильтров — загружаются все строки.</p>') + '</div>' +
        '</div><div class="trf-r"><div class="fs">Результат преобразования <span class="sp"></span><button class="mini" id="tPrev">Обновить просмотр</button><button class="mini" id="tWells">Список скважин</button></div><div id="tOut" class="trf-out"></div></div></div>';
      bind();
    };
    const sync = () => {
      const cfg = cfgs[cur]; if (!box.querySelector('#tTitle')) return;
      cfg.title = box.querySelector('#tTitle').value.trim() || cfg.schema + '.' + cfg.table;
      cfg.fields = {}; box.querySelectorAll('[data-mf]').forEach(s => { if (s.value) cfg.fields[s.dataset.mf] = s.value; });
      cfg.unit = box.querySelector('#tU').value; cfg.from = box.querySelector('#tFrom').value; cfg.to = box.querySelector('#tTo').value;
    };
    const spec = (cfg) => GSRC.dsSpec(Object.assign({}, cfg, { from: cfg.from || null, to: cfg.to || null, filters: cfg.filters.filter(f => f.column && (f.value || ['null', 'notnull'].includes(f.op))) }));
    async function prev() {
      sync(); const cfg = cfgs[cur]; const out = box.querySelector('#tOut'); const m = missing(cfg);
      if (m.length) { out.innerHTML = '<div class="warnbox">' + ICO.warn + '<div>Сопоставьте обязательные поля: ' + m.join(', ') + '.</div></div>'; return; }
      out.innerHTML = '<p class="muted small"><span class="spin sm"></span> Выполнение запроса…</p>';
      try {
        const t0 = performance.now();
        const r = await GSRC.nat('pg_fetch', { id: cfg.connId, dataset: spec(cfg), since: null, sinceId: null, limit: 100 });
        const map = [['fn', 'Месторождение'], ['f', 'ID мест.'], ['wn', 'Скважина'], ['w', 'ID скв.'], ['ts', 'Время'], ['pwh', 'Pwh'], ['pline', 'Pline'], ['choke', 'Штуцер'], ['rate', 'Дебит'], ['temp', 'T газа'], ['gamma', 'γ'], ['st', 'Статус']].filter(([k]) => r.rows.some(x => k in x));
        out.innerHTML = gridHtml(map.map(x => x[1]), r.rows.map(x => map.map(([k]) => x[k])), esc) + '<div class="muted small nv-gf">Первые ' + r.rows.length + ' строк в формате ГазПродувки (' + Math.round(performance.now() - t0) + ' мс)' + (r.next ? ' · есть ещё строки' : '') + '</div>';
      } catch (e) { out.innerHTML = '<div class="warnbox err">' + ICO.warn + '<div>' + esc(e.message) + '</div></div>'; }
    }
    function bind() {
      const cfg = cfgs[cur];
      box.querySelectorAll('.trf-tabs [data-i]').forEach(b => b.onclick = () => { sync(); cur = +b.dataset.i; draw(); prev(); });
      box.querySelectorAll('[data-mf],#tU,#tFrom,#tTo,#tTitle').forEach(e => e.onchange = () => { sync(); const tb = box.querySelector('.trf-tabs .on'); if (tb) tb.classList.toggle('bad', !!missing(cfg).length); });
      box.querySelector('#jAdd').onclick = () => { sync(); const m = relOf(cat, cfg.schema, cfg.table); const t = cat.relations.find(r => r.select && !(r.schema === cfg.schema && r.name === cfg.table)) || m; cfg.joins.push({ schema: t.schema, table: t.name, type: 'left', on: [['m.' + m.columns[0].name, t.columns[0].name]] }); draw(); };
      box.querySelectorAll('[data-j]').forEach(s => s.onchange = () => { sync(); const j = cfg.joins[+s.dataset.j]; const f = s.dataset.f; if (f === 'table') { const [sc, ...nm] = s.value.split('.'); j.schema = sc; j.table = nm.join('.'); j.on = [[j.on[0][0], (relOf(cat, sc, j.table).columns[0] || {}).name]]; } else if (f === 'type') j.type = s.value; else if (f === 'l') j.on[0][0] = s.value; else j.on[0][1] = s.value; draw(); });
      box.querySelectorAll('[data-jdel]').forEach(b => b.onclick = () => { sync(); const k = +b.dataset.jdel; cfg.joins.splice(k, 1); Object.keys(cfg.fields).forEach(f => { if (/^j\d+\./.test(cfg.fields[f])) delete cfg.fields[f]; }); draw(); });
      box.querySelector('#fAdd').onclick = () => { sync(); cfg.filters.push({ column: cfg.fields.wellId || '', op: '=', value: '' }); draw(); };
      box.querySelectorAll('[data-fi]').forEach(s => s.onchange = () => { const f = cfg.filters[+s.dataset.fi]; f[s.dataset.f] = s.value; if (s.dataset.f === 'op') { sync(); draw(); } });
      box.querySelectorAll('[data-fdel]').forEach(b => b.onclick = () => { sync(); cfg.filters.splice(+b.dataset.fdel, 1); draw(); });
      box.querySelector('#tPrev').onclick = prev;
      box.querySelector('#tWells').onclick = async () => {
        sync(); const out = box.querySelector('#tOut'); if (missing(cfg).length) return prev();
        out.innerHTML = '<p class="muted small"><span class="spin sm"></span> Подсчёт по скважинам…</p>';
        try { const ws = await GSRC.nat('pg_wells', { id: cfg.connId, dataset: spec(cfg) }); out.innerHTML = gridHtml(['Месторождение', 'Скважина', 'Записей', 'Первая запись', 'Последняя запись'], ws.map(w => [w.fn != null ? w.fn : w.f, w.wn != null ? w.wn : w.w, w.n, w.t0, w.t1]), esc) + '<div class="muted small nv-gf">Скважин: ' + ws.length + '</div>'; }
        catch (e) { out.innerHTML = '<div class="warnbox err">' + ICO.warn + '<div>' + esc(e.message) + '</div></div>'; }
      };
    }
    draw(); prev();
    const ok = await modal('Преобразование данных — ' + prof.name, box, [{ t: 'Отмена', v: 0 }, { t: 'Загрузить', v: 1, primary: true, check: () => {
      sync(); const bad = cfgs.findIndex(x => missing(x).length);
      if (bad >= 0) { cur = bad; draw(); prev(); toast('Набор «' + cfgs[bad].title + '»: сопоставьте ' + missing(cfgs[bad]).join(', '), true); return false; }
      return true;
    } }], 'xxl');
    if (ok) return load(c, cfgs.map(x => Object.assign(x, { filters: x.filters.filter(f => f.column && (f.value || ['null', 'notnull'].includes(f.op))) })));
  }

  /* =============================== 10. Загрузка =============================== */
  async function load(c, cfgs) {
    const { toast, busy, modal, esc } = c; const ids = [];
    for (const cfg of cfgs) {
      const prevDs = cfg.id ? GSRC.st.datasets.find(d => d.id === cfg.id) : null;
      const same = prevDs && JSON.stringify(GSRC.dsSpec(prevDs)) === JSON.stringify(GSRC.dsSpec(cfg));
      const d = Object.assign({}, prevDs || {}, cfg, { enabled: true, cursor: same ? prevDs.cursor : null, rows: same ? prevDs.rows : 0 }); delete d.cols;
      await GSRC.saveDataset(d); ids.push(d.id);
    }
    const h0 = GSRC.hooks(); GSRC.on(Object.assign({}, h0, { progress: (d, n) => busy(true, 'Загрузка «' + d.title + '»: получено строк ' + n.toLocaleString('ru-RU')) }));
    busy(true, 'Загрузка данных из PostgreSQL…');
    const r = await GSRC.sync('загрузка набора данных', ids);
    busy(false); GSRC.on(h0);
    await c.loadAll(); c.renderTree(); c.renderSrcPill();
    if (!r.ok) { toast('Загрузка завершилась с ошибкой: ' + (r.error || ''), true); }
    else toast('Загружено записей: ' + r.count.toLocaleString('ru-RU') + ', скважин: ' + r.wells);
    if (r.ok && GSRC.st.mode === 'offline') {
      const sw = await modal('Данные PostgreSQL загружены', '<p>Получено записей: <b>' + r.count.toLocaleString('ru-RU') + '</b>, скважин: <b>' + r.wells + '</b>.</p><p>Сейчас для расчётов выбран источник <b>' + esc(GSRC.MODES.offline) + '</b>. Переключить расчёты на данные PostgreSQL?</p>', [{ t: 'Оставить OFFLINE', v: 0 }, { t: 'Объединённые данные', v: 'merged' }, { t: 'ONLINE — PostgreSQL', v: 'online', primary: true }], 'sm');
      if (sw) { await GSRC.setMode(sw, 'загрузка набора данных PostgreSQL'); c.S.cache = {}; await c.loadAll(); c.renderTree(); c.renderSrcPill(); }
    }
    c.select({ type: 'fund' }, 'fund');
  }

  /* ======================= карточка ONLINE в «Источниках данных» ======================= */
  async function onlineHtml(c) {
    const { esc, fDT, F } = c; const g = GSRC.st;
    let conns = [], err = ''; try { conns = await GSRC.nat('conn_list'); } catch (e) { err = e.message; }
    const ds = g.datasets;
    return '<div class="card span2"><h3>ONLINE — PostgreSQL <span class="sub">прямое подключение</span><span class="sp"></span><span class="badge high">без шлюза</span></h3>' +
      '<div class="actions"><button class="tbtn primary" id="nGet">' + ICO.db + 'Получить данные</button><button class="tbtn" id="nSyncAll"' + (GSRC.active() ? '' : ' disabled') + '>' + ICO.cycles + 'Обновить все</button><button class="tbtn" id="nOpts">' + ICO.gear + 'Параметры получения данных</button></div>' +
      (err ? '<div class="warnbox err" style="margin-top:10px">' + ICO.warn + '<div>' + esc(err) + '</div></div>' : '') +
      '<div class="fs" style="margin-top:14px">Подключения</div><div class="tblwrap" style="max-height:200px"><table class="tbl"><thead><tr><th>Имя</th><th>Сервер</th><th>База</th><th>Пользователь</th><th>SSL</th><th>Пароль</th><th></th></tr></thead><tbody>' +
      (conns.length ? conns.map(x => '<tr><td><b>' + esc(x.name) + '</b></td><td>' + esc(x.host + ':' + x.port) + '</td><td>' + esc(x.database) + '</td><td>' + esc(x.user || '—') + '</td><td>' + esc(x.ssl) + '</td><td>' + (x.auth === 'none' ? '<span class="pill man">не требуется</span>' : x.hasPassword ? '<span class="pill ok">в хранилище Windows</span>' : '<span class="pill no">на время сеанса</span>') + '</td><td class="nowrap"><button class="mini" data-cn="' + x.id + '">Navigator</button> <button class="mini" data-ce="' + x.id + '">Изменить</button></td></tr>').join('') : '<tr><td colspan=7 class="muted">Подключений нет — нажмите «Получить данные».</td></tr>') + '</tbody></table></div>' +
      '<div class="fs" style="margin-top:14px">Загружаемые наборы данных</div><div class="tblwrap" style="max-height:260px"><table class="tbl"><thead><tr><th>Набор</th><th>Подключение</th><th>Объект</th><th class="num">Записей</th><th>Обновлено</th><th>Состояние</th><th>Вкл.</th><th></th></tr></thead><tbody>' +
      (ds.length ? ds.map(d => '<tr><td><b>' + esc(d.title) + '</b></td><td>' + esc(d.connName) + '</td><td class="muted">' + esc(d.database + ' › ' + d.schema + '.' + d.table) + (d.joins && d.joins.length ? ' + ' + d.joins.length + ' связ.' : '') + (d.filters && d.filters.length ? ' · фильтров ' + d.filters.length : '') + '</td><td class="num">' + F(d.rows || 0, 0) + '</td><td>' + (d.lastOk ? fDT(d.lastOk) : '—') + '</td><td>' + (d.lastErr ? '<span class="pill no" title="' + esc(d.lastErr) + '">ошибка</span>' : d.lastOk ? '<span class="pill ok">ok</span>' : '<span class="pill man">ожидание</span>') + '</td><td><input type="checkbox" data-den="' + d.id + '"' + (d.enabled !== false ? ' checked' : '') + '></td><td class="nowrap"><button class="mini" data-dsy="' + d.id + '">Обновить</button> <button class="mini" data-ded="' + d.id + '">Изменить</button> <button class="mini" data-ddel="' + d.id + '">' + ICO.trash + '</button></td></tr>').join('') : '<tr><td colspan=8 class="muted">Наборов нет. Выберите таблицы в Navigator и нажмите «Загрузить».</td></tr>') + '</tbody></table></div>' +
      (ds.some(d => d.lastErr) ? '<div class="warnbox err" style="margin-top:10px">' + ICO.warn + '<div>' + ds.filter(d => d.lastErr).map(d => '<b>' + esc(d.title) + ':</b> ' + esc(d.lastErr)).join('<br>') + '</div></div>' : '') + '</div>';
  }
  function bindOnline(el, c) {
    const { toast, esc } = c; const $ = (s) => el.querySelector(s); if (!$('#nGet')) return;
    $('#nGet').onclick = () => getData(c);
    $('#nSyncAll').onclick = async () => { c.busy(true, 'Обновление из PostgreSQL…'); const r = await GSRC.sync('вручную'); c.busy(false); toast(r.ok ? 'Получено новых записей: ' + r.count : 'Ошибка: ' + r.error, !r.ok); c.renderView(); };
    $('#nOpts').onclick = () => V.optsDialog(c);
    el.querySelectorAll('[data-cn]').forEach(b => b.onclick = async () => { const p = (await GSRC.nat('conn_list')).find(x => x.id === b.dataset.cn); if (p) navigator(c, p); });
    el.querySelectorAll('[data-ce]').forEach(b => b.onclick = () => connectDialog(c, b.dataset.ce));
    el.querySelectorAll('[data-den]').forEach(i => i.onchange = async () => { const d = GSRC.st.datasets.find(x => x.id === i.dataset.den); d.enabled = i.checked; await GSRC.saveDataset(d); c.renderSrcPill(); c.renderView(); });
    el.querySelectorAll('[data-dsy]').forEach(b => b.onclick = async () => { c.busy(true, 'Обновление набора…'); const r = await GSRC.sync('вручную', [b.dataset.dsy]); c.busy(false); toast(r.ok ? 'Получено новых записей: ' + r.count : 'Ошибка: ' + r.error, !r.ok); c.renderView(); });
    el.querySelectorAll('[data-ddel]').forEach(b => b.onclick = async () => { const d = GSRC.st.datasets.find(x => x.id === b.dataset.ddel); if (!await c.confirmBox('Удалить набор «' + esc(d.title) + '» из обновления? Уже загруженные измерения сохранятся в программе.')) return; await GSRC.removeDataset(d.id); c.renderSrcPill(); c.renderView(); });
    el.querySelectorAll('[data-ded]').forEach(b => b.onclick = async () => {
      const d = GSRC.st.datasets.find(x => x.id === b.dataset.ded); const prof = (await GSRC.nat('conn_list')).find(x => x.id === d.connId);
      if (!prof) { toast('Подключение набора не найдено', true); return; }
      c.busy(true, 'Чтение структуры базы…'); let cat; try { cat = await catalog(d.connId, d.database, true); } catch (e) { c.busy(false); toast(e.message, true); return; } c.busy(false);
      const cfg = JSON.parse(JSON.stringify(d)); cfg.joins = cfg.joins || []; cfg.filters = cfg.filters || []; cfg.from = cfg.from || ''; cfg.to = cfg.to || '';
      transform(c, prof, d.database, cat, [cfg]);
    });
  }

  App.GPN = { getData, connectDialog, navigator, onlineHtml, bindOnline };
})();
