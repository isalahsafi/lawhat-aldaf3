// يجعل المنصة قابلة للتثبيت كتطبيق؛ البيانات دائمًا من الخادم مباشرة.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
