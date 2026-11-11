// مركز التنبيهات: زر 🔔 في رأس كل صفحة، ونافذة تلقائية عند فتح التطبيق
// بالالتزامات المتأخرة والمستحقة اليوم وغدًا. تُحسب من بيانات المنصة نفسها،
// فتختفي بمجرد تسجيل السداد.
const Alerts = (() => {
  const { $, $$, esc, get, post, patch, modal, toast, fail, m$, pad, ymLabel, iconFor, MONTHS } = App;
  const KIND = { overdue: ['متأخر', 'c-bad'], today: ['اليوم', 'c-fx'], tomorrow: ['غدًا', ''] };
  let data = null;

  const count = () => (data ? data.items.length : 0);
  const dayLabel = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? ' ' + y : ''}`; };

  async function load() {
    try { data = await get('/api/alerts'); } catch { data = data || { items: [], undated: [] }; }
    badge();
    return data;
  }
  function badge() {
    const n = count();
    $$('.bell').forEach((b) => {
      const s = $('.n', b);
      s.textContent = n > 9 ? '9+' : n || '';
      s.classList.toggle('hidden', !n);
      b.classList.toggle('has', !!n && data.items.some((i) => i.kind !== 'tomorrow'));
    });
  }
  // يضيف الزر إلى رأس الصفحة بعد كل عرض
  function decorate(view) {
    const tb = view && view.querySelector('.topbar');
    if (tb && !tb.querySelector('.bell')) tb.insertAdjacentHTML('beforeend', '<button class="bell" type="button" aria-label="التنبيهات" title="التنبيهات">🔔<span class="n hidden"></span></button>');
    badge();
  }
  document.addEventListener('click', (e) => { if (e.target.closest('.bell')) open(); });

  function row(i, idx) {
    const [label, cls] = KIND[i.kind];
    const amount = i.amount != null ? m$(i.partial ? i.amount - (i.paid_amount || 0) : i.amount, i.currency) : '<span class="faint">بلا مبلغ</span>';
    return `<div class="al-row k-${i.kind}">${iconFor(i)}
      <div class="al-m"><b>${esc(i.name)}</b><span class="${cls}">${label} · ${dayLabel(i.due)}${i.partial ? ' · المتبقي' : ''}</span></div>
      <div class="al-a">${amount}</div>
      <button class="btn sm p" data-pay="${idx}">✓ دُفع</button></div>`;
  }

  function show(auto) {
    const items = data.items;
    const undated = data.undated || [];
    const groups = ['overdue', 'today', 'tomorrow'].map((k) => [k, items.map((i, idx) => [i, idx]).filter(([i]) => i.kind === k)]).filter(([, l]) => l.length);
    const m = modal(`<h2>🔔 التنبيهات</h2>
      ${items.length ? groups.map(([k, l]) => `<div class="al-g"><div class="al-h">${{ overdue: 'متأخرة', today: 'مستحقة اليوم', tomorrow: 'مستحقة غدًا' }[k]}</div>${l.map(([i, idx]) => row(i, idx)).join('')}</div>`).join('')
        : '<p class="muted" style="margin:4px 0 12px">لا التزامات مستحقة اليوم أو غدًا ✓</p>'}
      ${undated.length ? `<div class="al-g"><div class="al-h">بلا موعد استحقاق هذا الشهر <span class="faint" style="font-weight:400">· حدّد اليوم ليصلك تنبيه</span></div>
        ${undated.map((u, idx) => `<div class="al-row">${iconFor(u)}<div class="al-m"><b>${esc(u.name)}</b><span class="faint">${ymLabel(u.ym)}</span></div>
          <input class="inp num" type="number" min="1" max="31" placeholder="اليوم" data-dayin="${idx}" style="width:74px">
          <button class="btn sm" data-dayset="${idx}">حفظ</button></div>`).join('')}</div>` : ''}
      <div class="mf"><button class="btn" data-close>${auto ? 'حسنًا' : 'إغلاق'}</button></div>`, { wide: 520 });

    $$('[data-pay]', m.el).forEach((b) => b.onclick = async () => {
      const i = items[Number(b.dataset.pay)];
      b.disabled = true;
      try {
        const r = await pay(i);
        toast(`✓ ${esc(i.name)} مدفوع`, { undo: r.auditId });
        m.close();
        await App.refresh();
      } catch (e) { b.disabled = false; fail(e); }
    });
    $$('[data-dayset]', m.el).forEach((b) => b.onclick = async () => {
      const u = undated[Number(b.dataset.dayset)];
      const d = Number($(`[data-dayin="${b.dataset.dayset}"]`, m.el).value);
      if (!(d >= 1 && d <= 31)) { toast('أدخل يومًا من 1 إلى 31', { error: true }); return; }
      const [y, mo] = u.ym.split('-').map(Number);
      const last = new Date(y, mo, 0).getDate();
      try {
        await patch('/api/entries/' + u.entry_id, { due_date: `${u.ym}-${pad(Math.min(d, last))}` });
        toast(`حُفظ موعد ${esc(u.name)}: يوم ${d} من كل شهر`);
        m.close();
        await App.refresh();
        open();
      } catch (e) { fail(e); }
    });
  }

  // تسجيل سداد التزام من القائمة (يُستخدم هنا وفي الإضافة السريعة)
  async function pay(i) {
    let id = i.entry_id;
    // بند في شهر لم يُنشأ بعد: يُنشأ الشهر ثم يُسجَّل السداد
    if (i.virtual) {
      await post('/api/months', { year: Number(i.ym.slice(0, 4)), month: Number(i.ym.slice(5)) });
      const again = await get('/api/alerts');
      const hit = again.items.find((x) => !x.virtual && x.ym === i.ym && x.name === i.name);
      id = hit && hit.entry_id;
      if (!id) throw new Error('تعذر إيجاد البند في الشهر الجديد');
    }
    return patch('/api/entries/' + id, { status: 'paid' });
  }

  async function open() { await load(); show(false); }

  // عند فتح التطبيق: تظهر النافذة إذا تغيّرت القائمة منذ آخر عرض (مرة في اليوم على الأكثر لنفس القائمة)
  async function autoShow() {
    await load();
    if (!count() || document.querySelector('.overlay')) return;
    const sig = data.today + '|' + data.items.map((i) => `${i.kind}:${i.name}:${i.due}`).join(',');
    let seen = null;
    try { seen = localStorage.getItem('alerts-seen'); } catch { /* لا شيء */ }
    if (seen === sig) return;
    try { localStorage.setItem('alerts-seen', sig); } catch { /* لا شيء */ }
    show(true);
  }

  return { load, decorate, open, autoShow, pay };
})();

window.Alerts = Alerts;
