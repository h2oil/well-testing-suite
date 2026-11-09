'use strict';
// server/test/core.test.js — core units without a database (docs/ACCOUNTS-PLAN.md §12.4): envelope round trips, AAD tamper,
// dual read by kid / dkv and rotation, keys and pepper rotation, revision retention, object keys, the generic browser
// family, csp-report sanitising, the Merkle root of the audit anchor.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../core/envelope');
const { createKeys } = require('../core/keys');
const { loadConfig } = require('../core/config');
const { planPrune } = require('../core/revisions');
const { KEYS, memoryObjects, fsObjects } = require('../core/objects');
const S = require('../core/service');
const CSP = require('../functions/csp-report')._internal;
const J = require('../core/jobs');

const k32 = () => crypto.randomBytes(32);
const b64 = (b) => b.toString('base64');

test('envelope: key ring, fields, system values and chunks round-trip; the AAD binds field, user, hash, index and kid', () => {
  const m1 = { kid: 1, key: k32() };
  const dk = E.newDataKey();
  const ring = E.wrapRing([{ dkv: 1, key: dk }], m1);
  const keys = E.unwrapRing(ring, (k) => (k === 1 ? m1.key : null)).keys;
  assert.ok(keys.get(1).equals(dk));
  assert.throws(() => E.unwrapRing(ring, () => null), /not loaded/);
  const f = E.sealField(dk, 1, 'user.address', 'name@company.example');
  assert.strictEqual(E.openField(keys, 'user.address', f).toString(), 'name@company.example');
  assert.throws(() => E.openField(keys, 'project.meta', f), 'a value moved to another column does not open');
  const other = E.unwrapRing(E.wrapRing([{ dkv: 1, key: E.newDataKey() }], m1), () => m1.key).keys;
  assert.throws(() => E.openField(other, 'user.address', f), 'another user\'s key does not open it');
  const sys = E.sealSystem(m1, 'mail.to', 'x@company.example');
  assert.strictEqual(E.openSystem((k) => (k === 1 ? m1.key : null), 'mail.to', sys).toString(), 'x@company.example');
  assert.throws(() => E.openSystem(() => m1.key, 'mail.params', sys));
  const uid = crypto.randomUUID(); const hash = 'a'.repeat(64);
  const plain = crypto.randomBytes(1000);
  const c = E.sealChunk({ dataKey: dk, dkv: 1, kid: 1, userId: uid, hash, n: 3 }, plain);
  assert.ok(E.openChunk(keys, { userId: uid, hash, n: 3 }, c).equals(plain));
  const h = E.chunkHeader(c).header;
  assert.deepStrictEqual([h.v, h.alg, h.kid, h.dkv], [1, 'A256GCM', 1, 1]);
  assert.throws(() => E.openChunk(keys, { userId: crypto.randomUUID(), hash, n: 3 }, c), 'another user');
  assert.throws(() => E.openChunk(keys, { userId: uid, hash: 'b'.repeat(64), n: 3 }, c), 'another hash');
  assert.throws(() => E.openChunk(keys, { userId: uid, hash, n: 4 }, c), 'another index');
  const t = Buffer.from(c); t[t.length - 20] ^= 1;
  assert.throws(() => E.openChunk(keys, { userId: uid, hash, n: 3 }, t), 'a flipped bit');
  // the header kid is in the AAD: a header edited to name another kid fails
  const hl = c.readUInt16BE(0);
  const hdr = JSON.parse(c.subarray(2, 2 + hl).toString()); hdr.kid = 2;
  const nh = Buffer.from(JSON.stringify(hdr)); const len = Buffer.alloc(2); len.writeUInt16BE(nh.length);
  assert.throws(() => E.openChunk(keys, { userId: uid, hash, n: 3 }, Buffer.concat([len, nh, c.subarray(2 + hl)])), 'kid bound by the AAD');
});

test('envelope: dual read by dkv during a re-key; rotation re-wraps every entry and the old kid can be retired', () => {
  const m1 = { kid: 1, key: k32() }; const m2 = { kid: 2, key: k32() };
  const d1 = E.newDataKey(); const d2 = E.newDataKey();
  const uid = crypto.randomUUID(); const hash = 'c'.repeat(64);
  const old = E.sealChunk({ dataKey: d1, dkv: 1, kid: 1, userId: uid, hash, n: 0 }, Buffer.from('old'));
  // compromise re-key: a second data key version joins the ring; new chunks use dkv 2, old ones still read
  const ring2 = E.wrapRing([{ dkv: 1, key: d1 }, { dkv: 2, key: d2 }], m2);
  const keys = E.unwrapRing(ring2, (k) => (k === 2 ? m2.key : null)).keys;
  const neu = E.sealChunk({ dataKey: d2, dkv: 2, kid: 2, userId: uid, hash, n: 1 }, Buffer.from('new'));
  assert.strictEqual(E.openChunk(keys, { userId: uid, hash, n: 0 }, old).toString(), 'old');
  assert.strictEqual(E.openChunk(keys, { userId: uid, hash, n: 1 }, neu).toString(), 'new');
  assert.deepStrictEqual(E.ringKids(ring2), [2, 2]);
  // rotation: kid 1 → kid 3, then kid 1 is not needed any more
  const r1 = E.wrapRing([{ dkv: 1, key: d1 }], m1);
  const m3 = { kid: 3, key: k32() };
  const r3 = E.rewrapRing(r1, (k) => (k === 1 ? m1.key : null), m3);
  assert.deepStrictEqual(E.ringKids(r3), [3]);
  assert.ok(E.unwrapRing(r3, (k) => (k === 3 ? m3.key : null)).keys.get(1).equals(d1));
  // after a re-encryption the old version is dropped from the ring
  const only2 = E.rewrapRing(ring2, (k) => (k === 2 ? m2.key : null), m2, [2]);
  assert.throws(() => E.openChunk(E.unwrapRing(only2, () => m2.key).keys, { userId: uid, hash, n: 0 }, old), /not in the ring/);
});

test('keys: secrets only from the environment; a rotated code pepper still verifies; ephemeral keys only outside production', () => {
  const p1 = b64(k32()); const p2 = b64(k32()); const ip = b64(k32()); const mk = b64(k32());
  const a = createKeys(loadConfig({ WTS_ENV: 'test', WTS_MASTER_KEYS: '1:' + mk, WTS_INDEX_PEPPER: ip, WTS_CODE_PEPPERS: '1:' + p1 }));
  const b = createKeys(loadConfig({ WTS_ENV: 'test', WTS_MASTER_KEYS: '1:' + mk, WTS_INDEX_PEPPER: ip, WTS_CODE_PEPPERS: '1:' + p1 + ',2:' + p2 }));
  assert.ok(a.ready && !a.ephemeral);
  assert.ok(a.emailBidx('n@company.example').equals(b.emailBidx('n@company.example')), 'the index is stable');
  const issued = a.codeHmac('signin', 'n@company.example', '12345678');
  assert.strictEqual(issued.kid, 1);
  assert.ok(b.codeCandidates('signin', ['n@company.example'], '12345678').some((h) => h.equals(issued.hmac)), 'the previous pepper still verifies');
  assert.strictEqual(b.codeHmac('signin', 'n@company.example', '12345678').kid, 2, 'new codes use the newest pepper');
  const bound = a.codeHmac('stepup', 'n@company.example', '12345678', { user: 'u', sid: Buffer.alloc(32, 1) }).hmac;
  assert.ok(!a.codeCandidates('stepup', ['n@company.example'], '12345678', { user: 'u', sid: Buffer.alloc(32, 2) }).some((h) => h.equals(bound)), 'bound to the session');
  assert.strictEqual(a.sidHash('abc').toString('hex'), crypto.createHash('sha256').update('abc').digest('hex'), 'sid_hash = SHA-256(id)');
  const prod = createKeys(loadConfig({ WTS_ENV: 'production', WTS_PROXY_SIG: 'x' }));
  assert.strictEqual(prod.ready, false); assert.deepStrictEqual(prod.missing.sort(), ['WTS_CODE_PEPPERS', 'WTS_INDEX_PEPPER', 'WTS_MASTER_KEYS']);
  assert.throws(() => prod.emailBidx('x@company.example'), /not configured/);
  const local = createKeys(loadConfig({ WTS_ENV: 'local' }));
  assert.ok(local.ready && local.ephemeral, 'a local run works with ephemeral keys');
  const m2 = createKeys(loadConfig({ WTS_ENV: 'test', WTS_MASTER_KEYS: '1:' + mk + ',7:' + b64(k32()), WTS_INDEX_PEPPER: ip, WTS_CODE_PEPPERS: '1:' + p1 }));
  assert.strictEqual(m2.master.current.kid, 7, 'the highest kid is current unless WTS_MASTER_KID says otherwise');
});

test('revision retention plan: head, device bases and pins kept; named saves 30 days; auto: one per 10-min bucket (24 h), one per day (30 days)', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0, 0); const MIN = 60e3; const DAY = 86400e3;
  const revs = [];
  let rev = 0;
  const add = (age, reason, pin) => revs.push({ rev: ++rev, reason, savedAt: now - age, pinnedUntil: pin || null });
  add(40 * DAY, 'save'); add(20 * DAY, 'save'); add(31 * DAY, 'auto'); add(5 * DAY + 2 * 3600e3, 'auto'); add(5 * DAY + 3600e3, 'auto');
  add(3 * 3600e3 + 5 * MIN, 'auto'); add(3 * 3600e3 + 2 * MIN, 'auto'); add(3 * 3600e3 + MIN, 'auto'); add(2 * MIN, 'auto', now + DAY); add(MIN, 'auto');
  const drop = planPrune(revs, { now, head: 10, protect: new Set([4]) });
  assert.ok(drop.includes(1), 'a named save older than 30 days goes');
  assert.ok(!drop.includes(2), 'a named save inside 30 days stays');
  assert.ok(drop.includes(3), 'an auto revision older than 30 days goes');
  assert.ok(!drop.includes(4), 'a device base stays (it would otherwise be dropped: an older revision of the same day)');
  assert.ok(!drop.includes(5), 'the newest of a day stays');
  assert.deepStrictEqual([6, 7, 8].filter((r) => !drop.includes(r)).length, 1, 'one per 10-minute bucket');
  assert.ok(!drop.includes(9) && !drop.includes(10), 'pinned and head stay');
  assert.strictEqual(planPrune(revs, { now, head: 10, max: 2 }).length, 2, 'at most max rows per call');
});

test('object store: keys only from a user id, a hash and an index; no traversal; memory and folder stores agree', async () => {
  const uid = crypto.randomUUID();
  assert.strictEqual(KEYS.blob(uid, 'a'.repeat(64), 2), 'u/' + uid + '/b/' + 'a'.repeat(64) + '/2');
  assert.throws(() => KEYS.blob('../x', 'a'.repeat(64), 0));
  assert.throws(() => KEYS.blob(uid, '../../etc', 0));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-obj-'));
  try {
    for (const st of [memoryObjects(), fsObjects(dir)]) {
      const k = KEYS.blob(uid, 'b'.repeat(64), 0);
      await st.put(k, Buffer.from('x'));
      assert.strictEqual((await st.get(k)).toString(), 'x');
      await st.put(KEYS.ledger(uid), Buffer.from('{}'));
      assert.deepStrictEqual(await st.list('u/' + uid + '/'), [k]);
      assert.strictEqual(await st.delPrefix('u/' + uid + '/'), 1);
      assert.strictEqual(await st.get(k), null);
      await assert.rejects(st.get('../../etc/passwd'), /bad key/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generic words in mails and device rows (no product names); csp-report keeps a directive and a host only; Merkle root', () => {
  const desk = S.uaFamily('Mozilla/5.0 (X11; Linux x86_64) Something/1.0');
  const mob = S.uaFamily('Mozilla/5.0 (Mobile) Something/1.0');
  assert.deepStrictEqual([desk.browser, desk.os, mob.os], ['a web browser', 'a computer', 'a phone or tablet']);
  assert.match(S.whenText(Date.UTC(2026, 10, 8, 9, 5)), /^2026-11-08 09:05 UTC$/);
  assert.strictEqual(CSP.hostOf('https://cdn.example/x.js?token=1'), 'cdn.example');
  assert.strictEqual(CSP.hostOf('inline'), 'inline');
  assert.strictEqual(CSP.hostOf('javascript:alert(1)'), 'other');
  assert.deepStrictEqual(CSP.reports({ 'csp-report': { 'violated-directive': 'img-src https:', 'blocked-uri': 'data' } }), [{ d: 'img-src', h: 'data' }]);
  assert.deepStrictEqual(CSP.reports({ 'csp-report': { 'effective-directive': '<script>', 'blocked-uri': 'x' } }), [{ d: 'other', h: 'other' }]);
  assert.strictEqual(J.merkle(['a', 'b', 'c']), J.merkle(['a', 'b', 'c']));
  assert.notStrictEqual(J.merkle(['a', 'b', 'c']), J.merkle(['a', 'c', 'b']));
});
