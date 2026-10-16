// Simulates unsupported browsers (user agent + no folder API) and checks the warning and its advice per OS.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dist = path.resolve(__dirname, '../dist');
const srv = http.createServer((q, r) => { const f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); fs.existsSync(f) && fs.statSync(f).isFile() ? (r.writeHead(200, { 'Content-Type': 'text/html' }), r.end(fs.readFileSync(f))) : (r.writeHead(404), r.end()); }).listen(8770);
const UA = {
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  braveMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
};
const ok = [], bad = []; const check = (n, c, x = '') => (c ? ok : bad).push(n + (x ? ' ' + x : ''));
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  async function open(ua, brave, keepApi = false) {
    const ctx = await b.newContext({ userAgent: ua, viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(([brave, keep]) => { if (!keep) delete window.showDirectoryPicker; if (brave) navigator.brave = { isBrave: () => Promise.resolve(true) }; }, [brave, keepApi]);
    const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto('http://localhost:8770/rgsx-library-checker.html'); await p.waitForTimeout(400);
    return { p, ctx, errors };
  }
  const cases = [
    ['Firefox on Linux', UA.firefoxLinux, false, /Chromium/, /Firefox · Linux/],
    ['Firefox on Windows', UA.firefoxWin, false, /already on your PC/, /Firefox · Windows/],
    ['Safari on macOS', UA.safariMac, false, /Safari can't open folders/, /Safari · macOS/],
    ['iPhone', UA.iphone, false, /Phones and tablets/, /iOS/],
    ['Android', UA.android, false, /Phones and tablets/, /Android/],
    ['Brave', UA.braveMac, true, /brave:\/\/flags/, /Brave · macOS/],
  ];
  for (const [name, ua, brave, adviceRx, whereRx] of cases) {
    const { p, ctx, errors } = await open(ua, brave);
    const w = await p.textContent('#main #browserWarning').catch(() => '');
    check(name + ': warning', /can't run RGSX Library Checker/.test(w) && adviceRx.test(w) && whereRx.test(w), w.replace(/\s+/g, ' ').slice(0, 160));
    const intro = await p.textContent('#intro').catch(() => '');
    check(name + ': warning in getting started', /can't run/.test(intro));
    if (name === 'Firefox on Linux') {
      await p.click('#intro [data-act=introClose]');
      await p.screenshot({ path: path.join(__dirname, 'shots', 'b1-firefox-warning.png') });
      await p.click('nav [data-tab=help]'); check(name + ': help works', (await p.textContent('#main')).includes('Browsers and computers'));
      await p.click('nav [data-tab=free]'); check(name + ': free games work', (await p.$$('#main .card')).length > 5);
      await p.click('[data-lang=fr]'); await p.waitForTimeout(200); check(name + ': warning translated', (await p.textContent('#browserWarning')).includes('Ce navigateur'));
    }
    check(name + ': no errors', !errors.length, errors.join('|'));
    await ctx.close();
  }
  // Chrome on each desktop OS: no warning
  for (const [name, ua] of [['Chrome Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'], ['Chrome macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'], ['Edge Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0']]) {
    const { p, ctx, errors } = await open(ua, false, true);
    check(name + ': no warning', !(await p.$('#browserWarning')) && !errors.length);
    await ctx.close();
  }
  console.log('PASS', ok.length, '\n' + ok.join('\n')); if (bad.length) console.log('FAIL', bad.length, '\n' + bad.join('\n'));
  await b.close(); srv.close(); process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); srv.close(); process.exit(1); });
