// Accounts WP-H — third-party code (docs/ACCOUNTS-PLAN.md §5.4 H16 / H17, §9 layer 1, §12.2 acct-thirdparty).
//
//   TP1  static, on the page built from sources: every external script / module / worker load goes through a pinned
//        loader (a remote library URL only in a file that checks a SHA-384 constant; script elements get blob: URLs;
//        no <script src="http…">, no import('http…'), no new Worker('http…')) — the analytics tag inside GA:START/END is
//        the one exception
//   TP2  the spreadsheet loader (07, H16) in the app: a mismatching download is never run (no script element), a matching
//        one runs from a blob: URL only; the pinned constants equal the published file (881,727 bytes)
//   TP3  the analytics guard (H17, the head GA block run in a bare context): no hint → tag loaded; signed in or a provider
//        sign-in under 10 minutes old → skipped; an older attempt or unreadable storage → loaded; __wtsGaLoaded says which.
//        The iOS strip leaves exactly one "Google" (the pinned analytics sentence of the privacy text)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const WP = 'WP-H';
const BUILD = path.resolve(__dirname, '..');
const ROOT = path.resolve(BUILD, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');

const REMOTE_JS = /['"`](https?:\/\/[^'"`\s]+?\.(?:m?js|wasm))(?:\?[^'"`]*)?['"`]/g;

function gaBlocks(html) { return html.match(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g) || []; }

module.exports = [
  {
    name: 'TP1 every external script load in the built page goes through a pinned loader (analytics excepted)', wp: WP, opts: false,
    run(app, assert, ctx) {
      const built = ctx.harness.buildFromSources({ silent: true }).html;
      const noGa = built.replace(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g, '');
      // 1. no static external script tags outside the GA blocks
      assert.deepStrictEqual(noGa.match(/<script[^>]*\bsrc\s*=\s*["']?https?:/gi) || [], [], 'static external <script src>');
      // 2. no script element is pointed at a remote literal; no remote import() / Worker / importScripts
      for (const re of [/\.src\s*=\s*['"`]https?:/g, /\bimport\s*\(\s*['"`]https?:/g, /new\s+Worker\s*\(\s*['"`]https?:/g, /importScripts\s*\(\s*['"`]https?:/g,
        /setAttribute\(\s*['"]src['"]\s*,\s*['"`]https?:/g]) {
        assert.deepStrictEqual(noGa.match(re) || [], [], 'remote load: ' + re);
      }
      // 3. every remote library URL sits in a source file that verifies a pinned SHA-384 before use
      const files = fs.readdirSync(BUILD).filter((f) => /^[0-9][0-9]-.*\.js$/.test(f));
      const seen = new Set();
      let m;
      while ((m = REMOTE_JS.exec(noGa))) seen.add(m[1]);
      assert.ok(seen.size >= 4, 'remote libraries found: ' + Array.from(seen).join(', '));
      for (const url of seen) {
        const owners = files.filter((f) => fs.readFileSync(path.join(BUILD, f), 'utf8').indexOf(url) !== -1);
        const hostOnly = owners.length === 0;
        const src = hostOnly ? noGa : owners.map((f) => fs.readFileSync(path.join(BUILD, f), 'utf8')).join('\n');
        assert.ok(!hostOnly, url + ' is referenced only by host code (no pinned loader)');
        assert.ok(/digest\(\s*['"]SHA-384['"]/.test(src), url + ': no SHA-384 check in ' + owners.join(', '));
        assert.ok(/['"][A-Za-z0-9+/]{64}['"]/.test(src), url + ': no pinned base64 SHA-384 constant in ' + owners.join(', '));
      }
      // 4. the analytics loader is the only remote script element, and only inside GA:START/END
      const ga = gaBlocks(built).join('\n');
      assert.ok(/s\.src = 'https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=/.test(ga), 'analytics tag loaded by the GA block');
      assert.strictEqual((built.match(/googletagmanager/g) || []).length, (ga.match(/googletagmanager/g) || []).length, 'analytics only inside GA blocks');
    },
  },
  {
    name: 'TP2 H16 SheetJS: a mismatching download is never run; a matching one runs only from a blob: URL; pinned constants', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const src07 = fs.readFileSync(path.join(BUILD, '07-data-enhancements.js'), 'utf8');
      const pin = /var XLSX_SHA384 = '([A-Za-z0-9+/]{64})';/.exec(src07);
      assert.ok(pin, 'pinned hash constant');
      assert.ok(/xlsx@0\.18\.5\/dist\/xlsx\.full\.min\.js/.test(src07) && /881727/.test(src07), 'pinned version and size');
      const fakeLib = 'window.XLSX = { version: "fake", read: function () { return { SheetNames: [], Sheets: {} }; } };';
      const fakeHash = crypto.createHash('sha384').update(fakeLib).digest('base64');
      const run = async (hash, body) => {
        const calls = [];
        const fetch = (url, init) => {
          calls.push({ url, init });
          const buf = Buffer.from(body);
          return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)) });
        };
        const ov = hash ? { '07-data-enhancements.js': src07.replace(pin[0], "var XLSX_SHA384 = '" + hash + "';") } : undefined;
        const a = ctx.loadApp(Object.assign({ globals: { fetch } }, ov ? { sourceOverrides: ov } : {}));
        const scripts = () => a.findAll('script').map((s) => String(s.src || s.getAttribute('src') || '')).filter(Boolean);
        const before = scripts().length;
        const p = a.win.PRiSM_loadXLSX();
        let res = null, err = null;
        let done = false;
        p.then((x) => { res = x; done = true; }, (e) => { err = e; done = true; });
        const settled = () => done || scripts().length > before;
        for (let i = 0; i < 200 && !settled(); i++) { await a.flushAsync(0); await new Promise((r) => setImmediate(r)); }
        const added = scripts().slice(before);
        return { a, calls, added, p, get res() { return res; }, get err() { return err; } };
      };
      // mismatch: both URLs tried, nothing run, the promise rejects, a later call may retry
      const bad = await run(null, 'window.XLSX = { evil: true };');
      try {
        assert.deepStrictEqual(bad.calls.map((c) => c.url), ['https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js']);
        assert.ok(bad.calls.every((c) => c.init && c.init.mode === 'cors' && c.init.credentials === 'omit'), 'CORS, no credentials');
        assert.deepStrictEqual(bad.added, [], 'no script element for unverified bytes');
        assert.ok(bad.err && /SHA-384 mismatch/.test(bad.err.message), 'rejects: ' + (bad.err && bad.err.message));
        assert.ok(!bad.a.win.XLSX, 'nothing ran');
      } finally { bad.a.dispose(); }
      // match: one fetch, a single blob: script element
      const good = await run(fakeHash, fakeLib);
      try {
        assert.strictEqual(good.calls.length, 1, 'first URL verified');
        assert.strictEqual(good.added.length, 1, 'one script element');
        assert.ok(/^blob:/.test(good.added[0]), 'runs from a blob: URL, not the CDN: ' + good.added[0]);
        // the harness does not execute script elements: run the verified text and fire onload like a browser would
        const el = good.a.findAll('script').find((s) => /^blob:/.test(String(s.src || '')));
        good.a.evalInApp(fakeLib);
        el.onload();
        for (let i = 0; i < 200 && !good.res; i++) { await good.a.flushAsync(0); await new Promise((r) => setImmediate(r)); }
        assert.ok(good.res && good.res.version === 'fake', 'resolved with window.XLSX');
      } finally { good.a.dispose(); }
    },
  },
  {
    name: 'TP2b H16 SheetJS on the native shell: the bundled copy first (same origin), checked when WebCrypto is there; without WebCrypto only the local copy', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const src07 = fs.readFileSync(path.join(BUILD, '07-data-enhancements.js'), 'utf8');
      const pin = /var XLSX_SHA384 = '([A-Za-z0-9+/]{64})';/.exec(src07);
      // the bundled iOS copy is the pinned file (sync-from-main.js copies it to www/)
      const bundled = fs.readFileSync(path.join(ROOT, 'ios-app', 'ios-additions', 'libs', 'xlsx.full.min.js'));
      assert.strictEqual(bundled.length, 881727, 'bundled size');
      assert.strictEqual(crypto.createHash('sha384').update(bundled).digest('base64'), pin[1], 'bundled copy = pinned SHA-384');
      const fakeLib = 'window.XLSX = { version: "native", read: function () { return { SheetNames: [], Sheets: {} }; } };';
      const fakeHash = crypto.createHash('sha384').update(fakeLib).digest('base64');
      const ov = { '07-data-enhancements.js': src07.replace(pin[0], "var XLSX_SHA384 = '" + fakeHash + "';") };
      const run = async (globals, respond) => {
        const calls = [];
        const fetch = (url, init) => {
          calls.push({ url, init });
          const r = respond(url);
          if (!r) return Promise.reject(new Error('offline'));
          const buf = Buffer.from(r);
          return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)) });
        };
        const a = ctx.loadApp({ globals: Object.assign({ fetch, Capacitor: { isNativePlatform: () => true, Plugins: {} } }, globals || {}), sourceOverrides: ov });
        const scripts = () => a.findAll('script').map((s) => String(s.src || s.getAttribute('src') || '')).filter(Boolean);
        const before = scripts().length;
        let err = null, done = false;
        a.win.PRiSM_loadXLSX().then(() => { done = true; }, (e) => { err = e; done = true; });
        for (let i = 0; i < 200 && !(done || scripts().length > before); i++) { await a.flushAsync(0); await new Promise((r) => setImmediate(r)); }
        return { a, calls, added: scripts().slice(before), get err() { return err; } };
      };
      // 1. WebCrypto present: one same-origin fetch of the bundled copy, verified, run from a blob: URL
      const srcs = await run(null, () => fakeLib);
      try {
        const list = srcs.a.win.PRiSM_loadXLSX.sources();
        assert.ok(list[0].local === true && /\/xlsx\.full\.min\.js$/.test(list[0].url) && srcs.a.win.PRiSM_loadXLSX.PINNED.urls.indexOf(list[0].url) === -1, 'local first: ' + list[0].url);
        assert.strictEqual(list.length, 3, 'local + two pinned remote');
        assert.strictEqual(srcs.calls.length, 1, 'only the bundled copy fetched');
        assert.strictEqual(srcs.calls[0].url, list[0].url);
        assert.ok(srcs.calls[0].init && srcs.calls[0].init.mode !== 'cors' && srcs.calls[0].init.credentials === 'same-origin', 'same-origin fetch');
        assert.ok(srcs.added.length === 1 && /^blob:/.test(srcs.added[0]), 'one blob: script');
      } finally { srcs.a.dispose(); }
      // 2. a damaged bundled copy is not run; the remote copies are tried next
      const dmg = await run(null, (u) => (/^https:/.test(u) ? fakeLib : 'window.XLSX = { evil: true };'));
      try {
        assert.strictEqual(dmg.calls.length, 2, 'local (mismatch) then the first remote');
        assert.ok(dmg.added.length === 1 && /^blob:/.test(dmg.added[0]), 'the verified remote bytes run');
      } finally { dmg.a.dispose(); }
      // 3. no WebCrypto: the bundled copy is accepted (unverified, as the historian and 3D loaders); a remote copy never
      const noWc = { crypto: { getRandomValues: (x) => crypto.randomFillSync(x) } };
      const nw = await run(noWc, () => 'window.XLSX = { version: "unverified-local" };');
      try {
        assert.strictEqual(nw.calls.length, 1, 'local only');
        assert.ok(nw.added.length === 1 && /^blob:/.test(nw.added[0]), 'local bytes run');
      } finally { nw.a.dispose(); }
      const off = await run(noWc, () => null);
      try {
        assert.strictEqual(off.calls.length, 1, 'remote copies skipped without WebCrypto');
        assert.deepStrictEqual(off.added, [], 'nothing run');
        assert.ok(off.err && /no WebCrypto/.test(off.err.message), 'rejects: ' + (off.err && off.err.message));
      } finally { off.a.dispose(); }
    },
  },
  {
    name: 'TP3 H17 analytics guard: no hint → loaded; signed in / fresh provider return → skipped; stale or unreadable → loaded; one pinned "Google" on iOS', wp: WP, opts: false,
    run(app, assert) {
      const html = fs.readFileSync(HTML, 'utf8');
      const block = gaBlocks(html)[0];
      const scripts = [];
      block.replace(/<script>([\s\S]*?)<\/script>/g, (m, s) => { scripts.push(s); return m; });
      assert.strictEqual(scripts.length, 2, 'filter script + loader script');
      const loader = scripts[1];
      assert.ok(!/<script[^>]*\bsrc=/.test(block), 'no static tag left');
      const now = Date.UTC(2026, 10, 8, 12, 0, 0);
      const runWith = (hint, opts) => {
        const appended = [];
        const sb = {
          Date: { now: () => now },
          JSON,
          document: { head: { appendChild: (s) => appended.push(s) }, documentElement: null, createElement: (t) => ({ tag: t }) },
          localStorage: (opts && opts.throws) ? { getItem() { throw new Error('blocked'); } } : { getItem: (k) => (k === 'wtsacct_hint' && hint != null ? JSON.stringify(hint) : null) },
        };
        sb.window = sb;
        vm.createContext(sb);
        vm.runInContext(loader, sb);
        return { loaded: sb.__wtsGaLoaded, appended };
      };
      let r = runWith(null);
      assert.strictEqual(r.loaded, true); assert.strictEqual(r.appended.length, 1);
      assert.ok(/^https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-/.test(r.appended[0].src) && r.appended[0].async === true, 'async tag');
      r = runWith({ signedIn: false, v: 3 });
      assert.strictEqual(r.loaded, true, 'signed-out hint → loaded');
      r = runWith({ signedIn: true, v: 3 });
      assert.strictEqual(r.loaded, false); assert.strictEqual(r.appended.length, 0, 'signed in → skipped');
      r = runWith({ signedIn: false, oauth: { provider: 'google', route: 'home', at: now - 9 * 60000 }, v: 3 });
      assert.strictEqual(r.loaded, false, 'provider return under 10 min → skipped');
      r = runWith({ signedIn: false, oauth: { provider: 'google', route: 'home', at: now - 11 * 60000 }, v: 3 });
      assert.strictEqual(r.loaded, true, 'older attempt → loaded');
      r = runWith(null, { throws: true });
      assert.strictEqual(r.loaded, true, 'storage blocked → loaded as before');
      // the iOS strip (GA, SW and ACCT steps of sync-from-main.js) leaves one "Google": the analytics sentence
      const ios = html.replace(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g, '')
        .replace(/\/\/ ── SW:START[\s\S]*?\/\/ ── SW:END ──/g, '')
        .replace(/\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g, '')
        .replace(/<!--\s*ACCT:START[\s\S]*?ACCT:END\s*-->/g, '');
      const g = ios.match(/[^'<>]{0,40}Google[^'<>]{0,60}/g) || [];
      assert.strictEqual(g.length, 1, 'one "Google" left: ' + JSON.stringify(g));
      assert.ok(/The web version uses Google Analytics 4 to count anonymous usage/.test(g[0]), 'the analytics sentence: ' + g[0]);
      assert.ok(ios.indexOf('LinkedIn') === -1, 'no "LinkedIn" on iOS');
    },
  },
];
