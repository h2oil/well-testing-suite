'use strict';
// server/test/e2e.test.js — Phase 1 end to end (docs/ACCOUNTS-PLAN.md §4, §6, §8.5, §10, §12): the REAL page (the app built
// in memory from prism-build/ by the acceptance harness, 66–68 included) talks through a cookie-jar browser to the REAL
// request pipeline and handlers (core/app.js, functions/*) on a freshly migrated database, with the fake OpenID providers
// (test/fake-oidc.js), the memory mail transport and the memory blob store. Skips without the throwaway cluster (run through
// server/test/run.js).
//
//   E1 sign up by e-mail code → Save to cloud → a "second device" opens it (same keys) → edit, save, history, restore a
//      revision → export everything (account JSON + projects)
//   E2 Google sign-up (consent) → link LinkedIn from the account (step-up, link-confirm code) → sign in with LinkedIn on
//      another device → unlink (its sessions signed out) → the export carries both identities
//   E3 a public computer: sign in, save, sign out → nothing of the work is left in the browser
//   E4 delete the account with the 7-day grace → signed out, identities released → a sign-in offers Cancel deletion →
//      delete again, the grace passes, the daily job purges it (ledger written, nothing left)
//   E5 the local dev server (server/dev.js) over real HTTP on 127.0.0.1: a page origin on localhost signs up by code, reads
//      /me and signs out; another origin is refused
//   E6 with no server configured the page behaves as v3.4 (no chip, no request); the iOS bundle of this build carries none of it

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const D = require('./_db');
const { createApp } = require('../core/app');
const { loadConfig } = require('../core/config');
const { memoryTransport } = require('../core/mail');
const { memoryObjects } = require('../core/objects');
const { runDaily } = require('../core/jobs');
const { createFakeOidc } = require('./fake-oidc');
const { createOauthHandlers } = require('../functions/oauth');
const baseHandlers = require('../functions').handlers;

const REPO = path.join(__dirname, '..', '..');
const TESTS = path.join(REPO, 'prism-build', 'tests');
const harness = require(path.join(TESTS, '_harness'));
const T = require(path.join(TESTS, '_acct-app'));
const F = require(path.join(TESTS, '_acct-fake-server'));
const PINS = require('../core/oidc-providers');

const skip = !D.available() && 'no throwaway database (run through server/test/run.js)';
const key32 = () => crypto.randomBytes(32).toString('base64');
const CONSUMER = PINS.CONFIG.google.consumerDomains[0];
// each page load starts its virtual clock at the real time, so a later load (the provider return) is later, as in a browser
const ctx = { loadApp: (o) => harness.loadApp(Object.assign({ fromSources: true, console: 'capture', startTime: Date.now() }, o || {})) };

let H = null; let api = null; let jobs = null;

// the real server: the pipeline on the database, wrapped in the transport the client tests use (one browser = one jar)
function realServer() {
  const g = createFakeOidc({ provider: 'google' });
  const l = createFakeOidc({ provider: 'linkedin', enforcePkce: true });
  const env = { WTS_ENV: 'test', ACCOUNTS_SIGNUP: 'open', SYNC_MODE: 'on', OAUTH_GOOGLE: 'on', OAUTH_LINKEDIN: 'on',
    OAUTH_GOOGLE_CLIENT_ID: g.clientId, OAUTH_GOOGLE_CLIENT_SECRET: g.clientSecret,
    OAUTH_LINKEDIN_CLIENT_ID: l.clientId, OAUTH_LINKEDIN_CLIENT_SECRET: l.clientSecret,
    WTS_TERMS_VERSION: '1', WTS_PRIVACY_VERSION: '1', WTS_VERSION: 'e2e',
    WTS_INDEX_PEPPER: key32(), WTS_MASTER_KEYS: '1:' + key32(), WTS_MASTER_KID: '1', WTS_CODE_PEPPERS: '1:' + key32() };
  const config = loadConfig(env);
  const mail = memoryTransport();
  const objects = memoryObjects();
  const logs = [];
  const log = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) };
  const fetch = (url, init) => (String(url).startsWith('https://google.') ? g : l).fetch(url, init);
  const oauth = createOauthHandlers({ fetch, override: { google: g.override, linkedin: l.override } });
  const app = createApp({ config, db: api, mail, log, objects, handlers: Object.assign({}, baseHandlers, oauth) });
  const requests = [];
  // every request waits for its after-response work (the queued mail), as a test reads the mailbox right after
  const Tr = { handle: async (req) => { const r = await app.handle(req); await app.idle(); return r; }, oidc: { google: g, linkedin: l }, requests };
  return {
    app, config, mail, objects, logs, requests, oidc: { google: g, linkedin: l }, keys: app.keys,
    browser: (name) => F.createBrowser(Tr, name || 'b' + Math.random().toString(36).slice(2, 7)),
    codeFor: (email, template) => mail.codeFor(String(email).toLowerCase(), template),
  };
}
// a page on a device of the real server (the harness app on the production location, beta flag set)
function device(srv, o) {
  o = o || {};
  const br = o.browser || srv.browser();
  const loc = F.prodLocation();
  const assigned = [];
  loc.assign = (u) => { assigned.push(String(u)); };
  if (o.hash) { loc.hash = o.hash; loc.href += o.hash; }
  const t = T.boot(ctx, Object.assign({}, o, { fake: srv, browser: br, globals: Object.assign({ location: loc }, o.globals || {}) }));
  t.assigned = assigned;
  return t;
}
const sql = () => H.admin.sql;
async function userRow(email, keys) { return (await sql()`select * from wts.users where email_bidx = ${keys.emailBidx(email)}`)[0] || null; }
async function signedIn(t, what) { await t.until(() => t.acct().state().status === 'signedIn' && !t.el('acct_dlg_ov'), what || 'signed in', 15000); }
async function wait(t, fn, what, o) {
  o = o || {};
  try { return await t.until(fn, what, o.max || 15000); } catch (e) {
    const b = (id) => { const el = t.a.el(id); return el ? String(el.textContent || '').slice(0, 300) : '-'; };
    e.message += ' [oauth dialog: ' + b('acct_oauth_body') + ' | dialog: ' + b('acct_dlg_body') + ' | hint: ' + t.storage.getItem('wtsacct_hint') + ']';
    // a link whose promise rejected says why (the rejection used to be swallowed, so a failure looked like a timeout)
    if (o.link) e.message += ' [linkProvider: ' + (o.link.state === 'rejected' ? 'rejected: ' + (o.link.error && (o.link.error.code || o.link.error.message)) : o.link.state) + ']';
    throw e;
  }
}
// the provider round trip from a page: the button → start → location.assign → the fake provider → callback → a new page
// load of the same device with #acct-oauth (same storage, IndexedDB and cookie jar)
async function providerTrip(srv, t, provider, as, o) {
  o = o || {};
  const before = t.assigned.length;
  const link = { state: 'pending', error: null };
  if (o.link) t.acct().linkProvider(provider).then(() => { link.state = 'resolved'; }, (e) => { link.state = 'rejected'; link.error = e; });
  else {
    t.acct().openSignIn();
    await wait(t, () => t.a.find('#acct_provider_buttons .acct-prov-btn[data-provider="' + provider + '"]'), provider + ' button');
    t.click(t.a.find('#acct_provider_buttons .acct-prov-btn[data-provider="' + provider + '"]'));
  }
  if (o.stepup) {
    // a provider session has no step-up: the code step-up of WP-C1 asks for a code sent to the account address
    await wait(t, () => (t.el('acct_code') && srv.codeFor(o.stepup, 'code_stepup')) || link.state === 'rejected', 'the step-up code', { max: 30000, link: o.link ? link : null });
    if (link.state === 'rejected') throw new Error('linkProvider rejected before the step-up code: ' + ((link.error && (link.error.code || link.error.message)) || 'unknown'));
    t.a.input('acct_code', srv.codeFor(o.stepup, 'code_stepup')); t.click('acct_verify');
  }
  await wait(t, () => t.assigned.length > before || link.state === 'rejected', 'location.assign to ' + provider, { max: 30000, link: o.link ? link : null });
  if (link.state === 'rejected') throw new Error('linkProvider rejected: ' + ((link.error && (link.error.code || link.error.message)) || 'unknown'));
  const back = await t.br.visit(t.assigned[t.assigned.length - 1], { as });
  assert.strictEqual(back.status, 303);
  assert.strictEqual(back.location, srv.config.appUrl + '#acct-oauth', 'the constant return address');
  t.dispose();
  return device(srv, { browser: t.br, storage: t.storage, idb: t.idb, hash: '#acct-oauth', seed: false });
}

test.describe('Phase 1 end to end: page ↔ API ↔ database ↔ fake providers ↔ mail', { skip }, () => {
  test.before(async () => {
    H = await D.freshDatabase('e2e');
    api = H.as('wts_api'); jobs = H.as('wts_jobs');
  });
  test.after(async () => { if (H) await H.close(); });

  test('E1 e-mail sign-up, Save to cloud, open on a second device, history and restore, export', async () => {
    const srv = realServer();
    const email = 'e1.owner@company.example';
    const a = device(srv, { seed: true });
    const b = device(srv, { seed: { client: 'Local Co', well: 'Local-9' } });
    try {
      // sign up: code, consent naming the address, signed in; the hint never holds the address
      await a.signIn(email, { handover: 'later' });
      await signedIn(a, 'A signed in');
      const u = await userRow(email, srv.keys);
      assert(u && u.status === 'active' && u.signup_method === 'code', 'the account row');
      assert(!String(a.storage.getItem('wtsacct_hint')).includes(email), 'no address in the hint');
      assert(!u.email_enc.toString('latin1').includes(email), 'the address is encrypted at rest');
      // Save to cloud: one project, one revision; the parts are encrypted chunks in the blob store
      const r1 = await a.sync().saveToCloud({});
      assert.strictEqual(r1.rev, 1);
      const id = a.sync().status().projectId;
      const p = (await sql()`select * from wts.projects where user_id = ${u.id}`);
      assert.strictEqual(p.length, 1); assert.strictEqual(p[0].id, id);
      assert(!p[0].meta_enc.toString('latin1').includes('Operator Energy'), 'the project name is encrypted at rest');
      assert.strictEqual((await sql()`select count(*)::int as n from wts.revisions where project_id = ${id}`)[0].n, 1);
      // the second device: a code sign-in, Open from cloud → the same keys; its own local work kept in a safety copy
      await b.signIn(email, { handover: 'later' });
      await signedIn(b, 'B signed in');
      assert(srv.mail.sent.some((m) => m.to === email && m.template === 'notice_new_device'), 'a new-device notice to the owner');
      await b.sync().openFromCloud(id);
      assert.strictEqual(JSON.parse(b.storage.getItem('wts_page_hydrate')).f.hy_T, '38');
      assert.strictEqual(JSON.parse(b.storage.getItem('h2oil_client_info')).client, 'Operator Energy Ltd');
      const safety = await b.sync().local.safety();
      assert(safety && safety.length === 1 && JSON.stringify(safety[0].payload).includes('Local Co'), 'B\'s local work in the safety copy');
      // an edit on B, Save → revision 2; history lists both; restore revision 1 → revision 3 (reason restore) with the old value
      b.storage.setItem('wts_page_hydrate', JSON.stringify({ v: 1, t: 9, f: { hy_T: '41' } }));
      b.a.fire('document', 'wts:autosaved', {});
      const r2 = await b.sync().saveToCloud({});
      assert.strictEqual(r2.rev, 2);
      const hist = await b.sync().history(id);
      assert.deepStrictEqual(T.J(hist).map((x) => x.rev).sort(), [1, 2]);
      await b.sync().restoreRevision(id, 1);
      const revs = await sql()`select rev, reason from wts.revisions where project_id = ${id} order by rev`;
      assert.deepStrictEqual(revs.map((x) => [Number(x.rev), x.reason]), [[1, 'save'], [2, 'save'], [3, 'restore']]);
      // A opens the head: the restored value
      await a.sync().openFromCloud(id);
      assert.strictEqual(JSON.parse(a.storage.getItem('wts_page_hydrate')).f.hy_T, '38');
      // export everything: the account JSON (address, devices, audit) and the project files
      const out = await a.sync().exportAll();
      const acc = JSON.parse(out.files[0].text);
      assert.strictEqual(out.files[0].name, 'account.json');
      assert.strictEqual(acc.user.email, email);
      assert(acc.devices.length >= 2 && acc.audit.some((x) => x.action === 'signup'));
      assert(out.files.slice(1).some((f) => /^projects\/.+\.h2oilproj$/.test(f.name) && JSON.parse(f.text).format === 'h2oilproj'));
      assert(srv.mail.sent.some((m) => m.to === email && m.template === 'notice_export'), 'an export notice');
      // every mail carried the composed plain text, never a client string
      assert(srv.mail.sent.every((m) => !/Operator Energy|Local Co/.test(JSON.stringify(m))));
    } finally { a.dispose(); b.dispose(); }
  });

  test('E2 Google sign-up, link LinkedIn (step-up + link-confirm code), LinkedIn sign-in elsewhere, unlink, export', async () => {
    const srv = realServer();
    const gEmail = 'e2.person@' + CONSUMER;
    let t = device(srv, { seed: false });
    let other = null;
    try {
      // Google: a managed address → consent naming it → a new account; the provider session carries no step-up
      t = await providerTrip(srv, t, 'google', { key: 'e2-g', email: gEmail });
      await wait(t, () => t.a.find('#acct_oauth_create'), 'the consent step');
      assert(/e•••@/.test(t.a.find('.acct-oauth-consent').textContent), 'the consent names the new address');
      t.a.find('#acct_oauth_consent_ok').checked = true;
      t.click(t.a.find('#acct_oauth_create'));
      await signedIn(t, 'signed in with Google');
      assert.strictEqual(t.acct().state().authMethod, 'google');
      const u = await userRow(gEmail, srv.keys);
      assert(u && u.signup_method === 'google', 'a Google account');
      const sess = await sql()`select auth_method, stepup_at from wts.sessions where user_id = ${u.id}`;
      assert.deepStrictEqual(sess.map((x) => [x.auth_method, x.stepup_at]), [['google', null]], 'a provider session never sets stepup_at');
      // link LinkedIn from the account: start needs a step-up (a code to the account address), then the link-confirm code
      t = await providerTrip(srv, t, 'linkedin', { key: 'e2-li', email: 'e2.li@company.example' }, { link: true, stepup: gEmail });
      await wait(t, () => t.a.find('#acct_oauth_code'), 'the link-confirm code step');
      assert.strictEqual(t.a.find('.acct-oauth-msg').getAttribute('data-reason'), 'link_confirm');
      t.a.input('acct_oauth_code', srv.codeFor(gEmail, 'code_link_confirm'));
      t.click(t.a.find('#acct_oauth_verify'));
      await wait(t, () => t.a.find('.acct-oauth-linked'), 'linked');
      assert(srv.mail.sent.some((m) => m.to === gEmail && m.template === 'notice_identity_linked'), 'a link notice');
      const m1 = await t.acct().methods();
      assert.deepStrictEqual(T.J(m1.identities).map((x) => x.provider).sort(), ['google', 'linkedin']);
      // LinkedIn sign-in on another device: rule 1 (known identity) → the same account, no code
      other = device(srv, { seed: false });
      other = await providerTrip(srv, other, 'linkedin', { key: 'e2-li', email: 'e2.li@company.example' });
      await signedIn(other, 'signed in with LinkedIn');
      assert.strictEqual(other.acct().state().user.id, u.id, 'the same account');
      assert.strictEqual(other.acct().state().authMethod, 'linkedin');
      // unlink LinkedIn on the first device (its step-up is fresh): the session it opened is signed out
      const li = T.J(m1.identities).find((x) => x.provider === 'linkedin');
      const un = await t.acct().unlinkMethod(li.id);
      assert.strictEqual(un.sessionsRevoked, 1);
      await other.acct().refresh();
      assert.strictEqual(other.acct().state().status, 'signedOut', 'the LinkedIn session is gone');
      assert(srv.mail.sent.some((m) => m.to === gEmail && m.template === 'notice_identity_unlinked'), 'an unlink notice');
      // the export: the remaining identity with its full subject and the e-mail received at link time
      const out = await t.sync().exportAll();
      const acc = JSON.parse(out.files[0].text);
      assert.deepStrictEqual(T.J(acc.identities).map((x) => [x.provider, x.email, x.subject]), [['google', gEmail, srv.oidc.google.subjectFor('e2-g')]]);
      // the audit chain of the account verifies (request handlers and the definers write one chain)
      const v = await require('../core/jobs').auditVerify(sql());
      assert.deepStrictEqual([v.bad, v.broken], [[], []]);
    } finally { t.dispose(); if (other) other.dispose(); }
  });

  test('E3 public computer: sign in, save, sign out → no work left in the browser; the session is gone', async () => {
    const srv = realServer();
    const email = 'e3.rig@company.example';
    const t = device(srv, { seed: true });
    try {
      await t.signIn(email, { publicDevice: true, handover: 'upload' });
      await signedIn(t, 'signed in on a public computer');
      await wait(t, () => t.sync().status().projectId && t.sync().status().state === 'idle', 'the hand-over upload');
      assert.strictEqual(t.acct().state().publicDevice, true);
      const u = await userRow(email, srv.keys);
      const s0 = await sql()`select public_device, abs_expires_at - created_at as life from wts.sessions where user_id = ${u.id}`;
      assert.strictEqual(s0.length, 1); assert.strictEqual(s0[0].public_device, true);
      assert.strictEqual((await sql()`select count(*)::int as n from wts.projects where user_id = ${u.id}`)[0].n, 1, 'the work is in the cloud');
      let done = false;
      t.acct().signOut().then(() => { done = true; });
      await wait(t, () => done && t.acct().state().status === 'signedOut', 'signed out');
      const left = Object.keys(t.storage.__snapshot()).filter((k) => /^(wts_|h2oil_)/.test(k) && !/^(wts_unit_system|wts_ui_|wts_prism_sample_suppress|wts_prism_migrated)/.test(k));
      assert.deepStrictEqual(left, [], 'no project, library or client key left: ' + left.join(','));
      assert.strictEqual(t.storage.getItem('wtsacct_hint'), null);
      assert.strictEqual(t.storage.getItem('wtspref_shared_browser'), '1', 'the shared-browser flag is kept');
      assert.strictEqual(t.br.cookie('__Host-wts_sid'), null, 'the session cookie is cleared');
      assert.strictEqual((await sql()`select count(*)::int as n from wts.sessions where user_id = ${u.id}`)[0].n, 0, 'the session row is gone');
    } finally { t.dispose(); }
  });

  test('E7 the built page without an appVer seam: X-WTS-App is the page\'s own version and a save works with the default server config', async () => {
    const srv = realServer();
    assert.strictEqual(srv.config.minClient, '', 'no security minimum by default (raised only for a security fix, §3.2)');
    const email = 'e7.version@company.example';
    const t = device(srv, { seed: true });
    try {
      t.acct().configure({ appVer: '' });                  // the page's own version (the label under the logo)
      const label = /(\d+\.\d+(?:\.\d+)?)/.exec(t.text('appVersionLabel') || '');
      assert(label, 'the version label');
      assert.strictEqual(t.acct()._i.appVer(), label[1], 'appVer() follows the label');
      await t.signIn(email, { handover: 'later' });
      await signedIn(t);
      const r = await t.sync().saveToCloud({});
      assert.strictEqual(r.rev, 1, 'the save went through: ' + JSON.stringify(r));
      const u = await userRow(email, srv.keys);
      assert.strictEqual((await sql()`select count(*)::int as n from wts.projects where user_id = ${u.id} and head_rev = 1`)[0].n, 1);
    } finally { t.dispose(); }
  });

  test('E4 delete with the 7-day grace: signed out, identities released, Cancel deletion after a sign-in; after the grace the daily job purges', async () => {
    const srv = realServer();
    const email = 'e4.leaver@company.example';
    let t = device(srv, { seed: true });
    try {
      await t.signIn(email, { handover: 'upload' });
      await signedIn(t, 'signed in');
      await wait(t, () => t.sync().status().projectId && t.sync().status().state === 'idle', 'the hand-over upload');
      const u = await userRow(email, srv.keys);
      // a Google identity linked from the account (the code session's step-up is fresh: no step-up dialog)
      t = await providerTrip(srv, t, 'google', { key: 'e4-g', email: 'e4.leaver@' + CONSUMER }, { link: true });
      await wait(t, () => t.a.find('#acct_oauth_code'), 'the link-confirm code step');
      t.a.input('acct_oauth_code', srv.codeFor(email, 'code_link_confirm')); t.click(t.a.find('#acct_oauth_verify'));
      await wait(t, () => t.a.find('.acct-oauth-linked'), 'linked');
      t.click(t.a.find('#acct_oauth_close'));
      await signedIn(t, 'still signed in after the link');
      assert.strictEqual((await sql()`select count(*)::int as n from wts.identities where user_id = ${u.id}`)[0].n, 1);
      // the account page: Delete account, typed confirmation → deleting, signed out, identities released at the request
      t.w.WTS_accountPage.open();
      await wait(t, () => t.el('acct_delete'), 'the account page');
      t.click('acct_delete');
      await wait(t, () => t.el('acct_delete_confirm'), 'the confirmation');
      t.a.input('acct_delete_confirm', 'DELETE');
      t.click('acct_ch_delete');
      await wait(t, () => t.acct().state().status === 'signedOut', 'signed out');
      let row = await userRow(email, srv.keys);
      assert.strictEqual(row.status, 'deleting');
      assert(+row.delete_at - Date.now() > 6.9 * 86400e3, 'the 7-day grace');
      assert.strictEqual((await sql()`select count(*)::int as n from wts.identities where user_id = ${u.id}`)[0].n, 0, 'identities released');
      assert.strictEqual((await sql()`select count(*)::int as n from wts.sessions where user_id = ${u.id}`)[0].n, 0, 'every session revoked');
      assert(srv.mail.sent.some((m) => m.to === email && m.template === 'notice_delete_requested'));
      // a sign-in during the grace reaches only Cancel deletion
      await t.signIn(email, {});
      await wait(t, () => t.acct().state().status === 'signedIn' && t.el('acct_bar_cancel_del'), 'the deletion bar');
      t.click('acct_bar_cancel_del');
      await wait(t, () => !t.el('acct_bar_cancel_del'), 'cancelled');
      row = await userRow(email, srv.keys);
      assert.strictEqual(row.status, 'active');
      // delete again and let the grace pass: the daily job (its own credential) purges the account and writes the ledger
      await t.acct().call('POST', '/account/delete', { confirm: 'DELETE' });
      await sql()`update wts.users set delete_at = now() - interval '1 minute' where id = ${u.id}`;
      const sum = await runDaily({ db: jobs, keys: srv.keys, objects: srv.objects, mail: srv.mail, log: { info() {}, warn() {} } });
      assert(sum.accounts && sum.accounts.purged >= 1, 'purged: ' + JSON.stringify(sum.accounts));
      assert.strictEqual(await userRow(email, srv.keys), null, 'the account row is gone');
      for (const tb of ['projects', 'revisions', 'devices', 'sessions']) {
        assert.strictEqual((await sql().unsafe('select count(*)::int as n from wts.' + tb + ' where ' + (tb === 'revisions' ? 'project_id in (select id from wts.projects where user_id = $1)' : 'user_id = $1'), [u.id]))[0].n, 0, tb);
      }
      assert((await srv.objects.list('ledger/')).includes('ledger/' + u.id), 'the ledger object outside the database');
      assert.deepStrictEqual(await srv.objects.list('u/' + u.id + '/'), [], 'no blob of the account left');
      assert(srv.mail.sent.some((m) => m.to === email && m.template === 'notice_delete_done'));
    } finally { t.dispose(); }
  });

  test('E5 the local dev server over HTTP: code sign-up from a localhost page origin, /me, sign-out', async () => {
    const http = require('http');
    const { start } = require('../dev');
    const env = { WTS_ENV: 'local', ACCOUNTS_SIGNUP: 'open', SYNC_MODE: 'on', WTS_DEV_ORIGIN: 'http://localhost:8080',
      WTS_TERMS_VERSION: '1', WTS_PRIVACY_VERSION: '1', WTS_INDEX_PEPPER: key32(), WTS_MASTER_KEYS: '1:' + key32(), WTS_MASTER_KID: '1', WTS_CODE_PEPPERS: '1:' + key32() };
    const config = loadConfig(env);
    const mail = memoryTransport();
    const srv = await start({ config, db: api, mail, port: 0 });
    let cookie = '';
    function req(method, p, body) {
      return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const headers = { Host: '127.0.0.1:' + srv.port, Origin: 'http://localhost:8080', 'X-WTS-Req': '1' };
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
        if (cookie) headers.Cookie = cookie;
        const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/v1' + p, method, headers }, (res) => {
          const chunks = []; res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            (res.headers['set-cookie'] || []).forEach((c) => { const nv = c.split(';')[0]; if (/=$/.test(nv) || /Max-Age=0/.test(c)) cookie = ''; else cookie = nv; });
            const txt = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, json: txt ? JSON.parse(txt) : null, headers: res.headers });
          });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
      });
    }
    try {
      const email = 'e6.local@company.example';
      assert.strictEqual((await req('POST', '/auth/code/start', { email, purpose: 'signin' })).status, 202);
      await srv.app.idle();
      const code = mail.codeFor(email, 'code_signin');
      assert(/^\d{8}$/.test(code), 'the code mail went to the transport');
      const v = await req('POST', '/auth/code/verify', { email, code, publicDevice: false, consent: { terms: '1', privacy: '1' } });
      assert.strictEqual(v.status, 200, JSON.stringify(v.json));
      assert.strictEqual(v.json.firstSignIn, true);
      assert(/^__Host-wts_sid=/.test(cookie), 'the session cookie');
      const me = await req('GET', '/me');
      assert.strictEqual(me.status, 200); assert.strictEqual(me.json.user.id, v.json.user.id);
      assert.strictEqual(me.headers['cache-control'], 'no-store');
      assert.strictEqual((await req('POST', '/auth/signout', {})).status, 200);
      assert.strictEqual((await req('GET', '/me')).json.error, 'signed_out');
      // another origin is refused before any work
      cookie = '';
      const bad = await new Promise((resolve) => {
        const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/v1/auth/code/start', method: 'POST',
          headers: { Host: '127.0.0.1:' + srv.port, Origin: 'http://evil.example', 'X-WTS-Req': '1', 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        r.end(JSON.stringify({ email, purpose: 'signin' }));
      });
      assert.strictEqual(bad, 403);
    } finally { await srv.close(); }
  });

  test('E6 no server configured: the page behaves as v3.4 (no chip, no request); the iOS bundle carries none of it', async () => {
    // the live site today: production host, no beta flag, nothing answering /api/v1 (a static host's page fallback)
    const calls = [];
    const fetch = (u) => { calls.push(String(u)); return Promise.resolve({ status: 200, ok: true, headers: { get: () => 'text/html' }, json: () => Promise.reject(new Error('html')), text: () => Promise.resolve('<html>') }); };
    const app = harness.loadApp({ fromSources: true, console: 'capture', timers: 'manual', globals: { fetch, location: F.prodLocation() } });
    try {
      app.flush(10000);
      assert.strictEqual(app.win.WTS_account.eligible, true, 'the guard admits the production host');
      assert.strictEqual(calls.filter((u) => u.includes('/api/v1')).length, 0, 'no request to the API');
      for (const id of ['acct_chip', 'acct_dlg_ov', 'wts_sync_bar', 'acct_css']) assert.strictEqual(app.el(id), null, 'no ' + id);
      assert(!app.win.WTS_calcRegistry || !app.win.WTS_calcRegistry.account, 'the account page is not registered');
    } finally { app.dispose(); }
    // the iOS bundle of this build: the real sync script strips every account block
    const html = harness.buildFromSources({ silent: true }).html;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ios-'));
    try {
      const src = path.join(tmp, 'main.html'); fs.writeFileSync(src, html);
      const out = path.join(tmp, 'www'); fs.mkdirSync(out);
      const r = cp.spawnSync(process.execPath, [path.join(REPO, 'ios-app', 'scripts', 'sync-from-main.js')], { encoding: 'utf8', timeout: 180000,
        env: Object.assign({}, process.env, { WTS_SYNC_MAIN_HTML: src, WTS_SYNC_OUT_DIR: out, WTS_SYNC_HELP_DIR: path.join(tmp, 'no-help') }) });
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      const ios = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
      for (const s of ['WTS_account', 'WTS_cloudSync', 'WTS_accountPage', '/api/v1', '/auth/oauth', 'acct_dlg', 'wtsacct_', 'LinkedIn']) assert(!ios.includes(s), 'iOS: no ' + s);
      assert(html.includes('WTS_account') && html.includes('/api/v1'), 'the web build carries the account code');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
