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
    [req('POST', '/auth/code/start', { body: ok }), 501, 'not_implemented'],
    [req('GET', '/nope'), 404, 'not_found'],
    [req('GET', '/health.json'), 404, 'not_found'],
    [req('GET', '/health', { headers: { host: 'other.example' } }), 404, 'not_found'],
    [req('DELETE', '/health'), 404, 'not_found'],
    [req('PUT', '/blobs/' + 'a'.repeat(64) + '/0', { body: Buffer.from([1, 2]), ct: 'application/json' }), 403, 'origin'],
    [req('PUT', '/blobs/' + 'a'.repeat(64) + '/0', { body: Buffer.from([1, 2]), ct: 'application/octet-stream' }), 501, 'not_implemented'],
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
  assert.strictEqual((await app.handle(ops())).status, 501, 'signed call reaches the handler');
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
    assert.strictEqual(w.status, 501);
    const big = await fetch(s.url + '/api/v1/auth/code/start', { method: 'POST', headers: { origin: 'http://localhost:8080', 'x-wts-req': '1', 'content-type': 'application/json' }, body: 'x'.repeat(80000) });
    assert.strictEqual(big.status, 413);
  } finally { await s.close(); }
});
