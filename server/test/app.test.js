'use strict';
// server/test/app.test.js — config loader, the common rules of §3.2 and the WP0 route table, through core/app.js and over
// real HTTP through server/dev.js (no database needed).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadConfig, loadJobsConfig, SECRET_ENV } = require('../core/config');
const { createApp } = require('../core/app');
const C = require('../core/contract');
const H = require('../core/http');
const fns = require('../functions');
const pins = require('../core/oidc-providers');

const ORIGIN = 'https://welltest.h2oil.co.uk';
const key32 = () => crypto.randomBytes(32).toString('base64');
function cfg(extra) { return loadConfig(Object.assign({ WTS_ENV: 'test' }, extra || {})); }
function req(method, path, o) {
  o = o || {};
  const headers = Object.assign({ host: 'welltest.h2oil.co.uk' }, o.headers || {});
  if (method !== 'GET' && !o.bare) Object.assign(headers, { origin: ORIGIN, 'x-wts-req': '1', 'content-type': o.ct || 'application/json' }, o.headers || {});
  const body = o.body === undefined ? (method === 'GET' ? null : Buffer.from('{}')) : (Buffer.isBuffer(o.body) ? o.body : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body)));
  return { method, url: C.BASE + path, headers, body, remoteAddress: o.ip || '203.0.113.7' };
}
const json = (r) => (r.body ? JSON.parse(r.body) : null);

test('config: switches fail closed, providers off unless configured, secrets never enumerable, production pins', () => {
  const c0 = cfg();
  assert.strictEqual(c0.signup, 'invite'); assert.strictEqual(c0.syncMode, 'on'); assert.strictEqual(c0.accountsOff, false);
  assert.deepStrictEqual(c0.providerSwitches(), { google: 'off', linkedin: 'off' });
  const c1 = cfg({ ACCOUNTS_SIGNUP: 'wide-open', SYNC_MODE: 'maybe', OAUTH_GOOGLE: 'yes', ACCOUNTS_OFF: 'true' });
  assert.strictEqual(c1.signup, 'off'); assert.strictEqual(c1.syncMode, 'off'); assert.strictEqual(c1.accountsOff, true);
  assert.strictEqual(c1.providers.google.switch, 'off');
  assert.ok(c1.warnings.length >= 3);
  const c2 = cfg({ OAUTH_GOOGLE: 'on' });
  assert.strictEqual(c2.providerSwitches().google, 'off', 'no client id / secret → off');
  const c3 = cfg({ OAUTH_GOOGLE: 'signin', OAUTH_GOOGLE_CLIENT_ID: 'id', OAUTH_GOOGLE_CLIENT_SECRET: 's3cret' });
  assert.strictEqual(c3.providerSwitches().google, 'signin');
  assert.ok(!JSON.stringify(c3).includes('s3cret') && !JSON.stringify(c3.redacted()).includes('s3cret'));
  assert.ok(!Object.keys(c3).includes('secrets'));
  // local runs need WTS_OIDC_MODE=dev for a provider; production refuses dev mode and unpinned providers
  assert.strictEqual(loadConfig({ WTS_ENV: 'local', OAUTH_GOOGLE: 'on', OAUTH_GOOGLE_CLIENT_ID: 'i', OAUTH_GOOGLE_CLIENT_SECRET: 's' }).providerSwitches().google, 'off');
  assert.strictEqual(loadConfig({ WTS_ENV: 'local', WTS_OIDC_MODE: 'dev', OAUTH_GOOGLE: 'on', OAUTH_GOOGLE_CLIENT_ID: 'i', OAUTH_GOOGLE_CLIENT_SECRET: 's' }).providerSwitches().google, 'on');
  const prodEnv = { WTS_ENV: 'production', WTS_PROXY_SIG: 'p', OAUTH_GOOGLE: 'on', OAUTH_GOOGLE_CLIENT_ID: 'i', OAUTH_GOOGLE_CLIENT_SECRET: 's',
    OAUTH_LINKEDIN: 'on', OAUTH_LINKEDIN_CLIENT_ID: 'i', OAUTH_LINKEDIN_CLIENT_SECRET: 's' };
  const p = loadConfig(prodEnv);
  assert.deepStrictEqual(p.providerSwitches(), { google: 'on', linkedin: 'off' }, 'LinkedIn waits for its WP0 pins');
  assert.deepStrictEqual(loadConfig(Object.assign({ WTS_OIDC_MODE: 'dev' }, prodEnv)).providerSwitches(), { google: 'off', linkedin: 'off' });
  assert.ok(loadConfig(Object.assign({ WTS_OIDC_MODE: 'dev' }, prodEnv)).alerts.length > 0);
  assert.strictEqual(loadConfig({ WTS_ENV: 'production', WTS_DEV_ORIGIN: 'http://localhost:8080' }).devOrigin, null);
  assert.deepStrictEqual(pins.checkPins(), []);
  assert.throws(() => pins.resolve('google', { production: true, override: { token: 'http://127.0.0.1/t' } }), /refused/);
  // key lists and peppers
  const k = loadConfig({ WTS_ENV: 'test', WTS_MASTER_KEYS: '1:' + key32() + ',2:short', WTS_INDEX_PEPPER: key32() });
  assert.strictEqual(k.secrets.masterKeys.length, 1); assert.ok(Buffer.isBuffer(k.secrets.indexPepper));
  assert.strictEqual(loadJobsConfig({ WTS_ENV: 'test', WTS_JOBS_DB_URL: 'x', WTS_INDEX_PEPPER: key32() }).jobsDbUrl, 'x');
  assert.ok(Buffer.isBuffer(loadJobsConfig({ WTS_ENV: 'test', WTS_INDEX_PEPPER: key32() }).secrets.indexPepper));
  assert.strictEqual(cfg().jobsDbUrl, undefined, 'request handlers never read the jobs credential');
  assert.ok(SECRET_ENV.includes('OAUTH_GOOGLE_CLIENT_SECRET') && SECRET_ENV.includes('WTS_JOBS_DB_URL'));
  // X-Forwarded-For can never be the trusted client-address header
  assert.strictEqual(cfg({ WTS_CLIENT_IP_HEADER: 'X-Forwarded-For' }).ipHeader, '');
});

test('route table: every contract endpoint has exactly one handler; no path has a file extension', () => {
  assert.deepStrictEqual(fns.missing(), []);
  assert.strictEqual(Object.keys(fns.handlers).length, C.ENDPOINTS.length);
  C.ENDPOINTS.forEach((e) => { assert.ok(!/\.[a-z0-9]+$/i.test(e.path), e.path); assert.ok(C.matchRoute(e.method, e.path.replace(/:(\w+)/g, 'x')), e.id); });
});

test('common rules (§3.2): headers, Origin / X-WTS-Req / Content-Type, host, body caps, bad JSON, request shapes', async () => {
  const app = createApp({ config: cfg() });
  const h = await app.handle(req('GET', '/health'));
  assert.strictEqual(h.status, 200);
  ['Cache-Control', 'Vary', 'X-Content-Type-Options', 'Content-Security-Policy'].forEach((k) => assert.strictEqual(h.headers[k], H.COMMON_HEADERS[k]));
  assert.strictEqual(h.headers['Content-Type'], 'application/json');
  assert.ok(C.checkShape('Health', json(h)).ok);
  assert.ok(!('Access-Control-Allow-Origin' in h.headers));
  const ok = { email: 'name@company.example', purpose: 'signin' };
  const cases = [
    [req('POST', '/auth/code/start', { body: ok, headers: { origin: 'https://evil.example' } }), 403, 'origin'],
    [req('POST', '/auth/code/start', { body: ok, headers: { origin: undefined } }), 403, 'origin'],
    [req('POST', '/auth/code/start', { body: ok, headers: { 'x-wts-req': undefined } }), 403, 'origin'],
    [req('POST', '/auth/code/start', { body: ok, ct: 'text/plain' }), 403, 'origin'],
    [req('POST', '/auth/code/start', { body: '{nope' }), 400, 'bad_request'],
    [req('POST', '/auth/code/start', { body: { email: 'x', purpose: 'signin' } }), 400, 'bad_request'],
    [req('POST', '/auth/code/start', { body: Object.assign({ extra: 1 }, ok) }), 400, 'bad_request'],
    [req('POST', '/auth/code/start', { body: Buffer.alloc(70 * 1024, 32) }), 413, 'too_large'],
    [req('POST', '/auth/code/start', { body: ok }), 503, 'paused'],          // passes every rule; no database configured here
    [req('GET', '/nope'), 404, 'not_found'],
    [req('GET', '/health.json'), 404, 'not_found'],
    [req('GET', '/health', { headers: { host: 'other.example' } }), 404, 'not_found'],
    [req('DELETE', '/health'), 404, 'not_found'],
    [req('PUT', '/blobs/' + 'a'.repeat(64) + '/0', { body: Buffer.from([1, 2]), ct: 'application/json' }), 403, 'origin'],
    [req('PUT', '/blobs/' + 'a'.repeat(64) + '/0', { body: Buffer.from([1, 2]), ct: 'application/octet-stream' }), 400, 'bad_request'],   // reaches the handler (no ?of)
    [req('POST', '/auth/oauth/other/start', { body: { purpose: 'signin', publicDevice: false } }), 404, 'not_found'],
    [req('POST', '/auth/oauth/google/start', { body: { purpose: 'signin', publicDevice: false } }), 503, 'provider_off'],
  ];
  for (const [r, status, code] of cases) {
    const out = await app.handle(r);
    assert.strictEqual(out.status, status, r.method + ' ' + r.url + ' → ' + out.status + ' ' + out.body);
    const b = json(out);
    assert.ok(C.checkError(code, b).ok, r.url + ': ' + JSON.stringify(C.checkError(code, b).errors) + ' ' + out.body);
  }
  const bad = json(await app.handle(req('POST', '/auth/code/start', { body: { email: 'name@company.example', purpose: 'nope' } })));
  assert.strictEqual(bad.field, 'purpose');
});

test('exceptions: callback is a constant 303; csp-report; ops-daily HMAC with one-time nonce; ACCOUNTS_OFF pauses', async () => {
  const opsKey = crypto.randomBytes(32);
  const config = cfg({ WTS_OPS_HMAC: opsKey.toString('base64') });
  let t = Date.UTC(2026, 10, 8, 12, 0, 0);
  const app = createApp({ config, now: () => t });
  for (const q of ['?code=a&state=b', '?error=access_denied&state=x', '?next=https://evil.example', '']) {
    const r = await app.handle(req('GET', '/auth/oauth/google/callback' + q));
    assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.Location, 'https://welltest.h2oil.co.uk/#acct-oauth');
    assert.strictEqual(r.headers['Referrer-Policy'], 'no-referrer'); assert.strictEqual(r.body, null);
    assert.ok(!r.cookies.some((c) => c.startsWith('__Host-wts_sid=')));
  }
  assert.strictEqual((await app.handle(req('GET', '/auth/oauth/unknown/callback?code=1'))).status, 303);
  assert.strictEqual((await app.handle(req('POST', '/csp-report', { bare: true, headers: { 'content-type': 'application/csp-report' }, body: '{}' }))).status, 204);
  assert.strictEqual((await app.handle(req('POST', '/csp-report', { bare: true, headers: { 'content-type': 'application/json' }, body: '{}' }))).status, 403);
  assert.strictEqual((await app.handle(req('POST', '/csp-report', { bare: true, headers: { 'content-type': 'application/csp-report' }, body: Buffer.alloc(17000, 32) }))).status, 413);
  const ts = String(Math.floor(t / 1000)); const nonce = crypto.randomBytes(12).toString('hex');
  const sig = H.opsSignature(opsKey, 'POST', C.BASE + '/ops/daily', ts, nonce);
  const ops = () => req('POST', '/ops/daily', { bare: true, headers: { 'content-type': 'application/json', 'x-wts-ts': ts, 'x-wts-nonce': nonce, 'x-wts-sig': sig } });
  const first = await app.handle(ops());
  assert.strictEqual(first.status, 200, 'signed call reaches the handler');
  assert.ok(C.checkShape('OpsDailyRes', json(first)).ok, 'no jobs credential here: skipped, nothing touched');
  assert.strictEqual((await app.handle(ops())).status, 403, 'replayed nonce refused');
  t += 6 * 60 * 1000;
  const n2 = crypto.randomBytes(12).toString('hex');
  assert.strictEqual((await app.handle(req('POST', '/ops/daily', { bare: true, headers: { 'content-type': 'application/json', 'x-wts-ts': ts, 'x-wts-nonce': n2, 'x-wts-sig': H.opsSignature(opsKey, 'POST', C.BASE + '/ops/daily', ts, n2) } }))).status, 403, 'outside ±5 min');
  const off = createApp({ config: cfg({ ACCOUNTS_OFF: '1' }) });
  assert.strictEqual(json(await off.handle(req('POST', '/auth/code/start', { body: { email: 'a@b.example', purpose: 'signin' } }))).error, 'paused');
  assert.strictEqual((await off.handle(req('GET', '/health'))).status, 200);
  assert.strictEqual((await off.handle(req('GET', '/auth/providers'))).status, 200);
});

test('production: proxy signature required, original host from the trusted header, client address never from X-Forwarded-For', async () => {
  const config = loadConfig({ WTS_ENV: 'production', WTS_PROXY_SIG: 'sig-123', WTS_HOST_HEADER: 'x-host-original', WTS_CLIENT_IP_HEADER: 'x-host-client' });
  let seenIp = null;
  const handlers = Object.assign({}, fns.handlers, { health: (ctx) => { seenIp = ctx.ipPrefix; return { status: 200, body: { ok: true, db: false, ver: 'x' } }; } });
  const app = createApp({ config, handlers });
  const base = { 'x-host-original': 'welltest.h2oil.co.uk', 'x-wts-proxy-sig': 'sig-123', 'x-host-client': '198.51.100.23', 'x-forwarded-for': '1.2.3.4' };
  assert.strictEqual((await app.handle(req('GET', '/health', { headers: base }))).status, 200);
  assert.strictEqual(seenIp, '198.51.100.0/24');
  assert.strictEqual((await app.handle(req('GET', '/health', { headers: Object.assign({}, base, { 'x-wts-proxy-sig': 'wrong' }) }))).status, 404);
  assert.strictEqual((await app.handle(req('GET', '/health', { headers: Object.assign({}, base, { 'x-host-original': 'preview.example' }) }))).status, 404);
  const noSig = createApp({ config: loadConfig({ WTS_ENV: 'production' }) });
  assert.strictEqual((await noSig.handle(req('GET', '/health'))).status, 404, 'production without a proxy secret answers nothing');
  assert.deepStrictEqual(json(await app.handle(req('GET', '/auth/providers', { headers: base }))), { google: 'off', linkedin: 'off' });
});

test('dev runner serves the pipeline on 127.0.0.1 and refuses production', async () => {
  const dev = require('../dev');
  await assert.rejects(dev.start({ config: loadConfig({ WTS_ENV: 'production' }), port: 0 }), /refused/);
  const s = await dev.start({ config: loadConfig({ WTS_ENV: 'local', WTS_DEV_ORIGIN: 'http://localhost:8080' }), port: 0 });
  try {
    const r = await fetch(s.url + '/api/v1/health');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await r.json(), { ok: true, db: false, ver: 'wp0' });
    const w = await fetch(s.url + '/api/v1/auth/code/start', { method: 'POST', headers: { origin: 'http://localhost:8080', 'x-wts-req': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.example', purpose: 'signin' }) });
    assert.strictEqual(w.status, 503, 'no database in this runner: paused');
    const big = await fetch(s.url + '/api/v1/auth/code/start', { method: 'POST', headers: { origin: 'http://localhost:8080', 'x-wts-req': '1', 'content-type': 'application/json' }, body: 'x'.repeat(80000) });
    assert.strictEqual(big.status, 413);
  } finally { await s.close(); }
});

test('fail closed: a missing or unknown WTS_ENV is production (no proxy secret → 404; alerts on); ACCOUNTS_OFF allow-list', async () => {
  const c = loadConfig({});
  assert.strictEqual(c.env, 'production'); assert.strictEqual(c.production, true);
  assert.ok(c.warnings.some((w) => /WTS_ENV: not set/.test(w)));
  assert.ok(c.alerts.some((a) => /WTS_PROXY_SIG missing/.test(a)), 'the production alerts are raised');
  const app = createApp({ config: c });
  assert.strictEqual((await app.handle(req('GET', '/health'))).status, 404, 'the production Host with no proxy signature → 404');
  assert.strictEqual((await app.handle(req('GET', '/health', { headers: { host: 'localhost:8787' } }))).status, 404, 'localhost refused');
  const u = loadConfig({ WTS_ENV: 'staging' });
  assert.strictEqual(u.production, true); assert.ok(u.warnings.some((w) => /WTS_ENV: unknown value — treated as production/.test(w)));
  assert.strictEqual(loadConfig({ WTS_ENV: '  ' }).production, true);
  // ACCOUNTS_OFF: unknown non-empty values pause the accounts and warn
  for (const v of ['', '0', 'false', 'off', 'no', 'OFF']) assert.strictEqual(cfg({ ACCOUNTS_OFF: v }).accountsOff, false, JSON.stringify(v));
  for (const v of ['1', 'true', 'on', 'yes']) assert.strictEqual(cfg({ ACCOUNTS_OFF: v }).accountsOff, true, v);
  for (const v of ['2', 'enable', 'maybe']) {
    const x = cfg({ ACCOUNTS_OFF: v });
    assert.strictEqual(x.accountsOff, true, v + ' fails closed');
    assert.ok(x.warnings.some((w) => /ACCOUNTS_OFF: unknown value/.test(w)), v + ' warns');
  }
});

test('malformed percent escapes: 404 envelope with the common headers; the callback still answers 303; nothing throws', async () => {
  const app = createApp({ config: cfg() });
  assert.strictEqual(C.matchRoute('GET', '/projects/%E0%A4%A/head'), null);
  const r = await app.handle(req('GET', '/projects/%E0%A4%A/head'));
  assert.strictEqual(r.status, 404);
  assert.ok(C.checkError('not_found', json(r)).ok);
  ['Cache-Control', 'Vary', 'X-Content-Type-Options', 'Content-Security-Policy'].forEach((k) => assert.strictEqual(r.headers[k], H.COMMON_HEADERS[k]));
  for (const p of ['/auth/oauth/%E0%A4%A/callback?code=a&state=b', '/auth/oauth/%/callback', '/auth/oauth/goo%ZZgle/callback']) {
    const cb = await app.handle(req('GET', p));
    assert.strictEqual(cb.status, 303, p); assert.strictEqual(cb.headers.Location, 'https://welltest.h2oil.co.uk/#acct-oauth');
    assert.strictEqual(cb.headers['Cache-Control'], 'no-store');
  }
  // a handler that throws a plain error ends as a 500 envelope with the common headers
  const boom = createApp({ config: cfg(), handlers: Object.assign({}, fns.handlers, { health: () => { throw new TypeError('x'); } }) });
  const b = await boom.handle(req('GET', '/health'));
  assert.strictEqual(b.status, 500); assert.deepStrictEqual(json(b), { error: 'server', message: 'Server error.' });
  assert.strictEqual(b.headers['Cache-Control'], 'no-store');
  const weird = await app.handle({ method: 'GET', url: null, headers: null, body: null });
  assert.strictEqual(weird.status, 404, 'no url / headers → 404, not a throw');
});

test('production without WTS_CLIENT_IP_HEADER: an alert, and no client address range (provider sign-in is refused on it)', async () => {
  const bare = loadConfig({ WTS_ENV: 'production', WTS_PROXY_SIG: 'x' });
  assert.ok(bare.alerts.some((a) => /WTS_CLIENT_IP_HEADER missing/.test(a)), JSON.stringify(bare.alerts));
  const withH = loadConfig({ WTS_ENV: 'production', WTS_PROXY_SIG: 'x', WTS_CLIENT_IP_HEADER: 'x-client-ip' });
  assert.deepStrictEqual(withH.alerts.filter((a) => /CLIENT_IP/.test(a)), []);
  let seen = 'unset';
  const echo = (config) => createApp({ config, handlers: Object.assign({}, fns.handlers, { health: (ctx) => { seen = ctx.ipPrefix; return { status: 200, body: { ok: true } }; } }) });
  await echo(bare).handle(req('GET', '/health', { headers: { 'x-wts-proxy-sig': 'x' }, ip: '198.51.100.7' }));
  assert.strictEqual(seen, null, 'the socket address (the proxy) is never a client range');
  await echo(withH).handle(req('GET', '/health', { headers: { 'x-wts-proxy-sig': 'x', 'x-client-ip': '203.0.113.9' } }));
  assert.strictEqual(seen, '203.0.113.0/24');
  // the security minimum is unset by default: no 426 for any app version (raised only for a security fix, §3.2)
  assert.strictEqual(loadConfig({ WTS_ENV: 'test' }).minClient, '');
});

test('proxy signature rotation: both comma-separated values are accepted, others refused', async () => {
  const config = loadConfig({ WTS_ENV: 'production', WTS_PROXY_SIG: 'sig-new, sig-old' });
  assert.deepStrictEqual(config.alerts.filter((a) => /PROXY/.test(a)), []);
  const app = createApp({ config });
  for (const [sig, st] of [['sig-new', 200], ['sig-old', 200], ['sig-other', 404], ['sig-new,sig-old', 404], ['', 404]]) {
    assert.strictEqual((await app.handle(req('GET', '/health', { headers: { 'x-wts-proxy-sig': sig } }))).status, st, JSON.stringify(sig));
  }
  assert.ok(!JSON.stringify(config.redacted()).includes('sig-old'));
});

test('session cookie: Max-Age through ctx.setCookie(def, value, {maxAge}); never without one', async () => {
  const handlers = Object.assign({}, fns.handlers, {
    health: (ctx) => { ctx.setCookie(C.COOKIES.session, 'sid1', { maxAge: 180 * 86400 }); return { status: 200, body: { ok: true, db: false, ver: 'x' } }; },
    providers: (ctx) => { ctx.setCookie(C.COOKIES.session, 'sid2'); return { status: 200, body: { google: 'off', linkedin: 'off' } }; },
  });
  const app = createApp({ config: cfg(), handlers });
  const r = await app.handle(req('GET', '/health'));
  assert.deepStrictEqual(r.cookies, ['__Host-wts_sid=sid1; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000']);
  const bad = await app.handle(req('GET', '/auth/providers'));
  assert.strictEqual(bad.status, 500, 'a session cookie without a lifetime is a server bug, never sent');
  assert.deepStrictEqual(bad.cookies, []);
});

test('ops-daily nonces: a shared store is used; production without one refuses; the memory store is test-only', async () => {
  const opsKey = crypto.randomBytes(32);
  const t = Date.UTC(2026, 10, 8, 12, 0, 0);
  const claimed = new Set(); let calls = 0;
  const shared = { async claim(n) { calls++; if (claimed.has(n)) return false; claimed.add(n); return true; } };
  const mk = (store) => createApp({ config: cfg({ WTS_OPS_HMAC: opsKey.toString('base64') }), now: () => t, opsNonces: store });
  const a1 = mk(shared); const a2 = mk(shared);                 // two function instances, one store
  const ts = String(Math.floor(t / 1000)); const nonce = crypto.randomBytes(12).toString('hex');
  const sig = H.opsSignature(opsKey, 'POST', C.BASE + '/ops/daily', ts, nonce);
  const ops = () => req('POST', '/ops/daily', { bare: true, headers: { 'content-type': 'application/json', 'x-wts-ts': ts, 'x-wts-nonce': nonce, 'x-wts-sig': sig } });
  assert.strictEqual((await a1.handle(ops())).status, 200);
  assert.strictEqual((await a2.handle(ops())).status, 403, 'a replay on another instance is refused');
  assert.strictEqual(calls, 2);
  const prod = createApp({ config: loadConfig({ WTS_ENV: 'production', WTS_PROXY_SIG: 'p', WTS_OPS_HMAC: opsKey.toString('base64') }), now: () => t });
  const pr = ops(); pr.headers['x-wts-proxy-sig'] = 'p';
  assert.strictEqual((await prod.handle(pr)).status, 403, 'production without a shared nonce store refuses ops-daily');
  assert.strictEqual(await H.verifyOps(ops(), C.BASE + '/ops/daily', cfg({ WTS_OPS_HMAC: opsKey.toString('base64') }), t, null), false);
});
