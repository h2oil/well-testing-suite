'use strict';
// server/core/blobstore.js — content-addressed, chunked, immutable parts per user (docs/ACCOUNTS-PLAN.md D5, D11, §3.3 Blobs,
// §3.4). The blob row lives in the database (under RLS); the encrypted chunks live in the object store at
// u/<session user id>/b/<hex hash>/<n>. Quota = Σ compressed bytes of the user's COMPLETE blobs (users.used_bytes); the chunk
// PUT also counts the bytes already stored for the user's unfinished uploads (kept ≤ 24 h by the daily job).
//
//   putChunk(unit, ctx, u, {hash, n, of, zsha, csha, chunk}) → 'stored' | 'same'   (throws immutable / quota / bad_request)
//   readChunk(ctx, u, userId, hash, n) → Buffer | null
//   putInline(unit, ctx, u, {hash, zsha, z}) → the inline core of a commit stored as a one-chunk blob in the same transaction
//   inlineOf(unit, ctx, u, hexHash) → base64 | null  (a complete one-chunk blob of ≤ 48 kB, for coreInline)
//   missing(unit, userId, hexes, {lock}) → [hex not complete]   (lock: FOR SHARE on the complete rows until the commit)
//   quotaCheck(unit, userId, extra, {inProgress}) → throws quota when used (+ unfinished uploads) + extra > quota
//
// Order inside one transaction: the row is locked (inserted with ON CONFLICT DO NOTHING, then re-selected FOR UPDATE), every
// check that can still refuse runs, and only then is the object written; a refused PUT leaves no object behind.

const crypto = require('crypto');
const E = require('./envelope');
const { KEYS } = require('./objects');
const { ApiError } = require('./errors');

const INLINE_MAX = 48 * 1024;
const CHUNK_MAX = 4 * 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function objects(ctx) { if (!ctx.objects) throw new ApiError('paused'); return ctx.objects; }
function sealFor(ctx, u, userId, hash, n, plain) {
  return E.sealChunk({ dataKey: u.keys.get(u.dkv), dkv: u.dkv, kid: u.row.data_key_kid, userId, hash, n }, plain);
}
async function readChunk(ctx, u, userId, hash, n) {
  const obj = await objects(ctx).get(KEYS.blob(userId, hash, n));
  if (!obj) return null;
  return E.openChunk(u.keys, { userId, hash, n }, obj);
}

async function quotaCheck(unit, userId, extra, o) {
  const q = (await unit.sql`select quota_bytes, used_bytes from wts.users where id = ${userId}`)[0];
  let used = Number(q.used_bytes);
  if (o && o.inProgress) {
    used += Number((await unit.sql`select coalesce(sum(stored_bytes), 0)::bigint as n from wts.blobs where user_id = ${userId} and not complete`)[0].n);
  }
  if (used + (extra || 0) > Number(q.quota_bytes)) throw new ApiError('quota', { limit: Number(q.quota_bytes), used: Number(q.used_bytes) });
  return q;
}

const lockRow = async (unit, userId, hb) => (await unit.sql`select * from wts.blobs where user_id = ${userId} and hash = ${hb} for update`)[0];

async function putChunk(unit, ctx, u, o) {
  const userId = unit.userId;
  const hb = Buffer.from(o.hash, 'hex');
  let row = await lockRow(unit, userId, hb);
  if (!row) {
    // two first PUTs of a new blob: one inserts, the other waits on the conflict and then locks the same row (no unique
    // violation, and no object written before the row is held)
    await unit.sql`insert into wts.blobs (user_id, hash, zsha, bytes, chunks, complete, created_at, refcount, dkv, chunk_sha, stored_bytes, unref_at)
      values (${userId}, ${hb}, ${Buffer.from(o.zsha, 'hex')}, 0, ${o.of}, false, now(), 0, ${u.dkv}, array_fill(''::text, array[${o.of}::int]), 0, now())
      on conflict do nothing`;
    row = await lockRow(unit, userId, hb);
  }
  const have = row.chunk_sha[o.n] && row.chunk_sha[o.n].length === 64 ? row.chunk_sha[o.n] : null;
  if (row.complete || have) {
    if (have === o.csha && row.chunks === o.of && Buffer.from(row.zsha).toString('hex') === o.zsha) return 'same';
    throw new ApiError('immutable');
  }
  if (row.chunks !== o.of || Buffer.from(row.zsha).toString('hex') !== o.zsha) throw new ApiError('immutable');
  await quotaCheck(unit, userId, o.chunk.length, { inProgress: true });
  await objects(ctx).put(KEYS.blob(userId, o.hash, o.n), sealFor(ctx, u, userId, o.hash, o.n, o.chunk));
  row = (await unit.sql`update wts.blobs set chunk_sha[${o.n + 1}] = ${o.csha}, stored_bytes = stored_bytes + ${o.chunk.length}
    where user_id = ${userId} and hash = ${hb} returning *`)[0];
  if (row.chunk_sha.length === row.chunks && row.chunk_sha.every((x) => typeof x === 'string' && x.length === 64)) {
    // every chunk is in: check the whole gzip stream against its declared SHA-256 (hashed chunk by chunk, never the whole
    // blob in memory), then the blob is complete and immutable
    const h = crypto.createHash('sha256');
    let total = 0;
    for (let i = 0; i < row.chunks; i++) {
      const part = i === o.n ? o.chunk : await readChunk(ctx, u, userId, o.hash, i);
      if (!part) throw new ApiError('bad_request', { field: 'chunk' });
      h.update(part); total += part.length;
    }
    if (h.digest('hex') !== o.zsha) {
      for (let i = 0; i < row.chunks; i++) await objects(ctx).del(KEYS.blob(userId, o.hash, i));
      await unit.sql`delete from wts.blobs where user_id = ${userId} and hash = ${hb}`;
      return unit.failAfterCommit('bad_request', { field: 'zsha' });
    }
    await unit.sql`update wts.blobs set complete = true, bytes = ${total} where user_id = ${userId} and hash = ${hb}`;
    await unit.sql`update wts.users set used_bytes = used_bytes + ${total} where id = ${userId}`;
  }
  return 'stored';
}

// Call it after the commit's other refusals (missing parts, quota), so no object is written for a commit that is then
// refused. A partial upload of the same core is replaced; its other chunk objects belong to no row any more and are removed
// after the response.
async function putInline(unit, ctx, u, o) {
  const userId = unit.userId;
  const hb = Buffer.from(o.hash, 'hex');
  let row = await lockRow(unit, userId, hb);
  if (row && row.complete) return 'same';
  if (row) {
    await unit.sql`delete from wts.blobs where user_id = ${userId} and hash = ${hb}`;
    const old = row.chunks;
    if (old > 1) ctx.after(async () => { for (let i = 1; i < old; i++) await objects(ctx).del(KEYS.blob(userId, o.hash, i)); });
  }
  await quotaCheck(unit, userId, o.z.length, { inProgress: true });
  const ins = await unit.sql`insert into wts.blobs (user_id, hash, zsha, bytes, chunks, complete, created_at, refcount, dkv, chunk_sha, stored_bytes, unref_at)
    values (${userId}, ${hb}, ${Buffer.from(o.zsha, 'hex')}, ${o.z.length}, 1, true, now(), 0, ${u.dkv}, array[${sha(o.z)}]::text[], ${o.z.length}, now())
    on conflict do nothing returning 1`;
  if (!ins.length) {                                       // a concurrent request stored the same core first
    row = await lockRow(unit, userId, hb);
    if (row && row.complete) return 'same';
    throw new ApiError('immutable');
  }
  await objects(ctx).put(KEYS.blob(userId, o.hash, 0), sealFor(ctx, u, userId, o.hash, 0, o.z));
  await unit.sql`update wts.users set used_bytes = used_bytes + ${o.z.length} where id = ${userId}`;
  return 'stored';
}

async function inlineOf(unit, ctx, u, hex) {
  if (!hex) return null;
  const row = (await unit.sql`select chunks, bytes, complete from wts.blobs where user_id = ${unit.userId} and hash = ${Buffer.from(hex, 'hex')}`)[0];
  if (!row || !row.complete || row.chunks !== 1 || Number(row.bytes) > INLINE_MAX) return null;
  const b = await readChunk(ctx, u, unit.userId, hex, 0);
  return b ? b.toString('base64') : null;
}

// With {lock:true} the complete rows are locked FOR SHARE until the transaction ends, so the daily clean-up's row delete
// (refcount = 0, unreferenced for 7 days) either finished first (the hash is missing: 422, the client uploads it again) or
// waits and then skips the row the new revision now references (T15).
async function missing(unit, userId, hexes, o) {
  const uniq = Array.from(new Set(hexes));
  if (!uniq.length) return [];
  const list = unit.sql.array(uniq.map((h) => Buffer.from(h, 'hex')), 17);
  const rows = o && o.lock
    ? await unit.sql`select encode(hash, 'hex') as h from wts.blobs where user_id = ${userId} and complete and hash = any(${list}) for share`
    : await unit.sql`select encode(hash, 'hex') as h from wts.blobs where user_id = ${userId} and complete and hash = any(${list})`;
  const have = new Set(rows.map((r) => r.h));
  return uniq.filter((h) => !have.has(h));
}

module.exports = { putChunk, putInline, readChunk, inlineOf, missing, quotaCheck, INLINE_MAX, CHUNK_MAX, sha };
