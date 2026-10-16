/* Top-list sources. Every fetcher returns [{t: title, y: year?, a: [alt titles]?, n: note?, w: en.wikipedia title?}]
   in rank order. All of these endpoints send CORS headers, so they work from a page opened straight from disk. */
const Sources = (() => {
  const WD = 'https://query.wikidata.org/sparql';
  const WP = 'https://en.wikipedia.org/w/api.php';
  const PV = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/';

  async function sparql(q) {
    const r = await fetch(WD + '?format=json&query=' + encodeURIComponent(q), { headers: { Accept: 'application/sparql-results+json' } });
    if (!r.ok) throw new Error('Wikidata returned HTTP ' + r.status);
    return (await r.json()).results.bindings;
  }
  const platformClause = sys => `VALUES ?ptitle { ${(sys.wiki || []).map(t => JSON.stringify(t) + '@en').join(' ')} }
      ?pa schema:about ?platform ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?ptitle .`;

  /* Ranked games on the platform, with English label, enwiki title, year and alternative titles.
     `inner` selects ?game ?links (and may restrict the set); results keep its order. */
  async function rankedGames(sys, inner) {
    const q = `SELECT ?game ?links ?label ?mul ?title (MIN(YEAR(?date)) AS ?year) (GROUP_CONCAT(DISTINCT ?alt; separator="|") AS ?alts) WHERE {
  { ${inner} }
  OPTIONAL { ?game rdfs:label ?label FILTER(LANG(?label) = "en") }
  OPTIONAL { ?game rdfs:label ?mul FILTER(LANG(?mul) = "mul") }
  OPTIONAL { ?ea schema:about ?game ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title }
  OPTIONAL { ?game wdt:P577 ?date }
  OPTIONAL { ?game skos:altLabel ?alt FILTER(LANG(?alt) = "en") }
} GROUP BY ?game ?links ?label ?mul ?title ORDER BY DESC(?links)`;
    const nm = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const seen = new Set(), out = [];
    for (const b of await sparql(q)) {
      const id = b.game.value; if (seen.has(id)) continue; seen.add(id);
      const w = b.title && b.title.value;
      const wikiTitle = w && w.replace(/ \((?:[^)]*video game|[^)]*game)\)$/i, '');
      const t = (b.label && b.label.value) || (b.mul && b.mul.value) || wikiTitle;
      if (!t || /^Q\d+$/.test(t)) continue;
      const keys = new Set([nm(t)]), a = [];
      for (const x of [wikiTitle, ...((b.alts && b.alts.value) ? b.alts.value.split('|') : [])]) {
        if (!x || x.length > 60 || keys.has(nm(x))) continue; keys.add(nm(x)); a.push(x); if (a.length >= 3) break;
      }
      const e = { t, n: b.links.value + ' wikis', q: id.split('/').pop() };
      if (w) e.w = w;
      if (b.year) e.y = +b.year.value;
      if (a.length) e.a = a;
      out.push(e);
    }
    return out;
  }

  /* Ranked by number of Wikipedia language editions with an article (sitelinks): an open popularity proxy. */
  async function wikidata(sys, limit = 500) {
    if (!(sys.wiki || []).length) return [];
    return rankedGames(sys, `SELECT DISTINCT ?game ?links WHERE { ${platformClause(sys)}
      ?game wdt:P400 ?platform ; wdt:P31 wd:Q7889 ; wikibase:sitelinks ?links . } ORDER BY DESC(?links) LIMIT ${limit | 0}`);
  }

  /* Same ranking, limited to games whose only listed platform is this one (checked among the 2,000 best known),
     so multi-platform hits don't crowd the list. */
  async function exclusives(sys, limit = 500) {
    if (!(sys.wiki || []).length) return [];
    const rows = await sparql(`SELECT ?game ?links WHERE { { SELECT ?game ?links WHERE { ${platformClause(sys)}
        ?game wdt:P400 ?platform ; wdt:P31 wd:Q7889 ; wikibase:sitelinks ?links . } ORDER BY DESC(?links) LIMIT 2000 }
      ?game wdt:P400 ?any . } GROUP BY ?game ?links HAVING(COUNT(DISTINCT ?any) = 1) ORDER BY DESC(?links) LIMIT ${limit | 0}`);
    const order = rows.map(b => b.game.value.split('/').pop());
    const info = await namesFor(sys, order);
    return order.filter(q => info.has(q)).map(q => info.get(q));
  }
  async function namesFor(sys, qids) {
    const info = new Map();
    for (let i = 0; i < qids.length; i += 150) {
      const ids = qids.slice(i, i + 150).map(q => 'wd:' + q).join(' ');
      for (const e of await rankedGames(sys, `SELECT ?game ?links WHERE { VALUES ?game { ${ids} } ?game wikibase:sitelinks ?links . }`)) info.set(e.q, e);
    }
    return info;
  }

  /* Review scores recorded on Wikidata for this platform (Metacritic, GameRankings, magazines), turned into 0-100, averaged per game and
     ranked with a Bayesian average so a single 100% review doesn't beat a game reviewed well five times. */
  function scoreTo100(s) {
    s = String(s).trim().replace(',', '.'); let m;
    if ((m = s.match(/^([\d.]+)\s*\/\s*([\d.]+)$/))) return +m[2] ? 100 * m[1] / m[2] : null;
    if ((m = s.match(/^([\d.]+)\s*%$/))) return +m[1];
    if ((m = s.match(/^([★☆✭]+)$/))) return null; // star ratings have no stated scale
    return null;
  }
  async function reviews(sys, limit = 500) {
    if (!(sys.wiki || []).length) return [];
    // Only scores qualified with this platform: Wikidata keeps one item per game across all its versions.
    const rows = await sparql(`SELECT ?game ?score WHERE { ${platformClause(sys)}
      ?game wdt:P400 ?platform ; wdt:P31 wd:Q7889 ; p:P444 ?st . ?st ps:P444 ?score ; pq:P400 ?platform . }`);
    const per = new Map();
    for (const b of rows) { const v = scoreTo100(b.score.value); if (v == null || v > 100 || v < 0) continue; const k = b.game.value.split('/').pop(); (per.get(k) || per.set(k, []).get(k)).push(v); }
    if (!per.size) return [];
    const all = [...per.values()].flat(), C = all.reduce((a, b) => a + b, 0) / all.length, M = 2;
    const ranked = [...per.entries()].map(([q, s]) => ({ q, n: s.length, avg: s.reduce((a, b) => a + b, 0) / s.length }))
      .map(x => ({ ...x, score: (x.n * x.avg + M * C) / (x.n + M) })).sort((a, b) => b.score - a.score).slice(0, limit);
    const info = await namesFor(sys, ranked.map(x => x.q));
    return ranked.filter(x => info.has(x.q)).map(x => ({ ...info.get(x.q), n: `${Math.round(x.avg)}/100 from ${x.n} review${x.n > 1 ? 's' : ''}` }));
  }

  /* Ranked by English Wikipedia page views over the last 12 full months: what people read about now.
     Candidates are the Wikidata list for the platform (games with an English article). */
  async function pageviews(sys, limit = 500, base = null, onProgress = null) {
    // Bundled lists omit the article title when it equals the game title; a title with no article just gets no views.
    const cand = (base || await wikidata(sys, 500)).map(e => ({ ...e, w: e.w || e.t }));
    if (!cand.length) return [];
    const now = new Date(), end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth() + 1, 1));
    const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const range = `/monthly/${ymd(start)}/${ymd(end)}`;
    const views = new Array(cand.length).fill(0); let next = 0, done = 0;
    async function worker() {
      while (next < cand.length) {
        const i = next++;
        try {
          const r = await fetch(PV + encodeURIComponent(cand[i].w.replace(/ /g, '_')) + range);
          if (r.ok) views[i] = (await r.json()).items.reduce((a, b) => a + b.views, 0);
        } catch { }
        done++; if (onProgress && done % 25 === 0) onProgress(done, cand.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    return cand.map((e, i) => ({ ...e, v: views[i] })).filter(e => e.v > 0).sort((a, b) => b.v - a.v).slice(0, limit)
      .map(({ v, w, q, ...e }) => ({ ...e, n: Math.round(v / 1000).toLocaleString('en-GB') + 'k views' }));
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

  return { wikidata, exclusives, reviews, pageviews, sales, critics, scoreTo100 };
})();
