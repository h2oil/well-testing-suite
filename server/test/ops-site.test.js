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
    { WTS_PREVIEW_SIGNIN: '1' }, { WTS_DRILL_ADMIN_URL: 'x' }, { WTS_MIGRATE_DB_URL: 'x' }, { WTS_SUPPORT_DB_URL: 'x' },
    { WTS_BACKUP_KEY: 'x' }, { WTS_BACKUP_DB_URL: 'x' }, { WTS_EXPORT_CREDENTIAL: 'x' }].forEach((patch) => {
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
  for (let i = 0; i < 12; i++) lines.push(M.accessLine({ route: 'oauthFinish', provider: 'google', status: i < 4 ? 400 : 200, err: i < 4 ? 'oauth_failed' : undefined, ms: 5, ip: '1.2.3.4' }));
  // a user-side refusal of a finish is not a provider failure
  lines.push(M.accessLine({ route: 'oauthFinish', provider: 'google', status: 403, err: 'not_invited', ms: 5, ip: '1.2.3.4' }));
  // callbacks are always 303: their outcome decides
  ['ok', 'ok', 'exchange_failed', 'state'].forEach((outcome) => lines.push(M.accessLine({ route: 'oauthCallback', provider: 'linkedin', status: 303, outcome, ms: 5, ip: '1.2.3.4' })));
  // verifyFails counts only invalid_or_expired, never a schema failure
  lines.push(M.accessLine({ route: 'codeVerify', status: 400, err: 'invalid_or_expired', ms: 5, ip: '1.2.3.4' }), M.accessLine({ route: 'codeVerify', status: 400, err: 'bad_request', ms: 5, ip: '1.2.3.4' }));
  const s = M.summarise(lines);
  assert.strictEqual(s.requests, 119); assert.ok(Math.abs(s.http5xxRate - 3 / 119) < 1e-9); assert.ok(s.p95Ms >= 100);
  assert.strictEqual(s.providerFinish.google.n, 13); assert.ok(Math.abs(s.providerFinish.google.failRate - 4 / 13) < 1e-9);
  assert.deepStrictEqual(s.providerFinish.linkedin, { n: 4, failRate: 0.5 });
  assert.deepStrictEqual(s.callbackOutcomes, { ok: 2, exchange_failed: 1, state: 1 });
  assert.strictEqual(s.verifyFails, 1);
  const cbLine = JSON.parse(M.accessLine({ rid: 'r1d2e3', route: 'oauthCallback', status: 303, outcome: 'exchange_failed', provider: 'google', err: 'Bad Value!', ip: '1.2.3.4' }));
  assert.deepStrictEqual([cbLine.outcome, cbLine.provider, cbLine.err], ['exchange_failed', 'google', undefined], 'fields are validated');
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
  // every rule has a declared data source, and every declared source really produces the metric
  const MC = require('../ops/monitor-check');
  const lineMetrics = new Set(['requests', 'http5xxRate', 'p95Ms', 'rate429', 'verifyFails', 'providerFailRate', 'providerN']);
  M.RULES.forEach((r) => {
    assert.ok(M.SOURCES.includes(r.source), 'rule ' + r.id + ' declares a source');
    const top = r.metric.split('.')[0];
    if (r.source === 'db') assert.ok(MC.DB_METRICS[r.metric], 'monitor-check computes ' + r.metric + ' (' + r.id + ')');
    if (r.source === 'lines') assert.ok(lineMetrics.has(top), 'summarise feeds ' + r.metric + ' (' + r.id + ')');
    if (r.source === 'log') assert.ok(M.LOG_ALERTS[r.id], 'log alert ' + r.id + ' is listed with its emitter');
    if (r.minMetric && r.source === 'db') assert.ok(MC.DB_METRICS[r.minMetric], 'monitor-check computes ' + r.minMetric);
  });
  assert.deepStrictEqual(M.RULES.filter((r) => r.source === 'code').map((r) => r.id), ['pins']);
  assert.strictEqual(typeof MC.codeMetrics().metrics.pinsFailed, 'number', 'pins computed from the deployed code');
  assert.deepStrictEqual(M.RULES.filter((r) => r.source === 'external').map((r) => r.id), ['complaint']);
  const L = MC.limits();
  assert.ok(L.codeStartIpHour.limit > 0 && L.commitBurst.limit > 0 && L.projectsReadSessionDay.limit > 0, 'thresholds from core/rate.js LIMITS (or the plan fallback)');
  // the RUNBOOK lists every alert id under §5
  const runbook = fs.readFileSync(path.join(__dirname, '..', 'RUNBOOK.md'), 'utf8');
  const s5 = runbook.slice(runbook.indexOf('## 5.'), runbook.indexOf('## 6.'));
  M.RULES.forEach((r) => assert.ok(s5.includes(r.id), 'RUNBOOK §5 names ' + r.id));
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
  await mail.send({ to: 'user@corp.example', template: 'code_signin', params: { code: '12345678', browser: 'B', os: 'O', at: 'now' } });
  const body = JSON.parse(sent[0].o.body);
  assert.strictEqual(sent[0].o.headers.Authorization, 'Bearer cred');
  assert.strictEqual(body.to, 'user@corp.example'); assert.ok(body.text.includes('1234 5678') || body.text.includes('12345678')); assert.ok(!/<[a-z]/i.test(body.text), 'plain text only');
  await assert.rejects(mail.send({ to: 'user@corp.example', template: 'nope', params: {} }));
  const failing = A.httpMail({ url: 'https://mail.example/send', credential: 'c', fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(failing.send({ to: 'u@corp.example', template: 'code_signin', params: { code: '12345678', browser: 'b', os: 'o', at: 'a' } }), /503/);
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

test('handler: plan §2 gate order — an unsigned or foreign-host request gets 404 before isolation, preview and size gates', async () => {
  const host = 'welltest.h2oil.co.uk';
  const sig = { WTS_ENV: 'production', WTS_PROXY_SIG: 's1' };
  const big = (h, extra) => h.invoke({ method: 'POST', url: '/api/v1/csp-report', headers: Object.assign({ host, 'content-type': 'application/csp-report', 'content-length': '99999' }, extra || {}), body: null, tooLarge: true });
  const h1 = createHandler({ env: sig, log: quiet() });
  assert.strictEqual((await big(h1)).status, 404, 'unsigned + too large → 404');
  assert.strictEqual((await big(h1, { 'x-wts-proxy-sig': 's1' })).status, 413, 'signed + too large → 413');
  assert.strictEqual((await big(h1, { 'x-wts-proxy-sig': 's1', host: 'evil.example' })).status, 404, 'foreign host + too large → 404');
  // failed isolation (a preview kid in production)
  const h2 = createHandler({ env: Object.assign({}, sig, { WTS_MASTER_KEYS: key(9001) }), log: quiet() });
  assert.strictEqual(h2.state().ready, false);
  assert.strictEqual((await h2.handle(webReq('GET', '/me'))).status, 404, 'unsigned, failed isolation → 404');
  assert.strictEqual((await h2.handle(webReq('GET', '/me', { headers: { 'x-wts-proxy-sig': 's1' } }))).status, 503, 'signed, failed isolation → 503');
  // a preview sign-in route
  const pv = createHandler({ env: { WTS_ENV: 'preview', WTS_PROXY_SIG: 's1' }, log: quiet() });
  const start = (headers) => pv.handle(webReq('POST', '/auth/code/start', { headers: Object.assign({ origin: PROD, 'x-wts-req': '1', 'content-type': 'application/json' }, headers), body: '{"email":"a@b.example","purpose":"signin"}' }));
  assert.strictEqual((await start({ host: 'evil.example' })).status, 404, 'unsigned preview sign-in from a foreign host → 404');
  assert.strictEqual((await start({ host: 'evil.example', 'x-wts-proxy-sig': 's1' })).status, 404, 'signed, foreign host → 404');
  assert.strictEqual((await start({})).status, 404, 'unsigned preview sign-in → 404');
  assert.strictEqual((await start({ 'x-wts-proxy-sig': 's1' })).status, 503, 'signed preview sign-in → 503 paused');
  // outside the API base path → 404 too
  assert.strictEqual((await h1.invoke({ method: 'GET', url: '/api/v10/health', headers: { host, 'x-wts-proxy-sig': 's1' } })).status, 404);
});

test('handler: request id shared by the response and the access line; res.meta feeds provider, outcome and error', async () => {
  const log = quiet();
  const h = createHandler({ env: { WTS_ENV: 'test' }, log });
  const access = () => log.lines.filter((x) => x[1].startsWith('{"t":"access"')).map((x) => JSON.parse(x[1]));
  const r = await h.handle(webReq('GET', '/health'));
  const rid = r.headers.get('x-wts-request-id');
  assert.ok(/^[A-Za-z0-9_-]{12}$/.test(rid), rid);
  assert.strictEqual(access().pop().rid, rid, 'the access line carries the id returned to the browser');
  const r2 = await h.handle(webReq('GET', '/health'));
  assert.notStrictEqual(r2.headers.get('x-wts-request-id'), rid, 'one id per request');
  const cb = await h.handle(webReq('GET', '/auth/oauth/google/callback?code=x&state=y'));
  assert.strictEqual(cb.status, 303);
  let l = access().pop();
  // no attempt cookie: the callback handler records a state failure (functions/oauth.js sets ctx.req.meta.outcome)
  assert.deepStrictEqual([l.route, l.provider, l.outcome], ['oauthCallback', 'google', 'state']);
  await h.handle(webReq('GET', '/auth/oauth/other/callback?code=x'));
  l = access().pop();
  assert.strictEqual(l.outcome, 'state', 'an unknown provider is a state failure'); assert.strictEqual(l.provider, undefined);
  const v = await h.handle(webReq('POST', '/auth/code/verify', { headers: { origin: PROD, 'x-wts-req': '1', 'content-type': 'application/json' }, body: '{}' }));
  assert.strictEqual(v.status, 400);
  l = access().pop();
  assert.strictEqual(l.route, 'codeVerify'); assert.strictEqual(l.err, 'bad_request');
  assert.ok(!log.lines.some((x) => /"meta"/.test(x[1])), 'meta is never logged as such');
  // a handler adds what only it knows through ctx.req.meta (here: the uid and the outcome of a failed exchange)
  const { createApp } = require('../core/app');
  const uid = '0b8f0f62-6a50-4a0c-9d7a-2a8e7f1e3a10';
  const app = createApp({ config: loadConfig({ WTS_ENV: 'test' }), handlers: { oauthCallback(ctx) { ctx.req.meta.outcome = 'exchange_failed'; ctx.req.meta.uid = uid; return { status: 303 }; } } });
  const res = await app.handle({ method: 'GET', url: '/api/v1/auth/oauth/linkedin/callback?code=x&state=y', headers: { host: 'welltest.h2oil.co.uk' }, body: null });
  assert.strictEqual(res.status, 303);
  assert.deepStrictEqual(res.meta, { provider: 'linkedin', uid, outcome: 'exchange_failed' });
});

test('objects loader: binding module, folder, none; weekly export refuses to run without a store', async () => {
  const { loadObjects } = require('../site/objects-loader');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-objroot-'));
  try {
    assert.deepStrictEqual(loadObjects({}, { root }), { objects: null, kind: 'none', source: null });
    assert.throws(() => loadObjects({}, { root, required: true }), /no object store configured/);
    fs.mkdirSync(path.join(root, 'site'));
    const mod = "'use strict';\nconst m = new Map();\nmodule.exports.createStore = (env) => ({ env: !!env, async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { m.set(k, Buffer.from(v)); }, async delete(k) { m.delete(k); }, async list(o) { return Array.from(m.keys()).filter((k) => k.startsWith(o.prefix)); } });\n";
    fs.writeFileSync(path.join(root, 'site', 'objects-binding.js'), mod);
    const b = loadObjects({}, { root });
    assert.strictEqual(b.kind, 'binding'); assert.strictEqual(b.source, 'site/objects-binding.js');
    await b.objects.put('chain/2026-11-08', Buffer.from('{}'));
    assert.deepStrictEqual(await b.objects.list('chain/'), ['chain/2026-11-08']);
    await assert.rejects(b.objects.put('../x', Buffer.from('x')), /bad key/, 'the binding is wrapped by hostObjects');
    fs.writeFileSync(path.join(root, 'other.js'), mod);
    assert.strictEqual(loadObjects({ WTS_OBJECTS_BINDING: 'other.js' }, { root }).source, 'other.js');
    assert.throws(() => loadObjects({ WTS_OBJECTS_BINDING: '../escape.js' }, { root }), /inside the server folder/);
    assert.throws(() => loadObjects({ WTS_OBJECTS_BINDING: 'missing.js' }, { root }), /does not exist/);
    fs.writeFileSync(path.join(root, 'bad.js'), 'module.exports = {};');
    assert.throws(() => loadObjects({ WTS_OBJECTS_BINDING: 'bad.js' }, { root }), /createStore/);
    // a folder store comes from core/objects.js; a build without it says so instead of MODULE_NOT_FOUND
    let core = true; try { require('../core/objects'); } catch (e) { core = false; }
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-objroot-'));
    try {
      if (core) assert.strictEqual(loadObjects({ WTS_OBJECTS_DIR: empty }, { root: empty }).kind, 'folder');
      else assert.throws(() => loadObjects({ WTS_OBJECTS_DIR: empty }, { root: empty }), /no folder store \(core\/objects\.js\)/);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // §13.5: no store configured → the weekly export fails (before touching the database) unless --no-objects is passed
  const W = require('../ops/weekly-export');
  const dbUrl = ['scheme://wts_backup', '127.0.0.1:1/wts'].join('@');
  const env = { WTS_BACKUP_DB_URL: dbUrl, WTS_BACKUP_KEY: '1:' + crypto.randomBytes(32).toString('base64'), WTS_EXPORT_DIR: os.tmpdir() };
  if (!fs.existsSync(path.join(__dirname, '..', 'site', 'objects-binding.js'))) await assert.rejects(W.main(env, []), /no object store configured/);
  // the handler logs an unloadable binding as an alert and serves data routes paused instead of crashing
  const log = quiet();
  const h = createHandler({ env: { WTS_ENV: 'test', WTS_OBJECTS_BINDING: 'missing-binding.js' }, log });
  assert.strictEqual(h.state().objects, false);
  assert.ok(log.lines.some((x) => /^alert: objects — /.test(x[1])));
});

test('build: the bundle holds the functions only, its entry answers, nothing static but robots.txt', () => {
  const B = require('../site/build');
  const out = fs.mkdtempSync(path.join(path.join(__dirname, '..'), '.build-test-'));
  try {
    const r = B.build({ out });
    const names = fs.readdirSync(out).sort();
    assert.deepStrictEqual(names, ['build-info.json', 'core', 'db', 'entry', 'functions', 'package-lock.json', 'package.json', 'site', 'static']);
    assert.deepStrictEqual(fs.readdirSync(path.join(out, 'static')), ['robots.txt']);
    // the single host function sits alone in its folder; the route-table modules in functions/ are not host functions
    assert.deepStrictEqual(fs.readdirSync(path.join(out, 'entry')), ['api.js']);
    assert.ok(!fs.existsSync(path.join(out, 'functions', 'api.js')));
    // the blob store binding comes from site/ (committed, rebuilt with every release), never from a file beside the entry
    assert.ok(fs.existsSync(path.join(out, 'site', 'objects-loader.js')));
    assert.ok(!/require\([^)]*objects-binding/.test(B.ENTRY), 'the entry does not load a hand-placed binding');
    assert.strictEqual(fs.existsSync(path.join(out, 'site', 'objects-binding.js')), fs.existsSync(path.join(__dirname, '..', 'site', 'objects-binding.js')));
    assert.ok(!fs.existsSync(path.join(out, 'test')) && !fs.existsSync(path.join(out, 'ops')) && !fs.existsSync(path.join(out, 'ci')));
    const info = JSON.parse(fs.readFileSync(path.join(out, 'build-info.json'), 'utf8'));
    assert.strictEqual(info.files.length, r.files);
    const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site', 'site.json'), 'utf8'));
    assert.strictEqual(site.static, null); assert.deepStrictEqual(site.functions[0].paths, ['/api/v1/*']); assert.strictEqual(site.functions[0].entry, 'dist/entry/api.js'); assert.strictEqual(site.functions[0].functionsDir, 'dist/entry');
    assert.ok(site.deploy.from.includes('server-v*'));
    // the generated entry loads from the bundle; with no environment it is production and fails closed (404 without the
    // proxy signature)
    const saved = process.env.WTS_ENV; delete process.env.WTS_ENV;
    try {
      const api = require(path.join(out, 'entry', 'api.js'));
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
