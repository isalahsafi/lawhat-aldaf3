// النواة: الحالة، الاتصال بالخادم، التنسيق، التوجيه، النوافذ والإشعارات.
const App = (() => {
  const LOCAL = Calc.LOCAL;
  const state = { boot: null, display: localStorage.getItem('display') || null, route: null };

  // ---------- الخادم ----------
  async function api(method, url, body, raw) {
    if (window.FPB_LOCAL) return window.FPB_LOCAL.api(method, url, raw ? undefined : body);
    const opt = { method, headers: {} };
    if (body !== undefined) {
      if (raw) { opt.body = body; opt.headers['Content-Type'] = 'application/octet-stream'; }
      else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    }
    const r = await fetch(url, opt);
    if (r.status === 401) { location.href = '/login.html'; throw new Error('login'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'خطأ في الخادم');
    return j;
  }
  const get = (u) => api('GET', u);
  const post = (u, b) => api('POST', u, b ?? {});
  const patch = (u, b) => api('PATCH', u, b);
  const put = (u, b) => api('PUT', u, b);
  const del = (u) => api('DELETE', u);

  async function reloadBoot() {
    state.boot = await get('/api/bootstrap');
    if (!state.display) state.display = state.boot.settings.base_currency || LOCAL;
    const r = state.boot.todayRate;
    $('#todayRate').textContent = r ? `1 $ = ${fmtN(r.rate, 2)} ₺` : 'غير متاح';
    const n = state.boot.debts.filter((d) => d.status === 'active' && d.late).length;
    $$('[data-badge="debts"]').forEach((b) => { b.textContent = n || ''; b.classList.toggle('hidden', !n); });
    return state.boot;
  }

  // ---------- أدوات ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const MONTHS_S = ['ينا', 'فبر', 'مار', 'أبر', 'ماي', 'يون', 'يول', 'أغس', 'سبت', 'أكت', 'نوف', 'ديس'];
  const ymLabel = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
  const ymShort = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS_S[m - 1]} ${String(y).slice(2)}`; };
  const shiftYm = Calc.shiftYm;
  const todayYm = () => state.boot.today.slice(0, 7);
  const dateLabel = (d) => { if (!d) return ''; const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS[m - 1]}${y !== Number(state.boot.today.slice(0, 4)) ? ' ' + y : ''}`; };
  const curSym = (c) => (c === 'USD' ? '$' : '₺');

  function fmtN(n, dec) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const d = dec ?? (Math.abs(n) >= 1000 || Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2);
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  // مبلغ بعملة: ₺ 12,500 أو $250
  function money(n, cur = LOCAL, dec) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const neg = n < 0;
    const d = dec ?? (cur === 'USD' && Math.abs(n) < 1000 && !Number.isInteger(Math.round(n * 100) / 100) ? 2 : undefined);
    const v = fmtN(Math.abs(n), d);
    return cur === 'USD' ? `${neg ? '−' : ''}$${v}` : `${neg ? '−' : ''}₺ ${v}`;
  }
  const m$ = (n, cur, dec) => `<span class="num money">${money(n, cur, dec)}</span>`;
  // قيمة محلية بعملة العرض المختارة
  function disp(localV, rate) {
    if (state.display === 'USD') return money(rate ? localV / rate : null, 'USD');
    return money(localV, LOCAL);
  }
  const d$ = (localV, rate) => `<span class="num money">${disp(localV, rate)}</span>`;
  // القيمة الأخرى (للسطر الثانوي)
  const other$ = (localV, rate) => (state.display === 'USD' ? m$(localV, LOCAL) : m$(rate ? localV / rate : null, 'USD'));
  const compact = (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return Math.round(n / 1e3) + 'k';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return fmtN(n, 0);
  };

  const sectionById = (id) => state.boot.sections.find((s) => s.id === id);
  const sectionByKey = (k) => state.boot.sections.find((s) => s.key === k);
  const templateById = (id) => state.boot.templates.find((t) => t.id === id);
  const SECTION_VAR = { income: 'in', basic: 'ex', subs: 'sub', variable: 'var', debts: 'debt' };
  const secColor = (s) => (s && SECTION_VAR[s.key] ? `var(--${SECTION_VAR[s.key]})` : (s && s.color) || 'var(--accent)');

  function iconFor(x) {
    let t = x.template_id ? templateById(x.template_id) : (x.section_id && x.aliases !== undefined ? x : null);
    if (!t && x.note) t = state.boot.templates.find((y) => y.name === x.note && y.section_id === x.section_id) || null;
    if (!t && x.debt_id) {
      const d = state.boot.debts.find((y) => y.id === x.debt_id);
      if (d) return avatar(d.party, d.color, 30);
    }
    const icon = (t && t.icon) || '';
    const color = (t && t.color) || '';
    if (color) return `<span class="mono" style="background:${esc(color)}">${esc(icon || (x.name || '?')[0])}</span>`;
    if (icon) return `<span class="ic">${esc(icon)}</span>`;
    const s = sectionById(x.section_id);
    return `<span class="ic">${esc((s && s.icon) || '•')}</span>`;
  }
  const avatar = (name, color, size = 34) => `<span class="av" style="background:${esc(color || '#c2255c')};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc(String(name || '?').trim()[0] || '?')}</span>`;

  // منتقي شهر وسنة: <select> للشهر و<input> للسنة
  function ymPicker(id, value, opts = {}) {
    const [y, m] = (value || todayYm()).split('-');
    return `<span class="ympick" id="${id}"><select class="inp">${MONTHS.map((n, i) => `<option value="${pad(i + 1)}" ${pad(i + 1) === m ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <input class="inp num" type="number" min="1990" max="2100" value="${y}">${opts.clear ? '<button type="button" class="link" data-clear>بلا نهاية</button>' : ''}</span>`;
  }
  const ymRead = (el) => { if (!el || el.dataset.empty) return null; const [s, i] = [$('select', el), $('input', el)]; return `${i.value}-${s.value}`; };

  // ---------- نوافذ ----------
  function modal(html, { onClose, wide } = {}) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal" role="dialog" ${wide ? `style="width:${wide === true ? 640 : wide}px"` : ''}>${html}</div>`;
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = (e) => { if (e.key === 'Escape' && ov === document.querySelector('.overlay:last-of-type')) close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    $$('[data-close]', ov).forEach((b) => b.addEventListener('click', close));
    const first = $('input:not([type=hidden]):not([type=checkbox]),select', ov);
    if (first && matchMedia('(min-width: 861px)').matches) setTimeout(() => first.focus(), 30);
    return { el: $('.modal', ov), close };
  }
  function confirmBox(text, okLabel = 'تأكيد', danger) {
    return new Promise((res) => {
      const m = modal(`<h2>تأكيد</h2><p>${text}</p><div class="mf"><button class="btn p" id="ok" ${danger ? 'style="background:var(--bad);border-color:var(--bad)"' : ''}>${okLabel}</button><button class="btn" data-close>إلغاء</button></div>`, { onClose: () => res(false) });
      $('#ok', m.el).onclick = () => { res(true); m.close(); };
    });
  }
  function toast(text, { undo, undoMany, error, ms = 5000 } = {}) {
    const t = document.createElement('div');
    t.className = 'toast' + (error ? ' err' : '');
    t.innerHTML = `<span>${text}</span>${undo || undoMany ? '<button>تراجع</button>' : ''}`;
    $('#toasts').appendChild(t);
    const kill = () => t.remove();
    if (undo || undoMany) $('button', t).onclick = async () => {
      kill();
      try {
        if (undoMany) await post('/api/audit/undo-many', { ids: undoMany }); else await post(`/api/audit/${undo}/undo`);
        toast('تم التراجع ✓'); refresh();
      } catch (e) { toast(esc(e.message), { error: true }); }
    };
    setTimeout(kill, ms);
  }
  const fail = (e) => toast(esc(e.message || e), { error: true });

  // ---------- التوجيه ----------
  const routes = {};
  const route = (name, fn) => { routes[name] = fn; };
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [p, qs] = h.split('?');
    const parts = p.split('/').filter(Boolean);
    return { name: parts[0] || 'home', args: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs || '')) };
  }
  const NAV_OF = { month: 'months', recurring: 'months', debt: 'debts', import: 'settings' };
  async function render() {
    const r = parseHash();
    state.route = r;
    const navName = NAV_OF[r.name] || r.name;
    $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === navName));
    const view = $('#view');
    try { await (routes[r.name] || routes.home)(view, r); } catch (e) { console.error(e); view.innerHTML = `<div class="card empty"><h2>حدث خطأ</h2><p>${esc(e.message)}</p></div>`; }
    if (window.Alerts) Alerts.decorate(view);
  }
  async function refresh() { await reloadBoot(); if (window.Alerts) await Alerts.load(); await render(); }

  function setDisplay(cur) { state.display = cur; localStorage.setItem('display', cur); render(); }
  const displaySeg = () => `<div class="seg" data-display><button class="${state.display !== 'USD' ? 'on' : ''}" data-cur="${LOCAL}">₺</button><button class="${state.display === 'USD' ? 'on' : ''}" data-cur="USD">$</button></div>`;
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-display] [data-cur]'); if (b) setDisplay(b.dataset.cur); });

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('theme', t);
    $('#themeBtn').textContent = t === 'dark' ? '☀' : '🌙';
    if (window.Chart) Chart.defaults.color = getComputedStyle(document.body).getPropertyValue('--muted').trim();
  }
  function applyPriv(on) {
    document.body.classList.toggle('priv', on);
    localStorage.setItem('priv', on ? '1' : '');
    $('#privBtn').classList.toggle('p', on);
    $$('[data-priv]').forEach((b) => { b.textContent = on ? '🙈' : '👁'; b.title = on ? 'إظهار المبالغ' : 'إخفاء المبالغ'; b.classList.toggle('on', on); });
  }
  // زر إخفاء/إظهار المبالغ في رأس الصفحة الرئيسية
  const privBtn = () => {
    const on = document.body.classList.contains('priv');
    return `<button class="btn eye ${on ? 'on' : ''}" data-priv type="button" title="${on ? 'إظهار المبالغ' : 'إخفاء المبالغ'}" aria-label="إخفاء المبالغ">${on ? '🙈' : '👁'}</button>`;
  };
  document.addEventListener('click', (e) => { if (e.target.closest('[data-priv]')) applyPriv(!document.body.classList.contains('priv')); });

  async function start() {
    applyTheme(document.documentElement.dataset.theme || 'light');
    applyPriv(!!localStorage.getItem('priv'));
    $('#themeBtn').onclick = () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); render(); };
    $('#privBtn').onclick = () => applyPriv(!document.body.classList.contains('priv'));
    $('#fab').onclick = () => Quick.open();
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || document.querySelector('.overlay')) return;
      if (e.key === '+' || e.key === '/') { e.preventDefault(); Quick.open(); }
    });
    if (window.Chart) {
      Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
      Chart.defaults.color = getComputedStyle(document.body).getPropertyValue('--muted').trim();
    }
    try { await reloadBoot(); } catch (e) { $('#view').innerHTML = `<div class="card empty"><h2>تعذر الاتصال بالخادم</h2><p>${esc(e.message)}</p></div>`; return; }
    window.addEventListener('hashchange', render);
    await render();
    // التنبيهات: عند الفتح، وعند العودة إلى التطبيق (قد يكون يومًا جديدًا)
    if (window.Alerts) {
      Alerts.autoShow();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Alerts.autoShow(); });
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register(window.FPB_LOCAL ? 'sw.js' : '/sw.js').catch(() => {});
  }

  return {
    LOCAL, state, api, get, post, patch, put, del, reloadBoot, refresh, render, route, modal, confirmBox, toast, fail,
    $, $$, esc, pad, MONTHS, MONTHS_S, ymLabel, ymShort, shiftYm, todayYm, dateLabel, curSym, fmtN, money, m$, disp, d$, other$, compact,
    sectionById, sectionByKey, templateById, secColor, iconFor, avatar, ymPicker, ymRead, displaySeg, privBtn, start,
  };
})();
