/* ============================================================================
   IO: распаковка 7z (LZMA / LZMA2), чтение XLSX (через JSZip), CSV,
   автоматическое распознавание структуры выгрузки SCADA.
   ========================================================================== */
const GIO = (function () {
  'use strict';

  /* ---------------------------- LZMA decoder ---------------------------- */
  function RangeDecoder(buf, pos, end) {
    this.b = buf; this.p = pos; this.end = end;
    this.range = 0xFFFFFFFF; this.code = 0;
    const first = buf[this.p++];
    for (let i = 0; i < 4; i++) this.code = ((this.code * 256) + buf[this.p++]) >>> 0;
    if (first !== 0 || this.code === this.range) throw new Error('LZMA: повреждённый поток');
  }
  RangeDecoder.prototype.norm = function () {
    if (this.range < 0x1000000) {
      this.range = (this.range * 256) >>> 0;
      this.code = ((this.code * 256) + (this.b[this.p++] | 0)) >>> 0;
    }
  };
  RangeDecoder.prototype.bit = function (probs, i) {
    const v = probs[i];
    const bound = (this.range >>> 11) * v;
    let s;
    if (this.code < bound) { probs[i] = v + ((2048 - v) >>> 5); this.range = bound >>> 0; s = 0; }
    else { probs[i] = v - (v >>> 5); this.code = (this.code - bound) >>> 0; this.range = (this.range - bound) >>> 0; s = 1; }
    this.norm();
    return s;
  };
  RangeDecoder.prototype.direct = function (n) {
    let res = 0;
    while (n-- > 0) {
      this.range = this.range >>> 1;
      this.code = (this.code - this.range) >>> 0;
      let bit = 1;
      if (this.code >>> 31) { this.code = (this.code + this.range) >>> 0; bit = 0; }
      this.norm();
      res = ((res << 1) | bit) >>> 0;
    }
    return res;
  };
  function treeDec(rc, probs, base, nb) { let m = 1; for (let i = 0; i < nb; i++) m = (m << 1) + rc.bit(probs, base + m); return m - (1 << nb); }
  function treeRev(rc, probs, base, nb) { let m = 1, s = 0; for (let i = 0; i < nb; i++) { const b = rc.bit(probs, base + m); m = (m << 1) + b; s |= b << i; } return s; }

  function LenDec() { this.p = new Uint16Array(2 + 16 * 8 + 16 * 8 + 256).fill(1024); }
  LenDec.prototype.reset = function () { this.p.fill(1024); };
  LenDec.prototype.dec = function (rc, ps) {
    const p = this.p;
    if (rc.bit(p, 0) === 0) return treeDec(rc, p, 2 + ps * 8, 3);
    if (rc.bit(p, 1) === 0) return 8 + treeDec(rc, p, 2 + 128 + ps * 8, 3);
    return 16 + treeDec(rc, p, 2 + 256, 8);
  };

  function LzmaDec(out) { this.out = out; this.pos = 0; this.lc = 3; this.lp = 0; this.pb = 2; this.lit = null; }
  LzmaDec.prototype.setProps = function (lc, lp, pb) { this.lc = lc; this.lp = lp; this.pb = pb; this.lit = new Uint16Array(0x300 << (lc + lp)); };
  LzmaDec.prototype.resetState = function () {
    this.lit.fill(1024);
    this.isMatch = new Uint16Array(192).fill(1024); this.isRep = new Uint16Array(12).fill(1024);
    this.isRepG0 = new Uint16Array(12).fill(1024); this.isRepG1 = new Uint16Array(12).fill(1024);
    this.isRepG2 = new Uint16Array(12).fill(1024); this.isRep0Long = new Uint16Array(192).fill(1024);
    this.posSlot = new Uint16Array(4 * 64).fill(1024); this.posDec = new Uint16Array(1 + 114).fill(1024);
    this.align = new Uint16Array(16).fill(1024);
    this.lenDec = new LenDec(); this.repLenDec = new LenDec();
    this.state = 0; this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  };
  LzmaDec.prototype.decode = function (rc, outEnd) {
    const out = this.out, pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1, lc = this.lc;
    let pos = this.pos, state = this.state, rep0 = this.rep0, rep1 = this.rep1, rep2 = this.rep2, rep3 = this.rep3;
    while (pos < outEnd) {
      const ps = pos & pbMask;
      if (rc.bit(this.isMatch, (state << 4) + ps) === 0) {
        const prev = pos > 0 ? out[pos - 1] : 0;
        const base = 0x300 * (((pos & lpMask) << lc) + (prev >>> (8 - lc)));
        let sym = 1;
        if (state >= 7) {
          let mb = out[pos - rep0 - 1];
          do {
            const mbit = (mb >>> 7) & 1; mb <<= 1;
            const b = rc.bit(this.lit, base + ((1 + mbit) << 8) + sym);
            sym = (sym << 1) | b;
            if (mbit !== b) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | rc.bit(this.lit, base + sym);
        out[pos++] = sym - 0x100;
        state = state < 4 ? 0 : (state < 10 ? state - 3 : state - 6);
        continue;
      }
      let len;
      if (rc.bit(this.isRep, state) !== 0) {
        if (pos === 0) throw new Error('LZMA: ошибка данных');
        if (rc.bit(this.isRepG0, state) === 0) {
          if (rc.bit(this.isRep0Long, (state << 4) + ps) === 0) {
            state = state < 7 ? 9 : 11;
            out[pos] = out[pos - rep0 - 1]; pos++;
            continue;
          }
        } else {
          let dist;
          if (rc.bit(this.isRepG1, state) === 0) dist = rep1;
          else {
            if (rc.bit(this.isRepG2, state) === 0) dist = rep2;
            else { dist = rep3; rep3 = rep2; }
            rep2 = rep1;
          }
          rep1 = rep0; rep0 = dist;
        }
        len = this.repLenDec.dec(rc, ps);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2; rep2 = rep1; rep1 = rep0;
        len = this.lenDec.dec(rc, ps);
        state = state < 7 ? 7 : 10;
        const lenState = len < 3 ? len : 3;
        const slot = treeDec(rc, this.posSlot, lenState * 64, 6);
        let dist;
        if (slot < 4) dist = slot;
        else {
          const nd = (slot >>> 1) - 1;
          dist = ((2 | (slot & 1)) << nd) >>> 0;
          if (slot < 14) dist = (dist + treeRev(rc, this.posDec, dist - slot, nd)) >>> 0;
          else {
            dist = (dist + ((rc.direct(nd - 4) << 4) >>> 0)) >>> 0;
            dist = (dist + treeRev(rc, this.align, 0, 4)) >>> 0;
          }
        }
        if (dist === 0xFFFFFFFF) break; // end marker
        rep0 = dist;
      }
      len += 2;
      if (rep0 >= pos) throw new Error('LZMA: неверная дистанция');
      for (let k = 0; k < len && pos < outEnd; k++) { out[pos] = out[pos - rep0 - 1]; pos++; }
    }
    this.pos = pos; this.state = state; this.rep0 = rep0; this.rep1 = rep1; this.rep2 = rep2; this.rep3 = rep3;
  };

  function lzmaDecode(buf, start, end, propsBytes, size) {
    const out = new Uint8Array(size);
    let d = propsBytes[0];
    const lc = d % 9; d = (d / 9) | 0; const lp = d % 5, pb = (d / 5) | 0;
    const dec = new LzmaDec(out); dec.setProps(lc, lp, pb); dec.resetState();
    const rc = new RangeDecoder(buf, start, end);
    dec.decode(rc, size);
    return out;
  }
  function lzma2Decode(buf, start, end, size) {
    const out = new Uint8Array(size);
    const dec = new LzmaDec(out);
    let p = start;
    while (p < end) {
      const c = buf[p++];
      if (c === 0) break;
      if (c === 1 || c === 2) {
        const n = ((buf[p] << 8) | buf[p + 1]) + 1; p += 2;
        out.set(buf.subarray(p, p + n), dec.pos); dec.pos += n; p += n; continue;
      }
      if (c < 0x80) throw new Error('LZMA2: неверный блок');
      const un = ((c & 0x1F) << 16) + (buf[p] << 8) + buf[p + 1] + 1; p += 2;
      const pk = ((buf[p] << 8) | buf[p + 1]) + 1; p += 2;
      const mode = (c >>> 5) & 3;
      if (mode >= 2) {
        let d = buf[p++]; const lc = d % 9; d = (d / 9) | 0; const lp = d % 5, pb = (d / 5) | 0;
        dec.setProps(lc, lp, pb);
      }
      if (mode >= 1) dec.resetState();
      const rc = new RangeDecoder(buf, p, p + pk);
      dec.decode(rc, dec.pos + un);
      p += pk;
    }
    return out.subarray(0, dec.pos);
  }

  /* ------------------------------- 7z ----------------------------------- */
  function un7z(u8) {
    const sig = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];
    for (let i = 0; i < 6; i++) if (u8[i] !== sig[i]) throw new Error('Не 7z архив');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const nhOff = dv.getUint32(12, true) + dv.getUint32(16, true) * 4294967296;
    const nhSize = dv.getUint32(20, true) + dv.getUint32(24, true) * 4294967296;
    let hb = u8.subarray(32 + nhOff, 32 + nhOff + nhSize);
    let p = 0;
    const R = {
      byte: () => hb[p++],
      num: () => {
        const first = hb[p++]; let mask = 0x80, val = 0;
        for (let i = 0; i < 8; i++) {
          if ((first & mask) === 0) { const hi = first & (mask - 1); return val + hi * Math.pow(2, 8 * i); }
          val += hb[p++] * Math.pow(2, 8 * i); mask >>>= 1;
        }
        return val;
      }
    };
    function readBits(n) { const r = []; let b = 0, m = 0; for (let i = 0; i < n; i++) { if (m === 0) { b = R.byte(); m = 0x80; } r.push(!!(b & m)); m >>>= 1; } return r; }
    function readDigests(n) { const allDef = R.byte(); const def = allDef ? new Array(n).fill(true) : readBits(n); def.forEach(d => { if (d) p += 4; }); }
    function readStreamsInfo() {
      const si = { packPos: 0, packSizes: [], folders: [], subSizes: null, numUnpack: null };
      let id = R.byte();
      if (id === 0x06) {
        si.packPos = R.num(); const n = R.num();
        id = R.byte();
        while (id !== 0) {
          if (id === 0x09) for (let i = 0; i < n; i++) si.packSizes.push(R.num());
          else if (id === 0x0A) readDigests(n);
          id = R.byte();
        }
        id = R.byte();
      }
      if (id === 0x07) {
        if (R.byte() !== 0x0B) throw new Error('7z: ожидался Folder');
        const nf = R.num(); if (R.byte() !== 0) throw new Error('7z: external не поддерживается');
        for (let f = 0; f < nf; f++) {
          const nc = R.num(); const coders = []; let totIn = 0, totOut = 0;
          for (let c = 0; c < nc; c++) {
            const flag = R.byte(); const idSize = flag & 0x0F;
            const cid = Array.from(hb.subarray(p, p + idSize)).map(x => x.toString(16).padStart(2, '0')).join(''); p += idSize;
            let ni = 1, no = 1; if (flag & 0x10) { ni = R.num(); no = R.num(); }
            let props = null; if (flag & 0x20) { const ps = R.num(); props = hb.subarray(p, p + ps); p += ps; }
            coders.push({ id: cid, ni, no, props }); totIn += ni; totOut += no;
          }
          const bps = []; for (let i = 0; i < totOut - 1; i++) bps.push([R.num(), R.num()]);
          const np = totIn - bps.length; if (np > 1) for (let i = 0; i < np; i++) R.num();
          si.folders.push({ coders, totOut, unpackSizes: [] });
        }
        if (R.byte() !== 0x0C) throw new Error('7z: ожидались размеры');
        si.folders.forEach(f => { for (let i = 0; i < f.totOut; i++) f.unpackSizes.push(R.num()); });
        id = R.byte();
        while (id !== 0) { if (id === 0x0A) readDigests(nf); id = R.byte(); }
        id = R.byte();
      }
      if (id === 0x08) {
        si.numUnpack = si.folders.map(() => 1);
        id = R.byte();
        if (id === 0x0D) { si.numUnpack = si.folders.map(() => R.num()); id = R.byte(); }
        si.subSizes = [];
        si.folders.forEach((f, i) => {
          const n = si.numUnpack[i]; if (n === 0) return;
          const tot = f.unpackSizes[f.unpackSizes.length - 1]; let s = 0;
          for (let k = 0; k < n - 1; k++) { if (id !== 0x09) break; const v = R.num(); si.subSizes.push(v); s += v; }
          si.subSizes.push(tot - s);
        });
        if (id === 0x09) id = R.byte();
        while (id !== 0) { if (id === 0x0A) { let tot = 0; si.numUnpack.forEach(n => tot += n); readDigests(tot); } id = R.byte(); }
        id = R.byte();
      }
      return si;
    }
    function unpackFolder(si, fi) {
      let off = 32 + si.packPos;
      for (let i = 0; i < fi; i++) off += si.packSizes[i];
      const f = si.folders[fi]; const size = f.unpackSizes[f.unpackSizes.length - 1];
      if (f.coders.length !== 1) throw new Error('7z: многофильтровые архивы (BCJ и т.п.) не поддерживаются. Сохраните архив с методом LZMA/LZMA2 или распакуйте вручную.');
      const c = f.coders[0], end = off + si.packSizes[fi];
      if (c.id === '030101') return lzmaDecode(u8, off, end, c.props, size);
      if (c.id === '21') return lzma2Decode(u8, off, end, size);
      if (c.id === '00') return u8.slice(off, off + size);
      if (c.id === '06f10701') throw new Error('7z: архив зашифрован паролем');
      throw new Error('7z: метод сжатия ' + c.id + ' не поддерживается');
    }
    let id = R.byte();
    if (id === 0x17) {
      const si = readStreamsInfo();
      hb = unpackFolder(si, 0); p = 0; id = R.byte();
    }
    if (id !== 0x01) throw new Error('7z: неверный заголовок');
    id = R.byte();
    let main = null; const files = [];
    if (id === 0x02) { while (R.byte() !== 0) { p += R.num(); } id = R.byte(); }
    if (id === 0x03) { readStreamsInfo(); id = R.byte(); }
    if (id === 0x04) { main = readStreamsInfo(); id = R.byte(); }
    if (id === 0x05) {
      const nfiles = R.num(); let empty = new Array(nfiles).fill(false); const names = [];
      for (;;) {
        const t = R.byte(); if (t === 0) break;
        const sz = R.num(); const end = p + sz;
        if (t === 0x0E) empty = readBits(nfiles);
        else if (t === 0x11) {
          R.byte(); let s = '';
          while (names.length < nfiles && p < end) {
            const ch = hb[p] | (hb[p + 1] << 8); p += 2;
            if (ch === 0) { names.push(s); s = ''; } else s += String.fromCharCode(ch);
          }
        }
        p = end;
      }
      for (let i = 0; i < nfiles; i++) files.push({ name: names[i] || ('file' + i), empty: empty[i] });
    }
    const result = [];
    if (main) {
      let fi = 0, si = 0;
      const subs = main.subSizes || main.folders.map(f => f.unpackSizes[f.unpackSizes.length - 1]);
      const numUn = main.numUnpack || main.folders.map(() => 1);
      for (let f = 0; f < main.folders.length; f++) {
        const data = unpackFolder(main, f); let off = 0;
        for (let k = 0; k < numUn[f]; k++) {
          while (fi < files.length && files[fi].empty) fi++;
          const sz = subs[si++];
          result.push({ name: (files[fi] || {}).name || ('file' + fi), data: data.subarray(off, off + sz) });
          off += sz; fi++;
        }
      }
    }
    return result;
  }

  /* ------------------------------ text ---------------------------------- */
  function decodeText(u8) {
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) u8 = u8.subarray(3);
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
    catch (e) { return new TextDecoder('windows-1251').decode(u8); }
  }
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length);
    const sample = lines.slice(0, 20).join('\n');
    const cand = [';', '\t', ','];
    let delim = ';', best = -1;
    cand.forEach(d => { const c = lines.slice(0, 20).map(l => l.split(d).length); const m = Math.min.apply(null, c); if (m > best && m > 1) { best = m; delim = d; } });
    void sample;
    const rows = lines.map(l => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (q) { if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
        else if (ch === '"') q = true; else if (ch === delim) { out.push(cur.trim()); cur = ''; } else cur += ch;
      }
      out.push(cur.trim()); return out;
    });
    return { name: 'CSV', header: rows[0], rows: rows.slice(1) };
  }

  /* ------------------------------- xlsx ---------------------------------- */
  function xmlUnescape(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&'); }
  function colIdx(ref) { let n = 0; for (let i = 0; i < ref.length; i++) { const c = ref.charCodeAt(i); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; }
  async function readXLSX(u8) {
    const JZ = (typeof JSZip !== 'undefined') ? JSZip : null;
    if (!JZ) throw new Error('JSZip не загружен');
    const zip = await JZ.loadAsync(u8);
    const get = async (n) => { const f = zip.file(n); return f ? await f.async('string') : null; };
    const wb = await get('xl/workbook.xml'); if (!wb) throw new Error('XLSX: не найден workbook.xml');
    const rels = (await get('xl/_rels/workbook.xml.rels')) || '';
    const relMap = {}; rels.replace(/<Relationship\b[^>]*>/g, (m) => { const id = /Id="([^"]+)"/.exec(m), t = /Target="([^"]+)"/.exec(m); if (id && t) relMap[id[1]] = t[1]; return m; });
    const ss = []; const sst = await get('xl/sharedStrings.xml');
    if (sst) sst.replace(/<si>([\s\S]*?)<\/si>/g, (m, inner) => { let s = ''; inner.replace(/<t[^>]*>([\s\S]*?)<\/t>/g, (m2, t) => { s += t; return m2; }); ss.push(xmlUnescape(s)); return m; });
    // date styles
    const styles = (await get('xl/styles.xml')) || ''; const dateStyles = new Set();
    const cx = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
    const customFmt = {}; styles.replace(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g, (m, id, code) => { customFmt[id] = code; return m; });
    if (cx) { let i = 0; cx[1].replace(/<xf\b[^>]*>/g, (m) => { const f = /numFmtId="(\d+)"/.exec(m); const id = f ? +f[1] : 0; const code = customFmt[id] || ''; if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dmyhs]/i.test(code.replace(/"[^"]*"/g, ''))) dateStyles.add(i); i++; return m; }); }
    const sheets = [];
    const sheetTags = wb.match(/<sheet\b[^>]*>/g) || [];
    for (const tag of sheetTags) {
      const name = xmlUnescape((/name="([^"]*)"/.exec(tag) || [])[1] || 'Лист');
      const rid = (/r:id="([^"]+)"/.exec(tag) || /id="([^"]+)"/.exec(tag) || [])[1];
      let target = relMap[rid] || ''; target = target.replace(/^\//, ''); if (!target.startsWith('xl/')) target = 'xl/' + target;
      const xml = await get(target); if (!xml) continue;
      const rows = [];
      xml.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (m, inner) => {
        const row = [];
        inner.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m2, attrs, body) => {
          const r = /r="([A-Z]+)\d+"/.exec(attrs); const ci = r ? colIdx(r[1]) : row.length;
          const t = (/t="([^"]+)"/.exec(attrs) || [])[1]; const s = +((/s="(\d+)"/.exec(attrs) || [])[1] || 0);
          let v = null;
          if (body) {
            if (t === 'inlineStr') { let str = ''; body.replace(/<t[^>]*>([\s\S]*?)<\/t>/g, (m3, x) => { str += x; return m3; }); v = xmlUnescape(str); }
            else { const vv = /<v>([\s\S]*?)<\/v>/.exec(body); if (vv) { v = vv[1]; if (t === 's') v = ss[+v]; else if (t === 'str' || t === 'e') v = xmlUnescape(v); else if (t === 'b') v = v === '1'; else { v = +v; if (dateStyles.has(s)) v = { excelDate: v }; } } }
          }
          row[ci] = v; return m2;
        });
        rows.push(row); return m;
      });
      if (rows.length) sheets.push({ name, header: (rows[0] || []).map(x => x == null ? '' : String(x)), rows: rows.slice(1) });
    }
    return sheets;
  }

  /* ---------------------------- dates & numbers -------------------------- */
  function excelToMs(serial) { const ms = Math.round((serial - 25569) * 86400000); const d = new Date(ms); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime(); }
  function parseNum(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v;
    if (typeof v === 'object') return NaN;
    const s = String(v).replace(/\s/g, '').replace(',', '.');
    if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return NaN;
    return parseFloat(s);
  }
  function parseDate(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'object' && v.excelDate != null) return excelToMs(v.excelDate);
    if (typeof v === 'number') return (v > 20000 && v < 80000) ? excelToMs(v) : NaN;
    const s = String(v).trim();
    let m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime(); }
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    return NaN;
  }
  function parseTime(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'object' && v.excelDate != null) return Math.round((v.excelDate % 1) * 86400000);
    if (typeof v === 'number') return v < 1 ? Math.round(v * 86400000) : NaN;
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(v).trim());
    return m ? ((+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0))) * 1000 : NaN;
  }

  /* -------------------------- structure detection ------------------------ */
  const RX = {
    pwh: /голов|устье|устьев|буфер|wellhead|whp|pwh|руст|p\s*уст|затруб/i,
    pline: /шлейф|линия|линии|line|после\s*штуц|pline|коллектор|flowline/i,
    date: /дата|date/i, time: /время|time/i, value: /значен|value|давл|показ/i,
    created: /создан|измерен|замер/i, changed: /изменен/i
  };
  const UNITS = { 'кгс/см²': 1, 'МПа': 10.19716, 'бар': 1.019716, 'атм': 1.033227, 'кПа': 0.01019716, 'psi': 0.0703070 };
  function detectUnit(text) {
    if (!text) return null; const t = text.toLowerCase();
    if (/мпа|mpa/.test(t)) return 'МПа'; if (/кпа|kpa/.test(t)) return 'кПа'; if (/бар|bar/.test(t)) return 'бар';
    if (/psi/.test(t)) return 'psi'; if (/кгс|kgf|at\b|ат\b/.test(t)) return 'кгс/см²'; if (/атм|atm/.test(t)) return 'атм';
    return null;
  }
  function pickCol(header, rx, prefer, avoid) {
    const idx = []; header.forEach((h, i) => { if (rx.test(h || '')) idx.push(i); });
    if (!idx.length) return -1;
    if (prefer) { const p = idx.find(i => prefer.test(header[i])); if (p != null) return p; }
    if (avoid) { const a = idx.find(i => !avoid.test(header[i])); if (a != null) return a; }
    return idx[0];
  }
  /** Возвращает предлагаемое сопоставление столбцов. */
  function autoMap(tables) {
    const map = { mode: null, pwh: null, pline: null, notes: [] };
    // Режим "лист на параметр"
    const tp = tables.findIndex(t => RX.pwh.test(t.name)); const tl = tables.findIndex(t => RX.pline.test(t.name));
    const colsFor = (t) => ({
      date: pickCol(t.header, RX.date, RX.created, RX.changed),
      time: pickCol(t.header, RX.time, RX.created, RX.changed),
      value: pickCol(t.header, RX.value)
    });
    if (tp >= 0 && tl >= 0 && tp !== tl) {
      map.mode = 'sheets';
      map.pwh = Object.assign({ table: tp }, colsFor(tables[tp]));
      map.pline = Object.assign({ table: tl }, colsFor(tables[tl]));
      map.notes.push('Распознана выгрузка SCADA: отдельный лист для каждого параметра («' + tables[tp].name + '», «' + tables[tl].name + '»).');
      if (map.pwh.date >= 0 && RX.created.test(tables[tp].header[map.pwh.date])) map.notes.push('Использованы столбцы «Дата/Время создания» (момент измерения).');
    } else {
      map.mode = 'table';
      const ti = 0; const t = tables[ti]; const h = t.header;
      const d = pickCol(h, RX.date, RX.created, RX.changed), tm = pickCol(h, RX.time, RX.created, RX.changed);
      const pw = pickCol(h, RX.pwh), pl = pickCol(h, RX.pline);
      map.pwh = { table: ti, date: d, time: tm === d ? -1 : tm, value: pw };
      map.pline = { table: ti, date: d, time: tm === d ? -1 : tm, value: pl };
      map.notes.push('Режим «одна таблица»: дата/время и оба давления в столбцах.');
      if (pw < 0 || pl < 0) map.notes.push('Не все столбцы давлений распознаны — укажите вручную.');
    }
    ['pwh', 'pline'].forEach(k => {
      const m = map[k]; if (!m) return; const t = tables[m.table];
      m.unit = detectUnit((t.header[m.value] || '') + ' ' + t.name) || 'кгс/см²';
    });
    return map;
  }
  /** Извлекает ряд {t[],v[]} по сопоставлению. */
  function extract(tables, m) {
    const t = tables[m.table]; const k = UNITS[m.unit] || 1;
    const T = [], V = []; let badDate = 0, badVal = 0;
    t.rows.forEach(r => {
      if (!r) return;
      let ms = parseDate(r[m.date]);
      if (m.time != null && m.time >= 0) { const tt = parseTime(r[m.time]); if (!isNaN(tt) && !isNaN(ms)) { const d = new Date(ms); ms = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() + tt; } }
      const v = parseNum(r[m.value]);
      if (isNaN(ms)) { badDate++; return; }
      if (isNaN(v)) { badVal++; return; }
      T.push(ms); V.push(v * k);
    });
    // сортировка
    const idx = T.map((_, i) => i).sort((a, b) => T[a] - T[b]);
    return { t: idx.map(i => T[i]), v: idx.map(i => V[i]), badDate, badVal };
  }

  /** Главная точка входа: File/ArrayBuffer → таблицы. */
  async function readAny(name, buf) {
    let u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const log = [];
    if (u8[0] === 0x37 && u8[1] === 0x7A && u8[2] === 0xBC) {
      const files = un7z(u8);
      log.push('Архив 7z: ' + files.map(f => f.name + ' (' + f.data.length + ' байт)').join(', '));
      let all = [];
      for (const f of files) { const r = await readAny(f.name, f.data); r.log.forEach(l => log.push(l)); all = all.concat(r.tables); }
      return { tables: all, log, inner: files.map(f => f.name) };
    }
    if (u8[0] === 0x50 && u8[1] === 0x4B) {
      const sheets = await readXLSX(u8);
      log.push('Книга Excel «' + name + '»: листов ' + sheets.length + (/\.csv$/i.test(name) ? ' (файл с расширением .csv фактически является XLSX)' : ''));
      return { tables: sheets, log };
    }
    if (u8[0] === 0xD0 && u8[1] === 0xCF) {
      const tables = GXLS.read(u8);
      return { tables, log: ['Книга Excel 97-2003 «' + name + '»: листов ' + tables.length] };
    }
    const tb = parseCSV(decodeText(u8)); tb.name = name;
    log.push('Текстовый файл CSV «' + name + '»: строк ' + tb.rows.length);
    return { tables: [tb], log };
  }

  return { un7z, readAny, autoMap, extract, UNITS, detectUnit, parseDate, parseNum };
})();
if (typeof module !== 'undefined') module.exports = GIO;
