// Accounts WP-C1 — the iOS exclusion (docs/ACCOUNTS-PLAN.md §9, §12.2 acct-ios). The REAL ios-app/scripts/sync-from-main.js
// runs on the built page with Round 10 rebuilt in memory from prism-build/ (the WP-C1 files 66–68), writing into a scratch
// WTS_SYNC_OUT_DIR; the guard is checked in the full app on the harness.
//
//   IO1  the bundle carries no account code: no ACCT block, no identifier (WTS_account, WTS_cloudSync, WTS_accountPage, /api/v1,
//        wts_account_host, wtsacct_, wts_sync_bar, acct_root, acct_dlg, wts-sync, wtspref_cloud, /auth/oauth, wts_oa), no dialog
//        CSS, the strip comments present, RELEASE_NOTES[0].ver unchanged
//   IO2  in the built page every account identifier sits between ACCT markers (or inside the stripped GA block)
//   IO3  no "LinkedIn" in www/index.html, "Google" at most at its one pinned baseline; no provider assets
//   IO4  the sync fails (no index.html) on unbalanced markers and on a leaked WP-C1 identifier
//   IO5  www/help: an account shot folder or account words in user-guide.html fail the sync; a clean help folder passes
//   IO6  the guard in the full app: capacitor (also with WTS_ACCOUNT_DEV), file:, another host, http → eligible false (framed: AC4),
//        no chip, no request, even with the beta flag set
//   IO7  the iOS privacy page text is today's (no account wording reaches renderPrivacy in www)
//   IO8  ios-styles.css: the ACCOUNTS block gives every fixed account overlay its safe-area rule and names no account identifier
//   IO9  help-shots: every shot hides the account controls (display:none on #wts_account_host / #sbAccountLine / bar / dialog)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const T = require('./_acct-app');

const WP = 'ACI';
const BUILD = path.join(__dirname, '..');
const REPO = path.join(BUILD, '..');
const SYNC = path.join(REPO, 'ios-app', 'scripts', 'sync-from-main.js');
const IDS = ['WTS_account', 'WTS_cloudSync', 'WTS_accountPage', '/api/v1', 'wts_account_host', 'wtsacct_', 'wts_sync_bar', 'acct_root', 'acct_dlg',
  'wts-sync', 'wtspref_cloud', '/auth/oauth', 'wts_oa', 'acct_css', 'acct_provider_buttons'];

let PAGE = null;
function page() {
  if (PAGE) return PAGE;
  const R10 = require(path.join(BUILD, 'concat-round10.js'));
  const I10 = require(path.join(BUILD, 'inject-round10.js'));
  const out = R10.build({ log: { log() {}, warn() {} } });
  let html = I10.inject(fs.readFileSync(path.join(REPO, 'well-testing-app.html'), 'utf8'), out).out;
  // the host's H8 / H9 hooks (WP-H) in HTML form, so step 0d is exercised whether or not WP-H has landed
  if (!/<!--\s*ACCT:START\s*-->\s*<div id="wts_account_host">/.test(html)) {
    html = html.replace('<div id="wts_well_host"></div>', '<!-- ACCT:START --><div id="wts_account_host"></div><!-- ACCT:END -->\n            <div id="wts_well_host"></div>');
  }
  PAGE = html;
  return html;
}
function runSync(html, o) {
  o = o || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-ios-'));
  try {
    const src = path.join(tmp, 'main.html');
    fs.writeFileSync(src, html);
    const dir = path.join(tmp, 'www'); fs.mkdirSync(dir);
    let helpDir = path.join(tmp, 'no-help');
    if (o.help) { helpDir = path.join(tmp, 'help'); Object.keys(o.help).forEach((rel) => { const f = path.join(helpDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, o.help[rel]); }); }
    const r = cp.spawnSync(process.execPath, [SYNC], { encoding: 'utf8', timeout: 120000,
      env: Object.assign({}, process.env, { WTS_SYNC_MAIN_HTML: src, WTS_SYNC_OUT_DIR: dir, WTS_SYNC_HELP_DIR: helpDir }) });
    const f = path.join(dir, 'index.html');
    const helpOut = path.join(dir, 'help');
    return { status: r.status, log: r.stdout + r.stderr, html: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null,
      helpFiles: fs.existsSync(helpOut) ? walk(helpOut) : [] };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function walk(d, base) { base = base || d; let out = []; fs.readdirSync(d).forEach((n) => { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) out = out.concat(walk(p, base)); else out.push(path.relative(base, p)); }); return out.sort(); }
let OK = null;
function okRun() { if (!OK) OK = runSync(page()); return OK; }
const firstVer = (h) => { const m = /RELEASE_NOTES\s*=\s*\[\s*\{[^}]*?ver\s*:\s*['"]([^'"]+)['"]/.exec(h); return m && m[1]; };
const stripAcct = (h) => h.replace(/\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g, '').replace(/<!--\s*ACCT:START[\s\S]*?ACCT:END\s*-->/g, '')
  .replace(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g, '');

module.exports = [
  {
    name: 'IO1 the iOS bundle carries no account code, identifier or dialog CSS; strip comments present; the version label unchanged', wp: WP, opts: false,
    run(app, assert) {
      const html = page();
      const own = IDS.filter((t) => !/^(\/auth\/oauth|wts_oa)$/.test(t));   // provider strings arrive with WP-O
      own.forEach((t) => assert(html.includes(t), 'the scratch page carries the WP-C1 client: ' + t));
      const r = okRun();
      assert.strictEqual(r.status, 0, 'sync passes: ' + r.log.slice(-600));
      IDS.forEach((t) => assert(!r.html.includes(t), 'www/index.html has no ' + t));
      assert(!/ACCT:START|ACCT:END/.test(r.html));
      assert(r.html.includes('// (accounts and cloud sync: web only — stripped from the iOS bundle)'), 'step 0c comment');
      assert(r.html.includes('<!-- account control: web only -->'), 'step 0d comment');
      assert(!/Didn't get the code|Sign in to Well Testing Suite|Save to cloud|Open from cloud/.test(r.html), 'no account UI text');
      assert.strictEqual(firstVer(r.html), firstVer(html), 'RELEASE_NOTES[0].ver is the same on iOS');
      assert(firstVer(html), 'version found');
    },
  },
  {
    name: 'IO2 in the built page every account identifier sits between ACCT markers (or inside the stripped GA block)', wp: WP, opts: false,
    run(app, assert) {
      const rest = stripAcct(page());
      IDS.forEach((t) => assert(!rest.includes(t), t + ' appears outside the ACCT markers'));
      const src = ['66-account.js', '67-cloud-sync.js', '68-account-page.js'].map((f) => fs.readFileSync(path.join(BUILD, f), 'utf8'));
      src.forEach((s, i) => {
        const end = s.indexOf('// ── ACCT:END ──'); const st = s.indexOf('// === SELF-TEST ===');
        assert(s.startsWith('// ── ACCT:START') && end > 0 && st > end, 'file ' + (66 + i) + ' is one ACCT block, then the self-test (stripped by concat)');
        IDS.forEach((t) => assert(!s.slice(end, st).includes(t), 'file ' + (66 + i) + ': ' + t + ' between ACCT:END and the self-test'));
      });
    },
  },
  {
    name: 'IO3 no "LinkedIn" in www/index.html, "Google" at most at its pinned baseline; no provider asset', wp: WP, opts: false,
    run(app, assert) {
      const r = okRun();
      assert.strictEqual(r.status, 0);
      assert(!/LinkedIn/.test(r.html), 'no LinkedIn');
      assert((r.html.match(/Google/g) || []).length <= 1, 'Google at most once (the analytics sentence)');
      assert(!/Sign in with|Continue with/.test(r.html));
      assert(page().includes('via LinkedIn'), 'the web page names the providers inside the ACCT block (naming exception)');
    },
  },
  {
    name: 'IO4 the sync fails without writing index.html on unbalanced markers or a leaked WP-C1 identifier', wp: WP, opts: false,
    run(app, assert) {
      const bad1 = runSync(page() + '\n// ── ACCT:START dangling');
      assert.notStrictEqual(bad1.status, 0); assert.strictEqual(bad1.html, null); assert(/unbalanced/.test(bad1.log));
      for (const leak of ['wts_sync_bar', 'WTS_accountPage', 'acct_root', 'wtspref_cloud_beta']) {
        const bad = runSync(page().replace('</body>', '<script>var x = "' + leak + '";</script></body>'));
        assert.notStrictEqual(bad.status, 0, leak + ' leaked: the sync fails');
        assert.strictEqual(bad.html, null);
        assert(bad.log.includes(leak.replace(/_beta$/, '')), leak + ' named in the error');
      }
    },
  },
  {
    name: 'IO5 www/help: an account shot folder or account words in user-guide.html fail; a clean help folder passes', wp: WP, opts: false,
    run(app, assert) {
      const clean = runSync(page(), { help: { 'img/start/home-d.webp': 'webp', 'user-guide.html': '<html><body>Guide</body></html>' } });
      assert.strictEqual(clean.status, 0, clean.log.slice(-400));
      assert.deepStrictEqual(clean.helpFiles, ['img/start/home-d.webp', 'user-guide.html']);
      const shot = runSync(page(), { help: { 'img/account/chip-d.webp': 'webp' } });
      assert.notStrictEqual(shot.status, 0); assert(/account shot folder/.test(shot.log));
      for (const word of ['Sign in', 'Google', 'LinkedIn', 'wts_account_host']) {
        const g = runSync(page(), { help: { 'user-guide.html': '<p>' + word + '</p>' } });
        assert.notStrictEqual(g.status, 0, word + ' in the guide fails');
        assert(/user-guide\.html contains account material/.test(g.log));
      }
    },
  },
  {
    name: 'IO6 the guard in the full app: capacitor (also DEV), file:, another host, http → inert, no chip, no request', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const cases = [
        ['capacitor native', { protocol: 'capacitor:', hostname: 'localhost', host: 'localhost' }, { Capacitor: { isNativePlatform: () => true } }],
        ['capacitor with WTS_ACCOUNT_DEV', { protocol: 'https:', hostname: 'localhost', host: 'localhost' }, { Capacitor: { isNativePlatform: () => true }, WTS_ACCOUNT_DEV: 1 }],
        ['production host in the native shell', null, { Capacitor: { isNativePlatform: () => true } }],
        ['file:', { protocol: 'file:', hostname: '', host: '' }, { WTS_ACCOUNT_DEV: 1 }],
        ['another https host', { protocol: 'https:', hostname: 'preview.example', host: 'preview.example' }, {}],
        ['production host over http', { protocol: 'http:', hostname: 'welltest.h2oil.co.uk', host: 'welltest.h2oil.co.uk' }, {}],
      ];
      for (const [what, loc, g] of cases) {
        const L = Object.assign(T.F.prodLocation(), loc || {});
        L.origin = L.protocol + '//' + L.host; L.href = L.origin + L.pathname;
        let fetches = 0;
        const a = ctx.loadApp({ timers: 'manual', console: 'capture', storage: T.createStorage({ wtspref_cloud_beta: '1', wtsacct_hint: JSON.stringify({ signedIn: true, v: 3 }) }),
          globals: Object.assign({ location: L, fetch: () => { fetches++; return Promise.reject(new Error('no')); } }, g) });
        try {
          a.flush(5000);
          assert.deepStrictEqual(T.J(Object.keys(a.win.WTS_account || {})), ['eligible'], what + ': only the inert stub');
          assert.strictEqual(a.win.WTS_account.eligible, false, what);
          assert.strictEqual(a.win.WTS_cloudSync, undefined, what);
          assert.strictEqual(a.win.WTS_accountPage, undefined, what);
          assert(!a.el('acct_chip') && !a.el('wts_sync_bar') && !a.el('acct_css'), what + ': no account DOM');
          assert.strictEqual(fetches, 0, what + ': no request');
          assert(!(a.win.WTS_calcRegistry && a.win.WTS_calcRegistry.account), what + ': no account page');
        } finally { a.dispose(); }
      }
      // a framed page is checked in acct-contract AC4 (a bare context controls window.top; the harness window is its own top)
    },
  },
  {
    name: 'IO7 the iOS privacy page text is today\'s: no account wording reaches renderPrivacy in www', wp: WP, opts: false,
    run(app, assert) {
      const r = okRun();
      const m = /function renderPrivacy\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(r.html);
      assert(m, 'renderPrivacy found in www');
      const body = m[1];
      assert(!/Sign in|sign-in method|cloud project|LinkedIn|Google sign|account page|wtsacct_/i.test(body), 'no account wording in the iOS privacy page');
    },
  },
  {
    name: 'IO8 ios-styles.css ACCOUNTS block: safe-area rules for every fixed account overlay, no account identifier', wp: WP, opts: false,
    run(app, assert) {
      const css = fs.readFileSync(path.join(REPO, 'ios-app', 'ios-additions', 'ios-styles.css'), 'utf8');
      const i = css.indexOf('ACCOUNTS'); assert(i > 0, 'ACCOUNTS block');
      const block = css.slice(i, css.indexOf('end of section 11'));
      for (const sel of ['html.ios-app .acct-ov', 'html.ios-app .acct-sync-bar', 'html.ios-app .acct-menu', 'html.ios-app .acct-toast']) {
        const j = block.indexOf(sel); assert(j > 0, sel);
        assert(/env\(safe-area-inset-/.test(block.slice(j, block.indexOf('}', j))), sel + ' uses the safe-area insets');
      }
      assert(/html\.ios-app \.acct-ov \{\s*display: block;/.test(block), 'the dialog overlay is block layout (its bottom padding scrolls)');
      IDS.forEach((t) => assert(!block.includes(t), 'ios-styles names no account identifier: ' + t));
      // the classes are the ones the client really uses
      const c66 = fs.readFileSync(path.join(BUILD, '66-account.js'), 'utf8');
      ['acct-ov', 'acct-sync-bar', 'acct-menu', 'acct-cloud-menu', 'acct-toast'].forEach((k) => assert(c66.includes("'" + k) || c66.includes(k + ' ') || c66.includes(k + "'"), k + ' used by 66'));
    },
  },
  {
    name: 'IO9 help-shots: every shot hides the account controls', wp: WP, opts: false,
    run(app, assert) {
      const src = fs.readFileSync(path.join(BUILD, 'help-shots.js'), 'utf8');
      const m = /'#wts_account_host,#sbAccountLine,([^']*)\{display:none!important\}'/.exec(src);
      assert(m, 'decorate() injects a display:none rule for the account hosts');
      assert(/\.acct-sync-bar/.test(m[1]) && /\.acct-ov/.test(m[1]), 'and the bar and the dialog');
    },
  },
];
