// تخزين دائم داخل الهاتف (IndexedDB): ملف قاعدة البيانات، والعمليات المنتظرة، وحالة المزامنة.
// الثلاثة تُحفظ معًا في معاملة واحدة حتى لا تختلف عن بعضها.
const NAME = 'family-payments';
let dbp = null;
function idb() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function load() {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', 'readonly');
    const s = t.objectStore('kv');
    const out = {};
    for (const k of ['db', 'outbox', 'meta']) s.get(k).onsuccess = (e) => { out[k] = e.target.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}
async function save(parts) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', 'readwrite');
    const s = t.objectStore('kv');
    for (const [k, v] of Object.entries(parts)) if (v !== undefined) s.put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function clear() {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', 'readwrite');
    t.objectStore('kv').clear();
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

module.exports = { load, save, clear };
