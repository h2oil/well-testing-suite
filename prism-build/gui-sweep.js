#!/usr/bin/env node
// prism-build/gui-sweep.js — automated whole-app GUI sweep (Playwright + Chromium).
//
// Serves the BUILT well-testing-app.html from a tiny local static server, stubs/blocks every external
// request, and for every route (sidebar buttons ∪ host `pages` table ∪ WTS_calcRegistry ∪ dashboard
// tiles) — plus the header (well menu, project New/Open/Save, units, Std base, decimal comma, Quick
// Report), the export buttons, PRiSM tabs/steps/Tools drawer, the simulator (2D/3D, run a few seconds)
// — it:
//   • captures pageerror / console errors / unhandled rejections / failed local requests;
//   • clicks every visible enabled control one by one (fresh navigation when a click navigates away or
//     leaves an overlay; destructive ones — delete/clear/reset/new — last, dialogs auto-answered and
//     recorded) and records errors, DOM/canvas change ("no visible effect" otherwise), dialogs,
//     downloads, popups (window.open), print() and clipboard writes;
//   • fills numeric inputs with blank / 0 / -1 / 1e12 and cycles every <select> option, looking for
//     NaN / undefined / Infinity / null / [object Object] rendered in the page text;
//   • checks layout at 1440 px and 390 px (horizontal overflow, controls off-screen, overlapping fixed
//     elements, menus/popovers opened off-screen, clicks intercepted by other elements);
//   • revisits every route in Metric mode and with the decimal comma on (NaN, imperial unit labels);
//   • screenshots every route at desktop width.
// Output: <out>/sweep-report.json + <out>/sweep-report.md (+ <out>/shots/*.png), findings deduplicated
// and mapped to a likely source file (stack frames → prism-build/NN-*.js by line content, ids / route
// keys → the file that defines them, else host well-testing-app.html).
//
// Usage: node prism-build/gui-sweep.js [--route key[,key…]] [--quick] [--mobile] [--out dir]
//        [--workers n] [--no-stub] [--budget sec] [--verbose]
//   --route   only these routes (repeatable / comma list; `_header` = header toolbar + well menu)
//   --quick   no edge-value fills (blank only, first 8 inputs), ≤ 3 options per select, ≤ 25 clicks per
//             view, no Metric / decimal-comma / phone passes
//   --mobile  run the click sweep at 390 px (phone, touch) and save phone screenshots too
//   --no-stub block the CDN libraries too (three.js, sql.js, SQLite WASM, html2canvas, jsPDF are served
//             from ios-app/ios-additions/libs by default so 3D / historian / PDF paths are exercised)
// Needs Playwright (+ Chromium). Prints "[skip] …" and exits 0 without it. Never runs `playwright install`.
// Exit code: 0 (the sweep is a report, not a gate); 2 if the sweep itself crashed.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const { execFileSync } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* try the global install */ }
  try { const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); return require(path.join(g, 'playwright')); } catch (e) { return null; }
}
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const args = (f) => { const out = []; argv.forEach((a, i) => { if (a === f && argv[i + 1]) out.push(argv[i + 1]); }); return out; };
const arg = (f, d) => { const a = args(f); return a.length ? a[a.length - 1] : d; };

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const LIBS = path.join(ROOT, 'ios-app', 'ios-additions', 'libs');
const QUICK = has('--quick'), MOBILE = has('--mobile'), STUB = !has('--no-stub'), VERBOSE = has('--verbose');
const ONLY = args('--route').join(',').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'wts-gui-sweep')));
const WORKERS = Math.max(1, parseInt(arg('--workers', String(Math.min(4, Math.max(2, os.cpus().length)))), 10));
const BUDGET_MS = parseInt(arg('--budget', QUICK ? '60' : '300'), 10) * 1000;   // per (route, view) job
const DESKTOP = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
const EDGE_VALUES = QUICK ? [''] : ['', '0', '-1', '1e12'];
const say = (s) => console.log(s);
const vlog = (s) => { if (VERBOSE) console.log('  ' + s); };

// ─────────────────────────────────────────────────────────────────────────────
// Static server + external-request policy
// ─────────────────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf', '.txt': 'text/plain' };
function serve() {
  return http.createServer((q, s) => {
    const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'well-testing-app.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); }
    s.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    s.end(fs.readFileSync(f));
  });
}
// CDN files the app loads lazily → the byte-identical copies bundled for iOS.
const CDN_STUBS = [
  [/three(@[\d.]+)?\/build\/three\.module\.min\.js/, 'three.module.min.js', 'text/javascript'],
  [/sql\.js@[\d.]+\/dist\/sql-wasm\.js/, 'sql-wasm.js', 'text/javascript'],
  [/sql\.js@[\d.]+\/dist\/sql-wasm\.wasm/, 'sql-wasm.wasm', 'application/wasm'],
  [/sqlite-wasm@[^/]+\/dist\/index\.mjs/, 'sqlite3.mjs', 'text/javascript'],
  [/sqlite-wasm@[^/]+\/dist\/sqlite3\.wasm/, 'sqlite3.wasm', 'application/wasm'],
  [/html2canvas[^/]*\/.*html2canvas(\.min)?\.js/, 'html2canvas.min.js', 'text/javascript'],
  [/jspdf[^/]*\/.*jspdf\.umd(\.min)?\.js/, 'jspdf.umd.min.js', 'text/javascript'],
];
const external = new Map();   // url → { action, routes:Set }
function noteExternal(url, action, route) {
  const k = url.replace(/\?.*$/, '');
  if (!external.has(k)) external.set(k, { action, routes: new Set() });
  external.get(k).routes.add(route || '?');
}

// ─────────────────────────────────────────────────────────────────────────────
// In-page helper (added with addInitScript to every page, popups included)
// ─────────────────────────────────────────────────────────────────────────────
function pageHelper() {
  if (window.__sweep) return;
  const S = window.__sweep = { rej: [], opens: [], prints: 0, clip: [], ids: new WeakMap(), nid: 1 };
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason; S.rej.push({ message: String(r && r.message || r), stack: String(r && r.stack || '') });
  });
  // File System Access pickers would wait for a user; force the download / <input type=file> fallback.
  try { window.showSaveFilePicker = undefined; window.showOpenFilePicker = undefined; } catch (e) { /* ignore */ }
  const _print = window.print;
  window.print = function () { S.prints++; };
  const _open = window.open;
  window.open = function (u, n, f) {
    S.opens.push(String(u || ''));
    let w = null;
    try { w = _open.call(window, u, n, f); } catch (e) { S.opens.push('threw: ' + e.message); }
    try { if (w) w.print = function () { S.prints++; }; } catch (e) { /* cross-origin */ }
    return w;
  };
  try {
    if (navigator.clipboard) {
      navigator.clipboard.writeText = (t) => { S.clip.push(String(t).length); return Promise.resolve(); };
      navigator.clipboard.write = (items) => { S.clip.push(items && items.length || 1); return Promise.resolve(); };
    }
  } catch (e) { /* ignore */ }
  const _exec = document.execCommand && document.execCommand.bind(document);
  if (_exec) document.execCommand = function (c) { if (/copy/i.test(c)) S.clip.push(-1); try { return _exec.apply(null, arguments); } catch (e) { return false; } };
  _print && 0;
  // Report iframes (print fallback): count them and record their print() calls.
  try {
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.tagName !== 'IFRAME') return;
      const hook = () => { try { n.contentWindow.print = function () { S.prints++; }; } catch (e) { /* cross-origin */ } };
      hook(); n.addEventListener('load', hook);
    }))).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* ignore */ }

  const CTRL = 'button, [role=button], [role=tab], [role=switch], [role=menuitem], [role=menuitemradio], [role=checkbox], [role=radio], ' +
    'input[type=checkbox], input[type=radio], input[type=button], input[type=submit], input[type=reset], summary, a[href], [onclick], ' +
    '.dash-card, .dash-mini, .nav-group-label, [data-prism-tab]';
  const DESTRUCTIVE = /\b(delete|remove|clear|reset|wipe|erase|purge|discard|forget|drop|new project|new well|restore defaults|start over)\b|^new$|^new\b.*…$|🗑|✕ all/i;
  const vis = (e) => {
    if (!e || !e.getClientRects || !e.getClientRects().length) return false;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
    const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1;
  };
  const txt = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  S.label = (e) => {
    let l = e.getAttribute('aria-label') || '';
    if (!l && (e.type === 'checkbox' || e.type === 'radio')) {
      const lab = e.closest('label') || (e.id && document.querySelector('label[for="' + CSS.escape(e.id) + '"]'));
      l = lab ? lab.innerText : '';
    }
    if (!l) l = e.innerText || '';
    if (!l) l = e.value && e.tagName !== 'INPUT' ? e.value : (e.tagName === 'INPUT' && /button|submit|reset/.test(e.type) ? e.value : '');
    if (!l) l = e.getAttribute('title') || e.getAttribute('placeholder') || '';
    if (!l) l = e.id ? '#' + e.id : (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/)[0] : e.tagName.toLowerCase());
    return txt(l).slice(0, 70);
  };
  S.path = (e) => {
    const parts = [];
    for (let n = e, d = 0; n && n.nodeType === 1 && d < 5; n = n.parentElement, d++) {
      if (n.id) { parts.unshift('#' + n.id); break; }
      let p = n.tagName.toLowerCase();
      if (typeof n.className === 'string' && n.className.trim()) p += '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.');
      const par = n.parentElement;
      if (par) { const sib = Array.from(par.children).filter((c) => c.tagName === n.tagName); if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')'; }
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const scopeEl = (sel) => sel === '@scope' ? document.querySelector('[data-sweep-scope]') : document.querySelector(sel);
  const skipEl = (e, excl) => excl && e.closest(excl);
  const cands = (scope, excl) => Array.from(scope.querySelectorAll(CTRL)).filter((e) => {
    if (skipEl(e, excl)) return false;
    if (e.parentElement && e.parentElement.closest('button, a[href], [role=button], summary') && scope.contains(e.parentElement.closest('button, a[href], [role=button], summary'))) return false;
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') return false;
    if (e.type === 'checkbox' || e.type === 'radio') { const lab = e.closest('label'); return vis(e) || (lab && vis(lab)); }
    return vis(e);
  });
  S.enumerate = (sel, excl) => {
    const scope = scopeEl(sel); if (!scope) return null;
    const list = cands(scope, excl), seenLab = {};
    return list.map((e, i) => {
      const lab = S.label(e), key = e.tagName + '|' + lab;
      const nth = seenLab[key] = (seenLab[key] === undefined ? 0 : seenLab[key] + 1);
      const active = e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-checked') === 'true' ||
        (typeof e.className === 'string' && /(^|\s)(active|on|selected|is-active|current)(\s|$)/.test(e.className)) || e.classList.contains('btn-primary') && /imperial|metric/i.test(lab);
      return { i, tag: e.tagName.toLowerCase(), id: e.id || '', label: lab, nth, type: e.type || '', role: e.getAttribute('role') || '',
        href: e.tagName === 'A' ? e.getAttribute('href') || '' : '', target: e.getAttribute('target') || '', onclick: (e.getAttribute('onclick') || '').slice(0, 80),
        destructive: DESTRUCTIVE.test(lab) || DESTRUCTIVE.test(e.getAttribute('title') || ''), active, sel: S.path(e),
        fileInput: e.tagName === 'INPUT' && e.type === 'file' };
    });
  };
  S.find = (sel, excl, d) => {
    document.querySelectorAll('[data-sweep-target]').forEach((x) => x.removeAttribute('data-sweep-target'));
    const scope = scopeEl(sel); if (!scope) return 'noscope';
    let el = null;
    if (d.id) { const x = document.getElementById(d.id); if (x && scope.contains(x) && !skipEl(x, excl)) el = x; }
    if (!el) { const m = cands(scope, excl).filter((e) => e.tagName.toLowerCase() === d.tag && S.label(e) === d.label); el = m[d.nth] || null; }
    if (!el) return 'missing';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return 'disabled';
    let t = el;
    if ((el.type === 'checkbox' || el.type === 'radio') && !vis(el)) t = el.closest('label') || el;
    if (!vis(t)) return 'hidden';
    t.setAttribute('data-sweep-target', '1');
    return 'ok';
  };
  // Structural snapshot of everything a user could see change: one hash per element, keyed by its
  // structural path (stable across identical re-renders), scripts/styles skipped; canvases sampled.
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; };
  const tiny = document.createElement('canvas'); tiny.width = 24; tiny.height = 12;
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1 };
  S.snap = () => {
    const m = new Map(); const b = document.body; if (!b) return m;
    const tc = tiny.getContext('2d');
    const walk = (el, key) => {
      let s = el.tagName;
      for (const a of el.attributes) if (a.name.indexOf('data-sweep') !== 0) s += ' ' + a.name + '=' + a.value;
      for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) s += '|' + c.nodeValue;
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') s += '#' + (el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value);
      if (el.tagName === 'CANVAS' && el.width && el.height && vis(el)) { try { tc.clearRect(0, 0, 24, 12); tc.drawImage(el, 0, 0, 24, 12); s += '#' + hash(Array.from(tc.getImageData(0, 0, 24, 12).data).join(',')); } catch (e) { /* tainted */ } }
      m.set(key, hash(s));
      let i = 0;
      for (let c = el.firstElementChild; c; c = c.nextElementSibling, i++) if (!SKIP[c.tagName]) walk(c, key + '/' + c.tagName.toLowerCase() + i);
    };
    walk(b, 'body');
    m.set('@url', hash(location.href + '|' + document.title));
    return m;
  };
  S._marks = {};
  S.mark = (name) => { const m = S.snap(); S._marks[name || 'm'] = m; return m.size; };
  S.changes = (vol, name) => {
    const a = S._marks[name || 'm'] || new Map(), b = S.snap(), out = [];
    const volatile = (k) => { for (const v of vol || []) if (k === v || k.indexOf(v + '/') === 0) return true; return false; };
    for (const [k, h] of b) if (a.get(k) !== h && !volatile(k)) out.push(k);
    for (const k of a.keys()) if (!b.has(k) && !volatile(k)) out.push(k);
    return { n: out.length, sample: out.slice(0, 3) };
  };
  // Keys that change while nobody touches the page (clocks, running simulators, animations).
  S.calibrate = (ms) => new Promise((res) => {
    const a = S.snap();
    setTimeout(() => {
      const b = S.snap(), ch = [];
      for (const [k, h] of b) if (a.get(k) !== h) ch.push(k);
      for (const k of a.keys()) if (!b.has(k)) ch.push(k);
      // collapse: added/removed children → their parent (a list that re-renders)
      const out = new Set();
      ch.forEach((k) => { out.add(a.has(k) && b.has(k) ? k : k.replace(/\/[^/]+$/, '')); });
      res(Array.from(out).slice(0, 400));
    }, ms);
  });
  S.title = () => { const t = document.getElementById('pgTitle'); return t ? t.textContent : ''; };
  // Overlays: visible fixed/absolute boxes with some size (menus, drawers, modals, popovers).
  S.overlays = () => {
    const out = [];
    document.querySelectorAll('body *').forEach((e) => {
      const cs = getComputedStyle(e);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
      if (!vis(e)) return;
      const r = e.getBoundingClientRect(); if (r.width * r.height < 1500) return;
      if (cs.position === 'absolute' && (cs.zIndex === 'auto' || +cs.zIndex < 1)) return;
      if (e.closest('#sidebar') && e.id !== 'sidebar') return;
      let id = S.ids.get(e); if (!id) { id = S.nid++; S.ids.set(e, id); }
      out.push({ id, what: S.path(e), l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), pos: cs.position });
    });
    return { list: out, vw: document.documentElement.clientWidth, vh: innerHeight };
  };
  S.markNewOverlay = (beforeIds) => {
    document.querySelectorAll('[data-sweep-scope]').forEach((x) => x.removeAttribute('data-sweep-scope'));
    const o = S.overlays().list.filter((x) => beforeIds.indexOf(x.id) < 0);
    if (!o.length) return null;
    let best = null, ba = 0;
    document.querySelectorAll('body *').forEach((e) => { const id = S.ids.get(e); const x = o.find((q) => q.id === id); if (x) { const a = (x.r - x.l) * (x.b - x.t); if (a > ba) { ba = a; best = e; } } });
    if (best) best.setAttribute('data-sweep-scope', '1');
    return best ? S.path(best) : null;
  };
  // Bad tokens rendered as text.
  const BAD = /(^|[^A-Za-z0-9_])(NaN|undefined|-?Infinity|null|\[object Object\])(?![A-Za-z0-9_])/g;
  S.tokens = (sel) => {
    const scope = sel ? document.querySelector(sel) : document.body; if (!scope) return [];
    const out = [];
    const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
      const p = n.parentElement; if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('script, style, textarea, select, option, code, pre, noscript, .rn-list, [data-sweep-ignore]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT; } });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const s = n.nodeValue; if (!s || !/NaN|undefined|Infinity|null|object Object/.test(s)) continue;
      if (!vis(n.parentElement)) continue;
      BAD.lastIndex = 0; let m;
      while ((m = BAD.exec(s))) {
        const tok = m[2], at = m.index;
        if (tok === 'null' && /null (hypothesis|model|point|space|character)|nullable/i.test(s)) continue;
        out.push({ token: tok, text: txt(s.slice(Math.max(0, at - 50), at + 60)), where: S.path(n.parentElement) });
      }
    }
    // input values the app wrote (read-only result boxes)
    scope.querySelectorAll('input[readonly], output').forEach((e) => { const v = String(e.value || e.textContent || ''); if (/^(NaN|undefined|-?Infinity|null)$|\[object Object\]/.test(v.trim())) out.push({ token: v.trim(), text: 'value of ' + S.path(e), where: S.path(e) }); });
    return out;
  };
  // Inputs to fill: numeric-looking, visible, editable.
  S.inputs = (sel, excl) => {
    const scope = scopeEl(sel); if (!scope) return [];
    const seen = {};
    return Array.from(scope.querySelectorAll('input:not([type]), input[type=number], input[type=text], input[type=tel], input[type=range]')).filter((e) => {
      if (skipEl(e, excl) || e.disabled || e.readOnly || !vis(e)) return false;
      const v = String(e.value).trim();
      return e.type === 'number' || e.type === 'range' || /^[-+]?[\d.,]+(e[-+]?\d+)?$/i.test(v);
    }).map((e) => {
      const lab = (e.closest('.fg-item') && e.closest('.fg-item').querySelector('label') ? e.closest('.fg-item').querySelector('label').innerText : '') || S.label(e);
      const key = lab + '|' + e.id; const nth = seen[key] = (seen[key] === undefined ? 0 : seen[key] + 1);
      return { id: e.id, label: txt(lab).slice(0, 60), nth, sel: S.path(e), value: e.value, type: e.type };
    });
  };
  S.inputEl = (sel, excl, d) => {
    const scope = scopeEl(sel); if (!scope) return null;
    if (d.id) { const x = document.getElementById(d.id); if (x && scope.contains(x)) return x; }
    const m = Array.from(scope.querySelectorAll('input')).filter((e) => !skipEl(e, excl) && S.path(e) === d.sel);
    return m[0] || null;
  };
  S.setInput = (sel, excl, d, v) => {
    const e = S.inputEl(sel, excl, d); if (!e) return false;
    e.focus && e.focus();
    e.value = v;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.dispatchEvent(new Event('blur', { bubbles: false }));
    return true;
  };
  S.selects = (sel, excl) => {
    const scope = scopeEl(sel); if (!scope) return [];
    return Array.from(scope.querySelectorAll('select')).filter((e) => !skipEl(e, excl) && !e.disabled && vis(e)).map((e) => ({
      id: e.id, sel: S.path(e), label: txt((e.closest('.fg-item') && e.closest('.fg-item').querySelector('label') || {}).innerText || S.label(e)).slice(0, 60),
      value: e.value, options: Array.from(e.options).filter((o) => !o.disabled).map((o) => ({ v: o.value, t: txt(o.text).slice(0, 40) })) }));
  };
  S.setSelect = (sel, excl, d, v) => {
    const scope = scopeEl(sel); if (!scope) return false;
    const e = (d.id && document.getElementById(d.id)) || Array.from(scope.querySelectorAll('select')).find((x) => S.path(x) === d.sel);
    if (!e) return false;
    e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  // Layout.
  S.layout = () => {
    const vw = document.documentElement.clientWidth, vh = innerHeight, pb = document.getElementById('pgBody');
    const scroller = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if (ox !== 'visible' && ox !== 'clip' || getComputedStyle(a).overflow === 'hidden') return true; } return false; };
    const bad = [];
    (pb ? pb.querySelectorAll('input, select, textarea, table, .card, .fg-item, button, canvas, svg') : []).forEach((e) => {
      if (!vis(e)) return;
      const r = e.getBoundingClientRect();
      if ((r.right > vw + 1 || r.left < -1) && !scroller(e)) bad.push(S.path(e) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
    });
    document.querySelectorAll('.page-actions button, .page-actions select').forEach((e) => {
      if (!vis(e)) return; const r = e.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1) bad.push('header ' + S.path(e) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
    });
    // overlapping fixed / sticky elements (not nested, not full-screen backdrops)
    const fx = Array.from(document.querySelectorAll('body *')).filter((e) => { const p = getComputedStyle(e).position; return (p === 'fixed' || p === 'sticky') && vis(e); })
      .map((e) => ({ e, r: e.getBoundingClientRect() })).filter((x) => x.r.width * x.r.height < vw * vh * 0.8 && x.r.bottom > 0 && x.r.top < vh && x.r.right > 0 && x.r.left < vw);
    const ov = [];
    for (let i = 0; i < fx.length; i++) for (let j = i + 1; j < fx.length; j++) {
      const a = fx[i], b = fx[j];
      if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 4 && h > 4 && w * h > 100) ov.push(S.path(a.e) + ' ✕ ' + S.path(b.e) + ' (' + Math.round(w) + '×' + Math.round(h) + ')');
    }
    return { vw, docW: document.documentElement.scrollWidth, over: document.documentElement.scrollWidth > vw + 1, pbOver: pb ? pb.scrollWidth > pb.clientWidth + 1 : false,
      pbW: pb ? pb.scrollWidth : 0, pbCW: pb ? pb.clientWidth : 0, bad: bad.slice(0, 8), nBad: bad.length, overlaps: ov.slice(0, 6) };
  };
  // Imperial unit words in results (Metric pass).
  S.imperial = () => {
    const pb = document.getElementById('pgBody'); if (!pb) return [];
    const RX = /(^|[\s(\/\[·,])(psi[ag]?|°F|degF|ft|ft³|ft²|bbl\/d|bbl|BPD|STB\/d|STB|lbm?\/ft³|lb\/gal|ppg|lbm?|gal|gpm|MSCF\/d|MMSCF\/d|Mscf\/d|MMscf\/d|scf\/STB|SCF\/STB|ft\/s|BTU\/hr|Btu)(?=$|[\s)\/\]·,.:;])/;
    const out = [];
    pb.querySelectorAll('.rrow, .rbox-title, .kpi, table.dtable th, table.dtable td, .card-title, .rl, label').forEach((e) => {
      if (!vis(e) || e.closest('#wts_viz')) return;
      const t = txt(e.innerText).replace(/(@|at|,)\s*60\s*°F/g, ''); const m = RX.exec(t); if (m && t.length < 160) out.push(t.slice(0, 100) + '  «' + m[2] + '»');
    });
    return Array.from(new Set(out));
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source mapping (stack frames, ids, routes → likely source file)
// ─────────────────────────────────────────────────────────────────────────────
const SRC = (() => {
  const htmlLines = fs.readFileSync(HTML, 'utf8').split(/\r?\n/);
  const blocks = [];
  let open = null;
  htmlLines.forEach((l, i) => {
    const m = /^\/\/ ── (.+?) injection (START|END) ──/.exec(l);
    if (!m) return;
    if (m[2] === 'START') open = { name: m[1], from: i + 1 }; else if (open) { open.to = i + 1; blocks.push(open); open = null; }
  });
  const files = fs.readdirSync(__dirname).filter((f) => /^\d\d-.*\.js$/.test(f));
  const content = {}, index = new Map();
  files.forEach((f) => {
    const txt = fs.readFileSync(path.join(__dirname, f), 'utf8'); content[f] = txt;
    txt.split(/\r?\n/).forEach((l, i) => {
      const t = l.trim(); if (t.length < 14) return;
      if (!index.has(t)) index.set(t, []);
      const a = index.get(t); if (a.length < 6) a.push([f, i + 1]);
    });
  });
  const hostText = htmlLines.map((l, i) => blocks.some((b) => i + 1 > b.from && i + 1 < b.to) ? '' : l).join('\n');
  function block(line) { return blocks.find((b) => line > b.from && line < b.to) || null; }
  function hostFn(line) {
    for (let i = line - 1; i >= Math.max(0, line - 400); i--) {
      const m = /(?:function\s+([\w$]+)|(window\.[\w$]+)\s*=\s*(?:async\s*)?function|const\s+([\w$]+)\s*=\s*(?:async\s*)?\()/.exec(htmlLines[i]);
      if (m) return m[1] || m[2] || m[3];
    }
    return '';
  }
  function mapLine(line) {
    const b = block(line);
    if (!b) { const fn = hostFn(line); return 'well-testing-app.html:' + line + ' (host' + (fn ? ', ' + fn : '') + ')'; }
    const votes = {};
    for (let d = -3; d <= 3; d++) {
      const t = (htmlLines[line - 1 + d] || '').trim(); const hits = index.get(t);
      if (!hits) continue;
      hits.forEach(([f, n]) => { votes[f] = votes[f] || { w: 0, n: null }; votes[f].w += d === 0 ? 3 : 1; if (d === 0) votes[f].n = n; else if (votes[f].n == null) votes[f].n = n - d; });
    }
    const best = Object.keys(votes).sort((a, c) => votes[c].w - votes[a].w)[0];
    if (best) return 'prism-build/' + best + ':' + votes[best].n;
    return 'well-testing-app.html:' + line + ' (' + b.name + ' block)';
  }
  const idCache = {};
  function forId(id) {
    if (!id) return [];
    if (idCache[id]) return idCache[id];
    const out = [];
    const tries = [id];
    let s = id; while (/[_-][^_-]*$/.test(s) && tries.length < 4) { s = s.replace(/[_-][^_-]*$/, ''); if (s.length > 3) tries.push(s + (s === id ? '' : '_')); }
    for (const t of tries) {
      const q = new RegExp('[\'"#]' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (t === id ? '[\'"]' : ''));
      for (const f of files) if (q.test(content[f])) out.push('prism-build/' + f);
      if (!out.length && q.test(hostText)) out.push('well-testing-app.html (host)');
      if (out.length) break;
    }
    return (idCache[id] = out.slice(0, 3));
  }
  function forFn(name) {
    if (!name) return [];
    const q = new RegExp('(function\\s+' + name + '\\b|\\b' + name + '\\s*=\\s*(async\\s*)?(function|\\())');
    const out = files.filter((f) => q.test(content[f])).map((f) => 'prism-build/' + f);
    if (!out.length && q.test(hostText)) out.push('well-testing-app.html (host)');
    return out.slice(0, 3);
  }
  function forRoute(key) {
    if (!key || key.startsWith('_')) return [];
    const reg = files.filter((f) => new RegExp('WTS_calcRegistry\\.' + key + '\\s*=|WTS_calcRegistry\\[\'' + key + '\'\\]').test(content[f]));
    if (reg.length) return reg.map((f) => 'prism-build/' + f);
    const m = new RegExp('\\b' + key + ':\\s*(window\\.)?([\\w$]+)[,}]').exec(htmlLines.slice(1700, 1760).join('\n'));
    if (m) { const f = forFn(m[2]); return f.length ? f : ['well-testing-app.html (host ' + m[2] + ')']; }
    return ['well-testing-app.html (host)'];
  }
  return { mapLine, forId, forFn, forRoute, blocks, htmlLines };
})();

const FRAME = /at (?:(.+?) \()?(?:https?:\/\/[^/\s]+\/)?([^():\s]+):(\d+):(\d+)\)?/;
function frames(stack) {
  return String(stack || '').split('\n').map((l) => FRAME.exec(l)).filter(Boolean).slice(0, 5).map((m) => {
    const file = m[2], line = +m[3];
    const src = /well-testing-app\.html$/.test(file) ? SRC.mapLine(line) : file + ':' + line;
    return (m[1] ? m[1] + ' ' : '') + '@ ' + src;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Findings
// ─────────────────────────────────────────────────────────────────────────────
const findings = new Map();
const routeInfo = {};
const stats = { routes: 0, views: 0, clicks: 0, fills: 0, selects: 0, dialogs: 0, downloads: 0, popups: 0, hangs: 0 };
const SEV_RANK = { error: 0, warning: 1, cosmetic: 2, info: 3 };
function areaOf(route, view, kind) {
  if (/^layout|^overlap|^offscreen|^intercept/.test(kind)) return 'layout';
  if (view === 'export' || /^export/.test(kind) || route === '_quickreport') return 'reports+export';
  if (route === '_header' || route === '_offline' || route === '_metric' || route === '_deccomma' || /metric|deccomma/.test(view || '') || route === 'releasenotes' || route === 'privacy' || route === '_sidebar') return 'settings+units+a11y';
  if (/^(prism|dca|pta)$/.test(route)) return 'PRiSM';
  if (route === 'wts') return 'simulator+3D';
  if (/^(modbus|wellos|historian)$/.test(route)) return 'Modbus+WellOS+historian';
  return 'host calculators';
}
function norm(s) { return String(s || '').replace(/https?:\/\/127\.0\.0\.1:\d+\//g, '').replace(/\b\d{3,}\b/g, 'N').slice(0, 300); }
function addFinding(f) {
  f.area = f.area || areaOf(f.route, f.view, f.kind);
  const perControl = /no-effect|intercept|click-failed|bad-token|offscreen|dialog|export|hang|layout|imperial|render/.test(f.kind);
  const key = [f.kind, norm(f.message), (f.stack && f.stack[0]) || '', perControl ? f.route + '|' + ((f.control && f.control.label) || '') + '|' + (f.view || '') : ''].join('§');
  const ex = findings.get(key);
  if (ex) {
    ex.count++;
    if (!ex.routes.includes(f.route)) ex.routes.push(f.route);
    const cl = f.control && f.control.label; if (cl && !ex.controls.includes(cl) && ex.controls.length < 12) ex.controls.push(cl);
    if (SEV_RANK[f.severity] < SEV_RANK[ex.severity]) ex.severity = f.severity;
    return;
  }
  let source = [];
  if (f.stack && f.stack.length) { const m = /@ (.+)$/.exec(f.stack.find((s) => /prism-build|well-testing-app/.test(s)) || f.stack[0]); if (m) source.push(m[1]); }
  if (!source.length && f.control && f.control.id) source = SRC.forId(f.control.id);
  if (!source.length && f.control && f.control.onclick) { const m = /([\w$.]+)\s*\(/.exec(f.control.onclick); if (m) source = SRC.forFn(m[1].replace(/^window\./, '')); }
  if (!source.length && f.control && f.control.sel) { const m = /#([\w-]+)/.exec(f.control.sel); if (m && !/^(pgBody|sidebar|exportBtns)$/.test(m[1])) source = SRC.forId(m[1]); }
  if (!source.length) source = SRC.forRoute(f.route);
  findings.set(key, Object.assign({ count: 1, routes: [f.route], controls: f.control && f.control.label ? [f.control.label] : [], source }, f));
}

// Classify raw events captured during an action into findings.
function eventsToFindings(evs, ctx) {
  for (const e of evs) {
    const base = { route: ctx.route, view: ctx.view, control: ctx.control, action: ctx.action };
    if (e.type === 'pageerror' || e.type === 'rejection') {
      addFinding(Object.assign(base, { severity: 'error', kind: e.type === 'rejection' ? 'unhandled-rejection' : 'exception', message: e.message, stack: frames(e.stack) }));
    } else if (e.type === 'console') {
      const t = e.text;
      if (/Failed to load resource: net::ERR_(FAILED|BLOCKED_BY_CLIENT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)|googletagmanager|service worker/i.test(t)) continue;   // blocked externals (reported separately)
      addFinding(Object.assign(base, { severity: /warn/.test(e.level) ? 'warning' : 'warning', kind: 'console-' + e.level, message: t.slice(0, 400),
        stack: e.stack ? frames(e.stack) : (e.loc && e.loc.url && /well-testing-app/.test(e.loc.url) ? ['console @ ' + SRC.mapLine(e.loc.lineNumber + 1)] : []) }));
    } else if (e.type === 'reqfail') {
      addFinding(Object.assign(base, { severity: 'warning', kind: 'request-failed', message: e.url + ' — ' + e.err }));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session: one context + page with listeners
// ─────────────────────────────────────────────────────────────────────────────
let BASE = '', SAMPLE_CSV = '', sampleProject = null;
class Session {
  constructor(browser, route, vp) { this.browser = browser; this.route = route; this.vp = vp || (MOBILE ? PHONE : DESKTOP); }
  async open() {
    const phone = this.vp.width < 700;
    this.ctx = await this.browser.newContext(Object.assign({ viewport: this.vp, deviceScaleFactor: 1, acceptDownloads: true, serviceWorkers: this.sw ? 'allow' : 'block' },
      phone ? { isMobile: true, hasTouch: true } : {}));
    this.ev = []; this.dialogs = []; this.downloads = []; this.popups = []; this.choosers = [];
    await this.ctx.addInitScript(pageHelper);
    // Software WebGL is slow: the simulator starts in 2D at low quality unless a view switches to 3D.
    await this.ctx.addInitScript(() => { try { if (!localStorage.getItem('h2viz3d_prefs')) localStorage.setItem('h2viz3d_prefs', JSON.stringify({ mode: '2d', quality: 'low' })); } catch (e) { /* ignore */ } });
    await this.ctx.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => {
      const u = r.request().url();
      if (/googletagmanager|google-analytics/.test(u)) { noteExternal(u, 'stubbed (empty analytics script)', this.route); return r.fulfill({ status: 200, contentType: 'text/javascript', body: '/* sweep: analytics stub */' }); }
      if (STUB) for (const [rx, file, ct] of CDN_STUBS) if (rx.test(u) && fs.existsSync(path.join(LIBS, file))) {
        noteExternal(u, 'stubbed from ios-app/ios-additions/libs/' + file, this.route);
        return r.fulfill({ status: 200, contentType: ct, body: fs.readFileSync(path.join(LIBS, file)), headers: { 'access-control-allow-origin': '*' } });
      }
      noteExternal(u, 'blocked', this.route); return r.abort('blockedbyclient');
    });
    this._main = true;
    this.ctx.on('page', (p) => { if (this._main) { this._main = false; return; } this._popup(p); });
    this.page = await this.ctx.newPage();
    const p = this.page;
    p.on('pageerror', (e) => this.ev.push({ type: 'pageerror', message: e.message, stack: e.stack }));
    p.on('console', (m) => {
      if (m.type() !== 'error' && !(m.type() === 'warning' && /\b(fail|error|exception|undefined|NaN)\b/i.test(m.text()))) return;
      this.ev.push({ type: 'console', level: m.type(), text: m.text(), loc: m.location() });
    });
    p.on('requestfailed', (q) => { const u = q.url(); if (/127\.0\.0\.1/.test(u) && !/sw\.js/.test(u)) this.ev.push({ type: 'reqfail', url: u.replace(BASE, ''), err: (q.failure() || {}).errorText }); });
    p.on('response', (r) => { const u = r.url(); if (/127\.0\.0\.1/.test(u) && r.status() >= 400) this.ev.push({ type: 'reqfail', url: u.replace(BASE, ''), err: 'HTTP ' + r.status() }); });
    p.on('dialog', async (d) => {
      this.dialogs.push({ type: d.type(), message: d.message().slice(0, 200) }); stats.dialogs++;
      try { if (d.type() === 'prompt') await d.accept(d.defaultValue() || 'Sweep test'); else await d.accept(); } catch (e) { /* already handled */ }
    });
    p.on('download', async (d) => {
      const rec = { name: d.suggestedFilename(), size: 0 }; this.downloads.push(rec); stats.downloads++;
      try { const f = await d.path(); rec.size = f ? fs.statSync(f).size : 0; if (/\.(h2oilproj|json)$/i.test(rec.name) && this.route === '_header' && /proj/i.test(rec.name) && rec.size > 50) { sampleProject = path.join(OUT, 'sample-project.h2oilproj'); fs.copyFileSync(f, sampleProject); } } catch (e) { rec.err = e.message; }
    });
    p.on('filechooser', async (fc) => {
      const acc = (await fc.element().getAttribute('accept').catch(() => '')) || '';
      this.choosers.push(acc);
      try {
        if (/h2oilproj/i.test(acc) && sampleProject) await fc.setFiles(sampleProject);
        else if (/csv|txt|dat|\.xlsx?|text\//i.test(acc) || !acc) await fc.setFiles(SAMPLE_CSV);
      } catch (e) { /* ignore */ }
    });
    await p.goto(BASE + 'well-testing-app.html', { waitUntil: 'load' });
    await p.waitForFunction(() => typeof window.WTS_nav === 'function' && document.querySelector('.nav-btn'), null, { timeout: 30000 });
    await p.waitForTimeout(500);
    this.rejSeen = 0;
  }
  _popup(p) {
    const rec = { url: '', errors: [], textLen: 0 }; this.popups.push(rec); stats.popups++;
    rec.done = this._popupWatch(p, rec);
  }
  async _popupWatch(p, rec) {
    p.on('pageerror', (e) => rec.errors.push({ type: 'pageerror', message: e.message, stack: e.stack }));
    try {
      await p.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
      for (let i = 0; i < 10; i++) {
        await p.waitForTimeout(400);
        rec.url = p.url();
        rec.textLen = await p.evaluate(() => (document.body ? document.body.innerText.length : 0) + (document.images ? document.images.length * 1000 : 0)).catch(() => -1);
        if (rec.textLen) break;
      }
    } catch (e) { rec.err = e.message; }
    await p.close().catch(() => {});
  }
  async close() { try { await this.ctx.close(); } catch (e) { /* ignore */ } }
  async take() {
    // Drain events (+ unhandled rejections recorded in the page).
    try {
      const rej = await withTimeout(this.page.evaluate((n) => (window.__sweep ? window.__sweep.rej.slice(n) : []), this.rejSeen), 3000);
      if (rej) { this.rejSeen += rej.length; rej.forEach((r) => { if (!this.ev.some((e) => e.type === 'pageerror' && e.message.indexOf(r.message) >= 0)) this.ev.push({ type: 'rejection', message: r.message, stack: r.stack }); }); }
    } catch (e) { /* ignore */ }
    const out = this.ev; this.ev = []; return out;
  }
  eval(fn, a, ms) { return withTimeout(this.page.evaluate(fn, a), ms || 30000); }
}
function withTimeout(pr, ms) {
  let t; return Promise.race([pr, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('TIMEOUT ' + ms + 'ms')), ms); })]).finally(() => clearTimeout(t));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function settleMs(route) { return route === 'prism' || route === 'dca' || route === 'pta' ? 1400 : route === 'wts' ? 1500 : /historian|wellos|modbus/.test(route) ? 700 : 300; }
async function navTo(s, route) {
  await s.eval((r) => { window.WTS_nav(r); }, route, 20000);
  await sleep(settleMs(route));
}

// ─────────────────────────────────────────────────────────────────────────────
// Views: what to sweep on each route
// ─────────────────────────────────────────────────────────────────────────────
// view = { name, scope, excl?, setup?(s), sweep? (default true), order? }
function viewsFor(route) {
  const main = { name: 'main', scope: '#pgBody' };
  const exp = { name: 'export', scope: '#exportBtns', slow: true };
  if (route === 'dca' || route === 'pta') return [];      // aliases of prism: render/layout only
  if (route === 'home') return [{ name: 'main', scope: '#pgBody' }];
  if (route === 'clientinfo') return [main];
  if (route === 'prism') {
    const v = [];
    for (let t = 1; t <= 7; t++) v.push({ name: 'tab' + t, scope: '#pgBody', setup: async (s) => { await s.eval((n) => { const b = document.querySelector('[data-prism-tab="' + n + '"]'); if (b) b.click(); }, t); await sleep(500); } });
    for (let st = 1; st <= 5; st++) v.push({ name: 'step' + st, scope: '#pgBody', setup: async (s) => { await s.eval((n) => { if (window.PRiSM_gotoStep) window.PRiSM_gotoStep(n); }, st); await sleep(500); } });
    v.push({ name: 'tools', scope: '#prism_tools_drawer', setup: async (s) => { await s.eval(() => { if (window.PRiSM_openTools) window.PRiSM_openTools(); }); await sleep(500); } });
    v.push(exp);
    return v;
  }
  if (route === 'wts') {
    // Pause the running simulator so a click's effect is not lost in the animation; every toolbar
    // menu (Scenarios, Reset, View, …) is swept as its own overlay view in both modes.
    const mode = (m) => async (s) => {
      await s.eval((x) => { const b = document.querySelector('[data-act=mode' + x + ']'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); }, m);
      await sleep(700);
      if (m === '3d') await s.page.waitForFunction(() => { const l = document.getElementById('wtsl_loading'); return !l || !l.offsetParent || getComputedStyle(l).display === 'none'; }, null, { timeout: 20000 }).catch(() => {});
      await s.eval(() => { const b = document.querySelector('[data-act=play]'); if (b && b.getAttribute('aria-label') === 'Pause') b.click(); });
      await sleep(200);
    };
    const menuView = (m, act) => ({ name: m + '-menu-' + act, scope: '@scope', reopen: true, setup: async (s) => {
      await mode(m)(s);
      const before = await s.eval(() => window.__sweep.overlays().list.map((x) => x.id));
      const ok = await s.eval((a) => { const b = Array.from(document.querySelectorAll('[data-act=' + a + ']')).find((x) => x.offsetParent); if (b) b.click(); return !!b; }, act);
      await sleep(300);
      if (ok) await s.eval((b) => {
        document.querySelectorAll('[data-sweep-scope]').forEach((x) => x.removeAttribute('data-sweep-scope'));
        const m = Array.from(document.querySelectorAll('.wtsl-menu, .wtsl-pop, #wtsl_drawer, [role=menu], [role=dialog]')).find((x) => x.offsetParent || x.getClientRects().length);
        if (m) m.setAttribute('data-sweep-scope', '1'); else window.__sweep.markNewOverlay(b);
      }, before); } });
    const v = [{ name: '2d', scope: '#pgBody', setup: mode('2d') }, { name: '3d', scope: '#pgBody', setup: mode('3d') }];
    for (const m of ['2d', '3d']) for (const a of (m === '2d' ? ['scen', 'resetmenu', 'alarms'] : ['scen', 'resetmenu', 'alarms', 'viewmenu', 'colour', 'labels', 'quality'])) v.push(menuView(m, a));
    v.push(exp);
    return v;
  }
  if (route === '_header') {
    return [
      { name: 'toolbar', scope: '.page-actions', excl: '#exportBtns, #wts_well_menu' },
      { name: 'well-menu', scope: '#wts_well_menu', setup: async (s) => { await s.eval(() => document.getElementById('wts_well_menu_btn').click()); await sleep(250); }, reopen: true },
      { name: 'quick-report-menu', scope: '@scope', setup: async (s) => {
        const before = await s.eval(() => window.__sweep.overlays().list.map((x) => x.id));
        await s.eval(() => { const b = Array.from(document.querySelectorAll('#wts_quick_report_host button')).find((x) => x.innerText.trim() === '▾'); if (b) b.click(); });
        await sleep(300);
        await s.eval((b) => window.__sweep.markNewOverlay(b), before); }, reopen: true },
    ];
  }
  if (route === '_sidebar') return [{ name: 'sidebar', scope: '#sidebar', excl: '.nav-btn' }];
  return [main, exp];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-view sweep
// ─────────────────────────────────────────────────────────────────────────────
async function freshSession(browser, route, vp) {
  const s = new Session(browser, route, vp); await s.open();
  const boot = await s.take();
  return { s, boot };
}
async function reset(st, route, view, hard) {
  if (hard || !st.s) {
    if (st.s) await st.s.close();
    st.s = new Session(st.browser, st.jobRoute, st.vp); await st.s.open(); await st.s.take();
  }
  const navRoute = route.startsWith('_') ? (route === '_header' || route === '_sidebar' ? 'aga3' : 'home') : route;
  await navTo(st.s, navRoute);
  if (view.setup) await view.setup(st.s);
  const vol = await st.s.eval((ms) => window.__sweep.calibrate(ms), st.vol ? 350 : 900, 20000).catch(() => []);
  st.vol = Array.from(new Set((st.vol || []).concat(vol || [])));
  await st.s.take();   // setup noise was attributed on the main view
}

async function sweepView(browser, route, view, opts) {
  const t0 = Date.now();
  const ri = routeInfo[route] = routeInfo[route] || { title: '', views: {}, controls: 0, clicks: 0, fills: 0, selects: 0, exports: {}, noEffect: [] };
  const vi = ri.views[view.name] = { controls: 0, clicked: 0, fills: 0, selects: 0, skipped: 0, ms: 0 };
  const st = { browser, jobRoute: route, vp: opts.vp, s: null };
  const ctxFor = (control, action) => ({ route, view: view.name, control, action });
  const record = async (control, action) => { eventsToFindings(await st.s.take(), ctxFor(control, action)); };
  try {
    await reset(st, route, view, true);
  } catch (e) {
    addFinding({ severity: 'error', kind: 'render', route, view: view.name, message: 'view setup failed: ' + e.message.split('\n')[0] });
    if (st.s) await st.s.close(); return;
  }
  const s0 = () => st.s;
  const overBudget = () => Date.now() - t0 > BUDGET_MS;

  // Fills + selects (skipped for the header/sidebar/export views).
  if (!/export|well-menu|quick-report|sidebar/.test(view.name)) {
    let inputs = [];
    try { inputs = await s0().eval((a) => window.__sweep.inputs(a[0], a[1]), [view.scope, view.excl || null]); } catch (e) { inputs = []; }
    if (QUICK) inputs = inputs.slice(0, 8);
    const baseTok = new Set(((await s0().eval(() => window.__sweep.tokens('#pgBody')).catch(() => [])) || []).map((t) => t.token + '|' + t.where));
    for (const inp of inputs) {
      if (overBudget()) break;
      if (opts.seen.has('in|' + inp.sel)) continue; opts.seen.add('in|' + inp.sel);
      const control = { label: inp.label || inp.id, id: inp.id, sel: inp.sel };
      for (const v of EDGE_VALUES) {
        try {
          const ok = await s0().eval((a) => window.__sweep.setInput(a[0], a[1], a[2], a[3]), [view.scope, view.excl || null, inp, v], 8000);
          if (!ok) break;
          stats.fills++; vi.fills++; ri.fills++;
          await sleep(90);
          const tok = (await s0().eval(() => window.__sweep.tokens('#pgBody'), null, 8000)) || [];
          const fresh = tok.filter((t) => !baseTok.has(t.token + '|' + t.where));
          if (fresh.length) addFinding({ severity: 'warning', kind: 'bad-token-edge', route, view: view.name, control,
            message: 'input = ' + JSON.stringify(v) + ' renders "' + fresh[0].token + '" (' + fresh.length + ' place' + (fresh.length > 1 ? 's' : '') + ')',
            detail: fresh.slice(0, 3).map((t) => t.where + ': ' + t.text) });
          await record(control, 'fill ' + JSON.stringify(v));
        } catch (e) {
          if (/TIMEOUT/.test(e.message)) { stats.hangs++; addFinding({ severity: 'error', kind: 'hang', route, view: view.name, control, message: 'page unresponsive > 8 s after input = ' + JSON.stringify(v) }); await reset(st, route, view, true); break; }
        }
      }
      try { await s0().eval((a) => window.__sweep.setInput(a[0], a[1], a[2], a[3]), [view.scope, view.excl || null, inp, inp.value], 8000); } catch (e) { /* ignore */ }
    }
    let sels = [];
    try { sels = await s0().eval((a) => window.__sweep.selects(a[0], a[1]), [view.scope, view.excl || null]); } catch (e) { sels = []; }
    for (const sel of sels) {
      if (overBudget()) break;
      if (opts.seen.has('sel|' + sel.sel)) continue; opts.seen.add('sel|' + sel.sel);
      const control = { label: sel.label || sel.id, id: sel.id, sel: sel.sel };
      const optsList = sel.options.filter((o) => o.v !== sel.value).slice(0, QUICK ? 3 : 15);
      for (const o of optsList) {
        try {
          const title0 = await s0().eval(() => window.__sweep.title());
          const ok = await s0().eval((a) => window.__sweep.setSelect(a[0], a[1], a[2], a[3]), [view.scope, view.excl || null, sel, o.v], 10000);
          if (!ok) break;
          stats.selects++; vi.selects++; ri.selects++;
          await sleep(160);
          const tok = (await s0().eval(() => window.__sweep.tokens('#pgBody'), null, 8000)) || [];
          const fresh = tok.filter((t) => !baseTok.has(t.token + '|' + t.where));
          if (fresh.length) addFinding({ severity: 'warning', kind: 'bad-token-edge', route, view: view.name, control,
            message: 'option "' + o.t + '" renders "' + fresh[0].token + '"', detail: fresh.slice(0, 3).map((t) => t.where + ': ' + t.text) });
          await record(control, 'select ' + o.t);
          const title1 = await s0().eval(() => window.__sweep.title());
          if (title1 !== title0) { await reset(st, route, view, false); break; }
        } catch (e) {
          if (/TIMEOUT/.test(e.message)) { stats.hangs++; addFinding({ severity: 'error', kind: 'hang', route, view: view.name, control, message: 'page unresponsive > 10 s after selecting "' + o.t + '"' }); await reset(st, route, view, true); break; }
        }
      }
      try { await s0().eval((a) => window.__sweep.setSelect(a[0], a[1], a[2], a[3]), [view.scope, view.excl || null, sel, sel.value], 10000); await sleep(100); await s0().take(); } catch (e) { /* ignore */ }
    }
    await reset(st, route, view, false).catch(() => reset(st, route, view, true));
  }

  // Clicks.
  let ctrls = null;
  try { ctrls = await s0().eval((a) => window.__sweep.enumerate(a[0], a[1]), [view.scope, view.excl || null]); } catch (e) { ctrls = null; }
  if (!ctrls) {
    if (view.name !== 'main') addFinding({ severity: view.scope === '@scope' ? 'info' : 'warning', kind: 'render', route, view: view.name, message: 'view scope ' + view.scope + ' not found after setup (' + view.name + ' did not open)' });
    await st.s.close(); return;
  }
  // Save before Open (the project written by Save feeds the Open file chooser); destructive last.
  ctrls.sort((a, b) => (a.destructive - b.destructive) || ((/^save/i.test(b.label) ? 1 : 0) - (/^save/i.test(a.label) ? 1 : 0)) || a.i - b.i);
  const todo = ctrls.filter((c) => { const k = 'c|' + (c.id || c.tag + '|' + c.label + '|' + c.nth); if (opts.seen.has(k)) return false; opts.seen.add(k); return true; });
  vi.controls = todo.length; ri.controls += todo.length;
  let n = 0;
  for (const c of (QUICK ? todo.slice(0, 25) : todo)) {
    if (overBudget()) { vi.skipped = todo.length - n; addFinding({ severity: 'info', kind: 'budget', route, view: view.name, message: 'time budget reached — ' + (todo.length - n) + ' controls not clicked' }); break; }
    n++;
    const control = { label: c.label, id: c.id, sel: c.sel, onclick: c.onclick };
    if (c.href && !/^(#|javascript:|blob:|data:)/.test(c.href)) {
      // Links: never navigate away; check local targets exist.
      if (!/^https?:|^mailto:/.test(c.href)) {
        const f = path.join(ROOT, c.href.split(/[?#]/)[0]);
        if (!fs.existsSync(f)) addFinding({ severity: 'warning', kind: 'broken-link', route, view: view.name, control, message: 'local link target missing: ' + c.href });
      }
      continue;
    }
    try {
      let r = await clickOne(st, route, view, c, control, ri, false);
      if (r === 'verify') { await reset(st, route, view, true); r = await clickOne(st, route, view, c, control, ri, true); }
      if (r === 'skipped') { vi.skipped++; ri.skipped = (ri.skipped || 0) + 1; }
      if (r === 'reset-hard') await reset(st, route, view, true);
      else if (r === 'reset') await reset(st, route, view, false);
    } catch (e) {
      if (/TIMEOUT/.test(e.message)) {
        stats.hangs++; addFinding({ severity: 'error', kind: 'hang', route, view: view.name, control, message: 'page unresponsive > 30 s after click' });
      } else vlog('click error ' + route + '/' + c.label + ': ' + e.message.split('\n')[0]);
      try { await reset(st, route, view, true); } catch (e2) { break; }
    }
  }
  vi.ms = Date.now() - t0; vi.clicked = n;
  await st.s.close();
}

const ANSI = /\x1b\[[0-9;]*m|\[\d+m/g;
async function clickOne(st, route, view, c, control, ri, verify) {
  const findIt = () => st.s.eval((a) => window.__sweep.find(a[0], a[1], a[2]), [view.scope, view.excl || null, c]);
  let found = await findIt();
  if (found !== 'ok') { await reset(st, route, view, false); found = await findIt(); }
  // an earlier click may have changed persisted state (localStorage) — retry in a clean context
  if (found !== 'ok') { await reset(st, route, view, true); found = await findIt(); }
  if (found !== 'ok') { vlog('skip ' + route + '/' + view.name + ' "' + c.label + '": ' + found); return 'skipped'; }
  const S = st.s;
  // hover first so hover-only DOM (tooltips) is not counted as the click's effect (it is if the click does nothing)
  await S.eval(() => window.__sweep.mark('h0'));
  await S.page.hover('[data-sweep-target="1"]', { timeout: 1200 }).catch(() => {});
  await sleep(60);
  await S.eval(() => window.__sweep.mark());
  const before = { title: await S.eval(() => window.__sweep.title()), ov: await S.eval(() => window.__sweep.overlays()),
    rec: await S.eval(() => ({ o: window.__sweep.opens.length, p: window.__sweep.prints, c: window.__sweep.clip.length })),
    d: S.dialogs.length, dl: S.downloads.length, pop: S.popups.length, fc: S.choosers.length, url: S.page.url() };
  await S.take();
  stats.clicks++; ri.clicks++;
  let clickErr = null;
  try {
    await S.page.click('[data-sweep-target="1"]', { timeout: 2500, noWaitAfter: true });
  } catch (e) {
    const lines = e.message.replace(ANSI, '').split('\n');
    clickErr = (lines.filter((l) => /intercepts pointer|not visible|outside of the viewport|not stable|detached|not enabled|not attached/.test(l)).pop() || lines[0]).replace(/^\s*-\s*/, '');
    // a drawer / modal left open by an earlier click (sweep state, not the app) → retry after a reset
    if (/intercepts pointer events/.test(clickErr) && /backdrop|aria-modal|role="dialog"|role="alertdialog"/.test(clickErr) && !verify) return 'verify';
    if (/intercepts pointer events/.test(clickErr)) {
      addFinding({ severity: 'warning', kind: 'intercepted', route, view: view.name, control, message: 'real click intercepted: ' + clickErr.trim().replace(/^retrying click action.*$/, '').slice(0, 220) });
    } else if (!/detached/.test(e.message) && !verify) {
      addFinding({ severity: 'info', kind: 'click-failed', route, view: view.name, control, message: 'real click failed (' + clickErr.trim().slice(0, 160) + ') — fell back to element.click()' });
    }
    await S.eval(() => { const e = document.querySelector('[data-sweep-target="1"]'); if (e) e.click(); }).catch(() => {});
  }
  const wait = view.slow ? 1600 : 280;
  await sleep(wait);
  let after = await probe(S, st.vol);
  let effects = diffEffects(before, after, S);
  if (!effects.length) { await sleep(view.slow ? 1800 : 800); after = await probe(S, st.vol); effects = diffEffects(before, after, S); }
  // exports: give slow renders (PNG of big canvases on a busy machine) up to ~8 s more to produce output
  for (let k = 0; view.slow && k < 8 && !effects.some((e) => /download|popup|print|clipboard|dialog/.test(e)); k++) { await sleep(1000); after = await probe(S, st.vol); effects = diffEffects(before, after, S); }
  if (!effects.length) { const h = await S.eval((v) => window.__sweep.changes(v, 'h0'), st.vol || []); if (h.n) effects.push('hover(' + h.n + ')'); }
  eventsToFindings(await S.take(), { route, view: view.name, control, action: 'click' });
  if (!effects.length && !verify && !c.active && !c.fileInput) return 'verify';   // re-check in a clean context before reporting
  // popups: errors inside, empty report windows
  await withTimeout(Promise.all(S.popups.slice(before.pop).map((p) => p.done)), 10000).catch(() => {});
  for (const pr of S.popups.slice(before.pop)) {
    eventsToFindings(pr.errors, { route, view: view.name, control, action: 'popup' });
    if (pr.textLen === 0) addFinding({ severity: 'warning', kind: 'export-empty', route, view: view.name, control, message: 'window.open() popup has no content (' + (pr.url || 'about:blank') + ')' });
  }
  for (const dl of S.downloads.slice(before.dl)) if (!dl.size) addFinding({ severity: 'warning', kind: 'export-empty', route, view: view.name, control, message: 'download "' + dl.name + '" is empty' + (dl.err ? ' (' + dl.err + ')' : '') });
  for (const d of S.dialogs.slice(before.d)) {
    if (d.type === 'alert' && /(error|fail|could not|cannot|invalid|not available|unable)/i.test(d.message)) addFinding({ severity: 'warning', kind: 'dialog-error', route, view: view.name, control, message: 'alert: ' + d.message });
  }
  if (view.name === 'export' || (c.tag === 'button' && /quick report|job report|this page|all wells|generate report/i.test(c.label))) {
    ri.exports[c.label] = effects.length ? effects.join(', ') : 'no output';
    if (!effects.filter((e) => /download|popup|print|clipboard|dialog/.test(e)).length) {
      const status = await S.eval(() => Array.from(document.querySelectorAll('[role=status], [aria-live], .wts-mw-msg')).map((e) => e.innerText.trim()).filter(Boolean).join(' | ').slice(0, 200)).catch(() => '');
      addFinding({ severity: 'warning', kind: 'export-none', route, view: view.name, control, message: 'export produced no download / popup / print / clipboard output (effects: ' + (effects.join(', ') || 'none') + ')' + (status ? ' — status text: "' + status + '"' : '') });
    }
  }
  // new overlays off-screen
  const newOv = after.title !== before.title ? [] : after.ov.list.filter((o) => !before.ov.list.some((b) => b.id === o.id));
  for (const o of newOv) {
    if (o.l < -2 || o.t < -2 || o.r > after.ov.vw + 2 || o.b > after.ov.vh + 2) {
      addFinding({ severity: 'warning', kind: 'offscreen', route, view: view.name, control, message: 'opened ' + o.what + ' partly off-screen [' + o.l + ',' + o.t + ' → ' + o.r + ',' + o.b + '] viewport ' + after.ov.vw + '×' + after.ov.vh });
    }
  }
  if (!effects.length) {
    if (c.active) vlog('already-active ' + c.label);
    else if (!c.fileInput) {
      ri.noEffect.push(c.label);
      addFinding({ severity: 'warning', kind: 'no-effect', route, view: view.name, control, message: 'no visible effect (no DOM / canvas / value change, no dialog, download, popup or navigation)' + (clickErr ? ' — real click failed: ' + clickErr.trim().slice(0, 100) : '') });
    }
  }
  vlog(route + '/' + view.name + ' "' + c.label + '" → ' + (effects.join(', ') || 'NO EFFECT'));
  // State hygiene for the next control.
  if (after.url !== before.url && !/well-testing-app\.html/.test(after.url)) return 'reset-hard';
  if (after.title !== before.title) return 'reset';
  if (view.reopen) return 'reset';
  if (newOv.length) {
    await S.page.keyboard.press('Escape').catch(() => {});
    await sleep(120);
    const still = await S.eval(() => window.__sweep.overlays()).catch(() => null);
    if (!still || still.list.some((o) => newOv.some((n) => n.id === o.id))) return 'reset';
  }
  return null;
}
async function probe(S, vol) {
  return {
    ch: await S.eval((v) => window.__sweep.changes(v), vol || []), title: await S.eval(() => window.__sweep.title()), ov: await S.eval(() => window.__sweep.overlays()),
    rec: await S.eval(() => ({ o: window.__sweep.opens.length, p: window.__sweep.prints, c: window.__sweep.clip.length })), url: S.page.url(),
  };
}
function diffEffects(b, a, S) {
  const e = [];
  if (a.url !== b.url) e.push('navigated(' + a.url.replace(BASE, '') + ')');
  if (a.title !== b.title) e.push('route→' + a.title);
  if (a.ch.n) e.push('dom(' + a.ch.n + ')');
  if (S.dialogs.length > b.d) e.push('dialog:' + S.dialogs.slice(b.d).map((d) => d.type).join('+'));
  if (S.downloads.length > b.dl) e.push('download:' + S.downloads.slice(b.dl).map((d) => d.name + ' ' + d.size + 'B').join('+'));
  if (S.popups.length > b.pop || a.rec.o > b.rec.o) e.push('popup');
  if (a.rec.p > b.rec.p) e.push('print');
  if (a.rec.c > b.rec.c) e.push('clipboard');
  if (S.choosers.length > b.fc) e.push('filechooser');
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route-level jobs
// ─────────────────────────────────────────────────────────────────────────────
async function renderJob(browser, route, title) {
  // Render + baseline tokens + desktop layout + screenshot.
  const { s, boot } = await freshSession(browser, route, DESKTOP);
  if (route === 'home') eventsToFindings(boot, { route: 'home', view: 'boot', action: 'page load' });
  const ri = routeInfo[route] = routeInfo[route] || { title: '', views: {}, controls: 0, clicks: 0, fills: 0, selects: 0, exports: {}, noEffect: [] };
  try {
    await navTo(s, route);
    const info = await s.eval(() => ({ title: document.getElementById('pgTitle').textContent, n: document.getElementById('pgBody').children.length, len: document.getElementById('pgBody').innerText.length }));
    ri.title = info.title || title;
    eventsToFindings(await s.take(), { route, view: 'main', control: { label: '(render)' }, action: 'render' });
    if (!info.n || info.len < 20) addFinding({ severity: 'error', kind: 'render', route, view: 'main', message: 'page body is empty after navigation (children ' + info.n + ', text ' + info.len + ')' });
    if (route !== 'releasenotes') {
      const tok = await s.eval(() => window.__sweep.tokens('#pgBody'));
      const byTok = {};
      tok.forEach((t) => { (byTok[t.token] = byTok[t.token] || []).push(t); });
      Object.keys(byTok).forEach((k) => addFinding({ severity: 'error', kind: 'bad-token-default', route, view: 'main', control: { label: '(default inputs)' },
        message: 'renders "' + k + '" with default inputs (' + byTok[k].length + '×)', detail: byTok[k].slice(0, 4).map((t) => t.where + ': ' + t.text) }));
    }
    const L = await s.eval(() => window.__sweep.layout());
    layoutFindings(route, 'desktop 1440', L);
    await s.page.screenshot({ path: path.join(OUT, 'shots', 'desktop', route + '.png'), fullPage: false }).catch(() => {});
    ri.shot = 'shots/desktop/' + route + '.png';
  } catch (e) {
    addFinding({ severity: 'error', kind: 'render', route, view: 'main', message: 'navigation failed: ' + e.message.split('\n')[0] });
  }
  await s.close();
}
function layoutFindings(route, where, L) {
  if (L.over || L.pbOver) addFinding({ severity: where.startsWith('phone') ? 'warning' : 'cosmetic', kind: 'layout-overflow', route, view: where, control: { label: where },
    message: where + ': horizontal overflow (document ' + L.docW + ' px / viewport ' + L.vw + ' px; #pgBody ' + L.pbW + ' / ' + L.pbCW + ')', detail: L.bad });
  else if (L.nBad) addFinding({ severity: 'cosmetic', kind: 'layout-offscreen', route, view: where, control: { label: where },
    message: where + ': ' + L.nBad + ' element(s) outside the viewport and not in a scroller', detail: L.bad });
  if (L.overlaps.length) addFinding({ severity: 'cosmetic', kind: 'overlap-fixed', route, view: where, control: { label: where },
    message: where + ': overlapping fixed/sticky elements', detail: L.overlaps });
}

async function passJob(browser, name, routes, opts) {
  // One context walks every route: phone layout, Metric mode, decimal comma.
  const vp = opts.vp || DESKTOP;
  const { s } = await freshSession(browser, '_' + name, vp);
  try {
    if (opts.before) { await opts.before(s); eventsToFindings(await s.take(), { route: '_' + name, view: name, control: { label: opts.label }, action: opts.label }); }
    for (const r of routes) {
      try {
        await navTo(s, r);
        eventsToFindings(await s.take(), { route: r, view: name, control: { label: '(' + name + ' render)' }, action: name + ' render' });
        if (opts.layout) {
          layoutFindings(r, 'phone ' + vp.width, await s.eval(() => window.__sweep.layout()));
          if (MOBILE) await s.page.screenshot({ path: path.join(OUT, 'shots', 'phone', r + '.png') }).catch(() => {});
        }
        if (opts.tokens && r !== 'releasenotes') {
          const tok = await s.eval(() => window.__sweep.tokens('#pgBody'));
          if (tok.length) addFinding({ severity: 'warning', kind: 'bad-token-' + name, route: r, view: name, control: { label: '(' + name + ')' },
            message: name + ': renders "' + tok[0].token + '" (' + tok.length + '×)', detail: tok.slice(0, 4).map((t) => t.where + ': ' + t.text) });
        }
        if (opts.imperial) {
          const imp = await s.eval(() => window.__sweep.imperial());
          if (imp.length) addFinding({ severity: 'cosmetic', kind: 'imperial-in-metric', route: r, view: name, control: { label: '(metric)' },
            message: 'Metric mode: ' + imp.length + ' result/label text(s) still carry imperial units', detail: imp.slice(0, 6) });
        }
      } catch (e) {
        if (/TIMEOUT/.test(e.message)) { stats.hangs++; addFinding({ severity: 'error', kind: 'hang', route: r, view: name, message: name + ' pass: page unresponsive' }); break; }
      }
    }
  } finally { await s.close(); }
}

async function simJob(browser) {
  // Run the Well Test Simulator for a few seconds (2D), then stop/reset.
  const { s } = await freshSession(browser, 'wts', DESKTOP);
  const route = 'wts', view = 'run';
  try {
    await navTo(s, 'wts'); await s.take();
    routeInfo.wts = routeInfo.wts || { title: '', views: {}, controls: 0, clicks: 0, fills: 0, selects: 0, exports: {}, noEffect: [] };
    const act = (sel, idx) => s.eval((a) => { const b = Array.from(document.querySelectorAll(a[0])).filter((x) => x.offsetParent)[a[1] || 0]; if (!b) return null; b.click(); return (b.getAttribute('aria-label') || b.innerText || a[0]).trim().slice(0, 60); }, [sel, idx || 0]);
    const clockTxt = () => s.eval(() => (Array.from(document.querySelectorAll('#pgBody *')).map((e) => e.childElementCount ? '' : e.textContent).find((t) => /^\s*(T\+)?\d{1,3}:\d{2}(:\d{2})?\s*$/.test(t || '')) || '').trim());
    const runs = {};
    for (const mode of ['3d', '2d']) {
      await act('[data-act=mode' + mode + ']'); await sleep(800);
      if (mode === '3d') {
        await s.page.waitForFunction(() => { const l = document.getElementById('wtsl_loading'); return !l || !l.offsetParent || getComputedStyle(l).display === 'none'; }, null, { timeout: 20000 })
          .catch(() => addFinding({ severity: 'warning', kind: 'sim', route, view, message: '3D view still loading after 20 s' }));
        const n = await s.eval(() => { const x = document.getElementById('wtsl_notice'); return x && x.offsetParent ? x.innerText.trim() : ''; });
        if (n) addFinding({ severity: 'error', kind: 'sim', route, view, message: '3D notice: ' + n.slice(0, 160) });
      }
      eventsToFindings(await s.take(), { route, view, control: { label: mode.toUpperCase() + ' mode' }, action: 'switch mode' });
      const playing = await s.eval(() => { const b = document.querySelector('[data-act=play]'); return b ? b.getAttribute('aria-label') : null; });
      if (playing === 'Play') await act('[data-act=play]');
      if (!playing) addFinding({ severity: 'warning', kind: 'sim', route, view, message: mode + ': no play/pause control found' });
      await s.eval(() => { const b = Array.from(document.querySelectorAll('[data-act=speed]')).find((x) => /60\b/.test(x.innerText) && !/600/.test(x.innerText)); if (b) b.click(); });
      const c0 = await clockTxt(); await s.eval(() => window.__sweep.mark());
      await sleep(4000);
      const ch = await s.eval(() => window.__sweep.changes([]), null, 20000);
      const c1 = await clockTxt();
      eventsToFindings(await s.take(), { route, view, control: { label: mode + ' run ×60' }, action: 'run 4 s' });
      runs[mode] = { clockBefore: c0, clockAfter: c1, changedNodes: ch.n };
      if (!ch.n) addFinding({ severity: 'error', kind: 'sim', route, view, control: { label: mode + ' run' }, message: mode.toUpperCase() + ': simulator running at ×60 but nothing on the page changed in 4 s' });
      // every fault scenario while running
      const nf = await s.eval(() => (window.WTS_sim && window.WTS_sim.FAULTS || []).length);
      for (let i = 0; i < nf; i++) {
        const open = await s.eval(() => Array.from(document.querySelectorAll('[data-act=fault]')).some((x) => x.offsetParent));
        if (!open) { await act('[data-act=scen]'); await sleep(250); }
        const lab = await act('[data-act=fault]', i); await sleep(1200);
        eventsToFindings(await s.take(), { route, view, control: { label: 'fault: ' + (lab || i) }, action: mode + ' fault on' });
        if (!lab) { addFinding({ severity: 'warning', kind: 'sim', route, view, message: mode + ': Scenarios menu did not list fault #' + (i + 1) }); await s.page.keyboard.press('Escape'); }
      }
      await act('[data-act=esd]'); await sleep(800);
      eventsToFindings(await s.take(), { route, view, control: { label: 'ESD' }, action: mode + ' ESD' });
      await act('[data-act=resetmenu]'); await sleep(250); const rl = await act('.wtsl-menu [data-act=reset]'); await sleep(800);
      eventsToFindings(await s.take(), { route, view, control: { label: 'Reset' + (rl ? ': ' + rl : '') }, action: mode + ' reset' });
      runs[mode].faults = nf;
    }
    routeInfo.wts.simRun = runs;
    const info3d = await s.eval(() => (window.WTS_3d && window.WTS_3d.loadInfo ? window.WTS_3d.loadInfo() : null));
    routeInfo.wts.three = info3d;
  } catch (e) {
    addFinding({ severity: 'error', kind: 'sim', route, view, message: 'simulator run failed: ' + e.message.split('\n')[0] });
  } finally { await s.close(); }
}

async function serviceWorkerJob(browser) {
  // The sweep blocks service workers elsewhere (their fetches bypass request interception). Here the
  // offline worker is allowed: it must register, and a reload with the network off must still boot.
  const s = new Session(browser, '_offline', DESKTOP); s.sw = true;
  const route = '_offline', view = 'service worker';
  try {
    await s.open();
    eventsToFindings(await s.take(), { route, view, control: { label: '(load with service worker)' }, action: 'load' });
    await sleep(2500);
    const reg = await s.eval(() => navigator.serviceWorker ? navigator.serviceWorker.getRegistration().then((r) => r ? { scope: r.scope, active: !!r.active, state: r.active ? r.active.state : (r.installing ? 'installing' : r.waiting ? 'waiting' : '') } : null) : null);
    routeInfo._offline = { title: 'Offline / service worker', views: {}, controls: 0, clicks: 0, fills: 0, selects: 0, exports: {}, noEffect: [], sw: reg };
    if (!reg) { addFinding({ severity: 'warning', kind: 'offline', route, view, message: 'no service worker registration after load' }); return; }
    await s.ctx.setOffline(true);
    await s.page.reload({ waitUntil: 'load', timeout: 20000 });
    const ok = await s.page.waitForFunction(() => typeof window.WTS_nav === 'function' && document.querySelector('.nav-btn'), null, { timeout: 15000 }).then(() => true, () => false);
    routeInfo._offline.offlineReload = ok;
    if (!ok) addFinding({ severity: 'error', kind: 'offline', route, view, message: 'app does not boot on an offline reload (service worker ' + reg.state + ')' });
    eventsToFindings(await s.take(), { route, view, control: { label: '(offline reload)' }, action: 'offline reload' });
  } catch (e) {
    addFinding({ severity: 'warning', kind: 'offline', route, view, message: 'offline check failed: ' + e.message.split('\n')[0] });
  } finally { await s.close(); }
}

async function homeTilesJob(browser) {
  // Every dashboard tile must navigate to its page.
  const { s } = await freshSession(browser, 'home', DESKTOP);
  try {
    await navTo(s, 'home');
    const n = await s.eval(() => document.querySelectorAll('#pgBody .dash-card').length);
    routeInfo.home = routeInfo.home || { title: 'Dashboard', views: {}, controls: 0, clicks: 0, fills: 0, selects: 0, exports: {}, noEffect: [] };
    routeInfo.home.tiles = n;
    for (let i = 0; i < n; i++) {
      await navTo(s, 'home');
      const t = await s.eval((k) => { const c = document.querySelectorAll('#pgBody .dash-card')[k]; if (!c) return null; const h = (c.querySelector('h3') || c).innerText.trim(); c.querySelector('h3') ? c.querySelector('h3').click() : c.click(); return h; }, i);
      await sleep(250);
      const title = await s.eval(() => window.__sweep.title());
      stats.clicks++;
      eventsToFindings(await s.take(), { route: 'home', view: 'tiles', control: { label: 'tile: ' + t }, action: 'click' });
      if (t && title === 'Dashboard') addFinding({ severity: 'warning', kind: 'no-effect', route: 'home', view: 'tiles', control: { label: 'tile: ' + t }, message: 'dashboard tile did not navigate' });
    }
  } finally { await s.close(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────
const AREAS = ['host calculators', 'PRiSM', 'simulator+3D', 'Modbus+WellOS+historian', 'reports+export', 'settings+units+a11y', 'layout'];
function writeReport(meta) {
  const list = Array.from(findings.values()).sort((a, b) => (AREAS.indexOf(a.area) - AREAS.indexOf(b.area)) || (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || String(a.route).localeCompare(String(b.route)));
  list.forEach((f, i) => { f.id = 'F' + String(i + 1).padStart(3, '0'); });
  const ext = Array.from(external.entries()).map(([u, v]) => ({ url: u, action: v.action, routes: Array.from(v.routes).sort() }));
  const json = { meta, stats, external: ext, routes: routeInfo, findings: list };
  fs.writeFileSync(path.join(OUT, 'sweep-report.json'), JSON.stringify(json, null, 1));
  const sev = (s) => list.filter((f) => f.severity === s).length;
  const md = [];
  md.push('# GUI sweep report', '', '- Date: ' + meta.date + ' · duration ' + Math.round(meta.ms / 1000) + ' s · mode ' + meta.mode + ' · viewport ' + meta.viewport);
  md.push('- Routes: ' + meta.routes.length + ' · views: ' + stats.views + ' · clicks: ' + stats.clicks + ' · fills: ' + stats.fills + ' · select changes: ' + stats.selects +
    ' · dialogs: ' + stats.dialogs + ' · downloads: ' + stats.downloads + ' · popups: ' + stats.popups + ' · hangs: ' + stats.hangs);
  md.push('- Findings: **' + list.length + '** (error ' + sev('error') + ', warning ' + sev('warning') + ', cosmetic ' + sev('cosmetic') + ', info ' + sev('info') + ')', '');
  md.push('## External network', '', 'All non-local requests are intercepted. Features that need them:', '');
  ext.forEach((e) => md.push('- `' + e.url + '` — ' + e.action + ' (routes: ' + e.routes.join(', ') + ')'));
  md.push('');
  for (const area of AREAS) {
    const fa = list.filter((f) => f.area === area && f.severity !== 'info');
    md.push('## ' + area + ' (' + fa.length + ')', '');
    if (!fa.length) { md.push('_No findings._', ''); continue; }
    const byRoute = {};
    fa.forEach((f) => { (byRoute[f.route] = byRoute[f.route] || []).push(f); });
    for (const r of Object.keys(byRoute)) {
      md.push('### ' + r + (routeInfo[r] && routeInfo[r].title ? ' — ' + routeInfo[r].title : ''), '');
      for (const f of byRoute[r]) {
        md.push('- **' + f.id + ' [' + f.severity + '] ' + f.kind + '** — ' + f.message.replace(/\n/g, ' ').slice(0, 400));
        const bits = [];
        if (f.controls.length) bits.push('control: ' + f.controls.map((c) => '`' + c.replace(/`/g, "'") + '`').join(', ') + (f.control && f.control.sel ? ' (`' + f.control.sel + '`)' : ''));
        if (f.view) bits.push('view: ' + f.view);
        if (f.action) bits.push('action: ' + f.action);
        if (f.routes.length > 1) bits.push('also on: ' + f.routes.filter((x) => x !== r).join(', '));
        if (f.count > 1) bits.push('×' + f.count);
        md.push('  - ' + bits.join(' · '));
        if (f.stack && f.stack.length) md.push('  - stack: ' + f.stack.slice(0, 4).map((x) => '`' + x + '`').join(' ← '));
        if (f.detail && f.detail.length) md.push('  - detail: ' + f.detail.slice(0, 4).map((x) => '`' + String(x).replace(/`/g, "'").slice(0, 160) + '`').join('; '));
        md.push('  - likely source: ' + (f.source.join(', ') || '?'));
      }
      md.push('');
    }
  }
  md.push('## Exports per route', '', '| route | Copy | PDF | PNG | CSV | JSON |', '|---|---|---|---|---|---|');
  Object.keys(routeInfo).sort().forEach((r) => {
    const e = routeInfo[r].exports || {}; const k = Object.keys(e); if (!k.length) return;
    const pick = (rx) => { const x = k.find((q) => rx.test(q)); return x ? e[x].replace(/\|/g, '/').slice(0, 60) : ''; };
    md.push('| ' + r + ' | ' + pick(/copy/i) + ' | ' + pick(/pdf/i) + ' | ' + pick(/png/i) + ' | ' + pick(/csv/i) + ' | ' + pick(/json/i) + ' |');
  });
  md.push('', '## Coverage per route', '', '| route | title | controls | clicks | fills | selects | no-effect |', '|---|---|---|---|---|---|---|');
  Object.keys(routeInfo).sort().forEach((r) => { const x = routeInfo[r]; md.push('| ' + r + ' | ' + (x.title || '') + ' | ' + x.controls + ' | ' + x.clicks + ' | ' + x.fills + ' | ' + x.selects + ' | ' + x.noEffect.length + ' |'); });
  const info = list.filter((f) => f.severity === 'info');
  if (info.length) { md.push('', '## Info', ''); info.forEach((f) => md.push('- ' + f.route + '/' + (f.view || '') + ': ' + f.message)); }
  fs.writeFileSync(path.join(OUT, 'sweep-report.md'), md.join('\n') + '\n');
  return { list, sev };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const pw = loadPlaywright();
  if (!pw) { say('[skip] playwright not installed'); return; }
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
  if (!fs.existsSync(HTML)) { say('[skip] ' + HTML + ' missing'); return; }
  fs.mkdirSync(path.join(OUT, 'shots', 'desktop'), { recursive: true });
  if (MOBILE) fs.mkdirSync(path.join(OUT, 'shots', 'phone'), { recursive: true });
  SAMPLE_CSV = path.join(OUT, 'sample-data.csv');
  { const rows = ['time_hr,pressure_psi,rate_stbd']; for (let i = 0; i < 80; i++) { const t = 0.001 * Math.pow(10, i / 16); rows.push(t.toFixed(5) + ',' + (2500 + 180 * Math.log10(1 + t * 1000)).toFixed(2) + ',0'); } fs.writeFileSync(SAMPLE_CSV, rows.join('\n')); }
  const t0 = Date.now();
  const srv = serve(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + srv.address().port + '/';
  let browser;
  try { browser = await pw.chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] }); }
  catch (e) { say('[skip] chromium not available: ' + String(e.message).split('\n')[0]); srv.close(); return; }

  // Discover routes from the app itself.
  const { s: disc } = await freshSession(browser, 'home', DESKTOP);
  const d = await disc.eval(() => ({
    nav: Array.from(document.querySelectorAll('.nav-btn[data-p]')).map((b) => [b.dataset.p, b.innerText.replace(/\s+/g, ' ').trim()]),
    reg: Object.keys(window.WTS_calcRegistry || {}).map((k) => [k, window.WTS_calcRegistry[k].title]),
  }));
  await navTo(disc, 'home');
  const tiles = await disc.eval(() => Array.from(document.querySelectorAll('#pgBody .dash-card h3')).map((h) => h.innerText.trim()));
  await disc.close();
  const pagesSrc = /const pages = \{([^}]+)\}/.exec(SRC.htmlLines.slice(1700, 1760).join('\n'));
  const hostKeys = pagesSrc ? Array.from(pagesSrc[1].matchAll(/(\w+):/g)).map((m) => m[1]) : [];
  const titles = {};
  d.nav.forEach(([k, t]) => { titles[k] = t; }); d.reg.forEach(([k, t]) => { titles[k] = titles[k] || t; });
  let routes = Array.from(new Set(d.nav.map((x) => x[0]).concat(d.reg.map((x) => x[0]), hostKeys)));
  const navSet = new Set(d.nav.map((x) => x[0]));
  hostKeys.filter((k) => !navSet.has(k) && !/^(dca|pta)$/.test(k)).forEach((k) => addFinding({ severity: 'info', kind: 'orphan-route', route: k, message: 'route "' + k + '" is in the host pages table but has no sidebar button' }));
  d.reg.filter(([k]) => !navSet.has(k)).forEach(([k]) => addFinding({ severity: 'warning', kind: 'registry', route: k, message: 'calculator "' + k + '" is registered but has no sidebar button' }));
  routes.push('_header', '_sidebar');
  if (ONLY.length) routes = routes.filter((r) => ONLY.includes(r));
  const pageRoutes = routes.filter((r) => !r.startsWith('_'));
  say('[gui-sweep] ' + pageRoutes.length + ' routes (' + d.nav.length + ' sidebar, ' + d.reg.length + ' registry, ' + hostKeys.length + ' host table, ' + tiles.length + ' dashboard tiles); ' + WORKERS + ' workers; out ' + OUT);

  // Jobs: longest first.
  const jobs = [];
  const vp = MOBILE ? PHONE : DESKTOP;
  const weight = (r, v) => (r === 'prism' ? 50 : r === 'wts' ? 40 : /modbus|wellos|historian/.test(r) ? 20 : 10) + (v === 'main' || /^tab/.test(v) ? 5 : 0);
  for (const r of routes) {
    if (!r.startsWith('_')) jobs.push({ w: 30, name: r + ' render', run: () => renderJob(browser, r, titles[r]) });
    const seen = new Set();   // controls already exercised in an earlier view of the same route (sequential per route)
    const views = viewsFor(r);
    if (views.length) jobs.push({ w: weight(r, 'main') + views.length * 5, name: r + ' views', run: async () => { for (const v of views) { stats.views++; say('  · ' + r + '/' + v.name); await sweepView(browser, r, v, { vp, seen }); } } });
  }
  if (!ONLY.length || ONLY.includes('wts')) jobs.push({ w: 45, name: 'wts run', run: () => simJob(browser) });
  if (QUICK && (!ONLY.length || ONLY.includes('home'))) jobs.push({ w: 25, name: 'home tiles', run: () => homeTilesJob(browser) });   // full mode: the home view clicks every tile
  if (!QUICK) {
    if (!ONLY.length) jobs.push({ w: 20, name: 'offline', run: () => serviceWorkerJob(browser) });
    jobs.push({ w: 20, name: 'phone layout', run: () => passJob(browser, 'phone', pageRoutes, { vp: PHONE, layout: true }) });
    jobs.push({ w: 20, name: 'metric', run: () => passJob(browser, 'metric', pageRoutes, { tokens: true, imperial: true, label: 'Metric', before: async (s) => { await s.page.click('#wts_units_metric'); await sleep(300); } }) });
    jobs.push({ w: 20, name: 'deccomma', run: () => passJob(browser, 'deccomma', pageRoutes, { tokens: true, label: 'decimal comma', before: async (s) => { await s.page.click('#wts_dec_comma'); await sleep(300); } }) });
  }
  // PRiSM views are the long pole — split its view list across workers.
  for (const big of ['prism', 'wts']) {
    const pj = jobs.findIndex((j) => j.name === big + ' views');
    if (pj < 0) continue;
    jobs.splice(pj, 1);
    const views = viewsFor(big);
    const seen = new Set();   // shared: a control is exercised once per route (chunks run in parallel, best effort)
    // prism: chunks of 3 views; wts: all 3D views in ONE job (one software-WebGL page at a time), 2D + export in another
    const parts = big === 'prism' ? [] : [views.filter((v) => /^3d/.test(v.name)), views.filter((v) => !/^3d/.test(v.name))];
    if (big === 'prism') for (let a = 0; a < views.length; a += 3) parts.push(views.slice(a, a + 3));
    parts.forEach((part, k) => {
      jobs.push({ w: (big === 'prism' ? 60 : 70) - k, name: big + ' views ' + part.map((v) => v.name).join(','), run: async () => { for (const v of part) { stats.views++; say('  · ' + big + '/' + v.name); await sweepView(browser, big, v, { vp, seen }); } } });
    });
  }
  jobs.sort((a, b) => b.w - a.w);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++]; const t = Date.now();
      try { await j.run(); } catch (e) { addFinding({ severity: 'info', kind: 'sweep-error', route: j.name.split(' ')[0], message: 'sweep job "' + j.name + '" crashed: ' + e.message.split('\n')[0] }); }
      say('[done] ' + j.name + ' (' + Math.round((Date.now() - t) / 1000) + ' s)');
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  await browser.close(); srv.close();
  stats.routes = pageRoutes.length;
  const { list, sev } = writeReport({ date: new Date().toISOString(), ms: Date.now() - t0, mode: QUICK ? 'quick' : 'full', viewport: MOBILE ? '390 phone' : '1440 desktop', routes: pageRoutes, stub: STUB,
    notes: ['File System Access pickers are disabled in the sweep (download / <input type=file> fallbacks exercised)', 'window.print() and clipboard writes are recorded, not performed'] });
  say('[gui-sweep] ' + list.length + ' findings (error ' + sev('error') + ', warning ' + sev('warning') + ', cosmetic ' + sev('cosmetic') + ') · ' + stats.clicks + ' clicks, ' + stats.fills + ' fills, ' + stats.selects + ' selects in ' + Math.round((Date.now() - t0) / 1000) + ' s');
  say('[gui-sweep] ' + path.join(OUT, 'sweep-report.md'));
})().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(2); });
