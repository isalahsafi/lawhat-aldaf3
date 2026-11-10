// نقل البيانات بين المنصة وتطبيق الهاتف كملف (دون اتصال مباشر):
//  - تصدير نسخة للهاتف: ملف قاعدة بيانات كامل يُستعاد في التطبيق.
//  - استيراد نسخة من الهاتف: تحل محل بيانات المنصة بعد مقارنة ونسخة احتياطية تلقائية.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { db, tx, DATA_DIR, SCHEMA_VERSION } = require('./db');
const fx = require('./fx');

// إعدادات خاصة بالكمبيوتر لا تنتقل بين الأجهزة
const LOCAL_KEYS = ['pin', 'port', 'lan_enabled'];
const IMPORTS = path.join(DATA_DIR, 'imports');
const pending = new Map(); // token → { file, expires }

const STATS_SQL = `SELECT (SELECT COUNT(*) FROM entries) entries, (SELECT COUNT(*) FROM months) months,
  (SELECT MAX(ym) FROM months) last_month, (SELECT MAX(at) FROM audit_log) last_edit`;
const sqlQuote = (p) => `'${p.replace(/'/g, "''")}'`;

function stats(handle) { return { ...handle.prepare(STATS_SQL).get() }; }

// يفحص ملفًا: نسخة صالحة من لوحة الدفع؟ ومن أي إصدار؟
function inspectFile(file) {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1', 0, 15) !== 'SQLite format 3') throw new Error('هذا الملف ليس نسخة احتياطية من لوحة الدفع');
  const h = new DatabaseSync(file, { readOnly: true });
  try {
    const n = h.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN ('entries','months','_migrations')").get().c;
    if (n < 3) throw new Error('هذا الملف ليس نسخة احتياطية من لوحة الدفع');
    const schema = h.prepare('SELECT MAX(id) v FROM _migrations').get().v;
    if (schema > SCHEMA_VERSION) throw new Error('النسخة من إصدار أحدث من المنصة. حدّث المنصة أولًا');
    return { ...stats(h), schema };
  } finally { h.close(); }
}

// نسخة كاملة للهاتف (بلا إعدادات الكمبيوتر)
function exportForPhone() {
  const tmp = path.join(IMPORTS, `export-${Date.now()}.db`);
  db.exec(`VACUUM INTO ${sqlQuote(tmp)}`);
  const h = new DatabaseSync(tmp);
  h.exec(`DELETE FROM settings WHERE key IN (${LOCAL_KEYS.map((k) => `'${k}'`).join(',')}); PRAGMA journal_mode=DELETE; VACUUM;`);
  h.close();
  const bytes = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return bytes;
}

// استبدال بيانات المنصة بمحتوى الملف، جدولًا جدولًا داخل معاملة واحدة
// (القاعدة تبقى مفتوحة والجمل المجهّزة صالحة، فلا حاجة لإعادة تشغيل المنصة)
function restoreFrom(file) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`ATTACH DATABASE ${sqlQuote(file)} AS up`);
  try {
    tx(() => {
      const tables = db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations'").all().map((r) => r.name);
      const keep = LOCAL_KEYS.map((k) => `'${k}'`).join(',');
      for (const t of tables) {
        const upCols = new Set(db.prepare(`PRAGMA up.table_info(${t})`).all().map((c) => c.name));
        if (!upCols.size) continue;
        const cols = db.prepare(`PRAGMA main.table_info(${t})`).all().map((c) => c.name).filter((c) => upCols.has(c)).join(', ');
        if (t === 'settings') {
          db.exec(`DELETE FROM main.settings WHERE key NOT IN (${keep}); INSERT OR IGNORE INTO main.settings (${cols}) SELECT ${cols} FROM up.settings WHERE key NOT IN (${keep});`);
        } else if (t === 'fx_cache') {
          db.exec(`INSERT OR IGNORE INTO main.fx_cache (${cols}) SELECT ${cols} FROM up.fx_cache;`);
        } else {
          db.exec(`DELETE FROM main.${t}; INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM up.${t};`);
        }
      }
    });
  } finally {
    db.exec('DETACH DATABASE up');
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function install(app, { express, backup, wrap }) {
  app.get('/api/backup/phone', wrap(async (req, res) => {
    const bytes = exportForPhone();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="lawhat-aldaf3-${fx.today()}.db"`);
    res.end(bytes);
  }));

  // الخطوة 1: رفع الملف وفحصه، مع مقارنته ببيانات المنصة الحالية
  app.post('/api/backup/inspect', express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
    if (!req.body || !req.body.length) throw new Error('الملف فارغ');
    const file = path.join(IMPORTS, `phone-${Date.now()}.db`);
    fs.writeFileSync(file, req.body);
    let info;
    try { info = inspectFile(file); } catch (e) { fs.unlinkSync(file); throw e; }
    const token = crypto.randomBytes(12).toString('hex');
    pending.set(token, { file, expires: Date.now() + 30 * 60e3 });
    res.json({ token, file: info, current: stats(db) });
  }));

  // الخطوة 2: الاستبدال بعد الموافقة، بعد نسخة احتياطية تلقائية
  app.post('/api/backup/restore', wrap(async (req, res) => {
    const p = pending.get(String((req.body && req.body.token) || ''));
    if (!p || Date.now() > p.expires) throw new Error('انتهت صلاحية الملف المرفوع، ارفعه من جديد');
    const saved = backup('before-phone-restore');
    restoreFrom(p.file);
    pending.delete(req.body.token);
    res.json({ ok: true, backup: saved, now: stats(db) });
  }));
}

module.exports = { install };
