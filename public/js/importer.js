// شاشة الاستيراد من Excel: رفع ← تحليل ← معاينة ← اعتماد.
(() => {
  const { $, $$, esc, state, get, post, route, toast, fail, confirmBox, LOCAL, ymLabel, fmtN, money, dateLabel } = App;
  const TYPES = { months: 'جدول أشهر', transactions: 'عمليات يومية', ignore: 'تجاهل' };
  const ROLES = {
    months: { month: 'الشهر', item: 'بند موجود', new: 'بند جديد', ignore: 'تجاهل' },
    transactions: { date: 'التاريخ', amount: 'المبلغ', desc: 'الوصف', category: 'التصنيف', currency: 'العملة', kind: 'النوع (دخل/مصروف)', ignore: 'تجاهل' },
    debts: { party: 'الطرف', amount: 'المبلغ', paid: 'المسدد', date: 'التاريخ', currency: 'العملة', direction: 'النوع/الاتجاه', note: 'ملاحظة', ignore: 'تجاهل' },
  };
  const SECTIONS = { income: 'الدخل', basic: 'المصاريف الأساسية', subs: 'الاشتراكات', debts: 'أقساط وديون' };
  let S = null; // حالة الجلسة

  route('import', async (view) => {
    App.killCharts();
    S = { step: 'upload', analysis: null, decisions: null, preview: null, choices: { conflicts: {}, suggestions: [], manualRates: {}, force: [] }, filter: 'all', limit: 150 };
    draw(view);
  });

  function draw(view = $('#view')) {
    if (S.step === 'upload') return drawUpload(view);
    if (S.step === 'analysis') return drawAnalysis(view);
    if (S.step === 'preview') return drawPreview(view);
    if (S.step === 'done') return drawDone(view);
  }
  const head = (step) => `<div class="topbar"><a class="btn icon" href="#/settings?tab=data">›</a><h1>استيراد من Excel</h1></div>
    <div class="steps" style="max-width:520px"><span class="on"></span><span class="${step >= 2 ? 'on' : ''}"></span><span class="${step >= 3 ? 'on' : ''}"></span></div>
    <div class="stepcap" style="max-width:520px"><span class="${step === 1 ? 'b' : ''}">${step === 1 ? '<b>الملف</b>' : 'الملف'}</span><span>${step === 2 ? '<b>التحليل</b>' : 'التحليل'}</span><span>${step === 3 ? '<b>المعاينة</b>' : 'المعاينة'}</span></div>`;

  // ---------- 1. الرفع ----------
  async function drawUpload(view) {
    let imports = [];
    try { imports = await get('/api/imports'); } catch { /* اختياري */ }
    view.innerHTML = `${head(1)}
      <div class="grid" style="grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)">
        <div class="card">
          <label class="drop" id="drop"><span style="font-size:34px">📄</span><b>اسحب ملف Excel هنا</b>أو اضغط للاختيار · ‎.xlsx ‎.csv<input type="file" id="file" accept=".xlsx,.csv" hidden></label>
          <div id="up" style="margin-top:10px"></div>
          <ul class="muted" style="font-size:12.5px;padding-inline-start:18px;margin:14px 0 0">
            <li>يتعرف تلقائيًا على: جدول أشهر (صف لكل شهر وعمود لكل بند)، عمليات يومية (تاريخ ومبلغ ووصف)، وقوائم الديون.</li>
            <li>الملف الأصلي لا يُعدَّل، وتُحفظ نسخة منه في مجلد البيانات.</li>
            <li>المكرر لا يُضاف مرتين، والتعارض لا يُستبدل إلا بقرارك. والاستيراد كله يمكن التراجع عنه.</li>
            <li>المبالغ تُحسب بسعر صرف شهرها أو يومها، وتُحفظ كمدفوعة.</li>
          </ul>
        </div>
        <div class="card"><h3>استيرادات سابقة</h3>${imports.length ? `<table class="tbl">${imports.map((i) => {
          const st = (() => { try { return JSON.parse(i.summary); } catch { return {}; } })();
          return `<tr><td style="white-space:normal">📗 ${esc(i.file_name)}<div class="faint" style="font-size:11.5px">${esc(i.created_at)} · ${st.added || 0} جديد${st.debts ? ' · ' + st.debts + ' ديون' : ''}</div></td>
            <td>${i.undone ? '<span class="faint" style="font-size:12px">تم التراجع</span>' : i.audit_id ? `<button class="btn sm" data-undo="${i.audit_id}">تراجع</button>` : ''}</td></tr>`;
        }).join('')}</table>` : '<p class="muted" style="margin:0">لا شيء بعد</p>'}</div>
      </div>`;
    const drop = $('#drop'), input = $('#file');
    input.onchange = () => input.files[0] && upload(input.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) upload(f); };
    $$('[data-undo]').forEach((b) => b.onclick = async () => {
      if (!(await confirmBox('التراجع عن هذا الاستيراد بالكامل؟ يُحذف كل ما أضافه وتعود البنود التي عدّلها.', 'تراجع', true))) return;
      try { await post(`/api/audit/${b.dataset.undo}/undo`); toast('تم التراجع عن الاستيراد'); await App.reloadBoot(); draw(); } catch (e) { fail(e); }
    });
  }

  async function upload(file) {
    $('#up').innerHTML = `<div class="row"><div class="spinner" style="margin:0;width:18px;height:18px"></div> جارٍ تحليل «${esc(file.name)}»…</div>`;
    try {
      const buf = await file.arrayBuffer();
      S.analysis = await App.api('POST', '/api/import/analyze?name=' + encodeURIComponent(file.name), buf, true);
      S.decisions = { sheets: {} };
      for (const s of S.analysis.sheets) S.decisions.sheets[s.name] = { type: s.type, currency: s.currency || LOCAL, negative: 'expense', columns: s.columns.map((c) => ({ ...c })), partyDirections: {} };
      S.step = 'analysis';
      draw();
    } catch (e) { $('#up').innerHTML = `<div class="errline">${esc(e.message)}</div>`; }
  }

  // ---------- 2. التحليل ----------
  function tplOptions(sel) {
    return state.boot.sections.filter((s) => s.key !== 'variable').map((sec) => {
      const ts = state.boot.templates.filter((t) => t.section_id === sec.id);
      return ts.length ? `<optgroup label="${esc(sec.name)}">${ts.map((t) => `<option value="${t.id}" ${Number(sel) === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>` : '';
    }).join('');
  }
  function colCard(sheet, d, st) {
    const c = d.columns.find((x) => x.i === st.i) || { i: st.i, role: 'ignore' };
    const roles = ROLES[d.type] || {};
    const role = c.role === 'ask' ? 'ask' : c.role;
    let extra = '';
    if (d.type === 'months' && role === 'item') extra = `<select class="inp" data-tpl style="margin-top:4px">${tplOptions(c.template_id)}</select>`;
    if (d.type === 'months' && (role === 'new' || role === 'ask')) extra = `<input class="inp" data-name value="${esc(c.name || st.header)}" style="margin-top:4px">
      <select class="inp" data-sec style="margin-top:4px">${Object.entries(SECTIONS).map(([k, v]) => `<option value="${k}" ${(c.section || (c.suggest === 'debt' ? 'debts' : 'basic')) === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    if (['item', 'new', 'ask', 'amount'].includes(role)) extra += `<select class="inp" data-ccur style="margin-top:4px"><option value="">عملة الورقة</option><option value="${LOCAL}" ${c.currency === LOCAL ? 'selected' : ''}>₺</option><option value="USD" ${c.currency === 'USD' ? 'selected' : ''}>$ دولار</option></select>`;
    return `<div class="cm ${role === 'ask' ? 'ask' : role === 'ignore' ? 'skip' : ''}" data-col="${st.i}">
      <div class="src"><b>${esc(st.header)}</b><i>${esc((st.sample || []).join('، '))}</i></div>
      <select class="inp" data-role>${role === 'ask' ? '<option value="ask" selected>⚠ اختر: بند جديد أم موجود؟</option>' : ''}${Object.entries(roles).map(([k, v]) => `<option value="${k}" ${k === role ? 'selected' : ''}>${v}</option>`).join('')}</select>${extra}
      ${c.reason && role === 'ignore' ? `<div class="faint" style="font-size:11px;margin-top:3px">${esc(c.reason)}</div>` : ''}</div>`;
  }

  function drawAnalysis(view) {
    const a = S.analysis;
    view.innerHTML = `${head(2)}
      <div class="card" style="margin-bottom:12px"><b>📗 ${esc(a.fileName)}</b> · ${a.sheets.length} أوراق. راجع نوع كل ورقة وربط أعمدتها. الأصفر يحتاج قرارك.</div>
      ${a.sheets.map((s) => {
        const d = S.decisions.sheets[s.name];
        return `<div class="sheetc" data-sheet="${esc(s.name)}">
          <div class="sheetc-h"><b>📄 ${esc(s.name)}</b>
            <select class="inp" data-type style="width:auto">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === d.type ? 'selected' : ''}>${v}</option>`).join('')}</select>
            <span class="conf ${s.confidence}">● ${{ high: 'تعرّف مؤكد', medium: 'تعرّف مرجّح', low: 'تعرّف غير مؤكد' }[s.confidence]}</span>
            <span class="ms faint" style="font-size:12px">${s.rowCount} صفًا</span></div>
          ${s.issues.length ? `<div class="sopts faint">${s.issues.map(esc).join(' · ')}</div>` : ''}
          ${d.type === 'ignore' ? '' : `<div class="sopts" style="padding-top:10px">
            <span ${s.askCurrency ? 'style="color:var(--warn);font-weight:600"' : ''}>${s.askCurrency ? '⚠ ' : ''}عملة المبالغ في هذه الورقة:</span>
            <span class="chips"><button class="chip ${d.currency !== 'USD' ? 'on' : ''}" data-scur="${LOCAL}">₺</button><button class="chip ${d.currency === 'USD' ? 'on' : ''}" data-scur="USD">$ دولار</button></span>
            ${d.type === 'transactions' ? `<span>المبالغ السالبة:</span><span class="chips"><button class="chip ${d.negative !== 'income' ? 'on' : ''}" data-neg="expense">مصروف</button><button class="chip ${d.negative === 'income' ? 'on' : ''}" data-neg="income">دخل</button></span>` : ''}
          </div>
          <div class="colmap">${s.stats.filter((st) => st.filled).map((st) => colCard(s, d, st)).join('')}</div>`}
        </div>`;
      }).join('')}
      <div class="errline" id="err"></div>
      <div class="mf" style="max-width:420px"><button class="btn p" id="next">المعاينة ←</button><button class="btn" id="back">ملف آخر</button></div>`;
    bindAnalysis(view);
  }

  function bindAnalysis(view) {
    $$('[data-sheet]', view).forEach((box) => {
      const name = box.dataset.sheet;
      const d = S.decisions.sheets[name];
      const s = S.analysis.sheets.find((x) => x.name === name);
      $('[data-type]', box).onchange = (e) => {
        d.type = e.target.value;
        d.columns = d.type === s.type ? s.columns.map((c) => ({ ...c })) : [];
        drawAnalysis(view);
      };
      $$('[data-scur]', box).forEach((b) => b.onclick = () => { d.currency = b.dataset.scur; s.askCurrency = false; drawAnalysis(view); });
      $$('[data-neg]', box).forEach((b) => b.onclick = () => { d.negative = b.dataset.neg; drawAnalysis(view); });
      $$('[data-col]', box).forEach((cm) => {
        const i = Number(cm.dataset.col);
        const get1 = () => { let c = d.columns.find((x) => x.i === i); if (!c) { c = { i, role: 'ignore' }; d.columns.push(c); } return c; };
        $('[data-role]', cm).onchange = (e) => {
          const c = get1();
          c.role = e.target.value;
          // دور فريد لكل ورقة: الشهر والتاريخ والمبلغ والطرف
          if (['month', 'date', 'amount', 'party', 'desc', 'currency', 'direction', 'paid'].includes(c.role)) for (const o of d.columns) if (o !== c && o.role === c.role) o.role = 'ignore';
          if (c.role === 'item' && !c.template_id) c.template_id = state.boot.templates[0] && state.boot.templates[0].id;
          if (c.role === 'new' && !c.name) c.name = s.stats[i].header;
          drawAnalysis(view);
        };
        const t = $('[data-tpl]', cm); if (t) t.onchange = () => { get1().template_id = Number(t.value); };
        const n = $('[data-name]', cm); if (n) n.oninput = () => { const c = get1(); c.name = n.value; if (c.role === 'ask') c.role = 'new'; };
        const sc = $('[data-sec]', cm); if (sc) sc.onchange = () => { const c = get1(); c.section = sc.value; if (c.role === 'ask') c.role = 'new'; };
        const cc = $('[data-ccur]', cm); if (cc) cc.onchange = () => { get1().currency = cc.value || null; };
      });
    });
    $('#back').onclick = () => { S.step = 'upload'; draw(); };
    $('#next').onclick = async () => {
      // «اختر» المتروك = بند جديد بالاسم المقترح، بعد تأكيد
      const asks = Object.values(S.decisions.sheets).flatMap((d) => d.type === 'ignore' ? [] : d.columns.filter((c) => c.role === 'ask'));
      if (asks.length && !(await confirmBox(`${asks.length} عمود لم يُحدد له بند. هل تُستورد كبنود جديدة بأسمائها؟`, 'نعم، بنود جديدة'))) return;
      asks.forEach((c) => { c.role = 'new'; c.section = c.section || (c.suggest === 'debt' ? 'debts' : 'basic'); });
      await runPreview();
    };
  }

  async function runPreview() {
    const v = $('#view');
    const btn = $('#next'); if (btn) { btn.disabled = true; btn.textContent = 'جارٍ جلب أسعار الصرف…'; }
    try {
      S.preview = await post('/api/import/preview', { token: S.analysis.token, decisions: S.decisions });
      S.step = 'preview';
      draw(v);
    } catch (e) { const er = $('#err'); if (er) er.textContent = e.message; else fail(e); if (btn) { btn.disabled = false; btn.textContent = 'المعاينة ←'; } }
  }

  // ---------- 3. المعاينة ----------
  const STATE = { new: ['t-in', 'جديد'], fill: ['t-in', 'يُعبّأ'], duplicate: ['t-mu', 'مكرر'], confirm: ['t-rec', 'يؤكد دفعة'], conflict: ['t-fx', 'تعارض'], ask: ['t-bad', 'يحتاج قرارك'] };
  function drawPreview(view) {
    const p = S.preview;
    const sm = p.summary;
    const recs = p.records.filter((r) => S.filter === 'all' || r.state === S.filter || (S.filter === 'new' && r.state === 'fill'));
    const undecided = [...new Set(p.records.filter((r) => r.state === 'ask').map((r) => r.party + '|' + r.sheet))];
    const ch = S.choices;
    const label = (r) => r.kind === 'debt' ? `${esc(r.party)} · ${r.direction === 'owe' ? 'عليّ' : r.direction === 'owed' ? 'لي' : '؟'} · ${r.txKind === 'payment' ? 'سداد' : 'دين'}` : esc(r.name);
    const sec = (r) => r.kind === 'debt' ? 'الديون' : esc((App.sectionById(r.section_id) || {}).name || '');
    view.innerHTML = `${head(3)}
      <div class="isum">
        <div class="n">جديد سيُضاف<b class="num">${sm.new}</b></div>
        <div>مكرر سيُتجاهل<b class="num">${sm.duplicate}</b></div>
        <div class="cn">يؤكد دفعات متكررة<b class="num">${sm.confirm}</b></div>
        <div class="cf">تعارض<b class="num">${sm.conflict}</b></div>
        <div>أشهر ستُنشأ<b class="num">${sm.months}</b></div>
      </div>
      ${p.issues.length ? `<div class="card" style="border-color:var(--warn);margin-bottom:12px;font-size:13px">${p.issues.map((i) => '⚠ ' + esc(i)).join('<br>')}</div>` : ''}
      ${undecided.length ? `<div class="card" style="border-color:var(--bad);margin-bottom:12px"><h3>اتجاه هذه الديون غير واضح في الملف</h3>
        ${undecided.map((k) => { const [party, sheet] = k.split('|'); return `<div class="row" style="margin-bottom:6px"><b style="min-width:120px">${esc(party)}</b>
          <button class="chip" data-pd="${esc(party)}" data-sh="${esc(sheet)}" data-v="owe">↑ عليّ</button><button class="chip" data-pd="${esc(party)}" data-sh="${esc(sheet)}" data-v="owed">↓ لي</button></div>`; }).join('')}</div>` : ''}
      ${p.missingRates.length ? `<div class="card" style="margin-bottom:12px"><h3>أشهر بلا سعر صرف تلقائي (قبل ${dateLabel(state.boot.settings.history_start)})</h3>
        <p class="muted" style="font-size:12.5px;margin:0 0 8px">أدخل سعر الدولار لكل شهر إن عرفته، أو اتركه وأدخله لاحقًا من صفحة الشهر. المبالغ بالليرة تُستورد في الحالتين.</p>
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px">${p.missingRates.map((ym) => `<label style="font-size:12.5px">${ymLabel(ym)}<input class="inp num" data-mr="${ym}" inputmode="decimal" value="${esc(ch.manualRates[ym] || '')}" placeholder="مثل 30.90"></label>`).join('')}</div></div>` : ''}
      ${p.suggestions.length ? `<div class="card" style="margin-bottom:12px"><h3>⟳ اقتراحات تكرار <span class="faint" style="font-weight:400">· لا يُفعَّل شيء دون اختيارك</span></h3>
        ${p.suggestions.map((s) => `<label class="suggest"><input type="checkbox" data-sg="${esc(s.key)}" ${ch.suggestions.includes(s.key) ? 'checked' : ''}>
          <div><b>${esc(s.name)}</b> · نفس المبلغ في أشهر متتالية (${s.months} شهرًا)
            <div class="muted" style="font-size:12px">${s.periods.map((x) => `${ymLabel(x.from_ym)} – ${ymLabel(x.to_ym)}: ${money(x.amount, x.currency)}`).join(' · ')}</div>
            <div class="faint" style="font-size:11.5px">عند الاختيار: يصبح بندًا متكررًا بهذه الفترات، وتُربط به المبالغ المستوردة.</div></div></label>`).join('')}</div>` : ''}
      <div class="card" style="padding:10px">
        <div class="filters">${[['all', 'الكل', sm.total], ['new', 'جديد', sm.new], ['duplicate', 'مكرر', sm.duplicate], ['confirm', 'تأكيد', sm.confirm], ['conflict', 'تعارض', sm.conflict]].filter((f) => f[0] === 'all' || f[2])
          .map(([k, v, n]) => `<button class="chip ${S.filter === k ? 'on' : ''}" data-flt="${k}">${v} (${n})</button>`).join('')}
          ${sm.conflict ? '<span class="ms"><button class="link" id="allRep">استبدال كل التعارضات</button> · <button class="link" id="allKeep">إبقاء الكل</button></span>' : ''}</div>
        <div class="tw"><table class="tbl"><tr><th>الحالة</th><th>الشهر / التاريخ</th><th>القسم</th><th>البند / الطرف</th><th>المبلغ</th><th>سعر $</th><th>المقابل</th></tr>
          ${recs.slice(0, S.limit).map((r) => `<tr class="${r.state === 'duplicate' ? 'dupr' : r.state === 'conflict' ? 'cfr' : ''}">
            <td><span class="tag ${STATE[r.state][0]}">${STATE[r.state][1]}</span>${r.reason === 'infile' ? `<div style="font-size:11px"><label><input type="checkbox" data-force="${r.key}" ${ch.force.includes(r.key) ? 'checked' : ''}> مكرر داخل الملف · أضفه</label></div>` : ''}</td>
            <td class="num">${r.date ? dateLabel(r.date) : ymLabel(r.ym)}</td><td>${sec(r)}</td><td>${label(r)}</td>
            <td class="num">${money(r.amount, r.currency)}${r.state === 'conflict' ? `<div style="font-size:11.5px" class="muted">في المنصة: ${money(r.existing.amount, r.existing.currency)}</div>
              <button class="chip ${ch.conflicts[r.key] !== 'replace' ? 'on' : ''}" data-cf="${r.key}" data-v="keep" style="font-size:11px">إبقاء</button><button class="chip ${ch.conflicts[r.key] === 'replace' ? 'on' : ''}" data-cf="${r.key}" data-v="replace" style="font-size:11px">استبدال</button>` : ''}</td>
            <td class="num c-fx">${r.rate ? '@' + fmtN(r.rate, 2) : (ch.manualRates[r.ym] ? '@' + ch.manualRates[r.ym] + ' ✎' : '—')}</td>
            <td class="num muted">${r.currency === 'USD' ? (r.local != null && r.rate ? money(r.local) : '—') : (r.usd != null ? money(r.usd, 'USD') : '—')}</td></tr>`).join('')}
        </table></div>
        ${recs.length > S.limit ? `<button class="link" id="more" style="margin:8px">عرض ${Math.min(300, recs.length - S.limit)} أخرى (من ${recs.length})</button>` : ''}
      </div>
      <div class="errline" id="err"></div>
      <div class="mf" style="max-width:460px"><button class="btn p" id="go" ${undecided.length ? 'disabled' : ''}>اعتماد الاستيراد (${sm.new + sm.confirm + ch.force.length})</button><button class="btn" id="back">رجوع للتحليل</button></div>`;

    $$('[data-flt]', view).forEach((b) => b.onclick = () => { S.filter = b.dataset.flt; S.limit = 150; drawPreview(view); });
    const more = $('#more', view); if (more) more.onclick = () => { S.limit += 300; drawPreview(view); };
    $$('[data-cf]', view).forEach((b) => b.onclick = () => { ch.conflicts[b.dataset.cf] = b.dataset.v; drawPreview(view); });
    const ar = $('#allRep', view); if (ar) ar.onclick = () => { p.records.filter((r) => r.state === 'conflict').forEach((r) => { ch.conflicts[r.key] = 'replace'; }); drawPreview(view); };
    const ak = $('#allKeep', view); if (ak) ak.onclick = () => { ch.conflicts = {}; drawPreview(view); };
    $$('[data-sg]', view).forEach((c) => c.onchange = () => { const k = c.dataset.sg; ch.suggestions = c.checked ? [...ch.suggestions, k] : ch.suggestions.filter((x) => x !== k); });
    $$('[data-force]', view).forEach((c) => c.onchange = () => { const k = c.dataset.force; ch.force = c.checked ? [...ch.force, k] : ch.force.filter((x) => x !== k); drawPreview(view); });
    $$('[data-mr]', view).forEach((i) => i.onchange = () => { const v = Calc.evalAmount(i.value); if (v > 0) ch.manualRates[i.dataset.mr] = v; else delete ch.manualRates[i.dataset.mr]; });
    $$('[data-pd]', view).forEach((b) => b.onclick = async () => { S.decisions.sheets[b.dataset.sh].partyDirections[b.dataset.pd] = b.dataset.v; await runPreview(); });
    $('#back', view).onclick = () => { S.step = 'analysis'; draw(); };
    $('#go', view).onclick = async () => {
      const go = $('#go', view);
      go.disabled = true; go.textContent = 'جارٍ الاستيراد…';
      try {
        S.result = await post('/api/import/commit', { token: S.analysis.token, decisions: S.decisions, choices: ch });
        S.step = 'done';
        await App.reloadBoot();
        draw(view);
      } catch (e) { $('#err', view).textContent = e.message; go.disabled = false; go.textContent = 'اعتماد الاستيراد'; }
    };
  }

  function drawDone(view) {
    const r = S.result;
    view.innerHTML = `${head(3)}<div class="card empty"><div class="art">✅</div><h2>تم الاستيراد</h2>
      <p>${r.added} سجلًا جديدًا${r.confirmed ? ` · ${r.confirmed} دفعة متكررة أُكِّدت` : ''}${r.replaced ? ` · ${r.replaced} استبدال` : ''}${r.kept ? ` · ${r.kept} تعارض أُبقي` : ''}${r.debts ? ` · ${r.debts} ديون جديدة` : ''}${r.series ? ` · ${r.series} بنود متكررة` : ''}</p>
      <div class="row" style="justify-content:center"><a class="btn p" href="#/months">عرض الأشهر</a>${r.debts ? '<a class="btn" href="#/debts">الديون</a>' : ''}<button class="btn" id="undo">↺ التراجع عن الاستيراد</button><button class="btn" id="again">استيراد ملف آخر</button></div></div>`;
    $('#undo').onclick = async () => {
      if (!(await confirmBox('التراجع عن هذا الاستيراد بالكامل؟', 'تراجع', true))) return;
      try { await post(`/api/audit/${r.auditId}/undo`); toast('تم التراجع عن الاستيراد'); await App.reloadBoot(); S.step = 'upload'; draw(); } catch (e) { fail(e); }
    };
    $('#again').onclick = () => { S.step = 'upload'; draw(); };
  }
})();
