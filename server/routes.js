// مسارات واجهة البيانات (API) المشتركة بين المنصة على الكمبيوتر (Express) والتطبيق على الهاتف (موجّه محلي).
// ctx: { publicSettings(), hashPin? }
const { db, getSetting, setSetting } = require('./db');
const core = require('./core');
const fx = require('./fx');
const Calc = require('../shared/calc');

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(400).json({ error: e.message || String(e) });
});

module.exports = function register(app, ctx) {
  app.get('/api/bootstrap', wrap(async (req, res) => {
    const t = await fx.dayRate(fx.today());
    res.json({
      sections: core.sections(), templates: core.templates(), months: core.listMonths(), today: fx.today(), todayRate: t,
      settings: ctx.publicSettings(), pendingRates: db.prepare('SELECT COUNT(*) c FROM entries WHERE fx_source=?').get(fx.PENDING).c, debts: core.listDebts(), series: core.listSeries(),
    });
  }));

  app.put('/api/settings', wrap(async (req, res) => {
    const b = req.body;
    if (b.default_method) setSetting('default_method', b.default_method);
    if ('lan_enabled' in b) setSetting('lan_enabled', b.lan_enabled ? '1' : '0');
    if (b.variable_budget !== undefined) setSetting('variable_budget', Number(b.variable_budget) > 0 ? Number(b.variable_budget) : '');
    if (Array.isArray(b.people)) setSetting('people', JSON.stringify([...new Set(b.people.map((p) => String(p).trim()).filter(Boolean))].slice(0, 20)));
    if (b.user_name !== undefined) setSetting('user_name', String(b.user_name).slice(0, 40));
    if (b.base_currency && ['TRY', 'USD'].includes(b.base_currency)) setSetting('base_currency', b.base_currency);
    if (b.pin !== undefined && ctx.hashPin) {
      if (b.pin && !/^\d{4,8}$/.test(b.pin)) throw new Error('الرمز من 4 إلى 8 أرقام');
      setSetting('pin', b.pin ? ctx.hashPin(b.pin) : '');
    }
    res.json(ctx.publicSettings());
  }));


  // ---------- الأشهر ----------
  app.get('/api/months', wrap(async (req, res) => res.json(core.listMonths())));
  app.get('/api/months/:ym', wrap(async (req, res) => {
    const m = await core.getMonth(req.params.ym);
    if (!m) return res.status(404).json({ error: 'الشهر غير موجود' });
    res.json(m);
  }));
  app.post('/api/months', wrap(async (req, res) => {
    const { year, month, mode, method, rate } = req.body;
    res.json(await core.createMonth(Number(year), Number(month), { mode, method, rate }));
  }));
  app.delete('/api/months/:ym', wrap(async (req, res) => res.json(core.deleteMonth(req.params.ym) || {})));
  app.put('/api/months/:ym/rate', wrap(async (req, res) => res.json(await core.setMonthRate(req.params.ym, req.body))));
  app.post('/api/months/:ym/fill-previous', wrap(async (req, res) => res.json(core.fillFromPrevious(req.params.ym))));

  app.get('/api/fx/day/:date', wrap(async (req, res) => res.json(await fx.dayRate(req.params.date))));
  app.get('/api/fx/month/:ym', wrap(async (req, res) => {
    const [avg, end] = await Promise.all([fx.monthRate(req.params.ym, 'avg'), fx.monthRate(req.params.ym, 'end')]);
    res.json({ avg, end, history_start: fx.HISTORY_START });
  }));

  // ---------- البنود ----------
  app.post('/api/months/:ym/entries', wrap(async (req, res) => { const r = await core.createEntry(req.params.ym, req.body); res.json({ entry: r.result, auditId: r.auditId }); }));
  app.patch('/api/entries/:id', wrap(async (req, res) => res.json(await core.updateEntry(Number(req.params.id), req.body))));
  app.delete('/api/entries/:id', wrap(async (req, res) => res.json(core.deleteEntry(Number(req.params.id)) || {})));
  app.post('/api/quick', wrap(async (req, res) => res.json(await core.quickAdd(req.body))));
  // إدخال عدة عمليات دفعة واحدة؛ كل سطر عملية مستقلة، والتراجع يعكسها كلها
  app.post('/api/quick/batch', wrap(async (req, res) => {
    const out = [];
    try {
      for (const item of req.body.items || []) out.push(await core.quickAdd(item));
    } catch (e) {
      for (const r of [...out].reverse()) { try { core.undo(r.auditId); } catch { /* تجاهل */ } }
      throw e;
    }
    res.json({ count: out.length, auditIds: out.map((r) => r.auditId), ym: out[0] && out[0].ym });
  }));
  app.post('/api/audit/undo-many', wrap(async (req, res) => {
    for (const id of [...(req.body.ids || [])].reverse()) core.undo(Number(id));
    res.json({ ok: true });
  }));
  // أوصاف المصاريف المتغيرة السابقة مع فئتها الأخيرة، لاقتراحها عند الكتابة
  app.get('/api/variable/history', wrap(async (req, res) => {
    const sec = core.q.sectionByKey.get('variable');
    if (!sec) return res.json([]);
    res.json(db.prepare(`SELECT e.name, COUNT(*) n, MAX(COALESCE(e.tx_date, e.created_at)) last,
        (SELECT x.note FROM entries x WHERE x.section_id=e.section_id AND x.name=e.name ORDER BY COALESCE(x.tx_date, x.created_at) DESC, x.id DESC LIMIT 1) category,
        (SELECT x.amount FROM entries x WHERE x.section_id=e.section_id AND x.name=e.name ORDER BY COALESCE(x.tx_date, x.created_at) DESC, x.id DESC LIMIT 1) amount,
        (SELECT x.currency FROM entries x WHERE x.section_id=e.section_id AND x.name=e.name ORDER BY COALESCE(x.tx_date, x.created_at) DESC, x.id DESC LIMIT 1) currency,
        (SELECT x.person FROM entries x WHERE x.section_id=e.section_id AND x.name=e.name ORDER BY COALESCE(x.tx_date, x.created_at) DESC, x.id DESC LIMIT 1) person
      FROM entries e WHERE e.section_id=? GROUP BY e.name ORDER BY n DESC, last DESC LIMIT 300`).all(sec.id));
  }));
  app.get('/api/quick/lookup', wrap(async (req, res) => {
    const ym = String(req.query.date || fx.today()).slice(0, 7);
    const m = core.q.monthByYm.get(ym);
    const tid = Number(req.query.template_id);
    const e = m && tid ? (db.prepare('SELECT * FROM entries WHERE month_id=? AND template_id=? ORDER BY id LIMIT 1').get(m.id, tid)
      || db.prepare('SELECT e.* FROM entries e JOIN series s ON s.id=e.series_id WHERE e.month_id=? AND s.template_id=? LIMIT 1').get(m.id, tid)) : null;
    const rate = m ? core.q.rate.get(m.id) : null;
    res.json({ ym, monthExists: !!m, entry: e || null, rate: rate && rate.rate });
  }));

  // ---------- التكرار ----------
  app.get('/api/series', wrap(async (req, res) => res.json(core.listSeries())));
  app.get('/api/series/:id', wrap(async (req, res) => res.json(core.getSeries(Number(req.params.id)))));
  app.post('/api/series/preview', wrap(async (req, res) => res.json(await core.previewSeries(req.body))));
  app.post('/api/series', wrap(async (req, res) => {
    const { def, pastPaid, conflicts } = req.body;
    const r = await core.saveSeries(def, { pastPaid, conflicts });
    res.json({ ...r.result, auditId: r.auditId });
  }));
  app.post('/api/series/edit-from', wrap(async (req, res) => {
    const r = await core.editSeriesFrom(Number(req.body.entry_id), req.body);
    res.json({ auditId: r.auditId, result: r.result });
  }));
  app.post('/api/series/:id/stop', wrap(async (req, res) => res.json(core.stopSeries(Number(req.params.id), req.body.from_ym))));
  app.post('/api/series/:id/reset-entry', wrap(async (req, res) => res.json(core.resetOverride(Number(req.body.entry_id)))));
  app.post('/api/series/:id/confirm', wrap(async (req, res) => res.json(core.confirmSeries(Number(req.params.id), req.body.months || null))));
  app.delete('/api/series/:id', wrap(async (req, res) => res.json(core.deleteSeries(Number(req.params.id), { keepEntries: req.query.keep === '1' }) || {})));

  // ---------- الديون ----------
  app.get('/api/debts', wrap(async (req, res) => res.json(core.listDebts())));
  app.get('/api/debts/:id', wrap(async (req, res) => res.json(core.getDebt(Number(req.params.id)))));
  app.post('/api/debts', wrap(async (req, res) => { const r = await core.createDebt(req.body); res.json({ id: r.result, auditId: r.auditId }); }));
  app.patch('/api/debts/:id', wrap(async (req, res) => res.json(await core.updateDebt(Number(req.params.id), req.body))));
  app.delete('/api/debts/:id', wrap(async (req, res) => res.json(core.deleteDebt(Number(req.params.id)) || {})));
  app.post('/api/debts/:id/txns', wrap(async (req, res) => res.json(await core.addDebtTxn(Number(req.params.id), req.body))));
  app.delete('/api/debt-txns/:id', wrap(async (req, res) => res.json(core.deleteDebtTxn(Number(req.params.id)) || {})));
  app.get('/api/parties', wrap(async (req, res) => res.json(db.prepare('SELECT * FROM parties ORDER BY name').all())));

  // ---------- الأقسام والقوالب ----------
  app.post('/api/sections', wrap(async (req, res) => {
    const { name, kind, color, icon } = req.body;
    const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 s FROM sections').get().s;
    const r = db.prepare('INSERT INTO sections (name,kind,color,icon,sort) VALUES (?,?,?,?,?)').run(name, kind || 'expense', color || '#3b5bdb', icon || '•', sort);
    res.json({ id: Number(r.lastInsertRowid) });
  }));
  app.patch('/api/sections/:id', wrap(async (req, res) => {
    const keys = Object.keys(req.body).filter((k) => ['name', 'color', 'icon', 'sort', 'active'].includes(k));
    if (keys.length) db.prepare(`UPDATE sections SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`).run(...keys.map((k) => req.body[k]), req.params.id);
    res.json({ ok: true });
  }));
  app.delete('/api/sections/:id', wrap(async (req, res) => {
    if (db.prepare('SELECT COUNT(*) c FROM entries WHERE section_id=?').get(req.params.id).c) { db.prepare('UPDATE sections SET active=0 WHERE id=?').run(req.params.id); return res.json({ archived: true }); }
    db.prepare('DELETE FROM templates WHERE section_id=?').run(req.params.id);
    db.prepare('DELETE FROM sections WHERE id=? AND key IS NULL').run(req.params.id);
    res.json({ ok: true });
  }));
  const TPL_FIELDS = ['section_id', 'name', 'aliases', 'icon', 'color', 'currency', 'planned_amount', 'recurrence', 'due_day', 'due_month', 'start_ym', 'active', 'sort', 'budget', 'one_off_default'];
  app.post('/api/templates', wrap(async (req, res) => {
    const b = { currency: 'TRY', recurrence: 'monthly', aliases: '', icon: '', color: '', active: 1, ...req.body };
    b.sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 s FROM templates WHERE section_id=?').get(b.section_id).s;
    const keys = TPL_FIELDS.filter((k) => k in b);
    const r = db.prepare(`INSERT INTO templates (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => (b[k] === '' ? null : b[k])));
    res.json({ id: Number(r.lastInsertRowid) });
  }));
  app.patch('/api/templates/:id', wrap(async (req, res) => {
    const keys = Object.keys(req.body).filter((k) => TPL_FIELDS.includes(k));
    if (keys.length) db.prepare(`UPDATE templates SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`).run(...keys.map((k) => (req.body[k] === '' ? null : req.body[k])), req.params.id);
    res.json(core.q.template.get(req.params.id));
  }));
  app.delete('/api/templates/:id', wrap(async (req, res) => {
    const used = db.prepare('SELECT COUNT(*) c FROM entries WHERE template_id=?').get(req.params.id).c + db.prepare('SELECT COUNT(*) c FROM series WHERE template_id=?').get(req.params.id).c;
    if (used) db.prepare('UPDATE templates SET active=0 WHERE id=?').run(req.params.id);
    else db.prepare('DELETE FROM templates WHERE id=?').run(req.params.id);
    res.json({ archived: !!used });
  }));

  // ---------- الأهداف ----------
  function goalsList() {
    const latest = db.prepare("SELECT rate FROM fx_cache WHERE currency='USD' ORDER BY date DESC LIMIT 1").get();
    return db.prepare('SELECT * FROM goals WHERE archived=0 ORDER BY id').all().map((g) => {
      const contribs = db.prepare('SELECT * FROM goal_contribs WHERE goal_id=? ORDER BY date DESC, id DESC').all(g.id);
      const saved = contribs.reduce((s, c) => s + Calc.convert(c.amount, c.currency, g.currency, c.fx_rate || (latest && latest.rate)), 0);
      return { ...g, saved: Calc.round2(saved), contribs };
    });
  }
  app.get('/api/goals', wrap(async (req, res) => res.json(goalsList())));
  app.post('/api/goals', wrap(async (req, res) => {
    const { name, icon, target, currency, deadline } = req.body;
    if (!name || !(Number(target) > 0)) throw new Error('أدخل اسم الهدف والمبلغ');
    db.prepare('INSERT INTO goals (name,icon,target,currency,deadline) VALUES (?,?,?,?,?)').run(name, icon || '🎯', Number(target), currency || 'USD', deadline || null);
    res.json(goalsList());
  }));
  app.patch('/api/goals/:id', wrap(async (req, res) => {
    const keys = Object.keys(req.body).filter((k) => ['name', 'icon', 'target', 'currency', 'deadline', 'archived'].includes(k));
    if (keys.length) db.prepare(`UPDATE goals SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`).run(...keys.map((k) => req.body[k]), req.params.id);
    res.json(goalsList());
  }));
  app.delete('/api/goals/:id', wrap(async (req, res) => { db.prepare('DELETE FROM goals WHERE id=?').run(req.params.id); res.json(goalsList()); }));
  app.post('/api/goals/:id/contribs', wrap(async (req, res) => {
    const { amount, currency, date, note } = req.body;
    const d = date || fx.today();
    const r = await fx.dayRate(d);
    db.prepare('INSERT INTO goal_contribs (goal_id,amount,currency,fx_rate,date,note) VALUES (?,?,?,?,?,?)').run(req.params.id, Number(amount), currency || 'TRY', r ? r.rate : null, d, note || '');
    res.json(goalsList());
  }));
  app.delete('/api/contribs/:id', wrap(async (req, res) => { db.prepare('DELETE FROM goal_contribs WHERE id=?').run(req.params.id); res.json(goalsList()); }));

  // ---------- التقارير وسجل التعديلات ----------
  app.get('/api/alerts', wrap(async (req, res) => res.json(core.alerts())));
  app.get('/api/reports/all', wrap(async (req, res) => res.json(core.allData())));
  app.get('/api/audit', wrap(async (req, res) => res.json(db.prepare('SELECT id, at, action, tbl, row_id, summary, undone FROM audit_log ORDER BY id DESC LIMIT 300').all())));
  app.post('/api/audit/:id/undo', wrap(async (req, res) => { core.undo(Number(req.params.id)); res.json({ ok: true }); }));
};
module.exports.wrap = wrap;

// إعدادات مشتركة يعرضها الكمبيوتر والهاتف
module.exports.baseSettings = () => ({
  default_method: getSetting('default_method', 'avg'), onboarded: getSetting('onboarded', '0') === '1', user_name: getSetting('user_name', ''),
  variable_budget: Number(getSetting('variable_budget', '')) || null,
  people: (() => { try { return JSON.parse(getSetting('people', '[]')); } catch { return []; } })(),
  base_currency: getSetting('base_currency', 'TRY'), local: Calc.LOCAL, history_start: fx.HISTORY_START,
});
