/* Finds the ranked list of game titles on a web page. Shared by the app (fetched or saved pages) and by the
   list grabber that runs on the site itself. Order on the page is taken as the rank.
   1. Selected text wins: one title per line.
   2. Otherwise the largest group of links that share a URL pattern (game pages), outside menus and footers.
   3. Otherwise the longest numbered list (<ol>), table column or run of headings. */
function rlcExtractList(doc, selection) {
  const STATWORD = '(?:hits?|views?|downloads?|votes?|players?|points?|pts|reviews?|ratings?)';
  const clean = s => {
    s = String(s).replace(/\s+/g, ' ').trim()
      .replace(/^(?:#\s*\d{1,3}\s*[.):\-–]?\s*|(?:no\.?\s*)?\d{1,3}\s*[.)]\s+)/i, '');   // leading rank "12." "12)" "#12"; keeps "007:" and "3 Ninjas"
    for (let i = 0; i < 4; i++) {
      const before = s;
      s = s.replace(new RegExp('\\s*[·•|,(\\[–-]?\\s*\\d[\\d.,]*\\s*' + STATWORD + '[)\\]]?\\s*$', 'i'), '')  // "· 557 votes"
        .replace(/\s*[·•|(\[–-]?\s*\b\d{1,2}[.,]\d{1,2}\s*(?:\/\s*\d+)?[)\]]?\s*$/, '')            // "9.18" "(8.5/10)"
        .replace(/\s*[·•|–-]?\s*\d{1,3}\s*%\s*$/, '').replace(/\s*[★☆]+\s*$/, '')                // "87%" "★★★"
        .replace(/\s*\((?:19|20)\d\d\)\s*$/, '').replace(/\s*[·•|]\s*$/, '').trim();               // "(1987)"
      if (s === before) break;
    }
    return s;
  };
  const ok = t => t.length >= 2 && t.length <= 90 && (/[a-z]/i.test(t) || /^\d{3,4}$/.test(t)) && !/^(next|prev|previous|more|read more|see all|login|sign in|home|top|page \d+|\d{1,2})$/i.test(t);
  // A link often holds the rank, the title and a stat in separate elements ("1", "Out Run", "85 hits"):
  // keep the text pieces that aren't numbers or stats.
  const STAT = new RegExp('^[#(]?\\d[\\d.,]*\\)?\\s*(?:%|' + STATWORD.slice(3, -1) + '|\\/\\s*\\d+)?\\.?$', 'i');
  const linkTitle = el => {
    const parts = []; const w = doc.createTreeWalker(el, 4); let n;
    while ((n = w.nextNode())) { const t = n.nodeValue.replace(/\s+/g, ' ').trim(); if (t) parts.push(t); }
    const keep = parts.filter(t => !STAT.test(t) || /^\d{4}$/.test(t));   // "1942" is a title, ranks have up to 3 digits
    return (keep.length ? keep : parts).join(' ');
  };
  const uniq = arr => { const seen = new Set(), out = []; for (const t of arr.map(clean)) { const k = t.toLowerCase(); if (ok(t) && !seen.has(k)) { seen.add(k); out.push(t); } } return out; };
  if (selection) {
    const lines = uniq(String(selection).split(/\r?\n/));
    if (lines.length >= 3) return { items: lines, how: 'selected text' };
  }
  const skip = el => el.closest('nav, header, footer, aside, [role=navigation], .menu, .nav, .navbar, .sidebar, #sidebar, .breadcrumb, .pagination, .footer, .header');
  const base = doc.baseURI || (typeof location !== 'undefined' ? location.href : 'https://example.invalid/');
  const groups = new Map();
  for (const a of doc.querySelectorAll('a[href]')) {
    if (skip(a)) continue;
    const text = linkTitle(a); if (!ok(text)) continue;
    let u; try { u = new URL(a.getAttribute('href'), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    let wild = false;
    const path = u.pathname.split('/').map(seg => { if (wild || /\d/.test(seg)) { wild = true; return '*'; } return seg; }).join('/');
    const sig = u.host + path + '?' + [...u.searchParams.keys()].sort().join('&');
    (groups.get(sig) || groups.set(sig, []).get(sig)).push(text);
  }
  const cands = [];
  for (const [sig, texts] of groups) { const items = uniq(texts); if (items.length >= 5) cands.push({ items, how: 'links like ' + sig.replace(/\?$/, '') }); }
  for (const ol of doc.querySelectorAll('ol')) { if (skip(ol)) continue; const items = uniq([...ol.children].map(li => linkTitle(li.querySelector('a, b, strong') || li))); if (items.length >= 5) cands.push({ items, how: 'numbered list' }); }
  for (const table of doc.querySelectorAll('table')) {
    const rows = [...table.querySelectorAll('tr')]; if (rows.length < 5) continue;
    const cols = Math.max(...rows.map(r => r.cells.length));
    for (let c = 0; c < Math.min(cols, 4); c++) { const items = uniq(rows.map(r => r.cells[c] ? linkTitle(r.cells[c].querySelector('a') || r.cells[c]) : '')); if (items.length >= 5) cands.push({ items, how: 'table column ' + (c + 1) }); }
  }
  for (const tag of ['h2', 'h3']) { const hs = [...doc.querySelectorAll(tag)].filter(h => !skip(h)); const items = uniq(hs.map(h => h.textContent)); if (items.length >= 5) cands.push({ items, how: tag + ' headings' }); }
  if (!cands.length) return { items: [], how: 'nothing found' };
  cands.sort((a, b) => b.items.length - a.items.length);
  return cands[0];
}
