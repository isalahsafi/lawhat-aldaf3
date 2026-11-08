// واجهة تطبيق الهاتف: الإعداد الأول، شريط الحالة، المزامنة التلقائية، النسخ الاحتياطي، والتحديثات.
(() => {
  const L = window.FPB_LOCAL;
  const { $, $$, esc, toast, fail, confirmBox } = App;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  const ago = (iso) => {
    if (!iso) return 'لم تتم بعد';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'الآن';
    if (s < 3600) return `قبل ${Math.round(s / 60)} دقيقة`;
    if (s < 86400) return `قبل ${Math.round(s / 3600)} ساعة`;
    return `قبل ${Math.round(s / 86400)} يوم`;
  };
  const FIELD = { amount: 'المبلغ', status: 'الحالة', currency: 'العملة', name: 'الاسم', due_date: 'تاريخ الاستحقاق', tx_date: 'تاريخ العملية', note: 'الفئة', person: 'لمن', planned_amount: 'المبلغ المعتاد', budget: 'الميزانية', paid_amount: 'المدفوع' };
  const STATUS = { paid: 'مدفوع', partial: 'جزئي', unpaid: 'مستحق' };
  const val = (k, v) => (v == null || v === '' ? '—' : k === 'status' ? STATUS[v] || v : esc(v));

  // ---------- شريط الحالة أعلى الصفحة ----------
  function netbar(s = L.status()) {
    const el = $('#netbar');
    const bits = [];
    let cls = '';
    if (!s.online) { bits.push('⦸ دون اتصال · كل شيء محفوظ على الهاتف'); cls = 'off'; }
    if (s.syncing) bits.push('⟳ جارٍ المزامنة…');
    else if (s.paired && s.outbox) bits.push(`⇡ ${s.outbox} ${s.outbox === 1 ? 'عملية' : 'عمليات'} بانتظار المزامنة`);
    if (s.pendingRates) bits.push(`💱 ${s.pendingRates} بانتظار سعر الصرف`);
    if (s.conflicts.length) { bits.push(`⚠ ${s.conflicts.length} تعارض يحتاج قرارك`); cls = 'warn'; }
    else if (s.errors.length) { bits.push(`⚠ ${s.errors.length} عملية لم تُنفذ على الكمبيوتر`); cls = 'warn'; }
    else if (s.paired && s.lastError && s.online && s.outbox) bits.push('الكمبيوتر غير متاح الآن');
    el.className = 'netbar ' + cls + (bits.length ? '' : ' hidden');
    el.innerHTML = bits.map((b) => `<span>${b}</span>`).join('');
    el.onclick = () => { location.hash = '#/settings?tab=phone'; };
  }

  // ---------- المزامنة التلقائية ----------
  let lastAuto = 0;
  let refreshWanted = false;
  async function autoSync(force) {
    const s = L.status();
    if (!s.paired || !navigator.onLine) return;
    if (!force && Date.now() - lastAuto < 45e3) return;
    lastAuto = Date.now();
    const r = await L.sync();
    if (r.ok && r.changed) refreshSoon();
    if (r.ok && (r.conflicts || r.errors)) toast(r.conflicts ? 'المزامنة: يوجد تعارض يحتاج قرارك' : 'المزامنة: بعض العمليات لم تُنفذ', { error: true, ms: 7000 });
  }
  // تحديث الشاشة بالبيانات الجديدة دون مقاطعة نافذة مفتوحة
  function refreshSoon() {
    if (document.querySelector('.overlay')) { refreshWanted = true; return; }
    App.refresh();
  }
  setInterval(() => { if (refreshWanted && !document.querySelector('.overlay')) { refreshWanted = false; App.refresh(); } }, 1500);

  // ---------- التحديثات ----------
  function watchUpdates() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const offer = (w) => {
        if (!w || !navigator.serviceWorker.controller) return;
        const b = $('#updbar') || Object.assign(document.createElement('div'), { id: 'updbar', className: 'updbar' });
        b.innerHTML = '<span>✦ تحديث جديد جاهز</span><button class="btn sm p">تطبيق الآن</button>';
        document.body.appendChild(b);
        $('button', b).onclick = () => { b.innerHTML = '<span>جارٍ التحديث…</span>'; w.postMessage('skipWaiting'); };
      };
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
      });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  }

  // ---------- الإعداد الأول ----------
  function pairForm(prefix = '') {
    return `<label class="fl">عنوان الكمبيوتر</label>
      <input class="inp num" id="${prefix}url" dir="ltr" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="pc-name.tailxxxx.ts.net" style="text-align:left">
      <label class="fl">رمز الربط</label>
      <input class="inp num" id="${prefix}code" inputmode="numeric" maxlength="6" placeholder="6 أرقام" style="letter-spacing:6px;text-align:center;font-size:20px">
      <p class="faint" style="font-size:12px;margin:6px 0 0">تجدهما على الكمبيوتر: الإعدادات ← تطبيق الهاتف ← «ربط جهاز جديد».</p>
      <div class="err c-bad" id="${prefix}err" style="font-size:13px;margin-top:8px"></div>
      <button class="btn p wide" id="${prefix}go" style="margin-top:10px">ربط ونقل البيانات</button>`;
  }
  function bindPair(root, prefix, after) {
    const go = $(`#${prefix}go`, root);
    go.onclick = async () => {
      const err = $(`#${prefix}err`, root);
      err.textContent = '';
      go.disabled = true; go.textContent = 'جارٍ الربط ونقل البيانات…';
      try {
        await L.pair($(`#${prefix}url`, root).value, $(`#${prefix}code`, root).value, 'iPhone');
        await after();
      } catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = 'ربط ونقل البيانات'; }
    };
  }
  function pickFile(cb) {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = '.db,.sqlite,application/octet-stream,application/x-sqlite3';
    i.onchange = async () => { const f = i.files[0]; if (f) cb(await f.arrayBuffer(), f.name); };
    i.click();
  }

  function setup() {
    document.body.classList.add('setup');
    const view = $('#view');
    view.innerHTML = `<div class="setup-wrap">
      <div class="setup-logo">₺</div>
      <h1>أهلًا 👋</h1>
      <p class="muted">لوحة الدفع على هاتفك: تعمل دون إنترنت، وتتزامن مع المنصة على الكمبيوتر.</p>
      ${isIOS && !standalone ? `<div class="card warnc"><h3>ثبّت التطبيق أولًا</h3>
        <p style="margin:0;font-size:13.5px">في Safari اضغط زر المشاركة <b>⬆︎</b> ثم «<b>إضافة إلى الشاشة الرئيسية</b>»، وافتح التطبيق من أيقونته. البيانات التي تُدخلها هنا في Safari لا تنتقل إلى التطبيق المثبّت.</p></div>` : ''}
      <div class="card"><h3>🔗 الربط بالكمبيوتر</h3>${pairForm('s')}</div>
      <div class="card"><h3>أو</h3>
        <button class="btn wide" id="restore">↺ استعادة من نسخة احتياطية</button>
        <button class="btn wide" id="empty" style="margin-top:8px">البدء ببيانات فارغة (دون كمبيوتر)</button></div>
    </div>`;
    const done = async () => { document.body.classList.remove('setup'); await begin(); requestPersist(); };
    bindPair(view, 's', done);
    $('#restore', view).onclick = () => pickFile(async (buf) => {
      try { await L.startEmpty(); await L.restore(buf); await done(); toast('✓ استُعيدت النسخة'); } catch (e) { await L.eraseAll(); fail(e); }
    });
    $('#empty', view).onclick = async () => { await L.startEmpty(); await done(); };
  }

  async function requestPersist() {
    try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* غير مدعوم */ }
  }

  // ---------- صفحة «المزامنة والبيانات» في الإعدادات ----------
  async function phoneTab(el) {
    const s = L.status();
    let persisted = null, usage = null;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch { /* لا شيء */ }
    try { const e = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; usage = e && e.usage; } catch { /* لا شيء */ }
    let version = '—';
    try { const v = await fetch('version.json', { cache: 'no-store' }).then((r) => r.json()); version = v.version; } catch { /* دون اتصال */ }

    el.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="card"><h3>المزامنة مع الكمبيوتر</h3>
        ${s.paired ? `<div class="kv">
            <span>الكمبيوتر</span><div class="num" style="text-align:start;word-break:break-all">${esc(s.pc.url.replace('https://', ''))}</div>
            <span>آخر مزامنة</span><div>${ago(s.lastSync)}</div>
            <span>بانتظار الإرسال</span><div>${s.outbox ? `<b>${s.outbox}</b> ${s.outbox === 1 ? 'عملية' : 'عمليات'}` : 'لا شيء'}</div>
            ${s.pendingRates ? `<span>أسعار معلّقة</span><div>${s.pendingRates} · تُجلب عند الاتصال</div>` : ''}
          </div>
          ${s.lastError ? `<div class="box c-bad" style="margin-top:10px;font-size:13px">آخر محاولة (${ago(s.lastAttempt)}): ${esc(s.lastError)}</div>` : ''}
          <div class="row" style="margin-top:12px"><button class="btn p" id="syncNow" ${s.syncing ? 'disabled' : ''}>${s.syncing ? 'جارٍ المزامنة…' : '⟳ مزامنة الآن'}</button>
            <button class="btn danger" id="unpair">إلغاء الربط</button></div>
          <p class="faint" style="font-size:12px;margin:10px 0 0">تحدث تلقائيًا عند فتح التطبيق إذا كان الكمبيوتر متاحًا. Apple لا تسمح بالمزامنة والتطبيق مغلق.</p>`
        : `<p class="muted" style="margin:0 0 6px;font-size:13px">الهاتف غير مرتبط. اربطه لتنتقل بيانات الكمبيوتر إليه وتتزامن العمليات بينهما. <b>تحل بيانات الكمبيوتر محل بيانات الهاتف الحالية.</b></p>${pairForm('p')}`}
      </div>

      ${s.conflicts.length ? `<div class="card"><h3>⚠ تعارض يحتاج قرارك</h3>
        <p class="faint" style="font-size:12.5px;margin:0 0 8px">عُدّل نفس البند على الجهازين قبل المزامنة. اختر القيمة الصحيحة.</p>
        ${s.conflicts.map((c, i) => `<div class="box" style="margin-bottom:8px"><b>${esc(c.name || '')}</b>${c.ym ? ` <span class="faint">· ${App.ymLabel(c.ym)}</span>` : ''}
          ${c.fields.map((f) => `<div style="font-size:13px;margin-top:4px">${FIELD[f.key] || esc(f.key)}: 📱 <b class="num">${val(f.key, f.phone)}</b> · 💻 <b class="num">${val(f.key, f.pc)}</b></div>`).join('')}
          <div class="row" style="margin-top:8px"><button class="btn sm p" data-cf="${i}" data-pick="phone">اعتماد الآيفون</button><button class="btn sm" data-cf="${i}" data-pick="pc">اعتماد الكمبيوتر</button></div></div>`).join('')}</div>` : ''}

      ${s.errors.length ? `<div class="card"><h3>عمليات لم تُنفذ على الكمبيوتر</h3>
        ${s.errors.map((e, i) => `<div class="box" style="margin-bottom:8px;font-size:13px"><div>${esc(e.error)}</div>
          <div class="faint num" style="text-align:start;font-size:11.5px">${esc(e.op ? e.op.method + ' ' + e.op.path : '')} · ${ago(e.at)}</div>
          <button class="btn sm" data-er="${i}" style="margin-top:6px">تجاهل</button></div>`).join('')}</div>` : ''}

      <div class="card"><h3>النسخ الاحتياطي</h3>
        <p class="muted" style="margin:0 0 10px;font-size:13px">ملف واحد فيه كل بياناتك، احفظه في «الملفات» أو iCloud Drive.</p>
        <div class="row"><button class="btn p" id="bk">💾 نسخة احتياطية الآن</button><button class="btn" id="rs">↺ استعادة من ملف</button></div>
        <div class="box ${s.paired ? '' : 'c-bad'}" style="margin-top:10px;font-size:12.5px">⚠ حذف أيقونة التطبيق من الشاشة الرئيسية يحذف بياناته من الهاتف.${s.paired ? ' بياناتك محفوظة أيضًا على الكمبيوتر.' : ' احتفظ بنسخة احتياطية دائمًا.'}</div>
        <div class="kv" style="margin-top:10px">
          <span>التخزين الدائم</span><div>${persisted ? '<span class="tag t-in">مفعّل</span>' : persisted === false ? '<span class="tag t-mu">غير مفعّل</span> <button class="btn sm" id="per">طلب التفعيل</button>' : '—'}</div>
          <span>المساحة المستخدمة</span><div class="num" style="text-align:start">${usage ? (usage / 1048576).toFixed(1) + ' MB' : '—'}</div>
          <span>إصدار التطبيق</span><div class="num" style="text-align:start">${esc(version)}</div>
        </div>
        <button class="btn danger sm" id="wipe" style="margin-top:12px">حذف بيانات التطبيق من هذا الهاتف</button>
      </div>
    </div>`;

    const rerender = () => phoneTab(el);
    const sn = $('#syncNow', el);
    if (sn) sn.onclick = async () => {
      sn.disabled = true; sn.textContent = 'جارٍ المزامنة…';
      const r = await L.sync();
      if (r.ok) { toast(r.sent ? `✓ أُرسلت ${r.sent} ${r.sent === 1 ? 'عملية' : 'عمليات'} وتمت المزامنة` : '✓ تمت المزامنة'); await App.reloadBoot(); }
      else toast(esc(r.error), { error: true, ms: 7000 });
      rerender();
    };
    const up = $('#unpair', el);
    if (up) up.onclick = async () => {
      const n = L.status().outbox;
      if (!(await confirmBox(n ? `توجد ${n} عمليات لم تُرسل بعد إلى الكمبيوتر وستبقى على الهاتف فقط. إلغاء الربط؟` : 'إلغاء ربط الهاتف بالكمبيوتر؟ تبقى البيانات الحالية على الهاتف.', 'إلغاء الربط', true))) return;
      await L.unpair(); toast('أُلغي الربط'); rerender();
    };
    if ($('#pgo', el)) bindPair(el, 'p', async () => { toast('✓ تم الربط ونقل البيانات'); requestPersist(); await App.refresh(); });
    $$('[data-cf]', el).forEach((b) => b.onclick = async () => {
      try { await L.resolveConflict(Number(b.dataset.cf), b.dataset.pick); if (b.dataset.pick === 'phone') autoSync(true); toast('✓ تم'); await App.reloadBoot(); rerender(); } catch (e) { fail(e); }
    });
    $$('[data-er]', el).forEach((b) => b.onclick = async () => { await L.dismissError(Number(b.dataset.er)); rerender(); });
    $('#bk', el).onclick = async () => {
      const bytes = await L.backup();
      const name = `lawhat-aldaf3-${App.state.boot.today}.db`;
      const file = new File([bytes], name, { type: 'application/octet-stream' });
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
      } catch (e) { if (e.name === 'AbortError') return; }
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    };
    $('#rs', el).onclick = () => pickFile(async (buf) => {
      if (!(await confirmBox('استعادة النسخة تستبدل كل بيانات الهاتف الحالية. متابعة؟', 'استعادة', true))) return;
      try { await L.restore(buf); toast('✓ استُعيدت النسخة'); await App.refresh(); } catch (e) { fail(e); }
    });
    const per = $('#per', el);
    if (per) per.onclick = async () => { await requestPersist(); rerender(); };
    $('#wipe', el).onclick = async () => {
      if (!(await confirmBox('سيُحذف كل شيء من هذا الهاتف ولا يمكن التراجع.' + (L.status().paired ? ' بياناتك على الكمبيوتر لا تتأثر.' : ' تأكد أن لديك نسخة احتياطية.'), 'حذف', true))) return;
      await L.eraseAll(); location.reload();
    };
  }
  window.FPB_UI = { phoneTab };

  // ---------- البداية ----------
  async function begin() {
    await App.start();
    netbar();
    L.onChange(netbar);
    addEventListener('online', () => { netbar(); L.fillPending().then(() => autoSync(true)); });
    addEventListener('offline', () => netbar());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { netbar(); L.fillPending(); autoSync(); } });
    L.fillPending().then(() => autoSync(true));
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
