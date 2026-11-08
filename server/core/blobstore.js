'use strict';
// server/core/blobstore.js — content-addressed, chunked, immutable parts per user (docs/ACCOUNTS-PLAN.md D5, D11, §3.3 Blobs,
// §3.4). The blob row lives in the database (under RLS); the encrypted chunks live in the object store at
// u/<session user id>/b/<hex hash>/<n>. Quota = Σ compressed bytes of the user's COMPLETE blobs (users.used_bytes).
//
//   putChunk(unit, ctx, u, {hash, n, of, zsha, csha, chunk}) → 'stored' | 'same'   (throws immutable / quota / bad_request)
//   readChunk(ctx, u, userId, hash, n) → Buffer | null
//   putInline(unit, ctx, u, {hash, zsha, z}) → the inline core of a commit stored as a one-chunk blob in the same transaction
//   inlineOf(unit, ctx, u, hexHash) → base64 | null  (a complete one-chunk blob of ≤ 48 kB, for coreInline)
//   missing(unit, userId, hexes) → [hex not complete]

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

async function quotaCheck(unit, userId, extra) {
  const q = (await unit.sql`select quota_bytes, used_bytes from wts.users where id = ${userId}`)[0];
  if (Number(q.used_bytes) + (extra || 0) > Number(q.quota_bytes)) throw new ApiError('quota', { limit: Number(q.quota_bytes), used: Number(q.used_bytes) });
  return q;
}

async function putChunk(unit, ctx, u, o) {
  const userId = unit.userId;
  const hb = Buffer.from(o.hash, 'hex');
  let row = (await unit.sql`select * from wts.blobs where user_id = ${userId} and hash = ${hb} for update`)[0];
  if (row) {
    const have = row.chunk_sha[o.n] && row.chunk_sha[o.n].length === 64 ? row.chunk_sha[o.n] : null;
    if (row.complete || have) {
      if (have === o.csha && row.chunks === o.of && Buffer.from(row.zsha).toString('hex') === o.zsha) return 'same';
      throw new ApiError('immutable');
    }
    if (row.chunks !== o.of || Buffer.from(row.zsha).toString('hex') !== o.zsha) throw new ApiError('immutable');
  }
  await quotaCheck(unit, userId, o.chunk.length);
  await objects(ctx).put(KEYS.blob(userId, o.hash, o.n), sealFor(ctx, u, userId, o.hash, o.n, o.chunk));
  if (!row) {
    row = (await unit.sql`insert into wts.blobs (user_id, hash, zsha, bytes, chunks, complete, created_at, refcount, dkv, chunk_sha, stored_bytes, unref_at)
      values (${userId}, ${hb}, ${Buffer.from(o.zsha, 'hex')}, 0, ${o.of}, false, now(), 0, ${u.dkv}, array_fill(''::text, array[${o.of}::int]), 0, now())
      returning *`)[0];
  }
  row = (await unit.sql`update wts.blobs set chunk_sha[${o.n + 1}] = ${o.csha}, stored_bytes = stored_bytes + ${o.chunk.length}
    where user_id = ${userId} and hash = ${hb} returning *`)[0];
  if (row.chunk_sha.length === row.chunks && row.chunk_sha.every((x) => typeof x === 'string' && x.length === 64)) {
    // every chunk is in: check the whole gzip stream against its declared SHA-256, then the blob is complete and immutable
    const parts = [];
    for (let i = 0; i < row.chunks; i++) parts.push(i === o.n ? o.chunk : await readChunk(ctx, u, userId, o.hash, i));
    if (parts.some((p) => !p)) throw new ApiError('bad_request', { field: 'chunk' });
    const all = Buffer.concat(parts);
    if (sha(all) !== o.zsha) {
      for (let i = 0; i < row.chunks; i++) await objects(ctx).del(KEYS.blob(userId, o.hash, i));
      await unit.sql`delete from wts.blobs where user_id = ${userId} and hash = ${hb}`;
      return unit.failAfterCommit('bad_request', { field: 'zsha' });
    }
    await unit.sql`update wts.blobs set complete = true, bytes = ${all.length} where user_id = ${userId} and hash = ${hb}`;
    await unit.sql`update wts.users set used_bytes = used_bytes + ${all.length} where id = ${userId}`;
  }
  return 'stored';
}

async function putInline(unit, ctx, u, o) {
  const userId = unit.userId;
  const hb = Buffer.from(o.hash, 'hex');
  const row = (await unit.sql`select complete, zsha from wts.blobs where user_id = ${userId} and hash = ${hb} for update`)[0];
  if (row && row.complete) return 'same';
  if (row) { await unit.sql`delete from wts.blobs where user_id = ${userId} and hash = ${hb}`; }   // a partial upload of the same core
  await objects(ctx).put(KEYS.blob(userId, o.hash, 0), sealFor(ctx, u, userId, o.hash, 0, o.z));
  await unit.sql`insert into wts.blobs (user_id, hash, zsha, bytes, chunks, complete, created_at, refcount, dkv, chunk_sha, stored_bytes, unref_at)
    values (${userId}, ${hb}, ${Buffer.from(o.zsha, 'hex')}, ${o.z.length}, 1, true, now(), 0, ${u.dkv}, array[${sha(o.z)}]::text[], ${o.z.length}, now())`;
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

async function missing(unit, userId, hexes) {
  const uniq = Array.from(new Set(hexes));
  if (!uniq.length) return [];
  const have = new Set((await unit.sql`select encode(hash, 'hex') as h from wts.blobs where user_id = ${userId} and complete
    and hash = any(${unit.sql.array(uniq.map((h) => Buffer.from(h, 'hex')), 17)})`).map((r) => r.h));
  return uniq.filter((h) => !have.has(h));
}

module.exports = { putChunk, putInline, readChunk, inlineOf, missing, quotaCheck, INLINE_MAX, CHUNK_MAX, sha };
