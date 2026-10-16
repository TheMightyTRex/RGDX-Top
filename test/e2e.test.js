// End-to-end: serves dist/ on localhost, fakes the folder picker with the browser's private file system (OPFS)
// holding a tiny RetroBat tree, then walks through the getting started flow and every tab.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dist = path.resolve(__dirname, '../dist'), fx = path.join(__dirname, 'fixtures');
const srv = http.createServer((q, r) => { const f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); fs.existsSync(f) && fs.statSync(f).isFile() ? (r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }), r.end(fs.readFileSync(f))) : (r.writeHead(404), r.end()); }).listen(8765);
let check0 = '', introChecks = [], introSteps = '', introOk = '';
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errors = [];
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && !/favicon|404/.test(m.text() + (m.location().url || '')) && errors.push(m.text()));
  const db = [...fs.readFileSync(path.join(fx, 'copy.sqlite3'))], wal = [...fs.readFileSync(path.join(fx, 'copy.sqlite3-wal'))];
  await p.goto('http://localhost:8765/rgsx-library-checker.html');
  await p.evaluate(async ([db, wal]) => {
    const root = await navigator.storage.getDirectory();
    for await (const [n] of root.entries()) await root.removeEntry(n, { recursive: true });
    const put = async (pth, data) => { const parts = pth.split('/'); let d = root; for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true }); const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(data); await w.close(); };
    await put('rgsx-library-checker.html', 'x');
    for (const f of ['Super Mario Bros. 3 (USA) (Rev 1).nes', 'Legend of Zelda, The (USA).nes', 'Mega Man 2 (USA).nes', 'Tetris (USA).nes', 'images/SMB3-image.png'])
      await put('roms/nes/' + f, 'rom');
    await put('roms/nes/gamelist.xml', '<gameList><game><path>./Mega Man 2 (USA).nes</path><name>Mega Man 2</name></game></gameList>');
    for (const f of ['Super Metroid (Japan, USA) (En).sfc', 'Chrono Trigger (USA).sfc']) await put('roms/snes/' + f, 'rom');
    await put('roms/megadrive/Sonic The Hedgehog (USA, Europe).md', 'rom');
    await put('roms/gb/Tetris (World) (Rev 1).gb', 'rom');
    await put('saves/ports/rgsx/rgsx.sqlite3', new Uint8Array(db)); await put('saves/ports/rgsx/rgsx.sqlite3-wal', new Uint8Array(wal));
    localStorage.clear(); indexedDB.deleteDatabase('rgsx-library-checker');
  }, [db, wal]);
  await p.addInitScript(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
  await p.reload(); await p.waitForTimeout(500);
  const shot = n => p.screenshot({ path: path.join(__dirname, 'shots', n + '.png') });
  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
  await shot('1-getting-started');
  await p.check('#introHide'); await p.click('[data-act=introPick]');
  await p.waitForFunction(() => RLC.dirs.roms && !RLC.scanning && RLC.catalog, null, { timeout: 20000 });
  await p.waitForFunction(() => RLC.catalog && !RLC.scanning && /Needs attention/.test(document.querySelector('#introBody').textContent));
  introChecks = await p.$$eval('#introBody tr', r => r.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  introSteps = await p.textContent('#introBody');
  // With every check passing, only the first instruction and "Everything is set up" remain.
  introOk = await p.evaluate(() => { const keep = setupChecks; setupChecks = () => [{ status: 'ok', title: 'Browser', detail: '' }]; const h = introBody(); setupChecks = keep; return h; });
  await shot('1b-getting-started-checks');
  await p.click('#intro [data-act=introClose]');
  check0 = await p.textContent('#main'); await p.click('nav [data-tab=library]'); await p.waitForTimeout(300); await shot('2-library');
  const lib = await p.textContent('#main');
  await p.evaluate(async () => { const r = await navigator.storage.getDirectory(); await (await r.getDirectoryHandle('roms')).getDirectoryHandle('n64', { create: true }); });
  await p.click('[data-act=scanAll]'); await p.waitForFunction(() => RLC.scan.n64 && !RLC.scanning);
  const sysCount = async v => { await p.selectOption('#sysShow', v); await p.waitForTimeout(250); return p.$$eval('.sysitem', e => e.map(x => x.dataset.sel)); };
  const showEmpty = await sysCount('empty'), showRoms = await sysCount('roms'), showAll = await sysCount('all');
  await p.click('[data-sel=nes]'); await shot('3-library-nes');
  await p.click('nav [data-tab=topn]'); await p.waitForTimeout(300); await shot('4-topn-summary');
  await p.selectOption('#tnSystem', 'nes'); await p.waitForTimeout(300); await shot('5-topn-nes');
  const nesRows = await p.$$eval('#main tr.have', r => r.map(x => x.querySelector('b').textContent));
  await p.selectOption('#tnSource', 'blend'); await p.selectOption('#tnSize', '10'); await p.waitForTimeout(300);
  await p.click('nav [data-tab=free]'); await p.waitForTimeout(300); await shot('6-free-retro');
  await p.check('input[name=fmode][value=pc]'); await p.waitForTimeout(300); await shot('7-free-pc');
  await p.click('nav [data-tab=settings]'); await p.waitForTimeout(800); await shot('8-settings');
  const cfg = await p.evaluate(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle('rgsx-library-checker.config.json')).getFile()).text()));
  const cache = await p.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('rgsx-library-checker-cache'); const n = []; for await (const [k] of d.entries()) n.push(k); return n; });
  // Reload: getting started must stay hidden, config must be re-read.
  await p.reload(); await p.waitForTimeout(1200);
  const introAfter = await p.isVisible('#intro .modal');
  const result = { introChecks, introStepsShown: /How to set it up/.test(introSteps), introOk: /Everything is set up/.test(introOk) && !/How to set it up/.test(introOk) && /Put this file/.test(introOk), firstRunCheck: check0.includes('Setup check'), showEmpty, showRoms, showAll, libraryShow: cfg.library, errors, libHasNes: lib.includes('Nintendo Entertainment System'), nesInstalled: nesRows, cfgTopN: cfg.topN, showGettingStarted: cfg.showGettingStarted, paths: cfg.paths, cache, introAfterReload: introAfter, catalog: await p.evaluate(() => RLC.catalog && RLC.catalog.counts) };
  console.log(JSON.stringify(result, null, 1));
  await b.close(); srv.close();
  if (!result.firstRunCheck || !result.introStepsShown || !result.introOk || introChecks.length < 2 || !introChecks.some(t => /Installation.*RetroBat|Installation.*roms folder/.test(t)) || showEmpty.join() !== 'n64' || showRoms.includes('n64') || showAll.length !== showRoms.length + 1 || errors.length || introAfter || cfg.showGettingStarted !== false || !nesRows.length) process.exit(1);
})().catch(e => { console.error(e); srv.close(); process.exit(1); });
