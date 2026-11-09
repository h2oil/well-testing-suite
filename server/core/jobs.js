'use strict';
// server/core/jobs.js — the one daily scheduled job (docs/ACCOUNTS-PLAN.md §3.5, §8.5, §13.5), run as wts_jobs with its own
// credential (loadJobsConfig; never the request handlers' one). Server-side scheduling does not touch the client's no-timer
// rule; when the host plan has no scheduler, the CI workflow calls POST /api/v1/ops/daily (HMAC, one-time nonce).
//
//   runDaily({db, keys, objects, mail, log, only?}) → summary {…counts}
//     purge   used / expired codes, challenges and provider attempts (24 h), signing keys past expiry, expired and replaced
//             sessions, rate counters (7 days), push receipts (24 h), sent mail (24 h), ops nonces (10 min)
//     mail    retry unsent outbox rows (tries < 5)
//     trash   purge projects trashed > 30 days ago
//     prune   squash and prune revisions of every project (core/revisions.js)
//     blobs   delete blobs unreferenced for 7 days and unfinished uploads older than 24 h (the row first, then the objects)
//     accounts purge accounts whose delete_at has passed: rows (committed), then the append-only ledger/<user id> object
//             outside the restorable database (ids and dates only) and the account's objects; audit rows keep a random
//             tombstone id; the ledger row is stamped. Object deletes that failed are retried from the ledger (30 days)
//     inactive warnings at 23 and 23.5 months without a sign-in, a deletion request (7-day grace) at 24 months: audited
//             (actor system) with the deletion notice queued in the outbox
//     quota   recompute users.used_bytes from complete blobs
//     retain  audit rows > 12 months, ledger rows purged > 12 months ago
//     anchor  verify the audit hash chains and write each chain head plus a Merkle root to chain/<YYYY-MM-DD>
//   ledgerReplay({db, objects, log}) → {replayed}   after ANY database restore, before the API is re-opened (§13.5)
//   auditVerify(sql) → {rows, bad, heads:[{chain, head}]}

const crypto = require('crypto');
const { KEYS } = require('./objects');
const { planPrune } = require('./revisions');
const E = require('./envelope');
const { compose } = require('./mail');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function merkle(leaves) {
  let level = leaves.map((l) => sha(l));
  if (!level.length) return sha('');
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha(level[i] + (level[i + 1] || level[i])));
    level = next;
  }
  return level[0];
}

async function auditVerify(sql) {
  const bad = (await sql`select a.id from wts.audit a where a.hash <> wts.audit_row_hash(a.prev_hash, a.actor, a.action, a.target, a.device_id,
    a.ip_prefix, a.ua_family, a.at, a.detail)`).map((r) => Number(r.id));
  const broken = (await sql`select a.id from wts.audit a where a.prev_hash is not null and not exists
    (select 1 from wts.audit b where b.hash = a.prev_hash and b.user_id is not distinct from a.user_id) and a.at > now() - interval '11 months'`).map((r) => Number(r.id));
  const heads = (await sql`select coalesce(a.user_id::text, 'system') as chain, encode(a.hash, 'hex') as head from wts.audit a
    where not exists (select 1 from wts.audit b where b.prev_hash = a.hash and b.user_id is not distinct from a.user_id) order by 1, 2`)
    .map((r) => ({ chain: r.chain, head: r.head }));
  const rows = (await sql`select count(*)::int as n from wts.audit`)[0].n;
  return { rows, bad, broken, heads };
}

// the rows of one account, in the caller's transaction (no object-store call inside it: a failed transaction must not leave
// rows whose objects are already gone)
async function purgeAccountRows(sql, uid) {
  const tomb = crypto.randomUUID();
  await sql`update wts.audit set user_id = ${tomb} where user_id = ${uid}`;
  await sql`delete from wts.push_receipts where user_id = ${uid}`;
  await sql`delete from wts.historian_backups where user_id = ${uid}`;
  await sql`delete from wts.revisions where user_id = ${uid}`;
  await sql`delete from wts.blobs where user_id = ${uid}`;
  await sql`update wts.projects set is_conflict_of = null where user_id = ${uid}`;
  await sql`delete from wts.projects where user_id = ${uid}`;
  await sql`delete from wts.users where id = ${uid}`;
  const l = (await sql`update wts.deletion_ledger set purged_at = coalesce(purged_at, now()) where user_id = ${uid} returning requested_at, purge_at, purged_at`)[0];
  return { v: 1, userId: uid, requestedAt: l ? l.requested_at.toISOString() : null, purgeAt: l ? l.purge_at.toISOString() : null,
    purgedAt: l ? l.purged_at.toISOString() : new Date().toISOString() };
}
// purge one account: the rows in one transaction and commit, THEN the append-only ledger object and the account's objects.
// A failed object delete is retried by the next daily run from the ledger (step 'accounts', rows purged in the last 30 days).
async function purgeAccount(sql, objects, uid, o) {
  const rec = await sql.begin((tx) => purgeAccountRows(tx, uid));
  if (objects) {
    if (!(o && o.noLedgerObject)) await objects.put(KEYS.ledger(uid), Buffer.from(JSON.stringify(rec)));
    await objects.delPrefix(KEYS.user(uid));
  }
  return rec;
}

// queue a mail from the job in the outbox (in the caller's transaction); sendOutbox sends it after the commit
async function queueMail(tx, keys, to, template, params) {
  const id = crypto.randomUUID();
  await tx`insert into wts.mail_outbox (id, to_enc, template, params_enc, created_at)
    values (${id}, ${keys.system.seal('mail.to', to)}, ${template}, ${keys.system.seal('mail.params', JSON.stringify({ template, params }))}, now())`;
  return { id, to, template, params };
}
async function sendOutbox(sql, mail, m, log) {
  let ok = false;
  try { await mail.send(compose({ to: m.to, template: m.template, params: m.params })); ok = true; } catch (e) { log.warn('jobs: ' + m.template + ' send failed'); }
  await sql`update wts.mail_outbox set sent_at = case when ${!!ok}::boolean then now() end, tries = tries + 1 where id = ${m.id}`;
  return ok;
}
const whenText = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

async function runDaily(o) {
  const db = o.db; const sql = db.sql; const log = o.log || { info() {}, warn() {} };
  const keys = o.keys; const objects = o.objects || null; const mail = o.mail || null;
  const did = {};
  const step = async (name, fn) => {
    if (o.only && o.only.indexOf(name) === -1) return;
    try { did[name] = await fn(); } catch (e) { did[name] = { error: true }; log.warn('jobs: ' + name + ' failed: ' + e.message); }
  };
  const n = async (q) => (await q).count;

  await step('purge', async () => ({
    codes: await n(sql`delete from wts.email_codes where expires_at < now() - interval '24 hours'
      or (coalesce(used_at, invalidated_at) is not null and coalesce(used_at, invalidated_at) < now() - interval '24 hours')`),
    challenges: await n(sql`delete from wts.webauthn_challenges where expires_at < now() - interval '24 hours'`),
    attempts: await n(sql`delete from wts.oauth_attempts where expires_at < now() - interval '24 hours'`),
    signingKeys: await n(sql`delete from wts.oidc_keys where expires_at < now()`),
    sessions: await n(sql`delete from wts.sessions where idle_expires_at < now() or abs_expires_at < now() or (replaced_at is not null and replaced_at < now() - interval '30 seconds')`),
    rate: await n(sql`delete from wts.rate_counters where window_start < now() - interval '7 days'`),
    receipts: await n(sql`delete from wts.push_receipts where at < now() - interval '24 hours'`),
    mail: await n(sql`delete from wts.mail_outbox where (sent_at is not null and sent_at < now() - interval '24 hours') or (tries >= 5 and created_at < now() - interval '24 hours')`),
    nonces: await n(sql`delete from wts.ops_nonces where seen_at < now() - interval '10 minutes'`),
  }));

  await step('mail', async () => {
    let sent = 0; let failed = 0;
    if (!mail || !keys) return { sent, failed, skipped: true };
    for (const m of await sql`select * from wts.mail_outbox where sent_at is null and tries < 5 and created_at < now() - interval '5 minutes' order by created_at limit 500`) {
      let ok = false;
      try {
        const to = keys.system.open('mail.to', m.to_enc).toString('utf8');
        const p = JSON.parse(keys.system.open('mail.params', m.params_enc).toString('utf8'));
        await mail.send(compose({ to, template: m.template, params: p.params }));
        ok = true; sent++;
      } catch (e) { failed++; }
      await sql`update wts.mail_outbox set sent_at = case when ${!!ok}::boolean then now() end, tries = tries + 1 where id = ${m.id}`;
    }
    return { sent, failed };
  });

  await step('trash', async () => {
    const ids = (await sql`select id from wts.projects where deleted_at is not null and deleted_at < now() - interval '30 days'`).map((r) => r.id);
    for (const id of ids) {
      await sql.begin(async (tx) => {
        await tx`update wts.projects set is_conflict_of = null where is_conflict_of = ${id}`;
        await tx`delete from wts.revisions where project_id = ${id}`;
        await tx`delete from wts.projects where id = ${id}`;
      });
    }
    return { projects: ids.length };
  });

  await step('prune', async () => {
    let removed = 0;
    for (const p of await sql`select p.id, p.user_id, p.head_rev from wts.projects p where (select count(*) from wts.revisions r where r.project_id = p.id) > 1`) {
      const revs = (await sql`select rev, reason, saved_at, pinned_until from wts.revisions where project_id = ${p.id}`)
        .map((r) => ({ rev: Number(r.rev), reason: r.reason, savedAt: +r.saved_at, pinnedUntil: r.pinned_until ? +r.pinned_until : null }));
      const bases = new Set((await sql`select (last_base_rev->>${p.id}::text)::bigint as rev from wts.devices where user_id = ${p.user_id} and last_base_rev ? ${p.id}::text`).map((r) => Number(r.rev)));
      const drop = planPrune(revs, { now: Date.now(), head: Number(p.head_rev), protect: bases });
      if (drop.length) removed += await n(sql`delete from wts.revisions where project_id = ${p.id} and rev = any(${sql.array(drop)}::bigint[])`);
    }
    await sql`update wts.revisions set pinned = false where pinned and pinned_until is not null and pinned_until < now()`;
    return { revisions: removed };
  });

  await step('blobs', async () => {
    // the ROW goes first, in its own statement (a commit referencing the blob holds it FOR SHARE: the delete waits and then
    // skips it, or finished first and the commit answers missing_blobs), and only then the objects (T15). Unfinished
    // uploads older than 24 h go the same way (they count against the quota while they exist).
    const gone = await sql`delete from wts.blobs b where (b.user_id, b.hash) in (
        select user_id, hash from wts.blobs where (refcount = 0 and unref_at is not null and unref_at < now() - interval '7 days')
          or (not complete and created_at < now() - interval '24 hours') limit 5000)
      and ((b.refcount = 0 and b.unref_at is not null and b.unref_at < now() - interval '7 days') or (not b.complete and b.created_at < now() - interval '24 hours'))
      returning b.user_id, encode(b.hash, 'hex') as h, b.chunks, b.complete`;
    let failed = 0;
    if (objects) {
      for (const b of gone) {
        for (let i = 0; i < b.chunks; i++) { try { await objects.del(KEYS.blob(b.user_id, b.h, i)); } catch (e) { failed++; } }
      }
    }
    if (failed) log.warn('jobs: ' + failed + ' blob objects could not be deleted (no row refers to them)');
    return { blobs: gone.filter((b) => b.complete).length, unfinished: gone.filter((b) => !b.complete).length };
  });

  await step('accounts', async () => {
    let purged = 0;
    for (const u of await sql`select id, email_enc, data_key_wrapped from wts.users where status = 'deleting' and delete_at <= now()`) {
      let to = null;
      try { to = E.openField(keys.ring.open(u.data_key_wrapped), 'user.address', u.email_enc).toString('utf8'); } catch (e) { to = null; }
      try { await purgeAccount(sql, objects, u.id); } catch (e) {
        // rows committed but an object call failed: the ledger retry below (next run) finishes it
        if ((await sql`select 1 from wts.users where id = ${u.id}`).length) throw e;
        log.warn('jobs: account objects not yet deleted; retried from the ledger');
      }
      purged++;
      if (to && mail) { try { await mail.send(compose({ to, template: 'notice_delete_done', params: { at: whenText(Date.now()) } })); } catch (e) { log.warn('jobs: deletion notice failed'); } }
    }
    // retry from the ledger: the objects of every account purged in the last 30 days (idempotent; the ledger object too)
    let retried = 0;
    if (objects) {
      for (const l of await sql`select user_id, requested_at, purge_at, purged_at from wts.deletion_ledger where purged_at is not null and purged_at > now() - interval '30 days'`) {
        try {
          if (!(await objects.get(KEYS.ledger(l.user_id)))) {
            await objects.put(KEYS.ledger(l.user_id), Buffer.from(JSON.stringify({ v: 1, userId: l.user_id, requestedAt: l.requested_at.toISOString(),
              purgeAt: l.purge_at.toISOString(), purgedAt: l.purged_at.toISOString() })));
          }
          if (await objects.delPrefix(KEYS.user(l.user_id))) retried++;
        } catch (e) { log.warn('jobs: ledger retry failed'); }
      }
    }
    return { purged, retried };
  });

  await step('inactive', async () => {
    let warned = 0; let started = 0;
    const rows = await sql`select id, email_enc, data_key_wrapped, coalesce(last_sign_in_at, created_at) as last, inactivity_warned_at as warned
      from wts.users where status = 'active' and coalesce(last_sign_in_at, created_at) < now() - interval '23 months'`;
    for (const u of rows) {
      const warnedSinceSignIn = u.warned && u.warned > u.last;
      const ageMonths = (Date.now() - u.last) / (30.44 * 86400e3);
      if (ageMonths >= 24) {
        let to = null;
        if (keys) { try { to = E.openField(keys.ring.open(u.data_key_wrapped), 'user.address', u.email_enc).toString('utf8'); } catch (e) { to = null; } }
        const queued = await sql.begin(async (tx) => {
          const r = (await tx`update wts.users set status = 'deleting', delete_requested_at = now(), delete_at = now() + interval '7 days'
            where id = ${u.id} returning delete_at`)[0];
          const ni = (await tx`delete from wts.identities where user_id = ${u.id} returning 1`).length;
          const ns = (await tx`delete from wts.sessions where user_id = ${u.id} returning 1`).length;
          await tx`insert into wts.deletion_ledger (user_id, requested_at, purge_at) values (${u.id}, now(), now() + interval '7 days')
            on conflict (user_id) do update set requested_at = excluded.requested_at, purge_at = excluded.purge_at, purged_at = null`;
          // audited on the account's own chain (actor system) like a user's own request
          await tx`insert into wts.audit (user_id, actor, action, at, detail, hash)
            values (${u.id}, 'system', 'delete_request', now(), ${tx.json({ reason: 'inactivity', identities: ni, sessions: ns })}, '\\x'::bytea)`;
          return to && keys ? queueMail(tx, keys, to, 'notice_delete_requested', { deleteAt: whenText(+r.delete_at) }) : null;
        });
        if (queued && mail) await sendOutbox(sql, mail, queued, log);
        started++;
        continue;
      }
      const second = ageMonths >= 23.5 && warnedSinceSignIn && (Date.now() - u.warned) > 10 * 86400e3;
      if (warnedSinceSignIn && !second) continue;
      if (mail && keys) {
        try {
          const to = E.openField(keys.ring.open(u.data_key_wrapped), 'user.address', u.email_enc).toString('utf8');
          const deleteAt = new Date(+u.last + 24 * 30.44 * 86400e3).toISOString().slice(0, 10);
          await mail.send({ to, template: 'notice_inactivity', params: { deleteAt } });
        } catch (e) { log.warn('jobs: inactivity notice failed'); }
      }
      await sql`update wts.users set inactivity_warned_at = now() where id = ${u.id}`;
      warned++;
    }
    return { warned, started };
  });

  await step('quota', async () => ({
    users: await n(sql`update wts.users u set used_bytes = coalesce((select sum(b.bytes) from wts.blobs b where b.user_id = u.id and b.complete), 0)
      where used_bytes is distinct from coalesce((select sum(b.bytes) from wts.blobs b where b.user_id = u.id and b.complete), 0)`),
  }));

  await step('retain', async () => ({
    audit: await n(sql`delete from wts.audit where at < now() - interval '12 months'`),
    ledger: await n(sql`delete from wts.deletion_ledger where purged_at is not null and purged_at < now() - interval '12 months'`),
  }));

  await step('anchor', async () => {
    const v = await auditVerify(sql);
    if (v.bad.length || v.broken.length) log.warn('alert: audit chain check failed (' + v.bad.length + ' bad, ' + v.broken.length + ' broken links)');
    const date = new Date().toISOString().slice(0, 10);
    const root = merkle(v.heads.map((h) => h.chain + ':' + h.head));
    if (objects) await objects.put(KEYS.chain(date), Buffer.from(JSON.stringify({ v: 1, date, heads: v.heads, root })));
    return { chains: v.heads.length, root, bad: v.bad.length, broken: v.broken.length };
  });

  return did;
}

// §13.5: after a restore, every account in the ledger objects is purged again before the API re-opens
async function ledgerReplay(o) {
  const sql = o.db.sql; let replayed = 0;
  for (const k of await o.objects.list('ledger/')) {
    const rec = JSON.parse((await o.objects.get(k)).toString('utf8'));
    if (!rec || !rec.userId) continue;
    const exists = (await sql`select 1 from wts.users where id = ${rec.userId}`).length > 0;
    if (exists) {
      await purgeAccount(sql, o.objects, rec.userId, { noLedgerObject: true });
      replayed++;
    } else {
      await o.objects.delPrefix(KEYS.user(rec.userId));              // objects a failed purge left behind
    }
    await sql`insert into wts.deletion_ledger (user_id, requested_at, purge_at, purged_at)
      values (${rec.userId}, ${rec.requestedAt || rec.purgedAt}, ${rec.purgeAt || rec.purgedAt}, ${rec.purgedAt})
      on conflict (user_id) do update set purged_at = coalesce(wts.deletion_ledger.purged_at, excluded.purged_at)`;
  }
  return { replayed };
}

module.exports = { runDaily, ledgerReplay, auditVerify, merkle, purgeAccount, purgeAccountRows, queueMail };
