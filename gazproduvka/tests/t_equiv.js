const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const bridge = `window.__TAURI__ = { core: { invoke: async (cmd, args) => { const r = await (await fetch('http://127.0.0.1:8799/' + cmd, { method: 'POST', body: JSON.stringify(args || {}) })).json(); if ('err' in r) throw r.err; return r.ok; } } };`;
(async () => {
  execSync('rm -rf /tmp/gpshim'); const shim = spawn('node', ['/home/claude/desktop/test/shim.js'], { stdio: ['ignore', 'pipe', 'inherit'] }); await new Promise(r => shim.stdout.once('data', r));
  const br = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const c = await br.newContext({ viewport: { width: 1600, height: 960 } }); await c.addInitScript(bridge); const pg = await c.newPage();
  pg.on('pageerror', e => console.log('PAGEERR', e.message));
  await pg.goto('file:///home/claude/desktop/dist/index.html'); await pg.waitForTimeout(800);
  const out = await pg.evaluate(async () => {
    const p = await GSRC.nat('conn_save', { profile: { name: 'eq', host: '127.0.0.1', port: 55432, database: 'scada_db', user: 'reader', savePassword: true }, password: 'S3cret!pw' });
    await GSRC.saveDataset({ title: 'm', connId: p.id, connName: 'eq', database: 'scada_db', schema: 'scada', table: 'measurements', joins: [{ schema: 'scada', table: 'wells', type: 'left', on: [['m.well_id', 'well_id']] }], fields: { wellId: 'm.well_id', wellName: 'j1.well_name', ts: 'm.meas_time', pwh: 'm.pwh', pline: 'm.pline', recId: 'm.id', updatedAt: 'm.updated_at' }, filters: [{ column: 'well_id', op: '=', value: '3' }], from: '2026-01-01T00:00', unit: 'кгс/см²', enabled: true });
    const r = await GSRC.sync('t'); await GSRC.setMode('online', 't');
    const w = (await GDB.all('wells'))[0]; w.params = Object.assign(w.params || {}, { d_mm: 6, gamma: 0.6 }); await GDB.put('wells', w);
    await App.ctx().loadAll(); App.S.cache = {}; const a = await App.getAnalysis(w.id); const ser = a.ser.online;
    const b = GCORE.blowdownPlan ? null : null;
    const A = a.A; return { sync: r, n: [ser.pwh.t.length, ser.pline.t.length], id: w.id, dbg: { d: A.p.d_mm, g: A.p.gamma, optOk: A.opt.ok, noGain: A.opt.noGain, best: A.blow.best.key, saf: A.blow.dpSafety, why: A.opt.reason } };
  });
  console.log('sync', JSON.stringify(out));
  await pg.evaluate((id) => App.select({ type: 'well', id }, 'dash'), out.id); await pg.waitForTimeout(2500);
  console.log('ONLINE dash:', (await pg.$$eval('.kpis .kpi', e => e.slice(0, 6).map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' || '))).slice(0, 600));
  await br.close(); shim.kill();
})();
