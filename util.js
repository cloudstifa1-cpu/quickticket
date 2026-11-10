// Shared helpers: money, dates, totals, escaping.
export const round = n => Math.round((+n || 0) * 100) / 100;

export const money = n =>
  (n < 0 ? '-$' : '$') + Math.abs(round(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function fmtDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Accepts a tax rate typed as 9 or as .09 — both mean 9%. (No real sales tax is under 1%.)
export function normRate(r) {
  const n = Math.abs(+r || 0);
  return n > 0 && n < 1 ? round(n * 100 * 1000) / 1000 : n;
}

// Tax can apply to everything, or materials only (common for trades — check your state's rules).
export function totals(doc) {
  let subtotal = 0, taxable = 0;
  for (const l of doc.lines || []) {
    const amt = (+l.qty || 0) * (+l.price || 0);
    subtotal += amt;
    if (doc.taxOn !== 'materials' || l.type === 'material') taxable += amt;
  }
  subtotal = round(subtotal);
  const discount = round(Math.min(+doc.discount || 0, subtotal));
  const taxBase = subtotal ? taxable - discount * (taxable / subtotal) : 0;
  const tax = round(Math.max(0, taxBase) * normRate(doc.taxRate) / 100);
  return { subtotal, discount, tax, total: round(subtotal - discount + tax) };
}

export function statusOf(d) {
  if (d.kind === 'invoice') {
    if (d.paid) return 'paid';
    if (d.sentAt && d.dueDate < today()) return 'overdue';
    return d.sentAt ? 'sent' : 'draft';
  }
  if (d.convertedTo) return 'accepted';
  return d.sentAt ? 'sent' : 'draft';
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
