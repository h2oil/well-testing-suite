'use strict';
// server/test/misc.test.js — smaller rules of docs/ACCOUNTS-PLAN.md §3.2–§3.3 and §8.3 against the throwaway database: the
// client address for limits comes from the socket / trusted header (a spoofed X-Forwarded-For changes nothing), the outbox
// key, opt-ins, a consent version bump, locked verify, "Send again" for an e-mail change, the overwrite path after a 409,
// incomplete blobs, oversized library bodies.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const zlib = require('zlib');
const { harness, available } = require('./_api');
const C = require('../core/contract');

const skip = !available() && 'no throwaway database (run through server/test/run.js)';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test.describe('smaller rules (§3.2, §3.3, §8.3)', { skip }, () => {
  let T = null;
  test.before(async () => { T = await harness('misc'); });
  test.after(async () => { if (T) await T.close(); });

  test('a spoofed X-Forwarded-For never moves a request to another rate bucket; the prefix is stored, not the address', async () => {
    const br = T.browser({ ip: '192.0.2.77' });
    await br.call('POST', '/auth/code/start', { email: 'xff@company.example', purpose: 'signin' }, { headers: { 'x-forwarded-for': '10.9.8.7' } });
    const rows = (await T.db.sql`select bucket from wts.rate_counters where bucket like 'codeStartIpHour:%'`).map((r) => r.bucket);
    assert.ok(rows.includes('codeStartIpHour:192.0.2.0/24')); assert.ok(!rows.some((b) => b.includes('10.9.8')));
    const codes = await T.db.sql`select ip_prefix::text as p from wts.email_codes where ip_prefix is not null`;
    assert.ok(codes.every((c) => /\/24$|\/48$/.test(c.p)), 'only prefixes are stored');
  });

  test('outbox key: 32 bytes, stable for the user, different per user, encrypted at rest; opts', async () => {
    const a = T.browser(); const b = T.browser();
    await T.signIn(a, 'ok1@company.example'); await T.signIn(b, 'ok2@company.example');
    const k1 = (await a.call('GET', '/me/outbox-key')).json.k; const k1b = (await a.call('GET', '/me/outbox-key')).json.k;
    const k2 = (await b.call('GET', '/me/outbox-key')).json.k;
    assert.strictEqual(Buffer.from(k1, 'base64').length, 32); assert.strictEqual(k1, k1b); assert.notStrictEqual(k1, k2);
    const raw = (await T.db.sql`select outbox_key_enc from wts.users where outbox_key_enc is not null`).map((r) => r.outbox_key_enc.toString('base64'));
    assert.ok(!raw.some((x) => x.includes(k1)));
    const o = await a.call('POST', '/me/opts', { historian: true });
    assert.deepStrictEqual(o.json, { opts: { historian: true, liveCfg: false } });
    assert.ok(C.checkShape('OptsRes', o.json).ok);
    assert.deepStrictEqual((await a.call('GET', '/me')).json.opts, { historian: true, liveCfg: false });
  });

  test('a Terms / Privacy version bump asks again at the next sign-in (409, code kept), then records the new versions', async () => {
    const email = 'bump@company.example';
    await T.signIn(T.browser(), email);
    T.setEnv({ WTS_TERMS_VERSION: '2' });
    const br = T.browser();
    await br.call('POST', '/auth/code/start', { email, purpose: 'signin' });
    const code = T.codeFor(email, 'code_signin');
    const r1 = await br.call('POST', '/auth/code/verify', { email, code, publicDevice: false });
    assert.strictEqual(r1.status, 409); assert.strictEqual(r1.json.terms, '2');
    const r2 = await br.call('POST', '/auth/code/verify', { email, code, publicDevice: false, consent: { terms: '2', privacy: '1' } });
    assert.strictEqual(r2.status, 200, 'the same code still works');
    assert.strictEqual((await br.call('GET', '/me')).json.user.terms, '2');
    T.setEnv({ WTS_TERMS_VERSION: '1' });
  });

  test('a locked account: code verify answers 403 locked (no session); the first sign-in sends no new-device notice', async () => {
    const email = 'lock2@company.example';
    await T.signIn(T.browser(), email);
    assert.strictEqual(T.lastMail(email, 'notice_new_device'), null, 'no notice on the first sign-in of a new account');
    const br = T.browser();
    await br.call('POST', '/auth/code/start', { email, purpose: 'signin' });
    const code = T.codeFor(email, 'code_signin');
    await T.db.sql`update wts.users set status = 'locked' where email_bidx = ${T.keys.emailBidx(email)}`;
    const r = await br.call('POST', '/auth/code/verify', { email, code, publicDevice: false });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.json.error, 'locked'); assert.strictEqual(br.cookie('__Host-wts_sid'), null);
  });

  test('"Send again" for an e-mail change goes only to the waiting address; both codes work', async () => {
    const br = T.browser(); const email = 'again@company.example'; const neu = 'again.new@company.example';
    await T.signIn(br, email);
    await br.call('POST', '/auth/email/change', { newEmail: neu });
    const c1 = T.codeFor(neu, 'code_email_change');
    await br.call('POST', '/auth/code/start', { email: neu, purpose: 'email_change' });
    await br.call('POST', '/auth/code/start', { email: 'elsewhere@company.example', purpose: 'email_change' });
    assert.strictEqual(T.mailsTo('elsewhere@company.example').length, 0, 'never to another address');
    assert.strictEqual(T.mailsTo(neu).filter((m) => m.template === 'code_email_change').length, 2);
    assert.strictEqual((await br.call('POST', '/auth/email/confirm', { code: c1 })).status, 200, 'the first code still works');
  });

  test('overwrite after a 409: baseRev equal to the head shown in the 409; the replaced revision stays in history', async () => {
    const a = T.browser(); await T.signIn(a, 'ow@company.example');
    const pid = (await a.call('POST', '/projects', { name: 'OW', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    const commit = (base, n, reason) => {
      const z = zlib.gzipSync(Buffer.from('{"n":' + n + '}'));
      const h = sha('{"n":' + n + '}');
      return a.call('POST', '/projects/' + pid + '/commit', { pushId: crypto.randomUUID(), baseRev: base, reason: reason || 'save',
        core: { hash: h, vhash: h, zsha: sha(z), bytes: 7, inline: z.toString('base64') }, parts: [], meta: { name: 'OW', client: '', well: '', field: '', operator: '' },
        wells: [], fmt: 2, appVer: '3.5' });
    };
    assert.strictEqual((await commit(0, 1)).json.rev, 1);
    assert.strictEqual((await commit(1, 2)).json.rev, 2);
    const st = await commit(1, 3);
    assert.strictEqual(st.status, 409);
    const ow = await commit(st.json.headRev, 3, 'overwrite');
    assert.strictEqual(ow.json.rev, 3);
    const revs = (await a.call('GET', '/projects/' + pid + '/revs')).json;
    assert.deepStrictEqual(revs.map((r) => [r.rev, r.reason]), [[3, 'overwrite'], [2, 'save'], [1, 'save']]);
  });

  test('an incomplete blob is not readable and not "had"; a library body over 2 MB is refused before parsing', async () => {
    const a = T.browser(); await T.signIn(a, 'inc@company.example');
    const z = zlib.gzipSync(crypto.randomBytes(3000));
    const c0 = z.subarray(0, 1000); const h = 'e'.repeat(64);
    assert.strictEqual((await a.call('PUT', '/blobs/' + h + '/0?of=3', null, { raw: c0, ct: 'application/octet-stream', headers: { 'x-wts-zsha': sha(z), 'x-wts-chunk-sha': sha(c0) } })).status, 204);
    assert.strictEqual((await a.call('GET', '/blobs/' + h + '/0')).status, 404);
    assert.deepStrictEqual((await a.call('POST', '/blobs/has', { hashes: [h] })).json.missing, [h]);
    assert.strictEqual((await a.call('PUT', '/blobs/' + h + '/0?of=2', null, { raw: c0, ct: 'application/octet-stream', headers: { 'x-wts-zsha': sha(z), 'x-wts-chunk-sha': sha(c0) } })).json.error, 'immutable', 'a different chunk count for a started blob');
    const big = await a.call('POST', '/library/commit', null, { raw: Buffer.alloc(3 * 1000 * 1000, 32) });
    assert.strictEqual(big.status, 413);
  });
});
