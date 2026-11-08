// قاعدة البيانات على الكمبيوتر: SQLite مدمجة في Node، ملف واحد داخل مجلد المشروع.
// البنية والترقيات في schema.js (مشتركة مع تطبيق الهاتف).
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { instrument } = require('./sqlwrap');
const { setup, VARIABLE_CATEGORIES } = require('./schema');

const argData = (process.argv.find((a) => a.startsWith('--data-dir=')) || '').slice(11);
const DATA_DIR = argData || process.env.FPB_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'finance.db');
for (const d of ['', 'imports', 'backups']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });

const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
const db = instrument(raw);

const { tx, getSetting, setSetting, SCHEMA_VERSION } = setup(db, {
  beforeUpgrade() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
    db.exec(`VACUUM INTO '${path.join(DATA_DIR, 'backups', `finance-${stamp}-before-upgrade.db`).replace(/'/g, "''")}'`);
  },
});

module.exports = { db, tx, DB_PATH, DATA_DIR, getSetting, setSetting, VARIABLE_CATEGORIES, SCHEMA_VERSION };
