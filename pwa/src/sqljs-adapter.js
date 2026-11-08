// يجعل SQLite WASM (sql.js) يتصرف مثل node:sqlite (prepare().run/get/all و exec)،
// فيعمل كود المنصة نفسه داخل الهاتف دون تعديل.
// الجمل المجهّزة تُنشأ عند أول استخدام، وتُعاد تهيئتها تلقائيًا بعد استبدال قاعدة البيانات أو تصديرها.
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

function adapt(SQL, bytes) {
  let sqlDb = null;
  let gen = 0;
  const open = (b) => {
    if (sqlDb) sqlDb.close();
    sqlDb = b ? new SQL.Database(b) : new SQL.Database();
    sqlDb.exec('PRAGMA foreign_keys = ON;');
    gen++;
  };
  open(bytes);
  const scalar = (sql) => { const r = sqlDb.exec(sql); return r.length ? r[0].values[0][0] : null; };

  function prepare(sql) {
    let st = null, g = -1;
    const S = () => { if (!st || g !== gen) { st = sqlDb.prepare(sql); g = gen; } return st; };
    const go = (params, fn) => {
      const s = S();
      try { s.bind(params.map(norm)); return fn(s); } finally { s.reset(); }
    };
    return {
      run: (...p) => go(p, (s) => { while (s.step()) { /* حتى النهاية */ } return { changes: sqlDb.getRowsModified(), lastInsertRowid: scalar('SELECT last_insert_rowid()') }; }),
      get: (...p) => go(p, (s) => (s.step() ? s.getAsObject() : undefined)),
      all: (...p) => go(p, (s) => { const out = []; while (s.step()) out.push(s.getAsObject()); return out; }),
    };
  }

  return {
    prepare,
    exec(sql) { sqlDb.exec(sql); },
    // نسخة من الملف كاملًا (التصدير يغلق الجمل المجهّزة، فتُعاد تهيئتها عند الاستخدام التالي)
    export() { const b = sqlDb.export(); gen++; sqlDb.exec('PRAGMA foreign_keys = ON;'); return b; },
    replace(b) { open(b); },
    totalChanges: () => scalar('SELECT total_changes()'),
  };
}

module.exports = { adapt };
