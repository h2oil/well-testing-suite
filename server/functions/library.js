'use strict';
// server/functions/library.js — the account library document (docs/ACCOUNTS-PLAN.md §3.3, D13): user curves, presets and
// mappings shared by every project and device. One gzip JSON body (≤ 2 MB) per account, encrypted in the object store at
// u/<uid>/lib/<hash>; compare-and-swap on users.lib_rev; pushId receipts make a retry idempotent. WP-S1.

const { fail } = require('../core/errors');
const E = require('../core/envelope');
const { KEYS } = require('../core/objects');
const S = require('../core/service');
const SE = require('../core/session');
const R = require('../core/rate');

const iso = (d) => (d == null ? null : new Date(d).toISOString());
const hex = (b) => (b == null ? null : Buffer.from(b).toString('hex'));
const MAX = 2000 * 1000;

function store(ctx) { if (!ctx.objects) fail('paused'); return ctx.objects; }

async function library(ctx) {
  S.syncGate(ctx, false);
  const body = await SE.withSession(ctx, {}, async (unit) => {
    const u = await unit.user();
    return { rev: Number(u.row.lib_rev), hash: hex(u.row.lib_hash), savedAt: iso(u.row.lib_saved_at) };
  });
  return { status: 200, body };
}

async function libraryBody(ctx) {
  S.syncGate(ctx, false);
  const buf = await SE.withSession(ctx, {}, async (unit) => {
    const u = await unit.user();
    if (!Number(u.row.lib_rev) || !u.row.lib_hash) fail('not_found');
    const h = hex(u.row.lib_hash);
    const obj = await store(ctx).get(KEYS.library(unit.userId, h));
    if (!obj) fail('not_found');
    const plain = E.openChunk(u.keys, { userId: unit.userId, hash: 'lib:' + h, n: 0 }, obj);
    await R.enforce(unit.sql, 'blobReadUserDay', unit.userId, plain.length);
    return plain;
  });
  return { status: 200, body: buf };
}

async function libraryCommit(ctx) {
  S.syncGate(ctx, true);
  require('./projects')._internal.clientGate(ctx);
  const b = ctx.body;
  const z = Buffer.from(b.body, 'base64');
  if (z.length > MAX) fail('too_large', { limit: MAX });
  let old = null;
  const body = await SE.withSession(ctx, {}, async (unit, s) => {
    const done = (await unit.sql`select result from wts.push_receipts where user_id = ${unit.userId} and push_id = ${b.pushId}`)[0];
    if (done) return done.result;
    await R.enforce(unit.sql, 'commitUserHour', s.userId);
    const u = await unit.user(true);
    const row = (await unit.sql`select lib_rev, lib_hash, used_bytes, quota_bytes from wts.users where id = ${unit.userId} for update`)[0];
    if (Number(row.lib_rev) !== b.baseRev) fail('stale', { rev: Number(row.lib_rev), hash: hex(row.lib_hash) });
    if (Number(row.used_bytes) + z.length > Number(row.quota_bytes)) fail('quota', { limit: Number(row.quota_bytes), used: Number(row.used_bytes) });
    await store(ctx).put(KEYS.library(unit.userId, b.hash), E.sealChunk({ dataKey: u.keys.get(u.dkv), dkv: u.dkv, kid: u.row.data_key_kid,
      userId: unit.userId, hash: 'lib:' + b.hash, n: 0 }, z));
    const r = (await unit.sql`update wts.users set lib_rev = lib_rev + 1, lib_hash = ${Buffer.from(b.hash, 'hex')}, lib_saved_at = now()
      where id = ${unit.userId} returning lib_rev`)[0];
    if (row.lib_hash && hex(row.lib_hash) !== b.hash) old = { uid: unit.userId, h: hex(row.lib_hash) };
    const res = { rev: Number(r.lib_rev) };
    await unit.sql`insert into wts.push_receipts (user_id, push_id, result, at) values (${unit.userId}, ${b.pushId}, ${unit.sql.json(res)}, now()) on conflict do nothing`;
    return res;
  });
  // the previous body goes only after the commit (a failed commit keeps it)
  if (old) ctx.after(() => store(ctx).del(KEYS.library(old.uid, old.h)));
  return { status: 200, body };
}

module.exports = { handlers: { library, libraryBody, libraryCommit } };
