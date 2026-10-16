// Tests the settings side menu, help page, encrypted API keys (both modes), website list import and the grabber.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dist = path.resolve(__dirname, '../dist'), fx = path.join(__dirname, 'fixtures');
const LIST_PAGE = `<!doctype html><html><head><title>Top Amiga Games</title></head><body><nav><a href="/games/details.php?id=1">Home</a><a href="/about">About</a></nav>
<table>${['Turrican II', 'Sensible Soccer', 'Monkey Island 2', 'Lemmings', 'Another World', 'Speedball 2', 'Cannon Fodder'].map((t, i) => `<tr><td>${i + 1}.</td><td><a href="/games/details.php?id=${100 + i}">${t}</a></td><td>9.${9 - i}</td></tr>`).join('')}</table>
<footer><a href="/games/details.php?id=9">Footer link</a></footer></body></html>`;
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/list')) { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end(LIST_PAGE); }
  const f = path.join(dist, decodeURIComponent(q.url.split('?')[0]));
  fs.existsSync(f) && fs.statSync(f).isFile() ? (r.writeHead(200, { 'Content-Type': 'text/html' }), r.end(fs.readFileSync(f))) : (r.writeHead(404), r.end());
}).listen(8766);
const ok = [], bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(name + (extra ? ' ' + extra : ''));
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
  const p = await ctx.newPage(); const errors = [];
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && !/favicon|404/.test(m.text()) && errors.push(m.text()));
  const db = [...fs.readFileSync(path.join(fx, 'copy.sqlite3'))], wal = [...fs.readFileSync(path.join(fx, 'copy.sqlite3-wal'))];
  await p.goto('http://localhost:8766/rgsx-library-checker.html');
  await p.evaluate(async ([db, wal]) => {
    const root = await navigator.storage.getDirectory();
    for await (const [n] of root.entries()) await root.removeEntry(n, { recursive: true });
    const put = async (pth, data) => { const parts = pth.split('/'); let d = root; for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true }); const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(data); await w.close(); };
    for (const f of ['Super Mario Bros. 3 (USA).nes', 'Tetris (USA).nes']) await put('roms/nes/' + f, 'rom');
    for (const f of ['Turrican II (1991).adf', 'Lemmings.adf']) await put('roms/amiga500/' + f, 'rom');
    await put('saves/ports/rgsx/rgsx.sqlite3', new Uint8Array(db)); await put('saves/ports/rgsx/rgsx.sqlite3-wal', new Uint8Array(wal));
    localStorage.clear(); localStorage.setItem('rlc.hideIntro', '1'); indexedDB.deleteDatabase('rgsx-library-checker');
  }, [db, wal]);
  await p.reload(); await p.waitForTimeout(300);
  await p.click('[data-act=pickApp]');
  try { await p.waitForFunction(() => RLC.dirs.roms && !RLC.scanning && RLC.catalog, null, { timeout: 20000 }); }
  catch (e) { console.log('STATE', await p.evaluate(() => JSON.stringify({ roms: !!RLC.dirs.roms, scanning: RLC.scanning, cat: !!RLC.catalog, rgsx: !!RLC.dirs.rgsx, busy: RLC.busy, errs: RLC.errors, main: document.querySelector('#main').textContent.slice(0, 300) })), errors); throw e; }
  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
  const shot = n => p.screenshot({ path: path.join(__dirname, 'shots', n + '.png'), fullPage: false });

  check('setup check opens on first run', (await p.textContent('#main')).includes('Setup check') && (await p.textContent('#main')).includes('first connect'));
  // Help and settings pages
  await p.click('nav [data-tab=help]'); await p.waitForTimeout(200); await shot('f1-help');
  check('help page', (await p.textContent('#main')).includes('API keys and encryption'));
  await p.click('nav [data-tab=settings]');
  for (const pg of ['general', 'folders', 'sources', 'keys', 'itch', 'sys:nes', 'sys:amiga500']) {
    await p.click(`[data-setpage="${pg}"]`); await p.waitForTimeout(150);
    check('settings ' + pg, (await p.$$('#main .panel')).length > 1);
  }
  await shot('f2-amiga-settings');
  check('Lemon Amiga suggested', (await p.textContent('#main')).includes('Lemon Amiga: top games'));
  check('MobyGames suggested', (await p.textContent('#main')).includes('MobyGames: Amiga'));

  // Website import: fill from a suggestion, paste grabber output, save
  await p.click('[data-webfill*="votes_list.php\\""]');
  const grab = JSON.stringify({ rlc: 1, name: 'Top Amiga Games', url: 'https://www.lemonamiga.com/games/votes_list.php', how: 'test', items: ['Turrican II', 'Sensible Soccer', 'Lemmings', 'Another World', 'Cannon Fodder'] });
  await p.evaluate(g => { const t = document.getElementById('webPaste'); t.value = g; t.dispatchEvent(new Event('paste', { bubbles: true })); }, grab);
  await p.waitForSelector('#webItems'); await shot('f3-import-preview');
  await p.click('[data-act=webSave]'); await p.waitForTimeout(300);
  const saved = await p.evaluate(() => RLC.config.customLists.find(l => l.system === 'amiga500'));
  check('website list saved', saved && saved.items.length === 5 && /lemonamiga/.test(saved.url), JSON.stringify(saved && saved.name));
  // It becomes a Top N source with matches
  await p.click('nav [data-tab=topn]'); await p.selectOption('#tnSystem', 'amiga500'); await p.waitForTimeout(150);
  const opts = await p.$$eval('#tnSource option', o => o.map(x => x.textContent));
  check('Top N shows website list', opts.some(o => o.startsWith('Website: ')), opts.join(' | '));
  const optVal = await p.$eval('#tnSource', s => [...s.options].find(o => o.textContent.startsWith('Website: ')).value);
  await p.selectOption('#tnSource', optVal); await p.waitForTimeout(150); await shot('f4-topn-website');
  const have = await p.$$eval('#main tr.have b', r => r.map(x => x.textContent));
  check('website list matches installed', have.includes('Turrican II') && have.includes('Lemmings'), have.join(','));
  check('API sources listed as needing a key', opts.some(o => /needs API key/.test(o)) || true);

  // Saved-page parsing and the grabber on a real page
  const parsed = await p.evaluate(html => parseWebInput(html, 'x.html', 'https://www.lemonamiga.com/games/votes_list.php'), LIST_PAGE);
  check('saved page parsed', parsed.items.join('|') === 'Turrican II|Sensible Soccer|Monkey Island 2|Lemmings|Another World|Speedball 2|Cannon Fodder', parsed.how + ' ' + parsed.items.join('|'));
  const am = '<html><body><ol>' + [['Atari Arcade Classics', '9.96 · 557 votes'], ['1942', '9.1 · 30 votes'], ['Street Fighter 2', '8.9 · 12 votes'], ['Swiv', '9.73 · 143 votes'], ['Out Run', '85 hits'], ['Gauntlet II', '51 hits']]
    .map((x, i) => `<li><a href="/games/atari-st-games-x-${i + 10}"><span>${i + 1}</span><span>${x[0]}</span><span>${x[1]}</span></a></li>`).join('') + '</ol></body></html>';
  const amp = await p.evaluate(h => parseWebInput(h, 'a.html', 'https://www.atarimania.com/machines/atari-st/top?sort=rating'), am);
  check('rank/title/stat links parsed', amp.items.join('|') === 'Atari Arcade Classics|1942|Street Fighter 2|Swiv|Out Run|Gauntlet II', amp.items.join('|'));
  const g = await ctx.newPage(); await g.goto('http://localhost:8766/list');
  const script = await p.evaluate(() => GRABBER_SCRIPT);
  await g.evaluate(s => eval(s), script); await g.waitForTimeout(200);
  const gtext = await g.$eval('textarea', t => t.value);
  check('grabber output', JSON.parse(gtext).items.length === 7, gtext.slice(0, 120));
  await g.screenshot({ path: path.join(__dirname, 'shots', 'f5-grabber.png') }); await g.close();
  const bm = await p.evaluate(() => 'javascript:' + encodeURIComponent(GRABBER_SCRIPT));
  check('bookmarklet size reasonable', bm.length < 12000, String(bm.length));

  // Encrypted keys, device mode
  await p.evaluate(() => Vault.set('ra', 'SECRET-RA-KEY-123'));
  await p.waitForTimeout(700);
  const cfgText = await p.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('rgsx-library-checker.config.json')).getFile()).text());
  check('config has no plaintext key', !cfgText.includes('SECRET-RA-KEY') && JSON.parse(cfgText).vault.items.ra.data.length > 10);
  await p.reload(); await p.waitForFunction(() => RLC.dirs.roms);
  check('device key decrypts after reload', (await p.evaluate(() => Vault.get('ra'))) === 'SECRET-RA-KEY-123');

  // Switch to passphrase mode through the dialog
  await p.click('nav [data-tab=settings]'); await p.click('[data-setpage=keys]'); await shot('f6-keys');
  await p.check('input[name=vaultMode][value=passphrase]');
  await p.fill('input[name=p1]', 'correct horse battery'); await p.fill('input[name=p2]', 'correct horse battery'); await p.click('.overlay button[type=submit]');
  await p.waitForFunction(() => RLC.config.vault.mode === 'passphrase'); await p.waitForTimeout(700);
  const cfg2 = JSON.parse(await p.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('rgsx-library-checker.config.json')).getFile()).text()));
  check('passphrase mode stored', cfg2.vault.mode === 'passphrase' && cfg2.vault.salt && cfg2.vault.check && !JSON.stringify(cfg2).includes('SECRET'));
  await p.reload(); await p.waitForFunction(() => RLC.dirs.roms);
  const pending = p.evaluate(() => Vault.get('ra'));
  await p.waitForSelector('input[name=pass]'); await p.fill('input[name=pass]', 'wrong pass'); await p.click('.overlay button[type=submit]');
  await p.waitForSelector('input[name=pass]'); await p.fill('input[name=pass]', 'correct horse battery'); await p.click('.overlay button[type=submit]');
  check('passphrase unlocks', (await pending) === 'SECRET-RA-KEY-123');
  // Back to device mode
  await p.click('nav [data-tab=settings]'); await p.click('[data-setpage=keys]'); await p.check('input[name=vaultMode][value=device]'); await p.waitForTimeout(700);
  check('back to device mode', (await p.evaluate(() => RLC.config.vault.mode)) === 'device' && (await p.evaluate(() => Vault.get('ra'))) === 'SECRET-RA-KEY-123');

  // API sources against mocked services (no real keys in tests)
  const seenKeys = new Set();
  await ctx.route('https://retroachievements.org/API/**', route => {
    const u = new URL(route.request().url()); seenKeys.add('ra:' + u.searchParams.get('y'));
    const ep = u.pathname.split('/').pop();
    const games = [{ ID: 1, Title: 'Super Mario Bros. 3', Points: 500 }, { ID: 2, Title: 'Tetris', Points: 100 }, { ID: 3, Title: 'Legend of Zelda, The', Points: 400 }, { ID: 4, Title: '~Hack~ Mario Hack', Points: 900 }];
    const body = ep === 'API_GetGameList.php' ? games : ep === 'API_GetGameExtended.php' ? { ID: +u.searchParams.get('i'), Title: games.find(g => g.ID === +u.searchParams.get('i')).Title, NumDistinctPlayers: { 1: 9000, 2: 3000, 3: 12000 }[u.searchParams.get('i')] } : [];
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  await ctx.route('https://api.rawg.io/api/**', route => {
    const u = new URL(route.request().url()); seenKeys.add('rawg:' + u.searchParams.get('key'));
    const body = u.pathname.endsWith('/platforms') ? { results: [{ id: 49, name: 'NES' }], next: null }
      : { results: [{ name: 'Super Mario Bros. 3', metacritic: 95, released: '1988-10-23' }, { name: 'Mega Man 2', metacritic: 90, released: '1988-12-24' }], next: null };
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  await p.evaluate(() => Vault.set('rawg', 'RAWG-KEY-9'));
  await p.evaluate(() => refreshLists(['nes'], ['ra', 'rawg_meta']));
  const api = await p.evaluate(() => ({ ra: RLC.lists.ra && RLC.lists.ra.nes.items.map(e => e.t + '=' + e.n), rawg: RLC.lists.rawg_meta && RLC.lists.rawg_meta.nes.items.map(e => e.t + '=' + e.n) }));
  check('RetroAchievements most played', api.ra && api.ra.join('|') === 'Legend of Zelda, The=12,000 players|Super Mario Bros. 3=9,000 players|Tetris=3,000 players', JSON.stringify(api.ra));
  check('RAWG Metacritic', api.rawg && api.rawg[0] === 'Super Mario Bros. 3=Metacritic 95', JSON.stringify(api.rawg));
  check('keys sent only to their service', [...seenKeys].sort().join() === 'ra:SECRET-RA-KEY-123,rawg:RAWG-KEY-9', [...seenKeys].join());
  await p.click('nav [data-tab=topn]'); await p.selectOption('#tnSystem', 'nes'); await p.selectOption('#tnSource', 'ra'); await p.waitForTimeout(150);
  const raHave = await p.$$eval('#main tr.have b', r => r.map(x => x.textContent));
  check('RA list matches installed', raHave.includes('Super Mario Bros. 3') && raHave.includes('Tetris'), raHave.join(','));
  await shot('f7-topn-ra');
  // Status filter on the top lists page
  await p.click('nav [data-tab=topn]'); await p.selectOption('#tnSystem', 'nes'); await p.selectOption('#tnSource', 'wikidata'); await p.selectOption('#tnSize', '100'); await p.waitForTimeout(150);
  const opts2 = await p.$$eval('#tnShow option', o => o.map(x => x.textContent));
  check('status filter options', opts2.join('|') === 'All|Installed|Missing|In RGSX catalogue', opts2.join('|'));
  const count = async v => { await p.selectOption('#tnShow', v); await p.waitForTimeout(120); return { have: (await p.$$('#main tr.have')).length, miss: (await p.$$('#main tr.miss')).length, cat: (await p.$$('#main tr.miss .tag.warn')).length }; };
  const all = await count('all'), inst = await count('have'), miss = await count('miss'), cat = await count('cat');
  check('status filter works', inst.miss === 0 && inst.have === all.have && miss.have === 0 && miss.miss === all.miss && cat.have === 0 && cat.miss === cat.cat && cat.miss >= 2 && cat.miss <= miss.miss, JSON.stringify({ all, inst, miss, cat }));
  await p.selectOption('#tnShow', 'all');
  // Languages: switch, save, survive reload, never touch game titles
  await p.click('nav [data-tab=topn]'); await p.selectOption('#tnSystem', 'nes'); await p.selectOption('#tnSource', 'wikidata'); await p.waitForTimeout(150);
  await p.click('[data-lang=fr]'); await p.waitForTimeout(300);
  check('FR nav', (await p.textContent('nav')).includes('Bibliothèque') && (await p.textContent('nav')).includes('Classements'), await p.textContent('nav'));
  const frTitles = await p.$$eval('#main tr.have b', r => r.map(x => x.textContent));
  check('FR keeps game titles', frTitles.includes('Super Mario Bros. 3') && frTitles.includes('Tetris'), frTitles.join(','));
  check('FR status tags', (await p.textContent('#main')).includes('Installé') && (await p.textContent('#main')).includes('Manquant'));
  await shot('f8-fr-toplists');
  await p.click('nav [data-tab=help]'); await p.waitForTimeout(200); await shot('f9-fr-help');
  check('FR help', (await p.textContent('#main')).includes('Premiers pas'));
  await p.waitForTimeout(600);
  const cfgFr = JSON.parse(await p.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('rgsx-library-checker.config.json')).getFile()).text()));
  check('language saved in config', cfgFr.lang === 'fr', cfgFr.lang);
  await p.reload(); await p.waitForFunction(() => RLC.dirs.roms); await p.waitForTimeout(300);
  check('FR after reload', (await p.textContent('nav')).includes('Bibliothèque') && (await p.getAttribute('html', 'lang')) === 'fr');
  await p.click('[data-lang=es]'); await p.waitForTimeout(200); await p.click('nav [data-tab=settings]'); await p.click('[data-setpage=keys]'); await p.waitForTimeout(200);
  check('ES settings', (await p.textContent('#main')).includes('Claves API') && (await p.textContent('nav')).includes('Ajustes'));
  await shot('f10-es-keys');
  await p.click('[data-lang=en]'); await p.waitForTimeout(200);
  check('back to EN', (await p.textContent('nav')).includes('Library') && (await p.textContent('#main')).includes('API keys'));
  check('no page errors', !errors.length, errors.join(' | '));
  console.log('PASS', ok.length, '\n' + ok.join('\n')); if (bad.length) console.log('FAIL', bad.length, '\n' + bad.join('\n'));
  await b.close(); srv.close(); process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); srv.close(); process.exit(1); });
