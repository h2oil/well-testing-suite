// Accounts WP-C1 — privacy behaviour of the account client (docs/ACCOUNTS-PLAN.md §8.4–8.6, §9 Help, §12.2 acct-privacy).
//
//   PV1  no account analytics events: a sign-in, a cloud save, an open and a sign-out send nothing to the analytics tag
//   PV2  nothing account-related is stored where it could travel: the hint holds no address or token, a project file carries
//        no wtsacct_ / wtspref_ / wts_acct_ / wts_sync_ key, and the device store never holds the session cookie
//   PV3  the privacy page: without a session and without the beta flag the web text is the v3.4 text (same as an inert
//        host); the web-only account cards (WP-H H11) exist only inside ACCT markers
//   PV4  the help centre (printed into the iOS guide) carries no account wording; the account help lives on the account page
//   PV5  the account page's own help covers cloud projects, two computers, public computers, the code-mail FAQ and data requests
'use strict';

const fs = require('fs');
const path = require('path');
const T = require('./_acct-app');

const WP = 'ACP';
const E1 = 'name@company.example';
const ACCOUNT_WORDS = /Sign in|sign-in method|cloud project|Save to cloud|LinkedIn|Google sign|wtsacct_|account page/;

module.exports = [
  {
    name: 'PV1 no account analytics events through sign-in, save, open and sign-out', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const calls = [];
      const t = T.boot(ctx, { seed: true, globals: { gtag: function () { calls.push(Array.prototype.slice.call(arguments)); }, dataLayer: [] } });
      try {
        await t.signIn(E1, { handover: 'upload' });
        await t.until(() => t.sync().status().state === 'idle', 'uploaded');
        await t.sync().openFromCloud(t.sync().status().projectId);
        await t.acct().signOut({ keep: true });
        await t.until(() => t.acct().state().status === 'signedOut');
        const acct = calls.filter((c) => /sign|account|cloud|login|auth|oauth|google|linkedin/i.test(JSON.stringify(c)));
        assert.deepStrictEqual(acct, [], 'no account event: ' + JSON.stringify(acct).slice(0, 300));
        assert(!JSON.stringify(t.w.dataLayer || []).match(/sign|account|cloud/i));
      } finally { t.dispose(); }
    },
  },
  {
    name: 'PV2 hint without address or token; project files carry no account key; the device store holds no session cookie', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true });
      try {
        await t.signIn(E1, { handover: 'upload' });
        await t.until(() => t.sync().status().state === 'idle', 'uploaded');
        const hint = t.storage.getItem('wtsacct_hint');
        assert(hint && !/@|company\.example|wts_sid|[A-Za-z0-9_-]{40,}/.test(hint), 'hint: ' + hint);
        const sid = t.br.cookie('__Host-wts_sid').value;
        const store = JSON.stringify(t.idb.keys('wts-sync', 'kv').map((k) => t.idb.get('wts-sync', 'kv', k)));
        assert(!store.includes(sid), 'no session id in IndexedDB');
        assert(!JSON.stringify(t.storage.__snapshot()).includes(sid), 'no session id in localStorage');
        const pl = t.w.WTS_project._buildPayload();
        const keys = Object.keys((pl.modules.storage && pl.modules.storage.keys) || {});
        assert.deepStrictEqual(keys.filter((k) => /^(wtsacct_|wtspref_|wts_acct_|wts_sync_)/.test(k)), [], 'no account key in a project file');
        assert(!JSON.stringify(pl).includes('wts-sync'));
        const files = await t.sync().projectFile(t.sync().status().projectId);
        assert(!/wtsacct_|wtspref_|__Host-wts_sid/.test(files.text), 'the cloud copy carries no account state');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'PV3 privacy page: signed out without the beta flag the web text is the v3.4 text; web-only cards only inside ACCT markers', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const txt = (a) => { a.win.WTS_nav('privacy'); a.flush(50); return String(a.el('pgBody').textContent || '').replace(/\s+/g, ' ').trim(); };
      const web = T.boot(ctx, { beta: false });
      const inert = ctx.loadApp({ timers: 'manual', console: 'capture' });   // http://localhost: accounts inert
      try {
        assert.strictEqual(txt(web.a), txt(inert), 'the same privacy text as an inert host');
        assert(!ACCOUNT_WORDS.test(txt(web.a)), 'no account wording without a session and the beta flag');
      } finally { web.dispose(); inert.dispose(); }
      const host = fs.readFileSync(path.join(__dirname, '..', '..', 'well-testing-app.html'), 'utf8');
      const m = /function renderPrivacy\s*\([^)]*\)\s*\{([\s\S]*?)\r?\n\}/.exec(host);
      assert(m, 'renderPrivacy');
      const outside = m[1].replace(/\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g, '');
      assert(!/LinkedIn|cloud project|sign-in method/i.test(outside), 'account / provider wording only inside ACCT markers');
      if (!/ACCT:START/.test(m[1])) T.skip('PV3 web cards', 'WP-H H11 (web / iOS privacy branches) not on this branch: the web account cards are not checked');
    },
  },
  {
    name: 'PV4 the help centre carries no account wording; the account help lives on the account page', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const a = ctx.loadApp({ timers: 'manual', console: 'capture' });
      try {
        const H = a.win.WTS_help;
        assert(H && typeof H.load === 'function', 'help loaded');
        H.load(true);
        const C = a.win.WTS_helpContent;
        const all = JSON.stringify(C.guides);
        assert(all.length > 10000, 'guides built');
        const hit = ACCOUNT_WORDS.exec(all);
        assert(!hit, 'account wording in the help centre: ' + (hit && all.slice(Math.max(0, hit.index - 60), hit.index + 60)));
        assert(!C.guides.account, 'no account guide in WTS_helpContent');
      } finally { a.dispose(); }
    },
  },
  {
    name: 'PV5 the account page help covers cloud projects, two computers, public computers, the code-mail FAQ and data requests', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, {});
      try {
        t.w.WTS_accountPage.open();
        await t.until(() => t.el('acct_card_help'));
        const h = t.text('acct_card_help');
        ['How cloud projects work', 'Two computers', 'Public or shared computers', 'Didn\'t get the code?', 'Your data'].forEach((s) => assert(h.includes(s), s));
        assert(/no-reply@h2oil\.co\.uk/.test(h) && /software@h2oil\.co\.uk/.test(h));
        assert(t.el('acct_page_signin'), 'signed out: a Sign in button, no request');
        assert.strictEqual(t.fake.requests.length, 0);
        const src = fs.readFileSync(path.join(__dirname, '..', '68-account-page.js'), 'utf8');
        assert(src.indexOf('How cloud projects work') < src.indexOf('// ── ACCT:END ──'), 'the help text is inside the ACCT block');
      } finally { t.dispose(); }
    },
  },
];
