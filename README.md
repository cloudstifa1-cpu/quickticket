# QuickTicket — Version 1

Quotes, invoices and payments for trades. Works on phones and desktops, and works offline.
Private code. Do not make this repo public.

## What Version 1 does

- Customer list: name, phone, email, address, notes, and history
- Quotes: labor and materials lines, tax (on everything or materials only), discount
- Turn a quote into an invoice in one tap
- Send by text, email, or as a shared PDF; download the PDF
- Pay link on every invoice (your Stripe Payment Link: card and bank)
- Status: draft, sent, overdue, paid (quotes: draft, sent, accepted)
- Reminders: the Home screen lists who to remind (3 days before due, due today, 7+ days late), with one-tap text or email
- Saved items for one-tap adding
- Your business name, info and logo on every quote and invoice
- Works offline; everything saves on the device; backup and restore file

## What waits for accounts (Version 1.5)

These need a server, so they switch on once Supabase and the LLC's Stripe account exist:

- "Viewed" status (knowing when the customer opened it)
- Reminders that send on their own, without you tapping
- Cloud sync between phone and computer (for now, use Backup and Restore)
- A Stripe pay button with the exact amount filled in, and invoices that mark themselves paid

## Files

| File | What it is |
| --- | --- |
| index.html | The page shell |
| app.js | All screens and logic. App name is set at the top (`APP_NAME`) |
| util.js | Money, dates, totals, status |
| db.js | On-device database (IndexedDB) |
| pdf.js | Builds the invoice PDF |
| sw.js | Offline support |
| styles.css | High-contrast theme, phone and desktop layouts |

## Putting it online

No build step. Upload the folder as-is to Netlify or Cloudflare Pages, or connect this repo to either one.
On the phone, open the site and choose "Add to Home screen" to install it.
