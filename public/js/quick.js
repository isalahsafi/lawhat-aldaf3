// الإضافة السريعة.
// تبويب «مصروف» (الافتراضي): خانة واحدة ذكية «خبز 60» ← حفظ، مع أزرار المتكرر وفئة مستنتجة،
//   ولصق عدة أسطر يسجّلها دفعة واحدة. تبقى النافذة مفتوحة للعملية التالية.
// تبويب «التزامات ودخل»: المستحق الآن أولًا، ثم البنود المعتادة (اختر بندًا ← المبلغ ← حفظ).
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
  // «خبز 60» أو «60 خبز» أو «غداء 12$» أو «قهوة 45+30»
  function parseText(raw) {
    const txt = String(raw || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).trim();
    const nums = txt.match(/\d[\d,.]*(?:\s*[+*]\s*\d[\d,.]*)*/g);
    const amtStr = nums ? nums[nums.length - 1] : '';
    const amount = amtStr ? Calc.evalAmount(amtStr) : NaN;
    const usd = /\$|دولار|usd/i.test(txt);
    const desc = (amtStr ? txt.replace(amtStr, '') : txt).replace(/[$₺]|دولار|ليرة|ليره|usd|try/gi, '').replace(/\s+/g, ' ').trim();
    return { desc, amount, usd, hasAmount: !!amtStr, ok: amount > 0 && !Number.isNaN(amount) };
  }
  const todayOf = () => state.boot.today;
  const yesterday = () => { const t = new Date(todayOf() + 'T12:00:00'); t.setDate(t.getDate() - 1); return `${t.getFullYear()}-${App.pad(t.getMonth() + 1)}-${App.pad(t.getDate())}`; };

  function open(preset = {}) {
    const s = {
      tab: preset.template_id ? 'fix' : 'exp', item: null, currency: state.boot.settings.base_currency || LOCAL, amount: '', date: todayOf(), dateMode: 'today',
      status: 'paid', mode: 'replace', paid: '', desc: '', category: null, catTouched: false, lookup: null, rate: null, filter: '', ddOpen: true, hi: 0,
      // تبويب «مصروف»
      text: '', showCats: false, showOpts: false, forceVar: false, person: null, personTouched: false, oneOff: false, oneOffTouched: false, parsedPrev: [],
      alerts: null,
    };
    const m = App.modal(`<h2>إضافة سريعة <button class="x" data-close>✕</button></h2>
      <div class="seg" style="margin-bottom:10px" id="qtabs"><button data-tab="exp">مصروف</button><button data-tab="fix">التزامات ودخل</button></div><div id="qbody"></div>`);
    const body = $('#qbody', m.el);
    const varSec = sectionByKey('variable');
    const categories = state.boot.templates.filter((t) => t.section_id === (varSec && varSec.id));
    let history = [];
    const loadHistory = () => get('/api/variable/history').then((h) => { history = h; }).catch(() => {});
    loadHistory().then(() => { if (s.tab === 'exp') { live(); tiles(); } });
    get('/api/fx/day/' + todayOf()).then((r) => { s.rate = r && r.rate; if (s.tab === 'exp') live(); }).catch(() => {});
    get('/api/alerts').then((a) => { s.alerts = a; if (s.tab === 'fix' && !s.item) draw(); }).catch(() => {});

    const setTab = (t) => {
      s.tab = t;
      $$('#qtabs [data-tab]', m.el).forEach((x) => x.classList.toggle('on', x.dataset.tab === t));
      if (t === 'exp') drawExp(); else { draw(); loadLookup(); }
    };
    $$('#qtabs [data-tab]', m.el).forEach((b) => b.onclick = () => setTab(b.dataset.tab));

    // =====================================================================
    // تبويب «مصروف»: خانة واحدة ذكية
    // =====================================================================
    const usage = () => {
      const n = {};
      for (const h of history) if (h.category) n[h.category] = (n[h.category] || 0) + h.n;
      return n;
    };
    const catsByUsage = () => { const n = usage(); return [...categories].sort((a, b) => (n[b.name] || 0) - (n[a.name] || 0) || a.sort - b.sort); };
    const lines = () => s.text.split('\n').map((x) => x.trim()).filter(Boolean);
    const isMulti = () => lines().length > 1;

    function drawExp() {
      body.innerHTML = `<div class="smartbox">
          <textarea class="inp smart" id="qSmart" rows="1" placeholder="اكتب: خبز 60 · قهوة 45+30 · غداء 12$" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done">${esc(s.text)}</textarea>
        </div>
        <div id="qLive"></div>
        <div id="qOpts"></div>
        <div id="qTiles"></div>
        <div class="errline" id="qErr"></div>
        <button class="btn p qgo" id="qGo">حفظ</button>
        <div class="qtoday faint" id="qToday"></div>`;
      const ta = $('#qSmart', body);
      grow(ta);
      ta.oninput = () => { s.text = ta.value; if (!s.text.trim()) resetGuess(); grow(ta); $('#qErr', body).textContent = ''; live(); tiles(); };
      ta.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); saveExp(); } };
      $('#qGo', body).onclick = saveExp;
      live(); opts(); tiles(); todayLine();
      focusSmart();
    }
    const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'; };
    const focusSmart = (end = true) => {
      const ta = $('#qSmart', body);
      if (!ta) return;
      ta.focus();
      if (end) { try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* لا شيء */ } }
    };
    function resetGuess() { s.category = null; s.catTouched = false; s.showCats = false; s.forceVar = false; if (!s.personTouched) s.person = null; if (!s.oneOffTouched) s.oneOff = false; }

    // المعاينة الحية: الفئة أو البند المعتاد، والتحويل، أو جدول عدة أسطر
    function live() {
      const el = $('#qLive', body);
      if (!el) return;
      const go = $('#qGo', body);
      if (isMulti()) { manyLive(el, go); return; }
      const p = parseText(s.text);
      // الفئة المختارة يدويًا (أو من زر متكرر) تخص الوصف الذي اختيرت له؛ تغيّر الوصف = تخمين جديد
      if ((s.catTouched || s.forceVar) && norm(p.desc) !== s.catDesc) { s.catTouched = false; s.forceVar = false; s.showCats = false; }
      const tpl = !s.forceVar && p.desc ? matchTemplate(p.desc) : null;
      let html = '';
      if (tpl) {
        const sec = sectionById(tpl.section_id);
        html += `<div class="qrow">${iconFor(tpl)}<span>يُسجَّل في بند <b>${esc(tpl.name)}</b> <span class="faint">· ${esc(sec ? sec.name : '')}</span></span>
          <button class="link" data-notpl>مصروف متغير؟</button></div>`;
      } else if (p.desc || s.catTouched) {
        if (!s.catTouched) s.category = guessCategory(p.desc, history, categories);
        if (!s.personTouched) s.person = guessPerson(p.desc, history);
        if (!s.oneOffTouched) s.oneOff = !!(s.category && s.category.one_off_default);
        if (s.category && !s.showCats) {
          html += `<div class="qrow"><button class="chip on" data-catopen>${esc(s.category.icon)} ${esc(s.category.name)} ▾</button>
            <span class="faint" style="font-size:12px">${s.catTouched ? '' : 'اختيرت تلقائيًا'}</span></div>`;
        } else {
          html += `<div class="fl" style="margin-top:10px">${s.category ? 'الفئة' : 'اختر الفئة'}</div>
            <div class="chips">${catsByUsage().map((c) => `<button class="chip ${s.category && s.category.id === c.id ? 'on' : ''}" data-cat="${c.id}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div>`;
        }
      }
      if (s.text.trim() && !p.hasAmount) html += '<div class="faint qhint">أضف المبلغ بعد الوصف، مثل: خبز 60</div>';
      else if (p.hasAmount && !p.ok) html += '<div class="c-bad qhint">صيغة المبلغ غير صحيحة</div>';
      else if (p.ok && s.rate) {
        const cur = p.usd ? 'USD' : s.currency;
        html += `<div class="faint qhint">≈ <b class="num">${cur === 'USD' ? money(p.amount * s.rate, LOCAL) : money(p.amount / s.rate, 'USD')}</b></div>`;
      }
      el.innerHTML = html;
      if (go) { go.textContent = 'حفظ'; go.disabled = false; }
      const nt = $('[data-notpl]', el); if (nt) nt.onclick = () => { s.forceVar = true; s.catDesc = norm(parseText(s.text).desc); live(); focusSmart(); };
      const co = $('[data-catopen]', el); if (co) co.onclick = () => { s.showCats = true; live(); };
      $$('[data-cat]', el).forEach((b) => b.onclick = () => {
        s.category = categories.find((c) => c.id === Number(b.dataset.cat));
        s.catTouched = true; s.showCats = false; s.catDesc = norm(parseText(s.text).desc);
        if (!s.oneOffTouched) s.oneOff = !!s.category.one_off_default;
        live(); opts(); focusSmart();
      });
      opts();
    }

    // سطر الخيارات الثانوية: التاريخ · العملة · لمن · لمرة واحدة
    function opts() {
      const el = $('#qOpts', body);
      if (!el) return;
      const p = parseText(s.text);
      const cur = p.usd ? 'USD' : s.currency;
      const dateTxt = s.dateMode === 'today' ? 'اليوم' : s.dateMode === 'yesterday' ? 'أمس' : App.dateLabel(s.date);
      const bits = [dateTxt, cur === 'USD' ? '$' : '₺'];
      if (s.person) bits.push('لـ ' + s.person);
      if (s.oneOff) bits.push('لمرة واحدة');
      if (!s.showOpts) {
        el.innerHTML = `<button class="qopts" data-opts>${bits.map(esc).join(' · ')} <span class="faint">▾ خيارات</span></button>`;
        $('[data-opts]', el).onclick = () => { s.showOpts = true; opts(); };
        return;
      }
      el.innerHTML = `<div class="previewbox qoptbox">
        <div class="fl" style="margin-top:0">التاريخ</div><div class="chips">
          <button class="chip ${s.dateMode === 'today' ? 'on' : ''}" data-date="today">اليوم</button>
          <button class="chip ${s.dateMode === 'yesterday' ? 'on' : ''}" data-date="yesterday">أمس</button>
          <button class="chip ${s.dateMode === 'pick' ? 'on' : ''}" data-date="pick">📅 تاريخ آخر</button></div>
          ${s.dateMode === 'pick' ? `<input type="date" class="inp" id="qDate" value="${s.date}" max="${todayOf()}" style="margin-top:8px">` : ''}
        <div class="fl">العملة ${p.usd ? '<span class="faint" style="font-size:11.5px">· من $ في النص</span>' : ''}</div>
          <div class="seg"><button data-qcur="${LOCAL}" class="${cur !== 'USD' ? 'on' : ''}">₺ ليرة</button><button data-qcur="USD" class="${cur === 'USD' ? 'on' : ''}">$ دولار</button></div>
        <div class="fl">لمن؟ <span class="faint" style="font-size:11.5px">اختياري</span></div>
          <div class="chips">${(state.boot.settings.people || []).map((x) => `<button class="chip ${s.person === x ? 'on' : ''}" data-person="${esc(x)}">${esc(x)}</button>`).join('')}
            <input class="inp" id="qNewPerson" placeholder="＋ شخص" style="width:100px;padding:4px 10px;border-radius:99px"></div>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:10px"><input type="checkbox" id="qOne" ${s.oneOff ? 'checked' : ''}> لمرة واحدة <span class="faint" style="font-size:11.5px">· لا يدخل في الوتيرة والتوقع</span></label>
        <button class="link" data-optsclose style="margin-top:8px">▴ إخفاء الخيارات</button></div>`;
      $$('[data-date]', el).forEach((b) => b.onclick = () => {
        s.dateMode = b.dataset.date;
        if (s.dateMode === 'today') s.date = todayOf();
        if (s.dateMode === 'yesterday') s.date = yesterday();
        opts(); todayLine();
      });
      const qd = $('#qDate', el); if (qd) qd.onchange = () => { if (qd.value) { s.date = qd.value; todayLine(); } };
      $$('[data-qcur]', el).forEach((b) => b.onclick = () => { s.currency = b.dataset.qcur; opts(); live(); });
      $$('[data-person]', el).forEach((b) => b.onclick = () => { s.person = s.person === b.dataset.person ? null : b.dataset.person; s.personTouched = true; opts(); });
      const np = $('#qNewPerson', el);
      if (np) np.onkeydown = async (ev) => {
        if (ev.key !== 'Enter' || !np.value.trim()) return;
        ev.preventDefault();
        const name = np.value.trim();
        const people = [...new Set([...(state.boot.settings.people || []), name])];
        try { await App.put('/api/settings', { people }); state.boot.settings.people = people; s.person = name; s.personTouched = true; opts(); } catch (e) { App.fail(e); }
      };
      const one = $('#qOne', el); if (one) one.onchange = () => { s.oneOff = one.checked; s.oneOffTouched = true; };
      $('[data-optsclose]', el).onclick = () => { s.showOpts = false; opts(); };
    }

    // أزرار المتكرر: الأكثر استخدامًا، أو ما يطابق ما يُكتب
    function tiles() {
      const el = $('#qTiles', body);
      if (!el) return;
      if (isMulti()) { el.innerHTML = ''; return; }
      const p = parseText(s.text);
      const f = norm(p.desc);
      let list;
      if (!f) list = [...history].sort((a, b) => b.n - a.n || String(b.last).localeCompare(String(a.last))).slice(0, 8);
      else list = history.filter((h) => norm(h.name).includes(f) && norm(h.name) !== f).slice(0, 6);
      if (!list.length) { el.innerHTML = ''; return; }
      const icon = (h) => { const c = categories.find((x) => x.name === h.category); return c ? c.icon : '✦'; };
      el.innerHTML = `<div class="fl">${f ? 'اقتراحات' : 'الأكثر تسجيلًا'}</div><div class="qtiles">${list.map((h, i) => `<button class="qtile" data-tile="${i}">
          <span class="ti">${esc(icon(h))}</span><span class="tn">${esc(h.name)}</span>${h.amount ? `<span class="ta num">${money(h.amount, h.currency || LOCAL)}</span>` : ''}</button>`).join('')}</div>`;
      $$('[data-tile]', el).forEach((b) => b.onclick = () => {
        const h = list[Number(b.dataset.tile)];
        s.text = `${h.name}${h.amount ? ' ' + App.fmtN(h.amount).replace(/,/g, '') + (h.currency === 'USD' ? '$' : '') : ''}`;
        const c = categories.find((x) => x.name === h.category);
        s.category = c || null; s.catTouched = !!c; s.showCats = false; s.forceVar = true; s.catDesc = norm(h.name);
        if (h.person && !s.personTouched) s.person = h.person;
        if (!s.oneOffTouched) s.oneOff = !!(c && c.one_off_default);
        const ta = $('#qSmart', body);
        ta.value = s.text; grow(ta);
        live(); tiles();
        // تحديد المبلغ ليسهل تعديله
        ta.focus();
        const at = s.text.lastIndexOf(' ');
        try { ta.setSelectionRange(at > 0 ? at + 1 : s.text.length, s.text.replace(/\$$/, '').length); } catch { /* لا شيء */ }
      });
    }

    // مجموع المصاريف المتغيرة لليوم المختار
    async function todayLine() {
      const el = $('#qToday', body);
      if (!el || !varSec) return;
      try {
        const ym = s.date.slice(0, 7);
        if (!state.boot.months.some((x) => x.ym === ym)) { el.textContent = ''; return; }
        const d = await get('/api/months/' + ym);
        const list = d.entries.filter((e) => e.section_id === varSec.id && e.tx_date === s.date && e.amount != null);
        const total = list.reduce((a, e) => a + Calc.entryValues(e, d.rate && d.rate.rate).local, 0);
        const day = s.date === todayOf() ? 'اليوم' : s.date === yesterday() ? 'أمس' : App.dateLabel(s.date);
        el.innerHTML = list.length ? `${day}: <b class="num">${money(total)}</b> · ${list.length} ${list.length === 1 ? 'عملية' : list.length <= 10 ? 'عمليات' : 'عملية'}` : '';
      } catch { el.textContent = ''; }
    }

    async function saveExp() {
      if (isMulti()) return saveMany();
      const err = $('#qErr', body);
      const go = $('#qGo', body);
      const p = parseText(s.text);
      if (!s.text.trim()) { err.textContent = 'اكتب الوصف والمبلغ، مثل: خبز 60'; focusSmart(); return; }
      if (!p.ok) { err.textContent = p.hasAmount ? 'صيغة المبلغ غير صحيحة' : 'أضف المبلغ، مثل: خبز 60'; focusSmart(); return; }
      const currency = p.usd ? 'USD' : s.currency;
      const tpl = !s.forceVar && p.desc ? matchTemplate(p.desc) : null;
      const payload = { amount: p.amount, currency, date: s.date, status: 'paid', keepDate: s.dateMode !== 'today' };
      let label;
      if (tpl) { payload.template_id = tpl.id; payload.mode = 'replace'; label = tpl.name; }
      else {
        if (!s.category) { err.textContent = 'اختر الفئة'; s.showCats = true; live(); return; }
        label = p.desc || s.category.name;
        Object.assign(payload, { new: { name: label, section_id: varSec.id }, category: s.category.name, person: s.person || null, one_off: s.oneOff });
      }
      try {
        go.disabled = true;
        const r = await post('/api/quick', payload);
        toast(`✓ ${esc(label)} · ${money(p.amount, currency)}${s.dateMode !== 'today' ? ' · ' + App.dateLabel(s.date) : ''}`, { undo: r.auditId, ms: 6000 });
        Object.assign(s, { text: '', person: null, personTouched: false, oneOff: false, oneOffTouched: false });
        resetGuess();
        await Promise.all([App.refresh(), loadHistory()]);
        drawExp();
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    }

    // ---------- عدة أسطر ملصوقة: سطر لكل عملية ----------
    function parseLines() {
      s.parsed = lines().map((raw, i) => {
        const p = parseText(raw);
        const prev = (s.parsedPrev || []).find((x) => x.raw === raw);
        const tpl = matchTemplate(p.desc);
        const cat = tpl ? null : guessCategory(p.desc, history, categories);
        const category = prev && prev.override ? prev.category : cat;
        return { i, raw, desc: p.desc, amount: p.amount, currency: p.usd ? 'USD' : LOCAL, tpl: prev && prev.override ? prev.tpl : tpl, category, override: prev && prev.override,
          person: guessPerson(p.desc, history), oneOff: prev && prev.oneOffSet ? prev.oneOff : !!(category && category.one_off_default), oneOffSet: prev && prev.oneOffSet,
          ok: p.ok && !!p.desc };
      });
      s.parsedPrev = s.parsed;
    }
    function manyLive(el, go) {
      parseLines();
      const ok = s.parsed.filter((x) => x.ok && (x.tpl || x.category));
      const total = ok.filter((x) => x.currency !== 'USD').reduce((a, x) => a + x.amount, 0);
      const regular = state.boot.templates.filter((t) => { const sc = sectionById(t.section_id); return sc && sc.key !== 'variable' && t.active; });
      el.innerHTML = `<div class="tw" style="margin-top:10px"><table class="tbl">${s.parsed.map((x) => `<tr>
          <td>${x.ok ? esc(x.desc) : `<span class="c-bad">${esc(x.raw)}</span>`}${x.ok && x.person && !x.tpl ? ` <span class="tag t-mu">${esc(x.person)}</span>` : ''}</td>
          <td class="num">${x.ok ? money(x.amount, x.currency) : '<span class="c-bad">لا مبلغ</span>'}</td>
          <td>${!x.ok ? '' : `<select class="inp" data-pl="${x.i}" style="padding:4px 8px;font-size:12.5px">
              ${!x.tpl && !x.category ? '<option value="" selected>⚠ اختر</option>' : ''}
              <optgroup label="مصاريف متغيرة">${categories.map((c) => `<option value="c${c.id}" ${!x.tpl && x.category && x.category.id === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</optgroup>
              <optgroup label="بنود معتادة">${regular.map((t) => `<option value="t${t.id}" ${x.tpl && x.tpl.id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup></select>`}</td></tr>`).join('')}</table></div>
        <div class="faint qhint">${ok.length} من ${s.parsed.length} جاهزة${total ? ` · المجموع بالليرة <b class="num">${money(total)}</b>` : ''}</div>`;
      $$('[data-pl]', el).forEach((sel) => sel.onchange = () => {
        const x = s.parsed[Number(sel.dataset.pl)];
        x.override = true;
        if (sel.value.startsWith('t')) { x.tpl = state.boot.templates.find((t) => t.id === Number(sel.value.slice(1))); x.category = null; }
        else { x.tpl = null; x.category = categories.find((c) => c.id === Number(sel.value.slice(1))); }
        live();
      });
      if (go) { go.textContent = `حفظ ${ok.length} عمليات`; go.disabled = !(ok.length && ok.length === s.parsed.length); }
      opts();
    }
    async function saveMany() {
      const go = $('#qGo', body);
      const keepDate = s.dateMode !== 'today';
      const items = s.parsed.map((x) => (x.tpl
        ? { template_id: x.tpl.id, amount: x.amount, currency: x.currency, date: s.date, status: 'paid', mode: 'replace', keepDate }
        : { new: { name: x.desc, section_id: varSec.id }, category: x.category.name, amount: x.amount, currency: x.currency, date: s.date, status: 'paid', person: x.person, one_off: x.oneOff }));
      try {
        go.disabled = true;
        const r = await post('/api/quick/batch', { items });
        toast(`✓ سُجّلت ${r.count} عمليات`, { undoMany: r.auditIds, ms: 8000 });
        Object.assign(s, { text: '', parsedPrev: [] });
        resetGuess();
        await Promise.all([App.refresh(), loadHistory()]);
        drawExp();
      } catch (e) { $('#qErr', body).textContent = e.message; go.disabled = false; }
    }

    // =====================================================================
    // تبويب «التزامات ودخل»: المستحق الآن، ثم اختيار بند معتاد
    // =====================================================================
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
        s.rate = s.lookup.rate || s.rate;
        if (!s.rate) { const r = await get('/api/fx/day/' + s.date); s.rate = r && r.rate; }
      } catch { /* المعاينة اختيارية */ }
      if (s.tab === 'fix') draw();
    }

    function pick(it) {
      s.item = it;
      s.ddOpen = false;
      const sec = sectionById(it.t.section_id);
      s.isIncome = !!sec && sec.kind === 'income';
      s.currency = it.t.currency || s.currency;
      s.status = 'paid';
      draw(); focusAmt(); loadLookup();
    }
    const amountVal = () => Calc.evalAmount(s.amount);

    // المستحق الآن (متأخر، اليوم، غدًا) بزر سداد مباشر
    function dueList() {
      const items = (s.alerts && s.alerts.items) || [];
      if (!items.length || s.filter) return '';
      const lbl = { overdue: ['متأخر', 'c-bad'], today: ['اليوم', 'c-fx'], tomorrow: ['غدًا', ''] };
      return `<div class="fl" style="margin-top:0">مستحق الآن</div>${items.map((i, idx) => `<div class="al-row k-${i.kind}">${iconFor(i)}
        <div class="al-m"><b>${esc(i.name)}</b><span class="${lbl[i.kind][1]}">${lbl[i.kind][0]} · ${App.dateLabel(i.due)}</span></div>
        <div class="al-a">${i.amount != null ? App.m$(i.amount, i.currency) : ''}</div><button class="btn sm p" data-duepay="${idx}">✓ دُفع</button></div>`).join('')}`;
    }

    let flat = [];
    function draw() {
      const groups = options();
      flat = groups.flatMap((g) => g.items);
      if (s.hi >= flat.length + 1) s.hi = 0;
      let html = '';
      if (s.item && !s.ddOpen) {
        const it = s.item;
        html += `<label class="fl">البند</label><div class="combo"><span class="sel-ic">${iconFor(it.t)}</span>
          <input class="inp" value="${esc(it.t.name)}" readonly id="qPicked" style="cursor:pointer"><button class="clear" id="qClear">✕</button></div>`;
      } else {
        html += dueList();
        html += `<label class="fl">البند</label><div class="combo"><span class="sel-ic"><span class="ic">⌕</span></span><input class="inp" id="qFilter" placeholder="اكتب أو اختر: كهرباء، Claude، الراتب…" value="${esc(s.filter)}" autocomplete="off"></div><div class="dd">`;
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
        html += `<div class="dsep"></div><button class="di new" data-toexp>＋ مصروف متغير${s.filter ? ': «' + esc(s.filter) + '»' : ''} ← تبويب «مصروف»</button></div>`;
      }
      if (s.item && !s.ddOpen) {
        const v = amountVal();
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
      ${s.dateMode === 'pick' ? `<input type="date" class="inp" id="qDate" value="${s.date}" max="${todayOf()}" style="margin-top:8px">` : ''}`;

    function keepFocus(fn) {
      const act = document.activeElement;
      const keep = act && body.contains(act) && act.id && act.id !== 'qFilter' ? { id: act.id, pos: act.selectionStart } : null;
      fn();
      if (keep) { const el = $('#' + keep.id, body); if (el) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch { /* date */ } } }
    }

    function entryPreview(v) {
      const lk = s.lookup;
      const ym = s.date.slice(0, 7);
      const e = lk && lk.entry;
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
      if (!s.item || !v || Number.isNaN(v) || !s.item.t.planned_amount) return '';
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
      const te = $('[data-toexp]', body); if (te) te.onclick = () => { s.text = s.filter; s.filter = ''; setTab('exp'); };
      $$('[data-duepay]', body).forEach((b) => b.onclick = async () => {
        const i = s.alerts.items[Number(b.dataset.duepay)];
        b.disabled = true;
        try {
          const r = await Alerts.pay(i);
          toast(`✓ ${esc(i.name)} مدفوع`, { undo: r.auditId });
          await App.refresh();
          s.alerts = await get('/api/alerts');
          draw();
        } catch (e) { b.disabled = false; App.fail(e); }
      });
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
      $$('[data-date]', body).forEach((b) => b.onclick = () => {
        s.dateMode = b.dataset.date;
        if (s.dateMode === 'today') s.date = todayOf();
        if (s.dateMode === 'yesterday') s.date = yesterday();
        draw(); loadLookup();
      });
      const qd = $('#qDate', body); if (qd) qd.onchange = () => { if (qd.value) { s.date = qd.value; loadLookup(); } };
      $$('[data-st]', body).forEach((b) => b.onclick = () => { s.status = b.dataset.st; draw(); });
      $$('[data-mode]', body).forEach((b) => b.onclick = () => { s.mode = b.dataset.mode; draw(); });
      const qp = $('#qPaid', body); if (qp) qp.oninput = () => { s.paid = qp.value; };
      const sv = $('#qSave', body); if (sv) sv.onclick = () => save(false);
      const sm = $('#qSaveMore', body); if (sm) sm.onclick = () => save(true);
    }
    const focusAmt = () => { const a = $('#qAmt', body); if (a) a.focus(); };

    async function save(more) {
      const v = amountVal();
      const err = $('#qErr', body);
      if (!v || Number.isNaN(v) || v <= 0) { err.textContent = 'أدخل مبلغًا صحيحًا'; focusAmt(); return; }
      const payload = { template_id: s.item.t.id, amount: v, currency: s.currency, date: s.date, status: s.status, mode: s.mode, keepDate: s.dateMode !== 'today',
        paid_amount: s.status === 'partial' ? Calc.evalAmount(s.paid) || 0 : undefined };
      const label = s.item.t.name;
      try {
        $$('#qSave,#qSaveMore', body).forEach((b) => b.disabled = true);
        const r = await post('/api/quick', payload);
        toast(`✓ ${esc(label)} · ${money(v, s.currency)} · ${ymLabel(r.ym || s.date.slice(0, 7))}`, { undo: r.auditId, ms: 7000 });
        await App.refresh();
        if (more) {
          s.alerts = await get('/api/alerts').catch(() => s.alerts);
          Object.assign(s, { item: null, amount: '', filter: '', ddOpen: true, status: 'paid', mode: 'replace', paid: '', hi: 0 });
          draw();
        } else m.close();
      } catch (e) {
        err.textContent = e.message;
        $$('#qSave,#qSaveMore', body).forEach((b) => b.disabled = false);
      }
    }

    if (preset.template_id) {
      setTab('fix');
      pick({ kind: 'tpl', t: state.boot.templates.find((t) => t.id === preset.template_id) });
    } else setTab('exp');
  }

  return { open };
})();
