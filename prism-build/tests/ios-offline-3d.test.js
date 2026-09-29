// P1 — offline 3D on iOS: three.js r170 bundled into the iOS www/ folder.
//
//   • ios-additions/libs/three.module.min.js is the exact file whose SHA-384 32-wts-3d.js pins.
//   • sync-from-main.js (run into a scratch folder via WTS_SYNC_OUT_DIR) copies it next to
//     index.html and the PDF libraries, and the generated index.html sets
//     window.WTS3D_LOCAL_URL = 'three.module.min.js' through ios-bridge.js.
//   • Loaded from that index.html, the app reports hasLocalCopy() = true, fetches the local
//     file before any CDN, and still enforces the SHA-384 (tampered bytes are never imported).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const WP = 'P1';
const ROOT = path.resolve(__dirname, '..', '..');
const IOS = path.join(ROOT, 'ios-app');
const LIB = path.join(IOS, 'ios-additions', 'libs', 'three.module.min.js');
const sha384 = (buf) => crypto.createHash('sha384').update(buf).digest('base64');
const pinned = () => /WTS_3d\.THREE_SHA384\s*=\s*'([A-Za-z0-9+/=]+)'/.exec(
  fs.readFileSync(path.join(__dirname, '..', '32-wts-3d.js'), 'utf8'))[1];

let _sync = null;
function runSync() {
  if (_sync) return _sync;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-sync-'));
  process.on('exit', () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
  const log = execFileSync(process.execPath, [path.join(IOS, 'scripts', 'sync-from-main.js')],
    { env: Object.assign({}, process.env, { WTS_SYNC_OUT_DIR: out }), encoding: 'utf8' });
  _sync = { out, log, html: fs.readFileSync(path.join(out, 'index.html'), 'utf8') };
  return _sync;
}

// Replace the harness fetch: serve the bundled bytes (optionally tampered) for the local URL,
// fail every other URL; record the order of requested URLs.
function serveLocal(app, tamper) {
  const W = app.win;
  const bytes = fs.readFileSync(LIB);
  if (tamper) bytes[bytes.length - 2] ^= 0x20;
  const seen = [];
  let objUrls = 0;
  const ocu = W.URL.createObjectURL;
  W.URL.createObjectURL = function (b) { objUrls++; return ocu.call(this, b); };
  W.fetch = function (u) {
    seen.push(String(u));
    if (String(u) === 'three.module.min.js') {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(ab) });
    }
    return Promise.reject(new Error('offline'));
  };
  return { seen, objUrls: () => objUrls };
}

// WebCrypto digests resolve off the main thread: give real time as well as virtual time.
async function settle(app) {
  await new Promise((r) => setTimeout(r, 5));
  await app.flushAsync(250);
}

module.exports = [
  {
    name: 'bundled three.module.min.js is three@0.170.0 and matches the SHA-384 pinned in 32-wts-3d.js',
    wp: WP,
    opts: false,
    run(app, assert) {
      assert.ok(fs.existsSync(LIB), 'ios-additions/libs/three.module.min.js present');
      const buf = fs.readFileSync(LIB);
      assert.equal(buf.length, 691648, 'size of three@0.170.0/build/three.module.min.js');
      assert.equal(sha384(buf), pinned(), 'SHA-384 = WTS_3d.THREE_SHA384');
      assert.includes(buf.slice(0, 200).toString('utf8'), 'const t="170"', 'r170 header');
      const cap = JSON.parse(fs.readFileSync(path.join(IOS, 'capacitor.config.json'), 'utf8'));
      assert.equal(cap.webDir, 'www', 'www/ is the Capacitor web root (capacitor://localhost/)');
    },
  },
  {
    name: 'sync-from-main.js copies the lib next to index.html and injects the WTS3D_LOCAL_URL override',
    wp: WP,
    opts: false,
    timeoutMs: 60000,
    run(app, assert) {
      const s = runSync();
      for (const f of ['index.html', 'capacitor.js', 'jspdf.umd.min.js', 'html2canvas.min.js', 'three.module.min.js']) {
        assert.ok(fs.existsSync(path.join(s.out, f)), 'www/' + f);
      }
      assert.equal(sha384(fs.readFileSync(path.join(s.out, 'three.module.min.js'))), pinned(), 'copied bytes unchanged');
      assert.includes(s.log, 'SHA-384 matches the pinned hash');
      assert.includes(s.html, "window.WTS3D_LOCAL_URL = 'three.module.min.js';");
      const iBridge = s.html.indexOf('// ── iOS Native Bridge ──');
      const iOverride = s.html.indexOf("window.WTS3D_LOCAL_URL = 'three.module.min.js'");
      assert.ok(iBridge > 0 && iOverride > iBridge, 'override comes from the injected ios-bridge.js');
      assert.ok(s.html.indexOf('googletagmanager') === -1, 'analytics stripped');
      // The committed www/ is in sync with the generator.
      const committed = path.join(IOS, 'www', 'three.module.min.js');
      assert.ok(fs.existsSync(committed), 'ios-app/www/three.module.min.js committed');
      assert.equal(sha384(fs.readFileSync(committed)), pinned());
    },
  },
  {
    name: 'iOS index.html: hasLocalCopy() true; loadThree fetches the local file first and verifies its hash',
    wp: WP,
    timeoutMs: 60000,
    opts: { html: (() => { try { return runSync().html; } catch (e) { return undefined; } })() },
    async run(app, assert) {
      const W = app.win;
      assert.equal(W.WTS3D_LOCAL_URL, 'three.module.min.js', 'override set by the bridge');
      assert.ok(W.WTS_3d && typeof W.WTS_3d.loadThree === 'function', 'WTS_3d loaded');
      let local = null;
      W.WTS_3d.hasLocalCopy().then((v) => { local = v; });
      await app.flushAsync(0);
      assert.equal(local, true, 'hasLocalCopy → offline launch mounts 3D instead of 2D');
      // Good bytes: local URL first, hash accepted → handed to the importer (a vm cannot
      // import modules, so the load then ends as "offline" — the browser path is exercised on device).
      const good = serveLocal(app, false);
      let err = null;
      W.WTS_3d.loadThree().then(null, (e) => { err = e; });
      for (let i = 0; i < 80 && !err; i++) await settle(app);
      assert.equal(good.seen[0], 'three.module.min.js', 'local file requested before the CDN: ' + good.seen.join(', '));
      assert.ok(good.objUrls() >= 1, 'verified bytes passed to the module importer');
      assert.ok(err && err.code !== 'integrity', 'genuine file never reported as an integrity failure');
    },
  },
  {
    name: 'iOS index.html: a tampered local three.js is rejected by the SHA-384 check (never imported)',
    wp: WP,
    timeoutMs: 60000,
    opts: { html: (() => { try { return runSync().html; } catch (e) { return undefined; } })() },
    async run(app, assert) {
      const W = app.win;
      const bad = serveLocal(app, true);
      let err = null;
      W.WTS_3d.loadThree().then(null, (e) => { err = e; });
      for (let i = 0; i < 80 && !err; i++) await settle(app);
      assert.equal(bad.seen[0], 'three.module.min.js');
      assert.equal(bad.objUrls(), 0, 'tampered bytes never imported');
      assert.ok(err, 'load failed');
      assert.equal(err.code, 'integrity', 'integrity failure reported');
    },
  },
];
