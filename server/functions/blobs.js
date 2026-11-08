'use strict';
// server/functions/blobs.js — content-addressed, immutable, chunked parts (docs/ACCOUNTS-PLAN.md §3.3 Blobs, D5, D11, §8.3).
// WP-S1. Object keys are built from the session's user id only. A PUT to a complete blob, or a different body for a stored
// chunk, is 409 immutable (a byte-identical repeat is 204). Reads count against 100 MB/h and 300 MB/day per user and
// 100 MB/h per session (after an export step-up: 300 MB/h for 2 h and 600 MB/day for that session); a session that reads more than half the account in a day
// gets a security notice.

const { fail } = require('../core/errors');
const C = require('../core/contract');
const H = require('../core/http');
const S = require('../core/service');
const SE = require('../core/session');
const R = require('../core/rate');
const B = require('../core/blobstore');

const MAX_CHUNKS = 16;          // 16 × 4 MB = the 64 MB project cap (D16); a larger blob is refused before it is stored

async function blobsHas(ctx) {
  S.syncGate(ctx, false);
  const missing = await SE.withSession(ctx, {}, (unit) => B.missing(unit, unit.userId, ctx.body.hashes));
  return { status: 200, body: { missing } };
}

async function blobPut(ctx) {
  S.syncGate(ctx, true);
  require('./projects')._internal.clientGate(ctx);
  const hash = ctx.params.hash; const n = Number(ctx.params.n); const of = Number(ctx.query.of);
  const zsha = String(H.header(ctx.req, 'x-wts-zsha') || '').toLowerCase();
  const csha = String(H.header(ctx.req, 'x-wts-chunk-sha') || '').toLowerCase();
  const chunk = ctx.raw || Buffer.alloc(0);
  if (!C.TYPES.hex64(hash)) fail('bad_request', { field: 'hash' });
  if (!/^\d{1,3}$/.test(ctx.params.n) || !/^\d{1,3}$/.test(String(ctx.query.of || '')) || of < 1 || of > MAX_CHUNKS || n >= of) fail('bad_request', { field: 'of' });
  if (!C.TYPES.hex64(zsha) || !C.TYPES.hex64(csha)) fail('bad_request', { field: 'sha' });
  if (!chunk.length) fail('bad_request', { field: 'chunk' });
  if (chunk.length > B.CHUNK_MAX) fail('too_large', { limit: B.CHUNK_MAX });
  if (B.sha(chunk) !== csha) fail('bad_request', { field: 'chunk' });
  await SE.withSession(ctx, {}, async (unit) => {
    const u = await unit.user();
    await R.enforce(unit.sql, 'chunkPutUserDay', unit.userId, chunk.length);
    await B.putChunk(unit, ctx, u, { hash, n, of, zsha, csha, chunk });
  });
  return { status: 204 };
}

async function blobGet(ctx) {
  S.syncGate(ctx, false);
  const hash = ctx.params.hash;
  if (!C.TYPES.hex64(hash) || !/^\d{1,3}$/.test(ctx.params.n)) fail('not_found');
  const n = Number(ctx.params.n);
  const out = await SE.withSession(ctx, {}, async (unit, s) => {
    const u = await unit.user();
    const row = (await unit.sql`select chunks, zsha, complete from wts.blobs where user_id = ${unit.userId} and hash = ${Buffer.from(hash, 'hex')}`)[0];
    if (!row || !row.complete || n >= row.chunks) fail('not_found');
    const plain = await B.readChunk(ctx, u, unit.userId, hash, n);
    if (!plain) fail('not_found');
    const len = plain.length;
    const sk = s.hash.toString('hex').slice(0, 32);
    await R.enforce(unit.sql, s.readUnlocked ? 'blobReadUserHourUnlocked' : 'blobReadUserHour', unit.userId, len);
    await R.enforce(unit.sql, s.readUnlocked ? 'blobReadUserDayUnlocked' : 'blobReadUserDay', unit.userId, len);
    await R.enforce(unit.sql, s.readUnlocked ? 'blobReadSessionHourUnlocked' : 'blobReadSessionHour', sk, len);
    const day = await R.hit(unit.sql, 'blobReadSessionDay', sk, len);
    const used = Number(u.row.used_bytes);
    if (used > 1000 * 1000 && day.n > used / 2 && day.n - len <= used / 2) {
      await unit.audit('read_burst', { deviceId: s.deviceId, detail: { kind: 'bytes' } });
      const once = await R.hit(unit.sql, 'noticeOnceDay', 'read:' + unit.userId);
      if (once.n === 1) await unit.mail(u.open('user.address', u.row.email_enc), 'notice_read_burst', { at: S.whenText(Date.now()) });
    }
    return { plain, of: row.chunks, zsha: Buffer.from(row.zsha).toString('hex') };
  });
  return { status: 200, body: out.plain, headers: { 'X-WTS-Of': String(out.of), 'X-WTS-Zsha': out.zsha } };
}

module.exports = { handlers: { blobsHas, blobPut, blobGet } };
