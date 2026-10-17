'use strict';
/* RGSX Library Checker: shows the ROMs installed in a RetroBat / Batocera library, compares each system
   against top lists, and lists top free games from itch.io. Runs from a local file in Chrome or Edge. */

const CONFIG_NAME = 'rgsx-library-checker.config.json';
const CACHE_DIR = 'rgsx-library-checker-cache';
const TOP_SIZES = [10, 50, 100, 200, 500];
const SOURCE_INFO = {
  wikidata:   { name: 'Most notable (Wikidata)', group: 'built-in', about: 'Games on the platform ranked by how many Wikipedia language editions cover them. Open CC0 data; works for almost every system.' },
  pageviews:  { name: 'Most read on Wikipedia (12 months)', group: 'built-in', about: 'The same games ranked by English Wikipedia page views over the last 12 full months: what people are reading about now. Multi-platform hits rank high.' },
  exclusives: { name: 'Notable exclusives (Wikidata)', group: 'built-in', about: 'Like "Most notable", but only games whose only listed platform is this one, so ports of Tetris and Doom don\'t crowd the list.' },
  reviews:    { name: 'Review scores (Wikidata)', group: 'built-in', about: 'Review scores Wikidata records for this platform\'s version (Metacritic, GameRankings, magazines), averaged and ranked with a Bayesian average. Strong for 16-bit computers, thin for some consoles.' },
  sales:      { name: 'Best-selling (Wikipedia)', group: 'built-in', about: 'The "List of best-selling … video games" article for the platform, in sales order. Only major consoles have one.' },
  critics:    { name: "Critics' all-time best (Wikipedia)", group: 'built-in', about: 'Wikipedia\'s "List of video games listed among the best", filtered to this platform. Short lists, high quality.' },
  blend:      { name: 'Blended (all built-in sources)', group: 'built-in', about: 'Every built-in list for the system combined with reciprocal-rank fusion: games that rank high in several lists rise to the top.' },
  ra:         { name: 'Most played (RetroAchievements)', group: 'api', service: 'ra', about: 'Number of RetroAchievements players per game. Needs your free RetroAchievements web API key (Settings > API keys). Checks the games that appear in the built-in lists, so it takes a few minutes per system and is cached.' },
  rawg_rating:{ name: 'User rating (RAWG)', group: 'api', service: 'rawg', about: 'RAWG users\' ratings, highest first, games with at least 5 ratings. Needs a free RAWG API key.' },
  rawg_meta:  { name: 'Metacritic score (RAWG)', group: 'api', service: 'rawg', about: 'Metacritic scores held by RAWG, highest first. Needs a free RAWG API key.' },
  rawg_added: { name: 'Most added to collections (RAWG)', group: 'api', service: 'rawg', about: 'How many RAWG users have the game in their library: a popularity measure. Needs a free RAWG API key.' },
};
const BUILTIN = ['wikidata', 'pageviews', 'exclusives', 'reviews', 'sales', 'critics'];
const API_SOURCES = ['ra', 'rawg_rating', 'rawg_meta', 'rawg_added'];
const SERVICES = {
  ra: { name: 'RetroAchievements', keyName: 'Web API key', help: 'Sign in at retroachievements.org, open Settings, and copy the "Web API Key" under Keys.', link: 'https://retroachievements.org/settings', test: k => ApiSources.raGet('API_GetConsoleIDs.php', {}, k) },
  rawg: { name: 'RAWG', keyName: 'API key', help: 'Create a free account at rawg.io and request a key on the API page.', link: 'https://rawg.io/apidocs', test: k => ApiSources.rawgGet('platforms', { page_size: 1 }, k) },
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
const SCAN_VERSION = 3; // bump when scanning rules change so old scan caches are ignored

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

// Keep a rolling log of errors/warnings so testers can copy a full diagnostic.
function logDiag(kind, msg, extra) {
  try { (S.diaglog ||= []).push({ t: new Date().toISOString(), kind, msg: String(msg), extra: extra ? String(extra) : '' }); if (S.diaglog.length > 60) S.diaglog.shift(); } catch { }
}
window.addEventListener('error', e => logDiag('js-error', e.message || 'error', (e.filename || '') + ':' + (e.lineno || '') + (e.error && e.error.stack ? '\n' + e.error.stack : '')));
window.addEventListener('unhandledrejection', e => { const r = e.reason || {}; logDiag('promise-rejection', r.message || r, r.stack || ''); });

function defaultConfig() {
  return {
    app: 'RGSX Library Checker', configVersion: 1, showGettingStarted: true,
    paths: { appFolder: '', retrobatFolder: '', romsFolder: '', rgsxFolder: '' },
    topN: { source: 'wikidata', size: 100, system: '', show: 'all' },
    lang: 'en', library: { show: 'all' },
    free: { mode: 'retro', system: '', genre: 'all', pcGenre: 'all', view: 'tile', hhApi: '' },
    download: { regions: [], langs: [] },
    customLists: [], wishlist: {}, vault: { mode: 'device', items: {} }, updated: '',
  };
}

/* ------------------------------------------------------------------ helpers */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtDate = s => { try { return new Date(s).toLocaleDateString(LANG === 'en' ? undefined : LANG, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return s; } };
const extOf = n => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
const stripExt = n => n.replace(/\.(?:p8\.png|[a-z0-9]{1,5})$/i, '');
/* Browser check. The page needs the File System Access API (folder picker + persistent handles), which only
   Chromium-based desktop browsers have: Chrome, Edge, Opera, Vivaldi and Chromium on Windows, macOS and Linux.
   Brave has it switched off by default. Firefox, Safari and every phone or tablet browser can't open folders. */
const ENV = (() => {
  const ua = navigator.userAgent || '', touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const os = /Windows/i.test(ua) ? 'Windows' : /iPhone|iPad|iPod/.test(ua) || touchMac ? 'iOS' : /Android/i.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux|X11/i.test(ua) ? 'Linux' : '';
  const name = navigator.brave ? 'Brave' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Vivaldi/.test(ua) ? 'Vivaldi'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const api = 'showDirectoryPicker' in window && typeof FileSystemHandle !== 'undefined' && 'queryPermission' in FileSystemHandle.prototype;
  const ok = api && 'indexedDB' in window && !!(window.crypto && crypto.subtle);
  return { os, name, mobile: os === 'iOS' || os === 'Android', brave: !!navigator.brave, ok };
})();
const fsSupported = ENV.ok;
function browserWarning() {
  if (ENV.ok) return '';
  const where = [ENV.name, ENV.os].filter(Boolean).join(' · ');
  let advice;
  if (ENV.mobile) advice = `<p>Phones and tablets can't give a web page access to folders. Open this page on a Windows, Mac or Linux computer, in Chrome or Edge.</p>`;
  else if (ENV.brave) advice = `<p>Brave switches folder access off. Open <code>brave://flags/#file-system-access-api</code>, set it to <b>Enabled</b>, restart Brave and reopen this page. Or use Chrome or Edge.</p>`;
  else {
    const list = ENV.os === 'Windows' ? '<b>Microsoft Edge</b> (already on your PC) or <b>Google Chrome</b>'
      : ENV.os === 'macOS' ? '<b>Google Chrome</b> or <b>Microsoft Edge</b> for Mac (Safari can\'t open folders)'
      : ENV.os === 'Linux' ? '<b>Google Chrome</b>, <b>Chromium</b> or <b>Microsoft Edge</b> for Linux (Firefox can\'t open folders)'
      : '<b>Google Chrome</b> or <b>Microsoft Edge</b>';
    advice = `<p>Open this file in ${list}. Opera and Vivaldi work too.</p>
      <p class="row"><a class="tag" href="https://www.google.com/chrome/" target="_blank" rel="noopener">Get Chrome ↗</a> <a class="tag" href="https://www.microsoft.com/edge/download" target="_blank" rel="noopener">Get Edge ↗</a></p>`;
  }
  return `<div class="notice err" role="alert" id="browserWarning"><b>This browser can't run RGSX Library Checker</b>${where ? ` <span translate="no">(${esc(where)})</span>` : ''}
    <p>The page needs to open your RetroBat or Batocera folder, which only Chrome, Edge and other Chromium-based browsers allow on Windows, macOS and Linux. Help and Free games still work here.</p>${advice}</div>`;
}
const D = s => `<span translate="no">${esc(fmtDate(s))}</span>`; // dates in HTML, kept out of text matching
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
  if (kind === 'err' || kind === 'warn') logDiag(kind, msg);
  S.errors.unshift({ msg, kind, at: Date.now() }); S.errors = S.errors.slice(0, 5); render();
}
// A message with names in it: translated as a whole sentence (see T in i18n.js).
function toastT(tpl, vars, kind = 'info') {
  if (kind === 'err' || kind === 'warn') logDiag(kind, T(tpl, vars));
  S.errors.unshift({ html: T(tpl, vars), kind, at: Date.now() }); S.errors = S.errors.slice(0, 5); render();
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
// A folder counts as a roms folder when it holds known system folders (one is enough when it's called "roms").
async function looksLikeRoms(d, need = 1) {
  if (!d) return false; let n = 0;
  try { for await (const [name, h] of d.entries()) { if (h.kind === 'directory' && FOLDER2SYS[name.toLowerCase()]) n++; if (n >= need) return true; } } catch { }
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
      out.type = await detectInstall(base);
      out.rgsxApp = !!(await tryDir(roms, 'ports/RGSX'));
      return out;
    }
  }
  if (await looksLikeRoms(root, 3)) { out.roms = root; out.type = 'roms'; out.rgsxApp = !!(await tryDir(root, 'ports/RGSX')); }
  return out;
}
// RetroBat keeps retrobat.ini / RetroBat.exe in its root; a Batocera share has system/batocera.conf.
async function detectInstall(base) {
  if (await tryFile(base, 'retrobat.ini') || await tryFile(base, 'RetroBat.exe')) return 'retrobat';
  if (await tryFile(await tryDir(base, 'system'), 'batocera.conf')) return 'batocera';
  if (await tryDir(base, 'emulationstation')) return 'retrobat';
  return 'unknown';
}
async function isRgsxFolder(d) { return !!(await tryFile(d, 'rgsx.sqlite3')); }

function pageLocation() {
  if (location.protocol !== 'file:') return { file: '', folder: '' };
  let p = decodeURIComponent(location.pathname);
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1).replace(/\//g, '\\');
  else if (location.host) p = '\\\\' + location.host + p.replace(/\//g, '\\');   // network share: \\BATOCERA\share\...
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
    catch (e) { toastT('Could not write the config file: {error}', { error: e.message }, 'err'); }
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
// Download region/language preference as arrays, migrating the old single-value form.
function normDownload(d) {
  d = d || {};
  const regions = Array.isArray(d.regions) ? d.regions : (d.region && d.region !== 'any' ? [d.region] : []);
  const langs = Array.isArray(d.langs) ? d.langs : (d.lang && d.lang !== 'any' ? [d.lang] : []);
  return { regions: regions.filter(Boolean), langs: langs.filter(Boolean) };
}
function mergeConfig(c) {
  const d = defaultConfig();
  if (!c || typeof c !== 'object') return d;
  return { ...d, ...c, paths: { ...d.paths, ...(c.paths || {}) }, library: { ...d.library, ...(c.library || {}) }, topN: { ...d.topN, ...(c.topN || {}) }, free: { ...d.free, ...(c.free || {}) }, download: normDownload(c.download),
    customLists: Array.isArray(c.customLists) ? c.customLists : [], wishlist: c.wishlist && typeof c.wishlist === 'object' ? c.wishlist : {},
    vault: c.vault && c.vault.items ? c.vault : d.vault };
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
    if (!loc.roms) { toastT('"{folder}" does not look like a RetroBat / Batocera folder or a roms folder (no system folders such as nes or snes found).', { folder: h.name }, 'err'); return; }
    S.handles.retro = h; await idb.set('retro', h); await connect(false);
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'err'); }
}
async function pickRgsx() {
  try {
    const h = await window.showDirectoryPicker({ id: 'rlc-rgsx', mode: 'read' });
    if (!(await isRgsxFolder(h))) { toastT('No rgsx.sqlite3 in "{folder}". The RGSX database lives in saves\\ports\\rgsx inside your RetroBat or Batocera folder.', { folder: h.name }, 'err'); return; }
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
  if (cfg && cfg.lang && cfg.lang !== LANG) setLang(cfg.lang, false); else S.config.lang = LANG;
  const pl = pageLocation();
  S.config.paths.appFolder = pl.folder || app.name;
  S.samePlace = pl.file ? !!(await tryFile(app, pl.file)) : null;

  let loc = { roms: null, rgsx: null, retro: null };
  if (S.handles.retro && await perm(S.handles.retro, 'read', false)) loc = await locate(S.handles.retro);
  if (!loc.roms) { const l2 = await locate(app); if (l2.roms) { loc = l2; S.handles.retro = null; await idb.set('retro', undefined); } }
  S.dirs.roms = loc.roms; S.install = { type: loc.type || '', rgsxApp: !!loc.rgsxApp };
  S.dirs.rgsx = (S.handles.rgsx && await perm(S.handles.rgsx, 'read', false)) ? S.handles.rgsx : loc.rgsx;
  if (S.dirs.rgsx && !(await isRgsxFolder(S.dirs.rgsx))) S.dirs.rgsx = null;
  if (!S.dirs.rgsx) { S.catalog = null; S.catIndex = {}; }   // don't keep a catalogue from a previously chosen folder
  const here = pl.folder || app.name || "this page's folder";
  S.config.paths.retrobatFolder = loc.retro ? (S.handles.retro ? S.handles.retro.name : (loc.rel ? here + '\\' + loc.rel : here)) : '';
  S.config.paths.romsFolder = loc.roms ? (loc.retro ? 'roms' : loc.roms.name) : '';
  S.config.paths.rgsxFolder = S.dirs.rgsx ? (S.handles.rgsx ? S.handles.rgsx.name : 'saves/ports/rgsx') : '';
  saveConfig();

  S.lists = (await cacheRead('toplists.json')) || {};
  S.itch = await cacheRead('itch-free.json');
  const sc = await cacheRead('scan.json'); if (sc && sc.scan && sc.v === SCAN_VERSION) { S.scan = sc.scan; S.index = {}; }
  await listFolders();
  // First run (no config file yet): open the setup check, which fills in as the scan and catalogue finish.
  if (!cfg) { S.tab = 'settings'; S.setPage = 'check'; S.firstRunCheck = true; }
  render();
  if (S.dirs.rgsx) loadCatalog(false);
  if (S.dirs.roms && !Object.keys(S.scan).length) scanAll();
  if (!cfg) saveConfig();   // writes the config, so the check opens by itself only once
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
    // Scraped metadata used for matching: the game's name, its release year and its RetroAchievements ID.
    const tag = t => { const m = new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>').exec(g[1]); return m ? dec(m[1]) : ''; };
    const path = tag('path'); if (!path) continue;
    const meta = {}, name = tag('name'), date = tag('releasedate'), ra = tag('cheevosId');
    if (name) meta.n = name;
    if (/^(19[5-9]\d|20\d\d)/.test(date)) meta.y = +date.slice(0, 4);
    if (/^\d+$/.test(ra) && ra !== '0') meta.ra = +ra;
    if (Object.keys(meta).length) map.set(path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase(), meta);
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
  if (gl) for (const r of roms) { const m = gl.get(((r.d ? r.d + '/' : '') + r.f).toLowerCase()); if (m) Object.assign(r, m); }
  roms.sort((a, b) => (a.n || a.f).localeCompare(b.n || b.f));
  S.scan[folder] = { at: new Date().toISOString(), roms, gl: !!gl };
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
  const byKey = new Map(), byMain = new Map(), byRa = new Map();
  const add = (m, k, e) => { if (!k) return; let a = m.get(k); if (!a) m.set(k, a = []); a.push(e); };
  for (const e of entries) {
    for (const name of [e.n, cleanName(e.f)]) { if (!name) continue; add(byKey, norm(name), e); add(byMain, mainTitle(name), e); }
    if (e.ra) add(byRa, e.ra, e);
  }
  return { byKey, byMain, byRa };
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
    // Paired releases ("Pokémon Red and Blue", "Gold / Silver"): also try the first one. Only when the second part is a
    // single word, so "Battletoads & Double Dragon" doesn't match plain "Battletoads".
    const parts = t.split(/\s+(?:and|&)\s+|\s*\/\s*/);
    if (parts.length === 2 && parts[0].length > 3 && /^\S+$/.test(parts[1])) out.push(parts[0]);
  }
  return out;
}
// claimed: normalised titles of every game in the list being compared. A loose match (subtitle added or dropped) may
// not take a ROM that is exactly another game in that list: "Speedy Gonzales" stays with Speedy Gonzales, not with
// "Speedy Gonzales: Aztec Adventure".
function findIn(idx, e, claimed) {
  if (!idx) return null;
  // A RetroAchievements game ID from gamelist.xml (cheevosId) is an exact match for RetroAchievements lists.
  if (e.ra && idx.byRa) { const r = idx.byRa.get(e.ra); if (r) return r; }
  // With a scraped release year, a ROM can't be a game first released later (allowing a year for regional dates):
  // this stops "Street Fighter" (1987) counting as "Street Fighter: The Movie" (1995).
  const ok = r => { if (!r) return null; const f = e.y ? r.filter(x => !x.y || x.y >= e.y - 1) : r; return f.length ? f : null; };
  const c = candidates(e);
  for (const t of c) { const r = ok(idx.byKey.get(norm(t))); if (r) return r; }
  const own = new Set(c.map(norm));
  const loose = r => { r = ok(r); if (!r || !claimed) return r; const f = r.filter(x => ![x.n, cleanName(x.f)].some(n => n && claimed.has(norm(n)) && !own.has(norm(n)))); return f.length ? f : null; };
  for (const t of c) { const r = loose(idx.byMain.get(norm(t))); if (r) return r; }
  for (const t of c) { const m = mainTitle(t); if (m && m.split(' ').length > 1) { const r = loose(idx.byKey.get(m)); if (r) return r; } }
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
      if (c && c.sig === sig) { c.dbModified ||= Math.max(dbf.lastModified, walf ? walf.lastModified : 0); S.catalog = c; S.catIndex = {}; render(); return; }
    }
    S.busy = 'Reading the RGSX database…'; renderStatus();
    const SQL = await getSql();
    let bytes = new Uint8Array(await dbf.arrayBuffer());
    if (walf && walf.size > 32) { S.busy = 'Applying recent RGSX changes (WAL)…'; renderStatus(); bytes = applyWal(bytes, new Uint8Array(await walf.arrayBuffer())); }
    if (bytes[18] === 2) { bytes[18] = 1; bytes[19] = 1; }
    S.busy = 'Indexing the RGSX catalogue…'; renderStatus();
    const db = new SQL.Database(bytes); bytes = null;
    const platforms = {}, names = {}; let seq = null;
    try {
      try { const r = db.exec("SELECT value FROM schema_meta WHERE key = 'catalog_sync_sequence'"); seq = r.length ? r[0].values[0][0] : null; } catch { }
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
    S.catalog = { sig, at: new Date().toISOString(), dbModified: Math.max(dbf.lastModified, walf ? walf.lastModified : 0), seq, platforms, counts, sources: Object.fromEntries(Object.entries(names).map(([k, v]) => [k, [...v]])) };
    S.catIndex = {};
    await cacheWrite('rgsx-catalog.json', S.catalog);
  } catch (e) {
    toastT('Could not read the RGSX database: {error} (if RGSX is running, close it and press Reload catalogue).', { error: e.message }, 'err');
  } finally { S.busy = ''; render(); }
}

/* ------------------------------------------------------------------ encrypted API keys */
/* Keys are stored in the config file only as AES-GCM ciphertext.
   "device" mode: the AES key is a non-extractable WebCrypto key kept in this browser's IndexedDB, so the config file
   alone can't be decrypted anywhere else. "passphrase" mode: the AES key is derived from your passphrase with
   PBKDF2-SHA256 (310,000 rounds); nothing that can decrypt is stored, and you unlock once per visit. */
const b64 = { enc: u8 => btoa(String.fromCharCode(...new Uint8Array(u8))), dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)) };
const Vault = {
  key: null, plain: {},
  cfg() { return S.config.vault ||= { mode: 'device', items: {} }; },
  async deviceKey() {
    let k = await idb.get('vaultKey');
    if (!k) { k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await idb.set('vaultKey', k); }
    return k;
  },
  async passKey(pass, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  },
  async encrypt(key, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)); return { iv: b64.enc(iv), data: b64.enc(data) }; },
  async decrypt(key, box) { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(box.iv) }, key, b64.dec(box.data))); },
  async unlock(interactive = true) {
    if (this.key) return this.key;
    const v = this.cfg();
    if (v.mode !== 'passphrase') return this.key = await this.deviceKey();
    if (!interactive) return null;
    for (;;) {
      const r = await dialog({ title: 'Unlock API keys', body: 'Enter the passphrase that protects your API keys.', fields: [{ id: 'pass', label: 'Passphrase', type: 'password' }], ok: 'Unlock' });
      if (!r) return null;
      const k = await this.passKey(r.pass, b64.dec(v.salt));
      try { if ((await this.decrypt(k, v.check)) === 'rlc-ok') return this.key = k; } catch { }
      toast('That passphrase is wrong.', 'err');
    }
  },
  has(service) { return !!this.cfg().items[service]; },
  async get(service, interactive = true) {
    if (this.plain[service]) return this.plain[service];
    const box = this.cfg().items[service]; if (!box) return null;
    const k = await this.unlock(interactive); if (!k) return null;
    try { return this.plain[service] = await this.decrypt(k, box); }
    catch { toastT('The {svc} key can\'t be decrypted in this browser (it was saved on another device or browser). Enter it again in Settings > API keys.', { svc: SERVICES[service].name }, 'err'); return null; }
  },
  async set(service, text) {
    const k = await this.unlock(true); if (!k) return false;
    if (text) { this.cfg().items[service] = await this.encrypt(k, text); this.plain[service] = text; }
    else { delete this.cfg().items[service]; delete this.plain[service]; }
    saveConfig(); return true;
  },
  async setMode(mode) {
    const v = this.cfg(); if (v.mode === mode) return;
    const all = {}; for (const s of Object.keys(v.items)) { const t = await this.get(s); if (t == null) return toast('Unlock the keys first.', 'err'); all[s] = t; }
    let key;
    if (mode === 'passphrase') {
      const r = await dialog({ title: 'Protect API keys with a passphrase', body: 'Choose a passphrase. You will need it each time you open the page, and on any other computer that uses this config file. It can\'t be recovered if you forget it; you would just enter the API keys again.', fields: [{ id: 'p1', label: 'Passphrase', type: 'password' }, { id: 'p2', label: 'Repeat passphrase', type: 'password' }], ok: 'Use passphrase' });
      if (!r) return; if (r.p1.length < 8) return toast('Use at least 8 characters.', 'err'); if (r.p1 !== r.p2) return toast('The passphrases don\'t match.', 'err');
      const salt = crypto.getRandomValues(new Uint8Array(16)); key = await this.passKey(r.p1, salt);
      v.salt = b64.enc(salt); v.check = await this.encrypt(key, 'rlc-ok');
    } else { key = await this.deviceKey(); delete v.salt; delete v.check; }
    v.mode = mode; this.key = key; v.items = {};
    for (const [s, t] of Object.entries(all)) v.items[s] = await this.encrypt(key, t);
    saveConfig(); render();
  },
};

/* ------------------------------------------------------------------ dialog */
function dialog({ title, body, fields = [], ok = 'OK', cancel = 'Cancel' }) {
  return new Promise(res => {
    const o = document.createElement('div'); o.className = 'overlay';
    o.innerHTML = `<form class="modal" style="max-width:460px"><h2>${esc(title)}</h2><p class="muted">${esc(body)}</p>
      ${fields.map(f => `<label style="display:block;margin:10px 0">${esc(f.label)}<br><input type="${f.type || 'text'}" name="${f.id}" style="width:100%" autocomplete="off" value="${esc(f.value || '')}"></label>`).join('')}
      <div class="foot"><span></span><div class="row"><button type="button" data-x>${esc(cancel)}</button><button class="primary" type="submit">${esc(ok)}</button></div></div></form>`;
    const done = v => { o.remove(); res(v); };
    o.querySelector('[data-x]').onclick = () => done(null);
    o.querySelector('form').onsubmit = e => { e.preventDefault(); const v = {}; for (const f of fields) v[f.id] = o.querySelector(`[name="${f.id}"]`).value; done(v); };
    document.body.appendChild(o); translateDom(o); const first = o.querySelector('input'); if (first) first.focus();
  });
}

/* ------------------------------------------------------------------ API sources (need a key) */
const ApiSources = {
  async raGet(endpoint, params, key) {
    const q = new URLSearchParams({ ...params, y: key });
    const r = await fetch('https://retroachievements.org/API/' + endpoint + '?' + q);
    if (r.status === 401 || r.status === 403) throw new Error('RetroAchievements rejected the API key');
    if (r.status === 429) throw new Error('RetroAchievements rate limit reached; try again later');
    if (!r.ok) throw new Error('RetroAchievements returned HTTP ' + r.status);
    return r.json();
  },
  async rawgGet(path, params, key) {
    const q = new URLSearchParams({ ...params, key });
    let r; try { r = await fetch('https://api.rawg.io/api/' + path + '?' + q); } catch { throw new Error('RAWG could not be reached (or blocked the request)'); }
    if (r.status === 401 || r.status === 403) throw new Error('RAWG rejected the API key');
    if (!r.ok) throw new Error('RAWG returned HTTP ' + r.status);
    return r.json();
  },
  async ra(sysKey, key, progress) {
    const id = SYSTEMS[sysKey].ra; if (!id) return [];
    const games = (await this.raGet('API_GetGameList.php', { i: id, f: 1 }, key)).filter(g => !/^~|\[Subset/i.test(g.Title));
    const idx = buildIndex(games.map(g => ({ f: g.Title, id: g.ID })));
    const pick = new Map();
    for (const src of BUILTIN) { const l = rawList(src, sysKey); if (l) for (const e of l.items) { const m = findIn(idx, e); if (m) pick.set(m[0].id, m[0].f); } }
    if (pick.size < 100) games.slice().sort((a, b) => b.Points - a.Points).slice(0, 150).forEach(g => pick.set(g.ID, g.Title));
    const list = [...pick.entries()].slice(0, 400), out = [];
    for (let i = 0; i < list.length; i++) {
      const [gid, title] = list[i];
      try { const g = await this.raGet('API_GetGameExtended.php', { i: gid }, key); out.push({ id: gid, t: g.Title || title, p: +(g.NumDistinctPlayers ?? g.numDistinctPlayers ?? ((g.NumDistinctPlayersCasual || 0) + (g.NumDistinctPlayersHardcore || 0))) || 0 }); }
      catch (e) { if (/rejected|rate limit/.test(e.message)) throw e; }
      progress && progress(i + 1, list.length); await sleep(350);
    }
    return out.filter(g => g.p > 0).sort((a, b) => b.p - a.p).map(g => ({ t: g.t.replace(/\s*\|.*$/, ''), ra: g.id, n: g.p.toLocaleString() + ' players' }));
  },
  rawgPlatforms: null,
  async rawgPlatform(sysKey, key) {
    const name = SYSTEMS[sysKey].rawg; if (!name) return null;
    if (!this.rawgPlatforms) {
      const all = []; let page = 1, more = true;
      while (more && page < 5) { const j = await this.rawgGet('platforms', { page_size: 50, page }, key); all.push(...j.results); more = !!j.next; page++; }
      this.rawgPlatforms = all;
    }
    const p = this.rawgPlatforms.find(x => x.name.toLowerCase() === name.toLowerCase());
    return p ? p.id : null;
  },
  async rawg(sysKey, key, ordering, progress) {
    const pid = await this.rawgPlatform(sysKey, key); if (!pid) return [];
    const out = [];
    for (let page = 1; page <= 13 && out.length < 500; page++) {
      const j = await this.rawgGet('games', { platforms: pid, ordering, page_size: 40, page, ...(ordering === '-metacritic' ? { metacritic: '1,100' } : {}) }, key);
      for (const g of j.results) {
        if (ordering === '-rating' && (g.ratings_count || 0) < 5) continue;
        const n = ordering === '-metacritic' ? `Metacritic ${g.metacritic}` : ordering === '-rating' ? `${g.rating}/5 from ${g.ratings_count} ratings` : `${(g.added || 0).toLocaleString()} collections`;
        out.push({ t: g.name, y: g.released ? +g.released.slice(0, 4) : undefined, n });
      }
      progress && progress(page, 13);
      if (!j.next) break; await sleep(250);
    }
    if (ordering === '-rating') out.sort((a, b) => parseFloat(b.n) - parseFloat(a.n));
    return out;
  },
};
const API_FETCH = {
  ra: (k, key, p) => ApiSources.ra(k, key, p),
  rawg_rating: (k, key, p) => ApiSources.rawg(k, key, '-rating', p),
  rawg_meta: (k, key, p) => ApiSources.rawg(k, key, '-metacritic', p),
  rawg_added: (k, key, p) => ApiSources.rawg(k, key, '-added', p),
};
function sourceAvailable(src, sysKey) {
  const sys = SYSTEMS[sysKey] || {};
  if (src === 'sales') return !!sys.sales; if (src === 'critics') return !!sys.best;
  if (src === 'ra') return !!sys.ra; if (src.startsWith('rawg')) return !!sys.rawg;
  if (src === 'blend') return true;
  return !!(sys.wiki || []).length;
}

/* ------------------------------------------------------------------ top lists */
function customListsFor(sysKey) { return S.config.customLists.filter(l => l.system === '*' || l.system === sysKey); }
function sourceOptions(sysKey) {
  const o = [];
  for (const k of Object.keys(SOURCE_INFO)) {
    if (sysKey && !sourceAvailable(k, sysKey)) continue;
    const l = sysKey ? getList(k, sysKey) : null;
    const needsKey = SOURCE_INFO[k].group === 'api' && !Vault.has(SOURCE_INFO[k].service);
    o.push([k, SOURCE_INFO[k].name + (l ? ` (${l.items.length})` : needsKey ? ' (needs API key)' : sysKey ? ' (not downloaded)' : '')]);
  }
  for (const l of customListsFor(sysKey)) o.push(['custom:' + l.id, (l.url ? 'Website: ' : 'Custom: ') + l.name + ` (${l.items.length})`]);
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
    return l ? { items: l.items.map(t => ({ t })), fetched: l.added, origin: 'custom', url: l.url } : null;
  }
  if (source !== 'blend') {
    const l = rawList(source, sysKey);
    if (!l || !['pageviews', 'exclusives', 'reviews'].includes(source)) return l;
    // These lists share their games with the Wikidata list; borrow its alternative titles for matching.
    const wd = rawList('wikidata', sysKey); if (!wd) return l;
    const alts = new Map(wd.items.filter(e => e.a).map(e => [norm(e.t), e.a]));
    return { ...l, items: l.items.map(e => e.a || !alts.has(norm(e.t)) ? e : { ...e, a: alts.get(norm(e.t)) }) };
  }
  const K = 20, score = new Map(); let any = 0, fetched = '';
  for (const src of BUILTIN) {
    const l = rawList(src, sysKey); if (!l) continue; any++; fetched = fetched > l.fetched ? fetched : l.fetched;
    l.items.slice(0, 500).forEach((e, r) => {
      const k = norm(e.t); let s = score.get(k);
      if (!s) score.set(k, s = { e: { t: e.t, y: e.y, a: [...(e.a || [])] }, v: 0, n: 0, from: [] });
      if (src === 'sales' || src === 'critics') s.e.t = e.t;
      if (!s.e.y && e.y) s.e.y = e.y;
      s.v += 1 / (K + r); s.n++; s.from.push(src);
    });
  }
  if (!any) return null;
  const items = [...score.values()].sort((a, b) => b.v - a.v).map(s => ({ ...s.e, n: s.n > 1 ? `in ${s.n} of ${any} lists` : 'only in ' + SOURCE_INFO[s.from[0]].name.split(' (')[0] }));
  return { items, fetched, origin: 'blend' };
}
async function refreshLists(sysKeys, sources) {
  const jobs = []; for (const k of sysKeys) for (const src of sources) if (src !== 'blend' && sourceAvailable(src, k)) jobs.push([k, src]);
  let i = 0, fails = 0; const errs = new Set();
  for (const [k, src] of jobs) {
    const label = `${SOURCE_INFO[src].name} for ${SYSTEMS[k].label} (${++i}/${jobs.length})`;
    S.busy = 'Downloading ' + label + '…'; renderStatus();
    const progress = (d, n) => { S.busy = `Downloading ${label}: ${d}/${n}…`; renderStatus(); };
    try {
      let items;
      if (SOURCE_INFO[src].group === 'api') {
        const key = await Vault.get(SOURCE_INFO[src].service); if (!key) { errs.add(`No ${SERVICES[SOURCE_INFO[src].service].name} API key set (Settings > API keys).`); continue; }
        items = await API_FETCH[src](k, key, progress);
      } else if (src === 'pageviews') {
        const base = rawList('wikidata', k); items = await Sources.pageviews(SYSTEMS[k], 500, base && base.items.some(e => e.w) ? base.items : null, progress);
      } else items = await Sources[src](SYSTEMS[k], 500);
      if (items.length) { (S.lists[src] ||= {})[k] = { items, fetched: new Date().toISOString() }; await cacheWrite('toplists.json', S.lists); }
    } catch (e) { fails++; errs.add(e.message); console.warn(src, k, e); }
    await sleep(300);
  }
  S.busy = ''; render();
  if (fails || errs.size) toast(`${fails ? fails + ' download(s) failed. ' : ''}${[...errs].slice(0, 3).join(' ')}`, 'warn');
}
function compareSystem(sysKey, source, size) {
  const l = getList(source, sysKey); if (!l) return null;
  const folders = foldersFor(sysKey);
  // Every game known on this platform (this list plus the Wikidata list): used to keep loose matches honest.
  const claimed = new Set([...l.items, ...((rawList('wikidata', sysKey) || {}).items || [])].map(x => norm(x.t)));
  const items = l.items.slice(0, size).map((e, i) => {
    let have = null; for (const f of folders) { have = findIn(localIndex(f), e, claimed); if (have) break; }
    let cat = null; if (!have && S.catalog) for (const f of new Set([...folders, sysKey, ...(SYSTEMS[sysKey].aliases || [])])) { cat = findIn(catalogIndex(f), e, claimed); if (cat) break; }
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
  const notices = S.errors.filter(e => Date.now() - e.at < 20000).map(e => `<div class="notice ${e.kind === 'err' ? 'err' : e.kind === 'warn' ? '' : 'info'}">${e.html || esc(e.msg)}${(e.kind === 'err' || e.kind === 'warn') ? ` <button class="small" data-act="copyDiag" title="Copy full diagnostics to the clipboard">Copy details</button>` : ''}</div>`).join('');
  let body = '';
  if (S.tab === 'help') body = viewHelp();
  else if (!fsSupported && S.tab === 'free') body = viewFree();
  else if (!fsSupported) body = '';
  else if (!S.handles.app) body = connectPanel();
  else if (S.needsReconnect) body = `<div class="panel"><h2>Allow access again</h2><p>Your browser needs you to confirm folder access each time this page is opened. Last folder: <b>${esc(S.handles.app.name)}</b>.</p><div class="row"><button class="primary" data-act="reconnect">${T('Allow access to {folder}', { folder: S.handles.app.name })}</button><button data-act="pickApp">Choose a different folder</button></div></div>`;
  else body = ({ library: viewLibrary, topn: viewTopN, rgsx: viewRgsx, free: viewFree, settings: viewSettings, help: viewHelp })[S.tab]();
  m.innerHTML = browserWarning() + notices + body;
  refreshIntroChecks();
  translateDom(m); translateDom(document.querySelector('header'));
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
  $('#status').innerHTML = chips.join(''); translateDom($('#status'));
  refreshIntroChecks();
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
  const problems = setupChecks().filter(x => x.status === 'err' || (x.status === 'warn' && ['Installation', 'RGSX database', 'Page folder'].includes(x.title)));
  const checkNote = problems.length ? `<div class="notice">${problems.map(x => `<b>${esc(x.title)}</b>: <span>${esc(x.detail)}</span>`).join(' · ')} <button class="small" data-setpage="check">Open setup check</button></div>` : '';
  if (!S.dirs.roms) return checkNote + `<div class="panel"><h2>ROMs folder not found</h2><p>No <code>roms</code> folder was found in <b>${esc(S.handles.app.name)}</b>. Choose your RetroBat or Batocera folder (or the roms folder itself).</p><div class="row"><button class="primary" data-act="pickRetro">Choose RetroBat folder…</button></div></div>`;
  const f = S.sysFilter.toLowerCase(), show = S.config.library.show;
  const count = x => S.scan[x] ? S.scan[x].roms.length : null;
  const rows = S.folders.filter(x => !f || x.includes(f) || sysLabel(x).toLowerCase().includes(f))
    .filter(x => show === 'all' || (show === 'empty' ? count(x) === 0 : count(x) !== 0)).map(x => {
    const n = S.scan[x] ? S.scan[x].roms.length : null, c = S.catalog && S.catalog.counts[x];
    return `<div class="sysitem ${x === S.sel ? 'on' : ''}" data-sel="${esc(x)}"><span translate="no">${esc(sysLabel(x))}<br><small>${esc(x)}</small></span><span class="right">${n == null ? '<small>…</small>' : n.toLocaleString()}${c ? `<br><small>RGSX ${c.toLocaleString()}</small>` : ''}</span></div>`;
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
    right = `<div class="row"><h2 style="margin:0">${esc(sysLabel(S.sel))}</h2><span class="muted">${sc.roms.length.toLocaleString()} files · scanned ${D(sc.at)}</span><div class="grow"></div>
      <input type="search" id="libFilter" placeholder="Filter…" value="${esc(S.libFilter)}">
      <button class="small" data-act="scanOne">Rescan</button>${sysKey ? `<button class="small" data-act="toTop">Compare with top lists</button>` : ''}</div>
      ${S.catalog && S.catalog.sources[S.sel] ? `<p class="muted">${T('RGSX catalogue for {folder}: {n} games from {sources}.', { folder: S.sel, n: (S.catalog.counts[S.sel] || 0).toLocaleString(), sources: S.catalog.sources[S.sel].join(', ') })}</p>` : ''}
      <table><thead><tr><th>Game</th><th>Year</th><th>File</th><th>Folder</th></tr></thead><tbody translate="no">
      ${shown.map(r => `<tr><td>${esc(r.n || cleanName(r.f))}${r.ra ? ' <span class="tag" title="RetroAchievements">RA</span>' : ''}</td><td class="muted">${r.y || ''}</td><td class="muted">${esc(r.f)}</td><td class="muted">${esc(r.d)}</td></tr>`).join('')}
      </tbody></table>
      ${list.length > shown.length ? `<p class="row"><span class="muted">Showing ${shown.length.toLocaleString()} of ${list.length.toLocaleString()}.</span><button class="small" data-act="more">Show 1,000 more</button></p>` : ''}
      ${!list.length ? '<div class="empty">No ROMs here.</div>' : ''}`;
  }
  return checkNote + `<div class="split"><div class="panel"><div class="row"><b>Systems</b><span class="muted">${withRoms} with games · ${total.toLocaleString()} files</span></div>
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
  const sysOpts = `<option value="*" ${c.system === '*' || !c.system ? 'selected' : ''}>All systems (summary)</option>` + systems.map(k => `<option translate="no" value="${k}" ${k === c.system ? 'selected' : ''}>${esc(SYSTEMS[k].label)}</option>`).join('');
  const opts = sourceOptions(c.system && c.system !== '*' ? c.system : '');
  if (!opts.some(([v]) => v === c.source)) opts.unshift([c.source, ((SOURCE_INFO[c.source] || {}).name || 'Removed list') + ' (not available for this system)']);
  const srcOpts = opts.map(([v, n]) => `<option value="${esc(v)}" ${v === c.source ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const controls = `<div class="panel"><div class="row">
    <label>System <select id="tnSystem">${sysOpts}</select></label>
    <label>Source <select id="tnSource">${srcOpts}</select></label>
    <label>Top <select id="tnSize">${TOP_SIZES.map(n => `<option ${n === +c.size ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    ${c.system && c.system !== '*' ? `<label>Status <select id="tnShow">${[['all', 'All'], ['have', 'Installed'], ['miss', 'Missing'], ['cat', 'In RGSX catalogue']].map(([v, n]) => `<option value="${v}" ${c.show === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}
    <div class="grow"></div>
    ${c.source.startsWith('custom:') ? '' : `<button data-act="refreshLists">Update from the internet</button>`}
    ${c.system && c.system !== '*' ? `<button data-act="exportMissing">Export missing (CSV)</button>` : ''}
    ${c.system && c.system !== '*' && S.catalog ? `<button class="primary" data-act="sendToRgsx" title="Queue the missing games RGSX can download, drop a one-click downloader in your folder, and show how to run it">Send to RGSX ⤓</button>` : ''}
    ${c.system && c.system !== '*' && S.catalog ? `<button class="small" data-act="clearRgsx" title="Empty the RGSX download list">Clear list</button>` : ''}
    </div><p class="muted" style="margin:8px 0 0">${esc((SOURCE_INFO[c.source] || { about: 'A list you added in Settings.' }).about)}</p></div>`;
  const unscanned = systems.flatMap(foldersFor).filter(f => !S.scan[f]);
  const scanNote = unscanned.length ? `<div class="notice">${unscanned.length} folder(s) not scanned yet, so they show as missing. <button class="small" data-act="scanAll" ${S.scanning ? 'disabled' : ''}>Scan now</button></div>` : '';
  if (!c.system || c.system === '*') {
    const rows = systems.map(k => ({ k, r: compareSystem(k, c.source, +c.size) })).filter(x => x.r);
    const body = rows.map(({ k, r }) => {
      const n = r.items.length, p = n ? Math.round(100 * r.have / n) : 0;
      return `<tr data-sys="${k}" style="cursor:pointer"><td translate="no">${esc(SYSTEMS[k].label)}<br><small class="muted">${r.folders.map(esc).join(', ')}</small></td><td>${r.have} / ${n}${n < +c.size ? ` <span class="tag" title="This source has fewer than ${c.size} games for the system">list has ${n}</span>` : ''}</td><td><div class="bar"><i style="width:${p}%"></i></div></td><td>${p}%</td><td class="muted">${r.list.origin === 'live' ? 'updated ' : r.list.origin === 'bundled' ? 'bundled ' : ''}${r.list.fetched ? D(r.list.fetched) : ''}</td></tr>`;
    }).join('');
    const none = systems.length - rows.length;
    return controls + scanNote + `<div class="panel"><h2>Top ${c.size} coverage by system</h2>${rows.length ? `<table><thead><tr><th>System</th><th>Installed</th><th></th><th></th><th>List date</th></tr></thead><tbody>${body}</tbody></table>` : '<div class="empty">This source has no lists for your systems.</div>'}
      ${none ? `<p class="muted">${none} of your systems have no list in this source. Try "Most notable (Wikidata)", or add a custom list in Settings.</p>` : ''}</div>`;
  }
  const r = compareSystem(c.system, c.source, +c.size);
  if (!r) {
    const info = SOURCE_INFO[c.source] || {}, needsKey = info.group === 'api' && !Vault.has(info.service);
    const src = tr(info.name || 'This list'), sysName = SYSTEMS[c.system].label;
    const msg = !sourceAvailable(c.source, c.system) ? T('{src} doesn\'t cover {sys}. Choose another source.', { src, sys: sysName })
      : needsKey ? T('{src} needs a {svc} API key.', { src, svc: SERVICES[info.service].name }) + ` <button class="small" data-setpage="keys">Add it in Settings</button>`
      : T('{src} hasn\'t been downloaded for {sys} yet. Press "Update from the internet".', { src, sys: sysName });
    return controls + `<div class="panel"><div class="empty">${msg}</div></div>`;
  }
  const wl = S.config.wishlist[c.system] || [];
  // Status filter: all, installed, missing, or missing but available in the RGSX catalogue.
  const items = r.items.filter(x => c.show === 'have' ? !!x.have : c.show === 'miss' ? !x.have : c.show === 'cat' ? !x.have && !!x.cat : true);
  const tnPlat = S.catalog ? ([...r.folders, c.system, ...((SYSTEMS[c.system] || {}).aliases || [])].find(f => (S.catalog.platforms[f] || []).length) || r.folders[0] || c.system) : (r.folders[0] || c.system);
  const rows = items.map(x => {
    const k = norm(x.e.t), star = wl.includes(k);
    const dl = !x.have && x.cat;
    const pick = dl ? `<input type="checkbox" class="toppick" data-plat="${esc(tnPlat)}" data-name="${esc(x.cat[0].f)}" data-title="${esc(x.e.t)}" title="Select to download with RGSX"> ` : '';
    return `<tr class="${x.have ? 'have' : 'miss'}"><td class="num">${x.rank}</td><td><b translate="no">${esc(x.e.t)}</b>${x.e.y ? ` <span class="muted">(${x.e.y})</span>` : ''}${x.e.n ? `<br><small class="muted">${esc(x.e.n)}</small>` : ''}</td>
      <td>${x.have ? `<span class="tag ok">Installed</span> <small class="muted" translate="no">${esc(x.have[0].f)}${x.have.length > 1 ? ` +${x.have.length - 1}` : ''}</small>` : `<span class="tag no">Missing</span>${x.cat ? ` <span class="tag warn" title="${esc(x.cat[0].f)}" translate="no">${tr('In RGSX catalogue')}</span>` : ''}`}</td>
      <td class="right">${pick}<button class="small" data-star="${esc(k)}" title="Wishlist">${star ? '★' : '☆'}</button></td></tr>`;
  }).join('');
  return controls + scanNote + `<div class="panel"><div class="row"><h2 style="margin:0"><span translate="no">${esc(SYSTEMS[c.system].label)}</span> · Top ${c.size}</h2>
    <span class="tag ok">${r.have} installed</span><span class="tag no">${r.items.length - r.have} missing</span>
    ${S.catalog ? `<span class="tag warn">${r.items.filter(x => !x.have && x.cat).length} of the missing are in the RGSX catalogue</span>` : ''}
    <div class="grow"></div><span class="muted">${r.list.origin === 'bundled' ? 'Bundled list from ' : r.list.origin === 'live' ? 'Updated ' : ''}${r.list.fetched ? D(r.list.fetched) : ''}${r.items.length < +c.size ? ` · source has ${r.items.length} games` : ''}</span></div>
    ${S.catalog ? `<div class="row" style="margin-top:8px"><button class="small" data-act="topAll">Select all in catalogue</button><button class="small" data-act="topNone">Clear</button><button class="primary" data-act="topAddSel">Add selected ⤓</button><span class="muted">ticked games are added to the download list</span></div>` : ''}
    <table style="margin-top:8px"><thead><tr><th>#</th><th>Game</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Nothing to show.</td></tr>'}</tbody></table>
    <p class="muted">Matching uses the names in your gamelist.xml and the file names, ignoring region tags, punctuation, "The" and roman numerals. A game can still be missed if its file is named very differently.</p></div>`;
}

/* ------------------------------------------------------------------ Homebrew Hub (gbdev) — live search */
const HH_API_DEFAULT = 'https://hh3.gbdev.io/api';
// Homebrew Hub API root — override with your own instance (e.g. a deployed fork) in Settings.
function hhBase() { return ((S.config.free && S.config.free.hhApi) || HH_API_DEFAULT).replace(/\/+$/, ''); }
function hhPlatFolder(p) { return ({ GB: 'gb', GBC: 'gbc', GBA: 'gba' })[p] || 'gb'; }
async function hhLoad(append) {
  const h = S.hh; if (!h) return;
  h.loading = true; h.error = ''; h.started = true; if (!append) { h.page = 1; h.items = []; } render();
  const url = `${hhBase()}/search?platform=${encodeURIComponent(h.plat)}&page=${h.page}&page_elements=10${h.q ? '&title=' + encodeURIComponent(h.q) : ''}`;
  try {
    const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const res = Array.isArray(j.entries) ? j.entries : (Array.isArray(j.results) ? j.results : []);
    h.items = append ? h.items.concat(res) : res;
    h.total = j.page_total || 1;
  } catch (e) { h.error = e.message || String(e); }
  h.loading = false; render();
}
function hhView(tiled) {
  const h = S.hh;
  const asset = (slug, fn) => `${hhBase()}/entry/${encodeURIComponent(slug)}/${encodeURIComponent(fn)}`;
  const card = e => {
    const slug = e.slug, title = esc(e.title || slug), dev = esc(e.developer || ''), tags = esc((e.tags || []).slice(0, 3).join(', '));
    const scr = (e.screenshots || [])[0], img = scr ? esc(asset(slug, scr)) : '';
    const file = (e.files || []).find(f => f.default) || (e.files || []).find(f => f.playable) || (e.files || [])[0];
    const dl = file ? esc(asset(slug, file.filename)) : '';
    const hub = esc('https://hh.gbdev.io/entry/' + encodeURIComponent(slug));
    const meta = dev + (tags ? ' · ' + tags : '');
    const dlbtn = dl ? `<a class="tag warn" href="${dl}" download title="Download the ROM, then save it into roms\\${hhPlatFolder(h.plat)}">Download ROM ⤓</a>` : '';
    if (!tiled) {
      return `<div class="frow">${img ? `<a href="${hub}" target="_blank" rel="noopener"><img class="fthumb" src="${img}" loading="lazy" alt=""></a>` : '<span class="fthumb"></span>'}
        <div class="fmeta"><b translate="no"><a href="${hub}" target="_blank" rel="noopener">${title}</a></b> <div class="muted fdesc" translate="no">${meta}</div></div>
        <div class="fplats">${dlbtn}</div></div>`;
    }
    return `<div class="card">${img ? `<a href="${hub}" target="_blank" rel="noopener"><img class="fcover" src="${img}" loading="lazy" alt=""></a>` : ''}<b translate="no"><a href="${hub}" target="_blank" rel="noopener">${title}</a></b>
      <p translate="no">${meta}</p><div style="margin-top:6px">${dlbtn} <span class="tag">${esc(h.plat)}</span></div></div>`;
  };
  const results = (h.loading && !h.items.length) ? '<div class="empty">Searching Homebrew Hub…</div>'
    : h.error ? `<div class="notice err">Couldn't reach Homebrew Hub (${esc(h.error)}). Your browser may be blocking the request; you can open <a href="https://hh.gbdev.io" target="_blank" rel="noopener">hh.gbdev.io</a> directly. <button class="small" data-act="hhSearch">Retry</button></div>`
    : !h.items.length ? '<div class="empty">No results. Try another search or platform.</div>'
    : `<div class="${tiled ? 'cards' : 'flist'}">${h.items.map(card).join('')}</div>${h.page < h.total ? `<div class="row" style="margin-top:12px"><button data-act="hhMore" ${h.loading ? 'disabled' : ''}>${h.loading ? 'Loading…' : `Load more (page ${h.page} of ${h.total})`}</button></div>` : ''}`;
  return `<div class="panel"><div class="row">
      <label>Platform <select id="hhPlat">${['GB', 'GBC', 'GBA'].map(p => `<option ${p === h.plat ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <input type="search" id="hhSearch" placeholder="Search Homebrew Hub…" value="${esc(h.q || '')}" style="flex:1;min-width:200px">
      <button class="small" data-act="hhSearch">Search</button><div class="grow"></div>
      <a href="https://hh.gbdev.io" target="_blank" rel="noopener">Open Homebrew Hub ↗</a></div>
    <p class="muted">Free Game Boy, Game Boy Color and Game Boy Advance homebrew from <b>Homebrew Hub</b>, searched live. Click <b>Download ROM</b>, then save the file into <code>roms\\${hhPlatFolder(h.plat)}</code> and rescan in RetroBat. (NES homebrew lives in a separate database — ask and I can add it.)</p>
    <p class="muted">Source: <code translate="no">${esc(hhBase())}</code> ${S.config.free.hhApi ? '<span class="tag warn">your instance</span>' : '<span class="tag">public hh.gbdev.io</span>'} <button class="small" data-act="hhSetApi">Change…</button></p>
    ${results}</div>`;
}
function viewFree() {
  const d = itchData(); const c = S.config.free;
  if (!d) return `<div class="panel"><div class="empty">No itch.io data.</div></div>`;
  const G = d.games;
  const mode = c.mode === 'pc' ? 'pc' : c.mode === 'hh' ? 'hh' : 'retro';
  const sysKeys = Object.keys(d.sys).sort((a, b) => (SYSTEMS[a]?.label || a).localeCompare(SYSTEMS[b]?.label || b));
  if (!c.system || !d.sys[c.system]) c.system = sysKeys.find(k => foldersFor(k).length || S.folders.includes(k)) || sysKeys[0];
  const tiled = c.view !== 'list';
  const hasImgs = G.some(g => g && g[4]);
  const srcNote = mode === 'hh' ? 'Homebrew Hub · live from hh.gbdev.io' : `itch.io top-rated free · ${d === ITCH_BUNDLED ? 'bundled' : 'updated'} ${D(d.fetched)}`;
  const head = `<div class="panel"><div class="row">
    <label><input type="radio" name="fmode" value="retro" ${mode === 'retro' ? 'checked' : ''}> Retro homebrew (itch.io)</label>
    <label><input type="radio" name="fmode" value="hh" ${mode === 'hh' ? 'checked' : ''}> Homebrew Hub (GB/GBC/GBA)</label>
    <label><input type="radio" name="fmode" value="pc" ${mode === 'pc' ? 'checked' : ''}> PC &amp; browser</label>
    <div class="grow"></div>
    <div class="row" style="gap:4px"><button class="small ${tiled ? 'primary' : ''}" data-act="freeTile" title="Tile view">▦ Tiles</button><button class="small ${!tiled ? 'primary' : ''}" data-act="freeList" title="List view">☰ List</button></div>
    <span class="muted">${srcNote}</span></div>
    ${mode !== 'hh' && !hasImgs ? `<p class="muted" style="margin:8px 0 0">No screenshots in this data. Refresh the list in <b>Settings › itch.io data</b> to pull in cover images.</p>` : ''}</div>`;
  if (mode === 'hh') {
    const h = (S.hh ||= { plat: 'GB', q: '', items: [], page: 1, total: 1, loading: false, error: '', started: false });
    if (!h.started && !h.loading) setTimeout(() => hhLoad(false), 0);
    return head + hhView(tiled);
  }
  let body = '';
  const wrap = items => `<div class="${tiled ? 'cards' : 'flist'}">${items || '<div class="empty">Nothing to show.</div>'}</div>`;
  const card = (i, sysKey) => {
    const g = G[i]; if (!g) return '';
    let have = null;
    if (sysKey) for (const f of [...foldersFor(sysKey), ...(S.folders.includes(sysKey) ? [sysKey] : [])]) { have = findIn(localIndex(f), { t: g[0] }); if (have) break; }
    const plats = [...new Set((g[2] || '').split('').map(p => PLAT[p]).filter(Boolean))];
    const url = esc(itchUrl(g[1])), name = esc(g[0]), desc = esc(g[3] || ''), by = esc(g[1].split('~')[0]), img = g[4] ? esc(g[4]) : '';
    const inst = have ? '<span class="tag ok">Installed</span>' : '';
    const platTags = plats.map(p => `<span class="tag">${p}</span>`).join('');
    if (!tiled) {
      return `<div class="frow">${img ? `<a href="${url}" target="_blank" rel="noopener"><img class="fthumb" src="${img}" loading="lazy" alt=""></a>` : '<span class="fthumb"></span>'}
        <div class="fmeta"><b translate="no"><a href="${url}" target="_blank" rel="noopener">${name}</a></b> ${inst} <div class="muted fdesc" translate="no">${desc}</div></div>
        <div class="fplats">${platTags}<span class="tag">by <span translate="no">${by}</span></span></div></div>`;
    }
    return `<div class="card">${img ? `<a href="${url}" target="_blank" rel="noopener"><img class="fcover" src="${img}" loading="lazy" alt=""></a>` : ''}<b translate="no"><a href="${url}" target="_blank" rel="noopener">${name}</a></b> ${inst}
      <p translate="no">${desc}</p><div style="margin-top:6px">${platTags}<span class="tag">by <span translate="no">${by}</span></span></div></div>`;
  };
  if (mode === 'retro') {
    const s = d.sys[c.system] || { all: [], genres: {} };
    const tag = (ITCH_TAGS[c.system] || [])[0];
    const gopts = `<option value="all">Top rated (all genres)</option>` + Object.keys(GENRES).filter(g => s.genres[g]).map(g => `<option value="${g}" ${g === c.genre ? 'selected' : ''}>${GENRES[g]} (${s.genres[g].length})</option>`).join('');
    if (c.genre !== 'all' && !s.genres[c.genre]) c.genre = 'all';
    const ids = c.genre === 'all' ? s.all : s.genres[c.genre];
    const more = tag ? `https://itch.io/games/top-rated/free/${c.genre === 'all' ? '' : 'genre-' + c.genre + '/'}tag-${tag}` : '';
    body = `<div class="panel"><div class="row">
      <label>System <select id="frSystem">${sysKeys.map(k => `<option translate="no" value="${k}" ${k === c.system ? 'selected' : ''}>${esc(SYSTEMS[k]?.label || k)}${foldersFor(k).length || S.folders.includes(k) ? '' : ' ' + tr('(no folder)')}</option>`).join('')}</select></label>
      <label>Genre <select id="frGenre">${gopts}</select></label><div class="grow"></div>${more ? `<a href="${more}" target="_blank" rel="noopener">See more on itch.io ↗</a>` : ''}<button class="small" data-act="rgsxAddItch" title="Queue RGSX to install the free itch.io homebrew for this system">Send free homebrew to RGSX ⤓</button></div>
      <p class="muted">Homebrew tagged for this system on itch.io, filtered to free games without Windows, macOS, Linux or Android builds (those are usually PC games in a retro style). Check each page for the ROM file; save it into <code>roms\\${esc(foldersFor(c.system)[0] || c.system)}</code>.</p>
      ${wrap((ids || []).map(i => card(i, c.system)).join(''))}</div>`;
  } else {
    const genres = Object.keys(GENRES).filter(g => d.pc[g]);
    const gopts = `<option value="all">All genres</option>` + genres.map(g => `<option value="${g}" ${g === c.pcGenre ? 'selected' : ''}>${GENRES[g]}</option>`).join('');
    const show = c.pcGenre === 'all' ? genres : [c.pcGenre];
    body = `<div class="panel"><div class="row"><label>Genre <select id="pcGenre">${gopts}</select></label></div>
      <p class="muted">Top-rated free games on itch.io by genre. Windows games can be added to RetroBat's <code>roms\\windows</code> folder.</p>
      ${show.map(g => `<h3>${GENRES[g]} <a class="muted" style="font-weight:400;font-size:12px" href="https://itch.io/games/top-rated/free/genre-${g}" target="_blank" rel="noopener">more ↗</a></h3>${wrap(d.pc[g].map(i => card(i, 'windows')).join(''))}`).join('')}</div>`;
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

/* ------------------------------------------------------------------ settings (side menu) */
function siteListsFor(sysKey) {
  const sys = SYSTEMS[sysKey] || {}, out = [...(SITE_LISTS[sysKey] || [])];
  for (const [k, l] of Object.entries(SITE_LISTS)) if (k.startsWith('*')) for (const e of l) if ((e.systems || []).includes(sysKey)) out.push(e);
  if (sys.moby) out.push({ name: 'MobyGames: ' + sys.label + ' by Moby score', url: `https://www.mobygames.com/platform/${sys.moby}/sort:-moby_score/`, rank: 'rating', note: 'Critic and user scores combined. The list is paged; grab each page you want.' });
  if (sys.ra) out.push({ name: 'RetroAchievements: ' + sys.label + ' games', url: `https://retroachievements.org/system/${sys.ra}/games`, rank: 'players', note: 'Sort the table by Players, then grab it. With an API key the built-in "Most played" source does this for you.' });
  return out;
}
function settingsSystems() {
  const mine = Object.keys(SYSTEMS).filter(k => foldersFor(k).length);
  const rest = Object.keys(SYSTEMS).filter(k => !mine.includes(k));
  return { mine, rest };
}
function viewSettings() {
  const page = S.setPage || 'general';
  const f = (S.setSysFilter || '').toLowerCase();
  const { mine, rest } = settingsSystems();
  const item = (id, label, sub = '', data = false) => `<div class="sysitem ${page === id ? 'on' : ''}" data-setpage="${esc(id)}"><span${data ? ' translate="no"' : ''}>${esc(label)}${sub ? `<br><small>${esc(sub)}</small>` : ''}</span></div>`;
  const sysItem = k => {
    const n = customListsFor(k).filter(l => l.system === k).length;
    return (!f || SYSTEMS[k].label.toLowerCase().includes(f) || k.includes(f)) ? item('sys:' + k, SYSTEMS[k].label, foldersFor(k).join(', ') + (n ? ` · ${n} list${n > 1 ? 's' : ''}` : ''), true) : '';
  };
  const menu = `<div class="panel"><b>Settings</b><div class="syslist" style="max-height:none">
    ${item('general', 'General')}${item('check', 'Setup check')}${item('folders', 'Folders')}${item('downloads', 'Downloads')}${item('sources', 'Top list sources')}${item('keys', 'API keys')}${item('itch', 'itch.io data')}</div>
    <div class="row" style="margin-top:14px"><b>Systems</b><span class="muted">lists per system</span></div>
    <div class="row" style="margin-top:8px"><input type="search" id="setSysFilter" placeholder="Find a system…" value="${esc(S.setSysFilter || '')}" style="flex:1"></div>
    <div class="syslist">${mine.map(sysItem).join('')}
    ${S.showAllSys ? rest.map(sysItem).join('') : ''}
    <div class="sysitem" data-act="toggleAllSys"><small>${S.showAllSys ? 'Hide systems without a ROM folder' : `Show ${rest.length} more systems without a ROM folder`}</small></div></div></div>`;
  let body;
  if (page.startsWith('sys:')) body = settingsSystem(page.slice(4));
  else body = ({ general: settingsGeneral, check: settingsCheck, folders: settingsFolders, downloads: settingsDownloads, sources: settingsSources, keys: settingsKeys, itch: settingsItch })[page]();
  return `<div class="split"><div>${menu}</div><div>${body}</div></div>`;
}
const INSTALL_NAME = { retrobat: 'RetroBat', batocera: 'Batocera share', roms: 'A roms folder on its own', unknown: 'A folder with a roms folder' };
function setupChecks() {
  const c = [], add = (status, title, detail = '', fix = '') => c.push({ status, title, detail, fix });
  const scanned = Object.values(S.scan), withRoms = Object.entries(S.scan).filter(([, v]) => v.roms.length);
  add(ENV.ok ? 'ok' : 'err', 'Browser', ENV.ok ? [ENV.name, ENV.os].filter(Boolean).join(' on ') || 'Supported' : 'This browser can\'t open folders.', ENV.ok ? '' : 'Use Chrome or Edge on Windows, macOS or Linux.');
  if (!S.handles.app) { add('err', 'Page folder', 'Not chosen yet.', 'Choose the folder this page is in.'); return c; }
  add(S.writable ? 'ok' : 'warn', 'Page folder', (S.config.paths.appFolder || S.handles.app.name) + (S.writable ? '' : ' ' + tr('(read-only)')), S.writable ? '' : 'Settings can\'t be saved. Choose the folder again and allow "Edit files", or check the share isn\'t read-only.');
  if (S.samePlace === false) add('warn', 'Page location', 'This page isn\'t in the chosen folder, so its config is saved somewhere else.', 'Copy the page into the RetroBat folder or Batocera share, or choose the folder it is in.');
  const t = (S.install || {}).type;
  add(t === 'retrobat' || t === 'batocera' ? 'ok' : t ? 'warn' : 'err', 'Installation', t ? INSTALL_NAME[t] : 'No roms folder found.',
    t === 'roms' ? 'You chose the roms folder itself, so the RGSX database can\'t be found automatically. Choose the RetroBat folder or the Batocera share instead, or pick the RGSX folder in Settings › Folders.'
    : t ? '' : 'Choose your RetroBat folder or Batocera share in Settings › Folders.');
  if (S.scanning) add('info', 'ROM folders', 'Scanning your library…', 'The results below update when the scan finishes.');
  else if (S.dirs.roms) add(withRoms.length ? 'ok' : 'warn', 'ROM folders', `${S.folders.length} system folders, ${withRoms.length} with games.`, withRoms.length ? '' : 'No games found yet. Press Rescan all in the Library.');
  if (withRoms.length && !S.scanning) {
    const gl = withRoms.filter(([, v]) => v.gl).length;
    add(gl === withRoms.length ? 'ok' : gl ? 'warn' : 'warn', 'Game lists (gamelist.xml)', `${gl} of ${withRoms.length} systems with games have one.`,
      gl === withRoms.length ? '' : 'Scrape your games in RetroBat / Batocera (Main menu › Scraper). Names, release years and RetroAchievements IDs make matching much more accurate.');
  }
  if (S.install) add(S.install.rgsxApp ? 'ok' : 'warn', 'RGSX app', S.install.rgsxApp ? 'Installed (roms/ports/RGSX).' : 'Not found in roms/ports/RGSX.', S.install.rgsxApp ? '' : 'Install RGSX from github.com/RetroGameSets/RGSX to see which missing games it can download.');
  if (!S.dirs.rgsx) add('warn', 'RGSX database', 'Not found (saves/ports/rgsx/rgsx.sqlite3).', 'Start RGSX once so it creates its database, or choose its folder in Settings › Folders.');
  else if (!S.catalog && /RGSX/.test(S.busy)) add('info', 'RGSX database', 'Reading the RGSX database…');
  else if (!S.catalog) add('warn', 'RGSX database', 'Found, not read yet.', 'Press Reload catalogue in Settings › Folders. Close RGSX first if it is running.');
  else {
    const age = S.catalog.dbModified ? Math.floor((Date.now() - S.catalog.dbModified) / 864e5) : null;
    add(age != null && age > 14 ? 'warn' : 'ok', 'RGSX database', `${Object.values(S.catalog.counts).reduce((a, b) => a + b, 0).toLocaleString()} games` + (age == null ? '' : age === 0 ? ', updated today' : age === 1 ? ', updated yesterday' : `, updated ${age} days ago`), age != null && age > 14 ? 'Start RGSX to update its catalogue, then press Reload catalogue.' : '');
  }
  if (t === 'batocera' || /^\\\\/.test(S.config.paths.appFolder || '')) add('info', 'Network share', 'The library is read over the network, so scans are slower than on a local disk.', 'The first scan can take a few minutes on Wi-Fi; after that the page uses its cache. Use Rescan when you add games.');
  return c;
}
function checksTable() {
  const icon = { ok: '✓', warn: '!', err: '✕', info: 'i' }, cls = { ok: 'ok', warn: 'warn', err: 'no', info: '' };
  return '<table><tbody>' + setupChecks().map(x => `<tr><td><span class="tag ${cls[x.status]}" translate="no">${icon[x.status]}</span></td><td><b>${esc(x.title)}</b></td><td${x.title === 'Browser' && ENV.ok ? ' translate="no"' : ''}>${esc(x.detail)}${x.fix ? `<br><small class="muted">${esc(x.fix)}</small>` : ''}</td></tr>`).join('') + '</tbody></table>';
}
function settingsCheck() {
  return `<div class="panel"><div class="row"><h2 style="margin:0">Setup check</h2><div class="grow"></div><button class="small" data-act="copyDiag" title="Copy a full diagnostic report to the clipboard">Copy diagnostics</button><button class="small" data-act="recheck">Check again</button></div>
    <p class="muted">Works for RetroBat on Windows and for a Batocera share opened from Windows, macOS or Linux.</p>
    ${!S.firstRunCheck ? '' : '<div class="notice info">This check runs when you first connect a folder. You can come back to it any time from Settings › Setup check.</div>'}
    ${checksTable()}</div>`;
}
const DL_REGIONS = [['uk', 'UK'], ['eu', 'Europe (EU)'], ['us', 'USA'], ['jp', 'Japan'], ['world', 'World']];
const DL_LANGS = [['en', 'English'], ['fr', 'French'], ['es', 'Spanish'], ['de', 'German'], ['nl', 'Dutch'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ja', 'Japanese'], ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian'], ['fi', 'Finnish'], ['ru', 'Russian'], ['zh', 'Chinese'], ['ko', 'Korean']];
// Parenthetical region/language tags used to classify a catalogue game name.
const RGSX_REGION_TAGS = { us: ['usa', 'us', 'ntsc-u', 'america'], eu: ['europe', 'eu', 'pal'], uk: ['uk', 'united kingdom', 'england', 'en-gb'], jp: ['japan', 'jp', 'jpn', 'ntsc-j', 'asia'], world: ['world'] };
const RGSX_LANG_TAGS = { en: ['en'], fr: ['fr'], es: ['es', 'sp'], de: ['de', 'ge'], nl: ['nl', 'du'], it: ['it'], pt: ['pt'], ja: ['ja', 'jp', 'jpn'], sv: ['sv', 'se'], da: ['da'], no: ['no'], fi: ['fi'], ru: ['ru'], zh: ['zh', 'cn'], ko: ['ko', 'kr'] };
function parenTags(name) { return (String(name).toLowerCase().match(/\(([^)]*)\)|\[([^\]]*)\]/g) || []).join(' '); }
// True if this game name is allowed by the chosen region/language rules (untagged & World always allowed).
function dlAllows(name) {
  const dc = S.config.download || {}, regions = dc.regions || [], langs = dc.langs || [], tags = parenTags(name);
  if (regions.length) {
    const named = Object.keys(RGSX_REGION_TAGS).filter(k => k !== 'world' && RGSX_REGION_TAGS[k].some(t => tags.includes(t)));
    const isWorld = RGSX_REGION_TAGS.world.some(t => tags.includes(t));
    if (named.length && !isWorld && !named.some(r => regions.includes(r))) return false;
  }
  if (langs.length) {
    const named = Object.keys(RGSX_LANG_TAGS).filter(k => RGSX_LANG_TAGS[k].some(t => new RegExp('(^|[^a-z])' + t + '([^a-z]|$)').test(tags)));
    if (named.length && !named.some(l => langs.includes(l))) return false;
  }
  return true;
}
function settingsDownloads() {
  const dc = S.config.download || { regions: [], langs: [] };
  const grid = (opts, sel, attr) => `<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px">${opts.map(([v, n]) => `<label class="card" style="display:flex;gap:8px;align-items:center;padding:6px 10px;cursor:pointer"><input type="checkbox" ${attr}="${v}" ${sel.includes(v) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>`;
  const rAll = dc.regions.length === DL_REGIONS.length, lAll = dc.langs.length === DL_LANGS.length;
  return `<div class="panel"><h2>Downloads — region &amp; language</h2>
    <p class="muted">Tick the regions and languages you want. These rules are <b>enforced</b>: the <b>RGSX › Catalogue</b> search hides versions that don't match, and the downloader only fetches a matching version — if a game has no matching version it's skipped (and noted in the report). Games with <b>no</b> region/language tag, and <span translate="no">(World)</span> releases, are always allowed. Leaving a group empty means <b>no restriction</b> for it.</p>
    <div class="row" style="margin-top:4px"><h3 style="margin:0">Regions</h3><div class="grow"></div><button class="small" data-act="dlRegionsAll">${rAll ? 'Clear all' : 'Select all'}</button></div>
    ${grid(DL_REGIONS, dc.regions, 'data-dlregion')}
    <div class="row" style="margin-top:12px"><h3 style="margin:0">Languages</h3><div class="grow"></div><button class="small" data-act="dlLangsAll">${lAll ? 'Clear all' : 'Select all'}</button></div>
    ${grid(DL_LANGS, dc.langs, 'data-dllang')}
    <p class="muted" style="margin-top:12px">Currently: ${dc.regions.length ? 'regions ' + dc.regions.map(r => (DL_REGIONS.find(x => x[0] === r) || [r, r])[1]).join(', ') : 'all regions'}; ${dc.langs.length ? 'languages ' + dc.langs.map(l => (DL_LANGS.find(x => x[0] === l) || [l, l])[1]).join(', ') : 'all languages'}. Saved in your settings and, next to the page, as <code>rgsx-download-prefs.json</code> for the downloader.${S.handles.app && S.writable ? '' : ' <b>Allow edit access to your folder (Folders) to write it for the downloader.</b>'}</p></div>`;
}
function settingsGeneral() {
  const cfg = JSON.stringify({ ...S.config, wishlist: `${Object.values(S.config.wishlist).flat().length} games`, customLists: `${S.config.customLists.length} lists`, vault: S.config.vault ? { mode: S.config.vault.mode, items: Object.keys(S.config.vault.items || {}).map(k => k + ' (encrypted)') } : undefined }, null, 2);
  return `<div class="panel"><h2>General</h2><div class="row">
    <label><input type="checkbox" id="optIntro" ${S.config.showGettingStarted ? 'checked' : ''}> Show the getting started page when this page opens</label></div>
    <div class="row" style="margin-top:10px"><button data-act="intro">Open getting started</button><button data-tab="help">Open help</button><button data-act="forget">Forget folders</button></div>
    <h3>Config file <code>${CONFIG_NAME}</code></h3><p class="muted">Saved next to this page. API keys in it are encrypted.</p><pre>${esc(cfg)}</pre></div>`;
}
function settingsFolders() {
  const p = S.config.paths;
  return `<div class="panel"><h2>Folders</h2><div class="kv">
    <div>This page's folder</div><div>${esc(p.appFolder || S.handles.app.name)} ${S.samePlace === false ? '<span class="tag warn">this page is not in that folder</span>' : S.samePlace ? '<span class="tag ok">config saved here</span>' : ''} ${S.writable ? '' : '<span class="tag no">read-only</span>'}</div><div><button class="small" data-act="pickApp">Change…</button></div>
    <div>RetroBat / Batocera folder</div><div>${p.retrobatFolder ? esc(p.retrobatFolder) : '<span class="tag no">not found</span>'} ${S.install && S.install.type ? `<span class="tag ok">${esc(tr(INSTALL_NAME[S.install.type]))}</span>` : ''}</div><div><button class="small" data-act="pickRetro">Choose…</button></div>
    <div>ROMs folder</div><div>${p.romsFolder ? esc(p.romsFolder) + ` <span class="muted">(${S.folders.length} system folders)</span>` : '<span class="tag no">not found</span>'}</div><div></div>
    <div>RGSX database folder</div><div>${p.rgsxFolder ? esc(p.rgsxFolder) : '<span class="tag no">not found</span>'} ${S.catalog ? `<span class="muted">read ${D(S.catalog.at)}</span>` : ''}</div><div><button class="small" data-act="pickRgsx">Choose…</button> ${S.dirs.rgsx ? '<button class="small" data-act="reloadCat">Reload catalogue</button>' : ''}</div>
  </div></div>
  ${rgsxUpdatePanel()}`;
}
function rgsxUpdatePanel() {
  const c = S.catalog, age = c && c.dbModified ? Math.floor((Date.now() - c.dbModified) / 864e5) : null;
  return `<div class="panel" id="rgsxUpdate"><h2>Updating the RGSX catalogue</h2>
    ${c ? `<p>${c.dbModified ? `RGSX last updated its database on ${D(c.dbModified)}` : 'The RGSX database was read'}${age != null ? ` (${age} day${age === 1 ? '' : 's'} ago)` : ''}. ${Object.values(c.counts).reduce((a, b) => a + b, 0).toLocaleString()} games${c.seq ? `, catalogue revision ${esc(c.seq)}` : ''}.</p>` : ''}
    ${age != null && age > 14 ? '<div class="notice">The catalogue is more than two weeks old. Update it in RGSX (below).</div>' : ''}
    <p class="muted">This page can't download the catalogue itself: the RGSX catalogue server only answers RGSX, not web pages. RGSX updates it for you:</p>
    <ol><li>Start <b>RGSX</b>: in RetroBat it's under <b>Ports</b> (or <b>Windows</b> › <b>RGSX Retrobat</b>); on Batocera, under <b>Ports</b>. Each time it starts it shows "Synchronizing game catalog…" and downloads the changes.</li>
      <li>To force a complete refresh, open the RGSX menu (Start button, or Esc on a keyboard) › <b>Games</b> › <b>Refresh game catalog</b>.</li>
      <li>Close RGSX, come back here and press <b>Reload catalogue</b>.</li></ol>
    ${S.dirs.rgsx ? '<div class="row"><button class="primary" data-act="reloadCat">Reload catalogue</button></div>' : ''}</div>`;
}
function settingsSources() {
  const lists = S.config.customLists.filter(l => l.system === '*').map(l => `<tr><td translate="no">${esc(l.name)}</td><td>${l.items.length}</td><td class="right"><button class="small" data-dellist="${esc(l.id)}">Remove</button></td></tr>`).join('');
  return `<div class="panel"><h2>Top list sources</h2>
    <table><thead><tr><th>Source</th><th>What it ranks</th></tr></thead><tbody>${Object.entries(SOURCE_INFO).map(([k, v]) => `<tr><td><b>${esc(v.name)}</b>${v.group === 'api' ? `<br><span class="tag ${Vault.has(v.service) ? 'ok' : 'warn'}">${Vault.has(v.service) ? 'key saved' : 'needs API key'}</span>` : ''}</td><td class="muted">${esc(v.about)}</td></tr>`).join('')}</tbody></table>
    <p class="muted">The page ships with a copy of every built-in list (made ${D(SNAPSHOT.fetched)}). Updating downloads fresh copies and keeps them in <code>${CACHE_DIR}</code>. Lists from websites are added per system: choose a system on the left.</p>
    <div class="row"><button data-act="refreshAll">Update all built-in lists for my systems</button>${API_SOURCES.some(s => Vault.has(SOURCE_INFO[s].service)) ? '<button data-act="refreshApi">Update API lists for my systems</button>' : ''}<button data-act="clearLists">Use the bundled lists again</button></div></div>
  <div class="panel"><h2>Lists for any system</h2><p class="muted">A list that mixes systems (for example a magazine's all-time top 100). Each system only shows the games it has. One title per line, best first; CSV uses the first column.</p>
    ${lists ? `<table><thead><tr><th>Name</th><th>Games</th><th></th></tr></thead><tbody>${lists}</tbody></table>` : ''}
    <div class="row" style="margin-top:8px"><input type="text" id="clName" placeholder="List name" style="flex:1"></div>
    <textarea id="clItems" placeholder="Super Mario Bros. 3&#10;The Legend of Zelda&#10;Mega Man 2"></textarea>
    <div class="row"><button class="primary" data-act="addList">Add list</button><label class="muted">or load a file <input type="file" id="clFile" accept=".txt,.csv,.json"></label></div></div>`;
}
function settingsKeys() {
  const v = Vault.cfg();
  const rows = Object.entries(SERVICES).map(([id, s]) => `<div class="panel"><h2>${esc(s.name)}</h2>
    <p class="muted">${esc(s.help)} <a href="${s.link}" target="_blank" rel="noopener">Open ${esc(s.name)} ↗</a></p>
    <p>Used by: ${API_SOURCES.filter(k => SOURCE_INFO[k].service === id).map(k => esc(SOURCE_INFO[k].name)).join(', ')}.</p>
    <div class="row"><span class="tag ${Vault.has(id) ? 'ok' : ''}">${Vault.has(id) ? 'Saved, encrypted' : 'Not set'}</span>
      <input type="password" id="key_${id}" placeholder="${esc(s.keyName)}" autocomplete="off" style="flex:1;min-width:220px">
      <button class="primary" data-savekey="${id}">Save</button><button data-testkey="${id}" ${Vault.has(id) ? '' : 'disabled'}>Test</button><button data-delkey="${id}" ${Vault.has(id) ? '' : 'disabled'}>Remove</button></div></div>`).join('');
  return `<div class="panel"><h2>API keys</h2>
    <p>Some sources need a personal API key. Keys are encrypted (AES-256-GCM) before they're written to <code>${CONFIG_NAME}</code>, and are only decrypted in memory while the page is open.</p>
    <div class="row"><label><input type="radio" name="vaultMode" value="device" ${v.mode !== 'passphrase' ? 'checked' : ''}> <b>This browser</b></label><span class="muted">The encryption key is kept by this browser and can't be exported. Nothing to type, but on another computer you enter the keys again.</span></div>
    <div class="row" style="margin-top:6px"><label><input type="radio" name="vaultMode" value="passphrase" ${v.mode === 'passphrase' ? 'checked' : ''}> <b>Passphrase</b></label><span class="muted">The key is made from a passphrase you type once per visit. Works on any computer with the config file.</span></div>
    ${v.mode === 'passphrase' ? `<p class="muted">Status: ${Vault.key ? 'unlocked for this visit' : 'locked'} ${Vault.key ? '' : '<button class="small" data-act="unlock">Unlock</button>'}</p>` : ''}
    <p class="muted">Keys are sent only to their own service, as that service's API requires.</p></div>${rows}
  <div class="panel"><h2>Services that can't be used here</h2><p class="muted">IGDB, MobyGames, TheGamesDB and Giant Bomb block requests from pages opened from disk, and ScreenScraper needs developer credentials. Their website lists can still be imported per system with the list grabber.</p></div>`;
}
function settingsItch() {
  return `<div class="panel"><h2>itch.io data</h2>
    <p>The <b>Free games</b> tab shows top-rated free itch.io games. itch.io doesn't let other web pages read its feeds, so this page ships with a <b>bundled snapshot</b> (from ${D(ITCH_BUNDLED.fetched)}). It works offline and you don't have to do anything — refresh it only when you want newer listings.</p>
    <h3>Refresh the list (optional)</h3>
    <p class="muted">You run a small script once, on itch.io itself, which reads itch's public "top rated free" feeds and saves a file you then load back here. It's safe and read-only; no login or key is needed.</p>
    <ol>
      <li>Click <b>Copy refresh script</b> below (it copies to your clipboard; if your browser blocks that, it downloads <code>itch-refresh.js</code> instead — open it and copy the text).</li>
      <li>Open <a href="https://itch.io" target="_blank" rel="noopener">itch.io</a> in <b>Chrome or Edge</b> (any page on the site is fine).</li>
      <li>Open the developer console: press <b>F12</b> (or Ctrl+Shift+J on Windows/Linux, ⌥⌘J on Mac) and click the <b>Console</b> tab.</li>
      <li>If the console shows a warning about pasting, type <code>allow pasting</code> and press Enter first (Chrome/Edge do this once for safety).</li>
      <li><b>Paste</b> the script and press <b>Enter</b>. It works through the feeds one at a time, logging progress like <code>itch refresh 12/80</code> — leave the tab open for <b>a few minutes</b>.</li>
      <li>When it finishes it logs <code>Done: itch-free.json downloaded</code> and saves <code>itch-free.json</code> to your <b>Downloads</b> folder.</li>
      <li>Come back here, click <b>Import</b> and choose that <code>itch-free.json</code>.</li>
    </ol>
    <div class="row"><button class="primary" data-act="copyItch">Copy refresh script</button><label>Import <input type="file" id="itchFile" accept=".json"></label>${S.itch ? `<span class="tag ok">Using refreshed data from ${D(S.itch.fetched)}</span><button class="small" data-act="dropItch">Use bundled data</button>` : `<span class="tag">Using bundled data</span>`}</div>
    <p class="muted" style="margin-top:12px">Nothing here needs an itch.io account. (That's separate from <b>installing</b> free homebrew through RGSX, which uses an itch.io API key set under <b>RGSX › Sources</b>.)</p></div>`;
}
const RANK_LABEL = { votes: 'members\' votes', rating: 'ratings', players: 'players', popularity: 'popularity', editorial: 'editorial ranking', curated: 'unranked selection', database: 'database' };
function settingsSystem(k) {
  const sys = SYSTEMS[k]; if (!sys) return '<div class="panel">Unknown system.</div>';
  const folders = foldersFor(k);
  const srcRows = Object.keys(SOURCE_INFO).filter(s => s !== 'blend' && sourceAvailable(s, k)).map(s => {
    const l = rawList(s, k), info = SOURCE_INFO[s], needs = info.group === 'api' && !Vault.has(info.service);
    return `<tr><td>${esc(info.name)}</td><td>${l ? l.items.length : '–'}</td><td class="muted">${l ? (l.origin === 'live' ? 'updated ' : 'bundled ') + D(l.fetched) : needs ? 'needs API key' : 'not downloaded'}</td>
      <td class="right">${needs ? '<button class="small" data-setpage="keys">Add key</button>' : `<button class="small" data-upd="${s}|${k}">Update</button>`}</td></tr>`;
  }).join('');
  const sites = siteListsFor(k).map(e => `<div class="card"><b translate="no"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)} ↗</a></b> <span class="tag">${esc(RANK_LABEL[e.rank] || e.rank || '')}</span>
      ${e.note ? `<p>${esc(e.note)}</p>` : ''}<div style="margin-top:6px"><button class="small" data-webfill="${esc(JSON.stringify({ name: e.name, url: e.url }))}">Import this list…</button></div></div>`).join('');
  const mine = S.config.customLists.filter(l => l.system === k).map(l => `<tr><td><b translate="no">${esc(l.name)}</b>${l.url ? `<br><a class="muted" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url.replace(/^https?:\/\//, '').slice(0, 60))}</a>` : ''}</td><td>${l.items.length}</td><td class="muted">${D(l.added)}</td>
      <td class="right">${l.url ? `<button class="small" data-webfill="${esc(JSON.stringify({ name: l.name, url: l.url, id: l.id }))}">Re-import</button> ` : ''}<button class="small" data-dellist="${esc(l.id)}">Remove</button></td></tr>`).join('');
  const d = S.webDraft && S.webDraft.sys === k ? S.webDraft : { sys: k, name: '', url: '', items: [], how: '' };
  const bm = 'javascript:' + encodeURIComponent(GRABBER_SCRIPT);
  return `<div class="panel"><div class="row"><h2 style="margin:0" translate="no">${esc(sys.label)}</h2><span class="muted">${folders.length ? T('ROM folder: {f}', { f: folders.join(', ') }) : 'no ROM folder'}${S.catalog && S.catalog.counts[k] ? ' · ' + T('RGSX {n} games', { n: S.catalog.counts[k].toLocaleString() }) : ''}</span><div class="grow"></div>${folders.length ? `<button class="small" data-sys-top="${k}">Compare with top lists</button>` : ''}</div>
    <h3>Built-in and API lists</h3><table><thead><tr><th>Source</th><th>Games</th><th>Copy</th><th></th></tr></thead><tbody>${srcRows}</tbody></table></div>
  <div class="panel"><h2>Your website lists</h2>${mine ? `<table><thead><tr><th>List</th><th>Games</th><th>Added</th><th></th></tr></thead><tbody>${mine}</tbody></table>` : '<p class="muted">None yet. Import one from the sites below, or any page with a ranked list.</p>'}</div>
  <div class="panel" id="webForm"><h2>Add a list from a website</h2>
    <div class="row"><input type="text" id="webName" placeholder="List name, e.g. Lemon Amiga top games" value="${esc(d.name)}" style="flex:1;min-width:200px"><input type="text" id="webUrl" placeholder="https://…" value="${esc(d.url)}" style="flex:2;min-width:240px"></div>
    <div class="row" style="margin-top:8px"><button data-act="webFetch">Try to read it directly</button>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">Open the page ↗</a>` : ''}</div>
    <p class="muted">Most sites (including Lemon Amiga, Lemon64 and MobyGames) don't let other pages read them, and some check for bots. Use the list grabber on the page in your own browser instead:</p>
    <ol class="muted" style="margin-top:0"><li>Drag <a class="tag warn" href="${esc(bm)}" data-bookmarklet title="Drag me to your bookmarks bar">Grab list for RGSX</a> to your bookmarks bar (once), or <button class="small" data-act="copyGrabber">copy the grabber script</button> to paste into the console (F12).</li>
      <li>Open the list page. Optionally select the list with the mouse for exact results. Click the bookmark (or paste the script into the console).</li>
      <li>It copies the list. Paste it below.</li></ol>
    <textarea id="webPaste" placeholder="Paste the grabber result, or plain text with one title per line"></textarea>
    <div class="row"><label class="muted">or load a saved page (Ctrl+S in the browser) <input type="file" id="webFile" accept=".html,.htm,.txt,.csv,.json"></label></div>
    ${d.items.length ? `<h3>Preview: ${d.items.length} games <span class="muted" style="font-weight:400">(${esc(d.how)}; edit freely, best first)</span></h3><textarea id="webItems" style="min-height:200px">${esc(d.items.join('\n'))}</textarea>
      <div class="row"><button class="primary" data-act="webSave">${d.id ? 'Update list' : T('Save list for {sys}', { sys: sys.label })}</button><button data-act="webClear">Discard</button></div>` : ''}</div>
  ${sites ? `<div class="panel"><h2>${T('Websites with {sys} lists', { sys: sys.label })}</h2><div class="cards">${sites}</div></div>` : ''}`;
}

/* ------------------------------------------------------------------ RGSX tab: check, catalogue, download list, sources */
const RGSX_QUEUE_JSON = 'rgsx-download-queue.json';
const RGSX_QUEUE_CSV = 'rgsx-download-queue.csv';
const RGSX_HOWTO_NAME = 'HOW TO DOWNLOAD WITH RGSX.txt';
const RGSX_HOWTO = `How to download your RGSX wishlist
==================================

The RGSX Library Checker saved a list of things to download:
  ${RGSX_QUEUE_CSV}   (also ${RGSX_QUEUE_JSON})

WINDOWS (RetroBat)
  1. Close RGSX if it is open.
  2. In this folder, double-click:  Download with RGSX.bat
  3. A window lists what it matched and asks you to confirm. Press Y, Enter.

LINUX / macOS / BATOCERA / KNULLI
  Run, on the machine where RGSX is installed:  ./RGSX-download.sh
  (first time: chmod +x RGSX-download.sh). On Batocera/Knulli you can run it
  over SSH or add it as a Port.

Preview without downloading:  add  --dry-run  (e.g.  "Download with RGSX.bat" --dry-run)

KEEP YOUR OWN LIST
  Instead of (or as well as) the buttons, you can hand-write a list. Make a file
  called  rgsx-download-list.txt  in this folder, one title per line:
      Sonic the Hedgehog
      megadrive | Gunstar Heroes      (optional "system | title" pins a system)
  The downloader picks it up automatically, or point it at any file:
      "Download with RGSX.bat" --list mylist.txt

The list can hold catalogue games (added from Top lists, the RGSX tab, your star
wishlist or a pasted/hand-kept list) and free itch.io homebrew jobs. When it
finishes it writes a report and clears the list. It uses the same Python and
catalogue as RGSX, needs no setup of its own, and never changes or deletes your
existing ROMs.`;

// RGSX stores each download-source key as a plain text file in saves/ports/rgsx.
const RGSX_KEY_FILES = { '1fichier': '1FichierAPI.txt', itch: 'ItchioAPI.txt', realdebrid: 'RealDebridAPI.txt', alldebrid: 'AllDebridAPI.txt', debridlink: 'DebridLinkAPI.txt', torbox: 'TorBoxAPI.txt' };
const RGSX_KEY_INFO = {
  '1fichier': { name: '1fichier', about: 'Premium key for 1fichier-hosted games (fast direct downloads).', link: 'https://1fichier.com' },
  itch: { name: 'itch.io', about: 'Free API key so RGSX can install itch.io homebrew.', link: 'https://itch.io/user/settings/api-keys' },
  realdebrid: { name: 'Real-Debrid', about: 'Debrid service for premium links and some torrents.', link: 'https://real-debrid.com/apitoken' },
  alldebrid: { name: 'AllDebrid', about: 'Debrid service for premium links.', link: 'https://alldebrid.com/apikeys' },
  debridlink: { name: 'Debrid-Link', about: 'Debrid service for premium links.', link: 'https://debrid-link.com/webapp/apikey' },
  torbox: { name: 'TorBox', about: 'Debrid / seedbox service.', link: 'https://torbox.app' },
};

async function dirPath(root, parts, create = false) { let d = root; for (const p of parts) d = await d.getDirectoryHandle(p, { create }); return d; }
async function fileAt(root, parts) { try { const d = await dirPath(root, parts.slice(0, -1)); return await (await d.getFileHandle(parts[parts.length - 1])).getFile(); } catch { return null; } }

function rgsxQueueCsv(list) {
  const qv = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  return [['type', 'platform', 'name', 'title', 'year', 'system', 'tag', 'count', 'source'].join(',')]
    .concat(list.map(e => [qv(e.type || 'game'), qv(e.platform), qv(e.name), qv(e.title), e.year || '', qv(e.system), qv(e.tag), e.count || '', qv(e.source)].join(','))).join('\r\n');
}
function rgsxKey(e) { return ((e.type || 'game') === 'itch') ? 'itch|' + (e.system || '') + '|' + (e.tag || '') : 'game|' + (e.platform || '') + '|' + (e.name || ''); }

// Merge rows into the queue and (re)write the runner files beside the page. Returns {added,total}.
async function rgsxWriteQueue(newRows) {
  if (!(S.handles.app && S.writable)) throw new Error('the folder is read-only');
  const existing = (await readJSON(S.handles.app, RGSX_QUEUE_JSON)) || [];
  const seen = new Set(existing.map(e => rgsxKey(e).toLowerCase()));
  let added = 0;
  for (const row of newRows) { const k = rgsxKey(row).toLowerCase(); if (seen.has(k)) continue; seen.add(k); existing.push(row); added++; }
  await writeText(S.handles.app, RGSX_QUEUE_JSON, JSON.stringify(existing, null, 2));
  await writeText(S.handles.app, RGSX_QUEUE_CSV, rgsxQueueCsv(existing));
  await writeText(S.handles.app, 'rgsx_batch_download.py', RUNNER_PY);
  await writeText(S.handles.app, 'Download with RGSX.bat', RUNNER_BAT.replace(/\r?\n/g, '\r\n'));
  await writeText(S.handles.app, 'RGSX-download.sh', RUNNER_SH.replace(/\r?\n/g, '\n'));
  await writeText(S.handles.app, 'rgsx-download-prefs.json', JSON.stringify(S.config.download || { regions: [], langs: [] }, null, 2));
  await writeText(S.handles.app, RGSX_HOWTO_NAME, RGSX_HOWTO.replace(/\r?\n/g, '\r\n'));
  return { added, total: existing.length };
}

// Probe the folder for the download pipeline: runner files, queue, keys, python.
async function rgsxProbe() {
  const r = { runner: {}, keys: {}, queue: [], torrent: null, python: null, done: true };
  const app = S.handles.app;
  if (app) {
    r.runner.py = !!(await tryFile(app, 'rgsx_batch_download.py'));
    r.runner.bat = !!(await tryFile(app, 'Download with RGSX.bat'));
    r.runner.sh = !!(await tryFile(app, 'RGSX-download.sh'));
    r.queue = (await readJSON(app, RGSX_QUEUE_JSON)) || [];
    r.failed = (await readJSON(app, 'rgsx-download-failed.json')) || [];
    r.python = !!(await fileAt(app, ['system', 'tools', 'Python', 'python.exe']));  // Windows bundle
  }
  const rg = S.dirs.rgsx;
  if (rg) {
    for (const [svc, fname] of Object.entries(RGSX_KEY_FILES)) {
      const f = await tryFile(rg, fname); let v = '';
      if (f) { try { v = (await f.text()).trim(); } catch { } }
      r.keys[svc] = !!(f && v);
    }
    try { const s = await readJSON(rg, 'rgsx_settings.json'); r.torrent = !!(s && (s.enable_torrent || s.torrent || s.use_torrent || (s.qbittorrent && Object.keys(s.qbittorrent).length))); } catch { }
  }
  S.rgsx = r; render();
}

function rgsxChecks() {
  const c = [], add = (status, title, detail = '', fix = '') => c.push({ status, title, detail, fix });
  const p = S.rgsx || {};
  add(ENV.ok ? 'ok' : 'err', 'Browser', ENV.ok ? [ENV.name, ENV.os].filter(Boolean).join(' on ') || 'Supported' : 'Can\'t open folders here.', ENV.ok ? '' : 'Use Chrome or Edge.');
  add(S.writable ? 'ok' : 'warn', 'Folder access', S.writable ? 'This page can save files into its folder.' : 'Read-only.', S.writable ? '' : 'Choose the folder again and allow "Edit files". Without it the downloader can\'t be written here.');
  const t = (S.install || {}).type;
  add(t === 'retrobat' || t === 'batocera' ? 'ok' : t ? 'warn' : 'err', 'Installation', t ? (INSTALL_NAME[t] || t) : 'No roms folder found.', t === 'retrobat' || t === 'batocera' ? '' : 'Choose your RetroBat folder or Batocera/Knulli share in Settings › Folders.');
  add((S.install || {}).rgsxApp ? 'ok' : 'warn', 'RGSX app', (S.install || {}).rgsxApp ? 'Installed (roms/ports/RGSX).' : 'Not found.', (S.install || {}).rgsxApp ? '' : 'Install RGSX from github.com/RetroGameSets/RGSX.');
  if (p.python) add('ok', 'Python', 'RGSX\'s bundled Python was found (system/tools/Python).');
  else add('info', 'Python', 'No Windows bundle found here.', 'On RetroBat, starting RGSX once installs it. On Linux/macOS/Batocera/Knulli the downloader uses the system python3 instead.');
  if (!S.catalog) add('warn', 'RGSX catalogue', 'Not read yet.', 'Press Reload catalogue in Settings › Folders (close RGSX first).');
  else { const age = S.catalog.dbModified ? Math.floor((Date.now() - S.catalog.dbModified) / 864e5) : null; add(age != null && age > 14 ? 'warn' : 'ok', 'RGSX catalogue', `${Object.values(S.catalog.counts).reduce((a, b) => a + b, 0).toLocaleString()} games` + (age == null ? '' : age === 0 ? ', updated today' : `, ${age} day(s) old`), age != null && age > 14 ? 'Start RGSX to refresh it, then Reload catalogue.' : ''); }
  const rn = p.runner || {};
  const have = ['py', 'bat', 'sh'].filter(k => rn[k]).length;
  add(have ? 'ok' : 'info', 'Downloader files', have ? `In place (${[rn.py && 'rgsx_batch_download.py', rn.bat && 'Download with RGSX.bat', rn.sh && 'RGSX-download.sh'].filter(Boolean).join(', ')}).` : 'Not written yet.', have ? '' : 'They are written automatically the first time you add something to the download list.');
  add((p.queue || []).length ? 'ok' : 'info', 'Download list', (p.queue || []).length ? `${p.queue.length} item(s) queued.` : 'Empty.', (p.queue || []).length ? 'Run "Download with RGSX.bat" (Windows) or "RGSX-download.sh" (Linux/mac/Batocera) in your folder.' : 'Add games from Top lists or the Catalogue tab.');
  const ks = p.keys || {};
  const set = Object.keys(RGSX_KEY_FILES).filter(k => ks[k]);
  add('info', 'Download sources', set.length ? 'Keys set: ' + set.map(k => RGSX_KEY_INFO[k].name).join(', ') + '.' : 'No optional source keys set.', 'Most games download with no key. Add 1fichier / debrid / itch.io keys under Sources for those hosts.' + (p.torrent ? '' : ' Torrent platforms need qBittorrent (set up in RGSX).'));
  return c;
}
function rgsxChecksTable() {
  const icon = { ok: '✓', warn: '!', err: '✕', info: 'i' }, cls = { ok: 'ok', warn: 'warn', err: 'no', info: '' };
  return '<table><tbody>' + rgsxChecks().map(x => `<tr><td><span class="tag ${cls[x.status]}" translate="no">${icon[x.status]}</span></td><td><b>${esc(x.title)}</b></td><td>${esc(x.detail)}${x.fix ? `<br><small class="muted">${esc(x.fix)}</small>` : ''}</td></tr>`).join('') + '</tbody></table>';
}
function rgsxCheckView() {
  if (!S.rgsx) return `<div class="panel"><div class="empty">Checking…</div></div>`;
  return `<div class="panel"><div class="row"><h2 style="margin:0">Is everything in place?</h2><div class="grow"></div><button class="small" data-act="copyDiag" title="Copy a full diagnostic report to the clipboard">Copy diagnostics</button><button class="small" data-act="rgsxRefresh">Check again</button></div>
    <p class="muted">Checks the whole download pipeline: this folder, the RGSX app and catalogue, the one-click downloader, your download list and the optional source keys. Works for RetroBat on Windows and for a Batocera/Knulli share opened from Windows, macOS or Linux.</p>
    ${rgsxChecksTable()}</div>`;
}
function rgsxCatalogueView() {
  if (!S.catalog) return `<div class="panel"><div class="empty">The RGSX catalogue isn't loaded. Open Settings › Folders and press Reload catalogue (close RGSX first).</div></div>`;
  const plats = Object.keys(S.catalog.platforms).sort((a, b) => ((S.catalog.sources[a] || [a])[0] || a).localeCompare((S.catalog.sources[b] || [b])[0] || b));
  if (!S.rgsxPlat || !S.catalog.platforms[S.rgsxPlat]) S.rgsxPlat = plats[0];
  const label = f => ((S.catalog.sources[f] || [])[0] || f);
  const opts = plats.map(f => `<option value="${esc(f)}" ${f === S.rgsxPlat ? 'selected' : ''}>${esc(label(f))} — ${f} (${(S.catalog.counts[f] || 0).toLocaleString()})</option>`).join('');
  const q = (S.rgsxSearch || '').trim().toLowerCase();
  const allRaw = S.catalog.platforms[S.rgsxPlat] || [];
  const dc = S.config.download || { regions: [], langs: [] };
  const ruleOn = (dc.regions && dc.regions.length) || (dc.langs && dc.langs.length);
  const all = ruleOn ? allRaw.filter(dlAllows) : allRaw;
  const hidden = allRaw.length - all.length;
  const names = (q ? all.filter(n => n.toLowerCase().includes(q)) : all).slice().sort((a, b) => a.localeCompare(b));
  const cap = 400; const shown = names.slice(0, cap);
  const idx = localIndex(S.rgsxPlat);
  const rows = shown.map(n => {
    const have = idx ? findIn(idx, { t: n }) : null;
    const add = esc(JSON.stringify({ p: S.rgsxPlat, n }));
    return `<tr><td style="width:28px"><input type="checkbox" class="catpick" value="${esc(n)}"></td><td><span translate="no">${esc(n)}</span> ${have ? '<span class="tag ok">Installed</span>' : ''}</td><td class="right"><button class="small" data-rgsxadd="${add}">Add ⤓</button></td></tr>`;
  }).join('');
  return `<div class="panel"><div class="row">
      <label>System / program <select id="rgsxPlat">${opts}</select></label>
      <input type="search" id="rgsxSearch" placeholder="Search this platform…" value="${esc(S.rgsxSearch || '')}" style="flex:1;min-width:200px">
      <div class="grow"></div><button class="small" data-act="rgsxGoList">View download list</button></div>
    <p class="muted">Every platform in the RGSX catalogue — consoles, computers, Windows programs, ports and more. Tick games and <b>Add selected</b> (or use a row's <b>Add ⤓</b>); everything in the download list gets fetched when you run the downloader. ${q ? `${names.length} match "${esc(q)}"` : `${all.length.toLocaleString()} items`}${names.length > cap ? `, showing first ${cap} — narrow with search` : ''}.${ruleOn ? ` <span class="tag warn">${hidden.toLocaleString()} hidden by your region/language rules</span> <button class="small" data-setpage="downloads">Change</button>` : ''}</p>
    <div class="row" style="margin-bottom:8px"><button class="small" data-act="catAll">Select all shown</button><button class="small" data-act="catNone">Clear</button><button class="primary" data-act="catAddSel">Add selected ⤓</button></div>
    <table><thead><tr><th></th><th>Game / program</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="empty">Nothing matches. Try a shorter search.</td></tr>'}</tbody></table></div>
  <div class="panel"><h3 style="margin-top:0">Keep your own list</h3>
    <p class="muted">Paste titles (one per line) to add to the download list for <b translate="no">${esc(label(S.rgsxPlat))}</b>. CSV uses the first column. The downloader matches each title to the catalogue when you run it — so this works for lists you keep by hand too. (You can also drop a <code>rgsx-download-list.txt</code> in your folder: one title per line, or <code>system | title</code>.)</p>
    <textarea id="rgsxPaste" placeholder="Sonic the Hedgehog&#10;Streets of Rage 2&#10;Gunstar Heroes"></textarea>
    <div class="row"><button class="primary" data-act="rgsxAddPasted">Add these to the download list</button></div></div>`;
}
function rgsxListView() {
  const list = (S.rgsx && S.rgsx.queue) || [];
  const failed = (S.rgsx && S.rgsx.failed) || [];
  const failKeys = new Set(failed.map(rgsxKey));
  const failTag = e => failKeys.has(rgsxKey(e)) ? ' <span class="tag no" title="Failed on the last run; skipped until you Retry">⚠ failed</span>' : '';
  const rows = list.map(e => (e.type || 'game') === 'itch'
    ? `<tr><td style="width:28px"><input type="checkbox" class="qpick" data-key="${esc(rgsxKey(e))}"></td><td><span class="tag">itch.io</span> <span translate="no">Free homebrew: ${esc(e.system || '')}${e.tag ? ' / ' + esc(e.tag) : ''}</span>${failTag(e)}</td><td class="muted">${esc(e.source || '')}</td></tr>`
    : `<tr><td style="width:28px"><input type="checkbox" class="qpick" data-key="${esc(rgsxKey(e))}"></td><td><span translate="no">${esc(e.title || e.name || '')}</span> <small class="muted" translate="no">${esc(e.platform || '')}</small>${failTag(e)}</td><td class="muted">${esc(e.source || '')}</td></tr>`).join('');
  const wlCount = Object.values(S.config.wishlist || {}).reduce((a, l) => a + ((l && l.length) || 0), 0);
  let failPanel = '';
  if (failed.length) {
    const groups = {};
    for (const e of failed) { const s = String(e.system || e.platform || '?'); (groups[s] ||= []).push(e); }
    const grp = Object.keys(groups).sort().map(s => `<div style="margin-top:8px"><div class="row"><b translate="no">${esc(s)}</b> <span class="tag no">${groups[s].length} failed</span><div class="grow"></div><button class="small" data-rgsxretry="${esc(s)}">Retry ${esc(s)} ⟳</button></div>
      <table><tbody>${groups[s].map(e => `<tr><td><span translate="no">${esc(e.title || e.name || '')}</span></td><td class="muted">${esc(e.reason || 'failed')}${e.at ? ' · ' + esc(String(e.at).slice(0, 16).replace('T', ' ')) : ''}</td></tr>`).join('')}</tbody></table></div>`).join('');
    failPanel = `<div class="panel"><div class="row"><h2 style="margin:0">Failed downloads</h2><span class="tag no">${failed.length}</span><div class="grow"></div><button class="small" data-act="rgsxRetryAll">Retry all ⟳</button><button class="small" data-act="rgsxDropFailed">Drop from list</button></div>
      <p class="muted">These failed on the last run and are <b>skipped automatically</b> next time. <b>Retry</b> clears the failure so they're attempted again (they stay in the download list); <b>Drop from list</b> removes them from the download list entirely.</p>${grp}</div>`;
  }
  return `<div class="panel"><div class="row"><h2 style="margin:0">Download list</h2><div class="grow"></div>
      ${wlCount ? `<button class="small" data-act="sendWishlistToRgsx" title="Add every ☆ wishlist game that is missing and in the catalogue">Add ☆ wishlist (${wlCount})</button>` : ''}
      <button class="small" data-act="rgsxRefresh">Refresh</button>${list.length ? '<button class="small" data-act="clearRgsx">Clear list</button>' : ''}</div>
    ${list.length ? `<div class="row" style="margin:4px 0 8px"><button class="small" data-act="qAll">Select all</button><button class="small" data-act="qNone">Clear</button><button class="small" data-act="qRemoveSel">Remove selected</button><span class="muted">everything here is downloaded when you run the downloader (⚠ failed items are skipped until you Retry)</span></div>
      <table><thead><tr><th></th><th>Item</th><th>Added from</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="notice info" style="margin-top:12px">To download these, go to your folder <b translate="no">${esc((S.handles.app || {}).name || '')}</b> and run <b>Download with RGSX.bat</b> (Windows) or <b>RGSX-download.sh</b> (Linux / macOS / Batocera / Knulli). Close RGSX first. Steps are in <code>${RGSX_HOWTO_NAME}</code>.</div>`
      : '<div class="empty">The list is empty. Add games from Top lists (tick + Add selected) or the Catalogue tab, or send free homebrew from Free games.</div>'}</div>${failPanel}`;
}
function rgsxSourcesView() {
  const ks = (S.rgsx || {}).keys || {};
  const writable = S.handles.app && S.writable && S.dirs.rgsx;
  const rows = Object.entries(RGSX_KEY_INFO).map(([svc, info]) => `<div class="panel"><div class="row"><h3 style="margin:0">${esc(info.name)}</h3> <span class="tag ${ks[svc] ? 'ok' : ''}">${ks[svc] ? 'Key saved' : 'Not set'}</span><div class="grow"></div><a href="${info.link}" target="_blank" rel="noopener">Get a key ↗</a></div>
      <p class="muted">${esc(info.about)}</p>
      <div class="row"><input type="password" id="rgsxkey_${svc}" placeholder="Paste ${esc(info.name)} API key" autocomplete="off" style="flex:1;min-width:220px" ${writable ? '' : 'disabled'}>
        <button class="primary" data-rgsxkey="${svc}" ${writable ? '' : 'disabled'}>Save</button>${ks[svc] ? `<button data-rgsxkeydel="${svc}" ${writable ? '' : 'disabled'}>Remove</button>` : ''}</div></div>`).join('');
  return `<div class="panel"><h2>Download sources</h2>
    <p class="muted">Most games download directly with no key. These optional keys unlock extra hosts, and are saved as the plain text files RGSX reads in <code>saves\\ports\\rgsx</code>. ${writable ? '' : '<b>Allow edit access to your folder (Settings › Folders) to set them here.</b>'}</p>
    <div class="notice info"><b>Torrent platforms</b> (e.g. "Xbox 360 (Torrent)") download through qBittorrent. RGSX sets that up for you — start RGSX once and pick a torrent source. Status detected here: ${(S.rgsx || {}).torrent ? '<span class="tag ok">torrent settings found</span>' : '<span class="tag">not detected</span>'}.</div></div>
    ${rows}`;
}
// A full plain-text report testers can copy when something goes wrong.
function rgsxDiagnostics() {
  const p = S.rgsx || {}, c = S.catalog, L = [];
  const add = s => L.push(s);
  add('RGSX Library Checker diagnostics');
  add('Generated : ' + new Date().toISOString());
  add('App version: ' + APP_VERSION);
  add('');
  add('[Environment]');
  add('  userAgent : ' + navigator.userAgent);
  add('  browser   : ' + JSON.stringify(ENV));
  add('  FS Access : ' + fsSupported);
  add('  language  : ' + (S.config && S.config.lang));
  add('');
  add('[Folders]');
  add('  page folder : ' + ((S.handles.app && S.handles.app.name) || '(none)') + (S.writable ? ' [writable]' : ' [read-only]'));
  add('  paths       : ' + JSON.stringify(S.config.paths || {}));
  add('  install     : ' + JSON.stringify(S.install || {}));
  add('  rom folders : ' + ((S.folders || []).join(', ') || '(none)'));
  add('');
  add('[RGSX catalogue]');
  if (c) {
    add('  games       : ' + Object.values(c.counts).reduce((a, b) => a + b, 0));
    add('  platforms   : ' + Object.keys(c.platforms).length);
    add('  dbModified  : ' + (c.dbModified ? new Date(c.dbModified).toISOString() : '?'));
    add('  revision    : ' + (c.seq || '?'));
    add('  read at     : ' + (c.at || '?'));
  } else add('  not loaded');
  add('');
  add('[Download pipeline]');
  add('  runner files   : ' + JSON.stringify(p.runner || {}));
  add('  python bundle  : ' + p.python);
  add('  queue items    : ' + ((p.queue || []).length));
  add('  source keys    : ' + JSON.stringify(p.keys || {}));
  add('  torrent config : ' + p.torrent);
  add('  download prefs : ' + JSON.stringify((S.config && S.config.download) || {}));
  add('');
  add('[Checks]');
  try { for (const x of rgsxChecks()) add('  [' + x.status.toUpperCase() + '] ' + x.title + ': ' + x.detail + (x.fix ? '  (fix: ' + x.fix + ')' : '')); }
  catch (e) { add('  (could not run checks: ' + e.message + ')'); }
  add('');
  const q = (p.queue || []);
  add('[Queue] ' + q.length + ' item(s)');
  for (const e of q.slice(0, 40)) add('  ' + ((e.type || 'game') === 'itch' ? 'itch:' + (e.system || '') + (e.tag ? '/' + e.tag : '') : (e.platform || '?') + ' | ' + (e.title || e.name || '')));
  if (q.length > 40) add('  …and ' + (q.length - 40) + ' more');
  add('');
  const log = S.diaglog || [];
  add('[Error / warning log] ' + log.length + ' entr(ies)');
  if (!log.length) add('  (nothing logged this session)');
  for (const e of log) add('  ' + e.t + ' [' + e.kind + '] ' + e.msg + (e.extra ? '\n      ' + e.extra.replace(/\n/g, '\n      ') : ''));
  return L.join('\n');
}
async function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { }
  try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.focus(); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; }
}
function showCopyModal(title, text) {
  const o = document.createElement('div'); o.className = 'overlay';
  o.innerHTML = `<div class="modal" style="max-width:780px"><h2>${esc(title)}</h2>
    <p class="muted">If it wasn't copied automatically: click in the box, select all (Ctrl/Cmd+A), copy (Ctrl/Cmd+C), then paste into your message.</p>
    <textarea readonly style="min-height:340px"></textarea>
    <div class="foot"><span></span><div class="row"><button type="button" data-copy>Copy</button><button class="primary" type="button" data-x>Close</button></div></div>`;
  const ta = o.querySelector('textarea'); ta.value = text;
  o.querySelector('[data-x]').onclick = () => o.remove();
  o.querySelector('[data-copy]').onclick = async () => { const ok = await copyText(text); toast(ok ? 'Copied to the clipboard.' : 'Select the text and press Ctrl/Cmd+C.'); };
  document.body.appendChild(o); ta.focus(); ta.select();
}
function viewRgsx() {
  const page = S.rgsxPage || 'check';
  const tab = (id, label) => `<button class="${page === id ? 'primary' : ''}" data-rgsxpage="${id}">${label}</button>`;
  const nav = `<div class="panel"><div class="row">${tab('check', 'Check')}${tab('catalogue', 'Catalogue')}${tab('list', 'Download list')}${tab('sources', 'Sources')}
    <div class="grow"></div><span class="muted">Queue games for RGSX to download, then run the one-click downloader in your folder.</span></div></div>`;
  const body = ({ check: rgsxCheckView, catalogue: rgsxCatalogueView, list: rgsxListView, sources: rgsxSourcesView })[page]();
  return nav + body;
}

/* ------------------------------------------------------------------ help */
function viewHelp() {
  const sec = (id, title, html) => `<div class="panel" id="help-${id}"><h2>${title}</h2>${html}</div>`;
  const toc = [['start', 'Getting started'], ['browsers', 'Browsers and computers'], ['batocera', 'Using it with Batocera'], ['library', 'Library'], ['topn', 'Top lists'], ['rgsx', 'The RGSX catalogue'], ['sources', 'Top list sources'], ['web', 'Lists from websites'], ['keys', 'API keys and encryption'], ['free', 'Free games'], ['files', 'Files and privacy'], ['trouble', 'Troubleshooting']];
  return `<div class="split"><div class="panel"><b>Help</b><div class="syslist" style="max-height:none">${toc.map(([id, t]) => `<div class="sysitem" data-helpgo="${id}"><span>${t}</span></div>`).join('')}</div></div><div>
  ${sec('start', 'Getting started', `<ol>
    <li>Put <code>rgsx-library-checker.html</code> in your RetroBat folder (for example <code>C:\\RetroBat</code>) or the Batocera <code>share</code> folder.</li>
    <li>Open it in <b>Chrome</b> or <b>Edge</b>. Firefox and Safari can't open folders from a web page.</li>
    <li>Click <b>Choose this page's folder…</b> and pick the folder the page is in. Allow <i>view and edit</i>.</li>
    <li>The page finds <code>roms</code> and the RGSX database (<code>saves\\ports\\rgsx\\rgsx.sqlite3</code>) itself and scans your library. If it can't find them, choose them in <b>Settings › Folders</b>.</li></ol>
    <p class="muted">Each time you open the page the browser may ask you to allow access again; click the button it shows. That's a browser safety rule.</p>`)}
  ${sec('browsers', 'Browsers and computers', `<p>The page works in <b>Google Chrome</b>, <b>Microsoft Edge</b>, <b>Chromium</b>, <b>Opera</b> and <b>Vivaldi</b> on <b>Windows</b>, <b>macOS</b> and <b>Linux</b>. These are the browsers that let a page open a folder you choose.</p>
    <ul><li><b>Firefox</b> and <b>Safari</b> can't open folders, so the page shows a warning. Help and Free games still work.</li>
    <li><b>Brave</b>: turn on <code>brave://flags/#file-system-access-api</code> and restart.</li>
    <li>Phones and tablets can't open folders from a web page.</li></ul>
    <p><b>RetroBat</b> runs on Windows: put the page in the RetroBat folder. For <b>Batocera</b>, open its <code>share</code> folder over the network (Windows: <code>\\\\BATOCERA\\share</code>; macOS: Finder › Go › Connect to Server › <code>smb://batocera/share</code>; Linux: your file manager's network location, or mount it) and put the page there, or choose that folder from anywhere.</p>`)}
  ${sec('batocera', 'Using it with Batocera', `<p>Batocera runs on its own machine, so you open its <code>share</code> folder from your computer over the network. The Batocera machine must be on and connected to the same network.</p>
    <ol><li>On Batocera, check the network is connected: Main menu › <b>Network settings</b> shows its IP address. The machine is called <code>BATOCERA</code> unless you renamed it.</li>
    <li>Open the share from your computer:<ul>
      <li><b>Windows</b>: in File Explorer's address bar type <code>\\\\BATOCERA\\share</code> (or <code>\\\\192.168.x.x\\share</code>).</li>
      <li><b>macOS</b>: Finder › Go › <b>Connect to Server</b>, enter <code>smb://batocera.local/share</code> (or the IP address) and connect as <b>Guest</b>.</li>
      <li><b>Linux</b>: in your file manager open <b>Other Locations</b> and enter <code>smb://batocera.local/share</code>, or mount it with <code>mount -t cifs //batocera.local/share /mnt/batocera -o guest</code>.</li></ul></li>
    <li>Copy <code>rgsx-library-checker.html</code> into the share, then open it in Chrome or Edge. (Or keep the page on your computer and choose the share folder when asked.)</li>
    <li>When asked, choose the <code>share</code> folder itself (it holds <code>roms</code>, <code>saves</code>, <code>bios</code> and <code>system</code>). The page recognises it as a Batocera share.</li>
    <li>RGSX on Batocera is under <b>Ports</b>. Start it there to update its catalogue, then press <b>Reload catalogue</b> here.</li></ol>
    <p class="muted">Reading over the network is slower, especially on Wi-Fi: the first scan can take a few minutes, then results are cached. <b>Settings › Setup check</b> shows whether everything was found.</p>`)}
  ${sec('library', 'Library', `<p>Lists every ROM folder with the number of game files, and the RGSX catalogue size. Choose a system to see its games, using the names from <code>gamelist.xml</code> when you've scraped. The dropdown shows all systems, only empty ones, or only those with ROMs. <b>Rescan all</b> picks up new games.</p>`)}
  ${sec('topn', 'Top lists', `<p>Pick a system, a source and a size (10 to 500). Each game shows <span class="tag ok">Installed</span> or <span class="tag no">Missing</span>; missing games that the RGSX catalogue has are marked <span class="tag warn">In RGSX catalogue</span>, so you can fetch them with RGSX. Choose <b>All systems</b> for a coverage table. Use ☆ for a wishlist, and <b>Export missing</b> for a CSV.</p>
    <p>A game can be marked missing when its file is named very differently from the list title (for example US and Japanese names). Scraping your library with names in <code>gamelist.xml</code> improves matching a lot.</p>`)}
  ${sec('rgsx', 'The RGSX catalogue', `<p>The page reads the game catalogue that RGSX keeps (<code>saves\\ports\\rgsx\\rgsx.sqlite3</code>) to show which missing games RGSX can download. It never changes it, and it can't download the catalogue itself: the catalogue server only answers RGSX.</p>
    <ol><li>Start RGSX (RetroBat: <b>Ports</b> or <b>Windows</b> › <b>RGSX Retrobat</b>; Batocera: <b>Ports</b>). It updates the catalogue each time it starts.</li>
    <li>For a complete refresh: RGSX menu (Start, or Esc) › <b>Games</b> › <b>Refresh game catalog</b>.</li>
    <li>Close RGSX, then press <b>Reload catalogue</b> in <b>Settings › Folders</b>, which also shows how old the catalogue is.</li></ol>
    <h3>Downloading with RGSX</h3>
    <p>This page can hand a whole list of games to RGSX to download. Build the list in two places: on a system's <b>Top list</b>, <b>Send to RGSX ⤓</b> queues every missing game the catalogue has; and on the new <b>RGSX</b> tab, the <b>Catalogue</b> browser lets you search <i>any</i> of RGSX's platforms — consoles, computers, Windows programs, ports — and <b>Add ⤓</b> individual items. The <b>Free games</b> tab can also queue free itch.io homebrew for a system. Everything lands in one list.</p>
    <p>Adding anything drops a one-click downloader into this page's folder: <code>Download with RGSX.bat</code> (Windows), <code>RGSX-download.sh</code> (Linux / macOS / Batocera / Knulli), <code>rgsx_batch_download.py</code> and a plain-text <code>HOW TO DOWNLOAD WITH RGSX.txt</code>. On the machine where RGSX is installed, run the <code>.bat</code> or <code>.sh</code> (close RGSX first). It matches each item in the catalogue, asks you to confirm, and hands them to RGSX to download into the right folders. The <b>RGSX › Check</b> tab tests that everything is in place; <b>RGSX › Sources</b> lets you add optional 1fichier / debrid / itch.io keys (torrent platforms use qBittorrent, which RGSX sets up). The downloader uses the same Python and catalogue as RGSX, needs no setup of its own, and never changes or deletes your ROMs. Anyone you give the page to gets the same flow.</p>`)}
  ${sec('sources', 'Top list sources', `<table><tbody>${Object.values(SOURCE_INFO).map(v => `<tr><td><b>${esc(v.name)}</b></td><td class="muted">${esc(v.about)}</td></tr>`).join('')}</tbody></table>
    <p class="muted">Built-in lists are bundled, so they work offline. <b>Update</b> (Top lists, or Settings › a system) fetches fresh copies. Some sources only cover some systems; the source menu shows how many games each has for the chosen system.</p>`)}
  ${sec('web', 'Lists from websites', `<p>Community sites such as Lemon Amiga, Lemon64, Spectrum Computing, Atarimania, Generation MSX and MobyGames keep their own top lists. To use one:</p>
    <ol><li>Go to <b>Settings</b> and choose the system on the left. Its page suggests sites with lists for it.</li>
    <li>Click <b>Import this list…</b> (or type a name and the address of any page).</li>
    <li>Try <b>Try to read it directly</b>. Most sites block this, so use the <b>list grabber</b>: drag <i>Grab list for RGSX</i> to the bookmarks bar, open the list page, click the bookmark. If the guess is wrong, select the list with the mouse and click it again.</li>
    <li>Paste the result into the box, check the preview, and save. The list appears as a source on the Top lists page for that system. <b>Re-import</b> refreshes it later.</li></ol>
    <p class="muted">You can also save the page with Ctrl+S and load the .html file, or paste plain text with one title per line.</p>`)}
  ${sec('keys', 'API keys and encryption', `<p>RetroAchievements (most played) and RAWG (user rating, Metacritic, popularity) need free personal API keys. Add them in <b>Settings › API keys</b>.</p>
    <ul><li>Keys are encrypted with AES-256-GCM before they're saved in the config file, and decrypted only in memory.</li>
    <li><b>This browser</b> mode keeps the encryption key inside the browser, where it can't be exported: anyone who copies the config file can't read the keys.</li>
    <li><b>Passphrase</b> mode derives the key from your passphrase (PBKDF2, 310,000 rounds). Nothing that can decrypt is stored; you unlock once per visit, on any computer.</li>
    <li>Each key is only sent to its own service, as part of that service's API requests.</li></ul>
    <p class="muted">The RetroAchievements list checks player counts for the games in the built-in lists, one request at a time, so it takes a few minutes per system. Results are cached.</p>`)}
  ${sec('free', 'Free games', `<p>Top-rated free games from itch.io by genre: retro homebrew ROMs for your systems, or PC and browser games. Open a game's page to download it, then put the ROM in the system's folder (shown on the page) and update your game lists in RetroBat. Games you already have are marked Installed.</p>
    <p>The list is a <b>bundled snapshot</b> that works offline, so you don't have to do anything. To fetch newer listings (optional):</p>
    <ol><li>In <b>Settings › itch.io data</b>, click <b>Copy refresh script</b>.</li>
      <li>Open <b>itch.io</b> in Chrome or Edge (any page, no login needed).</li>
      <li>Open the console — press <b>F12</b> (or Ctrl+Shift+J, or ⌥⌘J on Mac) and click <b>Console</b>. If it warns about pasting, type <code>allow pasting</code> and press Enter first.</li>
      <li><b>Paste</b> the script and press <b>Enter</b>. It reads itch's public free-game feeds and logs progress like <code>itch refresh 12/80</code>; leave the tab open for a few minutes.</li>
      <li>It downloads <code>itch-free.json</code> to your Downloads. Back in <b>Settings › itch.io data</b>, click <b>Import</b> and choose that file.</li></ol>
    <p>This only refreshes what the Free games tab <i>shows</i>. <b>Installing</b> free homebrew through RGSX (the "Send free homebrew to RGSX" button) is separate and uses an itch.io API key set under <b>RGSX › Sources</b>.</p>`)}
  ${sec('files', 'Files and privacy', `<ul><li><code>${CONFIG_NAME}</code>: your settings, website lists, wishlist and encrypted API keys.</li><li><code>${CACHE_DIR}</code>: scan results, downloaded lists and the RGSX catalogue index. Safe to delete.</li></ul>
    <p class="muted">The page never changes your ROMs or the RGSX database. Internet requests go only to Wikidata, Wikipedia and Wikimedia (lists), and to RetroAchievements and RAWG if you add keys.</p>`)}
  ${sec('trouble', 'Troubleshooting', `<ul><li><b>"This browser can't open folders"</b>: use Chrome or Edge.</li>
    <li><b>RGSX database can't be read</b>: close RGSX and press <b>Reload catalogue</b> in Settings › Folders.</li>
    <li><b>Missing games RGSX should have</b>: update the RGSX catalogue (start RGSX, or its menu › Games › Refresh game catalog), then Settings › Folders › <b>Reload catalogue</b>.</li>
    <li><b>Counts look wrong after adding games</b>: Library › <b>Rescan all</b>.</li>
    <li><b>The grabber found the wrong list</b>: select just the list with the mouse, then click the bookmark again.</li>
    <li><b>An API list fails</b>: check the key with <b>Test</b> in Settings › API keys. RetroAchievements limits how fast you can ask; wait and try again.</li>
    <li><b>Start again</b>: Settings › General › <b>Forget folders</b>, or delete the config file and cache folder.</li></ul>`)}
  </div></div>`;
}

/* ------------------------------------------------------------------ getting started */

function showIntro() {
  const o = $('#intro');
  o.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="introTitle">
    <h2 id="introTitle">Getting started</h2>${browserWarning()}
    <div id="introBody">${introBody()}</div>
    <div class="foot"><label><input type="checkbox" id="introHide" ${S.config.showGettingStarted && !ls.get('rlc.hideIntro') ? '' : 'checked'}> Don't show this again</label>
      <div class="row" id="introButtons">${introButtons()}</div></div></div>`;
  o.classList.remove('hidden'); translateDom(o);
}
/* The getting started page shows one instruction and the folder button. The other steps and the check results
   only appear when a check finds a problem; otherwise it says everything is set up. */
function introBody() {
  const pl = pageLocation();
  const step1 = ENV.os === 'macOS' || ENV.os === 'Linux'
    ? `<b>Put this file in your Batocera share folder</b> (open it over the network: <code>smb://batocera.local/share</code>; see Help › Using it with Batocera), or anywhere on your computer.`
    : `<b>Put this file in your RetroBat folder</b> (for example <code>C:\\RetroBat</code>), or in the Batocera <code>share</code> folder (on Windows: <code>\\\\BATOCERA\\share</code>; see Help › Using it with Batocera).`;
  let html = `<p>${step1} ${pl.folder ? `It's currently in <code>${esc(pl.folder)}</code>.` : ''}</p>`;
  if (!S.handles.app || S.needsReconnect) return html;
  const checks = setupChecks(), busy = S.scanning || /RGSX/.test(S.busy);
  const problems = checks.filter(x => x.status === 'err' || x.status === 'warn');
  if (busy) html += `<p class="muted">${S.scanning ? 'Scanning your library…' : 'Reading the RGSX database…'}</p>`;
  if (problems.length) {
    const icon = { warn: '!', err: '✕' }, cls = { warn: 'warn', err: 'no' };
    html += `<h3>Needs attention</h3><table><tbody>${problems.map(x => `<tr><td><span class="tag ${cls[x.status]}" translate="no">${icon[x.status]}</span></td><td><b>${esc(x.title)}</b></td><td>${esc(x.detail)}${x.fix ? `<br><small class="muted">${esc(x.fix)}</small>` : ''}</td></tr>`).join('')}</tbody></table>
      <h3>How to set it up</h3><ol>
      <li><b>Open it in Chrome or Edge</b> and choose <b>${pl.folder ? 'this page\'s folder' : 'the folder that holds this page'}</b>. Allow the browser to <i>view and edit</i> files: the page only writes its own <code>${CONFIG_NAME}</code> and a <code>${CACHE_DIR}</code> folder.</li>
      <li>The <code>roms</code> folder and the RGSX database (<code>saves\\ports\\rgsx\\rgsx.sqlite3</code>) are found automatically. If they're somewhere else, the page asks you to choose them, or use <b>Settings</b>.</li>
      <li>Use <b>Library</b> to browse installed games, <b>Top lists</b> to compare a system with a top list from your chosen source, and <b>Free games</b> for top free homebrew and PC games by genre.</li></ol>
      <p class="muted">Each time you open the page, the browser may ask you to allow access again; that's a browser safety rule. Nothing is uploaded: the only internet requests are list updates from Wikidata and Wikipedia when you ask for them.</p>`;
  } else if (!busy) html += `<div class="notice info"><span class="tag ok" translate="no">✓</span> Everything is set up. Use <b>Library</b>, <b>Top lists</b> and <b>Free games</b>; <b>Settings › Setup check</b> has the details.</div>`;
  return html;
}
function introButtons() {
  return (!S.handles.app && fsSupported ? `<button class="primary" data-act="introPick">Choose this page's folder…</button>` : '')
    + `<button ${S.handles.app ? 'class="primary"' : ''} data-act="introClose">${S.handles.app ? 'Done' : 'Close'}</button>`;
}
// Keeps the checks in the getting started page current while the folder is scanned and the catalogue is read.
function refreshIntroChecks() {
  const o = $('#intro'); if (o.classList.contains('hidden')) return;
  const c = o.querySelector('#introBody'), b = o.querySelector('#introButtons');
  if (c) { c.innerHTML = introBody(); translateDom(c); }
  if (b) { b.innerHTML = introButtons(); translateDom(b); }
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
function parseWebInput(text, fileName = '', pageUrl = '') {
  // Grabber JSON, a saved HTML page, or plain text.
  const t = String(text || '').trim(); if (!t) return null;
  if (t.startsWith('{')) { try { const j = JSON.parse(t); if (Array.isArray(j.items)) return { items: j.items, how: 'list grabber: ' + (j.how || ''), name: j.name, url: j.url }; } catch { } }
  if (/\.html?$/i.test(fileName) || /^<!doctype html|<html[\s>]/i.test(t)) {
    const doc = new DOMParser().parseFromString(t, 'text/html');
    const base = doc.createElement('base'); base.href = pageUrl || (doc.querySelector('link[rel=canonical]') || {}).href || 'https://example.invalid/'; doc.head.prepend(base);
    const r = rlcExtractList(doc, ''); return { items: r.items, how: 'saved page, ' + r.how, name: (doc.title || '').trim() };
  }
  return { items: parseListText(t, fileName), how: 'pasted text' };
}
function setDraft(patch) {
  const k = S.setPage.slice(4);
  const cur = S.webDraft && S.webDraft.sys === k ? S.webDraft : { sys: k, name: '', url: '', items: [], how: '' };
  const name = $('#webName') ? $('#webName').value : cur.name, url = $('#webUrl') ? $('#webUrl').value : cur.url;
  S.webDraft = { ...cur, name, url, ...patch };
  render(); const f = document.getElementById('webForm'); if (f) f.scrollIntoView({ block: 'start' });
}
const actions = {
  pickApp, pickRetro, pickRgsx, reconnect,
  intro: () => { S.introDismissed = false; showIntro(); },
  introPick: () => pickApp(),   // the getting started page stays open and shows the checks
  introClose: closeIntro,
  scanAll: () => scanAll(),
  scanOne: async () => { S.busy = 'Scanning ' + sysLabel(S.sel) + '…'; renderStatus(); await scanFolder(S.sel); S.busy = ''; await cacheWrite('scan.json', { v: SCAN_VERSION, at: new Date().toISOString(), scan: S.scan }); render(); },
  more: () => { S.libLimit += 1000; render(); },
  toTop: () => { S.config.topN.system = FOLDER2SYS[S.sel]; S.tab = 'topn'; saveConfig(); render(); },
  reloadCat: () => loadCatalog(true),
  refreshLists: () => {
    const c = S.config.topN; const sys = c.system && c.system !== '*' ? [c.system] : topSystems();
    refreshLists(sys, c.source === 'blend' ? BUILTIN : [c.source]);
  },
  refreshAll: () => refreshLists(topSystems(), BUILTIN),
  refreshApi: () => refreshLists(topSystems(), API_SOURCES.filter(s => Vault.has(SOURCE_INFO[s].service))),
  clearLists: async () => { S.lists = {}; await cacheWrite('toplists.json', {}); render(); },
  exportMissing: () => {
    const c = S.config.topN; const r = compareSystem(c.system, c.source, +c.size); if (!r) return;
    const q = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
    const lines = [['Rank', 'Title', 'Year', 'In RGSX catalogue'].join(',')].concat(r.items.filter(x => !x.have).map(x => [x.rank, q(x.e.t), x.e.y || '', x.cat ? q(x.cat[0].f) : ''].join(',')));
    download(`missing-${c.system}-top${c.size}-${c.source.replace(/\W/g, '')}.csv`, lines.join('\r\n'));
  },
  // Queue the missing-but-available games and drop a one-click downloader in the folder.
  sendToRgsx: async () => {
    const c = S.config.topN; const r = compareSystem(c.system, c.source, +c.size); if (!r) return;
    if (!S.catalog) return toast('Load the RGSX catalogue first (Settings › Folders).', 'warn');
    const dl = r.items.filter(x => !x.have && x.cat);
    if (!dl.length) return toast('None of the missing games from this list are in the RGSX catalogue.', 'warn');
    const cand = [...r.folders, c.system, ...((SYSTEMS[c.system] || {}).aliases || [])];
    const plat = cand.find(f => (S.catalog.platforms[f] || []).length) || r.folders[0] || c.system;
    const rows = dl.map(x => ({ type: 'game', platform: plat, name: x.cat[0].f, title: x.e.t, year: x.e.y || '', system: c.system, source: c.source }));
    if (!(S.handles.app && S.writable)) {
      download('rgsx-download-queue.csv', rgsxQueueCsv(rows));
      return toast('Your folder is read-only, so the list went to Downloads. Allow edit access (Settings › Folders), or move the file next to this page, then run “Download with RGSX”.', 'warn');
    }
    let res; try { res = await rgsxWriteQueue(rows); } catch (e) { return toast('Could not write to the folder: ' + e.message, 'err'); }
    if (S.rgsx) rgsxProbe();
    await dialog({
      title: 'Download list ready',
      body: `Added ${res.added} game(s); ${res.total} now queued. In your folder "${S.handles.app.name}", run "Download with RGSX.bat" (Windows) or "RGSX-download.sh" (Linux / macOS / Batocera / Knulli) to fetch them through RGSX — close RGSX first. Full steps are in "${RGSX_HOWTO_NAME}". You can add more from the RGSX tab.`,
      ok: 'Got it', cancel: 'Close'
    });
  },
  rgsxRefresh: () => { rgsxProbe(); },
  copyDiag: async () => {
    const text = rgsxDiagnostics();
    const ok = await copyText(text);
    if (ok) toast('Diagnostics copied to the clipboard — paste them into your bug report.');
    else showCopyModal('RGSX diagnostics', text);
  },
  rgsxGoList: () => { S.rgsxPage = 'list'; render(); window.scrollTo(0, 0); },
  rgsxAddItch: async () => {
    const c = S.config.free; const sys = c.system; if (!sys) return toast('Choose a system on the Free games tab first.', 'warn');
    if (!(S.handles.app && S.writable)) return toast('Your folder is read-only. Allow edit access in Settings › Folders.', 'warn');
    const tag = (ITCH_TAGS[sys] || [])[0] || '';
    const row = { type: 'itch', system: sys, tag, count: 25, title: 'Free homebrew: ' + (SYSTEMS[sys]?.label || sys), source: 'itch.io' };
    let res; try { res = await rgsxWriteQueue([row]); } catch (e) { return toast('Could not write to the folder: ' + e.message, 'err'); }
    if (S.rgsx) rgsxProbe();
    toastT('Queued free {sys} homebrew for RGSX ({total} in the list). Run the downloader in your folder; it needs an itch.io key (RGSX tab › Sources).', { sys: SYSTEMS[sys]?.label || sys, total: res.total });
  },
  clearRgsx: async () => {
    if (!(S.handles.app && S.writable)) return toast('The folder is read-only, so there is nothing to clear here.', 'warn');
    let removed = false;
    for (const n of ['rgsx-download-queue.json', 'rgsx-download-queue.csv']) { try { await S.handles.app.removeEntry(n); removed = true; } catch { } }
    toast(removed ? 'RGSX download list cleared.' : 'No download list to clear.');
  },
  rgsxRetryAll: async () => {
    if (!(S.handles.app && S.writable)) return toast('The folder is read-only.', 'warn');
    try { await S.handles.app.removeEntry('rgsx-download-failed.json'); } catch { }
    toast('Cleared the failed list — those items will be attempted again next run.');
    await rgsxProbe();
  },
  rgsxDropFailed: async () => {
    if (!(S.handles.app && S.writable)) return toast('The folder is read-only.', 'warn');
    const failed = (await readJSON(S.handles.app, 'rgsx-download-failed.json')) || [];
    if (!failed.length) return toast('No failed items to drop.');
    const keys = new Set(failed.map(rgsxKey));
    const q = (await readJSON(S.handles.app, RGSX_QUEUE_JSON)) || [];
    const kept = q.filter(e => !keys.has(rgsxKey(e)));
    try {
      await writeText(S.handles.app, RGSX_QUEUE_JSON, JSON.stringify(kept, null, 2));
      await writeText(S.handles.app, RGSX_QUEUE_CSV, rgsxQueueCsv(kept));
      await S.handles.app.removeEntry('rgsx-download-failed.json');
    } catch (e) { return toast('Could not update the lists: ' + e.message, 'err'); }
    toastT('Dropped {n} failed item(s) from the download list.', { n: failed.length });
    await rgsxProbe();
  },
  // Add every starred (☆) wishlist game that is missing and in the catalogue.
  sendWishlistToRgsx: async () => {
    if (!S.catalog) return toast('Load the RGSX catalogue first (Settings › Folders).', 'warn');
    if (!(S.handles.app && S.writable)) return toast('Your folder is read-only. Allow edit access in Settings › Folders.', 'warn');
    const wl = S.config.wishlist || {};
    const systems = Object.keys(wl).filter(k => (wl[k] || []).length);
    if (!systems.length) return toast('Your wishlist is empty. Star games (☆) on the Top lists tab first.', 'warn');
    const rows = []; let unresolved = 0;
    for (const k of systems) {
      const want = new Set(wl[k]); const found = new Set();
      const cand = [...foldersFor(k), k, ...((SYSTEMS[k] || {}).aliases || [])];
      const plat = cand.find(f => (S.catalog.platforms[f] || []).length) || foldersFor(k)[0] || k;
      for (const src of [S.config.topN.source, 'wikidata', 'blend']) {
        const r = compareSystem(k, src, 500); if (!r) continue;
        for (const x of r.items) { const key = norm(x.e.t); if (want.has(key) && !found.has(key) && !x.have && x.cat) { rows.push({ type: 'game', platform: plat, name: x.cat[0].f, title: x.e.t, year: x.e.y || '', system: k, source: 'wishlist' }); found.add(key); } }
      }
      unresolved += [...want].filter(key => !found.has(key)).length;
    }
    if (!rows.length) return toast('None of your wishlisted games are both missing and in the RGSX catalogue right now.', 'warn');
    let res; try { res = await rgsxWriteQueue(rows); } catch (e) { return toast('Could not write to the folder: ' + e.message, 'err'); }
    if (S.rgsx) rgsxProbe();
    toastT('Added {n} wishlisted game(s) to the download list ({total} total).{extra}', { n: rows.length, total: res.total, extra: unresolved ? ` ${unresolved} not added (already installed, or not in the catalogue).` : '' });
  },
  // Add a pasted plain list of titles for the currently selected catalogue platform.
  rgsxAddPasted: async () => {
    const el = $('#rgsxPaste'); const titles = parseListText(el ? el.value : '').filter(Boolean);
    if (!titles.length) return toast('Paste at least one title.', 'warn');
    if (!(S.handles.app && S.writable)) return toast('Your folder is read-only. Allow edit access in Settings › Folders.', 'warn');
    const plat = S.rgsxPlat || '';
    const rows = titles.map(t => ({ type: 'game', platform: plat, name: t, title: t, source: 'pasted' }));
    let res; try { res = await rgsxWriteQueue(rows); } catch (e) { return toast('Could not write to the folder: ' + e.message, 'err'); }
    if (S.rgsx) rgsxProbe();
    toastT('Added {n} title(s){plat} to the download list ({total} total). The downloader matches each to the catalogue when you run it.', { n: rows.length, plat: plat ? ' for ' + plat : '', total: res.total });
  },
  // --- multi-select helpers (operate on the DOM checkboxes; no re-render until add/remove) ---
  catAll: () => document.querySelectorAll('.catpick').forEach(b => b.checked = true),
  catNone: () => document.querySelectorAll('.catpick').forEach(b => b.checked = false),
  catAddSel: async () => {
    const boxes = [...document.querySelectorAll('.catpick:checked')];
    if (!boxes.length) return toast('Tick some games first.', 'warn');
    if (!(S.handles.app && S.writable)) return toast('Your folder is read-only. Allow edit access in Settings › Folders.', 'warn');
    const plat = S.rgsxPlat || '';
    const rows = boxes.map(b => ({ type: 'game', platform: plat, name: b.value, title: b.value, source: 'catalogue' }));
    let res; try { res = await rgsxWriteQueue(rows); } catch (e) { return toast('Could not write to the folder: ' + e.message, 'err'); }
    if (S.rgsx) rgsxProbe();
    toastT('Added {n} game(s) to the download list ({total} total).', { n: rows.length, total: res.total });
  },
  topAll: () => document.querySelectorAll('.toppick').forEach(b => b.checked = true),
  topNone: () => document.querySelectorAll('.toppick').forEach(b => b.checked = false),
  topAddSel: async () => {
    const boxes = [...document.querySelectorAll('.toppick:checked')];
    if (!boxes.length) return toast('Tick some games first (only missing games that RGSX has can be ticked).', 'warn');
    if (!(S.handles.app && S.writable)) return toast('Your folder is read-only. Allow edit access in Settings › Folders.', 'warn');
    const c = S.config.topN;
    const rows = boxes.map(b => ({ type: 'game', platform: b.dataset.plat, name: b.dataset.name, title: b.dataset.title, system: c.system, source: c.source }));
    let res; try { res = await rgsxWriteQueue(rows); } catch (e) { return toast('Could not write to the folder: ' + e.message, 'err'); }
    if (S.rgsx) rgsxProbe();
    toastT('Added {n} game(s) to the download list ({total} total). Run the downloader in your folder to fetch them.', { n: rows.length, total: res.total });
  },
  qAll: () => document.querySelectorAll('.qpick').forEach(b => b.checked = true),
  qNone: () => document.querySelectorAll('.qpick').forEach(b => b.checked = false),
  qRemoveSel: async () => {
    const keys = new Set([...document.querySelectorAll('.qpick:checked')].map(b => b.dataset.key));
    if (!keys.size) return toast('Tick items to remove first.', 'warn');
    if (!(S.handles.app && S.writable)) return toast('Your folder is read-only.', 'warn');
    const existing = (await readJSON(S.handles.app, RGSX_QUEUE_JSON)) || [];
    const kept = existing.filter(e => !keys.has(rgsxKey(e)));
    try { await writeText(S.handles.app, RGSX_QUEUE_JSON, JSON.stringify(kept, null, 2)); await writeText(S.handles.app, RGSX_QUEUE_CSV, rgsxQueueCsv(kept)); }
    catch (e) { return toast('Could not update the list: ' + e.message, 'err'); }
    toastT('Removed {n}. {total} left in the download list.', { n: existing.length - kept.length, total: kept.length });
    await rgsxProbe();
  },
  addList: () => {
    const name = $('#clName').value.trim() || 'My list'; const items = parseListText($('#clItems').value);
    if (!items.length) return toast('Paste at least one game title.', 'warn');
    S.config.customLists.push({ id: Date.now().toString(36), name, system: '*', items, added: new Date().toISOString() });
    saveConfig(); toastT('Added "{name}" with {n} games.', { name, n: items.length });
  },
  copyItch: async () => { try { await navigator.clipboard.writeText(ITCH_SCRIPT); toast('Refresh script copied. Paste it into the console on itch.io.'); } catch { download('itch-refresh.js', ITCH_SCRIPT, 'text/javascript'); } },
  copyGrabber: async () => { try { await navigator.clipboard.writeText(GRABBER_SCRIPT); toast('Grabber copied. On the list page press F12, open Console, paste and press Enter.'); } catch { download('list-grabber.js', GRABBER_SCRIPT, 'text/javascript'); } },
  dropItch: async () => { S.itch = null; await cacheWrite('itch-free.json', null); render(); },
  freeTile: () => { S.config.free.view = 'tile'; saveConfig(); render(); },
  freeList: () => { S.config.free.view = 'list'; saveConfig(); render(); },
  hhSearch: () => hhLoad(false),
  hhMore: () => { if (S.hh) { S.hh.page++; hhLoad(true); } },
  hhSetApi: async () => {
    const cur = S.config.free.hhApi || '';
    const r = await dialog({ title: 'Homebrew Hub API', body: 'API root of your Homebrew Hub instance, e.g. https://yourhost/api (your deployed fork). Leave blank to use the public hh.gbdev.io API. The instance must allow cross-origin requests from this page.', fields: [{ id: 'url', label: 'API root URL', value: cur }], ok: 'Save' });
    if (!r) return;
    const u = (r.url || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) return toast('Enter a full URL starting with http:// or https://', 'warn');
    S.config.free.hhApi = u; saveConfig();
    if (S.hh) S.hh.started = false;
    toast(u ? 'Homebrew Hub source set to your instance.' : 'Using the public Homebrew Hub API.');
    render();
  },
  dlRegionsAll: () => { const c = (S.config.download ||= { regions: [], langs: [] }); c.regions = c.regions.length === DL_REGIONS.length ? [] : DL_REGIONS.map(x => x[0]); saveConfig(); rgsxWritePrefs(); render(); },
  dlLangsAll: () => { const c = (S.config.download ||= { regions: [], langs: [] }); c.langs = c.langs.length === DL_LANGS.length ? [] : DL_LANGS.map(x => x[0]); saveConfig(); rgsxWritePrefs(); render(); },
  forget: async () => { for (const k of ['app', 'retro', 'rgsx']) await idb.set(k, undefined); S.handles = { app: null, retro: null, rgsx: null }; S.dirs = { roms: null, rgsx: null }; S.scan = {}; S.catalog = null; S.folders = []; render(); },
  toggleAllSys: () => { S.showAllSys = !S.showAllSys; render(); },
  recheck: async () => { await connect(false); S.tab = 'settings'; S.setPage = 'check'; render(); },
  unlock: async () => { await Vault.unlock(true); render(); },
  webFetch: async () => {
    const url = $('#webUrl').value.trim(); if (!/^https?:\/\//i.test(url)) return toast('Enter the page address, starting with https://', 'warn');
    S.busy = 'Reading ' + url + '…'; renderStatus();
    try {
      const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
      const res = parseWebInput(await r.text(), 'page.html', url);
      if (!res.items.length) throw new Error('no list found on the page');
      setDraft({ items: res.items, how: res.how.replace('saved page', 'read directly'), name: $('#webName').value || res.name || '' });
    } catch (e) { toastT('The site didn\'t allow a direct read ({error}). Use the list grabber on the page instead.', { error: e.message }, 'warn'); }
    finally { S.busy = ''; renderStatus(); }
  },
  webSave: () => {
    const d = S.webDraft; const items = parseListText($('#webItems').value);
    const name = ($('#webName').value || '').trim() || 'Website list', url = ($('#webUrl').value || '').trim();
    if (!items.length) return toast('The list is empty.', 'warn');
    const now = new Date().toISOString();
    const old = d.id && S.config.customLists.find(l => l.id === d.id);
    if (old) Object.assign(old, { name, url, items, added: now });
    else S.config.customLists.push({ id: Date.now().toString(36), name, system: d.sys, url, items, added: now });
    S.webDraft = null; saveConfig(); toastT('Saved "{name}" with {n} games. It\'s now a source on the Top lists page.', { name, n: items.length }); render();
  },
  webClear: () => { S.webDraft = null; render(); },
};
async function saveKey(id) {
  const v = ($('#key_' + id).value || '').trim(); if (!v) return toast('Paste the key first.', 'warn');
  S.busy = 'Checking the ' + SERVICES[id].name + ' key…'; renderStatus();
  try { await SERVICES[id].test(v); } catch (e) { S.busy = ''; renderStatus(); const keep = await dialog({ title: 'Key check failed', body: `${e.message}. Save it anyway?`, ok: 'Save anyway' }); if (!keep) return; }
  S.busy = '';
  if (await Vault.set(id, v)) toastT('{svc} key saved (encrypted).', { svc: SERVICES[id].name });
  render();
}
// Write (or remove) an RGSX download-source key file in saves/ports/rgsx, using the folder's edit access.
async function rgsxSaveKey(svc, del = false) {
  const fname = RGSX_KEY_FILES[svc]; if (!fname) return;
  if (!(S.handles.app && S.writable && S.dirs.rgsx)) return toast('Allow edit access to your folder (Settings › Folders) first.', 'warn');
  let val = '';
  if (!del) { const el = $('#rgsxkey_' + svc); val = (el && el.value || '').trim(); if (!val) return toast('Paste the key first.', 'warn'); }
  try {
    const dir = await dirPath(S.handles.app, ['saves', 'ports', 'rgsx'], true);
    if (del) { try { await dir.removeEntry(fname); } catch { } }
    else await writeText(dir, fname, val);
  } catch (e) { return toast('Could not save the key: ' + e.message, 'err'); }
  toast(del ? RGSX_KEY_INFO[svc].name + ' key removed.' : RGSX_KEY_INFO[svc].name + ' key saved.');
  await rgsxProbe();
}
// Write the region/language preference next to the page so the downloader honours it.
async function rgsxWritePrefs() {
  if (!(S.handles.app && S.writable)) return;
  try { await writeText(S.handles.app, 'rgsx-download-prefs.json', JSON.stringify(S.config.download || { regions: [], langs: [] }, null, 2)); } catch { }
}
// Clear the failed mark for one system so its items are attempted again next run.
async function rgsxRetrySystem(sys) {
  if (!(S.handles.app && S.writable)) return toast('The folder is read-only.', 'warn');
  const failed = (await readJSON(S.handles.app, 'rgsx-download-failed.json')) || [];
  const keep = failed.filter(e => String(e.system || e.platform || '').toLowerCase() !== String(sys).toLowerCase());
  try {
    if (keep.length) await writeText(S.handles.app, 'rgsx-download-failed.json', JSON.stringify(keep, null, 2));
    else await S.handles.app.removeEntry('rgsx-download-failed.json');
  } catch (e) { return toast('Could not update the failed list: ' + e.message, 'err'); }
  toastT('{sys} will be attempted again next run.', { sys });
  await rgsxProbe();
}
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-sel],[data-sys],[data-star],[data-dellist],[data-tab],[data-setpage],[data-upd],[data-webfill],[data-savekey],[data-testkey],[data-delkey],[data-helpgo],[data-sys-top],[data-bookmarklet],[data-rgsxpage],[data-rgsxadd],[data-rgsxkey],[data-rgsxkeydel],[data-rgsxretry]'); if (!t) return;
  if (t.dataset.bookmarklet !== undefined) { e.preventDefault(); toast('Drag this link to your bookmarks bar, then click it on a page with a list.'); return; }
  if (t.dataset.tab) { S.tab = t.dataset.tab; render(); window.scrollTo(0, 0); if (S.tab === 'rgsx') rgsxProbe(); return; }
  if (t.dataset.act) { actions[t.dataset.act]?.(); return; }
  if (t.dataset.setpage) { S.setPage = t.dataset.setpage; S.tab = 'settings'; render(); window.scrollTo(0, 0); return; }
  if (t.dataset.rgsxpage) { S.rgsxPage = t.dataset.rgsxpage; S.tab = 'rgsx'; render(); window.scrollTo(0, 0); return; }
  if (t.dataset.rgsxadd) { const v = JSON.parse(t.dataset.rgsxadd); try { const res = await rgsxWriteQueue([{ type: 'game', platform: v.p, name: v.n, title: v.n, source: 'catalogue' }]); toastT('Added “{n}”. {total} in the download list.', { n: v.n, total: res.total }); if (S.rgsx) rgsxProbe(); } catch (err) { toast('Could not add: ' + err.message, 'err'); } return; }
  if (t.dataset.rgsxkey) { await rgsxSaveKey(t.dataset.rgsxkey); return; }
  if (t.dataset.rgsxkeydel) { await rgsxSaveKey(t.dataset.rgsxkeydel, true); return; }
  if (t.dataset.rgsxretry !== undefined) { await rgsxRetrySystem(t.dataset.rgsxretry); return; }
  if (t.dataset.helpgo) { document.getElementById('help-' + t.dataset.helpgo)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (t.dataset.sysTop) { S.config.topN.system = t.dataset.sysTop; S.tab = 'topn'; saveConfig(); render(); return; }
  if (t.dataset.upd) { const [src, k] = t.dataset.upd.split('|'); await refreshLists([k], [src]); return; }
  if (t.dataset.webfill) { const v = JSON.parse(t.dataset.webfill); S.webDraft = { sys: S.setPage.slice(4), name: v.name, url: v.url, id: v.id, items: [], how: '' }; render(); document.getElementById('webForm')?.scrollIntoView({ block: 'start' }); return; }
  if (t.dataset.savekey) return saveKey(t.dataset.savekey);
  if (t.dataset.testkey) { const id = t.dataset.testkey; const k = await Vault.get(id); if (!k) return; try { await SERVICES[id].test(k); toastT('{svc} accepted the key.', { svc: SERVICES[id].name }); } catch (err) { toast(err.message, 'err'); } return; }
  if (t.dataset.delkey) { await Vault.set(t.dataset.delkey, null); toast('Key removed.'); render(); return; }
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
  else if (t.id === 'hhPlat') { (S.hh ||= { plat: 'GB', q: '', items: [], page: 1, total: 1 }).plat = t.value; hhLoad(false); return; }
  else if (t.id === 'hhSearch') { (S.hh ||= { plat: 'GB', q: '', items: [], page: 1, total: 1 }).q = t.value; hhLoad(false); return; }
  else if (t.id === 'frSystem') { c.free.system = t.value; c.free.genre = 'all'; }
  else if (t.id === 'frGenre') c.free.genre = t.value;
  else if (t.id === 'pcGenre') c.free.pcGenre = t.value;
  else if (t.id === 'rgsxPlat') { S.rgsxPlat = t.value; S.rgsxSearch = ''; render(); return; }
  else if (t.id === 'rgsxSearch') { S.rgsxSearch = t.value; render(); return; }
  else if (t.dataset.dlregion !== undefined) { const a = (c.download ||= { regions: [], langs: [] }).regions; const v = t.dataset.dlregion; const i = a.indexOf(v); if (t.checked && i < 0) a.push(v); else if (!t.checked && i >= 0) a.splice(i, 1); rgsxWritePrefs(); }
  else if (t.dataset.dllang !== undefined) { const a = (c.download ||= { regions: [], langs: [] }).langs; const v = t.dataset.dllang; const i = a.indexOf(v); if (t.checked && i < 0) a.push(v); else if (!t.checked && i >= 0) a.splice(i, 1); rgsxWritePrefs(); }
  else if (t.name === 'vaultMode') { await Vault.setMode(t.value); render(); return; }
  else if (t.id === 'optIntro') { c.showGettingStarted = t.checked; ls.set('rlc.hideIntro', t.checked ? null : '1'); }
  else if (t.id === 'clFile' && t.files[0]) { const f = t.files[0]; $('#clItems').value = parseListText(await f.text(), f.name).join('\n'); if (!$('#clName').value) $('#clName').value = f.name.replace(/\.\w+$/, ''); return; }
  else if (t.id === 'webFile' && t.files[0]) {
    const f = t.files[0]; const res = parseWebInput(await f.text(), f.name, $('#webUrl').value.trim());
    if (!res || !res.items.length) return toast('No list found in that file. Try the grabber with the list selected.', 'warn');
    return setDraft({ items: res.items, how: res.how, name: $('#webName').value || res.name || '' });
  }
  else if (t.id === 'itchFile' && t.files[0]) {
    try { const j = JSON.parse(await t.files[0].text()); if (!j.games || !j.sys || !j.pc) throw new Error('not an itch-free.json file'); S.itch = j; await cacheWrite('itch-free.json', j); toastT('Imported itch.io data from {date}.', { date: fmtDate(j.fetched) }); }
    catch (err) { toastT('Import failed: {error}', { error: err.message }, 'err'); }
  } else return;
  saveConfig(); render();
});
document.addEventListener('paste', e => {
  if (e.target.id !== 'webPaste') return;
  setTimeout(() => {
    const res = parseWebInput(e.target.value); if (!res || !res.items.length) return toast('No titles found in what you pasted.', 'warn');
    setDraft({ items: res.items, how: res.how, name: $('#webName').value || res.name || '', url: $('#webUrl').value || res.url || '' });
  }, 0);
});
let filterTimer = null;
document.addEventListener('input', e => {
  if (!['libFilter', 'sysFilter', 'setSysFilter'].includes(e.target.id)) return;
  const id = e.target.id; S[id] = e.target.value; S.libLimit = 500;
  clearTimeout(filterTimer); filterTimer = setTimeout(() => { render(); const el = document.getElementById(id); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 200);
});
$('#intro').addEventListener('click', e => { if (e.target.id === 'intro') closeIntro(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#intro').classList.contains('hidden')) closeIntro(); });

/* ------------------------------------------------------------------ language */
function setLang(l, save = true) {
  if (!I18N_LANGS[l]) l = 'en';
  LANG = l; document.documentElement.lang = l; ls.set('rlc.lang', l);
  document.querySelectorAll('[data-lang]').forEach(b => { b.classList.toggle('on', b.dataset.lang === l); b.setAttribute('aria-pressed', b.dataset.lang === l); });
  if (save) { S.config.lang = l; saveConfig(); }
  render(); const o = $('#intro'); if (!o.classList.contains('hidden')) translateDom(o);
}
document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));

/* ------------------------------------------------------------------ start */
(async function start() {
  setLang(ls.get('rlc.lang') || (navigator.language || 'en').slice(0, 2), false);
  if (ls.get('rlc.hideIntro')) S.config.showGettingStarted = false;
  if (fsSupported) {
    S.handles.app = (await idb.get('app')) || null;
    S.handles.retro = (await idb.get('retro')) || null;
    S.handles.rgsx = (await idb.get('rgsx')) || null;
    await connect(false);
  }
  render();
})();
