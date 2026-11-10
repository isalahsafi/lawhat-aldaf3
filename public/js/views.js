// الشاشات: الرئيسية، الأشهر، صفحة الشهر، التقارير، الأهداف.
(() => {
  const { $, $$, esc, state, get, post, patch, put, del, route, modal, toast, fail, confirmBox, LOCAL,
    ymLabel, ymShort, shiftYm, todayYm, dateLabel, fmtN, money, m$, d$, other$, compact, avatar,
    sectionById, templateById, secColor, iconFor, displaySeg, MONTHS_S } = App;

  const charts = [];
  const killCharts = () => { while (charts.length) charts.pop().destroy(); };
  App.killCharts = killCharts;
  App.charts = charts;
  const css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();
  const stLabel = (st, income) => (income ? { paid: '✓ مستلم', partial: '◐ جزئي', unpaid: 'متوقع' } : { paid: '✓ مدفوع', partial: '◐ جزئي', unpaid: 'مستحق' })[st];
  const methodLabel = { avg: 'متوسط الشهر', end: 'آخر يوم في الشهر', manual: 'يدوي' };
  const conv = (v, r) => (state.display === 'USD' ? (r ? v / r : 0) : v);

  // ============ الرئيسية ============
  route('home', async (view) => {
    killCharts();
    const ym = todayYm();
    const months = state.boot.months;
    const name = state.boot.settings.user_name;
    let data = null;
    if (months.find((m) => m.ym === ym)) data = await get('/api/months/' + ym);
    if (!data) {
      view.innerHTML = `<div class="topbar"><h1>${name ? 'أهلًا ' + esc(name) + ' · ' : ''}${ymLabel(ym)}</h1></div>
        <div class="card empty"><div class="art">🗓</div><h2>${ymLabel(ym)} لم يُنشأ بعد</h2><p>سيُنشأ ببنودك المعتادة وبسعر صرف هذا الشهر.</p>
        <div class="row" style="justify-content:center"><button class="btn p" id="mk">إنشاء ${ymLabel(ym)}</button><a class="btn" href="#/import">📥 استيراد من Excel</a></div></div>
        ${months.length ? '<div class="card" style="margin-top:12px"><h3>آخر 12 شهرًا</h3><div class="chartbox"><canvas id="bars"></canvas></div></div>' : ''}`;
      $('#mk').onclick = async () => { try { await post('/api/months', { year: +ym.slice(0, 4), month: +ym.slice(5) }); await App.refresh(); } catch (e) { fail(e); } };
      if (months.length) barsChart($('#bars'));
      return;
    }
    const s = data.summary;
    const rate = data.rate && data.rate.rate;
    const prev = months.find((m) => m.ym === shiftYm(ym, -1));
    const pct = s.income ? Math.round((s.net / s.income) * 100) : 0;
    const secs = state.boot.sections.filter((x) => x.kind === 'expense');
    const base = Math.max(s.income, s.expenses) || 1;
    const parts = secs.map((x) => ({ s: x, v: s.bySection[x.id] || 0 })).filter((p) => p.v > 0);
    const leftover = Math.max(0, s.income - s.expenses);
    const delta = (cur, old, goodUp) => {
      if (!old) return '';
      const d = Math.round(((cur - old) / old) * 100);
      if (!d) return '<span class="delta neutral">0%</span>';
      return `<span class="delta ${(goodUp ? d > 0 : d < 0) ? 'good' : 'badd'}">${d > 0 ? '↑' : '↓'} ${Math.abs(d)}%</span>`;
    };
    const due = data.entries.filter((e) => sectionById(e.section_id)?.kind === 'expense' && e.status !== 'paid' && Calc.effectiveAmount(e) > 0)
      .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || Calc.effectiveAmount(b) - Calc.effectiveAmount(a));
    // المصاريف المتغيرة: الميزانية والوتيرة
    const varSec = App.sectionByKey('variable');
    const varEntries = data.entries.filter((e) => varSec && e.section_id === varSec.id);
    const spent = s.variable;
    // المصروف لمرة واحدة يدخل في المجموع، لكن الوتيرة والتوقع يُحسبان من المصروف المعتاد فقط
    const regular = spent - s.oneOff;
    const budget = variableBudget();
    const [yy, mm] = ym.split('-').map(Number);
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const dayNow = Number(state.boot.today.slice(8, 10));
    const firstDay = varEntries.reduce((a, e) => Math.min(a, Number((e.tx_date || ym + '-01').slice(8, 10))), dayNow);
    const elapsed = Math.max(1, dayNow - firstDay + 1);
    // التوقع يحتاج 5 أيام على الأقل حتى لا يضخّمه يوم تسوق واحد؛ قبلها يظهر المتوسط اليومي
    const pace = regular && elapsed >= 5 ? (regular / elapsed) * (daysInMonth - firstDay + 1) + s.oneOff : null;
    const daily = regular ? regular / elapsed : 0;
    // نسبة الاستهلاك تُحسب على الفئات التي لها ميزانية فقط
    const budgeted = new Set(varCategories().filter((c) => c.budget).map((c) => c.name));
    const spentBudgeted = budgeted.size ? varEntries.filter((e) => budgeted.has(e.note)).reduce((a, e) => a + Calc.entryValues(e, rate).local, 0) : spent;
    const used = budget ? Math.round((spentBudgeted / budget) * 100) : null;
    // توقع المتبقي آخر الشهر: الدخل − الالتزامات الثابتة − المتغيرة المتوقعة
    const fixed = s.expenses - spent;
    const forecast = pace !== null ? s.income - fixed - pace : null;
    // مقارنة عادلة: الأشهر التي لم تُسجَّل فيها مصاريف متغيرة تُقارَن بدونها
    const fair = prev && !prev.summary.variable && spent;
    const expNow = fair ? s.expenses - spent : s.expenses;
    const expPrev = prev ? (fair ? prev.summary.expenses - prev.summary.variable : prev.summary.expenses) : 0;
    const tomorrow = (() => { const d = new Date(state.boot.today + 'T12:00:00'); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${App.pad(d.getMonth() + 1)}-${App.pad(d.getDate())}`; })();
    // الدخل غير المؤكد استلامه
    const pendingIncome = data.entries.filter((e) => sectionById(e.section_id)?.kind === 'income' && e.amount != null && e.status !== 'paid');

    view.innerHTML = `
      <div class="topbar"><h1>${name ? 'أهلًا ' + esc(name) + ' · ' : ''}${ymLabel(ym)}</h1>
        <div class="ms row">${App.privBtn()}${displaySeg()}<button class="btn p hide-m" id="qa">+ إضافة سريعة</button><a class="btn hide-m" href="#/month/${ym}">فتح الشهر</a></div></div>
      ${!rate ? `<div class="card" style="border-color:var(--warn);margin-bottom:12px">⚠ لا يتوفر سعر صرف لهذا الشهر. <a href="#/month/${ym}">أدخله يدويًا</a></div>` : ''}
      <div class="card hero">
        <div class="top">
          <div><div class="lbl">المتبقي من الدخل</div>
            <div class="big num money"><span class="cur">${state.display === 'USD' ? '$' : '₺'}</span><b>${fmtN(conv(s.net, rate), 0)}</b></div>
            <div class="sub">≈ ${other$(s.net, rate)} · ${pct}% من الدخل${s.expectedCount ? ` · <span class="faint">يشمل ${s.expectedCount} مبالغ متوقعة</span>` : ''}</div></div>
          <div class="stats"><div>دُفع<b>${d$(s.paid, rate)}</b></div><div>باقي للدفع<b class="c-bad">${d$(s.remaining, rate)}</b></div>
            <div title="الدخل − الالتزامات الثابتة − المصاريف المتغيرة المتوقعة حتى نهاية الشهر">متوقع آخر الشهر${forecast !== null && elapsed < 10 ? ' <span class="faint" style="font-size:11px">(تقدير أولي)</span>' : ''}<b class="${forecast !== null && forecast < 0 ? 'c-bad' : 'c-in'}">${forecast !== null ? d$(forecast, rate) : '<span class="faint" style="font-size:12px;font-weight:400">بعد 5 أيام تسجيل</span>'}</b></div></div>
        </div>
        <div class="split">${parts.map((p) => `<i style="width:${(p.v / base) * 100}%;background:${secColor(p.s)}" title="${esc(p.s.name)}"></i>`).join('')}<i style="width:${(leftover / base) * 100}%;background:var(--in)"></i></div>
        <div class="legend">${parts.map((p) => `<span style="--c:${secColor(p.s)}">${esc(p.s.name)} ${Math.round((p.v / (s.income || base)) * 100)}%</span>`).join('')}<span style="--c:var(--in)">متبقٍ ${pct}%</span></div>
      </div>
      <div class="kpis">
        <div class="card kpi"><div class="t"><span class="dot" style="--c:var(--in);--bg-c:var(--in-soft)">↓</span>الدخل</div>
          <div class="v c-in">${d$(s.income, rate)}</div><div class="s">${other$(s.income, rate)}${delta(s.income, prev && prev.summary.income, true)}</div></div>
        <div class="card kpi"><div class="t"><span class="dot" style="--c:var(--ex);--bg-c:var(--ex-soft)">↑</span>المصاريف والالتزامات</div>
          <div class="v">${d$(s.expenses, rate)}</div><div class="s">${other$(s.expenses, rate)}${delta(expNow, expPrev, false)}${fair ? ' <span class="faint" title="الشهر السابق لم تُسجَّل فيه مصاريف متغيرة">بدون المتغيرة</span>' : ''}</div></div>
        <div class="card kpi" style="border-color:var(--var)"><div class="t"><span class="dot" style="--c:var(--var);--bg-c:var(--var-soft)">✦</span>مصاريف متغيرة<button class="link ms" id="setBudget">${budget ? 'الميزانيات ✎' : '+ ميزانيات'}</button></div>
          <div class="v" style="color:var(--var)">${d$(spent, rate)}</div>
          ${s.oneOff ? `<div class="s">منها لمرة واحدة ${d$(s.oneOff, rate)}</div>` : ''}
          ${budget ? `<div class="prog" style="margin:6px 0 4px;height:7px"><i style="width:${Math.min(100, used)}%;${used > 100 ? 'background:var(--bad)' : pace && pace > budget ? 'background:var(--warn)' : ''}"></i></div>
            <div class="s">${budgeted.size && budgeted.size < varCategories().length ? `${d$(spentBudgeted, rate)} من ميزانيات ${budgeted.size} فئات (${d$(budget, rate)}) · ${used}%` : `${used}% من ${d$(budget, rate)}`}${used > 100 ? ' · <span class="c-bad">تجاوزت الميزانية</span>' : ''}</div>` : ''}
          <div class="s">${pace ? `بهذه الوتيرة: <b class="${budget && pace > budget ? 'c-bad' : ''}">${d$(pace, rate)}</b> هذا الشهر` : daily ? `متوسط يومي ${d$(daily, rate)} · ${varEntries.length} عمليات` : 'لا عمليات بعد'}</div></div>
      </div>
      ${pendingIncome.length ? `<div class="card" style="margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-color:var(--in)">
        <span class="dot" style="--c:var(--in);--bg-c:var(--in-soft)">↓</span><div style="flex:1">${pendingIncome.map((e) => `${esc(e.name)} ${m$(e.amount, e.currency)}`).join(' · ')} <span class="muted">لم يُعلَّم مستلمًا بعد</span></div>
        <button class="btn p" id="gotIncome">✓ استلمت</button></div>` : ''}
      <div class="dash2">
        <div class="card"><h3>مستحق قريبًا <a class="ms" href="#/month/${ym}">الكل</a></h3>
          ${due.length ? due.slice(0, 6).map((e) => {
            const v = Calc.entryValues(e, rate);
            const late = e.due_date && e.due_date < state.boot.today;
            const soon = e.due_date === state.boot.today ? 'اليوم' : e.due_date === tomorrow ? 'غدًا' : null;
            const when = e.due_date ? (late ? `متأخر منذ ${dateLabel(e.due_date)}` : soon ? `<b>يستحق ${soon}</b>` : `يستحق ${dateLabel(e.due_date)}`)
              : `${e.series_id ? '⟳ دفعة متكررة' : v.isExpected ? 'مبلغ متوقع' : 'مستحق'} · ${e.template_id ? `<button class="link" data-dueday="${e.id}" style="font-size:11.5px">📅 حدد موعده</button>` : ''}`;
            return `<div class="due" ${soon ? 'style="background:var(--fx-soft);border-radius:10px;padding-inline:8px"' : ''}>${iconFor(e)}<div class="meta">${esc(e.name)}<span class="${late || soon ? 'late' : ''}">${when}</span></div><b>${m$(v.amount, e.currency)}</b><button class="paybtn" data-pay="${e.id}">✓ دفع</button></div>`;
          }).join('') : s.expenses ? '<p class="muted" style="margin:0">كل الالتزامات مدفوعة هذا الشهر 🎉</p>' : `<p class="muted" style="margin:0">لم تُدخل مبالغ بعد. <a href="#/month/${ym}">افتح الشهر</a> أو استخدم «+ إضافة سريعة».</p>`}
        </div>
        <div class="card"><h3>آخر 12 شهرًا</h3><div class="chartbox"><canvas id="bars"></canvas></div>${trackingNote()}</div>
      </div>
      ${varEntries.length ? variableCard(varEntries, rate, ym) : ''}`;
    const qa = $('#qa'); if (qa) qa.onclick = () => Quick.open();
    $('#setBudget').onclick = () => budgetModal(varEntries, rate);
    $$('[data-dueday]').forEach((b) => b.onclick = () => {
      const e = data.entries.find((x) => x.id === Number(b.dataset.dueday));
      const mm2 = modal(`<h2>موعد ${esc(e.name)} <button class="x" data-close>✕</button></h2>
        <p class="muted" style="margin:0 0 10px;font-size:13px">في أي يوم من الشهر يُستحق عادةً؟ يُحفظ للأشهر القادمة.</p>
        <input class="inp num" id="dd" type="number" min="1" max="31" placeholder="مثل 15" style="width:110px">
        <div class="mf"><button class="btn p" id="ok">حفظ</button></div>`);
      $('#ok', mm2.el).onclick = async () => {
        const d = Number($('#dd', mm2.el).value);
        if (!(d >= 1 && d <= 31)) return;
        const last = new Date(yy, mm, 0).getDate();
        try { const r = await patch('/api/entries/' + e.id, { due_date: `${ym}-${App.pad(Math.min(d, last))}` }); mm2.close(); toast(`حُفظ موعد ${esc(e.name)}: يوم ${d}`, { undo: r.auditId }); App.refresh(); } catch (er) { fail(er); }
      };
    });
    const gi = $('#gotIncome');
    if (gi) gi.onclick = async () => {
      try {
        let last;
        for (const e of pendingIncome) last = await patch('/api/entries/' + e.id, { status: 'paid' });
        toast('✓ سُجّل الدخل مستلمًا', { undo: pendingIncome.length === 1 ? last.auditId : undefined });
        App.refresh();
      } catch (er) { fail(er); }
    };
    $$('[data-pay]').forEach((b) => b.onclick = async () => {
      try { const r = await patch('/api/entries/' + b.dataset.pay, { status: 'paid' }); toast(`✓ ${esc(r.entry.name)} مدفوع`, { undo: r.auditId }); App.refresh(); } catch (er) { fail(er); }
    });
    barsChart($('#bars'));
  });

  // فئات المصاريف المتغيرة وميزانياتها
  const varCategories = () => { const v = App.sectionByKey('variable'); return v ? state.boot.templates.filter((t) => t.section_id === v.id) : []; };
  function variableBudget() {
    const sum = varCategories().reduce((a, c) => a + (c.budget || 0), 0);
    return sum || state.boot.settings.variable_budget || null;
  }
  // أول شهر سُجّلت فيه مصاريف متغيرة: قبله لا تصح المقارنة المباشرة
  function variableSince() {
    const m = [...state.boot.months].sort((a, b) => a.ym.localeCompare(b.ym)).find((x) => x.summary.variable > 0);
    return m ? m.ym : null;
  }
  const trackingNote = () => { const y = variableSince(); return y ? `<p class="faint" style="font-size:11.5px;margin:6px 0 0">الأزرق: مصاريف متغيرة، يبدأ تسجيلها من ${ymLabel(y)}. ما قبلها التزامات ثابتة فقط.</p>` : ''; };

  // بطاقة المصاريف المتغيرة: حسب الفئة مع الميزانية، حسب الشخص، وآخر 7 أيام
  function variableCard(list, rate, ym) {
    const byCat = {}, oneByCat = {}, byPerson = {};
    for (const e of list) {
      const k = e.note || 'أخرى';
      const v = Calc.entryValues(e, rate).local;
      byCat[k] = (byCat[k] || 0) + v;
      if (e.one_off) oneByCat[k] = (oneByCat[k] || 0) + v;
      if (e.person) byPerson[e.person] = (byPerson[e.person] || 0) + v;
    }
    const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const total = cats.reduce((a, c) => a + c[1], 0) || 1;
    const catT = (name) => varCategories().find((t) => t.name === name) || {};
    const icon = (name) => catT(name).icon || '•';
    const people = Object.entries(byPerson).sort((a, b) => b[1] - a[1]);
    const days = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(state.boot.today + 'T12:00:00'); d.setDate(d.getDate() - i); days.push(`${d.getFullYear()}-${App.pad(d.getMonth() + 1)}-${App.pad(d.getDate())}`); }
    const byDay = Object.fromEntries(days.map((d) => [d, 0]));
    for (const e of list) if (e.tx_date && byDay[e.tx_date] !== undefined) byDay[e.tx_date] += Calc.entryValues(e, rate).local;
    const maxDay = Math.max(...Object.values(byDay), 1);
    const WD = ['أحد', 'إثن', 'ثلا', 'أرب', 'خمي', 'جمع', 'سبت'];
    return `<div class="dash2" style="margin-top:12px">
      <div class="card"><h3>المصاريف المتغيرة حسب الفئة <a class="ms" href="#/month/${ym}">التفاصيل</a></h3>
        ${cats.map(([name, v]) => {
          const b = catT(name).budget;
          const pctB = b ? Math.round((v / b) * 100) : null;
          return `<div style="margin-bottom:9px"><div class="row" style="font-size:13px"><span>${esc(icon(name))} ${esc(name)}${oneByCat[name] ? ' <span class="tag t-mu" title="منها لمرة واحدة">لمرة واحدة</span>' : ''}</span>
            <span class="ms">${d$(v, rate)} <span class="faint">${b ? `من ${d$(b, rate)}` : Math.round((v / total) * 100) + '%'}</span></span></div>
            <div class="prog" style="height:6px;margin-top:3px"><i style="width:${b ? Math.min(100, pctB) : (v / cats[0][1]) * 100}%;background:${b && pctB > 100 ? 'var(--bad)' : b && pctB > 80 ? 'var(--warn)' : 'var(--var)'}"></i></div></div>`;
        }).join('')}
        ${people.length ? `<h3 style="margin-top:14px">حسب الشخص</h3><div class="chips">${people.map(([p, v]) => `<span class="chip" style="cursor:default">${esc(p)} · <b class="num">${d$(v, rate)}</b></span>`).join('')}</div>` : ''}</div>
      <div class="card"><h3>آخر 7 أيام</h3>
        <div style="display:flex;align-items:flex-end;gap:6px;height:150px;padding-top:6px">${days.map((d) => {
          const v = byDay[d];
          const wd = WD[new Date(d + 'T12:00:00').getDay()];
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end" title="${dateLabel(d)}: ${money(conv(v, rate), state.display)}">
            <span class="num faint" style="font-size:10.5px">${v ? compact(conv(v, rate)) : ''}</span>
            <i style="display:block;width:100%;max-width:34px;border-radius:5px 5px 2px 2px;background:${d === state.boot.today ? 'var(--accent)' : 'var(--var)'};opacity:${v ? 1 : .15};height:${Math.max(3, (v / maxDay) * 100)}%"></i>
            <span style="font-size:11px" class="${d === state.boot.today ? 'c-in' : 'muted'}">${d === state.boot.today ? 'اليوم' : wd}</span></div>`;
        }).join('')}</div></div></div>`;
  }

  // ميزانية شهرية لكل فئة، مع ما صُرف عليها هذا الشهر للمقارنة
  function budgetModal(list, rate) {
    const spentBy = {};
    for (const e of list) spentBy[e.note || 'أخرى'] = (spentBy[e.note || 'أخرى'] || 0) + Calc.entryValues(e, rate).local;
    const cats = varCategories();
    const m = modal(`<h2>ميزانيات المصاريف المتغيرة <button class="x" data-close>✕</button></h2>
      <p class="muted" style="margin:0 0 10px;font-size:13px">سقف شهري بالليرة لكل فئة. اترك الخانة فارغة لفئة بلا ميزانية.</p>
      <table class="tbl"><tr><th>الفئة</th><th>صُرف هذا الشهر</th><th>الميزانية</th></tr>
        ${cats.map((c) => `<tr><td>${esc(c.icon)} ${esc(c.name)}${c.one_off_default ? ' <span class="tag t-mu">لمرة واحدة</span>' : ''}</td><td class="num muted">${spentBy[c.name] ? money(spentBy[c.name]) : '—'}</td>
          <td><input class="inp num" data-b="${c.id}" inputmode="decimal" value="${c.budget || ''}" placeholder="—" style="width:110px;padding:5px 8px"></td></tr>`).join('')}</table>
      <div class="previewbox" id="btot"></div>
      <div class="mf"><button class="btn p" id="ok">حفظ</button><button class="btn" data-close>إلغاء</button></div>`, { wide: 520 });
    const upd = () => { $('#btot', m.el).innerHTML = `المجموع: <b class="num">${money($$('[data-b]', m.el).reduce((a, i) => a + (Calc.evalAmount(i.value) || 0), 0))}</b> شهريًا`; };
    $$('[data-b]', m.el).forEach((i) => i.oninput = upd);
    upd();
    $('#ok', m.el).onclick = async () => {
      try {
        for (const i of $$('[data-b]', m.el)) {
          const v = Calc.evalAmount(i.value);
          const c = cats.find((x) => x.id === Number(i.dataset.b));
          const nv = v > 0 ? v : null;
          if ((c.budget || null) !== nv) await patch('/api/templates/' + c.id, { budget: nv });
        }
        if (state.boot.settings.variable_budget) await put('/api/settings', { variable_budget: '' });
        m.close(); toast('حُفظت الميزانيات ✓'); App.refresh();
      } catch (e) { fail(e); }
    };
  }

  function barsChart(canvas) {
    const list = [...state.boot.months].sort((a, b) => a.ym.localeCompare(b.ym)).filter((m) => m.ym <= todayYm()).slice(-12);
    charts.push(new Chart(canvas, {
      data: { labels: list.map((m) => ymShort(m.ym)), datasets: [
        { type: 'line', label: 'المتبقي', data: list.map((m) => conv(m.summary.net, m.rate)), borderColor: css('--accent'), backgroundColor: css('--accent'), tension: .35, pointRadius: 2.5, borderWidth: 2.5, order: 0, stack: 'net' },
        { type: 'bar', label: 'الدخل', data: list.map((m) => conv(m.summary.income, m.rate)), backgroundColor: css('--in'), borderRadius: 4, order: 1, stack: 'inc' },
        // المصاريف عمود مكدّس: الثابتة ثم المتغيرة، حتى يظهر أن المتغيرة جديدة في التسجيل
        { type: 'bar', label: 'التزامات ثابتة', data: list.map((m) => conv(m.summary.expenses - m.summary.variable, m.rate)), backgroundColor: css('--ex'), borderRadius: 4, order: 1, stack: 'exp' },
        { type: 'bar', label: 'مصاريف متغيرة', data: list.map((m) => conv(m.summary.variable, m.rate)), backgroundColor: css('--var'), borderRadius: 4, order: 1, stack: 'exp' },
      ] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { rtl: true, labels: { boxWidth: 10, boxHeight: 10 } }, tooltip: { rtl: true, callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y, state.display)}` } } },
        scales: { x: { reverse: true, grid: { display: false } }, y: { position: 'right', stacked: true, ticks: { callback: (v) => compact(v) }, grid: { color: css('--line') } } },
        onClick: (ev, els) => { if (els[0]) location.hash = '#/month/' + list[els[0].index].ym; } },
    }));
  }

  // ============ الأشهر ============
  route('months', async (view) => {
    killCharts();
    const months = [...state.boot.months].sort((a, b) => b.ym.localeCompare(a.ym));
    let rows = '', cards = '';
    months.forEach((m, i) => {
      const s = m.summary;
      const save = s.income ? Math.round((s.net / s.income) * 100) : null;
      cards += `<a class="mcard" href="#/month/${m.ym}"><div class="r1"><b>${ymLabel(m.ym)}</b>${m.ym === todayYm() ? '<span class="pill" style="cursor:default">الحالي</span>' : ''}
        <span class="ms num c-fx">${m.rate ? '@' + fmtN(m.rate, 2) : '<span class="c-bad">بلا سعر</span>'}</span></div>
        <div class="r2"><div>الدخل<b class="c-in">${d$(s.income, m.rate)}</b></div><div>المصاريف<b>${d$(s.expenses, m.rate)}</b></div><div>المتبقي<b class="${s.net < 0 ? 'c-bad' : ''}">${d$(s.net, m.rate)}</b></div></div></a>`;
      rows += `<tr class="click" data-ym="${m.ym}"><td><b>${ymLabel(m.ym)}</b>${m.ym === todayYm() ? ' <span class="pill" style="cursor:default">الحالي</span>' : ''}</td>
        <td class="num c-fx">${m.rate ? fmtN(m.rate, 2) : '<span class="c-bad">—</span>'}${m.rate_method === 'manual' && m.rate ? ' ✎' : ''}</td>
        <td class="c-in">${d$(s.income, m.rate)}</td><td>${d$(s.expenses, m.rate)}</td><td><b>${d$(s.net, m.rate)}</b></td><td class="muted">${other$(s.net, m.rate)}</td>
        <td>${save === null ? '—' : `<span class="delta ${save >= 20 ? 'good' : save >= 0 ? 'neutral' : 'badd'}">${save}%</span>`}</td>
        <td class="faint">${s.unpaidCount ? s.unpaidCount + ' مستحق' : '✓'}</td><td><button class="btn sm ghost danger" data-del="${m.ym}" title="حذف الشهر">🗑</button></td></tr>`;
      const next = months[i + 1];
      if (next) {
        const missing = [];
        for (let y = shiftYm(m.ym, -1); y > next.ym; y = shiftYm(y, -1)) missing.push(y);
        if (missing.length) {
          const label = missing.length === 1 ? ymLabel(missing[0]) : `${ymLabel(missing[missing.length - 1])} – ${ymLabel(missing[0])}`;
          rows += `<tr class="gap"><td colspan="9">${label} · غير مسجّل <button class="link" data-add="${missing[0]}">+ إضافة</button></td></tr>`;
          cards += `<div class="mcard gap">${label} · غير مسجّل <button class="link ms" data-add="${missing[0]}">+ إضافة</button></div>`;
        }
      }
    });
    const recN = state.boot.series.filter((x) => x.status === 'active').length;
    view.innerHTML = `<div class="topbar"><h1>الأشهر</h1><div class="ms row">${displaySeg()}<a class="btn" href="#/recurring">⟳ المتكرر${recN ? ' (' + recN + ')' : ''}</a><button class="btn p" id="add">+ إضافة شهر</button></div></div>
      ${months.length ? `<div class="mcards m-only">${cards}</div><div class="card tw d-only" style="padding:6px 8px"><table class="tbl"><tr><th>الشهر</th><th>سعر $</th><th>الدخل</th><th>المصاريف</th><th>المتبقي</th><th>${state.display === 'USD' ? 'بالليرة' : 'بالدولار'}</th><th>الادخار</th><th>الحالة</th><th></th></tr>${rows}</table></div>`
        : `<div class="card empty"><div class="art">🗓</div><h2>لا توجد أشهر بعد</h2><p>أضف الشهر الحالي أو أي شهر سابق، أو استورد ملف Excel.</p><div class="row" style="justify-content:center"><button class="btn p" id="add2">+ إضافة شهر</button><a class="btn" href="#/import">📥 استيراد</a></div></div>`}`;
    $('#add').onclick = () => AddMonth.open();
    const a2 = $('#add2'); if (a2) a2.onclick = () => AddMonth.open();
    $$('tr.click').forEach((tr) => tr.onclick = (e) => { if (!e.target.closest('button')) location.hash = '#/month/' + tr.dataset.ym; });
    $$('[data-add]').forEach((b) => b.onclick = (e) => { e.preventDefault(); AddMonth.open(b.dataset.add); });
    $$('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await confirmBox(`حذف ${ymLabel(b.dataset.del)} بكل بنوده؟ يمكن التراجع.`, 'حذف', true))) return;
      try { const r = await del('/api/months/' + b.dataset.del); toast('حُذف الشهر', { undo: r.auditId }); App.refresh(); } catch (e) { fail(e); }
    });
  });

  // ============ إضافة شهر ============
  const AddMonth = {
    open(presetYm) {
      const now = todayYm();
      const has = new Set(state.boot.months.map((m) => m.ym));
      const years = new Set([+now.slice(0, 4) + 1]);
      for (let y = +now.slice(0, 4); y >= +now.slice(0, 4) - 6; y--) years.add(y);
      state.boot.months.forEach((m) => years.add(m.year));
      const s = { year: presetYm ? +presetYm.slice(0, 4) : +now.slice(0, 4), month: presetYm ? +presetYm.slice(5) : null,
        method: state.boot.settings.default_method || 'avg', manual: '', rates: null, edit: false, adv: false, mode: 'templates', loading: false };
      if (!s.month) for (let d = 0; d < 48; d++) { const y = shiftYm(now, -d); if (!has.has(y)) { s.year = +y.slice(0, 4); s.month = +y.slice(5); break; } }
      const m = modal(`<h2>إضافة شهر <button class="x" data-close>✕</button></h2><div id="amb"></div>`);
      const b = $('#amb', m.el);
      const ym = () => `${s.year}-${App.pad(s.month)}`;
      async function loadRates() {
        s.rates = null; s.loading = true; draw();
        try { s.rates = await get('/api/fx/month/' + ym()); } catch { s.rates = {}; }
        s.loading = false;
        if (!(s.rates.avg && s.rates.avg.rate)) { s.method = 'manual'; s.edit = true; }
        draw();
      }
      const chosen = () => (s.method === 'manual' ? Calc.evalAmount(s.manual) : s.rates && s.rates[s.method] && s.rates[s.method].rate);
      function draw() {
        const exists = s.month && has.has(ym());
        const r = s.rates || {};
        const rv = chosen();
        const noAuto = s.rates && !(r.avg && r.avg.rate);
        b.innerHTML = `
          <label class="fl">السنة</label>
          <div class="chips">${[...years].sort().map((y) => `<button class="chip ${y === s.year ? 'on' : ''}" data-y="${y}">${y}</button>`).join('')}</div>
          <label class="fl">الشهر <span class="faint">· الأخضر مسجّل مسبقًا</span></label>
          <div class="yrgrid">${MONTHS_S.map((n, i) => { const k = `${s.year}-${App.pad(i + 1)}`; return `<button class="${i + 1 === s.month ? 'on' : has.has(k) ? 'has' : ''}" data-m="${i + 1}">${n}</button>`; }).join('')}</div>
          ${exists ? `<div class="previewbox">${ymLabel(ym())} مسجّل مسبقًا.</div><div class="mf"><a class="btn p" href="#/month/${ym()}" data-go>فتح ${ymLabel(ym())}</a></div>` : !s.month ? '' : `
          <label class="fl">سعر صرف الدولار لهذا الشهر</label>
          ${!s.edit ? `<div class="ratebox">1 $ = <b class="num">${s.loading ? '…' : rv ? fmtN(rv, 2) : '—'}</b> ₺ <span style="opacity:.85">${methodLabel[s.method]}${r[s.method] && r[s.method].days > 1 ? ` · ${r[s.method].days} أيام` : ''}${r[s.method] && r[s.method].complete === false ? ' · حتى اليوم' : ''}</span><button class="link ms" id="edit">تعديل</button></div>`
          : `${noAuto ? `<div class="warnline" style="margin:0 0 8px">لا يتوفر سعر تلقائي لهذا الشهر (المتاح من ${dateLabel(state.boot.settings.history_start)}). أدخله يدويًا، أو اتركه فارغًا وأدخله لاحقًا.</div>` : `
            <button class="opt ${s.method === 'avg' ? 'on' : ''}" data-meth="avg"><span class="r"></span>متوسط الشهر<span class="val num">${r.avg && r.avg.rate ? fmtN(r.avg.rate, 2) : '—'}</span></button>
            <button class="opt ${s.method === 'end' ? 'on' : ''}" data-meth="end"><span class="r"></span>آخر يوم في الشهر<span class="val num">${r.end && r.end.rate ? fmtN(r.end.rate, 2) : '—'}</span></button>`}
            <div class="opt ${s.method === 'manual' ? 'on' : ''}" data-meth="manual"><span class="r"></span>يدوي<input class="inp num ms" id="man" inputmode="decimal" value="${esc(s.manual)}" placeholder="مثل 30.90"></div>`}
          ${s.adv ? `<label class="fl">البنود الأولية</label><div class="chips">
            <button class="chip ${s.mode === 'templates' ? 'on' : ''}" data-mode="templates">من البنود المعتادة</button>
            <button class="chip ${s.mode === 'copy' ? 'on' : ''}" data-mode="copy">مثل آخر شهر مسجّل</button>
            <button class="chip ${s.mode === 'copy_amounts' ? 'on' : ''}" data-mode="copy_amounts">مثله مع المبالغ</button>
            <button class="chip ${s.mode === 'empty' ? 'on' : ''}" data-mode="empty">فارغ</button></div>` : ''}
          <div class="errline" id="err"></div>
          <div class="mf"><button class="btn p" id="go" ${s.loading ? 'disabled' : ''}>إنشاء ${ymLabel(ym())}</button><button class="btn" data-x>إلغاء</button></div>
          ${s.adv ? '' : '<button class="link" id="adv" style="margin-top:10px">خيارات متقدمة ⌄</button>'}`}`;
        $$('[data-y]', b).forEach((x) => x.onclick = () => { s.year = +x.dataset.y; s.edit = false; s.method = state.boot.settings.default_method || 'avg'; if (s.month && !has.has(ym())) loadRates(); else draw(); });
        $$('[data-m]', b).forEach((x) => x.onclick = () => { s.month = +x.dataset.m; s.edit = false; s.method = state.boot.settings.default_method || 'avg'; if (!has.has(ym())) loadRates(); else draw(); });
        const e = $('#edit', b); if (e) e.onclick = () => { s.edit = true; draw(); };
        $$('[data-meth]', b).forEach((x) => x.onclick = (ev) => { if (ev.target.tagName === 'INPUT') return; s.method = x.dataset.meth; draw(); if (s.method === 'manual') $('#man', b).focus(); });
        const man = $('#man', b); if (man) man.oninput = () => { s.manual = man.value; s.method = 'manual'; };
        $$('[data-mode]', b).forEach((x) => x.onclick = () => { s.mode = x.dataset.mode; draw(); });
        const adv = $('#adv', b); if (adv) adv.onclick = () => { s.adv = true; draw(); };
        const cx = $('[data-x]', b); if (cx) cx.onclick = m.close;
        const g = $('[data-go]', b); if (g) g.onclick = m.close;
        const go = $('#go', b);
        if (go) go.onclick = async () => {
          const rate = chosen();
          if (s.method === 'manual' && s.manual && !(rate > 0)) { $('#err', b).textContent = 'أدخل سعرًا صحيحًا'; return; }
          go.disabled = true;
          try {
            await post('/api/months', { year: s.year, month: s.month, mode: s.mode, method: s.method, rate: s.method === 'manual' && rate > 0 ? rate : undefined });
            m.close(); await App.reloadBoot(); location.hash = '#/month/' + ym();
          } catch (er) { $('#err', b).textContent = er.message; go.disabled = false; }
        };
      }
      if (s.month && !has.has(ym())) loadRates(); else draw();
    },
  };
  App.AddMonth = AddMonth;

  // ============ صفحة الشهر ============
  route('month', async (view, r) => {
    killCharts();
    const ym = r.args[0] || todayYm();
    let data;
    try { data = await get('/api/months/' + ym); } catch {
      view.innerHTML = `<div class="topbar"><a class="btn icon" href="#/month/${shiftYm(ym, -1)}">›</a><h1>${ymLabel(ym)}</h1><a class="btn icon" href="#/month/${shiftYm(ym, 1)}">‹</a></div>
        <div class="card empty"><div class="art">🗓</div><h2>${ymLabel(ym)} غير مسجّل</h2><p>أنشئه ببنودك المعتادة وبسعر صرف ذلك الشهر.</p><button class="btn p" id="mk">إنشاء ${ymLabel(ym)}</button></div>`;
      $('#mk').onclick = () => AddMonth.open(ym);
      return;
    }
    renderMonth(view, { data, ym, open: null });
  });

  function renderMonth(view, M) {
    const { data, ym } = M;
    const rate = data.rate && data.rate.rate;
    const rl = data.rate;
    const secs = state.boot.sections.filter((s) => s.active || data.entries.some((e) => e.section_id === s.id));
    const hasEmpty = data.entries.some((e) => e.amount == null && !e.series_id);
    const due = data.entries.filter((e) => e.series_id && e.status !== 'paid');
    const review = data.entries.filter((e) => e.needs_review);
    view.innerHTML = `
      <div class="topbar">
        <a class="btn icon" href="#/month/${data.prev || shiftYm(ym, -1)}" title="الشهر السابق">›</a><h1>${ymLabel(ym)}</h1><a class="btn icon" href="#/month/${data.next || shiftYm(ym, 1)}" title="الشهر التالي">‹</a>
        <button class="pill" id="ratePill" ${!rate ? 'style="background:var(--bad-soft);color:var(--bad)"' : ''}>${rate ? `${rl.locked ? '<span class="lock">🔒</span>' : ''}1 $ = <span class="num">${fmtN(rate, 2)}</span> ₺ <span style="font-weight:400;opacity:.8">· ${methodLabel[rl.method] || ''}${!rl.locked && rl.method !== 'manual' ? ' حتى اليوم' : ''} · تعديل</span>` : '⚠ لا يوجد سعر صرف · أدخله'}</button>
        <div class="ms row">${due.length ? `<button class="btn" id="confirmDue">✓ تأكيد ${due.length} دفعات متكررة</button>` : ''}${hasEmpty && data.prev ? '<button class="btn" id="fillPrev">⧉ مثل الشهر السابق</button>' : ''}<button class="btn p hide-m" id="qa">+ إضافة سريعة</button></div>
      </div>
      ${review.length ? `<div class="card" style="border-color:var(--warn);margin-bottom:12px;font-size:13px">⚠ ${review.length} بند متكرر تغيّر مبلغه بعد تأكيد دفعه: ${review.map((e) => esc(e.name)).join('، ')}. راجع المبلغ ثم اضغط «تمت المراجعة» من قائمة البند.</div>` : ''}
      ${secs.map((s) => sectionHtml(s, M)).join('')}
      <div class="sticky" id="foot"></div>`;
    footer(M);
    bindMonth(view, M);
  }

  function sectionHtml(s, M) {
    const list = M.data.entries.filter((e) => e.section_id === s.id);
    if (!list.length && (s.key === 'variable' || s.key === 'debts')) {
      return `<div class="sect" style="--c:${secColor(s)}"><div class="sect-h"><span class="bar"></span><strong>${esc(s.name)}</strong>
        ${s.key === 'debts' ? '<a class="add" href="#/debts">الديون ←</a>' : `<button class="add" data-addsec="${s.id}">+ إضافة</button>`}<span class="tot faint">لا شيء</span></div></div>`;
    }
    return `<div class="sect" style="--c:${secColor(s)}">
      <div class="sect-h"><span class="bar"></span><strong>${esc(s.name)}</strong><button class="add" data-addsec="${s.id}">+ إضافة</button>
        <span class="tot num money" style="color:${secColor(s)}" data-sectot="${s.id}"></span></div>
      ${list.map((e) => lineHtml(e, M)).join('')}</div>`;
  }

  function periodText(sr, ym) {
    const p = sr && sr.periods.find((x) => x.from_ym <= ym && (!x.to_ym || ym <= x.to_ym));
    if (!p) return '⟳ متكرر';
    return `⟳ ${App.ymShort(p.from_ym)} – ${p.to_ym ? App.ymShort(p.to_ym) : 'مستمر'}`;
  }

  function subtitle(e, v, income, M) {
    const bits = [];
    if (e.series_id) bits.push(`<span class="recb" data-series="${e.series_id}">${periodText(M.data.series[e.series_id], M.ym)}${e.series_override ? ' · استثناء' : ''}</span>`);
    if (e.needs_review) bits.push('<span class="reviewb">يحتاج مراجعة</span>');
    if (v.isExpected && e.planned) bits.push(`متوقع ${money(e.planned, e.currency)}`);
    if (!v.isExpected && e.planned && !e.series_id && e.amount > e.planned * 1.15) bits.push(`<span class="c-bad">أعلى من المعتاد بـ ${Math.round(((e.amount - e.planned) / e.planned) * 100)}%</span>`);
    if (e.status !== 'paid' && e.due_date) bits.push(e.due_date < state.boot.today ? `<span class="c-bad">متأخر · ${dateLabel(e.due_date)}</span>` : `يستحق ${dateLabel(e.due_date)}`);
    if (e.tx_date) bits.push(`بتاريخ ${dateLabel(e.tx_date)}`);
    if (e.fx_source === 'معلّق') bits.push('<span class="tag t-fx" title="يُجلب سعر صرف يومها عند الاتصال">السعر معلّق</span>');
    if (e.source === 'import') bits.push('من Excel');
    if (e.note && !income) bits.push(esc(e.note));
    if (e.person) bits.push(`لـ ${esc(e.person)}`);
    if (e.one_off) bits.push('<span class="tag t-mu">لمرة واحدة</span>');
    if (e.status === 'partial') bits.push(`دُفع ${money(e.paid_amount || 0, e.currency)}`);
    return bits.join(' · ');
  }

  function lineHtml(e, M) {
    const rate = M.data.rate && M.data.rate.rate;
    const v = Calc.entryValues(e, rate);
    const sec = sectionById(e.section_id);
    const income = sec && sec.kind === 'income';
    const other = e.currency === 'USD' ? money(v.local, LOCAL) : (v.rate ? money(v.usd, 'USD') : '');
    return `<div class="line ${e.status === 'paid' ? 'paid' : ''} ${!e.series_id && !v.isExpected && e.planned && e.amount > e.planned * 1.15 && !income ? 'over' : ''}" data-id="${e.id}">
      <div class="item" data-open="${e.id}">${iconFor(e)}<div class="nm"><span>${esc(e.name)}</span><small>${subtitle(e, v, income, M)}</small></div></div>
      <div class="amt"><div class="seg"><button data-cur="${LOCAL}" class="${e.currency !== 'USD' ? 'on' : ''}" tabindex="-1">₺</button><button data-cur="USD" class="${e.currency === 'USD' ? 'on' : ''}" tabindex="-1">$</button></div>
        <input class="money" data-amt inputmode="decimal" value="${e.amount ?? ''}" placeholder="${e.planned ? fmtN(e.planned) : '0'}" autocomplete="off"></div>
      <div class="eq num money" data-eq>${v.amount && other ? '≈ ' + other : ''}${e.fx_rate ? `<span class="rt">@${fmtN(e.fx_rate, 2)}</span>` : ''}</div>
      <button class="st ${e.status}" data-st>${stLabel(e.status, income)}</button>
      <button class="more" data-more title="خيارات">⋮</button>
      ${M.open === e.id ? drawerHtml(e, income) : ''}
    </div>`;
  }

  function drawerHtml(e, income) {
    return `<div class="drawer">
      <label>الاسم<input class="inp" data-f="name" value="${esc(e.name)}"></label>
      <label>الحالة<select class="inp" data-f="status">
        <option value="paid" ${e.status === 'paid' ? 'selected' : ''}>${income ? 'مستلم' : 'مدفوع'}</option>
        ${income ? '' : `<option value="partial" ${e.status === 'partial' ? 'selected' : ''}>مدفوع جزئيًا</option>`}
        <option value="unpaid" ${e.status === 'unpaid' ? 'selected' : ''}>${income ? 'متوقع' : 'مستحق'}</option></select></label>
      ${e.status === 'partial' ? `<label>المدفوع منه<input class="inp num" data-f="paid_amount" inputmode="decimal" value="${e.paid_amount ?? ''}"></label>` : ''}
      ${e.series_id ? '' : `<label>المبلغ المعتاد<input class="inp num" data-f="planned" inputmode="decimal" value="${e.planned ?? ''}"></label>`}
      ${income ? '' : `<label>تاريخ الاستحقاق<input class="inp" type="date" data-f="due_date" value="${e.due_date || ''}"></label>`}
      <label>تاريخ العملية <span class="faint">(لسعر يومها)</span><input class="inp" type="date" data-f="tx_date" value="${e.tx_date || ''}" max="${state.boot.today}"></label>
      <label>السعر المطبّق<span class="num c-fx" style="padding:7px 0">${e.fx_rate ? `${fmtN(e.fx_rate, 4)} · ${esc(e.fx_source || '')}` : 'سعر الشهر'}</span></label>
      ${e.tx_date ? `<label>تعديل سعر هذا البند يدويًا<input class="inp num" data-f="fx_manual" inputmode="decimal" placeholder="${e.fx_rate || ''}"></label>` : ''}
      ${App.sectionById(e.section_id)?.key === 'variable' ? `
      <label>الفئة<select class="inp" data-f="note">${varCategories().map((c) => `<option value="${esc(c.name)}" ${c.name === e.note ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}${e.note && !varCategories().some((c) => c.name === e.note) ? `<option selected>${esc(e.note)}</option>` : ''}</select></label>
      <label>لمن؟<select class="inp" data-f="person"><option value="">—</option>${[...new Set([...(state.boot.settings.people || []), ...(e.person ? [e.person] : [])])].map((p) => `<option ${p === e.person ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" data-f="one_off" ${e.one_off ? 'checked' : ''}> لمرة واحدة</label>`
      : `<label style="grid-column:1/-1">ملاحظة<input class="inp" data-f="note" value="${esc(e.note)}"></label>`}
      <div class="full"><button class="btn sm danger" data-delentry>🗑 حذف البند</button><span class="ms"></span><button class="btn sm" data-closedrawer>إغلاق</button></div>
    </div>`;
  }

  function footer(M) {
    const s = Calc.summarize(M.data.entries, M.data.rate && M.data.rate.rate, state.boot.sections);
    M.data.summary = s;
    const r = M.data.rate && M.data.rate.rate;
    $('#foot').innerHTML = `
      <div><span class="l">الدخل</span><b class="num money">${money(s.income)}</b></div>
      <div><span class="l">المصاريف</span><b class="num money">${money(s.expenses)}</b></div>
      <div><span class="l">باقي للدفع</span><b class="num money" style="color:#ff8787">${money(s.remaining)}</b></div>
      <div><span class="l">المتبقي</span><b><span class="num money">${money(s.net)}</span>${r ? ` · <span class="num money">${money(s.net / r, 'USD')}</span>` : ''}</b></div>
      <span class="saved" id="saved">✓ محفوظ</span>`;
    const budget = state.boot.settings.variable_budget;
    for (const sec of state.boot.sections) {
      const el = $(`[data-sectot="${sec.id}"]`);
      if (el) el.textContent = money(s.bySection[sec.id] || 0) + (sec.key === 'variable' && budget ? ` من ${money(budget)}` : '');
    }
  }
  const setSaving = (on) => { const el = $('#saved'); if (el) el.textContent = on ? 'جارٍ الحفظ…' : '✓ محفوظ'; };

  function replaceLine(M, id) {
    const e = M.data.entries.find((x) => x.id === id);
    const old = $(`.line[data-id="${id}"]`);
    if (!old || !e) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = lineHtml(e, M);
    const nu = tmp.firstElementChild;
    old.replaceWith(nu);
    bindLine(nu, M);
    return nu;
  }
  async function reloadMonth(M) {
    M.data = await get('/api/months/' + M.ym);
    await App.reloadBoot();
    renderMonth($('#view'), M);
  }
  async function savePatch(M, id, body, opts = {}) {
    setSaving(true);
    try {
      const r = await patch('/api/entries/' + id, body);
      const i = M.data.entries.findIndex((x) => x.id === id);
      M.data.entries[i] = r.entry;
      if (!opts.keepLine) replaceLine(M, id);
      footer(M);
      if (r.entry.debt_id) App.reloadBoot();
      return r.entry;
    } catch (er) { fail(er); setSaving(false); }
  }

  function bindMonth(view, M) {
    const qa = $('#qa'); if (qa) qa.onclick = () => Quick.open();
    $('#ratePill').onclick = () => rateModal(M);
    const fp = $('#fillPrev'); if (fp) fp.onclick = async () => {
      try { const r = await post(`/api/months/${M.ym}/fill-previous`); toast(`عُبّئ ${r.filled} بنود من الشهر السابق`, { undo: r.auditId }); reloadMonth(M); } catch (e) { fail(e); }
    };
    const cd = $('#confirmDue'); if (cd) cd.onclick = async () => {
      const ids = [...new Set(M.data.entries.filter((e) => e.series_id && e.status !== 'paid').map((e) => e.series_id))];
      if (!(await confirmBox(`تأكيد أن ${ids.length === 1 ? 'الدفعة المتكررة دُفعت' : 'الدفعات المتكررة دُفعت'} فعلًا في ${ymLabel(M.ym)}؟`, 'نعم، دُفعت'))) return;
      try { for (const id of ids) await post(`/api/series/${id}/confirm`, { months: [M.ym] }); toast('✓ تم التأكيد'); reloadMonth(M); } catch (e) { fail(e); }
    };
    $$('[data-addsec]').forEach((b) => b.onclick = () => addItemModal(M, Number(b.dataset.addsec)));
    $$('.line').forEach((l) => bindLine(l, M));
  }

  function bindLine(line, M) {
    const id = Number(line.dataset.id);
    const e = () => M.data.entries.find((x) => x.id === id);
    const input = $('[data-amt]', line);
    const rate = () => M.data.rate && M.data.rate.rate;
    input.addEventListener('input', () => {
      const v = Calc.evalAmount(input.value);
      input.parentElement.classList.toggle('err', Number.isNaN(v));
      if (Number.isNaN(v)) return;
      const cur = e();
      const tmp = { ...cur, amount: v };
      const vals = Calc.entryValues(tmp, rate());
      $('[data-eq]', line).innerHTML = vals.amount ? '≈ ' + (cur.currency === 'USD' ? money(vals.local) : vals.rate ? money(vals.usd, 'USD') : '') : '';
      const idx = M.data.entries.findIndex((x) => x.id === id);
      const saved = M.data.entries[idx];
      M.data.entries[idx] = tmp; footer(M); M.data.entries[idx] = saved;
    });
    const commit = async () => {
      const v = Calc.evalAmount(input.value);
      if (Number.isNaN(v)) return;
      const cur = e();
      if ((v ?? null) === (cur.amount ?? null)) { input.value = cur.amount ?? ''; return; }
      input.value = v ?? '';
      // بند متكرر: اسأل عن نطاق التعديل
      if (cur.series_id && v != null) { Series.scopeModal(cur, v, M.ym, () => reloadMonth(M), () => { input.value = cur.amount ?? ''; footer(M); }); return; }
      const ne = await savePatch(M, id, { amount: v }, { keepLine: true });
      if (ne) { const l = replaceLine(M, id); if (l) l.classList.add('saved-flash'); }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const all = $$('[data-amt]');
        const next = all[all.indexOf(input) + 1];
        commit().then(() => { const n = next && $(`.line[data-id="${next.closest('.line').dataset.id}"] [data-amt]`); if (n) n.focus(); });
      }
    });
    input.addEventListener('blur', () => { commit(); });
    $$('[data-cur]', line).forEach((b) => b.onclick = (ev) => {
      ev.preventDefault();
      const cur = e();
      const to = b.dataset.cur;
      if (to === cur.currency) return;
      const r = cur.fx_rate || rate();
      if (!r && cur.amount != null) { toast('لا يوجد سعر صرف لهذا الشهر لتحويل المبلغ. أدخل السعر أولًا', { error: true }); return; }
      const cv = (n) => (n == null ? n : Calc.round2(Calc.convert(n, cur.currency, to, r)));
      savePatch(M, id, { currency: to, amount: cv(cur.amount), planned: cv(cur.planned), paid_amount: cv(cur.paid_amount) });
    });
    // تغيير الحالة بنقرة: مع إشعار تراجع حتى لا تمر النقرة الخاطئة دون انتباه
    $('[data-st]', line).onclick = async () => {
      const cur = e();
      const to = cur.status === 'paid' ? 'unpaid' : 'paid';
      setSaving(true);
      try {
        const r = await patch('/api/entries/' + id, { status: to });
        M.data.entries[M.data.entries.findIndex((x) => x.id === id)] = r.entry;
        replaceLine(M, id); footer(M);
        toast(`${esc(cur.name)}: ${stLabel(to, sectionById(cur.section_id)?.kind === 'income')}`, { undo: r.auditId, ms: 6000 });
      } catch (er) { fail(er); setSaving(false); }
    };
    $('[data-open]', line).onclick = (ev) => {
      const rb = ev.target.closest('[data-series]');
      if (rb) { location.hash = '#/recurring/' + rb.dataset.series; return; }
      M.open = M.open === id ? null : id; replaceLine(M, id);
    };
    $('[data-more]', line).onclick = (ev) => lineMenu(ev.currentTarget, e(), M);
    $$('[data-f]', line).forEach((f) => f.onchange = () => {
      let val = f.value;
      if (f.type === 'checkbox') val = f.checked ? 1 : 0;
      if (['paid_amount', 'planned', 'fx_manual'].includes(f.dataset.f)) { val = Calc.evalAmount(val); if (Number.isNaN(val)) return; }
      if (f.dataset.f === 'name' && !val.trim()) return;
      savePatch(M, id, { [f.dataset.f]: val === '' ? null : val });
    });
    const dl = $('[data-delentry]', line);
    if (dl) dl.onclick = async () => {
      try {
        const name = e().name;
        const r = await del('/api/entries/' + id);
        M.data.entries = M.data.entries.filter((x) => x.id !== id);
        line.remove(); footer(M);
        toast(`حُذف ${esc(name)}`, { undo: r.auditId });
      } catch (er) { fail(er); }
    };
    const cd = $('[data-closedrawer]', line); if (cd) cd.onclick = () => { M.open = null; replaceLine(M, id); };
  }

  function lineMenu(anchor, e, M) {
    $$('.menu').forEach((x) => x.remove());
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = `${e.series_id
      ? `<button class="rec" data-a="series">⟳ فتح البند المتكرر</button>${e.needs_review ? '<button data-a="reviewed">✓ تمت المراجعة</button>' : ''}${e.series_override ? '<button data-a="unoverride">↺ إلغاء الاستثناء (العودة لمبلغ الفترة)</button>' : ''}`
      : (e.debt_id ? '' : '<button class="rec" data-a="recur">⟳ اجعله بندًا متكررًا…</button>')}
      <button data-a="details">✎ التفاصيل</button><button class="danger" data-a="delete">🗑 حذف</button>`;
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + scrollY + 4}px`;
    menu.style.left = `${Math.max(8, r.left + scrollX - 200)}px`;
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
    $$('[data-a]', menu).forEach((b) => b.onclick = async () => {
      menu.remove();
      const a = b.dataset.a;
      if (a === 'series') location.hash = '#/recurring/' + e.series_id;
      if (a === 'recur') Series.editor({ fromEntry: e, ym: M.ym, onDone: () => reloadMonth(M) });
      if (a === 'details') { M.open = e.id; replaceLine(M, e.id); }
      if (a === 'reviewed') savePatch(M, e.id, { needs_review: 0 });
      if (a === 'delete') {
        try { const r = await del('/api/entries/' + e.id); toast(`حُذف ${esc(e.name)}`, { undo: r.auditId }); reloadMonth(M); } catch (er) { fail(er); }
      }
      if (a === 'unoverride') {
        try { const r = await post(`/api/series/${e.series_id}/reset-entry`, { entry_id: e.id }); toast('عاد البند لمبلغ الفترة', { undo: r.auditId }); reloadMonth(M); } catch (er) { fail(er); }
      }
    });
  }

  function addItemModal(M, sectionId) {
    const sec = sectionById(sectionId);
    const used = new Set(M.data.entries.map((e) => e.template_id).filter(Boolean));
    const avail = state.boot.templates.filter((t) => t.section_id === sectionId && !used.has(t.id));
    const isVar = sec.key === 'variable';
    const m = modal(`<h2>إضافة إلى ${esc(sec.name)} <button class="x" data-close>✕</button></h2>
      ${avail.length && !isVar ? `<label class="fl">من بنودك</label><div class="chips">${avail.map((t) => `<button class="chip" data-t="${t.id}">${esc(t.name)}${t.active ? '' : ' ·موقوف'}</button>`).join('')}</div>` : ''}
      <label class="fl">${isVar ? 'على ماذا؟' : 'أو بند جديد'}</label><input class="inp" id="nm" placeholder="الاسم">
      ${isVar ? `<label class="fl">الفئة</label><div class="chips">${avail.map((t) => `<button class="chip" data-cat="${esc(t.name)}">${esc(t.icon)} ${esc(t.name)}</button>`).join('')}</div>` : ''}
      <label class="fl">المبلغ</label>
      <div class="amt big"><div class="seg"><button data-c="${LOCAL}" class="on">₺</button><button data-c="USD">$</button></div><input id="am" inputmode="decimal" placeholder="0"></div>
      ${isVar ? `<label class="fl">التاريخ</label><input class="inp" type="date" id="dt" value="${M.ym === todayYm() ? state.boot.today : M.ym + '-01'}" min="${M.ym}-01" max="${M.ym}-31">`
        : '<label class="fl" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="keep" checked> احفظه في بنودي المعتادة ليظهر في الأشهر القادمة</label>'}
      <div class="errline" id="err"></div><div class="mf"><button class="btn p" id="ok">إضافة</button><button class="btn" data-close>إلغاء</button></div>`);
    const el = m.el;
    let cur = LOCAL, tplId = null, cat = '';
    $$('[data-c]', el).forEach((b) => b.onclick = () => { cur = b.dataset.c; $$('[data-c]', el).forEach((x) => x.classList.toggle('on', x === b)); });
    $$('[data-t]', el).forEach((b) => b.onclick = () => {
      const t = templateById(Number(b.dataset.t)); tplId = t.id; $('#nm', el).value = t.name; cur = t.currency;
      $$('[data-c]', el).forEach((x) => x.classList.toggle('on', x.dataset.c === cur)); $$('[data-t]', el).forEach((x) => x.classList.toggle('on', x === b));
      if (t.planned_amount) $('#am', el).placeholder = fmtN(t.planned_amount);
      $('#am', el).focus();
    });
    $$('[data-cat]', el).forEach((b) => b.onclick = () => { cat = b.dataset.cat; $$('[data-cat]', el).forEach((x) => x.classList.toggle('on', x === b)); });
    $('#nm', el).oninput = () => { tplId = null; $$('[data-t]', el).forEach((x) => x.classList.remove('on')); };
    $('#ok', el).onclick = async () => {
      const name = $('#nm', el).value.trim() || cat;
      const amount = Calc.evalAmount($('#am', el).value);
      if (!name) { $('#err', el).textContent = 'أدخل الاسم'; return; }
      if (Number.isNaN(amount)) { $('#err', el).textContent = 'مبلغ غير صحيح'; return; }
      try {
        let template_id = tplId;
        const t = tplId && templateById(tplId);
        if (t && !t.active) await patch('/api/templates/' + t.id, { active: 1 });
        if (!tplId && !isVar && $('#keep', el).checked) template_id = (await post('/api/templates', { section_id: sectionId, name, currency: cur, planned_amount: amount, aliases: name })).id;
        await post(`/api/months/${M.ym}/entries`, { section_id: sectionId, template_id, name, currency: cur, amount, planned: t ? t.planned_amount : amount,
          tx_date: isVar ? $('#dt', el).value : null, recurrence: isVar ? 'once' : 'monthly', note: cat, status: isVar ? 'paid' : 'unpaid' });
        m.close(); reloadMonth(M);
      } catch (er) { $('#err', el).textContent = er.message; }
    };
  }

  async function rateModal(M) {
    const cur = M.data.rate || {};
    const s = { method: cur.rate ? cur.method || 'avg' : 'manual', manual: cur.method === 'manual' && cur.rate ? String(cur.rate) : '', rates: null };
    const m = modal(`<h2>سعر صرف ${ymLabel(M.ym)} <button class="x" data-close>✕</button></h2><div id="rb"><div class="spinner"></div></div>`);
    const b = $('#rb', m.el);
    try { s.rates = await get('/api/fx/month/' + M.ym); } catch { s.rates = {}; }
    const noAuto = !(s.rates.avg && s.rates.avg.rate);
    if (noAuto) s.method = 'manual';
    const newRate = () => (s.method === 'manual' ? Calc.evalAmount(s.manual) : s.rates[s.method] && s.rates[s.method].rate);
    function draw() {
      const nr = newRate();
      const before = Calc.summarize(M.data.entries, cur.rate, state.boot.sections);
      const after = nr > 0 ? Calc.summarize(M.data.entries, nr, state.boot.sections) : null;
      const own = M.data.entries.filter((e) => e.fx_rate).length;
      b.innerHTML = `
        <div class="ratebox" style="margin-bottom:12px">الحالي: 1 $ = <b class="num">${cur.rate ? fmtN(cur.rate, 4) : '—'}</b> ₺ <span class="ms">${cur.rate ? methodLabel[cur.method] || '' : ''}${cur.source ? ' · ' + esc(cur.source) : ''}${cur.locked ? ' · 🔒' : ''}</span></div>
        ${noAuto ? `<div class="warnline" style="margin-bottom:8px">لا يتوفر سعر تلقائي قبل ${dateLabel(s.rates.history_start || state.boot.settings.history_start)}. أدخل السعر يدويًا.</div>` : `
        <button class="opt ${s.method === 'avg' ? 'on' : ''}" data-meth="avg"><span class="r"></span>متوسط الشهر${s.rates.avg ? ` · ${s.rates.avg.days} أيام${s.rates.avg.complete ? '' : ' حتى اليوم'}` : ''}<span class="val num">${s.rates.avg ? fmtN(s.rates.avg.rate, 4) : '—'}</span></button>
        <button class="opt ${s.method === 'end' ? 'on' : ''}" data-meth="end"><span class="r"></span>آخر يوم في الشهر<span class="val num">${s.rates.end && s.rates.end.rate ? fmtN(s.rates.end.rate, 4) : '—'}</span></button>`}
        <div class="opt ${s.method === 'manual' ? 'on' : ''}" data-meth="manual"><span class="r"></span>يدوي<input class="inp num ms" id="man" inputmode="decimal" value="${esc(s.manual)}" placeholder="0.00"></div>
        ${after && after.usd ? `<div class="previewbox">المتبقي بالدولار: <b class="num">${before.usd ? money(before.usd.net, 'USD') : '—'}</b> ← <b class="num">${money(after.usd.net, 'USD')}</b>
          ${own ? `<div class="faint" style="font-size:12px;margin-top:4px">${own} بند له تاريخ عملية يبقى على سعر يومه.</div>` : ''}</div>` : ''}
        <div class="errline" id="err"></div>
        <div class="mf"><button class="btn p" id="ok" ${nr > 0 ? '' : 'disabled'}>اعتماد السعر</button><button class="btn" data-x>إلغاء</button></div>`;
      $$('[data-meth]', b).forEach((x) => x.onclick = (ev) => { if (ev.target.tagName === 'INPUT') return; s.method = x.dataset.meth; draw(); if (s.method === 'manual') $('#man', b).focus(); });
      const man = $('#man', b);
      man.oninput = () => { s.manual = man.value; s.method = 'manual'; const pos = man.selectionStart; draw(); const m2 = $('#man', b); m2.focus(); m2.setSelectionRange(pos, pos); };
      $('[data-x]', b).onclick = m.close;
      $('#ok', b).onclick = async () => {
        try { const r = await put(`/api/months/${M.ym}/rate`, { method: s.method, rate: s.method === 'manual' ? newRate() : undefined }); m.close(); toast('تم تحديث سعر الشهر', { undo: r.auditId }); reloadMonth(M); }
        catch (er) { $('#err', b).textContent = er.message; }
      };
    }
    draw();
  }

  // ============ التقارير ============
  route('reports', async (view, r) => {
    killCharts();
    const tab = r.query.tab || 'year';
    const all = await get('/api/reports/all');
    const monthsAsc = [...all.months].sort((a, b) => a.ym.localeCompare(b.ym));
    view.innerHTML = `<div class="topbar"><h1>التقارير</h1><div class="ms row">${displaySeg()}<button class="btn" onclick="print()">⇩ طباعة / PDF</button></div></div>
      <div class="tabs"><button data-tab="year" class="${tab === 'year' ? 'on' : ''}">السنة</button><button data-tab="compare" class="${tab === 'compare' ? 'on' : ''}">مقارنة الأشهر</button><button data-tab="subs" class="${tab === 'subs' ? 'on' : ''}">الاشتراكات</button><button data-tab="variable" class="${tab === 'variable' ? 'on' : ''}">المصاريف المتغيرة</button></div><div id="rep"></div>`;
    $$('[data-tab]').forEach((b) => b.onclick = () => { location.hash = '#/reports?tab=' + b.dataset.tab; });
    if (!monthsAsc.length) { $('#rep').innerHTML = '<div class="card empty"><h2>لا توجد بيانات بعد</h2></div>'; return; }
    if (tab === 'compare') compareView($('#rep'), all, monthsAsc, r.query);
    else if (tab === 'subs') subsView($('#rep'), all);
    else if (tab === 'variable') variableView($('#rep'), all, r.query);
    else yearView($('#rep'), all, monthsAsc, r.query);
  });

  // المصاريف المتغيرة لشهر: حسب الفئة مع الميزانية، حسب الشخص، وما كان لمرة واحدة
  function variableView(el, all, query) {
    const sec = App.sectionByKey('variable');
    const months = all.months.filter((m) => all.entries.some((e) => e.month_id === m.id && e.section_id === sec.id)).sort((a, b) => b.ym.localeCompare(a.ym));
    if (!months.length) { el.innerHTML = '<div class="card empty"><h2>لا مصاريف متغيرة بعد</h2></div>'; return; }
    const M = months.find((m) => m.ym === query.m) || months[0];
    const list = all.entries.filter((e) => e.month_id === M.id && e.section_id === sec.id).map((e) => ({ ...e, v: Calc.entryValues(e, M.rate).local }));
    const total = list.reduce((a, e) => a + e.v, 0);
    const oneOff = list.filter((e) => e.one_off);
    const group = (key) => { const g = {}; for (const e of list) { const k = e[key] || '—'; (g[k] ||= { v: 0, n: 0 }); g[k].v += e.v; g[k].n++; } return Object.entries(g).sort((a, b) => b[1].v - a[1].v); };
    const cats = group('note');
    const people = group('person').filter(([k]) => k !== '—');
    const catT = (n) => varCategories().find((t) => t.name === n) || {};
    el.innerHTML = `<div class="row" style="margin-bottom:12px"><select class="inp" id="vm" style="width:auto">${months.map((m) => `<option value="${m.ym}" ${m.ym === M.ym ? 'selected' : ''}>${ymLabel(m.ym)}</option>`).join('')}</select>
        <span class="ms muted">المجموع <b class="num">${d$(total, M.rate)}</b>${oneOff.length ? ` · منها لمرة واحدة <b class="num">${d$(oneOff.reduce((a, e) => a + e.v, 0), M.rate)}</b>` : ''}</span></div>
      <div class="grid" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)">
        <div class="card"><h3>حسب الفئة</h3><table class="tbl"><tr><th>الفئة</th><th>العمليات</th><th>المبلغ</th><th>الميزانية</th></tr>
          ${cats.map(([n, g]) => { const b = catT(n).budget; const p = b ? Math.round((g.v / b) * 100) : null; return `<tr><td>${esc(catT(n).icon || '•')} ${esc(n)}</td><td>${g.n}</td><td class="num">${d$(g.v, M.rate)}</td>
            <td>${b ? `<span class="delta ${p > 100 ? 'badd' : p > 80 ? 'neutral' : 'good'}">${p}%</span> <span class="faint num">من ${d$(b, M.rate)}</span>` : '<span class="faint">—</span>'}</td></tr>`; }).join('')}</table></div>
        <div class="card"><h3>حسب الشخص</h3>${people.length ? `<table class="tbl">${people.map(([p, g]) => `<tr><td>${esc(p)}</td><td>${g.n} عمليات</td><td class="num">${d$(g.v, M.rate)}</td></tr>`).join('')}</table>`
          : '<p class="muted" style="margin:0">لم يُحدد «لمن؟» لأي عملية بعد.</p>'}
          ${oneOff.length ? `<h3 style="margin-top:14px">لمرة واحدة</h3><table class="tbl">${oneOff.map((e) => `<tr><td>${esc(e.name)}</td><td class="faint">${dateLabel(e.tx_date)}</td><td class="num">${m$(e.amount, e.currency)}</td></tr>`).join('')}</table>` : ''}</div>
      </div>
      <div class="card tw" style="margin-top:12px;padding:6px 8px"><table class="tbl"><tr><th>التاريخ</th><th>الوصف</th><th>الفئة</th><th>لمن</th><th>المبلغ</th></tr>
        ${[...list].sort((a, b) => (b.tx_date || '').localeCompare(a.tx_date || '')).map((e) => `<tr><td class="faint">${dateLabel(e.tx_date)}</td><td>${esc(e.name)}${e.one_off ? ' <span class="tag t-mu">لمرة واحدة</span>' : ''}</td><td>${esc(e.note || '—')}</td><td>${esc(e.person || '—')}</td><td class="num">${m$(e.amount, e.currency)}</td></tr>`).join('')}</table></div>`;
    $('#vm', el).onchange = (ev) => { location.hash = '#/reports?tab=variable&m=' + ev.target.value; };
  }

  // مراجعة الاشتراكات: التكلفة الحالية والسنوية، آخر دفع، والتغير خلال 6 أشهر
  function subsView(el, all) {
    const sec = App.sectionByKey('subs');
    const ymOf = Object.fromEntries(all.months.map((m) => [m.id, m]));
    const tr = state.boot.todayRate && state.boot.todayRate.rate;
    const rows = state.boot.templates.filter((t) => t.section_id === sec.id).map((t) => {
      const es = all.entries.filter((e) => e.template_id === t.id).map((e) => ({ ...e, m: ymOf[e.month_id] })).filter((e) => e.m).sort((a, b) => b.m.ym.localeCompare(a.m.ym));
      const actual = es.filter((e) => e.amount != null);
      const latest = actual[0];
      const lastPaid = es.find((e) => e.status === 'paid' && e.amount != null);
      const cur = latest ? { amount: latest.amount, currency: latest.currency } : t.planned_amount ? { amount: t.planned_amount, currency: t.currency } : null;
      const monthlyLocal = cur ? Calc.toLocal(cur.amount, cur.currency, tr) : 0;
      const old = latest && actual.find((e) => e.m.ym <= shiftYm(latest.m.ym, -6));
      const oldLocal = old ? Calc.entryValues(old, old.m.rate).local : null;
      const newLocal = latest ? Calc.entryValues(latest, latest.m.rate).local : null;
      const paid12 = actual.filter((e) => e.m.ym > shiftYm(todayYm(), -12)).reduce((a, e) => a + Calc.entryValues(e, e.m.rate).local, 0);
      return { t, cur, monthlyLocal, lastPaid, old, change: oldLocal && newLocal ? Math.round(((newLocal - oldLocal) / oldLocal) * 100) : null, paid12, months: actual.length };
    }).filter((r) => r.t.active || r.months).sort((a, b) => (b.t.active - a.t.active) || b.monthlyLocal - a.monthlyLocal);
    const active = rows.filter((r) => r.t.active);
    const totalM = active.reduce((a, r) => a + r.monthlyLocal, 0);
    el.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-bottom:12px">
        <div class="card"><h3>شهريًا الآن</h3><div style="font-size:24px;font-weight:600" class="num">${money(totalM)}</div><div class="faint num">≈ ${tr ? money(totalM / tr, 'USD') : '—'} · ${active.length} اشتراكات</div></div>
        <div class="card"><h3>سنويًا بالأسعار الحالية</h3><div style="font-size:24px;font-weight:600" class="num c-sub">${money(totalM * 12)}</div><div class="faint num">≈ ${tr ? money((totalM * 12) / tr, 'USD') : '—'}</div></div>
        <div class="card"><h3>دفعته فعلًا آخر 12 شهرًا</h3><div style="font-size:24px;font-weight:600" class="num">${money(rows.reduce((a, r) => a + r.paid12, 0))}</div><div class="faint">كل شهر بسعر صرفه</div></div>
      </div>
      <div class="card tw" style="padding:6px 8px"><table class="tbl"><tr><th>الاشتراك</th><th>شهريًا</th><th>بالدولار</th><th>سنويًا</th><th>الحصة</th><th>تغيّر 6 أشهر</th><th>آخر دفع</th></tr>
        ${rows.map((r) => `<tr style="${r.t.active ? '' : 'opacity:.55'}"><td><div class="item" style="display:flex;gap:8px;align-items:center">${iconFor(r.t)}${esc(r.t.name)}${r.t.active ? '' : ' <span class="tag t-mu">موقوف</span>'}</div></td>
          <td class="num">${r.cur ? money(r.cur.amount, r.cur.currency) : '—'}</td><td class="num muted">${tr && r.monthlyLocal ? money(r.monthlyLocal / tr, 'USD') : '—'}</td>
          <td class="num">${r.t.active ? money(r.monthlyLocal * 12) : '—'}</td>
          <td>${r.t.active && totalM ? `<div class="prog" style="width:70px;height:6px;display:inline-block;vertical-align:middle"><i style="width:${(r.monthlyLocal / totalM) * 100}%;background:var(--sub)"></i></div> <span class="faint">${Math.round((r.monthlyLocal / totalM) * 100)}%</span>` : ''}</td>
          <td>${r.change === null ? '<span class="faint">—</span>' : `<span class="delta ${r.change > 0 ? 'badd' : r.change < 0 ? 'good' : 'neutral'}">${r.change > 0 ? '+' : ''}${r.change}%</span>`}</td>
          <td class="faint">${r.lastPaid ? ymLabel(r.lastPaid.m.ym) : '—'}</td></tr>`).join('')}</table></div>
      <p class="faint" style="font-size:12.5px">«شهريًا» = آخر مبلغ مسجّل. السنوي تقدير بسعر اليوم. التغير بالليرة بين آخر دفع وما قبله بستة أشهر.</p>`;
  }

  function aggregate(all) {
    const rateOf = Object.fromEntries(all.months.map((m) => [m.id, m.rate]));
    const ymOf = Object.fromEntries(all.months.map((m) => [m.id, m.ym]));
    const rows = {};
    for (const e of all.entries) {
      const v = Calc.entryValues(e, rateOf[e.month_id]);
      if (!v.local) continue;
      const sec = sectionById(e.section_id);
      const isVar = sec && sec.key === 'variable';
      const key = isVar ? 'var:' + (e.note || 'أخرى') : e.series_id ? 's' + e.series_id : e.template_id ? 't' + e.template_id : 'n' + e.name;
      const row = rows[key] ||= { key, name: isVar ? (e.note || 'أخرى') : e.name, section_id: e.section_id, sort: e.sort, byYm: {} };
      row.byYm[ymOf[e.month_id]] = (row.byYm[ymOf[e.month_id]] || 0) + v.local;
    }
    return { rows: Object.values(rows), rateByYm: Object.fromEntries(all.months.map((m) => [m.ym, m.rate])) };
  }

  function yearView(el, all, monthsAsc, query) {
    const years = [...new Set(monthsAsc.map((m) => m.year))];
    const year = Number(query.y) || (years.includes(+todayYm().slice(0, 4)) ? +todayYm().slice(0, 4) : years[years.length - 1]);
    const { rows, rateByYm } = aggregate(all);
    const yms = Array.from({ length: 12 }, (_, i) => `${year}-${App.pad(i + 1)}`);
    const cv = (v, ym) => (state.display === 'USD' ? (rateByYm[ym] ? v / rateByYm[ym] : 0) : v);
    const has = (ym) => rateByYm[ym] !== undefined;
    const cellColor = (c, a) => `background:color-mix(in srgb, ${c} ${Math.round(a * 100)}%, transparent);${a > .55 ? 'color:#fff' : ''}`;
    let html = '';
    const netByYm = {};
    for (const sec of state.boot.sections) {
      const sr = rows.filter((r) => r.section_id === sec.id).sort((a, b) => a.sort - b.sort);
      if (!sr.length) continue;
      const secTot = {};
      for (const r of sr) for (const ym of yms) if (r.byYm[ym]) secTot[ym] = (secTot[ym] || 0) + r.byYm[ym];
      for (const ym of yms) if (secTot[ym]) netByYm[ym] = (netByYm[ym] || 0) + (sec.kind === 'income' ? 1 : -1) * secTot[ym];
      const line = (label, data, cls, color) => {
        const vals = yms.map((ym) => (data[ym] ? cv(data[ym], ym) : 0));
        const nz = vals.filter((v) => v);
        const mx = Math.max(...nz, 0), mi = Math.min(...nz, mx);
        const total = vals.reduce((a, b) => a + b, 0);
        return `<tr class="${cls}"><td class="nm">${label}</td>${yms.map((ym, i) => {
          if (!has(ym)) return '<td class="none">—</td>';
          if (!vals[i]) return `<td class="cell faint" data-ym="${ym}">·</td>`;
          const a = .1 + .65 * (mx === mi ? .5 : (vals[i] - mi) / (mx - mi));
          return `<td class="cell num money" data-ym="${ym}" style="${cellColor(color, a)}" title="${money(vals[i], state.display)}">${compact(vals[i])}</td>`;
        }).join('')}<td class="tot num money">${compact(total)}</td><td class="num money faint">${nz.length ? compact(total / nz.length) : '—'}</td></tr>`;
      };
      html += line(esc(sec.name), secTot, 'secrow', secColor(sec));
      if (sec.key !== 'income' || sr.length > 1) for (const r of sr) html += line('<span class="faint">↳</span> ' + esc(r.name), r.byYm, '', secColor(sec));
    }
    const vals = yms.map((ym) => (netByYm[ym] !== undefined ? cv(netByYm[ym], ym) : null));
    const total = vals.reduce((a, b) => a + (b || 0), 0);
    const cnt = vals.filter((v) => v !== null).length;
    html += `<tr class="secrow"><td class="nm">المتبقي</td>${vals.map((v, i) => (v === null ? (has(yms[i]) ? '<td>·</td>' : '<td class="none">—</td>')
      : `<td class="cell num money" data-ym="${yms[i]}" style="${cellColor(v >= 0 ? 'var(--in)' : 'var(--bad)', .55)}">${compact(v)}</td>`)).join('')}
      <td class="tot num money">${compact(total)}</td><td class="num money faint">${cnt ? compact(total / cnt) : '—'}</td></tr>`;
    el.innerHTML = `<div class="topbar" style="margin-bottom:10px">
        ${years.includes(year - 1) ? `<a class="btn icon" href="#/reports?tab=year&y=${year - 1}">›</a>` : '<span class="btn icon" style="opacity:.3">›</span>'}<h1>${year}</h1>
        ${years.includes(year + 1) ? `<a class="btn icon" href="#/reports?tab=year&y=${year + 1}">‹</a>` : '<span class="btn icon" style="opacity:.3">‹</span>'}
        <span class="faint ms" style="font-size:12.5px">${state.display === 'USD' ? 'بالدولار، كل شهر بسعر صرفه' : 'بالليرة'} · انقر أي خلية لفتح الشهر</span></div>
      <div class="card tw" style="padding:10px"><table class="heat"><tr><th></th>${MONTHS_S.map((m) => `<th>${m}</th>`).join('')}<th>المجموع</th><th>المتوسط</th></tr>${html}</table></div>`;
    $$('td.cell', el).forEach((td) => td.onclick = () => { location.hash = '#/month/' + td.dataset.ym; });
  }

  function compareView(el, all, monthsAsc, query) {
    const yms = monthsAsc.map((m) => m.ym);
    const B = query.b && yms.includes(query.b) ? query.b : (yms.filter((y) => y <= todayYm()).pop() || yms[yms.length - 1]);
    const A = query.a && yms.includes(query.a) ? query.a : (yms.includes(shiftYm(B, -12)) ? shiftYm(B, -12) : yms[0]);
    const { rows, rateByYm } = aggregate(all);
    const ra = rateByYm[A], rb = rateByYm[B];
    const pct = (a, b) => (a && Number.isFinite(a) && Number.isFinite(b) ? Math.round(((b - a) / Math.abs(a)) * 100) : null);
    const dlt = (p, goodUp) => (p === null ? '<span class="faint">—</span>' : `<span class="delta ${p === 0 ? 'neutral' : (p > 0) === goodUp ? 'good' : 'badd'}">${p > 0 ? '+' : ''}${p}%</span>`);
    const cell = (v, r) => `<div class="num money">${money(v)}</div><div class="num money faint" style="font-size:11.5px">${r ? money(v / r, 'USD') : '—'}</div>`;
    let body = '';
    const secTotals = [];
    let netA = 0, netB = 0;
    for (const sec of state.boot.sections) {
      const sr = rows.filter((r) => r.section_id === sec.id && (r.byYm[A] || r.byYm[B]));
      if (!sr.length) continue;
      const ta = sr.reduce((s, r) => s + (r.byYm[A] || 0), 0), tb = sr.reduce((s, r) => s + (r.byYm[B] || 0), 0);
      const up = sec.kind === 'income';
      netA += up ? ta : -ta; netB += up ? tb : -tb;
      secTotals.push({ sec, ta, tb });
      body += `<tr style="background:var(--surface-2)"><td><b style="color:${secColor(sec)}">${esc(sec.name)}</b></td><td>${cell(ta, ra)}</td><td>${cell(tb, rb)}</td><td>${dlt(pct(ta, tb), up)}</td><td>${ra && rb ? dlt(pct(ta / ra, tb / rb), up) : '—'}</td></tr>`;
      for (const r of sr) {
        const a = r.byYm[A] || 0, b = r.byYm[B] || 0;
        body += `<tr><td>${esc(r.name)}</td><td>${a ? cell(a, ra) : '<span class="faint">—</span>'}</td><td>${b ? cell(b, rb) : '<span class="faint">—</span>'}</td><td>${a && b ? dlt(pct(a, b), up) : ''}</td><td>${a && b && ra && rb ? dlt(pct(a / ra, b / rb), up) : ''}</td></tr>`;
      }
    }
    body += `<tr><td><b>المتبقي</b></td><td>${cell(netA, ra)}</td><td>${cell(netB, rb)}</td><td>${dlt(pct(netA, netB), true)}</td><td>${ra && rb ? dlt(pct(netA / ra, netB / rb), true) : '—'}</td></tr>`;
    const opts = (sel) => [...yms].reverse().map((y) => `<option value="${y}" ${y === sel ? 'selected' : ''}>${ymLabel(y)}</option>`).join('');
    el.innerHTML = `<div class="row" style="margin-bottom:12px"><select class="inp" id="ca" style="width:auto">${opts(A)}</select><span class="faint">مقابل</span><select class="inp" id="cb" style="width:auto">${opts(B)}</select>
        <span class="faint ms" style="font-size:12.5px">Δ$ = التغير الحقيقي بعيدًا عن تغير سعر الليرة</span></div>
      <div class="grid"><div class="card tw" style="padding:6px 8px"><table class="tbl"><tr><th>البند</th><th>${ymLabel(A)} <span class="c-fx num">@${fmtN(ra, 2)}</span></th><th>${ymLabel(B)} <span class="c-fx num">@${fmtN(rb, 2)}</span></th><th>Δ بالليرة</th><th>Δ بالدولار</th></tr>${body}</table></div>
        <div class="card"><h3>بالدولار</h3><div class="chartbox" style="height:300px"><canvas id="cmp"></canvas></div></div></div>`;
    const go = () => { location.hash = `#/reports?tab=compare&a=${$('#ca').value}&b=${$('#cb').value}`; };
    $('#ca').onchange = go; $('#cb').onchange = go;
    const colorOf = (sec) => { const c = secColor(sec); return c.startsWith('var') ? css(c.slice(4, -1)) : c; };
    charts.push(new Chart($('#cmp'), {
      type: 'bar',
      data: { labels: secTotals.map((x) => x.sec.name), datasets: [
        { label: ymLabel(A), data: secTotals.map((x) => (ra ? x.ta / ra : 0)), backgroundColor: css('--faint'), borderRadius: 4 },
        { label: ymLabel(B), data: secTotals.map((x) => (rb ? x.tb / rb : 0)), backgroundColor: secTotals.map((x) => colorOf(x.sec)), borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { rtl: true }, tooltip: { rtl: true, callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y, 'USD')}` } } },
        scales: { x: { reverse: true, grid: { display: false } }, y: { position: 'right', ticks: { callback: (v) => '$' + compact(v) } } } },
    }));
  }

  // ============ الأهداف ============
  route('goals', async (view) => {
    killCharts();
    const goals = await get('/api/goals');
    view.innerHTML = `<div class="topbar"><h1>أهداف الادخار</h1><div class="ms"><button class="btn p" id="add">+ هدف جديد</button></div></div>
      <div class="goals">${goals.map((g) => {
        const p = Math.min(100, Math.round((g.saved / g.target) * 100));
        return `<div class="card goal" data-g="${g.id}" style="cursor:pointer"><div class="gt"><span class="dot" style="--c:var(--accent);--bg-c:var(--accent-soft)">${esc(g.icon)}</span>${esc(g.name)}</div>
          <div class="gb">${m$(g.saved, g.currency)} <span class="faint" style="font-size:.6em">/ ${money(g.target, g.currency)}</span></div>
          <div class="prog"><i style="width:${p}%"></i></div><div class="gm"><span>${p}%${p >= 100 ? ' 🎉' : ''}</span><span>${g.deadline ? 'الموعد ' + dateLabel(g.deadline) : ''}</span></div></div>`;
      }).join('')}<div class="card goal add" id="add2">+ هدف جديد</div></div>
      <p class="faint" style="font-size:12.5px;margin-top:14px">الأهداف بالدولار تُحسب بسعر يوم كل إيداع، فلا يأكلها تغير سعر الليرة.</p>`;
    $('#add').onclick = () => goalModal(); $('#add2').onclick = () => goalModal();
    $$('[data-g]').forEach((c) => c.onclick = () => goalDetail(goals.find((g) => g.id === Number(c.dataset.g))));
  });

  function goalModal(g) {
    const m = modal(`<h2>${g ? 'تعديل الهدف' : 'هدف جديد'} <button class="x" data-close>✕</button></h2>
      <label class="fl">الاسم</label><input class="inp" id="n" value="${esc(g ? g.name : '')}" placeholder="صندوق الطوارئ">
      <label class="fl">الأيقونة</label><div class="chips">${['🛟', '💻', '🚗', '🏠', '✈️', '🎓', '💍', '🎯'].map((i) => `<button class="chip ${(g ? g.icon : '🎯') === i ? 'on' : ''}" data-i="${i}">${i}</button>`).join('')}</div>
      <label class="fl">المبلغ المستهدف</label><div class="amt big"><div class="seg"><button data-c="USD" class="${!g || g.currency === 'USD' ? 'on' : ''}">$</button><button data-c="${LOCAL}" class="${g && g.currency !== 'USD' ? 'on' : ''}">₺</button></div><input id="t" inputmode="decimal" value="${g ? g.target : ''}"></div>
      <label class="fl">الموعد (اختياري)</label><input class="inp" type="date" id="d" value="${g && g.deadline ? g.deadline : ''}">
      <div class="errline" id="err"></div><div class="mf"><button class="btn p" id="ok">حفظ</button>${g ? '<button class="btn danger" id="rm">حذف</button>' : ''}</div>`);
    const el = m.el; let icon = g ? g.icon : '🎯'; let cur = g ? g.currency : 'USD';
    $$('[data-i]', el).forEach((b) => b.onclick = () => { icon = b.dataset.i; $$('[data-i]', el).forEach((x) => x.classList.toggle('on', x === b)); });
    $$('[data-c]', el).forEach((b) => b.onclick = () => { cur = b.dataset.c; $$('[data-c]', el).forEach((x) => x.classList.toggle('on', x === b)); });
    $('#ok', el).onclick = async () => {
      const body = { name: $('#n', el).value.trim(), icon, target: Calc.evalAmount($('#t', el).value), currency: cur, deadline: $('#d', el).value || null };
      try { if (g) await patch('/api/goals/' + g.id, body); else await post('/api/goals', body); m.close(); App.render(); } catch (e) { $('#err', el).textContent = e.message; }
    };
    const rm = $('#rm', el); if (rm) rm.onclick = async () => { if (await confirmBox('حذف الهدف وكل إيداعاته؟', 'حذف', true)) { await del('/api/goals/' + g.id); m.close(); App.render(); } };
  }

  function goalDetail(g) {
    const m = modal(`<h2>${esc(g.icon)} ${esc(g.name)} <button class="x" data-close>✕</button></h2>
      <div style="font-size:22px;font-weight:600">${m$(g.saved, g.currency)} <span class="faint" style="font-size:.6em">/ ${money(g.target, g.currency)}</span></div>
      <div class="prog" style="margin:8px 0 14px"><i style="width:${Math.min(100, (g.saved / g.target) * 100)}%"></i></div>
      <label class="fl">إيداع جديد</label>
      <div class="amt big"><div class="seg"><button data-c="${LOCAL}" class="on">₺</button><button data-c="USD">$</button></div><input id="a" inputmode="decimal" placeholder="0"></div>
      <div class="row" style="margin-top:8px"><input class="inp" type="date" id="d" value="${state.boot.today}" max="${state.boot.today}" style="width:auto"><input class="inp" id="nt" placeholder="ملاحظة" style="flex:1"></div>
      <div class="mf"><button class="btn p" id="ok">إضافة الإيداع</button><button class="btn" id="ed">تعديل الهدف</button></div>
      ${g.contribs.length ? `<label class="fl">الإيداعات</label><table class="tbl">${g.contribs.map((c) => `<tr><td>${dateLabel(c.date)}</td><td>${m$(c.amount, c.currency)}</td><td class="faint">${esc(c.note)}</td><td><button class="btn sm ghost danger" data-rm="${c.id}">🗑</button></td></tr>`).join('')}</table>` : ''}`);
    const el = m.el; let cur = LOCAL;
    $$('[data-c]', el).forEach((b) => b.onclick = () => { cur = b.dataset.c; $$('[data-c]', el).forEach((x) => x.classList.toggle('on', x === b)); });
    $('#ok', el).onclick = async () => {
      const a = Calc.evalAmount($('#a', el).value);
      if (!(a > 0)) return;
      try { await post(`/api/goals/${g.id}/contribs`, { amount: a, currency: cur, date: $('#d', el).value, note: $('#nt', el).value }); m.close(); App.render(); toast('أُضيف الإيداع ✓'); } catch (e) { fail(e); }
    };
    $('#ed', el).onclick = () => { m.close(); goalModal(g); };
    $$('[data-rm]', el).forEach((b) => b.onclick = async () => { await del('/api/contribs/' + b.dataset.rm); m.close(); App.render(); });
  }

  App.reloadMonthView = () => App.render();
})();
