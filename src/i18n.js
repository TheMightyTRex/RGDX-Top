/* Interface translation (EN / FR / ES). The app renders English; after each render the visible text and the
   placeholder/title attributes are looked up in the chosen language's dictionary. Numbers are matched as {n}, so
   "Showing 500 of 3,588." uses the entry "Showing {n} of {n}.". Anything inside translate="no" (game titles, file
   names, system names) and code/pre elements is left alone. */
const I18N_LANGS = { en: 'English', fr: 'Français', es: 'Español' };
let LANG = 'en';
function i18nKey(s) { const nums = []; const key = s.replace(/\d[\d,.]*\d|\d/g, m => { nums.push(m); return '{n}'; }); return { key, nums }; }
function i18nLookup(s) {
  if (LANG === 'en') return s;
  const dict = I18N[LANG] || {}; const t = s.trim(); if (!t) return s;
  let tr = dict[t];
  if (tr == null) { const { key, nums } = i18nKey(t); tr = dict[key]; if (tr != null) { let i = 0; tr = tr.replace(/\{n\}/g, () => nums[i++] ?? ''); } }
  if (tr == null) return s;
  return s.replace(t, tr);
}
function translateDom(root) {
  if (!root) return;
  const skip = el => el.closest('[translate="no"], script, style, code, pre, textarea, kbd');
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n; const nodes = [];
  while ((n = w.nextNode())) nodes.push(n);
  for (const node of nodes) {
    if (!node.parentElement || skip(node.parentElement)) continue;
    if (node.__en === undefined) node.__en = node.nodeValue;
    const out = i18nLookup(node.__en); if (node.nodeValue !== out) node.nodeValue = out;
  }
  for (const el of root.querySelectorAll('[placeholder], [title], [aria-label]')) {
    if (skip(el)) continue;
    el.__enAttr ||= {};
    for (const a of ['placeholder', 'title', 'aria-label']) {
      if (!el.hasAttribute(a)) continue;
      if (el.__enAttr[a] === undefined) el.__enAttr[a] = el.getAttribute(a);
      el.setAttribute(a, i18nLookup(el.__enAttr[a]));
    }
  }
}
function tr(s) { return i18nLookup(s); }   // for alert-style text built in code
/* T(): a translated sentence with named parts, for text that contains names, so word order can change per language.
   T('Websites with {sys} lists', { sys: 'Amiga' }). Values are escaped and never translated; values passed as
   { html: ... } are inserted as-is (already escaped or translated). The result is marked translate="no" so the DOM
   pass leaves it alone. */
function T(tpl, vars = {}) {
  const dict = LANG === 'en' ? null : I18N[LANG] || {};
  const t = (dict && dict[tpl]) || tpl;
  const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return '<span translate="no">' + t.replace(/\{(\w+)\}/g, (m, k) => k in vars ? (vars[k] && typeof vars[k] === 'object' ? vars[k].html : e(vars[k])) : m) + '</span>';
}
