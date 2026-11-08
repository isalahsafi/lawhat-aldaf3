// غلاف موحّد لقاعدة البيانات، يعمل فوق node:sqlite على الكمبيوتر وفوق SQLite WASM على الهاتف.
// وظيفتان للمزامنة:
//  1) تسجيل الصفوف التي تنشئها كل عملية (لربط معرّفات الهاتف بمعرّفات الكمبيوتر).
//  2) على الهاتف: الصفوف الجديدة تأخذ معرّفات من نطاق خاص بالجهاز (مثل 1000000000000+)
//     فلا تختلط بمعرّفات الكمبيوتر، ويمكن التعرف عليها واستبدالها عند المزامنة.
const ID_TABLES = new Set(['sections', 'templates', 'months', 'entries', 'goals', 'goal_contribs', 'audit_log',
  'series', 'series_periods', 'parties', 'debts', 'debt_txns', 'imports']);
const INSERT_RE = /^\s*INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(/i;

function instrument(raw) {
  const state = { base: 0, capture: null, last: null };
  // معرّفات الجهاز فريدة عبر كل الجداول (لا يتكرر نفس الرقم في جدولين)،
  // لأن المزامنة تستبدلها بمعرّفات الكمبيوتر بالرقم وحده
  const nextId = () => {
    if (state.last == null) {
      state.last = state.base - 1;
      for (const t of ID_TABLES) {
        const r = raw.prepare(`SELECT MAX(id) m FROM ${t} WHERE id >= ?`).get(state.base);
        if (r && r.m != null) state.last = Math.max(state.last, Number(r.m));
      }
    }
    return ++state.last;
  };

  function prepare(sql) {
    const m = INSERT_RE.exec(sql);
    const tbl = m && ID_TABLES.has(m[1]) ? m[1] : null;
    if (!tbl) return raw.prepare(sql);
    const hasId = m[2].split(',').map((c) => c.trim()).includes('id');
    let plain = null, withId = null;
    const get = (alloc) => (alloc
      ? (withId ||= raw.prepare(sql.replace(INSERT_RE, (all, t, cols) => `INSERT INTO ${t} (id, ${cols}) VALUES (?, `)))
      : (plain ||= raw.prepare(sql)));
    return {
      run(...params) {
        const alloc = state.base > 0 && !hasId;
        const r = alloc ? get(true).run(nextId(), ...params) : get(false).run(...params);
        if (state.capture) state.capture.push({ tbl, id: Number(r.lastInsertRowid) });
        return r;
      },
      get: (...p) => get(false).get(...p),
      all: (...p) => get(false).all(...p),
    };
  }

  return {
    raw,
    prepare,
    exec: (sql) => raw.exec(sql),
    // نطاق معرّفات الجهاز (0 = الترقيم العادي، كما على الكمبيوتر)
    // (يُستدعى أيضًا بعد استبدال البيانات، فيُعاد حساب آخر معرّف)
    setIdBase(base) { state.base = Number(base) || 0; state.last = null; },
    // تشغيل دالة مع تسجيل الصفوف التي أنشأتها
    async capture(fn) {
      const prev = state.capture;
      const list = [];
      state.capture = list;
      try { const result = await fn(); return { result, created: list }; } finally { state.capture = prev; }
    },
  };
}

module.exports = { instrument, ID_TABLES };
