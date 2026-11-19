// ============================================================
// icons.js - pixel-style inline SVG icons (MineOS-like pixel art)
//
// The web UI used to print emoji (📥 📁 💾 🛸 …). Their look depends on the
// operating system font (color emoji on Android, monochrome on Windows), so a
// small 16×16 pixel-art icon set is drawn inline instead. No image files are
// used: every icon is an inline <svg> that inherits `currentColor`.
//
// A MutationObserver rewrites matching characters in the rendered DOM, so the
// existing emoji inside i18n strings and templates keep working unchanged.
// Elements inside guest text (log panel, file viewer, form fields) are skipped.
// ============================================================
(() => {
  // 16x16 pixel grid, integer coordinates, no anti-aliasing.
  const ICONS = {
    logo: '<path fill-rule="evenodd" d="M8 .5L14.5 4.2v7.6L8 15.5 1.5 11.8V4.2zM8 3.6l3.6 2.1v4.6L8 12.4 4.4 10.3V5.7z"/>',
    import: '<rect x="7" y="1" width="2" height="6"/><path d="M4 7h8l-4 4z"/><rect x="2" y="12" width="2" height="3"/><rect x="12" y="12" width="2" height="3"/><rect x="2" y="14" width="12" height="2"/>',
    download: '<rect x="7" y="2" width="2" height="6"/><path d="M4 8h8l-4 4z"/><rect x="3" y="14" width="10" height="2"/>',
    upload: '<rect x="7" y="7" width="2" height="7"/><path d="M4 8l4-4.5L12 8z"/><rect x="3" y="14" width="10" height="2"/>',
    gear: '<rect x="7" y="0" width="2" height="3"/><rect x="7" y="13" width="2" height="3"/><rect x="0" y="7" width="3" height="2"/><rect x="13" y="7" width="3" height="2"/><rect x="2" y="2" width="2" height="2"/><rect x="12" y="2" width="2" height="2"/><rect x="2" y="12" width="2" height="2"/><rect x="12" y="12" width="2" height="2"/><path fill-rule="evenodd" d="M8 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
    info: '<path fill-rule="evenodd" d="M8 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM7 4h2v2H7zM7 7h2v5H7z"/>',
    warning: '<path fill-rule="evenodd" d="M8 1L15 14H1zM7 5h2v5H7zM7 11h2v2H7z"/>',
    folder: '<path d="M1 4h5l1.5 2H15v8H1z"/>',
    file: '<path fill-rule="evenodd" d="M3 1h7l3 3v11H3zM10 1v3h3z"/>',
    floppy: '<path fill-rule="evenodd" d="M2 2h9l3 3v9H2zM5 3h4v3H5zM5 9h6v5H5z"/>',
    trash: '<rect x="2" y="3" width="12" height="2"/><rect x="6" y="1" width="4" height="2"/><path fill-rule="evenodd" d="M3 5h10l-1 10H4zM6 7h1v7H6zM9 7h1v7H9z"/>',
    search: '<circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.7 9.7l4.3 4.3" fill="none" stroke="currentColor" stroke-width="3"/>',
    lock: '<path fill-rule="evenodd" d="M3 7h10v7H3zM7 9h2v3H7z"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="2"/>',
    unlock: '<path fill-rule="evenodd" d="M3 7h10v7H3zM7 9h2v3H7z"/><path d="M5 7V5a3 3 0 0 1 6 0" fill="none" stroke="currentColor" stroke-width="2"/>',
    drone: '<rect x="7" y="1" width="2" height="2"/><path d="M4.5 9a3.5 3.5 0 0 1 7 0z"/><path d="M1 9.5h14l-2.5 3.5h-9z"/><rect x="4" y="13" width="2" height="2"/><rect x="10" y="13" width="2" height="2"/>',
    radioactive: '<rect x="6" y="6" width="4" height="4"/><path d="M8 8L13.4 8A5.4 5.4 0 0 1 10.7 12.67z"/><path d="M8 8L13.4 8A5.4 5.4 0 0 1 10.7 12.67z" transform="rotate(120 8 8)"/><path d="M8 8L13.4 8A5.4 5.4 0 0 1 10.7 12.67z" transform="rotate(240 8 8)"/>',
    chip: '<path fill-rule="evenodd" d="M4 4h8v8H4zM6 6h4v4H6z"/><rect x="1" y="5" width="3" height="1.5"/><rect x="1" y="9.5" width="3" height="1.5"/><rect x="12" y="5" width="3" height="1.5"/><rect x="12" y="9.5" width="3" height="1.5"/><rect x="5" y="1" width="1.5" height="3"/><rect x="9.5" y="1" width="1.5" height="3"/><rect x="5" y="12" width="1.5" height="3"/><rect x="9.5" y="12" width="1.5" height="3"/>',
    robot: '<path fill-rule="evenodd" d="M2 3h12v9H2zM4.5 6h2v2h-2zM9.5 6h2v2h-2zM5 9.5h6v1.5H5z"/><rect x="7" y="1" width="2" height="2"/><rect x="0" y="6" width="2" height="4"/><rect x="14" y="6" width="2" height="4"/>',
    mouse: '<rect x="5" y="1" width="6" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><rect x="7" y="3" width="2" height="3"/>',
    keyboard: '<rect x="1" y="4" width="14" height="8" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="6" width="2" height="2"/><rect x="6" y="6" width="2" height="2"/><rect x="9" y="6" width="2" height="2"/><rect x="12" y="6" width="2" height="2"/><rect x="4" y="9.5" width="8" height="2"/>',
    package: '<path fill-rule="evenodd" d="M2 3h12v11H2zM7 3h2v11H7zM2 8h12v2H2z"/>',
    mirror: '<ellipse cx="8" cy="6.5" rx="4.5" ry="5.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="7" y="12" width="2" height="3"/><rect x="5" y="14" width="6" height="2"/>',
    cube: '<path d="M8 1l6 3v8l-6 3-6-3V4z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2 4l6 3 6-3M8 7v8" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    laptop: '<rect x="2" y="2" width="12" height="8" fill="none" stroke="currentColor" stroke-width="2"/><rect x="0" y="12" width="16" height="2"/><rect x="7" y="11" width="2" height="1"/>',
    pickaxe: '<path d="M3.5 12.5l7-7" stroke="currentColor" stroke-width="3" fill="none"/><path d="M8 2c3 .2 5 2 6 5l-2.4.8C10.8 4.7 9.4 4 7 4z"/>',
    clipboard: '<rect x="3" y="2" width="10" height="13" fill="none" stroke="currentColor" stroke-width="2"/><rect x="6" y="1" width="4" height="3"/><rect x="5" y="6" width="6" height="2"/><rect x="5" y="10" width="6" height="2"/>',
    book: '<path d="M2 2h5v12H2zM9 2h5v12H9z" fill="none" stroke="currentColor" stroke-width="2"/><rect x="4" y="4" width="1" height="8"/><rect x="11" y="4" width="1" height="8"/>',
    battery: '<rect x="1" y="4" width="11" height="8" fill="none" stroke="currentColor" stroke-width="2"/><rect x="12" y="6" width="2" height="4"/><rect x="3" y="6" width="2" height="4"/><rect x="6" y="6" width="2" height="4"/>',
    sponge: '<path fill-rule="evenodd" d="M2 4h12v10H2zM5 6h1.5v1.5H5zM9 6h1.5v1.5H9zM6.5 9.5h1.5v1.5H6.5zM10 10h1.5v1.5H10z"/>',
    snowflake: '<g stroke="currentColor" stroke-width="2" fill="none"><path d="M8 1v14"/><path d="M1.9 4.5l12.2 7"/><path d="M14.1 4.5L1.9 11.5"/></g>',
    fullscreen: '<path d="M1 6V3h3M15 6V3h-3M1 10v3h3M15 10v3h-3" fill="none" stroke="currentColor" stroke-width="2"/>',
    bolt: '<path d="M9.5 1L3 9h3.5l-1 6L13 6H9.5z"/>',
    menu: '<rect x="1" y="3" width="14" height="2"/><rect x="1" y="7" width="14" height="2"/><rect x="1" y="11" width="14" height="2"/>',
    more: '<rect x="7" y="2" width="2" height="2"/><rect x="7" y="7" width="2" height="2"/><rect x="7" y="12" width="2" height="2"/>',
    add: '<rect x="7" y="2" width="2" height="12"/><rect x="2" y="7" width="12" height="2"/>',
    play: '<path d="M4 2l9 6-9 6z"/>',
    pause: '<rect x="4" y="2" width="3" height="12"/><rect x="9" y="2" width="3" height="12"/>',
    stop: '<rect x="3" y="3" width="10" height="10"/>',
    check: '<path d="M2 8l4 5L14 3" fill="none" stroke="currentColor" stroke-width="2.5"/>',
    cross: '<path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="2.5"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M13.6 1.4v4h-4z"/>',
  };

  // Emoji / pictographic symbols -> icon name
  const CHAR_ICON = {
    '\u{1F4E5}': 'import',
    '\u2B07': 'download',
    '\u2B06': 'upload',
    '\u2699': 'gear',
    '\u2139': 'info',
    '\u26A0': 'warning',
    '\u{1F4C1}': 'folder',
    '\u{1F4C4}': 'file',
    '\u{1F4BE}': 'floppy',
    '\u{1F5D1}': 'trash',
    '\u{1F50D}': 'search',
    '\u{1F512}': 'lock',
    '\u{1F513}': 'unlock',
    '\u{1F6F8}': 'drone',
    '\u{1F681}': 'drone',
    '\u2622': 'radioactive',
    '\u{1F9E9}': 'chip',
    '\u{1F916}': 'robot',
    '\u{1F5B1}': 'mouse',
    '\u2328': 'keyboard',
    '\u{1F4E6}': 'package',
    '\u{1FA9E}': 'mirror',
    '\u{1F9CA}': 'cube',
    '\u{1F4BB}': 'laptop',
    '\u26CF': 'pickaxe',
    '\u{1F4CB}': 'clipboard',
    '\u{1F4D6}': 'book',
    '\u{1F50B}': 'battery',
    '\u{1F9FD}': 'sponge',
    '\u2744': 'snowflake',
    '\u26F6': 'fullscreen',
    '\u26A1': 'bolt',
    '\u2B23': 'logo',
    '\u2630': 'menu',
    '\u22EE': 'more',
    '\uFF0B': 'add',
    '\u25B6': 'play',
    '\u23F8': 'pause',
    '\u25A0': 'stop',
    '\u2713': 'check',
    '\u2717': 'cross',
    '\u27F3': 'refresh',
    '\u21BB': 'refresh',
    '\u21BA': 'refresh',
  };

  const CHARS = Object.keys(CHAR_ICON);
  const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
  const escapeRe = (s) => s.replace(ESCAPE_RE, '\\$&');
  // Optional U+FE0F (variation selector) is swallowed together with the icon
  const EMOJI_RE = new RegExp('(' + CHARS.map(escapeRe).join('|') + ')(?:\\uFE0F)?', 'g');

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TITLE', 'PRE', 'CODE']);
  const SKIP_SELECTOR = '[data-no-icon], .log-panel-body, .disk-file-content, svg';

  function shouldSkip(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    return !!(el.closest && el.closest(SKIP_SELECTOR));
  }

  function svgMarkup(name) {
    const body = ICONS[name];
    if (!body) return '';
    return '<svg class="ui-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  function iconNode(name) {
    const tpl = document.createElement('template');
    tpl.innerHTML = svgMarkup(name);
    return tpl.content.firstChild;
  }

  function decorateTextNode(node) {
    const text = node.nodeValue;
    if (!text || text.length > 4000) return;
    EMOJI_RE.lastIndex = 0;
    if (!EMOJI_RE.test(text)) return;
    const parent = node.parentNode;
    if (!parent || !parent.isConnected || shouldSkip(parent)) return;

    EMOJI_RE.lastIndex = 0;
    let last = 0;
    let match = null;
    let changed = false;
    const frag = document.createDocumentFragment();
    while ((match = EMOJI_RE.exec(text))) {
      const name = CHAR_ICON[match[1]];
      if (!name) continue;
      changed = true;
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      frag.appendChild(iconNode(name));
      last = match.index + match[0].length;
    }
    if (!changed) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, node);
  }

  // Let templates/scripts mark a span with data-icon="folder" instead of text
  function applyDataIcons(el) {
    if (!el || el.nodeType !== 1) return;
    const name = el.getAttribute('data-icon');
    if (!name || !ICONS[name] || el.dataset.iconDone === '1') return;
    el.dataset.iconDone = '1';
    el.innerHTML = svgMarkup(name);
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { decorateTextNode(root); return; }
    if (root.nodeType !== 1) return;
    applyDataIcons(root);
    // Collect first, mutate afterwards: replacing a node while a live TreeWalker
    // sits on it detaches the walker and the traversal stops after one match.
    const elems = [];
    const texts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === 3) texts.push(node);
      else elems.push(node);
      node = walker.nextNode();
    }
    for (const el of elems) applyDataIcons(el);
    for (const t of texts) decorateTextNode(t);
  }

  let running = false;
  const observer = new MutationObserver((records) => {
    if (running) return;
    running = true;
    try {
      for (const record of records) {
        if (record.type === 'characterData') {
          decorateTextNode(record.target);
          continue;
        }
        const target = record.target && record.target.nodeType === 1 ? record.target : record.target.parentNode;
        if (target) applyDataIcons(target);
        record.addedNodes.forEach(walk);
      }
    } finally {
      running = false;
    }
  });

  function start() {
    walk(document.body);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.Icons = {
    has: (name) => !!ICONS[name],
    svg: svgMarkup,
    // Re-run decoration (e.g. after a language switch rebuilds the DOM)
    refresh: () => walk(document.body),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
