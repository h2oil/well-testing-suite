#!/usr/bin/env node
'use strict';
// server/ops/retire-client.js — audited support script (docs/ACCOUNTS-PLAN.md §4.14, §13.7, D18): before a NEW provider client
// (app) goes live, remove every identity of that provider. A re-created LinkedIn app gives every user a new pairwise subject,
// and UNIQUE (user_id, provider) would otherwise answer provider_linked; after this script each user re-links with one e-mail
// code (§4.12 rule 5). Every removed identity takes its sessions with it, gets an audit row with actor support:<id> and the
// subject only as its keyed index (definer support_retire_identities, wts_support), and an unlink notice to the account
// address is queued in the outbox (the jobs credential opens the address with the account's data key and seals it as every
// outbox row is sealed; the daily job sends it).
//
//   node server/ops/retire-client.js --provider linkedin --actor support:<id> --yes
//     connections from WTS_SUPPORT_DB_URL (wts_support: the audited support functions only) and WTS_JOBS_DB_URL (wts_jobs:
//     the notices); keys as for the functions (WTS_MASTER_KEYS, WTS_MASTER_KID, WTS_INDEX_PEPPER, WTS_CODE_PEPPERS)
//   require('./retire-client').retireClient(db, {provider, actor, jobs?, keys?}) → Promise<{users, identities, sessions, notices}>
// Without --yes it prints what it would do and changes nothing. Never prints an address, subject or user id.

const PROVIDERS = ['google', 'linkedin'];
const ACTOR_RE = /^support:[a-z0-9_-]{1,32}$/;            // the actor form of every audited support operation (002-core.sql)

async function retireClient(db, o) {
  o = o || {};
  if (PROVIDERS.indexOf(o.provider) === -1) throw new Error('retire-client: --provider google|linkedin');
  if (!ACTOR_RE.test(String(o.actor || ''))) throw new Error('retire-client: --actor support:<id>');
  const rows = await db.sql`select * from wts.support_retire_identities(${o.actor}, ${o.provider})`;
  const users = Array.from(new Set(rows.map((r) => r.user_id)));
  let notices = 0;
  if (o.jobs && o.keys) notices = await queueNotices(o.jobs, o.keys, users, o.provider);
  return {
    users: users.length,
    identities: rows.reduce((n, r) => n + r.identities, 0),
    sessions: rows.reduce((n, r) => n + r.sessions, 0),
    notices,
  };
}

// one notice_identity_unlinked per user, queued with the jobs credential (it reads users and writes mail_outbox)
async function queueNotices(jobs, keys, userIds, provider) {
  const E = require('../core/envelope');
  const { whenText } = require('../core/service');
  const { queueMail } = require('../core/jobs');
  let n = 0;
  for (const id of userIds) {
    await jobs.sql.begin(async (tx) => {
      const u = (await tx`select email_enc, data_key_wrapped from wts.users where id = ${id}`)[0];
      if (!u) return;
      const to = E.openField(keys.ring.open(u.data_key_wrapped), 'user.address', u.email_enc).toString('utf8');
      await queueMail(tx, keys, to, 'notice_identity_unlinked', { provider, at: whenText(Date.now()) });
      n++;
    });
  }
  return n;
}

function parseArgs(argv) {
  const o = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider') o.provider = argv[++i];
    else if (argv[i] === '--actor') o.actor = argv[++i];
    else if (argv[i] === '--yes') o.yes = true;
  }
  return o;
}

module.exports = { retireClient, parseArgs };

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (PROVIDERS.indexOf(o.provider) === -1 || !ACTOR_RE.test(String(o.actor || ''))) {
    console.error('usage: retire-client.js --provider google|linkedin --actor support:<id> [--yes]');
    process.exit(2);
  }
  if (!o.yes) {
    console.log('[retire-client] dry run: would remove every ' + o.provider + ' identity (and the sessions it created), audit each as '
      + o.actor + ' and queue an unlink notice. Run again with --yes, only BEFORE the new client goes live.');
    process.exit(0);
  }
  const url = process.env.WTS_SUPPORT_DB_URL; const jurl = process.env.WTS_JOBS_DB_URL;
  if (!url || !jurl) { console.error('[retire-client] WTS_SUPPORT_DB_URL and WTS_JOBS_DB_URL must be set'); process.exit(2); }
  const { createDb } = require('../core/db');
  const { loadJobsConfig } = require('../core/config');
  const { createKeys } = require('../core/keys');
  const keys = createKeys(loadJobsConfig(Object.assign({}, process.env)));
  if (!keys.ready || keys.ephemeral) { console.error('[retire-client] keys are not configured: ' + keys.missing.join(', ')); process.exit(2); }
  const db = createDb(url, { max: 1, role: 'wts_support', sessionRole: true }); const jobs = createDb(jurl, { max: 1, role: 'wts_jobs', sessionRole: true });
  const close = () => Promise.all([db.close(), jobs.close()]);
  retireClient(db, { provider: o.provider, actor: o.actor, jobs, keys })
    .then((r) => { console.log('[retire-client] ' + o.provider + ': ' + r.identities + ' identities removed for ' + r.users + ' users; ' + r.sessions + ' sessions revoked; ' + r.notices + ' notices queued'); return close(); })
    .catch((e) => { console.error('[retire-client] ' + e.message); close().finally(() => process.exit(1)); });
}
