// يبني تطبيق الهاتف (PWA) في pwa/dist: نفس واجهة المنصة وكودها، مع قاعدة بيانات داخل الهاتف.
// الاستخدام: node pwa/build.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'dist');
const rel = (...p) => path.join(ROOT, ...p);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true }); fs.copyFileSync(from, path.join(OUT, to)); };

// كود الخادم يعمل في الهاتف: db.js يُستبدل بنسخة الهاتف، والتصحيحات المحلية الشخصية لا تُضمَّن أبدًا
const phonePlugin = {
  name: 'phone',
  setup(b) {
    b.onResolve({ filter: /^\.\/db$/ }, (a) => (a.importer.includes(`${path.sep}server${path.sep}`) ? { path: path.join(__dirname, 'src', 'db-browser.js') } : undefined));
    b.onResolve({ filter: /^\.\/local-fixes$/ }, () => ({ path: 'local-fixes', namespace: 'empty' }));
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'module.exports = null;', loader: 'js' }));
    b.onResolve({ filter: /^(node:.*|fs|path|os|crypto|child_process|exceljs|express)$/ }, (a) => ({ errors: [{ text: `وحدة خاصة بالكمبيوتر لا تعمل في الهاتف: ${a.path} (من ${a.importer})` }] }));
  },
};

(async () => {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'engine.js')],
    bundle: true, format: 'iife', platform: 'browser', target: ['safari15'], minify: true, legalComments: 'none',
    outfile: path.join(OUT, 'engine.js'), plugins: [phonePlugin], logLevel: 'warning',
  });
  const engine = fs.readFileSync(path.join(OUT, 'engine.js'), 'utf8');
  // تحقق: لا شيء من نصوص التصحيحات المحلية الخاصة (أسماء) داخل الحزمة
  const localFile = rel('server', 'local-fixes.js');
  if (fs.existsSync(localFile)) {
    const schema = fs.readFileSync(rel('server', 'schema.js'), 'utf8');
    const words = [...fs.readFileSync(localFile, 'utf8').matchAll(/'([^'\n]{3,})'/g)].map((m) => m[1]).filter((w) => !schema.includes(w));
    const leak = words.find((w) => engine.includes(w));
    if (leak) throw new Error('بيانات شخصية داخل حزمة الهاتف');
  }

  for (const f of fs.readdirSync(rel('public', 'js'))) copy(rel('public', 'js', f), `js/${f}`);
  for (const f of fs.readdirSync(rel('public', 'css'))) copy(rel('public', 'css', f), `css/${f}`);
  copy(rel('shared', 'calc.js'), 'shared/calc.js');
  copy(rel('node_modules', 'chart.js', 'dist', 'chart.umd.js'), 'vendor/chart.umd.js');
  copy(rel('node_modules', 'sql.js', 'dist', 'sql-wasm.js'), 'vendor/sql-wasm.js');
  copy(rel('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'), 'vendor/sql-wasm.wasm');
  for (const f of fs.readdirSync(path.join(__dirname, 'shell'))) {
    if (f === 'sw.js') continue;
    const src = path.join(__dirname, 'shell', f);
    if (fs.statSync(src).isDirectory()) for (const g of fs.readdirSync(src)) copy(path.join(src, g), `${f}/${g}`);
    else copy(src, f);
  }

  // عامل الخدمة: يحفظ كل ملفات التطبيق للعمل دون اتصال، ورقم الإصدار يتغير مع أي تعديل
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push(path.relative(OUT, p).split(path.sep).join('/')); } };
  walk(OUT);
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) h.update(f).update(fs.readFileSync(path.join(OUT, f)));
  const version = h.digest('hex').slice(0, 12);
  const sw = fs.readFileSync(path.join(__dirname, 'shell', 'sw.js'), 'utf8')
    .replace('__VERSION__', version).replace('__FILES__', JSON.stringify(['./', ...files.filter((f) => f !== 'index.html')]));
  fs.writeFileSync(path.join(OUT, 'sw.js'), sw);
  fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify({ version, built: new Date().toISOString() }));
  console.log(`✓ pwa/dist · الإصدار ${version} · ${files.length + 1} ملف`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
