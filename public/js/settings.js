// الإعدادات: البنود، الأقسام، أسعار الصرف، البيانات، سجل التعديلات، الوصول.
(() => {
  const { $, $$, esc, state, get, post, patch, put, del, route, modal, toast, fail, confirmBox, ymLabel, fmtN, iconFor, LOCAL } = App;
  const REC = { monthly: 'شهري', quarterly: 'كل 3 أشهر', yearly: 'سنوي', once: 'مرة واحدة' };
  // على الهاتف: المزامنة والنسخ الاحتياطي بدل الاستيراد، ولا وصول من الشبكة
  const PHONE = !!window.FPB_LOCAL;
  const TABS = PHONE
    ? [['items', 'البنود'], ['sections', 'الأقسام'], ['rates', 'أسعار الصرف'], ['phone', 'المزامنة والبيانات'], ['audit', 'سجل التعديلات'], ['access', 'الحساب']]
    : [['items', 'البنود'], ['sections', 'الأقسام'], ['rates', 'أسعار الصرف'], ['data', 'البيانات والاستيراد'], ['audit', 'سجل التعديلات'], ['access', 'الحساب والوصول'], ['devices', 'تطبيق الهاتف']];
  // رابط تطبيق الهاتف المنشور على GitHub Pages
  const PHONE_APP_URL = 'https://isalahsafi.github.io/lawhat-aldaf3/';

  route('settings', async (view, r) => {
    App.killCharts();
    const tab = TABS.some(([k]) => k === r.query.tab) ? r.query.tab : 'items';
    view.innerHTML = `<div class="topbar"><h1>الإعدادات</h1></div>
      <div class="tabs">${TABS.map(([k, n]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('')}</div><div id="st"></div>`;
    $$('[data-tab]').forEach((b) => b.onclick = () => { location.hash = '#/settings?tab=' + b.dataset.tab; });
    ({ items, sections, rates, data, audit, access, devices, phone: (el) => window.FPB_UI.phoneTab(el) })[tab]($('#st'));
  });

  function items(el) {
    const secs = state.boot.sections.filter((s) => s.active);
    const people = state.boot.settings.people || [];
    el.innerHTML = `<p class="muted" style="margin-top:0">البنود المعتادة تُنشأ في كل شهر جديد. البند المتكرر (⟳) تديره فتراته من صفحته. الأسماء البديلة تساعد في البحث والاستيراد.</p>
      <div class="card" style="margin-bottom:12px"><h3>الأشخاص <span class="faint" style="font-weight:400">· لخيار «لمن؟» في المصاريف المتغيرة</span></h3>
        <div class="chips">${people.map((p) => `<button class="chip on" data-rmp="${esc(p)}" title="إزالة">${esc(p)} ✕</button>`).join('')}
          <input class="inp" id="newP" placeholder="＋ اسم ثم Enter" style="width:150px;padding:4px 10px;border-radius:99px"></div></div>
      ${secs.map((s) => {
        const list = state.boot.templates.filter((t) => t.section_id === s.id);
        const isVar = s.key === 'variable';
        return `<div class="sect" style="--c:${App.secColor(s)}"><div class="sect-h"><span class="bar"></span><strong>${esc(s.name)}</strong>${isVar ? '<span class="faint" style="font-size:12px">فئات الإضافة السريعة</span>' : ''}<button class="add ms" data-new="${s.id}">+ ${isVar ? 'فئة' : 'بند'}</button></div>
          <div class="tw"><table class="tbl set-tpl"><tr><th></th><th>الاسم</th>${isVar ? '' : '<th>العملة</th><th>المبلغ المعتاد</th><th>التكرار</th><th>يوم الاستحقاق</th>'}<th>أسماء بديلة</th>${isVar ? '<th>ميزانية شهرية</th><th>لمرة واحدة</th>' : '<th>نشط</th>'}<th></th></tr>
          ${list.map((t) => {
            const ser = state.boot.series.find((x) => x.template_id === t.id && x.status === 'active');
            return `<tr data-t="${t.id}"><td data-c="icon">${iconFor(t)}</td>
            <td data-c="name"><input class="inp" data-f="name" value="${esc(t.name)}" style="min-width:120px">${ser ? `<a class="recb" href="#/recurring/${ser.id}" style="display:block;margin-top:2px">⟳ متكرر بفترات</a>` : ''}</td>
            ${isVar ? '' : `<td data-c="cur"><select class="inp" data-f="currency"><option value="${LOCAL}" ${t.currency !== 'USD' ? 'selected' : ''}>₺</option><option value="USD" ${t.currency === 'USD' ? 'selected' : ''}>$</option></select></td>
            <td data-c="amt"><input class="inp num" data-f="planned_amount" value="${t.planned_amount ?? ''}" inputmode="decimal" placeholder="المبلغ المعتاد" style="width:100px"></td>
            <td data-c="rec"><select class="inp" data-f="recurrence">${Object.entries(REC).map(([k, v]) => `<option value="${k}" ${t.recurrence === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
              ${t.recurrence === 'yearly' || t.recurrence === 'quarterly' ? `<select class="inp" data-f="due_month" style="margin-top:4px">${App.MONTHS.map((m, i) => `<option value="${i + 1}" ${t.due_month === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select>` : ''}</td>
            <td data-c="day"><input class="inp num" data-f="due_day" value="${t.due_day ?? ''}" inputmode="numeric" placeholder="يوم" style="width:60px"></td>`}
            <td data-c="alias"><input class="inp" data-f="aliases" value="${esc(t.aliases)}" placeholder="أسماء بديلة" style="min-width:160px"></td>
            ${isVar ? `<td data-c="amt"><input class="inp num" data-f="budget" value="${t.budget ?? ''}" inputmode="decimal" placeholder="—" style="width:100px"></td>
              <td data-c="act"><button class="switch ${t.one_off_default ? 'on' : ''}" data-oneoff title="عملياتها تُعلَّم «لمرة واحدة» تلقائيًا"></button></td>`
              : `<td data-c="act"><button class="switch ${t.active ? 'on' : ''}" data-active></button></td>`}
            <td data-c="rm"><button class="btn sm ghost danger" data-rm title="حذف">🗑</button></td></tr>`;
          }).join('')}</table></div></div>`;
      }).join('')}`;
    $$('tr[data-t]', el).forEach((tr) => {
      const id = Number(tr.dataset.t);
      $$('[data-f]', tr).forEach((f) => f.onchange = async () => {
        let v = f.value;
        if (['planned_amount', 'due_day', 'due_month', 'budget'].includes(f.dataset.f)) v = v === '' ? null : Number(Calc.evalAmount(v));
        try {
          if (f.dataset.f === 'recurrence' && (v === 'yearly' || v === 'quarterly')) await patch('/api/templates/' + id, { due_month: new Date().getMonth() + 1 });
          await patch('/api/templates/' + id, { [f.dataset.f]: v }); await App.reloadBoot(); if (f.dataset.f === 'recurrence') items(el); toast('حُفظ ✓', { ms: 1500 });
        } catch (e) { fail(e); }
      });
      const a = $('[data-active]', tr);
      if (a) a.onclick = async () => { const on = !a.classList.contains('on'); await patch('/api/templates/' + id, { active: on ? 1 : 0 }); a.classList.toggle('on', on); App.reloadBoot(); };
      const oo = $('[data-oneoff]', tr);
      if (oo) oo.onclick = async () => { const on = !oo.classList.contains('on'); await patch('/api/templates/' + id, { one_off_default: on ? 1 : 0 }); oo.classList.toggle('on', on); App.reloadBoot(); };
      $('[data-rm]', tr).onclick = async () => {
        if (!(await confirmBox('حذف هذا البند؟ إن كان مستخدمًا سيُوقف فقط.', 'حذف', true))) return;
        const r = await del('/api/templates/' + id); await App.reloadBoot(); items(el); toast(r.archived ? 'أُوقف البند (مستخدم سابقًا)' : 'حُذف البند');
      };
    });
    const savePeople = async (list) => { await put('/api/settings', { people: list }); await App.reloadBoot(); items(el); };
    $$('[data-rmp]', el).forEach((b) => b.onclick = () => savePeople(people.filter((p) => p !== b.dataset.rmp)));
    $('#newP', el).onkeydown = (ev) => { const v = ev.target.value.trim(); if (ev.key === 'Enter' && v) savePeople([...people, v]); };
    $$('[data-new]', el).forEach((b) => b.onclick = () => {
      const sid = Number(b.dataset.new);
      const m = modal(`<h2>بند جديد <button class="x" data-close>✕</button></h2>
        <label class="fl">الاسم</label><input class="inp" id="n">
        <label class="fl">أيقونة (رمز تعبيري أو حرف)</label><input class="inp" id="i" placeholder="💡 أو N" maxlength="4">
        <label class="fl">لون (للحرف، اختياري)</label><input class="inp" id="c" type="color" value="#3b5bdb" style="height:40px;padding:4px">
        <div class="mf"><button class="btn p" id="ok">إضافة</button></div>`);
      $('#ok', m.el).onclick = async () => {
        const name = $('#n', m.el).value.trim(); if (!name) return;
        const icon = $('#i', m.el).value.trim();
        const letter = icon && /^[A-Za-z0-9]{1,2}$/.test(icon);
        await post('/api/templates', { section_id: sid, name, icon, color: letter ? $('#c', m.el).value : '', aliases: name, currency: state.boot.settings.base_currency || LOCAL,
          active: state.boot.sections.find((s) => s.id === sid).key === 'variable' ? 0 : 1 });
        m.close(); await App.reloadBoot(); items(el);
      };
    });
  }

  function sections(el) {
    el.innerHTML = `<div class="card"><div class="tw"><table class="tbl"><tr><th>الأيقونة</th><th>الاسم</th><th>النوع</th><th>اللون</th><th>نشط</th><th></th></tr>
      ${state.boot.sections.map((s) => `<tr data-s="${s.id}"><td><input class="inp" data-f="icon" value="${esc(s.icon)}" style="width:56px;text-align:center"></td>
        <td><input class="inp" data-f="name" value="${esc(s.name)}"></td><td>${s.kind === 'income' ? '<span class="c-in">دخل</span>' : '<span class="c-ex">مصروف</span>'}</td>
        <td><input type="color" data-f="color" value="${esc(s.color)}" style="width:40px;height:30px;border:0;background:none"></td>
        <td><button class="switch ${s.active ? 'on' : ''}" data-active></button></td>
        <td>${s.key ? '<span class="faint" style="font-size:12px">أساسي</span>' : '<button class="btn sm ghost danger" data-rm>🗑</button>'}</td></tr>`).join('')}
      </table></div><div class="row" style="margin-top:12px"><button class="btn p" id="add">+ قسم جديد</button></div></div>`;
    $$('tr[data-s]', el).forEach((tr) => {
      const id = tr.dataset.s;
      $$('[data-f]', tr).forEach((f) => f.onchange = async () => { await patch('/api/sections/' + id, { [f.dataset.f]: f.value }); await App.reloadBoot(); toast('حُفظ ✓', { ms: 1500 }); });
      $('[data-active]', tr).onclick = async (ev) => { const on = !ev.target.classList.contains('on'); await patch('/api/sections/' + id, { active: on ? 1 : 0 }); await App.reloadBoot(); sections(el); };
      const rm = $('[data-rm]', tr); if (rm) rm.onclick = async () => { if (await confirmBox('حذف القسم؟', 'حذف', true)) { await del('/api/sections/' + id); await App.reloadBoot(); sections(el); } };
    });
    $('#add', el).onclick = () => {
      const m = modal(`<h2>قسم جديد <button class="x" data-close>✕</button></h2>
        <label class="fl">الاسم</label><input class="inp" id="n" placeholder="مثل: تعليم، سيارة">
        <label class="fl">النوع</label><div class="chips"><button class="chip on" data-k="expense">مصروف</button><button class="chip" data-k="income">دخل</button></div>
        <label class="fl">أيقونة</label><input class="inp" id="i" value="📌" maxlength="4">
        <label class="fl">اللون</label><input type="color" id="c" value="#0c8599" style="width:60px;height:36px">
        <div class="mf"><button class="btn p" id="ok">إضافة</button></div>`);
      let kind = 'expense';
      $$('[data-k]', m.el).forEach((b) => b.onclick = () => { kind = b.dataset.k; $$('[data-k]', m.el).forEach((x) => x.classList.toggle('on', x === b)); });
      $('#ok', m.el).onclick = async () => {
        const name = $('#n', m.el).value.trim(); if (!name) return;
        await post('/api/sections', { name, kind, icon: $('#i', m.el).value, color: $('#c', m.el).value });
        m.close(); await App.reloadBoot(); sections(el);
      };
    };
  }

  function rates(el) {
    const s = state.boot.settings;
    const months = [...state.boot.months].sort((a, b) => b.ym.localeCompare(a.ym));
    el.innerHTML = `<div class="card" style="margin-bottom:12px"><h3>طريقة سعر الأشهر الجديدة</h3>
        <div class="chips"><button class="chip ${s.default_method === 'avg' ? 'on' : ''}" data-m="avg">متوسط الشهر</button><button class="chip ${s.default_method === 'end' ? 'on' : ''}" data-m="end">سعر آخر يوم في الشهر</button></div>
        <p class="faint" style="font-size:12.5px;margin:10px 0 0">المصدر: أسعار البنك المركزي الأوروبي (Frankfurter)، واحتياطيًا currency-api. سعر كل شهر يُقفل عند انتهائه فلا تتغير حساباته.</p></div>
      <div class="card tw" style="padding:6px 8px"><table class="tbl"><tr><th>الشهر</th><th>1 $ =</th><th>الطريقة</th><th>الحالة</th><th></th></tr>
        ${months.map((m) => `<tr><td>${ymLabel(m.ym)}</td><td class="num c-fx">${m.rate ? fmtN(m.rate, 4) + ' ₺' : '<span class="c-bad">غير محدد</span>'}</td>
          <td>${m.rate ? { avg: 'متوسط', end: 'آخر يوم', manual: 'يدوي' }[m.rate_method] || '' : ''}</td><td>${m.rate_locked ? '🔒 مقفل' : m.rate ? '<span class="c-fx">يتحدث حتى نهاية الشهر</span>' : ''}</td>
          <td><a class="btn sm" href="#/month/${m.ym}">${m.rate ? 'فتح' : 'أدخل السعر'}</a></td></tr>`).join('')}</table></div>`;
    $$('[data-m]', el).forEach((b) => b.onclick = async () => { await put('/api/settings', { default_method: b.dataset.m }); await App.reloadBoot(); rates(el); });
  }

  async function data(el) {
    const backups = await get('/api/backups');
    el.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="card"><h3>استيراد من Excel</h3><p class="muted" style="margin:0 0 12px;font-size:13px">يتعرف على جداول الأشهر والعمليات وقوائم الديون، ويعرض معاينة قبل الاعتماد، ويمنع التكرار.</p>
        <a class="btn p" href="#/import">📥 استيراد ملف</a></div>
      <div class="card"><h3>تصدير</h3><div class="row"><a class="btn" href="/api/export.xlsx">⇩ Excel</a><a class="btn" href="/api/export.json">⇩ JSON (نسخة كاملة)</a><button class="btn" onclick="location.hash='#/reports';setTimeout(print,700)">⇩ تقرير PDF</button></div></div>
      <div class="card"><h3>النسخ الاحتياطي</h3><p class="muted" style="margin:0 0 10px;font-size:13px">نسخة يومية تلقائية، ويُحتفظ بآخر 30 نسخة.</p>
        <button class="btn p" id="bk">نسخة احتياطية الآن</button>
        <div style="max-height:200px;overflow:auto;margin-top:10px;font-size:12px" class="faint">${backups.map((b) => `<div class="num" style="text-align:start">${esc(b.file)} · ${Math.round(b.size / 1024)} KB</div>`).join('')}</div></div>
      <div class="card"><h3>مجلد البيانات</h3><div class="num faint" style="font-size:12px;text-align:start;white-space:normal;word-break:break-all">${esc(state.boot.settings.data_dir)}</div>
        <p class="faint" style="font-size:12px">انسخ هذا المجلد لنقل كل بياناتك إلى جهاز آخر.</p></div>
    </div>`;
    $('#bk', el).onclick = async () => { const r = await post('/api/backup'); toast('✓ ' + esc(r.file)); data(el); };
  }

  async function audit(el) {
    const list = await get('/api/audit');
    el.innerHTML = `<div class="card tw" style="padding:6px 8px"><table class="tbl"><tr><th>الوقت</th><th>التعديل</th><th></th></tr>
      ${list.map((a) => `<tr class="audit-row ${a.undone ? 'undone' : ''}"><td class="num faint" style="font-size:12px">${esc(a.at)}</td><td style="white-space:normal">${esc(a.summary)}</td>
        <td>${!a.undone && a.action === 'batch' ? `<button class="btn sm" data-u="${a.id}">تراجع</button>` : a.undone ? '<span class="faint" style="font-size:12px">تم التراجع</span>' : ''}</td></tr>`).join('')}</table></div>`;
    $$('[data-u]', el).forEach((b) => b.onclick = async () => { try { await post(`/api/audit/${b.dataset.u}/undo`); toast('تم التراجع ✓'); await App.reloadBoot(); audit(el); } catch (e) { fail(e); } });
  }

  function access(el) {
    const s = state.boot.settings;
    const dark = document.documentElement.dataset.theme === 'dark';
    el.innerHTML = `<div class="card"><div class="kv">
      <span>اسمك</span><div><input class="inp" id="un" value="${esc(s.user_name)}" style="max-width:240px"></div>
      <span>العملة الأساسية</span><div class="chips"><button class="chip ${s.base_currency !== 'USD' ? 'on' : ''}" data-base="${LOCAL}">الليرة التركية</button><button class="chip ${s.base_currency === 'USD' ? 'on' : ''}" data-base="USD">الدولار</button></div>
      <span>الوضع الداكن</span><div><button class="switch ${dark ? 'on' : ''}" id="th"></button></div>
      <span>إخفاء المبالغ</span><div><button class="switch ${document.body.classList.contains('priv') ? 'on' : ''}" id="pv"></button> <span class="faint" style="font-size:12px">تظهر عند المرور عليها</span></div>
      ${PHONE ? '' : `<span>الوصول من الهاتف</span><div><button class="switch ${s.lan_enabled ? 'on' : ''}" id="lan"></button> <span class="faint" style="font-size:12px">عبر نفس شبكة Wi-Fi · يتطلب إعادة تشغيل المنصة</span></div>
      <span>رمز PIN</span><div class="row"><input class="inp" id="pin" type="password" inputmode="numeric" placeholder="${s.pin_set ? 'معيّن · اكتب رمزًا جديدًا لتغييره' : '4 إلى 8 أرقام'}" style="max-width:240px"><button class="btn" id="savePin">حفظ</button>${s.pin_set ? '<button class="btn danger" id="clrPin">إزالة</button>' : ''}</div>
      ${s.lan_enabled ? `<span>العنوان من الهاتف</span><div>${s.lan_urls.map((u) => `<div class="num" style="text-align:start">${esc(u)}</div>`).join('') || '<span class="faint">لا توجد شبكة</span>'}</div>` : ''}`}
    </div>${PHONE ? '' : '<p class="faint" style="font-size:12.5px;margin:14px 0 0">على هذا الجهاز لا يُطلب الرمز. من الهاتف يُطلب مرة واحدة. لتطبيق الآيفون الذي يعمل دون إنترنت: تبويب «تطبيق الهاتف».</p>'}</div>`;
    $('#un', el).onchange = async () => { await put('/api/settings', { user_name: $('#un', el).value }); await App.reloadBoot(); toast('حُفظ ✓', { ms: 1500 }); };
    $$('[data-base]', el).forEach((b) => b.onclick = async () => { await put('/api/settings', { base_currency: b.dataset.base }); App.state.display = b.dataset.base; localStorage.setItem('display', b.dataset.base); await App.reloadBoot(); access(el); });
    $('#th', el).onclick = () => { $('#themeBtn').click(); access(el); };
    $('#pv', el).onclick = () => { $('#privBtn').click(); access(el); };
    if (PHONE) return;
    $('#lan', el).onclick = async () => {
      if (!s.lan_enabled && !s.pin_set) { toast('عيّن رمز PIN أولًا', { error: true }); return; }
      await put('/api/settings', { lan_enabled: !s.lan_enabled }); await App.reloadBoot(); access(el);
      toast('أغلق نافذة المنصة وشغّلها من جديد لتطبيق التغيير', { ms: 8000 });
    };
    $('#savePin', el).onclick = async () => { try { await put('/api/settings', { pin: $('#pin', el).value }); await App.reloadBoot(); access(el); toast('حُفظ الرمز ✓'); } catch (e) { fail(e); } };
    const c = $('#clrPin', el); if (c) c.onclick = async () => { await put('/api/settings', { pin: '', lan_enabled: false }); await App.reloadBoot(); access(el); };
  }

  // ---------- تطبيق الهاتف (على الكمبيوتر): العنوان الآمن وربط الأجهزة ----------
  let pairTimer = null;
  async function devices(el) {
    clearInterval(pairTimer);
    el.innerHTML = '<div class="spinner"></div>';
    let info;
    try { info = await get('/api/sync/info'); } catch (e) { el.innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
    const ts = info.tailscale || {};
    const p = (t) => `<p style="margin:0;font-size:13.5px">${t}</p>`;
    const step = (ok, n, title, body) => `<div class="card" style="margin-bottom:12px"><h3>${ok ? '✓' : n} · ${title}</h3>${body}</div>`;
    const s1 = !ts.installed ? p('ثبّت Tailscale من <b class="num">tailscale.com/download</b> على هذا الكمبيوتر، ومن App Store على الآيفون، وسجّل الدخول بنفس الحساب على الجهازين. ثم افتح هذه الصفحة من جديد.')
      : !ts.running ? p('Tailscale مثبّت لكنه غير متصل. شغّله وسجّل الدخول، ثم افتح هذه الصفحة من جديد.')
        : p(`متصل باسم <b class="num">${esc(ts.name || '')}</b>. تأكد أن Tailscale متصل على الآيفون أيضًا.`);
    const s2 = ts.serving ? p(`المنصة متاحة لأجهزتك فقط على <b class="num">${esc(ts.url)}</b>`)
      : `${p('يمرر Tailscale المنصة عبر عنوان آمن (https) لا يصل إليه إلا أجهزتك.')}<button class="btn p" id="serve" style="margin-top:10px">تفعيل العنوان الآمن</button>
        <pre id="serveOut" class="num" style="display:none;white-space:pre-wrap;text-align:left;direction:ltr;font-size:12px;background:var(--surface-2);border-radius:10px;padding:10px;margin:10px 0 0"></pre>`;
    const s3 = PHONE_APP_URL ? p(`افتح <b class="num">${esc(PHONE_APP_URL)}</b> في Safari على الآيفون ← زر المشاركة ← «إضافة إلى الشاشة الرئيسية»، ثم افتحه من أيقونته.`)
      : p('يظهر رابط التطبيق هنا بعد نشره على GitHub.');
    el.innerHTML = `<p class="muted" style="margin-top:0">تطبيق الآيفون يحمل نسخة كاملة من بياناتك ويعمل دون إنترنت، ويتزامن مع هذه المنصة عبر اتصال آمن (Tailscale).</p>
      ${step(ts.installed && ts.running, '1', 'Tailscale على الكمبيوتر والآيفون', s1)}
      ${step(ts.serving, '2', 'العنوان الآمن للمنصة', ts.running ? s2 : p('يُفعَّل من هنا بعد تشغيل Tailscale.'))}
      ${step(false, '3', 'تثبيت التطبيق على الآيفون', s3)}
      <div class="card" style="margin-bottom:12px"><h3>ربط جهاز جديد</h3><div id="pairBox"><button class="btn p" id="newPair" ${ts.serving ? '' : 'disabled'}>إنشاء رمز ربط</button>
        ${ts.serving ? '' : '<span class="faint" style="font-size:12.5px;margin-inline-start:8px">يتطلب العنوان الآمن أولًا</span>'}</div></div>
      <div class="card"><h3>الأجهزة المرتبطة</h3>${info.devices.length
        ? `<table class="tbl">${info.devices.map((d) => `<tr><td>📱 ${esc(d.name)}</td><td class="faint" style="font-size:12.5px">آخر اتصال: ${esc(new Date(d.lastSeen).toLocaleString('ar'))}</td><td><button class="btn sm danger" data-rev="${esc(d.id)}">إلغاء الربط</button></td></tr>`).join('')}</table>`
        : '<p class="faint" style="margin:0">لا توجد أجهزة.</p>'}</div>`;

    const sv = $('#serve', el);
    if (sv) sv.onclick = async () => {
      sv.disabled = true; sv.textContent = 'جارٍ التفعيل…';
      try {
        const r = await post('/api/sync/serve');
        if (r.tailscale && r.tailscale.serving) { toast('✓ فُعّل العنوان الآمن'); devices(el); return; }
        const o = $('#serveOut', el); o.style.display = 'block'; o.textContent = r.output || 'لم يكتمل التفعيل';
        sv.disabled = false; sv.textContent = 'إعادة المحاولة';
        toast('إن ظهر رابط: افتحه لتفعيل HTTPS في حساب Tailscale، ثم أعد المحاولة', { ms: 9000 });
      } catch (e) { fail(e); sv.disabled = false; sv.textContent = 'تفعيل العنوان الآمن'; }
    };
    const np = $('#newPair', el);
    if (np) np.onclick = async () => {
      try {
        const r = await post('/api/sync/pair-code');
        const box = $('#pairBox', el);
        const tick = () => {
          const left = Math.max(0, Math.round((r.expires - Date.now()) / 1000));
          if (!left || !document.body.contains(box)) { clearInterval(pairTimer); if (document.body.contains(box)) devices(el); return; }
          box.innerHTML = `<p style="margin:0 0 8px;font-size:13.5px">في التطبيق على الآيفون أدخل:</p>
            <div class="kv"><span>عنوان الكمبيوتر</span><b class="num" style="text-align:start;word-break:break-all">${esc(((r.tailscale && r.tailscale.url) || '').replace('https://', ''))}</b>
            <span>رمز الربط</span><b class="num" style="text-align:start;font-size:28px;letter-spacing:6px">${r.code}</b></div>
            <p class="faint" style="font-size:12px;margin:8px 0 0">صالح ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · لمرة واحدة</p>`;
        };
        tick(); pairTimer = setInterval(tick, 1000);
      } catch (e) { fail(e); }
    };
    $$('[data-rev]', el).forEach((b) => b.onclick = async () => {
      if (!(await confirmBox('إلغاء ربط هذا الجهاز؟ لن يتمكن من المزامنة حتى يُربط من جديد.', 'إلغاء الربط', true))) return;
      await del('/api/sync/devices/' + b.dataset.rev); devices(el);
    });
  }
})();
