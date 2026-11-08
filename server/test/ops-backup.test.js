'use strict';
// server/test/ops-backup.test.js — WP-OPS: the weekly encrypted export, the first restore drill, the deletion-ledger replay
// on restore, retention and the monitor's database metrics (docs/ACCOUNTS-PLAN.md §13.1, §13.5, §13.6), against the
// throwaway cluster of test/run.js (skips without one). The drill runs into a scratch database that it creates and drops.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const D = require('./_db');
const B = require('../site/backup');
const { findBin } = require('./_cluster');

const skip = !D.available() && 'no throwaway database (run through server/test/run.js)';
const key = (kid) => ({ kid, key: crypto.randomBytes(32) });

test('format: seal / open round trip, tamper and wrong key refused, pack names checked, key parsing', () => {
  const k1 = key(7); const k2 = key(8);
  const payload = B.pack([{ name: 'manifest.json', data: '{"a":1}' }, { name: 'objects/ledger/x', data: Buffer.from([0, 1, 2]) }]);
  const sealed = B.seal(payload, [k1]);
  assert.ok(sealed.subarray(0, 6).equals(Buffer.from('WTSX1\n')));
  assert.ok(!sealed.includes(Buffer.from('manifest.json')), 'names are encrypted too');
  const back = B.unpack(B.open(sealed, [k2, k1]));
  assert.deepStrictEqual(back.map((e) => e.name), ['manifest.json', 'objects/ledger/x']);
  assert.deepStrictEqual([...back[1].data], [0, 1, 2]);
  const t = Buffer.from(sealed); t[t.length - 30] ^= 1;
  assert.throws(() => B.open(t, [k1]), /authentication failed/);
  const h = Buffer.from(sealed); const i = h.indexOf(Buffer.from('"kid":7')); h[i + 6] = 0x39;   // header is authenticated (kid 9 unknown)
  assert.throws(() => B.open(h, [k1]), /no key with kid 9/);
  assert.throws(() => B.open(sealed, [key(7)]), /authentication failed/, 'same kid, other key');
  assert.throws(() => B.pack([{ name: '../x', data: '' }]), /bad entry name/);
  assert.throws(() => B.open(Buffer.from('nope'), [k1]), /not an export file/);
  assert.deepStrictEqual(B.parseKeys('3:' + crypto.randomBytes(32).toString('base64')).map((k) => k.kid), [3]);
  assert.throws(() => B.parseKeys(''), /not set/); assert.throws(() => B.parseKeys('1:abcd'), /32-byte/);
});

test.describe('export, restore drill and ledger replay (§13.5)', { skip }, () => {
  let H = null; let tmp = null; const bin = findBin();
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const objects = new Map();
  const store = {
    async list(p) { return Array.from(objects.keys()).filter((k) => k.startsWith(p)).sort(); },
    async get(k) { return objects.has(k) ? Buffer.from(objects.get(k)) : null; },
  };
  test.before(async () => {
    H = await D.freshDatabase('opsbackup');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-exp-'));
    await H.admin.sql.unsafe(fs.readFileSync(path.join(__dirname, '..', 'ops', 'sql', 'backup-role.sql'), 'utf8'));
    const sql = H.admin.sql;
    for (const id of ids) {
      await sql`insert into wts.users (id, email_bidx, email_enc, terms_version, privacy_version, consented_at, data_key_wrapped, data_key_kid, used_bytes)
                values (${id}, ${crypto.randomBytes(32)}, ${Buffer.from('enc')}, '1', '1', now(), ${Buffer.from('k')}, 1, 1000)`;
      await sql`insert into wts.projects (id, user_id, meta_enc, created_at, modified_at) values (${crypto.randomUUID()}, ${id}, ${Buffer.from('m')}, now(), now())`;
      await sql`insert into wts.audit (user_id, actor, action, at, hash) values (${id}, 'user', 'signin', now(), ${crypto.randomBytes(32)})`;
      objects.set('u/' + id + '/b/' + 'cd'.repeat(32) + '/0', Buffer.from('chunk'));
    }
    // the third account was purged AFTER this data was captured: its ledger object exists, its rows are still in the dump
    objects.set('ledger/' + ids[2], Buffer.from(JSON.stringify({ v: 1, userId: ids[2], requestedAt: '2026-11-01T00:00:00.000Z', purgeAt: '2026-11-08T00:00:00.000Z', purgedAt: '2026-11-08T03:17:00.000Z' })));
    objects.set('chain/2026-11-08', Buffer.from('{"v":1,"root":"ab"}'));
    await sql`insert into wts.mail_outbox (id, to_enc, template, created_at) values (${crypto.randomUUID()}, ${Buffer.from('t')}, 'code_signin', now() - interval '20 minutes')`;
  });
  test.after(async () => { if (H) await H.close(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('weekly export as the read-only backup role, retention of 28 days, then the drill restores, replays and drops', async () => {
    const keys = [key(1)];
    const conn = Object.assign({}, H.conn, { user: 'wts_backup' });
    const r = await B.exportDatabase({ conn, pgBin: bin, objects: store });
    assert.strictEqual(r.manifest.counts.users, 3); assert.strictEqual(r.manifest.counts.audit, 3);
    assert.deepStrictEqual(r.manifest.objects, { ledger: 1, chain: 1 });
    assert.strictEqual(r.manifest.blobKeys, 3);
    assert.ok(r.manifest.migrations.length >= 1 && r.manifest.auditDigest);
    const old = path.join(tmp, 'wts-export-20200101T000000Z.wtsx'); fs.writeFileSync(old, 'old');
    const recent = path.join(tmp, 'wts-export-' + B.stamp(Date.now() - 3 * 86400000) + '.wtsx'); fs.writeFileSync(recent, 'recent');
    const w = B.writeExport({ entries: r.entries, keys, dir: tmp });
    assert.deepStrictEqual(w.pruned, ['wts-export-20200101T000000Z.wtsx'], 'files older than 28 days pruned');
    assert.ok(fs.existsSync(recent) && fs.existsSync(w.file));
    assert.strictEqual(B.newestExport(tmp).name, path.basename(w.file));
    assert.strictEqual(fs.statSync(w.file).mode & 0o077, 0, 'export file readable by the owner only');
    const raw = fs.readFileSync(w.file);
    assert.ok(!raw.includes(Buffer.from('code_signin')) && !raw.includes(Buffer.from(ids[0])), 'nothing readable without the key');

    const report = await B.restoreDrill({ file: w.file, keys, adminUrl: Object.assign({}, H.conn), pgBin: bin, env: {} });
    assert.ok(report.ok, JSON.stringify(report.mismatches));
    assert.strictEqual(report.tables.users, 3, 'restored as exported');
    assert.strictEqual(report.ledger.objects, 1); assert.strictEqual(report.ledger.replayed, 1); assert.strictEqual(report.ledger.remaining, 0);
    assert.strictEqual(report.blobKeys, 3); assert.strictEqual(report.dropped, true);
    assert.ok(/^wts_drill_[0-9a-f]{10}$/.test(report.scratch));
    const left = await H.admin.sql`select count(*)::int as n from pg_database where datname like 'wts_drill_%'`;
    assert.strictEqual(left[0].n, 0, 'the scratch database is dropped');
    const src = await H.admin.sql`select count(*)::int as n from wts.users`;
    assert.strictEqual(src[0].n, 3, 'the source was never touched');

    // isolation of the drill target
    await assert.rejects(B.restoreDrill({ file: w.file, keys, adminUrl: 'scheme://admin@db.remote.example:5432/x', pgBin: bin, env: {} }), /loopback/);
    const url = 'scheme://wts_admin@127.0.0.1:' + H.conn.port + '/template1';
    await assert.rejects(B.restoreDrill({ file: w.file, keys, adminUrl: url, pgBin: bin, env: { WTS_DB_URL: url } }), /equals WTS_DB_URL/);
    await assert.rejects(B.restoreDrill({ file: w.file, keys: [key(1)], adminUrl: H.conn, pgBin: bin, env: {} }), /authentication failed/);

    // the scripts read everything from the environment
    const drillScript = require('../ops/restore-drill');
    const env = { WTS_BACKUP_KEY: '1:' + keys[0].key.toString('base64'), WTS_DRILL_ADMIN_URL: 'scheme://wts_admin@127.0.0.1:' + H.conn.port + '/template1', WTS_PG_BIN: bin };
    // (the driver needs its own scheme for a URL; the object form above is what the tests use — check the argument handling only)
    await assert.rejects(drillScript.main([], env), /usage/);
    await assert.rejects(drillScript.main(['--latest', path.join(tmp, 'none')], env), /no export file/);
  });

  test('monitor-check reads aggregate metrics with the jobs credential and alerts on an old outbox', async () => {
    const MC = require('../ops/monitor-check');
    const jobs = H.as('wts_jobs');
    const log = []; const r = await MC.check({ db: jobs, env: { WTS_EXPORT_DIR: tmp }, dry: true, log: { warn: (m) => log.push(m) } });
    assert.ok(r.metrics.outboxAgeMin > 5, JSON.stringify(r.metrics));
    assert.ok(r.alerts.includes('outboxAge'), JSON.stringify(r.alerts));
    assert.ok(r.metrics.exportAgeDays < 1, 'a fresh export exists');
    assert.strictEqual(r.metrics.codeSendsHour, 0);
    assert.ok(!JSON.stringify(r).includes('@'), 'counts only');
  });
});

test('call-daily signs the ops call exactly as core/http.js verifies it', async () => {
  const { signedRequest } = require('../ops/call-daily');
  const H2 = require('../core/http');
  const k = crypto.randomBytes(32);
  const now = Date.now();
  const r = signedRequest('https://welltest.h2oil.co.uk/', k.toString('base64'), now);
  assert.strictEqual(r.url, 'https://welltest.h2oil.co.uk/api/v1/ops/daily');
  const req = { method: 'POST', headers: Object.fromEntries(Object.entries(r.init.headers).map(([a, b]) => [a.toLowerCase(), b])) };
  const ok = await H2.verifyOps(req, '/api/v1/ops/daily', { secrets: { opsHmac: k } }, now, H2.memoryNonceStore());
  assert.strictEqual(ok, true);
  assert.throws(() => signedRequest('https://x.example', ''), /WTS_OPS_HMAC/);
});
