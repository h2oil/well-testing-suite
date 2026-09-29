// iOS app (Capacitor 8 / WKWebView on capacitor://localhost): 3D view loader + phone layout.
//
//   3D  • WTS_3d.loaderPolicy(): inside the native shell the bundled three.js is imported directly by
//         its absolute URL (no blob: import, no IndexedDB copy); the pinned SHA-384 is checked first when
//         WebCrypto exists, skipped only for that LOCAL file when it does not; CDN bytes are never
//         imported unverified. Outside the shell (web) the policy is the unchanged blob route.
//       • loadThree() under a simulated capacitor:// origin follows that table (fetch / import URLs are
//         recorded by replacing fetch and the realm's Function, which the loader uses for import()).
//       • 38-wts-live: WebGL context losses around an app background/foreground cycle (the bridge's
//         app-backgrounded / app-foregrounded events) do not count towards the 2-strike 2D fallback;
//         without those events (web) two losses in a minute still fall back to 2D.
//   Layout (generated ios-app/www/index.html, sync run into a scratch folder)
//       • iOS rules scoped to html.ios-app; every text control ≥ 16 px there (no focus auto-zoom);
//         grids / tables / tab strips cannot widen the page; viewport allows zoom; the class is set
//         only under Capacitor; the web HTML carries none of it.
// Expected values are the policy stated in the task/spec (independent of the code under test) and
// CSS facts (WebKit auto-zooms a focused control whose computed font-size is < 16 px).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WP = 'IOS';
const ROOT = path.resolve(__dirname, '..', '..');
const IOS = path.join(ROOT, 'ios-app');
const LIB = path.join(IOS, 'ios-additions', 'libs', 'three.module.min.js');
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

let _sync = null;
function runSync() {
  if (_sync) return _sync;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-sync-ios-'));
  process.on('exit', () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
  execFileSync(process.execPath, [path.join(IOS, 'scripts', 'sync-from-main.js')],
    { env: Object.assign({}, process.env, { WTS_SYNC_OUT_DIR: out }), encoding: 'utf8' });
  _sync = { out, html: fs.readFileSync(path.join(out, 'index.html'), 'utf8') };
  return _sync;
}

// Make the app believe it runs inside the native shell on capacitor://localhost, serve the bundled
// three.js (optionally tampered) for the local URL, record fetches and import() calls.
function nativeShell(app, o) {
  o = o || {};
  const W = app.win;
  W.location.protocol = 'capacitor:'; W.location.href = 'capacitor://localhost/index.html';
  W.location.origin = 'capacitor://localhost'; W.location.host = W.location.hostname = 'localhost'; W.location.port = '';
  W.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} };
  W.WTS3D_LOCAL_URL = 'three.module.min.js';
  if (o.noSubtle) W.crypto = { getRandomValues: W.crypto.getRandomValues };
  const bytes = fs.readFileSync(LIB);
  if (o.tamper) bytes[bytes.length - 2] ^= 0x20;
  const rec = { fetched: [], imported: [], blobs: 0 };
  const ocu = W.URL.createObjectURL;
  W.URL.createObjectURL = function (b) { rec.blobs++; return ocu.call(this, b); };
  W.fetch = function (u) {
    rec.fetched.push(String(u));
    if (String(u) === 'capacitor://localhost/three.module.min.js') {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(ab) });
    }
    return Promise.reject(new Error('offline'));
  };
  // The loader builds its importer with `new Function('u', 'return import(u)')` on first use.
  W.Function = function () { return function (u) { rec.imported.push(String(u)); return Promise.reject(new Error('no module loader in the test realm')); }; };
  return rec;
}
async function settle(app) { await new Promise((r) => setTimeout(r, 5)); await app.flushAsync(250); }
async function load(app) {
  let err = null, done = false;
  app.win.WTS_3d.loadThree().then(() => { done = true; }, (e) => { err = e; done = true; });
  for (let i = 0; i < 120 && !done; i++) await settle(app);
  return err;
}

// Replace WTS_3d's WebGL parts with a fake so the live view mounts "3D" in the harness, and let the
// test raise fatal context-lost errors through the onError callback 38-wts-live passes to mount().
function fake3d(app) {
  const W = app.win, rec = { mounts: 0, opts: null };
  const noop = () => {};
  const handle = () => ({ dispose: noop, focus: noop, frame: noop, legend: noop, refreshUnits: noop, resize: noop, select: noop,
    setAutoOrbit: noop, setInsets: noop, setInteraction: noop, setLabels: noop, setOverlay: noop, setPaused: noop,
    setQuality: noop, setReducedMotion: noop, view: noop, stats: {} });
  W.WTS_3d = Object.assign({}, W.WTS_3d, {
    isSupported: () => true, loadThree: () => Promise.resolve({}), hasLocalCopy: () => Promise.resolve(true),
    mount: (el, o) => { rec.mounts++; rec.opts = o; return Promise.resolve(handle()); },
  });
  return rec;
}
function openWts(app) {
  const b = app.find('.nav-btn[data-p="wts"]');
  if (!b) throw new Error('no Well Test Simulator sidebar button');
  app.click(b);
}
function vizState(app) {
  const v = app.document.getElementById('wts_viz');
  const n = v && v.querySelector('.wtsl-notice');
  return { mode: v && v.getAttribute('data-mode'), notice: n ? String(n.textContent || '') : '' };
}
const lost = () => Object.assign(new Error('context-lost'), { code: 'context-lost' });

// CSS helpers for the generated page: the iOS additions block and its rules.
function iosCssBlock(html) {
  const i = html.indexOf('/* ── iOS additions ── */');
  const j = html.indexOf('</style>', i);
  return i > 0 && j > i ? html.slice(i, j) : '';
}
function topLevelSplit(sel) {           // split a selector list on commas outside (...) / [...]
  const out = []; let depth = 0, cur = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++; else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}
function rules(css) {
  const out = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // flatten one level of @media
  const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(flat))) out.push({ sel: m[1].replace(/@media[^{]*$/, '').replace(/^[\s\S]*@media[^{]*\{/, '').trim(), body: m[2] });
  return out;
}

module.exports = [
  // ── 3D loader decision table ──────────────────────────────────────────
  {
    name: 'IOS loaderPolicy: native shell imports the bundled file by URL; hash verified when WebCrypto exists, local-only skip without; web unchanged',
    wp: WP,
    run(app, assert) {
      const P = (env) => JSON.parse(JSON.stringify(app.win.WTS_3d.loaderPolicy(app.toWin ? app.toWin(env) : env)));
      const base = { localUrl: 'capacitor://localhost/three.module.min.js', pinned: true, canFetch: true, canBlob: true };
      let p = P(Object.assign({ native: true, subtle: true }, base));
      assert.deepStrictEqual(p, { route: 'native-direct', idbCache: false,
        local: { url: base.localUrl, importBy: 'url', hash: 'verify' }, cdn: 'blob-verified' }, 'native + WebCrypto');
      p = P(Object.assign({ native: true, subtle: false }, base));
      assert.equal(p.local.hash, 'skip', 'no WebCrypto: the signed local bundle is imported unverified');
      assert.equal(p.local.importBy, 'url');
      assert.equal(p.cdn, 'none', 'no WebCrypto: CDN bytes are never imported unverified');
      p = P(Object.assign({ native: true, subtle: true }, base, { canFetch: false }));
      assert.equal(p.local.hash, 'skip', 'fetch unavailable → cannot hash the local file');
      p = P(Object.assign({ native: false, subtle: true }, base, { localUrl: null }));
      assert.equal(p.route, 'web'); assert.equal(p.idbCache, true); assert.equal(p.cdn, 'blob-verified'); assert.equal(p.local, null);
      p = P(Object.assign({ native: false, subtle: true }, base));
      assert.deepStrictEqual(p.local, { url: base.localUrl, importBy: 'blob', hash: 'verify' }, 'web preview of www/: blob route kept');
      p = P(Object.assign({ native: false, subtle: true }, base, { canBlob: false }));
      assert.equal(p.cdn, 'url'); assert.equal(p.local.importBy, 'url'); assert.equal(p.local.hash, 'none');
      p = P(Object.assign({ native: true, subtle: true }, base, { localUrl: null }));
      assert.equal(p.route, 'web', 'native shell without a bundled copy falls back to the web route');
      // live environment of the harness = a browser page → web route
      assert.equal(app.win.WTS_3d.loaderPolicy().route, 'web');
    },
  },
  {
    name: 'IOS loadThree (capacitor://): verifies the local file, then import()s it by absolute URL — no blob, no IndexedDB',
    wp: WP,
    timeoutMs: 60000,
    async run(app, assert) {
      const rec = nativeShell(app);
      assert.equal(app.win.WTS_3d.loaderPolicy().route, 'native-direct', 'policy under capacitor://');
      const err = await load(app);
      assert.equal(rec.fetched[0], 'capacitor://localhost/three.module.min.js', 'the local file is read first (hash check): ' + rec.fetched.join(', '));
      assert.equal(rec.imported[0], 'capacitor://localhost/three.module.min.js', 'import() of the capacitor:// URL');
      assert.ok(rec.imported.every((u) => !/^blob:|jsdelivr|unpkg/.test(u)), 'nothing but the local URL imported: ' + rec.imported.join(', '));
      // the direct import failed here (no module loader in the test realm), so the verified-CDN fallback
      // may try the CDN — offline, so nothing is turned into a blob or imported
      assert.ok(rec.fetched.slice(1).every((u) => /jsdelivr|unpkg/.test(u)), 'only CDN fallbacks after the local file');
      assert.equal(rec.blobs, 0, 'no blob: URL minted');
      assert.ok(err && err.code === 'offline', 'the test realm cannot evaluate modules → load reported as offline, never integrity');
      const info = JSON.parse(JSON.stringify(app.win.WTS_3d.loadInfo()));
      assert.equal(info.hash, 'verified', 'SHA-384 of the bundled file matched');
      assert.equal(info.route, 'native-failed');
    },
  },
  {
    name: 'IOS loadThree (capacitor://): a tampered bundled three.js is rejected before import()',
    wp: WP,
    timeoutMs: 60000,
    async run(app, assert) {
      const rec = nativeShell(app, { tamper: true });
      const err = await load(app);
      assert.equal(rec.imported.length, 0, 'never imported: ' + rec.imported.join(', '));
      assert.equal(rec.blobs, 0);
      assert.ok(err, 'load failed'); assert.equal(err.code, 'integrity');
      assert.equal(app.win.WTS_3d.loadInfo().hash, 'mismatch');
    },
  },
  {
    name: 'IOS loadThree (capacitor://, no WebCrypto): local file imported without a hash; CDN never contacted',
    wp: WP,
    timeoutMs: 60000,
    async run(app, assert) {
      const rec = nativeShell(app, { noSubtle: true });
      const pol = JSON.parse(JSON.stringify(app.win.WTS_3d.loaderPolicy()));
      assert.equal(pol.local.hash, 'skip'); assert.equal(pol.cdn, 'none');
      const err = await load(app);
      assert.equal(rec.fetched.length, 0, 'nothing fetched (no hash possible, no CDN): ' + rec.fetched.join(', '));
      assert.deepStrictEqual(rec.imported, ['capacitor://localhost/three.module.min.js']);
      assert.ok(!rec.imported.some((u) => /jsdelivr|unpkg/.test(u)), 'no unverified CDN import');
      assert.ok(err && err.code === 'offline');
      assert.equal(app.win.WTS_3d.loadInfo().hash, 'skip');
    },
  },
  {
    name: 'IOS loadThree (web page): unchanged — local file first, then CDN, bytes go through a blob: URL',
    wp: WP,
    timeoutMs: 60000,
    async run(app, assert) {
      const W = app.win;
      W.WTS3D_LOCAL_URL = 'three.module.min.js';
      const seen = []; let blobs = 0;
      const ocu = W.URL.createObjectURL; W.URL.createObjectURL = function (b) { blobs++; return ocu.call(this, b); };
      const bytes = fs.readFileSync(LIB);
      W.fetch = (u) => { seen.push(String(u));
        if (String(u) === 'three.module.min.js') { const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(ab) }); }
        return Promise.reject(new Error('offline')); };
      await load(app);
      assert.equal(seen[0], 'three.module.min.js', 'relative local URL fetched first (web code path)');
      assert.ok(seen.indexOf(CDN) > 0, 'CDN tried after the local copy');
      assert.ok(blobs >= 1, 'blob import route');
      assert.equal(W.WTS_3d.loadInfo(), null, 'native loader not used');
    },
  },
  // ── 38-wts-live: app lifecycle vs the 2-strike fallback ─────────────────
  {
    name: 'IOS live view: context losses across app background/foreground do not force 2D; remount happens on foreground',
    wp: WP,
    timeoutMs: 60000,
    async run(app, assert) {
      const rec = fake3d(app);
      openWts(app); await app.flushAsync(500);
      assert.equal(rec.mounts, 1, '3D mounted');
      assert.equal(vizState(app).mode, '3d');
      for (let k = 1; k <= 3; k++) {
        app.document.dispatchEvent(new app.win.Event('app-backgrounded'));
        rec.opts.onError(lost(), true);
        await app.flushAsync(500);
        assert.equal(rec.mounts, k, 'no remount while backgrounded (loss ' + k + ')');
        app.document.dispatchEvent(new app.win.Event('app-foregrounded'));
        await app.flushAsync(500);
        assert.equal(rec.mounts, k + 1, 'remounted after foreground (loss ' + k + ')');
        assert.equal(vizState(app).mode, '3d', 'still 3D after loss ' + k);
      }
      assert.ok(!/repeated graphics errors/.test(vizState(app).notice), 'no permanent fallback');
    },
  },
  {
    name: 'IOS live view (web, no app events): two context losses within a minute still fall back to 2D',
    wp: WP,
    timeoutMs: 60000,
    async run(app, assert) {
      const rec = fake3d(app);
      openWts(app); await app.flushAsync(500);
      rec.opts.onError(lost(), true); await app.flushAsync(500);
      assert.equal(rec.mounts, 2, 'first loss → remount');
      rec.opts.onError(lost(), true); await app.flushAsync(500);
      const s = vizState(app);
      assert.equal(s.mode, '2d', 'second loss → 2D');
      assert.includes(s.notice, 'repeated graphics errors');
    },
  },
  // ── generated www/ ────────────────────────────────────────────────────
  {
    name: 'IOS www: bridge + head script + bundled lib; class and native handling gated on Capacitor; web HTML untouched',
    wp: WP,
    opts: false,
    timeoutMs: 60000,
    run(app, assert) {
      const s = runSync();
      const html = s.html;
      assert.ok(fs.existsSync(path.join(s.out, 'three.module.min.js')), 'three.module.min.js copied next to index.html');
      // viewport: zoom allowed (accessibility), cover for safe areas
      const vp = /<meta name="viewport" content="([^"]+)"/.exec(html)[1];
      assert.includes(vp, 'width=device-width'); assert.includes(vp, 'initial-scale=1'); assert.includes(vp, 'viewport-fit=cover');
      assert.ok(!/maximum-scale/.test(vp) && !/user-scalable\s*=\s*no/.test(vp), 'no zoom lock: ' + vp);
      // head script: runs before the main script and gates the class on the native shell
      const head = html.slice(0, html.indexOf('</head>'));
      assert.includes(head, "location.protocol === 'capacitor:'");
      assert.includes(head, "C.isNativePlatform()");
      assert.includes(head, "document.documentElement.classList.add('ios-app')");
      assert.includes(head, "window.WTS3D_LOCAL_URL = window.WTS3D_LOCAL_URL || 'three.module.min.js'");
      assert.ok(/<script src="capacitor\.js"><\/script>\s*<script>\s*\/\* ═+\s*WELL TESTING SUITE/.test(html), 'capacitor.js loads right before the main script');
      assert.equal((html.match(/<script src="capacitor\.js">/g) || []).length, 1, 'capacitor.js injected once');
      const iBridge = html.indexOf('// ── iOS Native Bridge ──');
      assert.ok(iBridge > 0, 'bridge injected');
      const bridge = html.slice(iBridge);
      const iNativeGate = bridge.indexOf('if (!isNative)');
      assert.ok(iNativeGate > 0 && bridge.indexOf("classList.add('ios-app')") > iNativeGate, 'bridge adds ios-app only after the native check');
      assert.includes(bridge, "state.isActive ? 'app-foregrounded' : 'app-backgrounded'");
      assert.includes(bridge, "visualViewport.addEventListener('resize', revealFocused)");
      assert.ok(!/addEventListener\('gesturestart'/.test(bridge), 'pinch-zoom no longer cancelled');
      assert.ok(!/setInterval\(/.test(bridge), 'no polling in the bridge');
      // web version carries none of the iOS scope
      const web = fs.readFileSync(path.join(ROOT, 'well-testing-app.html'), 'utf8');
      assert.ok(web.indexOf('html.ios-app') < 0 && web.indexOf("classList.add('ios-app')") < 0 && web.indexOf('/* ── iOS additions ── */') < 0 &&
                web.indexOf('// ── iOS Native Bridge ──') < 0, 'web HTML has no iOS additions');
      assert.ok(/<meta name="viewport" content="width=device-width, initial-scale=1.0">/.test(web), 'web viewport unchanged');
    },
  },
  {
    name: 'IOS www CSS: under html.ios-app every text control is >= 16 px and grids/tables/tabs cannot widen the page',
    wp: WP,
    opts: false,
    timeoutMs: 60000,
    run(app, assert) {
      const html = runSync().html;
      const css = iosCssBlock(html);
      assert.ok(css.length > 500, 'iOS CSS block present');
      const R = rules(css);
      const scoped = R.filter((r) => /html\.ios-app/.test(r.sel));
      assert.ok(scoped.length >= 8, 'scoped rules: ' + scoped.length);
      // every selector in a scoped rule is scoped (nothing leaks to the web layout of a www/ preview)
      scoped.forEach((r) => topLevelSplit(r.sel).forEach((s) => assert.ok(/^html\.ios-app\b/.test(s.trim()), 'scoped selector: ' + s.trim())));
      // 16 px rule covers input (text-like types), select and textarea with !important
      const fsRule = scoped.find((r) => /font-size\s*:\s*16px\s*!important/.test(r.body));
      assert.ok(fsRule, '16px !important rule');
      ['html.ios-app select', 'html.ios-app textarea', 'html.ios-app input:not([type=checkbox])'].forEach((k) => assert.ok(fsRule.sel.replace(/\s+/g, ' ').includes(k), 'covers ' + k));
      assert.ok(!/:not\(\[type=(text|number|search|email|tel|password|url|date)\]\)/.test(fsRule.sel), 'no text-entry type excluded');
      // no iOS-scoped rule sets a control font-size below 16 px
      scoped.forEach((r) => { const m = /font-size\s*:\s*(\d+(?:\.\d+)?)px/.exec(r.body);
        if (m && /(input|select|textarea)/.test(r.sel)) assert.ok(+m[1] >= 16, 'control font-size >= 16px in ' + r.sel); });
      // nothing else in the page can beat the scoped !important rule with a smaller size:
      // no other `!important` font-size under 16 px on a control selector, no inline !important on a control
      const allCss = (html.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n');
      rules(allCss).forEach((r) => { const m = /font-size\s*:\s*(\d+(?:\.\d+)?)px\s*!important/.exec(r.body);
        if (m && /(^|[\s,>+~(])(input|select|textarea)\b/.test(r.sel) && !/html\.ios-app/.test(r.sel)) assert.ok(+m[1] >= 16, '!important small control font: ' + r.sel); });
      assert.ok(!/<(input|select|textarea)\b[^>]*style="[^"]*font-size\s*:\s*(\d|1[0-5])(\.\d+)?px\s*!important/i.test(html), 'no inline !important small font on a control');
      // overflow guards
      const has = (selPart, decl) => scoped.some((r) => r.sel.replace(/\s+/g, ' ').includes(selPart) && new RegExp(decl).test(r.body));
      assert.ok(has('html.ios-app .cols-2 > *', 'min-width\\s*:\\s*0'), 'grid children may shrink (1fr = minmax(auto,1fr) overflow)');
      assert.ok(has('html.ios-app .fg > *', 'min-width\\s*:\\s*0'));
      assert.ok(has('html.ios-app .fg-item input', 'max-width\\s*:\\s*100%'), 'inputs never wider than their cell');
      assert.ok(has('html.ios-app #pgBody select', 'contain\\s*:\\s*paint'), 'long selected option text stays inside the select');
      assert.ok(has('html.ios-app #pgBody table', 'overflow-x\\s*:\\s*auto'), 'tables scroll inside their own box');
      assert.ok(has('html.ios-app .tabs', 'overflow-x\\s*:\\s*auto'), 'tab strips scroll inside their own box');
      assert.ok(has('html.ios-app #pgBody .rbox', 'overflow-x\\s*:\\s*auto'), 'result boxes contain wide result tables');
      assert.ok(has('html.ios-app', 'touch-action\\s*:\\s*manipulation'), 'no double-tap zoom');
    },
  },
];
