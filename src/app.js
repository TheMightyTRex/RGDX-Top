'use strict';
/* RGSX Library Checker: shows the ROMs installed in a RetroBat / Batocera library, compares each system
   against Top N lists, and lists top free games from itch.io. Runs from a local file in Chrome or Edge. */

const CONFIG_NAME = 'rgsx-library-checker.config.json';
const CACHE_DIR = 'rgsx-library-checker-cache';
const TOP_SIZES = [10, 50, 100, 200, 500];
const SOURCE_INFO = {
  wikidata: { name: 'Most notable (Wikidata)', about: 'Games on the platform ranked by how many Wikipedia language editions cover them. Open CC0 data; works for almost every system.' },
  sales:    { name: 'Best-selling (Wikipedia)', about: 'The "List of best-selling … video games" article for the platform, in sales order. Only major consoles have one.' },
  critics:  { name: "Critics' all-time best (Wikipedia)", about: 'Wikipedia\'s "List of video games listed among the best", filtered to this platform. Short lists, high quality.' },
  blend:    { name: 'Blended (all sources)', about: 'The three lists above combined with reciprocal-rank fusion: games that rank high in several lists rise to the top.' },
};
const GENRES = { 'action': 'Action', 'adventure': 'Adventure', 'card-game': 'Card game', 'educational': 'Educational', 'fighting': 'Fighting',
  'interactive-fiction': 'Interactive fiction', 'platformer': 'Platformer', 'puzzle': 'Puzzle', 'racing': 'Racing', 'rhythm': 'Rhythm',
  'role-playing': 'Role playing', 'shooter': 'Shooter', 'simulation': 'Simulation', 'sports': 'Sports', 'strategy': 'Strategy',
  'survival': 'Survival', 'visual-novel': 'Visual novel' };
const SKIP_DIRS = new Set(['images', 'videos', 'manuals', 'media', 'thumbnails', 'marquees', 'screenshots', 'wheels', 'boxart', 'box2d', 'box3d',
  'downloaded_images', 'downloaded_videos', 'downloaded_media', 'snap', 'snaps', 'titles', 'fanart', 'maps', 'music', 'bezels', 'logos', 'covers',
  'cartridges', 'mixes', 'mix', 'logs', '__pycache__', '_info', 'saves', 'bios', 'cheats', 'flyers']);
// Note: .md is a Mega Drive ROM extension, not Markdown, so it is never skipped.
const SKIP_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'xml', 'txt', 'nfo', 'pdf', 'mp4', 'mkv', 'avi', 'webm', 'mp3', 'ogg',
  'wav', 'flac', 'cfg', 'ini', 'json', 'log', 'db', 'dat', 'bak', 'srm', 'sav', 'state', 'auto', 'html', 'htm', 'cue_bak', 'm3u8', 'sbi', 'sub',
  'py', 'pyc', 'dll', 'tmp', 'old', 'orig', 'keys', 'p2k', 'cht', 'rtc', 'eep', 'lnk_bak', 'ds_store', 'thumbs']);
const GAME_DIR = /\.(pc|ps3|daphne|singe|wiiu|psvita|squashfs|xbox|game|exe|cannonball|switch|m3u|steam|epic|gog|ldrd)$/i;
const SCAN_DEPTH = 3;
const SCAN_VERSION = 2; // bump when scanning rules change so old scan caches are ignored

/* ------------------------------------------------------------------ state */
const S = {
  config: defaultConfig(),
  handles: { app: null, retro: null, rgsx: null },   // picked folders (persisted in IndexedDB)
  dirs: { roms: null, rgsx: null },                   // resolved working folders
  folders: [],                                        // ROM folder names present on disk
  scan: {},                                           // folder -> {at, roms:[{f,d,n}]}
  index: {},                                          // folder -> match index (built lazily)
  catalog: null,                                      // {sig, at, platforms:{folder:[names]}, counts}
  catIndex: {},
  lists: {},                                          // live top lists: source -> sys -> {items, fetched}
  itch: null,                                         // imported itch.io refresh
  tab: 'library', sel: null, busy: '', errors: [], scanning: false, writable: false,
  libFilter: '', libLimit: 500, sysFilter: '',
};
window.RLC = S; // handy for debugging in DevTools

function defaultConfig() {
  return {
    app: 'RGSX Library Checker', configVersion: 1, showGettingStarted: true,
    paths: { appFolder: '', retrobatFolder: '', romsFolder: '', rgsxFolder: '' },
    topN: { source: 'wikidata', size: 100, system: '', show: 'all' },
    library: { show: 'all' },
    free: { mode: 'retro', system: '', genre: 'all', pcGenre: 'all' },
    customLists: [], wishlist: {}, updated: '',
  };
}

/* ------------------------------------------------------------------ helpers */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtDate = s => { try { return new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return s; } };
const extOf = n => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
const stripExt = n => n.replace(/\.(?:p8\.png|[a-z0-9]{1,5})$/i, '');
const fsSupported = 'showDirectoryPicker' in window;
const FOLDER2SYS = {};
for (const [k, v] of Object.entries(SYSTEMS)) { FOLDER2SYS[k] = k; (v.aliases || []).forEach(a => FOLDER2SYS[a] = k); }
const sysLabel = f => (SYSTEMS[FOLDER2SYS[f]] || {}).label || f;

const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10', xi: '11', xii: '12', xiii: '13' };
function norm(s) {
  return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter(w => w && w !== 'the' && w !== 'version').map(w => ROMAN[w] || w).join(' ');
}
function mainTitle(s) {
  const t = String(s).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  const m = t.split(/\s*:\s+|\s+-\s+|\s+–\s+/)[0];
  return m && m.length < t.trim().length ? norm(m) : '';
}
function cleanName(file) { return stripExt(file).replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').replace(/_/g, ' ').trim() || stripExt(file); }

function toast(msg, kind = 'info') {
  S.errors.unshift({ msg, kind, at: Date.now() }); S.errors = S.errors.slice(0, 5); render();
}

/* ------------------------------------------------------------------ IndexedDB (folder handles) */
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('rgsx-library-checker', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(this.db = r.result); r.onerror = () => rej(r.error);
    });
  },
  async get(k) { try { const db = await this.open(); return await new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } catch { return undefined; } },
  async set(k, v) { try { const db = await this.open(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); v === undefined ? t.objectStore('kv').delete(k) : t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) { console.warn(e); } },
};
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } },
};

/* ------------------------------------------------------------------ file system */
async function tryDir(root, path) {
  if (!root) return null;
  try { let d = root; for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p); return d; } catch { return null; }
}
async function tryFile(dir, name) { if (!dir) return null; try { return await (await dir.getFileHandle(name)).getFile(); } catch { return null; } }
async function readJSON(dir, name) { const f = await tryFile(dir, name); if (!f) return null; try { return JSON.parse(await f.text()); } catch { return null; } }
async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(text); await w.close();
}
async function perm(h, mode, ask) {
  if (!h) return false;
  try {
    if ((await h.queryPermission({ mode })) === 'granted') return true;
    return ask ? (await h.requestPermission({ mode })) === 'granted' : false;
  } catch { return false; }
}
async function looksLikeRoms(d) {
  if (!d) return false; let n = 0;
  try { for await (const [name, h] of d.entries()) { if (h.kind === 'directory' && FOLDER2SYS[name.toLowerCase()]) n++; if (n >= 3) return true; } } catch { }
  return false;
}
/* Given a folder, work out where the roms and the RGSX data are. Handles a RetroBat root, a Batocera share,
   a folder that holds either of those, or a roms folder picked directly. */
async function locate(root) {
  const out = { retro: null, roms: null, rgsx: null, rel: '' };
  for (const sub of ['', 'RetroBat', 'retrobat', 'userdata', 'share', 'Batocera', 'batocera']) {
    const base = sub ? await tryDir(root, sub) : root; if (!base) continue;
    const roms = await tryDir(base, 'roms');
    if (await looksLikeRoms(roms)) {
      out.retro = base; out.roms = roms; out.rel = sub;
      out.rgsx = await tryDir(base, 'saves/ports/rgsx') || await tryDir(base, 'saves/ports/RGSX');
      return out;
    }
  }
  if (await looksLikeRoms(root)) out.roms = root;
  return out;
}
async function isRgsxFolder(d) { return !!(await tryFile(d, 'rgsx.sqlite3')); }

function pageLocation() {
  if (location.protocol !== 'file:') return { file: '', folder: '' };
  let p = decodeURIComponent(location.pathname);
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1).replace(/\//g, '\\');
  const sep = p.includes('\\') ? '\\' : '/'; const i = p.lastIndexOf(sep);
  return { file: p.slice(i + 1), folder: p.slice(0, i) };
}

/* ------------------------------------------------------------------ config + cache */
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    S.config.updated = new Date().toISOString();
    ls.set('rlc.hideIntro', S.config.showGettingStarted ? null : '1');
    if (!S.handles.app || !S.writable) return;
    try { await writeText(S.handles.app, CONFIG_NAME, JSON.stringify(S.config, null, 2)); }
    catch (e) { toast('Could not write the config file: ' + e.message, 'err'); }
  }, 400);
}
async function cacheDir(create) {
  if (!S.handles.app) return null;
  try { return await S.handles.app.getDirectoryHandle(CACHE_DIR, { create: !!create && S.writable }); } catch { return null; }
}
async function cacheRead(name) { return readJSON(await cacheDir(false), name); }
async function cacheWrite(name, data) {
  const d = await cacheDir(true); if (!d) return;
  try { await writeText(d, name, JSON.stringify(data)); } catch (e) { console.warn('cache write', name, e); }
}
function mergeConfig(c) {
  const d = defaultConfig();
  if (!c || typeof c !== 'object') return d;
  return { ...d, ...c, paths: { ...d.paths, ...(c.paths || {}) }, library: { ...d.library, ...(c.library || {}) }, topN: { ...d.topN, ...(c.topN || {}) }, free: { ...d.free, ...(c.free || {}) },
    customLists: Array.isArray(c.customLists) ? c.customLists : [], wishlist: c.wishlist && typeof c.wishlist === 'object' ? c.wishlist : {} };
}

/* ------------------------------------------------------------------ connect */
async function pickApp() {
  try {
    const h = await window.showDirectoryPicker({ id: 'rlc-app', mode: 'readwrite' });
    S.handles.app = h; S.handles.retro = null; S.handles.rgsx = null;
    await idb.set('app', h); await idb.set('retro', undefined); await idb.set('rgsx', undefined);
    await connect(true);
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'err'); }
}
async function pickRetro() {
  try {
    const h = await window.showDirectoryPicker({ id: 'rlc-retro', mode: 'read' });
    const loc = await locate(h);
    if (!loc.roms) { toast(`"${h.name}" does not look like a RetroBat / Batocera folder or a roms folder (no system folders such as nes or snes found).`, 'err'); return; }
    S.handles.retro = h; await idb.set('retro', h); await connect(false);
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'err'); }
}
async function pickRgsx() {
  try {
    const h = await window.showDirectoryPicker({ id: 'rlc-rgsx', mode: 'read' });
    if (!(await isRgsxFolder(h))) { toast(`No rgsx.sqlite3 in "${h.name}". The RGSX database lives in saves\\ports\\rgsx inside your RetroBat or Batocera folder.`, 'err'); return; }
    S.handles.rgsx = h; await idb.set('rgsx', h); S.dirs.rgsx = h; S.config.paths.rgsxFolder = h.name; saveConfig(); await loadCatalog(false);
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'err'); }
}
async function reconnect() {
  // Needs a click: browsers only re-grant folder access in response to a user gesture.
  for (const k of ['app', 'retro', 'rgsx']) if (S.handles[k]) await perm(S.handles[k], k === 'app' ? 'readwrite' : 'read', true);
  await connect(false);
}
async function connect(fresh) {
  const app = S.handles.app; if (!app) return render();
  if (!(await perm(app, 'read', false))) { S.needsReconnect = true; return render(); }
  S.needsReconnect = false;
  S.writable = await perm(app, 'readwrite', false);
  const cfg = await readJSON(app, CONFIG_NAME);
  if (cfg) S.config = mergeConfig(cfg);
  else if (!fresh) S.config = mergeConfig(S.config);
  if (ls.get('rlc.hideIntro')) S.config.showGettingStarted = false;
  const pl = pageLocation();
  S.config.paths.appFolder = pl.folder || app.name;
  S.samePlace = pl.file ? !!(await tryFile(app, pl.file)) : null;

  let loc = { roms: null, rgsx: null, retro: null };
  if (S.handles.retro && await perm(S.handles.retro, 'read', false)) loc = await locate(S.handles.retro);
  if (!loc.roms) { const l2 = await locate(app); if (l2.roms) { loc = l2; S.handles.retro = null; await idb.set('retro', undefined); } }
  S.dirs.roms = loc.roms;
  S.dirs.rgsx = (S.handles.rgsx && await perm(S.handles.rgsx, 'read', false)) ? S.handles.rgsx : loc.rgsx;
  if (S.dirs.rgsx && !(await isRgsxFolder(S.dirs.rgsx))) S.dirs.rgsx = null;
  const here = pl.folder || app.name || "this page's folder";
  S.config.paths.retrobatFolder = loc.retro ? (S.handles.retro ? S.handles.retro.name : (loc.rel ? here + '\\' + loc.rel : here)) : '';
  S.config.paths.romsFolder = loc.roms ? (loc.retro ? 'roms' : loc.roms.name) : '';
  S.config.paths.rgsxFolder = S.dirs.rgsx ? (S.handles.rgsx ? S.handles.rgsx.name : 'saves/ports/rgsx') : '';
  saveConfig();

  S.lists = (await cacheRead('toplists.json')) || {};
  S.itch = await cacheRead('itch-free.json');
  const sc = await cacheRead('scan.json'); if (sc && sc.scan && sc.v === SCAN_VERSION) { S.scan = sc.scan; S.index = {}; }
  await listFolders();
  render();
  if (S.dirs.rgsx) loadCatalog(false);
  if (S.dirs.roms && !Object.keys(S.scan).length) scanAll();
}
async function listFolders() {
  S.folders = [];
  if (!S.dirs.roms) return;
  for await (const [name, h] of S.dirs.roms.entries()) if (h.kind === 'directory' && !name.startsWith('.') && !name.startsWith('_')) S.folders.push(name);
  S.folders.sort((a, b) => sysLabel(a).localeCompare(sysLabel(b)));
  if (!S.sel || !S.folders.includes(S.sel)) S.sel = S.folders.find(f => (S.scan[f]?.roms.length)) || S.folders[0] || null;
}

/* ------------------------------------------------------------------ scanning */
async function readGamelist(dir) {
  const f = await tryFile(dir, 'gamelist.xml'); if (!f) return null;
  const txt = await f.text(); const map = new Map();
  const dec = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").trim();
  const re = /<game\b[^>]*>([\s\S]*?)<\/game>/g; let g;
  while ((g = re.exec(txt))) {
    const p = /<path>([\s\S]*?)<\/path>/.exec(g[1]), n = /<name>([\s\S]*?)<\/name>/.exec(g[1]);
    if (p && n) map.set(dec(p[1]).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase(), dec(n[1]));
  }
  return map;
}
async function walk(dir, rel, depth, out) {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') {
      if (GAME_DIR.test(name)) { out.push({ f: name, d: rel }); continue; }
      if (depth < SCAN_DEPTH && !SKIP_DIRS.has(name.toLowerCase())) await walk(h, rel ? rel + '/' + name : name, depth + 1, out);
    } else {
      const e = extOf(name);
      if (!e || SKIP_EXT.has(e) || name === 'gamelist.xml') continue;
      out.push({ f: name, d: rel });
    }
  }
}
async function scanFolder(folder) {
  const dir = await tryDir(S.dirs.roms, folder); if (!dir) return;
  const roms = []; await walk(dir, '', 0, roms);
  const gl = await readGamelist(dir);
  if (gl) for (const r of roms) { const n = gl.get(((r.d ? r.d + '/' : '') + r.f).toLowerCase()); if (n) r.n = n; }
  roms.sort((a, b) => (a.n || a.f).localeCompare(b.n || b.f));
  S.scan[folder] = { at: new Date().toISOString(), roms };
  delete S.index[folder];
}
async function scanAll() {
  if (S.scanning || !S.dirs.roms) return;
  S.scanning = true;
  try {
    await listFolders();
    let i = 0;
    for (const f of S.folders) {
      S.busy = `Scanning ${sysLabel(f)} (${++i}/${S.folders.length})…`; renderStatus();
      try { await scanFolder(f); } catch (e) { console.warn('scan', f, e); }
      if (i % 8 === 0) render();
    }
    await cacheWrite('scan.json', { v: SCAN_VERSION, at: new Date().toISOString(), scan: S.scan });
  } finally { S.scanning = false; S.busy = ''; render(); }
}

/* ------------------------------------------------------------------ matching */
function buildIndex(entries) {
  const byKey = new Map(), byMain = new Map();
  const add = (m, k, e) => { if (!k) return; let a = m.get(k); if (!a) m.set(k, a = []); a.push(e); };
  for (const e of entries) {
    for (const name of [e.n, cleanName(e.f)]) { if (!name) continue; add(byKey, norm(name), e); add(byMain, mainTitle(name), e); }
  }
  return { byKey, byMain };
}
function localIndex(folder) {
  if (!S.index[folder]) S.index[folder] = buildIndex((S.scan[folder] || { roms: [] }).roms);
  return S.index[folder];
}
function catalogIndex(folder) {
  if (!S.catalog) return null;
  if (!S.catIndex[folder]) S.catIndex[folder] = buildIndex((S.catalog.platforms[folder] || []).map(n => ({ f: n })));
  return S.catIndex[folder];
}
function candidates(e) {
  const out = [];
  for (const t of [e.t, ...(e.a || [])]) {
    out.push(t);
    const parts = t.split(/\s+(?:and|&)\s+|\s*\/\s*/); if (parts.length > 1 && parts[0].length > 3) out.push(parts[0]);
  }
  return out;
}
function findIn(idx, e) {
  if (!idx) return null;
  const c = candidates(e);
  for (const t of c) { const r = idx.byKey.get(norm(t)); if (r) return r; }
  for (const t of c) { const r = idx.byMain.get(norm(t)); if (r) return r; }
  for (const t of c) { const m = mainTitle(t); if (m && m.split(' ').length > 1) { const r = idx.byKey.get(m); if (r) return r; } }
  return null;
}
function foldersFor(sysKey) { return S.folders.filter(f => FOLDER2SYS[f] === sysKey || f === sysKey); }

/* ------------------------------------------------------------------ RGSX catalogue (SQLite, incl. WAL) */
function walChecksum(buf, off, len, s0, s1, bigEndian) {
  const dv = new DataView(buf.buffer, buf.byteOffset + off, len);
  for (let i = 0; i < len; i += 8) { s0 = (s0 + dv.getUint32(i, !bigEndian) + s1) >>> 0; s1 = (s1 + dv.getUint32(i + 4, !bigEndian) + s0) >>> 0; }
  return [s0, s1];
}
/* RGSX keeps SQLite in WAL mode, so recent writes live in rgsx.sqlite3-wal. sql.js cannot read a WAL, so we
   replay every committed, checksummed frame onto the main file and switch the header back to rollback mode. */
function applyWal(db, wal) {
  if (!wal || wal.length < 32) return db;
  const dv = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
  const magic = dv.getUint32(0); if (magic !== 0x377f0682 && magic !== 0x377f0683) return db;
  const be = magic === 0x377f0683, pageSize = dv.getUint32(8), salt1 = dv.getUint32(16), salt2 = dv.getUint32(20);
  let [s0, s1] = walChecksum(wal, 0, 24, 0, 0, be);
  if (s0 !== dv.getUint32(24) || s1 !== dv.getUint32(28)) return db;
  const pages = new Map(), pending = new Map(); let dbPages = 0, off = 32;
  while (off + 24 + pageSize <= wal.length) {
    if (dv.getUint32(off + 8) !== salt1 || dv.getUint32(off + 12) !== salt2) break;
    [s0, s1] = walChecksum(wal, off, 8, s0, s1, be);
    [s0, s1] = walChecksum(wal, off + 24, pageSize, s0, s1, be);
    if (s0 !== dv.getUint32(off + 16) || s1 !== dv.getUint32(off + 20)) break;
    pending.set(dv.getUint32(off), off + 24);
    const commit = dv.getUint32(off + 4);
    if (commit) { for (const [k, v] of pending) pages.set(k, v); pending.clear(); dbPages = commit; }
    off += 24 + pageSize;
  }
  if (!pages.size) return db;
  const out = new Uint8Array(dbPages * pageSize);
  out.set(db.subarray(0, Math.min(db.length, out.length)));
  for (const [pg, o] of pages) if (pg <= dbPages) out.set(wal.subarray(o, o + pageSize), (pg - 1) * pageSize);
  return out;
}
let sqlPromise = null;
function getSql() {
  if (!sqlPromise) {
    const bin = Uint8Array.from(atob(SQL_WASM_B64), c => c.charCodeAt(0));
    sqlPromise = initSqlJs({ wasmBinary: bin });
  }
  return sqlPromise;
}
async function loadCatalog(force) {
  const dir = S.dirs.rgsx; if (!dir) return;
  try {
    const dbf = await tryFile(dir, 'rgsx.sqlite3'); if (!dbf) throw new Error('rgsx.sqlite3 not found');
    const walf = await tryFile(dir, 'rgsx.sqlite3-wal');
    const sig = [dbf.size, dbf.lastModified, walf ? walf.size : 0, walf ? walf.lastModified : 0].join(':');
    if (!force) {
      const c = S.catalog && S.catalog.sig === sig ? S.catalog : await cacheRead('rgsx-catalog.json');
      if (c && c.sig === sig) { S.catalog = c; S.catIndex = {}; render(); return; }
    }
    S.busy = 'Reading the RGSX database…'; renderStatus();
    const SQL = await getSql();
    let bytes = new Uint8Array(await dbf.arrayBuffer());
    if (walf && walf.size > 32) { S.busy = 'Applying recent RGSX changes (WAL)…'; renderStatus(); bytes = applyWal(bytes, new Uint8Array(await walf.arrayBuffer())); }
    if (bytes[18] === 2) { bytes[18] = 1; bytes[19] = 1; }
    S.busy = 'Indexing the RGSX catalogue…'; renderStatus();
    const db = new SQL.Database(bytes); bytes = null;
    const platforms = {}, names = {};
    try {
      const st = db.prepare("SELECT p.folder, p.platform_name, g.name, g.display_name FROM games g JOIN platforms p ON p.id = g.platform_id WHERE p.folder <> '' AND p.folder <> 'bios'");
      while (st.step()) {
        const [folder, pname, name, disp] = st.get();
        const base = String(disp || name).split('/').pop();
        (platforms[folder] ||= []).push(disp ? base : stripExt(base));
        (names[folder] ||= new Set()).add(pname);
      }
      st.free();
    } finally { db.close(); }
    const counts = {}; for (const [f, l] of Object.entries(platforms)) counts[f] = l.length;
    S.catalog = { sig, at: new Date().toISOString(), platforms, counts, sources: Object.fromEntries(Object.entries(names).map(([k, v]) => [k, [...v]])) };
    S.catIndex = {};
    await cacheWrite('rgsx-catalog.json', S.catalog);
  } catch (e) {
    toast('Could not read the RGSX database: ' + e.message + ' (if RGSX is running, close it and press Reload catalogue).', 'err');
  } finally { S.busy = ''; render(); }
}

/* ------------------------------------------------------------------ top lists */
function customListsFor(sysKey) { return S.config.customLists.filter(l => l.system === '*' || l.system === sysKey); }
function sourceOptions(sysKey) {
  const o = Object.keys(SOURCE_INFO).map(k => [k, SOURCE_INFO[k].name]);
  for (const l of customListsFor(sysKey)) o.push(['custom:' + l.id, 'Custom: ' + l.name]);
  return o;
}
function rawList(source, sysKey) {
  const live = S.lists[source] && S.lists[source][sysKey];
  if (live) return { items: live.items, fetched: live.fetched, origin: 'live' };
  const snap = SNAPSHOT[source] && SNAPSHOT[source][sysKey];
  if (snap) return { items: snap, fetched: SNAPSHOT.fetched, origin: 'bundled' };
  return null;
}
function getList(source, sysKey) {
  if (source.startsWith('custom:')) {
    const l = S.config.customLists.find(x => 'custom:' + x.id === source);
    return l ? { items: l.items.map(t => ({ t })), fetched: l.added, origin: 'custom' } : null;
  }
  if (source !== 'blend') return rawList(source, sysKey);
  const K = 20, score = new Map(); let any = false, fetched = '';
  for (const src of ['wikidata', 'sales', 'critics']) {
    const l = rawList(src, sysKey); if (!l) continue; any = true; fetched = fetched > l.fetched ? fetched : l.fetched;
    l.items.forEach((e, r) => {
      const k = norm(e.t); let s = score.get(k);
      if (!s) score.set(k, s = { e: { t: e.t, y: e.y, a: [...(e.a || [])] }, v: 0, n: 0, from: [] });
      if (src !== 'wikidata') s.e.t = e.t;
      if (!s.e.y && e.y) s.e.y = e.y;
      s.v += 1 / (K + r); s.n++; s.from.push(src);
    });
  }
  if (!any) return null;
  const items = [...score.values()].sort((a, b) => b.v - a.v).map(s => ({ ...s.e, n: s.n > 1 ? `in ${s.n} lists` : SOURCE_INFO[s.from[0]].name.split(' (')[0] }));
  return { items, fetched, origin: 'blend' };
}
async function refreshLists(sysKeys, sources) {
  let i = 0; const total = sysKeys.length * sources.length; let fails = 0;
  for (const k of sysKeys) for (const src of sources) {
    S.busy = `Downloading ${SOURCE_INFO[src].name} for ${SYSTEMS[k].label} (${++i}/${total})…`; renderStatus();
    try {
      const items = await Sources[src](SYSTEMS[k], 500);
      if (items.length) { (S.lists[src] ||= {})[k] = { items, fetched: new Date().toISOString() }; }
    } catch (e) { fails++; console.warn(src, k, e); }
    await sleep(300);
  }
  await cacheWrite('toplists.json', S.lists);
  S.busy = ''; render();
  if (fails) toast(`${fails} list download(s) failed; the bundled copy is still used for those.`, 'warn');
}
function compareSystem(sysKey, source, size) {
  const l = getList(source, sysKey); if (!l) return null;
  const folders = foldersFor(sysKey);
  const items = l.items.slice(0, size).map((e, i) => {
    let have = null; for (const f of folders) { have = findIn(localIndex(f), e); if (have) break; }
    let cat = null; if (!have && S.catalog) for (const f of new Set([...folders, sysKey, ...(SYSTEMS[sysKey].aliases || [])])) { cat = findIn(catalogIndex(f), e); if (cat) break; }
    return { rank: i + 1, e, have, cat };
  });
  return { list: l, items, have: items.filter(x => x.have).length, folders };
}

/* ------------------------------------------------------------------ itch.io data */
function itchData() { return S.itch && S.itch.games ? S.itch : ITCH_BUNDLED; }
const itchUrl = u => 'https://' + u.replace('~', '.itch.io/');
const PLAT = { w: 'Windows', l: 'Linux', m: 'macOS', o: 'macOS', h: 'Browser', a: 'Android' };

/* ------------------------------------------------------------------ rendering */
function render() {
  renderStatus();
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const m = $('#main');
  const notices = S.errors.filter(e => Date.now() - e.at < 20000).map(e => `<div class="notice ${e.kind === 'err' ? 'err' : e.kind === 'warn' ? '' : 'info'}">${esc(e.msg)}</div>`).join('');
  let body = '';
  if (!fsSupported) body = `<div class="panel"><h2>This browser can't open folders</h2><p>RGSX Library Checker needs the File System Access API to read your ROM folders and write its config file. Open this page in <b>Google Chrome</b> or <b>Microsoft Edge</b> on Windows, macOS or Linux.</p></div>`;
  else if (!S.handles.app) body = connectPanel();
  else if (S.needsReconnect) body = `<div class="panel"><h2>Allow access again</h2><p>Your browser needs you to confirm folder access each time this page is opened. Last folder: <b>${esc(S.handles.app.name)}</b>.</p><div class="row"><button class="primary" data-act="reconnect">Allow access to ${esc(S.handles.app.name)}</button><button data-act="pickApp">Choose a different folder</button></div></div>`;
  else body = ({ library: viewLibrary, topn: viewTopN, free: viewFree, settings: viewSettings })[S.tab]();
  m.innerHTML = notices + body;
  if (S.config.showGettingStarted && !ls.get('rlc.hideIntro') && !S.introDismissed && $('#intro').classList.contains('hidden')) showIntro();
}
function renderStatus() {
  const chips = [];
  if (S.handles.app && !S.needsReconnect) {
    chips.push(S.dirs.roms ? `<span class="chip ok">ROMs: ${S.folders.length} folders</span>` : `<span class="chip no">ROMs folder not found</span>`);
    chips.push(S.catalog ? `<span class="chip ok">RGSX: ${Object.values(S.catalog.counts).reduce((a, b) => a + b, 0).toLocaleString()} games</span>` : S.dirs.rgsx ? `<span class="chip warn">RGSX: not loaded</span>` : `<span class="chip no">RGSX database not found</span>`);
    if (!S.writable) chips.push(`<span class="chip warn" title="Settings can't be saved to the folder">Read-only</span>`);
  }
  if (S.busy) chips.unshift(`<span class="chip warn">${esc(S.busy)}</span>`);
  $('#status').innerHTML = chips.join('');
  $('#ver').textContent = 'v' + APP_VERSION;
}
function connectPanel() {
  const pl = pageLocation();
  return `<div class="panel"><h2>Connect your RetroBat folder</h2>
  <p>Choose the folder that holds this page${pl.folder ? ` (<code>${esc(pl.folder)}</code>)` : ''}. The page saves its settings to <code>${CONFIG_NAME}</code> in that folder.</p>
  <p class="muted">If this page sits in your RetroBat (or Batocera <code>share</code>) folder, the ROMs and the RGSX database are found automatically. If not, you can point to them afterwards.</p>
  <div class="row"><button class="primary" data-act="pickApp">Choose this page's folder…</button><button data-act="intro">Getting started</button></div></div>`;
}

function viewLibrary() {
  if (!S.dirs.roms) return `<div class="panel"><h2>ROMs folder not found</h2><p>No <code>roms</code> folder was found in <b>${esc(S.handles.app.name)}</b>. Choose your RetroBat or Batocera folder (or the roms folder itself).</p><div class="row"><button class="primary" data-act="pickRetro">Choose RetroBat folder…</button></div></div>`;
  const f = S.sysFilter.toLowerCase(), show = S.config.library.show;
  const count = x => S.scan[x] ? S.scan[x].roms.length : null;
  const rows = S.folders.filter(x => !f || x.includes(f) || sysLabel(x).toLowerCase().includes(f))
    .filter(x => show === 'all' || (show === 'empty' ? count(x) === 0 : count(x) !== 0)).map(x => {
    const n = S.scan[x] ? S.scan[x].roms.length : null, c = S.catalog && S.catalog.counts[x];
    return `<div class="sysitem ${x === S.sel ? 'on' : ''}" data-sel="${esc(x)}"><span>${esc(sysLabel(x))}<br><small>${esc(x)}</small></span><span class="right">${n == null ? '<small>…</small>' : n.toLocaleString()}${c ? `<br><small>RGSX ${c.toLocaleString()}</small>` : ''}</span></div>`;
  }).join('');
  const total = Object.values(S.scan).reduce((a, s) => a + s.roms.length, 0);
  const withRoms = Object.values(S.scan).filter(s => s.roms.length).length;
  let right = '<div class="empty">Choose a system.</div>';
  const sc = S.sel && S.scan[S.sel];
  if (S.sel && !sc) right = `<div class="empty">Not scanned yet. <button data-act="scanOne">Scan ${esc(sysLabel(S.sel))}</button></div>`;
  else if (sc) {
    const q = norm(S.libFilter);
    const list = q ? sc.roms.filter(r => norm((r.n || '') + ' ' + r.f + ' ' + r.d).includes(q)) : sc.roms;
    const shown = list.slice(0, S.libLimit);
    const sysKey = FOLDER2SYS[S.sel];
    right = `<div class="row"><h2 style="margin:0">${esc(sysLabel(S.sel))}</h2><span class="muted">${sc.roms.length.toLocaleString()} files · scanned ${fmtDate(sc.at)}</span><div class="grow"></div>
      <input type="search" id="libFilter" placeholder="Filter…" value="${esc(S.libFilter)}">
      <button class="small" data-act="scanOne">Rescan</button>${sysKey ? `<button class="small" data-act="toTop">Compare with Top N</button>` : ''}</div>
      ${S.catalog && S.catalog.sources[S.sel] ? `<p class="muted">RGSX catalogue for <code>${esc(S.sel)}</code>: ${(S.catalog.counts[S.sel] || 0).toLocaleString()} games from ${S.catalog.sources[S.sel].map(esc).join(', ')}.</p>` : ''}
      <table><thead><tr><th>Game</th><th>File</th><th>Folder</th></tr></thead><tbody>
      ${shown.map(r => `<tr><td>${esc(r.n || cleanName(r.f))}</td><td class="muted">${esc(r.f)}</td><td class="muted">${esc(r.d)}</td></tr>`).join('')}
      </tbody></table>
      ${list.length > shown.length ? `<p class="row"><span class="muted">Showing ${shown.length.toLocaleString()} of ${list.length.toLocaleString()}.</span><button class="small" data-act="more">Show 1,000 more</button></p>` : ''}
      ${!list.length ? '<div class="empty">No ROMs here.</div>' : ''}`;
  }
  return `<div class="split"><div class="panel"><div class="row"><b>Systems</b><span class="muted">${withRoms} with games · ${total.toLocaleString()} files</span></div>
    <div class="row" style="margin-top:8px"><input type="search" id="sysFilter" placeholder="Find a system…" value="${esc(S.sysFilter)}" style="flex:1"><button class="small" data-act="scanAll" ${S.scanning ? 'disabled' : ''}>Rescan all</button></div>
    <div class="row" style="margin-top:8px"><select id="sysShow" style="flex:1" aria-label="Which systems to list">
      <option value="all" ${show === 'all' ? 'selected' : ''}>Show all</option>
      <option value="empty" ${show === 'empty' ? 'selected' : ''}>Show empty</option>
      <option value="roms" ${show === 'roms' ? 'selected' : ''}>Show only with ROMs</option></select></div>
    <div class="syslist">${rows || '<div class="empty">No systems match.</div>'}</div></div><div class="panel">${right}</div></div>`;
}

function topSystems() {
  // Systems that have a top list (bundled, live or custom) and a ROM folder on disk.
  return Object.keys(SYSTEMS).filter(k => foldersFor(k).length);
}
function viewTopN() {
  const c = S.config.topN;
  const systems = topSystems();
  if (!systems.length) return `<div class="panel"><h2>Nothing to compare yet</h2><p>No supported system folders were found in your ROMs folder.</p></div>`;
  if (c.system && c.system !== '*' && !systems.includes(c.system)) c.system = '';
  const sysOpts = `<option value="*" ${c.system === '*' || !c.system ? 'selected' : ''}>All systems (summary)</option>` + systems.map(k => `<option value="${k}" ${k === c.system ? 'selected' : ''}>${esc(SYSTEMS[k].label)}</option>`).join('');
  const srcOpts = sourceOptions(c.system && c.system !== '*' ? c.system : '').map(([v, n]) => `<option value="${esc(v)}" ${v === c.source ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const controls = `<div class="panel"><div class="row">
    <label>System <select id="tnSystem">${sysOpts}</select></label>
    <label>Source <select id="tnSource">${srcOpts}</select></label>
    <label>Top <select id="tnSize">${TOP_SIZES.map(n => `<option ${n === +c.size ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    ${c.system && c.system !== '*' ? `<label>Show <select id="tnShow"><option value="all">All</option><option value="miss" ${c.show === 'miss' ? 'selected' : ''}>Missing only</option><option value="have" ${c.show === 'have' ? 'selected' : ''}>Installed only</option></select></label>` : ''}
    <div class="grow"></div>
    ${c.source.startsWith('custom:') ? '' : `<button data-act="refreshLists">Update from the internet</button>`}
    ${c.system && c.system !== '*' ? `<button data-act="exportMissing">Export missing (CSV)</button>` : ''}
    </div><p class="muted" style="margin:8px 0 0">${esc((SOURCE_INFO[c.source] || { about: 'A list you added in Settings.' }).about)}</p></div>`;
  const unscanned = systems.flatMap(foldersFor).filter(f => !S.scan[f]);
  const scanNote = unscanned.length ? `<div class="notice">${unscanned.length} folder(s) not scanned yet, so they show as missing. <button class="small" data-act="scanAll" ${S.scanning ? 'disabled' : ''}>Scan now</button></div>` : '';
  if (!c.system || c.system === '*') {
    const rows = systems.map(k => ({ k, r: compareSystem(k, c.source, +c.size) })).filter(x => x.r);
    const body = rows.map(({ k, r }) => {
      const n = r.items.length, p = n ? Math.round(100 * r.have / n) : 0;
      return `<tr data-sys="${k}" style="cursor:pointer"><td>${esc(SYSTEMS[k].label)}<br><small class="muted">${r.folders.map(esc).join(', ')}</small></td><td>${r.have} / ${n}${n < +c.size ? ` <span class="tag" title="This source has fewer than ${c.size} games for the system">list has ${n}</span>` : ''}</td><td><div class="bar"><i style="width:${p}%"></i></div></td><td>${p}%</td><td class="muted">${r.list.origin === 'live' ? 'updated ' : r.list.origin === 'bundled' ? 'bundled ' : ''}${r.list.fetched ? fmtDate(r.list.fetched) : ''}</td></tr>`;
    }).join('');
    const none = systems.length - rows.length;
    return controls + scanNote + `<div class="panel"><h2>Top ${c.size} coverage by system</h2>${rows.length ? `<table><thead><tr><th>System</th><th>Installed</th><th></th><th></th><th>List date</th></tr></thead><tbody>${body}</tbody></table>` : '<div class="empty">This source has no lists for your systems.</div>'}
      ${none ? `<p class="muted">${none} of your systems have no list in this source. Try "Most notable (Wikidata)", or add a custom list in Settings.</p>` : ''}</div>`;
  }
  const r = compareSystem(c.system, c.source, +c.size);
  if (!r) return controls + `<div class="panel"><div class="empty">${esc(SOURCE_INFO[c.source]?.name || 'This list')} has nothing for ${esc(SYSTEMS[c.system].label)}. Try another source or press "Update from the internet".</div></div>`;
  const wl = S.config.wishlist[c.system] || [];
  const items = r.items.filter(x => c.show === 'all' || (c.show === 'miss' ? !x.have : !!x.have));
  const rows = items.map(x => {
    const k = norm(x.e.t), star = wl.includes(k);
    return `<tr class="${x.have ? 'have' : 'miss'}"><td class="num">${x.rank}</td><td><b>${esc(x.e.t)}</b>${x.e.y ? ` <span class="muted">(${x.e.y})</span>` : ''}${x.e.n ? `<br><small class="muted">${esc(x.e.n)}</small>` : ''}</td>
      <td>${x.have ? `<span class="tag ok">Installed</span> <small class="muted">${esc(x.have[0].f)}${x.have.length > 1 ? ` +${x.have.length - 1}` : ''}</small>` : `<span class="tag no">Missing</span>${x.cat ? ` <span class="tag warn" title="${esc(x.cat[0].f)}">In RGSX catalogue</span>` : ''}`}</td>
      <td class="right"><button class="small" data-star="${esc(k)}" title="Wishlist">${star ? '★' : '☆'}</button></td></tr>`;
  }).join('');
  return controls + scanNote + `<div class="panel"><div class="row"><h2 style="margin:0">${esc(SYSTEMS[c.system].label)} · Top ${c.size}</h2>
    <span class="tag ok">${r.have} installed</span><span class="tag no">${r.items.length - r.have} missing</span>
    ${S.catalog ? `<span class="tag warn">${r.items.filter(x => !x.have && x.cat).length} of the missing are in the RGSX catalogue</span>` : ''}
    <div class="grow"></div><span class="muted">${r.list.origin === 'bundled' ? 'Bundled list from ' : r.list.origin === 'live' ? 'Updated ' : ''}${r.list.fetched ? fmtDate(r.list.fetched) : ''}${r.items.length < +c.size ? ` · source has ${r.items.length} games` : ''}</span></div>
    <table style="margin-top:8px"><thead><tr><th>#</th><th>Game</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Nothing to show.</td></tr>'}</tbody></table>
    <p class="muted">Matching uses the names in your gamelist.xml and the file names, ignoring region tags, punctuation, "The" and roman numerals. A game can still be missed if its file is named very differently.</p></div>`;
}

function viewFree() {
  const d = itchData(); const c = S.config.free;
  if (!d) return `<div class="panel"><div class="empty">No itch.io data.</div></div>`;
  const G = d.games;
  const mode = c.mode === 'pc' ? 'pc' : 'retro';
  const sysKeys = Object.keys(d.sys).sort((a, b) => (SYSTEMS[a]?.label || a).localeCompare(SYSTEMS[b]?.label || b));
  if (!c.system || !d.sys[c.system]) c.system = sysKeys.find(k => foldersFor(k).length || S.folders.includes(k)) || sysKeys[0];
  const head = `<div class="panel"><div class="row">
    <label><input type="radio" name="fmode" value="retro" ${mode === 'retro' ? 'checked' : ''}> Retro homebrew (ROMs for your systems)</label>
    <label><input type="radio" name="fmode" value="pc" ${mode === 'pc' ? 'checked' : ''}> PC &amp; browser games</label>
    <div class="grow"></div><span class="muted">itch.io top-rated free games · ${d === ITCH_BUNDLED ? 'bundled' : 'updated'} ${fmtDate(d.fetched)}</span></div></div>`;
  let body = '';
  const card = (i, sysKey) => {
    const g = G[i]; if (!g) return '';
    let have = null;
    if (sysKey) for (const f of [...foldersFor(sysKey), ...(S.folders.includes(sysKey) ? [sysKey] : [])]) { have = findIn(localIndex(f), { t: g[0] }); if (have) break; }
    const plats = [...new Set((g[2] || '').split('').map(p => PLAT[p]).filter(Boolean))];
    return `<div class="card"><b><a href="${esc(itchUrl(g[1]))}" target="_blank" rel="noopener">${esc(g[0])}</a></b> ${have ? '<span class="tag ok">Installed</span>' : ''}
      <p>${esc(g[3] || '')}</p><div style="margin-top:6px">${plats.map(p => `<span class="tag">${p}</span>`).join('')}<span class="tag">by ${esc(g[1].split('~')[0])}</span></div></div>`;
  };
  if (mode === 'retro') {
    const s = d.sys[c.system] || { all: [], genres: {} };
    const tag = (ITCH_TAGS[c.system] || [])[0];
    const gopts = `<option value="all">Top rated (all genres)</option>` + Object.keys(GENRES).filter(g => s.genres[g]).map(g => `<option value="${g}" ${g === c.genre ? 'selected' : ''}>${GENRES[g]} (${s.genres[g].length})</option>`).join('');
    if (c.genre !== 'all' && !s.genres[c.genre]) c.genre = 'all';
    const ids = c.genre === 'all' ? s.all : s.genres[c.genre];
    const more = tag ? `https://itch.io/games/top-rated/free/${c.genre === 'all' ? '' : 'genre-' + c.genre + '/'}tag-${tag}` : '';
    body = `<div class="panel"><div class="row">
      <label>System <select id="frSystem">${sysKeys.map(k => `<option value="${k}" ${k === c.system ? 'selected' : ''}>${esc(SYSTEMS[k]?.label || k)}${foldersFor(k).length || S.folders.includes(k) ? '' : ' (no folder)'}</option>`).join('')}</select></label>
      <label>Genre <select id="frGenre">${gopts}</select></label><div class="grow"></div>${more ? `<a href="${more}" target="_blank" rel="noopener">See more on itch.io ↗</a>` : ''}</div>
      <p class="muted">Homebrew tagged for this system on itch.io, filtered to free games without Windows, macOS, Linux or Android builds (those are usually PC games in a retro style). Check each page for the ROM file; save it into <code>roms\\${esc(foldersFor(c.system)[0] || c.system)}</code>.</p>
      <div class="cards">${(ids || []).map(i => card(i, c.system)).join('') || '<div class="empty">No games in this genre.</div>'}</div></div>`;
  } else {
    const genres = Object.keys(GENRES).filter(g => d.pc[g]);
    const gopts = `<option value="all">All genres</option>` + genres.map(g => `<option value="${g}" ${g === c.pcGenre ? 'selected' : ''}>${GENRES[g]}</option>`).join('');
    const show = c.pcGenre === 'all' ? genres : [c.pcGenre];
    body = `<div class="panel"><div class="row"><label>Genre <select id="pcGenre">${gopts}</select></label></div>
      <p class="muted">Top-rated free games on itch.io by genre. Windows games can be added to RetroBat's <code>roms\\windows</code> folder.</p>
      ${show.map(g => `<h3>${GENRES[g]} <a class="muted" style="font-weight:400;font-size:12px" href="https://itch.io/games/top-rated/free/genre-${g}" target="_blank" rel="noopener">more ↗</a></h3><div class="cards">${d.pc[g].map(i => card(i, 'windows')).join('')}</div>`).join('')}</div>`;
  }
  const links = `<div class="panel"><h2>More places for free and homebrew games</h2><div class="cards">
    <div class="card"><b><a href="https://hh.gbdev.io/" target="_blank" rel="noopener">Homebrew Hub</a></b><p>Thousands of free Game Boy, Game Boy Color, GBA and NES homebrew ROMs, filterable by genre tag.</p></div>
    <div class="card"><b><a href="https://www.lexaloffle.com/bbs/?cat=7" target="_blank" rel="noopener">PICO-8 BBS</a></b><p>Every PICO-8 cart is free; sort by featured or top rated.</p></div>
    <div class="card"><b><a href="https://tic80.com/play" target="_blank" rel="noopener">TIC-80</a></b><p>Free fantasy-console games, browsable by category.</p></div>
    <div class="card"><b><a href="https://wasm4.org/play/" target="_blank" rel="noopener">WASM-4</a></b><p>Free tiny games for the WASM-4 fantasy console.</p></div>
    <div class="card"><b><a href="https://www.romhacking.net/homebrew/" target="_blank" rel="noopener">Romhacking.net homebrew</a></b><p>Free homebrew archive covering many classic consoles.</p></div>
    <div class="card"><b><a href="https://itch.io/games/free" target="_blank" rel="noopener">itch.io free games</a></b><p>Browse everything free, then narrow by genre or tag.</p></div>
  </div></div>`;
  return head + body + links;
}

function viewSettings() {
  const p = S.config.paths;
  const lists = S.config.customLists.map(l => `<tr><td>${esc(l.name)}</td><td>${l.system === '*' ? 'Any system' : esc(SYSTEMS[l.system]?.label || l.system)}</td><td>${l.items.length}</td><td class="right"><button class="small" data-dellist="${esc(l.id)}">Remove</button></td></tr>`).join('');
  const cfg = JSON.stringify({ ...S.config, wishlist: `${Object.values(S.config.wishlist).flat().length} games`, customLists: `${S.config.customLists.length} lists` }, null, 2);
  return `<div class="panel"><h2>Folders</h2><div class="kv">
    <div>This page's folder</div><div>${esc(p.appFolder || S.handles.app.name)} ${S.samePlace === false ? '<span class="tag warn">this page is not in that folder</span>' : S.samePlace ? '<span class="tag ok">config saved here</span>' : ''} ${S.writable ? '' : '<span class="tag no">read-only</span>'}</div><div><button class="small" data-act="pickApp">Change…</button></div>
    <div>RetroBat / Batocera folder</div><div>${p.retrobatFolder ? esc(p.retrobatFolder) : '<span class="tag no">not found</span>'}</div><div><button class="small" data-act="pickRetro">Choose…</button></div>
    <div>ROMs folder</div><div>${p.romsFolder ? esc(p.romsFolder) + ` <span class="muted">(${S.folders.length} system folders)</span>` : '<span class="tag no">not found</span>'}</div><div></div>
    <div>RGSX database folder</div><div>${p.rgsxFolder ? esc(p.rgsxFolder) : '<span class="tag no">not found</span>'} ${S.catalog ? `<span class="muted">read ${fmtDate(S.catalog.at)}</span>` : ''}</div><div><button class="small" data-act="pickRgsx">Choose…</button> ${S.dirs.rgsx ? '<button class="small" data-act="reloadCat">Reload catalogue</button>' : ''}</div>
  </div></div>
  <div class="panel"><h2>Top lists</h2>
    <p class="muted">The page ships with a copy of every list (made ${fmtDate(SNAPSHOT.fetched)}). "Update" downloads fresh copies from Wikidata and Wikipedia and stores them in <code>${CACHE_DIR}</code>.</p>
    <div class="row"><button data-act="refreshAll">Update all lists for my systems</button><button data-act="clearLists">Use the bundled lists again</button></div>
    <h3>Custom lists</h3><p class="muted">Paste or load a list of game titles (one per line, best first; for CSV the first column is used). Custom lists appear as a source on the Top N page.</p>
    ${lists ? `<table><thead><tr><th>Name</th><th>System</th><th>Games</th><th></th></tr></thead><tbody>${lists}</tbody></table>` : ''}
    <div class="row" style="margin-top:8px"><input type="text" id="clName" placeholder="List name, e.g. Retro Gamer Top 100" style="flex:1"><select id="clSystem"><option value="*">Any system</option>${Object.keys(SYSTEMS).map(k => `<option value="${k}">${esc(SYSTEMS[k].label)}</option>`).join('')}</select></div>
    <textarea id="clItems" placeholder="Super Mario Bros. 3&#10;The Legend of Zelda&#10;Mega Man 2"></textarea>
    <div class="row"><button class="primary" data-act="addList">Add list</button><label class="muted">or load a file <input type="file" id="clFile" accept=".txt,.csv,.json"></label></div></div>
  <div class="panel"><h2>itch.io data</h2>
    <p class="muted">itch.io doesn't let other pages read its feeds, so the free-games list is bundled (${fmtDate(ITCH_BUNDLED.fetched)}). To refresh it: open <a href="https://itch.io" target="_blank" rel="noopener">itch.io</a>, open the browser console (F12 → Console), paste the refresh script and press Enter. It downloads <code>itch-free.json</code>; import that file here.</p>
    <div class="row"><button data-act="copyItch">Copy refresh script</button><label>Import <input type="file" id="itchFile" accept=".json"></label>${S.itch ? `<span class="tag ok">Using refreshed data from ${fmtDate(S.itch.fetched)}</span><button class="small" data-act="dropItch">Use bundled data</button>` : ''}</div></div>
  <div class="panel"><h2>General</h2><div class="row">
    <label><input type="checkbox" id="optIntro" ${S.config.showGettingStarted ? 'checked' : ''}> Show the getting started page when this page opens</label>
    <button data-act="intro">Open getting started</button><button data-act="forget">Forget folders</button></div>
    <h3>Config file <code>${CONFIG_NAME}</code></h3><pre>${esc(cfg)}</pre></div>`;
}

/* ------------------------------------------------------------------ getting started */
function showIntro() {
  const pl = pageLocation(); const o = $('#intro');
  o.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="introTitle">
    <h2 id="introTitle">Getting started</h2>
    <p class="muted">RGSX Library Checker lists the ROMs you have installed, checks each system against Top 10–500 lists, and suggests top free games from itch.io. It reads the game catalogue that <a href="https://github.com/RetroGameSets/RGSX" target="_blank" rel="noopener">RGSX</a> keeps, so you can see which missing games RGSX can fetch for you.</p>
    <ol>
      <li><b>Put this file in your RetroBat folder</b> (for example <code>C:\\RetroBat</code>), or in the Batocera <code>share</code> folder. ${pl.folder ? `It's currently in <code>${esc(pl.folder)}</code>.` : ''}</li>
      <li><b>Open it in Chrome or Edge</b> and choose <b>${pl.folder ? 'this page\'s folder' : 'the folder that holds this page'}</b>. Allow the browser to <i>view and edit</i> files: the page only writes its own <code>${CONFIG_NAME}</code> and a <code>${CACHE_DIR}</code> folder.</li>
      <li>The <code>roms</code> folder and the RGSX database (<code>saves\\ports\\rgsx\\rgsx.sqlite3</code>) are found automatically. If they're somewhere else, the page asks you to choose them, or use <b>Settings</b>.</li>
      <li>Use <b>Library</b> to browse installed games, <b>Top N</b> to compare a system with a top list from your chosen source, and <b>Free games</b> for top free homebrew and PC games by genre.</li>
    </ol>
    <p class="muted">Each time you open the page, the browser may ask you to allow access again; that's a browser safety rule. Nothing is uploaded: the only internet requests are list updates from Wikidata and Wikipedia when you ask for them.</p>
    <div class="foot"><label><input type="checkbox" id="introHide" ${S.config.showGettingStarted && !ls.get('rlc.hideIntro') ? '' : 'checked'}> Don't show this again</label>
      <div class="row">${!S.handles.app && fsSupported ? `<button class="primary" data-act="introPick">Choose this page's folder…</button>` : ''}<button ${S.handles.app ? 'class="primary"' : ''} data-act="introClose">Close</button></div></div></div>`;
  o.classList.remove('hidden');
}
function closeIntro() {
  const hide = $('#introHide')?.checked;
  S.config.showGettingStarted = !hide; ls.set('rlc.hideIntro', hide ? '1' : null);
  S.introDismissed = true; $('#intro').classList.add('hidden'); saveConfig();
}

/* ------------------------------------------------------------------ actions */
function download(name, text, type = 'text/csv') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function parseListText(text, fileName = '') {
  let items = [];
  if (/\.json$/i.test(fileName) || /^\s*[\[{]/.test(text)) {
    try { const j = JSON.parse(text); const arr = Array.isArray(j) ? j : (j.items || j.games || []); items = arr.map(x => typeof x === 'string' ? x : (x.t || x.title || x.name || '')); } catch { }
  }
  if (!items.length) items = text.split(/\r?\n/).map(l => {
    if (/\.csv$/i.test(fileName) || l.includes(',')) { const m = l.match(/^\s*"((?:[^"]|"")*)"|^([^,]*)/); l = (m[1] ?? m[2] ?? '').replace(/""/g, '"'); }
    return l.replace(/^\s*\d+[.)]\s+/, '').trim();
  });
  return items.filter(Boolean).filter((t, i, a) => a.indexOf(t) === i);
}
const actions = {
  pickApp, pickRetro, pickRgsx, reconnect,
  intro: () => { S.introDismissed = false; showIntro(); },
  introPick: () => { closeIntro(); pickApp(); },
  introClose: closeIntro,
  scanAll: () => scanAll(),
  scanOne: async () => { S.busy = 'Scanning ' + sysLabel(S.sel) + '…'; renderStatus(); await scanFolder(S.sel); S.busy = ''; await cacheWrite('scan.json', { v: SCAN_VERSION, at: new Date().toISOString(), scan: S.scan }); render(); },
  more: () => { S.libLimit += 1000; render(); },
  toTop: () => { S.config.topN.system = FOLDER2SYS[S.sel]; S.tab = 'topn'; saveConfig(); render(); },
  reloadCat: () => loadCatalog(true),
  refreshLists: () => {
    const c = S.config.topN; const sys = c.system && c.system !== '*' ? [c.system] : topSystems();
    const src = c.source === 'blend' ? ['wikidata', 'sales', 'critics'] : [c.source];
    refreshLists(sys.filter(k => src.some(s => s === 'wikidata' ? SYSTEMS[k].wiki : s === 'sales' ? SYSTEMS[k].sales : SYSTEMS[k].best)), src);
  },
  refreshAll: () => refreshLists(topSystems(), ['wikidata', 'sales', 'critics']),
  clearLists: async () => { S.lists = {}; await cacheWrite('toplists.json', {}); render(); },
  exportMissing: () => {
    const c = S.config.topN; const r = compareSystem(c.system, c.source, +c.size); if (!r) return;
    const q = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
    const lines = [['Rank', 'Title', 'Year', 'In RGSX catalogue'].join(',')].concat(r.items.filter(x => !x.have).map(x => [x.rank, q(x.e.t), x.e.y || '', x.cat ? q(x.cat[0].f) : ''].join(',')));
    download(`missing-${c.system}-top${c.size}-${c.source.replace(/\W/g, '')}.csv`, lines.join('\r\n'));
  },
  addList: () => {
    const name = $('#clName').value.trim() || 'My list'; const items = parseListText($('#clItems').value);
    if (!items.length) return toast('Paste at least one game title.', 'warn');
    S.config.customLists.push({ id: Date.now().toString(36), name, system: $('#clSystem').value, items, added: new Date().toISOString() });
    saveConfig(); toast(`Added "${name}" with ${items.length} games.`);
  },
  copyItch: async () => { try { await navigator.clipboard.writeText(ITCH_SCRIPT); toast('Refresh script copied. Paste it into the console on itch.io.'); } catch { download('itch-refresh.js', ITCH_SCRIPT, 'text/javascript'); } },
  dropItch: async () => { S.itch = null; await cacheWrite('itch-free.json', null); render(); },
  forget: async () => { for (const k of ['app', 'retro', 'rgsx']) await idb.set(k, undefined); S.handles = { app: null, retro: null, rgsx: null }; S.dirs = { roms: null, rgsx: null }; S.scan = {}; S.catalog = null; S.folders = []; render(); },
};
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-sel],[data-sys],[data-star],[data-dellist],[data-tab]'); if (!t) return;
  if (t.dataset.tab) { S.tab = t.dataset.tab; render(); return; }
  if (t.dataset.act) { actions[t.dataset.act]?.(); return; }
  if (t.dataset.sel) { S.sel = t.dataset.sel; S.libFilter = ''; S.libLimit = 500; render(); return; }
  if (t.dataset.sys) { S.config.topN.system = t.dataset.sys; saveConfig(); render(); return; }
  if (t.dataset.star) {
    const k = S.config.topN.system, l = S.config.wishlist[k] ||= []; const i = l.indexOf(t.dataset.star);
    i >= 0 ? l.splice(i, 1) : l.push(t.dataset.star); if (!l.length) delete S.config.wishlist[k]; saveConfig(); render(); return;
  }
  if (t.dataset.dellist) { S.config.customLists = S.config.customLists.filter(l => l.id !== t.dataset.dellist); if (S.config.topN.source === 'custom:' + t.dataset.dellist) S.config.topN.source = 'wikidata'; saveConfig(); render(); }
});
document.addEventListener('change', async e => {
  const t = e.target, c = S.config;
  if (t.id === 'tnSystem') { c.topN.system = t.value; }
  else if (t.id === 'tnSource') c.topN.source = t.value;
  else if (t.id === 'tnSize') c.topN.size = +t.value;
  else if (t.id === 'tnShow') c.topN.show = t.value;
  else if (t.id === 'sysShow') c.library.show = t.value;
  else if (t.name === 'fmode') c.free.mode = t.value;
  else if (t.id === 'frSystem') { c.free.system = t.value; c.free.genre = 'all'; }
  else if (t.id === 'frGenre') c.free.genre = t.value;
  else if (t.id === 'pcGenre') c.free.pcGenre = t.value;
  else if (t.id === 'optIntro') { c.showGettingStarted = t.checked; ls.set('rlc.hideIntro', t.checked ? null : '1'); }
  else if (t.id === 'clFile' && t.files[0]) { const f = t.files[0]; $('#clItems').value = parseListText(await f.text(), f.name).join('\n'); if (!$('#clName').value) $('#clName').value = f.name.replace(/\.\w+$/, ''); return; }
  else if (t.id === 'itchFile' && t.files[0]) {
    try { const j = JSON.parse(await t.files[0].text()); if (!j.games || !j.sys || !j.pc) throw new Error('not an itch-free.json file'); S.itch = j; await cacheWrite('itch-free.json', j); toast(`Imported itch.io data from ${fmtDate(j.fetched)}.`); }
    catch (err) { toast('Import failed: ' + err.message, 'err'); }
  } else return;
  saveConfig(); render();
});
let filterTimer = null;
document.addEventListener('input', e => {
  if (e.target.id !== 'libFilter' && e.target.id !== 'sysFilter') return;
  const id = e.target.id; S[id] = e.target.value; S.libLimit = 500;
  clearTimeout(filterTimer); filterTimer = setTimeout(() => { render(); const el = document.getElementById(id); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 200);
});
$('#helpBtn').addEventListener('click', () => { S.introDismissed = false; showIntro(); });
$('#intro').addEventListener('click', e => { if (e.target.id === 'intro') closeIntro(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#intro').classList.contains('hidden')) closeIntro(); });

/* ------------------------------------------------------------------ start */
(async function start() {
  if (ls.get('rlc.hideIntro')) S.config.showGettingStarted = false;
  if (fsSupported) {
    S.handles.app = (await idb.get('app')) || null;
    S.handles.retro = (await idb.get('retro')) || null;
    S.handles.rgsx = (await idb.get('rgsx')) || null;
    await connect(false);
  }
  render();
})();
