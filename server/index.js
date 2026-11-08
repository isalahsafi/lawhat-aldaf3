// خادم لوحة الدفع العائلية
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const ExcelJS = require('exceljs');
const { db, tx, getSetting, setSetting, DB_PATH, DATA_DIR } = require('./db');
const core = require('./core');
const fx = require('./fx');
const importer = require('./importer');
const routes = require('./routes');
const Calc = require('../shared/calc');

const app = express();
const ROOT = path.join(__dirname, '..');
const argPort = (process.argv.find((a) => a.startsWith('--port=')) || '').slice(7);
const PORT = Number(argPort || process.env.PORT || getSetting('port', '4600'));
const LAN = getSetting('lan_enabled', '0') === '1';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

app.use(express.json({ limit: '20mb' }));

// ---------- المزامنة مع تطبيق الهاتف (برمز الجهاز، قبل التحقق برمز PIN) ----------
require('./sync').install(app, { port: PORT, express, registerRoutes: (r) => routes(r, { publicSettings, hashPin }) });

// ---------- رمز PIN للوصول من أجهزة الشبكة ----------
const sessions = new Set();
const hashPin = (p) => crypto.createHash('sha256').update('fpb:' + p).digest('hex');
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const cookieToken = (req) => ((req.headers.cookie || '').match(/fpb_session=([a-f0-9]+)/) || [])[1];
app.post('/api/login', (req, res) => {
  const pin = getSetting('pin', '');
  if (!pin || hashPin(String(req.body.pin || '')) !== pin) return res.status(401).json({ error: 'رمز غير صحيح' });
  const t = crypto.randomBytes(24).toString('hex');
  sessions.add(t);
  res.setHeader('Set-Cookie', `fpb_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
  res.json({ ok: true });
});
app.use((req, res, next) => {
  if (isLocal(req) || sessions.has(cookieToken(req))) return next();
  if (req.path === '/login.html' || req.path.startsWith('/css/') || req.path === '/manifest.json' || req.path.startsWith('/icons/')) return next();
  if (!getSetting('pin', '')) return res.status(403).send('الوصول من الشبكة يتطلب تعيين رمز PIN من الإعدادات على جهاز المنصة.');
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login' });
  res.redirect('/login.html');
});

app.use(express.static(path.join(ROOT, 'public')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/vendor/chart.js', express.static(path.join(ROOT, 'node_modules', 'chart.js', 'dist')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(400).json({ error: e.message || String(e) });
});

// ---------- عام ----------
function publicSettings() {
  return {
    ...routes.baseSettings(), platform: 'pc', lan_enabled: getSetting('lan_enabled', '0') === '1', pin_set: !!getSetting('pin', ''),
    port: PORT, db_path: DB_PATH, data_dir: DATA_DIR, lan_urls: lanUrls(),
  };
}
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  return out;
}

routes(app, { publicSettings, hashPin });

// ---------- الاستيراد ----------
app.post('/api/import/analyze', express.raw({ type: '*/*', limit: '25mb' }), wrap(async (req, res) => {
  res.json(await importer.analyze(req.body, decodeURIComponent(String(req.query.name || 'file.xlsx'))));
}));
app.post('/api/import/preview', wrap(async (req, res) => res.json(await importer.preview(req.body.token, req.body.decisions || {}))));
app.post('/api/import/commit', wrap(async (req, res) => {
  backup('before-import');
  res.json(await importer.commit(req.body.token, req.body.decisions || {}, req.body.choices || {}));
}));
app.get('/api/imports', wrap(async (req, res) => res.json(importer.listImports())));

// ---------- التصدير والنسخ الاحتياطي ----------
app.get('/api/export.json', wrap(async (req, res) => {
  const dump = {};
  for (const t of ['sections', 'templates', 'months', 'month_rates', 'entries', 'series', 'series_periods', 'parties', 'debts', 'debt_txns', 'goals', 'goal_contribs']) dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  res.setHeader('Content-Disposition', `attachment; filename="family-payments-${fx.today()}.json"`);
  res.json(dump);
}));
app.get('/api/export.xlsx', wrap(async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('البنود', { views: [{ rightToLeft: true }] });
  ws.columns = [
    { header: 'الشهر', key: 'ym', width: 10 }, { header: 'القسم', key: 'section', width: 18 }, { header: 'البند', key: 'name', width: 24 },
    { header: 'العملة', key: 'currency', width: 8 }, { header: 'المبلغ', key: 'amount', width: 12 }, { header: 'سعر $', key: 'rate', width: 10 },
    { header: 'بالليرة', key: 'local', width: 13 }, { header: 'بالدولار', key: 'usd', width: 12 }, { header: 'الحالة', key: 'status', width: 10 },
    { header: 'متكرر', key: 'rec', width: 8 }, { header: 'تاريخ العملية', key: 'tx', width: 12 }, { header: 'ملاحظة', key: 'note', width: 20 },
  ];
  const secs = Object.fromEntries(core.sections().map((s) => [s.id, s]));
  const { months, entries } = core.allData();
  const mById = Object.fromEntries(months.map((m) => [m.id, m]));
  const st = { paid: 'مدفوع', partial: 'جزئي', unpaid: 'مستحق' };
  entries.sort((a, b) => mById[a.month_id].ym.localeCompare(mById[b.month_id].ym) || a.section_id - b.section_id || a.sort - b.sort);
  for (const e of entries) {
    if (e.amount == null) continue;
    const m = mById[e.month_id];
    const v = Calc.entryValues(e, m.rate);
    ws.addRow({ ym: m.ym, section: secs[e.section_id]?.name, name: e.name, currency: e.currency, amount: e.amount, rate: v.rate, local: Calc.round2(v.local),
      usd: v.rate ? Calc.round2(v.usd) : null, status: st[e.status], rec: e.series_id ? '⟳' : '', tx: e.tx_date || '', note: e.note });
  }
  ws.getRow(1).font = { bold: true };
  const dws = wb.addWorksheet('الديون', { views: [{ rightToLeft: true }] });
  dws.columns = [{ header: 'الطرف', key: 'p', width: 18 }, { header: 'الاتجاه', key: 'd', width: 8 }, { header: 'النوع', key: 'k', width: 10 },
    { header: 'المبلغ', key: 'a', width: 12 }, { header: 'العملة', key: 'c', width: 8 }, { header: 'التاريخ', key: 't', width: 12 }, { header: 'سعر $', key: 'r', width: 10 }];
  for (const d of core.listDebts()) for (const t of d.txns) dws.addRow({ p: d.party, d: d.direction === 'owe' ? 'عليّ' : 'لي', k: { start: 'دين', increase: 'زيادة', payment: 'سداد' }[t.kind], a: t.amount, c: t.currency, t: t.date, r: t.fx_rate });
  dws.getRow(1).font = { bold: true };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="family-payments-${fx.today()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

function backup(tag = 'auto') {
  const d = new Date();
  const name = `finance-${fx.iso(d)}-${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}-${String(d.getSeconds()).padStart(2, '0')}-${tag}.db`;
  db.exec(`VACUUM INTO '${path.join(BACKUP_DIR, name).replace(/'/g, "''")}'`);
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort();
  while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  return name;
}
app.post('/api/backup', wrap(async (req, res) => res.json({ file: backup('manual') })));
app.get('/api/backups', wrap(async (req, res) => res.json(fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort().reverse()
  .map((f) => ({ file: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size })))));
function dailyBackup() {
  const tag = fx.today();
  if (!fs.readdirSync(BACKUP_DIR).some((f) => f.startsWith(`finance-${tag}`) && f.endsWith('-daily.db'))) backup('daily');
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

const server = app.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  try { dailyBackup(); } catch (e) { console.error('backup failed', e.message); }
  const fill = () => core.fillPendingRates().catch(() => {});
  fill();
  setInterval(fill, 36e5);
  setInterval(() => { try { dailyBackup(); } catch { /* تجاهل */ } }, 6 * 36e5);
  console.log(`لوحة الدفع تعمل على http://localhost:${PORT}`);
  if (LAN) console.log('من الهاتف: ' + lanUrls().join(' , '));
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`المنفذ ${PORT} مستخدم. ربما المنصة تعمل بالفعل: افتح http://localhost:${PORT}`);
  else console.error(e);
  process.exit(1);
});
