'use strict';
// server/site/backup.js — the weekly encrypted export and the restore drill (docs/ACCOUNTS-PLAN.md §13.1, §13.4, §13.5; WP-OPS).
//
// Export (weekly, server/ops/weekly-export.js): a logical dump of the whole database (the engine's own dump tool, custom
// format), the blob manifest (every object key of the blob store, so a restore can be checked against the blob copy), the
// append-only deletion-ledger objects and the audit-anchor objects, plus a manifest with per-table row counts and a digest
// of the audit hash chain. Everything is packed, gzipped and encrypted with AES-256-GCM under WTS_BACKUP_KEY — a key that is
// NOT a master key, kept by the owner offline as well — and written to separate storage in another region; files older
// than 28 days are deleted there (§13.5, §8.5).
//
// Restore drill (quarterly, server/ops/restore-drill.js): decrypt, verify, restore into an ISOLATED scratch database that is
// created for the drill and DROPPED afterwards (never production: the administrator URL must be a loopback host unless
// allowRemote, and must not equal any production credential), replay the deletion ledger before anything else may read the
// data, and compare row counts, migrations and the audit digest with the manifest. The report (JSON, ids and counts only)
// goes into PROJECT-NOTES.md with the measured restore time.
//
//   parseKeys(raw) → [{kid, key}]                         "kid:base64,…" (32-byte keys), the first one encrypts
//   seal(payload, keys) / open(buf, keys) → Buffer        file format: "WTSX1\n" + header JSON + "\n" + ciphertext + tag
//   pack(entries:[{name, data}]) / unpack(buf) → entries  (length-prefixed; names checked)
//   exportDatabase({conn, pgBin, objects, log, now}) → {archive: entries, manifest}
//   writeExport({entries, keys, dir, now, retainDays}) → {file, pruned:[…]}
//   restoreDrill({file|buf, keys, adminUrl, pgBin, allowRemote, env, log}) → report

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const cp = require('child_process');

const MAGIC = Buffer.from('WTSX1\n');
const TABLES = ['users', 'passkeys', 'identities', 'devices', 'sessions', 'projects', 'revisions', 'blobs', 'push_receipts',
  'historian_backups', 'audit', 'oauth_attempts', 'oidc_keys', 'email_codes', 'webauthn_challenges', 'mail_outbox',
  'signup_allowlist', 'deletion_ledger', 'rate_counters', 'ops_nonces'];

function parseKeys(raw) {
  const out = [];
  String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((item) => {
    const m = /^(\d{1,6}):([A-Za-z0-9+/=_-]+)$/.exec(item);
    const key = m ? Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64') : null;
    if (!m || key.length !== 32) throw new Error('backup: WTS_BACKUP_KEY entries must be "kid:<32-byte base64>"');
    out.push({ kid: Number(m[1]), key });
  });
  if (!out.length) throw new Error('backup: WTS_BACKUP_KEY is not set');
  return out;
}

function seal(payload, keys, meta) {
  const k = keys[0];
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify(Object.assign({ v: 1, alg: 'A256GCM', kid: k.kid, iv: iv.toString('base64'), zip: 'gzip' }, meta || {})));
  const c = crypto.createCipheriv('aes-256-gcm', k.key, iv);
  c.setAAD(header);
  const body = Buffer.concat([c.update(zlib.gzipSync(payload)), c.final()]);
  return Buffer.concat([MAGIC, header, Buffer.from('\n'), body, c.getAuthTag()]);
}
function readHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + 20 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('backup: not an export file');
  const nl = buf.indexOf(0x0a, MAGIC.length);
  if (nl === -1 || nl - MAGIC.length > 4096) throw new Error('backup: bad header');
  const headerBuf = buf.subarray(MAGIC.length, nl);
  const header = JSON.parse(headerBuf.toString('utf8'));
  if (header.v !== 1 || header.alg !== 'A256GCM') throw new Error('backup: unknown format');
  return { header, headerBuf, rest: buf.subarray(nl + 1) };
}
function open(buf, keys) {
  const { header, headerBuf, rest } = readHeader(buf);
  const k = keys.find((x) => x.kid === header.kid);
  if (!k) throw new Error('backup: no key with kid ' + header.kid);
  const d = crypto.createDecipheriv('aes-256-gcm', k.key, Buffer.from(header.iv, 'base64'));
  d.setAAD(headerBuf);
  d.setAuthTag(rest.subarray(rest.length - 16));
  let plain;
  try { plain = Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()]); } catch (e) { throw new Error('backup: authentication failed (wrong key or a changed file)'); }
  return zlib.gunzipSync(plain);
}

const NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/;
function pack(entries) {
  const parts = [];
  entries.forEach((e) => {
    if (!NAME_RE.test(e.name) || e.name.split('/').includes('..')) throw new Error('backup: bad entry name');
    const name = Buffer.from(e.name); const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
    const h = Buffer.alloc(10); h.writeUInt16BE(name.length, 0); h.writeUIntBE(data.length, 2, 6); h.writeUInt16BE(0, 8);
    parts.push(h, name, data);
  });
  return Buffer.concat(parts);
}
function unpack(buf) {
  const out = []; let i = 0;
  while (i < buf.length) {
    if (i + 10 > buf.length) throw new Error('backup: truncated');
    const nl = buf.readUInt16BE(i); const dl = buf.readUIntBE(i + 2, 6); i += 10;
    const name = buf.subarray(i, i + nl).toString('utf8'); i += nl;
    if (!NAME_RE.test(name) || name.split('/').includes('..') || i + dl > buf.length) throw new Error('backup: bad entry');
    out.push({ name, data: buf.subarray(i, i + dl) }); i += dl;
  }
  return out;
}

function tool(pgBin, name) { return pgBin ? path.join(pgBin, name) : name; }
function connArgs(conn) {
  // conn: {host, port, user, database, password?} or a URL; the password goes only through the environment
  if (typeof conn === 'string') {
    const u = new URL(conn);
    return { args: ['-h', u.hostname, '-p', String(u.port || 5432), '-U', decodeURIComponent(u.username)], db: decodeURIComponent(u.pathname.slice(1)), password: decodeURIComponent(u.password || ''), host: u.hostname };
  }
  return { args: ['-h', conn.host, '-p', String(conn.port), '-U', conn.user], db: conn.database, password: conn.password || '', host: conn.host };
}
function run(cmd, args, o) {
  const r = cp.spawnSync(cmd, args, Object.assign({ maxBuffer: 1 << 30, timeout: 30 * 60 * 1000 }, o || {}));
  if (r.error) throw new Error(path.basename(cmd) + ': ' + r.error.message);
  if (r.status !== 0) throw new Error(path.basename(cmd) + ' failed (' + r.status + '): ' + String(r.stderr || '').slice(-600));
  return r.stdout;
}
async function stats(sql) {
  const counts = {};
  for (const t of TABLES) {
    try { counts[t] = Number((await sql.unsafe('select count(*)::bigint as n from wts.' + t))[0].n); } catch (e) { counts[t] = null; }
  }
  let audit = null;
  try {
    const r = (await sql.unsafe("select coalesce(string_agg(encode(hash, 'hex'), ',' order by id), '') as s from wts.audit"))[0];
    audit = crypto.createHash('sha256').update(r.s).digest('hex');
  } catch (e) { audit = null; }
  let migrations = [];
  try { migrations = (await sql.unsafe('select name, sha256 from public.wts_schema_migrations order by name')).map((r) => r.name + ':' + r.sha256); } catch (e) { migrations = []; }
  return { counts, audit, migrations };
}

async function exportDatabase(o) {
  const log = o.log || { log() {} };
  const now = o.now || (() => Date.now());
  const ca = connArgs(o.conn);
  const t0 = now();
  const dump = run(tool(o.pgBin, 'pg_dump'), ca.args.concat(['-Fc', '--no-password', '-d', ca.db]), { env: Object.assign({}, process.env, { PGPASSWORD: ca.password }) });
  const { createDb } = require('../core/db');
  const db = createDb(o.conn, { max: 1 });
  let st; let userIds = [];
  try {
    st = await stats(db.sql);
    try { userIds = (await db.sql.unsafe('select id::text as id from wts.users order by id')).map((r) => r.id); } catch (e) { userIds = []; }
  } finally { await db.close(); }
  const entries = [{ name: 'db.dump', data: dump }];
  let blobKeys = [];
  const objs = { ledger: 0, chain: 0 };
  if (o.objects) {
    for (const p of ['ledger/', 'chain/']) {
      for (const k of await o.objects.list(p)) { const b = await o.objects.get(k); if (b) { entries.push({ name: 'objects/' + k, data: b }); objs[p.slice(0, -1)]++; } }
    }
    for (const id of userIds) { try { blobKeys = blobKeys.concat(await o.objects.list('u/' + id + '/')); } catch (e) { /* a store without that user */ } }
  }
  entries.push({ name: 'blob-manifest.json', data: Buffer.from(JSON.stringify({ keys: blobKeys })) });
  const manifest = {
    v: 1, created: new Date(now()).toISOString(), dumpSha256: crypto.createHash('sha256').update(dump).digest('hex'), dumpBytes: dump.length,
    counts: st.counts, auditDigest: st.audit, migrations: st.migrations, objects: objs, blobKeys: blobKeys.length, ms: now() - t0,
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  log.log('[export] dump ' + dump.length + ' bytes, ' + objs.ledger + ' ledger and ' + objs.chain + ' anchor objects');
  return { entries, manifest };
}

const FILE_RE = /^wts-export-(\d{8}T\d{6}Z)\.wtsx$/;
function stamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function parseStamp(s) { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN; }
function writeExport(o) {
  const now = o.now || (() => Date.now());
  const retain = o.retainDays == null ? 28 : Number(o.retainDays);
  if (!o.dir) throw new Error('backup: WTS_EXPORT_DIR is not set');
  fs.mkdirSync(o.dir, { recursive: true });
  const t = now();
  const file = path.join(o.dir, 'wts-export-' + stamp(t) + '.wtsx');
  const sealed = seal(pack(o.entries), o.keys, { created: new Date(t).toISOString() });
  const tmp = file + '.part';
  fs.writeFileSync(tmp, sealed, { mode: 0o600 });
  fs.renameSync(tmp, file);
  const pruned = [];
  fs.readdirSync(o.dir).forEach((n) => {
    const m = FILE_RE.exec(n);
    if (m && t - parseStamp(m[1]) > retain * 86400000) { fs.unlinkSync(path.join(o.dir, n)); pruned.push(n); }
  });
  return { file, bytes: sealed.length, pruned };
}
function newestExport(dir) {
  let best = null;
  try { fs.readdirSync(dir).forEach((n) => { const m = FILE_RE.exec(n); if (m && (!best || m[1] > best.stamp)) best = { name: n, stamp: m[1], at: parseStamp(m[1]) }; }); } catch (e) { return null; }
  return best;
}

// the roles block of the first migration (cluster-wide roles; a scratch cluster needs them before the restore)
function rolesSql() {
  const t = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '001-schema.sql'), 'utf8');
  const m = /DO \$roles\$[\s\S]*?\$roles\$;/.exec(t);
  if (!m) throw new Error('backup: roles block not found in 001-schema.sql');
  return m[0];
}
// a scratch, in-memory object store over the archive's objects/ entries (the drill never touches the real blob store)
function archiveObjects(entries) {
  const m = new Map();
  entries.filter((e) => e.name.startsWith('objects/')).forEach((e) => m.set(e.name.slice(8), Buffer.from(e.data)));
  return {
    kind: 'archive',
    async put(k, b) { m.set(k, Buffer.from(b)); },
    async get(k) { return m.has(k) ? Buffer.from(m.get(k)) : null; },
    async del(k) { m.delete(k); },
    async list(p) { return Array.from(m.keys()).filter((k) => k.startsWith(p)).sort(); },
    async delPrefix(p) { let n = 0; for (const k of Array.from(m.keys())) if (k.startsWith(p)) { m.delete(k); n++; } return n; },
  };
}
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/;

async function restoreDrill(o) {
  const log = o.log || { log() {} };
  const env = o.env || process.env;
  const t0 = Date.now();
  const buf = o.buf || fs.readFileSync(o.file);
  const entries = unpack(open(buf, o.keys));
  const get = (n) => { const e = entries.find((x) => x.name === n); if (!e) throw new Error('backup: ' + n + ' missing'); return e.data; };
  const manifest = JSON.parse(get('manifest.json').toString('utf8'));
  const dump = get('db.dump');
  if (crypto.createHash('sha256').update(dump).digest('hex') !== manifest.dumpSha256) throw new Error('backup: dump digest mismatch');
  // isolation of the scratch target (§13.1)
  if (!o.adminUrl) throw new Error('drill: WTS_DRILL_ADMIN_URL is not set');
  const ca = connArgs(o.adminUrl);
  if (!LOOPBACK.test(ca.host) && !o.allowRemote) throw new Error('drill: the scratch cluster must be a loopback host (pass --allow-remote-scratch for an isolated remote scratch instance)');
  ['WTS_DB_URL', 'WTS_JOBS_DB_URL', 'WTS_SUPPORT_DB_URL', 'WTS_MIGRATE_DB_URL', 'WTS_BACKUP_DB_URL'].forEach((n) => {
    if (env[n] && String(env[n]) === String(o.adminUrl)) throw new Error('drill: the scratch administrator equals ' + n + ' — refused');
  });
  const scratch = 'wts_drill_' + crypto.randomBytes(5).toString('hex');
  const { createDb } = require('../core/db');
  const admin = createDb(o.adminUrl, { max: 1 });
  const report = { ok: false, scratch, created: manifest.created, tables: {}, mismatches: [], ledger: { objects: 0, replayed: 0, remaining: null } };
  let created = false;
  try {
    await admin.sql.unsafe(rolesSql());
    await admin.sql.unsafe('CREATE DATABASE ' + scratch);
    created = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-drill-'));
    try {
      const f = path.join(tmp, 'db.dump');
      fs.writeFileSync(f, dump, { mode: 0o600 });
      run(tool(o.pgBin, 'pg_restore'), ca.args.concat(['--no-password', '--exit-on-error', '-d', scratch, f]), { env: Object.assign({}, process.env, { PGPASSWORD: ca.password }) });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    const sconn = typeof o.adminUrl === 'string' ? (() => { const u = new URL(o.adminUrl); u.pathname = '/' + scratch; return u.toString(); })() : Object.assign({}, o.adminUrl, { database: scratch });
    const db = createDb(sconn, { max: 1 });
    try {
      const before = await stats(db.sql);
      Object.keys(manifest.counts).forEach((t) => {
        report.tables[t] = before.counts[t];
        if (before.counts[t] !== manifest.counts[t]) report.mismatches.push(t + ': ' + before.counts[t] + ' restored, ' + manifest.counts[t] + ' exported');
      });
      if (before.audit !== manifest.auditDigest) report.mismatches.push('audit chain digest differs');
      if (JSON.stringify(before.migrations) !== JSON.stringify(manifest.migrations)) report.mismatches.push('migrations differ');
      // §13.5: the ledger is replayed BEFORE the restored data may be served — deleted accounts never come back
      const ledger = entries.filter((e) => /^objects\/ledger\//.test(e.name)).map((e) => JSON.parse(e.data.toString('utf8')));
      report.ledger.objects = ledger.length;
      const ids = ledger.map((r) => r.userId).filter((id) => /^[0-9a-f-]{36}$/.test(String(id)));
      let jobs = null; try { jobs = require('../core/jobs'); } catch (e) { jobs = null; }
      if (jobs && typeof jobs.ledgerReplay === 'function') {
        const r = await jobs.ledgerReplay({ db, objects: archiveObjects(entries), log: { info() {}, warn() {} } });
        report.ledger.replayed = r.replayed;
      } else if (ids.length) {
        // drill fallback (foundation schema): purge the ledger's accounts in the scratch copy and stamp the ledger rows
        await db.sql.begin(async (tx) => {
          const del = await tx`delete from wts.users where id = any(${ids}::uuid[])`;
          report.ledger.replayed = del.count;
          for (const r of ledger) {
            await tx`insert into wts.deletion_ledger (user_id, requested_at, purge_at, purged_at) values (${r.userId}, ${r.requestedAt || new Date().toISOString()}, ${r.purgeAt || new Date().toISOString()}, ${r.purgedAt || new Date().toISOString()})
              on conflict (user_id) do update set purged_at = coalesce(wts.deletion_ledger.purged_at, excluded.purged_at)`;
          }
        });
      }
      report.ledger.remaining = ids.length ? Number((await db.sql`select count(*)::int as n from wts.users where id = any(${ids}::uuid[])`)[0].n) : 0;
      if (report.ledger.remaining) report.mismatches.push('ledger: ' + report.ledger.remaining + ' deleted accounts still present after the replay');
      const blobMan = JSON.parse(get('blob-manifest.json').toString('utf8'));
      report.blobKeys = blobMan.keys.length;
    } finally { await db.close(); }
    report.ok = report.mismatches.length === 0;
  } finally {
    if (created) {
      try { await admin.sql.unsafe('DROP DATABASE ' + scratch + ' WITH (FORCE)'); report.dropped = true; } catch (e) { report.dropped = false; log.log('[drill] DROP failed — remove ' + scratch + ' by hand'); }
    }
    await admin.close();
  }
  report.restoreMs = Date.now() - t0;
  return report;
}

module.exports = { parseKeys, seal, open, readHeader, pack, unpack, exportDatabase, writeExport, newestExport, restoreDrill, archiveObjects, stats, rolesSql, TABLES, stamp, FILE_RE };
