/* ============================================================================
   Чтение Excel 97-2003 (.xls, BIFF8) без внешних библиотек: контейнер CFB +
   записи BOUNDSHEET, SST, LABELSST, LABEL, NUMBER, RK, MULRK, FORMULA, STRING.
   ========================================================================== */
const GXLS = (function () {
  'use strict';
  function cfbStream(u8, wanted) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== 0xE011CFD0) throw new Error('Не файл Excel 97-2003');
    const ssz = 1 << dv.getUint16(30, true), mssz = 1 << dv.getUint16(32, true);
    const nFat = dv.getUint32(44, true), dirStart = dv.getInt32(48, true), cutoff = dv.getUint32(56, true);
    const miniFatStart = dv.getInt32(60, true), difatStart = dv.getInt32(68, true);
    const secOff = (s) => 512 + s * ssz;
    const fatSecs = []; for (let i = 0; i < 109 && fatSecs.length < nFat; i++) { const s = dv.getInt32(76 + i * 4, true); if (s >= 0) fatSecs.push(s); }
    let d = difatStart; while (d >= 0 && fatSecs.length < nFat) { const o = secOff(d); for (let i = 0; i < ssz / 4 - 1 && fatSecs.length < nFat; i++) { const s = dv.getInt32(o + i * 4, true); if (s >= 0) fatSecs.push(s); } d = dv.getInt32(o + ssz - 4, true); }
    const fat = []; fatSecs.forEach(s => { const o = secOff(s); for (let i = 0; i < ssz / 4; i++) fat.push(dv.getInt32(o + i * 4, true)); });
    const chain = (start, f) => { const out = []; let s = start, guard = 0; while (s >= 0 && guard++ < 1e7) { out.push(s); s = f[s]; } return out; };
    const read = (start, size) => { const secs = chain(start, fat); const b = new Uint8Array(secs.length * ssz); secs.forEach((s, i) => b.set(u8.subarray(secOff(s), secOff(s) + ssz), i * ssz)); return size != null ? b.subarray(0, size) : b; };
    const dir = read(dirStart); const ents = [];
    for (let o = 0; o + 128 <= dir.length; o += 128) {
      const nl = dir[o + 64] | (dir[o + 65] << 8); let name = ''; for (let i = 0; i < Math.max(0, nl - 2); i += 2) name += String.fromCharCode(dir[o + i] | (dir[o + i + 1] << 8));
      const ddv = new DataView(dir.buffer, dir.byteOffset + o, 128);
      ents.push({ name, type: dir[o + 66], start: ddv.getInt32(116, true), size: ddv.getUint32(120, true) });
    }
    const root = ents[0]; const e = ents.find(x => wanted.includes(x.name));
    if (!e) throw new Error('В файле нет листов Excel (поток Workbook не найден)');
    if (e.size >= cutoff) return read(e.start, e.size);
    const ministream = read(root.start, root.size); const mfat = []; if (miniFatStart >= 0) { const mf = read(miniFatStart); const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength); for (let i = 0; i < mf.length / 4; i++) mfat.push(mdv.getInt32(i * 4, true)); }
    const secs = chain(e.start, mfat); const b = new Uint8Array(secs.length * mssz); secs.forEach((s, i) => b.set(ministream.subarray(s * mssz, s * mssz + mssz), i * mssz));
    return b.subarray(0, e.size);
  }
  function read(u8) {
    const w = cfbStream(u8, ['Workbook', 'Book']);
    const dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
    const recs = []; for (let p = 0; p + 4 <= w.length;) { const t = dv.getUint16(p, true), l = dv.getUint16(p + 2, true); recs.push({ t, p: p + 4, l }); p += 4 + l; }
    const sheets = [], sst = [], xfFmt = [], fmts = {};
    const dec16 = new TextDecoder('utf-16le'), dec8 = new TextDecoder('windows-1252');
    // строки с учётом CONTINUE
    function strReader(ri, pos) {
      let r = ri, p = pos;
      const avail = () => recs[r].p + recs[r].l - p;
      const next = () => { r++; p = recs[r].p; };
      return {
        u8() { if (avail() <= 0) next(); return w[p++]; },
        u16() { if (avail() < 2) next(); const v = dv.getUint16(p, true); p += 2; return v; },
        u32() { if (avail() < 4) next(); const v = dv.getUint32(p, true); p += 4; return v; },
        skip(n) { while (n > 0) { if (avail() <= 0) next(); const k = Math.min(n, avail()); p += k; n -= k; } },
        chars(cch, wide) { let s = ''; while (cch > 0) { if (avail() <= 0) { next(); wide = w[p++] & 1; } const per = wide ? 2 : 1; const k = Math.min(cch, Math.floor(avail() / per)); s += (wide ? dec16 : dec8).decode(w.subarray(p, p + k * per)); p += k * per; cch -= k; } return s; },
        str16() { const cch = this.u16(), fl = this.u8(); const rich = fl & 8 ? this.u16() : 0, ext = fl & 4 ? this.u32() : 0; const s = this.chars(cch, fl & 1); this.skip(rich * 4 + ext); return s; }
      };
    }
    let i = 0;
    // глобальная часть книги
    for (; i < recs.length; i++) {
      const r = recs[i];
      if (r.t === 0x0085) { const pos = dv.getUint32(r.p, true); const cch = w[r.p + 6], fl = w[r.p + 7]; const name = (fl & 1 ? dec16 : dec8).decode(w.subarray(r.p + 8, r.p + 8 + cch * (fl & 1 ? 2 : 1))); sheets.push({ name, pos, header: [], rows: [] }); }
      else if (r.t === 0x00FC) { const n = dv.getUint32(r.p + 4, true); const sr = strReader(i, r.p + 8); for (let k = 0; k < n; k++) sst.push(sr.str16()); }
      else if (r.t === 0x041E) { const id = dv.getUint16(r.p, true); const sr = strReader(i, r.p + 2); fmts[id] = sr.str16(); }
      else if (r.t === 0x00E0) xfFmt.push(dv.getUint16(r.p + 2, true));
      else if (r.t === 0x000A) { i++; break; }
    }
    const isDate = (xf) => { const id = xfFmt[xf]; if (id == null) return false; if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true; const c = (fmts[id] || '').replace(/"[^"]*"|\[[^\]]*\]/g, ''); return /[dmyhs]/i.test(c) && !/^0|#/.test(c); };
    const rk = (v) => { let n; if (v & 2) n = (v >> 2); else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, v & 0xFFFFFFFC, true); b.setUint32(0, 0, true); n = b.getFloat64(0, true); } return v & 1 ? n / 100 : n; };
    const pIdx = {}; recs.forEach((r, k) => pIdx[r.p - 4] = k);
    sheets.forEach(sh => {
      let k = pIdx[sh.pos]; if (k == null) return; const grid = []; let lastFormula = null;
      const put = (row, col, xf, val) => { (grid[row] = grid[row] || [])[col] = (typeof val === 'number' && isDate(xf)) ? { excelDate: val } : val; };
      for (k++; k < recs.length; k++) {
        const r = recs[k]; const p = r.p;
        if (r.t === 0x000A) break;
        if (r.t === 0x00FD) put(dv.getUint16(p, true), dv.getUint16(p + 2, true), dv.getUint16(p + 4, true), sst[dv.getUint32(p + 6, true)]);
        else if (r.t === 0x0203) put(dv.getUint16(p, true), dv.getUint16(p + 2, true), dv.getUint16(p + 4, true), dv.getFloat64(p + 6, true));
        else if (r.t === 0x027E) put(dv.getUint16(p, true), dv.getUint16(p + 2, true), dv.getUint16(p + 4, true), rk(dv.getInt32(p + 6, true)));
        else if (r.t === 0x00BD) { const row = dv.getUint16(p, true), c0 = dv.getUint16(p + 2, true); const n = (r.l - 6) / 6; for (let c = 0; c < n; c++) put(row, c0 + c, dv.getUint16(p + 4 + c * 6, true), rk(dv.getInt32(p + 6 + c * 6, true))); }
        else if (r.t === 0x0204) { const sr = strReader(k, p + 6); put(dv.getUint16(p, true), dv.getUint16(p + 2, true), 0, sr.str16()); }
        else if (r.t === 0x0006) { const row = dv.getUint16(p, true), col = dv.getUint16(p + 2, true), xf = dv.getUint16(p + 4, true); if (dv.getUint16(p + 12, true) === 0xFFFF) { const ty = w[p + 6]; if (ty === 0) lastFormula = [row, col]; else if (ty === 1) put(row, col, 0, !!w[p + 8]); } else put(row, col, xf, dv.getFloat64(p + 6, true)); }
        else if (r.t === 0x0207 && lastFormula) { const sr = strReader(k, p); put(lastFormula[0], lastFormula[1], 0, sr.str16()); lastFormula = null; }
      }
      const rows = []; for (let r = 0; r < grid.length; r++) rows.push(grid[r] || []);
      sh.header = (rows[0] || []).map(x => x == null ? '' : String(x)); sh.rows = rows.slice(1); delete sh.pos;
    });
    return sheets.filter(s => s.rows.length);
  }
  return { read };
})();
