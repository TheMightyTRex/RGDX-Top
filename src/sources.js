/* Top-list sources. Every fetcher returns [{t: title, y: year?, a: [alt titles]?, n: note?}] in rank order.
   All of these endpoints send CORS headers, so they work from a page opened straight from disk. */
const Sources = (() => {
  const WD = 'https://query.wikidata.org/sparql';
  const WP = 'https://en.wikipedia.org/w/api.php';

  async function sparql(q) {
    const r = await fetch(WD + '?format=json&query=' + encodeURIComponent(q), { headers: { Accept: 'application/sparql-results+json' } });
    if (!r.ok) throw new Error('Wikidata returned HTTP ' + r.status);
    return (await r.json()).results.bindings;
  }

  /* Ranked by number of Wikipedia language editions with an article (sitelinks): an open popularity proxy. */
  async function wikidata(sys, limit = 500) {
    const titles = (sys.wiki || []).map(t => JSON.stringify(t) + '@en').join(' ');
    if (!titles) return [];
    const q = `SELECT ?game ?links ?label ?mul ?title (MIN(YEAR(?date)) AS ?year) (GROUP_CONCAT(DISTINCT ?alt; separator="|") AS ?alts) WHERE {
  { SELECT DISTINCT ?game ?links WHERE {
      VALUES ?ptitle { ${titles} }
      ?pa schema:about ?platform ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?ptitle .
      ?game wdt:P400 ?platform ; wdt:P31 wd:Q7889 ; wikibase:sitelinks ?links .
    } ORDER BY DESC(?links) LIMIT ${limit | 0} }
  OPTIONAL { ?game rdfs:label ?label FILTER(LANG(?label) = "en") }
  OPTIONAL { ?game rdfs:label ?mul FILTER(LANG(?mul) = "mul") }
  OPTIONAL { ?ea schema:about ?game ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title }
  OPTIONAL { ?game wdt:P577 ?date }
  OPTIONAL { ?game skos:altLabel ?alt FILTER(LANG(?alt) = "en") }
} GROUP BY ?game ?links ?label ?mul ?title ORDER BY DESC(?links)`;
    const rows = await sparql(q);
    const seen = new Set(), out = [];
    for (const b of rows) {
      const id = b.game.value; if (seen.has(id)) continue; seen.add(id);
      const wikiTitle = b.title && b.title.value.replace(/ \((?:[^)]*video game|[^)]*game)\)$/i, '');
      const t = (b.label && b.label.value) || (b.mul && b.mul.value) || wikiTitle;
      if (!t || /^Q\d+$/.test(t)) continue;
      const a = [];
      if (wikiTitle && wikiTitle !== t) a.push(wikiTitle);
      if (b.alts && b.alts.value) a.push(...b.alts.value.split('|').slice(0, 6));
      const e = { t, n: b.links.value + ' wikis' };
      if (b.year) e.y = +b.year.value;
      if (a.length) e.a = a;
      out.push(e);
    }
    return out;
  }

  async function wikiTables(page) {
    const url = WP + '?action=parse&prop=text&redirects=1&format=json&formatversion=2&origin=*&page=' + encodeURIComponent(page);
    const j = await (await fetch(url)).json();
    if (!j.parse) throw new Error('Wikipedia page not found: ' + page);
    const d = new DOMParser().parseFromString(j.parse.text, 'text/html');
    d.querySelectorAll('style, sup.reference').forEach(e => e.remove());
    const rows = [];
    for (const table of d.querySelectorAll('table.wikitable')) {
      for (const tr of table.querySelectorAll('tr')) {
        const i = tr.querySelector('td i, th[scope=row] i');
        if (!i) continue;
        const t = i.textContent.replace(/\s+/g, ' ').trim();
        if (t) rows.push({ t, text: tr.textContent.replace(/\s+/g, ' ').trim() });
      }
    }
    return rows;
  }

  function dedupe(rows) {
    const seen = new Set();
    return rows.filter(r => { const k = r.t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  /* Wikipedia "List of best-selling <platform> video games": ranked by copies sold. */
  async function sales(sys) {
    if (!sys.sales) return [];
    const rows = dedupe(await wikiTables(sys.sales));
    return rows.map(r => {
      const m = r.text.match(/([\d.,]+)\s*(million|,000\b)/i);
      return m ? { t: r.t, n: m[0] } : { t: r.t };
    });
  }

  /* Wikipedia "List of video games listed among the best": critics' lists, filtered to this platform. */
  let bestCache = null;
  async function critics(sys) {
    if (!sys.best) return [];
    if (!bestCache) bestCache = wikiTables('List of video games listed among the best');
    const rx = new RegExp(sys.best);
    const rows = (await bestCache).filter(r => rx.test(r.text.replace(r.t, '')));
    return dedupe(rows).map(r => { const y = r.text.match(/\b(19[5-9]\d|20[0-4]\d)\b/); return y ? { t: r.t, y: +y[1] } : { t: r.t }; });
  }

  return { wikidata, sales, critics };
})();
