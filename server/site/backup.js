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
//   exportDatabase({conn, pgBin, objects, log, now}) → {entries, manifest}   (one snapshot for dump and manifest; objects null
//        → manifest.objects = 'none', only when the caller passed --no-objects)
//   writeExport({entries, keys, dir, now, retainDays}) → {file, pruned:[…]}
//   restoreDrill({file|buf, keys, adminUrl, pgBin, allowRemote, env, log}) → report   (both export formats)
//
// One-login hosting (v4.0, server/README.md "Hosting"): a function runtime has no dump tool and the functions site must not
// hold a key that can READ an export (isolation.js keeps WTS_BACKUP_KEY off it). The weekly export there is therefore:
//   exportCopy({db, objects, now, log}) → {entries, manifest}   one REPEATABLE READ, READ ONLY transaction as wts_backup
//        (db = createDb(url, {role:'wts_backup', sessionRole:true})): every table of TABLES with COPY … TO STDOUT, the
//        column list of each, the row counts, audit digest, migration list and user list of the SAME snapshot; manifest
//        format 'copy' with the SHA-256 of every table file
//   sealTo(payload, publicKey, meta) → Buffer   file format "WTSX2\n": an ephemeral X25519 key agreement with the owner's
//        public key (WTS_BACKUP_PUBLIC_KEY "kid:<base64 SPKI>", not secret), HKDF-SHA-256, AES-256-GCM; only the private key
//        (WTS_BACKUP_PRIVATE_KEY "kid:<base64 PKCS#8>", kept offline and on the drill machine) opens it
//   parsePublicKey(raw) / parsePrivateKeys(raw) / generateBackupKeys(kid) → {publicKey, privateKey} (text forms)
//   writeExportStore({entries, publicKey, objects, now, retainDays}) → {key, bytes, pruned}   export/wts-export-<stamp>.wtsx in
//        the separate exports store (site/netlify-blobs.js 'wts-exports'), older than 28 days deleted
//   open(buf, keys) opens both formats: keys may mix {kid, key} (WTSX1) and {kid, priv} (WTSX2)

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
  if (Buffer.isBuffer(buf) && buf.subarray(0, MAGIC2.length).equals(MAGIC2)) return openV2(buf, keys);
  const { header, headerBuf, rest } = readHeader(buf);
  const k = keys.find((x) => x.kid === header.kid && x.key);
  if (!k) throw new Error('backup: no key with kid ' + header.kid);
  const d = crypto.createDecipheriv('aes-256-gcm', k.key, Buffer.from(header.iv, 'base64'));
  d.setAAD(headerBuf);
  d.setAuthTag(rest.subarray(rest.length - 16));
  let plain;
  try { plain = Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()]); } catch (e) { throw new Error('backup: authentication failed (wrong key or a changed file)'); }
  return zlib.gunzipSync(plain);
}

// ── WTSX2: sealed to the owner's public key (the functions site can write an export it cannot read) ─────────────────
const MAGIC2 = Buffer.from('WTSX2\n');
const V2_ALG = 'X25519-HKDF-SHA256-A256GCM';
function kidItem(item, name) {
  const m = /^(\d{1,6}):([A-Za-z0-9+/=_-]+)$/.exec(String(item).trim());
  if (!m) throw new Error('backup: ' + name + ' entries must be "kid:<base64>"');
  return { kid: Number(m[1]), der: Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64') };
}
function parsePublicKey(raw) {
  const first = String(raw || '').split(',').map((x) => x.trim()).filter(Boolean)[0];
  if (!first) throw new Error('backup: WTS_BACKUP_PUBLIC_KEY is not set');
  const { kid, der } = kidItem(first, 'WTS_BACKUP_PUBLIC_KEY');
  let key;
  try { key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); } catch (e) { throw new Error('backup: WTS_BACKUP_PUBLIC_KEY is not a public key'); }
  if (key.asymmetricKeyType !== 'x25519') throw new Error('backup: WTS_BACKUP_PUBLIC_KEY must be an X25519 key');
  return { kid, pub: key };
}
function parsePrivateKeys(raw) {
  const out = String(raw || '').split(',').map((x) => x.trim()).filter(Boolean).map((item) => {
    const { kid, der } = kidItem(item, 'WTS_BACKUP_PRIVATE_KEY');
    let key;
    try { key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); } catch (e) { throw new Error('backup: WTS_BACKUP_PRIVATE_KEY is not a private key'); }
    if (key.asymmetricKeyType !== 'x25519') throw new Error('backup: WTS_BACKUP_PRIVATE_KEY must be an X25519 key');
    return { kid, priv: key };
  });
  if (!out.length) throw new Error('backup: WTS_BACKUP_PRIVATE_KEY is not set');
  return out;
}
function generateBackupKeys(kid) {
  const k = crypto.generateKeyPairSync('x25519');
  const id = Number(kid) || 1;
  return {
    publicKey: id + ':' + k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: id + ':' + k.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}
function v2Key(shared, epk, kid) { return Buffer.from(crypto.hkdfSync('sha256', shared, epk, Buffer.from('wts-export v2 kid ' + kid), 32)); }
function sealTo(payload, pk, meta) {
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ type: 'spki', format: 'der' });
  const key = v2Key(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pk.pub }), epk, pk.kid);
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify(Object.assign({ v: 2, alg: V2_ALG, kid: pk.kid, epk: epk.toString('base64'), iv: iv.toString('base64'), zip: 'gzip' }, meta || {})));
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(header);
  const body = Buffer.concat([c.update(zlib.gzipSync(payload)), c.final()]);
  return Buffer.concat([MAGIC2, header, Buffer.from('\n'), body, c.getAuthTag()]);
}
function openV2(buf, keys) {
  const nl = buf.indexOf(0x0a, MAGIC2.length);
  if (nl === -1 || nl - MAGIC2.length > 4096) throw new Error('backup: bad header');
  const headerBuf = buf.subarray(MAGIC2.length, nl);
  const header = JSON.parse(headerBuf.toString('utf8'));
  if (header.v !== 2 || header.alg !== V2_ALG) throw new Error('backup: unknown format');
  const k = (keys || []).find((x) => x.kid === header.kid && x.priv);
  if (!k) throw new Error('backup: no private key with kid ' + header.kid + ' (WTS_BACKUP_PRIVATE_KEY)');
  const epkDer = Buffer.from(header.epk, 'base64');
  const epk = crypto.createPublicKey({ key: epkDer, format: 'der', type: 'spki' });
  const key = v2Key(crypto.diffieHellman({ privateKey: k.priv, publicKey: epk }), epkDer, header.kid);
  const rest = buf.subarray(nl + 1);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
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
// the same, without blocking the event loop (the export keeps a database transaction open while the dump runs)
function runAsync(cmd, args, o) {
  return new Promise((resolve, reject) => {
    const ch = cp.spawn(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'], timeout: 30 * 60 * 1000, killSignal: 'SIGKILL' }, o || {}));
    const out = []; const err = [];
    ch.stdout.on('data', (b) => out.push(b));
    ch.stderr.on('data', (b) => err.push(b));
    ch.on('error', (e) => { reject(new Error(path.basename(cmd) + ': ' + e.message)); });
    ch.on('close', (code) => {
      if (code !== 0) reject(new Error(path.basename(cmd) + ' failed (' + code + '): ' + Buffer.concat(err).toString().slice(-600)));
      else resolve(Buffer.concat(out));
    });
  });
}
// inside a transaction a failed statement aborts it: each optional read runs in its own savepoint when there is one
function guarded(sql, fn) { return typeof sql.savepoint === 'function' ? sql.savepoint((sp) => fn(sp)) : fn(sql); }
async function stats(sql) {
  const counts = {};
  for (const t of TABLES) {
    try { counts[t] = await guarded(sql, async (s) => Number((await s.unsafe('select count(*)::bigint as n from wts.' + t))[0].n)); } catch (e) { counts[t] = null; }
  }
  let audit = null;
  try {
    const r = await guarded(sql, async (s) => (await s.unsafe("select coalesce(string_agg(encode(hash, 'hex'), ',' order by id), '') as s from wts.audit"))[0]);
    audit = crypto.createHash('sha256').update(r.s).digest('hex');
  } catch (e) { audit = null; }
  let migrations = [];
  try { migrations = await guarded(sql, async (s) => (await s.unsafe('select name, sha256 from public.wts_schema_migrations order by name')).map((r) => r.name + ':' + r.sha256)); } catch (e) { migrations = []; }
  return { counts, audit, migrations };
}

// The dump and the manifest describe the SAME moment: one REPEATABLE READ, READ ONLY transaction exports its snapshot,
// pg_dump runs with --snapshot=<id> while that transaction stays open, and the row counts, audit digest, migration list and
// user list are read inside the same transaction before it ends. Writes that land meanwhile (rate counters, sessions, audit,
// outbox) are in neither. o.afterDump (tests only) runs between the dump and the stats.
async function exportDatabase(o) {
  const log = o.log || { log() {} };
  const now = o.now || (() => Date.now());
  const ca = connArgs(o.conn);
  const t0 = now();
  const { createDb } = require('../core/db');
  const db = createDb(o.conn, { max: 1 });
  let st; let userIds = []; let dump = null;
  try {
    await db.sql.begin('isolation level repeatable read read only', async (tx) => {
      const snap = (await tx`select pg_export_snapshot() as id`)[0].id;
      if (!/^[0-9A-Fa-f-]{1,64}$/.test(String(snap))) throw new Error('backup: unexpected snapshot id');
      dump = await runAsync(tool(o.pgBin, 'pg_dump'), ca.args.concat(['-Fc', '--no-password', '--snapshot=' + snap, '-d', ca.db]),
        { env: Object.assign({}, process.env, { PGPASSWORD: ca.password }) });
      if (typeof o.afterDump === 'function') await o.afterDump();
      st = await stats(tx);
      try { userIds = await guarded(tx, async (s) => (await s.unsafe('select id::text as id from wts.users order by id')).map((r) => r.id)); } catch (e) { userIds = []; }
    });
  } finally { await db.close(); }
  const entries = [{ name: 'db.dump', data: dump }];
  let blobKeys = [];
  const objs = o.objects ? { ledger: 0, chain: 0 } : 'none';
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
  log.log('[export] dump ' + dump.length + ' bytes, ' + (o.objects ? objs.ledger + ' ledger and ' + objs.chain + ' anchor objects' : 'no object store (--no-objects)'));
  return { entries, manifest };
}

const FILE_RE = /^wts-export-(\d{8}T\d{6}Z)\.wtsx$/;
function stamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function parseStamp(s) { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN; }
// ── the COPY export (function runtimes: no dump tool) ───────────────────────────────────────────────────────────────
async function copyOut(tx, stmt) {
  const stream = await tx.unsafe(stmt).readable();
  const parts = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}
async function exportCopy(o) {
  const log = o.log || { log() {} };
  const now = o.now || (() => Date.now());
  const t0 = now();
  if (!o.db || o.db.role !== 'wts_backup') throw new Error('backup: exportCopy needs a wts_backup connection');
  await o.db.checkRole();
  const files = {}; const columns = {}; let st; let userIds = [];
  await o.db.sql.begin('isolation level repeatable read read only', async (tx) => {
    for (const t of TABLES) {
      columns[t] = (await tx`select a.attname as c from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'wts' and c.relname = ${t} and a.attnum > 0 and not a.attisdropped order by a.attnum`).map((r) => r.c);
      if (!columns[t].length) throw new Error('backup: table wts.' + t + ' not found');
      files[t] = await copyOut(tx, 'copy wts.' + t + ' to stdout');
    }
    st = await stats(tx);
    userIds = (await tx.unsafe('select id::text as id from wts.users order by id')).map((r) => r.id);
  });
  const entries = TABLES.map((t) => ({ name: 'db/' + t + '.copy', data: files[t] }));
  entries.push({ name: 'db/columns.json', data: Buffer.from(JSON.stringify(columns)) });
  let blobKeys = [];
  const objs = o.objects ? { ledger: 0, chain: 0 } : 'none';
  if (o.objects) {
    for (const p of ['ledger/', 'chain/']) {
      for (const k of await o.objects.list(p)) { const b = await o.objects.get(k); if (b) { entries.push({ name: 'objects/' + k, data: b }); objs[p.slice(0, -1)]++; } }
    }
    for (const id of userIds) blobKeys = blobKeys.concat(await o.objects.list('u/' + id + '/'));
  }
  entries.push({ name: 'blob-manifest.json', data: Buffer.from(JSON.stringify({ keys: blobKeys })) });
  const tables = {};
  TABLES.forEach((t) => { tables[t] = { bytes: files[t].length, sha256: crypto.createHash('sha256').update(files[t]).digest('hex') }; });
  const manifest = {
    v: 2, format: 'copy', created: new Date(now()).toISOString(), tables,
    counts: st.counts, auditDigest: st.audit, migrations: st.migrations, objects: objs, blobKeys: blobKeys.length, ms: now() - t0,
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  log.log('[export] copy of ' + TABLES.length + ' tables, ' + (o.objects ? objs.ledger + ' ledger and ' + objs.chain + ' anchor objects' : 'no object store'));
  return { entries, manifest };
}
const EXPORT_PREFIX = 'export/';
async function writeExportStore(o) {
  const now = o.now || (() => Date.now());
  const retain = o.retainDays == null ? 28 : Number(o.retainDays);
  if (!o.objects) throw new Error('backup: no export store');
  if (!o.publicKey) throw new Error('backup: WTS_BACKUP_PUBLIC_KEY is not set');
  const t = now();
  const name = 'wts-export-' + stamp(t) + '.wtsx';
  const sealed = sealTo(pack(o.entries), o.publicKey, { created: new Date(t).toISOString() });
  await o.objects.put(EXPORT_PREFIX + name, sealed);
  const pruned = [];
  for (const k of await o.objects.list(EXPORT_PREFIX)) {
    const m = FILE_RE.exec(k.slice(EXPORT_PREFIX.length));
    if (m && t - parseStamp(m[1]) > retain * 86400000) { await o.objects.del(k); pruned.push(k.slice(EXPORT_PREFIX.length)); }
  }
  return { key: EXPORT_PREFIX + name, name, bytes: sealed.length, pruned };
}
async function newestExportInStore(objects) {
  let best = null;
  for (const k of await objects.list(EXPORT_PREFIX)) {
    const m = FILE_RE.exec(k.slice(EXPORT_PREFIX.length));
    if (m && (!best || m[1] > best.stamp)) best = { key: k, name: k.slice(EXPORT_PREFIX.length), stamp: m[1], at: parseStamp(m[1]) };
  }
  return best;
}
// a COPY export into the freshly created scratch database: the export's own migrations (names and digests), then the rows
// with triggers and foreign-key checks off for the load (session_replication_role = replica, administrator only), then
// every owned sequence moved past the restored ids
async function restoreCopy(sconn, entries, manifest) {
  const { createDb } = require('../core/db');
  const { migrate } = require('../db/migrate');
  const get = (n) => { const e = entries.find((x) => x.name === n); if (!e) throw new Error('backup: ' + n + ' missing'); return e.data; };
  const cols = JSON.parse(get('db/columns.json').toString('utf8'));
  Object.keys(manifest.tables).forEach((t) => {
    if (crypto.createHash('sha256').update(get('db/' + t + '.copy')).digest('hex') !== manifest.tables[t].sha256) throw new Error('backup: ' + t + ' digest mismatch');
  });
  const db = createDb(sconn, { max: 1 });
  try {
    await migrate(db.sql, { names: manifest.migrations });
    await db.sql.begin(async (tx) => {
      await tx.unsafe('set local session_replication_role = replica');
      for (const t of Object.keys(manifest.tables)) {
        const have = (await tx`select a.attname as c from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'wts' and c.relname = ${t} and a.attnum > 0 and not a.attisdropped order by a.attnum`).map((r) => r.c);
        if (JSON.stringify(have) !== JSON.stringify(cols[t])) throw new Error('backup: columns of ' + t + ' differ from the export');
        const data = get('db/' + t + '.copy');
        if (!data.length) continue;
        const w = await tx.unsafe('copy wts.' + t + ' from stdin').writable();
        await new Promise((resolve, reject) => { w.on('error', reject); w.on('finish', resolve); w.end(data); });
      }
      const seqs = await tx`select s.relname as seq, t.relname as tbl, a.attname as col from pg_class s
        join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i') join pg_class t on t.oid = d.refobjid
        join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid join pg_namespace n on n.oid = s.relnamespace
        where s.relkind = 'S' and n.nspname = 'wts'`;
      for (const q of seqs) {
        await tx.unsafe('select setval(' + "'wts." + q.seq + "'" + ', greatest(coalesce((select max(' + q.col + ') from wts.' + q.tbl + '), 0), 1), (select count(*) > 0 from wts.' + q.tbl + '))');
      }
    });
  } finally { await db.close(); }
}

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
  const t = fs.readFileSync(require('../core/root').serverPath('db', 'migrations', '001-schema.sql'), 'utf8');
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
  const isCopy = manifest.format === 'copy';
  const dump = isCopy ? null : get('db.dump');
  if (!isCopy && crypto.createHash('sha256').update(dump).digest('hex') !== manifest.dumpSha256) throw new Error('backup: dump digest mismatch');
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
    const sconn = typeof o.adminUrl === 'string' ? (() => { const u = new URL(o.adminUrl); u.pathname = '/' + scratch; return u.toString(); })() : Object.assign({}, o.adminUrl, { database: scratch });
    if (isCopy) await restoreCopy(sconn, entries, manifest);
    else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-drill-'));
      try {
        const f = path.join(tmp, 'db.dump');
        fs.writeFileSync(f, dump, { mode: 0o600 });
        run(tool(o.pgBin, 'pg_restore'), ca.args.concat(['--no-password', '--exit-on-error', '-d', scratch, f]), { env: Object.assign({}, process.env, { PGPASSWORD: ca.password }) });
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    report.format = isCopy ? 'copy' : 'dump';
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

module.exports = { parseKeys, seal, open, readHeader, pack, unpack, exportDatabase, writeExport, newestExport, restoreDrill, archiveObjects, stats, rolesSql, TABLES, stamp, FILE_RE,
  parsePublicKey, parsePrivateKeys, generateBackupKeys, sealTo, exportCopy, writeExportStore, newestExportInStore, restoreCopy, EXPORT_PREFIX };
