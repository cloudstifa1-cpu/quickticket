// QuickTicket — quotes, invoices and payments for trades. Version 1 (local-first, works offline).
import { db, uid } from './db.js';
import { buildPdf } from './pdf.js';
import { round, money, today, addDays, fmtDate, totals, statusOf, esc, normRate } from './util.js';

export const APP_NAME = 'QuickTicket'; // change the app's name here

// ---------- State (loaded from the device database) ----------
const S = { customers: [], items: [], docs: [], biz: {}, counters: { quote: 1001, invoice: 1001 } };
const view = document.getElementById('view');
const nav = document.getElementById('nav');
let draft = null;      // quote/invoice being edited
let newCust = null;    // quick-add customer inside the editor

async function load() {
  [S.customers, S.items, S.docs] = await Promise.all(['customers', 'items', 'docs'].map(s => db.all(s)));
  S.biz = (await db.get('meta', 'business')) || { id: 'business', taxRate: 0, termsDays: 14, taxOn: 'all' };
  S.counters = (await db.get('meta', 'counters')) || { id: 'counters', quote: 1001, invoice: 1001 };
}

async function save(store, obj) {
  await db.put(store, obj);
  const list = S[store];
  const i = list.findIndex(x => x.id === obj.id);
  i >= 0 ? (list[i] = obj) : list.push(obj);
}

async function remove(store, id) {
  await db.del(store, id);
  S[store] = S[store].filter(x => x.id !== id);
}

async function nextNumber(kind) {
  const n = S.counters[kind];
  S.counters[kind] = n + 1;
  await db.put('meta', S.counters);
  return (kind === 'quote' ? 'Q-' : 'INV-') + n;
}

const custOf = d => S.customers.find(c => c.id === d.customerId);
const badge = d => { const s = statusOf(d); return `<span class="badge b-${s}">${s.toUpperCase()}</span>`; };

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- Navigation ----------
const TABS = [
  ['home', '🏠', 'Home'], ['quotes', '📝', 'Quotes'], ['invoices', '💵', 'Invoices'],
  ['customers', '👥', 'Customers'], ['items', '🧰', 'Items'], ['settings', '⚙️', 'Business'],
];

function renderNav(route) {
  const top = route.split('/')[0] || 'home';
  const active = { doc: draft?.kind === 'quote' ? 'quotes' : 'invoices', customer: 'customers' }[top] || top;
  nav.innerHTML = `<div class="brand">${APP_NAME}</div>` + TABS.map(([r, i, l]) =>
    `<a href="#/${r}" class="${active === r ? 'on' : ''}"><span class="ico" aria-hidden="true">${i}</span>${l}</a>`).join('');
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, qs] = hash.split('?');
  const parts = path.split('/');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  view.oninput = view.onchange = view.onclick = null;
  const r = parts[0] || 'home';
  if (r !== 'doc') draft = null;
  ({
    home: viewHome,
    quotes: () => viewDocList('quote'),
    invoices: () => viewDocList('invoice'),
    doc: () => viewDoc(parts[1], parts[2], params),
    customers: viewCustomers,
    customer: () => viewCustomer(parts[1]),
    items: viewItems,
    settings: viewSettings,
  }[r] || viewHome)();
  renderNav(path);
  window.scrollTo(0, 0);
}
const go = h => { location.hash = h; };

// ---------- Messages, sending and reminders ----------
function message(d, reminder) {
  const c = custOf(d);
  const first = (c?.name || '').trim().split(' ')[0] || 'there';
  const biz = S.biz.name || 'us';
  const total = money(totals(d).total);
  if (d.kind === 'quote') {
    return `Hi ${first}, here is quote ${d.number} from ${biz} for ${total}. Reply to approve and we'll get you on the schedule. - ${biz}`;
  }
  const lead = {
    pre: `friendly reminder that invoice ${d.number} for ${total} is due ${fmtDate(d.dueDate)}.`,
    due: `invoice ${d.number} for ${total} is due today.`,
    late: `invoice ${d.number} for ${total} was due ${fmtDate(d.dueDate)} and is now past due.`,
  }[reminder] || `here is invoice ${d.number} from ${biz} for ${total}, due ${fmtDate(d.dueDate)}.`;
  const link = d.payLink || S.biz.payLink;
  return `Hi ${first}, ${lead}${link ? ` Pay online by card or bank: ${link}` : ''} Thank you! - ${biz}`;
}

function remindersDue() {
  const t = today();
  const out = [];
  for (const d of S.docs) {
    if (d.kind !== 'invoice' || d.paid || !d.sentAt) continue;
    const r = d.reminders || {};
    if (t >= addDays(d.dueDate, 7)) { if (!r.late) out.push({ d, k: 'late' }); }
    else if (t >= d.dueDate) { if (!r.due) out.push({ d, k: 'due' }); }
    else if (t >= addDays(d.dueDate, -3) && !r.pre) out.push({ d, k: 'pre' });
  }
  return out;
}

const pdfName = d => `${d.number}${custOf(d) ? '-' + custOf(d).name.replace(/[^\w]+/g, '-') : ''}.pdf`;

async function send(d, channel, reminder) {
  const c = custOf(d);
  const text = message(d, reminder);
  if (channel === 'text') {
    if (!c?.phone) return toast('Add a phone number for this customer first');
  } else if (channel === 'email') {
    if (!c?.email) return toast('Add an email for this customer first');
  }
  // Record it as sent / reminded
  if (reminder) d.reminders = { ...(d.reminders || {}), [reminder]: new Date().toISOString() };
  else if (!d.sentAt) d.sentAt = new Date().toISOString();
  await save('docs', d);

  if (channel === 'text') {
    location.href = `sms:${c.phone.replace(/[^\d+]/g, '')}?body=${encodeURIComponent(text)}`;
  } else if (channel === 'email') {
    const subject = `${d.kind === 'quote' ? 'Quote' : 'Invoice'} ${d.number} from ${S.biz.name || ''}`.trim();
    location.href = `mailto:${c.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  } else {
    const pdf = buildPdf(d, S.biz, c);
    const file = new File([pdf.output('blob')], pdfName(d), { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name, text }); }
      catch (e) { if (e.name !== 'AbortError') toast('Could not share. Try Download PDF.'); }
    } else {
      pdf.save(file.name);
      toast('PDF downloaded. Attach it to a text or email.');
    }
  }
  setTimeout(route, 300);
}

// ---------- Home ----------
function viewHome() {
  const inv = S.docs.filter(d => d.kind === 'invoice');
  const unpaid = inv.filter(d => !d.paid && d.sentAt);
  const overdue = unpaid.filter(d => statusOf(d) === 'overdue');
  const month = today().slice(0, 7);
  const paidMonth = inv.filter(d => d.paid && (d.paidAt || '').slice(0, 7) === month);
  const openQuotes = S.docs.filter(d => d.kind === 'quote' && !d.convertedTo);
  const sum = list => money(list.reduce((s, d) => s + totals(d).total, 0));
  const rem = remindersDue();
  const recent = [...S.docs].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 6);
  const label = { pre: 'Due in 3 days', due: 'Due today', late: '7+ days late' };

  view.innerHTML = `
    <h1>${esc(S.biz.name || APP_NAME)}</h1>
    ${!S.biz.name ? `<p class="note">Start here: <a href="#/settings">add your business info and logo</a>. It goes on every invoice.</p>` : ''}
    ${!navigator.onLine ? `<p class="note">You're offline. Everything still saves on this device.</p>` : ''}
    <div class="actions">
      <a class="btn" href="#/doc/new/quote">+ New quote</a>
      <a class="btn" href="#/doc/new/invoice">+ New invoice</a>
    </div>
    <div class="stats">
      <div class="card stat"><div>Money owed</div><div class="num">${sum(unpaid)}</div></div>
      <div class="card stat"><div>Overdue (${overdue.length})</div><div class="num" style="color:var(--warn)">${sum(overdue)}</div></div>
      <div class="card stat"><div>Paid this month</div><div class="num" style="color:var(--good)">${sum(paidMonth)}</div></div>
      <div class="card stat"><div>Open quotes (${openQuotes.length})</div><div class="num">${sum(openQuotes)}</div></div>
    </div>
    <h2>Reminders to send (${rem.length})</h2>
    ${rem.length ? rem.map(({ d, k }) => `
      <div class="card">
        <div class="row between wrap"><div><span class="big">${esc(custOf(d)?.name || 'No customer')}</span> · ${esc(d.number)} · ${money(totals(d).total)}</div><span class="badge b-overdue">${label[k]}</span></div>
        <div class="actions">
          <button data-act="remind" data-id="${d.id}" data-k="${k}" data-ch="text">Text reminder</button>
          <button class="ghost" data-act="remind" data-id="${d.id}" data-k="${k}" data-ch="email">Email reminder</button>
          <button class="ghost" data-act="skip" data-id="${d.id}" data-k="${k}">Skip</button>
        </div>
      </div>`).join('') : `<div class="empty">No reminders due. Nice.</div>`}
    <h2>Recent</h2>
    <div class="list">${recent.length ? recent.map(docRow).join('') : `<div class="empty">No quotes or invoices yet.</div>`}</div>`;

  view.onclick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const d = S.docs.find(x => x.id === b.dataset.id);
    if (b.dataset.act === 'remind') send(d, b.dataset.ch, b.dataset.k);
    if (b.dataset.act === 'skip') {
      d.reminders = { ...(d.reminders || {}), [b.dataset.k]: 'skipped' };
      await save('docs', d);
      route();
    }
  };
}

function docRow(d) {
  const c = custOf(d);
  return `<a class="item" href="#/doc/${d.id}">
    <div><div class="big">${esc(c?.name || 'No customer')}</div><div>${esc(d.number || 'Draft')} · ${fmtDate(d.issueDate)}</div></div>
    <div style="text-align:right"><div class="big">${money(totals(d).total)}</div>${badge(d)}</div></a>`;
}

// ---------- Quote / invoice lists ----------
function viewDocList(kind) {
  const all = S.docs.filter(d => d.kind === kind).sort((a, b) => (b.issueDate + b.number).localeCompare(a.issueDate + a.number));
  const statuses = kind === 'invoice' ? ['all', 'draft', 'sent', 'overdue', 'paid'] : ['all', 'draft', 'sent', 'accepted'];
  view.innerHTML = `
    <div class="row between wrap"><h1>${kind === 'quote' ? 'Quotes' : 'Invoices'}</h1>
      <a class="btn" href="#/doc/new/${kind}">+ New ${kind}</a></div>
    <label for="f">Show</label>
    <select id="f">${statuses.map(s => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
    <div class="list" id="list" style="margin-top:12px"></div>`;
  const draw = () => {
    const f = view.querySelector('#f').value;
    const list = f === 'all' ? all : all.filter(d => statusOf(d) === f);
    view.querySelector('#list').innerHTML = list.length ? list.map(docRow).join('') : `<div class="empty">Nothing here yet.</div>`;
  };
  view.onchange = draw;
  draw();
}

// ---------- Quote / invoice editor ----------
function blankLine() { return { desc: '', qty: 1, price: 0, type: 'labor' }; }

function viewDoc(id, kindNew, params) {
  if (id === 'new') {
    const kind = kindNew === 'quote' ? 'quote' : 'invoice';
    draft = {
      id: uid(), kind, number: null, customerId: params.c || '', lines: [blankLine()],
      taxRate: S.biz.taxRate ?? 0, taxOn: S.biz.taxOn || 'all', discount: 0, notes: '', payLink: '',
      issueDate: today(), dueDate: addDays(today(), kind === 'invoice' ? (+S.biz.termsDays || 14) : 30), isNew: true,
    };
  } else if (!draft || draft.id !== id) {
    const d = S.docs.find(x => x.id === id);
    if (!d) { view.innerHTML = `<div class="empty">Not found. <a href="#/home">Go home</a></div>`; return; }
    draft = structuredClone(d);
  }
  newCust = null;
  drawEditor();
}

function drawEditor() {
  const d = draft;
  const isQ = d.kind === 'quote';
  const src = !d.isNew ? S.docs.find(x => x.id === d.id) : null;
  const custOpts = [...S.customers].sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${c.id}" ${c.id === d.customerId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

  view.innerHTML = `
    <div class="row between wrap">
      <h1>${isQ ? 'Quote' : 'Invoice'} ${esc(d.number || '(new)')}</h1>
      ${src ? badge(src) : ''}
    </div>
    ${src?.convertedTo ? `<p class="note">Turned into an invoice. <a href="#/doc/${src.convertedTo}">Open the invoice</a></p>` : ''}
    ${src?.fromQuote ? `<p class="note">Made from a quote. <a href="#/doc/${src.fromQuote}">Open the quote</a></p>` : ''}

    <label for="cust">Customer</label>
    <select id="cust" data-f="customerId">
      <option value="">— Pick a customer —</option>${custOpts}<option value="__new">+ New customer</option>
    </select>
    <div id="newcust"></div>

    <div class="grid2">
      <div><label for="issue">Date</label><input id="issue" type="date" data-f="issueDate" value="${d.issueDate}"></div>
      <div><label for="due">${isQ ? 'Valid until' : 'Due date'}</label><input id="due" type="date" data-f="dueDate" value="${d.dueDate}"></div>
    </div>

    <h2>Work and materials</h2>
    <div id="lines"></div>
    <div class="actions">
      <button class="ghost" data-act="addline">+ Add line</button>
      ${S.items.length ? `<select data-act-change="additem" aria-label="Add a saved item"><option value="">+ Add saved item…</option>${
        [...S.items].sort((a, b) => a.name.localeCompare(b.name)).map(i => `<option value="${i.id}">${esc(i.name)} — ${money(i.price)}</option>`).join('')}</select>` : ''}
    </div>

    <div class="grid2">
      <div><label for="tax">Tax rate %</label><input id="tax" type="number" inputmode="decimal" step="any" data-f="taxRate" value="${d.taxRate}"></div>
      <div><label for="taxon">Tax applies to</label><select id="taxon" data-f="taxOn">
        <option value="all" ${d.taxOn !== 'materials' ? 'selected' : ''}>Everything</option>
        <option value="materials" ${d.taxOn === 'materials' ? 'selected' : ''}>Materials only</option></select></div>
      <div><label for="disc">Discount $</label><input id="disc" type="number" inputmode="decimal" step="any" data-f="discount" value="${d.discount}"></div>
    </div>

    <div class="card totals" id="totals"></div>

    <label for="notes">Notes for the customer</label>
    <textarea id="notes" data-f="notes" placeholder="e.g. 1-year warranty on parts and labor">${esc(d.notes)}</textarea>
    ${!isQ ? `<label for="pay">Payment link (leave blank to use your default)</label>
      <input id="pay" type="url" data-f="payLink" value="${esc(d.payLink)}" placeholder="${esc(S.biz.payLink || 'https://buy.stripe.com/...')}">` : ''}

    <div class="actions"><button data-act="save">Save</button></div>

    <h2>Send it</h2>
    <div class="actions">
      <button data-act="send" data-ch="text">Text it</button>
      <button data-act="send" data-ch="email">Email it</button>
      <button data-act="send" data-ch="share">Share PDF</button>
      <button class="ghost" data-act="pdf">Download PDF</button>
    </div>

    <h2>More</h2>
    <div class="actions">
      ${isQ && !src?.convertedTo ? `<button data-act="convert">Turn into invoice</button>` : ''}
      ${!isQ ? (src?.paid ? `<button class="ghost" data-act="unpaid">Mark as not paid</button>` : `<button data-act="paid">Mark as paid</button>`) : ''}
      ${src?.sentAt && !src?.paid ? `<button class="ghost" data-act="unsend">Mark as not sent</button>` : ''}
      ${src ? `<button class="danger" data-act="delete">Delete</button>` : ''}
    </div>`;

  drawLines();
  drawTotals();

  view.oninput = view.onchange = e => {
    const el = e.target;
    if (el.dataset.actChange === 'additem' && e.type === 'change') {
      const it = S.items.find(i => i.id === el.value);
      if (it) {
        const blank = d.lines.length === 1 && !d.lines[0].desc && !+d.lines[0].price;
        const line = { desc: it.name, qty: 1, price: it.price, type: it.type };
        blank ? (d.lines[0] = line) : d.lines.push(line);
        drawLines(); drawTotals();
      }
      el.value = '';
      return;
    }
    if (el.dataset.l !== undefined) {
      const l = d.lines[+el.dataset.l];
      l[el.dataset.f] = ['qty', 'price'].includes(el.dataset.f) ? el.value : el.value;
      const amt = view.querySelector(`[data-amt="${el.dataset.l}"]`);
      if (amt) amt.textContent = money((+l.qty || 0) * (+l.price || 0));
      drawTotals();
      return;
    }
    if (el.dataset.nc) { newCust[el.dataset.nc] = el.value; return; }
    if (el.dataset.f) {
      if (el.dataset.f === 'customerId' && el.value === '__new') {
        newCust = { name: '', phone: '', email: '', address: '' };
        d.customerId = '';
        drawNewCust();
        return;
      }
      if (el.dataset.f === 'customerId') { newCust = null; drawNewCust(); }
      d[el.dataset.f] = el.value;
      if (['taxRate', 'discount', 'taxOn'].includes(el.dataset.f)) drawTotals();
    }
  };

  view.onclick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'addline') { d.lines.push(blankLine()); drawLines(); drawTotals(); view.querySelector(`[data-l="${d.lines.length - 1}"]`)?.focus(); return; }
    if (act === 'rmline') { d.lines.splice(+b.dataset.i, 1); if (!d.lines.length) d.lines.push(blankLine()); drawLines(); drawTotals(); return; }
    if (act === 'saveitem') {
      const l = d.lines[+b.dataset.i];
      if (!l.desc.trim()) return toast('Type a description first');
      await save('items', { id: uid(), name: l.desc.trim(), price: round(l.price), type: l.type });
      return toast('Saved to your items');
    }
    if (act === 'delete') {
      if (!confirmInline(b, 'Tap again to delete')) return;
      await remove('docs', d.id);
      toast('Deleted');
      return go(isQ ? '#/quotes' : '#/invoices');
    }
    const saved = await saveDraft();
    if (!saved) return;
    if (act === 'save') { toast('Saved'); return go(`#/doc/${saved.id}`); }
    if (act === 'send') return send(saved, b.dataset.ch);
    if (act === 'pdf') { buildPdf(saved, S.biz, custOf(saved)).save(pdfName(saved)); return; }
    if (act === 'convert') {
      const inv = {
        ...structuredClone(saved), id: uid(), kind: 'invoice', number: await nextNumber('invoice'),
        issueDate: today(), dueDate: addDays(today(), +S.biz.termsDays || 14), sentAt: null, reminders: {},
        paid: false, paidAt: null, convertedTo: null, fromQuote: saved.id, payLink: '',
      };
      await save('docs', inv);
      saved.convertedTo = inv.id;
      await save('docs', saved);
      toast('Invoice created');
      draft = null;
      return go(`#/doc/${inv.id}`);
    }
    if (act === 'paid' || act === 'unpaid') {
      saved.paid = act === 'paid';
      saved.paidAt = saved.paid ? new Date().toISOString() : null;
      await save('docs', saved);
      toast(saved.paid ? 'Marked paid' : 'Marked not paid');
      draft = structuredClone(saved);
      return drawEditor();
    }
    if (act === 'unsend') {
      saved.sentAt = null; saved.reminders = {};
      await save('docs', saved);
      draft = structuredClone(saved);
      return drawEditor();
    }
  };
}

function drawNewCust() {
  const box = view.querySelector('#newcust');
  if (!newCust) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card">
    <label for="nc1">Name</label><input id="nc1" data-nc="name" autocomplete="off">
    <div class="grid2">
      <div><label for="nc2">Phone</label><input id="nc2" data-nc="phone" type="tel" inputmode="tel"></div>
      <div><label for="nc3">Email</label><input id="nc3" data-nc="email" type="email" inputmode="email"></div>
    </div>
    <label for="nc4">Address</label><input id="nc4" data-nc="address">
    <p>This customer is saved when you save the ${draft.kind}.</p></div>`;
  box.querySelector('#nc1').focus();
}

function drawLines() {
  view.querySelector('#lines').innerHTML = draft.lines.map((l, i) => `
    <div class="line">
      <label for="d${i}">Description</label>
      <input id="d${i}" data-l="${i}" data-f="desc" value="${esc(l.desc)}" placeholder="e.g. Water heater flush">
      <div class="lgrid">
        <div><label for="t${i}">Type</label><select id="t${i}" data-l="${i}" data-f="type">
          <option value="labor" ${l.type !== 'material' ? 'selected' : ''}>Labor</option>
          <option value="material" ${l.type === 'material' ? 'selected' : ''}>Materials</option></select></div>
        <div><label for="q${i}">Qty</label><input id="q${i}" data-l="${i}" data-f="qty" type="number" inputmode="decimal" step="any" value="${esc(l.qty)}"></div>
        <div><label for="p${i}">Price $</label><input id="p${i}" data-l="${i}" data-f="price" type="number" inputmode="decimal" step="any" value="${esc(l.price)}"></div>
        <button class="danger small" data-act="rmline" data-i="${i}" aria-label="Remove line">✕</button>
      </div>
      <div class="row between wrap" style="margin-top:8px">
        <span>Amount: <b data-amt="${i}">${money((+l.qty || 0) * (+l.price || 0))}</b></span>
        <button class="ghost small" data-act="saveitem" data-i="${i}">Save to my items</button>
      </div>
    </div>`).join('');
}

function drawTotals() {
  const t = totals(draft);
  view.querySelector('#totals').innerHTML = `
    <div class="row"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
    ${t.discount ? `<div class="row"><span>Discount</span><span>-${money(t.discount)}</span></div>` : ''}
    <div class="row"><span>Tax (${normRate(draft.taxRate)}%${draft.taxOn === 'materials' ? ', materials only' : ''})</span><span>${money(t.tax)}</span></div>
    <div class="row grand"><span>Total</span><span>${money(t.total)}</span></div>`;
}

// Saves the open quote/invoice (and a quick-added customer). Returns the saved record.
async function saveDraft() {
  const d = draft;
  if (newCust) {
    if (!newCust.name.trim()) { toast('Type the new customer\'s name'); return null; }
    const c = { id: uid(), ...newCust, name: newCust.name.trim(), notes: '' };
    await save('customers', c);
    d.customerId = c.id;
    newCust = null;
  }
  d.lines = d.lines.filter(l => l.desc.trim() || +l.price).map(l => ({ ...l, qty: +l.qty || 0, price: round(l.price) }));
  if (!d.lines.length) { d.lines = [blankLine()]; toast('Add at least one line'); drawLines(); return null; }
  d.taxRate = normRate(d.taxRate);
  d.discount = round(d.discount);
  if (!d.number) d.number = await nextNumber(d.kind);
  const prev = S.docs.find(x => x.id === d.id) || {};
  const rec = { ...prev, ...d };
  delete rec.isNew;
  await save('docs', rec);
  draft = structuredClone(rec);
  return rec;
}

function confirmInline(btn, text) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1';
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 3000);
  return false;
}

// ---------- Customers ----------
function viewCustomers() {
  view.innerHTML = `
    <div class="row between wrap"><h1>Customers</h1><a class="btn" href="#/customer/new">+ New customer</a></div>
    <label for="q">Search</label><input id="q" type="search" placeholder="Name, phone or address">
    <div class="list" id="list" style="margin-top:12px"></div>`;
  const draw = () => {
    const q = view.querySelector('#q').value.toLowerCase();
    const list = S.customers.filter(c => [c.name, c.phone, c.email, c.address].join(' ').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    view.querySelector('#list').innerHTML = list.length ? list.map(c => {
      const owed = S.docs.filter(d => d.customerId === c.id && d.kind === 'invoice' && !d.paid && d.sentAt)
        .reduce((s, d) => s + totals(d).total, 0);
      return `<a class="item" href="#/customer/${c.id}"><div><div class="big">${esc(c.name)}</div><div>${esc(c.phone || c.email || '')}</div></div>
        ${owed ? `<div class="big" style="color:var(--warn)">Owes ${money(owed)}</div>` : ''}</a>`;
    }).join('') : `<div class="empty">${S.customers.length ? 'No match.' : 'No customers yet.'}</div>`;
  };
  view.oninput = draw;
  draw();
}

function viewCustomer(id) {
  const isNew = id === 'new';
  const c = isNew ? { id: uid(), name: '', phone: '', email: '', address: '', notes: '' } : S.customers.find(x => x.id === id);
  if (!c) { view.innerHTML = `<div class="empty">Not found.</div>`; return; }
  const docs = S.docs.filter(d => d.customerId === c.id).sort((a, b) => b.issueDate.localeCompare(a.issueDate));
  view.innerHTML = `
    <h1>${isNew ? 'New customer' : esc(c.name)}</h1>
    <label for="n">Name</label><input id="n" data-f="name" value="${esc(c.name)}" autocomplete="off">
    <div class="grid2">
      <div><label for="p">Phone</label><input id="p" data-f="phone" type="tel" inputmode="tel" value="${esc(c.phone)}"></div>
      <div><label for="e">Email</label><input id="e" data-f="email" type="email" inputmode="email" value="${esc(c.email)}"></div>
    </div>
    <label for="a">Address</label><input id="a" data-f="address" value="${esc(c.address)}">
    <label for="no">Notes</label><textarea id="no" data-f="notes" placeholder="Gate code, dog in yard, etc.">${esc(c.notes)}</textarea>
    <div class="actions"><button data-act="save">Save</button>
      ${!isNew && c.phone ? `<a class="btn ghost" href="tel:${esc(c.phone)}">Call</a>` : ''}
      ${!isNew ? `<button class="danger" data-act="delete">Delete</button>` : ''}</div>
    ${!isNew ? `<div class="actions"><a class="btn" href="#/doc/new/quote?c=${c.id}">+ Quote for ${esc(c.name.split(' ')[0])}</a>
      <a class="btn" href="#/doc/new/invoice?c=${c.id}">+ Invoice for ${esc(c.name.split(' ')[0])}</a></div>
      <h2>History</h2><div class="list">${docs.length ? docs.map(docRow).join('') : `<div class="empty">No quotes or invoices yet.</div>`}</div>` : ''}`;
  if (isNew) view.querySelector('#n').focus();
  view.oninput = e => { if (e.target.dataset.f) c[e.target.dataset.f] = e.target.value; };
  view.onclick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'save') {
      if (!c.name.trim()) return toast('Type a name');
      c.name = c.name.trim();
      await save('customers', c);
      toast('Saved');
      return isNew ? go(`#/customer/${c.id}`) : route();
    }
    if (b.dataset.act === 'delete') {
      if (docs.length) return toast('This customer has quotes or invoices, so it can\'t be deleted');
      if (!confirmInline(b, 'Tap again to delete')) return;
      await remove('customers', c.id);
      go('#/customers');
    }
  };
}

// ---------- Saved items ----------
function viewItems() {
  const list = [...S.items].sort((a, b) => a.name.localeCompare(b.name));
  view.innerHTML = `
    <h1>My items and services</h1>
    <p>Save the jobs and parts you charge for most. Then add them to a quote with one tap.</p>
    <div class="card">
      <label for="in">Name</label><input id="in" placeholder="e.g. Service call">
      <div class="grid2">
        <div><label for="ip">Price $</label><input id="ip" type="number" inputmode="decimal" step="any"></div>
        <div><label for="it">Type</label><select id="it"><option value="labor">Labor</option><option value="material">Materials</option></select></div>
      </div>
      <div class="actions"><button data-act="add">+ Add item</button></div>
    </div>
    <div class="list">${list.length ? list.map(i => `
      <div class="card row between wrap">
        <div><div class="big">${esc(i.name)}</div><div>${money(i.price)} · ${i.type === 'material' ? 'Materials' : 'Labor'}</div></div>
        <button class="danger small" data-act="del" data-id="${i.id}">Delete</button>
      </div>`).join('') : `<div class="empty">No saved items yet.</div>`}</div>`;
  view.onclick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'add') {
      const name = view.querySelector('#in').value.trim();
      if (!name) return toast('Type a name');
      await save('items', { id: uid(), name, price: round(view.querySelector('#ip').value), type: view.querySelector('#it').value });
      toast('Item added');
      route();
    }
    if (b.dataset.act === 'del') {
      if (!confirmInline(b, 'Tap again')) return;
      await remove('items', b.dataset.id);
      route();
    }
  };
}

// ---------- Business settings + backup ----------
function viewSettings() {
  const b = { ...S.biz };
  view.innerHTML = `
    <h1>Your business</h1>
    <p>This shows on every quote and invoice.</p>
    <label for="bn">Business name</label><input id="bn" data-f="name" value="${esc(b.name)}">
    <label for="ba">Address</label><input id="ba" data-f="address" value="${esc(b.address)}">
    <div class="grid2">
      <div><label for="bp">Phone</label><input id="bp" data-f="phone" type="tel" value="${esc(b.phone)}"></div>
      <div><label for="be">Email</label><input id="be" data-f="email" type="email" value="${esc(b.email)}"></div>
    </div>
    <label for="logo">Logo</label>
    <div class="row wrap">${b.logo ? `<img class="logo-preview" src="${b.logo}" alt="Your logo">` : ''}
      <input id="logo" type="file" accept="image/*" style="max-width:320px">
      ${b.logo ? `<button class="ghost small" data-act="nologo">Remove logo</button>` : ''}</div>

    <h2>Defaults</h2>
    <div class="grid2">
      <div><label for="bt">Tax rate %</label><input id="bt" data-f="taxRate" type="number" inputmode="decimal" step="any" value="${esc(b.taxRate ?? 0)}"></div>
      <div><label for="bto">Tax applies to</label><select id="bto" data-f="taxOn">
        <option value="all" ${b.taxOn !== 'materials' ? 'selected' : ''}>Everything</option>
        <option value="materials" ${b.taxOn === 'materials' ? 'selected' : ''}>Materials only</option></select></div>
      <div><label for="bd">Invoices due in (days)</label><input id="bd" data-f="termsDays" type="number" inputmode="numeric" value="${esc(b.termsDays ?? 14)}"></div>
    </div>
    <label for="bterms">Fine print on every invoice</label>
    <textarea id="bterms" data-f="terms" placeholder="e.g. Payment due on receipt. Thank you for your business!">${esc(b.terms)}</textarea>

    <h2>Getting paid online</h2>
    <p class="note">In your Stripe account, make a <b>Payment Link</b> and set it so the customer can enter the amount. Turn on cards and bank payments. Paste the link here and it goes on every invoice.</p>
    <label for="bl">Stripe payment link</label>
    <input id="bl" data-f="payLink" type="url" placeholder="https://buy.stripe.com/..." value="${esc(b.payLink)}">

    <div class="actions"><button data-act="save">Save</button></div>

    <h2>Backup</h2>
    <p>Your data is saved on this device only. Download a backup now and then, and keep it somewhere safe. You can also use it to move to a new phone or a computer.</p>
    <div class="actions">
      <button class="ghost" data-act="export">Download backup</button>
      <label class="btn ghost" style="margin:0">Restore backup<input type="file" id="imp" accept="application/json,.json" hidden></label>
    </div>`;

  view.onchange = async e => {
    if (e.target.id === 'logo' && e.target.files[0]) {
      try { b.logo = await shrinkImage(e.target.files[0]); S.biz.logo = b.logo; await db.put('meta', { ...S.biz }); toast('Logo saved'); viewSettings(); }
      catch { toast('Could not read that image'); }
    }
    if (e.target.id === 'imp' && e.target.files[0]) importBackup(e.target.files[0]);
  };
  view.oninput = e => { if (e.target.dataset.f) b[e.target.dataset.f] = e.target.value; };
  view.onclick = async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'save') {
      b.taxRate = normRate(b.taxRate);
      b.termsDays = Math.max(0, parseInt(b.termsDays, 10) || 0);
      S.biz = b;
      await db.put('meta', b);
      toast('Saved');
    }
    if (btn.dataset.act === 'nologo') { b.logo = ''; S.biz.logo = ''; await db.put('meta', { ...S.biz }); viewSettings(); }
    if (btn.dataset.act === 'export') exportBackup();
  };
}

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 400 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      x.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function exportBackup() {
  const data = { app: APP_NAME, version: 1, exportedAt: new Date().toISOString(),
    business: S.biz, counters: S.counters, customers: S.customers, items: S.items, docs: S.docs };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `${APP_NAME}-backup-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.docs) || !Array.isArray(data.customers)) throw new Error('bad file');
    for (const s of ['customers', 'items', 'docs']) {
      await db.clear(s);
      for (const r of data[s] || []) await db.put(s, r);
    }
    if (data.business) await db.put('meta', { ...data.business, id: 'business' });
    if (data.counters) await db.put('meta', { ...data.counters, id: 'counters' });
    await load();
    toast('Backup restored');
    go('#/home');
  } catch { toast('That file is not a valid backup'); }
}

// ---------- Start ----------
window.addEventListener('hashchange', route);
window.addEventListener('online', route);
window.addEventListener('offline', route);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
document.title = APP_NAME;
load().then(route);
