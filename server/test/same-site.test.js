'use strict';
// server/test/same-site.test.js — same-site mode (WTS_SITE_MODE=same: the functions on the live site itself) and the live
// bundle (site/build-live.js, site/netlify-check.js checkLive): the configuration switch and its fail-closed rules, the host /
// proxy / client-address rules of core/http.js, the adapter end to end (site/handler.js, no database), the invite bootstrap
// list, the live function layout and the bundle allow-list; with the throwaway database a full sign-in in same-site mode
// (cookies exactly as before) and the bootstrap address on an invite-only site.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, inviteListed, allowSameSiteInTests } = require('../core/config');
allowSameSiteInTests();   // the adapter tests below run same mode with WTS_ENV=test (the test-only escape hatch)
const H = require('../core/http');
const NF = require('../site/netlify');
const NC = require('../site/netlify-check');
const { createHandler } = require('../site/handler');
const { harness, available } = require('./_api');

const b64 = () => crypto.randomBytes(32).toString('base64');
const PROD = 'welltest.h2oil.co.uk';
const req = (headers, extra) => Object.assign({ method: 'GET', url: '/api/v1/health', headers, body: null, remoteAddress: '10.0.0.1' }, extra || {});
function prodEnv(extra) {
  return Object.assign({ WTS_ENV: 'production', WTS_SITE_MODE: 'same', WTS_MASTER_KEYS: '1:' + b64(), WTS_MASTER_KID: '1', WTS_INDEX_PEPPER: b64(),
    WTS_CODE_PEPPERS: '1:' + b64(), WTS_SESSION_PEPPER: b64(), WTS_OPS_HMAC: b64() }, extra || {});
}

test.describe('same-site mode: configuration', () => {
  test('WTS_SITE_MODE=same: no proxy alert, Host header only, client address only from the platform header', () => {
    const c = loadConfig(prodEnv({ WTS_HOST_HEADER: 'x-wts-host', WTS_CLIENT_IP_HEADER: 'x-real-ip', WTS_PROXY_SIG: 'a'.repeat(43) }));
    assert.strictEqual(c.siteMode, 'same'); assert.strictEqual(c.sameSite, true); assert.strictEqual(c.production, true);
    assert.strictEqual(c.hostHeader, '', 'no forwarding header is trusted');
    assert.strictEqual(c.ipHeader, 'x-nf-client-connection-ip');
    assert.ok(!c.alerts.some((a) => /WTS_PROXY_SIG|WTS_CLIENT_IP_HEADER/.test(a)), JSON.stringify(c.alerts));
    ['WTS_HOST_HEADER', 'WTS_CLIENT_IP_HEADER', 'WTS_PROXY_SIG'].forEach((n) => assert.ok(c.warnings.some((w) => w.indexOf(n) === 0), n + ' warned'));
    // every other control exactly as before
    assert.deepStrictEqual(c.allowedOrigins, ['https://' + PROD]); assert.strictEqual(c.codeFloorMs, 400); assert.strictEqual(c.devOrigin, null);
  });
  test('missing or unknown mode = separate (signature required); the separate rules are unchanged', () => {
    const a = loadConfig(prodEnv({ WTS_SITE_MODE: '' }));
    assert.strictEqual(a.siteMode, 'separate'); assert.strictEqual(a.sameSite, false);
    assert.ok(a.alerts.some((x) => /WTS_PROXY_SIG missing/.test(x)));
    const b = loadConfig(prodEnv({ WTS_SITE_MODE: 'SAME-ish' }));
    assert.strictEqual(b.siteMode, 'separate'); assert.ok(b.warnings.some((w) => /^WTS_SITE_MODE: unknown value/.test(w)));
    const c = loadConfig(prodEnv({ WTS_SITE_MODE: 'separate', WTS_HOST_HEADER: 'x-wts-host', WTS_PROXY_SIG: 's'.repeat(40) }));
    assert.strictEqual(c.hostHeader, 'x-wts-host');
    assert.strictEqual(H.proxyOk(req({ 'x-wts-host': PROD }), c), false);
    assert.strictEqual(H.proxyOk(req({ 'x-wts-proxy-sig': 's'.repeat(40), 'x-wts-host': PROD }), c), true);
    assert.strictEqual(H.hostAllowed(req({ host: 'api.netlify.app', 'x-wts-host': PROD }), c), true, 'separate: the forwarding header carries the host');
  });
  test('platformEnv: no forwarding-header default in same mode; separate keeps x-wts-host', () => {
    assert.strictEqual(NF.platformEnv({ WTS_SITE_MODE: 'same' }).WTS_HOST_HEADER, undefined);
    assert.strictEqual(NF.platformEnv({}).WTS_HOST_HEADER, 'x-wts-host');
    assert.strictEqual(NF.platformEnv({ WTS_SITE_MODE: 'same' }).WTS_CLIENT_IP_HEADER, 'x-nf-client-connection-ip');
    assert.strictEqual(NF.platformEnv({ WTS_SITE_MODE: 'same' }).WTS_MIN_CLIENT, '4.0');
  });
  test('WTS_INVITE_BOOTSTRAP: normalised addresses, invalid entries warned, only with invite', async () => {
    const c = loadConfig(prodEnv({ ACCOUNTS_SIGNUP: 'invite', WTS_INVITE_BOOTSTRAP: ' Owner@Company.Example , not-an-address;second@company.example' }));
    assert.deepStrictEqual(Array.from(c.inviteBootstrap).sort(), ['owner@company.example', 'second@company.example']);
    assert.ok(c.warnings.some((w) => /WTS_INVITE_BOOTSTRAP: an entry is not an address/.test(w)));
    assert.strictEqual(c.redacted().inviteBootstrap, 2, 'redacted: only the count');
    assert.ok(!JSON.stringify(c.redacted()).includes('owner@'), 'no address in the redacted config');
    let called = 0;
    assert.strictEqual(await inviteListed(c, 'owner@company.example', async () => { called++; return false; }), true);
    assert.strictEqual(called, 0, 'a bootstrap address needs no database lookup');
    assert.strictEqual(await inviteListed(c, 'x@company.example', async () => { called++; return false; }), false);
    assert.strictEqual(await inviteListed(c, 'y@company.example', async () => true), true, 'the database list still counts');
    const d = loadConfig(prodEnv({ ACCOUNTS_SIGNUP: 'open', WTS_INVITE_BOOTSTRAP: 'owner@company.example' }));
    assert.ok(d.warnings.some((w) => /used only with ACCOUNTS_SIGNUP=invite/.test(w)));
  });
});

test.describe('same-site mode: host, proxy and client-address rules (core/http.js)', () => {
  test('same mode refuses WTS_ENV local / test / preview (test only through the test-only hatch)', () => {
    const base = Object.assign(prodEnv(), { WTS_MASTER_KEYS: '', WTS_CODE_PEPPERS: '' });
    ['local', 'preview'].forEach((e) => assert.throws(() => loadConfig(Object.assign({}, base, { WTS_ENV: e })), /runs only with WTS_ENV=production or staging/, e));
    allowSameSiteInTests(false);
    try {
      assert.throws(() => loadConfig(Object.assign({}, base, { WTS_ENV: 'test' })), /production or staging/, 'test without the hatch');
      assert.throws(() => loadConfig(Object.assign({}, base, { WTS_ENV: 'test', WTS_OIDC_MODE: 'dev', WTS_DEV_ORIGIN: 'http://localhost:8080' })), /production or staging/);
      assert.strictEqual(loadConfig(Object.assign({}, base, { WTS_ENV: 'staging' })).sameSite, true);
      assert.strictEqual(loadConfig(Object.assign({}, base, { WTS_ENV: 'local', WTS_SITE_MODE: 'separate' })).sameSite, false, 'separate mode is unchanged');
    } finally { allowSameSiteInTests(); }
  });
  test('the api function answers 404 with an alert on a refused configuration (never 500)', async () => {
    const lines = [];
    const fn = NF.apiFunction({ env: Object.assign(prodEnv(), { WTS_ENV: 'local' }), log: { info() {}, warn: (m) => lines.push(m) } });
    const r = await fn(new Request('https://' + PROD + '/api/v1/health', { headers: { host: PROD } }), { deploy: { context: 'production', published: true } });
    assert.strictEqual(r.status, 404);
    assert.ok(lines.some((l) => /^alert: config — api refused: config: WTS_SITE_MODE=same runs only/.test(l)), lines.join('\n'));
  });
  test('no signature needed; the Host header must be EXACTLY the production host in every allowed WTS_ENV', () => {
    ['production', 'staging', 'test'].forEach((e) => {
      const c = loadConfig(Object.assign(prodEnv(), { WTS_ENV: e, WTS_MASTER_KEYS: '', WTS_CODE_PEPPERS: '' }));
      assert.strictEqual(H.proxyOk(req({ host: PROD }), c), true, e + ': no proxy');
      assert.strictEqual(H.hostAllowed(req({ host: PROD }), c), true, e);
      assert.strictEqual(H.hostAllowed(req({ host: 'localhost:8787' }), c), false, e + ': no loopback host');
      assert.strictEqual(H.hostAllowed(req({ host: 'h2oil.netlify.app' }), c), false, e + ': not the platform address');
      assert.strictEqual(H.hostAllowed(req({ host: 'h2oil.netlify.app', 'x-wts-host': PROD, 'x-forwarded-host': PROD }), c), false, e + ': forged forwarding headers ignored');
      assert.strictEqual(H.hostAllowed(req({}), c), false, e + ': no host');
      assert.strictEqual(H.hostAllowed(req({ host: PROD + '.evil.example' }), c), false);
    });
  });
  test('a configuration without a production host never passes the host check in same mode', () => {
    const c = Object.assign({}, loadConfig(prodEnv()), { prodHost: '' });
    assert.strictEqual(H.hostAllowed(req({ host: '' }), c), false);
    assert.strictEqual(H.hostAllowed(req({ host: PROD }), c), false);
  });
  test('client address: the platform header (last value), never X-Forwarded-For, never the socket', () => {
    const c = loadConfig(prodEnv());
    assert.strictEqual(H.clientIp(req({ 'x-nf-client-connection-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' }), c), '198.51.100.7');
    assert.strictEqual(H.clientIp(req({ 'x-forwarded-for': '1.2.3.4' }), c), null);
    const d = loadConfig(prodEnv({ WTS_CLIENT_IP_HEADER: 'x-forwarded-for' }));
    assert.strictEqual(d.ipHeader, 'x-nf-client-connection-ip');
  });
});

test.describe('same-site mode: the adapter end to end (site/handler.js, no database)', () => {
  const env = () => ({ WTS_ENV: 'test', WTS_SITE_MODE: 'same', WTS_VERSION: 'same', WTS_MASTER_KEYS: '9001:' + b64(), WTS_INDEX_PEPPER: b64(),
    WTS_CODE_PEPPERS: '9001:' + b64(), WTS_OPS_HMAC: b64(), WTS_PROXY_SIG: 'x'.repeat(40) });
  const quiet = { info() {}, warn() {} };
  test('health on the production host answers; the platform address, a forged header and a signature-only call get 404', async () => {
    const h = createHandler({ env: env(), log: quiet, store: null });
    const ok = await h.handle(new Request('https://' + PROD + '/api/v1/health', { headers: { host: PROD } }));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('strict-transport-security'), 'max-age=31536000');
    const plat = await h.handle(new Request('https://h2oil.netlify.app/api/v1/health', { headers: { host: 'h2oil.netlify.app', 'x-wts-host': PROD, 'x-wts-proxy-sig': 'x'.repeat(40) } }));
    assert.strictEqual(plat.status, 404);
    // no Host header passed on by the runtime: the routed URL's host stands in (and must still be the production host)
    const noHost = await h.handle(new Request('https://' + PROD + '/api/v1/health'));
    assert.strictEqual(noHost.status, 200);
    const noHost2 = await h.handle(new Request('https://deploy-preview-1--h2oil.netlify.app/api/v1/health'));
    assert.strictEqual(noHost2.status, 404);
    assert.strictEqual(h.config.sameSite, true);
  });
  test('writes keep the Origin / X-WTS-Req / Content-Type rules', async () => {
    const h = createHandler({ env: env(), log: quiet, store: null });
    const post = (headers) => h.handle(new Request('https://' + PROD + '/api/v1/auth/code/start', { method: 'POST', headers: Object.assign({ host: PROD }, headers), body: '{"email":"a@company.example","purpose":"signin"}' }));
    const r1 = await post({ 'content-type': 'application/json', 'x-wts-req': '1' });
    assert.strictEqual(r1.status, 403); assert.strictEqual((await r1.json()).error, 'origin');
    const r2 = await post({ 'content-type': 'application/json', origin: 'https://h2oil.netlify.app', 'x-wts-req': '1' });
    assert.strictEqual(r2.status, 403);
    const r3 = await post({ 'content-type': 'text/plain', origin: 'https://' + PROD, 'x-wts-req': '1' });
    assert.strictEqual(r3.status, 403);
  });
  test('the access log uses the platform client address, never X-Forwarded-For', async () => {
    const lines = [];
    const h = createHandler({ env: env(), log: { info: (m) => lines.push(m), warn() {} }, store: null });
    await h.handle(new Request('https://' + PROD + '/api/v1/health', { headers: { host: PROD, 'x-nf-client-connection-ip': '198.51.100.77', 'x-forwarded-for': '203.0.113.5' } }));
    const acc = lines.filter((l) => /health/.test(l)).join('\n');
    assert.ok(/198\.51\.100/.test(acc) && !/203\.0\.113/.test(acc), acc);
  });
});

test('live-inline scheduled functions run their job in place: no kick request, no background call', async () => {
  const calls = []; const lines = [];
  const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
  const ctx = { deploy: { context: 'production', published: true }, site: { url: 'https://' + PROD } };
  for (const name of ['ops-daily', 'weekly-export']) {
    const fn = NF.scheduledFunction(name, { inline: true, env: { WTS_ENV: 'production', WTS_SITE_MODE: 'same', WTS_OPS_HMAC: b64() }, log, fetch: async (u) => { calls.push(u); return { status: 202 }; } });
    const res = await fn(new Request('https://' + PROD + '/.netlify/functions/' + name), ctx);
    const body = await res.json();
    assert.strictEqual(calls.length, 0, name + ': no kick');
    assert.ok(body.ok === false && (body.skipped === 'no database' || res.status === 500), name + ' ran in place: ' + JSON.stringify(body));
  }
  assert.ok(lines.some((l) => /ops-daily \(inline\)/.test(l)), lines.join('\n'));
  // the 25 s budget: a job that outlives it ends the function with an alert (the platform would stop it at 30 s silently)
  assert.strictEqual(NF.INLINE_BUDGET_MS, 25000);
  lines.length = 0;
  const seen = [];
  const never = () => new Promise(() => {});
  for (const name of ['ops-daily', 'weekly-export']) {
    const slow = NF.scheduledFunction(name, { inline: true, budgetMs: 30, env: { WTS_ENV: 'production', WTS_SITE_MODE: 'same' }, log,
      jobBodies: { runJobs: (o) => { seen.push(o.deadline); return never(); }, runExport: never } });
    const sb = await (await slow(new Request('https://' + PROD + '/.netlify/functions/' + name), ctx)).json();
    assert.deepStrictEqual(sb, { ok: false, skipped: 'time' }, name);
    assert.ok(lines.some((l) => new RegExp('^alert: jobs — ' + name + ' \\(inline\\) did not finish within').test(l)), lines.join('\n'));
  }
  assert.ok(seen.length === 1 && typeof seen[0] === 'number', 'the daily job gets a deadline');
  // the daily job stops cleanly at its deadline: steps not started are skipped, one alert line
  const dl = [];
  const did = await require('../core/jobs').runDaily({ db: { sql: null }, deadline: Date.now() - 1, log: { info() {}, warn: (m) => dl.push(m) } });
  assert.deepStrictEqual(did.purge, { skipped: 'time' });
  assert.ok(Object.keys(did).every((k) => did[k].skipped === 'time'), JSON.stringify(did));
  assert.strictEqual(dl.filter((l) => /^alert: jobs — daily job stopped at its time budget before step purge/.test(l)).length, 1, dl.join('\n'));
  // the separate layout still kicks its background function
  const kick = NF.scheduledFunction('ops-daily', { env: { WTS_ENV: 'production', WTS_OPS_HMAC: b64() }, log, fetch: async (u) => { calls.push(u); return { status: 202 }; } });
  await kick(new Request('https://x.example/'), ctx);
  assert.deepStrictEqual(calls, ['https://' + PROD + '/.netlify/functions/ops-daily-background']);
});

test.describe('server/ops/remote-smoke.js in same-site mode (fake platform routing)', () => {
  const smoke = require('../ops/remote-smoke');
  const HMAC = b64();
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
  const store = () => { const m = new Map(); return { async get(k) { return m.get(k) || null; }, async set(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); }, async list() { return { blobs: [] }; } }; };
  // the platform: static files for every path but /api/v1/*, which goes to the function with the Host the client used
  function platform(h) {
    return async (url, init) => {
      const u = new URL(url);
      if (u.pathname.indexOf('/api/v1/') !== 0) return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      const headers = new Headers((init && init.headers) || {}); headers.set('host', u.host);
      return h.handle(new Request(url, Object.assign({}, init, { headers })), {});
    };
  }
  test('every row passes on the production address; the platform address row needs WTS_SMOKE_ALT_BASE; no signature allowed', async () => {
    const h = createHandler({ env: prodEnv({ WTS_ENV: 'staging', WTS_MASTER_KEYS: '9001:' + b64(), WTS_MASTER_KID: '9001', WTS_CODE_PEPPERS: '9001:' + b64(), WTS_OPS_HMAC: HMAC, WTS_VERSION: '4.0.0' }),
      log: { info() {}, warn() {} }, db: fakeDb(), store: store(), probeRoleModes: async () => ({ session: true }) });
    const f = platform(h);
    const r = await smoke.run({ base: 'https://' + PROD, mode: 'same', altBase: 'https://h2oil.netlify.app', hmac: HMAC, fetch: f });
    assert.ok(r.ok, smoke.table(r.rows));
    assert.deepStrictEqual(r.rows.map((x) => x.id), [1, 2, 3, 4, 5, 6]);
    const r2 = await smoke.run({ base: 'https://' + PROD, mode: 'same', hmac: HMAC, fetch: f });
    assert.ok(!r2.ok); assert.deepStrictEqual(r2.rows.filter((x) => !x.ok).map((x) => x.id), [2]);
    await assert.rejects(() => smoke.run({ base: 'https://' + PROD, mode: 'same', sig: 'x', hmac: HMAC, fetch: f }), /unset WTS_PROXY_SIG/);
    await assert.rejects(() => smoke.run({ base: 'https://' + PROD, hmac: HMAC, fetch: f }), /WTS_SMOKE_MODE=same/);
  });
});

test.describe('live bundle layout (site/netlify.js functionsFor, site/build-live.js, site/netlify-check.js checkLive)', () => {
  test('live functions: the same six, api on /api/v1/* only, no region pin; separate layout unchanged', () => {
    const L = NF.functionsFor('live');
    assert.deepStrictEqual(Object.keys(L), Object.keys(NF.FUNCTIONS));
    assert.deepStrictEqual(L.api.config, { path: '/api/v1/*' });
    Object.keys(L).forEach((k) => { assert.ok(!('region' in L[k].config), k); assert.ok(!L[k].config.path || k === 'api', k + ' has no path'); });
    assert.strictEqual(NF.functionsFor('separate'), NF.FUNCTIONS);
    assert.throws(() => NF.functionsFor('other'));
    for (const k of Object.keys(L)) assert.deepStrictEqual(NC.literalConfig(NF.functionSource(k, 'live')), L[k].config, k);
    assert.ok(!/redirects|\/\*"?\s*=|force/.test(NC.LIVE_TOML.replace(/^#.*$/mg, '')), 'no redirect or catch-all rule: static files win for every other path');
    // live-inline (opt-in, --inline-jobs): no background functions; the daily job and the export run inside their schedule
    const I = NF.functionsFor('live-inline');
    assert.deepStrictEqual(Object.keys(I), ['api', 'ops-purge', 'ops-daily', 'weekly-export']);
    assert.deepStrictEqual(I.api.config, { path: '/api/v1/*' });
    assert.ok(I['ops-daily'].inline && !I['ops-daily'].kicks && I['weekly-export'].inline);
    assert.match(NF.functionSource('ops-daily', 'live-inline'), /nf\.scheduledFunction\('ops-daily', \{ inline: true \}\)/);
    for (const k of Object.keys(I)) assert.deepStrictEqual(NC.literalConfig(NF.functionSource(k, 'live-inline')), I[k].config, k);
    assert.ok(/command = "node site\/netlify-check\.js --live"/.test(NC.LIVE_TOML) && /publish = "public"/.test(NC.LIVE_TOML) && /NODE_VERSION = "22"/.test(NC.LIVE_TOML));
  });
  test('build → check passes; a stray, secret or tampered file fails the check', { skip: !fs.existsSync(path.join(__dirname, '..', '..', 'prism-build', 'publish-site.js')) && 'no repository tree' }, async () => {
    const BL = require('../site/build-live');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-live-'));
    const out = path.join(dir, 'bundle');
    try {
      const r = BL.build({ out, commit: 'test', inlineJobs: true });
      assert.ok(r.files > 50);
      assert.strictEqual(r.info.layout, 'live-inline');
      assert.ok(!fs.existsSync(path.join(out, 'netlify', 'functions', 'ops-daily-background.mjs')));
      const files = BL.checkDir(out).files;
      assert.ok(files.includes('public/index.html') && files.includes('public/well-testing-app.html') && files.includes('public/sw.js') && files.includes('public/privacy.html'));
      assert.ok(files.includes('netlify/database/migrations/0000_platform_roles.sql') && files.includes('netlify/functions/api.mjs') && files.includes('package-lock.json'));
      assert.ok(!files.some((f) => /^(docs|prism-build|test|ops|server)\//.test(f) || /\.env|\.pem$|RUNBOOK|README/.test(f)), files.filter((f) => /^(docs|test|ops)\//.test(f)).join());
      const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
      assert.ok(pkg.dependencies['@netlify/database'] && pkg.dependencies['@netlify/blobs'] && pkg.dependencies.postgres && !pkg.scripts);
      assert.deepStrictEqual(BL.checkDir(out).problems, []);
      assert.deepStrictEqual(NC.checkLive(out).problems, [], 'the platform build command passes');
      // the platform installs node_modules before the build command: skipped there, refused in an upload
      fs.mkdirSync(path.join(out, 'node_modules', 'x'), { recursive: true }); fs.writeFileSync(path.join(out, 'node_modules', 'x', 'i.js'), '');
      assert.deepStrictEqual(NC.checkLive(out).problems, []);
      assert.ok(NC.checkLive(out, { uploaded: true }).problems.some((p) => /^node_modules/.test(p)));
      fs.rmSync(path.join(out, 'node_modules'), { recursive: true });
      const bad = (rel, text, re) => {
        const f = path.join(out, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text);
        const p = BL.checkDir(out).problems; fs.rmSync(f);
        assert.ok(p.some((x) => re.test(x)), rel + ': ' + p.join(' | '));
      };
      bad('docs/notes.md', 'x', /docs\/notes\.md: not in the bundle allow-list/);
      bad('.env', 'A=1', /\.env: (dot file|key file)/);
      bad('site/key.pem', 'x', /key file/);
      bad('core/leak.js', 'const WTS_' + "OPS_HMAC = '" + 'Zk3uQ9pX2vL7rT1y' + "W8bN4cM6dF0gH5jK';\n", /secret-literal/);
      bad('public/extra.html', '<p>x</p>', /not in publish-manifest\.json/);
      bad('test/x.test.js', '', /not in the bundle allow-list/);
      const idx = path.join(out, 'public', 'index.html'); const keep = fs.readFileSync(idx);
      fs.appendFileSync(idx, '<!-- changed -->');
      assert.ok(BL.checkDir(out).problems.some((p) => /index\.html: differs from publish-manifest/.test(p)));
      fs.writeFileSync(idx, keep);
      const toml = path.join(out, 'netlify.toml'); fs.appendFileSync(toml, '[[redirects]]\n  from = "/*"\n  to = "/index.html"\n');
      assert.ok(BL.checkDir(out).problems.some((p) => /netlify\.toml differs/.test(p)));
      fs.writeFileSync(toml, NC.LIVE_TOML);
      const api = path.join(out, 'netlify', 'functions', 'api.mjs'); fs.writeFileSync(api, fs.readFileSync(api, 'utf8').replace("'/api/v1/*'", "'/*'"));
      assert.ok(BL.checkDir(out).problems.some((p) => /api: /.test(p)));
      // a background function added to the inline layout = the six-function set incomplete → refused
      fs.writeFileSync(api, NF.functionSource('api', 'live-inline'));
      fs.writeFileSync(path.join(out, 'netlify', 'functions', 'ops-daily-background.mjs'), NF.functionSource('ops-daily-background', 'live'));
      assert.ok(BL.checkDir(out).problems.some((p) => /must hold exactly .*layout live/.test(p)));
      const six = BL.build({ out: path.join(dir, 'six'), commit: 'test' });
      assert.strictEqual(six.info.layout, 'live', 'the default layout has the background functions');
      assert.ok(fs.existsSync(path.join(dir, 'six', 'netlify', 'functions', 'ops-daily-background.mjs')) && fs.existsSync(path.join(dir, 'six', 'netlify', 'functions', 'weekly-export-background.mjs')));
      assert.deepStrictEqual(BL.checkDir(path.join(dir, 'six')).problems, []);
      assert.throws(() => BL.build({ out: path.join(__dirname, '..', '..') }), /must not be the repository/);
      assert.throws(() => BL.build({ out: path.join(__dirname, '..', 'core', 'x') }), /server\/dist-live/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test.describe('same-site mode with the database: sign-in, cookies, invite bootstrap', { skip: !available() && 'no throwaway database (run through server/test/run.js)' }, () => {
  let T = null;
  test.before(async () => { T = await harness('samesite', { env: { WTS_SITE_MODE: 'same', ACCOUNTS_SIGNUP: 'invite', WTS_INVITE_BOOTSTRAP: 'Owner@Company.Example' } }); });
  test.after(async () => { if (T) await T.close(); });
  test('the bootstrap address signs up on an invite-only site; cookies are exactly __Host-, Secure, HttpOnly, SameSite', async () => {
    assert.strictEqual(T.config.sameSite, true);
    const br = T.browser();
    const s = await br.call('POST', '/auth/code/start', { email: 'owner@company.example', purpose: 'signin' });
    assert.strictEqual(s.status, 202);
    const code = T.codeFor('owner@company.example', 'code_signin');
    assert.ok(code, 'a code for the bootstrap address');
    const r = await br.call('POST', '/auth/code/verify', { email: 'owner@company.example', code, publicDevice: false, consent: { terms: '1', privacy: '1' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const sid = r.cookies.find((c) => /^__Host-wts_sid=/.test(c));
    assert.ok(sid && /; Path=\//.test(sid) && /; Secure/.test(sid) && /; HttpOnly/.test(sid) && /; SameSite=Strict/.test(sid) && /Max-Age=\d+/.test(sid) && !/Domain=/i.test(sid), sid);
    const me = await br.call('GET', '/me');
    assert.strictEqual(me.status, 200);
  });
  test('an address on neither list gets the uniform 202 and no mail; the platform address answers 404', async () => {
    const before = T.mail.sent.length;
    const br = T.browser();
    const s = await br.call('POST', '/auth/code/start', { email: 'stranger@company.example', purpose: 'signin' });
    assert.strictEqual(s.status, 202); assert.strictEqual(T.mail.sent.length, before);
    const p = await br.call('GET', '/health', undefined, { headers: { host: 'h2oil.netlify.app' } });
    assert.strictEqual(p.status, 404);
    const w = await br.call('POST', '/auth/code/start', { email: 'owner@company.example', purpose: 'signin' }, { headers: { origin: 'https://h2oil.netlify.app' } });
    assert.strictEqual(w.status, 403);
  });
});
