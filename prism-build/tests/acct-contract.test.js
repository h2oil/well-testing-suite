// Accounts — WP0 contract tests (docs/ACCOUNTS-PLAN.md §3, §5.1–5.2, §12; Phase 1 foundation).
//
//   AC1  the shared fixture: every endpoint's request / response example and every error envelope passes, broken copies fail
//        at the path of the break, request shapes are strict, the canonical-JSON vectors match server/core/canon.js
//   AC2  the fake server answers every Phase 1 endpoint through the real pipeline and every answer passes checkResponse
//   AC3  provider sign-in on the fake: the §4.12 linking rules, step-up never set by a provider sign-in, link-confirm, unlink
//        revokes sessions, attempt extension (12 min ok, 31 min refused), the callback never sets the session cookie,
//        cancel / switches / signin mode
//   AC4  the skeletons 66–68 in bare contexts: ineligible everywhere but the production https host (or DEV on localhost):
//        http, capacitor (also with WTS_ACCOUNT_DEV), file:, framed, another host; eligible → every planned name, stubs reject
//        not_implemented, nothing at load (no fetch, timer, DOM); ACCT markers survive concat-round10, files after 65; the
//        REAL ios-app/scripts/sync-from-main.js (steps 0c / 0d) on the built page + Round 10 strips every account identifier
//        and fails on unbalanced markers or a leaked identifier
//   AC5  the skeleton's call() / providers() / canonical() / sha256Hex() agree with the fake server and the shared vectors; a
//        2xx that is not JSON is code 'server' (providers off); sha256Hex uses the configured crypto seam
//   AC6  the app from sources on the harness (http://localhost) — accounts inert, no errors, no timer left
//   AC8  the session cookie's Max-Age (seconds to abs_expires_at, trusted and public devices) and the fake browser's restart
//   AC7  the app on the production https location with the fake fetch — eligible, zero requests and zero timers after 5 s,
//        no account page registered, providers() reaches the fake from the app realm
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const S = require('./_acct-shapes');
const F = require('./_acct-fake-server');

const WP = 'AC0';
const BUILD = path.join(__dirname, '..');
const FILES = ['66-account.js', '67-cloud-sync.js', '68-account-page.js'];
const B = F.PROD + S.BASE;
const clone = (o) => JSON.parse(JSON.stringify(o));

function post(br, p, body, extra) {
  return br.fetch(B + p, { method: 'POST', headers: Object.assign({ 'X-WTS-Req': '1', 'Content-Type': 'application/json' }, extra || {}), body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: r.status === 204 ? null : await r.json(), r }));
}
function get(br, p) {
  return br.fetch(B + p).then(async (r) => {
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, json: /json/.test(ct) ? await r.json() : null, bytes: /octet/.test(ct) ? Buffer.from(await r.arrayBuffer()) : null, r };
  });
}
function expect(assert, id, res, status, what) {
  assert.strictEqual(res.status, status, (what || id) + ': status ' + res.status + ' ' + JSON.stringify(res.json));
  const c = S.checkResponse(id, res.status, res.json === null && res.bytes ? res.bytes : res.json);
  assert(c.ok, (what || id) + ': ' + JSON.stringify(c.errors.slice(0, 4)));
  return res.json;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// a bare vm context for the skeletons; counts every fetch / timer / document access
function bare(o) {
  o = o || {};
  const counts = { fetch: 0, timers: 0, doc: 0 };
  const store = {};
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    location: o.location || { protocol: 'http:', hostname: 'localhost', host: 'localhost:8080', search: '', hash: '', pathname: '/' },
    fetch: o.fetch || (() => { counts.fetch++; return Promise.reject(new Error('no fetch')); }),
    setTimeout: () => { counts.timers++; return 0; }, setInterval: () => { counts.timers++; return 0; },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    crypto: { subtle: crypto.webcrypto.subtle }, TextEncoder,
    Promise, JSON, Object, Array, Error, Uint8Array,
  };
  if (o.fetch) { const f = o.fetch; ctx.fetch = function () { counts.fetch++; return f.apply(null, arguments); }; }
  Object.defineProperty(ctx, 'document', { get() { counts.doc++; return undefined; }, configurable: true });
  ctx.window = ctx;
  if (o.capacitor) ctx.Capacitor = { isNativePlatform: () => true };
  if (o.dev) ctx.WTS_ACCOUNT_DEV = 1;
  vm.createContext(ctx);
  ctx.top = o.framed ? {} : vm.runInContext('globalThis', ctx);
  const { stripSelfTest } = require(path.join(BUILD, 'concat-round8.js'));
  const quiet = { log() {}, warn() {} };
  FILES.forEach((f) => vm.runInContext(stripSelfTest(fs.readFileSync(path.join(BUILD, f), 'utf8'), f, quiet), ctx, { filename: f }));
  return { win: vm.runInContext('globalThis', ctx), counts, store };
}
const PROD_LOC = { protocol: 'https:', hostname: 'welltest.h2oil.co.uk', host: 'welltest.h2oil.co.uk', search: '', hash: '', pathname: '/well-testing-app.html' };

module.exports = [
  {
    name: 'AC1 shared fixture: examples, envelopes, broken copies, strict requests, canonical vectors', wp: WP, opts: false,
    run(app, assert) {
      assert.strictEqual(S.ENDPOINTS.length, 54);   // 50 + the four admin dashboard routes
      assert.deepStrictEqual(S.ENDPOINTS.map((e) => e.id).filter((id, i, a) => a.indexOf(id) !== i), [], 'endpoint ids are unique');
      for (const e of S.ENDPOINTS) {
        const ex = S.EXAMPLES[e.id];
        assert(ex, 'example for ' + e.id);
        if (e.req) assert(S.checkShape(e.req, ex.req).ok, e.id + ' request: ' + JSON.stringify(S.checkShape(e.req, ex.req).errors));
        for (const st of Object.keys(e.res)) assert(S.checkResponse(e.id, Number(st), ex.res[st]).ok, e.id + ' ' + st + ': ' + JSON.stringify(S.checkResponse(e.id, Number(st), ex.res[st]).errors));
        e.errors.forEach((code) => assert(S.ERRORS[code], e.id + ' lists unknown error ' + code));
        assert(e.path.startsWith('/') && !e.path.startsWith(S.BASE), e.id + ' path is relative to /api/v1');
      }
      for (const code of Object.keys(S.ERRORS)) assert(S.checkError(code, S.ERROR_EXAMPLES[code]).ok, code);
      S.FINISH_EXAMPLES.forEach((f, i) => assert(S.checkShape('FinishRes', f).ok, 'finish example ' + i));
      // broken copies fail at the path of the break
      const brk = (shape, base, fn, at) => { const o = clone(base); fn(o); const r = S.checkShape(shape, o); assert(!r.ok && r.errors.some((x) => x.startsWith(at)), shape + ' broken at ' + at + ': ' + JSON.stringify(r.errors)); };
      brk('Me', S.EXAMPLES.me.res[200], (o) => { o.session.authMethod = 'password'; }, 'session.authMethod');
      brk('Me', S.EXAMPLES.me.res[200], (o) => { delete o.quota.used; }, 'quota.used');
      brk('CommitReq', S.EXAMPLES.projectCommit.req, (o) => { o.parts[1].hash = 'XYZ'; }, 'parts[1].hash');
      brk('CommitReq', S.EXAMPLES.projectCommit.req, (o) => { o.reason = 'whim'; }, 'reason');
      brk('FinishRes', S.FINISH_EXAMPLES[3], (o) => { o.reason = 'because'; }, 'reason');
      brk('FinishRes', S.FINISH_EXAMPLES[0], (o) => { o.next = 'later'; }, 'next');
      brk('SignInResult', S.EXAMPLES.codeVerify.res[200], (o) => { o.user.emailMasked = 'name@company.example'; }, 'user.emailMasked');
      brk('CodeStartReq', S.EXAMPLES.codeStart.req, (o) => { o.extra = 1; }, 'extra');
      brk('CodeStartReq', S.EXAMPLES.codeStart.req, (o) => { delete o.email; }, '(root)');
      assert(S.checkShape('CodeStartReq', { purpose: 'stepup' }).ok, 'a step-up code needs no address');
      assert(!S.checkShape('OAuthFinishReq', { email: 'a@b.example', code: '12345678' }).ok, 'finish takes one step at a time');
      assert(!S.checkShape('RecoverySetReq', {}).ok && S.checkShape('RecoverySetReq', { code: '1234 5678' }).ok);
      assert(!S.checkError('rate', { error: 'rate', message: 'x' }).ok, 'rate needs retryAfter');
      assert(!S.checkError('oauth_failed', { error: 'oauth_failed', message: 'x', reason: 'whatever' }).ok);
      assert(!S.checkResponse('me', 403, S.ERROR_EXAMPLES.not_invited).ok, 'an error not listed for the endpoint fails');
      assert(S.checkResponse('me', 501, S.ERROR_EXAMPLES.not_implemented).ok, 'the foundation stub code is accepted everywhere');
      assert(!S.checkResponse('me', 418, {}).ok);
      assert.deepStrictEqual(S.COOKIES.session, { name: '__Host-wts_sid', secure: true, httpOnly: true, sameSite: 'Strict', path: '/', maxAgeRequired: true });
      assert.strictEqual(S.COOKIES.attemptLax.sameSite, 'Lax'); assert.strictEqual(S.COOKIES.attemptStrict.maxAge, 1200);
      const canon = require(path.join(S.SERVER_DIR, 'core', 'canon'));
      S.CANON_VECTORS.forEach((v) => { assert.strictEqual(canon.canonical(v.value), v.canonical); assert.strictEqual(canon.hashOf(v.value), v.sha256); });
      assert.strictEqual(S.CANON_VECTORS[0].canonical, '{"a":1,"b":2,"c":[3,{"y":"é","z":null}]}');
    },
  },
  {
    name: 'AC2 fake server: every Phase 1 endpoint through the real pipeline, every answer passes the contract', wp: WP, opts: false,
    async run(app, assert) {
      let t = Date.UTC(2026, 10, 8, 9, 0, 0);
      const fake = F.createFakeServer({ now: () => t });
      const br = fake;
      expect(assert, 'health', await get(br, '/health'), 200);
      expect(assert, 'providers', await get(br, '/auth/providers'), 200);
      expect(assert, 'me', await get(br, '/me'), 401, 'me signed out');
      expect(assert, 'codeStart', await post(br, '/auth/code/start', { email: 'name@company.example', purpose: 'signin' }), 202);
      const code = fake.codeFor('name@company.example', 'code_signin');
      assert(/^\d{8}$/.test(code));
      const cr = expect(assert, 'codeVerify', await post(br, '/auth/code/verify', { email: 'name@company.example', code, publicDevice: false }), 409, 'new account without consent');
      assert.deepStrictEqual([cr.terms, cr.privacy], ['1', '1']);
      expect(assert, 'codeVerify', await post(br, '/auth/code/verify', { email: 'name@company.example', code: code === '11111111' ? '22222222' : '11111111', publicDevice: false, consent: { terms: '1', privacy: '1' } }), 400, 'wrong code');
      const si = expect(assert, 'codeVerify', await post(br, '/auth/code/verify', { email: 'name@company.example', code, publicDevice: false, consent: { terms: '1', privacy: '1' } }), 200, 'the same code still works (not burnt by the 409)');
      assert.strictEqual(si.firstSignIn, true);
      assert(fake.cookie('__Host-wts_sid') && fake.cookie('__Host-wts_sid').sameSite === 'Strict' && fake.cookie('__Host-wts_sid').attrs.httponly);
      const me = expect(assert, 'me', await get(br, '/me'), 200);
      assert.strictEqual(me.session.authMethod, 'code'); assert(me.session.stepupAt);
      expect(assert, 'outboxKey', await get(br, '/me/outbox-key'), 200);
      expect(assert, 'opts', await post(br, '/me/opts', { historian: true }), 200);
      expect(assert, 'deviceRename', await post(br, '/devices/rename', { id: si.device.id, label: 'Office PC' }), 200);
      expect(assert, 'methods', await get(br, '/auth/methods'), 200);
      // library
      expect(assert, 'library', await get(br, '/library'), 200);
      expect(assert, 'libraryBody', await get(br, '/library/body'), 404);
      const lib = expect(assert, 'libraryCommit', await post(br, '/library/commit', { pushId: crypto.randomUUID(), baseRev: 0, hash: 'a'.repeat(64), body: Buffer.from('{}').toString('base64') }), 200);
      assert.strictEqual(lib.rev, 1);
      expect(assert, 'libraryCommit', await post(br, '/library/commit', { pushId: crypto.randomUUID(), baseRev: 0, hash: 'a'.repeat(64), body: '' }), 409);
      // projects + blobs
      const meta = { client: 'Operator Energy Ltd', well: 'Example-1', field: '', operator: '' };
      const pc = expect(assert, 'projectCreate', await post(br, '/projects', { name: 'Example-1 DST', meta }), 201);
      const part = Buffer.from(JSON.stringify({ wts_page_choke: '{"v":1}' }));
      const z1 = require('zlib').gzipSync(part); const z2 = Buffer.from('second chunk');
      const whole = Buffer.concat([z1, z2]);
      const ph = sha('part-1');
      expect(assert, 'blobsHas', await post(br, '/blobs/has', { hashes: [ph] }), 200);
      const put = (n, buf, of, z) => br.fetch(B + '/blobs/' + ph + '/' + n + '?of=' + of, { method: 'PUT', headers: { 'X-WTS-Req': '1', 'Content-Type': 'application/octet-stream', 'X-WTS-Zsha': z, 'X-WTS-Chunk-Sha': sha(buf) }, body: buf })
        .then(async (r) => ({ status: r.status, json: r.status === 204 ? null : await r.json() }));
      expect(assert, 'blobPut', await put(0, z1, 2, sha(whole)), 204);
      expect(assert, 'blobPut', await put(0, z1, 2, sha(whole)), 204, 'byte-identical repeat');
      expect(assert, 'blobPut', await put(0, z2, 2, sha(whole)), 409, 'a different body for a stored chunk');
      const core = require('zlib').gzipSync('{"core":1}');
      const commit = (o) => post(br, '/projects/' + pc.id + '/commit', Object.assign({ pushId: crypto.randomUUID(), baseRev: 0, reason: 'save',
        core: { hash: sha('core-1'), vhash: sha('v-1'), zsha: sha(core), bytes: 10, inline: core.toString('base64') },
        parts: [{ name: 'well/w1', hash: ph, bytes: part.length }], meta: Object.assign({ name: 'Example-1 DST' }, meta), wells: [{ id: 'w1', name: 'Example-1' }], fmt: 2, appVer: '4.0' }, o));
      const miss = expect(assert, 'projectCommit', await commit({}), 422);
      assert.deepStrictEqual(miss.missing, [ph]);
      expect(assert, 'blobPut', await put(1, z2, 2, sha(whole)), 204);
      const pid = crypto.randomUUID();
      const c1 = expect(assert, 'projectCommit', await commit({ pushId: pid }), 200);
      assert.deepStrictEqual(expect(assert, 'projectCommit', await commit({ pushId: pid }), 200), c1, 'a pushId retry is idempotent');
      const st = expect(assert, 'projectCommit', await commit({}), 409, 'stale');
      assert.strictEqual(st.headRev, 1);
      const blob = await get(br, '/blobs/' + ph + '/1');
      expect(assert, 'blobGet', blob, 200); assert.strictEqual(blob.bytes.toString(), 'second chunk'); assert.strictEqual(blob.r.headers.get('x-wts-of'), '2');
      expect(assert, 'projectList', await get(br, '/projects'), 200);
      const hd = expect(assert, 'projectHead', await get(br, '/projects/' + pc.id + '/head'), 200);
      assert.strictEqual(hd.rev, 1); assert(hd.coreInline);
      expect(assert, 'projectRevs', await get(br, '/projects/' + pc.id + '/revs?limit=5'), 200);
      expect(assert, 'projectRev', await get(br, '/projects/' + pc.id + '/rev/1'), 200);
      expect(assert, 'projectRev', await get(br, '/projects/' + pc.id + '/rev/9'), 404);
      expect(assert, 'projectRename', await post(br, '/projects/' + pc.id + '/rename', { name: 'Renamed' }), 200);
      expect(assert, 'projectRestoreRev', await post(br, '/projects/' + pc.id + '/restore-rev', { rev: 1, pushId: crypto.randomUUID() }), 200);
      const dup = expect(assert, 'projectDuplicate', await post(br, '/projects/' + pc.id + '/duplicate', { name: 'Copy' }), 201);
      expect(assert, 'projectTrash', await post(br, '/projects/' + dup.id + '/trash', {}), 200);
      expect(assert, 'projectHead', await get(br, '/projects/' + dup.id + '/head'), 410);
      expect(assert, 'projectRestore', await post(br, '/projects/' + dup.id + '/restore', {}), 200);
      expect(assert, 'projectHead', await get(br, '/projects/' + crypto.randomUUID() + '/head'), 404);
      // step-up window: 11 min later every step-up action asks again
      t += 11 * 60 * 1000;
      expect(assert, 'projectPurge', await post(br, '/projects/' + dup.id + '/purge', {}), 403);
      expect(assert, 'codeStart', await post(br, '/auth/code/start', { purpose: 'stepup' }), 202);
      const old = fake.cookie('__Host-wts_sid').value;
      expect(assert, 'codeVerify', await post(br, '/auth/code/verify', { code: fake.codeFor('name@company.example', 'code_stepup'), publicDevice: false }), 200, 'step-up');
      assert.notStrictEqual(fake.cookie('__Host-wts_sid').value, old, 'step-up rotates the session id');
      const stale = fake.browser('old-tab'); stale.jar.set('__Host-wts_sid', { value: old, sameSite: 'Strict', expires: null, attrs: {} });
      expect(assert, 'me', await get(stale, '/me'), 200, 'the previous id stays valid for 30 s');
      t += 31 * 1000;
      expect(assert, 'me', await get(stale, '/me'), 401, 'and not after');
      expect(assert, 'projectPurge', await post(br, '/projects/' + dup.id + '/purge', {}), 200);
      // e-mail change, confirm, revert; recovery address
      expect(assert, 'emailChange', await post(br, '/auth/email/change', { newEmail: 'new@company.example' }), 202);
      expect(assert, 'emailConfirm', await post(br, '/auth/email/confirm', { code: fake.codeFor('new@company.example', 'code_email_change') }), 200);
      const revert = fake.lastMail('name@company.example');
      assert.strictEqual(revert.template, 'notice_email_changed');
      const other = fake.browser('revert');
      expect(assert, 'emailRevert', await post(other, '/auth/email/revert', { email: 'name@company.example', code: revert.params.revertCode }), 200);
      expect(assert, 'me', await get(br, '/me'), 401, 'revert revokes every session');
      const s2 = await F.signIn(fake, br, 'name@company.example');
      assert.strictEqual(s2.status, 200); assert.strictEqual(s2.json.firstSignIn, false);
      expect(assert, 'recoverySet', await post(br, '/auth/recovery/set', { email: 'me@personal.example' }), 202);
      expect(assert, 'recoverySet', await post(br, '/auth/recovery/set', { code: fake.codeFor('me@personal.example', 'code_recovery_add') }), 200);
      assert(expect(assert, 'me', await get(br, '/me'), 200).user.recoveryMasked);
      expect(assert, 'recoveryRemove', await post(br, '/auth/recovery/remove', {}), 200);
      // passkeys are Phase 3
      expect(assert, 'passkeyOptions', await post(br, '/auth/passkey/options', { purpose: 'signin' }), 501);
      // export, delete with grace, cancel
      const ex = expect(assert, 'accountExport', await post(br, '/account/export', {}), 200);
      assert(ex.projects.length >= 1);
      expect(assert, 'accountDelete', await post(br, '/account/delete', { confirm: 'DELETE' }), 200);
      expect(assert, 'me', await get(br, '/me'), 401, 'deletion revokes every session');
      await F.signIn(fake, br, 'name@company.example');
      const dm = expect(assert, 'me', await get(br, '/me'), 200);
      assert.strictEqual(dm.user.status, 'deleting'); assert(dm.user.deleteAt);
      expect(assert, 'projectList', await get(br, '/projects'), 410, 'everything hidden while deleting');
      expect(assert, 'accountDeleteCancel', await post(br, '/account/delete/cancel', {}), 200);
      expect(assert, 'projectList', await get(br, '/projects'), 200);
      // devices, sign out, sign out everywhere
      const d2 = fake.browser('laptop'); await F.signIn(fake, d2, 'name@company.example');
      const devs = expect(assert, 'me', await get(br, '/me'), 200).devices;
      assert(devs.length >= 2);
      expect(assert, 'deviceRevoke', await post(br, '/devices/revoke', { id: devs.find((d) => !d.current).id }), 200);
      t += 11 * 60 * 1000;
      expect(assert, 'signOutAll', await post(br, '/auth/signout-all', {}), 403, 'needs a step-up within 10 min');
      await F.signIn(fake, br, 'name@company.example');
      expect(assert, 'signOutAll', await post(br, '/auth/signout-all', {}), 200);
      await F.signIn(fake, br, 'name@company.example');
      expect(assert, 'signOut', await post(br, '/auth/signout', {}), 200);
      assert.strictEqual(fake.cookie('__Host-wts_sid'), null);
      // kill switches and fault modes
      fake.setSwitch('ACCOUNTS_OFF', '1');
      expect(assert, 'codeStart', await post(br, '/auth/code/start', { email: 'a@b.example', purpose: 'signin' }), 503);
      fake.setSwitch('ACCOUNTS_OFF', null);
      await F.signIn(fake, br, 'name@company.example');
      fake.setSwitch('SYNC_MODE', 'readonly');
      expect(assert, 'projectCreate', await post(br, '/projects', { name: 'x', meta }), 503);
      expect(assert, 'projectList', await get(br, '/projects'), 200, 'reads still work when read-only');
      fake.setSwitch('SYNC_MODE', 'off');
      expect(assert, 'projectList', await get(br, '/projects'), 503);
      fake.setSwitch('SYNC_MODE', null);
      fake.fault({ path: '/me', mode: 'rate' });
      const rl = expect(assert, 'me', await get(br, '/me'), 429); assert.strictEqual(rl.retryAfter, 30);
      fake.fault({ path: '/me', mode: 'network' });
      await assert.rejects(get(br, '/me'), /Failed to fetch/);
      // the pipeline's common rules hold on the fake too
      const noHdr = await br.fetch(B + '/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.strictEqual(noHdr.status, 403); assert.strictEqual((await noHdr.json()).error, 'origin');
      assert.strictEqual(noHdr.headers.get('cache-control'), 'no-store');
      // every Phase 1 endpoint was exercised (callback / finish / start / unlink / devices are in AC3)
      const hit = new Set(fake.requests.map((q) => { const m = S.matchRoute(q.method, q.path.slice(S.BASE.length)); return m && m.endpoint.id; }));
      // (the admin routes are exercised against the real server: server/test/admin.test.js)
      const left = S.ENDPOINTS.filter((e) => e.phase === 1 && !hit.has(e.id) && e.group !== 'admin' && ['oauthStart', 'oauthCallback', 'oauthFinish', 'unlink', 'emailRevert', 'cspReport', 'opsDaily'].indexOf(e.id) === -1).map((e) => e.id);
      assert.deepStrictEqual(left, [], 'Phase 1 endpoints not exercised');
      fake.mail.sent.forEach((m) => { assert(!/</.test(JSON.stringify(m.params)), 'plain-text mail params'); });
    },
  },
  {
    name: 'AC3 fake provider sign-in: linking rules, step-up, link-confirm, unlink, extension, cookies, switches', wp: WP, opts: false,
    async run(app, assert) {
      let t = Date.UTC(2026, 10, 8, 9, 0, 0);
      const fake = F.createFakeServer({ now: () => t });
      const start = (br, p, body) => post(br, '/auth/oauth/' + p + '/start', Object.assign({ purpose: 'signin', publicDevice: false }, body || {}));
      const finish = (br, body) => post(br, '/auth/oauth/finish', body || {});
      // rule 3: Google, a Google-managed address, no account → consent → new account, stepupAt NULL
      const g = fake.browser('g');
      const s1 = expect(assert, 'oauthStart', await start(g, 'google'), 200);
      assert(/prompt=select_account/.test(s1.url) && /code_challenge_method=S256/.test(s1.url) && /scope=openid\+email(&|$)/.test(s1.url));
      const oa = g.cookie('__Host-wts_oa'); assert(oa && oa.sameSite === 'Lax' && oa.attrs['max-age'] === '600');
      const cb = await g.visit(s1.url, { as: { key: 'g-1', email: 'someone@gmail.com' } });
      assert.deepStrictEqual(cb, { status: 303, location: 'https://welltest.h2oil.co.uk/#acct-oauth' });
      assert.strictEqual(g.cookie('__Host-wts_sid'), null, 'the callback never sets the session cookie');
      const f1 = expect(assert, 'oauthFinish', await finish(g), 200);
      assert.strictEqual(f1.next, 'consent'); assert.strictEqual(g.cookie('__Host-wts_oa').sameSite, 'Strict', 'the attempt cookie is re-issued Strict');
      const f2 = expect(assert, 'oauthFinish', await finish(g, { consent: { terms: '1', privacy: '1' } }), 200);
      assert.strictEqual(f2.next, 'done'); assert.strictEqual(f2.method, 'google'); assert.strictEqual(f2.firstSignIn, true);
      assert.strictEqual(g.cookie('__Host-wts_oa'), null, 'attempt cookie cleared at the end');
      const gm = expect(assert, 'me', await get(g, '/me'), 200);
      assert.strictEqual(gm.session.authMethod, 'google'); assert.strictEqual(gm.session.stepupAt, null);
      for (const [id, p, body] of [['emailChange', '/auth/email/change', { newEmail: 'x@company.example' }], ['signOutAll', '/auth/signout-all', {}],
        ['accountExport', '/account/export', {}], ['accountDelete', '/account/delete', { confirm: 'DELETE' }], ['recoverySet', '/auth/recovery/set', { email: 'r@company.example' }],
        ['unlink', '/auth/methods/unlink', { id: gm.identities[0].id }], ['oauthStart', '/auth/oauth/linkedin/start', { purpose: 'link', publicDevice: false }]]) {
        expect(assert, id, await post(g, p, body), 403, id + ' right after a provider sign-in');
      }
      // rule 1: the known identity signs in again with one click
      const g2 = fake.browser('g2');
      await g2.visit(expect(assert, 'oauthStart', await start(g2, 'google'), 200).url, { as: { key: 'g-1', email: 'someone@gmail.com' } });
      const k = expect(assert, 'oauthFinish', await finish(g2), 200);
      assert.strictEqual(k.next, 'done'); assert.strictEqual(k.firstSignIn, false); assert.strictEqual(k.providerEmailDiffers, false);
      // a verified Google flag on a third-party domain without hd never creates an account (rule 5) …
      const g3 = fake.browser('g3');
      await g3.visit((await start(g3, 'google')).json.url, { as: { key: 'g-3', email: 'ex@company.example', email_verified: true } });
      const u5 = expect(assert, 'oauthFinish', await finish(g3), 200);
      assert.strictEqual(u5.next, 'email'); assert.strictEqual(u5.reason, 'unmanaged');
      // … with a matching hd it does (consent step)
      const g4 = fake.browser('g4');
      await g4.visit((await start(g4, 'google')).json.url, { as: { key: 'g-4', email: 'eng@corp.example', hd: 'corp.example' } });
      assert.strictEqual(expect(assert, 'oauthFinish', await finish(g4), 200).next, 'consent');
      // U15 / rule 4: a code user presses Google with the same managed address → code to that address, then linked
      const c = fake.browser('code-user');
      await F.signIn(fake, c, 'owner@gmail.com');
      const g5 = fake.browser('g5');
      await g5.visit((await start(g5, 'google')).json.url, { as: { key: 'g-5', email: 'owner@gmail.com' } });
      const le = expect(assert, 'oauthFinish', await finish(g5), 200);
      assert.deepStrictEqual([le.next, le.reason], ['code', 'link_existing']);
      expect(assert, 'oauthFinish', await finish(g5, { code: '00000000' }), 400);
      t += 12 * 60 * 1000;                                    // a code entered 12 min after the callback still finishes
      const lx = expect(assert, 'oauthFinish', await finish(g5, { code: fake.codeFor('owner@gmail.com', 'code_oauth_verify') }), 200);
      assert.strictEqual(lx.next, 'done');
      assert(expect(assert, 'me', await get(g5, '/me'), 200).session.stepupAt, 'an oauth_verify code sets stepupAt');
      // LinkedIn always asks for a code; an attempt is refused 31 min after its start
      const l = fake.browser('l');
      await l.visit((await start(l, 'linkedin')).json.url, { as: { key: 'l-1', email: 'li@company.example' } });
      assert.strictEqual(expect(assert, 'oauthFinish', await finish(l), 200).next, 'email');
      assert.strictEqual(expect(assert, 'oauthFinish', await finish(l, { email: 'li@company.example' }), 200).next, 'code');
      t += 31 * 60 * 1000;
      expect(assert, 'oauthFinish', await finish(l, { code: fake.codeFor('li@company.example', 'code_oauth_verify') }), 400, 'expired attempt');
      // link from the account page: step-up at start, link-confirm code after the return; identity_in_use; unlink revokes
      await F.signIn(fake, c, 'owner@gmail.com');            // fresh code sign-in = step-up for 10 min
      const ls = expect(assert, 'oauthStart', await start(c, 'linkedin', { purpose: 'link' }), 200);
      await c.visit(ls.url, { as: { key: 'l-owner', email: 'owner@gmail.com' } });
      const lc = expect(assert, 'oauthFinish', await finish(c), 200);
      assert.deepStrictEqual([lc.next, lc.reason], ['code', 'link_confirm']);
      assert.strictEqual(fake.lastMail('owner@gmail.com').template, 'code_link_confirm');
      const linked = expect(assert, 'oauthFinish', await finish(c, { code: fake.codeFor('owner@gmail.com', 'code_link_confirm') }), 200);
      assert.strictEqual(linked.linked.provider, 'linkedin');
      const meths = expect(assert, 'methods', await get(c, '/auth/methods'), 200);
      assert.deepStrictEqual(meths.identities.map((i) => i.provider).sort(), ['google', 'linkedin']);
      const l2 = fake.browser('l2');                          // sign in with the linked LinkedIn: one click now
      await l2.visit((await start(l2, 'linkedin')).json.url, { as: { key: 'l-owner', email: 'owner@gmail.com' } });
      assert.strictEqual(expect(assert, 'oauthFinish', await finish(l2), 200).next, 'done');
      const ul = expect(assert, 'unlink', await post(c, '/auth/methods/unlink', { id: meths.identities.find((i) => i.provider === 'linkedin').id }), 200);
      assert.strictEqual(ul.sessionsRevoked, 1);
      expect(assert, 'me', await get(l2, '/me'), 401, 'unlink revoked the session that identity created');
      await F.signIn(fake, g, 'someone@gmail.com');
      await g.visit((await start(g, 'google', { purpose: 'link' })).json.url, { as: { key: 'g-5' } });
      expect(assert, 'oauthFinish', await finish(g), 409, 'identity_in_use');
      // a browser holding A's session that finishes as B: A's session is revoked, B's is fresh
      const ab = fake.browser('ab');
      await F.signIn(fake, ab, 'aaa@company.example');
      const aSid = ab.cookie('__Host-wts_sid').value;
      await ab.visit((await start(ab, 'google')).json.url, { as: { key: 'g-1', email: 'someone@gmail.com' } });
      expect(assert, 'oauthFinish', await finish(ab), 200);
      assert.notStrictEqual(ab.cookie('__Host-wts_sid').value, aSid);
      assert(!fake.state.sessions.has(aSid), "A's presented session is gone");
      // cancel, missing attempt, switches, signin mode, fresh login, ceiling
      const x = fake.browser('x');
      await x.visit((await start(x, 'google')).json.url, { cancel: true });
      const can = expect(assert, 'oauthFinish', await finish(x), 400); assert.strictEqual(can.reason, 'cancelled');
      expect(assert, 'oauthFinish', await finish(fake.browser('none')), 400, 'no attempt cookie');
      fake.setSwitch('OAUTH_LINKEDIN', 'off');
      assert.strictEqual(expect(assert, 'providers', await get(x, '/auth/providers'), 200).linkedin, 'off');
      assert.strictEqual(expect(assert, 'oauthStart', await start(x, 'linkedin'), 503).provider, 'linkedin');
      fake.setSwitch('OAUTH_GOOGLE', 'signin');
      assert.strictEqual(expect(assert, 'providers', await get(x, '/auth/providers'), 200).google, 'signin');
      await x.visit((await start(x, 'google')).json.url, { as: { key: 'g-new', email: 'new@gmail.com' } });
      expect(assert, 'oauthFinish', await finish(x), 503, 'signin mode: no new account');
      fake.setSwitch('OAUTH_GOOGLE', 'on'); fake.setSwitch('OAUTH_LINKEDIN', 'on');
      const fr = expect(assert, 'oauthStart', await start(x, 'google', { publicDevice: true }), 200);
      assert(/prompt=login/.test(fr.url) && /max_age=0/.test(fr.url));
      assert.strictEqual(expect(assert, 'oauthStart', await start(x, 'linkedin', { sharedBrowser: true }), 400).reason, 'reauth_stale');
      fake.setSwitch('ACCOUNTS_SIGNUP', 'invite');
      const iv = fake.browser('iv');
      await iv.visit((await start(iv, 'google')).json.url, { as: { key: 'g-iv', email: 'stranger@gmail.com' } });
      expect(assert, 'oauthFinish', await finish(iv), 403, 'not_invited');
      fake.lock('someone@gmail.com');
      const lk = fake.browser('lk');
      await lk.visit((await start(lk, 'google')).json.url, { as: { key: 'g-1', email: 'someone@gmail.com' } });
      assert.strictEqual(expect(assert, 'oauthFinish', await finish(lk), 403).error, 'locked');
      const cl = fake.browser('ceiling');
      for (let i = 0; i < 20; i++) { const b2 = fake.browser('c' + i); await start(b2, 'google'); }
      assert.strictEqual(expect(assert, 'oauthStart', await start(cl, 'google'), 503).error, 'provider_off', 'the per-prefix live-attempt ceiling');
      // the 303 never depends on the query (open-redirect payloads)
      for (const q of ['?code=x&state=y&next=https://evil.example', '?error=x', '?state=%0d%0aSet-Cookie:a=b']) {
        const r = await fake.browser('q').navigate(B + '/auth/oauth/google/callback' + q);
        assert.deepStrictEqual(r, { status: 303, location: 'https://welltest.h2oil.co.uk/#acct-oauth' });
      }
      fake.mail.sent.forEach((m) => assert(!JSON.stringify(m).includes('<script>'), 'provider error text never reaches a mail'));
    },
  },
  {
    name: 'AC4 skeletons 66–68: guard, planned names as stubs, nothing at load, ACCT markers through concat-round10', wp: WP, opts: false,
    async run(app, assert) {
      const inert = [
        ['http localhost (no DEV flag)', {}],
        ['smoke-stub location', { location: { hash: '', pathname: '/', search: '' } }],
        ['capacitor native', { location: { protocol: 'capacitor:', hostname: 'localhost', search: '' }, capacitor: true }],
        ['capacitor native with WTS_ACCOUNT_DEV', { location: { protocol: 'https:', hostname: 'localhost', search: '' }, capacitor: true, dev: true }],
        ['production host inside the native shell', { location: PROD_LOC, capacitor: true }],
        ['file:', { location: { protocol: 'file:', hostname: '', search: '' }, dev: true }],
        ['framed production page', { location: PROD_LOC, framed: true }],
        ['another https host', { location: { protocol: 'https:', hostname: 'preview.example', search: '' } }],
        ['production host over http', { location: { protocol: 'http:', hostname: 'welltest.h2oil.co.uk', search: '' } }],
      ];
      for (const [what, o] of inert) {
        const b = bare(o);
        assert.deepStrictEqual(Object.keys(b.win.WTS_account || {}), ['eligible'], what + ': only the ineligible stub');
        assert.strictEqual(b.win.WTS_account.eligible, false, what);
        assert.strictEqual(b.win.WTS_cloudSync, undefined, what); assert.strictEqual(b.win.WTS_accountPage, undefined, what);
        assert.deepStrictEqual(b.counts, { fetch: 0, timers: 0, doc: 0 }, what + ': nothing at load');
      }
      for (const [what, o] of [['production https', { location: Object.assign({}, PROD_LOC, { search: '?cloud=1' }) }], ['DEV localhost', { dev: true }]]) {
        const b = bare(o);
        // the eligible files probe `typeof document` once each (undefined here, so no DOM can be touched); no request, no timer
        assert.deepStrictEqual([b.counts.fetch, b.counts.timers], [0, 0], what + ': no request or timer at load');
        assert(b.counts.doc <= 4, what + ': only document probes at load');
        const doc0 = b.counts.doc;
        for (const f of FILES) {
          const spec = S.CLIENT_NAMES[f]; const obj = b.win[spec.global];
          assert(obj, what + ': ' + spec.global);
          spec.fns.forEach((n) => assert.strictEqual(typeof obj[n], 'function', what + ': ' + spec.global + '.' + n));
          (spec.props || []).forEach((n) => assert(obj[n] !== undefined, what + ': ' + spec.global + '.' + n));
        }
        const A = b.win.WTS_account;
        assert.strictEqual(A.eligible, true);
        assert.deepStrictEqual(clone(A.PROVIDERS), ['google', 'linkedin']);
        assert(S.CLIENT_STATES.includes(A.state().status) && A.state().status === 'signedOut');
        assert(S.SYNC_STATES.includes(b.win.WTS_cloudSync.status().state) && b.win.WTS_cloudSync.status().state === 'off');
        // WP-C1 and WP-O built the client; automatic sync (Phase 2) is still a stub. With no provider a start is refused
        // before any request; with no document there is no dialog
        await assert.rejects(A.signInWith(), (e) => e.code === 'bad_request' && e instanceof A.Error, 'WTS_account.signInWith()');
        assert.strictEqual(await A.openSignIn(), null, 'no dialog without a document');
        await assert.rejects(b.win.WTS_cloudSync.saveToCloud(), (e) => e.code === 'signed_out', 'saveToCloud needs a session');
        for (const n of ['syncNow']) await assert.rejects(b.win.WTS_cloudSync[n](), (e) => e.code === 'not_implemented', 'WTS_cloudSync.' + n);
        assert.strictEqual(b.win.WTS_accountPage.register(), false, 'the account page is not registered before host H7');
        assert.strictEqual(b.win.WTS_accountPage.entry.navHidden, true);
        assert.deepStrictEqual([b.counts.fetch, b.counts.timers], [0, 0], what + ': stubs make no request');
        assert(b.counts.doc - doc0 <= 4, what + ': no DOM work without a document');
        if (what === 'production https') assert.strictEqual(b.store.wtspref_cloud_beta, '1', '?cloud=1 sets the beta flag');
      }
      const off = bare({ location: Object.assign({}, PROD_LOC, { search: '?x=1&cloud=0' }) });
      assert.strictEqual(off.win.WTS_account.betaEnabled(), false);
      // markers, file order, concat
      for (const f of FILES) {
        const src = fs.readFileSync(path.join(BUILD, f), 'utf8');
        assert(src.startsWith('// ── ACCT:START — web only; sync-from-main.js strips this block ──'), f + ' starts with the ACCT:START marker');
        const end = src.indexOf('// ── ACCT:END ──'); const st = src.indexOf('// === SELF-TEST ===');
        assert(end > 0 && st > end, f + ': ACCT:END sits before the self-test');
        assert.strictEqual((src.match(/ACCT:START/g) || []).length, 1); assert.strictEqual((src.match(/ACCT:END/g) || []).length, 1);
        // provider brand names (naming exception) only inside the ACCT block (WP-O put them in 66 / 68); never in the cloud-sync file
        assert(!/LinkedIn|Google/.test(src.replace(/\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g, '')), f + ': provider brand names only inside the ACCT block');
        if (f === '67-cloud-sync.js') assert(!/LinkedIn|Google/.test(src), f + ': no provider brand names');
        assert(!/setInterval\s*\(/.test(src), f + ': no setInterval');
        assert(((src.slice(0, st).match(/setTimeout\(/g) || []).length) <= (f === '66-account.js' ? 2 : 0), f + ': only the one-shot mount timers');
      }
      const R10 = require(path.join(BUILD, 'concat-round10.js'));
      const names = R10.listFiles();
      assert.deepStrictEqual(names.slice(-3), FILES, 'Round 10 discovers 66–68 after 65');
      const out = R10.build({ log: { log() {}, warn() {} } });
      assert.strictEqual((out.match(/\/\/ ── ACCT:START/g) || []).length, 3); assert.strictEqual((out.match(/\/\/ ── ACCT:END ──/g) || []).length, 3);
      const stripped = out.replace(/\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g, '// (accounts and cloud sync: web only — stripped from the iOS bundle)');
      assert(!/WTS_account|WTS_cloudSync|\/api\/v1|wtsacct_/.test(stripped), 'the planned strip of §9 removes every account identifier');
      assert(!/SELF-TEST/.test(out.split('66-account')[1] || ''), 'self-tests stripped');
      // the REAL iOS sync (§9 layer 1, steps 0c / 0d) on the built page with Round 10 rebuilt in memory
      const REPO = path.join(BUILD, '..');
      const SYNC = path.join(REPO, 'ios-app', 'scripts', 'sync-from-main.js');
      const I10 = require(path.join(BUILD, 'inject-round10.js'));
      const page = I10.inject(fs.readFileSync(path.join(REPO, 'well-testing-app.html'), 'utf8'), out).out;
      assert(page.includes('WTS_account') && page.includes('/api/v1'), 'the scratch page carries the account files');
      const os = require('os'); const cp = require('child_process');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-sync-'));
      const runSync = (html, extraHtml) => {
        const src = path.join(tmp, 'main-' + Math.random().toString(36).slice(2) + '.html');
        fs.writeFileSync(src, html + (extraHtml || ''));
        const dir = fs.mkdtempSync(path.join(tmp, 'www-'));
        const r = cp.spawnSync(process.execPath, [SYNC], { encoding: 'utf8', timeout: 120000,
          env: Object.assign({}, process.env, { WTS_SYNC_MAIN_HTML: src, WTS_SYNC_OUT_DIR: dir, WTS_SYNC_HELP_DIR: path.join(tmp, 'no-help') }) });
        const f = path.join(dir, 'index.html');
        return { status: r.status, log: r.stdout + r.stderr, html: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null };
      };
      try {
        // the HTML form (0d) next to the JS form (0c)
        const withHost = page.replace('</body>', '<!-- ACCT:START --><div id="wts_account_host"></div><!-- ACCT:END -->\n</body>');
        const ok = runSync(withHost);
        assert.strictEqual(ok.status, 0, 'sync passes: ' + ok.log.slice(-400));
        for (const t of ['WTS_account', 'WTS_cloudSync', '/api/v1', 'wtsacct_', 'wts_oa', '/auth/oauth', 'wts_account_host', 'ACCT:START', 'ACCT:END']) {
          assert(!ok.html.includes(t), 'www/index.html has no ' + t);
        }
        assert(ok.html.includes('// (accounts and cloud sync: web only — stripped from the iOS bundle)'), 'step 0c comment');
        assert(ok.html.includes('<!-- account control: web only -->'), 'step 0d comment');
        // unbalanced markers and a leaked identifier make the sync fail without writing index.html
        const bad1 = runSync(page + '\n// ── ACCT:START dangling');
        assert.notStrictEqual(bad1.status, 0, 'unbalanced markers fail'); assert.strictEqual(bad1.html, null); assert(/unbalanced/.test(bad1.log));
        const bad2 = runSync(page.replace('</body>', '<script>var x = "/api/v1/me";</script></body>'));
        assert.notStrictEqual(bad2.status, 0, 'a leaked identifier fails'); assert.strictEqual(bad2.html, null); assert(/\/api\/v1/.test(bad2.log));
        const bad3 = runSync(page.replace('</body>', '<p>LinkedIn</p></body>'));
        assert.notStrictEqual(bad3.status, 0, 'LinkedIn outside the markers fails');
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    },
  },
  {
    name: 'AC5 skeleton call() / providers() / canonical() / sha256Hex() agree with the fake server and the shared vectors', wp: WP, opts: false,
    async run(app, assert) {
      const fake = F.createFakeServer({});
      const b = bare({ location: PROD_LOC, fetch: (u, i) => fake.fetch(F.PROD + u, i) });
      const A = b.win.WTS_account;
      assert.deepStrictEqual(clone(await A.providers()), { google: 'on', linkedin: 'on' });
      fake.setSwitch('OAUTH_LINKEDIN', 'signin');
      assert.deepStrictEqual(clone(await A.providers()), { google: 'on', linkedin: 'signin' });
      const h = await A.call('GET', '/health');
      assert.strictEqual(h.status, 200); assert(S.checkResponse('health', 200, h.json).ok);
      await assert.rejects(A.call('GET', '/me'), (e) => e.code === 'signed_out' && e.status === 401);
      await assert.rejects(A.call('POST', '/auth/code/start', { email: 'nope', purpose: 'signin' }), (e) => e.code === 'bad_request' && e.body.field === 'email');
      assert.strictEqual((await A.call('POST', '/auth/code/start', { email: 'name@company.example', purpose: 'signin' })).status, 202);
      fake.fault({ path: '/me', mode: 'rate' });
      await assert.rejects(A.call('GET', '/me'), (e) => e.code === 'rate' && e.retryAfter === 30);
      fake.fault({ path: '/me', mode: 'server' });
      await assert.rejects(A.call('GET', '/me'), (e) => e.code === 'server' && e.status === 500);
      fake.fault({ path: '/auth/providers', mode: 'network' });
      assert.deepStrictEqual(clone(await A.providers()), { google: 'on', linkedin: 'on' }, 'network error: the buttons show, start decides');
      fake.fault({ path: '/me', mode: 'network' });
      await assert.rejects(A.call('GET', '/me'), (e) => e.code === 'network' && e.status === 0);
      const sent = fake.requests.filter((r) => r.path === '/api/v1/auth/code/start');
      assert.strictEqual(sent.length, 2);
      const CS = b.win.WTS_cloudSync;
      for (const v of S.CANON_VECTORS) {
        assert.strictEqual(CS.canonical(v.value), v.canonical);
        assert.strictEqual(await CS.sha256Hex(v.canonical), v.sha256);
      }
      assert.throws(() => CS.canonical({ x: NaN }), /non-finite/);
      // a 2xx that is not JSON (the static host's page fallback while no server is configured) → code 'server'
      const html = () => Promise.resolve({ status: 200, ok: true, headers: { get: (n) => (/content-type/i.test(n) ? 'text/html; charset=utf-8' : null) },
        json: () => Promise.reject(new SyntaxError('Unexpected token <')), text: () => Promise.resolve('<!doctype html>') });
      const h2 = bare({ location: PROD_LOC, fetch: html });
      await assert.rejects(h2.win.WTS_account.call('GET', '/me'), (e) => e.code === 'server' && e.status === 200 && e instanceof h2.win.WTS_account.Error);
      assert.deepStrictEqual(clone(await h2.win.WTS_account.providers()), { google: 'off', linkedin: 'off' }, 'no API answering → providers off');
      const badJson = () => Promise.resolve({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: () => Promise.reject(new SyntaxError('bad')) });
      const h3 = bare({ location: PROD_LOC, fetch: badJson });
      await assert.rejects(h3.win.WTS_account.call('GET', '/me'), (e) => e.code === 'server');
      // the crypto seam of WTS_account.configure({crypto}) is used by sha256Hex
      let digests = 0;
      b.win.WTS_account.configure({ crypto: { subtle: { digest: (alg, bytes) => { digests++; return crypto.webcrypto.subtle.digest(alg, bytes); } } } });
      assert.strictEqual(await CS.sha256Hex(S.CANON_VECTORS[0].canonical), S.CANON_VECTORS[0].sha256);
      assert.strictEqual(digests, 1, 'sha256Hex goes through the configured crypto seam');
      b.win.WTS_account.configure({ crypto: null });
    },
  },
  {
    name: 'AC6 app from sources on the harness (http://localhost): accounts inert, no errors, no timers', wp: WP,
    opts: { timers: 'manual', console: 'capture' },
    run(app, assert) {
      const w = app.win;
      assert.deepStrictEqual(Object.keys(w.WTS_account), ['eligible']);
      assert.strictEqual(w.WTS_cloudSync, undefined); assert.strictEqual(w.WTS_accountPage, undefined);
      assert(!(w.WTS_calcRegistry && w.WTS_calcRegistry.account));
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0);
      assert.deepStrictEqual(app.errors.map((e) => e.message), []);
    },
  },
  {
    name: 'AC7 app on the production https location with the fake fetch: eligible, zero requests and timers, no page registered', wp: WP,
    opts: false,
    async run(app, assert, ctx) {
      const fake = F.createFakeServer({});
      const a = ctx.loadApp({ timers: 'manual', console: 'capture', globals: { fetch: (u, i) => fake.fetch(String(u).startsWith('/') ? F.PROD + u : u, i), location: F.prodLocation() } });
      try {
        const w = a.win;
        assert.strictEqual(w.WTS_account.eligible, true);
        Object.keys(S.CLIENT_NAMES).forEach((f) => assert(w[S.CLIENT_NAMES[f].global], S.CLIENT_NAMES[f].global));
        a.flush(5000);
        assert.strictEqual(a.pendingTimers(), 0, 'no timer after 5 s idle');
        assert.strictEqual(fake.requests.length, 0, 'a signed-out first visit makes no request');
        assert(!(w.WTS_calcRegistry && w.WTS_calcRegistry.account), 'no account page in the registry');
        assert(!a.el('wts_account_host') || !a.el('wts_account_host').firstChild, 'no chip mounted');
        const p = w.WTS_account.providers();
        a.flush(10);
        assert.deepStrictEqual(clone(await p), { google: 'on', linkedin: 'on' });
        assert.strictEqual(fake.requests.length, 1);
        assert.deepStrictEqual(a.errors.map((e) => e.message), []);
      } finally { if (a.dispose) a.dispose(); }
    },
  },
  {
    name: 'AC8 session cookie lifetime: Max-Age = seconds to abs_expires_at (trusted 180 d, public 7 d), survives a browser restart', wp: WP, opts: false,
    async run(app, assert) {
      const H = require(path.join(S.SERVER_DIR, 'core', 'http'));
      assert.throws(() => H.serializeCookie(S.COOKIES.session, 'abc'), /maxAge/, 'the session cookie cannot be set without a lifetime');
      assert.match(H.serializeCookie(S.COOKIES.session, 'abc', { maxAge: 3600 }), /; Max-Age=3600$/);
      assert.match(H.serializeCookie(S.COOKIES.session, null), /Max-Age=0/, 'clearing needs no lifetime');
      assert.match(H.serializeCookie(S.COOKIES.attemptLax, 'x'), /Max-Age=600/, 'definition lifetimes still apply');
      assert.throws(() => H.serializeCookie(S.COOKIES.session, 'abc', { maxAge: 0 }), /positive/);
      const DAY = 86400;
      for (const [what, pub, days] of [['trusted', false, 180], ['public', true, 7]]) {
        const fake = F.createFakeServer({});
        const br = fake.browser(what);
        const r = await F.signIn(fake, br, what + '@company.example', { publicDevice: pub });
        assert.strictEqual(r.status, 200, what + ' sign-in');
        const c = br.cookie(S.COOKIES.session.name);
        assert(c && c.persistent, what + ': the session cookie is persistent');
        assert.strictEqual(Number(c.attrs['max-age']), days * DAY, what + ': Max-Age = ' + days + ' days');
        br.restart();
        assert(br.cookie(S.COOKIES.session.name), what + ': the session survives a browser restart');
        const me = await br.fetch(B + '/me');
        assert.strictEqual(me.status, 200, what + ': still signed in after the restart');
      }
      // the fake browser drops a cookie without Max-Age on restart
      const fake = F.createFakeServer({});
      const br = fake.browser('x');
      await br.fetch(B + '/health');
      br.jar.set('tmp', { value: '1', sameSite: 'Strict', expires: null, persistent: false, attrs: {} });
      br.restart();
      assert.strictEqual(br.cookie('tmp'), null, 'a browser-session cookie is gone after a restart');
    },
  },
];
