// بنية قاعدة البيانات وترقياتها وبياناتها الأولية.
// مشتركة بين المنصة على الكمبيوتر (node:sqlite) والتطبيق على الهاتف (SQLite WASM).
let localFixes = null;
try { localFixes = require('./local-fixes'); } catch { /* غير موجود في النسخة العامة */ }

const SEED_SECTIONS = [
  { key: 'income', name: 'الدخل', kind: 'income', color: '#0f9d6b', icon: '💼', sort: 1 },
  { key: 'basic', name: 'المصاريف الأساسية', kind: 'expense', color: '#e8590c', icon: '🏠', sort: 2 },
  { key: 'subs', name: 'الاشتراكات', kind: 'expense', color: '#7048e8', icon: '↻', sort: 3 },
  { key: 'variable', name: 'مصاريف متغيرة', kind: 'expense', color: '#1c7ed6', icon: '✦', sort: 4 },
];
// فئات المصاريف المتغيرة: [اسم، أسماء بديلة، أيقونة، لمرة واحدة افتراضيًا]
const VARIABLE_CATEGORIES = [
  ['أكل وأغراض البيت', 'سوق,بقالة,خبز,اكل البيت,أكل البيت,اغراض,أغراض,تسوق,مستلزمات,مشتريات,قهوة', '🛒', 0],
  ['أكل خارجي', 'طعام خارجي,مطعم,اكل خارجي,توصيل,كافيه,بيتزا', '🍽', 0],
  ['مصروف شخصي', 'شخصي,ارجيلة,أرجيلة,معسل,فحم,دخان', '🎯', 0],
  ['مصروف الزوجة', 'زوجتي,الزوجة,مصروف زوجتي', '💐', 0],
  ['الأطفال', 'اطفال,أطفال,الولد,ولادي,العاب,ألعاب,مدرسة,حفاضات', '🧸', 0],
  ['مواصلات', 'مواصلات,بنزين,تاكسي,باص,مترو', '🚗', 0],
  ['صحة', 'صحة,دواء,طبيب,صيدلية', '💊', 0],
  ['صيانة البيت', 'منزل,صيانة,بيت,فلتر,تصليح,عاملة الدرج,درج,تنظيف', '🔧', 0],
  ['العائلة والأهل', 'اهلي,أهلي,امي,أمي,حوالة,تحويل للاهل,مساعدة', '👨‍👩‍👧', 1],
  ['هدايا ومناسبات', 'هدية,هدايا,مناسبة,عيدية,عيد ميلاد', '🎁', 1],
];

function setup(db, { beforeUpgrade } = {}) {
  const MIGRATIONS = [
    // 1: البنية الأولى
    `
    CREATE TABLE sections (
      id INTEGER PRIMARY KEY, key TEXT UNIQUE, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
      color TEXT NOT NULL DEFAULT '#3b5bdb', icon TEXT NOT NULL DEFAULT '•',
      sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE templates (
      id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL REFERENCES sections(id),
      name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'TRY', planned_amount REAL,
      recurrence TEXT NOT NULL DEFAULT 'monthly' CHECK (recurrence IN ('monthly','quarterly','yearly','once')),
      due_day INTEGER, due_month INTEGER, start_ym TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE months (
      id INTEGER PRIMARY KEY, ym TEXT NOT NULL UNIQUE, year INTEGER NOT NULL, month INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE month_rates (
      month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE, currency TEXT NOT NULL DEFAULT 'USD', rate REAL,
      method TEXT NOT NULL DEFAULT 'avg' CHECK (method IN ('avg','end','manual')), source TEXT, days INTEGER,
      locked INTEGER NOT NULL DEFAULT 0, fetched_at TEXT, PRIMARY KEY (month_id, currency)
    );
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY, month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
      section_id INTEGER NOT NULL REFERENCES sections(id), template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
      name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'TRY', amount REAL, planned REAL, paid_amount REAL,
      status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('paid','partial','unpaid')),
      due_date TEXT, tx_date TEXT, fx_rate REAL, fx_source TEXT, recurrence TEXT NOT NULL DEFAULT 'monthly',
      note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_entries_month ON entries(month_id);
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '🎯', target REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD', deadline TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE goal_contribs (
      id INTEGER PRIMARY KEY, goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE, amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'TRY', fx_rate REAL, date TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now','localtime')), action TEXT NOT NULL, tbl TEXT NOT NULL,
      row_id INTEGER, before TEXT, after TEXT, summary TEXT NOT NULL DEFAULT '', undone INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE fx_cache (date TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', rate REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY (date, currency));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    `,
    // 2: محرك التكرار بالفترات، والتراجع الشامل، والاستيراد الذكي
    `
    ALTER TABLE templates ADD COLUMN catalog TEXT;
    ALTER TABLE months ADD COLUMN import_id INTEGER;
    CREATE TABLE series (
      id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL REFERENCES sections(id),
      template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL, debt_id INTEGER,
      name TEXT NOT NULL, due_day INTEGER, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE series_periods (
      id INTEGER PRIMARY KEY, series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      from_ym TEXT NOT NULL, to_ym TEXT, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'TRY'
    );
    ALTER TABLE entries ADD COLUMN series_id INTEGER REFERENCES series(id) ON DELETE SET NULL;
    ALTER TABLE entries ADD COLUMN series_override INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE entries ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE entries ADD COLUMN debt_id INTEGER;
    ALTER TABLE entries ADD COLUMN import_id INTEGER;
    ALTER TABLE entries ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
    CREATE INDEX idx_entries_series ON entries(series_id);
    CREATE TABLE parties (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '#c2255c', note TEXT NOT NULL DEFAULT '');
    CREATE TABLE debts (
      id INTEGER PRIMARY KEY, party_id INTEGER NOT NULL REFERENCES parties(id), direction TEXT NOT NULL CHECK (direction IN ('owe','owed')),
      currency TEXT NOT NULL DEFAULT 'TRY', title TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'none' CHECK (plan IN ('once','installments','none')),
      due_date TEXT, count_in_expenses INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', note TEXT NOT NULL DEFAULT '', import_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE debt_txns (
      id INTEGER PRIMARY KEY, debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('start','increase','payment')), amount REAL NOT NULL, currency TEXT NOT NULL, date TEXT NOT NULL,
      fx_rate REAL, fx_source TEXT, entry_id INTEGER, import_id INTEGER, note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE imports (
      id INTEGER PRIMARY KEY, file_name TEXT NOT NULL, stored_as TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      undone INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    INSERT OR IGNORE INTO settings (key,value) VALUES ('onboarded','1'), ('user_name',''), ('base_currency','TRY'), ('variable_budget','');
    `,
  ];

  function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function migrate() {
    db.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY)');
    const done = new Set(db.prepare('SELECT id FROM _migrations').all().map((r) => r.id));
    const pending = MIGRATIONS.map((sql, i) => [i + 1, sql]).filter(([id]) => !done.has(id));
    if (!pending.length) return;
    // نسخة احتياطية قبل ترقية قاعدة بيانات فيها بيانات
    if (done.size && beforeUpgrade) beforeUpgrade();
    for (const [id, step] of pending) tx(() => { typeof step === 'function' ? step() : db.exec(step); db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(id); });
  }

  // 3: تصحيح البيانات الموجودة: فئات المصاريف المتغيرة، العملة المعتادة، أيام الاستحقاق
  MIGRATIONS.push(() => {
    const varSec = db.prepare("SELECT id FROM sections WHERE key='variable'").get();
    if (varSec) {
      const rename = { 'سوق': 'أكل وأغراض البيت', 'منزل': 'صيانة البيت' };
      for (const [from, to] of Object.entries(rename)) {
        if (!db.prepare('SELECT 1 FROM templates WHERE section_id=? AND name=?').get(varSec.id, to)) {
          db.prepare('UPDATE templates SET name=? WHERE section_id=? AND name=?').run(to, varSec.id, from);
        }
      }
      VARIABLE_CATEGORIES.forEach(([name, aliases, icon], i) => {
        const t = db.prepare('SELECT id FROM templates WHERE section_id=? AND name=?').get(varSec.id, name);
        if (t) db.prepare('UPDATE templates SET aliases=?, icon=?, sort=? WHERE id=?').run(aliases, icon, i + 1, t.id);
        else db.prepare('INSERT INTO templates (section_id,name,aliases,icon,sort,active) VALUES (?,?,?,?,?,0)').run(varSec.id, name, aliases, icon, i + 1);
      });
      // إعادة تصنيف العمليات حسب وصفها
      const cats = db.prepare('SELECT name, aliases FROM templates WHERE section_id=?').all(varSec.id);
      const norm = (s) => String(s || '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();
      for (const e of db.prepare('SELECT id, name, note FROM entries WHERE section_id=?').all(varSec.id)) {
        const n = norm(e.name);
        let best = null, len = 0;
        for (const c of cats) for (const a of [c.name, ...c.aliases.split(',')].map(norm).filter(Boolean)) {
          if (a.length > len && (n === a || n.includes(a))) { best = c.name; len = a.length; }
        }
        if (best && best !== e.note) db.prepare('UPDATE entries SET note=? WHERE id=?').run(best, e.id);
      }
    }
    // المبلغ المعتاد بقي بعملة قديمة بعد تغيير عملة البند: يأخذ آخر مبلغ فعلي بنفس العملة
    for (const t of db.prepare('SELECT * FROM templates WHERE planned_amount IS NOT NULL').all()) {
      const last = db.prepare(`SELECT e.amount, e.currency FROM entries e JOIN months m ON m.id=e.month_id
        WHERE e.template_id=? AND e.amount IS NOT NULL ORDER BY m.ym DESC LIMIT 1`).get(t.id);
      if (last && last.currency === t.currency && last.amount > 0) {
        const ratio = t.planned_amount / last.amount;
        if (ratio > 8 || ratio < 1 / 8) db.prepare('UPDATE templates SET planned_amount=? WHERE id=?').run(last.amount, t.id);
      }
    }
    // أيام الاستحقاق المحددة في شهر تُحفظ للأشهر القادمة
    for (const r of db.prepare(`SELECT e.template_id, e.due_date FROM entries e JOIN months m ON m.id=e.month_id
      WHERE e.template_id IS NOT NULL AND e.due_date IS NOT NULL ORDER BY m.ym`).all()) {
      db.prepare('UPDATE templates SET due_day=? WHERE id=? AND due_day IS NULL').run(Number(r.due_date.slice(8, 10)), r.template_id);
    }
  });

  // 4: «لمرة واحدة» و«لمن؟» على العمليات، وميزانية لكل فئة، وفئات العائلة والأطفال والهدايا
  MIGRATIONS.push(() => {
    db.exec(`
      ALTER TABLE entries ADD COLUMN one_off INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE entries ADD COLUMN person TEXT;
      ALTER TABLE templates ADD COLUMN budget REAL;
      ALTER TABLE templates ADD COLUMN one_off_default INTEGER NOT NULL DEFAULT 0;
      INSERT OR IGNORE INTO settings (key,value) VALUES ('people', '[]');
    `);
    const varSec = db.prepare("SELECT id FROM sections WHERE key='variable'").get();
    if (!varSec) return;
    VARIABLE_CATEGORIES.forEach(([name, aliases, icon, oneOff], i) => {
      const t = db.prepare('SELECT id, aliases FROM templates WHERE section_id=? AND name=?').get(varSec.id, name);
      if (t) {
        // دمج الأسماء البديلة الجديدة مع ما أضافه المستخدم
        const merged = [...new Set([...t.aliases.split(','), ...aliases.split(',')].map((a) => a.trim()).filter(Boolean))].join(',');
        db.prepare('UPDATE templates SET aliases=?, one_off_default=?, sort=? WHERE id=?').run(merged, oneOff ? 1 : 0, i + 1, t.id);
      } else {
        db.prepare('INSERT INTO templates (section_id,name,aliases,icon,sort,active,one_off_default) VALUES (?,?,?,?,?,0,?)').run(varSec.id, name, aliases, icon, i + 1, oneOff ? 1 : 0);
      }
    });
    // تصحيح تصنيف عمليات الهدايا
    const fix = [[['هدية', 'هديه', 'هدايا'], 'هدايا ومناسبات', 1, null]];
    for (const e of db.prepare('SELECT id, name FROM entries WHERE section_id=?').all(varSec.id)) {
      const words = e.name.split(/[\s،,]+/).filter(Boolean);
      for (const [list, cat, oneOff, person] of fix) {
        if (words.some((w) => list.includes(w))) { db.prepare('UPDATE entries SET note=?, one_off=?, person=COALESCE(person, ?) WHERE id=?').run(cat, oneOff, person, e.id); break; }
      }
    }
    // تصحيحات خاصة بأسماء أفراد العائلة (ملف محلي غير مرفوع)
    if (localFixes && localFixes.migration4) localFixes.migration4(db, varSec);
  });

  function seed() {
    if (db.prepare('SELECT COUNT(*) c FROM sections').get().c) return;
    tx(() => {
      const insS = db.prepare('INSERT INTO sections (key,name,kind,color,icon,sort) VALUES (?,?,?,?,?,?)');
      const insT = db.prepare('INSERT INTO templates (section_id,name,aliases,icon,sort,active,one_off_default) VALUES (?,?,?,?,?,0,?)');
      for (const s of SEED_SECTIONS) {
        const id = Number(insS.run(s.key, s.name, s.kind, s.color, s.icon, s.sort).lastInsertRowid);
        if (s.key === 'variable') VARIABLE_CATEGORIES.forEach((c, i) => insT.run(id, c[0], c[1], c[2], i + 1, c[3]));
      }
      const set = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
      for (const [k, v] of [['default_method', 'avg'], ['lan_enabled', '0'], ['pin', ''], ['port', '4600']]) set.run(k, v);
    });
  }

  function getSetting(key, def = null) {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r ? r.value : def;
  }
  function setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
  }

  migrate();
  seed();
  return { tx, getSetting, setSetting, SCHEMA_VERSION: MIGRATIONS.length };
}

module.exports = { setup, VARIABLE_CATEGORIES, SEED_SECTIONS };
