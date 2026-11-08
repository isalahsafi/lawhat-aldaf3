// موجّه بسيط بنفس شكل Express (app.get/post/...)، يستقبل الطلبات كاستدعاءات داخلية بلا شبكة.
// يستخدمه التطبيق على الهاتف لتشغيل مسارات routes.js محليًا،
// ويستخدمه الكمبيوتر لتنفيذ عمليات الهاتف المؤجلة عند المزامنة.
function createRouter() {
  const table = [];
  const add = (method) => (pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    table.push({ method, re, keys, handler: handlers[handlers.length - 1] });
  };
  const app = { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };

  // ينفذ طلبًا ويعيد { status, body }
  app.handle = async function handle(method, url, body) {
    const [p, qs] = String(url).split('?');
    for (const r of table) {
      if (r.method !== method) continue;
      const m = r.re.exec(p);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const query = Object.fromEntries(new URLSearchParams(qs || ''));
      const out = { status: 200, body: undefined, headers: {} };
      let done;
      const finished = new Promise((res) => { done = res; });
      const res = {
        status(s) { out.status = s; return res; },
        setHeader(k, v) { out.headers[k] = v; },
        json(v) { out.body = v; done(); return res; },
        send(v) { out.body = v; done(); return res; },
        end() { done(); return res; },
      };
      await Promise.race([Promise.resolve(r.handler({ method, path: p, params, query, body: body ?? {}, headers: {} }, res)), finished]);
      await finished;
      return out;
    }
    return { status: 404, body: { error: 'مسار غير معروف: ' + method + ' ' + p } };
  };
  return app;
}

module.exports = { createRouter };
