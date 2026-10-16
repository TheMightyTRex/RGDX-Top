// Loads the random library from make-test-library.py into the page and checks it against expected.json:
// file counts per system, RGSX catalogue size (including WAL rows), installed/missing/in-catalogue matching.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dist = path.resolve(__dirname, '../dist'), lib = path.resolve(__dirname, process.argv[2] || 'fixtures/random-retrobat');
const expected = JSON.parse(fs.readFileSync(path.join(lib, 'expected.json'), 'utf8'));
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), rel + e.name + '/') : [[rel + e.name, path.join(d, e.name)]]);
const files = walk(lib).filter(([r]) => r !== 'expected.json').map(([r, p]) => [r, [...fs.readFileSync(p)]]);
const srv = http.createServer((q, r) => { const f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); fs.existsSync(f) && fs.statSync(f).isFile() ? (r.writeHead(200, { 'Content-Type': 'text/html' }), r.end(fs.readFileSync(f))) : (r.writeHead(404), r.end()); }).listen(8768 + (process.argv[2] ? 10 : 0));
const ok = [], bad = []; const check = (n, c, x = '') => (c ? ok : bad).push(n + (x ? ' ' + x : ''));
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const ctx = await b.newContext(); await ctx.addInitScript(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.goto(`http://localhost:${8768 + (process.argv[2] ? 10 : 0)}/rgsx-library-checker.html`);
  await p.evaluate(async files => {
    const root = await navigator.storage.getDirectory();
    for await (const [n] of root.entries()) await root.removeEntry(n, { recursive: true });
    for (const [rel, data] of files) { try { const parts = rel.split('/'); let d = root; for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true }); const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(new Uint8Array(data)); await w.close(); } catch (e) { throw new Error(rel + ': ' + e.message); } }
    for (const empty of ['3do', 'vectrex']) await (await root.getDirectoryHandle('roms')).getDirectoryHandle(empty, { create: true });
    localStorage.clear(); localStorage.setItem('rlc.hideIntro', '1'); indexedDB.deleteDatabase('rgsx-library-checker');
  }, files);
  await p.reload(); await p.waitForTimeout(300); await p.click('[data-act=pickApp]');
  await p.waitForFunction(() => RLC.dirs.roms && !RLC.scanning && RLC.catalog, null, { timeout: 30000 });
  const got = await p.evaluate(() => ({ counts: Object.fromEntries(Object.entries(RLC.scan).map(([k, v]) => [k, v.roms.length])), rgsx: Object.values(RLC.catalog.counts).reduce((a, b) => a + b, 0), seq: RLC.catalog.seq }));
  for (const [k, v] of Object.entries(expected.systems)) check('files ' + k, got.counts[k] === v.files, `${got.counts[k]} vs ${v.files}`);
  check('RGSX catalogue incl. WAL rows', got.rgsx === expected.rgsx_games, `${got.rgsx} vs ${expected.rgsx_games}`);
  check('catalogue revision read', !!got.seq);
  // Matching: every installed title must be found; titles in the catalogue (and not installed) must be flagged.
  for (const [k, v] of Object.entries(expected.systems)) {
    if (!v.installed.length) continue;
    const res = await p.evaluate(([k, inst, cat]) => {
      const sysKey = FOLDER2SYS[k] || k; const folders = foldersFor(sysKey);
      const claimed = new Set([...inst, ...cat, ...((rawList('wikidata', sysKey) || {}).items || []).map(x => x.t)].map(norm));
      const found = t => folders.some(f => findIn(localIndex(f), { t }, claimed));
      const inCat = t => !!findIn(catalogIndex(k), { t }, claimed);
      const fx = t => { for (const f of folders) { const r = findIn(localIndex(f), { t }, claimed); if (r) return t + ' => ' + (r[0].n || r[0].f); } };
      return { instFound: inst.filter(found).length, catFound: cat.filter(inCat).length, missFalse: cat.filter(found).length, falses: cat.filter(found).map(fx), notFound: inst.filter(t => !found(t)) };
    }, [k, v.installed, v.in_rgsx_not_installed]);
    const instRate = res.instFound / v.installed.length, catRate = v.in_rgsx_not_installed.length ? res.catFound / v.in_rgsx_not_installed.length : 1;
    check(`match ${k}`, instRate >= 0.95 && catRate >= 0.95, `installed ${res.instFound}/${v.installed.length}, catalogue ${res.catFound}/${v.in_rgsx_not_installed.length}, false installs ${res.missFalse}${res.missFalse ? ' [' + res.falses.join('; ') + ']' : ''}${res.notFound.length ? ' not found: ' + res.notFound.join('; ') : ''}`);
  }
  // Installation detection and setup checks
  const inst = await p.evaluate(() => ({ type: RLC.install && RLC.install.type, app: RLC.install && RLC.install.rgsxApp, checks: setupChecks().map(c => c.title + ':' + c.status) }));
  check('detected ' + expected.layout, inst.type === expected.layout && inst.app, JSON.stringify(inst));
  check('setup check has no errors', !inst.checks.some(c => c.endsWith(':err')), inst.checks.join(', '));
  if (expected.layout === 'batocera') check('network note for Batocera', inst.checks.includes('Network share:info'));
  // Metadata: a RetroAchievements ID matches even when the title is different; the year guard blocks older ROMs.
  const withRa = Object.entries(expected.systems).flatMap(([k, v]) => (v.meta || []).filter(m => m.ra).map(m => ({ k, ...m })));
  const withY = Object.entries(expected.systems).flatMap(([k, v]) => (v.meta || []).filter(m => m.y).map(m => ({ k, ...m })));
  const meta = await p.evaluate(([ra, ys]) => {
    const f = (k, e) => foldersFor(FOLDER2SYS[k] || k).concat(RLC.folders.includes(k) ? [k] : []).some(x => findIn(localIndex(x), e));
    return { ra: ra.filter(m => f(m.k, { t: 'A title that matches nothing at all', ra: m.ra })).length,
      yearOk: ys.filter(m => f(m.k, { t: m.t, y: m.y })).length,
      yearBlocked: ys.filter(m => f(m.k, { t: m.t, y: m.y + 10 })).length };
  }, [withRa.slice(0, 60), withY.slice(0, 60)]);
  check('RetroAchievements ID match', withRa.length > 5 && meta.ra === Math.min(60, withRa.length), `${meta.ra}/${Math.min(60, withRa.length)}`);
  check('year guard keeps right years', meta.yearOk === Math.min(60, withY.length), `${meta.yearOk}/${Math.min(60, withY.length)}`);
  check('year guard blocks a later game', meta.yearBlocked <= 3, `${meta.yearBlocked} still matched`);
  // Picking the roms folder itself: found, but the RGSX database needs choosing
  await p.evaluate(async () => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('roms'); });
  await p.evaluate(() => pickApp()); await p.waitForFunction(() => RLC.install && RLC.install.type === 'roms', null, { timeout: 15000 });
  const romsOnly = await p.evaluate(() => setupChecks().map(c => c.title + ':' + c.status));
  check('roms folder alone: warned', romsOnly.includes('Installation:warn') && romsOnly.includes('RGSX database:warn'), romsOnly.join(', '));
  check('roms folder alone: old catalogue cleared', !(await p.evaluate(() => !!RLC.catalog)) && !(await p.textContent('#status')).includes('3,'));
  await p.click('nav [data-tab=settings]'); await p.evaluate(() => { RLC.setPage = 'check'; render(); });
  await p.screenshot({ path: path.join(__dirname, 'shots', 'l1-setup-check-' + expected.layout + '.png') });
  check('no page errors', !errors.length, errors.join(' | '));
  console.log('PASS', ok.length, '\n' + ok.join('\n')); if (bad.length) console.log('FAIL', bad.length, '\n' + bad.join('\n'));
  await b.close(); srv.close(); process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); srv.close(); process.exit(1); });
