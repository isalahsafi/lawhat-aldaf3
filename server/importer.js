// الاستيراد الذكي من Excel: تحليل ← معاينة ← اعتماد.
// يتعرف على نوع كل ورقة (جدول أشهر، عمليات، ديون) وأعمدتها، ويمنع التكرار، ولا يقرر شيئًا ماليًا غامضًا دون المستخدم.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { db, DATA_DIR } = require('./db');
const core = require('./core');
const fx = require('./fx');
const Calc = require('../shared/calc');

const LOCAL = Calc.LOCAL;
const pad = (n) => String(n).padStart(2, '0');
const sessions = new Map(); // token -> {buffer, fileName, sheets, at}

// ---------- تطبيع النص العربي للمطابقة ----------
function norm(s) {
  return String(s ?? '').toLowerCase()
    .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s$]/gu, ' ').replace(/\s+/g, ' ').trim();
}
const noAl = (s) => s.split(' ').map((w) => (w.startsWith('ال') && w.length > 3 ? w.slice(2) : w)).join(' ');
function sameName(a, b) { const x = noAl(norm(a)), y = noAl(norm(b)); return x && x === y; }

// تطابق تام أولًا، ثم أطول اسم بديل يرد كعبارة كاملة داخل العنوان («راتب أم أحمد» ← «أم أحمد» وليس «راتب»)
function matchTemplate(label, templates) {
  const n = noAl(norm(label));
  if (!n) return null;
  const padded = ` ${n} `;
  let best = null, bestLen = 0;
  for (const t of templates) {
    const names = [t.name, ...t.aliases.split(',')].map((a) => noAl(norm(a))).filter(Boolean);
    if (names.includes(n)) return t;
    for (const a of names) {
      if (a.length >= 3 && a.length > bestLen && padded.includes(` ${a} `)) { best = t; bestLen = a.length; }
    }
  }
  return best;
}

// ---------- قراءة القيم ----------
const AR_MONTHS = { 'يناير': 1, 'فبراير': 2, 'مارس': 3, 'ابريل': 4, 'مايو': 5, 'يونيو': 6, 'يونيه': 6, 'يوليو': 7, 'يوليه': 7, 'اغسطس': 8, 'سبتمبر': 9, 'اكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12,
  'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12 };
function cellRaw(c) {
  if (c === null || c === undefined) return null;
  if (typeof c === 'object') {
    if (c instanceof Date) return c;
    if ('result' in c) return c.result ?? null;
    if (c.richText) return c.richText.map((t) => t.text).join('');
    if (c.text !== undefined) return c.text;
    if (c.formula || c.sharedFormula) return null;
    if (c.error) return null;
  }
  return c;
}
const digits = (s) => String(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const serialToDate = (n) => new Date(Date.UTC(1899, 11, 30) + n * 864e5);
function parseYm(v) {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}`;
  if (typeof v === 'number' && v > 30000 && v < 60000) { const d = serialToDate(v); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; }
  const s = norm(digits(v));
  let m = s.match(/^(\d{1,2})\s*(\d{4})$/) || String(digits(v)).trim().match(/^(\d{1,2})[/\-.](\d{4})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${pad(m[1])}`;
  m = String(digits(v)).trim().match(/^(\d{4})[/\-.](\d{1,2})(?:[/\-.]\d{1,2})?$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad(m[2])}`;
  m = s.match(/^([\p{L}]+)\s*(\d{4})$/u) || s.match(/^(\d{4})\s*([\p{L}]+)$/u);
  if (m) {
    const word = isNaN(m[1]) ? m[1] : m[2], year = isNaN(m[1]) ? m[2] : m[1];
    const k = Object.keys(AR_MONTHS).find((a) => noAl(word) === a || word.startsWith(a));
    if (k) return `${year}-${pad(AR_MONTHS[k])}`;
  }
  return null;
}
function parseDate(v) {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === 'number' && v > 30000 && v < 60000) { const d = serialToDate(v); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  const s = digits(v ?? '').trim();
  let m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (m && +m[2] <= 12) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}
// مبلغ وعملته من خلية. null إن لم تكن مبلغًا
function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? { amount: v, currency: null } : null;
  if (v === null || v === undefined || v instanceof Date) return null;
  let s = digits(v).trim();
  if (!s) return null;
  let currency = null;
  if (/\$|usd|دولار/i.test(s)) currency = 'USD';
  else if (/₺|ليره|ليرة|\btl\b|\btry\b/i.test(s)) currency = LOCAL;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[^\d\-().]/g, ''));
  s = s.replace(/[٬,،\s]/g, '').replace('٫', '.').replace(/[^\d.]/g, '');
  if (!s || isNaN(Number(s))) return null;
  return { amount: (neg ? -1 : 1) * Number(s), currency };
}
const isNum = (v) => !!parseAmount(v) && !(v instanceof Date);

// ---------- الكلمات الدالة ----------
const W = {
  ignoreSheet: /ملخص|summary|اجمالي|احصائ|chart|رسم/,
  debtSheet: /دين|ديون|سلف|قرض|قروض|debt|loan|جمعيه/,
  total: /^(اجمالي|الاجمالي|مجموع|المجموع|total|sum|صافي|الصافي|باقي|المتبقي|المتبقى)/,
  month: /^(شهر|الشهر|month|الفتره|التاريخ الشهري)$/,
  date: /تاريخ|date|يوم/,
  desc: /وصف|بيان|description|تفاصيل|البند|بند|item|ملاحظ|note/,
  amount: /مبلغ|المبلغ|amount|قيمه|القيمه|سعر|value/,
  currency: /عمله|العمله|currency/,
  category: /تصنيف|التصنيف|فئه|الفئه|category|نوع المصروف|قسم/,
  party: /اسم|الاسم|طرف|الطرف|الشخص|شخص|name|الجهه|جهه/,
  direction: /نوع|النوع|اتجاه|type|حاله/,
  paid: /سدد|المسدد|مسدد|دفع|المدفوع|مدفوع|paid|سداد/,
  usdHeader: /\$|usd|دولار/,
  debtWords: /جمعيه|قسط|اقساط|سلفه|قرض|دين/,
};
const OWE = /اخذت|اقترضت|استلفت|علي|عليا|عليه دين لي|دين علي|مدين|owe|borrow/;
const OWED = /اعطيت|سلفت|اقرضت|لي|ليا|لي عنده|دين لي|دائن|owed|lend|lent/;
const PAYMENT = /سداد|سدد|دفعه|رد|ارجع|payment|repay/;

// ---------- التحليل ----------
async function analyze(buffer, fileName) {
  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(fileName)) {
      const tmp = path.join(DATA_DIR, 'imports', `.tmp-${Date.now()}.csv`);
      fs.writeFileSync(tmp, buffer);
      try { await wb.csv.readFile(tmp); } finally { fs.unlinkSync(tmp); }
    } else await wb.xlsx.load(buffer);
  } catch { throw new Error('تعذرت قراءة الملف. احفظه بصيغة ‎.xlsx‎ ثم أعد المحاولة.'); }
  const templates = core.templates();
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, r) => rows.push({ r, vals: row.values.slice(1).map(cellRaw) }));
    if (!rows.length) return;
    sheets.push(analyzeSheet(ws.name, rows, templates));
  });
  const token = crypto.randomBytes(12).toString('hex');
  sessions.set(token, { buffer, fileName, sheets, at: Date.now() });
  for (const [k, v] of sessions) if (Date.now() - v.at > 36e5) sessions.delete(k);
  return { token, fileName, sheets: sheets.map(publicSheet) };
}

function analyzeSheet(name, rows, templates) {
  // صف العناوين: أول صف فيه عنوانان نصيان على الأقل
  let hIdx = rows.findIndex((x, i) => i < 10 && x.vals.filter((v) => typeof v === 'string' && v.trim() && !isNum(v)).length >= 2);
  if (hIdx < 0) hIdx = 0;
  const header = rows[hIdx].vals.map((v) => (v === null ? '' : String(v instanceof Date ? parseYm(v) : v).trim()));
  const data = rows.slice(hIdx + 1).filter((x) => x.vals.some((v) => v !== null && v !== ''));
  const width = Math.max(header.length, ...data.map((d) => d.vals.length));
  const col = (i) => data.map((d) => d.vals[i]);
  const filled = (v) => v != null && v !== '';
  const ratio = (arr, fn) => { const ne = arr.filter(filled); return ne.length ? ne.filter(fn).length / ne.length : 0; };
  const nName = norm(name);

  const stats = [];
  for (let i = 0; i < width; i++) {
    const h = norm(header[i] || '');
    const vals = col(i);
    const dates = vals.filter(filled).map(parseDate).filter(Boolean);
    stats.push({ i, header: header[i] || `عمود ${i + 1}`, h, ym: ratio(vals, (v) => !!parseYm(v)), date: ratio(vals, (v) => !!parseDate(v)),
      // تواريخ كلها في أول الشهر = عمود أشهر مكتوب كتاريخ
      day1: dates.length ? dates.filter((d) => d.endsWith('-01')).length / dates.length : 0,
      num: ratio(vals, isNum), filled: vals.filter(filled).length, sample: vals.filter(filled).slice(0, 3).map(show) });
  }
  const sheet = { name, headerRow: rows[hIdx].r, rowCount: data.length, rows: data.map((d) => ({ r: d.r, vals: d.vals })), stats, issues: [] };

  const monthLike = (s) => s.ym > 0.7 && (s.date < 0.5 || s.day1 > 0.95);
  const monthCol = stats.find((s) => W.month.test(s.h) && s.ym > 0.5) || stats.find(monthLike);
  const dateCol = stats.find((s) => W.date.test(s.h) && s.date > 0.5) || stats.find((s) => s.date > 0.7 && s.ym < 0.95);
  const hasParty = stats.some((s) => W.party.test(s.h) && s.num < 0.5);
  const hasDirection = stats.some((s) => W.direction.test(s.h));

  let type = 'ignore', confidence = 'low';
  if (W.ignoreSheet.test(nName) && !W.debtSheet.test(nName)) { type = 'ignore'; confidence = 'high'; sheet.issues.push('ورقة ملخص أو مجاميع، تُتجاهل'); }
  else if (W.debtSheet.test(nName) || (hasParty && hasDirection)) { type = 'ignore'; confidence = 'high'; sheet.issues.push('تبدو قائمة ديون، والديون غير مفعّلة في هذه المنصة فتُتجاهل'); }
  else if (monthCol && stats.filter((s) => s.i !== monthCol.i && s.num > 0.6).length >= 1) { type = 'months'; confidence = monthCol.ym > 0.9 ? 'high' : 'medium'; }
  else if (dateCol && stats.some((s) => s.num > 0.7 && s.i !== dateCol.i)) { type = 'transactions'; confidence = 'medium'; }
  sheet.type = type;
  sheet.confidence = confidence;
  sheet.currency = W.usdHeader.test(nName) ? 'USD' : LOCAL;
  sheet.negative = 'expense';
  sheet.columns = suggestColumns(sheet, type, { monthCol, dateCol }, templates);
  // ورقة بلا عمود عملة وفيها مبالغ: العملة قرار المستخدم
  if (type !== 'ignore' && !sheet.columns.some((c) => c.role === 'currency') && !stats.some((s) => W.usdHeader.test(s.h))) sheet.askCurrency = true;
  return sheet;
}

function suggestColumns(sheet, type, { monthCol, dateCol }, templates) {
  const out = [];
  const pick = (re, cond = () => true) => sheet.stats.find((s) => re.test(s.h) && cond(s) && !out.some((o) => o.i === s.i));
  if (type === 'months') {
    for (const s of sheet.stats) {
      if (s.i === monthCol.i) { out.push({ i: s.i, role: 'month' }); continue; }
      if (!s.filled) continue;
      if (W.total.test(s.h)) { out.push({ i: s.i, role: 'ignore', reason: 'مجموع' }); continue; }
      if (s.num < 0.5) { out.push({ i: s.i, role: 'ignore', reason: 'ليس أرقامًا' }); continue; }
      const t = matchTemplate(s.header, templates);
      const cur = W.usdHeader.test(s.h) ? 'USD' : null;
      if (t) out.push({ i: s.i, role: 'item', template_id: t.id, currency: cur });
      else out.push({ i: s.i, role: 'ask', suggest: W.debtWords.test(s.h) ? 'debt' : 'new', name: String(s.header).trim(), section: guessSection(s.h), currency: cur });
    }
  } else if (type === 'transactions') {
    const d = dateCol || pick(W.date);
    if (d) out.push({ i: d.i, role: 'date' });
    const a = pick(W.amount, (s) => s.num > 0.5) || sheet.stats.find((s) => s.num > 0.7 && !out.some((o) => o.i === s.i));
    if (a) out.push({ i: a.i, role: 'amount', currency: W.usdHeader.test(a.h) ? 'USD' : null });
    const de = pick(W.desc, (s) => s.num < 0.5) || sheet.stats.find((s) => s.num < 0.3 && s.date < 0.3 && s.filled && !out.some((o) => o.i === s.i));
    if (de) out.push({ i: de.i, role: 'desc' });
    const c = pick(W.category, (s) => s.num < 0.5); if (c) out.push({ i: c.i, role: 'category' });
    const cu = pick(W.currency); if (cu) out.push({ i: cu.i, role: 'currency' });
    const dir = pick(W.direction, (s) => s.num < 0.5); if (dir) out.push({ i: dir.i, role: 'kind' });
  } else if (type === 'debts') {
    const p = pick(W.party, (s) => s.num < 0.5); if (p) out.push({ i: p.i, role: 'party' });
    const a = pick(W.amount, (s) => s.num > 0.5) || sheet.stats.find((s) => s.num > 0.6 && !W.paid.test(s.h) && !out.some((o) => o.i === s.i));
    if (a) out.push({ i: a.i, role: 'amount', currency: W.usdHeader.test(a.h) ? 'USD' : null });
    const pd = pick(W.paid, (s) => s.num > 0.3); if (pd) out.push({ i: pd.i, role: 'paid' });
    const d = dateCol || pick(W.date); if (d && !out.some((o) => o.i === d.i)) out.push({ i: d.i, role: 'date' });
    const cu = pick(W.currency); if (cu) out.push({ i: cu.i, role: 'currency' });
    const dir = pick(W.direction, (s) => s.num < 0.5); if (dir) out.push({ i: dir.i, role: 'direction' });
    const nt = pick(/ملاحظ|note|سبب|بيان/); if (nt) out.push({ i: nt.i, role: 'note' });
  }
  return out;
}
function guessSection(h) {
  if (/راتب|مرتب|دخل|salary|income|ايراد/.test(h)) return 'income';
  if (/netflix|شاهد|اشتراك|spotify|icloud|chatgpt|youtube|انغامي/.test(h)) return 'subs';
  return 'basic';
}
const show = (v) => (v instanceof Date ? parseDate(v) : String(v).slice(0, 30));
function publicSheet(s) {
  const { rows, ...rest } = s;
  return { ...rest, sampleRows: rows.slice(0, 4).map((x) => x.vals.map((v) => (v === null ? '' : show(v)))) };
}

// ---------- المعاينة ----------
// decisions: {sheets: {[name]: {type, currency, negative, columns:[{i, role, template_id, name, section, currency, suggest}]}}}
async function buildRecords(token, decisions) {
  const sess = sessions.get(token);
  if (!sess) throw new Error('انتهت جلسة الاستيراد، ارفع الملف من جديد');
  const records = [];
  const issues = [];
  const secByKey = Object.fromEntries(core.sections().map((s) => [s.key, s]));
  const templates = core.templates();
  for (const s of sess.sheets) {
    const d = (decisions.sheets || {})[s.name] || {};
    const type = d.type || s.type;
    if (type === 'ignore') continue;
    const cols = d.columns || s.columns;
    const sheetCur = d.currency || s.currency || LOCAL;
    const role = (r) => cols.find((c) => c.role === r);
    const val = (row, c) => (c ? row.vals[c.i] : null);
    const curOf = (row, colCur) => {
      const cc = role('currency');
      const v = cc ? norm(val(row, cc)) : '';
      if (v) return /\$|usd|دولار/.test(v) ? 'USD' : LOCAL;
      return colCur || sheetCur;
    };
    if (type === 'months') {
      const mc = role('month');
      if (!mc) { issues.push(`${s.name}: حدد عمود الشهر`); continue; }
      const relabel = {};
      for (const row of s.rows) {
        const ym = parseYm(val(row, mc));
        if (!ym) continue;
        for (const c0 of cols) {
          const raw = row.vals[c0.i];
          if (typeof raw === 'string' && raw.trim() && !parseAmount(raw) && ['item', 'new', 'ask'].includes(c0.role)) {
            const t2 = matchTemplate(raw, templates);
            if (t2 && t2.id !== Number(c0.template_id)) { relabel[c0.i] = { ...c0, role: 'item', template_id: t2.id }; issues.push(`${s.name}: العمود «${s.stats[c0.i].header}» يُقرأ كـ «${t2.name}» ابتداءً من ${ym}`); }
          }
        }
        for (const c of cols.map((x) => relabel[x.i] || x)) {
          if (!['item', 'new', 'ask'].includes(c.role)) continue;
          if (c.role === 'ask') { issues.push(`${s.name}: العمود «${s.stats[c.i].header}» يحتاج قرارك`); continue; }
          const pa = parseAmount(row.vals[c.i]);
          if (!pa || !pa.amount) continue;
          const t = c.role === 'item' ? templates.find((x) => x.id === Number(c.template_id)) : null;
          const sec = t ? core.sections().find((x) => x.id === t.section_id) : secByKey[c.section || 'basic'];
          records.push({ kind: 'entry', sheet: s.name, row: row.r, ym, template_id: t ? t.id : null, name: t ? t.name : c.name,
            section_id: sec.id, amount: Math.abs(pa.amount), currency: pa.currency || c.currency || sheetCur, colKey: `${s.name}#${c.i}` });
        }
      }
    } else if (type === 'transactions') {
      const dc = role('date'), ac = role('amount'), de = role('desc'), ca = role('category'), kc = role('kind');
      if (!dc || !ac) { issues.push(`${s.name}: حدد عمودي التاريخ والمبلغ`); continue; }
      for (const row of s.rows) {
        const date = parseDate(val(row, dc));
        const pa = parseAmount(val(row, ac));
        if (!date || !pa || !pa.amount) continue;
        const kindTxt = kc ? norm(val(row, kc)) : '';
        const income = /دخل|ايراد|income|قبض|استلام/.test(kindTxt) || (pa.amount < 0 && (d.negative || s.negative) === 'income');
        const desc = de ? String(val(row, de) ?? '').trim() : '';
        const catTxt = ca ? String(val(row, ca) ?? '').trim() : '';
        const tpl = matchTemplate(catTxt || desc, templates);
        const tSec = tpl && core.sections().find((x) => x.id === tpl.section_id);
        let section_id = income ? secByKey.income.id : secByKey.variable.id, template_id = null, name = desc || catTxt || 'مصروف', note = catTxt;
        if (tpl && tSec && tSec.key !== 'variable' && (tSec.kind === 'income') === income) { section_id = tpl.section_id; template_id = tpl.id; name = tpl.name; note = desc; }
        else if (tpl && tSec && tSec.key === 'variable') note = tpl.name;
        records.push({ kind: 'txn', sheet: s.name, row: row.r, ym: date.slice(0, 7), date, template_id, name, note, section_id,
          amount: Math.abs(pa.amount), currency: pa.currency || ac.currency || curOf(row, null) });
      }
    } else if (type === 'debts') {
      const pc = role('party'), ac = role('amount'), dc = role('date'), dir = role('direction'), pd = role('paid'), nt = role('note');
      if (!pc || !ac) { issues.push(`${s.name}: حدد عمودي الطرف والمبلغ`); continue; }
      for (const row of s.rows) {
        const party = String(val(row, pc) ?? '').trim();
        const pa = parseAmount(val(row, ac));
        if (!party || W.total.test(norm(party))) continue;
        const date = (dc && parseDate(val(row, dc))) || fx.today();
        const dtxt = dir ? norm(val(row, dir)) : '';
        let direction = null, txKind = 'start';
        if (PAYMENT.test(dtxt)) txKind = 'payment';
        if (OWE.test(dtxt) && !/دين لي/.test(dtxt)) direction = 'owe';
        if (OWED.test(dtxt) && !OWE.test(dtxt)) direction = 'owed';
        if (!direction) direction = ((d.partyDirections || {})[party] || d.debtDirection || null);
        const currency = pa && pa.currency ? pa.currency : curOf(row, ac.currency);
        const note = nt ? String(val(row, nt) ?? '') : '';
        if (pa && pa.amount) records.push({ kind: 'debt', sheet: s.name, row: row.r, party, direction, txKind, amount: Math.abs(pa.amount), currency, date, ym: date.slice(0, 7), note, dirText: dtxt });
        const pp = pd ? parseAmount(val(row, pd)) : null;
        if (pp && pp.amount) records.push({ kind: 'debt', sheet: s.name, row: row.r, party, direction, txKind: 'payment', amount: Math.abs(pp.amount), currency: pp.currency || currency, date, ym: date.slice(0, 7), note: 'مسدد (من الملف)' });
      }
      // صف سداد بلا اتجاه يأخذ اتجاه نفس الطرف في بقية الصفوف
      const own = records.filter((r) => r.kind === 'debt' && r.sheet === s.name);
      for (const r of own) if (!r.direction) { const o = own.find((x) => x.party === r.party && x.direction); if (o) r.direction = o.direction; }
      const undecided = [...new Set(own.filter((r) => !r.direction).map((r) => r.party))];
      if (undecided.length) issues.push(`${s.name}: لم نعرف اتجاه الدين لـ ${undecided.join('، ')}. حدد: عليّ أم لي`);
    }
  }
  return { sess, records, issues };
}

async function rateMaps(records) {
  const yms = [...new Set(records.map((r) => r.ym))];
  const dates = [...new Set(records.filter((r) => r.date).map((r) => r.date))];
  const monthRates = {}, dayRates = {};
  const queue = [...yms.map((ym) => ['m', ym]), ...dates.map((dt) => ['d', dt])];
  // تحميل متوازٍ محدود حتى لا يُرهق المصدر
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const [k, v] = queue.shift();
      if (k === 'm') {
        const m = core.q.monthByYm.get(v); const r = m && core.q.rate.get(m.id);
        if (r && r.rate) monthRates[v] = { rate: r.rate, method: r.method, source: r.source, existing: true };
        else { const info = await fx.monthRate(v, 'avg'); monthRates[v] = info && info.rate ? { ...info, method: 'avg' } : { rate: null, method: 'avg', unavailable: true }; }
      } else { const r = await fx.dayRate(v); dayRates[v] = r ? r.rate : null; }
    }
  }));
  return { monthRates, dayRates };
}

// تصنيف كل سجل: جديد، مكرر، تأكيد دفعة متكررة، تعارض
function classify(records) {
  const debtsByParty = {};
  for (const d of core.listDebts()) (debtsByParty[d.party + '|' + d.direction] ||= []).push(d);
  const seen = new Set();
  for (const r of records) {
    const key = JSON.stringify([r.kind, r.ym, r.date, r.template_id || r.name, r.party, r.amount, r.currency, r.txKind]);
    r.key = crypto.createHash('md5').update(key + r.sheet + r.row).digest('hex').slice(0, 10);
    // صفان متطابقان في الملف قد يكونان عمليتين حقيقيتين: يُتجاهل الثاني افتراضيًا ويمكن إضافته
    if (seen.has(key)) { r.state = 'duplicate'; r.reason = 'infile'; continue; }
    seen.add(key);
    const m = core.q.monthByYm.get(r.ym);
    if (r.kind === 'entry') {
      const ex = m && (r.template_id
        ? db.prepare('SELECT e.* FROM entries e LEFT JOIN series s ON s.id=e.series_id WHERE e.month_id=? AND (e.template_id=? OR s.template_id=?) ORDER BY e.id LIMIT 1').get(m.id, r.template_id, r.template_id)
        : db.prepare('SELECT * FROM entries WHERE month_id=? AND section_id=? AND name=? ORDER BY id LIMIT 1').get(m.id, r.section_id, r.name));
      if (!ex || ex.amount == null) { r.state = ex ? 'fill' : 'new'; r.existing = ex ? { id: ex.id } : null; continue; }
      const same = Number(ex.amount) === r.amount && ex.currency === r.currency;
      r.existing = { id: ex.id, amount: ex.amount, currency: ex.currency, status: ex.status, series: !!ex.series_id };
      if (same) r.state = ex.status === 'paid' ? 'duplicate' : 'confirm';
      else r.state = 'conflict';
    } else if (r.kind === 'txn') {
      const ex = m && db.prepare('SELECT * FROM entries WHERE month_id=? AND tx_date=? AND amount=? AND currency=? AND (name=? OR template_id IS ?) LIMIT 1')
        .get(m.id, r.date, r.amount, r.currency, r.name, r.template_id);
      r.state = ex ? 'duplicate' : 'new';
    } else if (r.kind === 'debt') {
      if (!r.direction) { r.state = 'ask'; continue; }
      const ds = debtsByParty[r.party + '|' + r.direction] || [];
      const dup = ds.some((d) => d.txns.some((t) => t.date === r.date && Number(t.amount) === r.amount && t.currency === r.currency && (t.kind === 'payment') === (r.txKind === 'payment')));
      r.state = dup ? 'duplicate' : 'new';
    }
  }
  return records;
}

// اقتراحات التكرار: نفس المبلغ في 3 أشهر متتالية على الأقل. لا شيء يُفعَّل دون موافقة.
function suggestRecurring(records) {
  const byItem = {};
  for (const r of records) if (r.kind === 'entry') (byItem[r.template_id || 'n:' + r.name] ||= []).push(r);
  const out = [];
  for (const [k, list] of Object.entries(byItem)) {
    const tplHasSeries = list[0].template_id && db.prepare('SELECT 1 FROM series WHERE template_id=?').get(list[0].template_id);
    if (tplHasSeries) continue;
    const sorted = [...new Map(list.map((r) => [r.ym, r])).values()].sort((a, b) => a.ym.localeCompare(b.ym));
    const periods = [];
    for (const r of sorted) {
      const last = periods[periods.length - 1];
      if (last && Calc.shiftYm(last.to_ym, 1) === r.ym && last.amount === r.amount && last.currency === r.currency) last.to_ym = r.ym;
      else periods.push({ from_ym: r.ym, to_ym: r.ym, amount: r.amount, currency: r.currency });
    }
    const runs = periods.filter((p) => Calc.ymRange(p.from_ym, p.to_ym).length >= 3);
    if (!runs.length) continue;
    // فترات متصلة فقط (بمبالغ مختلفة) تُدمج في سلسلة واحدة
    const useful = periods.filter((p) => Calc.ymRange(p.from_ym, p.to_ym).length >= 2);
    out.push({ key: 'rec:' + k, name: list[0].name, template_id: list[0].template_id, section_id: list[0].section_id, periods: useful,
      months: useful.reduce((n, p) => n + Calc.ymRange(p.from_ym, p.to_ym).length, 0), once: sorted.length === 1 });
  }
  return out;
}

async function preview(token, decisions) {
  const { records, issues } = await buildRecords(token, decisions);
  const { monthRates, dayRates } = await rateMaps(records);
  classify(records);
  for (const r of records) {
    const rate = (r.date && dayRates[r.date]) || (monthRates[r.ym] && monthRates[r.ym].rate) || null;
    r.rate = rate;
    r.usd = rate ? Calc.round2(Calc.toUsd(r.amount, r.currency, rate)) : null;
    r.local = rate || r.currency !== 'USD' ? Calc.round2(Calc.toLocal(r.amount, r.currency, rate)) : null;
  }
  const newMonths = Object.keys(monthRates).filter((ym) => !core.q.monthByYm.get(ym)).sort();
  const missingRates = newMonths.filter((ym) => !monthRates[ym].rate);
  const count = (st) => records.filter((r) => r.state === st).length;
  return {
    summary: { new: count('new') + count('fill'), duplicate: count('duplicate'), confirm: count('confirm'), conflict: count('conflict'), ask: count('ask'), months: newMonths.length, total: records.length },
    records, issues, newMonths, missingRates, monthRates, suggestions: suggestRecurring(records),
  };
}

// ---------- الاعتماد ----------
// choices: {conflicts:{key:'keep'|'replace'}, suggestions:[key], manualRates:{ym:rate}, newItems:{colKey:'activate'}}
async function commit(token, decisions, choices = {}) {
  const pv = await preview(token, decisions);
  const sess = sessions.get(token);
  if (pv.summary.ask) throw new Error('حدد اتجاه الديون غير المعروفة قبل الاعتماد');
  const manual = choices.manualRates || {};
  const stored = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${sess.fileName.replace(/[\\/:*?"<>|]/g, '_')}`;
  fs.writeFileSync(path.join(DATA_DIR, 'imports', stored), sess.buffer);
  const cur = core.currentYm();
  const accepted = new Set(choices.suggestions || []);
  const sugg = pv.suggestions.filter((s) => accepted.has(s.key));
  const allMonths = [...new Set([...pv.records.map((r) => r.ym), ...sugg.flatMap((s) => s.periods.flatMap((p) => Calc.ymRange(p.from_ym, p.to_ym)))])];
  for (const ym of allMonths) if (!pv.monthRates[ym]) { const info = await fx.monthRate(ym, 'avg'); pv.monthRates[ym] = info && info.rate ? { ...info, method: 'avg' } : { rate: null, method: 'avg' }; }

  const res = core.track((r) => `استيراد «${sess.fileName}»: ${r.added} سجلًا جديدًا، ${r.confirmed} تأكيد، ${r.replaced} استبدال`, (rec) => {
    const importId = core.insertRow(rec, 'imports', { file_name: sess.fileName, stored_as: stored, summary: '' });
    const stats = { added: 0, confirmed: 0, replaced: 0, kept: 0, debts: 0, series: 0, importId };
    const monthOf = (ym) => {
      const mr = pv.monthRates[ym] || {};
      const m = core.q.monthByYm.get(ym);
      if (m) {
        // شهر موجود بلا سعر: يأخذ السعر اليدوي إن أُدخل
        const r = core.q.rate.get(m.id);
        if (r && !r.rate && manual[ym]) { rec.update('month_rates', r); db.prepare("UPDATE month_rates SET rate=?, method='manual', source='يدوي', locked=1 WHERE month_id=? AND currency='USD'").run(Number(manual[ym]), m.id); }
        return m;
      }
      const rate = manual[ym] ? { rate: Number(manual[ym]), method: 'manual', source: 'يدوي', complete: true } : { rate: mr.rate || null, method: mr.rate ? 'avg' : 'avg', source: mr.source || null, days: mr.days || null, complete: !!mr.complete };
      const nm = core.createMonthSync(rec, ym, rate, ym >= cur ? 'templates' : 'empty');
      core.updateRow(rec, 'months', nm.id, { import_id: importId });
      return core.q.monthByYm.get(ym);
    };
    // بنود جديدة من أعمدة لا تطابق قوالب: تُنشأ قالبًا
    const newTpl = {};
    const tplFor = (r) => {
      if (r.template_id) return r.template_id;
      const k = r.section_id + '|' + r.name;
      if (newTpl[k]) return newTpl[k];
      const sec = core.sections().find((s) => s.id === r.section_id);
      if (sec.key === 'variable' || r.kind === 'txn') return null;
      const ex = core.templates().find((t) => t.section_id === r.section_id && sameName(t.name, r.name));
      if (ex) return (newTpl[k] = ex.id);
      const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 s FROM templates WHERE section_id=?').get(r.section_id).s;
      return (newTpl[k] = core.insertRow(rec, 'templates', { section_id: r.section_id, name: r.name, aliases: r.name, currency: r.currency, active: 0, sort }));
    };
    const lastByTpl = {};
    const force = new Set(choices.force || []);
    for (const r of pv.records) if (r.state === 'duplicate' && r.reason === 'infile' && force.has(r.key)) r.state = 'new';
    for (const r of pv.records) {
      if (r.kind === 'debt') continue;
      if (r.state === 'duplicate') continue;
      const m = monthOf(r.ym);
      const tid = tplFor(r);
      if (tid) lastByTpl[tid] = r.ym > (lastByTpl[tid]?.ym || '') ? { ym: r.ym, amount: r.amount, currency: r.currency } : lastByTpl[tid];
      const txRate = r.date ? r.rate : null;
      if (r.state === 'new' || (r.state === 'fill' && !r.existing)) {
        core.insertRow(rec, 'entries', { month_id: m.id, section_id: r.section_id, template_id: tid, name: r.name, currency: r.currency, amount: r.amount,
          status: 'paid', tx_date: r.date || null, fx_rate: txRate, fx_source: txRate ? 'ECB' : null, recurrence: r.kind === 'txn' ? 'once' : 'monthly',
          note: r.note || '', source: 'import', import_id: importId, sort: 0 });
        stats.added++;
      } else if (r.state === 'fill') {
        core.updateRow(rec, 'entries', r.existing.id, { amount: r.amount, currency: r.currency, status: 'paid', import_id: importId });
        stats.added++;
      } else if (r.state === 'confirm') {
        core.updateRow(rec, 'entries', r.existing.id, { status: 'paid', needs_review: 0, import_id: importId });
        stats.confirmed++;
      } else if (r.state === 'conflict') {
        if ((choices.conflicts || {})[r.key] === 'replace') {
          core.updateRow(rec, 'entries', r.existing.id, { amount: r.amount, currency: r.currency, status: 'paid', import_id: importId, ...(r.existing.series ? { series_override: 1 } : {}) });
          stats.replaced++;
        } else stats.kept++;
      }
    }
    // القوالب: المبلغ المعتاد = آخر قيمة، والبند نشط إن ظهر في آخر شهرين من الملف
    const maxYm = pv.records.filter((r) => r.kind === 'entry').reduce((a, r) => (r.ym > a ? r.ym : a), '');
    for (const [tid, v] of Object.entries(lastByTpl)) {
      const t = core.q.template.get(Number(tid));
      if (!t) continue;
      const patch = {};
      if (t.planned_amount == null || v.ym === maxYm) patch.planned_amount = v.amount;
      if (!t.active && v.ym >= Calc.shiftYm(maxYm, -1)) patch.active = 1;
      if (Object.keys(patch).length) core.updateRow(rec, 'templates', t.id, patch);
    }
    // الديون: دين واحد لكل طرف واتجاه وعملة، وكل صف حركة بسعر يومه
    const debtIds = {};
    for (const r of pv.records.filter((x) => x.kind === 'debt' && x.state === 'new').sort((a, b) => a.date.localeCompare(b.date))) {
      const k = r.party + '|' + r.direction + '|' + r.currency;
      let did = debtIds[k];
      if (!did) {
        const ex = db.prepare("SELECT d.id FROM debts d JOIN parties p ON p.id=d.party_id WHERE p.name=? AND d.direction=? AND d.currency=? AND d.status='active' ORDER BY d.id DESC LIMIT 1").get(r.party, r.direction, r.currency);
        if (ex) did = ex.id;
        else {
          const pid = core.partyId(rec, r.party);
          did = core.insertRow(rec, 'debts', { party_id: pid, direction: r.direction, currency: r.currency, plan: 'none', count_in_expenses: 0, note: r.note || '', import_id: importId });
          stats.debts++;
        }
        debtIds[k] = did;
      }
      const kind = r.txKind === 'payment' ? 'payment' : (db.prepare('SELECT COUNT(*) c FROM debt_txns WHERE debt_id=?').get(did).c ? 'increase' : 'start');
      core.insertRow(rec, 'debt_txns', { debt_id: did, kind, amount: r.amount, currency: r.currency, date: r.date, fx_rate: r.rate, fx_source: r.rate ? 'ECB' : null, import_id: importId, note: r.note || '' });
    }
    for (const did of Object.values(debtIds)) {
      const d = db.prepare('SELECT * FROM debts WHERE id=?').get(did);
      const b = Calc.debtBalance(d, db.prepare('SELECT * FROM debt_txns WHERE debt_id=?').all(did));
      if (b.remaining <= 0.009 && d.status !== 'settled') core.updateRow(rec, 'debts', did, { status: 'settled' });
    }
    // التكرار المقبول: سلسلة بفتراتها، تُربط بها البنود المستوردة
    for (const s of sugg) {
      const tid = s.template_id || tplFor({ ...s, kind: 'entry', currency: s.periods[0].currency });
      const sid = core.insertRow(rec, 'series', { section_id: s.section_id, template_id: tid, name: s.name });
      for (const p of s.periods) core.insertRow(rec, 'series_periods', { series_id: sid, from_ym: p.from_ym, to_ym: p.to_ym, amount: p.amount, currency: p.currency });
      core.applySeries(rec, sid, { rates: Object.fromEntries(Object.entries(pv.monthRates).map(([k, v]) => [k, v.rate])) });
      stats.series++;
    }
    core.updateRow(rec, 'imports', importId, { summary: JSON.stringify(stats) });
    return stats;
  }, 'imports');
  db.prepare('UPDATE audit_log SET row_id=? WHERE id=?').run(res.result.importId, res.auditId);
  sessions.delete(token);
  return { ...res.result, auditId: res.auditId };
}

function listImports() {
  return db.prepare('SELECT i.*, (SELECT id FROM audit_log a WHERE a.tbl=\'imports\' AND a.row_id=i.id) audit_id FROM imports i ORDER BY id DESC').all();
}

module.exports = { analyze, preview, commit, listImports, parseYm, parseDate, parseAmount, matchTemplate };
