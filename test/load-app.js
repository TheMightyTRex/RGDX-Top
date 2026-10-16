// Loads src/app.js in a Node VM with a minimal fake DOM, so its pure functions can be tested.
const fs = require('fs'), vm = require('vm'), path = require('path');
module.exports = function loadApp(extra = {}) {
  const el = () => ({ innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => true }, addEventListener() {} });
  const els = {};
  const document = { querySelector: s => (els[s] ||= el()), querySelectorAll: () => [], addEventListener() {}, getElementById: () => null, createElement: el };
  const ctx = { console, document, window: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { protocol: 'file:', pathname: '/C:/RetroBat/rgsx-library-checker.html' },
    SYSTEMS: JSON.parse(fs.readFileSync(path.join(__dirname, '../data/systems.json'), 'utf8')), SNAPSHOT: {}, ITCH_BUNDLED: null, ITCH_TAGS: {}, ITCH_SCRIPT: '', SQL_WASM_B64: '', APP_VERSION: 'test',
    setTimeout, clearTimeout, URL, Blob: function () {}, atob: s => Buffer.from(s, 'base64').toString('binary'), ...extra };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8'), ctx);
  return ctx;
};
