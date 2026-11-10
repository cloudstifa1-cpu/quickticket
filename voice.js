// Voice-to-invoice: turns "John Smith, water heater flush 250 dollars, two elements at 40 each"
// into a customer and line items. Works offline (plain rules, no AI service).

const NUM = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

const MATERIAL_WORDS = /\b(parts?|materials?|elements?|valves?|pipes?|fittings?|filters?|wire|wiring|breakers?|outlets?|switch(es)?|faucets?|toilets?|tanks?|mulch|sod|seed|fertilizer|gravel|rock|shingles?|lumber|boards?|supplies|cartridges?|gaskets?|thermostats?|hoses?|bags?|gallons?|pumps?|motors?|capacitors?|refrigerant|freon|belts?|bulbs?|fixtures?|screws|nails|paint|caulk|sealant|tiles?|drywall|sheets?|disposal|heater)\b/i;
const LABOR_WORDS = /\b(install(ation|ing)?|replac(e|ed|ing|ement)|repair(s|ing)?|flush(ing)?|service|labor|clean(ing)?|mow(ing)?|trim(ming)?|haul(ing)?|inspect(ion)?|call|visit|diagnos(e|tic|is)|hours?|edg(e|ing)|blow(ing)?|weed(ing)?|unclog|snake|hookup|hook up)\b/i;

// "two hundred fifty" -> "250", "two and a half" -> "2.5"
export function wordsToNumbers(text) {
  const toks = text.replace(/(\w)-(\w)/g, '$1 $2').split(/\s+/).filter(Boolean);
  const out = [];
  let run = null;
  const flush = () => { if (run) { out.push(String(run.total + run.cur) + run.trail); run = null; } };
  for (let i = 0; i < toks.length; i++) {
    const m = toks[i].match(/^([a-zA-Z]+)([^a-zA-Z0-9]*)$/);
    const w = m ? m[1].toLowerCase() : null;
    if (w && (w in NUM || ((w === 'hundred' || w === 'thousand') && run))) {
      if (!run) run = { cur: 0, total: 0, trail: '' };
      if (w === 'hundred') run.cur = (run.cur || 1) * 100;
      else if (w === 'thousand') { run.total += (run.cur || 1) * 1000; run.cur = 0; }
      else run.cur += NUM[w];
      run.trail = m[2];
      if (m[2]) flush();
      continue;
    }
    if (run && w === 'and') {
      const nx = (toks[i + 1] || '').replace(/[^a-zA-Z]/g, '').toLowerCase();
      if (nx in NUM) continue; // "two hundred and fifty"
    }
    flush();
    out.push(toks[i]);
  }
  flush();
  return out.join(' ');
}

function normalize(text) {
  let t = ' ' + wordsToNumbers(text) + ' ';
  t = t.replace(/(\d+(?:\.\d+)?) and a half\b/gi, (_, n) => String(+n + 0.5));
  t = t.replace(/\ba half\b/gi, '0.5');
  t = t.replace(/(\d+)\s*(?:dollars?|bucks?)\s*(?:and\s*)?(\d{1,2})\s*cents?/gi, (_, d, c) => `$${d}.${c.padStart(2, '0')}`);
  t = t.replace(/\$\s*(\d[\d,]*(?:\.\d+)?)/g, (_, n) => '$' + n.replace(/,/g, ''));
  t = t.replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|bucks?)\b/gi, (_, n) => '$' + n.replace(/,/g, ''));
  t = t.replace(/(\d),(\d{3})\b/g, '$1$2');
  return t.replace(/\s+/g, ' ').trim();
}

const titleCase = s => s.replace(/\b[a-z]/g, c => c.toUpperCase());
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findCustomer(text, customers) {
  const lower = text.toLowerCase();
  const byLen = [...customers].sort((a, b) => b.name.length - a.name.length);
  for (const c of byLen) {
    if (c.name && new RegExp(`\\b${reEsc(c.name.toLowerCase())}\\b`).test(lower)) return { c, match: c.name };
  }
  // First name only, if just one customer has it
  const firsts = {};
  for (const c of customers) {
    const f = (c.name || '').split(' ')[0].toLowerCase();
    if (f.length > 2) (firsts[f] ||= []).push(c);
  }
  for (const [f, list] of Object.entries(firsts)) {
    if (list.length === 1 && new RegExp(`\\b${reEsc(f)}\\b`).test(lower)) return { c: list[0], match: f };
  }
  return null;
}

function matchItem(desc, items) {
  const d = desc.toLowerCase();
  let best = null;
  for (const it of items) {
    const n = it.name.toLowerCase();
    if (d === n || d.includes(n) || (n.includes(d) && d.length > 3)) {
      if (!best || it.name.length > best.name.length) best = it;
    }
  }
  return best;
}

function parseLine(seg, items) {
  let s = ' ' + seg.replace(/^\s*(and|also|plus|then)\s+/i, '') + ' ';
  let qty = null, price = null, unit = false, type = null;

  // hours: "3 hours of labor at 75"
  const hrs = s.match(/\s(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b(?:\s+of)?/i);
  if (hrs) { qty = +hrs[1]; type = 'labor'; s = s.replace(hrs[0], ' '); }

  // price: "$40 each", "at 40", "for 80", "$250"
  let pm = s.match(/\s(?:at|@)\s*\$?(\d+(?:\.\d+)?)(\s*(?:each|apiece|a piece|per \w+|an hour|a hour|an? \w+))?/i);
  if (pm) { price = +pm[1]; unit = true; }
  else if ((pm = s.match(/\$(\d+(?:\.\d+)?)(\s*(?:each|apiece|a piece|per \w+|an hour|a hour))?/i))) { price = +pm[1]; unit = !!pm[2]; }
  else if ((pm = s.match(/\sfor\s*(\d+(?:\.\d+)?)\b/i))) { price = +pm[1]; }
  else if ((pm = s.match(/\s(\d+(?:\.\d+)?)(\s*(?:each|apiece))?\s*$/i)) && (qty !== null || /\D/.test(s.replace(pm[0], '').trim()))) { price = +pm[1]; unit = !!pm[2]; }
  if (pm) s = s.replace(pm[0], ' ');
  if (/\b(each|apiece|per)\b/i.test(s)) { unit = true; s = s.replace(/\b(each|apiece)\b/gi, ' '); }

  // quantity: "2 elements", "elements x 2", "2 of"
  if (qty === null) {
    const q = s.match(/^\s*(\d+(?:\.\d+)?)\s+(?:of\s+)?(?=[a-z])/i) || s.match(/\s(?:x|times)\s*(\d+(?:\.\d+)?)\b/i) || s.match(/\s(\d+(?:\.\d+)?)\s*(?:x|times)\b/i);
    if (q) { qty = +q[1]; s = s.replace(q[0], ' '); }
  }
  if (qty === null) qty = 1;

  let desc = s.replace(/\b(a|an|the|for|at|of|with|is|was|charge|charged|add|plus)\s*$/i, '')
    .replace(/^\s*(a|an|the|for|and)\b/i, '')
    .replace(/\s+/g, ' ').trim();
  desc = desc.replace(/\b(for|at|of)\s*$/i, '').trim();
  if (!desc && price === null) return null;

  const saved = desc ? matchItem(desc, items) : null;
  if (saved) {
    if (price === null) { price = saved.price; unit = true; }
    if (desc.toLowerCase() === saved.name.toLowerCase()) desc = saved.name;
    type ||= saved.type;
  }
  if (price === null) return null;
  if (!desc) desc = 'Service';
  if (!unit && qty > 1) price = Math.round((price / qty) * 100) / 100;
  if (!type) type = MATERIAL_WORDS.test(desc) && !LABOR_WORDS.test(desc) ? 'material' : 'labor';
  if (/\b(labor)\b/i.test(desc)) type = 'labor';
  return { desc: desc[0].toUpperCase() + desc.slice(1), qty, price, type };
}

export function parseVoice(text, customers = [], items = []) {
  const result = { customerId: null, newCustomer: null, kind: null, lines: [], skipped: [] };
  let t = normalize(text);
  if (!t) return result;

  if (/^\W*(new\s+)?(invoice|bill)\b/i.test(t)) result.kind = 'invoice';
  else if (/^\W*(new\s+)?(quote|estimate)\b/i.test(t)) result.kind = 'quote';
  t = t.replace(/^\W*(new\s+)?(invoice|bill|quote|estimate)\b\s*(for|to)?\s*/i, '');

  const found = findCustomer(t, customers);
  if (found) {
    result.customerId = found.c.id;
    t = t.replace(new RegExp(`\\b(for|to|bill)?\\s*${reEsc(found.match)}\\b[,:]?`, 'i'), ' ').trim();
  }

  let segs = t.split(/[;\n]+|,|\.(?=\s|$)|\b(?:and then|then|plus|also|next)\b/i).map(x => x.trim()).filter(Boolean);
  // split on "and" when each side has a number or is a saved item ("service call and 2 elements")
  const known = p => /\d/.test(p) || !!matchItem(p.replace(/^\s*(a|an|the)\s+/i, '').trim(), items);
  segs = segs.flatMap(sg => {
    const parts = sg.split(/\band\b/i).map(p => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every(known)) return parts;
    return [sg];
  });
  // a price said on its own belongs to the job before it ("water heater flush, 250 dollars")
  segs = segs.reduce((acc, sg) => {
    const prev = acc[acc.length - 1];
    if (prev !== undefined && /^\$?\d+(?:\.\d+)?(\s*(each|apiece))?$/i.test(sg) && !/\d/.test(prev) &&
        (acc.length > 1 || result.customerId || LABOR_WORDS.test(prev) || MATERIAL_WORDS.test(prev) || matchItem(prev, items))) {
      acc[acc.length - 1] = `${prev} ${sg.startsWith('$') ? sg : '$' + sg}`;
    } else acc.push(sg);
    return acc;
  }, []);

  segs.forEach((sg, i) => {
    const line = parseLine(sg, items);
    if (line) { result.lines.push(line); return; }
    // First piece with no price and few words = a new customer's name
    const name = sg.replace(/^(for|to|bill|customer|customer is|name is)\s+/i, '').trim();
    if (i === 0 && !result.customerId && !/\d/.test(name) && name.split(' ').length <= 4 && name.length > 1) {
      result.newCustomer = titleCase(name.toLowerCase());
    } else result.skipped.push(sg);
  });
  return result;
}

// ---------- Microphone (browser speech, if available) ----------
const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
export const canListen = !!SR;
let active = null;

export function toggleListen(textarea, onState, onError) {
  if (active) { active.stop(); return; }
  const r = new SR();
  r.lang = 'en-US';
  r.interimResults = true;
  r.continuous = true;
  const base = textarea.value.trim() ? textarea.value.trim() + ', ' : '';
  r.onresult = e => { textarea.value = base + [...e.results].map(x => x[0].transcript).join(' ').trim(); };
  r.onerror = e => onError(e.error);
  r.onend = () => { active = null; onState(false); };
  try { r.start(); active = r; onState(true); } catch { onError('start'); }
}
