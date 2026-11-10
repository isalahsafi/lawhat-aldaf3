// واجهة تطبيق الهاتف: الإعداد الأول، شريط الحالة، النسخ الاحتياطي والاستعادة، والتحديثات.
(() => {
  const L = window.FPB_LOCAL;
  const { $, esc, toast, fail, confirmBox, modal, fmtN, ymLabel } = App;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const BACKUP_DAYS = 7;

  const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 864e5) : null);
  const ago = (iso) => {
    if (!iso) return 'لم تُؤخذ بعد';
    const d = daysSince(iso);
    return d === 0 ? 'اليوم' : d === 1 ? 'أمس' : `قبل ${d} يوم`;
  };

  // ---------- شريط الحالة أعلى الصفحة ----------
  function netbar(s = L.status()) {
    const el = $('#netbar');
    if (!el) return;
    const bits = [];
    if (!s.online) bits.push('⦸ دون اتصال · كل شيء محفوظ على الهاتف');
    if (s.pendingRates) bits.push(`💱 ${s.pendingRates} بانتظار سعر الصرف`);
    const d = daysSince(s.lastBackup);
    if (d === null || d >= BACKUP_DAYS) bits.push(`💾 ${d === null ? 'لا توجد نسخة احتياطية بعد' : `آخر نسخة احتياطية قبل ${d} يوم`}`);
    el.className = 'netbar' + (bits.length ? '' : ' hidden');
    el.innerHTML = bits.map((b) => `<span>${b}</span>`).join('');
    el.onclick = () => { location.hash = '#/settings?tab=phone'; };
  }

  // ---------- التحديثات ----------
  let applying = false;
  function watchUpdates() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const offer = (w) => {
        if (!w || !navigator.serviceWorker.controller) return;
        const b = $('#updbar') || Object.assign(document.createElement('div'), { id: 'updbar', className: 'updbar' });
        b.innerHTML = '<span>✦ تحديث جديد جاهز</span><button class="btn sm p">تطبيق الآن</button>';
        document.body.appendChild(b);
        $('button', b).onclick = () => { applying = true; b.innerHTML = '<span>جارٍ التحديث…</span>'; w.postMessage('skipWaiting'); };
      };
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
      });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
    // إعادة التحميل فقط بعد «تطبيق الآن» (وليس عند أول تثبيت، حتى لا يضيع ما يُكتب)
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (applying && !reloading) { reloading = true; location.reload(); } });
  }

  // ---------- ملفات ----------
  function pickFile(cb) {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = '.db,.sqlite,application/octet-stream,application/x-sqlite3';
    i.onchange = async () => { const f = i.files[0]; if (f) cb(await f.arrayBuffer(), f.name); };
    i.click();
  }
  async function saveBackup() {
    const bytes = await L.backup();
    const d = new Date();
    const name = `lawhat-aldaf3-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.db`;
    const file = new File([bytes], name, { type: 'application/octet-stream' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); netbar(); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    netbar();
  }
  // استعادة مع مقارنة الملف ببيانات الهاتف قبل الاستبدال
  function restoreFlow(after) {
    pickFile(async (buf) => {
      let info;
      try { info = L.inspect(buf); } catch (e) { fail(e); return; }
      const { file, current } = info;
      const when = (s) => (s && s.last_edit ? `<span class="num">${esc(String(s.last_edit).slice(0, 16))}</span>` : '—');
      const older = current && file.last_edit && current.last_edit && file.last_edit < current.last_edit;
      const m = modal(`<h2>استعادة من ملف</h2>
        <table class="tbl"><tr><th></th><th>الملف</th>${current ? '<th>الهاتف الآن</th>' : ''}</tr>
          <tr><td>آخر تعديل</td><td>${when(file)}</td>${current ? `<td>${when(current)}</td>` : ''}</tr>
          <tr><td>عدد العمليات</td><td class="num">${fmtN(file.entries)}</td>${current ? `<td class="num">${fmtN(current.entries)}</td>` : ''}</tr>
          <tr><td>آخر شهر</td><td>${file.last_month ? ymLabel(file.last_month) : '—'}</td>${current ? `<td>${current.last_month ? ymLabel(current.last_month) : '—'}</td>` : ''}</tr></table>
        ${older ? '<div class="box c-bad" style="margin-top:10px;font-size:13px">⚠ الملف <b>أقدم</b> من بيانات الهاتف: التعديلات الأحدث على الهاتف ستُستبدل. خذ نسخة احتياطية أولًا إن لم تكن نقلتها.</div>' : ''}
        <div class="mf"><button class="btn p" id="ok">${current ? 'استبدال بيانات الهاتف' : 'استعادة'}</button><button class="btn" data-close>إلغاء</button></div>`);
      $('#ok', m.el).onclick = async () => {
        try { await L.restore(buf); m.close(); toast('✓ استُعيدت البيانات'); await after(); } catch (e) { fail(e); }
      };
    });
  }

  // ---------- الإعداد الأول ----------
  function setup() {
    document.body.classList.add('setup');
    $('#view').innerHTML = `<div class="setup-wrap">
      <div class="setup-logo">₺</div>
      <h1>أهلًا 👋</h1>
      <p class="muted">لوحة الدفع على هاتفك: تعمل دون إنترنت، وكل بياناتك محفوظة على الهاتف.</p>
      ${isIOS && !standalone ? `<div class="card warnc"><h3>ثبّت التطبيق أولًا</h3>
        <p style="margin:0;font-size:13.5px">في Safari اضغط زر المشاركة <b>⬆︎</b> ثم «<b>إضافة إلى الشاشة الرئيسية</b>»، وافتح التطبيق من أيقونته. البيانات التي تُدخلها هنا في Safari لا تنتقل إلى التطبيق المثبّت.</p></div>` : ''}
      <div class="card"><h3>📂 نقل بياناتك من الكمبيوتر</h3>
        <p style="margin:0 0 10px;font-size:13.5px">على الكمبيوتر: المنصة ← الإعدادات ← تطبيق الهاتف ← «تصدير نسخة للهاتف». أرسل الملف إلى الآيفون (AirDrop أو iCloud Drive)، ثم اختره هنا.</p>
        <button class="btn p wide" id="restore">اختيار الملف</button></div>
      <div class="card"><button class="btn wide" id="empty">البدء ببيانات فارغة</button></div>
    </div>`;
    const done = async () => { document.body.classList.remove('setup'); await begin(); requestPersist(); };
    $('#restore').onclick = () => restoreFlow(done);
    $('#empty').onclick = async () => { await L.startEmpty(); await done(); };
  }

  async function requestPersist() {
    try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* غير مدعوم */ }
  }

  // ---------- صفحة «البيانات» في الإعدادات ----------
  async function phoneTab(el) {
    const s = L.status();
    let persisted = null, usage = null, version = '—';
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch { /* لا شيء */ }
    try { const e = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; usage = e && e.usage; } catch { /* لا شيء */ }
    try { version = (await fetch('version.json', { cache: 'no-store' }).then((r) => r.json())).version; } catch { /* دون اتصال */ }
    const late = daysSince(s.lastBackup) === null || daysSince(s.lastBackup) >= BACKUP_DAYS;

    el.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="card"><h3>💾 نسخة احتياطية / نقل إلى الكمبيوتر</h3>
        <p class="muted" style="margin:0 0 10px;font-size:13px">ملف واحد فيه كل بياناتك. احفظه في «الملفات» أو iCloud Drive، أو أرسله بـ AirDrop إلى الكمبيوتر ثم في المنصة: الإعدادات ← تطبيق الهاتف ← «استيراد نسخة من الهاتف».</p>
        <button class="btn p" id="bk">💾 نسخة احتياطية الآن</button>
        <p class="${late ? 'c-fx' : 'faint'}" style="font-size:12.5px;margin:10px 0 0">آخر نسخة: ${ago(s.lastBackup)}</p></div>

      <div class="card"><h3>↺ استعادة من ملف</h3>
        <p class="muted" style="margin:0 0 10px;font-size:13px">بعد استيراد Excel أو تعديلات على الكمبيوتر: «تصدير نسخة للهاتف» من المنصة، ثم اختر الملف هنا. يعرض المقارنة قبل الاستبدال.</p>
        <button class="btn" id="rs">↺ اختيار ملف</button></div>

      <div class="card"><h3>عن البيانات</h3>
        <div class="box" style="font-size:12.5px">⚠ حذف أيقونة التطبيق من الشاشة الرئيسية يحذف بياناته من الهاتف. احتفظ بنسخة احتياطية حديثة.</div>
        <div class="kv" style="margin-top:10px">
          <span>التخزين الدائم</span><div>${persisted ? '<span class="tag t-in">مفعّل</span>' : persisted === false ? '<span class="tag t-mu">غير مفعّل</span> <button class="btn sm" id="per">طلب التفعيل</button>' : '—'}</div>
          <span>المساحة المستخدمة</span><div class="num" style="text-align:start">${usage ? (usage / 1048576).toFixed(1) + ' MB' : '—'}</div>
          <span>إصدار التطبيق</span><div class="num" style="text-align:start">${esc(version)}</div>
        </div>
        <button class="btn danger sm" id="wipe" style="margin-top:12px">حذف بيانات التطبيق من هذا الهاتف</button></div>
    </div>`;

    const rerender = () => phoneTab(el);
    $('#bk', el).onclick = async () => { await saveBackup(); rerender(); };
    $('#rs', el).onclick = () => restoreFlow(async () => { await App.refresh(); });
    const per = $('#per', el);
    if (per) per.onclick = async () => { await requestPersist(); rerender(); };
    $('#wipe', el).onclick = async () => {
      if (!(await confirmBox('سيُحذف كل شيء من هذا الهاتف ولا يمكن التراجع. تأكد أن لديك نسخة احتياطية.', 'حذف', true))) return;
      await L.eraseAll(); location.reload();
    };
  }
  window.FPB_UI = { phoneTab };

  // ---------- البداية ----------
  async function begin() {
    await App.start();
    netbar();
    L.onChange(netbar);
    addEventListener('online', () => { netbar(); L.fillPending(); });
    addEventListener('offline', () => netbar());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { netbar(); L.fillPending(); } });
    L.fillPending();
  }

  (async () => {
    watchUpdates();
    try {
      const r = await L.boot();
      if (r.needsSetup) setup(); else await begin();
    } catch (e) {
      console.error(e);
      $('#view').innerHTML = `<div class="card empty"><h2>تعذر تشغيل التطبيق</h2><p>${esc(e.message)}</p></div>`;
    }
  })();
})();
