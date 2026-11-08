// عامل الخدمة: يحفظ ملفات التطبيق في الهاتف فيعمل دون إنترنت.
// الإصدار الجديد يُنزَّل في الخلفية وينتظر موافقة المستخدم («تطبيق الآن»).
const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = 'fpb-' + VERSION;
const FONTS = 'fpb-fonts';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONTS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // الخطوط: من الذاكرة أولًا ثم تُحدَّث
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  // ملفات التطبيق فقط؛ الاتصال بالكمبيوتر وأسعار الصرف تمر مباشرة
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json')) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('./') : null);
    return hit || fetch(req);
  }));
});
