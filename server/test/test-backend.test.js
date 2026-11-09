'use strict';
// server/test/test-backend.test.js — the disposable test backend (server/RUNBOOK.md "Test backend"): WTS_ENV=staging keeps
// every production security rule (proxy signature, host, origin, cookies, keys, providers) and only swaps the key-id rule,
// so keys never cross between staging and production; the Postmark mode of the mail transport (request shape, ErrorCode →
// transport error kinds, nothing personal in errors or logs; the generic JSON mode stays the default); the signed ops
// self-test of site/handler.js; and server/ops/remote-smoke.js against a local server. No database needed.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');
const path = require('path');
const { loadConfig } = require('../core/config');
const H = require('../core/http');
const { checkIsolation } = require('../site/isolation');
const A = require('../site/adapters');
const { createHandler, SELFTEST_PATH } = require('../site/handler');
const { deployRefusal } = require('../site/netlify');
const MAIL = require('../core/mail');
const smoke = require('../ops/remote-smoke');

const key = (kid) => kid + ':' + crypto.randomBytes(32).toString('base64');
const b64 = () => crypto.randomBytes(32).toString('base64');
const quiet = () => { const lines = []; return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) }; };
const SIG = crypto.randomBytes(32).toString('base64url');
const HMAC = b64();
const PROD = 'https://welltest.h2oil.co.uk';
function stagingEnv(extra) {
  return Object.assign({ WTS_ENV: 'staging', WTS_PROXY_SIG: SIG, WTS_OPS_HMAC: HMAC, WTS_MASTER_KEYS: key(9001), WTS_MASTER_KID: '9001',
    WTS_INDEX_PEPPER: b64(), WTS_CODE_PEPPERS: key(9001), WTS_SESSION_PEPPER: b64(), WTS_HOST_HEADER: 'x-wts-host',
    WTS_CLIENT_IP_HEADER: 'x-nf-client-connection-ip', ACCOUNTS_SIGNUP: 'open', WTS_VERSION: '4.0.0-test' }, extra || {});
}

test.describe('WTS_ENV=staging (disposable test backend)', () => {
  test('production for every security rule; signup open allowed; only "staging" exactly', () => {
    const c = loadConfig(stagingEnv({ WTS_DEV_ORIGIN: 'http://localhost:8080', WTS_OIDC_MODE: 'dev' }));
    assert.strictEqual(c.env, 'staging'); assert.strictEqual(c.staging, true); assert.strictEqual(c.production, true);
    assert.strictEqual(c.signup, 'open');
    assert.deepStrictEqual(c.allowedOrigins, [PROD], 'no development origin');
    assert.strictEqual(c.devOrigin, null); assert.strictEqual(c.oidcMode, '');
    assert.ok(c.alerts.some((a) => /WTS_OIDC_MODE is set on the production host/.test(a)), 'provider overrides refused as in production');
    assert.strictEqual(c.codeFloorMs, 400);
    const p = loadConfig({ WTS_ENV: 'production' });
    assert.strictEqual(p.staging, false);
    for (const v of ['stage', 'Staging-1', 'test-site', 'prod']) {
      const u = loadConfig({ WTS_ENV: v });
      assert.strictEqual(u.env, 'production', v); assert.strictEqual(u.staging, false);
    }
    assert.strictEqual(loadConfig({ WTS_ENV: ' STAGING ' }).env, 'staging');
    // no proxy signature on staging = everything 404, as in production
    assert.ok(loadConfig({ WTS_ENV: 'staging' }).alerts.some((a) => /WTS_PROXY_SIG missing/.test(a)));
  });

  test('request gates: signature, host, origin and cookies exactly as production', () => {
    const c = loadConfig(stagingEnv());
    const p = loadConfig(Object.assign(stagingEnv(), { WTS_ENV: 'production', WTS_MASTER_KEYS: key(1), WTS_CODE_PEPPERS: key(1), WTS_MASTER_KID: '1' }));
    const req = (h) => ({ method: 'POST', headers: h, remoteAddress: '127.0.0.1' });
    for (const cfg of [c, p]) {
      assert.strictEqual(H.proxyOk(req({}), cfg), false);
      assert.strictEqual(H.proxyOk(req({ 'x-wts-proxy-sig': SIG }), cfg), true);
      assert.strictEqual(H.hostAllowed(req({ 'x-wts-host': 'localhost:8787' }), cfg), false, 'no loopback host');
      assert.strictEqual(H.hostAllowed(req({ 'x-wts-host': 'welltest.h2oil.co.uk' }), cfg), true);
      const ep = { auth: 'none', body: 'json' };
      assert.strictEqual(H.writeHeadersOk(req({ 'x-wts-req': '1', 'content-type': 'application/json' }), ep, cfg), false, 'origin-less write refused');
      assert.strictEqual(H.writeHeadersOk(req({ origin: 'http://localhost:8080', 'x-wts-req': '1', 'content-type': 'application/json' }), ep, cfg), false);
      assert.strictEqual(H.writeHeadersOk(req({ origin: PROD, 'x-wts-req': '1', 'content-type': 'application/json' }), ep, cfg), true);
    }
  });

  test('isolation: staging needs the test key ids, production refuses them — keys never cross', () => {
    const env = stagingEnv({ NETLIFY_DB_URL: 'scheme://h/neondb' });
    const r = checkIsolation(loadConfig(env), env);
    assert.ok(r.ok, JSON.stringify(r.problems)); assert.strictEqual(r.signinAllowed, true);
    assert.ok(r.warnings.some((w) => /one-login database/.test(w)), 'the one-login warning as in production');
    [{ WTS_MASTER_KEYS: key(1) }, { WTS_CODE_PEPPERS: key(2) }, { WTS_MASTER_KID: '1' }, { WTS_PREVIEW_SIGNIN: '1' },
      { WTS_MIGRATE_DB_URL: 'x' }, { WTS_SUPPORT_DB_URL: 'x' }, { WTS_BACKUP_PRIVATE_KEY: 'x' }, { WTS_DRILL_ADMIN_URL: 'x' }].forEach((patch) => {
      const e = Object.assign({}, env, patch);
      assert.ok(!checkIsolation(loadConfig(e), e).ok, 'staging refuses ' + Object.keys(patch)[0]);
    });
    const asProd = Object.assign({}, env, { WTS_ENV: 'production' });
    const pr = checkIsolation(loadConfig(asProd), asProd);
    assert.ok(!pr.ok && pr.problems.some((p) => /non-production kid/.test(p)), 'the staging keys refused by production');
    // the weekly export key follows the same kid rule: the test backend never seals to the production recovery key
    const B = require('../site/backup');
    const testBk = B.generateBackupKeys(9001).publicKey; const prodBk = B.generateBackupKeys(1).publicKey;
    const sOk = Object.assign({}, env, { WTS_BACKUP_PUBLIC_KEY: testBk });
    assert.ok(checkIsolation(loadConfig(sOk), sOk).ok, 'staging accepts the test backup key');
    const sBad = Object.assign({}, env, { WTS_BACKUP_PUBLIC_KEY: prodBk });
    const rb = checkIsolation(loadConfig(sBad), sBad);
    assert.ok(!rb.ok && rb.problems.some((p) => /WTS_BACKUP_PUBLIC_KEY has a production kid/.test(p)), 'staging refuses the production backup key');
    const pBad = Object.assign({}, env, { WTS_ENV: 'production', WTS_MASTER_KEYS: key(1), WTS_CODE_PEPPERS: key(1), WTS_MASTER_KID: '1', WTS_BACKUP_PUBLIC_KEY: testBk });
    const rp = checkIsolation(loadConfig(pBad), pBad);
    assert.ok(!rp.ok && rp.problems.length === 1 && /WTS_BACKUP_PUBLIC_KEY has a non-production kid/.test(rp.problems[0]), JSON.stringify(rp.problems));
    const pOk = Object.assign({}, pBad, { WTS_BACKUP_PUBLIC_KEY: prodBk });
    assert.ok(checkIsolation(loadConfig(pOk), pOk).ok, 'production accepts the production backup key');
  });

  test('deploys: only the published production deploy runs (staging is production mode)', () => {
    const env = { WTS_ENV: 'staging' };
    assert.match(deployRefusal(env, { deploy: { context: 'deploy-preview' } }), /not a production deploy/);
    assert.match(deployRefusal(env, { deploy: { context: 'production', published: false } }), /not the published deploy/);
    assert.strictEqual(deployRefusal(env, { deploy: { context: 'production', published: true } }), '');
  });
});

test.describe('mail transport: Postmark mode (WTS_MAIL_PROVIDER=postmark)', () => {
  const MSG = MAIL.compose({ to: 'person@company.example', template: 'code_signin', params: { code: '12345678', browser: 'a web browser', os: 'a computer', at: '2026-11-09 10:00 UTC' } });
  const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  test('the request: endpoint, headers, body fields, plain text only, outbound stream', async () => {
    const sent = [];
    const t = A.postmarkMail({ credential: 'server-token-x', from: 'no-reply@h2oil.co.uk', fetch: async (u, o) => { sent.push({ u, o }); return { ok: true, status: 200, json: async () => ({ ErrorCode: 0, Message: 'OK' }) }; } });
    assert.strictEqual(t.kind, 'postmark');
    assert.strictEqual(await t.send(MSG), true);
    assert.strictEqual(sent[0].u, 'https://api.postmarkapp.com/email');
    assert.strictEqual(sent[0].o.method, 'POST');
    assert.deepStrictEqual(sent[0].o.headers, { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': 'server-token-x' });
    const b = JSON.parse(sent[0].o.body);
    assert.deepStrictEqual(Object.keys(b).sort(), ['From', 'MessageStream', 'Subject', 'TextBody', 'To']);
    assert.strictEqual(b.MessageStream, 'outbound'); assert.strictEqual(b.From, 'no-reply@h2oil.co.uk'); assert.strictEqual(b.To, 'person@company.example');
    assert.ok(b.TextBody.includes('1234 5678') && !/<[a-z]/i.test(b.TextBody));
    // an uncomposed message is rendered the same way
    await t.send({ to: 'person@company.example', template: 'notice_export', params: { at: '2026-11-09 10:00 UTC' } });
    assert.match(JSON.parse(sent[1].o.body).Subject, /export/);
    await assert.rejects(t.send({ to: 'x', template: 'notice_export', params: { at: 'a' } }), /to: expected an address/);
    assert.throws(() => A.postmarkMail({}), /server token/);
  });

  test('ErrorCode / status → the transport error kinds; never the service message, the address or the body', async () => {
    const cases = [
      [422, { ErrorCode: 300, Message: 'Invalid email: person@company.example' }, 'mail_rejected', false],
      [422, { ErrorCode: 406, Message: 'person@company.example is inactive' }, 'mail_rejected', false],
      [401, { ErrorCode: 10, Message: 'bad token' }, 'mail_auth', false],
      [422, { ErrorCode: 400, Message: 'Sender signature not found' }, 'mail_sender', false],
      [422, { ErrorCode: 412, Message: 'account pending' }, 'mail_sender', false],
      [429, { ErrorCode: 0, Message: 'rate' }, 'mail_rate', true],
      [422, { ErrorCode: 402, Message: 'Invalid JSON' }, 'mail_config', false],
      [422, { ErrorCode: 403, Message: 'Incompatible JSON' }, 'mail_config', false],
      [422, { ErrorCode: 422, Message: 'Invalid server' }, 'mail_config', false],
      [422, { ErrorCode: 1235, Message: 'Message stream not found' }, 'mail_config', false],
      [422, { ErrorCode: 1236, Message: 'Message stream unsupported' }, 'mail_config', false],
      [422, { ErrorCode: 1480, Message: 'IP not authorised' }, 'mail_config', false],
      [422, { ErrorCode: 11, Message: 'no permission' }, 'mail_config', false],
      [422, { ErrorCode: 413, Message: 'account paused' }, 'mail_sender', false],
      [500, null, 'mail_unavailable', true],
      [422, { ErrorCode: 999, Message: 'other' }, 'mail_failed', true],
      [200, { ErrorCode: 300, Message: 'odd: a 200 with an error code' }, 'mail_rejected', false],
    ];
    for (const [status, body, kind, retry] of cases) {
      const t = A.postmarkMail({ credential: 'tok', fetch: answer(status, body) });
      const e = await t.send(MSG).then(() => null, (x) => x);
      assert.ok(e, status + ' ' + JSON.stringify(body) + ' must fail');
      assert.strictEqual(e.code, kind); assert.strictEqual(e.retry, retry);
      assert.match(e.message, /^mail: the service answered \d+ \(mail_[a-z]+\)$/);
      assert.ok(!/person@|company\.example|1234|tok|Sender|inactive/.test(e.message + JSON.stringify(e)), 'nothing personal or secret');
    }
    const down = A.postmarkMail({ credential: 'tok', fetch: async () => { throw new Error('connect ECONNREFUSED person@company.example'); } });
    const e = await down.send(MSG).then(() => null, (x) => x);
    assert.strictEqual(e.code, 'mail_unavailable'); assert.ok(!/person@/.test(e.message));
  });

  test('mailFromEnv: postmark, the generic JSON mode stays the default, missing values → no transport', () => {
    assert.strictEqual(A.mailFromEnv({ WTS_MAIL_PROVIDER: 'postmark', WTS_MAIL_CREDENTIAL: 't' }).kind, 'postmark');
    assert.strictEqual(A.mailFromEnv({ WTS_MAIL_PROVIDER: 'Postmark ', WTS_MAIL_CREDENTIAL: 't' }).kind, 'postmark');
    assert.strictEqual(A.mailFromEnv({ WTS_MAIL_PROVIDER: 'postmark' }), null);
    assert.strictEqual(A.mailFromEnv({ WTS_MAIL_API_URL: 'https://mail.example/send', WTS_MAIL_CREDENTIAL: 't' }).kind, 'http');
    assert.strictEqual(A.mailFromEnv({ WTS_MAIL_PROVIDER: 'json', WTS_MAIL_API_URL: 'https://mail.example/send', WTS_MAIL_CREDENTIAL: 't' }).kind, 'http');
    assert.strictEqual(A.mailFromEnv({ WTS_MAIL_CREDENTIAL: 't' }), null);
    assert.strictEqual(A.mailFromEnv({ WTS_MAIL_PROVIDER: 'postmark', WTS_MAIL_KEY: 't' }).kind, 'postmark');   // alias
    assert.throws(() => A.mailFromEnv({ WTS_MAIL_PROVIDER: 'other', WTS_MAIL_CREDENTIAL: 't' }), /postmark or json/);
  });

  test('the handler binds the Postmark transport from the environment; a send failure is logged without the address', async () => {
    const log = quiet();
    const h = createHandler({ env: stagingEnv({ WTS_MAIL_PROVIDER: 'postmark', WTS_MAIL_CREDENTIAL: 'tok' }), log, fetch: answer(422, { ErrorCode: 406, Message: 'person@company.example inactive' }) });
    assert.strictEqual(h.state().mail, true);
    assert.ok(!JSON.stringify(log.lines).includes('tok'));
  });
});

// ── the signed self-test and the remote smoke against a local server ────────────────────────────────────────────────
function fakeDb() {
  const nonces = new Set();
  const tx = (strings, ...vals) => {
    const q = strings.join('?');
    if (/ops_nonce_claim/.test(q)) { const fresh = !nonces.has(vals[0]); nonces.add(vals[0]); return Promise.resolve([{ ok: fresh }]); }
    if (/current_user/.test(q)) return Promise.resolve([{ u: 'wts_api' }]);
    return Promise.resolve([]);
  };
  return { async ping() { return true; }, anon: (fn) => fn(tx), asUser: (id, fn) => fn(tx), close: async () => {} };
}
function fakeStore() {
  const m = new Map();
  return { async get(k) { return m.get(k) || null; }, async set(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); }, async list() { return { blobs: [] }; } };
}
function serve(handler) {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = chunks.length ? Buffer.concat(chunks) : null;
      const r = await handler.invoke({ method: req.method, url: req.url, headers: req.headers, body, remoteAddress: req.socket.remoteAddress });
      res.writeHead(r.status, r.headers); res.end(r.body == null ? '' : r.body);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port })));
}

test.describe('ops self-test and server/ops/remote-smoke.js (local server)', () => {
  let S = null; let log = null; let mail = null;
  test.before(async () => {
    log = quiet();
    mail = MAIL.memoryTransport();
    mail.kind = 'memory';
    S = await serve(createHandler({ env: stagingEnv(), log, db: fakeDb(), mail, store: fakeStore() }));
  });
  test.after(() => new Promise((r) => S.srv.close(r)));

  test('remote smoke: every check passes, one test e-mail, nothing secret or personal printed or logged', async () => {
    const r = await smoke.run({ base: S.base, sig: SIG + ',previous', hmac: HMAC, mailTo: 'ops-person@company.example' });
    assert.ok(r.ok, smoke.table(r.rows));
    assert.deepStrictEqual(r.rows.map((x) => x.id), [1, 2, 3, 4, 5, 6, 7]);
    assert.strictEqual(mail.sent.length, 1);
    assert.strictEqual(mail.sent[0].template, 'notice_ops_test'); assert.strictEqual(mail.sent[0].to, 'ops-person@company.example');
    assert.match(mail.sent[0].text, /delivery|delivered/);
    const out = smoke.table(r.rows) + JSON.stringify(log.lines);
    assert.ok(!out.includes('ops-person') && !out.includes(SIG) && !out.includes(HMAC), 'no address, no secret');
    assert.ok(log.lines.some((l) => /"route":"opsSelftest"/.test(l[1])), 'the access line names the route');
  });

  test('remote smoke without --mail-to sends nothing; a wrong key fails the self-test row', async () => {
    const before = mail.sent.length;
    const r = await smoke.run({ base: S.base, sig: SIG, hmac: HMAC });
    assert.ok(r.ok, smoke.table(r.rows)); assert.strictEqual(r.rows.length, 6); assert.strictEqual(mail.sent.length, before);
    const bad = await smoke.run({ base: S.base, sig: SIG, hmac: b64() });
    assert.ok(!bad.ok); assert.deepStrictEqual(bad.rows.filter((x) => !x.ok).map((x) => x.id), [6]);
    const nosig = await smoke.run({ base: S.base, sig: 'wrong', hmac: HMAC });
    assert.ok(!nosig.ok); assert.deepStrictEqual(nosig.rows.filter((x) => !x.ok).map((x) => x.id), [1, 4, 6]);
  });

  test('self-test: replayed nonce, GET, bad address, unsigned → refused; a failing transport reports its kind', async () => {
    const ts = String(Math.floor(Date.now() / 1000)); const nonce = crypto.randomBytes(18).toString('base64url');
    const headers = { 'X-WTS-Proxy-Sig': SIG, 'X-WTS-Host': 'welltest.h2oil.co.uk', 'Content-Type': 'application/json', 'X-WTS-Ts': ts, 'X-WTS-Nonce': nonce,
      'X-WTS-Sig': H.opsSignature(Buffer.from(HMAC, 'base64'), 'POST', SELFTEST_PATH, ts, nonce) };
    const first = await fetch(S.base + SELFTEST_PATH, { method: 'POST', headers, body: '{}' });
    assert.strictEqual(first.status, 200);
    assert.strictEqual((await fetch(S.base + SELFTEST_PATH, { method: 'POST', headers, body: '{}' })).status, 404, 'a nonce is used once');
    assert.strictEqual((await fetch(S.base + SELFTEST_PATH, { headers })).status, 404);
    const sign = () => { const n = crypto.randomBytes(18).toString('base64url'); return Object.assign({}, headers, { 'X-WTS-Nonce': n, 'X-WTS-Sig': H.opsSignature(Buffer.from(HMAC, 'base64'), 'POST', SELFTEST_PATH, ts, n) }); };
    assert.strictEqual((await fetch(S.base + SELFTEST_PATH, { method: 'POST', headers: sign(), body: JSON.stringify({ mailTo: 'not an address' }) })).status, 400);
    assert.strictEqual((await fetch(S.base + SELFTEST_PATH, { method: 'POST', headers: sign(), body: '[1]' })).status, 400);
    const failing = createHandler({ env: stagingEnv({ WTS_MAIL_PROVIDER: 'postmark', WTS_MAIL_CREDENTIAL: 'tok' }), log: quiet(), db: fakeDb(), store: fakeStore(),
      fetch: async () => ({ ok: false, status: 422, json: async () => ({ ErrorCode: 400, Message: 'Sender signature not found for ops-person@company.example' }) }) });
    const F = await serve(failing);
    try {
      const r = await smoke.run({ base: F.base, sig: SIG, hmac: HMAC, mailTo: 'ops-person@company.example' });
      assert.ok(!r.ok);
      const row = r.rows.find((x) => x.id === 7);
      assert.strictEqual(row.ok, false); assert.match(row.detail, /mail_sender/); assert.ok(!row.detail.includes('ops-person'));
      assert.ok(r.rows.find((x) => x.id === 6).detail.includes('mail transport postmark'));
    } finally { await new Promise((res) => F.srv.close(res)); }
  });

  test('the command line takes the base URL and secrets from the environment only', () => {
    const file = path.join(__dirname, '..', 'ops', 'remote-smoke.js');
    const a = cp.spawnSync(process.execPath, [file, 'https://fn.example'], { encoding: 'utf8', env: Object.assign({}, process.env, { WTS_SMOKE_BASE: '', WTS_PROXY_SIG: '', WTS_OPS_HMAC: '' }) });
    assert.strictEqual(a.status, 2); assert.match(a.stderr, /from WTS_SMOKE_BASE, WTS_PROXY_SIG and WTS_OPS_HMAC only/);
    const b = cp.spawnSync(process.execPath, [file], { encoding: 'utf8', env: Object.assign({}, process.env, { WTS_SMOKE_BASE: 'http://fn.example', WTS_PROXY_SIG: 'x', WTS_OPS_HMAC: HMAC }) });
    assert.strictEqual(b.status, 2); assert.match(b.stderr, /must be https/);
    assert.throws(() => smoke.checkBase('https://fn.example/path'), /must be https/);
  });
});
