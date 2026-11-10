'use strict';
// server/test/oidc.test.js — core/oidc.js against the fake OpenID provider (docs/ACCOUNTS-PLAN.md §4.10, §4.11, §8.3, §12.4):
// PKCE, authorization URL, callback error mapping, code exchange (access token dropped), RS256 checks for every fault,
// signing-key cache and its refetch limit, e-mail trust (consumer domain / hd), the breaker policy and the production pins.
// No database.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const O = require('../core/oidc');
const PINS = require('../core/oidc-providers');
const { loadConfig } = require('../core/config');
const { createFakeOidc, FAULTS } = require('./fake-oidc');

const MIN = 60 * 1000;
function setup(provider, o) {
  o = o || {};
  let t = o.t || Date.UTC(2026, 10, 8, 12, 0, 0);
  const now = () => t;
  const op = createFakeOidc(Object.assign({ provider, now }, o.fake || {}));
  const cfg = PINS.resolve(provider, { override: op.override });
  const keys = O.createKeyCache({ fetch: op.fetch, now, store: o.store });
  return { op, cfg, keys, now, advance(ms) { t += ms; } };
}
// one full provider leg: authorization URL → fake authorize → exchange → verify
async function leg(s, o) {
  o = o || {};
  const state = O.randomToken(32); const nonce = O.randomToken(32); const p = O.pkce();
  const created = s.now();
  const url = O.authorizationUrl(s.cfg, { clientId: s.op.clientId, redirectUri: s.op.redirectUri, state, nonce, challenge: p.challenge, fresh: !!o.fresh });
  const cb = new URL(s.op.authorize(url, { user: o.user || { key: 'u1', email: 'name@company.example' } }));
  const ex = await O.exchangeCode(s.cfg, { code: cb.searchParams.get('code'), verifier: o.verifier || p.verifier, clientId: s.op.clientId,
    clientSecret: s.op.clientSecret, redirectUri: s.op.redirectUri, fetch: s.op.fetch });
  if (!ex.ok) return { ex, url };
  const v = await O.verifyIdToken(ex.idToken, { cfg: s.cfg, clientId: s.op.clientId, nonce, freshLogin: !!o.fresh, attemptCreatedAt: created,
    now: s.now(), getKey: (c, kid) => s.keys.getKey(c, kid) });
  return { ex, v, url, nonce };
}

test('pkce: verifier length and charset, S256 challenge', () => {
  const p = O.pkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.strictEqual(p.challenge, O.b64u(crypto.createHash('sha256').update(p.verifier).digest()));
  assert.notStrictEqual(O.pkce().verifier, p.verifier);
  assert.strictEqual(O.randomToken(32).length, 43);
});

test('authorization URL: required parameters, Google select_account / fresh login, LinkedIn fresh login refused, no offline access', () => {
  const g = setup('google');
  const u = new URL(O.authorizationUrl(g.cfg, { clientId: 'cid', redirectUri: 'https://welltest.h2oil.co.uk/api/v1/auth/oauth/google/callback', state: 's', nonce: 'n', challenge: 'c' }));
  const q = Object.fromEntries(u.searchParams);
  assert.strictEqual(u.origin + u.pathname, g.cfg.authorization);
  assert.deepStrictEqual({ rt: q.response_type, cid: q.client_id, scope: q.scope, state: q.state, nonce: q.nonce, cc: q.code_challenge, m: q.code_challenge_method, prompt: q.prompt },
    { rt: 'code', cid: 'cid', scope: 'openid email', state: 's', nonce: 'n', cc: 'c', m: 'S256', prompt: 'select_account' });
  assert(!('access_type' in q) && !('max_age' in q));
  const f = Object.fromEntries(new URL(O.authorizationUrl(g.cfg, { clientId: 'cid', redirectUri: 'x', state: 's', nonce: 'n', challenge: 'c', fresh: true })).searchParams);
  assert.strictEqual(f.prompt, 'login'); assert.strictEqual(f.max_age, '0');
  const l = setup('linkedin');
  assert.strictEqual(new URL(O.authorizationUrl(l.cfg, { clientId: 'cid', redirectUri: 'x', state: 's', nonce: 'n', challenge: 'c' })).searchParams.get('scope'), 'openid profile email');
  assert.throws(() => O.authorizationUrl(l.cfg, { clientId: 'cid', redirectUri: 'x', state: 's', nonce: 'n', challenge: 'c', fresh: true }), (e) => e.reason === 'reauth_stale');
  // the fixed redirect URI: production origin in production; a dev origin only outside it
  const prod = loadConfig({ WTS_ENV: 'production', WTS_PROXY_SIG: 'x' });
  assert.strictEqual(O.redirectUri(prod, 'google'), 'https://welltest.h2oil.co.uk/api/v1/auth/oauth/google/callback');
  const dev = loadConfig({ WTS_ENV: 'local', WTS_DEV_ORIGIN: 'http://localhost:8787' });
  assert.strictEqual(O.redirectUri(dev, 'linkedin'), 'http://localhost:8787/api/v1/auth/oauth/linkedin/callback');
});

test('callback error mapping: cancel codes, known and unknown codes; never the description', () => {
  assert.deepStrictEqual(O.mapCallbackError('google', 'access_denied'), { reason: 'cancelled', logged: 'access_denied' });
  assert.deepStrictEqual(O.mapCallbackError('linkedin', 'user_cancelled_login'), { reason: 'cancelled', logged: 'user_cancelled_login' });
  assert.deepStrictEqual(O.mapCallbackError('linkedin', 'user_cancelled_authorize'), { reason: 'cancelled', logged: 'user_cancelled_authorize' });
  assert.deepStrictEqual(O.mapCallbackError('google', 'server_error'), { reason: 'provider', logged: 'server_error' });
  assert.deepStrictEqual(O.mapCallbackError('google', '<script>x</script>'), { reason: 'provider', logged: 'unknown' });
  assert.deepStrictEqual(O.mapCallbackError('google', undefined), { reason: 'provider', logged: 'unknown' });
});

test('a full Google leg verifies; only the listed claims come back; the access token is dropped', async () => {
  const s = setup('google');
  const r = await leg(s, { user: { key: 'u1', email: 'Name@Corp.Example', hd: 'corp.example' } });
  assert.strictEqual(r.ex.ok, true);
  assert.deepStrictEqual(Object.keys(r.ex).sort(), ['idToken', 'ok']);
  assert.strictEqual(r.v.ok, true, JSON.stringify(r.v));
  assert.deepStrictEqual(Object.keys(r.v.claims).sort(), ['authTime', 'email', 'emailVerified', 'hd', 'iss', 'sub']);
  assert.strictEqual(r.v.claims.email, 'name@corp.example');
  assert.strictEqual(r.v.claims.emailVerified, true);
  assert.strictEqual(r.v.claims.sub, s.op.subjectFor('u1'));
  assert.strictEqual(O.emailTrusted(s.cfg, r.v.claims), true, 'hd equal to the domain → trusted');
});

test('LinkedIn leg: profile claims dropped, flag never trusted, pairwise subject', async () => {
  const s = setup('linkedin', { fake: { enforcePkce: true } });
  const r = await leg(s, { user: { key: 'u2', email: 'x@personal.example' } });
  assert.strictEqual(r.v.ok, true, JSON.stringify(r.v));
  assert.strictEqual(r.v.claims.emailVerified, true, 'the string "true" counts as verified');
  assert.strictEqual(O.emailTrusted(s.cfg, r.v.claims), false, 'LinkedIn: trustEmailVerified false');
  assert(!('name' in r.v.claims) && !('picture' in r.v.claims));
  const other = createFakeOidc({ provider: 'linkedin', clientId: 'another-app' });
  assert.notStrictEqual(other.subjectFor('u2'), s.op.subjectFor('u2'), 'a new LinkedIn app gives new subjects');
  // wrong verifier: refused when the provider enforces PKCE (Google always; LinkedIn per the WP0 setting)
  const bad = await leg(s, { verifier: 'w'.repeat(64) });
  assert.deepStrictEqual(bad.ex, { ok: false, reason: 'token', providerFailure: false });
  const g = setup('google');
  assert.strictEqual((await leg(g, { verifier: 'w'.repeat(64) })).ex.reason, 'token');
});

test('e-mail trust: Google consumer domain, matching hd, third-party domain, unverified forms', () => {
  const g = setup('google').cfg;
  const consumer = 'someone@' + g.consumerDomains[0];
  assert.strictEqual(O.emailTrusted(g, { email: consumer, emailVerified: true, hd: null }), true);
  assert.strictEqual(O.emailTrusted(g, { email: 'name@company.example', emailVerified: true, hd: null }), false, 'no hd, third-party domain');
  assert.strictEqual(O.emailTrusted(g, { email: 'name@company.example', emailVerified: true, hd: 'other.example' }), false, 'hd of another domain');
  assert.strictEqual(O.emailTrusted(g, { email: 'name@company.example', emailVerified: true, hd: 'company.example' }), true);
  assert.strictEqual(O.emailTrusted(g, { email: consumer, emailVerified: false, hd: null }), false);
  assert.strictEqual(O.emailTrusted(g, { email: null, emailVerified: false, hd: null }), false);
});

test('id_token faults: every refused form', async () => {
  const want = {
    iss: 'token', aud: 'token', aud_extra: 'token', azp: 'token', nonce: 'token', alg_none: 'token', hs256: 'token', unknown_kid: 'token',
    expired: 'token', future_iat: 'token', stale_iat: 'token', bad_sig: 'token', token_5xx: 'ex:provider', token_400: 'ex:token',
  };
  for (const f of Object.keys(want)) {
    const s = setup('google');
    s.op.setFault(f);
    const r = await leg(s);
    const got = r.v ? (r.v.ok ? 'ok' : r.v.reason) : 'ex:' + r.ex.reason;
    assert.strictEqual(got, want[f], 'fault ' + f);
    if (f === 'token_5xx') assert.strictEqual(r.ex.providerFailure, true);
    if (f === 'token_400') assert.strictEqual(r.ex.providerFailure, false, 'a 4xx never counts for the breaker');
  }
  assert(Object.keys(want).every((f) => FAULTS.includes(f)));
});

test('nonce: Google requires it; LinkedIn accepts its absence only when the configuration says when-returned', async () => {
  const g = setup('google'); g.op.setFault('no_nonce');
  assert.strictEqual((await leg(g)).v.reason, 'token', 'Google without a nonce is refused');
  const l = setup('linkedin', { fake: { returnsNonce: false } });
  assert.strictEqual(l.cfg.nonce, 'when-returned');
  assert.strictEqual((await leg(l)).v.ok, true, 'LinkedIn per the WP0 setting');
  const l2 = setup('linkedin'); l2.op.setFault('nonce');
  assert.strictEqual((await leg(l2)).v.reason, 'token', 'a returned nonce must match');
  const l3 = setup('linkedin', { fake: { returnsNonce: false } });
  l3.cfg.nonce = 'required';
  assert.strictEqual((await leg(l3)).v.reason, 'token', 'with nonce:required its absence is refused');
});

test('email_verified forms: missing, string, false, no e-mail', async () => {
  const cases = { ev_missing: false, ev_string: true, ev_false: false, no_email: false };
  for (const f of Object.keys(cases)) {
    const s = setup('google'); s.op.setFault(f);
    const r = await leg(s, { user: { key: 'k', email: 'someone@' + s.cfg.consumerDomains[0] } });
    assert.strictEqual(r.v.ok, true, f);
    assert.strictEqual(r.v.claims.emailVerified, cases[f], f);
    assert.strictEqual(O.emailTrusted(s.cfg, r.v.claims), cases[f], f + ' trust');
  }
});

test('fresh login: auth_time required and recent', async () => {
  const s = setup('google');
  assert.strictEqual((await leg(s, { fresh: true })).v.ok, true);
  s.op.setFault('no_auth_time');
  assert.strictEqual((await leg(s, { fresh: true })).v.reason, 'reauth_stale');
  s.op.setFault('old_auth_time');
  assert.strictEqual((await leg(s, { fresh: true })).v.reason, 'reauth_stale');
  s.op.setFault(null);
  const r = await leg(s, { fresh: false });
  assert.strictEqual(r.v.ok, true); assert.strictEqual(r.v.claims.authTime, null, 'auth_time is read only for a fresh-login attempt');
});

test('clock skew: exp just past and iat just ahead within 60 s pass; beyond fail', async () => {
  const s = setup('google');
  const t = Math.floor(s.now() / 1000);
  const base = { iss: s.op.issuer, aud: s.op.clientId, sub: '1', nonce: 'n' };
  const check = (claims, nowMs) => O.verifyIdToken(s.op.sign(Object.assign({}, base, claims)), { cfg: s.cfg, clientId: s.op.clientId, nonce: 'n', now: nowMs != null ? nowMs : s.now(), getKey: (c, k) => s.keys.getKey(c, k) });
  assert.strictEqual((await check({ iat: t - 30, exp: t - 30 })).ok, true, 'exp 30 s past: within skew');
  assert.strictEqual((await check({ iat: t - 100, exp: t - 61 })).ok, false);
  assert.strictEqual((await check({ iat: t + 59, exp: t + 3600 })).ok, true);
  assert.strictEqual((await check({ iat: t + 61, exp: t + 3600 })).ok, false);
  assert.strictEqual((await check({ iat: t - 600, exp: t + 3600 })).ok, true, '10 minutes old');
  assert.strictEqual((await check({ iat: t - 700, exp: t + 3600 })).ok, false, 'older than 10 minutes');
  assert.strictEqual((await check({ iat: t, exp: t + 3600, sub: '' })).ok, false, 'empty sub');
  assert.strictEqual((await check({ iat: t, exp: t + 3600, sub: 'x'.repeat(256) })).ok, false, 'sub over 255');
  assert.strictEqual((await check({ iat: t, exp: t + 3600, aud: [] })).ok, false, 'empty aud list');
  assert.strictEqual((await O.verifyIdToken('a.b', { cfg: s.cfg, clientId: 'x', getKey: () => ({ key: null }) })).ok, false, 'malformed');
  assert.strictEqual((await O.verifyIdToken('x'.repeat(20000), { cfg: s.cfg, clientId: 'x', getKey: () => ({ key: null }) })).ok, false, 'oversized');
  let lookups = 0;
  const none = await O.verifyIdToken(s.op.sign(Object.assign({}, base, { iat: t, exp: t + 60 }), { alg: 'none' }), { cfg: s.cfg, clientId: s.op.clientId, nonce: 'n', now: s.now(), getKey: () => { lookups++; return { key: null }; } });
  assert.strictEqual(none.ok, false); assert.strictEqual(lookups, 0, 'alg checked before any key lookup');
});

test('signing-key cache: memory, store, one refetch per provider per 5 minutes, rotation', async () => {
  const stored = new Map();
  const store = { async get(p, kid) { return stored.get(p + '|' + kid) || null; }, async put(p, kid, jwk, exp) { stored.set(p + '|' + kid, jwk); assert(exp > 0); } };
  const s = setup('google', { store });
  await leg(s);
  assert.strictEqual(s.keys.stats.fetches, 1); assert.strictEqual(stored.size, 1, 'the public key is stored');
  await leg(s);
  assert.strictEqual(s.keys.stats.fetches, 1, 'cached');
  // unknown kid: one refetch, then refused without fetching for 5 minutes
  s.op.setFault('unknown_kid');
  assert.strictEqual((await leg(s)).v.reason, 'token');
  assert.strictEqual(s.keys.stats.fetches, 1, 'the first fetch was under 5 minutes ago: no refetch');
  s.advance(5 * MIN + 1);
  assert.strictEqual((await leg(s)).v.reason, 'token');
  assert.strictEqual(s.keys.stats.fetches, 2, 'one refetch after 5 minutes');
  assert.strictEqual((await leg(s)).v.reason, 'token');
  assert.strictEqual(s.keys.stats.fetches, 2, 'and none again within 5 minutes');
  // rotation: the new kid is found by the (allowed) refetch
  s.op.setFault(null);
  s.op.rotateKey();
  s.advance(5 * MIN + 1);
  assert.strictEqual((await leg(s)).v.ok, true);
  assert.strictEqual(s.keys.stats.fetches, 3);
  // a second instance finds the key in the store without fetching
  const s2 = O.createKeyCache({ fetch: () => { throw new Error('no fetch expected'); }, now: s.now, store });
  const kid = Array.from(stored.keys()).pop().split('|')[1];
  assert((await s2.getKey(s.cfg, kid)).key, 'store hit');
  // a failing JWKS fetch is a provider-side failure
  const s3 = O.createKeyCache({ fetch: async () => ({ status: 503, headers: { get: () => null } }), now: s.now });
  assert.deepStrictEqual(await s3.getKey(s.cfg, 'k1'), { key: null, providerFailure: true });
  // non-RSA / wrong-alg keys are ignored
  const s4 = O.createKeyCache({ fetch: async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ keys: [{ kty: 'oct', kid: 'k', k: 'AAAA' }, { kty: 'RSA', kid: 'k2', alg: 'HS256', n: 'x', e: 'AQAB' }] }) }), now: s.now });
  assert.strictEqual((await s4.getKey(s.cfg, 'k')).key, null);
  assert.strictEqual((await s4.getKey(s.cfg, 'k2')).key, null);
});

test('breaker policy: provider-side failures only, ≥ 20 exchanges and > 50 %; 100 junk-code callbacks never open it', async () => {
  let t = 0; const now = () => t;
  const b = O.memoryBreaker({ now });
  for (let i = 0; i < 100; i++) await b.note('google', false);
  assert.strictEqual(await b.isOpen('google'), false, '4xx / invalid_grant never count');
  const b2 = O.memoryBreaker({ now });
  for (let i = 0; i < 19; i++) await b2.note('google', true);
  assert.strictEqual(await b2.isOpen('google'), false, 'fewer than 20 exchanges');
  await b2.note('google', true);
  assert.strictEqual(await b2.isOpen('google'), true, '20 failing exchanges');
  assert.strictEqual(await b2.isOpen('linkedin'), false, 'per provider');
  t += 10 * MIN + 1;
  assert.strictEqual(await b2.isOpen('google'), false, 'closes after 10 minutes (checked on the next request)');
  assert.strictEqual(O.breakerDecision({ total: 20, bad: 10 }), false); assert.strictEqual(O.breakerDecision({ total: 20, bad: 11 }), true);
});

test('production pins: the pinned configuration passes; a localhost issuer or a non-https key address refuses start-up', () => {
  assert.deepStrictEqual(PINS.checkPins(), []);
  const bad = JSON.parse(JSON.stringify(PINS.CONFIG));
  bad.google.jwks = 'http://www.example.test/certs';
  assert(PINS.checkPins(bad).some((e) => /google\.jwks/.test(e)));
  const bad2 = JSON.parse(JSON.stringify(PINS.CONFIG));
  bad2.google.issuers = ['http://localhost:9999'];
  assert(PINS.checkPins(bad2).length > 0);
  const env = { WTS_ENV: 'production', WTS_PROXY_SIG: 'sig', OAUTH_GOOGLE: 'on', OAUTH_GOOGLE_CLIENT_ID: 'id', OAUTH_GOOGLE_CLIENT_SECRET: 'secret' };
  assert.strictEqual(loadConfig(env).providerSwitches().google, 'on', 'pinned Google on the production host');
  assert.strictEqual(loadConfig(env).providerSwitches().linkedin, 'off', 'LinkedIn off while OAUTH_LINKEDIN is unset');
  // LinkedIn pinned since release 4.2 (owner decision 2026-11-10): the discovery document's issuer, no pending item, and
  // production + OAUTH_LINKEDIN=on with a client id and secret offers it
  assert.strictEqual(PINS.pinned('linkedin'), true);
  assert.deepStrictEqual(PINS.CONFIG.linkedin.pending, []);
  assert.deepStrictEqual(PINS.CONFIG.linkedin.issuers, ['https://www.linkedin.com/oauth']);
  assert.strictEqual(PINS.CONFIG.linkedin.freshLogin, null, 'no forced login relied on');
  assert.strictEqual(PINS.CONFIG.linkedin.pkce, 'sent'); assert.strictEqual(PINS.CONFIG.linkedin.nonce, 'when-returned');
  const envL = Object.assign({ OAUTH_LINKEDIN: 'on', OAUTH_LINKEDIN_CLIENT_ID: 'lid', OAUTH_LINKEDIN_CLIENT_SECRET: 'lsecret' }, env);
  const cL = loadConfig(envL);
  assert.deepStrictEqual(cL.providerSwitches(), { google: 'on', linkedin: 'on' }, 'production + OAUTH_LINKEDIN=on offers LinkedIn');
  assert.ok(!cL.alerts.some((a) => /OAUTH_LINKEDIN/.test(a)), 'no LinkedIn alert');
  assert.strictEqual(loadConfig(Object.assign({}, envL, { OAUTH_LINKEDIN_CLIENT_SECRET: '' })).providerSwitches().linkedin, 'off', 'a missing secret is off');
  assert.strictEqual(loadConfig(Object.assign({}, envL, { OAUTH_LINKEDIN: 'signin' })).providerSwitches().linkedin, 'signin');
  const keep = PINS.CONFIG.google.jwks;
  try {
    PINS.CONFIG.google.jwks = 'http://localhost:9000/jwks';
    const c = loadConfig(env);
    assert.deepStrictEqual(c.providerSwitches(), { google: 'off', linkedin: 'off' }, 'start-up check: every provider off');
    assert(c.alerts.some((a) => /provider pins/.test(a)), 'an alert fires');
  } finally { PINS.CONFIG.google.jwks = keep; }
  const withMode = loadConfig(Object.assign({ WTS_OIDC_MODE: 'dev' }, env));
  assert.deepStrictEqual(withMode.providerSwitches(), { google: 'off', linkedin: 'off' }, 'WTS_OIDC_MODE on production: off');
  assert.throws(() => PINS.resolve('google', { override: { token: 'https://x.test/t' }, production: true }));
  // switches default off; unknown value off; missing secret off
  assert.deepStrictEqual(loadConfig({ WTS_ENV: 'test' }).providerSwitches(), { google: 'off', linkedin: 'off' });
  assert.strictEqual(loadConfig({ WTS_ENV: 'test', OAUTH_GOOGLE: 'maybe', OAUTH_GOOGLE_CLIENT_ID: 'a', OAUTH_GOOGLE_CLIENT_SECRET: 'b' }).providerSwitches().google, 'off');
  assert.strictEqual(loadConfig({ WTS_ENV: 'test', OAUTH_GOOGLE: 'signin', OAUTH_GOOGLE_CLIENT_ID: 'a' }).providerSwitches().google, 'off');
  assert.strictEqual(loadConfig({ WTS_ENV: 'test', OAUTH_GOOGLE: 'signin', OAUTH_GOOGLE_CLIENT_ID: 'a', OAUTH_GOOGLE_CLIENT_SECRET: 'b' }).providerSwitches().google, 'signin');
  assert(!JSON.stringify(loadConfig({ WTS_ENV: 'test', OAUTH_GOOGLE: 'on', OAUTH_GOOGLE_CLIENT_ID: 'a', OAUTH_GOOGLE_CLIENT_SECRET: 'top-secret' }).redacted()).includes('top-secret'));
});

test('a slow signing-key endpoint: the fetch gives up at its timeout, counts as a provider-side failure, and is limited', async () => {
  let t = Date.now();
  const op = createFakeOidc({ provider: 'google', now: () => t, freshKey: true });
  const cfg = PINS.resolve('google', { override: op.override });
  op.setFault('jwks_slow');
  const keys = O.createKeyCache({ fetch: op.fetch, now: () => t, timeoutMs: 60 });
  const t0 = Date.now();
  const r = await keys.getKey(cfg, 'k-any');
  const took = Date.now() - t0;
  assert.deepStrictEqual(r, { key: null, providerFailure: true }, 'a timeout is a provider-side failure (the breaker counts it)');
  assert(took < 2000, 'gave up at the timeout, not at the slow answer (' + took + ' ms)');
  // the token check passes the failure up
  const tok = op.sign({ iss: op.issuer, aud: op.clientId, azp: op.clientId, sub: '1', iat: Math.floor(t / 1000), exp: Math.floor(t / 1000) + 60, nonce: 'n' });
  t += 5 * MIN + 1;
  const v = await O.verifyIdToken(tok, { cfg, clientId: op.clientId, nonce: 'n', now: t, attemptCreatedAt: t, getKey: (c, kid) => keys.getKey(c, kid) });
  assert.strictEqual(v.ok, false); assert.strictEqual(v.providerFailure, true);
  // and within 5 minutes no second fetch is tried
  const again = await keys.getKey(cfg, 'k-other');
  assert.deepStrictEqual(again, { key: null, providerFailure: false });
  assert.strictEqual(keys.stats.fetches, 2);
  op.setFault(null);
});

test('signing-key refetch limit across instances: store.claimFetch (the database window) refuses a second instance', async () => {
  let t = Date.now();
  const op = createFakeOidc({ provider: 'google', now: () => t });
  const cfg = PINS.resolve('google', { override: op.override });
  let window = new Set();
  const store = { async get() { return null; }, async put() {}, async claimFetch(p) { if (window.has(p)) return false; window.add(p); return true; } };
  const a = O.createKeyCache({ fetch: op.fetch, now: () => t, store });
  const b = O.createKeyCache({ fetch: op.fetch, now: () => t, store });
  await a.getKey(cfg, 'k-unknown');
  assert.strictEqual(a.stats.fetches, 1);
  assert.deepStrictEqual(await b.getKey(cfg, 'k-unknown'), { key: null, providerFailure: false }, 'another instance does not refetch');
  assert.strictEqual(b.stats.fetches, 0); assert.strictEqual(b.stats.claimRefused, 1);
  window = new Set();                                         // the next 5-minute window
  await b.getKey(cfg, 'k-unknown');
  assert.strictEqual(b.stats.fetches, 1);
});
