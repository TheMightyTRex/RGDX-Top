// Opens the built page in headless Chromium: checks it starts without errors, then tests the WAL replay + sql.js.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const p = await b.newPage(); const errors = [];
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await p.goto('file://' + path.resolve(__dirname, '../dist/rgsx-library-checker.html'));
  await p.waitForTimeout(800);
  const intro = await p.isVisible('#intro .modal');
  const main = await p.textContent('#main');
  const db = [...fs.readFileSync(path.join(__dirname, 'fixtures/copy.sqlite3'))], wal = [...fs.readFileSync(path.join(__dirname, 'fixtures/copy.sqlite3-wal'))];
  const r = await p.evaluate(async ([db, wal]) => {
    const SQL = await getSql();
    const raw = new Uint8Array(db); let before;
    try { const d0 = new SQL.Database(raw.slice()); before = d0.exec('select count(*) from games')[0].values[0][0]; } catch (e) { before = 'error: ' + e.message; }
    let m = applyWal(new Uint8Array(db), new Uint8Array(wal)); if (m[18] === 2) { m[18] = 1; m[19] = 1; }
    const d = new SQL.Database(m);
    return { before, after: d.exec('select count(*) from games')[0].values[0][0], snes: d.exec("select g.name from games g join platforms p on p.id=g.platform_id where p.folder='snes'")[0].values[0][0] };
  }, [db, wal]);
  // Free games / top N views render from bundled data without a folder.
  const free = await p.evaluate(() => { S.tab = 'free'; return viewFree().length; });
  console.log(JSON.stringify({ intro, mainStartsWith: main.slice(0, 60), sql: r, freeHtml: free, errors }));
  await b.close();
  if (errors.length || r.after !== 3003 || !intro) process.exit(1);
})();
