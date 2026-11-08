// التكرار الذكي: محرر الفترات مع المعاينة، نطاق التعديل، وصفحة البند المتكرر.
const Series = (() => {
  const { $, $$, esc, state, get, post, del, route, modal, toast, fail, confirmBox, LOCAL, MONTHS,
    ymLabel, ymShort, shiftYm, todayYm, fmtN, money, m$, sectionById, iconFor } = App;

  const ymSel = (val, attr) => {
    const [y, m] = (val || todayYm()).split('-');
    return `<span class="ympick" ${attr}><select class="inp">${MONTHS.map((n, i) => `<option value="${App.pad(i + 1)}" ${App.pad(i + 1) === m ? 'selected' : ''}>${n}</option>`).join('')}</select><input class="inp num" type="number" min="1990" max="2100" value="${y}"></span>`;
  };
  const readYm = (el) => `${$('input', el).value}-${$('select', el).value}`;
  const count = (p) => (p.to_ym ? Calc.ymRange(p.from_ym, p.to_ym).length : Calc.ymRange(p.from_ym, todayYm() > p.from_ym ? todayYm() : p.from_ym).length);

  function gantt(periods) {
    const months = Calc.ymRange(periods[0].from_ym, periods.reduce((a, p) => { const e = p.to_ym || (todayYm() > p.from_ym ? todayYm() : p.from_ym); return e > a ? e : a; }, periods[0].from_ym));
    const total = months.length || 1;
    const years = [];
    for (const ym of months) { const y = ym.slice(0, 4); const last = years[years.length - 1]; if (last && last.y === y) last.n++; else years.push({ y, n: 1 }); }
    let html = '<div class="gantt"><div class="bar">';
    let cursor = periods[0].from_ym;
    periods.forEach((p, i) => {
      const gap = Calc.ymRange(cursor, p.from_ym).length - 1;
      if (gap > 0) html += `<i style="flex:${gap};background:var(--line)"></i>`;
      const n = count(p);
      html += `<i class="pcolor-${i % 6}" style="flex:${n}" title="${ymLabel(p.from_ym)} – ${p.to_ym ? ymLabel(p.to_ym) : 'مستمر'}">${n / total > 0.12 ? `${fmtN(p.amount)} × ${n}` : ''}</i>`;
      cursor = shiftYm(p.to_ym || todayYm(), 1);
    });
    html += '</div><div class="yrs">' + years.map((y) => `<span style="flex:${y.n};text-align:center">${y.y}</span>`).join('') + '</div></div>';
    return html;
  }

  // محرر سلسلة: من بند في شهر، أو تعديل سلسلة موجودة
  async function editor({ fromEntry, ym, seriesId, onDone, debtId, toYm }) {
    let def;
    if (seriesId) {
      const d = await get('/api/series/' + seriesId);
      def = { id: d.series.id, name: d.series.name, section_id: d.series.section_id, template_id: d.series.template_id, debt_id: d.series.debt_id, due_day: d.series.due_day,
        periods: d.periods.map((p) => ({ from_ym: p.from_ym, to_ym: p.to_ym, amount: p.amount, currency: p.currency })) };
    } else {
      const e = fromEntry;
      def = { name: e.name, section_id: e.section_id, template_id: e.template_id, debt_id: debtId || null, due_day: e.due_date ? Number(e.due_date.slice(8)) : null,
        periods: [{ from_ym: ym, to_ym: toYm || null, amount: e.amount ?? e.planned ?? '', currency: e.currency || LOCAL }] };
    }
    const s = { pastPaid: false, conflicts: {}, pv: null, err: '', loading: false };
    const sec = sectionById(def.section_id);
    const m = modal(`<h2>⟳ ${seriesId ? 'تعديل' : 'تكرار'}: ${esc(def.name)} <button class="x" data-close>✕</button></h2>
      <p class="muted" style="margin:0 0 12px;font-size:13px">${esc(sec ? sec.name : '')} · كل فترة بمبلغها، وكل شهر يُحسب بسعر صرفه.</p><div id="sb"></div>`, { wide: 860 });
    const b = $('#sb', m.el);

    function readPeriods() {
      return $$('.prow', b).map((row) => ({
        from_ym: readYm($('[data-from]', row)),
        to_ym: $('[data-open]', row).checked ? null : readYm($('[data-to]', row)),
        amount: Calc.evalAmount($('[data-amount]', row).value),
        currency: $('[data-pc].on', row).dataset.pc,
      }));
    }

    function draw() {
      const pv = s.pv;
      const rowsHtml = def.periods.map((p, i) => `<div class="prow">
          <span class="k pcolor-${i % 6}">${i + 1}</span>
          <div><span class="faint" style="font-size:11px">من</span><br>${ymSel(p.from_ym, 'data-from')}</div>
          <div><span class="faint" style="font-size:11px">إلى</span><br>${ymSel(p.to_ym || p.from_ym, 'data-to')}<label style="font-size:11.5px;display:flex;gap:4px;align-items:center;margin-top:3px"><input type="checkbox" data-open ${p.to_ym ? '' : 'checked'}> مستمر بلا نهاية</label></div>
          <div class="amt"><div class="seg"><button data-pc="${LOCAL}" class="${p.currency !== 'USD' ? 'on' : ''}">₺</button><button data-pc="USD" class="${p.currency === 'USD' ? 'on' : ''}">$</button></div><input data-amount inputmode="decimal" value="${p.amount ?? ''}" placeholder="المبلغ الشهري"></div>
          <button class="x" data-rm="${i}" title="حذف الفترة">✕</button></div>`).join('');
      const counts = pv ? pv.rows.reduce((a, r) => ((a[r.state] = (a[r.state] || 0) + 1), a), {}) : {};
      const conflicts = pv ? pv.rows.filter((r) => r.state === 'conflict') : [];
      const totLocal = pv ? pv.rows.reduce((a, r) => a + (r.local || 0), 0) : 0;
      const totUsd = pv ? pv.rows.reduce((a, r) => a + (r.usd || 0), 0) : 0;
      const missing = pv ? pv.rows.filter((r) => !r.rate).length : 0;
      const hasPast = pv && pv.rows.some((r) => r.ym < todayYm() && ['new', 'fill'].includes(r.state));
      const stateTag = { new: '<span class="tag t-rec">جديد</span>', fill: '<span class="tag t-rec">يُعبّأ</span>', exists: '<span class="tag t-in">موجود ✓</span>', same: '<span class="tag t-mu">بلا تغيير</span>',
        conflict: '<span class="tag t-fx">تعارض</span>', review: '<span class="tag t-bad">مدفوع · مراجعة</span>', override: '<span class="tag t-mu">استثناء</span>' };
      b.innerHTML = `<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:20px">
        <div>
          <label class="fl" style="margin-top:0">الفترات</label>
          <div id="prows">${rowsHtml}</div>
          <button class="chip" id="addp">＋ فترة جديدة</button>
          <label class="fl">يوم الاستحقاق (اختياري)</label>
          <input class="inp num" id="due" type="number" min="1" max="31" value="${def.due_day || ''}" placeholder="—" style="width:90px">
          ${hasPast ? `<label class="fl">حالة الأشهر الماضية المُنشأة</label>
            <button class="scope ${!s.pastPaid ? 'on' : ''}" data-past="0"><span class="r"></span><div>مستحقة (غير مؤكدة)<small>تظهر في «باقي للدفع» حتى تؤكدها</small></div></button>
            <button class="scope ${s.pastPaid ? 'on' : ''}" data-past="1"><span class="r"></span><div>مدفوعة: أؤكد أنني دفعتها فعلًا<small>للأشهر الماضية فقط، والقادمة تبقى مستحقة</small></div></button>` : ''}
        </div>
        <div>
          <label class="fl" style="margin-top:0">المعاينة ${pv ? '· ' + pv.rows.length + ' شهرًا' : ''}</label>
          ${s.loading ? '<div class="spinner"></div>' : !pv ? `<div class="muted" style="font-size:13px">${s.err ? `<span class="c-bad">${esc(s.err)}</span>` : 'أكمل الفترات لعرض المعاينة'}</div>` : `
            ${gantt(readPeriods().filter((p) => p.amount > 0).sort((x, y) => x.from_ym.localeCompare(y.from_ym)))}
            <div class="mgrid" style="margin-top:10px">${pv.rows.map((r) => `<div class="mc ${r.state === 'conflict' ? 'cf' : r.state === 'review' ? 'rv' : ['exists', 'same'].includes(r.state) ? 'ok' : ''}">
              <span class="u">${ymShort(r.ym)} · ${r.rate ? '@' + fmtN(r.rate, 2) : '<span class="c-bad">بلا سعر</span>'}</span><b class="num">${fmtN(r.amount)} ${r.currency === 'USD' ? '$' : ''}</b>
              <span class="u num">${r.currency === 'USD' ? (r.local != null && r.rate ? money(r.local) : '') : r.usd != null ? money(r.usd, 'USD') : ''}</span>
              ${r.existing && r.state === 'conflict' ? `<span class="u">مسجّل ${money(r.existing.amount, r.existing.currency)}</span>` : ''}<div style="margin-top:3px">${stateTag[r.state] || ''}</div></div>`).join('')}</div>
            <div class="previewbox">المجموع: <b class="num">${money(totLocal)}</b> · <b class="num">≈ ${money(totUsd, 'USD')}</b> <span class="faint">كل شهر بسعره</span>
              ${missing ? `<div class="warnline">${missing} شهر بلا سعر صرف تلقائي، يُحسب بالدولار بعد إدخال سعره يدويًا.</div>` : ''}
              <div style="margin-top:6px;font-size:12px" class="muted">${['new', 'fill', 'exists', 'conflict', 'review', 'override'].filter((k) => counts[k]).map((k) => `${{ new: 'جديد', fill: 'يُعبّأ', exists: 'موجود ويُربط', conflict: 'تعارض', review: 'مدفوع ويحتاج مراجعة', override: 'استثناء محفوظ' }[k]}: ${counts[k]}`).join(' · ')}</div>
              ${conflicts.map((r) => `<div style="margin-top:8px;font-size:12.5px">${ymLabel(r.ym)} مسجّل بـ ${money(r.existing.amount, r.existing.currency)}:
                <button class="chip ${s.conflicts[r.ym] !== 'replace' ? 'on' : ''}" data-cf="${r.ym}" data-v="keep">إبقاؤه كاستثناء</button>
                <button class="chip ${s.conflicts[r.ym] === 'replace' ? 'on' : ''}" data-cf="${r.ym}" data-v="replace">استبدال بـ ${fmtN(r.amount)}</button></div>`).join('')}
            </div>`}
        </div></div>
        <div class="errline" id="err">${pv && s.err ? esc(s.err) : ''}</div>
        <div class="mf"><button class="btn p" id="save" ${pv && !s.loading ? '' : 'disabled'}>${seriesId ? 'حفظ التعديل' : `اعتماد التكرار${pv ? ` (${pv.rows.length} شهرًا)` : ''}`}</button><button class="btn" data-x>إلغاء</button>
          ${seriesId ? '<button class="btn danger" id="delS" style="margin-inline-start:auto">حذف التكرار</button>' : ''}</div>`;
      bind();
    }

    let timer;
    function schedulePreview() { clearTimeout(timer); timer = setTimeout(runPreview, 350); }
    async function runPreview() {
      def.periods = readPeriods();
      def.due_day = Number($('#due', b).value) || null;
      if (def.periods.some((p) => !(p.amount > 0))) { s.pv = null; s.err = 'أدخل مبلغ كل فترة'; draw(); return; }
      s.loading = true; s.err = ''; draw();
      try { s.pv = await post('/api/series/preview', def); } catch (e) { s.pv = null; s.err = e.message; }
      s.loading = false; draw();
    }

    function bind() {
      $$('.prow select, .prow input', b).forEach((el) => el.addEventListener('change', schedulePreview));
      $$('.prow [data-amount]', b).forEach((el) => el.addEventListener('input', schedulePreview));
      $$('[data-pc]', b).forEach((x) => x.onclick = () => { $$('[data-pc]', x.parentElement).forEach((y) => y.classList.toggle('on', y === x)); schedulePreview(); });
      $$('[data-rm]', b).forEach((x) => x.onclick = () => { def.periods = readPeriods(); if (def.periods.length > 1) { def.periods.splice(Number(x.dataset.rm), 1); runPreview(); } });
      $('#addp', b).onclick = () => {
        def.periods = readPeriods();
        const last = def.periods[def.periods.length - 1];
        if (!last.to_ym) last.to_ym = last.from_ym > todayYm() ? last.from_ym : todayYm();
        def.periods.push({ from_ym: shiftYm(last.to_ym, 1), to_ym: null, amount: '', currency: last.currency });
        s.pv = null; draw();
        const inputs = $$('[data-amount]', b); inputs[inputs.length - 1].focus();
      };
      $('#due', b).onchange = schedulePreview;
      $$('[data-past]', b).forEach((x) => x.onclick = () => { s.pastPaid = x.dataset.past === '1'; draw(); });
      $$('[data-cf]', b).forEach((x) => x.onclick = () => { s.conflicts[x.dataset.cf] = x.dataset.v; draw(); });
      $('[data-x]', b).onclick = m.close;
      $('#save', b).onclick = async () => {
        if (s.pastPaid && !(await confirmBox('ستُسجَّل كل الأشهر الماضية المُنشأة كمدفوعة. هل دفعتها فعلًا؟', 'نعم، دفعتها'))) return;
        try {
          const r = await post('/api/series', { def: { ...def, periods: readPeriods() }, pastPaid: s.pastPaid, conflicts: s.conflicts });
          m.close();
          toast(`⟳ ${esc(def.name)}: ${r.created} شهر جديد، ${r.updated} محدّث`, { undo: r.auditId, ms: 7000 });
          await App.reloadBoot();
          onDone ? onDone(r) : App.render();
        } catch (e) { s.err = e.message; draw(); }
      };
      const ds = $('#delS', b);
      if (ds) ds.onclick = async () => {
        if (!(await confirmBox('حذف التكرار؟ الأشهر المدفوعة تبقى كما هي، والمستحقة غير المدفوعة تُحذف.', 'حذف', true))) return;
        try { const r = await del('/api/series/' + seriesId); m.close(); toast('حُذف التكرار', { undo: r.auditId }); await App.reloadBoot(); location.hash = '#/recurring'; } catch (e) { fail(e); }
      };
    }
    draw();
    runPreview();
  }

  // تعديل مبلغ بند متكرر من خانته: ما النطاق؟
  function scopeModal(entry, newAmount, ym, onDone, onCancel) {
    let scope = 'to_end', until = ym;
    let done = false;
    const m = modal(`<h2>تعديل ${esc(entry.name)} <button class="x" data-close>✕</button></h2>
      <p class="muted" style="margin:0 0 12px">من ${money(entry.amount ?? entry.planned, entry.currency)} إلى <b class="num" style="color:var(--ink)">${money(newAmount, entry.currency)}</b> · بدءًا من ${ymLabel(ym)}</p>
      <div id="sc"></div>`, { onClose: () => { if (!done) onCancel && onCancel(); } });
    const b = $('#sc', m.el);
    function draw() {
      b.innerHTML = `
        <button class="scope ${scope === 'one' ? 'on' : ''}" data-s="one"><span class="r"></span><div>${ymLabel(ym)} فقط<small>مبلغ استثنائي لهذا الشهر، وبقية الفترة كما هي</small></div></button>
        <button class="scope ${scope === 'to_end' ? 'on' : ''}" data-s="to_end"><span class="r"></span><div>من ${ymLabel(ym)} حتى نهاية الفترة<small>تُقسم الفترة، وما قبل هذا الشهر لا يتغير</small></div></button>
        <button class="scope ${scope === 'until' ? 'on' : ''}" data-s="until"><span class="r"></span><div>من ${ymLabel(ym)} حتى شهر أحدده<small>بعده يعود المبلغ القديم</small></div></button>
        ${scope === 'until' ? `<div style="margin:4px 0 8px">${ymSel(until, 'id="until"')}</div>` : ''}
        <p class="faint" style="font-size:12px;margin:6px 0 0">الأشهر المدفوعة والمؤكدة داخل النطاق لا تُعدَّل بصمت، بل تُعلَّم «يحتاج مراجعة».</p>
        <div class="errline" id="err"></div>
        <div class="mf"><button class="btn p" id="ok">تطبيق التعديل</button><button class="btn" data-x>إلغاء</button></div>`;
      $$('[data-s]', b).forEach((x) => x.onclick = () => { scope = x.dataset.s; draw(); });
      const u = $('#until', b); if (u) u.addEventListener('change', () => { until = readYm(u); });
      $('[data-x]', b).onclick = m.close;
      $('#ok', b).onclick = async () => {
        if (scope === 'until') until = readYm($('#until', b));
        try {
          const r = await post('/api/series/edit-from', { entry_id: entry.id, amount: newAmount, currency: entry.currency, scope, until });
          done = true; m.close();
          toast('✓ عُدّل البند المتكرر', { undo: r.auditId });
          onDone && onDone();
        } catch (e) { $('#err', b).textContent = e.message; }
      };
    }
    draw();
  }

  // ---------- قائمة البنود المتكررة ----------
  route('recurring', async (view, r) => {
    App.killCharts();
    if (r.args[0]) return page(view, Number(r.args[0]));
    const list = await get('/api/series');
    view.innerHTML = `<div class="topbar"><a class="btn icon" href="#/months">›</a><h1>البنود المتكررة</h1></div>
      <p class="muted" style="margin-top:-6px">لإنشاء تكرار: افتح أي شهر، ومن قائمة ⋮ بجانب أي بند اختر «اجعله بندًا متكررًا».</p>
      ${list.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${list.map((s) => {
        const last = s.periods[s.periods.length - 1];
        const sec = sectionById(s.section_id);
        return `<a class="card" href="#/recurring/${s.id}" style="color:inherit;${s.status !== 'active' ? 'opacity:.6' : ''}">
          <div class="row"><b style="font-size:15px">${esc(s.name)}</b><span class="tag ${s.status === 'active' ? 't-rec' : 't-mu'} ms">${s.status === 'active' ? '⟳ نشط' : 'موقوف'}</span></div>
          <div class="muted" style="font-size:12.5px;margin:4px 0 8px">${esc(sec ? sec.name : '')} · ${s.periods.length} فترات${s.debt_id ? ' · قسط دين' : ''}</div>
          ${s.periods.length ? gantt(s.periods) : ''}
          <div class="row" style="margin-top:8px;font-size:12.5px"><span>الحالي: <b class="num">${last ? money(last.amount, last.currency) : '—'}</b></span>
            <span class="ms">${s.paid || 0}/${s.n || 0} مدفوع${s.review ? ` · <span class="c-bad">${s.review} مراجعة</span>` : ''}</span></div></a>`;
      }).join('')}</div>` : '<div class="card empty"><div class="art">⟳</div><h2>لا توجد بنود متكررة بعد</h2><p>حوّل أي بند في صفحة الشهر إلى سلسلة شهرية بفترات ومبالغ متغيرة.</p></div>'}`;
  });

  async function page(view, id) {
    const d = await get('/api/series/' + id);
    if (!d) { view.innerHTML = '<div class="card empty"><h2>غير موجود</h2></div>'; return; }
    const { series: s, periods, entries } = d;
    const v = entries.map((e) => ({ ...e, ...Calc.entryValues(e, e.month_rate) }));
    const totLocal = v.reduce((a, e) => a + e.local, 0);
    const totUsd = v.reduce((a, e) => a + (e.rate ? e.usd : 0), 0);
    const paid = v.filter((e) => e.status === 'paid');
    const unpaid = v.filter((e) => e.status !== 'paid');
    const review = v.filter((e) => e.needs_review);
    const sec = sectionById(s.section_id);
    const pRows = periods.map((p, i) => {
      const es = v.filter((e) => e.ym >= p.from_ym && (!p.to_ym || e.ym <= p.to_ym) && !e.series_override);
      const sl = es.reduce((a, e) => a + e.local, 0), su = es.reduce((a, e) => a + (e.rate ? e.usd : 0), 0);
      return `<tr><td><span class="k pcolor-${i % 6}" style="display:inline-grid;place-items:center;width:18px;height:18px;border-radius:5px;color:#fff;font-size:10px">${i + 1}</span> ${ymLabel(p.from_ym)} – ${p.to_ym ? ymLabel(p.to_ym) : 'مستمر'}</td>
        <td class="num">${money(p.amount, p.currency)}</td><td>${es.length}</td><td class="num">${money(sl)}</td><td class="num">${su ? money(su, 'USD') : '—'}</td><td class="num c-fx">${su ? '@' + fmtN(sl / su, 2) : '—'}</td></tr>`;
    }).join('');
    const first = periods[0], lastP = periods[periods.length - 1];
    const firstE = v.find((e) => e.ym === (first && first.from_ym)), lastE = [...v].reverse().find((e) => !e.series_override && e.rate);
    view.innerHTML = `<div class="topbar"><a class="btn icon" href="#/recurring">›</a><h1>${esc(s.name)}</h1><span class="tag ${s.status === 'active' ? 't-rec' : 't-mu'}">${s.status === 'active' ? '⟳ متكرر' : 'موقوف'}</span><span class="tag t-ex">${esc(sec ? sec.name : '')}</span>
        <div class="ms row"><button class="btn" id="stop">⏸ إيقاف من شهر…</button><button class="btn p" id="edit">✎ تعديل الفترات</button></div></div>
      <div class="grid g3" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        <div class="card"><h3>المستحق حتى الآن</h3><div style="font-size:24px;font-weight:600" class="num">${money(totLocal)}</div><div class="faint num">≈ ${money(totUsd, 'USD')} بأسعار كل شهر</div></div>
        <div class="card"><h3>مدفوع ومؤكد</h3><div style="font-size:24px;font-weight:600" class="num c-in">${money(paid.reduce((a, e) => a + e.local, 0))}</div><div class="faint">${paid.length} من ${v.length} شهرًا</div></div>
        <div class="card" style="${unpaid.length ? 'border-color:var(--warn)' : ''}"><h3>مستحق غير مؤكد</h3><div style="font-size:24px;font-weight:600;color:var(--warn)" class="num">${money(unpaid.reduce((a, e) => a + e.local, 0))}</div>
          <div class="faint">${unpaid.length ? unpaid.slice(0, 3).map((e) => ymShort(e.ym)).join('، ') + (unpaid.length > 3 ? '…' : '') + ' · <button class="link" id="confAll">تأكيد الكل</button>' : 'لا شيء'}</div></div>
      </div>
      ${review.length ? `<div class="card" style="border-color:var(--bad);margin-top:12px;font-size:13px">⚠ ${review.length} شهر مدفوع تغيّر مبلغه بعد التأكيد: ${review.map((e) => `<a href="#/month/${e.ym}">${ymLabel(e.ym)}</a>`).join('، ')}</div>` : ''}
      <div class="card" style="margin-top:12px"><h3>الفترات</h3>${periods.length ? gantt(periods) : '<p class="muted">لا فترات نشطة</p>'}
        <div class="tw" style="margin-top:10px"><table class="tbl"><tr><th>الفترة</th><th>الشهري</th><th>الأشهر</th><th>المجموع</th><th>بالدولار</th><th>متوسط السعر</th></tr>${pRows}</table></div>
        ${firstE && lastE && first !== lastP && firstE.rate ? `<p class="note" style="font-size:12.5px">التغير من ${ymLabel(firstE.ym)} إلى ${ymLabel(lastE.ym)}: <b>${Math.round(((lastE.local - firstE.local) / firstE.local) * 100)}%</b> بالليرة، و<b>${Math.round(((lastE.usd - firstE.usd) / firstE.usd) * 100)}%</b> بالدولار.</p>` : ''}
      </div>
      <div class="card tw" style="margin-top:12px;padding:6px 8px"><table class="tbl"><tr><th>الشهر</th><th>المبلغ</th><th>سعر $</th><th>بالدولار</th><th>الحالة</th><th></th></tr>
        ${v.map((e) => `<tr class="click" data-ym="${e.ym}"><td>${ymLabel(e.ym)}</td><td class="num">${money(e.amount ?? e.planned, e.currency)}${e.series_override ? ' <span class="tag t-mu">استثناء</span>' : ''}</td>
          <td class="num c-fx">${e.rate ? fmtN(e.rate, 2) : '—'}</td><td class="num">${e.rate ? money(e.usd, 'USD') : '—'}</td>
          <td>${e.status === 'paid' ? '<span class="tag t-in">✓ مدفوع</span>' : '<span class="tag t-fx">مستحق</span>'}${e.needs_review ? ' <span class="tag t-bad">مراجعة</span>' : ''}</td><td class="faint">←</td></tr>`).join('')}</table></div>`;
    $$('tr.click', view).forEach((tr) => tr.onclick = () => { location.hash = '#/month/' + tr.dataset.ym; });
    $('#edit').onclick = () => editor({ seriesId: id, onDone: () => App.render() });
    const ca = $('#confAll');
    if (ca) ca.onclick = async () => {
      if (!(await confirmBox(`تأكيد أن ${unpaid.length} دفعات دُفعت فعلًا؟`, 'نعم، دُفعت'))) return;
      try { const r = await post(`/api/series/${id}/confirm`, {}); toast('✓ تم التأكيد', { undo: r.auditId }); App.refresh(); } catch (e) { fail(e); }
    };
    $('#stop').onclick = () => {
      const mm = modal(`<h2>إيقاف ${esc(s.name)}</h2><p class="muted">يتوقف التكرار ابتداءً من الشهر المختار. المستحق غير المدفوع بعده يُحذف، والمدفوع يبقى.</p>
        ${ymSel(shiftYm(todayYm(), 1), 'id="from"')}<div class="mf"><button class="btn p" id="ok">إيقاف</button><button class="btn" data-close>إلغاء</button></div>`);
      $('#ok', mm.el).onclick = async () => {
        try { const r = await post(`/api/series/${id}/stop`, { from_ym: readYm($('#from', mm.el)) }); mm.close(); toast('أُوقف التكرار', { undo: r.auditId }); App.refresh(); } catch (e) { fail(e); }
      };
    };
  }

  return { editor, scopeModal, gantt };
})();
