// منطق المنصة: الأشهر، البنود، التكرار، الديون، سجل التعديلات مع التراجع.
const { db, tx, getSetting } = require('./db');
const fx = require('./fx');
const Calc = require('../shared/calc');

const pad = (n) => String(n).padStart(2, '0');
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const currentYm = () => fx.today().slice(0, 7);
const LOCAL = Calc.LOCAL;

const q = {
  sections: db.prepare('SELECT * FROM sections ORDER BY sort, id'),
  templates: db.prepare('SELECT * FROM templates ORDER BY section_id, sort, id'),
  template: db.prepare('SELECT * FROM templates WHERE id=?'),
  monthByYm: db.prepare('SELECT * FROM months WHERE ym=?'),
  monthById: db.prepare('SELECT * FROM months WHERE id=?'),
  months: db.prepare('SELECT * FROM months ORDER BY ym DESC'),
  rate: db.prepare("SELECT * FROM month_rates WHERE month_id=? AND currency='USD'"),
  entries: db.prepare('SELECT * FROM entries WHERE month_id=? ORDER BY section_id, sort, id'),
  entry: db.prepare('SELECT * FROM entries WHERE id=?'),
  allEntries: db.prepare('SELECT * FROM entries'),
  allRates: db.prepare("SELECT * FROM month_rates WHERE currency='USD'"),
  series: db.prepare('SELECT * FROM series WHERE id=?'),
  periods: db.prepare('SELECT * FROM series_periods WHERE series_id=? ORDER BY from_ym, id'),
  sectionByKey: db.prepare('SELECT * FROM sections WHERE key=?'),
};
const sections = () => q.sections.all();
const templates = () => q.templates.all();

// ============ سجل التعديلات القابل للتراجع ============
// كل عملية تسجّل ما أنشأته وما عدّلته وما حذفته، فيمكن عكسها كاملة.
class Recorder {
  constructor() { this.created = []; this.updated = []; this.deleted = []; }
  create(tbl, id) { this.created.push({ tbl, id: Number(id) }); return Number(id); }
  update(tbl, row) { if (row && !this.updated.some((u) => u.tbl === tbl && u.row.id === row.id)) this.updated.push({ tbl, row }); }
  remove(tbl, row) { if (row) this.deleted.push({ tbl, row }); }
}
const insAudit = db.prepare('INSERT INTO audit_log (action, tbl, row_id, before, after, summary) VALUES (?,?,?,?,?,?)');
function track(summary, fn, tbl = 'batch') {
  return tx(() => {
    const rec = new Recorder();
    const result = fn(rec);
    const auditId = Number(insAudit.run('batch', tbl, null, JSON.stringify(rec), null, typeof summary === 'function' ? summary(result) : summary).lastInsertRowid);
    return { result, auditId };
  });
}
const PK = { month_rates: ['month_id', 'currency'] };
function restoreRow(tbl, row) {
  const pk = PK[tbl] || ['id'];
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${tbl} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
    ON CONFLICT(${pk.join(',')}) DO UPDATE SET ${cols.filter((c) => !pk.includes(c)).map((c) => `${c}=excluded.${c}`).join(', ')}`)
    .run(...cols.map((c) => row[c]));
}
function undo(auditId) {
  const a = db.prepare('SELECT * FROM audit_log WHERE id=?').get(auditId);
  if (!a || a.undone || a.action !== 'batch') throw new Error('لا يمكن التراجع عن هذا التعديل');
  const rec = JSON.parse(a.before);
  tx(() => {
    for (const c of [...rec.created].reverse()) {
      if (c.tbl === 'month_rates') db.prepare('DELETE FROM month_rates WHERE month_id=?').run(c.id);
      else db.prepare(`DELETE FROM ${c.tbl} WHERE id=?`).run(c.id);
    }
    // الحذف يُسجَّل من الفرع إلى الأصل، فيُستعاد بالعكس
    for (const d of [...rec.deleted].reverse()) restoreRow(d.tbl, d.row);
    // صفوف أُنشئت ثم عُدّلت في نفس العملية حُذفت أعلاه، فلا تُستعاد
    const born = new Set(rec.created.map((c) => c.tbl + ':' + c.id));
    for (const u of rec.updated) if (!born.has(u.tbl + ':' + u.row.id)) restoreRow(u.tbl, u.row);
    db.prepare('UPDATE audit_log SET undone=1 WHERE id=?').run(auditId);
    if (a.tbl === 'imports') db.prepare('UPDATE imports SET undone=1 WHERE id=?').run(a.row_id);
  });
}

// أدوات تعديل مسجّلة
function insertRow(rec, tbl, obj) {
  const cols = Object.keys(obj);
  const r = db.prepare(`INSERT INTO ${tbl} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => obj[c] ?? null));
  return rec.create(tbl, r.lastInsertRowid);
}
function updateRow(rec, tbl, id, patch) {
  const before = db.prepare(`SELECT * FROM ${tbl} WHERE id=?`).get(id);
  if (!before) return null;
  rec.update(tbl, before);
  const keys = Object.keys(patch);
  if (keys.length) db.prepare(`UPDATE ${tbl} SET ${keys.map((k) => k + '=?').join(', ')}${tbl === 'entries' ? ", updated_at=datetime('now')" : ''} WHERE id=?`)
    .run(...keys.map((k) => (patch[k] === '' || patch[k] === undefined ? null : patch[k])), id);
  return db.prepare(`SELECT * FROM ${tbl} WHERE id=?`).get(id);
}
function deleteRow(rec, tbl, id) {
  const before = db.prepare(`SELECT * FROM ${tbl} WHERE id=?`).get(id);
  if (!before) return;
  rec.remove(tbl, before);
  db.prepare(`DELETE FROM ${tbl} WHERE id=?`).run(id);
}

// ============ الأشهر ============
function monthDue(day, ym) {
  if (!day) return null;
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${pad(Math.min(day, new Date(y, m, 0).getDate()))}`;
}
function templateApplies(t, year, month) {
  const ym = `${year}-${pad(month)}`;
  if (t.start_ym && ym < t.start_ym) return false;
  if (t.recurrence === 'quarterly') return ((month - (t.due_month || 1)) % 3 + 3) % 3 === 0;
  if (t.recurrence === 'yearly') return month === (t.due_month || 1);
  if (t.recurrence === 'once') return t.start_ym === ym;
  return true;
}

// سعر الشهر قبل فتح المعاملة (يحتاج اتصالًا)
async function resolveMonthRate(ym, method, manual) {
  if (method === 'manual' || manual) return { rate: Number(manual), method: 'manual', source: 'يدوي', days: null, complete: true };
  const info = await fx.monthRate(ym, method || getSetting('default_method', 'avg'));
  if (!info || !info.rate) return { rate: null, method: method || 'avg', source: null, days: null, complete: false, unavailable: true };
  return { ...info, method: method || 'avg' };
}

// إنشاء شهر داخل عملية مسجّلة (السعر محسوب مسبقًا)
function createMonthSync(rec, ym, rateInfo, mode, skipSeriesId) {
  const existing = q.monthByYm.get(ym);
  if (existing) return existing;
  const [y, m] = ym.split('-').map(Number);
  const id = insertRow(rec, 'months', { ym, year: y, month: m });
  db.prepare(`INSERT INTO month_rates (month_id, currency, rate, method, source, days, locked, fetched_at) VALUES (?, 'USD', ?, ?, ?, ?, ?, ?)`)
    .run(id, rateInfo.rate, rateInfo.method, rateInfo.source, rateInfo.days, rateInfo.rate && (rateInfo.method === 'manual' || rateInfo.complete) ? 1 : 0, nowSql());
  rec.create('month_rates', id);
  fillMonth(rec, id, y, m, mode);
  applySeriesToMonth(rec, ym, skipSeriesId);
  return q.monthById.get(id);
}

async function createMonth(year, month, opts = {}) {
  const ym = `${year}-${pad(month)}`;
  const existing = q.monthByYm.get(ym);
  if (existing) return { month: existing, existed: true };
  const rateInfo = await resolveMonthRate(ym, opts.method, opts.rate);
  const { result, auditId } = track(`إنشاء شهر ${ym}`, (rec) => createMonthSync(rec, ym, rateInfo, opts.mode || 'templates'));
  return { month: result, existed: false, auditId, rateMissing: !rateInfo.rate };
}

function previousMonthWithData(ym) {
  return db.prepare('SELECT m.* FROM months m WHERE m.ym < ? AND EXISTS (SELECT 1 FROM entries e WHERE e.month_id=m.id) ORDER BY m.ym DESC LIMIT 1').get(ym);
}

function fillMonth(rec, monthId, year, month, mode) {
  if (mode === 'empty') return;
  const ym = `${year}-${pad(month)}`;
  const secs = Object.fromEntries(sections().map((s) => [s.id, s]));
  // البنود التي لها تكرار نشط يُنشئها محرك التكرار وليس القوالب
  const seriesTpl = new Set(db.prepare("SELECT template_id FROM series WHERE status='active' AND template_id IS NOT NULL").all().map((r) => r.template_id));
  if (mode === 'copy' || mode === 'copy_amounts') {
    const prev = previousMonthWithData(ym);
    if (prev) {
      for (const e of q.entries.all(prev.id)) {
        const s = secs[e.section_id];
        if (!s || s.key === 'variable' || s.key === 'debts' || e.series_id) continue;
        insertRow(rec, 'entries', { month_id: monthId, section_id: e.section_id, template_id: e.template_id, name: e.name, currency: e.currency,
          amount: mode === 'copy_amounts' ? e.amount : null, planned: e.amount ?? e.planned, status: 'unpaid', recurrence: e.recurrence, sort: e.sort });
      }
      return;
    }
  }
  for (const t of templates()) {
    const s = secs[t.section_id];
    if (!t.active || !s || !s.active || s.key === 'variable' || s.key === 'debts' || seriesTpl.has(t.id)) continue;
    if (!templateApplies(t, year, month)) continue;
    insertRow(rec, 'entries', { month_id: monthId, section_id: t.section_id, template_id: t.id, name: t.name, currency: t.currency,
      planned: t.planned_amount, status: 'unpaid', due_date: monthDue(t.due_day, ym), recurrence: t.recurrence, sort: t.sort });
  }
}

async function refreshOpenRate(month) {
  const r = q.rate.get(month.id);
  if (!r || r.locked || r.method === 'manual') return r;
  const age = r.fetched_at ? (Date.now() - new Date(r.fetched_at + 'Z').getTime()) / 36e5 : 999;
  if (age < 6 && r.rate) return r;
  const info = await fx.monthRate(month.ym, r.method);
  if (info && info.rate) {
    db.prepare("UPDATE month_rates SET rate=?, source=?, days=?, locked=?, fetched_at=? WHERE month_id=? AND currency='USD'")
      .run(info.rate, info.source, info.days, info.complete ? 1 : 0, nowSql(), month.id);
  } else {
    db.prepare("UPDATE month_rates SET fetched_at=? WHERE month_id=? AND currency='USD'").run(nowSql(), month.id);
  }
  return q.rate.get(month.id);
}

function seriesInfo(ids) {
  const out = {};
  for (const id of ids) {
    const s = q.series.get(id);
    if (s) out[id] = { ...s, periods: q.periods.all(id) };
  }
  return out;
}

async function getMonth(ym) {
  const m = q.monthByYm.get(ym);
  if (!m) return null;
  const rate = await refreshOpenRate(m);
  const entries = q.entries.all(m.id);
  const summary = Calc.summarize(entries, rate && rate.rate, sections());
  const prev = db.prepare('SELECT ym FROM months WHERE ym < ? ORDER BY ym DESC LIMIT 1').get(ym);
  const next = db.prepare('SELECT ym FROM months WHERE ym > ? ORDER BY ym ASC LIMIT 1').get(ym);
  const series = seriesInfo([...new Set(entries.map((e) => e.series_id).filter(Boolean))]);
  return { month: m, rate, entries, summary, series, prev: prev && prev.ym, next: next && next.ym };
}

function listMonths() {
  const secs = sections();
  const rates = Object.fromEntries(q.allRates.all().map((r) => [r.month_id, r]));
  const byMonth = {};
  for (const e of q.allEntries.all()) (byMonth[e.month_id] ||= []).push(e);
  return q.months.all().map((m) => {
    const r = rates[m.id];
    return { ...m, rate: r ? r.rate : null, rate_method: r && r.method, rate_locked: r && r.locked, summary: Calc.summarize(byMonth[m.id] || [], r && r.rate, secs) };
  });
}

function allData() {
  const rates = Object.fromEntries(q.allRates.all().map((r) => [r.month_id, r.rate]));
  return { months: q.months.all().map((m) => ({ ...m, rate: rates[m.id] || null })), entries: q.allEntries.all() };
}

async function setMonthRate(ym, { method, rate }) {
  const m = q.monthByYm.get(ym);
  if (!m) throw new Error('الشهر غير موجود');
  let info;
  if (method === 'manual') info = { rate: Number(rate), source: 'يدوي', days: null, complete: true };
  else {
    info = await fx.monthRate(ym, method);
    if (!info || !info.rate) throw new Error('لا يتوفر سعر تلقائي لهذا الشهر، أدخله يدويًا');
  }
  if (!(info.rate > 0)) throw new Error('سعر غير صالح');
  const before = q.rate.get(m.id);
  return track(`سعر ${ym}: ${before && before.rate ? before.rate : '—'} ← ${info.rate}`, (rec) => {
    rec.update('month_rates', before);
    db.prepare("UPDATE month_rates SET rate=?, method=?, source=?, days=?, locked=?, fetched_at=? WHERE month_id=? AND currency='USD'")
      .run(info.rate, method, info.source, info.days, method === 'manual' || info.complete ? 1 : 0, nowSql(), m.id);
    return q.rate.get(m.id);
  });
}

function deleteMonth(ym) {
  const m = q.monthByYm.get(ym);
  if (!m) return null;
  return track(`حذف شهر ${ym}`, (rec) => {
    for (const e of q.entries.all(m.id)) {
      unlinkDebtTxn(rec, e);
      rec.remove('entries', e);
    }
    rec.remove('month_rates', q.rate.get(m.id));
    rec.remove('months', m);
    db.prepare('DELETE FROM months WHERE id=?').run(m.id);
  });
}

// ============ البنود ============
const ENTRY_FIELDS = ['section_id', 'template_id', 'name', 'currency', 'amount', 'planned', 'paid_amount', 'status', 'one_off', 'person',
  'due_date', 'tx_date', 'fx_rate', 'fx_source', 'recurrence', 'note', 'sort', 'needs_review'];

async function txRatePatch(patch) {
  if (patch.tx_date) {
    const r = await fx.dayRate(patch.tx_date);
    patch.fx_rate = r ? r.rate : null;
    patch.fx_source = r && !r.stale ? `${r.source} ${r.date}` : fx.PENDING;
  } else if ('tx_date' in patch) {
    patch.tx_date = null; patch.fx_rate = null; patch.fx_source = null;
  }
}

async function updateEntry(id, patch) {
  const before = q.entry.get(id);
  if (!before) throw new Error('البند غير موجود');
  patch = Object.fromEntries(Object.entries(patch).filter(([k]) => ENTRY_FIELDS.includes(k) || k === 'fx_manual'));
  if ('tx_date' in patch && patch.tx_date !== before.tx_date) await txRatePatch(patch);
  if (patch.fx_manual) { patch.fx_rate = Number(patch.fx_manual); patch.fx_source = 'يدوي'; }
  delete patch.fx_manual;
  if (patch.status === 'paid' && before.amount == null && !('amount' in patch) && before.planned != null) patch.amount = before.planned;
  const debtRate = before.debt_id ? await rateForEntry({ ...before, ...patch }) : null;
  const m = q.monthById.get(before.month_id);
  const { result, auditId } = track(() => describe(before, { ...before, ...patch }, m.ym), (rec) => {
    // تعديل مبلغ بند متكرر من الخانة مباشرة = استثناء لهذا الشهر
    if ('amount' in patch && before.series_id && patch.amount !== before.amount) patch.series_override = 1;
    const after = updateRow(rec, 'entries', id, patch);
    // تذكّر العملة للأشهر القادمة، مع تحويل المبلغ المعتاد معها حتى لا يبقى رقمًا بعملة أخرى
    if ('currency' in patch && after.template_id && before.currency !== after.currency) {
      const t = q.template.get(after.template_id);
      rec.update('templates', t);
      const rate = before.fx_rate || (q.rate.get(before.month_id) || {}).rate;
      const planned = t.planned_amount == null ? null
        : t.currency === after.currency ? t.planned_amount
          : rate ? Calc.round2(Calc.convert(t.planned_amount, t.currency, after.currency, rate)) : after.amount;
      db.prepare('UPDATE templates SET currency=?, planned_amount=? WHERE id=?').run(after.currency, planned, after.template_id);
    }
    // يوم الاستحقاق المحدد في شهر يُحفظ للأشهر القادمة
    if ('due_date' in patch && after.template_id && after.due_date) {
      rec.update('templates', q.template.get(after.template_id));
      db.prepare('UPDATE templates SET due_day=? WHERE id=?').run(Number(after.due_date.slice(8, 10)), after.template_id);
    }
    syncDebtTxn(rec, after, debtRate);
    return q.entry.get(id);
  });
  return { entry: result, auditId };
}

function describe(b, a, ym) {
  const parts = [];
  if (b.amount !== a.amount) parts.push(`المبلغ ${b.amount ?? '—'} ← ${a.amount ?? '—'}`);
  if (b.status !== a.status) parts.push(`الحالة ${b.status} ← ${a.status}`);
  if (b.currency !== a.currency) parts.push(`العملة ${b.currency} ← ${a.currency}`);
  return `${a.name} (${ym})${parts.length ? ': ' + parts.join('، ') : ''}`;
}

async function createEntry(ym, data) {
  const m = q.monthByYm.get(ym);
  if (!m) throw new Error('الشهر غير موجود');
  const e = { currency: LOCAL, status: 'unpaid', recurrence: 'monthly', note: '', source: 'manual', ...data };
  if (e.tx_date) await txRatePatch(e);
  return track(`إضافة ${e.name} (${ym})`, (rec) => {
    const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 s FROM entries WHERE month_id=? AND section_id=?').get(m.id, e.section_id).s;
    const id = insertRow(rec, 'entries', { month_id: m.id, section_id: e.section_id, template_id: e.template_id || null, name: e.name,
      currency: e.currency, amount: e.amount ?? null, planned: e.planned ?? null, paid_amount: e.paid_amount ?? null, status: e.status,
      due_date: e.due_date || null, tx_date: e.tx_date || null, fx_rate: e.fx_rate || null, fx_source: e.fx_source || null,
      recurrence: e.recurrence, note: e.note || '', sort: e.sort ?? sort, source: e.source, debt_id: e.debt_id || null,
      one_off: e.one_off ? 1 : 0, person: e.person || null });
    return q.entry.get(id);
  });
}

function deleteEntry(id) {
  const e = q.entry.get(id);
  if (!e) return null;
  return track(`حذف ${e.name}`, (rec) => {
    unlinkDebtTxn(rec, e);
    deleteRow(rec, 'entries', id);
  });
}

function fillFromPrevious(ym) {
  const m = q.monthByYm.get(ym);
  const prev = previousMonthWithData(ym);
  if (!m || !prev) return { filled: 0 };
  const prevEntries = q.entries.all(prev.id);
  const { result, auditId } = track(`تعبئة ${ym} من ${prev.ym}`, (rec) => {
    let n = 0;
    for (const e of q.entries.all(m.id)) {
      if (e.amount != null || e.series_id) continue;
      const p = prevEntries.find((x) => (e.template_id && x.template_id === e.template_id) || x.name === e.name);
      if (p && p.amount != null) { updateRow(rec, 'entries', e.id, { amount: p.amount, currency: p.currency }); n++; }
    }
    return n;
  });
  return { filled: result, auditId };
}

// ============ التكرار الذكي ============
function periodFor(periods, ym) {
  return periods.find((p) => p.from_ym <= ym && (!p.to_ym || ym <= p.to_ym)) || null;
}
// الأشهر المشمولة: الفترات المفتوحة تمتد حتى الشهر الحالي
function seriesMonths(periods) {
  const out = [];
  for (const p of periods) {
    const end = p.to_ym || (currentYm() > p.from_ym ? currentYm() : p.from_ym);
    for (const ym of Calc.ymRange(p.from_ym, end)) if (!out.includes(ym)) out.push(ym);
  }
  return out.sort();
}
function validatePeriods(periods) {
  if (!periods.length) throw new Error('أضف فترة واحدة على الأقل');
  const sorted = [...periods].sort((a, b) => a.from_ym.localeCompare(b.from_ym));
  sorted.forEach((p, i) => {
    if (!/^\d{4}-\d{2}$/.test(p.from_ym) || (p.to_ym && !/^\d{4}-\d{2}$/.test(p.to_ym))) throw new Error('صيغة شهر غير صحيحة');
    if (p.to_ym && p.to_ym < p.from_ym) throw new Error(`الفترة ${i + 1}: النهاية قبل البداية`);
    if (!(Number(p.amount) > 0)) throw new Error(`الفترة ${i + 1}: المبلغ غير صالح`);
    const next = sorted[i + 1];
    if (next && (!p.to_ym || p.to_ym >= next.from_ym)) throw new Error(`الفترتان ${i + 1} و${i + 2} متداخلتان`);
  });
  return sorted;
}

// البند الموجود في الشهر الذي يمثل هذه السلسلة
function matchEntry(monthId, s) {
  return db.prepare('SELECT * FROM entries WHERE month_id=? AND series_id=? ORDER BY id LIMIT 1').get(monthId, s.id || -1)
    || (s.template_id && db.prepare('SELECT * FROM entries WHERE month_id=? AND template_id=? AND series_id IS NULL ORDER BY id LIMIT 1').get(monthId, s.template_id))
    || db.prepare('SELECT * FROM entries WHERE month_id=? AND section_id=? AND name=? AND series_id IS NULL ORDER BY id LIMIT 1').get(monthId, s.section_id, s.name)
    || null;
}

// معاينة: ماذا سيحدث لكل شهر. def = {id?, section_id, template_id, name, periods}
async function previewSeries(def) {
  const periods = validatePeriods(def.periods);
  const months = seriesMonths(periods);
  if (months.length > 240) throw new Error('الفترة طويلة جدًا (أكثر من 20 سنة)');
  const rates = {};
  await Promise.all(months.map(async (ym) => {
    const m = q.monthByYm.get(ym);
    const r = m && q.rate.get(m.id);
    if (r && r.rate) rates[ym] = r.rate;
    else { const info = await fx.monthRate(ym, 'avg'); rates[ym] = info && info.rate ? info.rate : null; }
  }));
  const rows = months.map((ym) => {
    const p = periodFor(periods, ym);
    const m = q.monthByYm.get(ym);
    const ex = m ? matchEntry(m.id, def) : null;
    let state = 'new';
    if (ex) {
      if (ex.series_override) state = 'override';
      else if (ex.amount == null) state = 'fill';
      else if (Number(ex.amount) === Number(p.amount) && ex.currency === p.currency) state = ex.series_id ? 'same' : 'exists';
      else state = ex.status === 'paid' && ex.series_id ? 'review' : 'conflict';
    }
    const rate = rates[ym];
    return { ym, amount: Number(p.amount), currency: p.currency, rate, usd: rate ? Calc.round2(Calc.toUsd(p.amount, p.currency, rate)) : null,
      local: rate || p.currency !== 'USD' ? Calc.round2(Calc.toLocal(p.amount, p.currency, rate)) : null,
      monthExists: !!m, state, existing: ex ? { id: ex.id, amount: ex.amount, currency: ex.currency, status: ex.status } : null };
  });
  return { rows, rates, months };
}

// تطبيق السلسلة على الأشهر داخل عملية مسجلة. opts: {pastPaid, conflicts:{ym:'keep'|'replace'}, rates}
function applySeries(rec, seriesId, opts = {}) {
  const s = q.series.get(seriesId);
  const periods = q.periods.all(seriesId);
  const months = s.status === 'active' ? seriesMonths(periods) : [];
  const cur = currentYm();
  let created = 0, updated = 0;
  for (const ym of months) {
    const p = periodFor(periods, ym);
    let m = q.monthByYm.get(ym);
    if (!m) {
      const rate = opts.rates && opts.rates[ym];
      m = createMonthSync(rec, ym, { rate: rate || null, method: rate ? 'avg' : 'manual', source: rate ? 'ECB' : null, days: null, complete: ym < cur }, ym >= cur ? 'templates' : 'empty', seriesId);
    }
    const ex = matchEntry(m.id, s);
    const due = monthDue(s.due_day, ym);
    if (!ex) {
      insertRow(rec, 'entries', { month_id: m.id, section_id: s.section_id, template_id: s.template_id, series_id: s.id, debt_id: s.debt_id,
        name: s.name, currency: p.currency, amount: p.amount, planned: p.amount, status: opts.pastPaid && ym < cur ? 'paid' : 'unpaid',
        due_date: due, recurrence: 'monthly', source: 'series', sort: 0 });
      created++;
      continue;
    }
    if (ex.series_override) continue;
    const same = ex.amount != null && Number(ex.amount) === Number(p.amount) && ex.currency === p.currency;
    if (!ex.series_id) {
      // بند موجود مسبقًا (مُستورد أو يدوي) يُربط بالسلسلة دون تغيير ما سُجّل فعلًا
      const decision = (opts.conflicts || {})[ym];
      if (same || ex.amount == null) updateRow(rec, 'entries', ex.id, { series_id: s.id, amount: ex.amount ?? p.amount, currency: ex.amount == null ? p.currency : ex.currency, planned: p.amount, due_date: ex.due_date || due });
      else if (decision === 'replace') updateRow(rec, 'entries', ex.id, { series_id: s.id, amount: p.amount, currency: p.currency, planned: p.amount, needs_review: 0 });
      else updateRow(rec, 'entries', ex.id, { series_id: s.id, series_override: 1, planned: p.amount });
      updated++;
      continue;
    }
    if (same) continue;
    if (ex.status === 'paid') updateRow(rec, 'entries', ex.id, { needs_review: 1, planned: p.amount });
    else updateRow(rec, 'entries', ex.id, { amount: p.amount, currency: p.currency, planned: p.amount, needs_review: 0 });
    updated++;
  }
  // بنود خارج الفترات: غير المدفوعة تُحذف، والمدفوعة تبقى للمراجعة
  let removed = 0;
  for (const e of db.prepare('SELECT e.*, m.ym FROM entries e JOIN months m ON m.id=e.month_id WHERE e.series_id=?').all(seriesId)) {
    if (months.includes(e.ym)) continue;
    const { ym, ...row } = e;
    if (row.status === 'paid' || row.series_override) updateRow(rec, 'entries', row.id, { needs_review: 1 });
    else { unlinkDebtTxn(rec, row); deleteRow(rec, 'entries', row.id); removed++; }
  }
  return { created, updated, removed };
}

// عند إنشاء أي شهر: السلاسل النشطة التي تشمله تضيف بنودها
function applySeriesToMonth(rec, ym, skipSeriesId) {
  const m = q.monthByYm.get(ym);
  for (const s of db.prepare("SELECT * FROM series WHERE status='active'").all()) {
    if (s.id === skipSeriesId) continue;
    const p = periodFor(q.periods.all(s.id), ym);
    if (!p) continue;
    if (matchEntry(m.id, s)) continue;
    insertRow(rec, 'entries', { month_id: m.id, section_id: s.section_id, template_id: s.template_id, series_id: s.id, debt_id: s.debt_id,
      name: s.name, currency: p.currency, amount: p.amount, planned: p.amount, status: 'unpaid', due_date: monthDue(s.due_day, ym),
      recurrence: 'monthly', source: 'series', sort: 0 });
  }
}

async function saveSeries(def, opts = {}) {
  const periods = validatePeriods(def.periods);
  const pv = await previewSeries({ ...def, periods });
  return track((r) => `${def.id ? 'تعديل' : 'إنشاء'} تكرار «${def.name}»: ${r.created} جديد، ${r.updated} محدّث`, (rec) => {
    let id = def.id;
    if (id) {
      updateRow(rec, 'series', id, { name: def.name, due_day: def.due_day || null, status: 'active' });
      for (const p of q.periods.all(id)) deleteRow(rec, 'series_periods', p.id);
    } else {
      id = insertRow(rec, 'series', { section_id: def.section_id, template_id: def.template_id || null, debt_id: def.debt_id || null, name: def.name, due_day: def.due_day || null });
    }
    for (const p of periods) insertRow(rec, 'series_periods', { series_id: id, from_ym: p.from_ym, to_ym: p.to_ym || null, amount: Number(p.amount), currency: p.currency || LOCAL });
    // لا تُنشأ بنود القالب العادية لاحقًا لنفس البند
    const res = applySeries(rec, id, { pastPaid: !!opts.pastPaid, conflicts: opts.conflicts, rates: pv.rates });
    return { id, ...res };
  });
}

// تعديل مبلغ من شهر معيّن: هذا الشهر فقط، أو حتى نهاية الفترة، أو حتى شهر محدد
async function editSeriesFrom(entryId, { amount, currency, scope, until }) {
  const e = q.entry.get(entryId);
  if (!e || !e.series_id) throw new Error('البند ليس متكررًا');
  const m = q.monthById.get(e.month_id);
  const ym = m.ym;
  amount = Number(amount);
  if (!(amount > 0)) throw new Error('المبلغ غير صالح');
  if (scope === 'one') return updateEntry(entryId, { amount, currency: currency || e.currency });
  const s = q.series.get(e.series_id);
  const periods = q.periods.all(s.id);
  const p = periodFor(periods, ym);
  if (!p) throw new Error('الشهر خارج فترات التكرار');
  const end = scope === 'until' ? until : p.to_ym;
  if (scope === 'until' && (!until || until < ym)) throw new Error('اختر شهر نهاية بعد هذا الشهر');
  const pv = await previewSeries({ ...s, periods: periods.map((x) => ({ ...x })) });
  return track(`تعديل «${s.name}» من ${ym}${end ? ' حتى ' + end : ''} إلى ${amount}`, (rec) => {
    // تقسيم الفترات: ما قبل الشهر يبقى، والجديد من الشهر حتى النهاية المختارة، وما بعدها يعود للمبلغ القديم
    const affected = periods.filter((x) => (!end || x.from_ym <= end) && (!x.to_ym || x.to_ym >= ym));
    for (const x of affected) {
      deleteRow(rec, 'series_periods', x.id);
      if (x.from_ym < ym) insertRow(rec, 'series_periods', { series_id: s.id, from_ym: x.from_ym, to_ym: Calc.shiftYm(ym, -1), amount: x.amount, currency: x.currency });
      if (end && (!x.to_ym || x.to_ym > end)) insertRow(rec, 'series_periods', { series_id: s.id, from_ym: Calc.shiftYm(end, 1) > x.from_ym ? Calc.shiftYm(end, 1) : x.from_ym, to_ym: x.to_ym, amount: x.amount, currency: x.currency });
    }
    insertRow(rec, 'series_periods', { series_id: s.id, from_ym: ym, to_ym: end || null, amount, currency: currency || p.currency });
    // الاستثناءات داخل النطاق الجديد تُلغى حتى تأخذ المبلغ الجديد
    for (const x of db.prepare('SELECT e.* FROM entries e JOIN months m ON m.id=e.month_id WHERE e.series_id=? AND e.series_override=1 AND m.ym>=? AND (? IS NULL OR m.ym<=?)').all(s.id, ym, end || null, end || null)) {
      if (x.status !== 'paid') updateRow(rec, 'entries', x.id, { series_override: 0 });
    }
    return applySeries(rec, s.id, { rates: pv.rates });
  });
}

// إلغاء استثناء شهر: يعود لمبلغ فترته (والمدفوع يُعلَّم للمراجعة بدل تعديله)
function resetOverride(entryId) {
  const e = q.entry.get(entryId);
  if (!e || !e.series_id) throw new Error('البند ليس متكررًا');
  return track(`إلغاء استثناء ${e.name}`, (rec) => {
    updateRow(rec, 'entries', e.id, { series_override: 0 });
    return applySeries(rec, e.series_id, {});
  });
}

function stopSeries(id, fromYm) {
  const s = q.series.get(id);
  if (!s) throw new Error('غير موجود');
  return track(`إيقاف «${s.name}» من ${fromYm}`, (rec) => {
    for (const p of q.periods.all(id)) {
      if (p.from_ym >= fromYm) deleteRow(rec, 'series_periods', p.id);
      else if (!p.to_ym || p.to_ym >= fromYm) updateRow(rec, 'series_periods', p.id, { to_ym: Calc.shiftYm(fromYm, -1) });
    }
    if (!q.periods.all(id).length) updateRow(rec, 'series', id, { status: 'stopped' });
    return applySeries(rec, id, {});
  });
}

function deleteSeries(id, { keepEntries } = {}) {
  const s = q.series.get(id);
  if (!s) return null;
  return track(`حذف تكرار «${s.name}»`, (rec) => {
    for (const e of db.prepare('SELECT * FROM entries WHERE series_id=?').all(id)) {
      if (keepEntries || e.status === 'paid') updateRow(rec, 'entries', e.id, { series_id: null, series_override: 0, needs_review: 0 });
      else { unlinkDebtTxn(rec, e); deleteRow(rec, 'entries', e.id); }
    }
    for (const p of q.periods.all(id)) deleteRow(rec, 'series_periods', p.id);
    deleteRow(rec, 'series', id);
  });
}

function confirmSeries(id, ymList) {
  const s = q.series.get(id);
  return track(`تأكيد دفعات «${s.name}»`, (rec) => {
    let n = 0;
    for (const e of db.prepare('SELECT e.*, m.ym FROM entries e JOIN months m ON m.id=e.month_id WHERE e.series_id=? AND e.status!=\'paid\'').all(id)) {
      if (ymList && !ymList.includes(e.ym)) continue;
      const { ym, ...row } = e;
      const after = updateRow(rec, 'entries', row.id, { status: 'paid', amount: row.amount ?? row.planned, needs_review: 0 });
      syncDebtTxn(rec, after, null);
      n++;
    }
    return n;
  });
}

function getSeries(id) {
  const s = q.series.get(id);
  if (!s) return null;
  const entries = db.prepare(`SELECT e.*, m.ym, r.rate AS month_rate FROM entries e JOIN months m ON m.id=e.month_id
    LEFT JOIN month_rates r ON r.month_id=m.id AND r.currency='USD' WHERE e.series_id=? ORDER BY m.ym`).all(id);
  return { series: s, periods: q.periods.all(id), entries };
}

function listSeries() {
  return db.prepare('SELECT * FROM series ORDER BY status, name').all().map((s) => {
    const periods = q.periods.all(s.id);
    const stats = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) paid, SUM(needs_review) review FROM entries WHERE series_id=?").get(s.id);
    return { ...s, periods, ...stats };
  });
}

// ============ الديون ============
async function rateForEntry(e) {
  const date = e.tx_date || e.due_date;
  if (date) { const r = await fx.dayRate(date); if (r) return r.rate; }
  const m = q.monthById.get(e.month_id);
  const r = m && q.rate.get(m.id);
  return r ? r.rate : null;
}

// بند مدفوع مرتبط بدين = حركة سداد. غير مدفوع = لا حركة.
function syncDebtTxn(rec, entry, rate) {
  if (!entry || !entry.debt_id) return;
  const txn = db.prepare('SELECT * FROM debt_txns WHERE entry_id=?').get(entry.id);
  const m = q.monthById.get(entry.month_id);
  const paidAmount = entry.status === 'paid' ? entry.amount : entry.status === 'partial' ? entry.paid_amount : null;
  if (paidAmount == null || !(paidAmount > 0)) { if (txn) deleteRow(rec, 'debt_txns', txn.id); return; }
  const date = entry.tx_date || entry.due_date || (m.ym === currentYm() ? fx.today() : `${m.ym}-01`);
  const r = rate || (txn && txn.fx_rate) || (q.rate.get(m.id) || {}).rate || null;
  if (txn) updateRow(rec, 'debt_txns', txn.id, { amount: paidAmount, currency: entry.currency, date, fx_rate: r });
  else insertRow(rec, 'debt_txns', { debt_id: entry.debt_id, kind: 'payment', amount: paidAmount, currency: entry.currency, date, fx_rate: r, entry_id: entry.id, note: 'من صفحة الشهر' });
  settleCheck(rec, entry.debt_id);
}
function unlinkDebtTxn(rec, entry) {
  if (!entry || !entry.debt_id) return;
  const txn = db.prepare('SELECT * FROM debt_txns WHERE entry_id=?').get(entry.id);
  if (txn) deleteRow(rec, 'debt_txns', txn.id);
}
function settleCheck(rec, debtId) {
  const d = db.prepare('SELECT * FROM debts WHERE id=?').get(debtId);
  const b = Calc.debtBalance(d, db.prepare('SELECT * FROM debt_txns WHERE debt_id=?').all(debtId));
  const status = b.remaining <= 0.009 ? 'settled' : 'active';
  if (d.status !== status) updateRow(rec, 'debts', debtId, { status });
}

function partyId(rec, name, color) {
  const n = String(name || '').trim();
  if (!n) throw new Error('أدخل اسم الطرف');
  const p = db.prepare('SELECT * FROM parties WHERE name=?').get(n);
  if (p) return p.id;
  const colors = ['#c2255c', '#1971c2', '#e67700', '#0f9d6b', '#7048e8', '#0c8599', '#d6336c', '#5c940d'];
  return insertRow(rec, 'parties', { name: n, color: color || colors[db.prepare('SELECT COUNT(*) c FROM parties').get().c % colors.length] });
}

// body: {direction, party, currency, amount, date, title, note, plan, installment:{amount,currency,due_day,from_ym}, due_date, count_in_expenses, fx_manual}
async function createDebt(b) {
  const amount = Number(b.amount);
  if (!(amount > 0)) throw new Error('أدخل مبلغ الدين');
  const date = b.date || fx.today();
  const r = b.fx_manual ? { rate: Number(b.fx_manual), source: 'يدوي' } : await fx.dayRate(date);
  let inst = null;
  if (b.plan === 'installments') {
    const ia = Number(b.installment && b.installment.amount);
    if (!(ia > 0)) throw new Error('أدخل مبلغ القسط');
    const icur = b.installment.currency || b.currency;
    const principalInInst = Calc.convert(amount, b.currency, icur, r && r.rate);
    if (!principalInInst) throw new Error('يلزم سعر صرف لتحويل القسط، أدخله يدويًا');
    const n = Math.ceil(principalInInst / ia - 1e-9);
    const from = b.installment.from_ym || Calc.shiftYm(date.slice(0, 7), 1);
    inst = { amount: ia, currency: icur, due_day: b.installment.due_day || null, from, to: Calc.shiftYm(from, n - 1), n };
  }
  const pv = inst ? await previewSeries({ section_id: 0, name: '', periods: [{ from_ym: inst.from, to_ym: inst.to, amount: inst.amount, currency: inst.currency }] }) : null;
  return track(`دين جديد: ${b.direction === 'owe' ? 'عليّ لـ' : 'لي عند'} ${b.party} ${amount} ${b.currency}`, (rec) => {
    const pid = partyId(rec, b.party);
    const id = insertRow(rec, 'debts', { party_id: pid, direction: b.direction, currency: b.currency || LOCAL, title: b.title || '',
      plan: b.plan || 'none', due_date: b.due_date || null, count_in_expenses: b.count_in_expenses === false ? 0 : 1, note: b.note || '', import_id: b.import_id || null });
    insertRow(rec, 'debt_txns', { debt_id: id, kind: 'start', amount, currency: b.currency || LOCAL, date, fx_rate: r ? r.rate : null, fx_source: r ? r.source : null, note: b.note || '', import_id: b.import_id || null });
    if (inst && b.direction === 'owe') {
      const party = db.prepare('SELECT name FROM parties WHERE id=?').get(pid).name;
      const sid = insertRow(rec, 'series', { section_id: q.sectionByKey.get('debts').id, debt_id: id, name: `قسط ${party}`, due_day: inst.due_day });
      insertRow(rec, 'series_periods', { series_id: sid, from_ym: inst.from, to_ym: inst.to, amount: inst.amount, currency: inst.currency });
      applySeries(rec, sid, { rates: pv.rates });
    }
    return id;
  });
}

// حركة على دين: سداد أو زيادة. السداد يُحسب ضمن مصاريف شهره إن طُلب.
async function addDebtTxn(debtId, b) {
  const d = db.prepare('SELECT d.*, p.name party FROM debts d JOIN parties p ON p.id=d.party_id WHERE d.id=?').get(debtId);
  if (!d) throw new Error('الدين غير موجود');
  const amount = Number(b.amount);
  if (!(amount > 0)) throw new Error('المبلغ غير صالح');
  const date = b.date || fx.today();
  const r = b.fx_manual ? { rate: Number(b.fx_manual), source: 'يدوي' } : await fx.dayRate(date);
  const ym = date.slice(0, 7);
  const countIt = b.kind === 'payment' && d.direction === 'owe' && (b.count_in_expenses ?? d.count_in_expenses);
  let monthRate = null;
  if (countIt && !q.monthByYm.get(ym)) monthRate = await resolveMonthRate(ym);
  return track(`${b.kind === 'payment' ? (d.direction === 'owe' ? 'سداد لـ' : 'استلام من') : 'زيادة دين'} ${d.party}: ${amount} ${b.currency}`, (rec) => {
    if (countIt) {
      const m = q.monthByYm.get(ym) || createMonthSync(rec, ym, monthRate, ym >= currentYm() ? 'templates' : 'empty');
      // إن كان في الشهر قسط مستحق لهذا الدين، يُؤكَّد بدل إضافة سطر جديد
      const inst = db.prepare("SELECT * FROM entries WHERE month_id=? AND debt_id=? AND series_id IS NOT NULL AND status!='paid' ORDER BY id LIMIT 1").get(m.id, debtId);
      if (inst && !b.separate) {
        const after = updateRow(rec, 'entries', inst.id, { amount, currency: b.currency, status: 'paid', tx_date: date, fx_rate: r ? r.rate : null, fx_source: r ? r.source : null, series_override: Number(inst.amount) === amount && inst.currency === b.currency ? inst.series_override : 1 });
        syncDebtTxn(rec, after, r && r.rate);
        return after.id;
      }
      const eid = insertRow(rec, 'entries', { month_id: m.id, section_id: q.sectionByKey.get('debts').id, debt_id: debtId, name: `سداد لـ ${d.party}`,
        currency: b.currency, amount, status: 'paid', tx_date: date, fx_rate: r ? r.rate : null, fx_source: r ? r.source : null, recurrence: 'once', source: 'debt', note: b.note || '' });
      syncDebtTxn(rec, q.entry.get(eid), r && r.rate);
      return eid;
    }
    insertRow(rec, 'debt_txns', { debt_id: debtId, kind: b.kind, amount, currency: b.currency, date, fx_rate: r ? r.rate : null, fx_source: r ? r.source : null, note: b.note || '', import_id: b.import_id || null });
    settleCheck(rec, debtId);
    return null;
  });
}

function deleteDebtTxn(txnId) {
  const t = db.prepare('SELECT * FROM debt_txns WHERE id=?').get(txnId);
  if (!t) return null;
  return track('حذف حركة دين', (rec) => {
    if (t.entry_id) {
      const e = q.entry.get(t.entry_id);
      if (e && e.series_id) updateRow(rec, 'entries', e.id, { status: 'unpaid', tx_date: null, fx_rate: null, fx_source: null });
      else if (e) deleteRow(rec, 'entries', e.id);
    }
    deleteRow(rec, 'debt_txns', t.id);
    settleCheck(rec, t.debt_id);
  });
}

function deleteDebt(id) {
  const d = db.prepare('SELECT * FROM debts WHERE id=?').get(id);
  if (!d) return null;
  return track('حذف دين', (rec) => {
    for (const s of db.prepare('SELECT * FROM series WHERE debt_id=?').all(id)) {
      for (const e of db.prepare('SELECT * FROM entries WHERE series_id=?').all(s.id)) {
        if (e.status === 'paid') updateRow(rec, 'entries', e.id, { series_id: null, debt_id: null });
        else deleteRow(rec, 'entries', e.id);
      }
      for (const p of q.periods.all(s.id)) deleteRow(rec, 'series_periods', p.id);
      deleteRow(rec, 'series', s.id);
    }
    for (const e of db.prepare('SELECT * FROM entries WHERE debt_id=?').all(id)) updateRow(rec, 'entries', e.id, { debt_id: null });
    for (const t of db.prepare('SELECT * FROM debt_txns WHERE debt_id=?').all(id)) deleteRow(rec, 'debt_txns', t.id);
    deleteRow(rec, 'debts', id);
  });
}

function debtView(d) {
  const txns = db.prepare('SELECT * FROM debt_txns WHERE debt_id=? ORDER BY date, id').all(d.id);
  const bal = Calc.debtBalance(d, txns);
  const s = db.prepare('SELECT * FROM series WHERE debt_id=?').get(d.id);
  const next = db.prepare(`SELECT e.*, m.ym FROM entries e JOIN months m ON m.id=e.month_id WHERE e.debt_id=? AND e.series_id IS NOT NULL AND e.status!='paid'
    ORDER BY m.ym LIMIT 1`).get(d.id);
  const instLeft = s ? db.prepare("SELECT COUNT(*) c FROM entries WHERE series_id=? AND status!='paid'").get(s.id).c : null;
  const nextDue = next ? (next.due_date || `${next.ym}-28`) : d.due_date;
  return { ...d, txns, ...bal, series: s ? { ...s, periods: q.periods.all(s.id) } : null, next: next || null, nextDue,
    installmentsLeft: instLeft, late: !!(nextDue && nextDue < fx.today() && d.status === 'active') };
}
function listDebts() {
  return db.prepare('SELECT d.*, p.name party, p.color FROM debts d JOIN parties p ON p.id=d.party_id ORDER BY d.status, d.created_at DESC').all().map(debtView);
}
function getDebt(id) {
  const d = db.prepare('SELECT d.*, p.name party, p.color FROM debts d JOIN parties p ON p.id=d.party_id WHERE d.id=?').get(id);
  return d ? debtView(d) : null;
}
async function updateDebt(id, b) {
  const d = db.prepare('SELECT * FROM debts WHERE id=?').get(id);
  return track('تعديل دين', (rec) => {
    const patch = {};
    for (const k of ['title', 'note', 'due_date', 'count_in_expenses', 'status']) if (k in b) patch[k] = b[k];
    if (b.party) patch.party_id = partyId(rec, b.party);
    updateRow(rec, 'debts', d.id, patch);
  });
}

// ============ الإضافة السريعة ============
// body: {template_id | debt_id | new:{name, section_id}, amount, currency, date, status, mode, keepDate, paid_amount, category}
async function quickAdd(body) {
  const date = body.date || fx.today();
  const ym = date.slice(0, 7);
  const amount = Number(body.amount);
  if (!(amount > 0)) throw new Error('المبلغ غير صالح');
  const currency = body.currency || LOCAL;
  if (body.debt_id) {
    const r = await addDebtTxn(body.debt_id, { kind: 'payment', amount, currency, date, count_in_expenses: body.count_in_expenses });
    return { ...r, ym };
  }
  if (!q.monthByYm.get(ym)) await createMonth(Number(ym.slice(0, 4)), Number(ym.slice(5)), { mode: ym < currentYm() ? 'empty' : 'templates' });
  const month = q.monthByYm.get(ym);
  const status = body.status || 'paid';
  const useDate = date !== fx.today() || body.keepDate;
  const dayR = useDate ? await fx.dayRate(date) : null;
  const tpl = body.template_id ? q.template.get(body.template_id) : null;
  const sec = tpl ? db.prepare('SELECT * FROM sections WHERE id=?').get(tpl.section_id) : null;
  const isVariable = body.new || (sec && sec.key === 'variable');

  if (isVariable) {
    const varSec = q.sectionByKey.get('variable');
    const r = await createEntry(ym, { section_id: body.new ? (body.new.section_id || varSec.id) : tpl.section_id, name: body.new ? body.new.name : tpl.name,
      currency, amount, status, paid_amount: status === 'partial' ? Number(body.paid_amount || 0) : null, tx_date: date, recurrence: 'once',
      note: body.new ? (body.category || '') : tpl.name, source: 'quick', one_off: body.one_off ? 1 : 0, person: body.person || null });
    return { entry: r.result, auditId: r.auditId, ym };
  }
  const target = db.prepare('SELECT * FROM entries WHERE month_id=? AND template_id=? ORDER BY id LIMIT 1').get(month.id, tpl.id)
    || db.prepare("SELECT e.* FROM entries e JOIN series s ON s.id=e.series_id WHERE e.month_id=? AND s.template_id=? LIMIT 1").get(month.id, tpl.id);
  if (!target) {
    const r = await createEntry(ym, { section_id: tpl.section_id, template_id: tpl.id, name: tpl.name, currency, amount, planned: tpl.planned_amount,
      status, tx_date: useDate ? date : null, paid_amount: status === 'partial' ? Number(body.paid_amount || 0) : null, source: 'quick' });
    return { entry: r.result, auditId: r.auditId, ym };
  }
  let newAmount = amount, newCurrency = currency;
  if (body.mode === 'add' && target.amount != null) {
    const rate = (q.rate.get(month.id) || {}).rate;
    newCurrency = target.currency;
    newAmount = Calc.round2(Number(target.amount) + Calc.convert(amount, currency, target.currency, rate));
  }
  const patch = { amount: newAmount, currency: newCurrency, status };
  if (status === 'partial') patch.paid_amount = Number(body.paid_amount || amount);
  if (useDate) { patch.tx_date = date; patch.fx_rate = dayR ? dayR.rate : null; patch.fx_source = dayR && !dayR.stale ? dayR.source : fx.PENDING; }
  // تأكيد دفعة متكررة بنفس مبلغها لا يجعلها استثناء
  const keepSeries = target.series_id && newAmount === Number(target.amount) && newCurrency === target.currency;
  const before = target;
  const res = track(`إضافة سريعة: ${target.name} ${amount} ${currency} (${ym})`, (rec) => {
    if (target.series_id && !keepSeries) patch.series_override = 1;
    const after = updateRow(rec, 'entries', target.id, patch);
    syncDebtTxn(rec, after, dayR && dayR.rate);
    return after;
  });
  return { entry: res.result, before, auditId: res.auditId, ym };
}

// إكمال أسعار العمليات المعلّقة عند توفر الاتصال (دون سجل تعديلات: هو تصحيح سعر لا تعديل من المستخدم)
async function fillPendingRates() {
  const list = db.prepare('SELECT id, tx_date FROM entries WHERE fx_source=? AND tx_date IS NOT NULL').all(fx.PENDING);
  let filled = 0;
  for (const e of list) {
    const r = await fx.dayRate(e.tx_date);
    if (!r || r.stale) break;
    db.prepare('UPDATE entries SET fx_rate=?, fx_source=? WHERE id=?').run(r.rate, `${r.source} ${r.date}`, e.id);
    filled++;
  }
  return { pending: list.length - filled, filled };
}

function audit(summary) { insAudit.run('note', 'note', null, null, null, summary); }

module.exports = {
  q, sections, templates, track, undo, insertRow, updateRow, deleteRow, createMonth, createMonthSync, resolveMonthRate, getMonth, listMonths, allData,
  setMonthRate, deleteMonth, updateEntry, createEntry, deleteEntry, fillFromPrevious, previewSeries, saveSeries, editSeriesFrom, stopSeries,
  deleteSeries, confirmSeries, getSeries, resetOverride, listSeries, applySeries, createDebt, addDebtTxn, deleteDebtTxn, deleteDebt, listDebts, getDebt,
  updateDebt, partyId, quickAdd, fillPendingRates, audit, matchEntry, periodFor, currentYm, monthDue,
};
