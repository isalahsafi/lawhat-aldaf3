// محرك التطبيق على الهاتف: يشغّل كود المنصة نفسه (core + routes) فوق SQLite داخل الهاتف،
// ويحفظ كل تغيير فورًا. البيانات تنتقل مع المنصة على الكمبيوتر كملف (نسخة احتياطية / استعادة).
const { adapt } = require('./sqljs-adapter');
const store = require('./store');
const { createRouter } = require('../../server/router');

let SQL = null;
let raw = null, db = null, core = null, fx = null, routes = null, router = null, SCHEMA = 0;
let meta = {};
let queue = Promise.resolve();
let lastChanges = 0;
const listeners = new Set();
const emit = () => { const s = status(); listeners.forEach((f) => { try { f(s); } catch { /* تجاهل */ } }); };
const serial = (fn) => { const job = queue.then(fn); queue = job.catch(() => {}); return job; };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const STATS_SQL = `SELECT (SELECT COUNT(*) FROM entries) entries, (SELECT COUNT(*) FROM months) months,
  (SELECT MAX(ym) FROM months) last_month, (SELECT MAX(at) FROM audit_log) last_edit`;

// ---------- التشغيل ----------
async function boot() {
  globalThis.FPB_FX_TIMEOUT = 6000;
  SQL = await window.initSqlJs({ locateFile: (f) => 'vendor/' + f });
  const saved = await store.load();
  // من إصدار سابق كان يتزامن عبر Tailscale: تُحذف بيانات الربط وتبقى البيانات كما هي
  const { pc, outbox, etag, conflicts, errors, seq, lastSync, lastError, lastAttempt, ...rest } = saved.meta || {};
  meta = rest;
  if (!saved.db) return { needsSetup: true };
  open(saved.db);
  if (pc || saved.outbox) await store.save({ meta, outbox: [] });
  return { ready: true };
}

function open(bytes) {
  if (raw) {
    raw.replace(bytes);
    require('../../server/schema').setup(db, {});   // ترقية نسخة أقدم إن لزم
    lastChanges = -1;
    return;
  }
  raw = adapt(SQL, bytes);
  globalThis.__FPB_RAW = raw;
  const dbm = require('./db-browser');
  db = dbm.db; SCHEMA = dbm.SCHEMA_VERSION;
  core = require('../../server/core');
  fx = require('../../server/fx');
  routes = require('../../server/routes');
  router = createRouter();
  routes(router, { publicSettings });
  lastChanges = raw.totalChanges();
}

function publicSettings() {
  return { ...routes.baseSettings(), platform: 'phone' };
}

// ---------- الحفظ ----------
async function persist() {
  const bytes = raw.export();
  lastChanges = raw.totalChanges();
  await store.save({ db: bytes, meta });
}
async function persistIfChanged(force) {
  if (force || raw.totalChanges() !== lastChanges) await persist();
}

// ---------- الواجهة المحلية (بدل الخادم) ----------
function api(method, url, body) {
  return serial(async () => {
    const mutating = method !== 'GET';
    const out = await router.handle(method, url, clone(body ?? {}));
    await persistIfChanged(mutating && out.status < 400);
    if (out.status >= 400) throw new Error((out.body && out.body.error) || 'خطأ');
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

// ---------- البدء والنسخ الاحتياطي والاستعادة ----------
async function startEmpty() {
  open(null);
  await persist();
}
function backup() {
  return serial(async () => {
    const b = raw.export();
    meta.lastBackup = new Date().toISOString();
    lastChanges = raw.totalChanges();
    await store.save({ db: b, meta });
    emit();
    return b;
  });
}
// يفحص ملفًا قبل الاستعادة ويقارنه ببيانات الهاتف
function inspect(bytes) {
  const u8 = new Uint8Array(bytes);
  if (new TextDecoder().decode(u8.slice(0, 15)) !== 'SQLite format 3') throw new Error('هذا الملف ليس نسخة احتياطية من لوحة الدفع');
  const probe = new SQL.Database(u8);
  try {
    const t = probe.exec("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('entries','months','_migrations')");
    if (!t.length || t[0].values[0][0] < 3) throw new Error('هذا الملف ليس نسخة احتياطية من لوحة الدفع');
    const v = probe.exec('SELECT MAX(id) FROM _migrations')[0].values[0][0];
    if (SCHEMA && v > SCHEMA) throw new Error('النسخة من إصدار أحدث من التطبيق. أغلق التطبيق وافتحه من جديد ليتحدّث، ثم أعد المحاولة');
    const r = probe.exec(STATS_SQL)[0];
    const file = Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]]));
    return { file, current: raw ? { ...db.prepare(STATS_SQL).get() } : null };
  } finally { probe.close(); }
}
async function restore(bytes) {
  inspect(bytes);
  const u8 = new Uint8Array(bytes);
  return serial(async () => {
    open(u8);
    await persist();
    emit();
  });
}
async function eraseAll() { await store.clear(); }

// ---------- الحالة ----------
function status() {
  return { online: navigator.onLine, pendingRates: raw ? pendingRates() : 0, lastBackup: meta.lastBackup || null, schema: SCHEMA };
}
const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

window.FPB_LOCAL = { boot, api, startEmpty, backup, inspect, restore, eraseAll, fillPending, status, onChange };
