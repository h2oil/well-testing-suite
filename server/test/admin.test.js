'use strict';
// server/test/admin.test.js — the admin dashboard (functions/admin.js, db/migrations/060-admin.sql) and the platform's
// country / city capture (core/http.js clientGeo, core/session.js issue): the admin gate (everyone else gets 404), the summary
// numbers (byCountry with an unknown country), keyset pagination and the address search, idempotent invites, audit rows, the
// geolocation header validation (bad values → null; separate mode ignores the headers) and the capture at sign-up and
// sign-in for the e-mail code and the provider paths. The database parts skip without the throwaway cluster.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const D = require('./_db');
const S = require('./_shapes');
const C = require('../core/contract');
const H = require('../core/http');
const { loadConfig, allowSameSiteInTests } = require('../core/config');
const { harness } = require('./_api');
const { auditVerify } = require('../core/jobs');

const skip = !D.available() && 'no throwaway database (run through server/test/run.js)';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o), 'utf8').toString('base64');
const geoHdr = (country, city, extra) => Object.assign({ 'x-nf-geo': b64({ city, country: { code: country, name: 'x' }, subdivision: { code: 'DU', name: 'x' }, timezone: 'Asia/Dubai' }), 'x-country': country }, extra || {});
const req = (headers) => ({ method: 'GET', url: '/api/v1/me', headers, body: null, remoteAddress: '203.0.113.1' });
const k32 = () => crypto.randomBytes(32).toString('base64');

test.describe('platform geolocation headers (no database)', () => {
  const on = loadConfig({ WTS_ENV: 'test', WTS_GEO_HEADERS: '1' });

  test('valid headers: country from x-nf-geo (then x-country), city only with the record that gave the country', () => {
    assert.deepStrictEqual(H.clientGeo(req(geoHdr('AE', 'Dubai')), on), { country: 'AE', city: 'Dubai' });
    assert.deepStrictEqual(H.clientGeo(req(geoHdr('GB', "Stoke-on-Trent St. Mary's")), on), { country: 'GB', city: "Stoke-on-Trent St. Mary's" });
    assert.deepStrictEqual(H.clientGeo(req(geoHdr('BR', 'São Paulo')), on), { country: 'BR', city: 'São Paulo' });
    assert.deepStrictEqual(H.clientGeo(req({ 'x-country': 'NO' }), on), { country: 'NO', city: null }, 'x-country alone: no city');
    assert.deepStrictEqual(H.clientGeo(req({ 'x-nf-geo': b64({ city: 'Oslo', country: { code: 'nope' } }), 'x-country': 'NO' }), on),
      { country: 'NO', city: null }, 'a bad x-nf-geo country falls back to x-country, and its city is not used');
    assert.deepStrictEqual(H.clientGeo(req({ 'x-nf-geo': b64({ city: 'Dubai', country: { code: 'AE' } }).replace(/=+$/, '') }), on).country, 'AE', 'unpadded base64');
  });

  test('bad values → null', () => {
    const none = { country: null, city: null };
    for (const c of ['ae', 'AEX', 'A1', '', ' AE', 'ÄE', 'AE,GB']) assert.deepStrictEqual(H.clientGeo(req({ 'x-country': c }), on), none, 'country ' + JSON.stringify(c));
    for (const city of ['Dubai 1', '<script>', 'x'.repeat(81), 'Dubai\u0000', 'Dubai😀', '-Dubai', '', '   ', 42, null, { a: 1 }, ['Dubai']]) {
      assert.deepStrictEqual(H.clientGeo(req(geoHdr('AE', city)), on), { country: 'AE', city: null }, 'city ' + JSON.stringify(city));
    }
    assert.strictEqual(H.clientGeo(req(geoHdr('AE', 'x'.repeat(80))), on).city.length, 80, '80 characters are fine');
    assert.deepStrictEqual(H.clientGeo(req({ 'x-nf-geo': 'not base64 !!' }), on), none);
    assert.deepStrictEqual(H.clientGeo(req({ 'x-nf-geo': b64('[1,2]') }), on), none, 'a JSON array');
    assert.deepStrictEqual(H.clientGeo(req({ 'x-nf-geo': b64('{"country":') }), on), none, 'broken JSON');
    assert.deepStrictEqual(H.clientGeo(req({ 'x-nf-geo': b64({ country: 'AE', city: 'Dubai' }) }), on), none, 'country must be an object with a code');
    assert.deepStrictEqual(H.clientGeo(req({ 'x-nf-geo': 'A'.repeat(5000) }), on), none, 'oversized');
    assert.deepStrictEqual(H.clientGeo(req({}), on), none);
  });

  test('separate mode ignores the headers; the test flag only with WTS_ENV=test; same-site mode always reads them', () => {
    const sep = loadConfig({ WTS_ENV: 'test' });
    assert.strictEqual(sep.geoHeaders, false);
    assert.deepStrictEqual(H.clientGeo(req(geoHdr('AE', 'Dubai')), sep), { country: null, city: null });
    const prod = loadConfig({ WTS_ENV: 'production', WTS_GEO_HEADERS: '1' });
    assert.strictEqual(prod.geoHeaders, false);
    assert.ok(prod.warnings.some((w) => /^WTS_GEO_HEADERS: accepted only with WTS_ENV=test/.test(w)));
    assert.deepStrictEqual(H.clientGeo(req(geoHdr('AE', 'Dubai')), prod), { country: null, city: null });
    allowSameSiteInTests();
    try {
      const same = loadConfig({ WTS_ENV: 'test', WTS_SITE_MODE: 'same' });
      assert.strictEqual(same.geoHeaders, true);
      assert.deepStrictEqual(H.clientGeo(req(geoHdr('AE', 'Dubai')), same), { country: 'AE', city: 'Dubai' });
      const sameProd = loadConfig({ WTS_ENV: 'production', WTS_SITE_MODE: 'same' });
      assert.strictEqual(sameProd.geoHeaders, true);
    } finally { allowSameSiteInTests(false); }
  });

  test('admin addresses: WTS_ADMIN_EMAILS (normalised), else the bootstrap list; invalid entries warn; never a secret', () => {
    const a = loadConfig({ WTS_ENV: 'test', WTS_ADMIN_EMAILS: ' Boss@Company.Example , not-an-address' });
    assert.deepStrictEqual(Array.from(a.adminEmails), ['boss@company.example']);
    assert.ok(a.warnings.some((w) => /^WTS_ADMIN_EMAILS: an entry is not an address/.test(w)));
    const b = loadConfig({ WTS_ENV: 'test', ACCOUNTS_SIGNUP: 'invite', WTS_INVITE_BOOTSTRAP: 'Owner@Company.example' });
    assert.deepStrictEqual(Array.from(b.adminEmails), ['owner@company.example'], 'defaults to the bootstrap addresses');
    const c = loadConfig({ WTS_ENV: 'test', ACCOUNTS_SIGNUP: 'invite', WTS_INVITE_BOOTSTRAP: 'owner@company.example', WTS_ADMIN_EMAILS: 'boss@company.example' });
    assert.deepStrictEqual(Array.from(c.adminEmails), ['boss@company.example'], 'an explicit list replaces the default');
    assert.strictEqual(loadConfig({ WTS_ENV: 'test' }).adminEmails.size, 0);
    assert.strictEqual(a.redacted().adminEmails, 1, 'redacted: only the count');
    assert.ok(require('../core/config').CONFIG_ENV.includes('WTS_ADMIN_EMAILS') && !require('../core/config').SECRET_ENV.includes('WTS_ADMIN_EMAILS'));
  });

  test('the cursor is opaque and strictly checked', () => {
    const { parseCursor, makeCursor } = require('../functions/admin')._internal;
    const row = { created_us: '2026-11-09T10:00:00.123456Z', id: '6f1c2a3b-0000-4000-8000-000000000001' };
    assert.deepStrictEqual(parseCursor({ cursor: makeCursor(row) }), { at: row.created_us, id: row.id });
    for (const bad of ['x', 'AAAA', Buffer.from('2026-11-09|nope').toString('base64url'), '../../etc']) {
      assert.throws(() => parseCursor({ cursor: bad }), (e) => e.code === 'bad_request' && e.extra.field === 'cursor', bad);
    }
    assert.strictEqual(parseCursor({}), null);
  });
});

test.describe('admin dashboard and country capture (database)', { skip }, () => {
  let T = null;
  const ADMIN = 'boss@company.example';
  test.before(async () => { T = await harness('admin', { env: { WTS_ADMIN_EMAILS: 'Boss@Company.example', WTS_GEO_HEADERS: '1' } }); });
  test.after(async () => { if (T) await T.close(); });

  // a code sign-in (or sign-up) whose requests carry the given headers
  async function signInWith(br, email, headers) {
    const s = await br.call('POST', '/auth/code/start', { email, purpose: 'signin' }, { headers });
    assert.strictEqual(s.status, 202);
    const code = T.codeFor(email, 'code_signin');
    const r = await br.call('POST', '/auth/code/verify', { email, code, publicDevice: false, consent: { terms: '1', privacy: '1' } }, { headers });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    br.device = r.json.device.id;
    return r.json;
  }
  const geoOf = async (email) => (await T.db.sql`select signup_country, last_country, last_city from wts.users where email_bidx = ${T.keys.emailBidx(email)}`)[0];
  const rowsAudit = async (email, action) => T.db.sql`select actor, action, detail from wts.audit where user_id = (select id from wts.users where email_bidx = ${T.keys.emailBidx(email)}) and action = ${action} order by id`;

  let admin; let u1; let u2; let u3;
  test('code path: signup_country at sign-up, last_country / last_city at each sign-in; unknown keeps the last; bad → null', async () => {
    admin = T.browser();
    await signInWith(admin, ADMIN, geoHdr('AE', 'Dubai'));
    assert.deepStrictEqual(await geoOf(ADMIN), { signup_country: 'AE', last_country: 'AE', last_city: 'Dubai' });
    u1 = T.browser();
    await signInWith(u1, 'gb.user@company.example', {});
    assert.deepStrictEqual(await geoOf('gb.user@company.example'), { signup_country: null, last_country: null, last_city: null }, 'no headers: unknown');
    await signInWith(T.browser(), 'gb.user@company.example', geoHdr('GB', 'London'));
    assert.deepStrictEqual(await geoOf('gb.user@company.example'), { signup_country: null, last_country: 'GB', last_city: 'London' }, 'a later sign-in never sets the sign-up country');
    await signInWith(T.browser(), 'gb.user@company.example', {});
    assert.deepStrictEqual(await geoOf('gb.user@company.example'), { signup_country: null, last_country: 'GB', last_city: 'London' }, 'an unknown location keeps the last one');
    await signInWith(T.browser(), 'gb.user@company.example', { 'x-country': 'FR' });
    assert.deepStrictEqual(await geoOf('gb.user@company.example'), { signup_country: null, last_country: 'FR', last_city: null }, 'a new country without a city clears the city');
    await signInWith(T.browser(), 'gb.user@company.example', geoHdr('GB', 'London'));
    u2 = T.browser();
    await signInWith(u2, 'odd.user@company.example', { 'x-country': 'zz', 'x-nf-geo': b64({ city: '<b>x</b>', country: { code: 'Z9' } }) });
    assert.deepStrictEqual(await geoOf('odd.user@company.example'), { signup_country: null, last_country: null, last_city: null });
    // no address of any kind is stored for this: the three columns only
    const cols = (await T.db.sql`select column_name from information_schema.columns where table_schema = 'wts' and table_name = 'users' and (column_name like '%country%' or column_name like '%city%' or column_name like '%ip%')`).map((r) => r.column_name).sort();
    assert.deepStrictEqual(cols, ['last_city', 'last_country', 'signup_country']);
  });

  test('non-admins and signed-out callers get 404 not_found on every admin route; /me says admin false', async () => {
    const out = T.browser();
    for (const [m, p, b] of [['GET', '/admin/summary'], ['GET', '/admin/users'], ['GET', '/admin/invites'], ['POST', '/admin/invites', { email: 'x@company.example' }]]) {
      for (const br of [out, u1]) {
        const r = await br.call(m, p, b);
        assert.strictEqual(r.status, 404, m + ' ' + p); assert.strictEqual(r.json.error, 'not_found');
        const unknown = await br.call(m, '/admin/nothing-here', b);
        assert.strictEqual(unknown.status, 404); assert.deepStrictEqual(Object.keys(r.json).sort(), Object.keys(unknown.json).sort(), 'same envelope as an unknown route');
      }
    }
    const me = await u1.call('GET', '/me');
    assert.strictEqual(me.status, 200); assert.strictEqual(me.json.admin, false);
    assert.ok(S.checkResponse('me', 200, me.json).ok);
    const denied = await rowsAudit('gb.user@company.example', 'admin.denied');
    assert.strictEqual(denied.length, 4); assert.ok(denied.every((a) => a.actor === 'user'));
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.signup_allowlist`)[0].n, 0, 'a non-admin cannot invite');
    // the database refuses a non-admin too, whatever list it is handed
    const uid = await T.userId('gb.user@company.example');
    await assert.rejects(T.api.asUser(uid, (tx) => tx`select wts.admin_summary(${tx.array([T.keys.emailBidx(ADMIN)], 17)})`), /not an administrator/);
    await assert.rejects(T.api.sql`select wts.admin_summary(${T.api.sql.array([T.keys.emailBidx(ADMIN)], 17)})`, /not an administrator/, 'no app.user_id');
    await assert.rejects(T.api.sql`select wts._admin_check(${T.api.sql.array([T.keys.emailBidx(ADMIN)], 17)})`, /permission denied/);
  });

  test('admin: /me admin true; summary totals, byCountry (with unknown), byMethod, signupsByDay; audited', async () => {
    const me = await admin.call('GET', '/me');
    assert.strictEqual(me.json.admin, true);
    const pid = (await admin.call('POST', '/projects', { name: 'P', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    assert.ok(pid);
    await T.age`update wts.users set used_bytes = 1000 where email_bidx = ${T.keys.emailBidx(ADMIN)}`;
    await T.age`update wts.users set used_bytes = 234 where email_bidx = ${T.keys.emailBidx('gb.user@company.example')}`;
    u3 = T.browser();
    await signInWith(u3, 'idle.user@company.example', geoHdr('AE', 'Abu Dhabi'));
    await T.age`update wts.users set last_sign_in_at = now() - interval '10 days' where email_bidx = ${T.keys.emailBidx('idle.user@company.example')}`;
    await T.age`update wts.sessions set last_seen_at = now() - interval '10 days' where user_id = (select id from wts.users where email_bidx = ${T.keys.emailBidx('idle.user@company.example')})`;
    await T.age`update wts.users set last_sign_in_at = now() - interval '40 days' where email_bidx = ${T.keys.emailBidx('odd.user@company.example')}`;
    await T.age`update wts.sessions set last_seen_at = now() - interval '40 days' where user_id = (select id from wts.users where email_bidx = ${T.keys.emailBidx('odd.user@company.example')})`;
    await T.age`update wts.users set signup_method = 'google' where email_bidx = ${T.keys.emailBidx('odd.user@company.example')}`;
    assert.strictEqual((await admin.call('POST', '/admin/invites', { email: 'Invited@Company.example', note: 'crew' })).status, 201);
    const r = await admin.call('GET', '/admin/summary');
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(S.checkResponse('adminSummary', 200, r.json).ok, JSON.stringify(S.checkResponse('adminSummary', 200, r.json).errors));
    assert.deepStrictEqual(r.json.totals, { users: 4, active7d: 2, active30d: 3, projects: 1, storageBytes: 1234, invitesPending: 1 });
    assert.deepStrictEqual(r.json.byCountry, [{ country: 'AE', users: 2, active30d: 2 }, { country: 'GB', users: 1, active30d: 1 }, { country: null, users: 1, active30d: 0 }]);
    assert.deepStrictEqual(r.json.byMethod, [{ method: 'code', users: 3 }, { method: 'google', users: 1 }]);
    const today = new Date().toISOString().slice(0, 10);
    assert.deepStrictEqual(r.json.signupsByDay, [{ day: today, n: 4 }]);
    // an old sign-up leaves the 90-day window; the invited address, once signed up, is no longer pending
    await T.age`update wts.users set created_at = now() - interval '120 days' where email_bidx = ${T.keys.emailBidx('odd.user@company.example')}`;
    await signInWith(T.browser(), 'invited@company.example', {});
    const r2 = (await admin.call('GET', '/admin/summary')).json;
    assert.deepStrictEqual(r2.signupsByDay, [{ day: today, n: 4 }]);
    assert.strictEqual(r2.totals.invitesPending, 0); assert.strictEqual(r2.totals.users, 5);
    const a = await rowsAudit(ADMIN, 'admin.summary');
    assert.strictEqual(a.length, 2); assert.ok(a.every((x) => x.actor === 'admin'));
  });

  test('admin users: newest first, keyset pages without gaps or repeats (ties on created_at), search, bad parameters', async () => {
    const all = (await admin.call('GET', '/admin/users?limit=200')).json;
    assert.ok(S.checkResponse('adminUsers', 200, all).ok, JSON.stringify(S.checkResponse('adminUsers', 200, all).errors));
    assert.strictEqual(all.users.length, 5); assert.strictEqual(all.next, null);
    const times = all.users.map((u) => Date.parse(u.createdAt));
    assert.deepStrictEqual(times, times.slice().sort((x, y) => y - x), 'newest first');
    const bossRow = all.users.find((u) => u.email === ADMIN);
    assert.deepStrictEqual([bossRow.method, bossRow.status, bossRow.signupCountry, bossRow.lastCountry, bossRow.lastCity, bossRow.projects, bossRow.usedBytes],
      ['code', 'active', 'AE', 'AE', 'Dubai', 1, 1000]);
    assert.ok(bossRow.lastSignInAt);
    const odd = all.users.find((u) => u.email === 'odd.user@company.example');
    assert.deepStrictEqual([odd.method, odd.signupCountry, odd.lastCountry, odd.lastCity], ['google', null, null, null]);
    // ties: every account at the same microsecond — pages follow (created_at, id)
    await T.age`update wts.users set created_at = '2026-11-01T00:00:00.123456Z'`;
    const seen = []; let cursor = null; let pages = 0;
    do {
      const r = await admin.call('GET', '/admin/users?limit=2' + (cursor ? '&cursor=' + cursor : ''));
      assert.strictEqual(r.status, 200);
      seen.push(...r.json.users.map((u) => u.id)); cursor = r.json.next; pages++;
    } while (cursor && pages < 10);
    assert.strictEqual(pages, 3); assert.strictEqual(seen.length, 5); assert.strictEqual(new Set(seen).size, 5);
    assert.deepStrictEqual(seen, seen.slice().sort().reverse(), 'id descending within one timestamp');
    // distinct microseconds that one millisecond would merge
    await T.age`update wts.users set created_at = '2026-11-01T00:00:00.123000Z'::timestamptz + (row_number_hack.n || ' microseconds')::interval
      from (select id, row_number() over (order by id) as n from wts.users) row_number_hack where row_number_hack.id = wts.users.id`;
    const ids = []; cursor = null; pages = 0;
    do {
      const r = await admin.call('GET', '/admin/users?limit=1' + (cursor ? '&cursor=' + cursor : ''));
      ids.push(...r.json.users.map((u) => u.id)); cursor = r.json.next; pages++;
    } while (cursor && pages < 10);
    assert.strictEqual(new Set(ids).size, 5, 'microsecond keyset: no repeats or gaps');
    // search on the opened addresses (case-insensitive), paged too
    const q = (await admin.call('GET', '/admin/users?q=USER@COMPANY')).json;
    assert.deepStrictEqual(q.users.map((u) => u.email).sort(), ['gb.user@company.example', 'idle.user@company.example', 'odd.user@company.example']);
    const q1 = (await admin.call('GET', '/admin/users?limit=2&q=user@')).json;
    assert.strictEqual(q1.users.length, 2); assert.ok(q1.next);
    const q2 = (await admin.call('GET', '/admin/users?limit=2&q=user@&cursor=' + q1.next)).json;
    assert.strictEqual(q2.users.length, 1); assert.strictEqual(q2.next, null);
    assert.strictEqual(new Set(q1.users.concat(q2.users).map((u) => u.id)).size, 3);
    assert.deepStrictEqual((await admin.call('GET', '/admin/users?q=nobody-here')).json, { users: [], next: null });
    for (const bad of ['limit=0', 'limit=201', 'limit=abc', 'cursor=zzz', 'q=' + 'a'.repeat(255)]) {
      const r = await admin.call('GET', '/admin/users?' + bad);
      assert.strictEqual(r.status, 400, bad); assert.strictEqual(r.json.error, 'bad_request');
    }
    const au = await rowsAudit(ADMIN, 'admin.users');
    assert.ok(au.length >= 10 && au.every((x) => x.actor === 'admin'));
    assert.ok(au.every((x) => !JSON.stringify(x.detail).includes('user@')), 'the search text is never audited');
  });

  test('invites: add is idempotent (201 each time), list carries no address, a bad address is refused; audited', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await admin.call('POST', '/admin/invites', { email: 'New.Crew@Company.example', note: 'rig crew' });
      assert.strictEqual(r.status, 201); assert.deepStrictEqual(r.json, { ok: true });
    }
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.signup_allowlist where email_bidx = ${T.keys.emailBidx('new.crew@company.example')}`)[0].n, 1);
    assert.strictEqual((await admin.call('POST', '/admin/invites', { email: 'not an address' })).status, 400);
    assert.strictEqual((await admin.call('POST', '/admin/invites', { email: 'a@company.example', note: 'x'.repeat(201) })).status, 400);
    assert.strictEqual((await admin.call('POST', '/admin/invites', { email: 'a@company.example', extra: 1 })).status, 400);
    assert.strictEqual((await admin.call('POST', '/admin/invites', { email: 'a@company.example' }, { headers: { origin: 'https://evil.example' } })).status, 403, 'write rules');
    const l = await admin.call('GET', '/admin/invites');
    assert.ok(S.checkResponse('adminInvites', 200, l.json).ok);
    assert.strictEqual(l.json.invites.length, 2);
    assert.deepStrictEqual(l.json.invites.map((x) => x.note).sort(), ['crew', 'rig crew']);
    assert.ok(!JSON.stringify(l.json).includes('@'), 'no address comes back');
    // an invited address may now sign up with ACCOUNTS_SIGNUP=invite
    T.setEnv({ ACCOUNTS_SIGNUP: 'invite' });
    await signInWith(T.browser(), 'new.crew@company.example', {});
    T.setEnv({ ACCOUNTS_SIGNUP: 'open' });
    const inv = await rowsAudit(ADMIN, 'admin.invite');
    assert.ok(inv.length >= 4 && inv.every((x) => x.actor === 'admin'));
    assert.deepStrictEqual(inv.filter((x) => x.detail.op === 'add').map((x) => x.detail.added), [true, true, false]);
    assert.ok(!inv.some((x) => JSON.stringify(x.detail).includes('@')), 'no address in the audit');
    // the hash chain still verifies with the admin rows in it
    const v = await auditVerify(T.db.sql);
    assert.deepStrictEqual(v.bad, []);
  });

  test('rate limit per admin; the admin gate also needs an active account', async () => {
    const uid = await T.userId(ADMIN);
    await T.age`insert into wts.rate_counters (bucket, window_start, n)
      values ('adminReadUserHour:' || ${uid}::text, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 600)
      on conflict (bucket, window_start) do update set n = 600`;
    const rr = await admin.call('GET', '/admin/summary');
    assert.strictEqual(rr.status, 429); assert.strictEqual(rr.json.error, 'rate'); assert.ok(rr.json.retryAfter >= 1);
    await T.age`delete from wts.rate_counters where bucket like 'adminReadUserHour:%'`;
    await T.age`update wts.users set status = 'locked' where id = ${uid}`;
    assert.strictEqual((await admin.call('GET', '/admin/summary')).status, 404, 'locked: like everyone else');
    await T.age`update wts.users set status = 'active' where id = ${uid}`;
    assert.strictEqual((await admin.call('GET', '/admin/summary')).status, 200);
  });
});

test.describe('provider path: country capture at sign-up and sign-in (database)', { skip }, () => {
  const { createApp } = require('../core/app');
  const { memoryTransport } = require('../core/mail');
  const { createFakeOidc } = require('./fake-oidc');
  const { createOauthHandlers } = require('../functions/oauth');
  const baseHandlers = require('../functions').handlers;
  let DB = null;

  test.before(async () => { DB = await D.freshDatabase('admin_oauth'); });
  test.after(async () => { if (DB) await DB.close(); });

  test('Google sign-up records signup_country and last_*; a later sign-in updates last_* only', async () => {
    const g = createFakeOidc({ provider: 'google' });
    const l = createFakeOidc({ provider: 'linkedin', enforcePkce: true });
    const config = loadConfig({ WTS_ENV: 'test', ACCOUNTS_SIGNUP: 'open', OAUTH_GOOGLE: 'on', OAUTH_GOOGLE_CLIENT_ID: g.clientId, OAUTH_GOOGLE_CLIENT_SECRET: g.clientSecret,
      OAUTH_LINKEDIN: 'off', WTS_TERMS_VERSION: '1', WTS_PRIVACY_VERSION: '1', WTS_GEO_HEADERS: '1',
      WTS_INDEX_PEPPER: k32(), WTS_MASTER_KEYS: '1:' + k32(), WTS_MASTER_KID: '1', WTS_CODE_PEPPERS: '1:' + k32() });
    const fetch = (url, init) => (String(url).startsWith('https://google.') ? g : l).fetch(url, init);
    const oauth = createOauthHandlers({ fetch, override: { google: g.override, linkedin: l.override }, delay: async () => {} });
    const app = createApp({ config, db: DB.as('wts_api'), mail: memoryTransport(), log: { info() {}, warn() {} }, handlers: Object.assign({}, baseHandlers, oauth) });
    const CONSUMER = require('../core/oidc-providers').CONFIG.google.consumerDomains[0];
    const email = 'traveller@' + CONSUMER;
    function browser() {
      const jar = new Map();
      const apply = (sc) => (sc || []).forEach((line) => {
        const [nv, ...attrs] = line.split(';').map((s) => s.trim()); const i = nv.indexOf('=');
        const lax = attrs.some((a) => /^samesite=lax$/i.test(a));
        if (/max-age=0/i.test(line)) jar.delete(nv.slice(0, i)); else jar.set(nv.slice(0, i), { v: nv.slice(i + 1), lax });
      });
      const ck = (laxOnly) => Array.from(jar.entries()).filter(([, c]) => !laxOnly || c.lax).map(([k, c]) => k + '=' + c.v).join('; ');
      return {
        async call(method, path, body, headers) {
          const h = Object.assign({ host: 'welltest.h2oil.co.uk', cookie: ck(false) }, headers || {});
          if (method !== 'GET') Object.assign(h, { origin: 'https://welltest.h2oil.co.uk', 'x-wts-req': '1', 'content-type': 'application/json' });
          const r = await app.handle({ method, url: C.BASE + path, headers: h, body: method === 'GET' ? null : Buffer.from(JSON.stringify(body || {})), remoteAddress: '198.51.100.7' });
          await app.idle(); apply(r.cookies);
          return { status: r.status, json: r.body ? JSON.parse(r.body) : null };
        },
        async visit(url, as) {
          const back = new URL(g.authorize(url, { user: as }));
          const r = await app.handle({ method: 'GET', url: back.pathname + back.search, headers: { host: 'welltest.h2oil.co.uk', cookie: ck(true) }, body: null, remoteAddress: '198.51.100.7' });
          apply(r.cookies); return r.status;
        },
      };
    }
    async function round(headers, first) {
      const br = browser();
      const s = await br.call('POST', '/auth/oauth/google/start', { purpose: 'signin', publicDevice: false }, headers);
      assert.strictEqual(s.status, 200, JSON.stringify(s.json));
      assert.strictEqual(await br.visit(s.json.url, { key: 'trav-1', email }), 303);
      let f = await br.call('POST', '/auth/oauth/finish', {}, headers);
      if (first) { assert.strictEqual(f.json.next, 'consent', JSON.stringify(f.json)); f = await br.call('POST', '/auth/oauth/finish', { consent: { terms: '1', privacy: '1' } }, headers); }
      assert.strictEqual(f.json.next, 'done', JSON.stringify(f.json));
      return br;
    }
    const geo = async () => (await DB.admin.sql`select signup_method, signup_country, last_country, last_city from wts.users`)[0];
    await round(geoHdr('IN', 'Mumbai'), true);
    assert.deepStrictEqual(await geo(), { signup_method: 'google', signup_country: 'IN', last_country: 'IN', last_city: 'Mumbai' });
    await round(geoHdr('SG', 'Singapore'), false);
    assert.deepStrictEqual(await geo(), { signup_method: 'google', signup_country: 'IN', last_country: 'SG', last_city: 'Singapore' });
    await round({ 'x-country': 'bad' }, false);
    assert.deepStrictEqual(await geo(), { signup_method: 'google', signup_country: 'IN', last_country: 'SG', last_city: 'Singapore' }, 'bad headers change nothing');
  });
});
