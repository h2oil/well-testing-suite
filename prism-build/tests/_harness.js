// prism-build/tests/_harness.js — headless app harness for PRiSM acceptance
// tests. Owned by WP0. Nothing here writes to the repo.
//
//   const { loadApp } = require('./_harness');
//   const app = loadApp({ fromSources: true, timers: 'manual' });
//   app.openPRiSM(); app.renderTab(2); app.flush(500);
//
// loadApp(opts) options (all optional):
//   fromSources  true (default) — rebuild the main script IN MEMORY from the
//                current prism-build/ sources (phase1-2, phase3-4, round2..6,
//                round8, round9 = every 4N-calc-*.js plus any such name in
//                sourceOverrides; round 7 is left as it is in the HTML). A source that
//                fails a syntax check falls back to its git HEAD version (with
//                a warning naming the file). false — use well-testing-app.html
//                exactly as it is on disk.
//   html         a full HTML string to load instead (advanced).
//   timers       'manual' (default) — virtual clock; nothing runs until
//                flush(ms). Date.now / new Date() / performance.now follow the
//                virtual clock. 'real' — Node timers (flush(ms) returns a
//                Promise that resolves after ms of real time).
//   domStore     true (default) — real node tree + id registry (always on;
//                the flag is accepted for API compatibility).
//   recordCanvas true (default) — 2D contexts record every call.
//   storage      a storage object from createStorage() or a previous app's
//                app.storage — shared localStorage for reload tests.
//   viewport     {width:1280, height:800}   (C9: use {width:375,height:812} for phones)
//   layout       {width:900, height:420}    default element box size
//   console      'capture' (default) | 'inherit' (also print) | 'errors'
//                (print console.error only). Env PRISM_HARNESS_VERBOSE=1 → 'inherit'.
//   confirm      value returned by window.confirm (default true)
//   prompt       value returned by window.prompt (default null)
//   seed         false (default) — when true, clear the sample-suppress flag
//                and seed the default sample right after load.
//
// The returned app:
//   win, document, storage, sessionStorage
//   flush(ms=0)            advance the virtual clock (manual) — runs due timers
//   flushAsync(ms=0)       same, but yields to the microtask queue between timers
//   flushUntilIdle(maxMs)  advance until no timers remain (or maxMs elapsed)
//   pendingTimers()        number of pending timers; timers() → details (+ creation stack)
//   el(id) / $(id)         document.getElementById
//   find(sel) / findAll(sel)
//   click(idOrEl, {allowErrors})   dispatch a click; throws if a handler threw
//   input(idOrEl, value), change(idOrEl, value), select(idOrEl, value), check(idOrEl, bool),
//   key(idOrEl, key, type='keydown')
//   fire(target, type, detail)     target 'window' | 'document' | id | element
//   seedSample()           seed the default sample → window.PRiSM_dataset
//   openPRiSM()            navigate the host app to PRiSM (renderPRiSM into #pgBody)
//   renderPRiSM(hostEl?)   call the host-scope renderPRiSM directly
//   renderTab(n)           call PRiSM_renderTab(n) (host scope or window export)
//   gotoTab(n)             window.PRiSM.setTab(n) (falls back to renderTab)
//   canvasLog(canvasOrId, op?)  recorded 2D calls ([{op,args}|{op:'set',prop,value}]);
//                          with op → the args arrays of that op only
//   canvasTexts(canvasOrId) fillText strings;  canvases(rootOrId?) → canvas elements
//   logs, errors, consoleErrors(), downloads, dialogs, clipboard, opened
//   resize(w, h)           change the viewport and fire 'resize' (+ matchMedia change)
//   toWin(value)           deep-copy a plain value into the app realm
//   reload(extraOpts)      new session sharing this app's localStorage
//   build                  {mode, fallbacks:[...], skipped:[...], warnings:[...]}
//   hook                   host-scope test hook {renderPRiSM, renderTab, nav, render, page}
//
// Limitations (see accept-test.js --help):
//   • no real layout / CSS cascade: sizes come from inline px styles, canvas
//     attributes, or the layout defaults; display:none (inline style or
//     hidden attribute, self or ancestor) and detached elements measure 0.
//   • getComputedStyle only knows inline styles + :root custom properties.
//   • values created in test code live in the Node realm: `x instanceof Array`
//     inside app code is false for them — pass app.toWin(x) when it matters.
//   • FileReader / Image / toBlob / clipboard complete via timers: flush().
//   • fetch / XMLHttpRequest always fail; WebGL contexts are null.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const D = require('./_dom');

const BUILD_DIR = path.resolve(__dirname, '..');
const REPO = path.resolve(BUILD_DIR, '..');
const HTML_PATH = path.join(REPO, 'well-testing-app.html');

// Pipeline in injection order. Round 7 is never rebuilt here.
const PIPELINE = [
  ['concat-phase1-2', 'inject-phase1-2'],
  ['concat-phase3-4', 'inject-phase3-4'],
  ['concat-round2', 'inject-round2'],
  ['concat-round3', 'inject-round3'],
  ['concat-round4', 'inject-round4'],
  ['concat-round5', 'inject-round5'],
  ['concat-round6', 'inject-round6'],
  ['concat-round8', 'inject-round8'],
  ['concat-round9', 'inject-round9'],   // plug-in calculators: every prism-build/4N-calc-*.js
];

const MAIN_RE = /<script>\s*\/\* ═+\s*WELL TESTING SUITE([\s\S]+?)<\/script>/;

// ─────────────────────────────────────────────────────────────────────────
// Source resolution with syntax-check + git HEAD fallback
// ─────────────────────────────────────────────────────────────────────────
function gitShowHead(rel) {
  const args = ['show', 'HEAD:' + rel];
  const opts = { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 };
  for (const git of ['git', 'C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe']) {
    try { return execFileSync(git, args, opts); } catch (e) {
      if (e.code === 'ENOENT') continue;
      return null;   // not in HEAD
    }
  }
  return null;
}
function syntaxError(src, file) {
  try { new vm.Script(src, { filename: file }); return null; } catch (e) {
    if (!(e instanceof SyntaxError) && e.name !== 'SyntaxError') return null;
    const m = /:(\d+)\s*$/m.exec(String(e.stack).split('\n')[0]);
    return e.message + (m ? ' (line ' + m[1] + ')' : '');
  }
}

let _buildCache = null;
// opts: { silent, noCache, overrides: { 'NN-file.js': sourceText | null } }
//   overrides replace a source file's working-copy text for this build only
//   (null = treat as missing). A build with overrides is never cached.
function buildFromSources(opts) {
  opts = opts || {};
  const cacheable = !opts.overrides;
  if (_buildCache && cacheable && !opts.noCache) return _buildCache;
  const warnings = [];
  const fallbacks = [];
  const skipped = [];
  const warn = (m) => { warnings.push(m); if (!opts.silent) console.warn(m); };
  const resolved = new Map();
  const read = (file) => {
    if (resolved.has(file)) return resolved.get(file);
    const rel = 'prism-build/' + file;
    const p = path.join(BUILD_DIR, file);
    const ov = opts.overrides && Object.prototype.hasOwnProperty.call(opts.overrides, file) ? opts.overrides[file] : undefined;
    // An explicit null override means "this file is absent" — never fall back
    // to its git HEAD copy (that would silently undo the override once the
    // file is committed).
    if (ov === null) { skipped.push({ file, error: 'override: absent' }); resolved.set(file, null); return null; }
    let src = ov !== undefined ? ov : (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
    let out = null;
    if (src != null) {
      const err = syntaxError(src, file);
      if (!err) out = src;
      else {
        const head = gitShowHead(rel);
        if (head != null && !syntaxError(head, file)) {
          warn('[harness] WARNING ' + file + ': syntax error in working copy — ' + err + ' — using git HEAD version instead');
          fallbacks.push({ file, error: err });
          out = head;
        } else {
          warn('[harness] WARNING ' + file + ': syntax error — ' + err + ' — and no usable HEAD version; file SKIPPED');
          skipped.push({ file, error: err });
        }
      }
    } else {
      const head = gitShowHead(rel);
      if (head != null && !syntaxError(head, file)) {
        warn('[harness] WARNING ' + file + ': missing from working tree — using git HEAD version');
        fallbacks.push({ file, error: 'missing' });
        out = head;
      } else {
        skipped.push({ file, error: 'missing' });   // e.g. a Round-8 file that has not landed yet
      }
    }
    resolved.set(file, out);
    return out;
  };
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  const quiet = { log() {}, warn(m) { if (!/not present — skipped|not available — skipped/.test(m)) warn('[harness] ' + m); } };
  // Round 9 lists its files from the directory; override names let a test add
  // an in-memory calculator (e.g. '49-calc-probe.js') that is not on disk.
  const extraFiles = opts.overrides ? Object.keys(opts.overrides).filter((f) => opts.overrides[f] != null) : [];
  for (const [c, i] of PIPELINE) {
    const concat = require(path.join(BUILD_DIR, c + '.js'));
    const inject = require(path.join(BUILD_DIR, i + '.js'));
    const blob = concat.build({ read, log: quiet, extraFiles });
    try { html = inject.inject(html, blob).out; }
    catch (e) { throw new Error('[harness] ' + i + ' failed in memory: ' + (e.lines || [e.message]).join(' ')); }
  }
  const result = { html, mode: 'sources', fallbacks, skipped, warnings };
  if (cacheable) _buildCache = result;
  return result;
}

function extractMain(html) {
  const m = html.match(MAIN_RE);
  if (!m) throw new Error('[harness] could not locate the WELL TESTING SUITE main <script>');
  return '/* ═══ WELL TESTING SUITE' + m[1];
}

// Host-scope hook appended just before the host IIFE closes.
const HOOK = '\n;window.__WTS_TEST__ = {\n' +
  '  renderPRiSM: function (b) { return renderPRiSM(b); },\n' +
  "  renderTab: function (n) { var f = (typeof PRiSM_renderTab === 'function') ? PRiSM_renderTab : window.PRiSM_renderTab; return f(n); },\n" +
  "  nav: function (p) { return (typeof nav === 'function') ? nav(p) : undefined; },\n" +
  "  render: function () { return (typeof render === 'function') ? render() : undefined; },\n" +
  "  page: function () { try { return page; } catch (e) { return undefined; } }\n" +
  '};\n';

function withHook(main) {
  const k = main.lastIndexOf('})();');
  if (k === -1) throw new Error('[harness] main script has no closing })();');
  return main.slice(0, k) + HOOK + main.slice(k);
}

// Map a main-script line number to the prism-build file it came from.
// Source line numbers survive the self-test strip (it only cuts at the end).
const _lineCache = new WeakMap();
function fileAtLine(main, line) {
  let lines = _lineCache.get(Object(main));
  if (!lines) lines = main.split('\n');
  let cur = null, begin = -1;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const b = /\/\/ ─── BEGIN ([\w.-]+)/.exec(lines[i]);
    if (b) { cur = b[1]; begin = i; }
    const e = /\/\/ ─── END ([\w.-]+)/.exec(lines[i]);
    if (e && cur === e[1] && i < line - 1) cur = null;
  }
  if (!cur) return 'host well-testing-app.html (main-script line ' + line + ')';
  // Rounds 2+ put a '// ═══' rule after the BEGIN line; phase 1+2 does not.
  const skip = /^\/\/ ═+\s*$/.test(lines[begin + 1] || '') ? 2 : 1;
  return 'prism-build/' + cur + '.js:' + (line - begin - skip);
}

const scriptCache = new Map();
function compiled(main) {
  const key = crypto.createHash('sha1').update(main).digest('hex');
  if (!scriptCache.has(key)) scriptCache.set(key, new vm.Script(main, { filename: 'wts-main.js' }));
  return scriptCache.get(key);
}

// ─────────────────────────────────────────────────────────────────────────
// Storage (shareable between sessions)
// ─────────────────────────────────────────────────────────────────────────
function createStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  const api = {
    getItem(k) { k = String(k); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(String(k), String(v)); },
    removeItem(k) { data.delete(String(k)); },
    clear() { data.clear(); },
    key(i) { return Array.from(data.keys())[i] ?? null; },
  };
  return new Proxy(api, {
    get(t, p) {
      if (p === 'length') return data.size;
      if (p === '__data') return data;
      if (p === '__snapshot') return () => Object.fromEntries(data);
      if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(api, p)) return api[p];
      if (typeof p === 'string' && data.has(p)) return data.get(p);
      return undefined;
    },
    set(t, p, v) { data.set(String(p), String(v)); return true; },
    deleteProperty(t, p) { data.delete(String(p)); return true; },
    has(t, p) { return p in api || data.has(String(p)); },
    ownKeys() { return Array.from(data.keys()); },
    getOwnPropertyDescriptor(t, p) { return data.has(String(p)) ? { value: data.get(String(p)), enumerable: true, configurable: true, writable: true } : undefined; },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Timers
// ─────────────────────────────────────────────────────────────────────────
function makeManualTimers(app) {
  let now = 0, seq = 0, nextId = 1;
  const q = new Map();
  const add = (kind, fn, ms, args, interval) => {
    const id = nextId++;
    const stack = String(new Error().stack).split('\n').slice(1).filter((s) => s.indexOf('wts-main.js') !== -1).slice(0, 3).map((s) => s.trim()).join(' | ');
    q.set(id, { id, kind, fn, args, due: now + Math.max(0, +ms || 0), delay: Math.max(0, +ms || 0), interval, seq: seq++, stack });
    return id;
  };
  const run = (t) => {
    try {
      if (typeof t.fn === 'function') t.fn.apply(app.win, t.args || []);
      else if (typeof t.fn === 'string') app._compile(t.fn)();
    } catch (e) { app._reportError(e, t.kind + ' callback'); }
  };
  function next(limit) {
    let best = null;
    for (const t of q.values()) if (t.due <= limit && (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq))) best = t;
    return best;
  }
  function flush(ms) {
    const target = now + Math.max(0, +ms || 0);
    let n = 0;
    for (;;) {
      const t = next(target);
      if (!t) break;
      if (++n > 200000) throw new Error('[harness] flush: runaway timers (>200000 callbacks) — last scheduled at: ' + t.stack);
      now = Math.max(now, t.due);
      if (t.interval != null) { t.due = now + Math.max(1, t.interval); t.seq = seq++; } else q.delete(t.id);
      run(t);
    }
    now = target;
    return n;
  }
  async function flushAsync(ms) {
    const target = now + Math.max(0, +ms || 0);
    let n = 0;
    await new Promise((r) => setImmediate(r));
    for (;;) {
      const t = next(target);
      if (!t) break;
      if (++n > 200000) throw new Error('[harness] flushAsync: runaway timers');
      now = Math.max(now, t.due);
      if (t.interval != null) { t.due = now + Math.max(1, t.interval); t.seq = seq++; } else q.delete(t.id);
      run(t);
      await new Promise((r) => setImmediate(r));
    }
    now = target;
    return n;
  }
  function flushUntilIdle(maxMs) {
    const stop = now + (maxMs == null ? 60000 : maxMs);
    let n = 0;
    while (q.size) {
      let soonest = Infinity;
      for (const t of q.values()) soonest = Math.min(soonest, t.due);
      if (soonest > stop) break;
      n += flush(soonest - now);
    }
    return n;
  }
  return {
    now: () => now,
    api: {
      setTimeout: (fn, ms, ...a) => add('setTimeout', fn, ms, a, null),
      setInterval: (fn, ms, ...a) => add('setInterval', fn, ms, a, Math.max(0, +ms || 0)),
      clearTimeout: (id) => { q.delete(id); },
      clearInterval: (id) => { q.delete(id); },
      requestAnimationFrame: (fn) => add('requestAnimationFrame', () => fn(now), 16, [], null),
      cancelAnimationFrame: (id) => { q.delete(id); },
      requestIdleCallback: (fn) => add('requestIdleCallback', () => fn({ didTimeout: false, timeRemaining: () => 50 }), 1, [], null),
      cancelIdleCallback: (id) => { q.delete(id); },
    },
    flush, flushAsync, flushUntilIdle,
    pending: () => q.size,
    list: () => Array.from(q.values()).map((t) => ({ id: t.id, kind: t.kind, delay: t.delay, interval: t.interval, dueIn: t.due - now, fn: (t.fn && t.fn.name) || '(anonymous)', stack: t.stack })),
  };
}

function makeRealTimers(app) {
  const live = new Map();
  let nextId = 1;
  const t0 = Date.now();
  const wrap = (kind, fn, args, once) => function () {
    try { fn.apply(app.win, args); } catch (e) { app._reportError(e, kind + ' callback'); }
    if (once) live.delete(this.__hid);
  };
  const add = (kind, fn, ms, args, interval) => {
    const id = nextId++;
    if (typeof fn === 'string') { const code = fn; fn = () => app._compile(code)(); }
    const stack = String(new Error().stack).split('\n').slice(1).filter((s) => s.indexOf('wts-main.js') !== -1).slice(0, 3).map((s) => s.trim()).join(' | ');
    const cb = () => { try { fn.apply(app.win, args); } catch (e) { app._reportError(e, kind + ' callback'); } if (!interval) live.delete(id); };
    const h = interval ? setInterval(cb, ms) : setTimeout(cb, ms);
    live.set(id, { id, kind, h, interval: !!interval, delay: ms, stack, fn: (fn && fn.name) || '(anonymous)' });
    return id;
  };
  const clear = (id) => { const t = live.get(id); if (t) { (t.interval ? clearInterval : clearTimeout)(t.h); live.delete(id); } };
  return {
    now: () => Date.now() - t0,
    api: {
      setTimeout: (fn, ms, ...a) => add('setTimeout', fn, ms, a, false),
      setInterval: (fn, ms, ...a) => add('setInterval', fn, ms, a, true),
      clearTimeout: clear, clearInterval: clear,
      requestAnimationFrame: (fn) => add('requestAnimationFrame', () => fn(Date.now() - t0), 16, [], false),
      cancelAnimationFrame: clear,
      requestIdleCallback: (fn) => add('requestIdleCallback', () => fn({ didTimeout: false, timeRemaining: () => 50 }), 1, [], false),
      cancelIdleCallback: clear,
    },
    flush: (ms) => new Promise((r) => setTimeout(r, Math.max(0, +ms || 0))),
    flushAsync: (ms) => new Promise((r) => setTimeout(r, Math.max(0, +ms || 0))),
    flushUntilIdle: () => { throw new Error('[harness] flushUntilIdle is only available with timers:"manual"'); },
    pending: () => live.size,
    list: () => Array.from(live.values()).map((t) => ({ id: t.id, kind: t.kind, delay: t.delay, interval: t.interval ? t.delay : null, fn: t.fn, stack: t.stack })),
    dispose: () => { for (const id of Array.from(live.keys())) clear(id); },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Blob / File / FileReader
// ─────────────────────────────────────────────────────────────────────────
function partText(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  if (p instanceof HBlob || (p && typeof p._text === 'string')) return p._text;
  if (p instanceof ArrayBuffer || (p && p.constructor && p.constructor.name === 'ArrayBuffer')) return Buffer.from(new Uint8Array(p)).toString('utf8');
  if (ArrayBuffer.isView(p) || (p && p.buffer && typeof p.byteLength === 'number')) return Buffer.from(p.buffer, p.byteOffset || 0, p.byteLength).toString('utf8');
  return String(p);
}
class HBlob {
  constructor(parts, opts) {
    this._text = (parts || []).map(partText).join('');
    this.type = (opts && opts.type) || '';
    this.size = Buffer.byteLength(this._text, 'utf8');
  }
  text() { return Promise.resolve(this._text); }
  arrayBuffer() { const b = Buffer.from(this._text, 'utf8'); return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  slice(a, b, type) { return new HBlob([this._text.slice(a, b)], { type: type || this.type }); }
  stream() { throw new Error('[harness] Blob.stream not supported'); }
}
class HFile extends HBlob {
  constructor(parts, name, opts) { super(parts, opts); this.name = String(name); this.lastModified = (opts && opts.lastModified) || 0; }
}

// ─────────────────────────────────────────────────────────────────────────
// loadApp
// ─────────────────────────────────────────────────────────────────────────
function loadApp(opts) {
  opts = Object.assign({ fromSources: true, timers: 'manual', domStore: true, recordCanvas: true }, opts || {});
  let consoleMode = opts.console || (process.env.PRISM_HARNESS_VERBOSE ? 'inherit' : 'capture');

  // 1. HTML + main script
  let html, build;
  if (opts.html) { html = opts.html; build = { mode: 'custom', fallbacks: [], skipped: [], warnings: [] }; }
  // sourceOverrides only make sense on an in-memory build, so they force sources mode
  // even under accept-test --html (tests that pin/remove files would otherwise be vacuous).
  else if (opts.fromSources || opts.sourceOverrides) { build = buildFromSources({ silent: opts.silentBuild, overrides: opts.sourceOverrides }); html = build.html; }
  else { html = fs.readFileSync(HTML_PATH, 'utf8'); build = { mode: 'html', fallbacks: [], skipped: [], warnings: [] }; }
  const main = withHook(extractMain(html));
  let script;
  try { script = compiled(main); }
  catch (e) {
    const m = /wts-main\.js:(\d+)/.exec(String(e.stack));
    const where = m ? fileAtLine(main, +m[1]) : 'unknown';
    throw new Error('[harness] main script does not compile: ' + e.message + ' — in ' + where);
  }

  // 2. App object + realm
  const app = {
    build, html, mainScript: main,
    logs: [], errors: [], downloads: [], dialogs: [], opened: [], clipboard: null,
    viewport: Object.assign({ width: 1280, height: 800 }, opts.viewport || {}),
  };
  const layout = Object.assign({ width: 900, height: 420 }, opts.layout || {});
  const timers = opts.timers === 'real' ? makeRealTimers(app) : makeManualTimers(app);
  const storage = opts.storage || createStorage();
  const sessionStorage = opts.sessionStorage || createStorage();
  const blobUrls = new Map();
  let blobSeq = 0;
  const rootVars = {};
  (html.match(/:root\s*\{([^}]*)\}/) || [null, ''])[1].split(';').forEach((d) => {
    const i = d.indexOf(':'); if (i === -1) return;
    const k = d.slice(0, i).trim(); if (k.startsWith('--')) rootVars[k] = d.slice(i + 1).trim();
  });

  const env = {
    win: null,
    layout, viewport: app.viewport,
    recordCanvas: opts.recordCanvas !== false,
    canvasLogLimit: opts.canvasLogLimit || 200000,
    Blob: HBlob,
    compileHandler: (code) => app._compile(code, true),
    reportError: (e, where) => app._reportError(e, where),
    onDownload: (rec) => {
      const b = blobUrls.get(rec.href);
      let content = b ? b._text : null;
      if (content == null && /^data:/.test(rec.href)) {
        const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(rec.href);
        if (m) content = m[2] ? Buffer.from(m[3], 'base64').toString('utf8') : decodeURIComponent(m[3]);
      }
      app.downloads.push({ filename: rec.filename, href: rec.href, content, type: b ? b.type : null });
    },
  };
  const dom = D.createDOM(env);
  const doc = dom.document;

  const out = (level, args) => {
    const text = args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error || (a && a.stack && a.message)) return a.stack || a.message;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
    app.logs.push({ level, text, t: timers.now() });
    if (consoleMode === 'inherit' || (consoleMode === 'errors' && level === 'error')) {
      (console[level] || console.log)('[app:' + level + ']', text);
    }
  };
  const appConsole = {};
  for (const lv of ['log', 'info', 'warn', 'error', 'debug', 'trace']) appConsole[lv] = (...a) => out(lv === 'trace' ? 'debug' : lv, a);
  Object.assign(appConsole, {
    table: (...a) => out('log', a), dir: (...a) => out('log', a), group() {}, groupCollapsed() {}, groupEnd() {},
    time() {}, timeEnd() {}, timeLog() {}, count() {}, countReset() {}, clear() {},
    assert: (c, ...a) => { if (!c) out('error', ['Assertion failed:'].concat(a)); },
  });

  const mediaLists = [];
  const evalMedia = (q) => {
    let ok = true;
    const w = app.viewport.width, h = app.viewport.height;
    String(q).replace(/\(\s*(min|max)-(width|height)\s*:\s*([\d.]+)px\s*\)/g, (_, mm, dim, v) => {
      const cur = dim === 'width' ? w : h;
      if (mm === 'min' && !(cur >= +v)) ok = false;
      if (mm === 'max' && !(cur <= +v)) ok = false;
    });
    if (/orientation\s*:\s*portrait/.test(q) && !(h >= w)) ok = false;
    if (/orientation\s*:\s*landscape/.test(q) && !(w > h)) ok = false;
    if (/prefers-color-scheme\s*:\s*light/.test(q)) ok = false;
    if (/prefers-reduced-motion\s*:\s*reduce/.test(q)) ok = false;
    if (/\(\s*hover\s*:\s*none\s*\)|pointer\s*:\s*coarse/.test(q)) ok = ok && w < 768;
    if (/^\s*print\b/.test(q)) ok = false;
    return ok;
  };

  const sandbox = {
    document: doc,
    console: appConsole,
    navigator: {
      userAgent: 'Mozilla/5.0 (PRiSM harness; Node) AppleWebKit/537.36 (KHTML, like Gecko)',
      language: 'en-GB', languages: ['en-GB', 'en'], platform: 'Win32', vendor: '', onLine: true,
      cookieEnabled: true, maxTouchPoints: 0, hardwareConcurrency: 4,
      clipboard: {
        writeText: (t) => { app.clipboard = String(t); return Promise.resolve(); },
        readText: () => Promise.resolve(app.clipboard || ''),
        write: (items) => { app.clipboard = items; return Promise.resolve(); },
      },
      sendBeacon: () => true,
    },
    location: {
      href: 'http://localhost:8080/well-testing-app.html', origin: 'http://localhost:8080', protocol: 'http:',
      host: 'localhost:8080', hostname: 'localhost', port: '8080', pathname: '/well-testing-app.html',
      search: '', hash: '', reload() {}, assign() {}, replace() {}, toString() { return this.href; },
    },
    history: { length: 1, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
    screen: { width: app.viewport.width, height: app.viewport.height, availWidth: app.viewport.width, availHeight: app.viewport.height, colorDepth: 24 },
    devicePixelRatio: opts.devicePixelRatio || 1,
    localStorage: storage,
    sessionStorage,
    Event: D.Event, CustomEvent: D.CustomEvent, UIEvent: D.UIEvent, MouseEvent: D.MouseEvent,
    PointerEvent: D.PointerEvent, WheelEvent: D.WheelEvent, KeyboardEvent: D.KeyboardEvent,
    FocusEvent: D.FocusEvent, InputEvent: D.InputEvent, TouchEvent: D.TouchEvent, ErrorEvent: D.ErrorEvent,
    ProgressEvent: D.ProgressEvent, StorageEvent: D.StorageEvent, DragEvent: D.DragEvent,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.Element, SVGElement: dom.Element,
    HTMLCanvasElement: dom.Element, HTMLInputElement: dom.Element, HTMLSelectElement: dom.Element,
    HTMLTextAreaElement: dom.Element, HTMLButtonElement: dom.Element, HTMLAnchorElement: dom.Element,
    HTMLImageElement: dom.Element, HTMLDivElement: dom.Element, HTMLFormElement: dom.Element,
    HTMLTableElement: dom.Element, Text: dom.Text, Comment: dom.Comment, DocumentFragment: dom.DocumentFragment,
    Document: dom.Document,
    Blob: HBlob, File: HFile,
    URL: Object.assign(function HURL(u, b) { return new URL(u, b); }, {
      createObjectURL: (b) => { const u = 'blob:http://localhost:8080/harness-' + (++blobSeq); blobUrls.set(u, b); return u; },
      revokeObjectURL: () => {},
    }),
    URLSearchParams,
    TextEncoder, TextDecoder,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    crypto: { getRandomValues: (a) => crypto.randomFillSync(a), randomUUID: () => crypto.randomUUID(), subtle: crypto.webcrypto && crypto.webcrypto.subtle },
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    fetch: () => Promise.reject(new Error('[harness] fetch is not available')),
    XMLHttpRequest: function XMLHttpRequest() {
      return { open() {}, setRequestHeader() {}, abort() {}, send() { const x = this; sandbox.setTimeout(() => { if (x.onerror) x.onerror(new D.Event('error')); }, 0); }, readyState: 0, status: 0 };
    },
    FileReader: function FileReader() {
      const fr = { result: null, error: null, readyState: 0, onload: null, onerror: null, onloadend: null,
        addEventListener(t, f) { this['on' + t] = f; }, removeEventListener() {}, abort() {} };
      const finish = (result) => sandbox.setTimeout(() => {
        fr.result = result; fr.readyState = 2;
        const ev = { target: fr, currentTarget: fr, type: 'load' };
        if (fr.onload) fr.onload(ev);
        if (fr.onloadend) fr.onloadend(ev);
      }, 0);
      fr.readAsText = (b) => finish(partText(b));
      fr.readAsDataURL = (b) => finish('data:' + ((b && b.type) || 'application/octet-stream') + ';base64,' + Buffer.from(partText(b), 'utf8').toString('base64'));
      fr.readAsArrayBuffer = (b) => { const buf = Buffer.from(partText(b), 'utf8'); finish(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); };
      fr.readAsBinaryString = (b) => finish(partText(b));
      return fr;
    },
    Image: function Image(w, h) {
      const img = doc.createElement('img');
      if (w) img.width = w; if (h) img.height = h;
      let src = '';
      Object.defineProperty(img, 'src', { get: () => src, set: (v) => { src = String(v); sandbox.setTimeout(() => { if (typeof img.onload === 'function') img.onload({ target: img }); }, 0); }, configurable: true });
      img.complete = true; img.naturalWidth = w || 1; img.naturalHeight = h || 1;
      img.decode = () => Promise.resolve();
      return img;
    },
    Path2D: function Path2D() { return { moveTo() {}, lineTo() {}, arc() {}, rect() {}, closePath() {}, bezierCurveTo() {}, quadraticCurveTo() {}, ellipse() {}, addPath() {} }; },
    ImageData: function ImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }; },
    ClipboardItem: function ClipboardItem(items) { return { items, types: Object.keys(items || {}) }; },
    ResizeObserver: function ResizeObserver() { return { observe() {}, unobserve() {}, disconnect() {} }; },
    MutationObserver: function MutationObserver() { return { observe() {}, disconnect() {}, takeRecords: () => [] }; },
    IntersectionObserver: function IntersectionObserver() { return { observe() {}, unobserve() {}, disconnect() {}, takeRecords: () => [] }; },
    getComputedStyle: (el) => {
      const s = {};
      if (el && el.style) for (const k of Object.keys(el.style)) s[k] = el.style[k];
      if (el && el._hidden && el._hidden()) s.display = 'none';
      else if (!s.display) s.display = el && /^(span|a|b|i|em|strong|code|label|small|sup|sub|input|button|select|canvas|img|svg)$/i.test(el.localName || '') ? 'inline' : 'block';
      s.getPropertyValue = (n) => {
        if (String(n).startsWith('--')) { const v = el && el.style && el.style[n]; return v != null ? v : (rootVars[n] || ''); }
        const k = String(n).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return s[k] == null ? '' : String(s[k]);
      };
      return s;
    },
    matchMedia: (q) => {
      const ml = { media: String(q), matches: evalMedia(q), onchange: null, _l: [],
        addListener(f) { this._l.push(f); }, removeListener(f) { this._l = this._l.filter((x) => x !== f); },
        addEventListener(t, f) { if (t === 'change') this._l.push(f); }, removeEventListener(t, f) { this._l = this._l.filter((x) => x !== f); },
        dispatchEvent() { return true; } };
      mediaLists.push(ml);
      return ml;
    },
    getSelection: () => ({ removeAllRanges() {}, addRange() {}, toString: () => '', rangeCount: 0 }),
    alert: (m) => { app.dialogs.push({ type: 'alert', message: String(m) }); },
    confirm: (m) => { app.dialogs.push({ type: 'confirm', message: String(m) }); return opts.confirm === undefined ? true : opts.confirm; },
    prompt: (m, d) => { app.dialogs.push({ type: 'prompt', message: String(m), def: d }); return opts.prompt === undefined ? null : opts.prompt; },
    print: () => { app.dialogs.push({ type: 'print' }); },
    open: (url, name, feats) => {
      const written = [];
      const w = { closed: false, document: { write: (s) => written.push(String(s)), writeln: (s) => written.push(String(s) + '\n'), open() {}, close() {}, title: '' },
        focus() {}, print() {}, close() { this.closed = true; }, addEventListener() {}, removeEventListener() {} };
      w.document.body = doc.createElement('body');
      app.opened.push({ url, name, feats, written, win: w, html: () => written.join('') });
      return w;
    },
    scrollTo() {}, scrollBy() {}, scroll() {}, focus() {}, blur() {}, stop() {}, moveTo() {}, resizeTo() {},
    postMessage() {},
    innerWidth: app.viewport.width, innerHeight: app.viewport.height,
    outerWidth: app.viewport.width, outerHeight: app.viewport.height,
    scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
    name: '', status: '', closed: false, isSecureContext: true, origin: 'http://localhost:8080',
    dataLayer: [],
    Buffer: undefined,
  };
  Object.assign(sandbox, timers.api);
  sandbox.gtag = function () { sandbox.dataLayer.push(Array.from(arguments)); };

  const ctx = vm.createContext(sandbox, { name: 'prism-app' });
  const g = vm.runInContext('globalThis', ctx);
  env.win = g;
  sandbox.window = g; sandbox.self = g; sandbox.top = g; sandbox.parent = g; sandbox.frames = g;
  sandbox.addEventListener = (t, f, o) => D.addEventListener.call(g, t, f, o);
  sandbox.removeEventListener = (t, f, o) => D.removeEventListener.call(g, t, f, o);
  sandbox.dispatchEvent = (ev) => dom.dispatch(g, ev);
  dom.setTimer((fn, ms) => sandbox.setTimeout(fn, ms));
  const AppFunction = vm.runInContext('Function', ctx);
  app._compile = (code, asHandler) => {
    const f = asHandler ? new AppFunction('event', String(code)) : new AppFunction(String(code));
    return f;
  };
  app._reportError = (e, where) => {
    app.errors.push({ where, error: e, message: (e && e.message) || String(e), stack: e && e.stack });
    out('error', ['[uncaught in ' + where + ']', e]);
  };

  // Virtual clock for Date / performance (manual timers only).
  if (opts.timers !== 'real') {
    const base = opts.startTime != null ? +opts.startTime : Date.UTC(2026, 8, 29, 9, 0, 0);
    vm.runInContext(
      '(function (getNow) {\n' +
      '  var RD = Date;\n' +
      '  function HD(a, b, c, d, e, f, g) {\n' +
      '    if (!(this instanceof HD)) return new RD(getNow()).toString();\n' +
      '    var n = arguments.length;\n' +
      '    if (n === 0) return new RD(getNow());\n' +
      '    if (n === 1) return new RD(a);\n' +
      '    return new RD(a, b, c === undefined ? 1 : c, d || 0, e || 0, f || 0, g || 0);\n' +
      '  }\n' +
      '  HD.prototype = RD.prototype;\n' +
      '  HD.now = function () { return getNow(); };\n' +
      '  HD.UTC = RD.UTC; HD.parse = RD.parse;\n' +
      '  globalThis.Date = HD;\n' +
      '})', ctx)(() => base + timers.now());
    sandbox.performance = { now: () => timers.now(), timeOrigin: base, mark() {}, measure() {}, getEntriesByName: () => [], getEntriesByType: () => [] };
  } else {
    sandbox.performance = { now: () => timers.now(), timeOrigin: Date.now(), mark() {}, measure() {}, getEntriesByName: () => [], getEntriesByType: () => [] };
  }

  // 3. Static document (head + body markup up to the main script)
  const headM = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  if (headM) dom.parseInto(doc.head, headM[1]);
  const titleEl = doc.head.querySelector('title');
  if (titleEl) doc.title = titleEl.textContent;
  const bodyStart = html.search(/<body[^>]*>/i);
  const mainStart = html.search(MAIN_RE);
  if (bodyStart !== -1) {
    const open = /<body[^>]*>/i.exec(html.slice(bodyStart))[0];
    dom.parseInto(doc.body, html.slice(bodyStart + open.length, mainStart > bodyStart ? mainStart : undefined));
  }

  // 4. Run the main script like a browser: loading → DOMContentLoaded → load
  doc.readyState = 'loading';
  try { script.runInContext(ctx, { filename: 'wts-main.js' }); }
  catch (e) {
    const m = /wts-main\.js:(\d+)/.exec(String(e.stack));
    const where = m ? fileAtLine(main, +m[1]) : 'unknown';
    const err = new Error('[harness] app threw while loading: ' + (e && e.message) + '\n    in ' + where +
      '\n    ' + String(e && e.stack).split('\n').slice(0, 4).join('\n    '));
    err.cause = e; err.app = app;
    throw err;
  }
  doc.readyState = 'interactive';
  dom.dispatch(doc, new D.Event('DOMContentLoaded', { bubbles: true }));
  doc.readyState = 'complete';
  dom.dispatch(doc, new D.Event('readystatechange'));
  dom.dispatch(g, new D.Event('load'));

  // 5. Public API
  const resolve = (x) => {
    if (x == null) return null;
    if (typeof x === 'string') { const e = doc.getElementById(x); if (!e) throw new Error('[harness] no element with id "' + x + '"'); return e; }
    return x;
  };
  const errorsSince = (n) => app.errors.slice(n);
  const guard = (fn, o) => {
    const n = app.errors.length;
    const r = fn();
    const errs = errorsSince(n);
    if (errs.length && !(o && o.allowErrors)) {
      throw new Error('[harness] handler threw: ' + errs.map((x) => x.where + ': ' + (x.stack || x.message)).join('\n'));
    }
    return r;
  };
  Object.assign(app, {
    win: g,
    window: g,
    document: doc,
    storage,
    sessionStorage,
    timersMode: opts.timers === 'real' ? 'real' : 'manual',
    get hook() { return g.__WTS_TEST__; },
    now: () => timers.now(),
    flush: (ms) => timers.flush(ms),
    flushAsync: (ms) => timers.flushAsync(ms),
    flushUntilIdle: (maxMs) => timers.flushUntilIdle(maxMs),
    pendingTimers: () => timers.pending(),
    timers: () => timers.list().map((t) => Object.assign(t, { where: String(t.stack || '').replace(/wts-main\.js:(\d+)(:\d+)?/g, (m, ln) => fileAtLine(main, +ln)) })),
    dispose: () => { if (timers.dispose) timers.dispose(); },
    el: (id) => doc.getElementById(id),
    $: (id) => doc.getElementById(id),
    find: (sel) => doc.querySelector(sel),
    findAll: (sel) => Array.from(doc.querySelectorAll(sel)),
    click: (x, o) => guard(() => { const e = resolve(x); e.click(); return e; }, o),
    input: (x, v, o) => guard(() => {
      const e = resolve(x); e.value = v;
      dom.dispatch(e, new D.InputEvent('input', { bubbles: true }));
      if (!o || o.change !== false) dom.dispatch(e, new D.Event('change', { bubbles: true }));
      return e;
    }, o),
    change: (x, v, o) => guard(() => { const e = resolve(x); if (v !== undefined) e.value = v; dom.dispatch(e, new D.Event('change', { bubbles: true })); return e; }, o),
    select: (x, v, o) => guard(() => {
      const e = resolve(x); e.value = v;
      dom.dispatch(e, new D.Event('input', { bubbles: true }));
      dom.dispatch(e, new D.Event('change', { bubbles: true }));
      return e;
    }, o),
    check: (x, on, o) => guard(() => { const e = resolve(x); if (!!e.checked !== !!on) e.click(); return e; }, o),
    key: (x, key, type, o) => guard(() => { const e = resolve(x); dom.dispatch(e, new D.KeyboardEvent(type || 'keydown', { key, bubbles: true, cancelable: true })); return e; }, o),
    fire: (target, type, detail, o) => guard(() => {
      const t = target === 'window' ? g : target === 'document' ? doc : resolve(target);
      return dom.dispatch(t, new D.CustomEvent(type, { detail, bubbles: true }));
    }, o),
    seedSample: () => {
      try { storage.removeItem('wts_prism_sample_suppress'); } catch (_) { /* ignore */ }
      if (typeof g.PRiSM_seedDefaultSample === 'function') {
        const cur = g.PRiSM_dataset;
        if (!(cur && cur.t && cur.t.length)) g.PRiSM_seedDefaultSample('prism_data_paste');
      }
      return g.PRiSM_dataset || null;
    },
    openPRiSM: (o) => guard(() => { g.__WTS_TEST__.nav('prism'); return doc.getElementById('pgBody'); }, o),
    renderPRiSM: (host, o) => guard(() => { const h = host ? resolve(host) : doc.getElementById('pgBody'); g.__WTS_TEST__.renderPRiSM(h); return h; }, o),
    renderTab: (n, o) => guard(() => { g.__WTS_TEST__.renderTab(n); return doc.getElementById('prism_tab_' + n); }, o),
    gotoTab: (n, o) => guard(() => {
      if (g.PRiSM && typeof g.PRiSM.setTab === 'function') g.PRiSM.setTab(n);
      else g.__WTS_TEST__.renderTab(n);
      return doc.getElementById('prism_tab_' + n);
    }, o),
    canvases: (root) => { const r = root ? resolve(root) : doc; return Array.from(r.querySelectorAll('canvas')); },
    canvasLog: (c, op) => {
      const cv = resolve(c);
      const log = (cv && cv._log) || [];
      return op ? log.filter((e) => e.op === op).map((e) => e.args) : log;
    },
    canvasTexts: (c) => {
      const cv = resolve(c);
      return ((cv && cv._log) || []).filter((e) => e.op === 'fillText' || e.op === 'strokeText').map((e) => String(e.args[0]));
    },
    consoleErrors: () => app.logs.filter((l) => l.level === 'error'),
    resize: (w, h) => {
      app.viewport.width = w; if (h != null) app.viewport.height = h;
      sandbox.innerWidth = w; sandbox.outerWidth = w;
      if (h != null) { sandbox.innerHeight = h; sandbox.outerHeight = h; }
      for (const ml of mediaLists) {
        const m = evalMedia(ml.media);
        if (m !== ml.matches) {
          ml.matches = m;
          const ev = { matches: m, media: ml.media };
          ml._l.slice().forEach((f) => { try { f.call(ml, ev); } catch (e) { app._reportError(e, 'matchMedia change'); } });
          if (typeof ml.onchange === 'function') ml.onchange(ev);
        }
      }
      dom.dispatch(g, new D.Event('resize'));
    },
    toWin: (v) => vm.runInContext('(function (s) { return JSON.parse(s); })', ctx)(JSON.stringify(v)),
    evalInApp: (code) => vm.runInContext(String(code), ctx),
    reload: (extra) => loadApp(Object.assign({}, opts, { storage, html: opts.html }, extra || {})),
  });

  if (opts.seed) app.seedSample();
  return app;
}

module.exports = {
  loadApp, createStorage, buildFromSources, extractMain, fileAtLine, gitShowHead,
  REPO, BUILD_DIR, HTML_PATH, PIPELINE,
  _resetBuildCache: () => { _buildCache = null; },
};
