// قاعدة البيانات داخل الهاتف: يحل محل server/db.js في نسخة التطبيق.
// القاعدة نفسها تُفتح مسبقًا في engine.js وتُمرَّر عبر globalThis.__FPB_RAW.
const { instrument } = require('../../server/sqlwrap');
const { setup, VARIABLE_CATEGORIES } = require('../../server/schema');

const raw = globalThis.__FPB_RAW;
if (!raw) throw new Error('قاعدة البيانات غير مفتوحة');
const db = instrument(raw);
const { tx, getSetting, setSetting, SCHEMA_VERSION } = setup(db, {});

module.exports = { db, tx, getSetting, setSetting, VARIABLE_CATEGORIES, SCHEMA_VERSION, DB_PATH: '', DATA_DIR: '' };
