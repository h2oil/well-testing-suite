'use strict';
// server/test/projects.test.js — cloud projects, revisions, blobs, library and quotas (docs/ACCOUNTS-PLAN.md §3.3 Projects /
// Blobs / Library, D5, D6, §3.4, §8.3) through the real pipeline against the throwaway database.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const zlib = require('zlib');
const { harness, available } = require('./_api');
const C = require('../core/contract');
const { canonical } = require('../core/canon');
const E = require('../core/envelope');

const skip = !available() && 'no throwaway database (run through server/test/run.js)';
let T = null;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const META = { name: 'Example-1 DST', client: 'Operator Energy Ltd', well: 'Example-1', field: '', operator: '' };

// a part = canonical JSON → gzip; hash = SHA-256 of the canonical JSON (D5), zsha = SHA-256 of the gzip
function part(obj) {
  const json = Buffer.from(canonical(obj), 'utf8');
  const z = zlib.gzipSync(json);
  return { hash: sha(json), zsha: sha(z), z, bytes: json.length };
}
async function upload(br, p, chunkSize) {
  const size = chunkSize || 4 * 1024 * 1024;
  const of = Math.max(1, Math.ceil(p.z.length / size));
  for (let n = 0; n < of; n++) {
    const c = p.z.subarray(n * size, (n + 1) * size);
    const r = await br.call('PUT', '/blobs/' + p.hash + '/' + n + '?of=' + of, null, { raw: c, ct: 'application/octet-stream',
      headers: { 'x-wts-zsha': p.zsha, 'x-wts-chunk-sha': sha(c) } });
    if (r.status !== 204) return r;
  }
  return { status: 204 };
}
function commitBody(baseRev, core, parts, o) {
  o = o || {};
  const b = { pushId: o.pushId || crypto.randomUUID(), baseRev, reason: o.reason || 'save',
    core: { hash: core.hash, vhash: o.vhash || core.hash, zsha: core.zsha, bytes: core.bytes },
    parts: parts.map((p, i) => ({ name: 'well/w' + (i + 1), hash: p.hash, bytes: p.bytes })),
    meta: o.meta || META, wells: parts.map((p, i) => ({ id: 'w' + (i + 1), name: 'Example-' + (i + 1) })), fmt: 2, appVer: '3.5' };
  if (o.inline !== false) b.core.inline = core.z.toString('base64');
  return b;
}

test.describe('projects, revisions, blobs, library (§3.3)', { skip }, () => {
  let br; let other;
  test.before(async () => {
    T = await harness('projects');
    br = T.browser(); other = T.browser();
    await T.signIn(br, 'pam@company.example');
    await T.signIn(other, 'oscar@company.example');
  });
  test.after(async () => { if (T) await T.close(); });

  test('create, list (meta encrypted at rest), head of an empty project, 404 for another account (same as absent)', async () => {
    const c = await br.call('POST', '/projects', { name: 'Example-1 DST', meta: { client: 'Operator Energy Ltd', well: 'Example-1', field: '', operator: '' } });
    assert.strictEqual(c.status, 201); assert.ok(C.checkShape('ProjectCreated', c.json).ok); assert.strictEqual(c.json.headRev, 0);
    const l = await br.call('GET', '/projects');
    assert.ok(C.checkShape('ProjectList', l.json).ok, JSON.stringify(C.checkShape('ProjectList', l.json).errors));
    assert.strictEqual(l.json[0].name, 'Example-1 DST'); assert.strictEqual(l.json[0].meta.client, 'Operator Energy Ltd');
    const raw = await T.db.sql`select meta_enc from wts.projects where id = ${c.json.id}`;
    assert.ok(!raw[0].meta_enc.toString('latin1').includes('Operator'), 'meta is envelope-encrypted');
    const h = await br.call('GET', '/projects/' + c.json.id + '/head');
    assert.strictEqual(h.status, 200); assert.ok(C.checkShape('Head', h.json).ok); assert.strictEqual(h.json.rev, 0);
    const foreign = await other.call('GET', '/projects/' + c.json.id + '/head');
    const absent = await other.call('GET', '/projects/' + crypto.randomUUID() + '/head');
    assert.strictEqual(foreign.status, 404); assert.deepStrictEqual(foreign.json, absent.json);
    assert.strictEqual((await other.call('GET', '/projects')).json.length, 0);
  });

  test('commit: inline core, 422 missing blobs, chunked upload, CAS 409 stale with the head, pushId retry, vhash no-op, history', async () => {
    const pid = (await br.call('POST', '/projects', { name: 'P2', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    const core = part({ wells: ['w1'], job: { a: 1 } });
    const w1 = part({ page: { x: 1 }, big: 'y'.repeat(5000) });
    // the part is not uploaded yet
    const r0 = await br.call('POST', '/projects/' + pid + '/commit', commitBody(0, core, [w1]));
    assert.strictEqual(r0.status, 422); assert.ok(C.checkError('missing_blobs', r0.json).ok); assert.deepStrictEqual(r0.json.missing, [w1.hash]);
    const has = await br.call('POST', '/blobs/has', { hashes: [w1.hash, core.hash] });
    assert.deepStrictEqual(has.json.missing.sort(), [w1.hash, core.hash].sort(), 'the failed commit stored nothing');
    assert.strictEqual((await upload(br, w1, 1000)).status, 204, 'several chunks');
    assert.deepStrictEqual((await br.call('POST', '/blobs/has', { hashes: [w1.hash] })).json.missing, []);
    const body = commitBody(0, core, [w1]);
    const r1 = await br.call('POST', '/projects/' + pid + '/commit', body);
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.json)); assert.ok(C.checkShape('CommitRes', r1.json).ok); assert.strictEqual(r1.json.rev, 1);
    const again = await br.call('POST', '/projects/' + pid + '/commit', body);
    assert.deepStrictEqual(again.json, r1.json, 'the same pushId answers the same result');
    const stale = await br.call('POST', '/projects/' + pid + '/commit', commitBody(0, core, [w1]));
    assert.strictEqual(stale.status, 409); assert.ok(C.checkError('stale', stale.json).ok);
    assert.strictEqual(stale.json.headRev, 1); assert.strictEqual(stale.json.head.coreHash, core.hash);
    const head = (await br.call('GET', '/projects/' + pid + '/head')).json;
    assert.ok(C.checkShape('Head', head).ok);
    assert.strictEqual(head.coreInline, core.z.toString('base64'), 'the inline core comes back with the head');
    assert.deepStrictEqual(head.parts, [{ name: 'well/w1', hash: w1.hash, bytes: w1.bytes }]);
    const noop = await br.call('POST', '/projects/' + pid + '/commit', commitBody(1, core, [w1], { reason: 'auto' }));
    assert.strictEqual(noop.json.rev, 1, 'an auto commit with the head vhash is a no-op');
    const core2 = part({ wells: ['w1'], job: { a: 2 } });
    const r2 = await br.call('POST', '/projects/' + pid + '/commit', commitBody(1, core2, [w1], { reason: 'auto' }));
    assert.strictEqual(r2.json.rev, 2);
    const revs = await br.call('GET', '/projects/' + pid + '/revs');
    assert.ok(C.checkShape('RevList', revs.json).ok); assert.deepStrictEqual(revs.json.map((x) => x.rev), [2, 1]);
    const rev1 = await br.call('GET', '/projects/' + pid + '/rev/1');
    assert.strictEqual(rev1.json.coreHash, core.hash); assert.strictEqual(rev1.json.coreInline, core.z.toString('base64'));
    assert.strictEqual((await br.call('GET', '/projects/' + pid + '/rev/9')).status, 404);
    // restore a revision: a new head with reason restore, idempotent by pushId
    const pushId = crypto.randomUUID();
    const rr = await br.call('POST', '/projects/' + pid + '/restore-rev', { rev: 1, pushId });
    assert.strictEqual(rr.json.rev, 3);
    assert.strictEqual((await br.call('POST', '/projects/' + pid + '/restore-rev', { rev: 1, pushId })).json.rev, 3);
    const h3 = (await br.call('GET', '/projects/' + pid + '/head')).json;
    assert.strictEqual(h3.coreHash, core.hash); assert.strictEqual(h3.coreInline, core.z.toString('base64'));
    assert.strictEqual((await br.call('GET', '/projects/' + pid + '/revs')).json[0].reason, 'restore');
    // a bad inline core
    const bad = commitBody(3, core2, [w1]); bad.core.zsha = sha('x');
    assert.strictEqual((await br.call('POST', '/projects/' + pid + '/commit', bad)).json.error, 'bad_request');
    // the device's base is recorded (never pruned)
    const dev = await T.db.sql`select last_base_rev from wts.devices where device_id = ${br.device}`;
    assert.strictEqual(Number(dev[0].last_base_rev[pid]), 3);
  });

  test('blobs: immutable once complete, a different chunk body is refused, a repeat is 204, chunk SHA and zsha checked, encrypted objects with AAD', async () => {
    const p = part({ k: 'immutable', pad: crypto.randomBytes(1500).toString('hex') });
    assert.strictEqual((await upload(br, p, 700)).status, 204);
    const c0 = p.z.subarray(0, 700);
    const same = await br.call('PUT', '/blobs/' + p.hash + '/0?of=' + Math.ceil(p.z.length / 700), null, { raw: c0, ct: 'application/octet-stream', headers: { 'x-wts-zsha': p.zsha, 'x-wts-chunk-sha': sha(c0) } });
    assert.strictEqual(same.status, 204);
    const diff = Buffer.from(c0); diff[0] ^= 1;
    const imm = await br.call('PUT', '/blobs/' + p.hash + '/0?of=' + Math.ceil(p.z.length / 700), null, { raw: diff, ct: 'application/octet-stream', headers: { 'x-wts-zsha': p.zsha, 'x-wts-chunk-sha': sha(diff) } });
    assert.strictEqual(imm.status, 409); assert.strictEqual(imm.json.error, 'immutable');
    const wrongSha = await br.call('PUT', '/blobs/' + 'a'.repeat(64) + '/0?of=1', null, { raw: c0, ct: 'application/octet-stream', headers: { 'x-wts-zsha': p.zsha, 'x-wts-chunk-sha': sha('other') } });
    assert.strictEqual(wrongSha.json.error, 'bad_request');
    // a stream that does not match its zsha is dropped
    const q = part({ k: 'mismatch' });
    const qz = await br.call('PUT', '/blobs/' + q.hash + '/0?of=1', null, { raw: q.z, ct: 'application/octet-stream', headers: { 'x-wts-zsha': sha('nope'), 'x-wts-chunk-sha': sha(q.z) } });
    assert.strictEqual(qz.status, 400); assert.strictEqual(qz.json.field, 'zsha');
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.blobs where hash = ${Buffer.from(q.hash, 'hex')}`)[0].n, 0);
    // read back: chunk bytes, headers
    const g = await br.call('GET', '/blobs/' + p.hash + '/1');
    assert.strictEqual(g.status, 200); assert.strictEqual(g.headers['Content-Type'], 'application/octet-stream');
    assert.ok(g.body.equals(p.z.subarray(700, 1400))); assert.strictEqual(g.headers['X-WTS-Zsha'], p.zsha);
    assert.strictEqual(g.headers['X-WTS-Of'], String(Math.ceil(p.z.length / 700)));
    assert.strictEqual((await other.call('GET', '/blobs/' + p.hash + '/0')).status, 404, 'per user: another account sees nothing');
    // the object is encrypted under the per-user data key; the AAD binds user, hash and index
    const uid = await T.userId('pam@company.example');
    const key = 'u/' + uid + '/b/' + p.hash + '/1';
    const obj = await T.objects.get(key);
    assert.ok(obj && !obj.includes(p.z.subarray(700, 1400)));
    const hdr = E.chunkHeader(obj).header;
    assert.deepStrictEqual(Object.keys(hdr).sort(), ['alg', 'dkv', 'iv', 'kid', 'v']);
    await T.objects.put('u/' + uid + '/b/' + p.hash + '/0', obj);            // swap chunk 1 into slot 0
    assert.strictEqual((await br.call('GET', '/blobs/' + p.hash + '/0')).status, 500, 'a swapped chunk fails its tag');
  });

  test('trash → 410 gone, restore, purge needs step-up and releases blob references; duplicate references the same blobs', async () => {
    const pid = (await br.call('POST', '/projects', { name: 'T1', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    const core = part({ t: 1 }); const w = part({ t: 'w' });
    await upload(br, w);
    assert.strictEqual((await br.call('POST', '/projects/' + pid + '/commit', commitBody(0, core, [w]))).status, 200);
    const dup = await br.call('POST', '/projects/' + pid + '/duplicate', { name: 'T1 copy' });
    assert.strictEqual(dup.status, 201); assert.strictEqual(dup.json.headRev, 1);
    const dh = (await br.call('GET', '/projects/' + dup.json.id + '/head')).json;
    assert.strictEqual(dh.coreHash, core.hash);
    const refs = async () => Number((await T.db.sql`select refcount from wts.blobs where hash = ${Buffer.from(w.hash, 'hex')}`)[0].refcount);
    assert.strictEqual(await refs(), 2, 'two revisions reference the part');
    assert.strictEqual((await br.call('POST', '/projects/' + pid + '/rename', { name: 'T1 renamed' })).status, 200);
    assert.strictEqual((await br.call('POST', '/projects/' + pid + '/trash', {})).status, 200);
    const g = await br.call('GET', '/projects/' + pid + '/head');
    assert.strictEqual(g.status, 410); assert.strictEqual(g.json.error, 'gone');
    assert.strictEqual((await br.call('POST', '/projects/' + pid + '/commit', commitBody(1, core, [w]))).status, 410);
    assert.ok((await br.call('GET', '/projects?trash=1')).json.some((p) => p.id === pid && p.name === 'T1 renamed'));
    assert.ok(!(await br.call('GET', '/projects')).json.some((p) => p.id === pid));
    assert.strictEqual((await br.call('POST', '/projects/' + pid + '/restore', {})).status, 200);
    assert.strictEqual((await br.call('GET', '/projects/' + pid + '/head')).status, 200);
    await T.age`update wts.sessions set stepup_at = now() - interval '11 minutes'`;
    assert.strictEqual((await br.call('POST', '/projects/' + pid + '/purge', {})).json.error, 'reauth');
    await T.stepUp(br);
    assert.strictEqual((await br.call('POST', '/projects/' + pid + '/purge', {})).status, 200);
    assert.strictEqual((await br.call('GET', '/projects/' + pid + '/head')).status, 404);
    assert.strictEqual(await refs(), 1, 'purge released its reference');
  });

  test('quota: a chunk over the quota and a commit over it answer 413 quota; ≤ 200 projects', async () => {
    const q = T.browser(); await T.signIn(q, 'quinn@company.example');
    const uid = await T.userId('quinn@company.example');
    await T.db.sql`update wts.users set quota_bytes = 400 where id = ${uid}`;
    const big = part({ x: crypto.randomBytes(800).toString('hex') });
    const r = await upload(q, big);
    assert.strictEqual(r.status, 413); assert.ok(C.checkError('quota', r.json).ok); assert.strictEqual(r.json.limit, 400);
    await T.db.sql`update wts.users set quota_bytes = 250000000, used_bytes = 250000001 where id = ${uid}`;
    const pid = (await q.call('POST', '/projects', { name: 'Q', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    const core = part({ q: 1 });
    const c = await q.call('POST', '/projects/' + pid + '/commit', commitBody(0, core, []));
    assert.strictEqual(c.status, 413); assert.strictEqual(c.json.error, 'quota');
    await T.db.sql`update wts.users set used_bytes = 0 where id = ${uid}`;
    await T.db.sql`insert into wts.projects (id, user_id, meta_enc, created_at, modified_at) select gen_random_uuid(), ${uid}, '\\x00', now(), now() from generate_series(1, 199)`;
    const over = await q.call('POST', '/projects', { name: 'one too many', meta: { client: '', well: '', field: '', operator: '' } });
    assert.strictEqual(over.status, 413); assert.strictEqual(over.json.error, 'quota');
  });

  test('quota counts unfinished uploads in the chunk PUT; the daily job drops unfinished uploads after 24 h (row and objects)', async () => {
    const q = T.browser(); await T.signIn(q, 'una@company.example');
    const uid = await T.userId('una@company.example');
    await T.db.sql`update wts.users set quota_bytes = 2500 where id = ${uid}`;
    const a = part({ a: crypto.randomBytes(3000).toString('base64') });
    const b = part({ b: crypto.randomBytes(3000).toString('base64') });
    const put = (p, n, size) => {
      const of = Math.ceil(p.z.length / size); const c = p.z.subarray(n * size, (n + 1) * size);
      return q.call('PUT', '/blobs/' + p.hash + '/' + n + '?of=' + of, null, { raw: c, ct: 'application/octet-stream', headers: { 'x-wts-zsha': p.zsha, 'x-wts-chunk-sha': sha(c) } });
    };
    assert.strictEqual((await put(a, 0, 1000)).status, 204);
    assert.strictEqual((await put(b, 0, 1000)).status, 204);
    const third = await put(b, 1, 1000);
    assert.strictEqual(third.status, 413, 'used 0 + unfinished 2000 + 1000 > 2500'); assert.strictEqual(third.json.error, 'quota');
    assert.strictEqual(Number((await T.db.sql`select used_bytes from wts.users where id = ${uid}`)[0].used_bytes), 0, 'nothing is complete');
    await T.age`update wts.blobs set created_at = now() - interval '25 hours' where user_id = ${uid} and not complete`;
    const d = await T.jobs.run({ only: ['blobs'] });
    assert.strictEqual(d.blobs.unfinished, 2);
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.blobs where user_id = ${uid}`)[0].n, 0);
    assert.deepStrictEqual(await T.objects.list('u/' + uid + '/b/'), [], 'their objects are gone too');
    // more than 16 chunks (64 MB) is refused before anything is stored
    const r = await q.call('PUT', '/blobs/' + a.hash + '/0?of=17', null, { raw: a.z.subarray(0, 10), ct: 'application/octet-stream', headers: { 'x-wts-zsha': a.zsha, 'x-wts-chunk-sha': sha(a.z.subarray(0, 10)) } });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.json.field, 'of');
  });

  test('T15: the blob clean-up deletes the row first; a commit after it answers missing_blobs; a commit holding the blob makes it skip', async () => {
    const q = T.browser(); await T.signIn(q, 'vic@company.example');
    const uid = await T.userId('vic@company.example');
    const p1 = part({ race: 1, pad: crypto.randomBytes(400).toString('hex') });
    assert.strictEqual((await upload(q, p1)).status, 204);
    const hb = Buffer.from(p1.hash, 'hex');
    await T.age`update wts.blobs set unref_at = now() - interval '8 days' where user_id = ${uid} and hash = ${hb}`;
    // the client's has says present …
    assert.deepStrictEqual((await q.call('POST', '/blobs/has', { hashes: [p1.hash] })).json.missing, []);
    // … the job runs in between …
    assert.strictEqual((await T.jobs.run({ only: ['blobs'] })).blobs.blobs, 1);
    // … and the commit is refused, so the client uploads again (no head over missing chunks)
    const pid = (await q.call('POST', '/projects', { name: 'Race', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    const core = part({ race: 'core' });
    const c1 = await q.call('POST', '/projects/' + pid + '/commit', commitBody(0, core, [p1]));
    assert.strictEqual(c1.status, 422); assert.deepStrictEqual(c1.json.missing, [p1.hash]);
    assert.strictEqual((await upload(q, p1)).status, 204);
    assert.strictEqual((await q.call('POST', '/projects/' + pid + '/commit', commitBody(0, core, [p1]))).status, 200);
    assert.ok(await T.objects.get('u/' + uid + '/b/' + p1.hash + '/0'));
    // a commit holding the row FOR SHARE: the job's delete waits, then skips the row that is referenced again
    const p2 = part({ race: 2, pad: crypto.randomBytes(400).toString('hex') });
    assert.strictEqual((await upload(q, p2)).status, 204);
    const hb2 = Buffer.from(p2.hash, 'hex');
    await T.age`update wts.blobs set unref_at = now() - interval '8 days' where user_id = ${uid} and hash = ${hb2}`;
    let job = null;
    await T.db.sql.begin(async (tx) => {
      assert.strictEqual((await tx`select 1 from wts.blobs where user_id = ${uid} and hash = ${hb2} and complete for share`).length, 1);
      job = T.jobs.run({ only: ['blobs'] });
      await new Promise((r) => setTimeout(r, 300));
      await tx`update wts.blobs set refcount = 1, unref_at = null where user_id = ${uid} and hash = ${hb2}`;
    });
    const d = await job;
    assert.strictEqual(d.blobs.blobs, 0, 'skipped');
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.blobs where user_id = ${uid} and hash = ${hb2}`)[0].n, 1);
    assert.ok(await T.objects.get('u/' + uid + '/b/' + p2.hash + '/0'), 'its chunks are still there');
  });

  test('head: coreInline also for a small core uploaded as a blob; GET head does not write the device base', async () => {
    const q = T.browser(); await T.signIn(q, 'wes@company.example');
    const uid = await T.userId('wes@company.example');
    const pid = (await q.call('POST', '/projects', { name: 'Small', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    const core = part({ small: 'core' });
    assert.strictEqual((await upload(q, core)).status, 204);
    assert.strictEqual((await q.call('POST', '/projects/' + pid + '/commit', commitBody(0, core, [], { inline: false }))).status, 200);
    await T.db.sql`update wts.devices set last_base_rev = '{}'::jsonb where user_id = ${uid}`;
    const h = (await q.call('GET', '/projects/' + pid + '/head')).json;
    assert.strictEqual(h.coreInline, core.z.toString('base64'));
    const dev = await T.db.sql`select last_base_rev from wts.devices where user_id = ${uid}`;
    assert.ok(dev.every((d) => !d.last_base_rev || d.last_base_rev[pid] === undefined), 'a GET changes no state (§3.2)');
  });

  test('revision retention: squash in the commit transaction, named saves kept, device bases kept, burst pins the previous head', async () => {
    const pid = (await br.call('POST', '/projects', { name: 'R', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    let rev = 0;
    for (let i = 0; i < 12; i++) {
      const core = part({ r: i });
      const res = await br.call('POST', '/projects/' + pid + '/commit', commitBody(rev, core, [], { reason: i === 0 ? 'save' : 'auto' }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.json)); rev = res.json.rev;
      if (rev === 4) {
        // another device of this user works from revision 4
        await T.age`insert into wts.devices (user_id, device_id, first_seen, last_seen, last_base_rev)
          select user_id, gen_random_uuid(), now(), now(), jsonb_build_object(${pid}::text, 4) from wts.projects where id = ${pid}`;
      }
    }
    const during = (await T.db.sql`select rev from wts.revisions where project_id = ${pid} order by rev`).map((r) => Number(r.rev));
    assert.ok(during.length < 12, 'auto revisions of one 10-minute bucket are squashed as they come: ' + during.join(','));
    assert.ok(during.includes(1) && during.includes(4) && during.includes(12), 'named save, device base and head kept: ' + during.join(','));
    // 12 commits in under 10 minutes: the 11th pinned the revision before it, and one burst notice went out
    const pinned = await T.db.sql`select rev from wts.revisions where project_id = ${pid} and pinned`;
    assert.ok(pinned.length >= 1, 'a burst pins the previous revision');
    assert.ok(T.lastMail('pam@company.example', 'notice_commit_burst'));
    // squash: age the auto revisions into one 10-minute bucket of yesterday-ish; the next commit prunes ≤ 10
    await T.age`update wts.revisions set saved_at = date_trunc('hour', now() - interval '3 hours'), pinned_until = null, pinned = false where project_id = ${pid} and rev > 1`;
    const res = await br.call('POST', '/projects/' + pid + '/commit', commitBody(rev, part({ r: 'last' }), [], { reason: 'auto' }));
    assert.strictEqual(res.status, 200);
    const left = (await T.db.sql`select rev, reason from wts.revisions where project_id = ${pid} order by rev`).map((r) => Number(r.rev));
    assert.ok(left.includes(1), 'the named save is kept');
    assert.ok(left.includes(4), 'a device base is never pruned');
    assert.ok(left.includes(res.json.rev), 'the head is kept');
    assert.ok(left.length <= 5, 'one auto revision per 10-minute bucket: ' + left.join(','));
    // refcounts follow the deletions
    const orphans = await T.db.sql`select count(*)::int as n from wts.blobs b where b.user_id = (select user_id from wts.projects where id = ${pid}) and b.refcount = 0 and b.unref_at is null`;
    assert.strictEqual(orphans[0].n, 0, 'an unreferenced blob carries unref_at');
  });

  test('library: CAS on the revision, stale answers rev and hash, pushId, body round trip; SYNC_MODE readonly / off', async () => {
    const h0 = await br.call('GET', '/library');
    assert.ok(C.checkShape('LibraryHead', h0.json).ok); assert.strictEqual(h0.json.rev, 0);
    assert.strictEqual((await br.call('GET', '/library/body')).status, 404);
    const z = zlib.gzipSync(Buffer.from('{"curves":[]}'));
    const body = { pushId: crypto.randomUUID(), baseRev: 0, hash: sha('{"curves":[]}'), body: z.toString('base64') };
    const c1 = await br.call('POST', '/library/commit', body);
    assert.strictEqual(c1.status, 200); assert.deepStrictEqual(c1.json, { rev: 1 });
    assert.deepStrictEqual((await br.call('POST', '/library/commit', body)).json, { rev: 1 }, 'pushId retry');
    const st = await br.call('POST', '/library/commit', Object.assign({}, body, { pushId: crypto.randomUUID() }));
    assert.strictEqual(st.status, 409); assert.strictEqual(st.json.rev, 1); assert.strictEqual(st.json.hash, body.hash);
    const got = await br.call('GET', '/library/body');
    assert.ok(got.body.equals(z));
    const z2 = zlib.gzipSync(Buffer.from('{"curves":[1]}'));
    assert.strictEqual((await br.call('POST', '/library/commit', { pushId: crypto.randomUUID(), baseRev: 1, hash: sha('{"curves":[1]}'), body: z2.toString('base64') })).json.rev, 2);
    const uid = await T.userId('pam@company.example');
    assert.strictEqual((await T.objects.list('u/' + uid + '/lib/')).length, 1, 'the previous body is removed after the commit');
    T.setEnv({ SYNC_MODE: 'readonly' });
    assert.strictEqual((await br.call('GET', '/library')).status, 200, 'reads still work');
    assert.strictEqual((await br.call('GET', '/projects')).status, 200);
    const ro = await br.call('POST', '/projects', { name: 'x', meta: { client: '', well: '', field: '', operator: '' } });
    assert.strictEqual(ro.status, 503); assert.strictEqual(ro.json.error, 'readonly');
    T.setEnv({ SYNC_MODE: 'off' });
    assert.strictEqual((await br.call('GET', '/projects')).json.error, 'paused');
    assert.strictEqual((await br.call('GET', '/me')).status, 200, 'the account page still answers');
    T.setEnv({ SYNC_MODE: 'on', ACCOUNTS_OFF: '1' });
    assert.strictEqual((await br.call('GET', '/me')).json.error, 'paused');
    assert.strictEqual((await br.call('GET', '/health')).status, 200);
    T.setEnv({ ACCOUNTS_OFF: '0' });
  });

  test('rate limits: commits per session per hour (429 with retryAfter); blob reads per session; 426 below the security minimum', async () => {
    const r = T.browser(); await T.signIn(r, 'rita@company.example');
    const pid = (await r.call('POST', '/projects', { name: 'L', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    const uid = await T.userId('rita@company.example');
    const sid = (await T.db.sql`select encode(sid_hash, 'hex') as h from wts.sessions where user_id = ${uid}`)[0].h.slice(0, 32);
    await T.db.sql`insert into wts.rate_counters (bucket, window_start, n) values (${'commitSessionHour:' + sid}, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 60)`;
    const c = await r.call('POST', '/projects/' + pid + '/commit', commitBody(0, part({ l: 1 }), []));
    assert.strictEqual(c.status, 429); assert.ok(C.checkError('rate', c.json).ok); assert.ok(c.json.retryAfter > 0 && c.json.retryAfter <= 3600);
    const p = part({ read: 'x'.repeat(2000) }); await upload(r, p);
    await T.db.sql`insert into wts.rate_counters (bucket, window_start, n) values (${'blobReadSessionHour:' + sid}, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 100000000)`;
    assert.strictEqual((await r.call('GET', '/blobs/' + p.hash + '/0')).status, 429);
    const old = await r.call('POST', '/projects/' + pid + '/commit', commitBody(0, part({ l: 2 }), []), { headers: { 'x-wts-app': '3.4' } });
    assert.strictEqual(old.status, 426); assert.strictEqual(old.json.error, 'upgrade');
  });
});
