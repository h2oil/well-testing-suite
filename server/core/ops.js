'use strict';
// server/core/ops.js — the audited operations behind server/ops/*.js (docs/ACCOUNTS-PLAN.md D18, §13.4–13.7). Support
// actions run as wts_support and reach data ONLY through the audited definer functions (each writes an audit row with
// actor support:<id>); key rotation and the ledger replay run as wts_jobs. Nothing here prints an address, a key or a body.
//
//   lookup({db, keys, actor, email})                → {userId, status, created} | null      (support_lookup)
//   allowlistAdd({db, keys, actor, email, note})    → boolean                                (support_allowlist_add)
//   securityReset({db, actor, userId, since})       → {sessions, passkeys, identities, emailReverted}
//   recover({db, keys, actor, userId, newEmail})    → the new address becomes primary (7-day revert window on the old one)
//   ringStatus({db, keys})                          → {byKid: {kid: n}, total}                (jobs)
//   rewrapAll({db, keys, toKid, batch})             → {rewrapped}  every users.data_key_wrapped re-wrapped with toKid (jobs)
//                                                     — a kid may be retired only when ringStatus shows no row on it

const E = require('./envelope');
const V = require('./validate');

const ACTOR_RE = /^support:[a-z0-9_-]{1,32}$/;
function actorOf(a) { if (!ACTOR_RE.test(String(a || ''))) throw new Error('ops: actor must be support:<id>'); return a; }
function emailOf(e) { const n = V.normEmail(e); if (!n) throw new Error('ops: not an address'); return n; }

async function lookup(o) {
  const r = (await o.db.sql`select * from wts.support_lookup(${actorOf(o.actor)}, ${o.keys.emailBidx(emailOf(o.email))})`)[0];
  return r ? { userId: r.user_id, status: r.status, created: r.created_at.toISOString() } : null;
}
async function allowlistAdd(o) {
  return (await o.db.sql`select wts.support_allowlist_add(${actorOf(o.actor)}, ${o.keys.emailBidx(emailOf(o.email))}, ${String(o.note || '').slice(0, 200)}) as ok`)[0].ok;
}
async function securityReset(o) {
  return (await o.db.sql`select wts.support_security_reset(${actorOf(o.actor)}, ${o.userId}, ${o.since}) as r`)[0].r;
}
// the new address is sealed with the account's data key by the jobs credential (support cannot read users), then moved
// by the audited definer
async function recover(o) {
  const email = emailOf(o.newEmail);
  const row = (await o.jobsDb.sql`select data_key_wrapped, data_key_ver from wts.users where id = ${o.userId}`)[0];
  if (!row) throw new Error('ops: no such account');
  const ring = o.keys.ring.open(row.data_key_wrapped);
  const enc = E.sealField(ring.get(row.data_key_ver), row.data_key_ver, 'user.address', email);
  await o.db.sql`select wts.support_recover(${actorOf(o.actor)}, ${o.userId}, ${o.keys.emailBidx(email)}, ${enc})`;
  return { ok: true };
}

async function ringStatus(o) {
  const byKid = {}; let total = 0;
  for (const r of await o.db.sql`select data_key_wrapped from wts.users`) {
    E.ringKids(r.data_key_wrapped).forEach((k) => { byKid[k] = (byKid[k] || 0) + 1; });
    total++;
  }
  return { byKid, total };
}
async function rewrapAll(o) {
  const to = o.keys.master.forKid(o.toKid);
  if (!to) throw new Error('ops: master key ' + o.toKid + ' is not loaded');
  let rewrapped = 0;
  for (;;) {
    const rows = await o.db.sql`select id, data_key_wrapped from wts.users where data_key_kid <> ${o.toKid} order by id limit ${o.batch || 500}`;
    if (!rows.length) break;
    let progress = 0;
    for (const r of rows) {
      const w = E.rewrapRing(r.data_key_wrapped, o.keys.master.forKid, { kid: o.toKid, key: to });
      progress += (await o.db.sql`update wts.users set data_key_wrapped = ${w}, data_key_kid = ${o.toKid} where id = ${r.id} and data_key_wrapped = ${r.data_key_wrapped}`).count;
    }
    rewrapped += progress;
    if (!progress) break;                                   // rows changed under us: the next run picks them up
  }
  return { rewrapped };
}

module.exports = { lookup, allowlistAdd, securityReset, recover, ringStatus, rewrapAll };
