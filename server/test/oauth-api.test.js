'use strict';
// server/test/oauth-api.test.js — provider sign-in through the REAL pipeline (core/app.js), the REAL handlers
// (functions/oauth.js) and a freshly migrated database (docs/ACCOUNTS-PLAN.md §3.3, §4.10–4.14, §8.3, §12.4), with the fake
// OpenID providers of test/fake-oidc.js. Skips without the throwaway cluster (run through server/test/run.js).
//
// WP-S1 definer bodies that are still WP0 stubs (resolve_session, create_user, codes, …) are filled for these tests only by
// test/_s1-shim.js; it does nothing once WP-S1's bodies are migrated.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const D = require('./_db');
const C = require('../core/contract');
const { createApp } = require('../core/app');
const { loadConfig } = require('../core/config');
const { createDb } = require('../core/db');
const { memoryTransport } = require('../core/mail');
const { createFakeOidc } = require('./fake-oidc');
const { applyS1Shim } = require('./_s1-shim');
const S1 = require('../core/wpo-s1');
const { createOauthHandlers } = require('../functions/oauth');
const baseHandlers = require('../functions').handlers;

const PROD = 'https://welltest.h2oil.co.uk';
const HOST = 'welltest.h2oil.co.uk';
const MIN = 60 * 1000;
const key32 = () => crypto.randomBytes(32).toString('base64');
const skip = !D.available() && 'no throwaway database (run through server/test/run.js)';

let H = null; let api = null;
const SECRETS = { WTS_INDEX_PEPPER: key32(), WTS_MASTER_KEYS: '1:' + key32(), WTS_MASTER_KID: '1', WTS_CODE_PEPPERS: '1:' + key32() };

// one test environment: config + fake providers + app; `env` overrides switches
function makeEnv(o) {
  o = o || {};
  const g = createFakeOidc({ provider: 'google' });
  const l = createFakeOidc({ provider: 'linkedin', enforcePkce: true });
  const env = Object.assign({ WTS_ENV: 'test', ACCOUNTS_SIGNUP: 'open', OAUTH_GOOGLE: 'on', OAUTH_LINKEDIN: 'on',
    OAUTH_GOOGLE_CLIENT_ID: g.clientId, OAUTH_GOOGLE_CLIENT_SECRET: g.clientSecret,
    OAUTH_LINKEDIN_CLIENT_ID: l.clientId, OAUTH_LINKEDIN_CLIENT_SECRET: l.clientSecret, WTS_TERMS_VERSION: '1', WTS_PRIVACY_VERSION: '1' }, SECRETS, o.env || {});
  const config = loadConfig(env);
  const mail = memoryTransport();
  const logs = [];
  const dbg = (m) => { if (process.env.WPO_DEBUG) process.stderr.write('[log] ' + m + '\n'); };
  const log = { info: (m) => { dbg(m); logs.push(String(m)); }, warn: (m) => { dbg(m); logs.push(String(m)); } };
  const fetch = (url, init) => (String(url).startsWith('https://google.') ? g : l).fetch(url, init);
  const oauth = createOauthHandlers({ fetch, override: { google: g.override, linkedin: l.override } });
  const app = createApp({ config, db: api, mail, log, handlers: Object.assign({}, baseHandlers, oauth) });
  const ctxLike = { db: api, config, cookies: {}, req: { headers: {} }, ipPrefix: null, log, mail, setCookie() {} };
  return { g, l, config, mail, logs, app, op: { google: g, linkedin: l }, ctxLike };
}

// a browser: cookie jar with SameSite; same-origin calls send every cookie, the provider's cross-site return only Lax ones
function browser(E, ip) {
  const jar = new Map();
  function apply(setCookies) {
    for (const sc of setCookies || []) {
      const [nv, ...attrs] = sc.split(';').map((s) => s.trim());
      const i = nv.indexOf('='); const name = nv.slice(0, i); const value = nv.slice(i + 1);
      const a = {}; attrs.forEach((x) => { const [k, v] = x.split('='); a[k.toLowerCase()] = v === undefined ? true : v; });
      if (a['max-age'] === '0') jar.delete(name); else jar.set(name, { value, sameSite: a.samesite, raw: sc });
    }
  }
  const cookieHeader = (lax) => Array.from(jar.entries()).filter(([, c]) => !lax || c.sameSite === 'Lax').map(([n, c]) => n + '=' + c.value).join('; ');
  async function call(method, path, body, o2) {
    o2 = o2 || {};
    const headers = { host: HOST };
    const ck = cookieHeader(false); if (ck) headers.cookie = ck;
    if (method !== 'GET') Object.assign(headers, { origin: o2.origin === undefined ? PROD : o2.origin, 'x-wts-req': '1', 'content-type': 'application/json' });
    if (o2.origin === null) delete headers.origin;
    const r = await E.app.handle({ method, url: C.BASE + path, headers, body: method === 'GET' ? null : Buffer.from(JSON.stringify(body || {})), remoteAddress: ip || '198.51.100.7' });
    apply(r.cookies);
    return { status: r.status, json: r.body ? JSON.parse(r.body) : null, cookies: r.cookies, headers: r.headers };
  }
  // the provider round trip of location.assign(url): authorize at the fake, then the cross-site callback (Lax cookies only)
  async function visit(url, as) {
    const p = url.startsWith('https://google.') ? 'google' : 'linkedin';
    const a = as && (as.cancel || as.error || as.user) ? as : { user: as || {} };
    const back = new URL(E.op[p].authorize(url, a));
    const headers = { host: HOST };
    const ck = cookieHeader(true); if (ck) headers.cookie = ck;
    const r = await E.app.handle({ method: 'GET', url: back.pathname + back.search, headers, body: null, remoteAddress: ip || '198.51.100.7' });
    apply(r.cookies);
    return { status: r.status, location: r.headers.Location, cookies: r.cookies, url: back.toString() };
  }
  return { jar, call, visit, cookie: (n) => (jar.get(n) || {}).value, setCookie: (n, v, ss) => jar.set(n, { value: v, sameSite: ss || 'Strict' }) };
}
const start = (br, p, o) => br.call('POST', '/auth/oauth/' + p + '/start', Object.assign({ purpose: 'signin', publicDevice: false }, o || {}));
const finish = (br, body) => br.call('POST', '/auth/oauth/finish', body || {});
async function round(E, br, p, as, o) {
  const s = await start(br, p, o);
  assert.strictEqual(s.status, 200, 'start: ' + JSON.stringify(s.json));
  const v = await br.visit(s.json.url, as);
  assert.strictEqual(v.status, 303);
  return finish(br);
}
const okFinish = (r) => { const c = C.checkShape('FinishRes', r.json); assert(c.ok, JSON.stringify(c.errors.concat([r.json]))); return r.json; };
const CONSUMER = require('../core/oidc-providers').CONFIG.google.consumerDomains[0];
const consumer = (E, name) => name + '@' + CONSUMER;
const codeFor = (E, email, tpl) => E.mail.codeFor(email, tpl);
async function sessionRow(sid) { return (await H.admin.sql`select * from wts.sessions where sid_hash = ${S1.sidHash(sid)}`)[0] || null; }
// an account created the e-mail-code way (WP-S1 path), and a code session for it in a browser
async function codeAccount(E, email) { return S1.createUser(E.ctxLike, { email, method: 'code' }); }
async function codeSession(br, userId, o) {
  o = o || {};
  const sid = crypto.randomBytes(32).toString('base64url');
  await H.admin.sql`insert into wts.sessions (sid_hash, user_id, public_device, created_at, auth_at, stepup_at, last_seen_at, idle_expires_at, abs_expires_at, auth_method)
    values (${S1.sidHash(sid)}, ${userId}, false, now(), now(), ${o.stepup === false ? null : new Date()}, now(), now() + interval '1 day', now() + interval '2 days', 'code')`;
  br.setCookie('__Host-wts_sid', sid, 'Strict');
  return sid;
}
async function age(cookieless, minutes) {
  const iv = minutes + ' minutes';
  await H.admin.sql`update wts.oauth_attempts set created_at = created_at - ${iv}::interval, expires_at = expires_at - ${iv}::interval,
    used_at = used_at - ${iv}::interval where finished_at is null`;
  await H.admin.sql`update wts.email_codes set expires_at = expires_at - ${iv}::interval where used_at is null`;
}

test.describe('provider sign-in API (§4.10–4.14)', { skip }, () => {
  test.before(async () => {
    H = await D.freshDatabase('oauth');
    await applyS1Shim(H.admin);
    api = H.as('wts_api');
  });
  test.after(async () => { if (H) await H.close(); });
  test.beforeEach(async () => {
    await H.admin.sql`truncate wts.users, wts.oauth_attempts, wts.oidc_keys, wts.email_codes, wts.rate_counters, wts.signup_allowlist, wts.mail_outbox cascade`;
  });

  test('GET /auth/providers: switches, signin label, breaker; no cookie needed', async () => {
    const E = makeEnv({ env: { OAUTH_LINKEDIN: 'signin' } });
    const r = await browser(E).call('GET', '/auth/providers');
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json, { google: 'on', linkedin: 'signin' });
    assert.strictEqual(r.headers['Cache-Control'], 'no-store');
    const off = makeEnv({ env: { OAUTH_GOOGLE: 'off', OAUTH_LINKEDIN_CLIENT_SECRET: '' } });
    assert.deepStrictEqual((await browser(off).call('GET', '/auth/providers')).json, { google: 'off', linkedin: 'off' }, 'off; a missing secret is off');
    await H.admin.sql`insert into wts.rate_counters (bucket, window_start, n) values ('oauth_brk_open:google', now() + interval '5 minutes', 1)`;
    assert.deepStrictEqual((await browser(E).call('GET', '/auth/providers')).json, { google: 'off', linkedin: 'signin' }, 'breaker open → off');
    assert.strictEqual((await start(browser(E), 'google')).json.error, 'provider_off');
  });

  test('start: header rules, the Lax attempt cookie, the authorization URL, one live attempt per browser', async () => {
    const E = makeEnv();
    const br = browser(E);
    assert.strictEqual((await br.call('POST', '/auth/oauth/google/start', { purpose: 'signin', publicDevice: false }, { origin: null })).json.error, 'origin');
    assert.strictEqual((await br.call('POST', '/auth/oauth/google/start', { purpose: 'signin', publicDevice: false }, { origin: 'https://evil.example' })).json.error, 'origin');
    const s = await start(br, 'google');
    assert.strictEqual(s.status, 200);
    assert(C.checkShape('OAuthStartRes', s.json).ok);
    const sc = s.cookies.find((c) => c.startsWith('__Host-wts_oa='));
    assert.match(sc, /^__Host-wts_oa=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    assert(!s.cookies.some((c) => c.startsWith('__Host-wts_sid')));
    const u = new URL(s.json.url); const q = Object.fromEntries(u.searchParams);
    assert.strictEqual(u.origin + u.pathname, E.g.authorizationEndpoint);
    assert.strictEqual(q.redirect_uri, PROD + '/api/v1/auth/oauth/google/callback');
    assert.strictEqual(q.code_challenge_method, 'S256'); assert.strictEqual(q.prompt, 'select_account');
    assert(q.state.length >= 43 && q.nonce.length >= 43);
    const row = (await H.admin.sql`select * from wts.oauth_attempts`)[0];
    assert(!row.state_hash.equals(Buffer.from(q.state)), 'only the hash of state is stored');
    assert(!row.pkce_verifier_enc.toString().includes(q.code_challenge), 'the verifier is stored encrypted');
    // a new start replaces the earlier attempt: the first URL no longer completes
    const s2 = await start(br, 'google');
    const v1 = await br.visit(s.json.url, { key: 'u1', email: consumer(E, 'a') });
    assert.strictEqual(v1.location, PROD + '/#acct-oauth');
    assert.strictEqual((await finish(br)).json.error, 'oauth_state', 'the replaced attempt is dead');
    assert(s2.json.url);
    // fresh login: Google prompt=login + max_age=0; LinkedIn refused (no forced login pinned)
    const f = Object.fromEntries(new URL((await start(br, 'google', { publicDevice: true })).json.url).searchParams);
    assert.strictEqual(f.prompt, 'login'); assert.strictEqual(f.max_age, '0');
    const f2 = Object.fromEntries(new URL((await start(br, 'google', { sharedBrowser: true })).json.url).searchParams);
    assert.strictEqual(f2.prompt, 'login', 'the shared-browser flag makes a fresh-login attempt');
    const li = await start(br, 'linkedin', { publicDevice: true });
    assert.strictEqual(li.status, 400); assert.deepStrictEqual([li.json.error, li.json.reason], ['oauth_failed', 'reauth_stale']);
    assert.strictEqual((await br.call('POST', '/auth/oauth/other/start', { purpose: 'signin', publicDevice: false })).status, 404);
  });

  test('callback: constant 303, never the session cookie; missing / foreign cookie, bad state, other path, expiry, replays', async () => {
    const E = makeEnv();
    const br = browser(E);
    const s = await start(br, 'google');
    // open-redirect payloads and junk: always the constant Location, nothing in the URL
    for (const qs of ['?code=x&state=y&redirect_uri=https://evil.example', '?next=//evil.example', '?error=x&error_description=%3Cscript%3E', '']) {
      const r = await E.app.handle({ method: 'GET', url: '/api/v1/auth/oauth/google/callback' + qs, headers: { host: HOST }, body: null, remoteAddress: '198.51.100.7' });
      assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.Location, PROD + '/#acct-oauth'); assert.strictEqual(r.headers['Referrer-Policy'], 'no-referrer');
      assert.deepStrictEqual(r.cookies, []);
    }
    // bad state / other provider path: the attempt is untouched (still usable)
    const cb = new URL(E.g.authorize(s.json.url, { user: { key: 'u1', email: consumer(E, 'a') } }));
    const withCookie = (path) => E.app.handle({ method: 'GET', url: path, headers: { host: HOST, cookie: '__Host-wts_oa=' + br.cookie('__Host-wts_oa') }, body: null, remoteAddress: '198.51.100.7' });
    await withCookie(cb.pathname + cb.search.replace(/state=[^&]+/, 'state=wrong'));
    await withCookie('/api/v1/auth/oauth/linkedin/callback' + cb.search);
    assert.strictEqual((await H.admin.sql`select count(*)::int as n from wts.oauth_attempts where used_at is not null`)[0].n, 0);
    // a foreign browser presenting the URL without the cookie gets nothing
    const other = browser(E);
    const ro = await E.app.handle({ method: 'GET', url: cb.pathname + cb.search, headers: { host: HOST }, body: null, remoteAddress: '203.0.113.9' });
    assert.strictEqual(ro.status, 303);
    assert.strictEqual((await finish(other)).json.error, 'oauth_state');
    // the real return: burnt before the exchange; never a session cookie on the callback
    const r = await withCookie(cb.pathname + cb.search);
    assert.strictEqual(r.status, 303); assert(!r.cookies.some((c) => /wts_sid/.test(c)), 'the callback never sets the session cookie');
    const tokenCalls = E.g.calls.token;
    await withCookie(cb.pathname + cb.search);                                     // replayed callback
    assert.strictEqual(E.g.calls.token, tokenCalls, 'a replayed callback never reaches the token endpoint');
    // replayed code in a fresh attempt of an attacker: the provider refuses the used code → token
    const atk = browser(E, '203.0.113.10');
    const sa = await start(atk, 'google');
    const st = new URL(sa.json.url).searchParams.get('state');
    await E.app.handle({ method: 'GET', url: '/api/v1/auth/oauth/google/callback?code=' + cb.searchParams.get('code') + '&state=' + st + '&iss=' + encodeURIComponent(E.g.issuer),
      headers: { host: HOST, cookie: '__Host-wts_oa=' + atk.cookie('__Host-wts_oa') }, body: null, remoteAddress: '203.0.113.10' });
    const fa = await finish(atk);
    assert.deepStrictEqual([fa.json.error, fa.json.reason], ['oauth_failed', 'token'], 'a replayed code fails');
    // the legitimate browser finishes
    assert.strictEqual(okFinish(await finish(br)).next, 'consent');
    // expiry: a callback more than 10 minutes after the start finds nothing
    const br2 = browser(E);
    const s2 = await start(br2, 'google');
    await H.admin.sql`update wts.oauth_attempts set expires_at = now() - interval '1 second', created_at = now() - interval '11 minutes' where used_at is null`;
    await br2.visit(s2.json.url, { key: 'u2', email: consumer(E, 'b') });
    assert.strictEqual((await finish(br2)).json.error, 'oauth_state');
  });

  test('provider error, callback iss mismatch, token endpoint failure, id_token faults → oauth_failed with the reason', async () => {
    const E = makeEnv();
    const br = browser(E);
    let s = await start(br, 'google');
    await br.visit(s.json.url, { cancel: true });
    let f = await finish(br);
    assert.deepStrictEqual([f.status, f.json.error, f.json.reason], [400, 'oauth_failed', 'cancelled']);
    assert(!E.logs.join('\n').includes('script'), 'error_description is never logged');
    s = await start(br, 'linkedin');
    await br.visit(s.json.url, { error: 'something_new' });
    f = await finish(br);
    assert.strictEqual(f.json.reason, 'provider');
    assert(E.logs.some((m) => /provider error unknown/.test(m)) && !E.logs.join('\n').includes('something_new'), 'unknown codes are logged only as unknown');
    // iss on the callback must equal the configured issuer (mix-up defence)
    s = await start(br, 'google');
    const cb = new URL(E.g.authorize(s.json.url, { user: { key: 'k', email: consumer(E, 'c') } }));
    cb.searchParams.set('iss', 'https://other.idp.test');
    await E.app.handle({ method: 'GET', url: cb.pathname + cb.search, headers: { host: HOST, cookie: '__Host-wts_oa=' + br.cookie('__Host-wts_oa') }, body: null, remoteAddress: '198.51.100.7' });
    assert.strictEqual((await finish(br)).json.reason, 'provider');
    for (const [fault, reason] of [['token_5xx', 'provider'], ['token_400', 'token'], ['iss', 'token'], ['alg_none', 'token'], ['hs256', 'token'], ['nonce', 'token'], ['aud_extra', 'token']]) {
      E.g.setFault(fault);
      f = await round(E, br, 'google', { key: 'k', email: consumer(E, 'c') });
      assert.deepStrictEqual([f.json.error, f.json.reason], ['oauth_failed', reason], fault);
    }
    E.g.setFault(null);
    // the attempt cookie is cleared when a finish fails
    assert.strictEqual(br.cookie('__Host-wts_oa'), undefined);
  });

  test('rule 3: a Google-managed address → consent (names the address) → account, provider session without step-up', async () => {
    const E = makeEnv();
    const br = browser(E);
    const email = consumer(E, 'new.user');
    const c = okFinish(await round(E, br, 'google', { key: 'u3', email }));
    assert.strictEqual(c.next, 'consent'); assert.strictEqual(c.newAccountEmailMasked, 'n•••@' + email.split('@')[1]);
    const sc = br.jar.get('__Host-wts_oa');
    assert.strictEqual(sc.sameSite, 'Strict', 'the attempt cookie is re-issued Strict for the next step');
    assert.strictEqual((await H.admin.sql`select count(*)::int as n from wts.users`)[0].n, 0, 'nothing is created before consent');
    const stale = await finish(br, { consent: { terms: '0', privacy: '1' } });
    assert.deepStrictEqual([stale.status, stale.json.error], [409, 'consent_required']);
    const d = okFinish(await finish(br, { consent: { terms: '1', privacy: '1' } }));
    assert.strictEqual(d.next, 'done'); assert.strictEqual(d.firstSignIn, true); assert.strictEqual(d.method, 'google');
    const sid = br.cookie('__Host-wts_sid');
    assert(sid, 'the session cookie comes from finish');
    const s = await sessionRow(sid);
    assert.strictEqual(s.auth_method, 'google'); assert.strictEqual(s.stepup_at, null, 'a provider sign-in never sets stepup_at');
    assert(s.identity_id);
    const u = (await H.admin.sql`select signup_method from wts.users`)[0];
    assert.strictEqual(u.signup_method, 'google');
    const idn = (await H.admin.sql`select * from wts.identities`)[0];
    assert.strictEqual(idn.linked_via, 'signup'); assert.strictEqual(idn.email_verified_at_link, true);
    assert(!idn.subject_enc.toString().includes(E.g.subjectFor('u3')), 'the subject is stored encrypted');
    assert.strictEqual(br.cookie('__Host-wts_oa'), undefined, 'the attempt cookie is cleared at the end');
    const aud = await H.admin.sql`select action, detail from wts.audit order by id`;
    assert(aud.some((x) => x.action === 'identity_link' && x.detail.subject_bidx && !JSON.stringify(x.detail).includes('@')), 'link audited with the subject index only');
    // rule 1: signs in again with no mail and no code
    const n = E.mail.sent.length;
    const b2 = browser(E);
    const again = okFinish(await round(E, b2, 'google', { key: 'u3', email }));
    assert.strictEqual(again.next, 'done'); assert.strictEqual(again.firstSignIn, false); assert.strictEqual(again.providerEmailDiffers, false);
    assert.strictEqual(E.mail.sent.filter((m) => /^code_/.test(m.template)).length, 0, 'no code mail at all');
    assert(E.mail.sent.length >= n);
    // the provider e-mail changed: said once per new address (U18); the account e-mail never follows
    const moved = okFinish(await round(E, browser(E), 'google', { key: 'u3', sub: E.g.subjectFor('u3'), email: consumer(E, 'renamed') }));
    assert.strictEqual(moved.providerEmailDiffers, true);
    assert.strictEqual(moved.user.emailMasked, again.user.emailMasked);
    assert.strictEqual(okFinish(await round(E, browser(E), 'google', { key: 'u3', sub: E.g.subjectFor('u3'), email: consumer(E, 'renamed') })).providerEmailDiffers, false, 'once per address');
    // step-up actions from a provider session answer reauth
    assert.strictEqual((await br.call('POST', '/auth/methods/unlink', { id: idn.id })).json.error, 'reauth');
    assert.strictEqual((await start(br, 'linkedin', { purpose: 'link' })).json.error, 'reauth');
    assert.strictEqual((await br.call('GET', '/auth/methods')).status, 200, 'reading methods needs no step-up');
  });

  test('rule 4 (U15): an account already uses the managed address → code to that address; never linked without it; stepup set', async () => {
    const E = makeEnv();
    const email = consumer(E, 'existing');
    const uid = await codeAccount(E, email);
    const br = browser(E);
    const c = okFinish(await round(E, br, 'google', { key: 'u4', email }));
    assert.deepStrictEqual([c.next, c.reason], ['code', 'link_existing']);
    assert.strictEqual(E.mail.last(email).template, 'code_oauth_verify');
    assert.strictEqual((await H.admin.sql`select count(*)::int as n from wts.identities`)[0].n, 0, 'not linked before the code');
    const bad = await finish(br, { code: '00000000' });
    assert.deepStrictEqual([bad.status, bad.json.error], [400, 'invalid_or_expired']);
    const d = okFinish(await finish(br, { code: codeFor(E, email, 'code_oauth_verify') }));
    assert.strictEqual(d.next, 'done'); assert.strictEqual(d.user.id, uid);
    const s = await sessionRow(br.cookie('__Host-wts_sid'));
    assert(s.stepup_at, 'the oauth_verify code to the account address sets stepup_at');
    const i = (await H.admin.sql`select linked_via from wts.identities`)[0];
    assert.strictEqual(i.linked_via, 'code_confirm');
    assert(E.mail.sent.some((m) => m.to === email && m.template === 'notice_identity_linked'), 'link notice to the account address');
    // a code bound to one attempt cannot finish another
    const b2 = browser(E); const b3 = browser(E, '203.0.113.5');
    await codeAccount(E, consumer(E, 'other'));
    okFinish(await round(E, b2, 'google', { key: 'u5', email: consumer(E, 'other') }));
    okFinish(await round(E, b3, 'google', { key: 'u6', email: consumer(E, 'other') }));
    const codes = E.mail.sent.filter((m) => m.to === consumer(E, 'other') && m.template === 'code_oauth_verify').map((m) => m.params.code);
    assert.strictEqual((await finish(b3, { code: codes[0] })).json.error, 'invalid_or_expired', 'the code of the other attempt');
  });

  test('rule 5: Google on an unmanaged domain, hd, LinkedIn — e-mail step, code, then link or consent', async () => {
    const E = makeEnv();
    const br = browser(E);
    const e = okFinish(await round(E, br, 'google', { key: 'u7', email: 'name@company.example' }));
    assert.deepStrictEqual([e.next, e.reason, e.emailPrefill], ['email', 'unmanaged', 'name@company.example'], 'verified but unmanaged: never straight to an account');
    const c = okFinish(await finish(br, { email: 'name@company.example' }));
    assert.deepStrictEqual([c.next, c.reason], ['code', 'verify']);
    const consent = okFinish(await finish(br, { code: codeFor(E, 'name@company.example') }));
    assert.strictEqual(consent.next, 'consent');
    const d = okFinish(await finish(br, { consent: { terms: '1', privacy: '1' } }));
    assert.strictEqual(d.next, 'done');
    assert((await sessionRow(br.cookie('__Host-wts_sid'))).stepup_at, 'our code proved the address');
    // matching hd → trusted
    const hd = okFinish(await round(E, browser(E), 'google', { key: 'u8', email: 'boss@corp.example', hd: 'corp.example' }));
    assert.strictEqual(hd.next, 'consent');
    // LinkedIn: always our code; an address an account uses is linked after the code (uniform: always next code)
    const uid = await codeAccount(E, 'li.user@company.example');
    const lb = browser(E);
    const le = okFinish(await round(E, lb, 'linkedin', { key: 'l1', email: 'li.user@company.example' }));
    assert.deepStrictEqual([le.next, le.reason], ['email', 'unmanaged']);
    okFinish(await finish(lb, { email: 'li.user@company.example' }));
    const ld = okFinish(await finish(lb, { code: codeFor(E, 'li.user@company.example') }));
    assert.strictEqual(ld.user.id, uid); assert.strictEqual(ld.method, 'linkedin');
    // no e-mail at all → reason missing; an unverified one → unverified
    E.l.setFault('no_email');
    assert.strictEqual(okFinish(await round(E, browser(E), 'linkedin', { key: 'l2' })).reason, 'missing');
    E.l.setFault(null);
    E.g.setFault('ev_false');
    assert.strictEqual(okFinish(await round(E, browser(E), 'google', { key: 'g9', email: consumer(E, 'unv') })).reason, 'unverified');
    E.g.setFault(null);
    // steps out of order
    const bo = browser(E);
    okFinish(await round(E, bo, 'google', { key: 'u10', email: 'z@company.example' }));
    assert.strictEqual((await finish(bo, { code: '12345678' })).json.error, 'oauth_state', 'a code before the e-mail step');
  });

  test('attempt lifetime: a code 12 minutes after the callback still finishes; 31 minutes after the start → oauth_state', async () => {
    const E = makeEnv();
    const br = browser(E);
    okFinish(await round(E, br, 'google', { key: 'u11', email: 'late@company.example' }));
    okFinish(await finish(br, { email: 'late@company.example' }));
    await age(br, 12);
    const r = okFinish(await finish(br, { code: codeFor(E, 'late@company.example') }));
    assert.strictEqual(r.next, 'consent');
    const b2 = browser(E);
    okFinish(await round(E, b2, 'google', { key: 'u12', email: 'later@company.example' }));
    okFinish(await finish(b2, { email: 'later@company.example' }));
    await age(b2, 31);
    assert.strictEqual((await finish(b2, { code: codeFor(E, 'later@company.example') })).json.error, 'oauth_state');
  });

  test('rule 2: link from the account page — step-up at start, the link-confirm code after the return, no step-up from it', async () => {
    const E = makeEnv();
    const email = 'acct@company.example';
    const uid = await codeAccount(E, email);
    const br = browser(E);
    await codeSession(br, uid, { stepup: false });
    assert.strictEqual((await start(br, 'google', { purpose: 'link' })).json.error, 'reauth');
    assert.strictEqual((await start(browser(E), 'google', { purpose: 'link' })).json.error, 'signed_out');
    const sid = await codeSession(br, uid);
    const c = okFinish(await round(E, br, 'google', { key: 'L1', email: consumer(E, 'mine') }, { purpose: 'link' }));
    assert.deepStrictEqual([c.next, c.reason, c.emailMasked], ['code', 'link_confirm', 'a•••@company.example']);
    const m = E.mail.last(email);
    assert.strictEqual(m.template, 'code_link_confirm'); assert.strictEqual(m.params.provider, 'google'); assert.match(m.params.providerEmailMasked, /^m•••@/);
    await H.admin.sql`update wts.sessions set stepup_at = null where sid_hash = ${S1.sidHash(sid)}`;
    const d = okFinish(await finish(br, { code: m.params.code }));
    assert.strictEqual(d.next, 'done'); assert.strictEqual(d.linked.provider, 'google'); assert.match(d.linked.emailMasked, /^m•••@/);
    assert.strictEqual((await sessionRow(sid)).stepup_at, null, 'the link-confirm code does not set stepup_at');
    assert.strictEqual(br.cookie('__Host-wts_sid'), sid, 'a link keeps the session');
    // one per provider
    await codeSession(br, uid);
    assert.strictEqual((await round(E, br, 'google', { key: 'L2', email: consumer(E, 'second') }, { purpose: 'link' })).json.error, 'provider_linked');
    // the same identity again: done
    assert.strictEqual(okFinish(await round(E, br, 'google', { key: 'L1', email: consumer(E, 'mine') }, { purpose: 'link' })).linked.provider, 'google');
    // an identity linked to another account
    const other = await codeAccount(E, 'other@company.example');
    const bo = browser(E); await codeSession(bo, other);
    assert.strictEqual((await round(E, bo, 'google', { key: 'L1', email: consumer(E, 'mine') }, { purpose: 'link' })).json.error, 'identity_in_use');
    // a link attempt cannot be finished by another session or browser
    const b3 = browser(E); await codeSession(b3, other);
    const s3 = await start(b3, 'linkedin', { purpose: 'link' });
    await b3.visit(s3.json.url, { key: 'L3', email: 'x@company.example' });
    await codeSession(b3, other);                                                // a different session in the same browser
    assert.strictEqual((await finish(b3)).json.error, 'oauth_state');
  });

  test('a sign-in finish revokes the session the request carried (user A → user B): fresh id, A gone', async () => {
    const E = makeEnv();
    const a = await codeAccount(E, 'a.user@company.example');
    const br = browser(E);
    const sidA = await codeSession(br, a);
    okFinish(await round(E, br, 'google', { key: 'B', email: consumer(E, 'b.user') }));
    const d = okFinish(await finish(br, { consent: { terms: '1', privacy: '1' } }));
    assert.notStrictEqual(d.user.id, a);
    assert.strictEqual(await sessionRow(sidA), null, "A's session is revoked");
    assert.notStrictEqual(br.cookie('__Host-wts_sid'), sidA);
    // same user: rotated (the presented id never survives)
    const sidB = br.cookie('__Host-wts_sid');
    okFinish(await round(E, br, 'google', { key: 'B', email: consumer(E, 'b.user') }));
    assert.strictEqual(await sessionRow(sidB), null); assert(await sessionRow(br.cookie('__Host-wts_sid')));
  });

  test('status outcomes: locked, deleting (cancel_deletion code), not_invited, signup_closed, signin mode, paused', async () => {
    const E = makeEnv();
    const br = browser(E);
    okFinish(await round(E, br, 'google', { key: 'S1', email: consumer(E, 'locked') }));
    okFinish(await finish(br, { consent: { terms: '1', privacy: '1' } }));
    await H.admin.sql`update wts.users set status = 'locked'`;
    assert.deepStrictEqual((await round(E, browser(E), 'google', { key: 'S1', email: consumer(E, 'locked') })).json.error, 'locked');
    await H.admin.sql`update wts.users set status = 'deleting'`;
    const b2 = browser(E);
    const c = okFinish(await round(E, b2, 'google', { key: 'S1', email: consumer(E, 'locked') }));
    assert.deepStrictEqual([c.next, c.reason], ['code', 'cancel_deletion']);
    const d = okFinish(await finish(b2, { code: codeFor(E, consumer(E, 'locked'), 'code_cancel_deletion') }));
    assert.strictEqual(d.next, 'done'); assert((await sessionRow(b2.cookie('__Host-wts_sid'))).stepup_at);
    // invite beta and closed sign-up: only after the provider vouched for the address
    const inv = makeEnv({ env: { ACCOUNTS_SIGNUP: 'invite' } });
    assert.strictEqual((await round(inv, browser(inv), 'google', { key: 'I1', email: consumer(inv, 'stranger') })).json.error, 'not_invited');
    await H.admin.sql`insert into wts.signup_allowlist (email_bidx, added_at) values (${S1.bidx(inv.config, consumer(inv, 'friend'))}, now())`;
    assert.strictEqual(okFinish(await round(inv, browser(inv), 'google', { key: 'I2', email: consumer(inv, 'friend') })).next, 'consent');
    const closed = makeEnv({ env: { ACCOUNTS_SIGNUP: 'off' } });
    assert.strictEqual((await round(closed, browser(closed), 'google', { key: 'I3', email: consumer(closed, 'x') })).json.error, 'signup_closed');
    // signin mode: no new account or link, known identities still sign in
    const si = makeEnv({ env: { OAUTH_GOOGLE: 'signin' } });
    assert.deepStrictEqual((await round(si, browser(si), 'google', { key: 'I4', email: consumer(si, 'new') })).json, { error: 'provider_off', message: C.ERRORS.provider_off.text, provider: 'google' });
    await H.admin.sql`update wts.users set status = 'active'`;
    assert.strictEqual(okFinish(await round(si, browser(si), 'google', { key: 'S1', email: consumer(si, 'locked') })).next, 'done');
    // ACCOUNTS_OFF: finish paused, providers still answers
    const off = makeEnv({ env: { ACCOUNTS_OFF: '1' } });
    const bo = browser(off);
    assert.strictEqual((await bo.call('GET', '/auth/providers')).status, 200);
    assert.strictEqual((await finish(bo)).json.error, 'paused');
  });

  test('methods and unlink: shape, step-up, revokes every session of the identity, notice, audit, not_found', async () => {
    const E = makeEnv();
    const email = 'u@company.example';
    const uid = await codeAccount(E, email);
    const owner = browser(E); await codeSession(owner, uid);
    okFinish(await round(E, owner, 'google', { key: 'M1', email: consumer(E, 'm1') }, { purpose: 'link' }));
    okFinish(await finish(owner, { code: E.mail.last(email).params.code }));
    // two provider sessions of that identity
    const p1 = browser(E); const p2 = browser(E, '203.0.113.20');
    okFinish(await round(E, p1, 'google', { key: 'M1', email: consumer(E, 'm1') }));
    okFinish(await round(E, p2, 'google', { key: 'M1', email: consumer(E, 'm1') }));
    const m = await owner.call('GET', '/auth/methods');
    assert(C.checkShape('Methods', m.json).ok, JSON.stringify(m.json));
    assert.strictEqual(m.json.email.masked, 'u•••@company.example'); assert.strictEqual(m.json.identities.length, 1);
    assert.strictEqual((await browser(E).call('GET', '/auth/methods')).json.error, 'signed_out');
    assert.strictEqual((await owner.call('POST', '/auth/methods/unlink', { id: crypto.randomUUID() })).json.error, 'not_found');
    const u = await owner.call('POST', '/auth/methods/unlink', { id: m.json.identities[0].id });
    assert.strictEqual(u.status, 200); assert(C.checkShape('UnlinkRes', u.json).ok);
    assert.strictEqual(u.json.sessionsRevoked, 2); assert.strictEqual(u.json.methods.identities.length, 0);
    assert.strictEqual((await p1.call('GET', '/auth/methods')).json.error, 'signed_out', 'the identity sessions are gone');
    assert.strictEqual((await owner.call('GET', '/auth/methods')).status, 200, 'the code session stays');
    assert(E.mail.sent.some((x) => x.to === email && x.template === 'notice_identity_unlinked'));
    assert((await H.admin.sql`select action from wts.audit where action = 'identity_unlink'`).length === 1);
    // a provider session that unlinks its own identity is signed out too
    okFinish(await round(E, owner, 'linkedin', { key: 'M2', email: 'm2@company.example' }, { purpose: 'link' }));
    okFinish(await finish(owner, { code: E.mail.last(email).params.code }));
    const p3 = browser(E);
    okFinish(await round(E, p3, 'linkedin', { key: 'M2', email: 'm2@company.example' }));
    await H.admin.sql`update wts.sessions set stepup_at = now() where sid_hash = ${S1.sidHash(p3.cookie('__Host-wts_sid'))}`;
    const id2 = (await p3.call('GET', '/auth/methods')).json.identities[0].id;
    assert.strictEqual((await p3.call('POST', '/auth/methods/unlink', { id: id2 })).json.sessionsRevoked, 1);
    assert.strictEqual((await p3.call('GET', '/auth/methods')).json.error, 'signed_out');
    // deleting the account removes its identities (cascade)
    await H.admin.sql`delete from wts.users where id = ${uid}`;
    assert.strictEqual((await H.admin.sql`select count(*)::int as n from wts.identities`)[0].n, 0);
  });

  test('ceilings and the breaker: 20 live attempts per prefix; 30 exchanges per prefix per 10 min; junk codes never open it', async () => {
    const E = makeEnv();
    for (let i = 0; i < 20; i++) assert.strictEqual((await start(browser(E, '192.0.2.' + (i + 1)), 'google')).status, 200);
    const r = await start(browser(E, '192.0.2.99'), 'google');
    assert.deepStrictEqual([r.status, r.json.error, r.json.provider], [503, 'provider_off', 'google'], 'hard ceiling: 20 live attempts per /24');
    assert.strictEqual((await start(browser(E, '198.18.0.1'), 'google')).status, 200, 'another prefix is not affected');
    await H.admin.sql`truncate wts.oauth_attempts`;
    // 100 junk-code callbacks from one prefix: never the breaker; only 30 reach the token endpoint
    const before = E.g.calls.token;
    for (let i = 0; i < 100; i++) {
      const br = browser(E, '100.64.1.' + ((i % 200) + 1));
      const s = await start(br, 'google');
      const st = new URL(s.json.url).searchParams.get('state');
      await E.app.handle({ method: 'GET', url: '/api/v1/auth/oauth/google/callback?code=junk' + i + '&state=' + st + '&iss=' + encodeURIComponent(E.g.issuer),
        headers: { host: HOST, cookie: '__Host-wts_oa=' + br.cookie('__Host-wts_oa') }, body: null, remoteAddress: '100.64.1.' + ((i % 200) + 1) });
      if (i % 19 === 18) await H.admin.sql`truncate wts.oauth_attempts`;
    }
    assert.strictEqual(E.g.calls.token - before, 30, 'beyond 30 per prefix per 10 min the provider is not contacted');
    assert.deepStrictEqual((await browser(E).call('GET', '/auth/providers')).json.google, 'on', 'junk codes never open the breaker');
    // provider-side failures from many prefixes: ≥ 20 exchanges, > 50 % failing → off for 10 minutes (a fresh window: the
    // 30 good exchanges above would otherwise keep the share under half)
    await H.admin.sql`truncate wts.rate_counters`;
    E.g.setFault('token_5xx');
    for (let i = 0; i < 20; i++) await round(E, browser(E, '10.' + (i + 1) + '.0.1'), 'google', { key: 'x' + i, email: consumer(E, 'x') });
    E.g.setFault(null);
    assert.strictEqual((await browser(E).call('GET', '/auth/providers')).json.google, 'off');
    assert.strictEqual((await start(browser(E, '10.200.0.1'), 'google')).json.error, 'provider_off');
    assert.strictEqual((await browser(E).call('GET', '/auth/providers')).json.linkedin, 'on', 'per provider');
    assert(E.logs.some((m) => /breaker open for google/.test(m)));
  });

  test('signing keys are cached in oidc_keys (public only); logs carry no code, state, token, claim or e-mail', async () => {
    const E = makeEnv();
    const br = browser(E);
    const s = await start(br, 'google');
    const v = await br.visit(s.json.url, { key: 'K1', email: consumer(E, 'secret.person') });
    const r = await finish(br);
    assert.strictEqual(r.json.next, 'consent');
    const k = await H.admin.sql`select * from wts.oidc_keys`;
    assert.strictEqual(k.length, 1); assert.strictEqual(k[0].provider, 'google'); assert(!('d' in k[0].jwk), 'public key only');
    await assert.rejects(api.sql`select wts.oidc_key_put('google', 'kx', ${api.sql.json({ kty: 'RSA', n: 'a', e: 'AQAB', d: 'secret' })}, now() + interval '1 hour')`, /public RSA keys only/);
    const u = new URL(v.url);
    const all = E.logs.join('\n');
    for (const secret of [u.searchParams.get('code'), u.searchParams.get('state'), 'secret.person', E.g.subjectFor('K1'), E.g.clientSecret]) {
      assert(!all.includes(secret), 'not in the logs: ' + secret.slice(0, 6));
    }
  });

  test('RLS: wts_api reaches attempts and keys only through definers; identities of another user are invisible', async () => {
    const E = makeEnv();
    const a = await codeAccount(E, 'r1@company.example'); const b = await codeAccount(E, 'r2@company.example');
    const ba = browser(E); await codeSession(ba, a);
    okFinish(await round(E, ba, 'google', { key: 'R1', email: consumer(E, 'r1') }, { purpose: 'link' }));
    okFinish(await finish(ba, { code: E.mail.last('r1@company.example').params.code }));
    for (const t of ['oauth_attempts', 'oidc_keys']) await assert.rejects(api.sql.unsafe('select 1 from wts.' + t), /permission denied/, t);
    assert.strictEqual((await api.asUser(b, (tx) => tx`select count(*)::int as n from wts.identities`))[0].n, 0, 'B sees none of A');
    assert.strictEqual((await api.asUser(a, (tx) => tx`select count(*)::int as n from wts.identities`))[0].n, 1);
    await assert.rejects(api.asUser(b, (tx) => tx`select wts.identity_link(${a}, 'linkedin', 'x', '\\x01', '\\x01', null, false, 'signup')`), /not the current user/);
    assert.strictEqual((await api.asUser(b, async (tx) => (await tx`select wts.identity_unlink(id) as n from (select ${(await H.admin.sql`select id from wts.identities`)[0].id}::uuid as id) q`)[0].n)), null, 'B cannot unlink A');
    await assert.rejects(api.asUser(a, (tx) => tx`update wts.identities set user_id = ${b}`), /permission denied/);
  });
});
