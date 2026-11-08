// Accounts — WP-O client: provider sign-in in 66 / 68 against the fake server (docs/ACCOUNTS-PLAN.md §4.10–4.15, §5.2, §5.5,
// §11.2, §11.3, §12.2 acct-oauth).
//
// Each case runs 66 + 68 (self-tests stripped) in a small vm "page" with the _dom.js document, a localStorage that survives
// a page load (the provider round trip leaves the page), history / location recorders and the fake server's fetch (one
// cookie jar per browser). The provider leg is the fake's visit(): authorize, then the cross-site callback with Lax cookies.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const D = require('./_dom');
const F = require('./_acct-fake-server');

const WP = 'WP-O';
const BUILD = path.join(__dirname, '..');
const FILES = ['66-account.js', '68-account-page.js'];
const { stripSelfTest } = require(path.join(BUILD, 'concat-round8.js'));
const PINS = require(path.join(BUILD, '..', 'server', 'core', 'oidc-providers'));
const CONSUMER = PINS.CONFIG.google.consumerDomains[0];
const SRC = FILES.map((f) => [f, stripSelfTest(fs.readFileSync(path.join(BUILD, f), 'utf8'), f, { log() {}, warn() {} })]);
const MIN = 60 * 1000;
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n) { for (let i = 0; i < (n || 12); i++) await tick(); }

// one page load. o: {fake, br (fake browser), store, hash, location, route, registry, online, capacitor, dev, now}
function page(o) {
  o = o || {};
  const store = o.store || {};
  const rec = { assigned: [], replaced: [], navs: [], flushes: 0, fetches: [], timers: 0 };
  const dom = D.createDOM({ layout: { width: 900, height: 420 }, viewport: { width: 390, height: 800 } });
  const doc = dom.document;
  const loc = Object.assign(F.prodLocation(), o.location || {});
  loc.hash = o.hash || '';
  loc.assign = (u) => { rec.assigned.push(u); };
  const br = o.br || (o.fake && o.fake.browser('b' + Math.random()));
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    location: loc, document: doc,
    history: { replaceState(s, t, u) { rec.replaced.push(u); loc.hash = ''; } },
    navigator: { onLine: o.online !== false },
    fetch: (u, i) => { rec.fetches.push(String(u)); if (!br) return Promise.reject(new TypeError('no fetch')); return br.fetch(String(u).startsWith('/') ? F.PROD + u : u, i); },
    setTimeout: () => { rec.timers++; return 0; }, setInterval: () => { rec.timers++; return 0; },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    WTS_nav: (r) => rec.navs.push(r),
    WTS_pageAutosave: { flush() { rec.flushes++; }, page: () => o.route || 'wts' },
    WTS_calcRegistry: o.registry || { buildup: {}, cheminj: {} },
    Promise, JSON, Object, Array, Error, Date: o.now ? fakeDate(o.now) : Date, Math, String, Number, Boolean, RegExp, TypeError,
  };
  ctx.window = ctx;
  if (o.capacitor) ctx.Capacitor = { isNativePlatform: () => true };
  if (o.dev) ctx.WTS_ACCOUNT_DEV = 1;
  vm.createContext(ctx);
  ctx.top = vm.runInContext('globalThis', ctx);
  SRC.forEach(([f, s]) => vm.runInContext(s, ctx, { filename: f }));
  const win = vm.runInContext('globalThis', ctx);
  if (o.now && win.WTS_account && win.WTS_account.configure) win.WTS_account.configure({ now: o.now });
  return { win, A: win.WTS_account, P: win.WTS_accountPage, doc, store, rec, br, loc,
    q: (s) => doc.querySelector(s), qa: (s) => Array.from(doc.querySelectorAll(s)), host() { const h = doc.createElement('div'); doc.body.appendChild(h); return h; } };
}
function fakeDate(now) {
  function FD(...a) { return a.length ? new Date(...a) : new Date(now()); }
  FD.now = () => now(); FD.parse = Date.parse; FD.UTC = Date.UTC; FD.prototype = Date.prototype;
  return FD;
}
const hint = (p) => JSON.parse(p.store.wtsacct_hint || '{}');
const click = (el) => { if (!el) throw new Error('no element to click'); el.onclick({ type: 'click', target: el }); };
const typeIn = (el, v) => { el.value = v; };
// the whole provider round trip for a page: press the button → fake provider → callback → a new page load with #acct-oauth
async function roundTrip(p, provider, as, o) {
  o = o || {};
  const host = p.host();
  await p.A.oauthUI.renderButtons(host, { publicDevice: !!o.publicDevice });
  click(host.querySelector('.acct-prov-btn[data-provider="' + provider + '"]'));
  await settle();
  const url = p.rec.assigned[p.rec.assigned.length - 1];
  if (!url) throw new Error('no location.assign: ' + (host.textContent || ''));
  const v = await p.br.visit(url, o.cancel ? { cancel: true } : { as });
  const next = page(Object.assign({ fake: o.fake, br: p.br, store: p.store, hash: v.location.split('#')[1] ? '#' + v.location.split('#')[1] : '', route: o.route, now: o.now }, o.page || {}));
  await settle();
  return next;
}
const lastMail = (fake, email) => fake.lastMail(email);

module.exports = [
  {
    name: 'OA1 guard: no provider code off the production host, on iOS or in the vm stub; nothing at load', wp: WP, opts: false,
    async run(app, assert) {
      for (const [what, o] of [['preview https host', { location: { hostname: 'preview.example', host: 'preview.example' } }],
        ['http', { location: { protocol: 'http:' } }], ['iOS shell', { capacitor: true }], ['capacitor + DEV', { capacitor: true, dev: true, location: { hostname: 'localhost', host: 'localhost' } }]]) {
        const p = page(o);
        assert.strictEqual(p.A.eligible, false, what);
        assert.strictEqual(p.A.oauthUI, undefined, what + ': no provider UI');
        assert.strictEqual(p.qa('.acct-prov-btn').length, 0);
        assert.strictEqual(p.rec.fetches.length + p.rec.timers, 0, what + ': nothing at load');
      }
      // DEV on localhost: present (the fake provider only; the server decides which provider answers)
      const dev = page({ dev: true, location: { hostname: 'localhost', host: 'localhost', protocol: 'http:' } });
      assert.strictEqual(typeof dev.A.oauthUI.renderButtons, 'function');
      const fake = F.createFakeServer({});
      const p = page({ fake });
      assert.strictEqual(p.A.eligible, true);
      assert.deepStrictEqual([p.rec.fetches.length, p.rec.timers, p.qa('.acct-prov-btn').length], [0, 0, 0], 'a signed-out first visit: no request, timer or button');
      for (const f of FILES) {
        const src = fs.readFileSync(path.join(BUILD, f), 'utf8');
        const outside = src.replace(/\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g, '');
        assert(!/Google|LinkedIn|\/auth\/oauth|acct-oauth/.test(outside), f + ': provider names and routes only inside the ACCT block');
        assert(!/setInterval\(|<img|<link|<script|https:\/\/(?!welltest\.h2oil\.co\.uk)[a-z]/.test(src.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), f + ': no external asset, script or timer');
      }
    },
  },
  {
    name: 'OA2 buttons: GET /auth/providers on open; off hides, signin labels; same size and verb, inline marks, no external request', wp: WP, opts: false,
    async run(app, assert) {
      const fake = F.createFakeServer({});
      const p = page({ fake });
      const host = p.host();
      const st = await p.A.oauthUI.renderButtons(host, {});
      assert.deepStrictEqual(JSON.parse(JSON.stringify(st)), { google: 'on', linkedin: 'on' });
      assert.deepStrictEqual(p.rec.fetches, ['/api/v1/auth/providers'], 'one same-origin request, when the dialog opens');
      const b = Array.from(host.querySelectorAll('.acct-prov-btn'));
      assert.deepStrictEqual(b.map((x) => x.getAttribute('data-provider')), ['google', 'linkedin']);
      assert.deepStrictEqual(b.map((x) => x.querySelector('.acct-prov-label').textContent), ['Sign in with Google', 'Sign in with LinkedIn'], 'the same verb');
      b.forEach((x) => assert.strictEqual(x.getAttribute('aria-label'), x.querySelector('.acct-prov-label').textContent, 'aria-label = visible text'));
      assert.strictEqual(b[0].getAttribute('style'), b[1].getAttribute('style'), 'the same size and weight');
      assert(/width: ?100%/.test(b[0].getAttribute('style')) && /min-height: ?44px/.test(b[0].getAttribute('style')), 'full width, ≥ 44 px (390 px sheet)');
      b.forEach((x) => { assert(x.querySelector('svg'), 'inline mark'); assert(!/\b(src|href)=/.test(x.innerHTML), 'no external reference'); });
      assert(/Use the e-mail code/.test(host.textContent));
      fake.setSwitch('OAUTH_GOOGLE', 'off'); fake.setSwitch('OAUTH_LINKEDIN', 'signin');
      await p.A.oauthUI.renderButtons(host, {});
      assert.deepStrictEqual(Array.from(host.querySelectorAll('.acct-prov-btn')).map((x) => x.getAttribute('data-provider')), ['linkedin']);
      assert(/existing accounts only/.test(host.textContent));
      fake.setSwitch('OAUTH_LINKEDIN', 'off');
      await p.A.oauthUI.renderButtons(host, {});
      assert.strictEqual(host.querySelectorAll('.acct-prov-btn').length, 0);
      // offline: disabled
      fake.setSwitch('OAUTH_GOOGLE', 'on');
      const off = page({ fake, online: false });
      const h2 = off.host();
      await off.A.oauthUI.renderButtons(h2, {});
      assert(h2.querySelector('.acct-prov-btn').disabled, 'needs a connection');
      await assert.rejects(off.A.signInWith('google', {}), (e) => e.code === 'network');
      assert.strictEqual(off.rec.fetches.filter((u) => /start/.test(u)).length, 0);
    },
  },
  {
    name: 'OA3 start: flush, hint.oauth, POST start, location.assign; public tick and shared-browser flag → fresh login, LinkedIn hidden', wp: WP, opts: false,
    async run(app, assert) {
      const fake = F.createFakeServer({});
      const p = page({ fake, route: 'buildup' });
      const host = p.host();
      await p.A.oauthUI.renderButtons(host, {});
      click(host.querySelector('[data-provider="google"]'));
      assert(/Taking you to Google/.test(host.textContent));
      await settle();
      assert.strictEqual(p.rec.flushes, 1, 'autosave flushed before leaving');
      const h = hint(p);
      assert.strictEqual(h.oauth.provider, 'google'); assert.strictEqual(h.oauth.route, 'buildup'); assert.strictEqual(typeof h.oauth.at, 'number');
      assert.strictEqual(p.rec.assigned.length, 1);
      const u = new URL(p.rec.assigned[0]);
      assert.strictEqual(u.origin + u.pathname, fake.oidc.google.authorizationEndpoint);
      assert.strictEqual(u.searchParams.get('prompt'), 'select_account');
      assert(p.br.cookie('__Host-wts_oa'), 'the attempt cookie (HttpOnly; the page never reads it)');
      // the public tick: Google asks for a fresh login, LinkedIn is hidden, the note is shown
      const h2 = p.host();
      await p.A.oauthUI.renderButtons(h2, { publicDevice: true });
      assert.deepStrictEqual(Array.from(h2.querySelectorAll('.acct-prov-btn')).map((x) => x.getAttribute('data-provider')), ['google']);
      assert(/sign out of it too when you finish/.test(h2.textContent));
      click(h2.querySelector('.acct-prov-btn')); await settle();
      assert.strictEqual(new URL(p.rec.assigned[1]).searchParams.get('prompt'), 'login');
      // a browser marked shared: every later attempt is fresh-login, without the tick
      p.store.wtspref_shared_browser = '1';
      const h3 = p.host();
      await p.A.oauthUI.renderButtons(h3, {});
      assert.strictEqual(h3.querySelectorAll('.acct-prov-btn').length, 1, 'LinkedIn hidden on a shared browser');
      await p.A.signInWith('google', {});
      assert.strictEqual(new URL(p.rec.assigned[2]).searchParams.get('max_age'), '0');
      await assert.rejects(p.A.signInWith('linkedin', {}), (e) => e.code === 'oauth_failed' && e.body.reason === 'reauth_stale');
      assert.strictEqual(hint(p).oauth, undefined, 'a failed start clears hint.oauth');
    },
  },
  {
    name: 'OA4 return: #acct-oauth without the hint is ignored; with it — fragment stripped, consent names the address, Cancel second, done', wp: WP, opts: false,
    async run(app, assert) {
      const fake = F.createFakeServer({});
      const lone = page({ fake, hash: '#acct-oauth' });
      await settle();
      assert.deepStrictEqual([lone.rec.fetches.length, lone.rec.replaced.length, lone.qa('#acct_oauth_dlg').length], [0, 0, 0], 'no hint: no request, no dialog');
      const p = page({ fake, route: 'cheminj' });
      const email = 'new.person@' + CONSUMER;
      const r = await roundTrip(p, 'google', { key: 'g1', email }, { fake, route: 'cheminj' });
      assert.deepStrictEqual(r.rec.replaced, ['/well-testing-app.html'], 'fragment removed with replaceState');
      assert(r.q('#acct_oauth_dlg'), 'the finish dialog');
      assert.strictEqual(r.q('#acct_oauth_dlg').getAttribute('role'), 'dialog');
      assert(/rp-skip/.test(r.q('#acct_oauth_dlg').className) && r.q('#acct_oauth_dlg').getAttribute('data-rp-nosnap') === '1');
      const consent = r.q('.acct-oauth-consent');
      assert(consent && consent.textContent.includes('n•••@' + CONSUMER), 'names the new account address');
      assert(/add Google under Account → Sign-in methods/.test(consent.textContent), 'the two-accounts warning');
      const btns = r.qa('#acct_oauth_body button').map((b) => b.textContent);
      assert.deepStrictEqual(btns, ['Create account', 'Cancel'], 'Cancel is the second button');
      click(r.q('#acct_oauth_create')); await settle();
      assert.strictEqual(r.q('#acct_oauth_dlg'), null, 'closed when done');
      const h = hint(r);
      assert.strictEqual(h.signedIn, true); assert.strictEqual(h.oauth, undefined); assert.strictEqual(h.initial, 'N');
      assert.deepStrictEqual(r.rec.navs, ['cheminj'], 'return route restored (a known route key)');
      assert.strictEqual(r.A.state().status, 'signedIn'); assert.strictEqual(r.A.state().authMethod, 'google');
      assert(r.br.cookie('__Host-wts_sid'), 'the session cookie came from finish');
      // an unknown route key is never used
      const p2 = page({ fake, route: 'nope' });
      p2.store.wtsacct_hint = JSON.stringify({ oauth: { provider: 'google', route: 'javascript:alert(1)', at: Date.now() } });
      const r2 = await roundTrip(p2, 'google', { key: 'g1', email }, { fake, route: '../evil' });
      assert.deepStrictEqual(r2.rec.navs, ['home'], 'unknown route → home');
      // Cancel at the consent step leaves nothing behind
      const p3 = page({ fake });
      const r3 = await roundTrip(p3, 'google', { key: 'g-cancel', email: 'cancel.me@' + CONSUMER }, { fake });
      click(r3.q('#acct_oauth_cancel'));
      assert.strictEqual(r3.q('#acct_oauth_dlg'), null); assert.strictEqual(hint(r3).oauth, undefined);
      assert.strictEqual(fake.user('cancel.me@' + CONSUMER), null, 'no account');
    },
  },
  {
    name: 'OA5 e-mail and code steps: LinkedIn always; Google on an unmanaged domain; a wrong code stays on the step; 12 min later still finishes', wp: WP, opts: false,
    async run(app, assert) {
      let t = Date.UTC(2026, 10, 8, 12); const now = () => t;
      const fake = F.createFakeServer({ now });
      const p = page({ fake, now });
      const r = await roundTrip(p, 'linkedin', { key: 'l1', email: 'li@company.example' }, { fake, now });
      const inp = r.q('#acct_oauth_email');
      assert(inp, 'LinkedIn: always the e-mail step'); assert.strictEqual(inp.value, 'li@company.example', 'prefilled');
      assert.strictEqual(inp.getAttribute('inputmode'), 'email');
      click(r.q('#acct_oauth_send')); await settle();
      const msg = r.q('.acct-oauth-msg');
      assert(/We sent a code to l•••@company\.example/.test(msg.textContent));
      assert.strictEqual(r.q('#acct_oauth_code').getAttribute('autocomplete'), 'one-time-code');
      typeIn(r.q('#acct_oauth_code'), '0000 0000'); click(r.q('#acct_oauth_verify')); await settle();
      assert(/wrong or has expired/.test(r.q('.acct-oauth-error').textContent), 'a wrong code: message, still on the code step');
      assert(r.q('#acct_oauth_code'));
      t += 12 * MIN;
      typeIn(r.q('#acct_oauth_code'), fake.codeFor('li@company.example', 'code_oauth_verify')); click(r.q('#acct_oauth_verify')); await settle();
      assert(r.q('.acct-oauth-consent'), 'a code entered 12 minutes after the callback still finishes the step');
      click(r.q('#acct_oauth_create')); await settle();
      assert.strictEqual(hint(r).signedIn, true);
      // Google on a domain Google does not manage asks for a code
      const g = await roundTrip(page({ fake, now }), 'google', { key: 'g2', email: 'name@company.example' }, { fake, now });
      assert(g.q('#acct_oauth_email'), 'unmanaged domain → e-mail step');
    },
  },
  {
    name: 'OA6 U15 and statuses: code to the matched address; identity_in_use, provider_linked, not_invited, signup_closed, locked, cancel_deletion', wp: WP, opts: false,
    async run(app, assert) {
      const fake = F.createFakeServer({});
      const email = 'existing@' + CONSUMER;
      await F.signIn(fake, fake.browser('setup'), email);
      const p = page({ fake });
      let r = await roundTrip(p, 'google', { key: 'u15', email }, { fake });
      const m = r.q('.acct-oauth-msg');
      assert.strictEqual(m.getAttribute('data-reason'), 'link_existing');
      assert(m.textContent.includes('An account already uses e•••@' + CONSUMER + '. Enter the code we sent to it to add Google.'));
      typeIn(r.q('#acct_oauth_code'), fake.codeFor(email, 'code_oauth_verify')); click(r.q('#acct_oauth_verify')); await settle();
      assert.strictEqual(hint(r).signedIn, true);
      // a later Google sign-in (rule 1: no code, stepup_at NULL): its first step-up action asks for a code (stepUp runs, then
      // the call is repeated)
      r = await roundTrip(page({ fake }), 'google', { key: 'u15', email }, { fake });
      assert.strictEqual(hint(r).signedIn, true);
      let stepups = 0;
      r.A.stepUp = async () => {
        stepups++;
        await r.A.call('POST', '/auth/code/start', { purpose: 'stepup' });
        await r.A.call('POST', '/auth/code/verify', { code: fake.codeFor(email, 'code_stepup'), publicDevice: false });
      };
      const mm = await r.A.methods();
      const un = await r.A.unlinkMethod(mm.identities[0].id);
      assert.strictEqual(stepups, 1, 'reauth → a code step-up'); assert.strictEqual(un.ok, true);
      // statuses, each in plain words
      const cases = [
        ['not_invited', () => fake.setSwitch('ACCOUNTS_SIGNUP', 'invite'), 'invite-only'],
        ['signup_closed', () => fake.setSwitch('ACCOUNTS_SIGNUP', 'off'), 'New accounts are not open'],
      ];
      for (const [code, set, words] of cases) {
        set();
        const x = await roundTrip(page({ fake }), 'google', { key: 'k-' + code, email: code + '@' + CONSUMER }, { fake });
        assert(x.q('.acct-oauth-error') && x.q('.acct-oauth-error').textContent.includes(words), code + ': ' + x.q('#acct_oauth_body').textContent);
      }
      fake.setSwitch('ACCOUNTS_SIGNUP', 'open');
      // identity_in_use: link a Google identity that another account owns
      const other = fake.browser('other');
      await F.signIn(fake, other, 'owner2@company.example');
      const lp = page({ fake, br: other });
      lp.A.stepUp = async () => { await lp.A.call('POST', '/auth/code/start', { purpose: 'stepup' }); await lp.A.call('POST', '/auth/code/verify', { code: fake.codeFor('owner2@company.example', 'code_stepup'), publicDevice: false }); };
      // re-link the u15 identity to owner2: first give it back to the first account
      const back = await roundTrip(page({ fake }), 'google', { key: 'u15', email }, { fake });
      typeIn(back.q('#acct_oauth_code'), fake.codeFor(email, 'code_oauth_verify')); click(back.q('#acct_oauth_verify')); await settle();
      await lp.A.linkProvider('google'); await settle();
      const v = await other.visit(lp.rec.assigned.pop(), { as: { key: 'u15', email } });
      const rl = page({ fake, br: other, store: lp.store, hash: '#' + v.location.split('#')[1] }); await settle();
      assert(/linked to another Well Testing Suite account/.test(rl.q('.acct-oauth-error').textContent), 'identity_in_use');
      // locked
      fake.lock(email);
      const lk = await roundTrip(page({ fake }), 'google', { key: 'u15', email }, { fake });
      assert(/locked/.test(lk.q('.acct-oauth-error').textContent));
      // cancel_deletion
      const u = fake.user(email); u.status = 'deleting';
      const cd = await roundTrip(page({ fake }), 'google', { key: 'u15', email }, { fake });
      assert.strictEqual(cd.q('.acct-oauth-msg').getAttribute('data-reason'), 'cancel_deletion');
      assert(/being deleted/.test(cd.q('.acct-oauth-msg').textContent));
      typeIn(cd.q('#acct_oauth_code'), fake.codeFor(email, 'code_cancel_deletion')); click(cd.q('#acct_oauth_verify')); await settle();
      assert(cd.q('#acct_oauth_undelete'), 'Cancel deletion is offered only after the code');
      // cancelled at the provider
      const cc = await roundTrip(page({ fake }), 'linkedin', null, { fake, cancel: true });
      assert(/Sign-in with LinkedIn was cancelled/.test(cc.q('.acct-oauth-error').textContent));
      assert(/Use the e-mail code/.test(cc.q('#acct_oauth_body').textContent), 'the e-mail code stays offered');
    },
  },
  {
    name: 'OA7 Sign-in methods card: link needs step-up and the link-confirm code; unlink reports sessions; escaped; cancelled link keeps the session', wp: WP, opts: false,
    async run(app, assert) {
      let t = Date.UTC(2026, 10, 8, 12); const now = () => t;
      const fake = F.createFakeServer({ now });
      const br = fake.browser('acct');
      const email = 'card@company.example';
      await F.signIn(fake, br, email, { publicDevice: true });
      t += 11 * MIN;                                       // the code sign-in's step-up window has passed
      const p = page({ fake, br });
      p.store.wtsacct_hint = JSON.stringify({ signedIn: true, public: true, v: 3 });
      let stepups = 0;
      p.A.stepUp = async () => { stepups++; await p.A.call('POST', '/auth/code/start', { purpose: 'stepup' }); await p.A.call('POST', '/auth/code/verify', { code: fake.codeFor(email, 'code_stepup'), publicDevice: true }); };
      const host = p.host();
      await p.P.renderSignInMethods(host);
      const rows = Array.from(host.querySelectorAll('.acct-method-row')).map((x) => x.getAttribute('data-method'));
      assert.deepStrictEqual(rows, ['email', 'recovery', 'google', 'linkedin']);
      assert(/c•••@company\.example — always on/.test(host.textContent));
      assert(/always works as a way in/.test(host.textContent));
      // a cancelled link on a public device: still signed in, nothing wiped
      click(host.querySelector('[data-method="linkedin"] .acct-prov-btn')); await settle();
      assert.strictEqual(stepups, 1, 'link runs a step-up first (start answered reauth)');
      const url1 = p.rec.assigned.pop();
      const vc = await br.visit(url1, { cancel: true });
      const rc = page({ fake, br, store: p.store, hash: '#' + vc.location.split('#')[1] }); await settle();
      assert(/cancelled/.test(rc.q('.acct-oauth-error').textContent));
      assert.strictEqual(hint(rc).signedIn, true, 'still signed in'); assert(br.cookie('__Host-wts_sid'), 'session kept');
      // the real link: link-confirm code after the return
      await p.A.linkProvider('google'); await settle();
      const v = await br.visit(p.rec.assigned.pop(), { as: { key: 'card-g', email: 'card.g@' + CONSUMER } });
      const r = page({ fake, br, store: p.store, hash: '#' + v.location.split('#')[1] }); await settle();
      assert.strictEqual(r.q('.acct-oauth-msg').getAttribute('data-reason'), 'link_confirm');
      const lm = lastMail(fake, email);
      assert.strictEqual(lm.template, 'code_link_confirm'); assert.strictEqual(lm.params.provider, 'google');
      typeIn(r.q('#acct_oauth_code'), lm.params.code); click(r.q('#acct_oauth_verify')); await settle();
      assert(/Google was added/.test(r.q('.acct-oauth-linked').textContent));
      // a provider session for it, then unlink from the card
      const ps = fake.browser('ps');
      const pp = page({ fake, br: ps });
      const pr = await roundTrip(pp, 'google', { key: 'card-g', email: 'card.g@' + CONSUMER }, { fake });
      assert.strictEqual(hint(pr).signedIn, true);
      await p.P.renderSignInMethods(host);
      assert(/Unlinking signs out every session it opened/.test(host.textContent));
      click(host.querySelector('#acct_m_unlink_google')); await settle(20);
      assert(/Google was removed\. 1 session it opened was signed out\./.test(host.textContent), host.textContent);
      assert(fake.lastMail(email).template === 'notice_identity_unlinked');
      // server strings are text, never markup
      const evil = '<img src=x onerror="window.pwned=1">';
      p.A.methods = () => Promise.resolve({ email: { masked: evil }, identities: [{ id: crypto.randomUUID(), provider: 'google', emailMasked: evil, linkedAt: '2026-11-08T00:00:00Z', lastUsedAt: null }], passkeys: [{ id: crypto.randomUUID(), name: evil, created: '2026-11-08T00:00:00Z', lastUsed: null }] });
      await p.P.renderSignInMethods(host);
      assert.strictEqual(host.querySelectorAll('img').length, 0, 'no element from a server string');
      assert(host.textContent.includes(evil));
    },
  },
  {
    name: 'OA8 sessions: user A → user B revokes A; providerEmailDiffers note; public provider session → blocking provider sign-out step', wp: WP, opts: false,
    async run(app, assert) {
      const fake = F.createFakeServer({});
      const br = fake.browser('shared');
      await F.signIn(fake, br, 'a.user@company.example');
      assert.strictEqual(fake.sessionsOf('a.user@company.example').length, 1);
      const p = page({ fake, br });
      const r = await roundTrip(p, 'google', { key: 'B', email: 'b.user@' + CONSUMER }, { fake });
      click(r.q('#acct_oauth_create')); await settle();
      assert.strictEqual(fake.sessionsOf('a.user@company.example').length, 0, "A's session is revoked by B's finish");
      assert.strictEqual(r.A.state().user.emailMasked, 'b•••@' + CONSUMER);
      // the provider e-mail differs from the one at link time: Change / Keep, the account e-mail unchanged
      const d = await roundTrip(page({ fake }), 'google', { key: 'B', email: 'b.renamed@' + CONSUMER }, { fake });
      assert(d.q('.acct-oauth-differs'), 'the note');
      assert.deepStrictEqual(d.qa('#acct_oauth_body button').map((x) => x.textContent), ['Change account e-mail', 'Keep my account e-mail']);
      assert(d.q('.acct-oauth-differs').textContent.includes('b•••@' + CONSUMER));
      click(d.q('#acct_oauth_keep')); assert.strictEqual(d.q('#acct_oauth_dlg'), null);
      // public provider session: the shared flag is set, and sign-out has a blocking provider step
      const pub = await roundTrip(page({ fake }), 'google', { key: 'B', email: 'b.user@' + CONSUMER }, { fake, publicDevice: true });
      assert.strictEqual(pub.store.wtspref_shared_browser, '1', 'this browser is now marked shared');
      assert.strictEqual(pub.A.providerSignOutNeeded(), 'google');
      let resolved = false;
      const done = pub.A.oauthUI.providerSignOutStep('google').then((v) => { resolved = v; });
      assert(/Now sign out of Google in this browser/.test(pub.q('.acct-oauth-signout').textContent));
      if (pub.q('#acct_oauth_dlg').onkeydown) pub.q('#acct_oauth_dlg').onkeydown({ key: 'Escape' });
      assert(pub.q('#acct_oauth_dlg'), 'Escape does not close the blocking step');
      await settle(); assert.strictEqual(resolved, false);
      click(pub.q('#acct_oauth_signedout')); await done;
      assert.strictEqual(resolved, true); assert.strictEqual(pub.q('#acct_oauth_dlg'), null);
      assert.strictEqual(page({ fake }).A.providerSignOutNeeded(), null, 'a fresh page without a provider session');
    },
  },
  {
    name: 'OA9 finish dialog focus (§11.2): focus moves in, Tab stays inside, closing returns it; the blocking step traps Tab too', wp: WP, opts: false,
    async run(app, assert) {
      const fake = F.createFakeServer({});
      const p = page({ fake });
      const opener = p.doc.createElement('button'); opener.id = 'opener'; p.doc.body.appendChild(opener); opener.focus();
      p.store.wtsacct_hint = JSON.stringify({ oauth: { provider: 'google', route: 'cheminj', at: Date.now() } });
      const calls = [];
      p.A.finishProviderSignIn = (b) => { calls.push(b); return Promise.resolve({ next: 'code', reason: 'verify', emailMasked: 'a•••@company.example' }); };
      p.A.oauthUI.openFinish(); await settle();
      const tab = (shift) => p.q('#acct_oauth_dlg').onkeydown({ key: 'Tab', shiftKey: !!shift, preventDefault() {} });
      assert.strictEqual(p.doc.activeElement, p.q('#acct_oauth_code'), 'focus moves to the code input');
      assert.deepStrictEqual(p.qa('#acct_oauth_body button').map((b) => b.id), ['acct_oauth_verify', 'acct_oauth_close']);
      tab(); assert.strictEqual(p.doc.activeElement.id, 'acct_oauth_verify');
      tab(); assert.strictEqual(p.doc.activeElement.id, 'acct_oauth_close');
      tab(); assert.strictEqual(p.doc.activeElement.id, 'acct_oauth_code', 'Tab wraps inside the dialog');
      tab(true); assert.strictEqual(p.doc.activeElement.id, 'acct_oauth_close', 'Shift+Tab wraps backwards');
      assert(/Didn't get the code\?/.test(p.q('.acct-oauth-help').textContent), "the Didn't-get-the-code help");
      assert(/choose Google again/.test(p.q('.acct-oauth-help').textContent));
      click(p.q('#acct_oauth_close'));
      assert.strictEqual(p.q('#acct_oauth_dlg'), null);
      assert.strictEqual(p.doc.activeElement, opener, 'focus returns to the control that opened it');
      assert.strictEqual(hint(p).oauth, undefined, 'closing the code step drops the attempt hint');
      // the blocking provider sign-out step: Escape stays, Tab stays inside
      opener.focus();
      const done = p.A.oauthUI.providerSignOutStep('google');
      assert.strictEqual(p.doc.activeElement.id, 'acct_oauth_signedout');
      p.q('#acct_oauth_dlg').onkeydown({ key: 'Escape' }); assert(p.q('#acct_oauth_dlg'), 'Escape does not close it');
      tab(); assert.strictEqual(p.doc.activeElement.id, 'acct_oauth_signedout');
      click(p.q('#acct_oauth_signedout')); assert.strictEqual(await done, true);
      assert.strictEqual(p.doc.activeElement, opener);
    },
  },
  {
    name: 'OA10 consent without versions sends nothing; a finished link restores the route; done steps close cleanly', wp: WP, opts: false,
    async run(app, assert) {
      const fake = F.createFakeServer({});
      const p = page({ fake });
      p.store.wtsacct_hint = JSON.stringify({ oauth: { provider: 'google', route: 'cheminj', at: Date.now(), purpose: 'signin' } });
      const calls = [];
      p.A.finishProviderSignIn = (b) => { calls.push(b); return Promise.resolve({ next: 'consent', newAccountEmailMasked: 'n•••@company.example' }); };
      p.A.oauthUI.openFinish(); await settle();
      assert.strictEqual(p.q('#acct_oauth_create'), null, 'no Create account without the server versions');
      assert(p.q('.acct-oauth-error'), 'the server-error message');
      assert.strictEqual(JSON.stringify(calls), '[{}]', 'no consent body was sent (never made-up versions)');
      click(p.q('#acct_oauth_close'));
      // with the versions: they are sent as the server gave them
      p.store.wtsacct_hint = JSON.stringify({ oauth: { provider: 'google', route: 'cheminj', at: Date.now(), purpose: 'signin' } });
      calls.length = 0;
      p.A.finishProviderSignIn = (b) => { calls.push(b); return Promise.resolve(b.consent ? { next: 'oauth_state' } : { next: 'consent', newAccountEmailMasked: 'n•••@company.example', terms: '2026-11', privacy: '2026-10' }); };
      p.A.oauthUI.openFinish(); await settle();
      click(p.q('#acct_oauth_create')); await settle();
      assert.strictEqual(JSON.stringify(calls[1]), JSON.stringify({ consent: { terms: '2026-11', privacy: '2026-10' } }));
      // a finished link goes back to the page it started from
      p.store.wtsacct_hint = JSON.stringify({ oauth: { provider: 'linkedin', route: 'cheminj', at: Date.now(), purpose: 'link' } });
      p.rec.navs.length = 0;
      p.A.finishProviderSignIn = () => Promise.resolve({ next: 'done', linked: { id: crypto.randomUUID(), provider: 'linkedin', emailMasked: null, linkedAt: '2026-11-08T00:00:00Z', lastUsedAt: null } });
      p.A.oauthUI.openFinish(); await settle();
      assert(/LinkedIn was added/.test(p.q('.acct-oauth-linked').textContent));
      assert.strictEqual(JSON.stringify(p.rec.navs), '["cheminj"]', 'route restored after a link as after a sign-in');
      assert.strictEqual(p.doc.activeElement.id, 'acct_oauth_close');
      click(p.q('#acct_oauth_close')); assert.strictEqual(p.q('#acct_oauth_dlg'), null);
    },
  },
];
