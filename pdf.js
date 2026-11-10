// Builds a clean invoice/quote PDF on the device (no server needed).
import { totals, money, fmtDate, normRate } from './util.js';

export function buildPdf(doc, biz, customer) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 48;
  let y = M;

  // Header: logo + business info (left), title (right)
  if (biz.logo) {
    try {
      const props = pdf.getImageProperties(biz.logo);
      const h = 60, w = Math.min(160, (props.width / props.height) * h);
      pdf.addImage(biz.logo, M, y, w, h);
      y += h + 10;
    } catch (_) { /* bad image: skip it */ }
  }
  pdf.setFont('helvetica', 'bold').setFontSize(14).text(biz.name || 'Your Business', M, y);
  pdf.setFont('helvetica', 'normal').setFontSize(10);
  const bizLines = [biz.address, biz.phone, biz.email].filter(Boolean);
  bizLines.forEach((l, i) => pdf.text(String(l), M, y + 15 + i * 13));

  const title = doc.kind === 'quote' ? 'QUOTE' : 'INVOICE';
  pdf.setFont('helvetica', 'bold').setFontSize(24).text(title, W - M, M + 20, { align: 'right' });
  pdf.setFont('helvetica', 'normal').setFontSize(10);
  const meta = [
    `No. ${doc.number}`,
    `Date: ${fmtDate(doc.issueDate)}`,
    doc.kind === 'invoice' ? `Due: ${fmtDate(doc.dueDate)}` : `Valid until: ${fmtDate(doc.dueDate)}`,
  ];
  meta.forEach((l, i) => pdf.text(l, W - M, M + 40 + i * 13, { align: 'right' }));
  if (doc.kind === 'invoice' && doc.paid) {
    const paidOn = doc.paidAt ? fmtDate(doc.paidAt.slice(0, 10)) : '';
    pdf.setTextColor(0, 140, 60).setFont('helvetica', 'bold').setFontSize(20);
    pdf.text('PAID', W - M, M + 100, { align: 'right' });
    pdf.setFontSize(10).text(paidOn ? `Paid ${paidOn} - thank you!` : 'Thank you!', W - M, M + 114, { align: 'right' });
    pdf.setTextColor(0).setFont('helvetica', 'normal');
  }

  y = Math.max(y + 20 + bizLines.length * 13, M + 90);

  // Bill to
  pdf.setFont('helvetica', 'bold').setFontSize(11).text(doc.kind === 'quote' ? 'Prepared for' : 'Bill to', M, y);
  pdf.setFont('helvetica', 'normal').setFontSize(10);
  const cust = customer ? [customer.name, customer.address, customer.phone, customer.email].filter(Boolean) : ['—'];
  cust.forEach((l, i) => pdf.text(String(l), M, y + 15 + i * 13));
  y += 25 + cust.length * 13;

  // Table header
  const cols = { desc: M, qty: W - M - 210, price: W - M - 120, amt: W - M };
  pdf.setFillColor(20, 20, 20).rect(M, y, W - 2 * M, 22, 'F');
  pdf.setTextColor(255).setFont('helvetica', 'bold').setFontSize(10);
  pdf.text('Description', cols.desc + 6, y + 15);
  pdf.text('Qty', cols.qty, y + 15, { align: 'right' });
  pdf.text('Price', cols.price, y + 15, { align: 'right' });
  pdf.text('Amount', cols.amt - 6, y + 15, { align: 'right' });
  pdf.setTextColor(0).setFont('helvetica', 'normal');
  y += 22;

  for (const line of doc.lines) {
    const text = `${line.desc || ''}${line.type === 'material' ? ' (materials)' : ''}`;
    const wrapped = pdf.splitTextToSize(text, cols.qty - cols.desc - 50);
    const rowH = Math.max(20, wrapped.length * 12 + 8);
    if (y + rowH > H - 160) { pdf.addPage(); y = M; }
    pdf.text(wrapped, cols.desc + 6, y + 14);
    pdf.text(String(line.qty ?? ''), cols.qty, y + 14, { align: 'right' });
    pdf.text(money(line.price), cols.price, y + 14, { align: 'right' });
    pdf.text(money((+line.qty || 0) * (+line.price || 0)), cols.amt - 6, y + 14, { align: 'right' });
    y += rowH;
    pdf.setDrawColor(200).line(M, y, W - M, y);
  }

  // Totals
  const t = totals(doc);
  y += 16;
  const tot = [['Subtotal', money(t.subtotal)]];
  if (t.discount) tot.push(['Discount', '-' + money(t.discount)]);
  if (t.tax) tot.push([`Tax (${normRate(doc.taxRate)}%)`, money(t.tax)]);
  tot.forEach(([k, v]) => {
    pdf.text(k, cols.price, y, { align: 'right' });
    pdf.text(v, cols.amt - 6, y, { align: 'right' });
    y += 15;
  });
  pdf.setFont('helvetica', 'bold').setFontSize(13);
  pdf.text(doc.kind === 'quote' ? 'Total' : (doc.paid ? 'Total (PAID)' : 'Total due'), cols.price, y + 4, { align: 'right' });
  pdf.text(money(t.total), cols.amt - 6, y + 4, { align: 'right' });
  pdf.setFont('helvetica', 'normal').setFontSize(10);
  y += 30;

  // Pay link + notes
  const payLink = doc.payLink || biz.payLink;
  if (doc.kind === 'invoice' && payLink && !doc.paid) {
    pdf.setFont('helvetica', 'bold').text('Pay online (card or bank):', M, y);
    pdf.setFont('helvetica', 'normal').setTextColor(0, 70, 200);
    pdf.textWithLink(payLink, M, y + 14, { url: payLink });
    pdf.setTextColor(0);
    y += 34;
  }
  const notes = [doc.notes, biz.terms].filter(Boolean).join('\n\n');
  if (notes) {
    if (y > H - 100) { pdf.addPage(); y = M; }
    pdf.setFont('helvetica', 'bold').text('Notes', M, y);
    pdf.setFont('helvetica', 'normal').text(pdf.splitTextToSize(notes, W - 2 * M), M, y + 14);
  }

  return pdf;
}
