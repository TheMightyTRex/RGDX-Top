/* RGSX Library Checker: list grabber. Run it on a page that shows a top list (as a bookmarklet, or pasted into the
   browser console with F12 > Console). Select the list first if you want exact control; otherwise it guesses.
   It copies the list to the clipboard; paste it into RGSX Library Checker > Settings > (system) > Add a list from a website. */
(() => {
  /*__EXTRACT__*/
  const sel = String(window.getSelection ? window.getSelection() : '');
  const r = rlcExtractList(document, sel);
  const data = JSON.stringify({ rlc: 1, name: document.title.replace(/\s+/g, ' ').trim(), url: location.href, how: r.how, items: r.items });
  const box = document.createElement('div');
  box.setAttribute('style', 'position:fixed;z-index:2147483647;top:16px;right:16px;width:380px;max-height:80vh;overflow:auto;background:#fff;color:#111;font:14px/1.4 system-ui,sans-serif;border:1px solid #888;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.3);padding:14px');
  const ta = document.createElement('textarea');
  ta.value = data; ta.setAttribute('style', 'width:100%;height:90px;font:11px monospace');
  const h = document.createElement('div');
  h.innerHTML = '<b>RGSX Library Checker</b><br>' + r.items.length + ' games found (' + r.how.replace(/[<>&]/g, '') + ').';
  const list = document.createElement('ol'); list.setAttribute('style', 'margin:8px 0 8px 18px;padding:0;max-height:200px;overflow:auto');
  r.items.slice(0, 15).forEach(t => { const li = document.createElement('li'); li.textContent = t; list.appendChild(li); });
  const msg = document.createElement('div');
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => box.remove();
  box.append(h, list, ta, msg, close); document.body.appendChild(box);
  ta.select();
  let copied = false; try { copied = document.execCommand('copy'); } catch (e) { }
  msg.textContent = copied ? 'Copied. Paste it into the page in Settings.' : 'Copy the text above (Ctrl+C), then paste it into the page in Settings.';
  if (!r.items.length) msg.textContent = 'No list found. Select the list on the page with the mouse, then run this again.';
})();
