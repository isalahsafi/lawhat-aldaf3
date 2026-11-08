// الإضافة السريعة: عملية واحدة (اختر بندًا ← المبلغ ← حفظ)، أو عدة عمليات بسطر لكل عملية.
const Quick = (() => {
  const { $, $$, esc, state, money, iconFor, sectionById, sectionByKey, ymLabel, post, get, toast, LOCAL } = App;

  // ---------- تخمين الفئة من الوصف: السجل السابق أولًا، ثم الأسماء البديلة ----------
  const norm = (s) => String(s || '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase().trim();
  function guessCategory(desc, history, categories) {
    const n = norm(desc);
    if (!n) return null;
    const h = history.find((x) => norm(x.name) === n && x.category);
    if (h) { const c = categories.find((x) => x.name === h.category); if (c) return c; }
    let best = null, len = 0;
    for (const c of categories) for (const a of [c.name, ...c.aliases.split(',')].map(norm).filter(Boolean)) {
      if (a.length > len && (n === a || n.includes(a))) { best = c; len = a.length; }
    }
    return best;
  }
  // «لمن؟» من اسم وارد في الوصف (مثل «ل سارة» أو «اشياء لأحمد»)، أو من آخر استخدام لنفس الوصف
  function guessPerson(desc, history) {
    const words = String(desc || '').split(/[\s،,]+/).filter(Boolean);
    const people = state.boot.settings.people || [];
    const hit = people.find((p) => words.some((w) => w === p || w === 'ل' + p));
    if (hit) return hit;
    const h = history.find((x) => norm(x.name) === norm(desc) && x.person);
    return h ? h.person : null;
  }
  // بند معتاد (غير متغير) يطابق النص، مثل «كهرباء 785»
  function matchTemplate(text) {
    const n = norm(text);
    if (!n) return null;
    let best = null, len = 0;
    for (const t of state.boot.templates) {
      const sec = sectionById(t.section_id);
      if (!sec || sec.key === 'variable' || !(t.active || state.boot.series.some((x) => x.template_id === t.id && x.status === 'active'))) continue;
      for (const a of [t.name, ...t.aliases.split(',')].map(norm).filter((x) => x.length >= 2)) {
        if (a.length > len && (n === a || n === 'ال' + a || ` ${n} `.includes(` ${a} `))) { best = t; len = a.length; }
      }
    }
    return best;
  }

  function open(preset = {}) {
    const s = {
      tab: 'one', item: null, currency: state.boot.settings.base_currency || LOCAL, amount: '', date: state.boot.today, dateMode: 'today',
      status: 'paid', mode: 'replace', paid: '', desc: '', category: null, catTouched: false, lookup: null, rate: null, filter: '', ddOpen: true, hi: 0,
      lines: '', parsed: [], person: null, personTouched: false, oneOff: false, oneOffTouched: false,
    };
    const m = App.modal(`<h2>إضافة سريعة <button class="x" data-close>✕</button></h2>
      <div class="seg" style="margin-bottom:6px" id="qtabs"><button data-tab="one" class="on">عملية واحدة</button><button data-tab="many">عدة عمليات</button></div><div id="qbody"></div>`);
    const body = $('#qbody', m.el);
    const varSec = sectionByKey('variable');
    const categories = state.boot.templates.filter((t) => t.section_id === (varSec && varSec.id));
    let history = [];
    get('/api/variable/history').then((h) => { history = h; if (s.item && s.item.kind === 'new') draw(); }).catch(() => {});
    $$('#qtabs [data-tab]', m.el).forEach((b) => b.onclick = () => {
      s.tab = b.dataset.tab;
      $$('#qtabs [data-tab]', m.el).forEach((x) => x.classList.toggle('on', x === b));
      draw();
      if (s.tab === 'many') { const ta = $('#qLines', body); if (ta) ta.focus(); } else { loadLookup(); }
    });

    function options() {
      const f = s.filter.trim().toLowerCase();
      const hit = (names) => !f || names.some((a) => String(a).trim().toLowerCase().includes(f));
      const groups = [];
      for (const sec of state.boot.sections) {
        if (!sec.active || sec.key === 'variable') continue;
        const items = state.boot.templates.filter((t) => t.section_id === sec.id && (t.active || state.boot.series.some((x) => x.template_id === t.id && x.status === 'active')))
          .filter((t) => hit([t.name, ...t.aliases.split(',')])).map((t) => ({ kind: 'tpl', t }));
        if (items.length) groups.push({ name: sec.name, items });
      }
      return groups;
    }

    async function loadLookup() {
      try {
        const q = new URLSearchParams({ date: s.date, ...(s.item && s.item.kind === 'tpl' ? { template_id: s.item.t.id } : {}) });
        s.lookup = await get('/api/quick/lookup?' + q);
        s.rate = s.lookup.rate;
        if (!s.rate) { const r = await get('/api/fx/day/' + s.date); s.rate = r && r.rate; }
      } catch { /* المعاينة اختيارية */ }
      draw();
    }

    function pick(it) {
      s.item = it;
      s.ddOpen = false;
      if (it.kind === 'tpl') { const sec = sectionById(it.t.section_id); s.isIncome = !!sec && sec.kind === 'income'; s.currency = it.t.currency || s.currency; }
      else { s.isIncome = false; s.desc = s.desc || s.filter; s.category = guessCategory(s.desc, history, categories); s.catTouched = false; autoTags(); }
      s.status = 'paid';
      draw(); focusAmt(); loadLookup();
    }
    const amountVal = () => Calc.evalAmount(s.amount);
    // «لمن؟» و«لمرة واحدة» يتبعان الوصف والفئة ما لم يغيّرهما المستخدم
    function autoTags() {
      if (!s.personTouched) s.person = guessPerson(s.desc, history);
      if (!s.oneOffTouched) s.oneOff = !!(s.category && s.category.one_off_default);
    }

    let flat = [];
    function draw() {
      if (s.tab === 'many') return drawMany();
      const groups = options();
      flat = groups.flatMap((g) => g.items);
      if (s.hi >= flat.length + 1) s.hi = 0;
      let html = '<label class="fl">البند</label>';
      if (s.item && !s.ddOpen) {
        const it = s.item;
        html += `<div class="combo"><span class="sel-ic">${it.kind === 'tpl' ? iconFor(it.t) : '<span class="ic">✦</span>'}</span>
          <input class="inp" value="${esc(it.kind === 'tpl' ? it.t.name : '＋ مصروف متغير')}" readonly id="qPicked" style="cursor:pointer"><button class="clear" id="qClear">✕</button></div>`;
      } else {
        html += `<div class="combo"><span class="sel-ic"><span class="ic">⌕</span></span><input class="inp" id="qFilter" placeholder="اكتب أو اختر: كهرباء، Claude، خبز…" value="${esc(s.filter)}" autocomplete="off"></div><div class="dd">`;
        let idx = 0;
        for (const g of groups) {
          html += `<div class="dg">${esc(g.name)}</div>`;
          for (const it of g.items) {
            const t = it.t;
            const rec = state.boot.series.find((x) => x.template_id === t.id && x.status === 'active');
            html += `<button class="di ${idx === s.hi ? 'on' : ''}" data-idx="${idx}">${iconFor(t)}${esc(t.name)}<span class="dm">${rec ? '⟳ متكرر' : t.planned_amount ? 'المعتاد ' + money(t.planned_amount, t.currency) : ''}</span></button>`;
            idx++;
          }
        }
        if (!flat.length) html += '<div class="dg">لا يوجد بند معتاد بهذا الاسم</div>';
        html += `<div class="dsep"></div><button class="di new ${idx === s.hi ? 'on' : ''}" data-new>＋ مصروف متغير${s.filter ? ': «' + esc(s.filter) + '»' : ' (سوق، أكل، مواصلات…)'}</button></div>`;
      }
      if (s.item && !s.ddOpen) {
        const v = amountVal();
        if (s.item.kind === 'new') {
          const f = norm(s.desc);
          const sugg = history.filter((h) => !f || norm(h.name).includes(f)).filter((h) => norm(h.name) !== f).slice(0, 8);
          html += `<label class="fl">على ماذا؟</label><input class="inp" id="qDesc" placeholder="مثل: خبز، أغراض للبيت" value="${esc(s.desc)}" autocomplete="off">
            ${sugg.length ? `<div class="chips" style="margin-top:6px">${sugg.map((h) => `<button class="chip" data-hist="${esc(h.name)}" title="${esc(h.category || '')}">${esc(h.name)}${h.amount ? ` <span class="faint num">${App.fmtN(h.amount)}</span>` : ''}</button>`).join('')}</div>` : ''}
            <label class="fl">الفئة ${s.category && !s.catTouched ? '<span class="faint" style="font-size:11.5px">· اختيرت تلقائيًا</span>' : ''}</label>
            <div class="chips">${categories.map((c) => `<button class="chip ${s.category && s.category.id === c.id ? 'on' : ''}" data-cat="${c.id}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div>
            <label class="fl">لمن؟ <span class="faint" style="font-size:11.5px">اختياري</span></label>
            <div class="chips">${(state.boot.settings.people || []).map((p) => `<button class="chip ${s.person === p ? 'on' : ''}" data-person="${esc(p)}">${esc(p)}</button>`).join('')}<input class="inp" id="qNewPerson" placeholder="＋ شخص" style="width:100px;padding:4px 10px;border-radius:99px"></div>
            <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:10px"><input type="checkbox" id="qOne" ${s.oneOff ? 'checked' : ''}> لمرة واحدة <span class="faint" style="font-size:11.5px">· لا يدخل في حساب الوتيرة والتوقع</span></label>`;
        }
        html += `<label class="fl">${s.isIncome ? 'المبلغ المستلم' : 'المبلغ'}</label>
          <div class="amt big ${Number.isNaN(v) ? 'err' : ''}"><div class="seg"><button data-qcur="${LOCAL}" class="${s.currency !== 'USD' ? 'on' : ''}">₺</button><button data-qcur="USD" class="${s.currency === 'USD' ? 'on' : ''}">$</button></div>
          <input id="qAmt" inputmode="decimal" placeholder="0" value="${esc(s.amount)}" autocomplete="off"></div>
          <div class="conv">${convLine(v)}</div>
          ${dateChips()}${entryPreview(v)}
          <div class="errline" id="qErr"></div>
          <div class="mf"><button class="btn p" id="qSave">حفظ</button><button class="btn" id="qSaveMore">حفظ وإضافة آخر</button></div>`;
      }
      keepFocus(() => { body.innerHTML = html; bind(); });
    }

    const dateChips = () => `<label class="fl">التاريخ</label><div class="chips">
      <button class="chip ${s.dateMode === 'today' ? 'on' : ''}" data-date="today">اليوم</button>
      <button class="chip ${s.dateMode === 'yesterday' ? 'on' : ''}" data-date="yesterday">أمس</button>
      <button class="chip ${s.dateMode === 'pick' ? 'on' : ''}" data-date="pick">📅 تاريخ آخر</button></div>
      ${s.dateMode === 'pick' ? `<input type="date" class="inp" id="qDate" value="${s.date}" max="${state.boot.today}" style="margin-top:8px">` : ''}`;

    function keepFocus(fn) {
      const act = document.activeElement;
      const keep = act && body.contains(act) && act.id && act.id !== 'qFilter' ? { id: act.id, pos: act.selectionStart } : null;
      fn();
      if (keep) { const el = $('#' + keep.id, body); if (el) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch { /* date */ } } }
    }

    function entryPreview(v) {
      const lk = s.lookup;
      const ym = s.date.slice(0, 7);
      const e = s.item.kind === 'tpl' && lk && lk.entry;
      const paidLabel = s.isIncome ? 'مستلم' : 'مدفوع';
      return `<div class="previewbox">
        <div>سيُسجَّل في <b>${ymLabel(ym)}</b>${lk && !lk.monthExists ? ' <span class="c-fx">· سيُنشأ الشهر تلقائيًا بسعر صرفه</span>' : ''}</div>
        <div class="chips" style="margin-top:8px">
          <button class="chip ${s.status === 'paid' ? 'on' : ''}" data-st="paid">✓ ${paidLabel}</button>
          ${s.isIncome ? '' : `<button class="chip ${s.status === 'partial' ? 'on' : ''}" data-st="partial">◐ جزئي</button>`}
          <button class="chip ${s.status === 'unpaid' ? 'on' : ''}" data-st="unpaid">${s.isIncome ? 'متوقع' : 'مستحق'}</button></div>
        ${s.status === 'partial' ? `<label class="fl">المدفوع منه</label><input class="inp" id="qPaid" inputmode="decimal" value="${esc(s.paid)}" placeholder="0">` : ''}
        ${e && e.series_id && e.status !== 'paid' ? `<div class="c-in" style="margin-top:6px;font-size:12.5px">⟳ دفعة متكررة مستحقة بـ ${money(e.amount, e.currency)}، ستُؤكَّد</div>` : ''}
        ${e && e.amount != null && !(e.series_id && e.status !== 'paid') ? `<div class="warnline">مسجّل مسبقًا: ${money(e.amount, e.currency)} (${e.status === 'paid' ? paidLabel : e.status === 'partial' ? 'جزئي' : 'مستحق'})</div>
          <div class="chips" style="margin-top:6px"><button class="chip ${s.mode === 'replace' ? 'on' : ''}" data-mode="replace">استبدال المبلغ</button><button class="chip ${s.mode === 'add' ? 'on' : ''}" data-mode="add">إضافة دفعة ثانية</button></div>` : ''}
        <div id="qWarn">${warnFor(v)}</div></div>`;
    }

    function convLine(v) {
      const rate = s.rate;
      if (!v || Number.isNaN(v)) return Number.isNaN(v) ? '<span class="c-bad">صيغة غير صحيحة</span>' : (rate ? `1 $ = ${App.fmtN(rate, 2)} ₺` : '');
      if (!rate) return '';
      const other = s.currency === 'USD' ? money(v * rate, LOCAL) : money(v / rate, 'USD');
      return `≈ <b class="num">${other}</b> <span class="faint">· @${App.fmtN(rate, 2)}</span>`;
    }
    function warnFor(v) {
      if (!s.item || s.item.kind !== 'tpl' || !v || Number.isNaN(v) || !s.item.t.planned_amount) return '';
      const t = s.item.t;
      const usual = Calc.convert(t.planned_amount, t.currency, s.currency, s.rate);
      return usual && v > usual * 1.8 ? `<div class="warnline">⚠ أعلى من المعتاد (${money(usual, s.currency)}) بكثير، تأكد من المبلغ</div>` : '';
    }

    function bind() {
      const f = $('#qFilter', body);
      if (f) {
        if (matchMedia('(min-width: 861px)').matches || s.filter) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
        f.oninput = () => { s.filter = f.value; s.hi = 0; draw(); };
        f.onkeydown = (ev) => {
          const n = $$('.di', body).length;
          if (ev.key === 'ArrowDown') { ev.preventDefault(); s.hi = Math.min(n - 1, s.hi + 1); draw(); }
          else if (ev.key === 'ArrowUp') { ev.preventDefault(); s.hi = Math.max(0, s.hi - 1); draw(); }
          else if (ev.key === 'Enter') { ev.preventDefault(); const it = $$('.di', body)[s.hi]; if (it) it.click(); }
        };
      }
      $$('[data-idx]', body).forEach((b) => b.onclick = () => pick(flat[Number(b.dataset.idx)]));
      const nb = $('[data-new]', body); if (nb) nb.onclick = () => pick({ kind: 'new' });
      const cl = $('#qClear', body); if (cl) cl.onclick = () => { s.ddOpen = true; s.item = null; draw(); };
      const pk = $('#qPicked', body); if (pk) pk.onclick = () => { s.ddOpen = true; draw(); };
      $$('[data-qcur]', body).forEach((b) => b.onclick = () => { s.currency = b.dataset.qcur; draw(); focusAmt(); });
      const a = $('#qAmt', body);
      if (a) {
        a.oninput = () => {
          s.amount = a.value;
          const v = amountVal();
          $('.conv', body).innerHTML = convLine(v);
          const w = $('#qWarn', body); if (w) w.innerHTML = warnFor(v);
          a.parentElement.classList.toggle('err', Number.isNaN(v));
        };
        a.onchange = () => draw();
        a.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(false); } };
      }
      const d = $('#qDesc', body);
      if (d) {
        d.oninput = () => { s.desc = d.value; if (!s.catTouched) s.category = guessCategory(s.desc, history, categories); autoTags(); draw(); };
        d.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); focusAmt(); } };
      }
      $$('[data-hist]', body).forEach((b) => b.onclick = () => {
        const h = history.find((x) => x.name === b.dataset.hist);
        s.desc = h.name; s.category = categories.find((c) => c.name === h.category) || guessCategory(h.name, history, categories); s.catTouched = false; autoTags();
        draw(); focusAmt();
      });
      $$('[data-cat]', body).forEach((b) => b.onclick = () => { s.category = categories.find((c) => c.id === Number(b.dataset.cat)); s.catTouched = true; autoTags(); draw(); });
      $$('[data-person]', body).forEach((b) => b.onclick = () => { s.person = s.person === b.dataset.person ? null : b.dataset.person; s.personTouched = true; draw(); });
      const np = $('#qNewPerson', body);
      if (np) np.onkeydown = async (ev) => {
        if (ev.key !== 'Enter' || !np.value.trim()) return;
        ev.preventDefault();
        const name = np.value.trim();
        const people = [...new Set([...(state.boot.settings.people || []), name])];
        try { await App.put('/api/settings', { people }); state.boot.settings.people = people; s.person = name; s.personTouched = true; draw(); } catch (e) { App.fail(e); }
      };
      const one = $('#qOne', body); if (one) one.onchange = () => { s.oneOff = one.checked; s.oneOffTouched = true; };
      bindDates();
      $$('[data-st]', body).forEach((b) => b.onclick = () => { s.status = b.dataset.st; draw(); });
      $$('[data-mode]', body).forEach((b) => b.onclick = () => { s.mode = b.dataset.mode; draw(); });
      const qp = $('#qPaid', body); if (qp) qp.oninput = () => { s.paid = qp.value; };
      const sv = $('#qSave', body); if (sv) sv.onclick = () => save(false);
      const sm = $('#qSaveMore', body); if (sm) sm.onclick = () => save(true);
    }
    function bindDates() {
      $$('[data-date]', body).forEach((b) => b.onclick = () => {
        s.dateMode = b.dataset.date;
        if (s.dateMode === 'today') s.date = state.boot.today;
        if (s.dateMode === 'yesterday') { const t = new Date(state.boot.today + 'T12:00:00'); t.setDate(t.getDate() - 1); s.date = `${t.getFullYear()}-${App.pad(t.getMonth() + 1)}-${App.pad(t.getDate())}`; }
        draw(); if (s.tab === 'one') loadLookup();
      });
      const qd = $('#qDate', body); if (qd) qd.onchange = () => { if (qd.value) { s.date = qd.value; if (s.tab === 'one') loadLookup(); else draw(); } };
    }
    const focusAmt = () => { const a = $('#qAmt', body); if (a) a.focus(); };

    async function save(more) {
      const v = amountVal();
      const err = $('#qErr', body);
      if (!v || Number.isNaN(v) || v <= 0) { err.textContent = 'أدخل مبلغًا صحيحًا'; focusAmt(); return; }
      const payload = { amount: v, currency: s.currency, date: s.date, status: s.status, mode: s.mode, keepDate: s.dateMode !== 'today',
        paid_amount: s.status === 'partial' ? Calc.evalAmount(s.paid) || 0 : undefined };
      let label;
      if (s.item.kind === 'tpl') { payload.template_id = s.item.t.id; label = s.item.t.name; }
      else {
        const desc = (s.desc || '').trim() || (s.category && s.category.name) || 'مصروف';
        if (!s.category) { err.textContent = 'اختر الفئة'; return; }
        payload.new = { name: desc, section_id: varSec.id };
        payload.category = s.category.name;
        payload.person = s.person || null;
        payload.one_off = s.oneOff;
        label = desc;
      }
      try {
        $$('#qSave,#qSaveMore', body).forEach((b) => b.disabled = true);
        const r = await post('/api/quick', payload);
        toast(`✓ ${esc(label)} · ${money(v, s.currency)} · ${ymLabel(r.ym || s.date.slice(0, 7))}`, { undo: r.auditId, ms: 7000 });
        await App.refresh();
        if (more) {
          if (s.item.kind === 'new') history = await get('/api/variable/history').catch(() => history);
          Object.assign(s, { item: null, amount: '', filter: '', desc: '', category: null, ddOpen: true, status: 'paid', mode: 'replace', paid: '', hi: 0, person: null, personTouched: false, oneOff: false, oneOffTouched: false });
          draw();
        } else m.close();
      } catch (e) {
        err.textContent = e.message;
        $$('#qSave,#qSaveMore', body).forEach((b) => b.disabled = false);
      }
    }

    // ---------- عدة عمليات: سطر لكل عملية «الوصف المبلغ» ----------
    function parseLines() {
      s.parsed = s.lines.split('\n').map((raw) => raw.trim()).filter(Boolean).map((raw, i) => {
        const txt = raw.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
        const nums = txt.match(/\d[\d,.]*(?:\s*[+*]\s*\d[\d,.]*)*/g);
        const amtStr = nums ? nums[nums.length - 1] : '';
        const amount = Calc.evalAmount(amtStr);
        const usd = /\$|دولار|usd/i.test(txt);
        const desc = txt.replace(amtStr, '').replace(/[$₺]|دولار|ليرة|ليره|usd|try/gi, '').replace(/\s+/g, ' ').trim();
        const prev = (s.parsedPrev || []).find((p) => p.raw === raw);
        const tpl = matchTemplate(desc);
        const cat = tpl ? null : guessCategory(desc, history, categories);
        const category = prev && prev.override ? prev.category : cat;
        return { i, raw, desc, amount, currency: usd ? 'USD' : LOCAL, tpl: prev && prev.override ? prev.tpl : tpl, category, override: prev && prev.override,
          person: guessPerson(desc, history), oneOff: prev && prev.oneOffSet ? prev.oneOff : !!(category && category.one_off_default), oneOffSet: prev && prev.oneOffSet,
          ok: amount > 0 && !Number.isNaN(amount) && !!desc };
      });
      s.parsedPrev = s.parsed;
    }
    function drawMany() {
      parseLines();
      const ok = s.parsed.filter((p) => p.ok && (p.tpl || p.category));
      const total = ok.filter((p) => p.currency !== 'USD').reduce((a, p) => a + p.amount, 0);
      const regular = state.boot.templates.filter((t) => { const sc = sectionById(t.section_id); return sc && sc.key !== 'variable' && t.active; });
      const html = `<label class="fl">سطر لكل عملية: الوصف ثم المبلغ</label>
        <textarea class="inp" id="qLines" rows="6" placeholder="خبز 60&#10;فحم 200&#10;مستلزمات بيت 1546&#10;كهرباء 785&#10;Claude 20$">${esc(s.lines)}</textarea>
        <p class="faint" style="font-size:12px;margin:6px 0 0">البنود المعتادة (مثل كهرباء) تُسجَّل في بندها، وغيرها مصروف متغير بفئة تُخمَّن من استخدامك السابق. أضف $ للدولار.</p>
        ${dateChips()}
        ${s.parsed.length ? `<div class="tw" style="margin-top:12px"><table class="tbl">${s.parsed.map((p) => `<tr>
          <td>${p.ok ? esc(p.desc) : `<span class="c-bad">${esc(p.raw)}</span>`}${p.ok && p.person && !p.tpl ? ` <span class="tag t-mu">${esc(p.person)}</span>` : ''}${p.ok && !p.tpl ? `<label style="display:block;font-size:11px" class="faint"><input type="checkbox" data-one="${p.i}" ${p.oneOff ? 'checked' : ''}> لمرة واحدة</label>` : ''}</td>
          <td class="num">${p.ok ? money(p.amount, p.currency) : '<span class="c-bad">لا مبلغ</span>'}</td>
          <td>${!p.ok ? '' : `<select class="inp" data-pl="${p.i}" style="padding:4px 8px;font-size:12.5px">
              ${!p.tpl && !p.category ? '<option value="" selected>⚠ اختر</option>' : ''}
              <optgroup label="مصاريف متغيرة">${categories.map((c) => `<option value="c${c.id}" ${!p.tpl && p.category && p.category.id === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</optgroup>
              <optgroup label="بنود معتادة">${regular.map((t) => `<option value="t${t.id}" ${p.tpl && p.tpl.id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup></select>`}</td></tr>`).join('')}</table></div>
          <div class="previewbox">${ok.length} عمليات · ${ymLabel(s.date.slice(0, 7))}${total ? ` · المجموع بالليرة <b class="num">${money(total)}</b>` : ''}</div>` : ''}
        <div class="errline" id="qErr"></div>
        <div class="mf"><button class="btn p" id="qSaveAll" ${ok.length && ok.length === s.parsed.length ? '' : 'disabled'}>حفظ ${ok.length || ''} عمليات</button></div>`;
      keepFocus(() => { body.innerHTML = html; bindMany(); });
    }
    function bindMany() {
      const ta = $('#qLines', body);
      let t;
      ta.oninput = () => { s.lines = ta.value; clearTimeout(t); t = setTimeout(drawMany, 300); };
      $$('[data-pl]', body).forEach((sel) => sel.onchange = () => {
        const p = s.parsed[Number(sel.dataset.pl)];
        const v = sel.value;
        p.override = true;
        if (v.startsWith('t')) { p.tpl = state.boot.templates.find((x) => x.id === Number(v.slice(1))); p.category = null; }
        else { p.tpl = null; p.category = categories.find((x) => x.id === Number(v.slice(1))); }
        drawMany();
      });
      $$('[data-one]', body).forEach((c) => c.onchange = () => { const p = s.parsed[Number(c.dataset.one)]; p.oneOff = c.checked; p.oneOffSet = true; });
      bindDates();
      $('#qSaveAll', body).onclick = async () => {
        const items = s.parsed.map((p) => (p.tpl
          ? { template_id: p.tpl.id, amount: p.amount, currency: p.currency, date: s.date, status: 'paid', mode: 'replace', keepDate: s.dateMode !== 'today' }
          : { new: { name: p.desc, section_id: varSec.id }, category: p.category.name, amount: p.amount, currency: p.currency, date: s.date, status: 'paid', person: p.person, one_off: p.oneOff }));
        try {
          $('#qSaveAll', body).disabled = true;
          const r = await post('/api/quick/batch', { items });
          m.close();
          toast(`✓ سُجّلت ${r.count} عمليات في ${ymLabel(r.ym)}`, { undoMany: r.auditIds, ms: 8000 });
          App.refresh();
        } catch (e) { $('#qErr', body).textContent = e.message; $('#qSaveAll', body).disabled = false; }
      };
    }

    if (preset.template_id) pick({ kind: 'tpl', t: state.boot.templates.find((t) => t.id === preset.template_id) });
    else { draw(); loadLookup(); }
  }

  return { open };
})();
