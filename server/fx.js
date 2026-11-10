// أسعار صرف الدولار مقابل الليرة: تاريخية، مع كاش ومصدر احتياطي.
const { db } = require('./db');

const LOCAL = 'TRY';
const PRIMARY = 'ECB';        // Frankfurter (البنك المركزي الأوروبي)
const FALLBACK = 'currency-api';
const HISTORY_START = '1999-01-04';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// «اليوم» قابل للتثبيت مؤقتًا: عند تنفيذ عملية مؤجلة من الهاتف تُحسب بتاريخ يوم إدخالها
let pinnedToday = null;
const today = () => pinnedToday || iso(new Date());
async function withToday(day, fn) {
  const prev = pinnedToday;
  pinnedToday = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : null;
  try { return await fn(); } finally { pinnedToday = prev; }
}
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const monthBounds = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: `${ym}-${pad(new Date(y, m, 0).getDate())}` };
};

const cacheGet = db.prepare("SELECT date, rate, source FROM fx_cache WHERE currency='USD' AND date<=? AND date>=? ORDER BY date DESC LIMIT 1");
const cacheRange = db.prepare("SELECT date, rate, source FROM fx_cache WHERE currency='USD' AND date BETWEEN ? AND ? ORDER BY date");
const cachePut = db.prepare("INSERT OR REPLACE INTO fx_cache (date, currency, rate, source) VALUES (?, 'USD', ?, ?)");

async function getJSON(url) {
  // على الهاتف دون اتصال: لا داعي للانتظار
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('offline');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), globalThis.FPB_FX_TIMEOUT || 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchRange(from, to) {
  try {
    const j = await getJSON(`https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=${LOCAL}`);
    for (const [d, r] of Object.entries(j.rates || {})) cachePut.run(d, r[LOCAL], PRIMARY);
    return true;
  } catch { return false; }
}

async function fetchDayRemote(date) {
  try {
    const j = await getJSON(`https://api.frankfurter.dev/v1/${date}?base=USD&symbols=${LOCAL}`);
    if (j.rates && j.rates[LOCAL]) { cachePut.run(j.date, j.rates[LOCAL], PRIMARY); return { date: j.date, rate: j.rates[LOCAL], source: PRIMARY }; }
  } catch { /* الاحتياطي */ }
  for (const url of [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.min.json`,
    `https://${date}.currency-api.pages.dev/v1/currencies/usd.min.json`,
  ]) {
    try {
      const j = await getJSON(url);
      const v = j.usd && j.usd[LOCAL.toLowerCase()];
      if (v) { cachePut.run(j.date || date, v, FALLBACK); return { date: j.date || date, rate: v, source: FALLBACK }; }
    } catch { /* التالي */ }
  }
  return null;
}

function isWeekendGap(cached, wanted) {
  for (let d = addDays(cached, 1); d <= wanted; d = addDays(d, 1)) {
    const wd = new Date(d + 'T12:00:00').getDay();
    if (wd !== 0 && wd !== 6) return false;
  }
  return true;
}

// سعر يوم محدد، أو آخر يوم عمل قبله
async function dayRate(date) {
  if (date > today()) date = today();
  let c = cacheGet.get(date, addDays(date, -6));
  if (c && (c.date === date || isWeekendGap(c.date, date))) return { ...c, requested: date };
  const r = await fetchDayRemote(date);
  if (r) return { ...r, requested: date };
  c = cacheGet.get(date, addDays(date, -30));
  return c ? { ...c, requested: date, stale: true } : null;
}

function businessDays(from, to) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) { const wd = new Date(d + 'T12:00:00').getDay(); if (wd !== 0 && wd !== 6) n++; }
  return n;
}
const round4 = (n) => Math.round(n * 10000) / 10000;

// سعر الشهر: متوسط كل أيام العمل، أو آخر يوم
async function monthRate(ym, method = 'avg') {
  const { from, to: monthEnd } = monthBounds(ym);
  const t = today();
  if (from > t) {
    const d = await dayRate(t);
    return d ? { rate: round4(d.rate), source: d.source, days: 1, complete: false, method } : null;
  }
  const to = monthEnd < t ? monthEnd : t;
  let rows = cacheRange.all(from, to);
  if (rows.length < businessDays(from, to)) { await fetchRange(from, to); rows = cacheRange.all(from, to); }
  if (!rows.length) { const d = await dayRate(to); if (!d) return null; rows = [d]; }
  const complete = monthEnd < t;
  if (method === 'end') { const last = rows[rows.length - 1]; return { rate: round4(last.rate), source: last.source, days: 1, date: last.date, complete, method }; }
  return { rate: round4(rows.reduce((s, r) => s + r.rate, 0) / rows.length), source: rows[0].source, days: rows.length, complete, method };
}

async function warm(from, to) { return fetchRange(from, to < today() ? to : today()); }

// سعر لم يُعرف بعد (دون اتصال): يُحفظ مؤقتًا بآخر سعر معروف ويُكمَّل عند الاتصال
const PENDING = 'معلّق';

module.exports = { dayRate, monthRate, monthBounds, today, iso, warm, withToday, PENDING, LOCAL, HISTORY_START };
