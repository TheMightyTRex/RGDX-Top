/* RGSX Library Checker: itch.io refresh script.
   1. Open https://itch.io in Chrome or Edge.  2. Press F12, open the Console tab.
   3. Paste this whole script and press Enter. After a few minutes it downloads itch-free.json.
   4. In RGSX Library Checker go to Settings > itch.io data > Import, and choose that file.
   It reads the public "top rated free" RSS feeds, one request at a time with a short pause. */
(async () => {
  const GENRES = ['action', 'adventure', 'card-game', 'educational', 'fighting', 'interactive-fiction', 'platformer', 'puzzle', 'racing',
    'rhythm', 'role-playing', 'shooter', 'simulation', 'sports', 'strategy', 'survival', 'visual-novel'];
  const SYS = {"nes":["nes","famicom"],"fds":["famicom-disk-system"],"snes":["snes","super-nintendo"],"n64":["n64","nintendo-64"],"gb":["gameboy","game-boy","gb-studio"],"gbc":["gameboy-color","game-boy-color"],"gba":["gba","game-boy-advance"],"nds":["nintendo-ds","nds"],"virtualboy":["virtual-boy"],"pokemini":["pokemon-mini"],"mastersystem":["sega-master-system","master-system"],"megadrive":["sega-genesis","mega-drive","megadrive"],"gamegear":["game-gear"],"sega32x":["32x"],"dreamcast":["dreamcast"],"pcengine":["pc-engine","turbografx-16"],"ngpc":["neo-geo-pocket"],"wswanc":["wonderswan"],"atari2600":["atari-2600","atari2600"],"atari7800":["atari-7800"],"lynx":["atari-lynx"],"jaguar":["atari-jaguar"],"colecovision":["colecovision"],"intellivision":["intellivision"],"vectrex":["vectrex"],"zxspectrum":["zx-spectrum","zxspectrum"],"c64":["c64","commodore-64"],"amiga500":["amiga"],"amstradcpc":["amstrad-cpc"],"msx1":["msx"],"pico8":["pico-8"],"tic80":["tic-80"],"arduboy":["arduboy"],"wasm4":["wasm-4"]};
  const FANTASY = new Set(['pico8', 'tic80', 'wasm4', 'arduboy']);
  if (location.hostname !== 'itch.io') { alert('Run this on https://itch.io'); return; }
  const games = [], idx = new Map();
  const dec = s => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; };
  function add(it) {
    const url = it.querySelector('link').textContent.replace('https://', '').replace('.itch.io/', '~');
    if (idx.has(url)) return idx.get(url);
    const plat = [...it.querySelectorAll('platforms > *')].map(e => e.tagName[0]).join('');
    const desc = dec((it.querySelector('description')?.textContent || '').split('\n')[0].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 90);
    games.push([it.querySelector('plainTitle').textContent, url, plat, desc]); idx.set(url, games.length - 1); return games.length - 1;
  }
  async function feed(path) {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(path); if (r.status !== 200) { await new Promise(s => setTimeout(s, 2000)); continue; }
        const x = new DOMParser().parseFromString(await r.text(), 'text/xml');
        return [...x.querySelectorAll('item')].filter(it => /\$0\.00|^$/.test(it.querySelector('price')?.textContent || '')).map(add);
      } catch { await new Promise(s => setTimeout(s, 2000)); }
    }
    return [];
  }
  const jobs = [], pc = {}, raw = {};
  for (const g of GENRES) jobs.push(async () => { pc[g] = (await feed(`/games/top-rated/free/genre-${g}.xml`)).slice(0, 20); });
  for (const [s, tags] of Object.entries(SYS)) {
    raw[s] = { all: [], genres: {} };
    for (const t of tags) jobs.push(async () => { raw[s].all.push(...await feed(`/games/top-rated/free/tag-${t}.xml`)); });
    for (const g of GENRES) jobs.push(async () => { const l = await feed(`/games/top-rated/free/genre-${g}/tag-${tags[0]}.xml`); if (l.length) raw[s].genres[g] = l; });
  }
  let k = 0;
  async function worker() { while (k < jobs.length) { const j = jobs[k++]; await j(); console.log(`itch refresh ${k}/${jobs.length}`); await new Promise(s => setTimeout(s, 300)); } }
  await Promise.all(Array.from({ length: 4 }, worker));
  // Keep only what the page shows, and renumber.
  const keep = new Map(), G = [];
  const use = i => { if (!keep.has(i)) { keep.set(i, G.length); G.push(games[i]); } return keep.get(i); };
  const ok = (s, i) => FANTASY.has(s) || !/[wlma]/.test(games[i][2]);
  const outPc = {}; for (const [g, l] of Object.entries(pc)) outPc[g] = l.map(use);
  const sys = {};
  for (const [s, v] of Object.entries(raw)) {
    const all = [...new Set(v.all)].filter(i => ok(s, i)).slice(0, 40), gen = {};
    for (const [g, l] of Object.entries(v.genres)) { const f = [...new Set(l)].filter(i => ok(s, i)).slice(0, 15); if (f.length) gen[g] = f.map(use); }
    if (all.length || Object.keys(gen).length) sys[s] = { all: all.map(use), genres: gen };
  }
  const data = { v: 1, fetched: new Date().toISOString(), games: G, pc: outPc, sys };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })); a.download = 'itch-free.json'; a.click();
  console.log('Done: itch-free.json downloaded with', G.length, 'games.');
})();
