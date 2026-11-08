// المزامنة مع تطبيق الهاتف (الكمبيوتر هو المرجع).
// الهاتف يعمل دون اتصال ويسجّل كل عملية يجريها. عند الاتصال:
//   1) يرسل عملياته، فينفذها الكمبيوتر بنفس المسارات وبتاريخ يوم إدخالها،
//      مع استبدال معرّفات الهاتف المؤقتة بمعرّفات الكمبيوتر، وكشف التعارض.
//   2) يستلم نسخة كاملة محدّثة من البيانات تحل محل نسخته.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { db, DATA_DIR, SCHEMA_VERSION } = require('./db');
const fx = require('./fx');
const { createRouter } = require('./router');

const STATE_FILE = path.join(DATA_DIR, 'sync.json');
const DEVICE_SPAN = 1e12;            // الجهاز رقم n يرقّم صفوفه الجديدة من n × 10^12
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { devices: [], applied: {} }; }
}
let state = loadState();
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
let pairing = null;                  // { code, expires }

// ---------- مساعدات ----------
const isLocalReq = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function deviceOf(req) {
  const t = ((req.headers.authorization || '').match(/^Bearer\s+([a-f0-9]{40,})$/i) || [])[1];
  if (!t) return null;
  const h = sha(t);
  return state.devices.find((d) => d.tokenHash === h && !d.revoked) || null;
}
function tailscaleExe() {
  const win = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  return process.platform === 'win32' && fs.existsSync(win) ? win : 'tailscale';
}
function run(args) {
  return new Promise((res) => execFile(tailscaleExe(), args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) =>
    res({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') })));
}
// العنوان الآمن للكمبيوتر عبر Tailscale (إن كان مثبتًا)
async function tailscaleInfo(port) {
  const st = await run(['status', '--json']);
  if (!st.ok) return { installed: false };
  let j; try { j = JSON.parse(st.out); } catch { return { installed: true, running: false }; }
  const name = j.Self && j.Self.DNSName ? j.Self.DNSName.replace(/\.$/, '') : null;
  const running = j.BackendState === 'Running';
  const serve = await run(['serve', 'status', '--json']);
  let serving = false;
  try { const s = JSON.parse(serve.out || '{}'); serving = JSON.stringify(s).includes(`127.0.0.1:${port}`) || JSON.stringify(s).includes(`localhost:${port}`); } catch { /* لا شيء */ }
  return { installed: true, running, name, url: name ? `https://${name}` : null, serving };
}

// ---------- استبدال المعرّفات ----------
const isLocalId = (v) => typeof v === 'number' && Number.isInteger(v) && v >= DEVICE_SPAN;
function remap(value, map, missing) {
  if (isLocalId(value)) { if (map[value] != null) return map[value]; missing.push(value); return value; }
  if (typeof value === 'string' && /^\d{13,}$/.test(value) && Number(value) >= DEVICE_SPAN) {
    if (map[value] != null) return String(map[value]); missing.push(value); return value;
  }
  if (Array.isArray(value)) return value.map((v) => remap(v, map, missing));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, map, missing)]));
  return value;
}
const remapPath = (p, map, missing) => p.replace(/\d{13,}/g, (n) => { if (map[n] != null) return String(map[n]); missing.push(n); return n; });

// تعديل صف واحد: هل تغيّرت نفس الحقول على الكمبيوتر منذ آخر مزامنة؟
const PATCH_TABLES = { entries: 'entries', templates: 'templates', sections: 'sections', goals: 'goals' };
const same = (a, b) => (a == null && b == null) || (a != null && b != null && String(a) === String(b));
function checkConflict(op, method, p, body) {
  if (method !== 'PATCH' || !op.before) return null;
  const m = /^\/api\/(\w+)\/(\d+)$/.exec(p);
  const tbl = m && PATCH_TABLES[m[1]];
  if (!tbl) return null;
  const cur = db.prepare(`SELECT * FROM ${tbl} WHERE id=?`).get(Number(m[2]));
  if (!cur) return null;
  const fields = [];
  for (const [k, before] of Object.entries(op.before)) {
    if (!(k in cur) || !(k in body)) continue;
    if (!same(cur[k], before) && !same(cur[k], body[k])) fields.push({ key: k, phone: body[k], pc: cur[k], before });
  }
  if (!fields.length) return null;
  let ym = null;
  if (tbl === 'entries') { const mo = db.prepare('SELECT ym FROM months WHERE id=?').get(cur.month_id); ym = mo && mo.ym; }
  return { table: tbl, id: cur.id, name: cur.name, ym, path: p, fields };
}

// ---------- التنفيذ ----------
let replayRouter = null;
function router(registerRoutes) {
  if (!replayRouter) { replayRouter = createRouter(); registerRoutes(replayRouter); }
  return replayRouter;
}

async function applyOps(device, ops, registerRoutes) {
  const r = router(registerRoutes);
  const applied = (state.applied[device.id] ||= {});
  // خريطة معرّفات الهاتف ← الكمبيوتر من العمليات المنفذة سابقًا (عند إعادة الإرسال)
  const map = {};
  for (const a of Object.values(applied)) for (const [from, to] of a.pairs || []) map[from] = to;
  const results = [];
  for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
    if (applied[op.seq]) { results.push({ seq: op.seq, ...applied[op.seq], repeated: true }); continue; }
    const missing = [];
    const p = remapPath(op.path, map, missing);
    let body = remap(op.body || {}, map, missing);
    let res;
    if (missing.length) {
      res = { status: 'error', error: 'تعتمد على عملية سابقة لم تُنفذ', summary: op.summary };
    } else {
      const conflict = checkConflict(op, op.method, p.split('?')[0], body);
      if (conflict) {
        // تُنفَّذ الحقول التي لا خلاف عليها، وتُعرض الحقول المختلفة على المستخدم
        body = Object.fromEntries(Object.entries(body).filter(([k]) => !conflict.fields.some((f) => f.key === k)));
      }
      let out, created = [];
      if (!conflict || Object.keys(body).length) {
        ({ result: out, created } = await db.capture(() => fx.withToday(op.today, () => r.handle(op.method, p, body))));
      }
      const pairs = [];
      if (out && out.status < 400) {
        // ربط الصفوف التي أنشأتها العملية على الهاتف بنظيرتها هنا: حسب الجدول وترتيب الإنشاء
        const byTbl = {};
        for (const c of created) (byTbl[c.tbl] ||= []).push(c.id);
        const seen = {};
        // احتياط: معرّف هاتف يظهر في جدولين لا يُربط (لا يحدث مع الترقيم الموحّد)
        const dup = new Set((op.created || []).map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i));
        for (const c of op.created || []) {
          const i = seen[c.tbl] || 0;
          seen[c.tbl] = i + 1;
          if (dup.has(c.id)) continue;
          const to = byTbl[c.tbl] && byTbl[c.tbl][i];
          if (to != null && isLocalId(c.id)) { map[c.id] = to; pairs.push([c.id, to]); }
        }
      }
      if (conflict) res = { status: 'conflict', conflict, pairs, summary: op.summary };
      else if (out.status >= 400) res = { status: 'error', error: (out.body && out.body.error) || 'خطأ', summary: op.summary };
      else res = { status: 'ok', pairs };
    }
    applied[op.seq] = res;
    results.push({ seq: op.seq, ...res });
  }
  // الاحتفاظ بآخر 2000 نتيجة لكل جهاز
  const keys = Object.keys(applied).map(Number).sort((a, b) => a - b);
  for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete applied[k];
  device.lastSeen = new Date().toISOString();
  saveState();
  return results;
}

// نسخة كاملة من البيانات للهاتف، دون الإعدادات الخاصة بالكمبيوتر
let snapCache = null;
function snapshot() {
  const tmp = path.join(DATA_DIR, 'sync-snapshot.db');
  try { fs.unlinkSync(tmp); } catch { /* غير موجود */ }
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const s = new DatabaseSync(tmp);
  s.exec("DELETE FROM settings WHERE key IN ('pin','port','lan_enabled'); PRAGMA journal_mode=DELETE; VACUUM;");
  s.close();
  const bytes = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  const etag = crypto.createHash('sha1').update(bytes).digest('hex');
  snapCache = { etag, bytes };
  return snapCache;
}

// ---------- المسارات ----------
function install(app, { port, registerRoutes, express }) {
  // يُسمح للتطبيق المنشور (مثل github.io) بالاتصال؛ الحماية برمز الجهاز لا بالمصدر
  app.use('/api/sync', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-None-Match');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'ETag, X-Schema');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  const json = express.json({ limit: '20mb' });
  const local = (req, res, next) => (isLocalReq(req) ? next() : res.status(403).json({ error: 'من جهاز المنصة فقط' }));
  const auth = (req, res, next) => {
    const d = deviceOf(req);
    if (!d) return res.status(401).json({ error: 'الجهاز غير مرتبط أو أُلغي ربطه' });
    req.device = d;
    next();
  };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); res.status(400).json({ error: e.message || String(e) }); });

  // على الكمبيوتر: إنشاء رمز ربط لمدة 10 دقائق
  app.post('/api/sync/pair-code', local, wrap(async (req, res) => {
    pairing = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), expires: Date.now() + 10 * 60e3 };
    res.json({ code: pairing.code, expires: pairing.expires, tailscale: await tailscaleInfo(port) });
  }));
  app.get('/api/sync/info', local, wrap(async (req, res) => {
    res.json({ tailscale: await tailscaleInfo(port), devices: state.devices.filter((d) => !d.revoked).map(({ tokenHash, ...d }) => d), schema: SCHEMA_VERSION });
  }));
  // تفعيل العنوان الآمن: tailscale serve يمرر https إلى المنصة
  app.post('/api/sync/serve', local, wrap(async (req, res) => {
    const r = await run(['serve', '--bg', String(port)]);
    res.json({ ok: r.ok, output: (r.out + '\n' + r.err).trim().slice(0, 2000), tailscale: await tailscaleInfo(port) });
  }));
  app.delete('/api/sync/devices/:id', local, wrap(async (req, res) => {
    const d = state.devices.find((x) => x.id === req.params.id);
    if (d) { d.revoked = true; delete state.applied[d.id]; saveState(); }
    res.json({ ok: true });
  }));

  // من الهاتف: الربط بالرمز
  app.post('/api/sync/pair', json, wrap(async (req, res) => {
    const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
    if (!pairing || Date.now() > pairing.expires) return res.status(400).json({ error: 'لا يوجد رمز ربط فعّال. أنشئ رمزًا من إعدادات المنصة على الكمبيوتر' });
    if (code !== pairing.code) return res.status(400).json({ error: 'رمز الربط غير صحيح' });
    pairing = null;
    const token = crypto.randomBytes(32).toString('hex');
    const no = state.devices.reduce((m, d) => Math.max(m, d.no), 0) + 1;
    const device = { id: crypto.randomUUID(), no, name: String((req.body && req.body.name) || 'iPhone').slice(0, 40), tokenHash: sha(token),
      created: new Date().toISOString(), lastSeen: new Date().toISOString() };
    state.devices.push(device);
    saveState();
    res.json({ deviceId: device.id, deviceNo: no, idBase: no * DEVICE_SPAN, token, schema: SCHEMA_VERSION });
  }));
  app.get('/api/sync/status', auth, (req, res) => res.json({ ok: true, schema: SCHEMA_VERSION, device: req.device.name, time: new Date().toISOString() }));

  app.post('/api/sync/push', auth, json, wrap(async (req, res) => {
    const { schema, ops } = req.body || {};
    if (Number(schema) !== SCHEMA_VERSION) return res.status(409).json({ error: 'schema', pc: SCHEMA_VERSION, phone: schema });
    const results = await applyOps(req.device, Array.isArray(ops) ? ops : [], registerRoutes);
    snapCache = null;
    res.json({ results });
  }));

  app.get('/api/sync/snapshot', auth, wrap(async (req, res) => {
    const s = snapshot();
    req.device.lastSeen = new Date().toISOString();
    saveState();
    res.setHeader('ETag', `"${s.etag}"`);
    res.setHeader('X-Schema', String(SCHEMA_VERSION));
    res.setHeader('Cache-Control', 'no-store');
    if ((req.headers['if-none-match'] || '').replace(/"/g, '') === s.etag) return res.status(304).end();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(s.bytes);
  }));
}

module.exports = { install, DEVICE_SPAN };
