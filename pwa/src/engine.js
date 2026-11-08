// محرك التطبيق على الهاتف: يشغّل كود المنصة نفسه (core + routes) فوق SQLite داخل الهاتف،
// ويحفظ كل تغيير فورًا، ويسجّل العمليات لإرسالها إلى الكمبيوتر عند المزامنة.
const { adapt } = require('./sqljs-adapter');
const store = require('./store');
const { createRouter } = require('../../server/router');

let SQL = null;
let raw = null, db = null, core = null, fx = null, routes = null, router = null, SCHEMA = 0;
let meta = { seq: 0, conflicts: [], errors: [] };
let outbox = [];
let queue = Promise.resolve();
let lastChanges = 0;
let syncing = false;
const listeners = new Set();
const emit = () => { const s = status(); listeners.forEach((f) => { try { f(s); } catch { /* تجاهل */ } }); };
const serial = (fn) => { const job = queue.then(fn); queue = job.catch(() => {}); return job; };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---------- التشغيل ----------
async function boot() {
  globalThis.FPB_FX_TIMEOUT = 6000;
  SQL = await window.initSqlJs({ locateFile: (f) => 'vendor/' + f });
  const saved = await store.load();
  meta = { seq: 0, conflicts: [], errors: [], ...(saved.meta || {}) };
  outbox = saved.outbox || [];
  if (!saved.db) return { needsSetup: true };
  open(saved.db);
  return { ready: true };
}

function open(bytes) {
  if (raw) { raw.replace(bytes); afterReplace(); return; }
  raw = adapt(SQL, bytes);
  globalThis.__FPB_RAW = raw;
  const dbm = require('./db-browser');
  db = dbm.db; SCHEMA = dbm.SCHEMA_VERSION;
  core = require('../../server/core');
  fx = require('../../server/fx');
  routes = require('../../server/routes');
  router = createRouter();
  routes(router, { publicSettings });
  db.setIdBase(meta.pc ? meta.pc.idBase : 0);
  lastChanges = raw.totalChanges();
}
// بعد استبدال البيانات (مزامنة أو استعادة): ترقية إن لزم ثم متابعة
function afterReplace() {
  require('../../server/schema').setup(db, {});
  db.setIdBase(meta.pc ? meta.pc.idBase : 0);
  lastChanges = -1;
}

function publicSettings() {
  return { ...routes.baseSettings(), platform: 'phone', paired: !!meta.pc, pc_url: meta.pc ? meta.pc.url : null };
}

// ---------- الحفظ ----------
async function persist() {
  const bytes = raw.export();
  lastChanges = raw.totalChanges();
  await store.save({ db: bytes, outbox, meta });
}
async function persistIfChanged(force) {
  if (force || raw.totalChanges() !== lastChanges) await persist();
}

// ---------- الواجهة المحلية (بدل الخادم) ----------
const PATCH_TABLES = { entries: 'entries', templates: 'templates', sections: 'sections', goals: 'goals' };
function beforeOf(method, url, body) {
  if (method !== 'PATCH') return null;
  const m = /^\/api\/(\w+)\/(\d+)$/.exec(url.split('?')[0]);
  const tbl = m && PATCH_TABLES[m[1]];
  if (!tbl) return null;
  const row = db.prepare(`SELECT * FROM ${tbl} WHERE id=?`).get(Number(m[2]));
  if (!row) return null;
  return Object.fromEntries(Object.keys(body || {}).filter((k) => k in row).map((k) => [k, row[k]]));
}

function api(method, url, body) {
  return serial(async () => {
    const mutating = method !== 'GET';
    const sent = clone(body ?? {});
    const before = mutating && meta.pc ? beforeOf(method, url, sent) : null;
    const { result: out, created } = await db.capture(() => router.handle(method, url, clone(sent)));
    if (out.status >= 400) {
      await persistIfChanged();
      throw new Error((out.body && out.body.error) || 'خطأ');
    }
    if (mutating && meta.pc) {
      outbox.push({ seq: ++meta.seq, at: new Date().toISOString(), today: fx.today(), method, path: url, body: sent, created, before });
    }
    await persistIfChanged(mutating);
    if (mutating) emit();
    return out.body;
  });
}

// ---------- أسعار الصرف المعلّقة ----------
function pendingRates() {
  try { return db.prepare('SELECT COUNT(*) c FROM entries WHERE fx_source=?').get(fx.PENDING).c; } catch { return 0; }
}
function fillPending() {
  if (!raw || !navigator.onLine || !pendingRates()) return Promise.resolve();
  return serial(async () => { await core.fillPendingRates(); await persistIfChanged(); emit(); });
}

// ---------- الاتصال بالكمبيوتر ----------
function normUrl(u) {
  let s = String(u || '').trim().replace(/\s+/g, '');
  if (!s) throw new Error('أدخل عنوان الكمبيوتر');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const x = new URL(s);
  return x.origin;
}
async function pcFetch(path, { method = 'GET', body, headers = {}, timeout = 30000, url, token } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch((url || meta.pc.url) + path, {
      method, cache: 'no-store', signal: ctrl.signal,
      headers: { ...(token || (meta.pc && meta.pc.token) ? { Authorization: 'Bearer ' + (token || meta.pc.token) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('انتهت مهلة الاتصال بالكمبيوتر');
    throw new Error('الكمبيوتر غير متاح الآن. تأكد أنه يعمل وأن Tailscale متصل على الجهازين');
  } finally { clearTimeout(t); }
}
const schemaError = (pc) => new Error(pc > SCHEMA
  ? 'المنصة على الكمبيوتر أحدث من التطبيق: افتح التطبيق من جديد ليتحدّث'
  : 'التطبيق أحدث من المنصة على الكمبيوتر: أغلق المنصة على الكمبيوتر وشغّلها من جديد');

async function fetchSnapshot(etag, auth) {
  const r = await pcFetch('/api/sync/snapshot', { headers: etag ? { 'If-None-Match': `"${etag}"` } : {}, timeout: 90000, ...auth });
  if (r.status === 401) throw new Error('أُلغي ربط هذا الهاتف من الكمبيوتر. اربطه من جديد');
  if (r.status === 304) return null;
  if (!r.ok) throw new Error('تعذر استلام البيانات من الكمبيوتر (' + r.status + ')');
  const schema = Number(r.headers.get('X-Schema'));
  if (schema !== SCHEMA && SCHEMA) throw schemaError(schema);
  return { bytes: new Uint8Array(await r.arrayBuffer()), etag: (r.headers.get('ETag') || '').replace(/"/g, ''), schema };
}

function sync() {
  if (!meta.pc || syncing) return Promise.resolve({ ok: false, skipped: true });
  syncing = true; emit();
  return serial(async () => {
    try {
      const ops = outbox.slice();
      let results = [];
      if (ops.length) {
        const r = await pcFetch('/api/sync/push', { method: 'POST', body: { schema: SCHEMA, ops }, timeout: 120000 });
        if (r.status === 401) throw new Error('أُلغي ربط هذا الهاتف من الكمبيوتر. اربطه من جديد');
        if (r.status === 409) { const j = await r.json().catch(() => ({})); throw schemaError(j.pc); }
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'تعذر إرسال العمليات (' + r.status + ')'); }
        results = (await r.json()).results || [];
      }
      // بعد إرسال عمليات تُستلم نسخة كاملة دائمًا
      const snap = await fetchSnapshot(ops.length ? null : meta.etag);
      const sent = new Set(ops.map((o) => o.seq));
      outbox = outbox.filter((o) => !sent.has(o.seq));
      const opOf = (seq) => ops.find((o) => o.seq === seq);
      const conflicts = results.filter((x) => x.status === 'conflict').map((x) => ({ ...x.conflict, seq: x.seq, at: opOf(x.seq).at }));
      const errors = results.filter((x) => x.status === 'error').map((x) => ({ seq: x.seq, error: x.error, at: opOf(x.seq).at, op: opOf(x.seq) }));
      meta.conflicts = [...(meta.conflicts || []), ...conflicts].slice(-50);
      meta.errors = [...(meta.errors || []), ...errors].slice(-50);
      if (snap) { open(snap.bytes); meta.etag = snap.etag; }
      meta.lastSync = new Date().toISOString();
      meta.lastError = null;
      await persist();
      return { ok: true, sent: ops.length, changed: !!snap, conflicts: conflicts.length, errors: errors.length };
    } catch (e) {
      meta.lastError = e.message;
      meta.lastAttempt = new Date().toISOString();
      await store.save({ meta });
      return { ok: false, error: e.message };
    } finally { syncing = false; setTimeout(emit, 0); }
  });
}

// الربط بالكمبيوتر: تحل بيانات الكمبيوتر محل بيانات الهاتف
async function pair(url, code, name) {
  const base = normUrl(url);
  const r = await pcFetch('/api/sync/pair', { method: 'POST', body: { code: String(code).trim(), name: name || 'iPhone' }, url: base, timeout: 20000 });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'تعذر الربط (' + r.status + ')');
  const snap = await fetchSnapshot(null, { url: base, token: j.token });
  return serial(async () => {
    if (SCHEMA && j.schema !== SCHEMA) throw schemaError(j.schema);
    meta = { ...meta, pc: { url: base, token: j.token, deviceId: j.deviceId, deviceNo: j.deviceNo, idBase: j.idBase, name: name || 'iPhone' },
      etag: snap.etag, conflicts: [], errors: [], lastSync: new Date().toISOString(), lastError: null };
    outbox = [];
    open(snap.bytes);
    await persist();
    emit();
    return { ok: true };
  });
}
function unpair() {
  return serial(async () => {
    meta = { ...meta, pc: null, etag: null, conflicts: [], errors: [], lastError: null };
    outbox = [];
    db.setIdBase(0);
    await persist();
    emit();
  });
}

// ---------- بدء بلا كمبيوتر، والنسخ الاحتياطي ----------
async function startEmpty() {
  open(null);
  await persist();
}
function backup() {
  return serial(async () => { const b = raw.export(); lastChanges = raw.totalChanges(); return b; });
}
async function restore(bytes) {
  const u8 = new Uint8Array(bytes);
  if (new TextDecoder().decode(u8.slice(0, 15)) !== 'SQLite format 3') throw new Error('هذا الملف ليس نسخة احتياطية من لوحة الدفع');
  const probe = new SQL.Database(u8);
  try {
    const t = probe.exec("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('entries','months','_migrations')");
    if (!t.length || t[0].values[0][0] < 3) throw new Error('هذا الملف ليس نسخة احتياطية من لوحة الدفع');
    const v = probe.exec('SELECT MAX(id) FROM _migrations')[0].values[0][0];
    if (SCHEMA && v > SCHEMA) throw new Error('النسخة من إصدار أحدث من التطبيق. افتح التطبيق من جديد ليتحدّث ثم أعد المحاولة');
  } finally { probe.close(); }
  if (meta.pc) throw new Error('الهاتف مرتبط بالكمبيوتر، وبياناته تأتي منه. ألغِ الربط أولًا لاستعادة نسخة');
  return serial(async () => {
    open(u8);
    await persist();
    emit();
  });
}
async function eraseAll() { await store.clear(); }

// ---------- التعارض والأخطاء ----------
async function resolveConflict(index, choice) {
  const c = (meta.conflicts || [])[index];
  if (!c) return;
  meta.conflicts.splice(index, 1);
  if (choice === 'phone') {
    const body = Object.fromEntries(c.fields.map((f) => [f.key, f.phone]));
    await api('PATCH', c.path, body);
  } else {
    await serial(() => store.save({ meta }));
  }
  emit();
}
async function dismissError(index) {
  (meta.errors || []).splice(index, 1);
  await serial(() => store.save({ meta }));
  emit();
}

// ---------- الحالة ----------
function status() {
  return {
    paired: !!meta.pc, pc: meta.pc ? { url: meta.pc.url, name: meta.pc.name, deviceNo: meta.pc.deviceNo } : null,
    lastSync: meta.lastSync || null, lastError: meta.lastError || null, lastAttempt: meta.lastAttempt || null, syncing,
    outbox: outbox.length, pendingRates: raw ? pendingRates() : 0, conflicts: meta.conflicts || [], errors: meta.errors || [],
    online: navigator.onLine, schema: SCHEMA,
  };
}
const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

window.FPB_LOCAL = { boot, api, sync, pair, unpair, startEmpty, backup, restore, eraseAll, resolveConflict, dismissError, fillPending, status, onChange, normUrl };
