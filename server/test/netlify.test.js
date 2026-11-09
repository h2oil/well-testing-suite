'use strict';
// server/test/netlify.test.js — the Netlify bindings without the platform (v4.0; server/README.md "Hosting"): the function
// entries and their literal configs, the platform environment defaults, the blob store binding (region and consistency on
// every call), the signed kick of the background functions, the main site's proxy rule, the secret generator, the database
// URL rules and the build check. No network, no database (netlify-db.test.js has the database half).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..');
const NF = require('../site/netlify');
const NB = require('../site/netlify-blobs');
const { hostObjects } = require('../site/adapters');
const H = require('../core/http');

// a fake of the platform's getStore: one Map per store name; every options object recorded
function fakeBlobs() {
  const stores = new Map(); const calls = [];
  function getStore(o) {
    calls.push(Object.assign({}, o));
    if (!stores.has(o.name)) stores.set(o.name, new Map());
    const m = stores.get(o.name);
    return {
      async get(k, opt) { assert.strictEqual(opt.type, 'arrayBuffer'); return m.has(k) ? m.get(k).slice(0) : null; },
      async set(k, v) { assert.ok(v instanceof ArrayBuffer, 'the platform gets an ArrayBuffer'); m.set(k, v.slice(0)); return { modified: true }; },
      async delete(k) { m.delete(k); },
      async list(q) { return { blobs: Array.from(m.keys()).filter((k) => k.startsWith(q.prefix || '')).map((key) => ({ key, etag: 'x' })), directories: [] }; },
    };
  }
  return { getStore, stores, calls };
}
const memLog = () => { const lines = []; return { lines, info: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)) }; };

test('function files: exactly the six of FUNCTIONS, each importing site/netlify.js with the same literal config', async () => {
  const dir = path.join(SERVER, 'netlify', 'functions');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), Object.keys(NF.FUNCTIONS).map((k) => NF.FUNCTIONS[k].file).sort());
  for (const name of Object.keys(NF.FUNCTIONS)) {
    const m = await import(path.join(dir, NF.FUNCTIONS[name].file));
    assert.strictEqual(typeof m.default, 'function', name + ' exports a handler');
    assert.deepStrictEqual(m.config === undefined ? null : m.config, NF.FUNCTIONS[name].config, name + ' config');
    if (/-background$/.test(name)) assert.strictEqual(NF.FUNCTIONS[name].config, null);
  }
  // the scheduled ones never serve a path; the API serves /api/v1/* only
  assert.deepStrictEqual(NF.FUNCTIONS.api.config, { path: '/api/v1/*' });
  ['ops-purge', 'ops-daily', 'weekly-export'].forEach((n) => assert.ok(/^\S+ \S+ \S+ \S+ \S+$/.test(NF.FUNCTIONS[n].config.schedule) && !NF.FUNCTIONS[n].config.path));
  // site.json describes the same set
  const site = JSON.parse(fs.readFileSync(path.join(SERVER, 'site', 'site.json'), 'utf8'));
  assert.deepStrictEqual(site.netlify.functions.map((f) => f.name), Object.keys(NF.FUNCTIONS));
  assert.strictEqual(site.netlify.blobs.region, 'eu-central-1');
});

test('netlify.toml: base layout, functions directory, Node 22, no secret, previews documented off', () => {
  const t = fs.readFileSync(path.join(SERVER, 'netlify.toml'), 'utf8');
  assert.match(t, /^\s*directory = "netlify\/functions"$/m);
  assert.match(t, /^\s*publish = "public"$/m);
  assert.match(t, /^\s*NODE_VERSION = "22"$/m);
  assert.match(t, /^\s*command = "node site\/netlify-check\.js"$/m);
  assert.match(t, /Deploy previews and branch deploys MUST stay OFF/);
  assert.ok(!/WTS_(MASTER|PROXY|OPS|INDEX|CODE|SESSION)[A-Z_]*\s*=/.test(t), 'no secret variable is set in the file');
  assert.deepStrictEqual(fs.readdirSync(path.join(SERVER, 'public')), ['robots.txt']);
  assert.deepStrictEqual(require('../site/netlify-check').check(), []);
});

test('netlify-check refuses a bundle with extra published files or a changed function config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-nfc-'));
  try {
    fs.cpSync(path.join(SERVER, 'netlify'), path.join(tmp, 'netlify'), { recursive: true });
    fs.cpSync(path.join(SERVER, 'public'), path.join(tmp, 'public'), { recursive: true });
    fs.copyFileSync(path.join(SERVER, 'netlify.toml'), path.join(tmp, 'netlify.toml'));
    const C = require('../site/netlify-check');
    assert.deepStrictEqual(C.check(tmp), []);
    fs.writeFileSync(path.join(tmp, 'public', 'index.html'), '<p>x</p>');
    const f = path.join(tmp, 'netlify', 'functions', 'ops-daily.mjs');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("'17 3 * * *'", "'* * * * *'"));
    const p = C.check(tmp);
    assert.ok(p.some((x) => /public\/ must hold robots\.txt only/.test(x)));
    assert.ok(p.some((x) => /ops-daily: config differs/.test(x)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('platformEnv: the platform database with wts_api always, 4.0 minimum, release version, header defaults; overrides kept', () => {
  const e = NF.platformEnv({ NETLIFY_DB_URL: 'postgresql://owner:pw@db.example.invalid/main?sslmode=require', WTS_DB_ROLE: 'wts_jobs' });
  assert.strictEqual(e.WTS_DB_URL, 'postgresql://owner:pw@db.example.invalid/main?sslmode=require');
  assert.strictEqual(e.WTS_DB_ROLE, 'wts_api', 'the request role cannot be changed');
  assert.strictEqual(e.WTS_MIN_CLIENT, '4.0');
  assert.strictEqual(e.WTS_VERSION, require('../package.json').version);
  assert.strictEqual(require('../package.json').version, '4.0.0');
  assert.strictEqual(e.WTS_HOST_HEADER, 'x-wts-host');
  assert.strictEqual(e.WTS_CLIENT_IP_HEADER, 'x-nf-client-connection-ip');
  const o = NF.platformEnv({ WTS_DB_URL: 'postgresql://a@b.example.invalid/c', NETLIFY_DB_URL: 'postgresql://x@y.example.invalid/z', WTS_MIN_CLIENT: '4.1', WTS_VERSION: 'server-v4.0.1' });
  assert.strictEqual(o.WTS_DB_URL, 'postgresql://a@b.example.invalid/c');
  assert.strictEqual(o.WTS_MIN_CLIENT, '4.1'); assert.strictEqual(o.WTS_VERSION, 'server-v4.0.1');
  const { loadConfig } = require('../core/config');
  const c = loadConfig(Object.assign({ WTS_ENV: 'test' }, e));
  assert.strictEqual(c.dbRole, 'wts_api'); assert.strictEqual(c.minClient, '4.0'); assert.strictEqual(c.hostHeader, 'x-wts-host');
  const bad = loadConfig({ WTS_ENV: 'test', WTS_DB_ROLE: 'postgres' });
  assert.strictEqual(bad.dbRole, 'invalid'); assert.ok(bad.warnings.some((w) => /WTS_DB_ROLE/.test(w)));
});

test('blob binding: eu-central-1 and strong consistency on EVERY store call; ArrayBuffer in, Buffer out; keys validated first', async () => {
  const F = fakeBlobs();
  const store = NB.createStore({}, { getStore: F.getStore });
  const objects = hostObjects(store);
  const uid = crypto.randomUUID(); const k = 'u/' + uid + '/lib/' + 'a'.repeat(64);
  await objects.put(k, Buffer.from('hello'));
  assert.deepStrictEqual(await objects.get(k), Buffer.from('hello'));
  assert.deepStrictEqual(await objects.list('u/' + uid + '/'), [k]);
  await objects.del(k);
  assert.strictEqual(await objects.get(k), null);
  await assert.rejects(objects.put('../etc/passwd', Buffer.from('x')), /bad key/);
  assert.ok(F.calls.length >= 5);
  F.calls.forEach((c) => {
    assert.strictEqual(c.region, 'eu-central-1'); assert.strictEqual(c.consistency, 'strong'); assert.strictEqual(c.name, 'wts-objects');
    assert.ok(!('siteID' in c) && !('token' in c), 'inside the site the platform injects its own credentials');
  });
  // a Uint8Array view on a larger buffer is copied exactly
  const big = Buffer.from('xxABCyy'); await store.set('chain/2026-11-09', big.subarray(2, 5));
  assert.deepStrictEqual(await store.get('chain/2026-11-09'), Buffer.from('ABC'));
  // outside the site: both the site id and the credential, or neither
  const ex = NB.createStore({ WTS_BLOBS_SITE_ID: 'site-id', WTS_OBJECTS_CREDENTIAL: 'tok' }, { name: 'wts-exports', getStore: F.getStore });
  await ex.list({ prefix: 'export/' });
  const last = F.calls[F.calls.length - 1];
  assert.deepStrictEqual([last.name, last.region, last.siteID, last.token], ['wts-exports', 'eu-central-1', 'site-id', 'tok']);
  NB.createStore({ WTS_BLOBS_SITE_ID: 'site-id' }, { getStore: F.getStore }).list({ prefix: 'ledger/' });
  assert.ok(!('siteID' in F.calls[F.calls.length - 1]));
  assert.throws(() => NB.createStore({}, { name: 'Bad/Name', getStore: F.getStore }), /bad store name/);
});

test('api function: one handler per instance; 404 without the proxy signature, health through the rule; version from the release', async () => {
  const F = fakeBlobs(); const log = memLog();
  const sig = crypto.randomBytes(32).toString('base64url');
  const api = NF.apiFunction({ env: { WTS_ENV: 'production', WTS_PROXY_SIG: sig }, getStore: F.getStore, log });
  const direct = await api(new Request('https://wts-api.netlify.app/api/v1/health'), { ip: '203.0.113.9' });
  assert.strictEqual(direct.status, 404, 'a request sent straight to the functions site learns nothing');
  const via = await api(new Request('https://wts-api.netlify.app/api/v1/health', { headers: { 'X-WTS-Proxy-Sig': sig, 'X-WTS-Host': 'welltest.h2oil.co.uk', 'x-nf-client-connection-ip': '203.0.113.9' } }), { ip: '203.0.113.9' });
  assert.strictEqual(via.status, 200);
  const body = await via.json();
  assert.strictEqual(body.ok, true); assert.strictEqual(body.ver, '4.0.0'); assert.strictEqual(body.db, false);
  assert.strictEqual(via.headers.get('strict-transport-security'), 'max-age=31536000');
  const other = await api(new Request('https://wts-api.netlify.app/api/v1/health', { headers: { 'X-WTS-Proxy-Sig': sig, 'X-WTS-Host': 'elsewhere.example' } }), {});
  assert.strictEqual(other.status, 404, 'the forwarded host must be the production host');
  assert.ok(log.lines.some((l) => /"t":"access"/.test(l)));
  assert.ok(!log.lines.some((l) => l.includes(sig)), 'the signature is never logged');
});

test('kick: signed request accepted once by the background function; replay, wrong path, GET and plain http refused', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  const env = { WTS_ENV: 'test', WTS_OPS_HMAC: key };
  const nonces = H.memoryNonceStore();
  const k = NF.kickRequest('ops-daily-background', 'https://wts-api.netlify.app', key, Date.now());
  assert.strictEqual(k.url, 'https://wts-api.netlify.app/.netlify/functions/ops-daily-background');
  const req = () => new Request(k.url, k.init);
  assert.strictEqual(await NF.verifyKick(req(), 'ops-daily-background', env, { nonces }), true);
  assert.strictEqual(await NF.verifyKick(req(), 'ops-daily-background', env, { nonces }), false, 'a nonce is accepted once');
  const k2 = NF.kickRequest('ops-daily-background', 'https://wts-api.netlify.app', key, Date.now());
  assert.strictEqual(await NF.verifyKick(new Request(k2.url, k2.init), 'weekly-export-background', env, { nonces }), false, 'signed for another function');
  assert.strictEqual(await NF.verifyKick(new Request(k2.url, { method: 'GET', headers: k2.init.headers }), 'ops-daily-background', env, { nonces }), false);
  const old = NF.kickRequest('ops-daily-background', 'https://wts-api.netlify.app', key, Date.now() - 6 * 60 * 1000);
  assert.strictEqual(await NF.verifyKick(new Request(old.url, old.init), 'ops-daily-background', env, { nonces }), false, '±5 min');
  const forged = NF.kickRequest('ops-daily-background', 'https://wts-api.netlify.app', crypto.randomBytes(32).toString('base64'), Date.now());
  assert.strictEqual(await NF.verifyKick(new Request(forged.url, forged.init), 'ops-daily-background', env, { nonces }), false, 'another key');
  assert.throws(() => NF.kickRequest('ops-daily-background', 'http://wts-api.netlify.app', key), /https/);
  assert.throws(() => NF.kickRequest('api', 'https://wts-api.netlify.app', key), /unknown background/);
  assert.throws(() => NF.kickRequest('ops-daily-background', 'https://wts-api.netlify.app', ''), /WTS_OPS_HMAC/);
});

test('scheduled functions: ops-daily and weekly-export only start their background function; a failure is an alert line', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  const seen = []; const log = memLog();
  const fetch = async (url, init) => { seen.push({ url, init }); return { status: 202, ok: true }; };
  const r = await NF.scheduledFunction('weekly-export', { env: { WTS_OPS_HMAC: key }, fetch, log })(new Request('https://x.invalid/'), { site: { url: 'https://wts-api.netlify.app' } });
  assert.deepStrictEqual(await r.json(), { ok: true, kicked: 'weekly-export-background', status: 202 });
  assert.strictEqual(seen[0].url, 'https://wts-api.netlify.app/.netlify/functions/weekly-export-background');
  assert.strictEqual(seen[0].init.method, 'POST'); assert.ok(seen[0].init.headers['X-WTS-Sig']);
  const bad = await NF.scheduledFunction('ops-daily', { env: {}, fetch, log })(new Request('https://x.invalid/'), { site: { url: 'https://wts-api.netlify.app' } });
  assert.strictEqual(bad.status, 500);
  assert.ok(log.lines.some((l) => /^alert: jobs — ops-daily failed: WTS_OPS_HMAC/.test(l)));
  const refused = await NF.scheduledFunction('ops-daily', { env: { WTS_OPS_HMAC: key }, fetch: async () => ({ status: 500, ok: false }), log })(new Request('https://x.invalid/'), { site: { url: 'https://wts-api.netlify.app' } });
  assert.strictEqual((await refused.json()).ok, false);
  assert.ok(log.lines.some((l) => /could not start ops-daily-background \(500\)/.test(l)));
  assert.throws(() => NF.scheduledFunction('api'), /not a scheduled function/);
  assert.throws(() => NF.backgroundFunction('ops-daily'), /not a background function/);
});

test('background functions: unsigned calls refused with an alert; a signed call without a database reports skipped', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  const log = memLog(); const nonces = H.memoryNonceStore();
  const bg = NF.backgroundFunction('ops-daily-background', { env: { WTS_ENV: 'test', WTS_OPS_HMAC: key }, nonces, log, getStore: fakeBlobs().getStore });
  const unsigned = await bg(new Request('https://wts-api.netlify.app/.netlify/functions/ops-daily-background', { method: 'POST', body: '{}' }));
  assert.strictEqual(unsigned.status, 404);
  assert.ok(log.lines.some((l) => /^alert: jobs — ops-daily-background refused/.test(l)));
  const k = NF.kickRequest('ops-daily-background', 'https://wts-api.netlify.app', key, Date.now());
  const r = await bg(new Request(k.url, k.init));
  assert.deepStrictEqual(await r.json(), { ok: false, skipped: 'no database' });
  assert.ok(log.lines.some((l) => /skipped \(no database\)/.test(l)));
});

test('proxy rule for the main site: placeholder only in the snippet, filled in from WTS_PROXY_SIG at build time', () => {
  const P = require('../site/proxy-rule');
  const s = P.snippet('wts-accounts-api.netlify.app');
  assert.match(s, /to = "https:\/\/wts-accounts-api\.netlify\.app\/api\/v1\/:splat"/);
  assert.match(s, /status = 200/); assert.match(s, /force = true/);
  assert.match(s, /X-WTS-Proxy-Sig = "__WTS_PROXY_SIG__", X-WTS-Host = "welltest\.h2oil\.co\.uk"/);
  assert.match(s, /publish = "dist-site"/); assert.match(s, /SECRETS_SCAN_OMIT_PATHS = "netlify\.toml"/);
  assert.throws(() => P.snippet('evil.example.com'), /functions site address/);
  const sig = crypto.randomBytes(32).toString('base64url');
  const a = P.apply(s, { WTS_PROXY_SIG: sig + ',' + crypto.randomBytes(32).toString('base64url') });
  assert.strictEqual(a.state, 'set'); assert.ok(a.text.includes('X-WTS-Proxy-Sig = "' + sig + '"')); assert.ok(!a.text.includes(P.PLACEHOLDER));
  const u = P.apply(s, {});
  assert.strictEqual(u.state, 'unset'); assert.ok(u.text.includes('X-WTS-Proxy-Sig = "unset"'));
  assert.strictEqual(P.apply('nothing here', {}).state, 'no-placeholder');
  assert.throws(() => P.apply(s, { WTS_PROXY_SIG: 'short"injected' }), /32-128/);
  assert.throws(() => P.apply(s + P.PLACEHOLDER, { WTS_PROXY_SIG: sig }), /exactly once/);
});

test('keygen: every value loads in core/config.js; production ids pass isolation in production, preview ids only outside it', () => {
  const K = require('../ops/keygen');
  const { loadConfig } = require('../core/config');
  const { checkIsolation } = require('../site/isolation');
  const B = require('../site/backup');
  const toEnv = (rows) => { const e = {}; rows.filter((r) => r.where !== 'NOT on any site').forEach((r) => { e[r.name] = r.value; }); return e; };
  const prodRows = K.generate();
  const prod = Object.assign({ WTS_ENV: 'production', WTS_CLIENT_IP_HEADER: 'x-nf-client-connection-ip' }, toEnv(prodRows));
  const c = loadConfig(prod);
  assert.deepStrictEqual(c.warnings, []);
  assert.strictEqual(c.secrets.masterKeys.length, 1); assert.strictEqual(c.secrets.codePeppers.length, 1); assert.ok(c.secrets.opsHmac && c.secrets.indexPepper && c.secrets.sessionPepper);
  assert.ok(checkIsolation(c, prod).ok, 'production values pass isolation');
  assert.ok(require('../core/keys').createKeys(c).ready);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(prod.WTS_PROXY_SIG), 'the proxy signature fits the main site rule');
  const priv = prodRows.find((r) => r.name === 'WTS_BACKUP_PRIVATE_KEY');
  assert.ok(!(priv.name in prod), 'the private export key is never a site variable');
  assert.ok(B.open(B.sealTo(Buffer.from('x'), B.parsePublicKey(prod.WTS_BACKUP_PUBLIC_KEY)), B.parsePrivateKeys(priv.value)).equals(Buffer.from('x')));
  assert.ok(!checkIsolation(c, Object.assign({}, prod, { WTS_BACKUP_PRIVATE_KEY: priv.value })).ok, 'isolation refuses the private key on the site');
  const prev = Object.assign({ WTS_ENV: 'preview', WTS_PREVIEW_SIGNIN: '1' }, toEnv(K.generate({ preview: true })));
  assert.ok(checkIsolation(loadConfig(prev), prev).ok);
  assert.ok(!checkIsolation(loadConfig(Object.assign({}, prev, { WTS_ENV: 'production' })), Object.assign({}, prev, { WTS_ENV: 'production', WTS_PREVIEW_SIGNIN: '' })).ok);
});

test('database URLs: only sslmode / sslrootcert reach the driver; TLS raised to verify-full off loopback; roles checked', () => {
  const D = require('../core/db');
  assert.strictEqual(D.cleanUrl('postgresql://u:p@ep-x.example.invalid/db?sslmode=require&channel_binding=require'), 'postgresql://u:p@ep-x.example.invalid/db?sslmode=verify-full');
  assert.strictEqual(D.cleanUrl('postgres://u@127.0.0.1:5432/db?sslmode=disable&role=wts_jobs'), 'postgres://u@127.0.0.1:5432/db?sslmode=disable');
  assert.strictEqual(D.cleanUrl('postgres://u@db.example.invalid/db'), 'postgres://u@db.example.invalid/db');
  assert.throws(() => D.cleanUrl('https://db.example.invalid/x'), /not a database URL/);
  assert.throws(() => D.createDb('postgres://u@127.0.0.1/db', { role: 'postgres' }), /wts_\* roles/);
  assert.throws(() => D.createDb('postgres://u@127.0.0.1/db', { role: 'wts_api; drop table x' }), /wts_\* roles/);
});

test('backup sealing: an export sealed to the public key opens only with its private key; the old format still opens', () => {
  const B = require('../site/backup');
  const a = B.generateBackupKeys(1); const b = B.generateBackupKeys(1);
  const sealed = B.sealTo(Buffer.from('payload'), B.parsePublicKey(a.publicKey), { created: '2026-11-09T00:00:00Z' });
  assert.ok(sealed.subarray(0, 6).equals(Buffer.from('WTSX2\n')));
  assert.ok(B.open(sealed, B.parsePrivateKeys(a.privateKey)).equals(Buffer.from('payload')));
  assert.throws(() => B.open(sealed, B.parsePrivateKeys(b.privateKey)), /authentication failed/);
  assert.throws(() => B.open(sealed, B.parseKeys('1:' + crypto.randomBytes(32).toString('base64'))), /no private key/);
  const flipped = Buffer.from(sealed); flipped[flipped.length - 20] ^= 1;
  assert.throws(() => B.open(flipped, B.parsePrivateKeys(a.privateKey)), /authentication failed/);
  const k1 = B.parseKeys('1:' + crypto.randomBytes(32).toString('base64'));
  assert.ok(B.open(B.seal(Buffer.from('v1'), k1), k1.concat(B.parsePrivateKeys(a.privateKey))).equals(Buffer.from('v1')));
  assert.throws(() => B.parsePublicKey('1:' + Buffer.from('not a key').toString('base64')), /not a public key/);
  assert.throws(() => B.parsePublicKey(''), /not set/);
});

test('export-fetch copies the newest sealed export from the exports store without the private key', async () => {
  const F = fakeBlobs();
  const ex = hostObjects(NB.createStore({}, { name: 'wts-exports', getStore: F.getStore }));
  await ex.put('export/wts-export-20261101T044100Z.wtsx', Buffer.from('old'));
  await ex.put('export/wts-export-20261108T044100Z.wtsx', Buffer.from('new'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-xf-'));
  try {
    const r = await require('../ops/export-fetch').main([dir], {}, { getStore: F.getStore });
    assert.deepStrictEqual(r, { ok: true, file: 'wts-export-20261108T044100Z.wtsx', bytes: 3 });
    assert.strictEqual(fs.readFileSync(path.join(dir, r.file), 'utf8'), 'new');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
