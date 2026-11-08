// الحسابات المشتركة بين الخادم والواجهة: مصدر واحد لكل الأرقام.
// العملة المحلية (الليرة TRY) هي عملة الحساب الداخلية، والسعر دائمًا: كم وحدة محلية لكل دولار.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LOCAL = 'TRY';
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  function rateFor(entry, monthRate) {
    return entry.fx_rate || monthRate || null;
  }

  function effectiveAmount(entry) {
    if (entry.amount !== null && entry.amount !== undefined && entry.amount !== '') return Number(entry.amount);
    return Number(entry.planned || 0);
  }

  function toLocal(amount, currency, rate) {
    if (currency !== 'USD') return amount;
    return rate ? amount * rate : 0;
  }

  function toUsd(amount, currency, rate) {
    if (currency === 'USD') return amount;
    return rate ? amount / rate : 0;
  }

  // تحويل بين أي عملتين من العملتين المدعومتين
  function convert(amount, from, to, rate) {
    if (from === to) return amount;
    return to === 'USD' ? toUsd(amount, from, rate) : toLocal(amount, from, rate);
  }

  function entryValues(entry, monthRate) {
    const rate = rateFor(entry, monthRate);
    const amt = effectiveAmount(entry);
    const isExpected = entry.amount === null || entry.amount === undefined || entry.amount === '';
    const loc = toLocal(amt, entry.currency, rate);
    const usd = toUsd(amt, entry.currency, rate);
    let paidLocal = 0;
    if (!isExpected) {
      if (entry.status === 'paid') paidLocal = loc;
      else if (entry.status === 'partial') paidLocal = toLocal(Number(entry.paid_amount || 0), entry.currency, rate);
    }
    return { rate, amount: amt, isExpected, local: loc, usd, paidLocal };
  }

  // ملخص شهر. sections: [{id, kind, key}]
  function summarize(entries, monthRate, sections) {
    const byId = {};
    for (const s of sections) byId[s.id] = s;
    const out = {
      income: 0, expenses: 0, paid: 0, remaining: 0, net: 0, bySection: {},
      subs: 0, basic: 0, variable: 0, debts: 0, incomeReceived: 0, oneOff: 0,
      expectedCount: 0, unpaidCount: 0, dueCount: 0, count: entries.length,
    };
    for (const e of entries) {
      const s = byId[e.section_id];
      if (!s) continue;
      const v = entryValues(e, monthRate);
      out.bySection[s.id] = (out.bySection[s.id] || 0) + v.local;
      if (s.kind === 'income') {
        out.income += v.local;
        if (!v.isExpected && e.status === 'paid') out.incomeReceived += v.local;
      } else {
        out.expenses += v.local;
        out.paid += v.paidLocal;
        if (s.key && out[s.key] !== undefined && typeof out[s.key] === 'number') out[s.key] += v.local;
        // مصروف لمرة واحدة: يدخل في المجموع ولا يدخل في حساب الوتيرة والتوقع
        if (s.key === 'variable' && e.one_off) out.oneOff += v.local;
        if (e.status !== 'paid' && v.local > 0) out.unpaidCount++;
      }
      if (e.series_id && e.status !== 'paid') out.dueCount++;
      if (v.isExpected && v.amount) out.expectedCount++;
    }
    out.remaining = Math.max(0, out.expenses - out.paid);
    out.net = out.income - out.expenses;
    for (const k of ['income', 'expenses', 'paid', 'remaining', 'net', 'subs', 'basic', 'variable', 'debts', 'incomeReceived', 'oneOff']) out[k] = round2(out[k]);
    const r = monthRate || 0;
    out.usd = r ? {
      income: round2(out.income / r), expenses: round2(out.expenses / r), net: round2(out.net / r),
      subs: round2(out.subs / r), paid: round2(out.paid / r), remaining: round2(out.remaining / r),
    } : null;
    out.rate = monthRate;
    return out;
  }

  // عمليات حسابية بسيطة داخل حقل المبلغ مثل 850+120، وتقبل الأرقام العربية
  function evalAmount(input) {
    if (input === null || input === undefined) return null;
    let s = String(input).trim();
    if (s === '') return null;
    s = s.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[٫,،]/g, (c) => (c === '٫' ? '.' : '')).replace(/[×x]/gi, '*').replace(/÷/g, '/');
    if (!/^[\d.+\-*/()\s]+$/.test(s)) return NaN;
    try {
      // eslint-disable-next-line no-new-func
      const v = Function('"use strict";return (' + s + ')')();
      return Number.isFinite(v) ? round2(v) : NaN;
    } catch { return NaN; }
  }

  // أدوات الأشهر
  const pad = (n) => String(n).padStart(2, '0');
  function shiftYm(ym, d) {
    const [y, m] = ym.split('-').map(Number);
    const t = new Date(y, m - 1 + d, 1);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`;
  }
  function ymRange(from, to) {
    const out = [];
    for (let y = from; y <= to && out.length < 600; y = shiftYm(y, 1)) out.push(y);
    return out;
  }

  // ديون: الرصيد بعملة الدين. كل حركة تُحوَّل بسعر يومها.
  function debtBalance(debt, txns) {
    let principal = 0, paid = 0;
    for (const t of txns) {
      const v = convert(Number(t.amount), t.currency, debt.currency, t.fx_rate);
      if (t.kind === 'payment') paid += v; else principal += v;
    }
    return { principal: round2(principal), paid: round2(paid), remaining: round2(Math.max(0, principal - paid)) };
  }

  return { LOCAL, round2, rateFor, effectiveAmount, toLocal, toUsd, convert, entryValues, summarize, evalAmount, shiftYm, ymRange, debtBalance, pad };
});
