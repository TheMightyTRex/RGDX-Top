// Collects every translatable UI string (as the i18n engine sees them) by visiting all views and states.
// Output: test/out/strings.json. Used to build data/i18n-*.json.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dist = path.resolve(__dirname, '../dist'), fx = path.join(__dirname, 'fixtures');
const srv = http.createServer((q, r) => { const f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); fs.existsSync(f) && fs.statSync(f).isFile() ? (r.writeHead(200, { 'Content-Type': 'text/html' }), r.end(fs.readFileSync(f))) : (r.writeHead(404), r.end()); }).listen(8767);
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
  const p = await ctx.newPage();
  const db = [...fs.readFileSync(path.join(fx, 'copy.sqlite3'))], wal = [...fs.readFileSync(path.join(fx, 'copy.sqlite3-wal'))];
  await p.goto('http://localhost:8767/rgsx-library-checker.html');
  await p.evaluate(async ([db, wal]) => {
    const root = await navigator.storage.getDirectory();
    for await (const [n] of root.entries()) await root.removeEntry(n, { recursive: true });
    const put = async (pth, data) => { const parts = pth.split('/'); let d = root; for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true }); const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(data); await w.close(); };
    for (const f of ['Super Mario Bros. 3 (USA).nes', 'Tetris (USA).nes']) await put('roms/nes/' + f, 'rom');
    await put('roms/amiga500/Lemmings.adf', 'rom'); await (await root.getDirectoryHandle('roms')).getDirectoryHandle('n64', { create: true });
    await put('saves/ports/rgsx/rgsx.sqlite3', new Uint8Array(db)); await put('saves/ports/rgsx/rgsx.sqlite3-wal', new Uint8Array(wal));
    localStorage.clear(); indexedDB.deleteDatabase('rgsx-library-checker');
  }, [db, wal]);
  await p.reload(); await p.waitForTimeout(400);
  await p.evaluate(() => {
    window.__H = new Set();
    window.__harvest = (root = document.body) => {
      const skip = el => el.closest('[translate="no"], script, style, code, pre, textarea, kbd');
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) { if (!n.parentElement || skip(n.parentElement)) continue; const t = (n.__en ?? n.nodeValue).trim(); if (t && /[a-z]/i.test(t)) __H.add(i18nKey(t).key); }
      for (const el of root.querySelectorAll('[placeholder],[title],[aria-label]')) { if (skip(el)) continue; for (const a of ['placeholder', 'title', 'aria-label']) { const v = el.getAttribute(a); if (v && /[a-z]/i.test(v)) __H.add(i18nKey(v.trim()).key); } }
    };
    window.__html = h => { const d = document.createElement('div'); d.innerHTML = h; __harvest(d); };
  });
  const H = () => p.evaluate(() => __harvest());
  await H(); // intro + connect panel
  await p.evaluate(() => { __html(`<div>${['nes'].map(() => '').join('')}</div>`); RLC.needsReconnect = true; RLC.handles.app = { name: 'X' }; render(); __harvest(); RLC.needsReconnect = false; RLC.handles.app = null; render(); });
  await p.click('#intro [data-act=introPick]');
  await p.waitForFunction(() => RLC.dirs.roms && !RLC.scanning && RLC.catalog, null, { timeout: 20000 });
  await H(); await p.click('#intro [data-act=introClose]');
  await H(); await p.click('nav [data-tab=library]');
  for (const v of ['empty', 'roms', 'all']) { await p.selectOption('#sysShow', v); await H(); }
  await p.click('[data-sel=nes]'); await H(); await p.click('[data-sel=n64]'); await H();
  await p.click('nav [data-tab=topn]'); await H();
  const srcs = await p.evaluate(() => Object.keys(SOURCE_INFO));
  for (const sys of ['*', 'nes', 'amiga500']) {
    await p.selectOption('#tnSystem', sys); await H();
    for (const s of srcs) { await p.evaluate(s => { RLC.config.topN.source = s; render(); }, s); await H(); }
    if (sys !== '*') for (const sh of ['miss', 'have']) { await p.selectOption('#tnShow', sh); await H(); }
  }
  await p.click('nav [data-tab=free]'); await H(); await p.check('input[name=fmode][value=pc]'); await H();
  await p.check('input[name=fmode][value=retro]');
  await p.evaluate(() => { const d = itchData(); for (const k of Object.keys(d.sys)) { RLC.config.free.system = k; render(); __harvest(); } });
  await p.click('nav [data-tab=help]'); await H();
  await p.click('nav [data-tab=settings]');
  for (const pg of ['general', 'check', 'folders', 'sources', 'keys', 'itch', 'sys:nes', 'sys:amiga500', 'sys:c64', 'sys:atarist', 'sys:zxspectrum', 'sys:msx1', 'sys:snes', 'sys:psx']) { await p.evaluate(pg => { RLC.setPage = pg; render(); }, pg); await H(); }
  await p.evaluate(() => { RLC.showAllSys = true; render(); __harvest(); for (const k of Object.keys(SITE_LISTS)) if (!k.startsWith('*')) { RLC.setPage = 'sys:' + k; render(); __harvest(); } });
  await p.evaluate(() => { RLC.setPage = 'sys:nes'; RLC.webDraft = { sys: 'nes', name: 'x', url: 'https://example.com', items: ['a', 'b'], how: 'pasted text' }; render(); __harvest(); RLC.webDraft.id = 'z'; render(); __harvest(); });
  await p.evaluate(async () => { Vault.cfg().mode = 'passphrase'; RLC.setPage = 'keys'; render(); __harvest(); Vault.cfg().mode = 'device'; });
  // dialogs
  await p.evaluate(() => { dialog({ title: 'Unlock API keys', body: 'Enter the passphrase that protects your API keys.', fields: [{ id: 'pass', label: 'Passphrase', type: 'password' }], ok: 'Unlock' }); });
  await H(); await p.click('.overlay [data-x]');
  await p.evaluate(() => { dialog({ title: 'Protect API keys with a passphrase', body: 'Choose a passphrase. You will need it each time you open the page, and on any other computer that uses this config file. It can\'t be recovered if you forget it; you would just enter the API keys again.', fields: [{ id: 'p1', label: 'Passphrase', type: 'password' }, { id: 'p2', label: 'Repeat passphrase', type: 'password' }], ok: 'Use passphrase' }); });
  await H(); await p.click('.overlay [data-x]');
  // status chips
  await p.evaluate(() => { RLC.busy = 'x'; RLC.writable = false; renderStatus(); __harvest(document.querySelector('#status')); RLC.busy = ''; RLC.writable = true; const c = RLC.catalog; RLC.catalog = null; renderStatus(); __harvest(document.querySelector('#status')); RLC.catalog = c; renderStatus(); });
  await p.evaluate(() => { const keep = { ...ENV };
    for (const v of [{ ok: false, os: 'Windows', name: 'Firefox' }, { ok: false, os: 'macOS', name: 'Safari' }, { ok: false, os: 'Linux', name: 'Firefox' }, { ok: false, os: '', name: '' }, { ok: false, os: 'iOS', mobile: true }, { ok: false, os: 'macOS', brave: true }]) { Object.assign(ENV, { mobile: false, brave: false }, v); __html(browserWarning()); }
    Object.assign(ENV, keep); });
  await p.evaluate(() => { const keep = { ...RLC.install }, kc = RLC.catalog, kd = RLC.dirs.rgsx, kw = RLC.writable;
    for (const t of ['roms', 'batocera', 'unknown', '']) { RLC.install = { type: t, rgsxApp: false }; RLC.writable = false; RLC.samePlace = false; RLC.setPage = 'check'; render(); __harvest(); RLC.setPage = 'folders'; render(); __harvest(); }
    RLC.catalog = null; render(); __harvest(); RLC.dirs.rgsx = null; RLC.setPage = 'check'; render(); __harvest();
    RLC.tab = 'library'; render(); __harvest();
    RLC.install = keep; RLC.catalog = kc; RLC.dirs.rgsx = kd; RLC.writable = kw; RLC.samePlace = true; });
  const strings = await p.evaluate(() => [...__H].sort());
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'strings.json'), JSON.stringify(strings, null, 1));
  console.log('strings', strings.length);
  await b.close(); srv.close();
})().catch(e => { console.error(e); srv.close(); process.exit(1); });
