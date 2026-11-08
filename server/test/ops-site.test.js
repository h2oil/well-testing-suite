'use strict';
// server/test/ops-site.test.js — WP-OPS: the functions-only site adapter, preview isolation, monitoring hooks, host
// bindings, the bundle build and the secret scan (docs/ACCOUNTS-PLAN.md §13.1–13.3, §13.6, §13.8). No database needed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('../core/config');
const { checkIsolation, kidsOf, dbNameOf } = require('../site/isolation');
const M = require('../site/monitor');
const A = require('../site/adapters');
const { createHandler } = require('../site/handler');
const scan = require('../ci/secret-scan');

const key = (kid) => kid + ':' + crypto.randomBytes(32).toString('base64');
const quiet = () => { const lines = []; return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) }; };
const PROD = 'https://welltest.h2oil.co.uk';

test('isolation: kid and database-name conventions, preview sign-in flag, production fail-safes', () => {
  assert.deepStrictEqual(kidsOf('1:aaa, 9001:bbb,bad'), [1, 9001]);
  assert.strictEqual(dbNameOf('scheme://u:p@h:5/wts_preview?x=1'), 'wts_preview');
  const prodEnv = { WTS_ENV: 'production', WTS_PROXY_SIG: 'x', WTS_MASTER_KEYS: key(1), WTS_CODE_PEPPERS: key(2), WTS_DB_URL: 'scheme://h/wts' };
  const ok = checkIsolation(loadConfig(prodEnv), prodEnv);
  assert.ok(ok.ok, JSON.stringify(ok.problems)); assert.strictEqual(ok.signinAllowed, true);
  [{ WTS_MASTER_KEYS: key(9001) }, { WTS_CODE_PEPPERS: key(9500) }, { WTS_DB_URL: 'scheme://h/wts_preview' }, { WTS_DB_URL: 'scheme://h/drill_1' },
    { WTS_PREVIEW_SIGNIN: '1' }, { WTS_DRILL_ADMIN_URL: 'x' }, { WTS_MIGRATE_DB_URL: 'x' }].forEach((patch) => {
    const env = Object.assign({}, prodEnv, patch);
    assert.ok(!checkIsolation(loadConfig(env), env).ok, 'production refuses ' + Object.keys(patch)[0]);
  });
  const pv = { WTS_ENV: 'preview', WTS_MASTER_KEYS: key(9001), WTS_CODE_PEPPERS: key(9002), WTS_DB_URL: 'scheme://h/wts_preview' };
  const r = checkIsolation(loadConfig(pv), pv);
  assert.ok(r.ok, JSON.stringify(r.problems)); assert.strictEqual(r.signinAllowed, false, 'preview: sign-in off by default');
  assert.strictEqual(checkIsolation(loadConfig(pv), Object.assign({}, pv, { WTS_PREVIEW_SIGNIN: '1' })).signinAllowed, true);
  [{ WTS_MASTER_KEYS: key(3) }, { WTS_CODE_PEPPERS: key(4) }, { WTS_DB_URL: 'scheme://h/wts' }, { OAUTH_GOOGLE_CLIENT_SECRET: 's' },
    { OAUTH_LINKEDIN_CLIENT_SECRET: 's' }, { WTS_MAIL_CREDENTIAL: 'm' }].forEach((patch) => {
    const env = Object.assign({}, pv, patch);
    assert.ok(!checkIsolation(loadConfig(env), env).ok, 'preview refuses ' + Object.keys(patch)[0]);
  });
  // an unset WTS_ENV is production (config.js fails closed) and gets the production checks
  const unset = { WTS_MASTER_KEYS: key(9001) };
  assert.strictEqual(checkIsolation(loadConfig(unset), unset).env, 'production');
  assert.ok(!checkIsolation(loadConfig(unset), unset).ok);
});

test('monitor: access lines carry nothing personal; redaction; summary; §13.6 rules; alert sender', async () => {
  const l = JSON.parse(M.accessLine({ rid: 'abc123', route: 'codeStart', status: 200, ms: 12.6, ip: '203.0.113.77', email: 'a@b.example', cookie: 'sid', body: 'x' }));
  assert.deepStrictEqual(Object.keys(l).sort(), ['ip' + 'p', 'ms', 'rid', 'route', 'status', 't'].sort());
  assert.strictEqual(l.ipp, '203.0.113.0/24'); assert.strictEqual(l.ms, 13);
  assert.strictEqual(JSON.parse(M.accessLine({ route: '/api/v1/projects/123', status: 404, ip: '2001:db8:aa:bb::1' })).route, 'unmatched');
  assert.strictEqual(M.ipPrefix('2001:db8:aa:bb::1'), '2001:db8:aa::/48');
  assert.strictEqual(M.ipPrefix('::ffff:198.51.100.9'), '198.51.100.0/24');
  const red = M.redactLine('send to someone@corp.example code 123456 token ' + 'A'.repeat(30) + ' /cb?code=xyz&state=abc');
  assert.ok(!/someone@|123456|AAAAAAAAAAAAAAAAAAAAAAAAAA|code=xyz|state=abc/.test(red), red);
  const lines = [];
  for (let i = 0; i < 97; i++) lines.push(M.accessLine({ route: 'me', status: 200, ms: 10 + i, ip: '1.2.3.4' }));
  lines.push(M.accessLine({ route: 'me', status: 500, ms: 3000, ip: '1.2.3.4' }), M.accessLine({ route: 'me', status: 502, ms: 2500, ip: '1.2.3.4' }), M.accessLine({ route: 'me', status: 503, ms: 2600, ip: '1.2.3.4' }), 'not json');
  for (let i = 0; i < 12; i++) lines.push(M.accessLine({ route: 'oauthFinish', provider: 'google', status: i < 4 ? 400 : 200, ms: 5, ip: '1.2.3.4' }));
  const s = M.summarise(lines);
  assert.strictEqual(s.requests, 112); assert.ok(Math.abs(s.http5xxRate - 3 / 112) < 1e-9); assert.ok(s.p95Ms >= 100);
  assert.strictEqual(s.providerFinish.google.n, 12);
  const alerts = M.evaluate({ requests: s.requests, http5xxRate: s.http5xxRate, p95Ms: 2500, codeSendsHour: 301, storageRatio: 0.5,
    providerFailRate: { google: s.providerFinish.google.failRate, linkedin: 0.9 }, providerN: { google: 12, linkedin: 3 },
    verifyFails: 60, rate429: 15, outboxAgeMin: 6, deletionLagHours: 2, subjectMultiLinked: 1, isolationProblems: 0 }, { verifyFails: 10, rate429: 1 });
  const ids = alerts.map((a) => a.id).sort();
  assert.deepStrictEqual(ids, ['codeSends', 'http5xx', 'latency', 'outboxAge', 'providerGoogle', 'subjectMulti', 'verifyFails'].sort(), JSON.stringify(alerts));
  assert.deepStrictEqual(M.evaluate({ requests: 10, http5xxRate: 0.5 }), [], 'too few requests → no 5xx alert');
  assert.deepStrictEqual(M.evaluate({}), [], 'absent metrics never alert');
  ['http5xx', 'latency', 'codeSends', 'verifyFails', 'rate429', 'storage', 'bounce', 'complaint', 'deletionLag', 'outboxAge', 'providerGoogle',
    'providerLinkedin', 'jwksFetch', 'unknownKid', 'breaker', 'ceiling', 'linkSpike', 'subjectMulti', 'pins', 'readAnomaly', 'commitBurst', 'ipSoft']
    .forEach((id) => assert.ok(M.RULES.some((r) => r.id === id), 'rule ' + id));
  const log = quiet(); const calls = [];
  const fakeFetch = async (u, o) => { calls.push([u, JSON.parse(o.body)]); return { ok: true, status: 200 }; };
  const sent = await M.sendAlerts(alerts, { log, webhook: 'https://hook.example/t', fetch: fakeFetch });
  assert.strictEqual(sent.posted, true); assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0][1].alerts.length, alerts.length);
  assert.strictEqual(log.lines.filter((x) => /^alert: /.test(x[1])).length, alerts.length);
  const s2 = await M.sendAlerts(alerts, { log: quiet(), webhook: 'http://plain.example', fetch: fakeFetch });
  assert.strictEqual(s2.posted, false, 'only https hooks');
  assert.deepStrictEqual(await M.sendAlerts([], { webhook: 'https://hook.example', fetch: fakeFetch }), { logged: 0, posted: false });
});

test('adapters: host blob store binding validates keys and normalises list shapes; e-mail transport', async () => {
  const uid = '0b8f0f62-6a50-4a0c-9d7a-2a8e7f1e3a10'; const hex = 'ab'.repeat(32);
  for (const shape of ['array', 'blobs', 'objects']) {
    const m = new Map();
    const store = {
      async get(k) { return m.has(k) ? new Uint8Array(m.get(k)).buffer : null; },
      async set(k, v) { m.set(k, Buffer.from(v)); },
      async delete(k) { m.delete(k); },
      async list(o) { const ks = Array.from(m.keys()).filter((k) => k.startsWith(o.prefix)); return shape === 'array' ? ks : { [shape]: ks.map((key) => ({ key })) }; },
    };
    const o = A.hostObjects(store);
    await o.put('u/' + uid + '/b/' + hex + '/0', Buffer.from('chunk'));
    await o.put('ledger/' + uid, Buffer.from('{"userId":"' + uid + '"}'));
    await o.put('chain/2026-11-08', Buffer.from('{}'));
    assert.strictEqual((await o.get('u/' + uid + '/b/' + hex + '/0')).toString(), 'chunk');
    assert.strictEqual(await o.get('chain/2026-11-09'), null);
    assert.deepStrictEqual(await o.list('ledger/'), ['ledger/' + uid]);
    assert.strictEqual(await o.delPrefix('u/' + uid + '/'), 1);
    for (const bad of ['../etc/passwd', 'u/' + uid + '/x', 'ledger/../../x', '', 'chain/2026-1-1']) await assert.rejects(o.put(bad, Buffer.from('x')), /bad key/, bad);
    await assert.rejects(o.list('u/'), /bad prefix/);
  }
  assert.throws(() => A.hostObjects({}), /get \/ set \/ delete \/ list/);
  const sent = [];
  const mail = A.httpMail({ url: 'https://mail.example/send', credential: 'cred', from: 'no-reply@h2oil.co.uk', fetch: async (u, o) => { sent.push({ u, o }); return { ok: true }; } });
  await mail.send({ to: 'user@corp.example', template: 'code_signin', params: { code: '123456', browser: 'B', os: 'O', at: 'now' } });
  const body = JSON.parse(sent[0].o.body);
  assert.strictEqual(sent[0].o.headers.Authorization, 'Bearer cred');
  assert.strictEqual(body.to, 'user@corp.example'); assert.ok(body.text.includes('123456')); assert.ok(!/<[a-z]/i.test(body.text), 'plain text only');
  await assert.rejects(mail.send({ to: 'user@corp.example', template: 'nope', params: {} }));
  const failing = A.httpMail({ url: 'https://mail.example/send', credential: 'c', fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(failing.send({ to: 'u@corp.example', template: 'code_signin', params: { code: '1', browser: 'b', os: 'o', at: 'a' } }), /503/);
  assert.throws(() => A.httpMail({ url: 'http://mail.example', credential: 'c' }), /https/);
});

function webReq(method, p, o) {
  o = o || {};
  const headers = Object.assign({ host: 'welltest.h2oil.co.uk' }, o.headers || {});
  return new Request('https://fn.example' + '/api/v1' + p, { method, headers, body: o.body });
}

test('handler: web and event conventions, site headers, access log, isolation and preview gates, body cap', async () => {
  const log = quiet();
  const h = createHandler({ env: { WTS_ENV: 'test' }, log });
  const r = await h.handle(webReq('GET', '/health'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.strictEqual(r.headers.get('content-security-policy'), "default-src 'none'");
  assert.strictEqual(r.headers.get('referrer-policy'), 'same-origin');
  assert.strictEqual((await r.json()).ok, true);
  const access = log.lines.filter((x) => x[1].startsWith('{"t":"access"')).map((x) => JSON.parse(x[1]));
  assert.strictEqual(access.length, 1); assert.strictEqual(access[0].route, 'health'); assert.strictEqual(access[0].status, 200);
  const r404 = await h.handle(webReq('GET', '/health', { headers: { host: 'preview--site.example' } }));
  assert.strictEqual(r404.status, 404, 'a non-production host gets 404');
  // the callback keeps its own Referrer-Policy
  const cb = await h.handle(webReq('GET', '/auth/oauth/google/callback?code=x&state=y'));
  assert.strictEqual(cb.status, 303); assert.strictEqual(cb.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(!log.lines.some((x) => /code=x|state=y/.test(x[1])), 'no query string in any log line');
  // body cap before reading (Content-Length) → 413
  const big = await h.invoke({ method: 'POST', url: '/api/v1/csp-report', headers: { host: 'welltest.h2oil.co.uk', 'content-type': 'application/csp-report' }, body: null, tooLarge: true });
  assert.strictEqual(big.status, 413);
  const big2 = await h.handle(webReq('POST', '/csp-report', { headers: { 'content-type': 'application/csp-report' }, body: 'x'.repeat(17000) }));
  assert.strictEqual(big2.status, 413);
  // event convention
  const ev = await h.classic({ httpMethod: 'GET', path: '/api/v1/health', headers: { Host: 'welltest.h2oil.co.uk' } });
  assert.strictEqual(ev.statusCode, 200); assert.strictEqual(JSON.parse(ev.body).ok, true); assert.strictEqual(ev.isBase64Encoded, false);
  const ev2 = await h.classic({ httpMethod: 'POST', path: '/api/v1/auth/code/start', headers: { Host: 'welltest.h2oil.co.uk', Origin: 'https://evil.example', 'Content-Type': 'application/json', 'X-WTS-Req': '1' }, body: '{}' });
  assert.strictEqual(ev2.statusCode, 403); assert.strictEqual(JSON.parse(ev2.body).error, 'origin');
  // isolation failure: only /health answers
  const bad = createHandler({ env: { WTS_ENV: 'test', WTS_MASTER_KEYS: key(5) }, log: quiet() });
  assert.strictEqual(bad.state().ready, false);
  assert.strictEqual((await bad.handle(webReq('GET', '/health'))).status, 200);
  const p = await bad.handle(webReq('GET', '/me'));
  assert.strictEqual(p.status, 503); assert.strictEqual((await p.json()).error, 'paused');
  // preview without the flag: sign-in routes paused; the host check still 404s anything but the production host
  const pv = createHandler({ env: { WTS_ENV: 'preview', WTS_HOST_HEADER: 'x-original-host' }, log: quiet() });
  assert.strictEqual(pv.state().isolation.signinAllowed, false);
  const cs = await pv.handle(webReq('POST', '/auth/code/start', { headers: { 'x-original-host': 'welltest.h2oil.co.uk', origin: PROD, 'x-wts-req': '1', 'content-type': 'application/json' }, body: '{"email":"a@b.example","purpose":"signin"}' }));
  assert.strictEqual(cs.status, 503);
  assert.strictEqual((await pv.handle(webReq('GET', '/health', { headers: { 'x-original-host': 'welltest.h2oil.co.uk' } }))).status, 200);
  // production without a proxy signature answers 404 to everything (the functions site is reachable only via the rewrite)
  const prod = createHandler({ env: { WTS_ENV: 'production' }, log: quiet() });
  assert.strictEqual((await prod.handle(webReq('GET', '/health'))).status, 404);
  const prod2 = createHandler({ env: { WTS_ENV: 'production', WTS_PROXY_SIG: 'sig-now,sig-old' }, log: quiet() });
  assert.strictEqual((await prod2.handle(webReq('GET', '/health', { headers: { 'x-wts-proxy-sig': 'sig-old' } }))).status, 200);
  assert.strictEqual((await prod2.handle(webReq('GET', '/health', { headers: { 'x-wts-proxy-sig': 'nope' } }))).status, 404);
  assert.ok(prod2.state().ready, JSON.stringify(prod2.state().isolation));
});

test('build: the bundle holds the functions only, its entry answers, nothing static but robots.txt', () => {
  const B = require('../site/build');
  const out = fs.mkdtempSync(path.join(path.join(__dirname, '..'), '.build-test-'));
  try {
    const r = B.build({ out });
    const names = fs.readdirSync(out).sort();
    assert.deepStrictEqual(names, ['build-info.json', 'core', 'db', 'functions', 'package-lock.json', 'package.json', 'site', 'static']);
    assert.deepStrictEqual(fs.readdirSync(path.join(out, 'static')), ['robots.txt']);
    assert.ok(!fs.existsSync(path.join(out, 'test')) && !fs.existsSync(path.join(out, 'ops')) && !fs.existsSync(path.join(out, 'ci')));
    const info = JSON.parse(fs.readFileSync(path.join(out, 'build-info.json'), 'utf8'));
    assert.strictEqual(info.files.length, r.files);
    const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site', 'site.json'), 'utf8'));
    assert.strictEqual(site.static, null); assert.deepStrictEqual(site.functions[0].paths, ['/api/v1/*']);
    assert.ok(site.deploy.from.includes('server-v*'));
    // the generated entry loads from the bundle; with no environment it is production and fails closed (404 without the
    // proxy signature)
    const saved = process.env.WTS_ENV; delete process.env.WTS_ENV;
    try {
      const api = require(path.join(out, 'functions', 'api.js'));
      assert.strictEqual(typeof api, 'function'); assert.strictEqual(typeof api.handler, 'function'); assert.deepStrictEqual(api.config, { path: '/api/v1/*' });
      return api.handler({ httpMethod: 'GET', path: '/api/v1/health', headers: { host: 'welltest.h2oil.co.uk' } }).then((ev) => assert.strictEqual(ev.statusCode, 404));
    } finally { if (saved !== undefined) process.env.WTS_ENV = saved; }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  assert.throws(() => B.build({ out: os.tmpdir() }), /inside server/);
});

test('secret scan: key material and secret literals are found, names and placeholders are not; server/ is clean', () => {
  const pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const t = [
    'const x = process.env.WTS_MASTER_KEYS;',
    "WTS_PROXY_SIG: 'test-proxy-sig',",
    "WTS_OPS_HMAC: 'k8Jd02jfKs9d" + "Lq0Zx7Vb3Nw1Pq5Rt6Yu',",       // split so the scan of this file stays clean
    pem,
    "const clientSecret = 'Zq8wE2rT6yU1" + "iO9pA3sD5fG7hJ0kL4z';",
    'url = "scheme://admin:Sup3rS3' + 'cretPw@db.internal.example:5432/wts"',
    'local = "scheme://wts_admin:pw123456@127.0.0.1:54010/wts"',
    "token: '${{ secrets.WTS_DEPLOY_TOKEN }}'",
  ].join('\n');
  const f = scan.scanText(t, ['WTS_MASTER_KEYS', 'WTS_PROXY_SIG', 'WTS_OPS_HMAC']);
  assert.deepStrictEqual(f.map((x) => x.line + ':' + x.rule), ['3:secret-literal', '4:pem-private', '5:named-literal', '6:url-password']);
  assert.strictEqual(scan.scanText('{"kty":"RSA","n":"x","e":"AQAB","d":"' + 'Q'.repeat(30) + '"}').length, 1);
  assert.ok(scan.KEY_FILE.test('server/.env') && scan.KEY_FILE.test('a/b.pem') && !scan.KEY_FILE.test('server/core/keys.js'));
  const r = scan.scan(['server', '.github/workflows']);
  assert.deepStrictEqual(r.findings, [], 'server/ and the workflows are clean');
  assert.ok(r.files > 20);
});
