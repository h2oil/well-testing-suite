'use strict';
// server/test/insight.test.js — the optional profile and the project summary (insight follow-up of the admin dashboard;
// db/migrations/070-insight.sql, core/insight.js): request validation, storage encrypted at rest, the profile at sign-up on
// the e-mail code and the provider paths, PUT /account/profile, GET /me, commits with and without a summary, the account
// export, and the admin rows (profile + work), the user detail route, the summary's byCompany / topClients / topFields, the
// 404 for non-admins and the audit rows. The database parts skip without the throwaway cluster.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const zlib = require('zlib');
const D = require('./_db');
const C = require('../core/contract');
const I = require('../core/insight');
const { canonical } = require('../core/canon');
const { loadConfig } = require('../core/config');
const { harness } = require('./_api');
const { auditVerify } = require('../core/jobs');

const skip = !D.available() && 'no throwaway database (run through server/test/run.js)';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const k32 = () => crypto.randomBytes(32).toString('base64');
const shapeOk = (name, v) => { const r = C.checkShape(name, v); assert.ok(r.ok, name + ': ' + JSON.stringify(r.errors)); };
const bad = (name, v, re) => { const r = C.checkShape(name, v); assert.ok(!r.ok, name + ' should refuse ' + JSON.stringify(v).slice(0, 80)); if (re) assert.match(r.errors.join(' | '), re); };

test.describe('profile and summary rules (no database)', () => {
  test('ProfileReq: optional keys, text or null, limits after NFKC + trim, ISO country, phone characters, unknown keys refused', () => {
    shapeOk('ProfileReq', {});
    shapeOk('ProfileReq', { fullName: 'Ana Example', company: 'Operator Energy Ltd', jobTitle: 'Well test engineer', country: 'AE', phone: '+971 (4) 123-4567' });
    shapeOk('ProfileReq', { fullName: null, company: '', jobTitle: '   ', country: '', phone: null });
    shapeOk('ProfileReq', { fullName: 'x'.repeat(80) + '   ' });
    bad('ProfileReq', { fullName: 'x'.repeat(81) }, /at most 80/);
    bad('ProfileReq', { company: 'x'.repeat(121) }, /at most 120/);
    bad('ProfileReq', { jobTitle: 'a\nb' }, /control/);
    bad('ProfileReq', { fullName: 'a b' }, /control/);
    bad('ProfileReq', { country: 'ae' }); bad('ProfileReq', { country: 'ZZ' }); bad('ProfileReq', { country: 'United Kingdom' });
    bad('ProfileReq', { phone: 'call me' }); bad('ProfileReq', { phone: '+1' }); bad('ProfileReq', { phone: '1'.repeat(41) });
    bad('ProfileReq', { fullName: 42 }); bad('ProfileReq', { email: 'a@company.example' }, /unexpected key/);
    assert.strictEqual(C.COUNTRIES.length, 250); assert.ok(C.COUNTRIES.includes('GB') && C.COUNTRIES.includes('XK'));
    // the sign-up requests carry it; the provider finish only together with consent
    shapeOk('CodeVerifyReq', { email: 'a@company.example', code: '12345678', publicDevice: false, profile: { fullName: 'A' } });
    bad('OAuthFinishReq', { profile: { fullName: 'A' } }, /only together with consent/);
    shapeOk('OAuthFinishReq', { consent: { terms: '1', privacy: '1' }, profile: { fullName: 'A' } });
    bad('CodeVerifyReq', { email: 'a@company.example', code: '12345678', publicDevice: false, profile: { nick: 'A' } });
  });

  test('normProfile: NFKC, trim, empty → null, every key present; isEmptyProfile', () => {
    const p = I.normProfile({ fullName: '  Ana  Example ', company: 'ＡＢＣ Ltd', jobTitle: '', phone: ' +44 20 7946 0000 ', country: 'GB' });
    assert.deepStrictEqual(p, { fullName: 'Ana  Example', company: 'ABC Ltd', jobTitle: null, country: 'GB', phone: '+44 20 7946 0000' });
    assert.deepStrictEqual(I.normProfile({}), I.emptyProfile());
    assert.ok(I.isEmptyProfile(I.normProfile({ fullName: ' ' })));
    assert.throws(() => I.normProfile({ x: 1 }), (e) => e.code === 'bad_request' && e.extra.field === 'profile.x');
    assert.throws(() => I.normProfile({ country: 'QQ' }), (e) => e.extra.field === 'profile.country');
  });

  test('SummaryReq / normSummary: text ≤ 120, wells ≤ 50 of ≤ 80, modules ≤ 40 page keys; empty and repeated entries dropped', () => {
    const full = { name: 'Example-1 DST', client: 'Operator Energy Ltd', operator: 'Operator Energy Ltd', company: 'Service Co', field: 'North Field',
      rig: 'Rig 7', country: 'United Arab Emirates', jobRef: 'JOB-001', wells: ['Example-1', '', 'Example-2', 'Example-1'], modules: ['prism', 'wts', 'prism'] };
    shapeOk('SummaryReq', full); shapeOk('SummaryReq', {});
    shapeOk('CommitReq', { pushId: crypto.randomUUID(), baseRev: 0, reason: 'save', core: { hash: sha('a'), vhash: sha('a'), zsha: sha('b'), bytes: 1 }, parts: [],
      meta: { name: 'n', client: '', well: '', field: '', operator: '' }, wells: [], fmt: 2, appVer: '4.0', summary: full });
    bad('SummaryReq', { client: 'x'.repeat(121) }, /at most 120/);
    bad('SummaryReq', { wells: ['x'.repeat(81)] }, /at most 80/);
    bad('SummaryReq', { wells: Array.from({ length: 51 }, (_, i) => 'W' + i) }, /at most 50 items/);
    bad('SummaryReq', { wells: [null] }); bad('SummaryReq', { modules: ['Prism'] }); bad('SummaryReq', { modules: Array.from({ length: 41 }, () => 'a') });
    bad('SummaryReq', { notes: 'x' }, /unexpected key/);
    const s = I.normSummary(full);
    assert.deepStrictEqual(s.wells, ['Example-1', 'Example-2']); assert.deepStrictEqual(s.modules, ['prism', 'wts']);
    assert.strictEqual(I.normSummary({}).client, null); assert.deepStrictEqual(I.normSummary({}).wells, []);
    shapeOk('ProjectSummary', s);
  });

  test('distinct / top: case-insensitive, first spelling kept / most common spelling shown, ordered by count', () => {
    assert.deepStrictEqual(I.distinct(['A', 'a', null, '', 'B', ' b', 'C'], 2), ['A', 'B']);
    assert.deepStrictEqual(I.top(['acme', 'ACME', 'ACME', 'Beta', null, '', 'gamma', 'Gamma'], 2),
      [{ value: 'ACME', n: 3 }, { value: 'gamma', n: 2 }], 'a tie keeps the first spelling seen');
  });

  test('the new routes: PUT /account/profile and GET /admin/users/:id (hidden like the other admin routes)', async () => {
    assert.strictEqual(C.matchRoute('PUT', '/account/profile').endpoint.id, 'profileUpdate');
    assert.strictEqual(C.matchRoute('GET', '/admin/users/6f1c2a3b-0000-4000-8000-000000000001').endpoint.id, 'adminUser');
    assert.strictEqual(C.matchRoute('GET', '/admin/users').endpoint.id, 'adminUsers');
    const { createApp } = require('../core/app');
    const app = createApp({ config: loadConfig({ WTS_ENV: 'test', WTS_ADMIN_EMAILS: 'boss@company.example' }) });
    const unknown = await app.handle({ method: 'GET', url: C.BASE + '/admin/nothing', headers: { host: 'welltest.h2oil.co.uk' }, body: null, remoteAddress: '203.0.113.7' });
    const r = await app.handle({ method: 'GET', url: C.BASE + '/admin/users/not-a-uuid', headers: { host: 'welltest.h2oil.co.uk' }, body: null, remoteAddress: '203.0.113.7' });
    assert.strictEqual(r.status, 404); assert.strictEqual(r.body, unknown.body);
    await assert.rejects(require('../functions/admin').handlers.adminUser({ params: { id: 'x' }, config: { adminEmails: new Set() }, endpoint: { id: 'adminUser' } }), (e) => e.code === 'not_found');
  });
});

// a one-part project (core inline, no well parts) — enough for the commit path
function coreOf(obj) {
  const json = Buffer.from(canonical(obj), 'utf8');
  const z = zlib.gzipSync(json);
  return { hash: sha(json), zsha: sha(z), z, bytes: json.length };
}
function commitBody(baseRev, core, o) {
  o = o || {};
  const b = { pushId: crypto.randomUUID(), baseRev, reason: o.reason || 'save',
    core: { hash: core.hash, vhash: o.vhash || core.hash, zsha: core.zsha, bytes: core.bytes, inline: core.z.toString('base64') },
    parts: [], meta: { name: o.name || 'Example-1 DST', client: '', well: '', field: '', operator: '' }, wells: [], fmt: 2, appVer: '4.0' };
  if (o.summary !== undefined) b.summary = o.summary;
  return b;
}

test.describe('profile, summaries and the admin insight (database)', { skip }, () => {
  let T = null;
  const ADMIN = 'boss@company.example';
  const PROFILE = { fullName: 'Ana Example', company: 'Operator Energy Ltd', jobTitle: 'Well test engineer', country: 'AE', phone: '+971 4 123 4567' };
  test.before(async () => { T = await harness('insight', { env: { WTS_ADMIN_EMAILS: ADMIN } }); });
  test.after(async () => { if (T) await T.close(); });
  const rowOf = async (email) => (await T.db.sql`select id, profile_enc from wts.users where email_bidx = ${T.keys.emailBidx(email)}`)[0];
  const auditOf = async (email, action) => T.db.sql`select actor, action, target, detail from wts.audit
    where user_id = (select id from wts.users where email_bidx = ${T.keys.emailBidx(email)}) and action = ${action} order by id`;

  // a code sign-up in two steps, as the page does it: verify without consent → 409, then with consent and the profile
  async function signUp(br, email, profile) {
    assert.strictEqual((await br.call('POST', '/auth/code/start', { email, purpose: 'signin' })).status, 202);
    const code = T.codeFor(email, 'code_signin');
    const first = await br.call('POST', '/auth/code/verify', { email, code, publicDevice: false });
    assert.strictEqual(first.status, 409); assert.strictEqual(first.json.error, 'consent_required');
    const body = { email, code, publicDevice: false, consent: { terms: T.config.terms, privacy: T.config.privacy } };
    if (profile !== undefined) body.profile = profile;
    const r = await br.call('POST', '/auth/code/verify', body);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    br.device = r.json.device.id;
    return r.json;
  }

  let ana; let ben; let admin;
  test('code sign-up stores the profile encrypted at rest (no plaintext in the column); /me returns it; audited without values', async () => {
    ana = T.browser();
    // a bad profile is refused before the code is tried (400), and the code still works afterwards
    assert.strictEqual((await ana.call('POST', '/auth/code/start', { email: 'ana@company.example', purpose: 'signin' })).status, 202);
    const code = T.codeFor('ana@company.example', 'code_signin');
    const b0 = await ana.call('POST', '/auth/code/verify', { email: 'ana@company.example', code, publicDevice: false, consent: { terms: '1', privacy: '1' }, profile: { country: 'XX' } });
    assert.strictEqual(b0.status, 400); assert.strictEqual(b0.json.error, 'bad_request');
    assert.strictEqual(await rowOf('ana@company.example'), undefined, 'no account was created');
    const r = await ana.call('POST', '/auth/code/verify', { email: 'ana@company.example', code, publicDevice: false, consent: { terms: '1', privacy: '1' }, profile: Object.assign({}, PROFILE, { fullName: '  Ana Example ' }) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json)); ana.device = r.json.device.id;
    const row = await rowOf('ana@company.example');
    assert.ok(Buffer.isBuffer(row.profile_enc) && row.profile_enc[0] === 1, 'an envelope field value');
    const raw = row.profile_enc.toString('latin1');
    for (const v of ['Ana Example', 'Operator Energy', 'Well test', '123 4567', '"AE"']) assert.ok(!raw.includes(v), 'plaintext ' + v + ' is not stored');
    const me = await ana.call('GET', '/me');
    assert.strictEqual(me.status, 200); shapeOk('Me', me.json);
    assert.deepStrictEqual(me.json.profile, PROFILE);
    const a = await auditOf('ana@company.example', 'profile_update');
    assert.strictEqual(a.length, 1);
    assert.deepStrictEqual(a[0].detail, { via: 'signup', fields: ['fullName', 'company', 'jobTitle', 'country', 'phone'] });
    assert.ok(!JSON.stringify(a).includes('Ana'), 'no values in the audit');
  });

  test('sign-up without a profile (or an empty one) stores none; a profile sent at a later sign-in is ignored', async () => {
    ben = T.browser();
    await signUp(ben, 'ben@company.example', { fullName: '', company: '  ' });
    assert.strictEqual((await rowOf('ben@company.example')).profile_enc, null);
    assert.deepStrictEqual((await ben.call('GET', '/me')).json.profile, I.emptyProfile());
    assert.strictEqual((await auditOf('ben@company.example', 'profile_update')).length, 0);
    const other = T.browser();
    assert.strictEqual((await other.call('POST', '/auth/code/start', { email: 'ben@company.example', purpose: 'signin' })).status, 202);
    const r = await other.call('POST', '/auth/code/verify', { email: 'ben@company.example', code: T.codeFor('ben@company.example', 'code_signin'), publicDevice: false, profile: { fullName: 'Not stored' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await rowOf('ben@company.example')).profile_enc, null, 'an existing account keeps its profile');
    admin = T.browser();
    await signUp(admin, ADMIN);
  });

  test('PUT /account/profile: replaces the whole profile, clears with nulls, validates, needs a session; audited', async () => {
    const r = await ben.call('PUT', '/account/profile', { fullName: 'Ben Example', company: 'operator energy ltd', country: 'GB' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json)); shapeOk('ProfileRes', r.json);
    assert.deepStrictEqual(r.json.profile, { fullName: 'Ben Example', company: 'operator energy ltd', jobTitle: null, country: 'GB', phone: null });
    assert.deepStrictEqual((await ben.call('GET', '/me')).json.profile, r.json.profile);
    assert.ok(!(await rowOf('ben@company.example')).profile_enc.toString('latin1').includes('Ben Example'));
    for (const b of [{ fullName: 'x'.repeat(81) }, { country: 'gb' }, { phone: 'abc' }, { nick: 'B' }, { fullName: 'a\u0000' }]) {
      const x = await ben.call('PUT', '/account/profile', b);
      assert.strictEqual(x.status, 400, JSON.stringify(b)); assert.strictEqual(x.json.error, 'bad_request');
    }
    assert.strictEqual((await T.browser().call('PUT', '/account/profile', { fullName: 'X' })).status, 401, 'signed out');
    assert.strictEqual((await ben.call('POST', '/account/profile', { fullName: 'X' })).status, 404, 'PUT only');
    // the page's profile was cleared, then set again for the admin tests below
    const c = await ben.call('PUT', '/account/profile', {});
    assert.deepStrictEqual(c.json.profile, I.emptyProfile());
    assert.strictEqual((await rowOf('ben@company.example')).profile_enc, null, 'all null → no stored value');
    await ben.call('PUT', '/account/profile', { fullName: 'Ben Example', company: 'operator energy ltd', jobTitle: 'Supervisor', country: 'GB' });
    const a = await auditOf('ben@company.example', 'profile_update');
    assert.deepStrictEqual(a.map((x) => x.detail.via), ['account', 'account', 'account']);
    assert.deepStrictEqual(a[1].detail.fields, []);
    assert.ok(!JSON.stringify(a).includes('Ben Example'));
  });

  let anaP1; let anaP2;
  test('commit: the summary is stored encrypted and kept as the latest per project; a commit without one keeps it; limits', async () => {
    anaP1 = (await ana.call('POST', '/projects', { name: 'Example-1 DST', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    const S1 = { name: 'Example-1 DST', client: 'Operator Energy Ltd', operator: 'Operator Energy Ltd', company: 'Service Co', field: 'North Field',
      rig: 'Rig 7', country: 'United Arab Emirates', jobRef: 'JOB-001', wells: ['Example-1', 'Example-1', 'Example-2'], modules: ['prism', 'wts'] };
    const c1 = await ana.call('POST', '/projects/' + anaP1 + '/commit', commitBody(0, coreOf({ a: 1 }), { summary: S1 }));
    assert.strictEqual(c1.status, 200, JSON.stringify(c1.json));
    const raw = (await T.db.sql`select summary_enc, summary_at from wts.projects where id = ${anaP1}`)[0];
    assert.ok(raw.summary_enc && raw.summary_at);
    for (const v of ['Operator Energy', 'North Field', 'Example-1', 'JOB-001', 'prism']) assert.ok(!raw.summary_enc.toString('latin1').includes(v), 'plaintext ' + v);
    // without a summary: kept
    const c2 = await ana.call('POST', '/projects/' + anaP1 + '/commit', commitBody(1, coreOf({ a: 2 })));
    assert.strictEqual(c2.status, 200);
    const keep = (await T.db.sql`select summary_enc from wts.projects where id = ${anaP1}`)[0].summary_enc;
    assert.ok(keep.equals(raw.summary_enc), 'unchanged');
    // refused summaries: 400, no new revision, nothing stored
    for (const s of [{ client: 'x'.repeat(121) }, { wells: Array.from({ length: 51 }, (_, i) => 'W' + i) }, { wells: ['x'.repeat(81)] }, { modules: ['Bad Key'] }, { extra: 1 }, { rig: 'a\nb' }]) {
      const x = await ana.call('POST', '/projects/' + anaP1 + '/commit', commitBody(2, coreOf({ a: 3 }), { summary: s }));
      assert.strictEqual(x.status, 400, JSON.stringify(s)); assert.strictEqual(x.json.error, 'bad_request');
    }
    assert.strictEqual((await ana.call('GET', '/projects/' + anaP1 + '/revs')).json.length, 2);
    // a new summary replaces it (also on a no-op auto commit)
    const S2 = Object.assign({}, S1, { rig: 'Rig 9', wells: ['Example-1'] });
    const c3 = await ana.call('POST', '/projects/' + anaP1 + '/commit', commitBody(2, coreOf({ a: 2 }), { reason: 'auto', vhash: coreOf({ a: 2 }).hash, summary: S2 }));
    assert.strictEqual(c3.status, 200); assert.strictEqual(c3.json.rev, 2, 'a no-op commit');
    // a second project, and a duplicate that carries the summary over
    anaP2 = (await ana.call('POST', '/projects', { name: 'Example-3 test', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    await ana.call('POST', '/projects/' + anaP2 + '/commit', commitBody(0, coreOf({ b: 1 }), { name: 'Example-3 test', summary: { client: 'OPERATOR ENERGY LTD', field: 'South Field', wells: ['Example-3'], country: 'Oman' } }));
    const dup = await ana.call('POST', '/projects/' + anaP2 + '/duplicate', { name: 'Copy' });
    assert.strictEqual(dup.status, 201);
    assert.ok((await T.db.sql`select summary_enc from wts.projects where id = ${dup.json.id}`)[0].summary_enc);
    await ana.call('POST', '/projects/' + dup.json.id + '/trash', {});
    // Ben: one project with a summary (another client), one without
    const bp = (await ben.call('POST', '/projects', { name: 'B', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    await ben.call('POST', '/projects/' + bp + '/commit', commitBody(0, coreOf({ c: 1 }), { summary: { client: 'Another Client', field: 'north field', wells: ['B-1'] } }));
    await ben.call('POST', '/projects', { name: 'B2', meta: { client: '', well: '', field: '', operator: '' } });
  });

  test('export: the profile and each project\'s latest summary', async () => {
    await T.stepUp(ana);
    const ex = await ana.call('POST', '/account/export', {});
    assert.strictEqual(ex.status, 200, JSON.stringify(ex.json)); shapeOk('ExportRes', ex.json);
    assert.deepStrictEqual(ex.json.profile, PROFILE);
    const p1 = ex.json.projects.find((p) => p.id === anaP1);
    assert.strictEqual(p1.summary.rig, 'Rig 9'); assert.deepStrictEqual(p1.summary.wells, ['Example-1']); assert.ok(p1.summaryAt);
    await T.stepUp(admin);
    const ex2 = (await admin.call('POST', '/account/export', {})).json;
    assert.strictEqual(ex2.profile, null);
  });

  test('admin users: rows carry the profile and work (wells, clients, operators, fields, countries, lastProjectAt)', async () => {
    const r = await admin.call('GET', '/admin/users?limit=200');
    assert.strictEqual(r.status, 200, JSON.stringify(r.json)); shapeOk('AdminUsers', r.json);
    const a = r.json.users.find((u) => u.email === 'ana@company.example');
    assert.deepStrictEqual(a.profile, PROFILE);
    assert.deepStrictEqual(a.work.wells, ['Example-3', 'Example-1'], 'newest project first; trashed projects left out; unique');
    assert.deepStrictEqual(a.work.clients, ['OPERATOR ENERGY LTD'], 'case-insensitive unique, first (newest) spelling');
    assert.deepStrictEqual(a.work.operators, ['Operator Energy Ltd']);
    assert.deepStrictEqual(a.work.fields, ['South Field', 'North Field']);
    assert.deepStrictEqual(a.work.countries, ['Oman', 'United Arab Emirates']);
    assert.ok(a.work.lastProjectAt);
    const b = r.json.users.find((u) => u.email === 'ben@company.example');
    assert.strictEqual(b.profile.jobTitle, 'Supervisor'); assert.deepStrictEqual(b.work.clients, ['Another Client']);
    const boss = r.json.users.find((u) => u.email === ADMIN);
    assert.strictEqual(boss.profile, null);
    assert.deepStrictEqual(boss.work, { wells: [], clients: [], operators: [], fields: [], countries: [], lastProjectAt: null });
  });

  test('admin user detail: the row, the live projects with name, updated time, bytes and summary; unknown id 404; audited', async () => {
    const id = (await rowOf('ana@company.example')).id;
    const r = await admin.call('GET', '/admin/users/' + id);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json)); shapeOk('AdminUserDetail', r.json);
    assert.strictEqual(r.json.user.email, 'ana@company.example'); assert.deepStrictEqual(r.json.user.profile, PROFILE);
    // the name shown is the summary's (anaP2's summary has none): the project's own name (meta_enc) is never opened (review fix)
    assert.deepStrictEqual(r.json.projects.map((p) => p.id), [anaP2, anaP1], 'newest first, the trashed copy left out');
    assert.deepStrictEqual(r.json.projects.map((p) => p.name), ['', 'Example-1 DST']);
    assert.ok(!JSON.stringify(r.json).includes('Example-3 test'), 'the project name outside a summary is not shown');
    const p1 = r.json.projects.find((p) => p.id === anaP1);
    assert.strictEqual(p1.summary.client, 'Operator Energy Ltd'); assert.strictEqual(p1.summary.jobRef, 'JOB-001'); assert.deepStrictEqual(p1.summary.modules, ['prism', 'wts']);
    assert.ok(p1.bytes > 0 && p1.updatedAt && p1.summaryAt);
    const bid = (await rowOf('ben@company.example')).id;
    const rb = (await admin.call('GET', '/admin/users/' + bid)).json;
    assert.strictEqual(rb.projects.length, 2); assert.ok(rb.projects.some((p) => p.summary === null && p.summaryAt === null));
    for (const x of [crypto.randomUUID(), 'not-a-uuid']) {
      const n = await admin.call('GET', '/admin/users/' + x);
      assert.strictEqual(n.status, 404); assert.strictEqual(n.json.error, 'not_found');
    }
    const au = await auditOf(ADMIN, 'admin.user');
    assert.strictEqual(au.length, 4); assert.ok(au.every((x) => x.actor === 'admin'));
    assert.deepStrictEqual(au.map((x) => x.detail.found), [true, true, false, false]);
    assert.strictEqual(au[0].target, id);
    assert.ok(!JSON.stringify(au).includes('@'), 'no address in the audit');
  });

  test('admin summary: byCompany from profiles, topClients / topFields from summaries (case-insensitive, live projects)', async () => {
    const r = await admin.call('GET', '/admin/summary');
    assert.strictEqual(r.status, 200, JSON.stringify(r.json)); shapeOk('AdminSummary', r.json);
    // two spellings once each: one group of 2 (which spelling is shown on a tie depends on the account order)
    assert.strictEqual(r.json.byCompany.length, 1); assert.strictEqual(r.json.byCompany[0].users, 2);
    assert.strictEqual(r.json.byCompany[0].company.toLowerCase(), 'operator energy ltd');
    const low = (list, k) => list.map((x) => [x[k].toLowerCase(), x.projects]);
    assert.deepStrictEqual(low(r.json.topClients, 'client'), [['operator energy ltd', 2], ['another client', 1]], 'the trashed copy is not counted');
    assert.deepStrictEqual(low(r.json.topFields, 'field'), [['north field', 2], ['south field', 1]]);
    assert.ok(['OPERATOR ENERGY LTD', 'Operator Energy Ltd'].includes(r.json.topClients[0].client), 'one of the stored spellings');
  });

  test('non-admins and signed-out callers get 404 on the user detail route; a non-admin\'s probe is audited as admin.denied', async () => {
    const id = (await rowOf('ana@company.example')).id;
    for (const br of [T.browser(), ben]) {
      const r = await br.call('GET', '/admin/users/' + id);
      assert.strictEqual(r.status, 404); assert.strictEqual(r.json.error, 'not_found');
    }
    const d = await auditOf('ben@company.example', 'admin.denied');
    assert.strictEqual(d.length, 1); assert.strictEqual(d[0].detail.route, 'adminUser');
    // the database refuses a non-admin, whatever list it is handed
    const bid = (await rowOf('ben@company.example')).id;
    const list = (tx) => tx.array([T.keys.emailBidx(ADMIN)], 17);
    await assert.rejects(T.api.asUser(bid, (tx) => tx`select * from wts.admin_insight(${list(tx)}, null)`), /not an administrator/);
    await assert.rejects(T.api.asUser(bid, (tx) => tx`select * from wts.admin_user_get(${list(tx)}, ${id})`), /not an administrator/);
    await assert.rejects(T.api.asUser(bid, (tx) => tx`select * from wts.admin_user_projects(${list(tx)}, ${id})`), /not an administrator/);
    // under RLS a user still sees only its own projects' summaries
    const seen = await T.api.asUser(bid, (tx) => tx`select count(*)::int as n from wts.projects where summary_enc is not null`);
    assert.strictEqual(seen[0].n, 1);
    const v = await auditVerify(T.db.sql);
    assert.deepStrictEqual(v.bad, []);
  });

  test('privacy notice gate (review fix): an account on an older version stores no summary or profile, the admin routes hide what it stored, the code sign-in asks it again; /me countryHint', async () => {
    const cara = T.browser();
    await signUp(cara, 'cara@company.example');
    const id = (await rowOf('cara@company.example')).id;
    // while current: a profile and a summary are stored
    assert.strictEqual((await cara.call('PUT', '/account/profile', { fullName: 'Cara Example', company: 'Cara Co' })).status, 200);
    const cp = (await cara.call('POST', '/projects', { name: 'Cara own name', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    assert.strictEqual((await cara.call('POST', '/projects/' + cp + '/commit', commitBody(0, coreOf({ k: 1 }), { name: 'Cara own name', summary: { name: 'Cara-1 test', client: 'Kept Client', wells: ['Cara-1'] } }))).status, 200);
    const before = (await T.db.sql`select summary_enc from wts.projects where id = ${cp}`)[0].summary_enc;
    // the account is on an older notice (as every v1 account is when v2 goes live)
    await T.db.sql`update wts.users set privacy_version = '0' where id = ${id}`;
    const pr = await cara.call('PUT', '/account/profile', { fullName: 'New Name' });
    assert.strictEqual(pr.status, 409); assert.strictEqual(pr.json.error, 'consent_required'); assert.ok(C.checkError('consent_required', pr.json).ok);
    const c2 = await cara.call('POST', '/projects/' + cp + '/commit', commitBody(1, coreOf({ k: 2 }), { summary: { client: 'Secret Client', wells: ['Secret-1'] } }));
    assert.strictEqual(c2.status, 200, 'the save itself goes on'); assert.strictEqual(c2.json.rev, 2);
    assert.ok((await T.db.sql`select summary_enc from wts.projects where id = ${cp}`)[0].summary_enc.equals(before), 'the new summary was not stored');
    const row = (await admin.call('GET', '/admin/users?limit=200')).json.users.find((u) => u.email === 'cara@company.example');
    assert.strictEqual(row.profile, null); assert.deepStrictEqual(row.work.clients, []); assert.deepStrictEqual(row.work.wells, []);
    const d = await admin.call('GET', '/admin/users/' + id);
    assert.strictEqual(d.status, 200); shapeOk('AdminUserDetail', d.json);
    assert.deepStrictEqual(d.json.projects.map((p) => [p.name, p.summary, p.summaryAt]), [['', null, null]]);
    assert.ok(!/Cara|Kept Client|Secret/.test(JSON.stringify(d.json)), JSON.stringify(d.json));
    const sm = (await admin.call('GET', '/admin/summary')).json;
    assert.ok(!sm.topClients.some((x) => /kept client|secret client/i.test(x.client)) && !sm.byCompany.some((x) => /cara co/i.test(x.company)));
    // /me: the country default of the profile card (the last recorded country when this connection has none)
    await T.db.sql`update wts.users set last_country = 'OM' where id = ${id}`;
    const me = await cara.call('GET', '/me');
    shapeOk('Me', me.json); assert.strictEqual(me.json.countryHint, 'OM');
    // the next e-mail-code sign-in asks for the current versions (existing: true), then records them
    const br = T.browser();
    assert.strictEqual((await br.call('POST', '/auth/code/start', { email: 'cara@company.example', purpose: 'signin' })).status, 202);
    const code = T.codeFor('cara@company.example', 'code_signin');
    const r1 = await br.call('POST', '/auth/code/verify', { email: 'cara@company.example', code, publicDevice: false });
    assert.strictEqual(r1.status, 409); assert.strictEqual(r1.json.existing, true); assert.ok(C.checkError('consent_required', r1.json).ok);
    const r2 = await br.call('POST', '/auth/code/verify', { email: 'cara@company.example', code, publicDevice: false, consent: { terms: T.config.terms, privacy: T.config.privacy } });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
    assert.strictEqual((await T.db.sql`select privacy_version from wts.users where id = ${id}`)[0].privacy_version, T.config.privacy);
    assert.strictEqual((await cara.call('PUT', '/account/profile', { fullName: 'New Name' })).status, 200, 'collected again once accepted');
    assert.strictEqual(I.consentCurrent({ privacy_version: '3' }, { privacy: '2' }), true);
    assert.strictEqual(I.consentCurrent({ privacy_version: '1' }, { privacy: '2' }), false);
    assert.strictEqual(I.consentCurrent({ privacy_version: '2026-10' }, { privacy: '2026-11' }), false);
    assert.strictEqual(I.consentCurrent(null, { privacy: '2' }), false);
  });
});

test.describe('provider path: the profile at the consent step (database)', { skip }, () => {
  const { createApp } = require('../core/app');
  const { memoryTransport } = require('../core/mail');
  const { createFakeOidc } = require('./fake-oidc');
  const { createOauthHandlers } = require('../functions/oauth');
  const baseHandlers = require('../functions').handlers;
  let DB = null;
  test.before(async () => { DB = await D.freshDatabase('insight_oauth'); });
  test.after(async () => { if (DB) await DB.close(); });

  test('Google sign-up: profile with consent is stored encrypted; profile without consent is refused; /me returns it', async () => {
    const g = createFakeOidc({ provider: 'google' });
    const l = createFakeOidc({ provider: 'linkedin', enforcePkce: true });
    const config = loadConfig({ WTS_ENV: 'test', ACCOUNTS_SIGNUP: 'open', OAUTH_GOOGLE: 'on', OAUTH_GOOGLE_CLIENT_ID: g.clientId, OAUTH_GOOGLE_CLIENT_SECRET: g.clientSecret,
      OAUTH_LINKEDIN: 'off', WTS_TERMS_VERSION: '1', WTS_PRIVACY_VERSION: '1',
      WTS_INDEX_PEPPER: k32(), WTS_MASTER_KEYS: '1:' + k32(), WTS_MASTER_KID: '1', WTS_CODE_PEPPERS: '1:' + k32() });
    const fetch = (url, init) => (String(url).startsWith('https://google.') ? g : l).fetch(url, init);
    const oauth = createOauthHandlers({ fetch, override: { google: g.override, linkedin: l.override }, delay: async () => {} });
    const app = createApp({ config, db: DB.as('wts_api'), mail: memoryTransport(), log: { info() {}, warn() {} }, handlers: Object.assign({}, baseHandlers, oauth) });
    const email = 'field.engineer@' + require('../core/oidc-providers').CONFIG.google.consumerDomains[0];
    const jar = new Map();
    const apply = (sc) => (sc || []).forEach((line) => {
      const [nv, ...attrs] = line.split(';').map((s) => s.trim()); const i = nv.indexOf('=');
      const lax = attrs.some((a) => /^samesite=lax$/i.test(a));
      if (/max-age=0/i.test(line)) jar.delete(nv.slice(0, i)); else jar.set(nv.slice(0, i), { v: nv.slice(i + 1), lax });
    });
    const ck = (laxOnly) => Array.from(jar.entries()).filter(([, c]) => !laxOnly || c.lax).map(([k, c]) => k + '=' + c.v).join('; ');
    const call = async (method, path, body, ct) => {
      const h = { host: 'welltest.h2oil.co.uk', cookie: ck(false) };
      if (method !== 'GET') Object.assign(h, { origin: 'https://welltest.h2oil.co.uk', 'x-wts-req': '1', 'content-type': 'application/json' });
      const r = await app.handle({ method, url: C.BASE + path, headers: h, body: method === 'GET' ? null : Buffer.from(JSON.stringify(body || {})), remoteAddress: '198.51.100.7' });
      await app.idle(); apply(r.cookies);
      return { status: r.status, json: r.body ? JSON.parse(r.body) : null };
    };
    const s = await call('POST', '/auth/oauth/google/start', { purpose: 'signin', publicDevice: false });
    assert.strictEqual(s.status, 200, JSON.stringify(s.json));
    const back = new URL(g.authorize(s.json.url, { user: { key: 'fe-1', email } }));
    const cb = await app.handle({ method: 'GET', url: back.pathname + back.search, headers: { host: 'welltest.h2oil.co.uk', cookie: ck(true) }, body: null, remoteAddress: '198.51.100.7' });
    apply(cb.cookies); assert.strictEqual(cb.status, 303);
    let f = await call('POST', '/auth/oauth/finish', {});
    assert.strictEqual(f.json.next, 'consent', JSON.stringify(f.json));
    const nope = await call('POST', '/auth/oauth/finish', { profile: { fullName: 'Field Engineer' } });
    assert.strictEqual(nope.status, 400); assert.strictEqual(nope.json.error, 'bad_request');
    f = await call('POST', '/auth/oauth/finish', { consent: { terms: '1', privacy: '1' }, profile: { fullName: 'Field Engineer', company: 'Service Co', country: 'NO' } });
    assert.strictEqual(f.json.next, 'done', JSON.stringify(f.json));
    const row = (await DB.admin.sql`select signup_method, profile_enc from wts.users`)[0];
    assert.strictEqual(row.signup_method, 'google');
    assert.ok(row.profile_enc && !row.profile_enc.toString('latin1').includes('Field Engineer'));
    const me = await call('GET', '/me');
    assert.deepStrictEqual(me.json.profile, { fullName: 'Field Engineer', company: 'Service Co', jobTitle: null, country: 'NO', phone: null });
    const a = await DB.admin.sql`select detail from wts.audit where action = 'profile_update'`;
    assert.deepStrictEqual(a.map((x) => x.detail), [{ via: 'signup', fields: ['fullName', 'company', 'country'] }]);

    // review fix: the same account on an older Privacy notice signs in with the provider again → the consent step comes first
    // (existingAccount, no new-account address), and accepting it records the current versions in the sign-in
    await DB.admin.sql`update wts.users set privacy_version = '0'`;
    const s2 = await call('POST', '/auth/oauth/google/start', { purpose: 'signin', publicDevice: false });
    const back2 = new URL(g.authorize(s2.json.url, { user: { key: 'fe-1', email } }));
    const cb2 = await app.handle({ method: 'GET', url: back2.pathname + back2.search, headers: { host: 'welltest.h2oil.co.uk', cookie: ck(true) }, body: null, remoteAddress: '198.51.100.7' });
    apply(cb2.cookies);
    const r1 = await call('POST', '/auth/oauth/finish', {});
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.json));
    assert.deepStrictEqual(r1.json, { next: 'consent', existingAccount: true, terms: '1', privacy: '1' });
    assert.ok(C.checkShape('FinishRes', r1.json).ok, JSON.stringify(C.checkShape('FinishRes', r1.json).errors));
    assert.strictEqual((await DB.admin.sql`select privacy_version from wts.users`)[0].privacy_version, '0', 'nothing recorded before the tick');
    const old = await call('POST', '/auth/oauth/finish', { consent: { terms: '1', privacy: '0' } });
    assert.strictEqual(old.status, 409); assert.strictEqual(old.json.error, 'consent_required');
    const r2 = await call('POST', '/auth/oauth/finish', { consent: { terms: '1', privacy: '1' }, profile: { fullName: 'Not taken' } });
    assert.strictEqual(r2.json.next, 'done', JSON.stringify(r2.json));
    assert.strictEqual(r2.json.firstSignIn, false);
    const row2 = (await DB.admin.sql`select count(*)::int as n, min(privacy_version) as v from wts.users`)[0];
    assert.deepStrictEqual([row2.n, row2.v], [1, '1'], 'the same account, now on the current notice');
    assert.strictEqual((await call('GET', '/me')).json.profile.fullName, 'Field Engineer', 'no profile taken at a re-consent');
  });
});
