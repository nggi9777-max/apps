/* ============================================================================
   DB: локальная база IndexedDB (сохраняется между сеансами).
   Хранилища: fields, wells, series (история измерений по скважине), recs (журнал).
   ========================================================================== */
const GDB = (function () {
  'use strict';
  const NAME = 'GasWellBlowdownDB', VER = 2;
  let db = null; let mem = null; // резерв в памяти, если IndexedDB недоступна
  function open() {
    return new Promise((res) => {
      if (!('indexedDB' in window)) { mem = { fields: new Map(), wells: new Map(), series: new Map(), recs: new Map(), meta: new Map() }; return res(false); }
      const rq = indexedDB.open(NAME, VER);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains('fields')) d.createObjectStore('fields', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('wells')) { const s = d.createObjectStore('wells', { keyPath: 'id' }); s.createIndex('fieldId', 'fieldId'); }
        if (!d.objectStoreNames.contains('series')) d.createObjectStore('series', { keyPath: 'wellId' });
        if (!d.objectStoreNames.contains('recs')) { const s = d.createObjectStore('recs', { keyPath: 'id' }); s.createIndex('wellId', 'wellId'); }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      };
      rq.onsuccess = () => { db = rq.result; res(true); };
      rq.onerror = () => { mem = { fields: new Map(), wells: new Map(), series: new Map(), recs: new Map(), meta: new Map() }; res(false); };
    });
  }
  const key = (store) => store === 'series' ? 'wellId' : 'id';
  function tx(store, mode, fn) {
    if (mem) return Promise.resolve(fn(null));
    return new Promise((res, rej) => { const t = db.transaction(store, mode); const s = t.objectStore(store); let out; const r = fn(s); if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; }; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); });
  }
  const api = {
    open,
    persistent: () => !mem,
    uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    all(store) { if (mem) return Promise.resolve(Array.from(mem[store].values())); return tx(store, 'readonly', s => s.getAll()); },
    get(store, id) { if (mem) return Promise.resolve(mem[store].get(id)); return tx(store, 'readonly', s => s.get(id)); },
    put(store, obj) { if (mem) { mem[store].set(obj[key(store)], obj); return Promise.resolve(); } return tx(store, 'readwrite', s => s.put(obj)); },
    del(store, id) { if (mem) { mem[store].delete(id); return Promise.resolve(); } return tx(store, 'readwrite', s => s.delete(id)); },
    async byWell(store, wellId) { const a = await api.all(store); return a.filter(x => x.wellId === wellId); },
    async exportAll() { const o = { app: 'ГазПродувка', version: 1, exported: new Date().toISOString() }; for (const s of ['fields', 'wells', 'series', 'recs', 'meta']) o[s] = await api.all(s); return o; },
    async importAll(o, replace) {
      if (!o || !o.fields) throw new Error('Неверный файл резервной копии');
      if (replace) for (const s of ['fields', 'wells', 'series', 'recs']) { const a = await api.all(s); for (const x of a) await api.del(s, x[key(s)]); }
      for (const s of ['fields', 'wells', 'series', 'recs', 'meta']) for (const x of (o[s] || [])) await api.put(s, x);
    }
  };
  return api;
})();
