const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const SH = '/home/claude/shots3/';
const bridge = `window.__TAURI__ = { core: { invoke: async (cmd, args) => { const r = await (await fetch('http://127.0.0.1:8799/' + cmd, { method: 'POST', body: JSON.stringify(args || {}) })).json(); if ('err' in r) throw r.err; return r.ok; } } };`;
(async () => {
  execSync('rm -rf /tmp/gpshim');
  const shim = spawn('node', ['/home/claude/desktop/test/shim.js'], { stdio: ['ignore', 'pipe', 'inherit'] }); await new Promise(r => shim.stdout.once('data', r));
  const br = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const ctxb = await br.newContext({ viewport: { width: 1600, height: 960 } }); await ctxb.addInitScript(bridge);
  const pg = await ctxb.newPage(); const errs = []; pg.on('pageerror', e => errs.push('PAGEERR ' + e.stack.split('\n').slice(0,3).join(' | '))); pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await pg.goto('file:///home/claude/desktop/dist/index.html'); await pg.waitForTimeout(900);
  // 1. Получить данные
  await pg.click('#bImport'); await pg.waitForTimeout(300); await pg.screenshot({ path: SH + '01_get_data.png' });
  await pg.click('.gd-tile[data-s="pg"]'); await pg.waitForTimeout(500);
  // 3. Параметры
  const set = async (k, v) => pg.fill('.pgd [data-p="' + k + '"]', String(v));
  await set('name', 'SCADA Кандым'); await set('host', '127.0.0.1'); await set('port', 55432); await set('database', 'scada_db'); await set('user', 'reader');
  await pg.fill('.pgd [data-pw]', 'wrong-password'); await pg.click('#pgTest'); await pg.waitForTimeout(900);
  console.log('wrong pw:', (await pg.textContent('#pgRes')).slice(0, 120)); await pg.screenshot({ path: SH + '02_wrong_password.png' });
  await pg.fill('.pgd [data-pw]', 'S3cret!pw'); await pg.click('#pgTest'); await pg.waitForTimeout(900);
  console.log('test:', (await pg.textContent('#pgRes')).slice(0, 160)); await pg.screenshot({ path: SH + '03_conn_ok.png' });
  await pg.click('.ov .mf .tbtn.primary'); await pg.waitForTimeout(1500);
  // 6. Navigator
  await pg.screenshot({ path: SH + '04_navigator.png' });
  await pg.click('.nv-it[data-k="scada.v_meas"]'); await pg.waitForTimeout(900); await pg.screenshot({ path: SH + '05_preview_view.png' });
  await pg.fill('#nvQ', 'meas'); await pg.waitForTimeout(200);
  await pg.check('.nv-it[data-k="scada.measurements"] input'); await pg.click('.nv-it[data-k="scada.measurements"] .nm'); await pg.waitForTimeout(900);
  await pg.click('.nv-cols .chip:has-text("updated_at")'); await pg.waitForTimeout(800);
  console.log('preview cols:', await pg.$$eval('.nv-grid th', e => e.map(x => x.textContent).join('|')));
  await pg.screenshot({ path: SH + '06_preview_table.png' });
  // вторая база
  await pg.selectOption('#nvDb', 'scada_arch'); await pg.waitForTimeout(1200); console.log('arch tree:', await pg.$$eval('.nv-it', e => e.map(x => x.dataset.k).join(',')));
  await pg.selectOption('#nvDb', 'scada_db'); await pg.waitForTimeout(1200);
  await pg.check('.nv-it[data-k="scada.measurements"] input');
  // 9. Преобразовать
  await pg.click('.ov .mf .tbtn.primary'); await pg.waitForTimeout(1500);
  console.log('auto map:', await pg.$$eval('[data-mf]', e => e.filter(x => x.value).map(x => x.dataset.mf + '=' + x.value).join(', ')));
  await pg.click('#jAdd'); await pg.waitForTimeout(300);
  await pg.selectOption('[data-j="0"][data-f="table"]', 'scada.wells'); await pg.waitForTimeout(200);
  await pg.selectOption('[data-j="0"][data-f="l"]', 'm.well_id'); await pg.selectOption('[data-j="0"][data-f="r"]', 'well_id'); await pg.waitForTimeout(200);
  await pg.selectOption('[data-mf="wellName"]', 'j1.well_name');
  await pg.click('#jAdd'); await pg.waitForTimeout(300);
  await pg.selectOption('[data-j="1"][data-f="table"]', 'scada.fields'); await pg.waitForTimeout(200);
  await pg.selectOption('[data-j="1"][data-f="l"]', 'j1.field_id'); await pg.selectOption('[data-j="1"][data-f="r"]', 'field_id'); await pg.waitForTimeout(200);
  await pg.selectOption('[data-mf="fieldName"]', 'j2.field_name'); await pg.selectOption('[data-mf="fieldId"]', 'j2.field_id'); await pg.dispatchEvent('[data-mf="fieldId"]', 'change');
  await pg.fill('#tFrom', '2026-11-01T00:00'); await pg.dispatchEvent('#tFrom', 'change');
  await pg.click('#tPrev'); await pg.waitForTimeout(1200); console.log('mapped head:', await pg.$$eval('#tOut th', e => e.map(x => x.textContent).join('|')), '| row1:', await pg.$$eval('#tOut tbody tr:first-child td', e => e.map(x => x.textContent).join('|')));
  await pg.screenshot({ path: SH + '07_transform.png' });
  await pg.click('#tWells'); await pg.waitForTimeout(900); console.log('wells:', await pg.$$eval('#tOut tbody tr', e => e.map(x => x.textContent).join(' ; ')));
  await pg.screenshot({ path: SH + '08_wells_check.png' });
  // 10. Загрузить
  await pg.click('.ov .mf .tbtn.primary'); await pg.waitForTimeout(4000);
  await pg.screenshot({ path: SH + '09_loaded_switch.png' });
  await pg.click('.ov .mf .tbtn.primary'); await pg.waitForTimeout(3500);
  await pg.screenshot({ path: SH + '10_fund_online.png' });
  console.log('tree:', await pg.$$eval('.tn', e => e.map(x => x.textContent.trim()).join(' | ')));
  console.log('pill:', await pg.textContent('#srcPill'));
  await pg.click('#srcPill'); await pg.waitForTimeout(1500); await pg.screenshot({ path: SH + '11_sources.png', fullPage: false });
  console.log('datasets:', await pg.$$eval('[data-den]', e => e.length), '| conns rows:', await pg.$$eval('[data-ce]', e => e.length));
  // новая запись → обновление
  execSync(`su pgt -c "psql -q -h /tmp/pg -p 55432 -U admin -d scada_db -c \\"INSERT INTO scada.measurements(well_id,meas_time,pwh,pline) VALUES (901, now()::timestamp, 0.5, 9.9)\\""`);
  await pg.click('#nSyncAll'); await pg.waitForTimeout(2000); console.log('toast:', await pg.$$eval('.toast', e => e.map(x => x.textContent).slice(-2).join(' / ')));
  // скважина
  await pg.click('.tn.l1 .lbl'); await pg.waitForTimeout(2500); await pg.screenshot({ path: SH + '12_well_online.png' });
  // потеря соединения
  execSync(`su pgt -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pg/data stop -m fast -w"`, { stdio: 'pipe' });
  await pg.click('#srcPill'); await pg.waitForTimeout(800); await pg.click('#nSyncAll'); await pg.waitForTimeout(1500);
  console.log('loss toast:', await pg.$$eval('.toast', e => e.map(x => x.textContent).slice(-1).join('')));
  await pg.screenshot({ path: SH + '13_conn_lost.png' });
  execSync(`su pgt -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pg/data -l /tmp/pg/log -o '-p 55432 -k /tmp/pg -c listen_addresses=127.0.0.1' start -w"`, { stdio: 'pipe' });
  await pg.click('#nSyncAll'); await pg.waitForTimeout(1800); console.log('restore toast:', await pg.$$eval('.toast', e => e.map(x => x.textContent).slice(-2).join(' / ')), '| pill:', await pg.textContent('#srcPill'));
  // перезапуск программы — настройки сохраняются
  await pg.reload(); await pg.waitForTimeout(2500); await pg.click('#srcPill'); await pg.waitForTimeout(1200);
  console.log('after reload datasets:', await pg.$$eval('[data-den]', e => e.length), '| pill:', await pg.textContent('#srcPill'));
  // отчёт Word → сохранение через backend
  execSync(`su pgt -c "psql -q -h /tmp/pg -p 55432 -U admin -d scada_db -c \\"DELETE FROM scada.measurements WHERE meas_time > now() - interval '1 day'\\""`);
  console.log(errs.join('\n') || 'NO ERRORS'); await br.close(); shim.kill();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
